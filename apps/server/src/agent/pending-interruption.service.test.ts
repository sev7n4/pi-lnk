/**
 * P2 待确认门 durable（service 层行为级测试）。
 * spec: docs/superpowers/plans/2026-11-11-sse-p2-durable-interruption.md §4
 *
 * T1 门创建即落库（精确 expiresAt + 题面补齐 + 重复帧幂等 + 终态不复活）
 * T2 正常作答 CAS（幂等不双翻）
 * T3 超时扫描（mock 时钟 + 未过期不误翻 + 二次扫描幂等）
 * T5 重启存活（新 service 实例共享同一持久化 store）
 *
 * 变异自检（手工改实现 → 本文件必须 RED）：
 *  M1 去掉 openGate 的 `status !== 'pending' return` → T1 终态复活断言 RED
 *  M2 去掉 settleGate where 的 `status:'pending'` → T2 第二次 settle 不再返回 false → RED
 *  M3 去掉 sweepExpired 的 expiresAt 条件 → T3「未过期门不误翻」RED
 */
import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_GATE_TTL_MS,
  PENDING_INTERRUPTION_SWEEP_KEY,
  PendingInterruptionService,
} from './pending-interruption.service'

type Row = {
  id: string
  threadId: string
  callId: string
  kind: string
  questionsJson: string | null
  status: string
  answerJson: string | null
  expiresAt: Date
  runId: string | null
  createdAt: Date
  updatedAt: Date
}

/** 模拟持久化表：跨 service 实例共享 ⇒ 可验证「进程重启后仍在」。 */
class FakeGates {
  rows: Row[] = []
  private seq = 0

  async findUnique(args: { where: { threadId_callId: { threadId: string; callId: string } } }) {
    const k = args.where.threadId_callId
    return this.rows.find((r) => r.threadId === k.threadId && r.callId === k.callId) ?? null
  }

  async create(args: { data: Record<string, unknown> }) {
    const d = args.data
    if (this.rows.some((r) => r.threadId === d.threadId && r.callId === d.callId)) {
      throw new Error('unique constraint')
    }
    const row = { id: `r${++this.seq}`, ...d } as unknown as Row
    this.rows.push(row)
    return row
  }

  async update(args: { where: { id: string }; data: Record<string, unknown> }) {
    const row = this.rows.find((r) => r.id === args.where.id)
    if (!row) throw new Error('row not found')
    Object.assign(row, args.data)
    return row
  }

  async updateMany(args: { where: Record<string, any>; data: Record<string, unknown> }) {
    const w = args.where
    let count = 0
    for (const r of this.rows) {
      if (w.callId !== undefined && r.callId !== w.callId) continue
      if (w.threadId !== undefined && r.threadId !== w.threadId) continue
      if (w.status !== undefined && r.status !== w.status) continue
      if (w.expiresAt?.lt && !(r.expiresAt.getTime() < new Date(w.expiresAt.lt).getTime())) continue
      Object.assign(r, args.data)
      count++
    }
    return { count }
  }

  async findFirst(args: { where: Record<string, any>; orderBy?: Record<string, string> }) {
    const w = args.where
    const matches = this.rows.filter((r) => {
      if (w.callId !== undefined && r.callId !== w.callId) return false
      if (w.threadId !== undefined && r.threadId !== w.threadId) return false
      if (w.status !== undefined && r.status !== w.status) return false
      if (w.expiresAt?.gt && !(r.expiresAt.getTime() > new Date(w.expiresAt.gt).getTime())) return false
      return true
    })
    if (!matches.length) return null
    // getLatest 按 createdAt desc 取最新一条
    if (args.orderBy?.createdAt === 'desc') {
      return matches.reduce((a, b) => (b.createdAt.getTime() > a.createdAt.getTime() ? b : a))
    }
    return matches[0]!
  }

  async findMany(args: { where: Record<string, any> }) {
    const inList: string[] | undefined = args.where.callId?.in
    return this.rows.filter((r) => !inList || inList.includes(r.callId))
  }
}

const NOW = 1_800_000_000_000

function makeService(gates: FakeGates, scheduler?: { registerHandler: ReturnType<typeof vi.fn> }) {
  const prisma = { pendingInterruption: gates } as unknown as any
  return new PendingInterruptionService(prisma, scheduler as any)
}

describe('P2 待确认门 durable · service 层', () => {
  let gates: FakeGates
  let svc: PendingInterruptionService

  beforeEach(() => {
    gates = new FakeGates()
    svc = makeService(gates)
  })

  it('T1: 门创建即落库 —— 精确 expiresAt / 题面补齐 / 重复帧幂等 / 终态不复活', async () => {
    const expiresAt = NOW + 120_000
    await svc.openGate({
      threadId: 'thread-A',
      callId: 'call-1',
      runId: 'run-1',
      kind: 'ask_user',
      expiresAt,
      startedAt: NOW,
    })
    expect(gates.rows).toHaveLength(1)
    expect(gates.rows[0]!.status).toBe('pending')
    expect(gates.rows[0]!.expiresAt.getTime()).toBe(expiresAt)

    // 卡片帧随后到达：只补题面，绝不把精确 expiresAt 覆写成兜底 15min
    const questions = [{ id: 'q1', question: '选哪个？' }]
    await svc.openGate({
      threadId: 'thread-A',
      callId: 'call-1',
      questions,
      runId: 'run-1',
      startedAt: NOW,
    })
    expect(gates.rows).toHaveLength(1) // 幂等：不双行
    expect(JSON.parse(gates.rows[0]!.questionsJson as string)).toEqual(questions)
    expect(gates.rows[0]!.expiresAt.getTime()).toBe(expiresAt)

    // 无显式 expiresAt 的新门 ⇒ 兜底 TTL
    await svc.openGate({ threadId: 'thread-A', callId: 'call-2', startedAt: NOW })
    expect(gates.rows[1]!.expiresAt.getTime()).toBe(NOW + DEFAULT_GATE_TTL_MS)

    // 终态行不被复活（M1 变异点）
    await svc.settleGate({ threadId: 'thread-A', callId: 'call-1', status: 'expired' })
    await svc.openGate({
      threadId: 'thread-A',
      callId: 'call-1',
      questions,
      expiresAt: NOW + 999_999,
      startedAt: NOW,
    })
    expect(gates.rows[0]!.status).toBe('expired')
    expect(gates.rows[0]!.expiresAt.getTime()).toBe(expiresAt)
  })

  it('T2: 正常作答 CAS —— 翻 answered + 重复作答幂等不双翻', async () => {
    await svc.openGate({ threadId: 'thread-A', callId: 'call-1', expiresAt: NOW + 60_000, startedAt: NOW })
    const first = await svc.settleGate({
      threadId: 'thread-A',
      callId: 'call-1',
      status: 'answered',
      answerJson: { q1: ['A'] },
    })
    expect(first).toBe(true)
    expect(gates.rows[0]!.status).toBe('answered')
    expect(JSON.parse(gates.rows[0]!.answerJson as string)).toEqual({ q1: ['A'] })

    // 重复 POST：CAS where status='pending' 命中 0（M2 变异点）
    const second = await svc.settleGate({
      threadId: 'thread-A',
      callId: 'call-1',
      status: 'answered',
      answerJson: { q1: ['B'] },
    })
    expect(second).toBe(false)
    expect(JSON.parse(gates.rows[0]!.answerJson as string)).toEqual({ q1: ['A'] })
    expect(gates.rows).toHaveLength(1)
  })

  it('T3: 超时扫描 —— 过期门翻 expired、未过期门不误翻、二次扫描幂等', async () => {
    await svc.openGate({ threadId: 'thread-A', callId: 'expired-one', expiresAt: NOW + 1_000, startedAt: NOW })
    await svc.openGate({ threadId: 'thread-A', callId: 'live-one', expiresAt: NOW + 600_000, startedAt: NOW })

    const swept = await svc.sweepExpired(NOW + 2_000)
    expect(swept).toBe(1)
    expect(gates.rows.find((r) => r.callId === 'expired-one')!.status).toBe('expired')
    expect(gates.rows.find((r) => r.callId === 'live-one')!.status).toBe('pending') // M3 变异点

    expect(await svc.sweepExpired(NOW + 3_000)).toBe(0) // 幂等
  })

  it('T5: 重启存活 —— 新 service 实例（新进程）仍读到 pending 门', async () => {
    await svc.openGate({
      threadId: 'thread-A',
      callId: 'call-1',
      kind: 'propose_plan',
      questions: [{ id: 'p1', question: '确认？' }],
      expiresAt: NOW + 60_000,
      startedAt: NOW,
    })
    const afterRestart = makeService(gates) // 共享同一持久化 store
    const pending = await afterRestart.getPending('thread-A', NOW)
    expect(pending).not.toBeNull()
    expect(pending!.callId).toBe('call-1')
    expect(pending!.kind).toBe('propose_plan')
    expect(pending!.questions).toEqual([{ id: 'p1', question: '确认？' }])
    expect(pending!.status).toBe('pending')

    // 阴性：无门记录 ⇒ null（旧形状兼容）
    expect(await makeService(new FakeGates()).getPending('thread-A', NOW)).toBeNull()
    // 阴性：门已终态 ⇒ 不再是活门
    await svc.settleGate({ threadId: 'thread-A', callId: 'call-1', status: 'answered' })
    expect(await afterRestart.getPending('thread-A', NOW)).toBeNull()
  })

  it('T8 辅助: isGateLive 对终态/过期门返回 false，对未知门保守放行', async () => {
    expect(await svc.isGateLive('unknown', NOW)).toBe(true) // fail-open：老会话零回归
    await svc.openGate({ threadId: 't', callId: 'c', expiresAt: NOW + 5_000, startedAt: NOW })
    expect(await svc.isGateLive('c', NOW)).toBe(true)
    expect(await svc.isGateLive('c', NOW + 6_000)).toBe(false)
    await svc.settleGate({ threadId: 't', callId: 'c', status: 'answered' })
    expect(await svc.isGateLive('c', NOW)).toBe(false)
    expect(await svc.getTerminalCallIds(['c', 'unknown'], NOW)).toEqual(new Set(['c']))
  })

  it('handler 注册到统一调度器（不新起 timer）', () => {
    const registerHandler = vi.fn()
    const withScheduler = makeService(gates, { registerHandler })
    withScheduler.onModuleInit()
    expect(registerHandler).toHaveBeenCalledTimes(1)
    expect(registerHandler.mock.calls[0]![0]).toBe(PENDING_INTERRUPTION_SWEEP_KEY)
    expect(typeof registerHandler.mock.calls[0]![1]).toBe('function')
  })

  it('T9 (W1c D1=A): getLatest 返回最新门（不限 status）—— 与 getPending 互补', async () => {
    // 先开一张已作答的门，再开一张新的活门；getLatest 应返回最新建的（活门）
    await svc.openGate({
      threadId: 'thread-A',
      callId: 'call-old',
      kind: 'ask_user',
      questions: [{ id: 'o1', question: '旧的？' }],
      expiresAt: NOW + 60_000,
      startedAt: NOW,
    })
    await svc.settleGate({ threadId: 'thread-A', callId: 'call-old', status: 'answered' })
    await svc.openGate({
      threadId: 'thread-A',
      callId: 'call-new',
      kind: 'ask_user',
      questions: [{ id: 'n1', question: '新的？' }],
      expiresAt: NOW + 120_000,
      startedAt: NOW + 10_000,
    })
    const latest = await svc.getLatest('thread-A', NOW + 11_000)
    expect(latest).not.toBeNull()
    expect(latest!.callId).toBe('call-new') // 最新建的（createdAt 更大）
    expect(latest!.status).toBe('pending')
    expect(latest!.questions).toEqual([{ id: 'n1', question: '新的？' }])

    // 终态门也能被 getLatest 看到（getPending 看不到 ⇒ W1c-2 数据源）
    await svc.settleGate({ threadId: 'thread-A', callId: 'call-new', status: 'expired' })
    const terminal = await svc.getLatest('thread-A', NOW + 11_000)
    expect(terminal).not.toBeNull()
    expect(terminal!.callId).toBe('call-new')
    expect(terminal!.status).toBe('expired')

    // 阴性：无记录 ⇒ null（老会话零回归）
    expect(await makeService(new FakeGates()).getLatest('thread-A', NOW)).toBeNull()
  })

  it('M7 (W1c): getLatest 漏排 createdAt desc ⇒ T9「返回最新建」断言 RED', async () => {
    // 仅作变异锚：本测试验证 findFirst 排序逻辑存在；若实现去掉 orderBy 排序，
    // 上面 T9 的 callId==='call-new' 仍可能因插入顺序巧合通过，故此处显式验证排序生效。
    await svc.openGate({ threadId: 't', callId: 'first', expiresAt: NOW + 60_000, startedAt: NOW })
    await svc.openGate({ threadId: 't', callId: 'second', expiresAt: NOW + 60_000, startedAt: NOW + 5_000 })
    const latest = await svc.getLatest('t', NOW + 6_000)
    expect(latest!.callId).toBe('second')
  })
})
