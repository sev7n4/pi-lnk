import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import MobileNodeEditorSheet from './MobileNodeEditorSheet.vue'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'MobileNodeEditorSheet.vue'), 'utf8')

/**
 * 走查④⑤⑥（2026-10-24 真机）：全屏编辑 sheet 的关闭入口与参数选择器。
 *
 * - ④ 图片打开后无法关闭回去：唯一关闭入口是左上角「▾」（语义模糊，像折叠
 *   不像关闭）⇒ 补平台惯例的右上角 X。
 * - ⑤ 右上角没有 x 关闭按钮：同上，44px 触控目标。
 * - ⑥ 四个节点类型的参数选择（模型 / 尺寸 / 视频 / 音频）点击不能弹出：
 *   根因是 PC popover 在全屏 sheet 里被 `overflow:hidden` 裁剪 + 包含块错觉
 *   压扁（详见组件内注释）⇒ sheet 作用域内统一改为贴底卡片。
 */
describe('走查④⑤：编辑 sheet 的关闭入口', () => {
  const baseNode = { id: 'n1', type: 'image', data: { url: 'x.png' } } as never

  it('右上角 X 存在且 emit close（行为级）', async () => {
    const w = mount(MobileNodeEditorSheet, { props: { node: baseNode } })
    const closeBtn = w.find('[data-testid="mobile-editor-close"]')
    expect(closeBtn.exists()).toBe(true)
    // 平台惯例：右上角（标题在左、按钮在右的 space-between 头栏）
    expect(closeBtn.attributes('aria-label')).toBe('关闭')
    await closeBtn.trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('44px 触控目标（磁贴/按钮都不能小于系统触控下限）', () => {
    const block = /<style scoped>([\s\S]*?)<\/style>/.exec(SRC)?.[1] ?? ''
    const rule = /\.sheet-close\s*\{([^}]*)\}/.exec(block)?.[1] ?? ''
    expect(rule, '必须能定位 .sheet-close 规则').not.toBe('')
    expect(rule).toMatch(/width:\s*var\(--lnk-touch-target\)/)
    expect(rule).toMatch(/height:\s*var\(--lnk-touch-target\)/)
  })

  it('左上角语义模糊的「▾」已删（不再有两个关闭语义）', () => {
    // ⚠️ 先剥注释：迁移说明写在注释里是规范（命中注释 = 假红）
    const template = (/<template>([\s\S]*?)<\/template>/.exec(SRC)?.[1] ?? '').replace(
      /<!--[\s\S]*?-->/g,
      '',
    )
    expect(template).not.toContain('▾')
    const closeCount = (template.match(/data-action="close"/g) ?? []).length
    expect(closeCount).toBe(1)
  })
})

describe('走查⑥：参数选择器弹层在 sheet 内可用（CSS 契约 + 变异意识）', () => {
  it('弹层改贴底卡片：fixed + 通宽 + 72vh 封顶 + 内部滚', () => {
    const block = /<style scoped>([\s\S]*?)<\/style>/.exec(SRC)?.[1] ?? ''
    const rule = /\.mobile-editor-sheet :deep\(\.neo-popover\)\s*\{([^}]*)\}/.exec(block)?.[1] ?? ''
    expect(rule, '必须能定位 .neo-popover 覆盖规则（删除即本守卫红）').not.toBe('')
    expect(rule).toMatch(/position:\s*fixed !important/)
    expect(rule).toMatch(/inset:\s*auto 0 0 0 !important/)
    expect(rule).toMatch(/max-height:\s*72vh !important/)
    expect(rule).toMatch(/overflow-y:\s*auto !important/)
    expect(rule).toMatch(/z-index:\s*300 !important/)
  })

  it('先摘 backdrop-filter（它会让 fixed 包含块变成面板而非视口）', () => {
    const block = /<style scoped>([\s\S]*?)<\/style>/.exec(SRC)?.[1] ?? ''
    const rule =
      /\.mobile-editor-sheet :deep\(\.bottom-toolbar-container\)\s*\{([^}]*)\}/.exec(block)?.[1] ?? ''
    expect(rule, '必须能定位 bottom-toolbar-container 覆盖规则').not.toBe('')
    expect(rule).toMatch(/backdrop-filter:\s*none/)
    expect(rule).toMatch(/-webkit-backdrop-filter:\s*none/)
  })

  it('触发器 wrapper 恢复 overflow: visible（弹层不再被裁剪）', () => {
    const block = /<style scoped>([\s\S]*?)<\/style>/.exec(SRC)?.[1] ?? ''
    expect(block).toMatch(/\.mobile-editor-sheet :deep\(\.bottom-toolbar-actions > \*:first-child\)\s*\{[^}]*overflow:\s*visible/)
    // chip 省略改由内部收缩完成（不依赖外层裁剪）
    expect(block).toMatch(/min-width:\s*0/)
  })

  it('四个参数选择器的弹层类名都在覆盖范围内（neo-popover 单一承接）', () => {
    // 模型 / 尺寸 / 视频 / 音频（含音色模型）五个触发器的弹层共用 .neo-popover
    for (const p of [
      'canvas/UniversalModelSelector.vue',
      'canvas/ImageParamsSelector.vue',
      'canvas/VideoSettingsSelector.vue',
      'canvas/AudioVoiceSettingsSelector.vue',
      'canvas/VoiceModelSelector.vue',
    ]) {
      const code = readFileSync(join(HERE, '..', p), 'utf8')
      expect(code, `${p} 的弹层必须挂 neo-popover（否则 sheet 内改贴底卡片覆盖不到）`).toMatch(
        /class="[^"]*neo-popover/,
      )
    }
  })

  it('覆盖全部限定在 .mobile-editor-sheet 作用域内（PC 浮动 Dock 零 diff）', () => {
    const block = /<style scoped>([\s\S]*?)<\/style>/.exec(SRC)?.[1] ?? ''
    // 走查⑥ 之后的所有 :deep 覆盖必须带 .mobile-editor-sheet 前缀
    const deepRules = block.match(/[^{}:]*:deep\([^{]*\)\s*\{/g) ?? []
    expect(deepRules.length).toBeGreaterThan(0)
    for (const r of deepRules) {
      expect(r, `覆盖规则未限定在 sheet 作用域：${r.trim()}`).toContain('.mobile-editor-sheet')
    }
  })
})
