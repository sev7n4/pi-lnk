/**
 * S3 行为回归（2026-11-17）：abort 与 needsStart 必须正交。
 *
 * 生产实证：#944 上线后 /runs/events 仍只有两条 ~19ms 请求，均 net::ERR_ABORTED。
 * 根因在接线层：needsStart=false 有两种含义——「不该开（follower/隐藏/交槽）」
 * 与「已有活连接（liveCount>=1，不该重复开）」。旧 else 分支把两者都当成
 * 「该 abort」⇒ 第二次判定时掐死唯一健康连接，且之后无触发点重开。
 *
 * 本测试把「什么时候才能释放连接」抽成纯函数并锁死上面两种语义的分界。
 */
import { describe, expect, it } from 'vitest'
import { shouldAbortConnection } from './shared-subscription-core'

type State = 'idle' | 'connecting' | 'streaming' | 'backoff'
const STATES: State[] = ['idle', 'connecting', 'streaming', 'backoff']

describe('S3：abort 与 needsStart 正交（不得误杀健康连接）', () => {
  it('不被允许且确有活连接 ⇒ 必须释放（follower / 隐藏页 / 交出全局槽位）', () => {
    for (const state of STATES) {
      expect(
        shouldAbortConnection({ allowed: false, state, liveCount: 1 }),
        `state=${state} 且本端不该开连接时必须释放`,
      ).toBe(true)
    }
  })

  it('不被允许但本来就没有活连接 ⇒ 无需 abort（no-op 即可）', () => {
    for (const state of STATES) {
      expect(shouldAbortConnection({ allowed: false, state, liveCount: 0 })).toBe(false)
    }
  })

  it('⭐ 被允许但已有活连接（needsStart=false）⇒ 绝不 abort（生产根因）', () => {
    for (const state of STATES) {
      for (const liveCount of [1, 2]) {
        expect(
          shouldAbortConnection({ allowed: true, state, liveCount }),
          `allowed=true + liveCount=${liveCount} + state=${state}：这是健康流，abort 会制造孤儿态`,
        ).toBe(false)
      }
    }
  })

  it('被允许且无活连接（需自愈开连接）⇒ 也不得 abort', () => {
    for (const state of STATES) {
      expect(shouldAbortConnection({ allowed: true, state, liveCount: 0 })).toBe(false)
    }
  })
})
