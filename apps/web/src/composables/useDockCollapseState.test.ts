// studio dock 收缩态状态机（2026-10-20 PR3 / D-7）：
// PC 悬停展开/划走收回不变；移动端 tap 切换；两通道按断点互斥；生成中一律不收缩。
import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { useDockCollapseState } from './useDockCollapseState'

function setup(opts: { collapsed?: boolean; generating?: boolean; isMobile?: boolean } = {}) {
  const collapsed = ref(opts.collapsed ?? true)
  const generating = ref(opts.generating ?? false)
  const isMobile = ref(opts.isMobile ?? false)
  const api = useDockCollapseState({ collapsed, generating, isMobile })
  return { collapsed, generating, isMobile, ...api }
}

describe('useDockCollapseState（PR3 dock 折叠态）', () => {
  it('PC：收缩态靠 hoverOpen 展开，划走收回', () => {
    const s = setup()
    expect(s.collapsedNow.value).toBe(true)
    s.hoverOpen.value = true
    expect(s.collapsedNow.value).toBe(false)
    s.hoverOpen.value = false
    expect(s.collapsedNow.value).toBe(true)
  })

  it('移动端：tap 切换折叠/展开（hover 不参与）', () => {
    const s = setup({ isMobile: true })
    expect(s.collapsedNow.value).toBe(true)
    s.onCollapsedHit()
    expect(s.tapOpen.value).toBe(true)
    expect(s.collapsedNow.value).toBe(false)
    // 再点一次收起
    s.onCollapsedHit()
    expect(s.collapsedNow.value).toBe(true)
  })

  it('移动端：桌面端残留的合成 hover 不得顶掉 tap 展开态（两通道互斥）', () => {
    const s = setup({ isMobile: true })
    s.onCollapsedHit()
    s.hoverOpen.value = true
    expect(s.collapsedNow.value).toBe(false)
  })

  it('移动端展开态可经收起把手折叠', () => {
    const s = setup({ isMobile: true })
    s.onCollapsedHit()
    s.collapseByTap()
    expect(s.collapsedNow.value).toBe(true)
  })

  it('生成中/锁定：一律不收缩（两条通道都无权展开）', () => {
    const s = setup({ isMobile: true, generating: true })
    s.onCollapsedHit()
    expect(s.collapsedNow.value).toBe(false)
    const pc = setup({ generating: true })
    pc.hoverOpen.value = true
    expect(pc.collapsedNow.value).toBe(false)
  })

  it('宿主未要求收缩时恒展开', () => {
    const s = setup({ collapsed: false })
    expect(s.collapsedNow.value).toBe(false)
    s.onCollapsedHit()
    expect(s.collapsedNow.value).toBe(false)
  })
})