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
    const w = mount(MobileNodeEditorSheet, { props: { node: baseNode }, global: { stubs: { teleport: true } } })
    await w.find('[data-action="close"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('initialOpinion 预填意见框（音频 at mm:ss 链路终点，规格 v1.5 Q）', () => {
    const w = mount(MobileNodeEditorSheet, { props: { node: baseNode, initialOpinion: 'at 0:07' }, global: { stubs: { teleport: true } } })
    expect((w.get('[data-testid="mobile-editor-opinion"]').element as HTMLTextAreaElement).value).toBe('at 0:07')
    w.unmount()
  })

  it('提交 ⇒ emit send-to-agent({ prompt, opinion })，且提示词有改动时同时 emit patch', async () => {
    const w = mount(MobileNodeEditorSheet, { props: { node: baseNode }, global: { stubs: { teleport: true } } })
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
      global: { stubs: { teleport: true } },
    })
    expect(w.get('[data-testid="mobile-editor-send"]').attributes('disabled')).toBeDefined()
    w.unmount()
  })

  it('点参数 chip ⇒ 翻译成意见前缀（J-1 翻译制，不改值不越权）', async () => {
    const w = mount(MobileNodeEditorSheet, {
      props: { node: { id: 'n3', type: 'image', position: { x: 0, y: 0 }, data: { prompt: '一只猫', imageAspect: '16:9' } } as any },
      global: { stubs: { teleport: true } },
    })
    await w.get('[data-testid="mobile-editor-param-chip"]').trigger('click')
    const opinion = w.get('[data-testid="mobile-editor-opinion"]').element as HTMLTextAreaElement
    expect(opinion.value).toBe('把画面比例改为')
    w.unmount()
  })

  it('参数 chip 预填幂等 + 换行追加（不覆盖既有意见 / at mm:ss）', async () => {
    const w = mount(MobileNodeEditorSheet, {
      props: { node: { id: 'n4', type: 'audio', position: { x: 0, y: 0 }, data: { prompt: '一段钢琴', audioModel: 'tts-1' } } as any, initialOpinion: 'at 0:07' },
      global: { stubs: { teleport: true } },
    })
    const chip = w.get('[data-testid="mobile-editor-param-chip"]')
    await chip.trigger('click')
    await chip.trigger('click')
    const opinion = w.get('[data-testid="mobile-editor-opinion"]').element as HTMLTextAreaElement
    expect(opinion.value).toBe('at 0:07\n把模型改为')
    w.unmount()
  })

  it('P0 层序修复：浮层 Teleport 到 body（不被 main.z-10 堆叠上下文困住，2026-11-01 真机回归）', () => {
    // 行为级：不 stub teleport → 内容渲染进 document.body，而非组件树内
    const w = mount(MobileNodeEditorSheet, {
      props: { node: { id: 'n6', type: 'image', position: { x: 0, y: 0 }, data: { prompt: 'x' } } as any },
      attachTo: document.body,
    })
    expect(document.body.querySelector('[data-testid="mobile-editor-cancel"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="mobile-editor-send"]')).toBeTruthy()
    w.unmount()
    expect(document.body.querySelector('[data-testid="mobile-editor-cancel"]')).toBeNull()
  })

  it('裸内部模型 ID 不上屏：humanize 短标签 + 全量原值进 aria-label（v2.1 P1）', () => {
    const w = mount(MobileNodeEditorSheet, {
      props: {
        node: {
          id: 'n7',
          type: 'image',
          position: { x: 0, y: 0 },
          data: { prompt: 'x', imageModel: 'platform::agnes-image-2.1-flash' },
        } as any,
      },
      global: { stubs: { teleport: true } },
    })
    const chip = w.get('[data-testid="mobile-editor-param-chip"]')
    expect(chip.text()).not.toContain('platform::')
    expect(chip.text()).toContain('图像')
    expect(chip.attributes('aria-label')).toBe('platform::agnes-image-2.1-flash')
    w.unmount()
  })

  it('产物上下文行：标题降级为「{类型}节点」+ 共用副标题（图 1 ②）', () => {
    const w = mount(MobileNodeEditorSheet, {
      props: { node: { id: 'n5', type: 'image', position: { x: 0, y: 0 }, data: { prompt: 'x' } } as any },
      global: { stubs: { teleport: true } },
    })
    const ctx = w.get('[data-testid="mobile-editor-context"]')
    expect(ctx.text()).toContain('图片节点')
    expect(ctx.text()).toContain('发送后 agent 将按新词重做并替换当前产物')
    w.unmount()
  })
})
