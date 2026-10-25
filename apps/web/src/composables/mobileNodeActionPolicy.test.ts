import { describe, it, expect } from 'vitest'
import { resolveMobileNodeActions, resolveMobileNodeMenuTiers } from './mobileNodeActionPolicy'

/**
 * 移动端长按 **Menu** 的操作集与门控（规格 §5.1 总门控表 + §4.11.2/§4.11.3）。
 *
 * ⭐ 单一真源：Menu 的渲染与页面层的分发都消费这一个函数，不各写一遍
 *   （否则门控会漂移 —— 审阅焦点 #2）。
 * ⭐ 一级 ≤5 项（Apple HIG：*"Avoid displaying more than four buttons …"* 的
 *   可扫读性原则 + §4.11.3）⇒ 低频项进二级「更多」。
 */
describe('resolveMobileNodeActions（操作集 + 状态门控）', () => {
  it('confirmed 节点 = 全集，且 edit 置顶、delete 置底', () => {
    const keys = resolveMobileNodeActions({ type: 'image', data: { url: 'https://x/a.png' } })
    expect(keys[0]).toBe('edit')
    expect(keys[keys.length - 1]).toBe('delete')
    expect(keys).toContain('reference')
    expect(keys).toContain('duplicate')
    expect(keys).toContain('duplicate-upstream')
    expect(keys).toContain('save-asset')
    expect(keys).toContain('save-local')
  })

  it('generating 态：禁引用/副本/资产库/本地/删除（G-12）', () => {
    const keys = resolveMobileNodeActions({ type: 'image', data: { status: 'generating' } })
    expect(keys).not.toContain('reference')
    expect(keys).not.toContain('duplicate')
    expect(keys).not.toContain('duplicate-upstream')
    expect(keys).not.toContain('save-asset')
    expect(keys).not.toContain('save-local')
    expect(keys).not.toContain('delete')
    expect(keys).toContain('rename')
    expect(keys).toContain('multi-select')
  })

  it('empty 节点：无产物 ⇒ 禁副本含上游/资产库/本地', () => {
    const keys = resolveMobileNodeActions({ type: 'image', data: {} })
    expect(keys).not.toContain('duplicate-upstream')
    expect(keys).not.toContain('save-asset')
    expect(keys).not.toContain('save-local')
    expect(keys).toContain('edit')
  })

  it('pending 节点：走全集（用户要能改词/看引用）', () => {
    const keys = resolveMobileNodeActions({ type: 'image', data: { status: 'pending_confirm' } })
    expect(keys).toContain('edit')
    expect(keys).toContain('reference')
    expect(keys).toContain('delete')
  })

  it('error 且有旧产物 = 走全集（Review Focus #1：用户此时最想看/存旧产物）', () => {
    const keys = resolveMobileNodeActions({
      type: 'image',
      data: { status: 'error', url: 'https://x/a.png' },
    })
    expect(keys).toContain('reference')
    expect(keys).toContain('save-local')
  })
})

describe('resolveMobileNodeMenuTiers（一级 / 二级分层 · §4.11.3）', () => {
  it('一级 ≤5 项：低频三项进二级「更多」（HIG 数量上限）', () => {
    const { primary, more } = resolveMobileNodeMenuTiers({
      type: 'image',
      data: { url: 'https://x/a.png' },
    })
    expect(primary.length).toBeLessThanOrEqual(5)
    expect(more).toContain('duplicate-upstream')
    expect(more).toContain('save-asset')
    expect(more).toContain('save-local')
    expect(primary).not.toContain('save-local')
    expect(primary).not.toContain('save-asset')
    expect(primary).not.toContain('duplicate-upstream')
  })

  it('一级末位是 delete（Menu 内破坏性置底，§4.11.4）', () => {
    const { primary } = resolveMobileNodeMenuTiers({ type: 'image', data: { url: 'https://x/a.png' } })
    expect(primary[primary.length - 1]).toBe('delete')
  })

  it('一级首项是 edit（高频主操作置顶）', () => {
    const { primary } = resolveMobileNodeMenuTiers({ type: 'image', data: { url: 'https://x/a.png' } })
    expect(primary[0]).toBe('edit')
  })

  it('generating 态：一级不足 5 ⇒ 二级项回填到一级，二级清空（不为 1 项单开二级）', () => {
    const { primary, more } = resolveMobileNodeMenuTiers({
      type: 'image',
      data: { status: 'generating' },
    })
    expect(primary.length).toBeLessThanOrEqual(5)
    expect(more).toEqual([])
    // 回填后「重命名」回到一级（generating 态唯一可下沉项）
    expect(primary).toContain('rename')
    // generating 态本就无破坏性项（不删生成中的任务）⇒ 末位约束不适用
    expect(primary).not.toContain('delete')
  })

  it('empty 节点：二级为空（无产物 ⇒ 无低频产物类操作）', () => {
    const { more } = resolveMobileNodeMenuTiers({ type: 'image', data: {} })
    expect(more).toEqual([])
  })

  it('两级并集 = 全集（不丢操作）', () => {
    const node = { type: 'image', data: { url: 'https://x/a.png' } }
    const all = resolveMobileNodeActions(node)
    const { primary, more } = resolveMobileNodeMenuTiers(node)
    expect([...primary, ...more].sort()).toEqual([...all].sort())
  })
})
