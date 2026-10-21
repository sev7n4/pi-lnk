/**
 * 回合外生成终态通报（2026-10-18 上游对齐，Nest→lane followUp）。
 *
 * 动机（#456 生产复测后的遗留缺口）：propose 终态等待有 13min cap、run_* HTTP 阻塞
 * 有端点超时——超过后生成继续在 Nest 侧跑，终态落地时**回合已经不在等**，模型与
 * 时间线都无从得知（前端画布对账只翻画布行，agent 侧零感知）。
 *
 * 通路：generation-reaper 每 5min 巡检扫「最近落终态 + 有画布会话 + 未通报」的记录 →
 * POST /sessions/:id/notify-generation → pi-runtime 裁决（工具仍在等 ⇒ 抑制；否则
 * 入 lane followUp，idle 由 drainQueued 空 prompt 兜底立刻开一轮，模型主动向用户简报）。
 *
 * 去重：metadata.agentTurnNotified 标记（durable，进程重启不重发）。reaper 扫描是
 * 唯一咽喉点——studio 各终态落点零改动，新增生成类型自动被覆盖。
 *
 * 纯函数模块（不持 Nest DI token）：reaper（studio 模块）直接 import，绕开
 * studio ↔ agent 的模块环（同 GenerationRecoveryService 的 Symbol 端口教训）。
 *
 * ⭐ **2026-10-21 补第三层防线（本 bug 的根因链）**
 *
 * 这个 bug（查 `GenerationRecord.updatedAt` 但该列不存在 ⇒ 每 5min 刷一次屏、
 * 「回合外终态通报」从 #459 合入起就没工作过）之所以能溜过两层防线，是因为：
 * 1. **类型层失守**：`LateNotifyPrisma` 是**手写**的最小面声明（为绕模块环而写）
 *    ⇒ 它的 `orderBy: { updatedAt: 'asc' | 'desc' }` 只是**字符串字面量**，
 *    prisma 的真实类型**根本没参与校验** ⇒ 写一个 DB 里不存在的列名，tsc 一声不吭；
 * 2. **运行层失守**：测试用 **mock prisma**（`findMany: async () => records`）
 *    ⇒ 查询参数被整个绕开 ⇒ 参数写错也测不出来。
 *
 * ⇒ 两层同时失效 ⇒ 缺陷直达生产。
 *
 * ⭐ 修法（**不加新抽象，只把类型接回真源**）：`LateNotifyPrisma` 的 prisma 侧签名
 * 改为从 **prisma 生成的类型**派生（`Prisma.GenerationRecordFindManyArgs` 等）⇒
 * 字段名写错 ⇒ **tsc 直接报错** ⇒ 第三层防线成立。
 * `import type` 是**纯类型**导入（编译后擦除）⇒ 零运行时依赖，不引入模块环。
 */
import type { Logger } from '@nestjs/common'
import type { Prisma } from '@prisma/client'

/** 与 pi-runtime GenerationTerminalNotice 通知载荷对齐（结构对齐，独立声明）。 */
export interface LateGenerationNotifyPayload {
	nodeId: string
	status: 'completed' | 'failed'
	recordId?: string
	kind?: string
	url?: string
	error?: string
}

/** 通报客户端的最小面（PiRuntimeClient 的结构子集，测试可注入假实现）。 */
export interface LateNotifyClient {
	notifyGeneration(
		sessionId: string,
		payload: LateGenerationNotifyPayload,
	): Promise<{ delivered: boolean; reason?: string }>
}

/**
 * 通报所需 prisma 最小面（PrismaService 的结构子集）。
 *
 * ⭐ **prisma 侧的签名从 prisma 生成的类型派生**（2026-10-21）——
 * 这样「查了一个 DB 里不存在的列」在 **tsc 阶段**就会报错，而不是等到生产刷屏。
 * 详见文件头「第三层防线」注记。
 *
 * - `FindManyArgs` / `FindFirstArgs`：用 prisma 的**真类型** ⇒ 字段名与形态受真源约束；
 * - `where` 保留 `Record<string, unknown>` 宽类型：调用点的过滤条件是**运行时拼装**的
 *   （`status.in` / `sessionId.not` / `updatedAt.gte`），保持宽类型免去噪音；
 *   但**字段名**本身由下面的 `Prisma.*WhereInput` 约束（见 `where` 的类型注记）。
 */
export interface LateNotifyPrisma {
	generationRecord: {
		findMany(
			args: Omit<Prisma.GenerationRecordFindManyArgs, 'where'> & {
				where: Prisma.GenerationRecordWhereInput
			},
		): Promise<
			Array<{
				id: string
				type: string
				status: string
				url: string | null
				sessionId: string | null
				nodeId: string | null
				metadata: string | null
			}>
		>
		update(args: { where: { id: string }; data: { metadata: string } }): Promise<unknown>
	}
	agentThread: {
		findFirst(
			args: Omit<Prisma.AgentThreadFindFirstArgs, 'where' | 'select'> & {
				where: Prisma.AgentThreadWhereInput
				select: { threadId: boolean }
			},
		): Promise<{ threadId: string } | null>
	}
}

export function piLateNotifyEnabled(): boolean {
	if (process.env.PI_RUNTIME_MODE?.trim().toLowerCase() === 'off') return false
	return !!process.env.PI_RUNTIME_URL?.trim()
}

function parseMeta(raw: string | null | undefined): Record<string, unknown> {
	if (!raw) return {}
	try {
		const parsed = JSON.parse(raw) as unknown
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
	} catch {
		return {}
	}
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

/** 生成类型 → 通报文案用词（与 reaper 的 REAP_REASON_BY_TYPE 同族但更短）。 */
function kindLabel(type: string): string {
	if (type.startsWith('video')) return '视频'
	if (type.startsWith('audio')) return '音频'
	if (type.startsWith('text')) return '文案'
	return '图片'
}

/**
 * 单轮通报扫描：返回成功落标记的记录数（含 suppressed/no-thread 的标记——
 * 它们也是「已处理」，防止每轮重扫）。
 */
export async function notifyLateGenerationTerminals(
	prisma: LateNotifyPrisma,
	client: LateNotifyClient,
	logger: { warn(msg: string): unknown; log(msg: string): unknown },
	opts?: { lookbackMs?: number; batch?: number },
): Promise<number> {
	// 回看窗：默认 10min（> reaper 5min 巡检间隔，覆盖窗口无缝；终态后 10min 内必被扫到）。
	const lookbackMs = opts?.lookbackMs ?? 10 * 60_000
	const batch = opts?.batch ?? 30
	// ⭐ 扫描失败**降级不崩**（2026-10-21）：坏查询（如列缺失）不该每 5min 在生产刷一次屏。
	// 判据：prisma 的参数校验错误是**确定性的**（重试无用）⇒ 降级 + 一次性告警即可。
	// ⚠️ 这里的 catch 正是本 bug 之前**没有**的东西 —— 少了它，一次列缺失会变成
	// 「每 5 分钟一条 error」的无限刷屏，把真正的错误淹没在噪音里。
	let records: Awaited<
		ReturnType<LateNotifyPrisma['generationRecord']['findMany']>
	>
	try {
		records = await prisma.generationRecord.findMany({
			where: {
				status: { in: ['completed', 'failed'] },
				sessionId: { not: null },
				updatedAt: { gte: new Date(Date.now() - lookbackMs) },
			},
			select: {
				id: true,
				type: true,
				status: true,
				url: true,
				sessionId: true,
				nodeId: true,
				metadata: true,
			},
			take: batch,
			orderBy: { updatedAt: 'asc' },
		})
	} catch (err) {
		logger.warn(
			`late_generation_scan_failed (degraded, skipped): ${
				err instanceof Error ? err.message : String(err)
			}`,
		)
		return 0
	}

	let handled = 0
	for (const rec of records) {
		const meta = parseMeta(rec.metadata)
		if (meta.agentTurnNotified) continue // 已通报过（durable 去重键）
		// 通报三大前提：有画布会话、有节点 id、会话上存在 agent 线程。
		if (!rec.sessionId || !rec.nodeId) {
			await markNotified(prisma, rec.id, meta, 'no-target')
			handled += 1
			continue
		}
		const thread = await prisma.agentThread
			.findFirst({ where: { sessionId: rec.sessionId }, orderBy: { updatedAt: 'desc' }, select: { threadId: true } })
			.catch(() => null)
		if (!thread) {
			// 无 agent 线程 = 该画布从未开过对话 ⇒ 永远不会有人消费通报，落标记防重扫。
			await markNotified(prisma, rec.id, meta, 'no-thread')
			handled += 1
			continue
		}
		// 失败原因取记录自带 userMessage（studio 各失败路径统一写入）；成功不传。
		const errorMessage =
			rec.status !== 'completed' && typeof meta.userMessage === 'string' && meta.userMessage
				? meta.userMessage
				: undefined
		try {
			const result = await client.notifyGeneration(thread.threadId, {
				nodeId: rec.nodeId,
				status: rec.status === 'completed' ? 'completed' : 'failed',
				...(rec.id ? { recordId: rec.id } : {}),
				kind: kindLabel(rec.type),
				...(rec.url ? { url: rec.url } : {}),
				...(rec.status !== 'completed' && errorMessage ? { error: errorMessage } : {}),
			})
			// delivered=false（工具仍在等 / 会话不在本实例）也是确定性结果，落标记防重发。
			await markNotified(prisma, rec.id, meta, result.delivered ? 'delivered' : `suppressed:${result.reason ?? 'unknown'}`)
			handled += 1
			logger.log(
				`[late-notify] ${rec.type} ${rec.id} node=${rec.nodeId} → thread=${thread.threadId} ` +
					`delivered=${result.delivered}${result.reason ? ` (${result.reason})` : ''}`,
			)
		} catch (err) {
			// 瞬时失败不落标记：下一轮巡检重试（终态记录不消失，最坏多延迟一轮）。
			logger.warn(`[late-notify] ${rec.type} ${rec.id} 通报失败（下轮重试）: ${errMessage(err)}`)
		}
	}
	return handled
}

async function markNotified(
	prisma: LateNotifyPrisma,
	recordId: string,
	meta: Record<string, unknown>,
	outcome: string,
): Promise<void> {
	await prisma.generationRecord.update({
		where: { id: recordId },
		data: {
			metadata: JSON.stringify({
				...meta,
				agentTurnNotified: outcome,
				agentTurnNotifiedAt: new Date().toISOString(),
			}),
		},
	})
}
