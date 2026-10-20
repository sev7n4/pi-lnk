/**
 * 回合连续性状态（turn continuity state）——「故障后说『继续』能接上」的核心。
 *
 * ## 问题（2026-10-21 生产取证，证据见 docs/agent/turn-continuity-design.md）
 *
 * pi-lnk 把对话历史**完全**交给 pi 侧原生 transcript
 * （`apps/server/src/agent/agent.service.ts:410`：「不再查 AgentMessage 历史喂 prompt
 * —— 会话跨轮常驻，历史已在 pi 侧原生 context 里」）。
 *
 * 该假设在**故障轮**上不成立，两条独立机制都会让模型「失忆」：
 *
 * 1. **上游过滤**（`vendor/earendil-works/pi/packages/agent/src/harness/session/context.ts:24-29`）：
 *    `isContextMessage()` 把 `stopReason ∈ {error, aborted, deferred}` 的 **assistant**
 *    消息排除出下一轮上下文。即「中断轮的助手输出」虽然落在 transcript 里，模型**看不到**。
 * 2. **双写分叉**（生产实证）：Nest 侧 `AgentMessage` 表与 pi 侧 transcript 是两份独立存储。
 *    故障轮在 Nest 侧落库了 user 消息（`agent.service.ts:412-421`），但在 pi 侧
 *    **整轮不存在**（转录 gap 内 0 条 entry）。此后用户说「继续」，
 *    模型上下文里既没有那条 user 消息、也没有任何「我正在做什么」的线索
 *    ⇒ 只能退化成「感知画布」去猜「继续」是什么意思。
 *
 * ���种分叉**静默发生**：Nest 侧无任何校验，pi 侧 transcript 是唯一喂模型的东西。
 *
 * ## 解法（吃满上游，不造轮子）
 *
 * 上游 pi 提供了**为此场景设计的扩展点**，但 pi-lnk 一概未用：
 *
 * - `AgentLane.appendCustomEntry(customType, data, ctx)`（`harness/runtime/lane.ts:1919`）
 *   —— 往 transcript 落一条**自定义条目**（`CustomEntry{type:"custom",customType,data}`）。
 * - `AgentHarness.create({ entryProjectors })`（`harness/runtime/harness.ts:72`）
 *   —— 把自定义条目**投影回模型上下文**（`harness/session/context.ts:55-61`）。
 *
 * 二者合起来 = 上游原生的「往对话历史里持久化一条结构化状态，并在后续轮次
 * 重新投喂给模型」的能力。本模块就是它的实现。
 *
 * ## 为什么不是「关键词识别『继续』」
 *
 * 行业共识（Codex / Claude Code / WorkBuddy 三方一致）：**恢复靠「信息在状态里」，
 * 不靠猜用户意图**。WorkBuddy 对「继续 / 接着 / go on」全仓零关键词识别，
 * 靠的是每轮把结构化状态落盘 + 失败时自动注入 error-recovery 提醒。
 * 关键词方案在「接着改那个组件」「刚才那个先放着」这类表达上立刻失效。
 *
 * ## 本模块的职责边界
 *
 * - **只管「上一轮中断时，把当时的任务状态持久化并在下一轮重新投影」**。
 * - 不做意图分类（那是关键词方案的短视做法）。
 * - 不负责把状态外置到文件系统（那是超长任务的 ledger 纪律，WorkBuddy 用 skill 解决，
 *   不属于本仓库的运行时范畴）。
 */

/** ��制状态的自定义条目类型名（与上游 `entryProjectors` 的键一一对应）。 */
export const TURN_STATE_CUSTOM_TYPE = "lnkpi.turn_state";

/**
 * 中断类型分类（对齐 WorkBuddy 的 `aborted_tools` / `aborted_streaming` 二分，
 * 见 `~/.workbuddy` cli/dist 中断分类器）。
 *
 * ⛔ 不做「哪种更严重」的排序——消费方（projector）只按类型调整措辞，
 * 不改变事实陈述。
 */
export type InterruptionKind =
	/** 上游明确以 error/aborted 收尾（含进程重启后的孤儿结算）。 */
	| "upstream_error"
	/** 工具执行期间流断（工具可能已产生副作用）。 */
	| "tool_interrupted"
	/** 上游 409 / 会话忙。 */
	| "session_busy"
	/** Nest ↔ pi 传输失败（prompt 未被接受）。 */
	| "transport_failed"
	/** Nest 侧落库成功但 pi 侧整轮缺失（双写分叉，2026-10-21 生产形态）。 */
	| "history_diverged"
	/** 原因不明。 */
	| "unknown";

/**
 * 一条「回合状态」——**这是模型唯一能看到的、跨故障仍然存活的东西**。
 *
 * ⭐ 与「对话历史」的分工（WorkBuddy 的 task state vs conversation history）：
 * - 对话历史 = 模型说了什么（会被压缩、会被过滤、故障时可能整段消失）
 * - 回合状态 = **任务进行到哪一步**（结构化、跨故障、跨压缩存活）
 */
export interface TurnState {
	/** 出问题那一轮的 user 原文（截断后）。模型靠它知道「用户本来要我做什么」。 */
	readonly userText: string;
	/** 那一轮助手已产出的内容（截断后）。可能是空（模型还没开口就挂了）。 */
	readonly assistantPartial: string;
	/** 中断类型。 */
	readonly interruption: InterruptionKind;
	/** 那一轮已经**确定完成**的步骤（自然语言短句，模型可据此判断从哪继续）。 */
	readonly completedSteps: readonly string[];
	/** 那一轮**正在做但没做完**的步骤。 */
	readonly pendingSteps: readonly string[];
	/** 中断发生的 Unix 毫秒。 */
	readonly at: number;
}

/** `userText` / `assistantPartial` 的保留上限（字符）。 */
const MAX_TEXT = 1200;
/** `completedSteps` / `pendingSteps` 的条数上限。 */
const MAX_STEPS = 8;

/** 截断文本（保留首尾，中间省略——尾部往往是最接近故障点的信息）。 */
export function truncateText(text: string, limit = MAX_TEXT): string {
	const trimmed = (text ?? "").trim();
	if (trimmed.length <= limit) return trimmed;
	const head = Math.floor(limit * 0.6);
	const tail = limit - head - 3;
	return `${trimmed.slice(0, head)}...${trimmed.slice(-tail)}`;
}

/** 规范化步骤列表：去空白、去空项、截断条数。 */
export function normalizeSteps(steps: readonly string[] | undefined, limit = MAX_STEPS): string[] {
	if (!steps?.length) return [];
	const out: string[] = [];
	for (const raw of steps) {
		const s = (raw ?? "").trim();
		if (!s) continue;
		out.push(truncateText(s, 200));
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * 构造回合状态（纯函数，无 IO）。
 *
 * ⭐ 判据：**宁可少说也不多说**（N4：不冒充知道）。
 * 不知道「助手说了什么」就留空——模型看到空 partial 时会自己去感知画布，
 * 这比编造一段半截输出安全得多（编造会让模型以为「我已经开始做了」而重复执行）。
 */
export function buildTurnState(input: {
	userText: string;
	assistantPartial?: string;
	interruption: InterruptionKind;
	completedSteps?: readonly string[];
	pendingSteps?: readonly string[];
	at: number;
}): TurnState {
	return {
		userText: truncateText(input.userText),
		assistantPartial: truncateText(input.assistantPartial ?? ""),
		interruption: input.interruption,
		completedSteps: normalizeSteps(input.completedSteps),
		pendingSteps: normalizeSteps(input.pendingSteps),
		at: input.at,
	};
}

/**
 * 渲染**指导指令**部分（与状态事实分离）。
 *
 * ⭐ 为什么要拆开：状态事实里出现「画布」是**正常的**（已完成步骤可能就是
 * 「已读取画布摘要」），而「不要靠观察画布反推用户意图」是**指令**层面的约束。
 * 两者混在一段文本里，判据就没法精确表达——测试只能靠禁词猜，禁词一撞就假红。
 * 拆开后：事实照实写，指令只管推理路径。
 *
 * ⭐ 措辞纪律（对齐 WorkBuddy 的 "Resume directly — no apology, no recap"）：
 * - 不道歉、不复盘、不说「我上次失败了」；
 * - 直接陈述**事实状态**（用户要什么 / 做到哪 / 卡在哪）；
 * - 明确告诉模型**下一步该干什么**，而不是让它重新感知画布去猜。
 */
export function renderTurnStateGuidance(state: TurnState): string {
	return [
		"处理方式：直接接着未完成的部分继续——用户想要什么已写在上面，不要重新推断；" +
			"不要重复已经完成的步骤；不要为中断道歉或复盘。",
	].join("\n");
}

/**
 * 把回合状态渲染成**注入模型上下文**的中文说明块（事实 + 指令）。
 *
 * ⛔ 不得出现「请根据画布推测用户意图」这类措辞——那正是本次事故的形态。
 * ⚠️ 但允许出现「已读取画布摘要」这类**事实性**描述（那是助手真做过的步骤）。
 */
export function renderTurnStateBlock(state: TurnState): string {
	const lines: string[] = ["【上一轮被中断，以下是该轮的任务状态】"];
	lines.push(`用户当时的请求：${state.userText || "（未捕获）"}`);

	if (state.assistantPartial) {
		lines.push(`中断前助手已产出：${state.assistantPartial}`);
	}
	if (state.completedSteps.length > 0) {
		lines.push(`已完成：${state.completedSteps.join("；")}`);
	}
	if (state.pendingSteps.length > 0) {
		lines.push(`未完成：${state.pendingSteps.join("；")}`);
	} else {
		lines.push("未完成：未知（中断发生在记录状态之前）");
	}

	lines.push(`中断类型：${describeInterruption(state.interruption)}。`);
	lines.push(renderTurnStateGuidance(state));
	return lines.join("\n");
}

/** 中断类型的人话描述（给模型看）。 */
export function describeInterruption(kind: InterruptionKind): string {
	switch (kind) {
		case "upstream_error":
			return "上游模型调用报错";
		case "tool_interrupted":
			return "工具执行期间中断";
		case "session_busy":
			return "会话忙，未被接受";
		case "transport_failed":
			return "请求未送达";
		case "history_diverged":
			return "历史记录缺失";
		case "unknown":
			return "原因不明";
	}
}

/**
 * 上游 `EntryProjector` 形状（见 `harness/session/types.ts:58-62`）。
 *
 * ⚠️ 这里只声明我们用到的最小结构，**不 import vendor 类型**——
 * pi-runtime 已经依赖 vendor（`session-manager.ts` 直接 import AgentHarness），
 * 但本文件被 Nest 侧也可能引用，保持零依赖更安全。
 */
export interface TurnStateProjectorEntry {
	type: "custom";
	customType: string;
	data?: unknown;
}

/**
 * 上游 `EntryProjector`：把 `lnkpi.turn_state` 自定义条目投影成一条 user 消息。
 *
 * ⭐ 为什么投影成 **user 角色**而不是 assistant：
 * - assistant 消息会被 `isContextMessage` 按 `stopReason` 过滤（`context.ts:24-29`），
 *   我们自造的消息没有 `stopReason` ⇒ 恒为 `undefined` ⇒ **永不被过滤**；
 * - 语义上它是「给模型的补充输入」而非「模型的发言」⇒ user 角色更贴切。
 *
 * ⛔ 非 `lnkpi.turn_state` 的自定义条目一律返回 `undefined`（不投影）——
 * 上游允许一个 projector 只管自己那类。
 */
export function turnStateProjector(entry: TurnStateProjectorEntry): Array<{ role: "user"; content: string }> | undefined {
	if (entry?.type !== "custom" || entry.customType !== TURN_STATE_CUSTOM_TYPE) return undefined;
	const state = parseTurnState(entry.data);
	if (!state) return undefined;
	return [{ role: "user", content: renderTurnStateBlock(state) }];
}

/**
 * 解析持久化后的回合状态（容错解析）。
 *
 * ⭐ 判据：**解析不出来就返回 undefined**（⇒ 不投影）——
 * 宁可这一轮没有恢复提示，也不能把一段坏数据当事实投给模型
 * （「不冒充知道」原则，与 turn-ledger.ts 同源）。
 */
export function parseTurnState(data: unknown): TurnState | undefined {
	if (data === null || typeof data !== "object") return undefined;
	const raw = data as Record<string, unknown>;

	const userText = typeof raw.userText === "string" ? raw.userText : undefined;
	if (userText === undefined) return undefined;

	const interruption = raw.interruption;
	const kind: InterruptionKind =
		interruption === "upstream_error" ||
		interruption === "tool_interrupted" ||
		interruption === "session_busy" ||
		interruption === "transport_failed" ||
		interruption === "history_diverged"
			? interruption
			: "unknown";

	return {
		userText,
		assistantPartial: typeof raw.assistantPartial === "string" ? raw.assistantPartial : "",
		interruption: kind,
		completedSteps: Array.isArray(raw.completedSteps)
			? normalizeSteps(raw.completedSteps.filter((s): s is string => typeof s === "string"))
			: [],
		pendingSteps: Array.isArray(raw.pendingSteps)
			? normalizeSteps(raw.pendingSteps.filter((s): s is string => typeof s === "string"))
			: [],
		at: typeof raw.at === "number" ? raw.at : 0,
	};
}
