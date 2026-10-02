/**
 * AgentController `POST /api/agent/runs/steer` 单测（2026-10-02，steering 闭环）
 *
 * 这个端点存在的理由：流式对话进行中发言，走完整 prompt 必然撞 409（上一轮还在跑），
 * 而老代码把 409 放进 `void .catch(() => {})` **静默吞掉** —— 前端只剩浏览器内存里
 * 「最多 1 条」的单槽队列，刷新/断网即丢。现在插话有 durable 服务端队列兜底。
 *
 * 本测试只做三件事（不引 Nest HTTP 层，控制器仅 3 个依赖，直接 new 即可）：
 *   ① 空 text 在入口就 400，不碰下游；
 *   ② 归属校验用 `req.user.sub` 查会话，越权不许往别人队列塞消息；
 *   ③ 正常路径把 sessionId / threadId / text 原样交给 service。
 */
import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { AgentController } from './agent.controller'
import { AgentService } from './agent.service'
import type { SessionsService } from '../sessions/sessions.service'

/**
 * `runs/followup` 与 `runs/steer` 的唯一实质差别是**送达时机**（收尾边界 vs run 内边界），
 * 但两者**互斥**：同一次边界里已有 steer 时 followUp 会被 `boundary.ts:106` 跳过。
 * 所以这条路径必须是独立端点、独立 service 方法 —— 前端「点了等跑完再说」绝不能退化成 steer。
 */
describe('AgentController runs/followup（followUp 队列，2026-10-02）', () => {
  const req = { user: { sub: 'u1' } } as never

  it('空 / 纯空白 text → 400，且不调用下游 service', async () => {
    const followUpPiRun = vi.fn()
    const findOne = vi.fn()
    const ctrl = new AgentController(
      { followUpPiRun } as unknown as AgentService,
      { findOne } as unknown as SessionsService,
      {} as never,
    )

    for (const text of ['', '   ', undefined]) {
      const res = await ctrl.followUpRun({ sessionId: 's1', text: text as string }, req)
      expect(res).toEqual({ code: 400, message: 'text is required', data: null })
    }
    expect(followUpPiRun).not.toHaveBeenCalled()
    expect(findOne).not.toHaveBeenCalled()
  })

  it('正常：先校验归属再透传，且走 followUpPiRun 而不是 steerPiRun', async () => {
    const followUpPiRun = vi.fn().mockResolvedValue({ queued: true })
    const ctrl = new AgentController(
      { followUpPiRun, steerPiRun: vi.fn() } as unknown as AgentService,
      { findOne: vi.fn().mockResolvedValue({ id: 's1' }) } as unknown as SessionsService,
      {} as never,
    )

    const res = await ctrl.followUpRun({ sessionId: 's1', threadId: 'tid-1', text: '跑完再说' }, req)
    expect(res).toEqual({ code: 0, message: 'ok', data: { queued: true } })
    expect(followUpPiRun).toHaveBeenCalledWith({ sessionId: 's1', threadId: 'tid-1', text: '跑完再说' })
  })

  it('归属校验失败 → 冒泡，绝不替别人排队', async () => {
    const followUpPiRun = vi.fn()
    const ctrl = new AgentController(
      { followUpPiRun } as unknown as AgentService,
      { findOne: vi.fn().mockRejectedValue(new Error('forbidden')) } as unknown as SessionsService,
      {} as never,
    )

    await expect(ctrl.followUpRun({ sessionId: 's9', text: '跑完再说' }, req)).rejects.toThrow(/forbidden/)
    expect(followUpPiRun).not.toHaveBeenCalled()
  })
})

describe('AgentController runs/steer（steering 队列，2026-10-02）', () => {
  const req = { user: { sub: 'u1' } } as never

  it('空 / 纯空白 text → 400，且不调用下游 service', async () => {
    const steerPiRun = vi.fn()
    const findOne = vi.fn()
    const ctrl = new AgentController(
      { steerPiRun } as unknown as AgentService,
      { findOne } as unknown as SessionsService,
      {} as never,
    )

    for (const text of ['', '   ', undefined]) {
      const res = await ctrl.steerRun({ sessionId: 's1', text: text as string }, req)
      expect(res).toEqual({ code: 400, message: 'text is required', data: null })
    }
    expect(steerPiRun).not.toHaveBeenCalled()
    expect(findOne).not.toHaveBeenCalled()
  })

  it('正常：先校验归属（用 req.user.sub），再透传 sessionId/threadId/text', async () => {
    const steerPiRun = vi.fn().mockResolvedValue({ queued: true })
    const findOne = vi.fn().mockResolvedValue({ id: 's1' })
    const ctrl = new AgentController(
      { steerPiRun } as unknown as AgentService,
      { findOne } as unknown as SessionsService,
      {} as never,
    )

    const res = await ctrl.steerRun({ sessionId: 's1', threadId: 'tid-1', text: '插话' }, req)
    expect(res).toEqual({ code: 0, message: 'ok', data: { queued: true } })
    expect(findOne).toHaveBeenCalledWith('s1', 'u1')
    expect(steerPiRun).toHaveBeenCalledWith({ sessionId: 's1', threadId: 'tid-1', text: '插话' })
  })

  it('未传 threadId 时传 undefined（让 service 自行回落 sessionId）', async () => {
    const steerPiRun = vi.fn().mockResolvedValue({ queued: true })
    const ctrl = new AgentController(
      { steerPiRun } as unknown as AgentService,
      { findOne: vi.fn().mockResolvedValue({ id: 's1' }) } as unknown as SessionsService,
      {} as never,
    )

    await ctrl.steerRun({ sessionId: 's1', text: '插话' }, req)
    expect(steerPiRun).toHaveBeenCalledWith({ sessionId: 's1', threadId: undefined, text: '插话' })
  })

  it('归属校验失败（他人会话）→ 冒泡，绝不把消息塞进别人的跑着的那轮', async () => {
    const steerPiRun = vi.fn().mockResolvedValue({ queued: true })
    const ctrl = new AgentController(
      { steerPiRun } as unknown as AgentService,
      {
        findOne: vi.fn().mockRejectedValue(new Error('forbidden')),
      } as unknown as SessionsService,
      {} as never,
    )

    await expect(ctrl.steerRun({ sessionId: 's9', text: '插话' }, req)).rejects.toThrow(/forbidden/)
    expect(steerPiRun).not.toHaveBeenCalled()
  })
})
