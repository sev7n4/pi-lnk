/**
 * 回合连续性状态（turn state）—— **共享类型层**。
 *
 * ## 这份数据的地位：它是「第四份历史」的守护者
 *
 * pi-lnk 已有三份历史/状态载体：
 * 1. **Nest `AgentMessage` 表** —— 展示层 SSOT（前端消息列表）；
 * 2. **pi 侧 transcript** —— 模型上下文 SSOT（喂模型的唯一来源）；
 * 3. **canvas `Session.canvasData`** —— 画布状态 SSOT。
 *
 * 而「上一轮任务进行到哪」这件事**不属于上面任何一份**：
 * - 不在 (1)：那是「说了什么」，故障轮的 user 消息虽在，但助手做到哪不在；
 * - 不在 (2)：上游 `isContextMessage` 会把 `error/aborted` 轮排除出上下文
 *   （`vendor/…/harness/session/context.ts:24-29`），且双写分叉时该轮整轮缺失；
 * - 不在 (3)：画布只说「有哪些节点」，不说「用户要什么、卡在哪一步」。
 *
 * ⇒ 它必须是**独立的第四份状态**，且**权威副本必须在 Nest 侧**
 * （模型只看得到 pi 侧；pi 侧那份只能是投影，不能是 SSOT）。
 *
 * ## 为什么不放 pi 侧 transcript（2026-10-21 自我审查结论）
 *
 * 初版（PR #525）把状态写成 pi transcript 的自定义条目
 * （`appendCustomEntry` + `entryProjectors`），三处不成立：
 *
 * 1. **压缩必丢**：`buildContextEntries`（`context.ts:10-23`）在有 compaction 时返回
 *    `[compaction, ...compaction之后的entries]` ⇒ compaction **之前**的自定义条目被丢弃；
 *    且 `CompactionEntry.retainedTail: AgentMessage[]`（`types.ts:36`）**只含 message**。
 *    ⇒ 「落在 transcript 里天然跨压缩存活」是**错的**。
 * 2. **第三条真相线**：Nest 已有「不再查 AgentMessage 历史喂 prompt」的决策
 *    （`agent.service.ts:410`），再加一份 pi 侧状态 = 多一处分叉面。
 * 3. **绕过了宿主既有通道**：项目早就有跨压缩保留机制
 *    （`services/pi-runtime/src/compaction-retention.ts` 的 `RetentionState`
 *    → `lane.compact({ customInstructions })` ⇒ 拼进压缩摘要 prompt）。
 *    另开通道 = 违背「吃满上游」的第一步：**先穷尽宿主既有的同类通道**。
 *
 * ⇒ 修正后的形态：**权威在 Nest DB**，每轮重新求值喂给模型（与 `todo` 块同模式），
 * 跨压缩走**既有** `RetentionState` 通道。
 */

/** 中断类型分类。 */
export type TurnInterruption =
	/** 上游明确以 error/aborted 收尾（含进程重启后的孤儿结算）。 */
	| "upstream_error"
	/** 工具执行期间流断（工具可能已产生副作用）。 */
	| "tool_interrupted"
	/** 上游 409 / 会话忙。 */
	| "session_busy"
	/** Nest ↔ pi 传输失败（prompt 未被接受 ⇒ 该轮在 pi 侧整轮不存在）。 */
	| "transport_failed"
	/** Nest 侧落库成功但 pi 侧整轮缺失（双写分叉，2026-10-21 生产形态）。 */
	| "history_diverged"
	/** 原因不明。 */
	| "unknown";

/**
 * 一条「回合状态」——模型唯一能看到的、跨故障仍然存活的东西。
 *
 * ⭐ 与「对话历史」的分工（WorkBuddy 的 task state vs conversation history）：
 * - 对话历史 = 模型说了什么（会被压缩、会被过滤、故障时可能整段消失）；
 * - 回合状态 = **任务进行到哪一步**（结构化、跨故障、跨压缩存活）。
 */
export interface TurnState {
	/** 出问题那一轮的 user 原文（截断后）。模型靠它知道「用户本来要我做什么」。 */
	userText: string;
	/** 那一轮助手已产出的内容（截断后）。可能是空（模型还没开口就挂了）。 */
	assistantPartial: string;
	/** 中断类型。 */
	interruption: TurnInterruption;
	/** 那一轮已经**确定完成**的步骤（工具名，模型认识这些词）。 */
	completedSteps: string[];
	/** 那一轮**正在做但没做完**的步骤。 */
	pendingSteps: string[];
	/** 中断发生的 Unix 毫秒。 */
	at: number;
	/**
	 * 该状态所属的 user 消息 id（Nest 侧 `AgentMessage.id`）。
	 *
	 * ⭐ 用途：**对账锚点**。批次 2 要校验「Nest 侧的这条 user 消息在 pi 侧 transcript
	 * 里是否存在」⇒ 必须能精确定位到「是哪一条」，否则只能比「最后一条」（弱得多）。
	 */
	userMessageId?: string;
}

/** `userText` / `assistantPartial` 的保留上限（字符）。 */
export const TURN_STATE_MAX_TEXT = 1200;
/** `completedSteps` / `pendingSteps` 的条数上限。 */
export const TURN_STATE_MAX_STEPS = 8;
/** 单条步骤的最大长度（字符）。 */
export const TURN_STATE_MAX_STEP_LEN = 200;

/**
 * 截断文本（保留首尾，中间省略——尾部往往是最接近故障点的信息）。
 *
 * 纯函数：Nest 侧写库前、渲染前都调它 ⇒ 判据只有一份实现。
 */
export function truncateTurnText(text: string, limit = TURN_STATE_MAX_TEXT): string {
	const trimmed = (text ?? "").trim();
	if (trimmed.length <= limit) return trimmed;
	const head = Math.floor(limit * 0.6);
	const tail = limit - head - 3;
	return `${trimmed.slice(0, head)}...${trimmed.slice(-tail)}`;
}

/** 规范化步骤列表：去空白、去空项、截断条数与长度。 */
export function normalizeTurnSteps(
	steps: readonly string[] | undefined,
	limit = TURN_STATE_MAX_STEPS,
): string[] {
	if (!steps?.length) return [];
	const out: string[] = [];
	for (const raw of steps) {
		const s = (raw ?? "").trim();
		if (!s) continue;
		out.push(truncateTurnText(s, TURN_STATE_MAX_STEP_LEN));
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * 构造回合状态（纯函数，无 IO）。
 *
 * ⭐ 判据：**宁可少说也不多说**（不冒充知道）。
 * 不知道「助手说了什么」就留空——模型看到空 partial 时会自己去感知画布，
 * 这比编造一段半截输出安全得多（编造会让模型以为「我已经开始做了」而重复执行）。
 */
export function buildTurnState(input: {
	userText: string;
	assistantPartial?: string;
	interruption: TurnInterruption;
	completedSteps?: readonly string[];
	pendingSteps?: readonly string[];
	at: number;
	userMessageId?: string;
}): TurnState {
	return {
		userText: truncateTurnText(input.userText),
		assistantPartial: truncateTurnText(input.assistantPartial ?? ""),
		interruption: input.interruption,
		completedSteps: normalizeTurnSteps(input.completedSteps),
		pendingSteps: normalizeTurnSteps(input.pendingSteps),
		at: input.at,
		...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
	};
}

/** 中断类型的人话描述（给模型看）。 */
export function describeTurnInterruption(kind: TurnInterruption): string {
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
 * 渲染**指导指令**部分（与状态事实分离）。
 *
 * ⭐ 为什么拆开：状态事实里出现「画布」是**正常的**（已完成步骤可能就是
 * 「已读取画布摘要」），而「不要靠观察画布反推用户意图」是**指令**层面的约束。
 * 两者混在一段文本里，判据就没法精确表达——测试只能靠禁词猜，禁词一撞就假红。
 * 拆开后：事实照实写，指令只管推理路径。
 *
 * ⭐ 措辞纪律（对齐 WorkBuddy 的 "Resume directly — no apology, no recap"）：
 * 不道歉、不复盘、不说「我上次失败了」；直接陈述事实状态 + 下一步该干什么。
 */
export function renderTurnStateGuidance(): string {
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

	lines.push(`中断类型：${describeTurnInterruption(state.interruption)}。`);
	lines.push(renderTurnStateGuidance());
	return lines.join("\n");
}

/**
 * 渲染**压缩保留段**用的一行摘要（进 `RetentionState`）。
 *
 * ⭐ 为什么要有这个形态：跨压缩的通道是 `lane.compact({ customInstructions })`
 * ⇒ vendor 把它拼进**摘要 prompt**（`compaction.ts:567`）⇒ 只能是一段**自然语言**，
 * 不是结构化数据。而跨压缩后模型看到的是**摘要**，所以这里必须自带足够信息。
 *
 * ⚠️ 长度受 compaction 保留段的截断上限约束（`MAX_ITEM_LEN=120`）⇒ 必须短。
 * 完整状态仍由每轮动态块承载；这一行只保证「压缩后不彻底失忆」。
 */
export function renderTurnStateRetentionLine(state: TurnState): string {
	const parts: string[] = [];
	parts.push(`上一轮被中断，用户要「${truncateTurnText(state.userText, 60)}」`);
	if (state.pendingSteps.length > 0) {
		parts.push(`未完成 ${truncateTurnText(state.pendingSteps.join("、"), 40)}`);
	} else if (state.completedSteps.length > 0) {
		parts.push(`已完成 ${truncateTurnText(state.completedSteps.join("、"), 40)}`);
	}
	parts.push("接续时直接继续，不要重新推断意图");
	return parts.join("；");
}

/**
 * 容错解析持久化后的回合状态。
 *
 * ⭐ 判据：**解析不出来就返回 undefined**（⇒ 不注入）——
 * 宁可这一轮没有恢复提示，也不能把一段坏数据当事实投给模型
 * （「不冒充知道」原则，与 turn-ledger.ts 同源）。
 */
export function parseTurnState(data: unknown): TurnState | undefined {
	if (data === null || typeof data !== "object") return undefined;
	const raw = data as Record<string, unknown>;

	const userText = typeof raw.userText === "string" ? raw.userText : undefined;
	if (userText === undefined) return undefined;

	const interruption = raw.interruption;
	const kind: TurnInterruption =
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
		completedSteps: normalizeTurnSteps(
			Array.isArray(raw.completedSteps)
				? raw.completedSteps.filter((s): s is string => typeof s === "string")
				: undefined,
		),
		pendingSteps: normalizeTurnSteps(
			Array.isArray(raw.pendingSteps)
				? raw.pendingSteps.filter((s): s is string => typeof s === "string")
				: undefined,
		),
		at: typeof raw.at === "number" ? raw.at : 0,
		...(typeof raw.userMessageId === "string" && raw.userMessageId
			? { userMessageId: raw.userMessageId }
			: {}),
	};
}
