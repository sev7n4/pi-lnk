import { describe, it, expect, beforeEach } from 'vitest'
import { isSuppressed, markSuppressed } from './memory-suppression'

/**
 * M6a 反哺剔除 —— Nest 侧（注入通道）。
 * 关联：services/pi-runtime/src/tools/memory.test.ts（pi-runtime 侧同机制）。
 *
 * 这里的表是**进程内态**且**不跨进程同步**（理由见 memory-suppression.ts 顶部注释），
 * 故每条用例必须用**独立 id**：`beforeEach` 不清表（清表等于给生产代码加只为本测试存在的 API），
 * 用例之间靠 id 隔离，避免后写的标记污染前面的断言。
 */
describe('反哺抑制表（Nest 侧）', () => {
  beforeEach(() => {
    // 前置：确认初始态确实「未抑制」，否则下面几条可能因上个用例遗留状态而假绿
    expect(isSuppressed('mem-nest-untouched')).toBe(false)
  })

  it('标记后 isSuppressed 为 true，未标记为 false', () => {
    expect(isSuppressed('mem-nest-a')).toBe(false)
    markSuppressed('mem-nest-a', '反复把跨画布记忆当当前画布观察')
    expect(isSuppressed('mem-nest-a')).toBe(true)
    expect(isSuppressed('mem-nest-b')).toBe(false)
  })

  it('id 缺失时 fail-open 判false（无法判定就不删）', () => {
    // 这条锁的是「空 id 不被当成已抑制」。若有人把isSuppressed 硬化成
    // `if (!id) return true`（一种看起来很「安全」的 fail-closed 写法），
    // 注入侧会开始静默丢弃所有无 id 条目 —— 而记忆池里这类条目真实存在。
    expect(isSuppressed(undefined)).toBe(false)
    expect(isSuppressed(null)).toBe(false)
    expect(isSuppressed('')).toBe(false)
  })

  it('重复标记幂等（表是集合不是日志）', () => {
    markSuppressed('mem-nest-idem', '第一次')
    markSuppressed('mem-nest-idem', '第二次')
    expect(isSuppressed('mem-nest-idem')).toBe(true)
  })

  it('markSuppressed 收到空 id 时不写入（不制造一个「空 id 已抑制」的陷阱键）', () => {
    markSuppressed('', '空 id')
    // 若真写进去了，isSuppressed('') 会变true —— 那会让所有无 id 条目被静默剔除
    expect(isSuppressed('')).toBe(false)
  })
})