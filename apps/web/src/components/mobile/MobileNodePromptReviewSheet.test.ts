// 提示词全文审核层（规格 §4.7.1，2026-10-27 S1 批次 · V-11 组件层断言）：
// 全文 + 参数只读摘要；三动作 = 批注（满屏截图）/ 编辑（就地改字）/ 朗读；
// ⛔ 无确认/拒绝按钮、无参数控件（单一确认面 ADR-0011）。
// 数据源 = data.prompt + 参数字段（⛔ 不读 data.content，§4.8.1）。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import MobileNodePromptReviewSheet from './MobileNodePromptReviewSheet.vue'

beforeEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: { cancel: vi.fn(), speak: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() },
  })
})

const node = {
  id: 'n1',
  type: 'image' as const,
  data: {
    prompt: '赛博朋克城市夜景，霓虹雨夜，电影感构图，高对比度',
    imageModel: 'qwen-image',
    imageAspect: '1:1',
    imageResolution: '2K',
    // ⛔ 陷阱字段：content 绝不能被本组件读取渲染（§4.8.1 数据层分离判据）
    content: '这是产物正文不是提示词',
  },
}

function mountSheet(overrides: Record<string, unknown> = {}) {
  return mount(MobileNodePromptReviewSheet, {
    props: { node, ...overrides },
    attachTo: document.body,
  })
}


/** 派发 PointerEvent（jsdom 实例属性只读 ⇒ test-utils trigger 赋值会炸，须走构造器） */
async function firePointer(
  el: Element,
  type: string,
  o: { pointerId: number; clientX?: number; clientY?: number },
): Promise<void> {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...o }))
  await nextTick()
}

describe('MobileNodePromptReviewSheet 内容（§4.7.1）', () => {
  it('渲染提示词全文 + 标题（提示词 · 名字）+ 参数只读摘要', () => {
    const w = mountSheet()
    expect(w.find('[data-testid="mobile-prompt-review-prompt"]').text()).toContain('赛博朋克城市夜景')
    expect(w.find('[data-testid="mobile-reading-title"]').text()).toBe('提示词 · 图片')
    expect(w.find('[data-testid="mobile-prompt-review-params"]').text()).toContain('qwen-image')
    expect(w.find('[data-testid="mobile-prompt-review-params"]').text()).toContain('1:1')
    w.unmount()
  })

  it('⛔ 数据层分离：不渲染 data.content（复用边界判据，§4.8.1 #2）', () => {
    const w = mountSheet()
    expect(w.find('[data-testid="mobile-prompt-review"]').text()).not.toContain('这是产物正文')
    w.unmount()
  })

  it('V-11：无确认/拒绝按钮、无参数控件（⛔ 单一确认面 ADR-0011 + P4 参数只读）', () => {
    const w = mountSheet()
    const text = w.find('[data-testid="mobile-prompt-review"]').text()
    expect(text).not.toContain('确认')
    expect(text).not.toContain('拒绝')
    expect(w.find('select').exists()).toBe(false)
    expect(w.find('input[type="range"]').exists()).toBe(false)
    w.unmount()
  })

  it('参数全缺省 → 摘要行不渲染（不猜不占位）', () => {
    const w = mountSheet({ node: { id: 'n1', type: 'audio', data: { prompt: '一段提示词' } } })
    expect(w.find('[data-testid="mobile-prompt-review-params"]').exists()).toBe(false)
    // 音频同样可达（§4.7.1 入口①「四类节点统一可达」）——标题类型名兜底
    expect(w.find('[data-testid="mobile-reading-title"]').text()).toBe('提示词 · 音频')
    w.unmount()
  })
})

describe('MobileNodePromptReviewSheet 动作（§17 v2 收敛）', () => {
  it('底栏 = 批注 / 编辑（+ 朗读）', () => {
    const w = mountSheet()
    expect(w.find('[data-testid="mobile-prompt-review-annotate"]').text()).toBe('批注')
    expect(w.find('[data-testid="mobile-prompt-review-edit"]').text()).toBe('编辑')
    expect(w.find('[data-testid="mobile-reading-tts"]').exists()).toBe(true)
    w.unmount()
  })

  it('编辑 → 就地 textarea（不弹 sheet）→ 保存 emit edit-save；取消不 emit', async () => {
    const w = mountSheet()
    await w.find('[data-testid="mobile-prompt-review-edit"]').trigger('click')
    const editArea = w.find('[data-testid="mobile-prompt-review-edit-input"]')
    expect(editArea.exists()).toBe(true)
    expect((editArea.element as HTMLTextAreaElement).value).toContain('赛博朋克城市夜景')
    await w.find('[data-testid="mobile-prompt-review-edit-cancel"]').trigger('click')
    expect(w.emitted('edit-save')).toBeFalsy()
    await w.find('[data-testid="mobile-prompt-review-edit"]').trigger('click')
    await w.find('[data-testid="mobile-prompt-review-edit-input"]').setValue('改词后的提示词')
    await w.find('[data-testid="mobile-prompt-review-edit-save"]').trigger('click')
    expect(w.emitted('edit-save')).toEqual([['改词后的提示词']])
    w.unmount()
  })

  it('编辑态 gestureLocked ⇒ 关闭手势不触发（画笔/输入不误关，评审 C1 同款）', async () => {
    const w = mountSheet()
    await w.find('[data-testid="mobile-prompt-review-edit"]').trigger('click')
    const root = w.find('[data-testid="mobile-reading-surface"]')
    await root.trigger('touchstart', { touches: [{ clientY: 150 }] })
    await root.trigger('touchmove', { touches: [{ clientY: 300 }] })
    await root.trigger('touchend')
    expect(w.emitted('close')).toBeFalsy()
    w.unmount()
  })

  it('批注态：首笔落定弹胶囊；⚓ 无标记 ⇒ 诚实降级（degraded, 只带文字）', async () => {
    const w = mountSheet()
    await w.find('[data-testid="mobile-prompt-review-annotate"]').trigger('click')
    const ink = w.find('[data-testid="mobile-prompt-review-ink"]')
    expect(ink.exists()).toBe(true)
    // 画笔已迁 useInkOverlay：Pointer Events 采集（touchstart → pointerdown）
    await firePointer(ink.element as Element, 'pointerdown', { pointerId: 1, clientX: 10, clientY: 10 })
    await firePointer(ink.element as Element, 'pointerup', { pointerId: 1 })
    expect(w.find('[data-testid="mobile-annotation-capsule"]').exists()).toBe(true)
    await w.find('[data-testid="mobile-annotation-capsule-input"]').setValue('构图太挤')
    // ⭐ 环境无关断言：CI 装了 canvas 包 ⇒ 合成成功走 marks 路径（degraded:false + Blob）；
    //   纯 jsdom ⇒ toBlob 不可用 ⇒ 走 catch 诚实降级（degraded:true，只带文字）。
    //   两条路径都必须带上意见文字，不静默丢意见 ⇒ 只断 degraded 为 boolean + text 透传。
    await w.find('[data-testid="mobile-annotation-capsule-anchor"]').trigger('click')
    await vi.waitFor(() => expect(w.emitted('annotate')).toBeTruthy())
    const payload = w.emitted('annotate')![0]![0] as { degraded: boolean; text?: string }
    expect(typeof payload.degraded).toBe('boolean')
    expect(payload.text).toBe('构图太挤')
    w.unmount()
  })

  it('X 关闭 → emit close', async () => {
    const w = mountSheet()
    await w.find('[data-testid="mobile-reading-close"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })
})
