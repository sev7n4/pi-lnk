/**
 * 回合连续性状态 —— Nest 侧**权威存储**服务（2026-10-21 回合连续性修正）。
 *
 * ## 为什么权威在 Nest 侧（而不是 pi transcript）
 *
 * 2026-10-21 自我审查结论（初版 PR #525 把状态写成 pi 侧自定义条目，三处不成立）：
 *
 * 1. **压缩必丢**：`buildContextEntries`（`vendor/…/harness/session/context.ts:10-23`）
 *    在有 compaction 时返回 `[compaction, ...compaction之后的entries]`
 *    ⇒ compaction **之前**的自定义条目被丢弃；
 *    且 `CompactionEntry.retainedTail: AgentMessage[]`（`types.ts:36`）**只含 message**。
 * 2. **第三条真相线**：Nest 已决定「不再查 AgentMessage 历史喂 prompt」
 *    （`agent.service.ts:410`），再加一份 pi 侧状态 = 多一处分叉面。
 * 3. **绕过了宿主既有通道**：跨压缩保留早就有
 *    （`services/pi-runtime/src/compaction-retention.ts` 的 `RetentionState`
 *    → `lane.compact({ customInstructions })` ⇒ 拼进压缩摘要 prompt）。
 *
 * ⇒ 权威落 `AgentThread.turnState`（Nest DB），**每轮重新求值**喂给模型 ——
 * 与 `todo` 块「跨压缩存活」是**同一个机制**
 * （`session-manager.ts:2358-2369` 的注释：压缩后每次 LLM 请求重新求值
 * systemPrompt，块恒在）。于是 **pi 侧零改动**，也省掉一次 runtime 部署。
 *
 * ## 本文件职责
 *
 * - 写：中断时把状态落库（权威副本）；
 * - 读：每轮装配 prompt 时读出 → 渲染成 dynamic block 喂给模型；
 * - 清：状态被**消费**后清除（否则每轮都注入同一段陈旧状态 ⇒ 噪音 + 误导）。
 *
 * ## 纯函数边界
 *
 * 判定逻辑全在 `turn-state-store.ts`（纯函数）；本文件只做 IO 编排。
 */

import { Inject, Injectable, Logger } from '@nestjs/common'
import {
	buildTurnState,
	parseTurnState,
	renderTurnStateBlock,
	renderTurnStateRetentionLine,
	type TurnState,
} from '@lnkpi/shared'
import { classifyInterruption } from './turn-state-store'
import { PrismaService } from '../prisma/prisma.service'

/** prisma 客户端的最小形状（避免整个 PrismaClient 类型耦合）。 */
interface TurnStatePrisma {
	agentThread?: {
		update?: (args: unknown) => Promise<unknown>
		findUnique?: (args: unknown) => Promise<{ turnState?: string | null } | null>
	}
}

/** 记录状态的输入。 */
export interface RecordTurnStateInput {
	/** 线程 id（`sessionId:suffix`）。 */
	threadId: string
	/** 该轮的 user 原文。 */
	userText: string
	/** 该轮 user 消息的 id（对账锚点）。 */
	userMessageId?: string
	/** 该轮助手已产出的内容。 */
	assistantPartial: string
	/** 已完成步骤（工具名）。 */
	completedSteps: string[]
	/** 未完成步骤（工具名）。 */
	pendingSteps: string[]
	/** 本轮是否以错误收束。 */
	failed: boolean
	/** 本轮 prompt 是否被 pi 接受。 */
	promptAccepted: boolean
	/** 该轮是否被用户主动取消。 */
	userAborted: boolean
	/** 该轮是否已产出正文。 */
	hasAssistantText: boolean
	/** 该轮工具调用次数。 */
	toolCallCount: number
}

@Injectable()
export class TurnStateService {
	/** Nest 的 Logger 需在构造器外创建（不能作为 DI 依赖注入）。 */
	private readonly logger = new Logger(TurnStateService.name)

	constructor(@Inject(PrismaService) private readonly prisma: TurnStatePrisma) {}

	/**
	 * 写入（覆盖）某线程的回合状态。
	 *
	 * ⛔ fail-soft：任何异常只 warn ——「记不住上一轮」是降级，
	 * 「把用户请求打回去」是事故。
	 */
	async record(input: RecordTurnStateInput): Promise<boolean> {
		try {
			const state = buildTurnState({
				userText: input.userText,
				assistantPartial: input.assistantPartial,
				interruption: classifyInterruption({
					failed: input.failed,
					promptAccepted: input.promptAccepted,
				}),
				completedSteps: input.completedSteps,
				pendingSteps: input.pendingSteps,
				at: Date.now(),
				...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
			})
			// ⚠️ 必须显式校验「真的写了」：可选链（`?.update?.()`）在 prisma 缺
			// `agentThread` 时会**静默跳过**写入并返回 undefined ⇒ 被当成成功
			// ⇒ 「状态没落库」却报成功 ⇒ 故障时模型照样失忆，且无任何日志。
			// ⭐ 判据是「写操作确实发生」，不是「调用没抛错」。
			const update = this.prisma.agentThread?.update
			if (!update) {
				this.logger.warn(`turn_state_record skipped (no agentThread.update, thread=${input.threadId})`)
				return false
			}
			await update.call(this.prisma.agentThread, {
				where: { id: input.threadId },
				data: { turnState: JSON.stringify(state) },
			})
			return true
		} catch (err) {
			this.logger.warn(
				`turn_state_record failed (fail-soft, thread=${input.threadId}): ${
					err instanceof Error ? err.message : String(err)
				}`,
			)
			return false
		}
	}

	/**
	 * 读出某线程的回合状态（**不消费**）。
	 *
	 * ⭐ 读出失败 / 数据损坏 ⇒ 返回 undefined（宁可不注入，也不投坏数据）。
	 */
	async read(threadId: string): Promise<TurnState | undefined> {
		try {
			const row = await this.prisma.agentThread?.findUnique?.({
				where: { id: threadId },
				select: { turnState: true },
			})
			if (!row?.turnState) return undefined
			return parseTurnState(JSON.parse(row.turnState))
		} catch (err) {
			this.logger.warn(
				`turn_state_read failed (fail-soft, thread=${threadId}): ${
					err instanceof Error ? err.message : String(err)
				}`,
			)
			return undefined
		}
	}

	/**
	 * 清除某线程的回合状态（状态**被消费**后调用）。
	 *
	 * ⭐ 清除时机 = **下一轮成功结束后**，不是「注入后立刻清」——
	 * 立刻清的话，若该轮又失败，状态就没了 ⇒ 用户再说「继续」时又失忆。
	 */
	async clear(threadId: string): Promise<void> {
		try {
			// ⚠️ 同 record：可选链在缺 `agentThread` 时会静默跳过 ⇒ 状态永远清不掉
			// ⇒ 下一轮又注入同一段陈旧状态（噪音 + 可能误导模型）。
			const update = this.prisma.agentThread?.update
			if (!update) {
				this.logger.warn(`turn_state_clear skipped (no agentThread.update, thread=${threadId})`)
				return
			}
			await update.call(this.prisma.agentThread, {
				where: { id: threadId },
				data: { turnState: null },
			})
		} catch (err) {
			this.logger.warn(
				`turn_state_clear failed (fail-soft, thread=${threadId}): ${
					err instanceof Error ? err.message : String(err)
				}`,
			)
		}
	}

	/**
	 * 渲染成喂给模型的动态块（**没有状态则返回 undefined**，不产出空块）。
	 *
	 * ⭐ 与 `todo` 块同位置（systemPrompt 尾部动态段），每轮重新求值 ⇒ 跨压缩存活。
	 */
	async renderBlock(threadId: string): Promise<string | undefined> {
		const state = await this.read(threadId)
		if (!state) return undefined
		return renderTurnStateBlock(state)
	}

	/**
	 * 渲染成**压缩保留段**的一行摘要（进 `RetentionState`）。
	 *
	 * ⭐ 为什么还要这一行（动态块不是已经够了吗）：
	 * - 动态块保证「**下一轮**模型看到」；
	 * - 保留段保证「**压缩摘要里**也带着」⇒ 压缩后上下文被摘要替换时，
	 *   状态不至于彻底消失（上游 `retainedTail` 只留 `AgentMessage`，
	 *   压缩前的动态块**不在**其中）。
	 *
	 * ⇒ 两个通道**互补**，不是重复。
	 */
	async renderRetentionLine(threadId: string): Promise<string | undefined> {
		const state = await this.read(threadId)
		if (!state) return undefined
		return renderTurnStateRetentionLine(state)
	}
}
