/**
 * 提示词回归评测harness（W1b · Round 2 §07.1）。
 *
 * ## 为什么不直接用 vendor 的 `createPiCodingAgentHarness`
 *
 * vendor 那份（`packages/evals/src/pi-harness.ts`）的 `run` 函数**深度依赖
 * `@earendil-works/pi-coding-agent`**：`createAgentSessionFromServices` / `SessionManager`
 *（coding-agent 的）/ `SettingsManager`，且形态是「临时工程目录 + AgentSession」。
 *
 * 而本项目**刻意不依赖 pi-coding-agent**（它属交互式终端宿主层，见
 * `services/pi-runtime/DEPENDENCIES.md` 与 ADR-0001/0009）⇒ 直接复用会把整个 CLI
 * 宿主拉进依赖面，是净负。
 *
 * 但**不需要重写框架**：`createHarness` / `Harness` / `evalHarnessTable` /
 * LLM-judge 全部来自 `vitest-evals/harness`（**npm 公开包**），与 coding-agent 无关。
 * 本模块只实现那个 `run` 回调 —— 走 pi-runtime 的 HTTP 面（`/sessions` +
 * `/sessions/:id/prompt` + SSE `/sessions/:id/events`），这才是被测系统。
 *
 * ## 本模块的边界
 *
 * **只做「跑一轮并把结果归一化成 vitest-evals 认识的形状」**，不含任何判据。
 * 判据（期望调用了哪些工具 / 不该调用什么 / 是否先复述）在 case 文件里用
 * `assert` 表达 —— 因为它们是可读的、可 diff 的，不该藏进 harness。
 *
 * ## 为什么要有一层
 *
 * pi-runtime 的事件是**流式增量**的（`message_update` / `tool_execution_update`
 * 反复到达），而 vitest-evals 要的是**归一化 transcript**。这个折叠是本模块的核心价值：
 * 折叠错了会得到「看起来跑了、实际没记录」的评测基线 —— 那比没有 eval 更危险。
 */

/** pi-runtime 归一事件（与 `session-manager.ts` 的 `NormalizedEvent` 同构，只取用到字段）。 */
export interface RuntimeEvent {
	type: string;
	seq?: number;
	ts?: number;
	data?: unknown;
}

/** 一轮评测的输入。 */
export interface EvalCaseInput {
	/** 本轮用户话术。 */
	text: string;
	/**
	 * 首轮 system prompt。缺省用pi-runtime 自己的默认装配
	 * （`PiPromptAssembler` 渲染 Registry —— 这正是被测对象）。
	 */
	systemPrompt?: string;
	/** 画布会话 id（工具经 `toolContext.sessionId` 回查 Nest）。 */
	canvasSessionId?: string;
	/**
	 * ⭐ 真实 Nest userId。
	 *
	 * 画布工具（`get_canvas_summary` / `propose_generation` 等）都要它做归属校验，
	 * 填假值（如 `"eval"`）⇒ 全部 `/agent/internal/*` 返 4xx
	 * ⇒ 模型反复重试工具、评测只能拿到超时。**实测踩过**（首跑 7 条全 120s 超时，
	 * `get_canvas_summary` 22 次 4xx）。
	 */
	userId?: string;
	/** 画布初始态的 JSON 串。⚠️ 仅作为 artifact 记录，不自动写库。 */
	canvasData?: string;
}

export interface EvalTranscript {
	/** 归一化后的助手文本（`message_end` 累积）。 */
	assistantText: string;
	/** 按调用顺序的���具名列表（`tool_execution_start` 去重保序）。 */
	toolNames: string[];
	/** 完整工具调用记录（含 callId 与入参摘要），供断言「调了但参数对不对」。 */
	toolCalls: Array<{ name: string; callId?: string; input?: unknown }>;
	/** 本轮是否正常结束（收到 `agent_end` 且无 `error`）。 */
	completed: boolean;
	/** 收到的 error 事件原文。 */
	errors: string[];
	/** token 用量（若 runtime 上报）。 */
	usage?: { input?: number; output?: number; total?: number };
}

/**
 * 折叠流式事件 → 归一化 transcript。
 *
 * 纯函数（无 IO）⇒ 可直接单测，且是本模块最容易出错的地方。
 *
 * 折叠规则（每条都有对应的失效形态）：
 * 1. `message_update`/`message_end` 的 `text` 块**按序拼接**；
 *    ⭐ vendor 的 delta 可能重发全量（而非纯增量），故用 `text` 全量替换而非 append ——
 *    但仅当新文本**以旧文本为前缀**时才替换，否则退化为 append。
 * 2. `tool_execution_start` 记一条；同名多次调用**保留全部**（一轮里可以调多次），
 *    只按 `callId` 去重（重连重放会带同一 callId）。
 * 3. `error` 事件累加到 `errors`；`agent_end` 且 errors 为空 ⇒ `completed=true`。
 *    ⚠️ `agent_end` 的 `data.status` 也要看：`deferred`/`aborted` 不算完成。
 */
export function foldRuntimeEvents(events: readonly RuntimeEvent[]): EvalTranscript {
	const toolCalls: EvalTranscript["toolCalls"] = [];
	const seenCallIds = new Set<string>();
	let assistantText = "";
	let sawAgentEnd = false;
	let agentEndClean = true;
	const errors: string[] = [];
	let usage: EvalTranscript["usage"];

	for (const ev of events) {
		const data = (ev.data ?? {}) as Record<string, unknown>;
		switch (ev.type) {
			case "message_update": {
				// ⭐ 生产实测：`message_update` 带的是**累积快照**（当前已生成的全文），
				// 不是增量片段。实测一条消息有 132 个 update，
				// 而 `mergeText` 的「真增量」分支会把它们**全部追加**
				// ⇒ assistantText 变成阶梯状重复（"好的，" / "好的，当前" / … 各一份）
				// ⇒ 必须走 mergeText 的「全量重发则替换」分支。
				assistantText = mergeText(assistantText, extractText(data));
				break;
			}
			case "message_end": {
				// ⭐ `message_end` 是**该条消息的权威全文** ⇒ 直接**替换**，
				// 不 merge。
				// 为什么不能 merge：`mergeText` 只能识别「incoming 是 previous 的扩展」，
				// 而多轮/多块时 `message_end` 的文本可能与累积快照**不一致**
				//（例如最后一块只含尾部）⇒ merge 会留下前一块的残留。
				const full = extractText(data);
				if (full) assistantText = full;
				break;
			}
			case "tool_execution_start": {
				const name = String(data.toolName ?? data.name ?? "");
				const callId =
					typeof data.toolCallId === "string"
						? data.toolCallId
						: typeof data.callId === "string"
							? data.callId
							: undefined;
				// 重连重放会带同一 callId ⇒ 去重；但同名不同 callId 是两次真实调用，保留。
				const dedupKey = callId ?? `${name}#${toolCalls.length}`;
				if (!name || seenCallIds.has(dedupKey)) break;
				seenCallIds.add(dedupKey);
				toolCalls.push({ name, callId, input: data.input ?? data.arguments });
				break;
			}
			case "usage":
			case "agent_end": {
				const usageIn = data.usage as EvalTranscript["usage"] | undefined;
				if (usageIn && typeof usageIn === "object") usage = { ...usage, ...usageIn };
				if (ev.type === "agent_end") {
					sawAgentEnd = true;
					const status = String(data.status ?? "completed");
					// aborted / deferred / failed 都不是「正常完成」
					if (status !== "completed" && status !== "success") agentEndClean = false;
				}
				break;
			}
			case "error": {
				const msg =
					typeof data.message === "string" ? data.message : safeStringify(data.source ?? data);
				errors.push(msg);
				break;
			}
			default:
				break;
		}
	}

	return {
		assistantText,
		toolNames: toolCalls.map((c) => c.name),
		toolCalls,
		completed: sawAgentEnd && agentEndClean && errors.length === 0,
		errors,
		usage,
	};
}

/**
 * 文本合并：全量重发则替换，增量则追加。
 *
 * ⭐ 这是「重连重放」与「真增量」的判别。判错的后果不是丢字，而是**重复字**：
 * `message_end` 常带全量文本，若无条件 append 会让同一段话出现两遍，
 * 而基于文本的断言（如「必须先复述目标」）会因此永远失败。
 */
function mergeText(previous: string, incoming: string): string {
	if (!incoming) return previous;
	if (!previous) return incoming;
	if (incoming === previous) return previous;
	if (incoming.startsWith(previous)) return incoming; // 全量重发
	if (previous.endsWith(incoming)) return previous; // 重复末尾
	return previous + incoming; // 真增量
}

/**
 * 从 message 载荷里抽**助手文本**。
 *
 * ⭐ **生产实测校正（2026-10-04，真实事件流）**：pi-runtime 的
 * `message_end` / `message_update` 载荷是
 * `{ type, lane, runId, message: { role, content: [...] } }`，
 * 助手文本在 **`data.message.content[].text`** —— 不是 `data.text`，
 * 也不是 `data.content`。
 *
 * ⚠️⚠️ 这不是笔误级别的问题：原实现只读 `data.text` / `data.content`，
 * 在真实事件流上**恒返回空串** ⇒ `assistantText` 永远是 "" ⇒
 * **所有 `forbidText` / `expectTextIncludes` 判据永远「通过」**
 * ⇒ 「模型说了不该说的话」这类最关键的判据**全部假绿**。
 * 假绿的评测基线比没有评测更危险（它会让人根据错误的基线改提示词）。
 *
 * 两个必须处理的细节：
 * 1. ⭐ `content` 里**混着 `thinking` 块**（实测 `["thinking","text"]`）
 *    —— 只取 `type === "text"` 的块，**否则会把模型内心戏当成交付文本**，
 *    让 forbidText 判据误判。
 * 2. 保留对 `data.text` / `data.content` 的兼容（测试与未来形态变化）。
 */
function extractText(data: Record<string, unknown>): string {
	// 真实形态：data.message.content[]
	const message = data.message as { role?: unknown; content?: unknown } | undefined;
	if (message && typeof message === "object" && message.role === "assistant") {
		const fromMessage = textFromBlocks(message.content);
		if (fromMessage) return fromMessage;
	}
	const direct = typeof data.text === "string" ? data.text : "";
	if (direct) return direct;
	return textFromBlocks(data.content);
}

/**
 * 从 block 数组里拼文本。
 *
 * ⭐ 只收 `type === "text"` 的块（`thinking` / `toolCall` 等一律跳过）：
 * 实测助手 content 形如 `["thinking","text"]`，不过滤会把内心戏混进交付文本。
 */
function textFromBlocks(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (typeof block === "string") return block;
			if (block && typeof block === "object") {
				const t = block as { type?: unknown; text?: unknown };
				// 无 type 的裸字符串块按文本算（兼容简化形态）
				if (t.type === undefined && typeof t.text === "string") return t.text;
				return t.type === "text" && typeof t.text === "string" ? t.text : "";
			}
			return "";
		})
		.join("");
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}
