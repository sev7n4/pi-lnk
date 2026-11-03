import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentStore } from './agent'
import { useAuthStore } from './auth'
import type { CreditTxEvent } from '@lnkpi/shared'

/** 2026-11-03 Epic 1：前端 `trackCreditTx` 入口——幂等去重 + 本会话累计 + 余额事件化。 */
function makeCreditTx(over: Partial<CreditTxEvent['data']> = {}): CreditTxEvent['data'] {
  return {
    txId: 'tx-1',
    userId: 'u1',
    sessionId: 's1',
    amount: -10,
    kind: 'consume',
    category: 'image',
    reason: 'image_generation',
    balanceAfter: 90,
    ts: Date.now(),
    ...over,
  }
}

describe('trackCreditTx（Epic1 前端口径 + 余额事件化）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('收到 credit_tx 后本会话累计含生成费；同 txId 重放不重复计入', () => {
    const auth = useAuthStore()
    vi.spyOn(auth, 'refreshPoints').mockResolvedValue(100)
    const store = useAgentStore()
    expect(store.sessionConsumedCredits).toBe(0)
    store.trackCreditTx(makeCreditTx({ txId: 'a', category: 'image', amount: -10, balanceAfter: 90 }))
    expect(store.sessionConsumedCredits).toBe(10)
    // 同 txId 重放（断线重连）不重复计入
    store.trackCreditTx(makeCreditTx({ txId: 'a', category: 'image', amount: -10, balanceAfter: 90 }))
    expect(store.sessionConsumedCredits).toBe(10)
    // 不同 txId 累加
    store.trackCreditTx(makeCreditTx({ txId: 'b', category: 'image', amount: -5, balanceAfter: 85 }))
    expect(store.sessionConsumedCredits).toBe(15)
  })

  it('balanceAfter 直接驱动余额 pill（auth.setPoints，C2 余额事件化预备）', () => {
    const auth = useAuthStore()
    const setPointsSpy = vi.spyOn(auth, 'setPoints')
    vi.spyOn(auth, 'refreshPoints').mockResolvedValue(100)
    const store = useAgentStore()
    store.trackCreditTx(makeCreditTx({ txId: 'c', balanceAfter: 73 }))
    expect(setPointsSpy).toHaveBeenCalledWith(73)
  })

  it('退款（kind:refund, amount>0）回补已消耗并同步余额', () => {
    const auth = useAuthStore()
    const setPointsSpy = vi.spyOn(auth, 'setPoints')
    vi.spyOn(auth, 'refreshPoints').mockResolvedValue(80)
    const store = useAgentStore()
    store.trackCreditTx(makeCreditTx({ txId: 'd', category: 'image', amount: -20, balanceAfter: 80 }))
    expect(store.sessionConsumedCredits).toBe(20)
    store.trackCreditTx(
      makeCreditTx({ txId: 'e', kind: 'refund', category: 'image', amount: 8, balanceAfter: 88 }),
    )
    expect(store.sessionConsumedCredits).toBe(12) // 20 - 8
    expect(setPointsSpy).toHaveBeenLastCalledWith(88)
  })

  it('新会话 clear() 重置累计；但幂等集保留（跨会话不误杀新交易）', () => {
    const auth = useAuthStore()
    vi.spyOn(auth, 'refreshPoints').mockResolvedValue(100)
    const store = useAgentStore()
    store.trackCreditTx(makeCreditTx({ txId: 'f', amount: -10, balanceAfter: 90 }))
    expect(store.sessionConsumedCredits).toBe(10)
    store.clear()
    expect(store.sessionConsumedCredits).toBe(0) // 本会话累计重置
    // 新会话不同 txId 仍正常计入（幂等集保留但不挡新交易）
    store.trackCreditTx(makeCreditTx({ txId: 'g', amount: -7, balanceAfter: 83 }))
    expect(store.sessionConsumedCredits).toBe(7)
  })

  it('creditSplit 按 category 拆分对话费/生成费（摘要「对话 M · 生成 K」数据源）', () => {
    const auth = useAuthStore()
    vi.spyOn(auth, 'refreshPoints').mockResolvedValue(100)
    const store = useAgentStore()
    store.trackCreditTx(makeCreditTx({ txId: 't1', category: 'text', amount: -14, balanceAfter: 86 }))
    store.trackCreditTx(makeCreditTx({ txId: 't2', category: 'image', amount: -10, balanceAfter: 76 }))
    expect(store.creditSplit).toEqual({ text: 14, generation: 10 })
    expect(store.sessionConsumedCredits).toBe(24)
  })

  it('Epic4 Task8：restore 模式累计但不动余额（历史行 balanceAfter 非全局最新）', () => {
    const auth = useAuthStore()
    const setPointsSpy = vi.spyOn(auth, 'setPoints')
    const refreshSpy = vi.spyOn(auth, 'refreshPoints').mockResolvedValue(100)
    const store = useAgentStore()
    store.trackCreditTx(
      makeCreditTx({ txId: 'r1', category: 'image', amount: -10, balanceAfter: 5 }),
      { restore: true },
    )
    expect(store.sessionConsumedCredits).toBe(10) // 累计生效
    expect(store.creditSplit).toEqual({ text: 0, generation: 10 })
    expect(setPointsSpy).not.toHaveBeenCalled() // 不驱动余额
    expect(refreshSpy).not.toHaveBeenCalled() // refreshPoints 由调用方在还原后统一触发
    // restore 之后实时帧照常驱动余额（幂等集互不干扰）
    store.trackCreditTx(makeCreditTx({ txId: 'r2', amount: -3, balanceAfter: 77 }))
    expect(setPointsSpy).toHaveBeenCalledWith(77)
  })

  it('Epic5 Task11：漂移告警——余额降幅 > 本会话扣费 ⇒ 差额计入 crossSessionSpend（M2/M4 防御）', () => {
    const auth = useAuthStore()
    const setPointsSpy = vi.spyOn(auth, 'setPoints')
    vi.spyOn(auth, 'refreshPoints').mockResolvedValue(100)
    const store = useAgentStore()
    // 先把余额基线设为 100（setPoints mock 直写 user.points；⚠️ 断言禁 as never——
    // never 收窄会让后续 auth.user?.points 全线 TS2339，CI 教训 2026-11-04）
    setPointsSpy.mockImplementation((n: number) => {
      if (auth.user) auth.user.points = n
    })
    auth.user = { id: 'u1', points: 100 } as unknown as typeof auth.user
    // 本会话扣 10，余额 100→90：降幅=10=本会话扣费 ⇒ 无漂移
    store.trackCreditTx(makeCreditTx({ txId: 'd1', amount: -10, balanceAfter: 90 }))
    expect(store.crossSessionSpend).toBe(0)
    // 本会话扣 3，但余额 90→62（降幅 28）：差额 25 来自其他会话
    store.trackCreditTx(makeCreditTx({ txId: 'd2', amount: -3, balanceAfter: 62 }))
    expect(store.crossSessionSpend).toBe(25)
    // 退款令余额上升不构成漂移
    store.trackCreditTx(makeCreditTx({ txId: 'd3', kind: 'refund', amount: 5, balanceAfter: 67 }))
    expect(store.crossSessionSpend).toBe(24)
    // 新会话 clear() 重置漂移告警
    store.clear()
    expect(store.crossSessionSpend).toBe(0)
  })
})
