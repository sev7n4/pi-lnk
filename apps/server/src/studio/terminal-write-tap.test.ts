import { describe, it, expect, vi } from 'vitest'
import { isTerminalGenerationWrite, buildTerminalWriteTap, TERMINAL_STATUSES } from './terminal-write-tap'
import { TerminalEventBus } from './terminal-events'

describe('isTerminalGenerationWrite（图 2 判据树）', () => {
  it('update status=completed → true', () => {
    expect(isTerminalGenerationWrite('update', { data: { status: 'completed' } })).toBe(true)
  })
  it('updateMany status=failed → true', () => {
    expect(isTerminalGenerationWrite('updateMany', { data: { status: 'failed' } })).toBe(true)
  })
  it('create status=completed → true', () => {
    expect(isTerminalGenerationWrite('create', { data: { status: 'completed' } })).toBe(true)
  })
  it('status=generating → false（中间态占位）', () => {
    expect(isTerminalGenerationWrite('update', { data: { status: 'generating' } })).toBe(false)
  })
  it('status=fallback_pending → false（BYOK 重试中间态）', () => {
    expect(isTerminalGenerationWrite('update', { data: { status: 'fallback_pending' } })).toBe(false)
  })
  it('无 data → false（findMany 等读操作）', () => {
    expect(isTerminalGenerationWrite('findMany', {})).toBe(false)
  })
  it('delete → false（不拦截删除）', () => {
    expect(isTerminalGenerationWrite('delete', { data: { status: 'completed' } })).toBe(false)
  })
  it('data 无 status → false（agentTurnNotified metadata 标记更新，§1 第 29 处）', () => {
    expect(isTerminalGenerationWrite('update', { data: { metadata: '{}' } })).toBe(false)
  })
})

// 极简伪 client：把扩展的 $allOperations 包进 generationRecord，不连真 DB。
function makeFakeClient() {
  const client: any = {
    $extends(ext: any) {
      const wrapped = ext.query.generationRecord.$allOperations
      const record = {
        async update(args: any) {
          return wrapped({ operation: 'update', args, query: async () => ({ id: 'r1' }) })
        },
        async updateMany(args: any) {
          return wrapped({ operation: 'updateMany', args, query: async () => ({ count: 1 }) })
        },
        async create(args: any) {
          return wrapped({ operation: 'create', args, query: async () => ({ id: 'r1' }) })
        },
        async findMany(args: any) {
          return wrapped({ operation: 'findMany', args, query: async () => [] })
        },
      }
      return { generationRecord: record }
    },
  }
  return client
}

describe('buildTerminalWriteTap $extends 行为', () => {
  it('终态写触发 emitTerminalized（defer 同步化便于断言）', async () => {
    const bus = new TerminalEventBus()
    const cb = vi.fn()
    bus.onTerminalized(cb)
    const ext = makeFakeClient().$extends(buildTerminalWriteTap(bus, { defer: (fn) => fn() }))
    await ext.generationRecord.update({ where: { id: 'r1' }, data: { status: 'completed' } })
    expect(cb).toHaveBeenCalledTimes(1)
  })
  it('enabled=false 时不触发（D-5 flag 关闭语义）', async () => {
    const bus = new TerminalEventBus()
    const cb = vi.fn()
    bus.onTerminalized(cb)
    const ext = makeFakeClient().$extends(buildTerminalWriteTap(bus, { enabled: false, defer: (fn) => fn() }))
    await ext.generationRecord.update({ where: { id: 'r1' }, data: { status: 'completed' } })
    expect(cb).not.toHaveBeenCalled()
  })
  it('非终态写不触发', async () => {
    const bus = new TerminalEventBus()
    const cb = vi.fn()
    bus.onTerminalized(cb)
    const ext = makeFakeClient().$extends(buildTerminalWriteTap(bus, { defer: (fn) => fn() }))
    await ext.generationRecord.update({ where: { id: 'r1' }, data: { status: 'generating' } })
    expect(cb).not.toHaveBeenCalled()
  })
  it('返回值透传（D-2：不改参数/不改返回）', async () => {
    const bus = new TerminalEventBus()
    const ext = makeFakeClient().$extends(buildTerminalWriteTap(bus, { defer: (fn) => fn() }))
    expect(await ext.generationRecord.update({ where: { id: 'r1' }, data: { status: 'completed' } })).toEqual({ id: 'r1' })
    expect(await ext.generationRecord.updateMany({ where: {}, data: { status: 'failed' } })).toEqual({ count: 1 })
  })
  it('D-2 fail-open：bus.emit 抛错仍返回 result（写路径不被阻塞）', async () => {
    const badBus = { emitTerminalized() { throw new Error('boom') } } as any
    const ext = makeFakeClient().$extends(buildTerminalWriteTap(badBus, { defer: (fn) => fn() }))
    await expect(
      ext.generationRecord.update({ where: { id: 'r1' }, data: { status: 'completed' } }),
    ).resolves.toEqual({ id: 'r1' })
  })
  it('TERMINAL_STATUSES 为运行时白名单', () => {
    expect(TERMINAL_STATUSES).toEqual(['completed', 'failed'])
  })
})

describe('变异（mutation）守卫', () => {
  it('⚠️ 变异点：status 不在白名单必须返回 false（反向断言覆盖白名单外分支）', () => {
    for (const s of ['generating', 'fallback_pending', 'pending', 'processing', 'error']) {
      expect(isTerminalGenerationWrite('update', { data: { status: s } })).toBe(false)
    }
  })
})
