// 模型配置页共用面板（2026-11-20）：移动 Sheet 与 PC 锚定卡共用同一模板/样式单源。
// WorkBuddy 风格两行 disclosure 列表 + 思考档位二级页 + 上下文只读详情页。
// 视图状态由宿主（useModelConfigView）持有，面板按 view prop 渲染、update:view 上抛。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ModelConfigPanel from './ModelConfigPanel.vue'

type PanelProps = InstanceType<typeof ModelConfigPanel>['$props']

function mountPanel(props: Partial<PanelProps> = {}) {
  return mount(ModelConfigPanel, {
    props: {
      view: 'config',
      thinkingSupported: true,
      thinkingLevel: '标准',
      readOnly: false,
      contextLabel: '200K tokens',
      ...props,
    },
  })
}

describe('ModelConfigPanel', () => {
  it('config 视图：两行 disclosure（思考强度/上下文窗口）+ 右箭头 + 当前值', () => {
    const w = mountPanel()
    expect(w.find('[data-testid="model-thinking-row"]').exists()).toBe(true)
    expect(w.find('[data-testid="model-context-row"]').exists()).toBe(true)
    expect(w.findAll('.model-config-chevron').length).toBe(2)
    expect(w.text()).toContain('思考强度')
    expect(w.text()).toContain('上下文窗口')
    expect(w.text()).toContain('标准')
    expect(w.text()).toContain('200K tokens')
  })

  it('config 视图点思考强度行 → update:view=thinking；点上下文行 → update:view=context', async () => {
    const w = mountPanel()
    await w.get('[data-testid="model-thinking-row"]').trigger('click')
    expect(w.emitted('update:view')?.[0]).toEqual(['thinking'])
    await w.get('[data-testid="model-context-row"]').trigger('click')
    expect(w.emitted('update:view')?.[1]).toEqual(['context'])
  })

  it('思考强度不支持 → 行内显示「不支持」但仍可进详情页（详情页给空态文案）', async () => {
    const w = mountPanel({ thinkingSupported: false })
    const row = w.get('[data-testid="model-thinking-row"]')
    expect(row.text()).toContain('不支持')
    await row.trigger('click')
    expect(w.emitted('update:view')?.[0]).toEqual(['thinking'])
  })

  it('thinking 视图：三档列表 + 选中态 checkmark + aria-pressed，点击派发 setThinking', async () => {
    const w = mountPanel({ view: 'thinking' })
    const opts = w.findAll('[data-testid="thinking-level-option"]')
    expect(opts.length).toBe(3)
    const selected = opts.find((o) => o.attributes('aria-pressed') === 'true')!
    expect(selected.text()).toContain('标准')
    await opts.find((o) => o.text().includes('深入'))!.trigger('click')
    expect(w.emitted('setThinking')?.[0]).toEqual(['深入'])
  })

  it('thinking 视图 + 模型不支持 → 空态文案，无档位按钮', () => {
    const w = mountPanel({ view: 'thinking', thinkingSupported: false })
    expect(w.text()).toContain('当前模型不支持思考强度')
    expect(w.findAll('[data-testid="thinking-level-option"]').length).toBe(0)
  })

  it('readOnly → 档位按钮 disabled', () => {
    const w = mountPanel({ view: 'thinking', readOnly: true })
    for (const o of w.findAll('[data-testid="thinking-level-option"]')) {
      expect(o.attributes('disabled')).toBeDefined()
    }
  })

  it('context 视图：只读详情（无 input/select）+ 「暂不可配置」说明', () => {
    const w = mountPanel({ view: 'context' })
    expect(w.text()).toContain('当前窗口')
    expect(w.text()).toContain('200K tokens')
    expect(w.text()).toContain('暂不可配置')
    expect(w.find('input').exists()).toBe(false)
    expect(w.find('select').exists()).toBe(false)
  })

  it('双主题令牌合规：accent 三件套选中态，禁用翻转令牌', () => {
    // 样式在组件 scoped 内，源文本断言
    const src = readSrc()
    expect(src).toContain('--lnk-accent-subtle')
    expect(src).toContain('--lnk-accent-text')
    expect(src).not.toContain('--neo-hi-bg')
    expect(src).not.toContain('--neo-hi-text')
    expect(src).not.toContain('--lnk-hi-bg')
    expect(src).not.toContain('--lnk-hi-text')
  })
})

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
function readSrc(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return readFileSync(join(here, 'ModelConfigPanel.vue'), 'utf8')
}
