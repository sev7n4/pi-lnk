/**
 * 插话 / 尾随「入队即落库」（2026-10-21）。
 *
 * ── 为什么这些断言必须落在「落库的可观测出口」上 ──────────────────────────
 * 本次修的是「刷新后历史里看不到插话」—— 出口是 `AgentMessage` 的**行内容**。
 * 若只断言「调用了 prisma.upsert」，则把 content 换成 pi 的拼装文本、
 * 或去掉 `update: {}`（变成覆盖写），测试照样绿 ⇒ 守不住真正的 bug。
 * 故此处一律断言 **create/update 的实参形状**（content / entryId / update 是否为空）。
 *
 * ⭐ 变异实测（三个变异一次跑 ⇒ 本文件 5 条断言变红）：
 *   ① 去掉 `update: {}` 改成覆盖写      ⇒ 「先到先得」两条红
 *   ② 改存发给 pi 的 text（含 QUEUE_MARK / [In=…]） ⇒ 「用户原话」两条红
 *   ③ 落库失败改成抛错（不 fail-soft）  ⇒ 「fail-soft」红
 */
import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'

describe('插话/尾随入队落库（2026-10-21）', () => {
  const agentMessageUpsert = vi.fn()
  const agentMessageFindFirst = vi.fn()
  const agentMessageUpdate = vi.fn()
  let steer: ReturnType<typeof vi.fn>
  let followUp: ReturnType<typeof vi.fn>

  let service: AgentService

  function build() {
    return new AgentService(
      {
        agentMessage: {
          upsert: agentMessageUpsert,
          findFirst: agentMessageFindFirst,
          update: agentMessageUpdate,
          create: vi.fn(),
          findMany: vi.fn(),
        },
        agentThread: { update: vi.fn(), upsert: vi.fn(), findUnique: vi.fn() },
        session: { findUnique: vi.fn(), update: vi.fn() },
        userAiPreferences: { findUnique: vi.fn().mockResolvedValue(null) },
      } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
    )
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.PI_RUNTIME_MODE = 'active'
    // ⚠️ 必须给 PI_RUNTIME_URL：`getPiRuntimeUrl()` 读它，缺省即 `undefined`
    //    ⇒ steerPiRun/followUpPiRun 会**提前 return { queued: false }**，
    //    根本走不到落库逻辑（表现为「期望 queued:true，实得 queued:false」）。
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:30100'
    agentMessageUpsert.mockResolvedValue({})
    agentMessageFindFirst.mockResolvedValue(null)
    agentMessageUpdate.mockResolvedValue({})
    // pi 的响应**带 entryId**（vendor QueueResult，pi-runtime session-manager.ts:2517/2583）
    steer = vi.fn().mockResolvedValue({ queued: true, entryId: 'E-steer-1' })
    followUp = vi.fn().mockResolvedValue({ queued: true, entryId: 'E-follow-1' })
  })

  function newService() {
 service = build()
    // ⚠️ 必须在 service 建好之后 spy（`build` 里还没有实例可 spy）
    vi.spyOn(service as never, 'createPiRuntimeClient' as never).mockReturnValue({
      steer,
      followUp,
    } as never)
    return service
  }

  it('steer 入队成功即落库，键=pi 回传的 entryId', async () => {
    const s = newService()
    const res = await s.steerPiRun({ sessionId: 's1', threadId: 't1', text: '再加一只猫' })

    expect(res.queued).toBe(true)
    expect(agentMessageUpsert).toHaveBeenCalledTimes(1)
    const arg = agentMessageUpsert.mock.calls[0]![0]
    expect(arg.where).toEqual({ entryId: 'E-steer-1' })
    expect(arg.create).toMatchObject({
      sessionId: 's1',
      threadId: 't1',
      role: 'user',
      entryId: 'E-steer-1',
    })
  })

  it('⭐ 落库内容是「用户原话」，不是发给 pi 的拼装文本', async () => {
    const s = newService()
    await s.steerPiRun({ sessionId: 's1', threadId: 't1', text: '再加一只猫' })

    const arg = agentMessageUpsert.mock.calls[0]![0]
    // 变异②：若改存发给 pi 的 text，这里会含 QUEUE_MARK / [In=…] 标记 ⇒ 红
    expect(arg.create.content).toBe('再加一只猫')
    expect(arg.create.content).not.toContain('[In=')
  })

  it('⭐ 先到先得：upsert 的 update 是空操作（重放/重试不得覆盖既有行）', async () => {
    const s = newService()
    await s.steerPiRun({ sessionId: 's1', threadId: 't1', text: '第一版' })
    await s.steerPiRun({ sessionId: 's1', threadId: 't1', text: '第二版（重放）' })

    // 变异①：若 update 改成 { content: ... }，这两条红
    for (const call of agentMessageUpsert.mock.calls) {
      expect(call[0].update).toEqual({})
    }
  })

  it('followUp 同样落库（刷新后历史也要能看到尾随指令）', async () => {
    const s = newService()
    const res = await s.followUpPiRun({ sessionId: 's1', threadId: 't1', text: '等下换成夜景' })

    expect(res.queued).toBe(true)
    expect(agentMessageUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { entryId: 'E-follow-1' },
        create: expect.objectContaining({ content: '等下换成夜景', entryId: 'E-follow-1' }),
      }),
    )
  })

  it('未入队（queued=false）不落库 —— 不能凭空造一条用户消息', async () => {
    steer.mockResolvedValue({ queued: false })
    const s = newService()
    await s.steerPiRun({ sessionId: 's1', threadId: 't1', text: '不该出现' })
    expect(agentMessageUpsert).not.toHaveBeenCalled()
  })

  it('无 threadId / 无 entryId / 纯机器载荷 ⇒ 不落库', async () => {
    const s = newService()
    await s.steerPiRun({ sessionId: 's1', text: '没有 thread' }) // 无 threadId
    await s.steerPiRun({ sessionId: 's1', threadId: 't1', text: 'x' }) // steer 有 entryId，单独测下面
    agentMessageUpsert.mockClear()

    steer.mockResolvedValue({ queued: true }) // 无 entryId
    await s.steerPiRun({ sessionId: 's1', threadId: 't1', text: '没有幂等键' })
    steer.mockResolvedValue({ queued: true, entryId: 'E-m' })
    await s.steerPiRun({
      sessionId: 's1',
      threadId: 't1',
      text: '__scheme_decision__ 机器载荷',
    })

    // 只有最后一条（机器载荷被 sanitize 判空）可能被拒；无 thread / 无 entryId 必须不落库
    expect(agentMessageUpsert).not.toHaveBeenCalled()
  })

  it('⭐ 落库失败 fail-soft：记 warn 但不抛（插话已入队，不能让前端以为没发出去）', async () => {
    agentMessageUpsert.mockRejectedValue(new Error('db down'))
    const s = newService()

    // 变异③：若去掉 try/catch 让它抛，这里红
    await expect(
      s.steerPiRun({ sessionId: 's1', threadId: 't1', text: '插话照常入队' }),
    ).resolves.toMatchObject({ queued: true, entryId: 'E-steer-1' })
  })
})

describe('user 消息 entryId 回填（统一 user 消息身份，2026-10-21）', () => {
  const agentMessageFindFirst = vi.fn()
  const agentMessageUpdate = vi.fn()
  let service: AgentService

  beforeEach(() => {
    vi.restoreAllMocks()
    agentMessageFindFirst.mockResolvedValue(null)
    agentMessageUpdate.mockResolvedValue({})
    service = new AgentService(
      {
        agentMessage: { findFirst: agentMessageFindFirst, update: agentMessageUpdate },
        agentThread: { update: vi.fn() },
        session: { findUnique: vi.fn(), update: vi.fn() },
        userAiPreferences: { findUnique: vi.fn().mockResolvedValue(null) },
      } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
    )
  })

  it('回填到最后一条「尚无 entryId」的 user 行上', async () => {
    agentMessageFindFirst
      .mockResolvedValueOnce(null) // 首次：按 entryId 查，没有
      .mockResolvedValueOnce({ id: 'm9' }) // 再查：最后一条无 entryId 的 user 行

    const res = await service.attachUserMessageEntryId({
      sessionId: 's1',
      threadId: 't1',
      entryId: 'E1',
    })

    expect(res).toEqual({ attached: true })
    expect(agentMessageFindFirst.mock.calls[1]![0]).toMatchObject({
      where: { sessionId: 's1', threadId: 't1', role: 'user', entryId: null },
      orderBy: { createdAt: 'desc' },
    })
    expect(agentMessageUpdate).toHaveBeenCalledWith({
      where: { id: 'm9' },
      data: { entryId: 'E1' },
    })
  })

  it('⭐ 幂等：同一 entryId 重复回填（多页签各报一次）直接 no-op', async () => {
    agentMessageFindFirst.mockResolvedValueOnce({ id: 'm9' }) // 已有该 entryId 的行

    const res = await service.attachUserMessageEntryId({
      sessionId: 's1',
      threadId: 't1',
      entryId: 'E1',
    })

    expect(res).toEqual({ attached: true })
    // 只查了一次（命中即返回），没有去改别人的行
    expect(agentMessageFindFirst).toHaveBeenCalledTimes(1)
    expect(agentMessageUpdate).not.toHaveBeenCalled()
  })

  it('找不到可认领的 user 行 ⇒ attached:false，不硬造', async () => {
    agentMessageFindFirst.mockResolvedValue(null)
    const res = await service.attachUserMessageEntryId({
      sessionId: 's1',
      threadId: 't1',
      entryId: 'E1',
    })
    expect(res).toEqual({ attached: false })
    expect(agentMessageUpdate).not.toHaveBeenCalled()
  })

  it('缺 threadId / entryId ⇒ 直接拒绝，不打 DB', async () => {
    expect(
      await service.attachUserMessageEntryId({ sessionId: 's1', threadId: '', entryId: 'E1' }),
    ).toEqual({ attached: false })
    expect(
      await service.attachUserMessageEntryId({ sessionId: 's1', threadId: 't1', entryId: '  ' }),
    ).toEqual({ attached: false })
    expect(agentMessageFindFirst).not.toHaveBeenCalled()
  })

  it('fail-soft：DB 抛错不冒泡（只影响「重跑」增强，不该打断对话）', async () => {
    agentMessageFindFirst.mockRejectedValue(new Error('db down'))
    await expect(
      service.attachUserMessageEntryId({ sessionId: 's1', threadId: 't1', entryId: 'E1' }),
    ).resolves.toEqual({ attached: false })
  })
})