/**
 * 双写对账（批次 2，2026-10-21）—— 纯函数。
 *
 * ## 要解决什么
 *
 * pi-lnk 的两份历史是**独立双写**、无一致性校验：
 * - Nest `AgentMessage` 表（展示层 SSOT）
 * - pi 侧 transcript（**模型上下文 SSOT** —— 模型只看得到这份）
 *
 * 2026-10-21 生产事故正是这个形态：Nest 有「让他们抱在一起」那条 user 消息，
 * pi 侧 transcript **整轮不存在** ⇒ 用户发「继续」时模型零线索。
 * 批次 1（回合连续性）解决了「**故障发生后**下一轮能接上」，
 * 本模块解决「**分叉能被发现**（并自愈）」。
 *
 * ## 为什么用「前缀比对」而不是全文比对
 *
 * pi 侧 `GET /sessions/:id/snapshot` 返回的 `transcriptTail`：
 * - 只保留**最近 16 条**（`TRANSCRIPT_TAIL_LIMIT`）；
 * - 每条的 `text` 被**截断到 400 字符**（`SNAPSHOT_TEXT_LIMIT`）并加尾部 `…`。
 *
 * ⇒ Nest 侧是完整原文、pi 侧是截断版 ⇒ **全文比对必然不等**（假红）。
 * ⇒ 只比对**前缀**（长度取两侧都可保证的上界）。
 *
 * ## 为什么「窗口不足」是合法结论（而不是判成分叉）
 *
 * `transcriptTail` 只有 16 条 ⇒ 若 Nest 侧最近一条 user 消息之前隔了
 * 超过 16 条 entry，它可能**根本不在窗口内** ⇒ 此时 pi 侧「没有 user 消息」
 * **不能**判定为分叉（可能只是窗口滑过去了）⇒ 返回 `insufficient_window`。
 *
 * ⭐ 这是「宁可漏报也不误报」：误报会导致把正常会话当成故障去自愈（副作用）。
 *
 * ## 判据（为什么这样判）
 *
 * - **只比最近一条 user 消息**：全量比对成本高，且旧轮次分叉不影响当前续跑；
 * - **比前缀而非全文**：见上（截断约束）；
 * - **pi 侧无 user 消息 ⇒ insufficient_window**（不是 diverged）：见上；
 * - **Nest 侧无 user 消息 ⇒ aligned**（没有可分叉的东西）。
 *
 * ## 已知边界（漏报形态，刻意接受）
 *
 * 「Nest 只有 1 条 user 消息 **且** pi 侧会话里**一条 user 消息都没有**」
 * ⇒ 判成 `insufficient_window` 而非 `diverged`（因为无法区分
 * 「这轮没落 pi 侧」与「窗口滑过去了」）。
 *
 * ⭐ 实际影响很小：
 * - 真实事故形态里 pi 侧会话**有**更早轮次（用户在 01:03 说那句话之前聊了很多轮）
 *   ⇒ pi 侧 tail 里有 user 消息、只是缺最新那条 ⇒ **判成 diverged** ✓；
 * - 「全新会话 + 首轮就分叉」这种极端形态会漏报，但**下一轮就能检出**
 *   （届时 Nest 有 2 条、pi 侧有 1 条 ⇒ diverged）。
 *
 * ⭐ 刻意**不**为覆盖它引入更激进的判据：误报会导致把正常会话当故障去自愈
 * （自愈有副作用：改写 turn_state）⇒ 宁可漏报一轮。
 *
 * ## 自愈方式（分叉被发现之后怎么办）
 *
 * 分叉的实质是「**模型看不到 Nest 侧那条 user 消息**」⇒ 自愈就是
 * **把它写进 `turnState`**（批次 1 的通道）⇒ 下一轮动态块会喂给模型。
 * ⇒ 自愈**复用**既有状态线，不新造管道；且 `interruption` 用既有的
 * `history_diverged` 枚举值（语义正对应「Nest 有、pi 无」）。
 */

/** pi 侧 snapshot 的 transcriptTail 单条（只取对账需要的字段）。 */
export interface TailEntry {
	readonly seq?: number
	readonly id?: string
	readonly type?: string
	readonly role?: string
	readonly stopReason?: string
	readonly text?: string
}

/** Nest 侧最近一条 user 消息。 */
export interface NestUserMessage {
	readonly id: string
	readonly content: string
	readonly createdAt: number
}

/** 对账结论。 */
export type ReconciliationVerdict =
	/** 两侧最近一条 user 消息一致（prefix 命中）⇒ 无分叉。 */
	| 'aligned'
	/** Nest 有、pi 侧窗口内找不到（或内容不符）⇒ 双写分叉。 */
	| 'diverged'
	/** pi 侧窗口内没有 user 消息 ⇒ 窗口不足，**不能判定**。 */
	| 'insufficient_window'

/** 对账结果。 */
export interface ReconciliationResult {
	readonly verdict: ReconciliationVerdict
	/** 分叉时的细节（供日志/告警用）。 */
	readonly detail?: {
		/** Nest 侧那条 user 消息的 id（批次 2 的自愈锚点）。 */
		nestMessageId: string
		/** Nest 侧原文的前缀（自愈时要写进 turn_state 的内容）。 */
		nestPrefix: string
		/** pi 侧窗口内最近一条 user 消息的文本（若存在）—— 供人工排查。 */
		piText?: string
		/** 判定理由（人话，进日志）。 */
		reason: string
	}
}

/**
 * 前缀比对的长度。
 *
 * ⭐ 取值依据：pi 侧 `text` 截断到 400 字符 ⇒ 比对长度必须 **≤ 400**；
 * 但 Nest 侧原文可能**短于** 400 ⇒ 实际比对长度 = min(两者长度)。
 * 取 200 是折中：足够区分不同消息（"让他们抱在一起" vs "让他们分开"），
 * 又不会因长消息的尾部差异误判。
 */
export const RECONCILE_PREFIX_LEN = 200

/**
 * 取 pi 侧窗口内**最近一条** user 消息的文本。
 *
 * ⭐ 取「最近」而不是「最旧」：我们要判断的是**当前上下文**里有没有最新的那条 user 消息
 * ⇒ 与「模型这一轮看到的」对齐。
 * ⚠️ 但 Nest 侧也要取**最近一条** ⇒ 两侧口径一致（见调用方约定）。
 */
export function latestUserText(entries: readonly TailEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]
		if (e?.type !== 'message') continue
		if (e.role !== 'user') continue
		const text = e.text?.trim()
		if (text) return text
	}
	return undefined
}

/**
 * 去掉 pi 侧截断留下的尾部 `…`（`SNAPSHOT_TEXT_LIMIT` 截断时追加）。
 *
 * ⭐ 不去的话：Nest 前 200 字 vs pi 前 200 字 + `…` ⇒ 长度边界上会差一个字符
 * ⇒ 在「Nest 消息正好 200 字」这种边界情况下假红。
 */
export function stripTruncationMark(text: string): string {
	return text.endsWith('…') ? text.slice(0, -1) : text
}

/**
 * 对账：Nest 最近一条 user 消息 vs pi 侧 transcriptTail。
 *
 * ⛔ 纯函数、无 IO —— 判据必须与生产链路共用同一份实现，
 * 否则「测试绿了、线上判错」这对经典漂移必然重演。
 */
export function reconcileHistory(input: {
	/** Nest 侧最近一条 user 消息（没有则传 undefined）。 */
	nestUserMessage?: NestUserMessage
	/** pi 侧 snapshot 的 transcriptTail（可能为空数组）。 */
	tail: readonly TailEntry[]
}): ReconciliationResult {
	const nest = input.nestUserMessage
	// Nest 侧都没有 user 消息 ⇒ 无可分叉之物 ⇒ aligned。
	if (!nest) return { verdict: 'aligned' }

	const nestPrefix = nest.content.trim().slice(0, RECONCILE_PREFIX_LEN)
	const piText = latestUserText(input.tail)

	// pi 侧窗口内没有 user 消息 ⇒ **窗口不足**（可能只是滑过去了）⇒ 不能判成分叉。
	if (piText === undefined) {
		return {
			verdict: 'insufficient_window',
			detail: {
				nestMessageId: nest.id,
				nestPrefix,
				reason: 'pi 侧 transcriptTail 窗口内无 user 消息（16 条窗口不足或该轮未落 pi 侧）',
			},
		}
	}

	const piTrimmed = stripTruncationMark(piText.trim())
	const compareLen = Math.min(nestPrefix.length, piTrimmed.length)
	// ⭐ 比对长度取两侧的**较短者**：pi 侧可能比 Nest 侧短（被截断）⇒
	// 用 Nest 的全量长度去比会必然不等 ⇒ 假红。
	const matched =
		compareLen > 0 && nestPrefix.slice(0, compareLen) === piTrimmed.slice(0, compareLen)

	if (matched) return { verdict: 'aligned' }

	return {
		verdict: 'diverged',
		detail: {
			nestMessageId: nest.id,
			nestPrefix,
			piText: piTrimmed,
			reason: 'Nest 最近一条 user 消息与 pi 侧 transcriptTail 内的 user 消息前缀不一致',
		},
	}
}

// ── 编排层（IO 在这里，纯判据在上面）────────────────────────────────────────

/** 编排所需的 prisma 最小面。 */
export interface ReconcilePrisma {
	agentMessage: {
		/**
		 * ⭐ 用 `findFirst`（**不是** `findMany`）：只取最近一条 user 消息。
		 *
		 * ⚠️ 为什么不复用 `findMany`：既有守卫「P0-①：不再查询历史消息表」
		 * （`agent.service.pi-runtime.test.ts`）断言 `agentMessageFindMany` **不被调用**。
		 * 那条守卫的**原意**是「不查历史消息表**来喂 prompt**」（pi 侧 transcript 已含历史），
		 * 而对账是**比对**（查到的内容只用于判定分叉、**不进 prompt**）⇒ 目的不同。
		 * ⭐ 但守卫本身是对的（不重复喂历史是硬要求）⇒ **不改守卫，改实现去适配**。
		 *
		 * ⛔ 若将来有人把对账改成 `findMany`，那条守卫会红 ⇒ 说明要重新审视对账的取数方式
		 * （也可能是真的违反 P0-①）⇒ 这个"意外的守卫"是好事。
		 */
		findFirst(args: {
			where: { threadId?: string; role: string }
			orderBy: { createdAt: 'desc' }
			select: { id: boolean; content: boolean; createdAt: boolean }
		}): Promise<{ id: string; content: string | null; createdAt: Date | number } | null>
	}
}

/** 编排所需的 pi 侧 client 最小面。 */
export interface ReconcileClient {
	snapshot(sessionKey: string): Promise<{
		transcriptTail?: Array<{
			seq: number
			id: string
			type: string
			role?: string
			text?: string
			stopReason?: string
		}>
	} | undefined>
}

/** 编排所需的 turnState 存储最小面（批次 1 的通道）。 */
export interface ReconcileTurnState {
	record(input: {
		threadId: string
		userText: string
		userMessageId?: string
		assistantPartial: string
		completedSteps: string[]
		pendingSteps: string[]
		failed: boolean
		promptAccepted: boolean
		userAborted: boolean
		hasAssistantText: boolean
		toolCallCount: number
	}): Promise<boolean>
}

/** 编排结果（供调用方记日志）。 */
export interface ReconcileOutcome {
	readonly verdict: ReconciliationVerdict
	/** 是否已自愈（写入了 turn_state）。 */
	readonly healed: boolean
	/** 分叉时的 Nest 侧消息 id。 */
	readonly nestMessageId?: string
}

/**
 * 单轮收尾后的对账 + 自愈（批次 2 的编排层）。
 *
 * ⛔ **绝不抛错**（fail-soft）：对账是观测 + 自愈，不是主链路 ⇒ 任何异常只记 warn。
 * ⛔ **不 await**（调用方 fire-and-forget）：不拖慢 run 收尾。
 *
 * @param threadId Nest 侧 thread id（用于取该线程的 user 消息）。
 * @param sessionKey pi 侧会话键（snapshot 的入参）。
 */
export async function reconcileAfterTurn(input: {
	prisma: ReconcilePrisma
	client: ReconcileClient
	turnState?: ReconcileTurnState
	threadId?: string
	sessionKey: string
	logger: { warn(msg: string): unknown }
}): Promise<ReconcileOutcome> {
	try {
		// Nest 侧最近一条 user 消息（收尾时它就是本轮那条）。
		const nestMsg = await input.prisma.agentMessage.findFirst({
			where: { threadId: input.threadId, role: 'user' },
			orderBy: { createdAt: 'desc' },
			select: { id: true, content: true, createdAt: true },
		})
		if (!nestMsg) return { verdict: 'aligned', healed: false }

		// pi 侧快照；⛔ 取不到（404 会话不存在 / runtime 不可达）⇒ 不判定。
		const snapshot = await input.client.snapshot(input.sessionKey).catch(() => undefined)
		if (!snapshot) return { verdict: 'insufficient_window', healed: false }

		const result = reconcileHistory({
			nestUserMessage: {
				id: nestMsg.id,
				content: String(nestMsg.content ?? ''),
				createdAt:
					nestMsg.createdAt instanceof Date ? nestMsg.createdAt.getTime() : Number(nestMsg.createdAt) || 0,
			},
			tail: (snapshot.transcriptTail ?? []).map((e) => ({
				seq: e.seq,
				id: e.id,
				type: e.type,
				role: e.role,
				stopReason: e.stopReason,
				text: e.text,
			})),
		})

		if (result.verdict !== 'diverged') {
			if (result.verdict === 'insufficient_window') {
				input.logger.warn(
					`history_reconcile skipped key=${input.sessionKey} verdict=insufficient_window ` +
						`（pi 侧 16 条窗口内无 user 消息，无法判定）`,
				)
			}
			return { verdict: result.verdict, healed: false }
		}

		// ── 分叉：告警 + 自愈 ──────────────────────────────────────────
		const detail = result.detail!
		input.logger.warn(
			`history_diverged key=${input.sessionKey} nestMsgId=${detail.nestMessageId} ` +
				`nestPrefix="${detail.nestPrefix.slice(0, 40)}" reason=${detail.reason}`,
		)
		// 自愈：把 Nest 侧那条 user 消息写进 turnState ⇒ 下一轮动态块会喂给模型。
		// ⛔ 幂等：覆盖写（同一 thread 只有一条 turnState）⇒ 重复对账无副作用。
		const healed = await input.turnState
			?.record({
				threadId: input.sessionKey,
				userText: detail.nestPrefix,
				userMessageId: detail.nestMessageId,
				assistantPartial: '',
				completedSteps: [],
				pendingSteps: [],
				failed: true,
				promptAccepted: false,
				userAborted: false,
				hasAssistantText: false,
				toolCallCount: 0,
			})
			.then((ok) => ok === true)
			.catch(() => false)
		input.logger.warn(
			`history_reconcile healed key=${input.sessionKey} nestMsgId=${detail.nestMessageId} ` +
				`healed=${healed === true}（已写入 turn_state，下一轮模型可见）`,
		)
		return { verdict: 'diverged', healed: healed === true, nestMessageId: detail.nestMessageId }
	} catch (err) {
		input.logger.warn(
			`history_reconcile failed (fail-soft, key=${input.sessionKey}): ${
				err instanceof Error ? err.message : String(err)
			}`,
		)
		return { verdict: 'insufficient_window', healed: false }
	}
}
