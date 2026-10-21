/**
 * 回合连续性状态 —— Nest 侧**权威存储**（2026-10-21 回合连续性修正）。
 *
 * ## 定位
 *
 * 这是「上一轮任务进行到哪」的**唯一权威副本**（存 `AgentThread.turnState`）。
 * pi 侧 transcript 里那份（若存在）**只是投影**，不是 SSOT。
 *
 * ⭐ 修正的由来（2026-10-21 自我审查）：
 * 初版（PR #525）把状态写成 pi 侧自定义条目（`appendCustomEntry` + `entryProjectors`），
 * 三处不成立：
 * 1. **压缩必丢**：`buildContextEntries`（`vendor/…/harness/session/context.ts:10-23`）
 *    在有 compaction 时返回 `[compaction, ...compaction之后的entries]`
 *    ⇒ compaction **之前**的自定义条目被丢弃；且 `CompactionEntry.retainedTail`
 *    的类型是 `AgentMessage[]`（`types.ts:36`）⇒ **只含 message，不含 custom entry**。
 *    ⇒ 「落在 transcript 里天然跨压缩存活」是**错的**。
 * 2. **第三条真相线**：Nest 已决定「不再查 AgentMessage 历史喂 prompt」
 *    （`agent.service.ts:410`），再加一份 pi 侧状态 = 多一处分叉面。
 * 3. **绕过了宿主既有通道**：项目早就有跨压缩保留机制
 *    （`services/pi-runtime/src/compaction-retention.ts` 的 `RetentionState`
 *    → `lane.compact({ customInstructions })` ⇒ 拼进压缩摘要 prompt）。
 *
 * ⇒ 修正后：**权威在 Nest**，每轮重新求值喂给模型（与 `todo` 块同模式），
 * 跨压缩走**既有** `RetentionState` 通道。
 *
 * ## 纯函数边界
 *
 * 本文件只放**纯函数**（无 IO、无 Nest 依赖）：判定与归并的判据必须与生产链路
 * 共用同一份实现，否则「测试绿了、线上判错」这对经典漂移必然重演
 * （同 `turn-ledger.ts` 的立场）。
 */

import type { TurnInterruption } from '@lnkpi/shared'

/**
 * 从工具执行记录推导「已完成步骤」与「未完成步骤」。
 *
 * ⭐ 判据（保守优先）：
 * - **已完成** = 工具**成功返回**的那些 —— 成功的副作用真实发生，重做会重复出图/重复建节点；
 * - **未完成** = 「被调用但没成功」的最后一个工具 —— 那正是中断点所在；
 * - 工具**根本没被调用**的意图 ⇒ 不猜（模型会自己看 todo 清单与画布）。
 *
 * ⚠️ 失败工具**永不计作已完成**：它可能已产生部分副作用（节点建了一半、任务已提交），
 * 说它「完成」会让模型跳过它 ⇒ 状态错乱。它只作为**卡点**出现。
 *
 * ⚠️ 为什么不做「把工具名翻译成人话」：工具名（`run_image_generation`）对模型
 * 是**已知词汇**（它在工具表里），翻译反而引入歧义与维护成本。
 */
export function deriveSteps(attempts: readonly ToolAttempt[]): {
	completedSteps: string[]
	pendingSteps: string[]
} {
	const completedSteps: string[] = []
	let pendingStep: string | undefined

	for (const attempt of attempts) {
		if (attempt.ok) {
			completedSteps.push(attempt.toolName)
			// 成功即视为推进到了这一步 ⇒ 之前的未完成不再是「当前卡点」。
			pendingStep = undefined
		} else if (pendingStep === undefined) {
			// 只记**第一个**失败：它是卡点，后续失败多半是它的连锁。
			pendingStep = attempt.toolName
		}
	}

	return {
		completedSteps,
		pendingSteps: pendingStep === undefined ? [] : [pendingStep],
	}
}

/**
 * 一条工具执行记录（用于推导「做到哪一步」）。
 * 只取判定需要的最小字段：工具名 + 是否成功。
 */
export interface ToolAttempt {
	readonly toolName: string
	readonly ok: boolean
}

/**
 * 判定一个回合是否「需要留下续跑线索」。
 *
 * ⭐ 判据（**只在真需要时才记**，避免污染状态与 transcript）：
 * - 明确失败（error 事件 / prompt 提交失败）⇒ 要记；
 * - 正常结束 ⇒ **不记**（正常轮次的历史本来就完整，记了是噪声）。
 *
 * ⚠️ 特别地：**用户主动取消不算故障**（那是用户的意图，不是需要恢复的意外），
 * 但「用户取消后 agent 说了一半」仍值得记 —— 判据是「有没有未完成的工作」，
 * 而不是「是不是用户点的取消」。
 */
export function shouldRecordTurnState(input: {
	/** 本轮是否以错误收束。 */
	failed: boolean
	/** 本轮是否被用户主动取消。 */
	userAborted: boolean
	/** 本轮是否已产出正文。 */
	hasAssistantText: boolean
	/** 本轮是否调用过任何工具。 */
	toolCallCount: number
}): boolean {
	if (input.failed) return true
	// 正常收束但「有工具调用却没产出正文」⇒ 可能停在半路（例如 propose 卡超时后
	// 助手没说下文）。这种情况值得留线索。
	if (input.hasAssistantText) return false
	return input.toolCallCount > 0 || input.userAborted
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
	const attempts: ToolAttempt[] = []
	for (const event of events) {
		if (event.type !== 'tool_execution_end' && event.type !== 'tool_end') continue
		const data = (event.data ?? {}) as { toolName?: string; isError?: boolean }
		const toolName = typeof data.toolName === 'string' ? data.toolName : ''
		if (!toolName) continue
		attempts.push({ toolName, ok: data.isError !== true })
	}
	return attempts
}

/**
 * 判定「prompt 是否被 pi 接受」→ 决定中断类型。
 *
 * ⭐ 这是 2026-10-21 生产事故的关键分档：
 * - `promptAccepted === false` ⇒ pi 侧**整轮不存在**（Nest 有、pi 无）
 *   ⇒ 归类 `history_diverged`（双写分叉）；
 * - `promptAccepted === true` 但 run 失败 ⇒ pi 侧有这轮，但上游 `isContextMessage`
 *   会把 error/aborted 的 assistant 排除出上下文 ⇒ 归类 `upstream_error`。
 *
 * ⚠️ 两种都记（都要留线索），但**分档要准**——它决定模型看到的中断说明，
 * 也决定批次 2 对账时该查什么。
 */
export function classifyInterruption(input: {
	failed: boolean
	promptAccepted: boolean
}): TurnInterruption {
	if (!input.promptAccepted) return 'history_diverged'
	if (input.failed) return 'upstream_error'
	return 'unknown'
}
