import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileNodeActionSheet from './MobileNodeActionSheet.vue'

/**
 * 移动端长按 **Menu**（2026-10-25 §4.11 Menu 化）。
 *
 * ⚠️ 契约变更：
 *  - 容器从「裸 `position:fixed` div」改为 **`MobileSheet` 基座**（scrim + 拖拽
 *    把手 + 圆角 + Teleport body）⇒ **测试必须 stub teleport**（VTU 默认把
 *    Teleport 内容送到 document.body，`wrapper.find()` 在 wrapper 子树里找不到）。
 *  - 一级 ≤5 项（§4.11.3）⇒ 低频项（重命名 / 副本含上游 / 存入资产库 / 保存到本地）
 *    进二级「更多」⇒ 需要它们时**先点「更多」**。
 *  - 文案改**动词短语**（§4.11.7）：编辑提示词 / 引用到对话 / 创建副本 / 删除节点
 *    （`multi-select` 的三态文案**严格不变**，见 multiSelect 测试）。
 */
const TELEPORT_STUB = { global: { stubs: { teleport: true } } }

describe('MobileNodeActionSheet（Menu · 一级/二级分层）', () => {
  const baseNode = { id: 'n1', type: 'image', data: { url: 'x.png' } }

  function mountSheet(node = baseNode) {
    return mount(MobileNodeActionSheet, { props: { node }, ...TELEPORT_STUB })
  }

  it('走 MobileSheet 基座（有遮罩 + 拖拽把手，不再是裸 fixed div）', () => {
    const w = mountSheet()
    expect(w.find('[data-testid="m-sheet-scrim"]').exists()).toBe(true)
    expect(w.find('.m-sheet-handle').exists()).toBe(true)
    w.unmount()
  })

  it('一级只列高频项（编辑 / 引用 / 副本 / 多选 / 删除），≤5 项', () => {
    const w = mountSheet()
    const html = w.html()
    expect(html).toContain('编辑提示词')
    expect(html).toContain('引用到对话')
    expect(html).toContain('创建副本')
    expect(html).toContain('多选')
    expect(html).toContain('删除节点')
    // 低频项不在一级
    expect(html).not.toContain('存入资产库')
    expect(html).not.toContain('保存到本地')
    expect(html).not.toContain('含上游')
    w.unmount()
  })

  it('点「更多」⇒ 二级含低频三项 + 返回', async () => {
    const w = mountSheet()
    await w.find('[data-action="more"]').trigger('click')
    const html = w.html()
    expect(html).toContain('重命名')
    expect(html).toContain('创建副本（含上游）')
    expect(html).toContain('存入资产库')
    expect(html).toContain('保存到本地')
    expect(w.find('[data-action="back"]').exists()).toBe(true)
    w.unmount()
  })

  it('点「返回」⇒ 回到一级', async () => {
    const w = mountSheet()
    await w.find('[data-action="more"]').trigger('click')
    await w.find('[data-action="back"]').trigger('click')
    expect(w.find('[data-action="edit"]').exists()).toBe(true)
    expect(w.find('[data-action="more"]').exists()).toBe(true)
    w.unmount()
  })

  it('点击「编辑提示词」emit action(edit)', async () => {
    const w = mountSheet()
    await w.find('[data-action="edit"]').trigger('click')
    expect(w.emitted('action')).toEqual([['edit']])
    w.unmount()
  })

  it('点击「删除节点」emit action(delete)（破坏性置底 + 红色）', async () => {
    const w = mountSheet()
    await w.find('[data-action="delete"]').trigger('click')
    expect(w.emitted('action')).toEqual([['delete']])
    expect(w.find('[data-action="delete"]').classes()).toContain('action-item--danger')
    w.unmount()
  })

  it('点击取消 emit close', async () => {
    const w = mountSheet()
    await w.find('[data-action="cancel"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('⛔ 零 --neo-* 旧令牌（G-15）', () => {
    const w = mountSheet()
    expect(w.html()).not.toContain('--neo-')
    w.unmount()
  })
})
