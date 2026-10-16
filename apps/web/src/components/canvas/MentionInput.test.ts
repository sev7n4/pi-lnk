import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import MentionInput from './MentionInput.vue'

describe('MentionInput', () => {
  it('prevents Escape from closing the parent dock when dismissing mentions', async () => {
    const wrapper = mount(MentionInput, {
      props: {
        modelValue: '@',
        mentions: [{ id: 'ref-1', label: '参考图' }],
      },
    })
    const textarea = wrapper.get('textarea')
    await textarea.trigger('input')

    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    textarea.element.dispatchEvent(event)
    await wrapper.vm.$nextTick()

    expect(event.defaultPrevented).toBe(true)
    expect(wrapper.find('ul').exists()).toBe(false)
  })
})

function pressEnter(wrapper: ReturnType<typeof mount>) {
  const ta = wrapper.get('textarea')
  const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  ta.element.dispatchEvent(ev)
  return ev
}

describe('MentionInput keyboard contract (P0-1.1)', () => {
  it('desktop: Enter submits when submitOnEnter', async () => {
    const w = mount(MentionInput, { props: { modelValue: 'a', mentions: [], submitOnEnter: true } })
    const ev = pressEnter(w)
    await w.vm.$nextTick()
    expect(w.emitted('submit')).toHaveLength(1)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('mobile: Enter inserts newline, never submits (mobileEnterNewline)', async () => {
    const w = mount(MentionInput, { props: { modelValue: 'a', mentions: [], submitOnEnter: true, mobileEnterNewline: true } })
    const ev = pressEnter(w)
    await w.vm.$nextTick()
    expect(w.emitted('submit')).toBeUndefined()
    expect(ev.defaultPrevented).toBe(false) // 不阻止默认 → textarea 正常换行
  })
})

describe('MentionInput ghost prediction (P2-1.1)', () => {
  const HISTORY = ['帮我生成三张变体', '画一张水彩风格的猫']

  function mountWith(draft: string, history: string[] = HISTORY) {
    return mount(MentionInput, {
      props: {
        modelValue: draft,
        mentions: [],
        submitOnEnter: true,
        predictionHistory: history,
      },
    })
  }

  it('renders aria-hidden ghost layer for a matching draft prefix', async () => {
    const w = mountWith('帮我')
    await w.vm.$nextTick()
    const ghost = w.find('.mention-input-ghost')
    expect(ghost.exists()).toBe(true)
    expect(ghost.attributes('aria-hidden')).toBe('true')
    expect(ghost.text()).toContain('生成三张变体')
  })

  it('no prediction context → layer hidden', () => {
    const w = mountWith('帮我', [])
    expect(w.find('.mention-input-ghost').exists()).toBe(false)
  })

  it('Tab accepts ghost onto draft (non-menu branch)', async () => {
    const w = mountWith('帮我')
    const ta = w.get('textarea')
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    ta.element.dispatchEvent(ev)
    await w.vm.$nextTick()
    expect(ev.defaultPrevented).toBe(true)
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual(['帮我生成三张变体'])
    // 模拟父级 v-model 回写后，已接管的 draft 不再产生 ghost（历史条目 == draft → null）
    await w.setProps({ modelValue: '帮我生成三张变体' })
    expect(w.find('.mention-input-ghost').exists()).toBe(false)
  })

  it('Escape dismisses ghost without inserting', async () => {
    const w = mountWith('帮我')
    const ta = w.get('textarea')
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    ta.element.dispatchEvent(ev)
    await w.vm.$nextTick()
    expect(ev.defaultPrevented).toBe(true)
    expect(w.find('.mention-input-ghost').exists()).toBe(false)
    expect(w.emitted('update:modelValue')).toBeUndefined()
  })

  it('Tab without prediction is left to the browser', () => {
    const w = mountWith('不存在的前缀', HISTORY)
    const ta = w.get('textarea')
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    ta.element.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
    expect(w.emitted('update:modelValue')).toBeUndefined()
  })
})

describe('MentionInput ghost layer CSS contract (P2-1.1 review fix)', () => {
  // vitest ESM 下 import.meta.url 非 file:// scheme，沿用 bareBar 测试的 dirname 模式
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, 'MentionInput.vue'), 'utf8')
  const railSource = readFileSync(join(here, '../agent/AgentSideRail.vue'), 'utf8')

  it('scoped padding override groups ghost with backdrop/field (续写对齐契约)', () => {
    expect(source).toMatch(
      /\.mention-input-backdrop,\s*\n\.mention-input-field,\s*\n\.mention-input-ghost\s*\{[^}]*padding:/,
    )
  })

  it('ghost layer background is transparent (不染色/不遮挡 mention 高亮层)', () => {
    // 选择器组尾行与独立规则都以 `.mention-input-ghost {` 开头；
    // 含 background: transparent 的块只可能是独立 ghost 规则
    const rule = source.match(/\.mention-input-ghost\s*\{[^}]*background: transparent[^}]*\}/)
    expect(rule?.[0]).toContain('color: var(--lnk-text-muted)')
  })

  it('mobile bare-bar :deep() override includes ghost (不撑破 34px 行)', () => {
    expect(railSource).toMatch(
      /:deep\(\.mention-input-field\),\s*\n[^{]*:deep\(\.mention-input-ghost\)\s*\{[^}]*min-height: 34px/,
    )
  })
})

describe('MentionInput listbox semantics (P2-4.1)', () => {
  it('mention candidates use listbox semantics (P2-4.1)', async () => {
    const w = mount(MentionInput, { props: { modelValue: '@', mentions: [{ id: 'ref-1', label: '参考图' }] } })
    await w.get('textarea').trigger('input')
    await w.vm.$nextTick()
    const list = w.find('ul')
    expect(list.exists()).toBe(true)
    expect(list.attributes('role')).toBe('listbox')
    expect(w.find('ul li').attributes('role')).toBe('option')
  })

  it('aria-activedescendant follows the highlighted option', async () => {
    const w = mount(MentionInput, {
      props: {
        modelValue: '@',
        mentions: [
          { id: 'ref-1', label: '参考图' },
          { id: 'ref-2', label: '参考图二' },
        ],
      },
    })
    await w.get('textarea').trigger('input')
    await w.vm.$nextTick()
    const list = w.find('ul')
    const firstId = w.findAll('ul li')[0].attributes('id')
    expect(list.attributes('aria-activedescendant')).toBe(firstId)

    await w.get('textarea').trigger('keydown', { key: 'ArrowDown' })
    await w.vm.$nextTick()
    const secondId = w.findAll('ul li')[1].attributes('id')
    expect(list.attributes('aria-activedescendant')).toBe(secondId)
  })
})
