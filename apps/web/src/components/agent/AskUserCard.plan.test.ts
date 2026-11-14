import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AskUserCard from './AskUserCard.vue'

/**
 * A-3（spec docs/superpowers/specs/2026-11-15-a3-propose-plan-assumptions-design.md）：
 * 确认卡「假设/范围」区块渲染——断言落 DOM 出口（label/列表/行文本），不碰源码字符串。
 * 键不出现纪律的 DOM 面：未传 assumptions/scope ⇒ 区块不渲染（旧卡形态不变）。
 */

type PlanShape = {
  summary: string
  explanation?: string
  steps: { content: string; activeForm?: string }[]
  assumptions?: string[]
  scope?: { inScope: string[]; outOfScope: string[] }
}

function mountCard(plan: PlanShape) {
  return mount(AskUserCard, {
    props: {
      questions: [
        {
          id: 'plan_confirm',
          question: '三步配图',
          options: [
            { label: '开始执行', value: 'execute' },
            { label: '调整计划', value: 'refine' },
            { label: '仅保留方案', value: 'keep' },
          ],
          allowOther: true,
          plan,
        },
      ],
    },
  })
}

describe('AskUserCard — A-3 假设/范围区块渲染', () => {
  it('传 assumptions ⇒ 渲染「假设」区 + 逐条列表', () => {
    const w = mountCard({
      summary: '三步配图',
      steps: [{ content: '建节点' }],
      assumptions: ['目标画布为空', '素材已上传'],
    })
    const block = w.find('.ask-plan-meta .ask-plan-assumptions')
    expect(block.exists()).toBe(true)
    expect(w.find('.ask-plan-meta-label').text()).toBe('假设')
    const items = block.findAll('li')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toBe('目标画布为空')
    expect(items[1].text()).toBe('素材已上传')
  })

  it('传 scope ⇒ 渲染「覆盖/排除」两行', () => {
    const w = mountCard({
      summary: 's',
      steps: [{ content: 'a' }],
      scope: { inScope: ['生成 1 张配图'], outOfScope: ['排版与文案'] },
    })
    const rows = w.findAll('.ask-plan-scope-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('覆盖')
    expect(rows[0].text()).toContain('生成 1 张配图')
    expect(rows[1].text()).toContain('排除')
    expect(rows[1].text()).toContain('排版与文案')
  })

  it('不传 assumptions/scope ⇒ 两区块均不渲染（键不出现纪律）', () => {
    const w = mountCard({ summary: 's', steps: [{ content: 'a' }] })
    expect(w.find('.ask-plan-assumptions').exists()).toBe(false)
    expect(w.find('.ask-plan-scope').exists()).toBe(false)
    expect(w.findAll('.ask-plan-meta')).toHaveLength(0)
  })
})
