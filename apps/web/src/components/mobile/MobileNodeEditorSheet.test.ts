import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileNodeEditorSheet from './MobileNodeEditorSheet.vue'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(__dirname, 'MobileNodeEditorSheet.vue'), 'utf-8')
/** 只取 <template> 段（可见文案）—— ⛔ 注释里允许出现技术术语 */
const TPL = /<template>([\s\S]*?)<\/template>/.exec(SRC)?.[1] ?? ''

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
 * 移动端**轻量编辑器**（D8 / J1 / K1 · 2026-10-25 规格 §4.2）。
 *
 * ⭐ 核心变更：不再复用 PC 的 `DockStudioRouter`（参数所有权在 agent 侧 +
 *   窄屏参数选择器已实证弹不开），改为「改词 + 提意见」，出口是「发给 agent 修改」。
 */
describe('MobileNodeEditorSheet 轻量编辑器（D8 / J1 / K1）', () => {
  const baseNode = {
    id: 'n1',
    type: 'image',
    position: { x: 0, y: 0 },
    data: { url: 'x.png', prompt: '一只猫' },
  } as any

  it('⛔ 不再复用 PC studio dock（G-4 / G-7）', () => {
    // ⚠️ 用剥注释后的源码判定：注释里提到「不再挂 DockStudioRouter」是**规范说明**
    expect(CODE).not.toContain('DockStudioRouter')
    expect(CODE).not.toContain('dock-studio')
  })

  it('⛔ 可见文案里不出现本地提交按钮（「生成」二字只允许出现在注释/技术说明）', () => {
    expect(TPL).not.toContain('生成')
  })

  it('有「发给 agent 修改」出口', () => {
    expect(TPL).toContain('发给 agent 修改')
  })

  it('有提示词编辑区与意见输入区', () => {
    expect(TPL).toContain('提示词')
    expect(TPL).toContain('我的意见')
  })

  it('参数区只读（不出现参数选择器）', () => {
    expect(CODE).not.toContain('ModelSelector')
    expect(CODE).not.toContain('ImageParamsSelector')
    expect(CODE).not.toContain('VideoSettingsSelector')
    expect(CODE).not.toContain('AudioVoiceSettingsSelector')
  })

  it('emit send-to-agent（而非 generate）', () => {
    expect(SRC).toContain('send-to-agent')
    expect(SRC).not.toContain("'generate'")
  })

  it('⛔ 删掉 PC dock 专用契约：upstream prop / generate / removeRef emit', () => {
    expect(CODE).not.toContain('upstream')
    expect(CODE).not.toContain('removeRef')
  })

  it('关闭按钮 emit close', async () => {
    const w = mount(MobileNodeEditorSheet, { props: { node: baseNode } })
    await w.find('[data-action="close"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('initialOpinion 预填意见框（音频 at mm:ss 链路终点，规格 v1.5 Q）', () => {
    const w = mount(MobileNodeEditorSheet, { props: { node: baseNode, initialOpinion: 'at 0:07' } })
    expect((w.get('[data-testid="mobile-editor-opinion"]').element as HTMLTextAreaElement).value).toBe('at 0:07')
    w.unmount()
  })

  it('提交 ⇒ emit send-to-agent({ prompt, opinion })，且提示词有改动时同时 emit patch', async () => {
    const w = mount(MobileNodeEditorSheet, { props: { node: baseNode } })
    await w.get('[data-testid="mobile-editor-prompt"]').setValue('一只戴帽子的猫')
    await w.get('[data-testid="mobile-editor-opinion"]').setValue('加一顶帽子')
    await w.get('[data-testid="mobile-editor-send"]').trigger('click')
    expect(w.emitted('send-to-agent')?.[0]).toEqual([
      { prompt: '一只戴帽子的猫', opinion: '加一顶帽子' },
    ])
    expect(w.emitted('patch')?.[0]).toEqual([{ prompt: '一只戴帽子的猫' }])
    w.unmount()
  })

  it('空节点（无提示词无意见）⇒ 提交钮禁用（不空转）', () => {
    const w = mount(MobileNodeEditorSheet, {
      props: { node: { id: 'n2', type: 'image', position: { x: 0, y: 0 }, data: {} } as any },
    })
    expect(w.get('[data-testid="mobile-editor-send"]').attributes('disabled')).toBeDefined()
    w.unmount()
  })
})
