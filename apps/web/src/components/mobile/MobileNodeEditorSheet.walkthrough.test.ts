import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import MobileNodeEditorSheet from './MobileNodeEditorSheet.vue'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'MobileNodeEditorSheet.vue'), 'utf8')

/** 剥离注释（JS 注释 + HTML 注释）后再判定 —— 注释里提到组件名/术语是**规范**，不是引用 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/** 剥注释后的源码（判定「是否真的引用了某组件」时用它） */
const CODE = stripComments(SRC)

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
describe('走查④⑤ v2：导航三段（2026-11-01 规格 图 1 ①）', () => {
  const baseNode = { id: 'n1', type: 'image', data: { url: 'x.png' } } as never

  it('左「取消」存在且 emit close（行为级；X 已退役）', async () => {
    const w = mount(MobileNodeEditorSheet, { props: { node: baseNode } })
    const cancelBtn = w.find('[data-testid="mobile-editor-cancel"]')
    expect(cancelBtn.exists()).toBe(true)
    expect(cancelBtn.text()).toBe('取消')
    await cancelBtn.trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('右上「发送」胶囊：完整语义由 aria-label 承载（J-7）', () => {
    const w = mount(MobileNodeEditorSheet, {
      props: { node: { id: 'n1', type: 'image', data: { url: 'x.png', prompt: '一只猫' } } as never },
    })
    const send = w.find('[data-testid="mobile-editor-send"]')
    expect(send.exists()).toBe(true)
    expect(send.attributes('aria-label')).toBe('发给 agent 修改')
    w.unmount()
  })

  it('44px 触控目标（取消与发送都不能小于系统触控下限）', () => {
    const block = /<style scoped>([\s\S]*?)<\/style>/.exec(SRC)?.[1] ?? ''
    for (const cls of ['.nav-cancel', '.nav-send']) {
      const rule = new RegExp(`${cls.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(block)?.[1] ?? ''
      expect(rule, `必须能定位 ${cls} 规则`).not.toBe('')
      expect(rule).toMatch(/(?:min-height|height):\s*var\(--lnk-touch-target\)/)
    }
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

/**
 * 走查⑥ 的**收口**（2026-10-25 D8/J1/K1）：参数选择器整体随 PC dock 一起移除，
 * ⇒ 组件内那 35 行 `:deep(.neo-popover)` / `:deep(.bottom-toolbar-*)` 补丁
 * **一并消失**（它们的存在前提是「sheet 里挂着一个 PC 参数面板」）。
 *
 * ⭐ 这次修订同时消掉了走查⑥ 的**根因**（PC popover 在窄屏被裁剪 / 包含块压扁），
 * 而不只是绕过它。
 */
describe('走查⑥ 收口：换掉 PC dock 后，参数选择器与其补丁一并消失', () => {
  it('⛔ 组件内不再有 neo-popover / bottom-toolbar 的 :deep 补丁', () => {
    const block = /<style scoped>([\s\S]*?)<\/style>/.exec(CODE)?.[1] ?? ''
    expect(block).not.toContain(':deep(.neo-popover)')
    expect(block).not.toContain(':deep(.bottom-toolbar')
  })

  it('⛔ 组件内不再挂任何参数选择器（ModelSelector / ImageParamsSelector / …）', () => {
    for (const sel of [
      'ModelSelector',
      'ImageParamsSelector',
      'VideoSettingsSelector',
      'AudioVoiceSettingsSelector',
      'VoiceModelSelector',
      'DockStudioRouter',
    ]) {
      expect(CODE, `不应再出现 ${sel}`).not.toContain(sel)
    }
  })

  it('参数以只读 chips 呈现（agent 锁定 + 翻译制预填，非选择器）', () => {
    const template = (/<template>([\s\S]*?)<\/template>/.exec(SRC)?.[1] ?? '').replace(
      /<!--[\s\S]*?-->/g,
      '',
    )
    expect(template).toContain('参数')
    expect(template).toContain('mobile-editor-params')
    expect(template).toContain('mobile-editor-param-chip')
    expect(template).toContain('由 agent 锁定')
  })
})
