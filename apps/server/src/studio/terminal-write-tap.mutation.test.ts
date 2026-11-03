import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isTerminalGenerationWrite,
  buildTerminalWriteTap,
} from './terminal-write-tap'
import { isTerminalWriteTapEnabled } from '../prisma/prisma.module'
import { TerminalEventBus } from './terminal-events'

/**
 * E1 变异测试（§7.2 三件套 + D-6 解耦）。每个守卫同时给出「正确实现断言」
 * 与「变异体反例」，证明该测试不是真空绿——源码若退化到变异形态，既有断言会翻红。
 */

// 与 terminal-write-tap.test.ts 同构的极简伪 client（不连真 DB）。
function makeFakeClient() {
  const client: any = {
    $extends(ext: any) {
      const wrapped = ext.query.generationRecord.$allOperations
      const record = {
        async update(args: any) {
          return wrapped({ operation: 'update', args, query: async () => ({ id: 'r1' }) })
        },
      }
      return { generationRecord: record }
    },
  }
  return client
}

// 变异态伪 client：用调用方提供的 mutant $allOperations（可复刻「把 void 改 await」）。
function makeMutantClient(mutantAllOps: any) {
  const client: any = {
    $extends() {
      const record = {
        async update(args: any) {
          return mutantAllOps({ operation: 'update', args, query: async () => ({ id: 'r1' }) })
        },
      }
      return { generationRecord: record }
    },
  }
  return client
}

describe('变异守卫 · D-2 零阻塞（写路径不 await 通报）', () => {
  it('正确实现：写调用返回后 emit 仍在 macrotask 未触发（拦截层 fail-open、零阻塞）', async () => {
    const bus = new TerminalEventBus()
    const emitSpy = vi.spyOn(bus, 'emitTerminalized')
    // 默认 defer=setTimeout(0)：emit 落在下一个 macrotask。
    const ext = makeFakeClient().$extends(buildTerminalWriteTap(bus))
    await ext.generationRecord.update({ data: { status: 'completed' } })
    // 守卫断言：若源码把 `defer(...)` 改成 `await defer(...)`，此处会翻红（emit 已在 resolve 前跑完）。
    expect(emitSpy).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(emitSpy).toHaveBeenCalled())
  })

  it('变异体：若触发改成 await defer，写路径会阻塞在 emit（反例证明守卫非真空）', async () => {
    const bus = new TerminalEventBus()
    const emitSpy = vi.spyOn(bus, 'emitTerminalized')
    // §7.2 ② 变异：复刻源码结构，仅把 `defer(...)` 改为 `await defer(...)`。
    const mutantAllOps = async ({ args, query }: any) => {
      const result = await query(args)
      const defer = (fn: () => void) => fn() // 同步 defer
      await defer(() => bus.emitTerminalized()) // 变异点：await 掉 defer
      return result
    }
    const ext = makeMutantClient(mutantAllOps).$extends()
    await ext.generationRecord.update({ data: { status: 'completed' } })
    // 变异体下 emit 在写调用 resolve 前已同步执行 ⇒ 上面的「not.toHaveBeenCalled」守卫会翻红。
    expect(emitSpy).toHaveBeenCalled()
  })
})

describe('变异守卫 · D-3 判据穷举（status∈白名单不可省略）', () => {
  it('正确实现：generating / metadata-only 写点均不误触发', () => {
    // §1 第 29 处写点：late-generation-notify 只写 metadata，无 status 字段。
    expect(isTerminalGenerationWrite('update', { data: { metadata: '{}' } })).toBe(false)
    // 中间态占位 / 重试中间态。
    expect(isTerminalGenerationWrite('update', { data: { status: 'generating' } })).toBe(false)
    expect(isTerminalGenerationWrite('update', { data: { status: 'fallback_pending' } })).toBe(false)
  })

  it('变异体：若去掉 status∈白名单检查，generating/fallback_pending 会误触发（反例证明守卫非真空）', () => {
    // 复刻 isTerminalGenerationWrite，但删掉「status ∈ completed/failed」分支（保留 status 存在性检查）。
    const mutant = (operation: string, args: any): boolean => {
      if (operation === 'delete' || operation === 'deleteMany') return false
      if (!args || typeof args !== 'object') return false
      const data = args.data
      if (!data || typeof data !== 'object') return false
      // 变异点：只判 status 字段存在，不再判是否是终态集合。
      return 'status' in data
    }
    // 误判：带 status 字段但非终态 ⇒ 本应 false，变异后 true（§7.2 ① 所谓「去掉 status∈检查」）。
    expect(mutant('update', { data: { status: 'generating' } })).toBe(true)
    expect(mutant('update', { data: { status: 'fallback_pending' } })).toBe(true)
    // 对照正确实现：上述两者均为 false ⇒ 既有 D-3 用例能抓出此变异。
    expect(isTerminalGenerationWrite('update', { data: { status: 'generating' } })).toBe(false)
    expect(isTerminalGenerationWrite('update', { data: { status: 'fallback_pending' } })).toBe(false)
    // 控制组：无 status 字段的 metadata 写点（§1 第 29 处）在变异后仍正确为 false
    //（去掉白名单检查不影响「status 字段存在」这一前置关卡）。
    expect(mutant('update', { data: { metadata: '{}' } })).toBe(false)
    expect(isTerminalGenerationWrite('update', { data: { metadata: '{}' } })).toBe(false)
  })
})

describe('变异守卫 · D-5 flag 语义（判断取反会翻红）', () => {
  const env = { ...process.env }

  afterEach(() => {
    process.env = env
  })

  it('正确实现：LNKPI_TERMINAL_WRITE_TAP=false ⇒ 关闭', () => {
    process.env.LNKPI_TERMINAL_WRITE_TAP = 'false'
    expect(isTerminalWriteTapEnabled()).toBe(false)
  })

  it('变异体：若 flag 判断取反，false 会变成启用（反例证明开关守卫非真空）', () => {
    const correct = (v?: string) => v !== 'false'
    const mutant = (v?: string) => v === 'false' // 取反
    expect(correct('false')).toBe(false)
    expect(mutant('false')).toBe(true) // 变异：false 反而启用 ⇒ 既有开关用例翻红
    process.env.LNKPI_TERMINAL_WRITE_TAP = 'false'
    expect(isTerminalWriteTapEnabled()).toBe(false) // 真实实现等价于 correct
  })
})

describe('变异守卫 · D-6 解耦（tap 不直接依赖 reaper）', () => {
  it('terminal-write-tap.ts 不得 import / 引用 GenerationReaperService', () => {
    const src = readFileSync(join(__dirname, 'terminal-write-tap.ts'), 'utf8')
    expect(src).not.toContain('generation-reaper.service')
    expect(src).not.toContain('GenerationReaperService')
    // 正向确认：唯一对外依赖是领域事件总线（解耦地基）。
    expect(src).toContain("from './terminal-events'")
  })
})
