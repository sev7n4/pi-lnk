/**
 * 批次 3.1 —— 「画布上可见的未完成」判定（纯函数）。
 *
 * ## 目标
 *
 * 把「这一轮中断了，还剩什么」做成**画布上的一等公民** —— 用户直接看到
 * 「上次卡在出图这一步」，不必靠 agent 复述。
 *
 * ## 为什么能这么小（复用了什么）
 *
 * - ⭐ **节点状态已有事件通道**：pi 侧的 `node_status` 事件载荷是
 *   `{ nodeId, status, url, error }`（`pi-events.ts:216` 的 case）⇒ **带 nodeId**；
 * - ⭐ **改节点已有动作通道**：画布动作 `update_node` 的 `payload.data` 走
 *   `mergeNodeData` **深合并**（`useCanvasActions.ts`）⇒ 只发要改的字段，
 *   **不覆盖**节点的其它 `data`；
 * - ⭐ **落库已有通道**：`finalizeTurn(sessionId, threadId, userId, text, canvasActions, …)`
 *   会把 `canvasActions` 落进 `Session.canvasData` ⇒ **零新增落库路径**。
 *
 * ⇒ 节点 status 的写入散落在 80+ 处（`studio.service` / `material.service` /
 *   `agent-canvas-tools.service`），但**标记「未完成」只需要一个写入点**
 *   （中断发生的当下），不必去改那 80+ 处。
 *
 * ## 判据（为什么这样判）
 *
 * - **只标「未到终态」的节点**：`generating` ⇒ 中断时它还在跑 ⇒ 未完成；
 *   `completed` / `failed` ⇒ 已有终态 ⇒ **不标**（不覆盖既有终态）；
 * - **同一节点取最后一次状态**：节点可能先 `generating` 后 `completed`
 *   ⇒ 只有**最后**状态是 `generating` 才算未完成；
 * - **标不到节点就不标**：本轮可能根本没碰画布（纯聊天）⇒ 不标任何节点
 *   （宁可不标，也不乱标）。
 */

/** 一条执行事件（只取本模块需要的字段）。 */
export interface TraceEventLike {
	readonly type?: string
	readonly data?: unknown
}

/** 节点终态（已有终态 ⇒ 不标 incomplete）。 */
const TERMINAL_NODE_STATUSES = new Set(['completed', 'failed', 'error'])

/** 非终态（正在跑 ⇒ 中断时算未完成）。 */
const PENDING_NODE_STATUSES = new Set(['generating', 'pending', 'running'])

/**
 * 收集本轮**未到终态**的节点 id。
 *
 * ⭐ 只看 `node_status` 事件（它带 nodeId + status）⇒ 判据单一、来源可靠。
 * ⛔ 不从工具事件里猜 nodeId（工具事件的 nodeId 语义不统一，猜错会标错节点）。
 */
export function collectIncompleteNodeIds(
	events: readonly TraceEventLike[],
): string[] {
	/** nodeId → 最后一次见到的状态。 */
	const lastStatus = new Map<string, string>()
	for (const event of events) {
		if (event?.type !== 'node_status') continue
		const data = (event.data ?? {}) as { nodeId?: unknown; status?: unknown }
		const nodeId = typeof data.nodeId === 'string' ? data.nodeId : ''
		if (!nodeId) continue
		const status = typeof data.status === 'string' ? data.status : ''
		if (!status) continue
		lastStatus.set(nodeId, status)
	}

	const incomplete: string[] = []
	for (const [nodeId, status] of lastStatus) {
		if (TERMINAL_NODE_STATUSES.has(status)) continue
		if (!PENDING_NODE_STATUSES.has(status)) continue
		incomplete.push(nodeId)
	}
	return incomplete
}

/**
 * 构造「标记未完成」的画布动作（`update_node`）。
 *
 * ⭐ `data` 只带要改的字段 ⇒ 前端 `mergeNodeData` 深合并 ⇒ **不覆盖**其它 data。
 * ⭐ `incompleteReason` 用人话（`describeTurnInterruption`）⇒ 用户看得懂。
 */
export function buildIncompleteNodeActions(input: {
	nodeIds: readonly string[]
	reason: string
	at: number
}): Array<{ type: 'update_node'; payload: { id: string; data: Record<string, unknown> } }> {
	return input.nodeIds.map((id) => ({
		type: 'update_node' as const,
		payload: {
			id,
			data: {
				status: 'incomplete',
				incompleteReason: input.reason,
				incompleteAt: input.at,
			},
		},
	}))
}

/*
 * ⛔ **刻意不实现「清除未完成标记」**（2026-10-21 的设计结论）：
 *
 * `incomplete` 是**事实陈述**（这个节点在中断那一刻没跑完），**不是**状态机的一环。
 * 前端 `mergeNodeData` 是**深合并** ⇒ 生成流程后续写的 `status: 'completed'` /
 * `'failed'` 会**自然覆盖** `incomplete` ⇒ 不需要额外的清除动作。
 *
 * ⇒ 推论：
 * - 节点后来跑完了 ⇒ 流程写终态 ⇒ 角标消失 ✅
 * - 节点后来**又**失败了 ⇒ 流程写 `failed` ⇒ 角标消失 ✅
 * - 节点**再也没被碰** ⇒ 保留 `incomplete` ⇒ **正确**（它确实还没完成）
 *
 * ⇒ 主动清除反而会**说谎**（把没完成的节点标成 completed）。
 *   所以「什么时候清」这个问题的答案是：**不主动清**。
 */
