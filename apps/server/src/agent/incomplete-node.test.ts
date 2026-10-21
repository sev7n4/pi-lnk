/**
 * 批次 3.1 —— 「画布上可见的未完成」判据测试。
 *
 * ⭐ 核心不变式：**只标未到终态的节点**（`generating`），**不覆盖已有终态**。
 */
import { describe, expect, it } from 'vitest'
import {
	buildIncompleteNodeActions,
	collectIncompleteNodeIds,
} from './incomplete-node'

/** 造一条 node_status 事件。 */
function nodeStatus(nodeId: string, status: string) {
	return { type: 'node_status', data: { nodeId, status } }
}

describe('collectIncompleteNodeIds（收集未到终态的节点）', () => {
	it('generating ⇒ 收集', () => {
		expect(collectIncompleteNodeIds([nodeStatus('n1', 'generating')])).toEqual(['n1'])
	})

	it('⛔ completed / failed / error ⇒ 不收集（不覆盖已有终态）', () => {
		expect(
			collectIncompleteNodeIds([
				nodeStatus('n1', 'completed'),
				nodeStatus('n2', 'failed'),
				nodeStatus('n3', 'error'),
			]),
		).toEqual([])
	})

	it('⭐ 同一节点取**最后**状态（先 generating 后 completed ⇒ 不算未完成）', () => {
		expect(
			collectIncompleteNodeIds([nodeStatus('n1', 'generating'), nodeStatus('n1', 'completed')]),
		).toEqual([])
	})

	it('⭐ 先 completed 后 generating ⇒ 算未完成（最后状态说了算）', () => {
		expect(
			collectIncompleteNodeIds([nodeStatus('n1', 'completed'), nodeStatus('n1', 'generating')]),
		).toEqual(['n1'])
	})

	it('⛔ 非 node_status 事件一律不看（不从工具事件猜 nodeId）', () => {
		expect(
			collectIncompleteNodeIds([
				{ type: 'tool_call', data: { nodeId: 'n1', status: 'generating' } },
				{ type: 'canvas_action', data: { payload: { id: 'n2' } } },
			]),
		).toEqual([])
	})

	it('⛔ 缺 nodeId / 缺 status ⇒ 跳过', () => {
		expect(
			collectIncompleteNodeIds([
				{ type: 'node_status', data: { status: 'generating' } },
				{ type: 'node_status', data: { nodeId: 'n1' } },
				{ type: 'node_status', data: {} },
				{ type: 'node_status' },
			]),
		).toEqual([])
	})

	it('本轮没碰画布 ⇒ 空数组（不乱标）', () => {
		expect(collectIncompleteNodeIds([])).toEqual([])
		expect(collectIncompleteNodeIds([{ type: 'text', data: 'hi' }])).toEqual([])
	})

	it('多个未完成节点 ⇒ 全收', () => {
		expect(
			collectIncompleteNodeIds([nodeStatus('n1', 'generating'), nodeStatus('n2', 'generating')]),
		).toEqual(['n1', 'n2'])
	})
})

describe('buildIncompleteNodeActions（构造 update_node 动作）', () => {
	it('data 只带要改的字段（前端深合并 ⇒ 不覆盖其它 data）', () => {
		const actions = buildIncompleteNodeActions({
			nodeIds: ['n1'],
			reason: '上游模型调用报错',
			at: 123,
		})
		expect(actions).toHaveLength(1)
		expect(actions[0].type).toBe('update_node')
		expect(actions[0].payload.id).toBe('n1')
		expect(actions[0].payload.data).toEqual({
			status: 'incomplete',
			incompleteReason: '上游模型调用报错',
			incompleteAt: 123,
		})
		// ⛔ 不得带上会覆盖节点其它 data 的字段
		expect(Object.keys(actions[0].payload.data).sort()).toEqual([
			'incompleteAt',
			'incompleteReason',
			'status',
		])
	})

	it('无节点 ⇒ 无动作（不产生空 update_node）', () => {
		expect(buildIncompleteNodeActions({ nodeIds: [], reason: 'x', at: 1 })).toEqual([])
	})
})
