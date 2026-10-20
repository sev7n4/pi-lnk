import { describe, expect, it } from 'vitest'
import {
	collectToolAttempts,
	deriveSteps,
	shouldRecordTurnState,
	type ToolAttempt,
} from './turn-continuity'

describe('deriveSteps（从工具执行推导做到哪一步）', () => {
	it('成功工具 = 已完成步骤', () => {
		const { completedSteps } = deriveSteps([
			{ toolName: 'get_canvas_summary', ok: true },
			{ toolName: 'upsert_media_node', ok: true },
		])
		expect(completedSteps).toEqual(['get_canvas_summary', 'upsert_media_node'])
	})

	it('失败工具 = 未完成步骤（卡点）', () => {
		const { pendingSteps } = deriveSteps([
			{ toolName: 'get_canvas_summary', ok: true },
			{ toolName: 'run_image_generation', ok: false },
		])
		expect(pendingSteps).toEqual(['run_image_generation'])
	})

	it('后续成功会推进卡点（旧的未完成不再是当前卡点）', () => {
		const { pendingSteps, completedSteps } = deriveSteps([
			{ toolName: 'a', ok: false },
			{ toolName: 'b', ok: true },
		])
		expect(pendingSteps).toEqual([])
		// ⛔ 失败过的工具「a」永不计作已完成——它可能已产生部分副作用，
		// 说它完成会让模型跳过它 ⇒ 状态错乱。它只是不再是卡点。
		expect(completedSteps).toEqual(['b'])
	})

	it('只记第一个失败（后续失败是连锁）', () => {
		const { pendingSteps } = deriveSteps([
			{ toolName: 'first_fail', ok: false },
			{ toolName: 'second_fail', ok: false },
		])
		expect(pendingSteps).toEqual(['first_fail'])
	})

	it('空输入 ⇒ 两边都空（不猜）', () => {
		const r = deriveSteps([])
		expect(r.completedSteps).toEqual([])
		expect(r.pendingSteps).toEqual([])
	})
})

describe('collectToolAttempts（只取有终态的工具事件）', () => {
	it('tool_execution_end 取工具名与成功标志', () => {
		const attempts = collectToolAttempts([
			{ type: 'tool_execution_end', data: { toolName: 'x', isError: false } },
			{ type: 'tool_execution_end', data: { toolName: 'y', isError: true } },
		])
		expect(attempts).toEqual([
			{ toolName: 'x', ok: true },
			{ toolName: 'y', ok: false },
		])
	})

	it('⛔ start 事件不算（只说明开始调，不说明做完）', () => {
		const attempts = collectToolAttempts([
			{ type: 'tool_execution_start', data: { toolName: 'x' } },
		])
		expect(attempts).toEqual([])
	})

	it('缺 toolName 的事件被跳过', () => {
		const attempts = collectToolAttempts([{ type: 'tool_execution_end', data: {} }])
		expect(attempts).toEqual([])
	})

	it('缺 data 的事件不炸', () => {
		expect(() => collectToolAttempts([{ type: 'tool_execution_end' }])).not.toThrow()
	})
})

describe('shouldRecordTurnState（只在真需要时记）', () => {
	it('失败 ⇒ 记', () => {
		expect(
			shouldRecordTurnState({ failed: true, userAborted: false, hasAssistantText: false, toolCallCount: 0 }),
		).toBe(true)
	})

	it('正常结束且有正文 ⇒ 不记（历史本来就完整，记了是噪声）', () => {
		expect(
			shouldRecordTurnState({ failed: false, userAborted: false, hasAssistantText: true, toolCallCount: 3 }),
		).toBe(false)
	})

	it('正常结束但无正文且调过工具 ⇒ 记（可能停在半路）', () => {
		expect(
			shouldRecordTurnState({ failed: false, userAborted: false, hasAssistantText: false, toolCallCount: 2 }),
		).toBe(true)
	})

	it('用户取消且无产出 ⇒ 记', () => {
		expect(
			shouldRecordTurnState({ failed: false, userAborted: true, hasAssistantText: false, toolCallCount: 0 }),
		).toBe(true)
	})

	it('用户取消但已产出正文 ⇒ 不记', () => {
		expect(
			shouldRecordTurnState({ failed: false, userAborted: true, hasAssistantText: true, toolCallCount: 1 }),
		).toBe(false)
	})
})

describe('deriveSteps 与 collectToolAttempts 组合（端到端形态）', () => {
	it('从事件流推出「已完成读画布 / 卡在生成」', () => {
		const events = [
			{ type: 'tool_execution_start', data: { toolName: 'get_canvas_summary' } },
			{ type: 'tool_execution_end', data: { toolName: 'get_canvas_summary', isError: false } },
			{ type: 'tool_execution_start', data: { toolName: 'run_image_generation' } },
			{ type: 'tool_execution_end', data: { toolName: 'run_image_generation', isError: true } },
		]
		const attempts: ToolAttempt[] = collectToolAttempts(events)
		const { completedSteps, pendingSteps } = deriveSteps(attempts)
		expect(completedSteps).toEqual(['get_canvas_summary'])
		expect(pendingSteps).toEqual(['run_image_generation'])
	})
})
