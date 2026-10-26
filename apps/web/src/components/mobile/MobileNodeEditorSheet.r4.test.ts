import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import MobileNodeEditorSheet from './MobileNodeEditorSheet.vue'

const HERE = dirname(fileURLToPath(import.meta.url))
const CP = readFileSync(join(HERE, '..', '..', 'pages', 'CanvasPage.vue'), 'utf8')
const SHELL = readFileSync(join(HERE, 'MobileCanvasShell.vue'), 'utf8')

/**
 * R4-T2 的**闭环与再定义**（2026-10-25 D8/J1/K1）。
 *
 * ⭐ 历史断链（R4-T2 的教训）：`DockStudioRouter` 声明 6 个 emit，而当时的
 *   `MobileNodeEditorSheet` 只接了 patch / close ⇒ 其余四个被丢弃 ⇒
 *   移动端改完提示词点提交**毫无反应**。
 * ⭐ 这次的修法**不是**「再接一个 emit」，而是**换掉整个 dock**：
 *   移动端编辑器只做「改词 + 提意见」，出口是「发给 agent 修改」
 *   （`send-to-agent`）⇒ 不存在「被丢弃的 emit」这类断链面。
 */
describe('R4-T2 收口：轻量编辑器的「发给 agent 修改」通道', () => {
  const node = {
    id: 'n1',
    type: 'image',
    position: { x: 0, y: 0 },
    data: { url: 'https://x/a.png', prompt: '一只猫' },
  } as any

  function mountSheet() {
    return mount(MobileNodeEditorSheet, { props: { node } })
  }

  it('⛔ 不再声明 generate / removeRef（PC dock 专用契约已移除）', () => {
    const w = mountSheet()
    expect(w.emitted('generate')).toBeUndefined()
    expect(w.emitted('removeRef')).toBeUndefined()
    w.unmount()
  })

  it('提交 ⇒ emit send-to-agent({ prompt, opinion })', async () => {
    const w = mountSheet()
    await w.get('[data-testid="mobile-editor-opinion"]').setValue('加一顶帽子')
    await w.get('[data-testid="mobile-editor-send"]').trigger('click')
    expect(w.emitted('send-to-agent')?.[0]).toEqual([{ prompt: '一只猫', opinion: '加一顶帽子' }])
    w.unmount()
  })

  it('提示词改动 ⇒ 同时 emit patch（页面层据此落库）', async () => {
    const w = mountSheet()
    await w.get('[data-testid="mobile-editor-prompt"]').setValue('两只猫')
    await w.get('[data-testid="mobile-editor-send"]').trigger('click')
    expect(w.emitted('patch')?.[0]).toEqual([{ prompt: '两只猫' }])
    w.unmount()
  })

  it('壳层把 send-to-agent 接到页面回调（⛔ 不再有 generate / remove-ref 接线）', () => {
    expect(SHELL).toContain('@send-to-agent="props.onNodeEditorSendToAgent"')
    expect(SHELL).not.toContain('@generate="props.onNodeEditorGenerate"')
    expect(SHELL).not.toContain('@remove-ref="props.onNodeEditorRemoveRef"')
  })

  it('页面提供「发给 agent 修改」通道：写回提示词 + 切回对话页 + 意见进 composer', () => {
    expect(CP).toContain('function handleMobileNodeSendToAgent')
    const body = /function handleMobileNodeSendToAgent\([\s\S]*?\n\}/.exec(CP)?.[0] ?? ''
    // ① 落库改后的提示词 ② 意见进 composer 输入框 ③ 切回对话页签
    expect(body).toContain('patchNodeData')
    expect(body).toContain('setComposerInput')
    expect(body).toContain("mobileAppTab.value = 'chat'")
  })

  it('PC 的 handleNodeGenerate 未被改动（PC 零 diff）', () => {
    const pcBody = /async function handleNodeGenerate\(\)[\s\S]*?\n\}/.exec(CP)?.[0] ?? ''
    expect(pcBody).toContain('debouncedNodePatch.flush()')
  })
})
