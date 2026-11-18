// 内置技能可发现（B4）：MentionInput `/` 触发器——复用 `@` 的列框/键盘导航，按触发字符分支。
// 判据：`/` 唤出候选（同一 dockSkills 数据源由宿主传入）、Enter 选中 emit slash-select、
//       `@` mention 行为不受影响、未传 slashOptions 时 `/` 不触发（零回归）。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mount } from '@vue/test-utils'
import MentionInput, { type SlashOption } from './MentionInput.vue'

const slashes: SlashOption[] = [
  { id: 'product-visual', label: '实物产品视觉出图', desc: '电商商品图' },
  { id: 'drama-script-writing', label: 'drama-script-writing', desc: '剧本创作' },
  { id: 'html-craft', label: 'html-craft', desc: 'HTML 规范' },
]

const mention = { id: 'node-1', label: '节点A', type: 'text' }

function mountInput(extra: Record<string, unknown> = {}) {
  return mount(MentionInput, {
    props: {
      modelValue: '',
      mentions: [mention],
      ...extra,
    },
    attachTo: document.body,
  })
}

async function typeInput(wrapper: ReturnType<typeof mountInput>, value: string) {
  const el = wrapper.find('textarea')
  ;(el.element as HTMLTextAreaElement).value = value
  ;(el.element as HTMLTextAreaElement).setSelectionRange(value.length, value.length)
  await el.trigger('input')
}

describe('MentionInput `/` 技能候选（B4）', () => {
  it('键入 `/` 唤出候选列表（数据源=宿主传入 slashOptions）', async () => {
    const w = mountInput({ slashOptions: slashes })
    await typeInput(w, '/')
    expect(w.find('[role="listbox"]').exists()).toBe(true)
    const items = w.findAll('[role="option"]')
    expect(items).toHaveLength(3)
    expect(items[0].text()).toContain('实物产品视觉出图')
    w.unmount()
  })

  it('前缀过滤：`/drama` 只剩命中项', async () => {
    const w = mountInput({ slashOptions: slashes })
    await typeInput(w, '/drama')
    const items = w.findAll('[role="option"]')
    expect(items).toHaveLength(1)
    expect(items[0].text()).toContain('drama-script-writing')
    w.unmount()
  })

  it('Enter 选中 → emit slash-select 且 `/xxx` 从草稿移除（不伪造文本命令）', async () => {
    const w = mountInput({ slashOptions: slashes })
    await typeInput(w, '/html')
    await w.find('textarea').trigger('keydown', { key: 'Enter' })
    const emitted = w.emitted('slash-select')
    expect(emitted).toHaveLength(1)
    expect((emitted![0][0] as SlashOption).id).toBe('html-craft')
    expect(w.emitted('update:modelValue')!.at(-1)![0]).toBe('')
    w.unmount()
  })

  it('URL 路径不触发：`https://x/a` 的 `/a` 不唤出（行首/空白前缀约束）', async () => {
    const w = mountInput({ slashOptions: slashes })
    await typeInput(w, 'https://x/a')
    expect(w.find('[role="listbox"]').exists()).toBe(false)
    w.unmount()
  })

  it('句中空白后的 `/` 触发（`请用 /html`）', async () => {
    const w = mountInput({ slashOptions: slashes })
    await typeInput(w, '请用 /html')
    expect(w.find('[role="listbox"]').exists()).toBe(true)
    w.unmount()
  })

  it('未传 slashOptions → `/` 不触发（零回归），`@` mention 不受影响', async () => {
    const w = mountInput()
    await typeInput(w, '/html')
    expect(w.find('[role="listbox"]').exists()).toBe(false)
    await typeInput(w, '@')
    expect(w.find('[role="listbox"]').exists()).toBe(true)
    expect(w.findAll('[role="option"]')).toHaveLength(1)
    expect(w.findAll('[role="option"]')[0].text()).toContain('节点A')
    w.unmount()
  })

  it('`@` 与 `/` 并存：`@` 优先（mention 语义不被 slash 抢占）', async () => {
    const w = mountInput({ slashOptions: slashes })
    await typeInput(w, '@节点')
    expect(w.find('[role="listbox"]').exists()).toBe(true)
    expect(w.findAll('[role="option"]')[0].text()).toContain('@')
    w.unmount()
  })

  it('B4：slash 候选与 `+` 出口同源——宿主接口按 id 回写（slash-select 载荷即 dockSkills 项 id）', async () => {
    const w = mountInput({ slashOptions: slashes })
    await typeInput(w, '/实物')
    await w.find('textarea').trigger('keydown', { key: 'Enter' })
    expect((w.emitted('slash-select')![0][0] as SlashOption).id).toBe('product-visual')
    w.unmount()
  })

  // ── F4（2026-11-17 P3 真机修复）：`/` 候选数对齐 `+` ──
  it('F4/N5：超过 8 个 slash 候选全部展示（生产 11 个内置技能不再被 slice(0,8) 砍掉）', async () => {
    const eleven: SlashOption[] = Array.from({ length: 11 }, (_, i) => ({
      id: `skill-${i + 1}`,
      label: `技能${i + 1}`,
      desc: '内置',
    }))
    const w = mountInput({ slashOptions: eleven })
    await typeInput(w, '/')
    expect(w.findAll('[role="option"]')).toHaveLength(11)
    // 末位（第 11 个）仍可见——旧 slice(0,8) 在此回红
    expect(w.findAll('[role="option"]')[10].text()).toContain('技能11')
    w.unmount()
  })

  it('F4：mention 的 slice(0,8) 保留（@引用节点不同语义，不受本刀影响）', async () => {
    const manyMentions = Array.from({ length: 11 }, (_, i) => ({ id: `n${i}`, label: `节点${i}`, type: 'text' }))
    const w = mountInput({ mentions: manyMentions })
    await typeInput(w, '@')
    expect(w.findAll('[role="option"]')).toHaveLength(8)
    w.unmount()
  })

  // ── UI 美化 §4.1（U1）：标签化 + 淡底选中 + 44px ──
  it('U1：`/` 卡片显示中文名、slug 降副标题，顶部有「技能 · N」', async () => {
    const options: SlashOption[] = [
      { id: 'drama-audio-design', label: '短剧/漫剧配音与声音设计', desc: '当用户要求配音…', meta: 'drama-audio-design' },
    ]
    const w = mountInput({ slashOptions: options })
    await typeInput(w, '/')
    expect(w.find('[data-testid="slash-list-head"]').text()).toBe('技能 · 1')
    const item = w.findAll('[role="option"]')[0]!
    expect(item.text()).toContain('短剧/漫剧配音与声音设计')
    expect(item.text()).toContain('drama-audio-design')
    expect(w.find('[role="listbox"]').classes()).toContain('slash-popover')
    w.unmount()
  })

  it('U1：选中态走主题稳定的强调淡底（非黑底/非翻转令牌）；项高 ≥44 由令牌给出（静态判据）', () => {
    const sfc = readFileSync(join(__dirname, 'MentionInput.vue'), 'utf8')
    // ⛔ 禁 --lnk-hi-bg/hi-text：随主题翻转，深主题 = 黑底白字（CDP 实测暴露，§9 #9）
    expect(sfc).toContain('.mention-option.is-active {\n  /* 主题稳定的强调淡底')
    expect(sfc).toContain('background: var(--lnk-accent-subtle);')
    expect(sfc).toContain('color: var(--lnk-accent-text);')
    expect(sfc).not.toContain('#1a1a21')
    // 规则块内 background 必须是 accent-subtle，不能是翻转令牌（注释里提到 hi-bg 不算）
    expect(sfc).toMatch(/\.mention-option\.is-active \{[\s\S]*?background: var\(--lnk-accent-subtle\);[\s\S]*?\}/)
    expect(sfc).toMatch(/\.slash-option \{\n  min-height: var\(--lnk-touch-target\);\n\}/)
    expect(sfc).toContain('slash-popover max-h-[48vh]')
  })
})
