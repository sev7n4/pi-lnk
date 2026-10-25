/**
 * 画布整份覆盖保存守卫（纯函数层）。
 *
 * ⭐ 判据的**社会意义**：画布数据没加载成功时，本地画布是**不完整**的；
 *   此时任何整份 PUT 都是「用残缺覆盖完整」⇒ 服务端真画布被抹掉 ⇒ 不可逆。
 *   ⇒ 判据是 `state !== 'loaded'`，与「本地有没有节点」无关
 *   （有节点也不安全：那是残缺集合，盖上去一样丢）。
 */
import { describe, expect, it } from 'vitest'
import { shouldBlockCanvasOverwrite, type CanvasLoadState } from './canvasLoadGuard'

describe('画布整份覆盖保存的准入判据', () => {
  it('未成功加载 ⇒ 一律禁止整份覆盖（防空画布抹掉真画布）', () => {
    for (const s of ['idle', 'loading', 'failed'] as CanvasLoadState[]) {
      expect(shouldBlockCanvasOverwrite(s), `${s} 态必须拦住整份 PUT`).toBe(true)
    }
  })

  it('加载成功 ⇒ 放行（新建的空画布也必须能保存）', () => {
    expect(shouldBlockCanvasOverwrite('loaded')).toBe(false)
  })

  it('变异点：把判据写成「本地有节点就放行」⇒ 未加载成功时不得放行', () => {
    // 本地有节点**也不**安全：那是残缺集合，盖上去一样丢。
    // 判据只看加载状态，不看节点数（节点数在接线层，不在本纯函数里）。
    expect(shouldBlockCanvasOverwrite('loading')).toBe(true)
    expect(shouldBlockCanvasOverwrite('failed')).toBe(true)
  })
})
