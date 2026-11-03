import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PrismaService } from '../prisma/prisma.service'
import { buildTerminalWriteTap } from './terminal-write-tap'
import { TerminalEventBus } from './terminal-events'

/**
 * E1 集成（真实 PrismaService）：验证 terminal-write-tap 能被**真实** PrismaClient
 * 的 `$extends` 接受并产出合法扩展客户端。这是 Task 3 的回归护栏——早期用
 * `Prisma.defineExtension` 包裹会产出不透明 wrapper，真实 `$extends` 链消费时
 * `.query` 为 undefined ⇒ 整条拦截器失效。此处直接用真实 `PrismaService.$extends`
 * 验证，杜绝此类「看着像对、实际没挂上」的假绿。
 *
 * 注：不连库——只验证扩展接线（形状/可调用性），写点→emit 的端到端行为由
 * terminal-write-tap.test.ts（忠实 $extends 模拟）与 generation-reaper.service.test.ts
 * （真实订阅→notify）覆盖。
 */
describe('E1 集成：terminal-write-tap 接入真实 PrismaService.$extends', () => {
  let prisma: PrismaService
  let bus: TerminalEventBus

  beforeEach(() => {
    delete process.env.LNKPI_TERMINAL_WRITE_TAP // 默认启用
    bus = new TerminalEventBus()
    prisma = new PrismaService()
  })

  afterEach(() => {
    // 不连库，无需 disconnect；仅释放引用。
    prisma = undefined as unknown as PrismaService
    bus = undefined as unknown as TerminalEventBus
  })

  it('$extends(buildTerminalWriteTap) 不抛错且产出合法扩展客户端', () => {
    const ext = prisma.$extends(buildTerminalWriteTap(bus) as never) as unknown as PrismaService
    expect(ext).toBeDefined()
    // 扩展客户端必须仍是可链式扩展的 Prisma 客户端。
    expect(typeof ext.$extends).toBe('function')
    expect(typeof ext.$connect).toBe('function')
    expect(typeof ext.$disconnect).toBe('function')
  })

  it('扩展后 generationRecord 委托与 create/findMany 方法仍可用（未被 clobber）', () => {
    const ext = prisma.$extends(buildTerminalWriteTap(bus) as never) as unknown as PrismaService
    expect(ext.generationRecord).toBeDefined()
    expect(typeof ext.generationRecord.create).toBe('function')
    expect(typeof ext.generationRecord.findMany).toBe('function')
  })

  it('flag=off 时扩展结构同样成立（拦截器内部 enabled 短路，不影响接线）', () => {
    process.env.LNKPI_TERMINAL_WRITE_TAP = 'false'
    const ext = prisma.$extends(buildTerminalWriteTap(bus) as never) as unknown as PrismaService
    expect(typeof ext.generationRecord.create).toBe('function')
  })
})
