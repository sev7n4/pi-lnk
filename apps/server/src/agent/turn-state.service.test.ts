/**
 * 回合连续性 —— `TurnStateService` 的 IO 编排测试（2026-10-21 修正）。
 *
 * ⭐ 为什么必须测这一层：纯函数（`turn-state-store.ts` / shared 的 `turnState.ts`）
 * 只保证「判据对」；本层保证「**权威副本真的落在 Nest DB**」——
 * 这是修正方案的核心（初版把权威放在 pi 侧 transcript，压缩必丢）。
 *
 * 用**假 prisma**（不连真库）：本层只关心「调了什么 update / 读出后渲染成什么」，
 * 真实 DB 行为由 prisma 自身保证。
 */

import { describe, expect, it } from 'vitest'
import { TurnStateService } from './turn-state.service'

/** 假 prisma：记录 update 调用，可预设 findUnique 返回值。 */
function makePrisma(initial?: string) {
	const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = []
	let stored: string | null | undefined = initial
	return {
		updates,
		get stored() {
			return stored
		},
		agentThread: {
			update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
				updates.push(args)
				stored = args.data.turnState as string | null
				return args
			},
			findUnique: async (_args: unknown) =>
				stored === undefined ? null : { turnState: stored },
		},
	}
}

/** 记录状态的输入（最小可用）。 */
function recordInput(overrides: Partial<Parameters<TurnStateService['record']>[0]> = {}) {
	return {
		threadId: 'canvas-1:thread-a',
		userText: '让他们抱在一起',
		assistantPartial: '我先看一下画布',
		completedSteps: ['get_canvas_summary'],
		pendingSteps: ['run_image_generation'],
		failed: true,
		promptAccepted: false,
		userAborted: false,
		hasAssistantText: true,
		toolCallCount: 2,
		...overrides,
	}
}

describe('TurnStateService.record（写权威副本）', () => {
	it('⭐ 写进 AgentThread.turnState（Nest DB 权威副本）', async () => {
		const prisma = makePrisma()
		const svc = new TurnStateService(prisma as never)
		const ok = await svc.record(recordInput())
		expect(ok).toBe(true)
		expect(prisma.updates).toHaveLength(1)
		expect(prisma.updates[0].where.id).toBe('canvas-1:thread-a')
		expect(typeof prisma.updates[0].data.turnState).toBe('string')
	})

	it('落盘内容含恢复所需的全部事实', async () => {
		const prisma = makePrisma()
		const svc = new TurnStateService(prisma as never)
		await svc.record(recordInput({ userMessageId: 'msg-42' }))
		const state = JSON.parse(prisma.updates[0].data.turnState as string)
		expect(state.userText).toBe('让他们抱在一起')
		expect(state.assistantPartial).toBe('我先看一下画布')
		expect(state.completedSteps).toEqual(['get_canvas_summary'])
		expect(state.pendingSteps).toEqual(['run_image_generation'])
		expect(state.userMessageId).toBe('msg-42')
		// prompt 未被接受 ⇒ Nest 有、pi 无 ⇒ 双写分叉
		expect(state.interruption).toBe('history_diverged')
	})

	it('⛔ prisma 抛错 ⇒ 返回 false 且不抛出（fail-soft）', async () => {
		const prisma = {
			agentThread: {
				update: async () => {
					throw new Error('db down')
				},
				findUnique: async () => null,
			},
		}
		const svc = new TurnStateService(prisma as never)
		await expect(svc.record(recordInput())).resolves.toBe(false)
	})

	it('⛔ prisma 缺 agentThread ⇒ 返回 false（不炸）', async () => {
		const svc = new TurnStateService({} as never)
		await expect(svc.record(recordInput())).resolves.toBe(false)
	})
})

describe('TurnStateService.read（读权威副本）', () => {
	it('读出已写入的状态', async () => {
		const prisma = makePrisma()
		const svc = new TurnStateService(prisma as never)
		await svc.record(recordInput())
		const state = await svc.read('canvas-1:thread-a')
		expect(state).toBeDefined()
		expect(state!.userText).toBe('让他们抱在一起')
	})

	it('无状态 ⇒ undefined', async () => {
		const svc = new TurnStateService(makePrisma() as never)
		expect(await svc.read('nope')).toBeUndefined()
	})

	it('⛔ 坏 JSON ⇒ undefined（宁可不注入也不投坏数据）', async () => {
		const svc = new TurnStateService(makePrisma('{not json') as never)
		expect(await svc.read('x')).toBeUndefined()
	})

	it('⛔ 形状不对 ⇒ undefined', async () => {
		const svc = new TurnStateService(makePrisma(JSON.stringify({ foo: 1 })) as never)
		expect(await svc.read('x')).toBeUndefined()
	})

	it('⛔ prisma 抛错 ⇒ undefined（fail-soft）', async () => {
		const prisma = {
			agentThread: {
				findUnique: async () => {
					throw new Error('db down')
				},
			},
		}
		const svc = new TurnStateService(prisma as never)
		expect(await svc.read('x')).toBeUndefined()
	})
})

describe('TurnStateService.clear（消费后清除）', () => {
	it('清除 = 写 null', async () => {
		const prisma = makePrisma()
		const svc = new TurnStateService(prisma as never)
		await svc.record(recordInput())
		await svc.clear('canvas-1:thread-a')
		expect(prisma.updates[prisma.updates.length - 1].data.turnState).toBeNull()
		expect(await svc.read('canvas-1:thread-a')).toBeUndefined()
	})

	it('⛔ prisma 抛错 ⇒ 不抛出（fail-soft）', async () => {
		const prisma = {
			agentThread: {
				update: async () => {
					throw new Error('db down')
				},
			},
		}
		const svc = new TurnStateService(prisma as never)
		await expect(svc.clear('x')).resolves.toBeUndefined()
	})
})

describe('TurnStateService.renderBlock（喂给模型的动态块）', () => {
	it('⭐ 有状态 ⇒ 渲染出模型可见的说明块', async () => {
		const prisma = makePrisma()
		const svc = new TurnStateService(prisma as never)
		await svc.record(recordInput())
		const block = await svc.renderBlock('canvas-1:thread-a')
		expect(block).toBeDefined()
		expect(block!).toContain('上一轮被中断')
		expect(block!).toContain('让他们抱在一起')
		expect(block!).toContain('run_image_generation')
	})

	it('⭐ 无状态 ⇒ undefined（不产出空块，避免每轮都注入空噪音）', async () => {
		const svc = new TurnStateService(makePrisma() as never)
		expect(await svc.renderBlock('nope')).toBeUndefined()
	})

	it('⭐ 块首行固定（classifyBlock 靠前缀分类预算档位）', async () => {
		const prisma = makePrisma()
		const svc = new TurnStateService(prisma as never)
		await svc.record(recordInput())
		const block = (await svc.renderBlock('canvas-1:thread-a'))!
		expect(block.startsWith('【上一轮被中断')).toBe(true)
	})
})

describe('TurnStateService.renderRetentionLine（压缩保留段）', () => {
	it('有状态 ⇒ 产出一行摘要', async () => {
		const prisma = makePrisma()
		const svc = new TurnStateService(prisma as never)
		await svc.record(recordInput())
		const line = await svc.renderRetentionLine('canvas-1:thread-a')
		expect(line).toBeDefined()
		expect(line!).toContain('让他们抱在一起')
	})

	it('无状态 ⇒ undefined', async () => {
		const svc = new TurnStateService(makePrisma() as never)
		expect(await svc.renderRetentionLine('nope')).toBeUndefined()
	})
})
