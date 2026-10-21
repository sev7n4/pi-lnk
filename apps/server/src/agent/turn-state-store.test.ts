import { describe, expect, it } from 'vitest'
import {
	buildTurnState,
	describeTurnInterruption,
	normalizeTurnSteps,
	parseTurnState,
	renderTurnStateBlock,
	renderTurnStateGuidance,
	renderTurnStateRetentionLine,
	truncateTurnText,
} from '@lnkpi/shared'
import {
	classifyInterruption,
	collectToolAttempts,
	deriveSteps,
	shouldRecordTurnState,
	type ToolAttempt,
} from './turn-state-store'

describe('truncateTurnText（截断保留首尾）', () => {
	it('短文本原样返回（去首尾空白）', () => {
		expect(truncateTurnText('  hello  ')).toBe('hello')
	})

	it('超长文本头尾都保留，中间省略', () => {
		const long = 'A'.repeat(2000)
		const out = truncateTurnText(long, 100)
		expect(out.length).toBeLessThanOrEqual(100)
		expect(out).toContain('...')
		expect(out.startsWith('A')).toBe(true)
		expect(out.endsWith('A')).toBe(true)
	})

	it('空串不炸', () => {
		expect(truncateTurnText('')).toBe('')
		expect(truncateTurnText(undefined as unknown as string)).toBe('')
	})
})

describe('normalizeTurnSteps（步骤列表归一）', () => {
	it('去空白项、截断条数', () => {
		expect(normalizeTurnSteps(['  a  ', '', 'b', '   ', 'c'])).toEqual(['a', 'b', 'c'])
	})

	it('undefined/空数组返回空', () => {
		expect(normalizeTurnSteps(undefined)).toEqual([])
		expect(normalizeTurnSteps([])).toEqual([])
	})
})

describe('buildTurnState（构造，不冒充知道）', () => {
	it('字段按契约归一', () => {
		const state = buildTurnState({
			userText: '让他们抱在一起',
			assistantPartial: '好的，我先读取画布',
			interruption: 'upstream_error',
			completedSteps: ['已读画布'],
			pendingSteps: ['调用 run_image_generation'],
			at: 1_700_000_000_000,
		})
		expect(state.userText).toBe('让他们抱在一起')
		expect(state.interruption).toBe('upstream_error')
		expect(state.completedSteps).toEqual(['已读画布'])
		expect(state.pendingSteps).toEqual(['调用 run_image_generation'])
	})

	it('未提供 assistantPartial 时为空串（不编造半截输出）', () => {
		const state = buildTurnState({ userText: 'x', interruption: 'transport_failed', at: 1 })
		expect(state.assistantPartial).toBe('')
	})

	it('userMessageId 可选（对账锚点）', () => {
		const withId = buildTurnState({
			userText: 'x',
			interruption: 'unknown',
			at: 1,
			userMessageId: 'msg-1',
		})
		expect(withId.userMessageId).toBe('msg-1')
		const withoutId = buildTurnState({ userText: 'x', interruption: 'unknown', at: 1 })
		expect(withoutId.userMessageId).toBeUndefined()
	})
})

describe('renderTurnStateBlock（注入模型上下文的措辞纪律）', () => {
	const state = buildTurnState({
		userText: '让他们抱在一起',
		assistantPartial: '我先看一下画布',
		interruption: 'upstream_error',
		completedSteps: ['已读取画布摘要'],
		pendingSteps: ['合成两个角色的图片'],
		at: 1_700_000_000_000,
	})
	const block = renderTurnStateBlock(state)

	it('含用户原始请求（模型据此知道要继续什么）', () => {
		expect(block).toContain('让他们抱在一起')
	})

	it('含已完成与未完成步骤', () => {
		expect(block).toContain('已读取画布摘要')
		expect(block).toContain('合成两个角色的图片')
	})

	it('⛔ 指导指令不得让模型靠观察画布来反推用户意图（本次事故形态）', () => {
		// 判据落在**指导指令**上，而非整块文本：状态事实里出现「画布」是正常的
		// （已完成步骤可能就是「已读取画布摘要」），真正要禁的是
		// 「用观察画布来反推用户想要什么」这条推理路径。
		const guidance = renderTurnStateGuidance()
		expect(guidance).not.toContain('画布')
		expect(guidance).not.toContain('推测')
		expect(guidance).not.toContain('猜测')
	})

	it('✅ 指导指令给出「不要重新推断」的正面指令（替代禁词）', () => {
		expect(renderTurnStateGuidance()).toContain('不要重新推断')
	})

	it('⛔ 指导指令不得道歉/复盘（对齐 WorkBuddy no apology, no recap）', () => {
		const guidance = renderTurnStateGuidance()
		expect(guidance).not.toContain('抱歉')
		expect(guidance).not.toContain('对不起')
	})

	it('✅ 指导指令禁止重复已完成步骤', () => {
		expect(renderTurnStateGuidance()).toContain('不要重复已经完成的步骤')
	})

	it('无 pendingSteps 时显式说「未知」而不是留空', () => {
		const noPending = renderTurnStateBlock(
			buildTurnState({ userText: 'y', interruption: 'unknown', at: 1 }),
		)
		expect(noPending).toContain('未知')
	})
})

describe('renderTurnStateRetentionLine（压缩保留段的一行摘要）', () => {
	it('含用户请求与未完成步骤', () => {
		const state = buildTurnState({
			userText: '让他们抱在一起',
			interruption: 'upstream_error',
			pendingSteps: ['run_image_generation'],
			at: 1,
		})
		const line = renderTurnStateRetentionLine(state)
		expect(line).toContain('让他们抱在一起')
		expect(line).toContain('run_image_generation')
	})

	it('⭐ 长度受限（压缩保留段会截断）', () => {
		const state = buildTurnState({
			userText: 'A'.repeat(500),
			interruption: 'unknown',
			pendingSteps: ['B'.repeat(500)],
			at: 1,
		})
		const line = renderTurnStateRetentionLine(state)
		expect(line.length).toBeLessThanOrEqual(200)
	})

	it('无 pendingSteps 时退化为「已完成」信息', () => {
		const state = buildTurnState({
			userText: 'x',
			interruption: 'unknown',
			completedSteps: ['get_canvas_summary'],
			at: 1,
		})
		expect(renderTurnStateRetentionLine(state)).toContain('get_canvas_summary')
	})
})

describe('describeTurnInterruption（中断类型人话）', () => {
	it('覆盖全部枚举值', () => {
		for (const k of [
			'upstream_error',
			'tool_interrupted',
			'session_busy',
			'transport_failed',
			'history_diverged',
			'unknown',
		] as const) {
			expect(typeof describeTurnInterruption(k)).toBe('string')
			expect(describeTurnInterruption(k).length).toBeGreaterThan(0)
		}
	})
})

describe('parseTurnState（容错解析）', () => {
	it('解析合法状态', () => {
		const parsed = parseTurnState({
			userText: 'a',
			assistantPartial: 'b',
			interruption: 'tool_interrupted',
			completedSteps: ['c1'],
			pendingSteps: ['p1'],
			at: 42,
			userMessageId: 'm1',
		})
		expect(parsed).toBeDefined()
		expect(parsed!.interruption).toBe('tool_interrupted')
		expect(parsed!.at).toBe(42)
		expect(parsed!.userMessageId).toBe('m1')
	})

	it('未知 interruption 降级为 unknown（不猜）', () => {
		const parsed = parseTurnState({ userText: 'a', interruption: 'weird_kind' })
		expect(parsed).toBeDefined()
		expect(parsed!.interruption).toBe('unknown')
	})

	it('缺 userText ⇒ undefined（整条不注入）', () => {
		expect(parseTurnState({ assistantPartial: 'x' })).toBeUndefined()
		expect(parseTurnState({ userText: 123 })).toBeUndefined()
	})

	it('非对象 ⇒ undefined', () => {
		expect(parseTurnState('str')).toBeUndefined()
		expect(parseTurnState(undefined)).toBeUndefined()
		expect(parseTurnState(null)).toBeUndefined()
	})

	it('非字符串的步骤被丢弃而不是当成字符串用', () => {
		const parsed = parseTurnState({ userText: 'a', completedSteps: ['ok', 42, null] })
		expect(parsed).toBeDefined()
		expect(parsed!.completedSteps).toEqual(['ok'])
	})
})

describe('classifyInterruption（中断类型分档）', () => {
	it('prompt 未被接受 ⇒ history_diverged（Nest 有、pi 无）', () => {
		expect(classifyInterruption({ failed: true, promptAccepted: false })).toBe('history_diverged')
	})

	it('prompt 被接受但失败 ⇒ upstream_error', () => {
		expect(classifyInterruption({ failed: true, promptAccepted: true })).toBe('upstream_error')
	})

	it('未失败 ⇒ unknown', () => {
		expect(classifyInterruption({ failed: false, promptAccepted: true })).toBe('unknown')
	})
})

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

	it('后续成功会推进卡点；⛔ 失败过的工具永不计作已完成', () => {
		const { pendingSteps, completedSteps } = deriveSteps([
			{ toolName: 'a', ok: false },
			{ toolName: 'b', ok: true },
		])
		expect(pendingSteps).toEqual([])
		// 失败过的工具「a」可能已产生部分副作用，说它完成会让模型跳过它 ⇒ 状态错乱
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
		expect(collectToolAttempts([{ type: 'tool_execution_start', data: { toolName: 'x' } }])).toEqual([])
	})

	it('缺 toolName 的事件被跳过', () => {
		expect(collectToolAttempts([{ type: 'tool_execution_end', data: {} }])).toEqual([])
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

describe('端到端形态（状态从事件流到模型可见文本）', () => {
	it('从事件流推出「已完成读画布 / 卡在生成」，再渲染成模型可见块', () => {
		const events = [
			{ type: 'tool_execution_start', data: { toolName: 'get_canvas_summary' } },
			{ type: 'tool_execution_end', data: { toolName: 'get_canvas_summary', isError: false } },
			{ type: 'tool_execution_end', data: { toolName: 'run_image_generation', isError: true } },
		]
		const attempts: ToolAttempt[] = collectToolAttempts(events)
		const { completedSteps, pendingSteps } = deriveSteps(attempts)
		const state = buildTurnState({
			userText: '让他们抱在一起',
			interruption: classifyInterruption({ failed: true, promptAccepted: false }),
			completedSteps,
			pendingSteps,
			at: 1_700_000_000_000,
		})
		const block = renderTurnStateBlock(state)
		expect(block).toContain('让他们抱在一起')
		expect(block).toContain('get_canvas_summary')
		expect(block).toContain('run_image_generation')
		expect(block).toContain('历史记录缺失')
	})
})
