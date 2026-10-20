/**
 * 回合连续性 —— Nest 侧「中断时捕获任务状态」模块（2026-10-21）。
 *
 * ## 为什么要这个模块
 *
 * 2026-10-21 生产事故：用户在移动端让 agent「让他们抱在一起」，中途因故障中断；
 * 20 分钟后用户发「继续」，agent 答「当前画布上有：河马摸鱼图 / 小男孩图…」。
 *
 * 取证结论（详见 `docs/agent/turn-continuity-design.md`）：
 * - Nest 侧 `AgentMessage` 表**有** 01:03:50 的 user 消息「让他们抱在一起」；
 * - pi 侧 transcript **没有**这一轮（该时间窗内 0 条 entry，`COMPACTION_COUNT=0`）；
 * - 用户发「继续」时，模型上下文里既没有那条 user 消息，也没有任何
 *   「我正在做什么」的线索 ⇒ 只能退化成「读画布猜意图」。
 *
 * 两份历史（Nest DB / pi transcript）是**独立双写**，无一致性校验 ⇒ 静默分叉。
 * 而模型只看得到 pi 侧。
 *
 * ## 本模块的定位
 *
 * **在中断发生的当下**，把「用户要什么 / 做到哪 / 卡在哪」捕获下来，
 * 交给 pi-runtime 写进 transcript（上游 `appendCustomEntry`），
 * 于是下一轮模型能看到 —— 无需依赖对话历史本身是否完好。
 *
 * ⭐ 这与「关键词识别『继续』」是**不同路线**：
 * - 关键词方案要猜用户意图（「继续」到底指什么？），在「接着改那个组件」这类
 *   表达上立刻失效，且需要维护一份脆弱的同义词表；
 * - 本方案让**状态本身**跨故障存活，用户说什么都能接上
 *   （对齐 Codex / Claude Code / WorkBuddy 三方共识：恢复靠信息在状态里，不靠猜意图）。
 *
 * ## 纯函数边界
 *
 * 本文件只放**纯函数**（无 IO、无 Nest 依赖）：判定与归并的判据必须与生产链路
 * 共用同一份实现，否则「测试绿了、线上判错」这对经典漂移必然重演
 * （同 `turn-ledger.ts` 的立场）。
 */

/** 中断类型（与 pi-runtime `turn-state.ts` 的枚举同域，Nest 侧独立定义避免跨包耦合）。 */
export type TurnInterruption =
	/** 上游明确以 error/aborted 收尾。 */
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
 * 一条工具执行记录（用于推导「做到哪一步」）。
 *
 * 只取判定需要的最小字段：工具名 + 是否成功。
 */
export interface ToolAttempt {
	readonly toolName: string;
	readonly ok: boolean;
}

/**
 * 从工具执行记录推导「已完成步骤」与「未完成步骤」。
 *
 * ⭐ 判据（保守优先）：
 * - **已完成** = 工具**成功返回**的那些 —— 成功的副作用真实发生，重做会重复出图/重复建节点；
 * - **未完成** = 「被调用但没成功」的最后一个工具 —— 那正是中断点所在；
 * - 工具**根本没被调用**的意图 ⇒ 不猜（模型会自己看 todo 清单与画布）。
 *
 * ⚠️ 为什么不做「把工具名翻译成人话」：工具名（`run_image_generation`）对模型
 * 是**已知词汇**（它在工具表里），翻译反而引入歧义与维护成本。
 *
 * ⚠️ 失败工具**永不计作已完成**：它可能已产生部分副作用（节点建了一半、任务已提交），
 * 说它「完成」会让模型跳过它 ⇒ 状态错乱。它只作为**卡点**出现。
 */
export function deriveSteps(attempts: readonly ToolAttempt[]): {
	completedSteps: string[];
	pendingSteps: string[];
} {
	const completedSteps: string[] = [];
	let pendingStep: string | undefined;

	for (const attempt of attempts) {
		if (attempt.ok) {
			completedSteps.push(attempt.toolName);
			// 成功即视为推进到了这一步 ⇒ 之前的未完成不再是「当前卡点」。
			pendingStep = undefined;
		} else if (pendingStep === undefined) {
			// 只记**第一个**失败：它是卡点，后续失败多半是它的连锁。
			pendingStep = attempt.toolName;
		}
	}

	return {
		completedSteps,
		pendingSteps: pendingStep === undefined ? [] : [pendingStep],
	};
}

/**
 * 判定一个回合是否「需要留下续跑线索」。
 *
 * ⭐ 判据（**只在真需要时才记**，避免污染 transcript）：
 * - 明确失败（error 事件 / prompt 提交失败）⇒ 要记；
 * - 正常结束 ⇒ **不记**（正常轮次的历史本来就完整，记了是噪声）。
 *
 * ⚠️ 特别地：**用户主动取消不算故障**（那是用户的意图，不是需要恢复的意外），
 * 但「用户取消后 agent 说了一半」仍值得记 —— 判据是「有没有未完成的工作」，
 * 而不是「是不是用户点的取消」。
 */
export function shouldRecordTurnState(input: {
	/** 本轮是否以错误收束。 */
	failed: boolean;
	/** 本轮是否被用户主动取消。 */
	userAborted: boolean;
	/** 本轮是否已产出正文。 */
	hasAssistantText: boolean;
	/** 本轮是否调用过任何工具。 */
	toolCallCount: number;
}): boolean {
	if (input.failed) return true;
	// 正常收束但「有工具调用却没产出正文」⇒ 可能停在半路（例如 propose 卡超时后
	// 助手没说下文）。这种情况值得留线索。
	if (input.hasAssistantText) return false;
	return input.toolCallCount > 0 || input.userAborted;
}

/**
 * 从工具调用事件里抽取工具执行记录。
 *
 * ⭐ 判据：只看**有明确终态**的工具事件（`tool_execution_end` 之类），
 * 纯 `tool_execution_start` 不算 —— 它只说明「开始调了」，不说明「做完了」。
 */
export function collectToolAttempts(
	events: readonly { type: string; data?: unknown }[],
): ToolAttempt[] {
	const attempts: ToolAttempt[] = [];
	for (const event of events) {
		if (event.type !== "tool_execution_end" && event.type !== "tool_end") continue;
		const data = (event.data ?? {}) as { toolName?: string; isError?: boolean };
		const toolName = typeof data.toolName === "string" ? data.toolName : "";
		if (!toolName) continue;
		attempts.push({ toolName, ok: data.isError !== true });
	}
	return attempts;
}
