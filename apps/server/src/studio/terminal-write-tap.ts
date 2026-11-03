import { TerminalEventBus } from './terminal-events'

export const TERMINAL_STATUSES = ['completed', 'failed'] as const
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number]

/**
 * 判据 D-1/D-3（纯函数，可单测，无 DB）：一个 generationRecord 写操作是否构成「终态迁移」。
 * schema 的 status 是自由 String（非 enum），故判据是运行时白名单，不是 Prisma 类型级约束。
 * 已对 studio 27 写点取证：终态仅 completed/failed；generating 占位、fallback_pending
 * BYOK 重试中间态、error 只改 canvas node 不改 record，均不误触。
 */
export function isTerminalGenerationWrite(operation: string, args: unknown): boolean {
  if (operation === 'delete' || operation === 'deleteMany') return false
  if (!args || typeof args !== 'object') return false
  const data = (args as { data?: unknown }).data
  if (!data || typeof data !== 'object') return false
  const status = (data as { status?: unknown }).status
  return (TERMINAL_STATUSES as readonly string[]).includes(status as string)
}

export interface TerminalWriteTapOptions {
  /** 缺省 true；false = flag 关闭，不发射（D-5）。 */
  enabled?: boolean
  /** 发射延迟器，缺省 setTimeout(0)（macrotask defer，事务鲁棒性保险）。测试注入同步 fn。 */
  defer?: (fn: () => void) => void
}

/**
 * 构建 Prisma $extends 扩展对象：在 generationRecord 所有操作的 after-callback 中，
 * 若判定为终态写则 fire-and-forget 发射事件。拦截层无状态/无锁/无重试（D-2）。
 *
 * 返回原始扩展对象（非 Prisma.defineExtension 包裹）：① 便于无 DB 单元测试（伪 client
 * 的 $extends 直接消费该对象）；② 真实 PrismaService.$extends(obj) 同样接受；③ 模块侧
 * 以 `as unknown as PrismaService` 重绑生命周期，消费者类型不变。
 */
export function buildTerminalWriteTap(bus: TerminalEventBus, opts: TerminalWriteTapOptions = {}) {
  const enabled = opts.enabled !== false
  const defer = opts.defer ?? ((fn: () => void) => setTimeout(fn, 0))
  return {
    query: {
      generationRecord: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async $allOperations({ operation, args, query }: any) {
          const result = await query(args)
          if (enabled && isTerminalGenerationWrite(operation as string, args)) {
            defer(() => {
              try {
                bus.emitTerminalized()
              } catch {
                /* fire-and-forget fail-open：发射失败绝不影响写路径 */
              }
            })
          }
          return result
        },
      },
    },
  }
}
