# Agent Composer UI/UX 整改实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按规格 v0.5.3 落地 lnk π Agent Composer 三态整改（35 子任务），达成「单一干净表面 + 无背景控件 + 两层契约」的极简形态，并通过全部机检门禁与人工走查。

**Architecture:** 全部改动集中在 `apps/web`。策略：① 模板/样式改动落在 `AgentSideRail.vue` / `MentionInput.vue` / `DockMicButton.vue` / `DockGenerateButton.vue` / `neowow-tokens.css`；② 可测逻辑一律抽成 `apps/web/src/components/agent/composer/` 下的纯函数模块（沿用本仓 colocated `.test.ts` 模式）；③ 结构性断言用「读源码文本的 fs-scan 测试」（与 `design-token.test.ts` / `theme-usage.test.ts` 同型）——因为 4500 行 SFC 挂载成本高且生产构建不可断言内部符号。

**Tech Stack:** Vue 3 SFC + vitest（`@vue/test-utils` 已在用）+ CSS 自定义属性令牌（墨流 Ink Flow）。

**Spec:** [`docs/design/Agent Composer UI-UX 整改规格.md`](../../design/Agent%20Composer%20UI-UX%20整改规格.md)（v0.5.3 正式版）
**视觉验收基准:** [`docs/design/Agent Composer 三态线稿与视觉规范.html`](../../design/Agent%20Composer%20%E4%B8%89%E6%80%81%E7%BA%BF%E7%A8%BF%E4%B8%8E%E8%A7%86%E8%A7%89%E8%A7%84%E8%8C%83.html)（下称「线稿」；每任务的视觉对照节写明对应小节）
**图例:** [`docs/design/Agent Composer 三态组件图例.html`](../../design/Agent%20Composer%20%E4%B8%89%E6%80%81%E7%BB%84%E4%BB%B6%E5%9B%BE%E4%BE%8B.html)

**冲突裁决顺序：规格文字判据 > 线稿 > 个人审美。**

## Global Constraints（每个任务默认携带）

- **令牌**：composer 新增/修改样式只允许 `--lnk-*` L2/L3；禁止新增 hex / `rgba(` 文字色 / `text-white` / `bg-[#]`（P1-6.1）。`--neo-*` 计数只降不升（P1-6.2）。
- **对比度**：引导/状态文字 ≥ 4.5:1；`--neo-text-muted` 浅色 `var(--lnk-ink-600)`(#5a6478) / 深色 `var(--lnk-ink-400)`(#9aa3b2)（P0-2.1）。
- **命中区**：移动端（≤767px）主控件 ≥44px（视觉尺寸不变，透明 padding/伪元素撑）；PC ≥32px（P0-4）。
- **键盘契约**：桌面 Enter 发送 / Shift+Enter 换行；移动端回车换行、仅按钮发送；两处占位符不得出现 `Enter / Cmd / Ctrl / 回车` 字样（P0-1）。
- **两层契约**（规格 §2 原则 7 / §5.5）：composer = 单一干净表面（PC 整卡 / 移动单条），文本直接落表面、**无内嵌输入框描边**，focus = 表面边框→`--lnk-border-focus` + 2px ring；表面内 = 草稿（ref 芯片在文本上方）+ 无背景 ghost 控件；表面上 = 仅系统层（状态行/插话选项/PC 首屏样例 chips）。ghost 控件**任何状态不加底色**；唯一填充 = 生成态停止红块（`--lnk-red-600`）。
- **◎ 画布节点引用**：圆心与表面左顶点重合（`translate(-50%,-50%)`）；输入/生成态可见、空态隐藏；键入 `@` 全态可达；C 抽屉不含画布选节点（P1-2.3）。
- **停止键**与空闲态发送键同坐标同层级（P1-3.2）；状态行 ≤24px（P1-3.1）。
- **保护项**（规格 §6）不得削弱：流式插话队列 / 引用芯片（AgentRefStrip 可拖排可移除）/ 双主题 / 停止块。
- **测试纪律**：本机**不跑全量 web 测试**（CI 跑）；只跑指定 vitest 文件；单文件超时 ≠ 失败。改令牌/组件样式后必跑 `apps/web/src/styles/design-token.test.ts` + `theme-usage.test.ts`。
- **git 纪律**：命令用绝对路径或 `git -C /Users/4seven/workspace/pi-lnk`；**禁止 `git add -A`**；每任务一个 commit；合并走 squash + 生产复测（`docs/agent/delivery.md`）。
- **fs-scan 断言纪律**：否定断言（"X 不存在"）必须配有效性断言（"Y 存在"），防止空集假绿；扫描 `.vue`/`.css` 用正则文本匹配即可（本计划不涉及注释内历史记录扫描）。

## Review Focus（规格未言明、但最易咬人的 5 类输入）

1. **移动端 IME 组合输入中的回车**（拼音选字确认）不得触发表单提交——期望：组合期间 Enter 一律不 submit。→ Task 1 测试钉死。
2. **◎ 空态隐藏后的键盘可达性**：空态下键入 `@` 必须仍打开选择器（图标不可见不能导致功能不可达）。→ Task 6 断言 + 走查。
3. **深浅主题成对性**：新增的任何 L2 令牌消费在两主题下对比度/阴影都要成立。→ Task 2 / Task 11 强制跑 `design-token.test.ts`。
4. **生成中 ↔ 空闲切换时发送/停止槽位不跳动**：同槽位替换，切换前后按钮盒尺寸/坐标一致。→ Task 8 测试。
5. **移动条堆叠态（芯片行+输入行）在软键盘 + 安全区内不溢出、不横向滚动**。→ Task 10 布局函数测试 + 走查。

---

### Task 1: 键盘契约与占位符（P0-1.1 / P0-1.2）

**Files:**
- Modify: `apps/web/src/components/canvas/MentionInput.vue:143-156`（keydown 处理）、props 定义区
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（给 MentionInput 传移动端标记；streaming 占位符 `:3385`）
- Modify: `apps/web/src/constants/agentSkillMap.ts:31-37`
- Test: `apps/web/src/components/canvas/MentionInput.test.ts`（扩展）、Create: `apps/web/src/constants/agentSkillMap.keyboard.test.ts`

**Interfaces:**
- Produces: `MentionInput` 新 prop `mobileEnterNewline?: boolean`（默认 false，保持桌面行为不变）；`AGENT_INPUT_PLACEHOLDER_AUTO` / `agentInputPlaceholder()` 新文案。
- Consumes: AgentSideRail 已有的移动端布局布尔 **`isMobileLayout`**（`useAgentMobileLayout` 派生，`:174` `panelTeleported = floating || isMobileLayout` 已核实）。

- [ ] **Step 1: 写失败测试**（追加到 `MentionInput.test.ts`）

```ts
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MentionInput from './MentionInput.vue'

function pressEnter(wrapper: ReturnType<typeof mount>) {
  const ta = wrapper.get('textarea')
  const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  ta.element.dispatchEvent(ev)
  return ev
}

describe('MentionInput keyboard contract (P0-1.1)', () => {
  it('desktop: Enter submits when submitOnEnter', async () => {
    const w = mount(MentionInput, { props: { modelValue: 'a', submitOnEnter: true } })
    const ev = pressEnter(w)
    await w.vm.$nextTick()
    expect(w.emitted('submit')).toHaveLength(1)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('mobile: Enter inserts newline, never submits (mobileEnterNewline)', async () => {
    const w = mount(MentionInput, { props: { modelValue: 'a', submitOnEnter: true, mobileEnterNewline: true } })
    const ev = pressEnter(w)
    await w.vm.$nextTick()
    expect(w.emitted('submit')).toBeUndefined()
    expect(ev.defaultPrevented).toBe(false) // 不阻止默认 → textarea 正常换行
  })
})
```

新建 `apps/web/src/constants/agentSkillMap.keyboard.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { AGENT_INPUT_PLACEHOLDER_AUTO, agentInputPlaceholder, AGENT_SKILLS } from './agentSkillMap'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FORBIDDEN = /Cmd\/Ctrl|Ctrl \+|Cmd \+|回车|Enter/i

describe('composer placeholder keyboard copy ban (P0-1.2)', () => {
  it('auto placeholder describes capability, not keyboard', () => {
    expect(FORBIDDEN.test(AGENT_INPUT_PLACEHOLDER_AUTO)).toBe(false)
    expect(AGENT_INPUT_PLACEHOLDER_AUTO).toContain('@')
  })
  it('skill placeholder describes capability, not keyboard', () => {
    for (const s of AGENT_SKILLS) expect(FORBIDDEN.test(agentInputPlaceholder(s))).toBe(false)
  })
  it('streaming placeholder in AgentSideRail has no keyboard words', () => {
    const sfc = readFileSync(join(__dirname, '../agent/AgentSideRail.vue'), 'utf8')
    expect(sfc).not.toContain('回车加入待发队列')
    expect(sfc).toContain('加入待发队列')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/web exec vitest run src/components/canvas/MentionInput.test.ts src/constants/agentSkillMap.keyboard.test.ts`
Expected: FAIL（`submit` 被emit / FORBIDDEN 命中 `Cmd/Ctrl`）

- [ ] **Step 3: 实现**

`MentionInput.vue` props 区加 `mobileEnterNewline?: boolean`；`:146` 改为：

```ts
if (props.submitOnEnter && !props.mobileEnterNewline) {
  if (e.shiftKey) return
  e.preventDefault()
  emit('submit')
  return
}
```

`agentSkillMap.ts`：

```ts
export const AGENT_INPUT_PLACEHOLDER_AUTO = '描述你的想法，或 @ 引用画布节点…'
export function agentInputPlaceholder(skill: AgentSkillDef | undefined): string {
  if (!skill) return AGENT_INPUT_PLACEHOLDER_AUTO
  return `已选技能「${skill.label}」— 描述编排需求，@ 引用画布节点…`
}
```

`AgentSideRail.vue`：streaming 占位符（`:3385` 附近）改为 `输入消息…加入待发队列`；MentionInput 调用处加 `:mobile-enter-newline="isAgentMobile"`（符号名按 Step 0 侦察结果）。

- [ ] **Step 4: 跑测试确认通过**（同 Step 2 命令，Expected: PASS）

- [ ] **Step 5: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk add apps/web/src/components/canvas/MentionInput.vue apps/web/src/components/canvas/MentionInput.test.ts apps/web/src/constants/agentSkillMap.ts apps/web/src/constants/agentSkillMap.keyboard.test.ts apps/web/src/components/agent/AgentSideRail.vue
git -C /Users/4seven/workspace/pi-lnk commit -m "fix(agent-composer): unify keyboard contract and ban keyboard words in placeholders (P0-1)"
```

---

### Task 2: 文字对比度 / 字号令牌化 / rgba 文字色守卫（P0-2.1 / P0-2.2 / P0-2.3）

**Files:**
- Modify: `apps/web/src/styles/neowow-tokens.css:67`（浅色块）、`:225`（深色块）
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（composer 区段 10/11/12/13px 字面量 → 字阶令牌）
- Test: Create: `apps/web/src/styles/text-token-guard.test.ts`

**Interfaces:**
- Produces: `--neo-text-muted` 从 rgba 定义改为实色引用；`src/styles/text-token-guard.test.ts` 守卫（CI 既有 vitest job 自动执行，**不新建 job**）。

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/styles/text-token-guard.test.ts
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const STYLES = join(__dirname)

describe('text color token guard (P0-2.3)', () => {
  it('no text/ink/fg token is defined with rgba alpha in styles/*.css', () => {
    const offenders: string[] = []
    for (const f of readdirSync(STYLES).filter((f) => f.endsWith('.css'))) {
      const css = readFileSync(join(STYLES, f), 'utf8')
      for (const m of css.matchAll(/--[a-z0-9-]*(?:text|ink|fg)[a-z0-9-]*\s*:\s*rgba\(/gi)) {
        offenders.push(`${f}: ${m[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('--neo-text-muted is solid and theme-paired (P0-2.1)', () => {
    const css = readFileSync(join(STYLES, 'neowow-tokens.css'), 'utf8')
    expect(css).toContain('--neo-text-muted: var(--lnk-ink-600)')
    expect(css).toContain('--neo-text-muted: var(--lnk-ink-400)')
    expect(css).not.toMatch(/--neo-text-muted:\s*rgba\(/)
  })
})

describe('composer arbitrary font sizes collapsed (P0-2.2 / B15)', () => {
  it('AgentSideRail has no 10/11/12/13px literal font-size', () => {
    const sfc = readFileSync(join(__dirname, '../components/agent/AgentSideRail.vue'), 'utf8')
    const hits = [...sfc.matchAll(/font-size:\s*(10|11|12|13)px/g)].map((m) => m[0])
    expect(hits).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/web exec vitest run src/styles/text-token-guard.test.ts`
Expected: FAIL（rgba 命中 `--neo-text-muted`；字面量字号有命中）

- [ ] **Step 3: 实现**

1. `neowow-tokens.css` 浅色块 `:67`：`--neo-text-muted: var(--lnk-ink-600);`；深色块 `:225`：`--neo-text-muted: var(--lnk-ink-400);`（其余 rgba 引用处无需动，继承实色）。
2. `AgentSideRail.vue` composer 区段：`font-size: 10px|11px|12px|13px` → `var(--lnk-text-2xs)`(11) / `var(--lnk-text-xs)`(12) / `var(--lnk-text-sm)`(13)；10px 的引导文字提升用 `var(--lnk-text-2xs)`（11px，P0-2.2 要求 ≥11.5 的引导档以 11px 2xs + muted 实色双达标；若走查仍偏小，升 `var(--lnk-text-xs)`）。逐处替换直到测试绿。
3. 复算对比度（规格 §3 脚本，期望 浅 5.22 / 深 7.28）：

```bash
node -e '
const lin=c=>{c/=255;return c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4)};
const L=([r,g,b])=>0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b);
const R=(a,b)=>{const l1=L(a),l2=L(b),[h,l]=l1>l2?[l1,l2]:[l2,l1];return((h+0.05)/(l+0.05)).toFixed(2)};
console.log("浅 #5a6478 on #eef0f5 =", R([0x5a,0x64,0x78],[0xee,0xf0,0xf5]));  // 5.22
console.log("深 #9aa3b2 on #131318 =", R([0x9a,0xa3,0xb2],[0x13,0x13,0x18]));  // 7.28
'
```

- [ ] **Step 4: 跑守卫 + 令牌测试**

Run: `pnpm -C apps/web exec vitest run src/styles/text-token-guard.test.ts src/styles/design-token.test.ts src/styles/theme-usage.test.ts`
Expected: PASS（theme-usage 若因 `--neo-*` 计数下降需更新基线，按其文件内说明同步基线 json——只允许下降）

- [ ] **Step 5: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk add apps/web/src/styles/neowow-tokens.css apps/web/src/styles/text-token-guard.test.ts apps/web/src/components/agent/AgentSideRail.vue apps/web/src/styles/theme-usage-baseline.json
git -C /Users/4seven/workspace/pi-lnk commit -m "fix(agent-composer): solid muted text tokens, type-scale tokens, rgba text guard (P0-2)"
```

---

### Task 3: 输入 dock 阴影令牌化（P0-3.1 / P0-3.2）

**Files:**
- Modify: `apps/web/src/styles/neowow-tokens.css`（新增 `--neo-glass-shadow` 深/浅成对）
- Modify: `apps/web/src/components/agent/AgentSideRail.vue:4169-4174`（dock 阴影改用令牌；`:focus-within` / `.is-drop-target` 同）
- Test: 追加到 `apps/web/src/styles/text-token-guard.test.ts`

**Interfaces:**
- Produces: `--neo-glass-shadow`（深色保留现强度，浅色轻投影）。

- [ ] **Step 1: 写失败测试**（追加）

```ts
describe('dock shadow tokenized (P0-3.2)', () => {
  it('AgentSideRail has no hardcoded black dock shadows', () => {
    const sfc = readFileSync(join(__dirname, '../components/agent/AgentSideRail.vue'), 'utf8')
    expect(sfc).not.toContain('rgba(0, 0, 0, 0.42)')
    expect(sfc).not.toContain('rgba(0, 0, 0, 0.3)')
    expect(sfc).toContain('var(--neo-glass-shadow)')
  })
  it('--neo-glass-shadow is paired across themes', () => {
    const css = readFileSync(join(STYLES, 'neowow-tokens.css'), 'utf8')
    expect(css.match(/--neo-glass-shadow:/g)?.length).toBeGreaterThanOrEqual(2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**（同 Task 2 命令，Expected: FAIL）

- [ ] **Step 3: 实现**

`neowow-tokens.css` 深色块：

```css
--neo-glass-shadow: 0 8px 24px rgba(0, 0, 0, 0.42), 0 2px 6px rgba(0, 0, 0, 0.3);
```

浅色块（等效规格 P0-3.1 的 color-mix 轻投影）：

```css
--neo-glass-shadow: 0 8px 24px color-mix(in srgb, var(--lnk-ink-900) 12%, transparent);
```

`AgentSideRail.vue:4169-4174` 及 `:focus-within` / `.is-drop-target` 的 box-shadow 改 `var(--neo-glass-shadow)`。

- [ ] **Step 4: 跑测试确认通过**（含令牌测试全家，同 Task 2 Step 4 命令）

- [ ] **Step 5: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk add apps/web/src/styles/neowow-tokens.css apps/web/src/components/agent/AgentSideRail.vue apps/web/src/styles/text-token-guard.test.ts
git -C /Users/4seven/workspace/pi-lnk commit -m "fix(agent-composer): tokenize dock shadow with light-theme-aware --neo-glass-shadow (P0-3)"
```

---

### Task 4: 移动端命中区 ≥44px（P0-4.1 / P0-4.2）

**Files:**
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（composer 样式区新增 `.agent-hit-expand` 工具类；给 mic/generate/attach/模型/◎/＋ 的移动端命中扩边）
- Modify: `apps/web/src/components/canvas/dock-studio/shared/DockMicButton.vue:42-43`、`DockGenerateButton.vue:59-60`（模板根元素加类）
- Test: Create: `apps/web/src/components/canvas/dock-studio/shared/hitTarget.test.ts`

**Interfaces:**
- Produces: 工具类 `.agent-hit-expand`（视觉不变，`::after` 在 ≤767px 下 `inset: -8px` 撑命中区，28px→44px；24px 控件用 `inset: -10px`）。

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/components/canvas/dock-studio/shared/hitTarget.test.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(join(__dirname, p), 'utf8')

describe('mobile hit target expansion (P0-4)', () => {
  it('mic & generate buttons carry the expansion class', () => {
    expect(read('../DockMicButton.vue')).toMatch(/class="[^"]*agent-hit-expand/)
    expect(read('../DockGenerateButton.vue')).toMatch(/class="[^"]*agent-hit-expand/)
  })
  it('AgentSideRail defines the media-scoped expansion', () => {
    const sfc = read('../../agent/AgentSideRail.vue')
    expect(sfc).toContain('.agent-hit-expand')
    expect(sfc).toMatch(/@media\s*\(max-width:\s*767px\)[\s\S]{0,400}inset:\s*-8px/)
    expect(sfc).toMatch(/@media\s*\(max-width:\s*767px\)[\s\S]{0,400}inset:\s*-10px/)
  })
  it('visual sizes unchanged (B8: 24/28/32)', () => {
    expect(read('../DockMicButton.vue')).toMatch(/width:\s*24px/)
    expect(read('../DockGenerateButton.vue')).toMatch(/width:\s*28px/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/web exec vitest run src/components/canvas/dock-studio/shared/hitTarget.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`AgentSideRail.vue` composer 样式区：

```css
.agent-hit-expand { position: relative; }
.agent-hit-expand::after {
  content: ''; position: absolute; inset: 0; border-radius: inherit;
}
@media (max-width: 767px) {
  .agent-hit-expand[data-hit="m"]::after { inset: -10px; }  /* 24px → 44px */
  .agent-hit-expand[data-hit="l"]::after { inset: -8px; }   /* 28/32px → 44px */
}
```

给 DockMicButton 根元素加 `class="... agent-hit-expand" data-hit="m"`，DockGenerateButton 加 `data-hit="l"`；AgentSideRail 内 composer 区 attach（32px）/模型/◎/＋ 按钮同样加类与 data-hit。

- [ ] **Step 4: 跑测试确认通过**（同 Step 2 命令）

- [ ] **Step 5: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk add apps/web/src/components/canvas/dock-studio/shared/DockMicButton.vue apps/web/src/components/canvas/dock-studio/shared/DockGenerateButton.vue apps/web/src/components/canvas/dock-studio/shared/hitTarget.test.ts apps/web/src/components/agent/AgentSideRail.vue
git -C /Users/4seven/workspace/pi-lnk commit -m "fix(agent-composer): 44px mobile hit targets via visual-preserving expansion (P0-4)"
```

---

### Task 5: 首屏通用化 + persona 轻量化（P1-1.1 / P1-1.2 / P1-1.3）

**Files:**
- Create: `apps/web/src/components/agent/composer/exampleUtterances.ts`
- Test: Create: `apps/web/src/components/agent/composer/exampleUtterances.test.ts`
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（空态模板：persona 单行化 + 4 条样例 chips + 点击填充）

**Interfaces:**
- Produces: `selectExampleUtterances(phase, pool): string[]`（每相 ≤4 条）、`buildDraftFromUtterance(text): string`；AgentSideRail 的 `fillFromUtterance` 处理器（只填充 + focus，不 submit）。

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/components/agent/composer/exampleUtterances.test.ts
import { describe, expect, it } from 'vitest'
import { selectExampleUtterances, buildDraftFromUtterance, type UtterancePool } from './exampleUtterances'

const pool: UtterancePool = {
  empty: ['e1', 'e2', 'e3', 'e4', 'e5'],
  selection: ['s1', 's2'],
  artifact: ['a1', 'a2', 'a3'],
}

describe('selectExampleUtterances (P1-1.1)', () => {
  it('routes by canvas phase and caps at 4', () => {
    expect(selectExampleUtterances('empty', pool)).toEqual(['e1', 'e2', 'e3', 'e4'])
    expect(selectExampleUtterances('selection', pool)).toEqual(['s1', 's2'])
    expect(selectExampleUtterances('artifact', pool)).toEqual(['a1', 'a2', 'a3'])
  })
})

describe('buildDraftFromUtterance (P1-1.2)', () => {
  it('returns editable draft text (never submits)', () => {
    expect(buildDraftFromUtterance('把首页 hero 重画成电商横幅')).toBe('把首页 hero 重画成电商横幅')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/web exec vitest run src/components/agent/composer/exampleUtterances.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`exampleUtterances.ts`：

```ts
export type CanvasPhase = 'empty' | 'selection' | 'artifact'
export interface UtterancePool { empty: string[]; selection: string[]; artifact: string[] }

export function selectExampleUtterances(phase: CanvasPhase, pool: UtterancePool): string[] {
  return (pool[phase] ?? []).slice(0, 4)
}
export function buildDraftFromUtterance(text: string): string {
  return text
}
```

`AgentSideRail.vue` 空态模板：hero 块（B9 空态两行灰字 + persona 区）替换为**一行**轻量文案 + `v-for` 渲染 `selectExampleUtterances(currentCanvasPhase, EXAMPLE_POOL)` 的 chips；chips 点击调 `fillFromUtterance(u)`：

```ts
function fillFromUtterance(u: string) {
  draft.value = buildDraftFromUtterance(u)
  mentionInputRef.value?.focusInput()
}
```

（`currentCanvasPhase` 由已有的画布选中/产物响应式状态派生：空画布→`empty`、有选中→`selection`、有产物→`artifact`；recon：`grep -n "selectedNode\|hasArtifact\|selection" apps/web/src/components/agent/AgentSideRail.vue | head` 找现有布尔。）

- [ ] **Step 4: 跑测试确认通过**（同 Step 2 命令）+ fs 有效性断言：在 Task 12 的清理测试中统一做「chips 容器存在 + fillFromUtterance 不含 submit」扫描（本任务先跑单元测试）。

- [ ] **Step 5: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk add apps/web/src/components/agent/composer/exampleUtterances.ts apps/web/src/components/agent/composer/exampleUtterances.test.ts apps/web/src/components/agent/AgentSideRail.vue
git -C /Users/4seven/workspace/pi-lnk commit -m "feat(agent-composer): universal canvas-aware example chips, fill-not-submit, single-line persona (P1-1)"
```

---

### Task 6: ◎ 画布节点引用一等公民（P1-2.3）

**Files:**
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（按钮 `composer-canvas-pick-btn`，模板 `:3394-3402`；样式 `:4334-4356`）
- Test: Create: `apps/web/src/components/agent/AgentSideRail.canvasRefEntry.test.ts`

**Interfaces:**
- Consumes: 现有 `pickMode` / `onCanvasRefPickToggle` / `CanvasRefTargetIcon`（全部保留，只改容器形态与可见性）。
- Produces: 改名类 `composer-canvas-ref-btn`；ghost 化（无背景无描边）；22px 视觉；PC 命中 32（`::after inset:-5px`）；aria-label `引用画布节点`；空态隐藏。

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/components/agent/AgentSideRail.canvasRefEntry.test.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sfc = readFileSync(join(__dirname, 'AgentSideRail.vue'), 'utf8')

describe('canvas ref entry as first-class citizen (P1-2.3)', () => {
  it('legacy hover ball is fully removed (paired with new-entry presence)', () => {
    expect(sfc).not.toContain('从画布选节点作引用')          // 旧 aria-label
    expect(sfc).not.toContain('composer-canvas-pick-btn')   // 旧类名（含 halo/lens 派生）
    expect(sfc).toContain('aria-label="引用画布节点"')       // 新入口存在
    expect(sfc).toContain('composer-canvas-ref-btn')
  })
  it('ghost: corner button has no glass background, anchored at vertex', () => {
    const rule = sfc.match(/\.composer-canvas-ref-btn\s*\{[^}]*\}/)?.[0] ?? ''
    expect(rule).not.toContain('--neo-glass')
    expect(rule).toContain('background: transparent')
    expect(rule).toContain('translate(-50%, -50%)')
    expect(rule).toContain('width: 22px')
  })
  it('visibility gated: hidden in idle, visible in input/generating', () => {
    // 明确符号断言（比脆弱的位置正则更稳）：computed 名 + 模板绑定
    expect(sfc).toContain('canvasRefEntryVisible')
    expect(sfc).toMatch(/v-if="[^"]*canvasRefEntryVisible[^"]*"/)
  })
  it('C drawer does not contain canvas pick (only the corner button calls the toggle)', () => {
    expect(sfc.match(/onCanvasRefPickToggle/g)?.length).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/web exec vitest run src/components/agent/AgentSideRail.canvasRefEntry.test.ts`
Expected: FAIL（旧符号仍在）

- [ ] **Step 3: 实现**

1. 模板：`composer-canvas-pick-btn` 按钮（`:3394`）改名 `composer-canvas-ref-btn`，删 `__halo` / `__lens` 两个 span，aria-label 改 `引用画布节点`，可见性改为 `v-if="canvasRefEntryVisible"`——script 区新增：

```ts
/** ◎ 可见性门控（P1-2.3）：空态隐藏；输入/生成态可见；空态键入 @ 打开 mention 菜单时立即显示 */
const canvasRefEntryVisible = computed(() => !readOnly.value && (!isIdle.value || mentionMenuOpen.value))
```

（`isIdle` / `mentionMenuOpen` 按现有响应式布尔组合：recon `grep -n "isStreaming\|mentionMenu\|showMenu" AgentSideRail.vue | head` 取真实符号；语义 = 非空闲 或 菜单打开。）
2. 样式（`:4334-4356`）：28×28 玻璃球 → 22×22 ghost：

```css
.composer-canvas-ref-btn {
  position: absolute; z-index: 5; isolation: isolate; overflow: visible;
  width: 22px; height: 22px; padding: 0; border: none;
  border-radius: var(--lnk-radius-full);
  background: transparent; color: var(--lnk-accent-text);
  transform: translate(-50%, -50%);
  transition: color var(--lnk-duration-fast) var(--lnk-ease-standard);
  cursor: pointer;
}
.composer-canvas-ref-btn::after { content: ''; position: absolute; inset: -5px; }
.composer-canvas-ref-btn:hover { color: var(--lnk-accent-hover); }
.composer-canvas-ref-btn:focus-visible { outline: 2px solid var(--lnk-border-focus); outline-offset: 2px; }
```

3. 移动端命中：加 `agent-hit-expand` + `data-hit="l"`（Task 4 的类）。
4. **@ 路径验证**：空态下 MentionInput 键入 `@` 打开 mention 菜单的能力是既有实现（`MentionInput.test.ts` 已覆盖菜单开关），本任务不动它；◎ 隐藏不影响该路径（Review Focus #2）。

- [ ] **Step 4: 跑测试确认通过**（同 Step 2 命令）

- [ ] **Step 5: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk add apps/web/src/components/agent/AgentSideRail.vue apps/web/src/components/agent/AgentSideRail.canvasRefEntry.test.ts
git -C /Users/4seven/workspace/pi-lnk commit -m "feat(agent-composer): first-class corner canvas-ref entry, deprecate hover pick ball (P1-2.3)"
```

---

### Task 7: A/B/C 分层落地（P1-2.1 / P1-2.2 / P1-2.4）

**Files:**
- Create: `apps/web/src/components/agent/composer/thinkingLevels.ts`、`apps/web/src/components/agent/composer/modelSkillDedup.ts`
- Test: Create: `apps/web/src/components/agent/composer/thinkingLevels.test.ts`、`modelSkillDedup.test.ts`
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（C 抽屉收敛 + 思考 chip 替换三按钮 + 模型/技能去重）

**Interfaces:**
- Produces: `THINKING_LEVELS`（`['标准','深入','极限']`）、`levelLabel(v)`、`shouldShowModelChip(selectedSkillId | null): boolean`（skill 为「自动」时隐藏模型 chip 的同义暴露）。

- [ ] **Step 1: 写失败测试**

```ts
// thinkingLevels.test.ts
import { describe, expect, it } from 'vitest'
import { THINKING_LEVELS, levelLabel } from './thinkingLevels'
it('levels localized & labeled', () => {
  expect(THINKING_LEVELS).toEqual(['标准', '深入', '极限'])
  expect(levelLabel('标准')).toBe('思考·标准')
})

// modelSkillDedup.test.ts
import { shouldShowModelChip } from './modelSkillDedup'
it('hides model chip when skill is auto-routed', () => {
  expect(shouldShowModelChip(null)).toBe(true)          // 无技能 = 纯模型选择
  expect(shouldShowModelChip('auto')).toBe(false)       // 自动路由 = 技能菜单已表达
  expect(shouldShowModelChip('product-visual')).toBe(false) // 具体技能锁定编排，模型不重复暴露
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/web exec vitest run src/components/agent/composer/thinkingLevels.test.ts src/components/agent/composer/modelSkillDedup.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// thinkingLevels.ts
export const THINKING_LEVELS = ['标准', '深入', '极限'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]
export const levelLabel = (v: ThinkingLevel) => `思考·${v}`

// modelSkillDedup.ts
export function shouldShowModelChip(selectedSkillId: string | null): boolean {
  return selectedSkillId == null
}
```

`AgentSideRail.vue`：
1. 「深度思考 开/关 + high + max」三个按钮（recon：`grep -n "深度思考\|thinking" apps/web/src/components/agent/AgentSideRail.vue | head`）替换为单 chip `思考·标准 ⌄`，点击展开三档菜单，选中写回原 store/ref（沿用现有值通道，映射 `标准→关/default`、`深入→high`、`极限→max`）。ghost 无背景，样式同 §4 组件规格。
2. 模型 chip 的显隐接 `shouldShowModelChip(selectedSkillId)`；技能菜单「自动」项的语义 = 自动路由（P2-5.1 的 chip 化在 Task 12 一并处理）。
3. C 抽屉（＋ 内）确认只含：本地上传 / 资产库 / 参数预设（◎ 已在 Task 6 保证 `onCanvasRefPickToggle` 全文件仅 1 处）。

- [ ] **Step 4: 跑测试确认通过**（同 Step 2 命令 + `AgentSideRail.canvasRefEntry.test.ts` 回归）

- [ ] **Step 5: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk add apps/web/src/components/agent/composer/thinkingLevels.ts apps/web/src/components/agent/composer/thinkingLevels.test.ts apps/web/src/components/agent/composer/modelSkillDedup.ts apps/web/src/components/agent/composer/modelSkillDedup.test.ts apps/web/src/components/agent/AgentSideRail.vue
git -C /Users/4seven/workspace/pi-lnk commit -m "feat(agent-composer): A/B/C layering — thinking chip, model/skill dedup, C drawer (P1-2.1/2.2/2.4)"
```

---

### Task 8: 生成中状态行（P1-3.1 / P1-3.2）

**Files:**
- Create: `apps/web/src/components/agent/composer/statusLine.ts`
- Test: Create: `apps/web/src/components/agent/composer/statusLine.test.ts`
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（状态行模板 + 样式；停止槽位核对）

**Interfaces:**
- Produces: `buildStatusLine({phase?, progressRatio?, etaSeconds?, points?}): {phase, progress, eta, points}`（成本未知 → 对应字段 null，UI 段隐藏）。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { buildStatusLine } from './statusLine'

describe('buildStatusLine (P1-3.1)', () => {
  it('fills phase/eta/points when known', () => {
    const m = buildStatusLine({ phase: '排版变体', progressRatio: 0.62, etaSeconds: 39.6, points: 8 })
    expect(m).toEqual({ phase: '排版变体', progress: 0.62, eta: '约 40s', points: '8 积分' })
  })
  it('cost-unknown → null segments (must be hidden, not zeroed)', () => {
    const m = buildStatusLine({ phase: '生成中' })
    expect(m.eta).toBeNull()
    expect(m.points).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/web exec vitest run src/components/agent/composer/statusLine.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`statusLine.ts`：

```ts
export interface StatusLineModel {
  phase: string
  progress: number | null
  eta: string | null
  points: string | null
}
export function buildStatusLine(input: {
  phase?: string | null
  progressRatio?: number | null
  etaSeconds?: number | null
  points?: number | null
}): StatusLineModel {
  return {
    phase: input.phase ?? '生成中',
    progress: input.progressRatio ?? null,
    eta: input.etaSeconds == null ? null : `约 ${Math.ceil(input.etaSeconds)}s`,
    points: input.points == null ? null : `${input.points} 积分`,
  }
}
```

模板（输入区上方、ref 芯片层之上）：

```html
<div v-if="isStreaming" class="composer-status-line" role="status" aria-live="polite">
  <span>{{ status.phase }}</span>
  <span class="composer-status-track"><span class="composer-status-fill" :style="{ width: progressPct }" /></span>
  <span v-if="status.eta">{{ status.eta }}</span>
  <span v-if="status.points">{{ status.points }}</span>
</div>
```

样式：`height: 24px; font: var(--lnk-text-2xs)/16px; color: var(--lnk-text-muted);`；进度轨道 3px `--lnk-ink-200` 棘轮、填充 `--lnk-accent`。数据源接线：phase 聚合复用执行轨迹 phase（recon：`grep -n "phase" apps/web/src/components/agent/AgentSideRail.vue | head`）；积分口径沿用 #415。
停止槽位（Review Focus #4）：确认 `DockGenerateButton` 的 is-streaming 切换仍是**同一 DOM 槽位**（B11 现状 + 保护项），不改坐标；在测试里补 fs 断言 `composer-status-line` 存在且 `DockGenerateButton` 在 AgentSideRail 模板中仅出现 1 次。

- [ ] **Step 4: 跑测试确认通过**（同 Step 2 命令）

- [ ] **Step 5: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk add apps/web/src/components/agent/composer/statusLine.ts apps/web/src/components/agent/composer/statusLine.test.ts apps/web/src/components/agent/AgentSideRail.vue
git -C /Users/4seven/workspace/pi-lnk commit -m "feat(agent-composer): generating status line with cost-unknown hiding (P1-3)"
```

---

### Task 9: 产出收据 + 撤销工具立项评估（P1-4.1 / P1-4.2）

**Files:**
- Create: `apps/web/src/components/agent/composer/turnReceipt.ts`
- Test: Create: `apps/web/src/components/agent/composer/turnReceipt.test.ts`
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（消息流末尾收据行）
- Create: `docs/adr/0010-agent-turn-undo-runtime-tool.md`（docs/adr 已核实，0009 为最新）

**Interfaces:**
- Produces: `buildTurnReceipt({ producedCount }): { summary, keepAll, undoTurn }` 文案模型；`定位到画布` 复用现有 `focus-all` 事件（recon：`grep -rn "focus-all" apps/web/src --include=*.vue --include=*.ts | grep -v test | head`）。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { buildTurnReceipt } from './turnReceipt'

it('builds receipt copy (P1-4.1)', () => {
  const r = buildTurnReceipt({ producedCount: 3 })
  expect(r.summary).toBe('本轮产出 3 张 · 定位到画布')
  expect(r.keepAll).toBe('全部保留')
  expect(r.undoTurn).toBe('撤销本轮')
})
```

- [ ] **Step 2: 跑测试确认失败**（同上文件路径模式）Expected: FAIL

- [ ] **Step 3: 实现**

```ts
export function buildTurnReceipt(input: { producedCount: number }) {
  return {
    summary: `本轮产出 ${input.producedCount} 张 · 定位到画布`,
    keepAll: '全部保留',
    undoTurn: '撤销本轮',
  }
}
```

模板：消息流末尾（现有产出卡片之后）渲染收据行；`定位到画布` 派发既有 `focus-all`；`全部保留`=当前行为（无操作确认态）；`撤销本轮` 按钮在 runtime 工具落地前 `disabled` + `title="需 runtime 批量移除工具，见 ADR"`。
ADR 内容要点：基线 grep `deleteNode|removeNode` 无现成入口（规格 P1-4.2）；候选方案（新增 runtime 工具 `remove_turn_nodes` vs 复用既有图编辑通道）；影响面（工具分层纪律——新增工具须答「哪个资产点名了它」，见 AGENTS.md）；结论栏留「待立项评审」。

- [ ] **Step 4: 跑测试确认通过** + fs 断言（追加到 turnReceipt.test.ts）：AgentSideRail.vue 含 `定位到画布`、`全部保留`、`撤销本轮` 三串各 ≥1 次。

- [ ] **Step 5: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk add apps/web/src/components/agent/composer/turnReceipt.ts apps/web/src/components/agent/composer/turnReceipt.test.ts apps/web/src/components/agent/AgentSideRail.vue docs/adr
git -C /Users/4seven/workspace/pi-lnk commit -m "feat(agent-composer): turn receipt row + undo-tool ADR (P1-4)"
```

---

### Task 10: 移动端底部裸条形态（P1-5.1 / P1-5.2 / P1-5.3 / P1-5.4）

**Files:**
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（移动端分支：替换全屏 sheet Teleport（B18 `:3670-3687`），去遮罩（`:2738-2750`），实现三态共条）
- Modify: `apps/web/src/composables/useAgentMobileLayout.ts`（如需新增 `isBareBar` 派生）
- Create: `apps/web/src/components/agent/composer/mobileBarLayout.ts`
- Test: Create: `apps/web/src/components/agent/composer/mobileBarLayout.test.ts`、`apps/web/src/components/agent/AgentSideRail.bareBar.test.ts`（fs-scan）

**Interfaces:**
- Produces: `barShape({ hasRefs, isStreaming }): 'idle' | 'stacked' | 'queued'`（移动条三态形态路由）；`onComposerHold` 空实现发射点（Task 13 接语音）。
- 视觉验收：线稿 §3 三格 + §4「composer 表面」行。

- [ ] **Step 1: 写失败测试**

```ts
// mobileBarLayout.test.ts
import { describe, expect, it } from 'vitest'
import { barShape } from './mobileBarLayout'
describe('barShape (P1-5 two-layer contract)', () => {
  it('idle: single bar, only ＋ inside', () => {
    expect(barShape({ hasRefs: false, isStreaming: false })).toBe('idle')
  })
  it('refs draft content grows the bar → stacked (chips inside, not floating)', () => {
    expect(barShape({ hasRefs: true, isStreaming: false })).toBe('stacked')
  })
  it('generating: queued placeholder + stop slot', () => {
    expect(barShape({ hasRefs: false, isStreaming: true })).toBe('queued')
    expect(barShape({ hasRefs: true, isStreaming: true })).toBe('stacked')
  })
})
```

```ts
// AgentSideRail.bareBar.test.ts（fs-scan）
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
const sfc = readFileSync(join(__dirname, 'AgentSideRail.vue'), 'utf8')

describe('mobile bare bar structure (P1-5)', () => {
  it('full-screen backdrop + view-canvas escape removed (paired with bar presence)', () => {
    // 真实类名已核实：遮罩 = agent-mobile-backdrop（:2652/:3637）；退回按钮 = agent-view-canvas-btn
    expect(sfc).not.toContain('agent-mobile-backdrop')
    expect(sfc).not.toContain('agent-view-canvas-btn')
    expect(sfc).toContain('composer-bare-bar')
  })
  it('idle bar: ＋ inside the bar, no separate control row', () => {
    expect(sfc).toMatch(/composer-bare-bar[\s\S]{0,600}aria-label="更多"/)
    expect(sfc).toMatch(/按住说话/)
  })
  it('status line & interject options live ABOVE the bar (system layer)', () => {
    expect(sfc).toMatch(/composer-status-line[\s\S]{0,400}composer-bare-bar/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/web exec vitest run src/components/agent/composer/mobileBarLayout.test.ts src/components/agent/AgentSideRail.bareBar.test.ts`
Expected: FAIL（旧类名 `agent-mobile-backdrop` / `agent-view-canvas-btn` 仍在，`composer-bare-bar` 不存在）

- [ ] **Step 3: 实现**

1. 移动分支重写：去掉全屏 sheet 与遮罩（删 `:2648-2656` 的 `agent-mobile-backdrop` Teleport 块及其 `:3637` 样式；`panelTeleported` 移动端分支改 false 或移除移动 Teleport）；删除「看画布」退回按钮（`agent-view-canvas-btn`，P1-5.2）；改为 `position: fixed; bottom: env(safe-area-inset-bottom); left/right: 12px` 的贴底容器，内部 = 系统层（状态行 / 插话选项，仅生成态）+ `composer-bare-bar`。画布不再被盖（P1-5.2），`agent-fab` 去留按 P1-5.2 重评（默认移除，走查定夺）。
2. `composer-bare-bar`：`border-radius: var(--lnk-radius-full)`、`min-height: 48px`、`background: var(--lnk-surface-raised)`、`border: 1.5px solid var(--lnk-border-default)`、`box-shadow: var(--lnk-shadow-sm)`、`padding: 0 var(--lnk-space-2)`；focus-within 同 PC（边框→focus + ring）。**文本直接落条内，无内嵌输入框**。
3. 空闲态（P1-5.3）：条内 = `＋`（`agent-hit-expand data-hit="l"`，aria-label="更多"，**`@click.stop`**）+ 提示「按住说话 · 点按输入」；无模型/发送/独立 mic。手势：`pointerdown/pointerup` 计时 → `classifyGesture`（Task 13 提供前先内联 300ms 阈值常量并留 `onComposerHold()` 发射点）；点按 = 切输入态。**条级手势排除子控件**（P1-5.3 判据）：手势监听绑在条空白银幕层或以 `event.target closest` 排除按钮命中，＋/◎/模型/发送的 click 均 `.stop`。
4. 输入态（P1-5.4）：`barShape` 返回 `stacked` 时条内两行——ref 芯片行（草稿层，条内文本上方）+ 输入行（`＋` / 文本 / 模型⌄ / 发送，均 ghost）。`@`/◎（Task 6）钉条左顶点。
5. 生成态：占位 `输入消息…加入待发队列`，发送槽位换停止（复用 DockGenerateButton 同槽位），状态行 + 插话选项在条**上方**。

- [ ] **Step 4: 跑测试确认通过** + 手动双主题目检（对照线稿 §3）。

- [ ] **Step 5: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk add apps/web/src/components/agent/AgentSideRail.vue apps/web/src/components/agent/AgentSideRail.bareBar.test.ts apps/web/src/components/agent/composer/mobileBarLayout.ts apps/web/src/components/agent/composer/mobileBarLayout.test.ts apps/web/src/composables/useAgentMobileLayout.ts
git -C /Users/4seven/workspace/pi-lnk commit -m "feat(agent-composer): mobile bottom bare bar, no sheet/mask, chips inside bar (P1-5)"
```

---

### Task 11: 令牌迁移棘轮（P1-6.1 / P1-6.2）

**Files:**
- Test: Create: `apps/web/src/components/agent/neoUsageRatchet.test.ts`
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（composer 区段 `--neo-*` → `--lnk-*` 清扫，计数只降）

**Interfaces:**
- Produces: 棘轮常量 `NEO_BASELINE`（初值 157 = B12 实测；只允许调低）。

- [ ] **Step 1: 写失败/棘轮测试**

```ts
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const NEO_BASELINE = 157 // B12：Task 11 实施前的计数，只允许下调

function countNeoTokens(dir: string): number {
  let n = 0
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) n += countNeoTokens(p)
    else if (f.endsWith('.vue') || f.endsWith('.ts')) n += (readFileSync(p, 'utf8').match(/--neo-/g) ?? []).length
  }
  return n
}

describe('--neo-* usage ratchet (P1-6.2 / B12)', () => {
  it('count in components/agent only decreases', () => {
    expect(countNeoTokens(join(__dirname))).toBeLessThanOrEqual(NEO_BASELINE)
  })
})
```

- [ ] **Step 2: 确认基线**：先跑一次（Expected: PASS 且当前值 = 157 或已更低），把实测值回填 `NEO_BASELINE`。

- [ ] **Step 3: 实现**：composer 区段样式逐条 `--neo-*` → 对应 `--lnk-*`（映射：`--neo-glass-lite-bg`→`--lnk-surface-raised`、`--neo-text-*`→`--lnk-text-*`、`--neo-glass-border`→`--lnk-border-default`…；无对应语义令牌的先在 `design-tokens.css` 的 L2 深浅成对补齐再消费，禁止直接引用 L1）。目标：composer 区段 0 个 `--neo-*`（文件其余部分允许渐进）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C apps/web exec vitest run src/components/agent/neoUsageRatchet.test.ts src/styles/design-token.test.ts src/styles/theme-usage.test.ts`
Expected: PASS（棘轮值同步下调）

- [ ] **Step 5: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk add apps/web/src/components/agent/neoUsageRatchet.test.ts apps/web/src/components/agent/AgentSideRail.vue apps/web/src/styles/design-tokens.css
git -C /Users/4seven/workspace/pi-lnk commit -m "refactor(agent-composer): migrate composer styles to --lnk-* with ratchet (P1-6)"
```

---

### Task 12: 清理批 —— 引导收敛 / 死样式 / listbox / 技能 chip / 本地化（P1-7.1 / P2-3 / P2-4 / P2-5 / P2-6）

**Files:**
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（删 `.agent-prompt-field` 死块 CSS 2 处（B14 `:4204,4217`）；四层引导收敛 ≤1 层（B13）；输入框高度口径统一 96px）
- Modify: `apps/web/src/components/canvas/MentionInput.vue`（mention 候选 listbox 语义）+ `MentionInput.test.ts`
- Create: `apps/web/src/components/agent/composer/skillMenuMode.ts`
- Test: Create: `apps/web/src/components/agent/composer/skillMenuMode.test.ts`；追加 MentionInput 测试

**Interfaces:**
- Produces: `skillMenuMode(count: number): 'chip' | 'menu'`（≤3 → chip，≥4 → menu）。

- [ ] **Step 1: 写失败测试**

```ts
// skillMenuMode.test.ts
import { skillMenuMode } from './skillMenuMode'
it('≤3 skills degrade to chip (P2-5.1)', () => {
  expect(skillMenuMode(1)).toBe('chip')
  expect(skillMenuMode(3)).toBe('chip')
  expect(skillMenuMode(4)).toBe('menu')
})
```

```ts
// 追加到 MentionInput.test.ts
it('mention candidates use listbox semantics (P2-4.1)', async () => {
  const w = mount(MentionInput, { props: { modelValue: '@', mentions: [{ id: 'ref-1', label: '参考图' }] } })
  await w.get('textarea').trigger('input')
  await w.vm.$nextTick()
  const list = w.find('ul')
  expect(list.exists()).toBe(true)
  expect(list.attributes('role')).toBe('listbox')
  expect(w.find('ul li').attributes('role')).toBe('option')
})
```

- [ ] **Step 2: 跑测试确认失败** Expected: FAIL

- [ ] **Step 3: 实现**

1. 删 `.agent-prompt-field` 两处 CSS；输入框高度统一 96px（消除 76px 死值，P2-3.2）。
2. MentionInput：`<ul role="listbox" :aria-activedescendant="activeId">`、`<li role="option" :id="optId(i)">`、aria-activedescendant 跟随高亮（保留既有键盘上下键，B16）。
3. `skillMenuMode.ts`：`export const skillMenuMode = (n: number): 'chip' | 'menu' => (n >= 4 ? 'menu' : 'chip')`；AgentSideRail 技能入口按其切换 chip/菜单（当前 `AGENT_SKILLS.length === 1` → chip）。
4. 引导文案四层（reattach / attachment / coachmark / pick-tip，B13）收敛：仅保留 coachmark 且首次出现（localStorage 或既有持久化通道）；其余删除，靠控件自解释。
5. 模型 chip 文案截断：`friendlyModelName(raw, max = 12)` —— 超长取 `raw.slice(0, max) + '…'`，完整名进 `title` tooltip（P2-6.1，放入 `modelSkillDedup.ts` 同文件并加测试：`expect(friendlyModelName('Step-5-Planning-Alpha')).toBe('Step-5-Planni…')`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C apps/web exec vitest run src/components/agent/composer/skillMenuMode.test.ts src/components/agent/composer/modelSkillDedup.test.ts src/components/canvas/MentionInput.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk add apps/web/src/components/agent/AgentSideRail.vue apps/web/src/components/canvas/MentionInput.vue apps/web/src/components/canvas/MentionInput.test.ts apps/web/src/components/agent/composer/skillMenuMode.ts apps/web/src/components/agent/composer/skillMenuMode.test.ts apps/web/src/components/agent/composer/modelSkillDedup.ts apps/web/src/components/agent/composer/modelSkillDedup.test.ts
git -C /Users/4seven/workspace/pi-lnk commit -m "chore(agent-composer): dead styles, listbox a11y, skill chip degrade, copy cleanup (P1-7, P2-3/4/5/6)"
```

---

### Task 13: 按住说话（P2-2.1 PC / P2-2.2 移动）

**Files:**
- Create: `apps/web/src/components/agent/composer/holdGesture.ts`
- Test: Create: `apps/web/src/components/agent/composer/holdGesture.test.ts`
- Modify: `apps/web/src/components/canvas/dock-studio/shared/DockMicButton.vue`（PC press-and-hold）；`apps/web/src/components/agent/AgentSideRail.vue`（移动条 hold 接 `onComposerHold`；录音时长/电平/上滑取消 UI）

**Interfaces:**
- Produces: `classifyGesture({ durationMs, dy }): 'tap' | 'hold' | 'cancel'`（`HOLD_MS = 300`、`CANCEL_SWIPE_PX = 60`）；录音 UI 状态复用现有 `.is-listening` 通道（P2-2.1 保留并强化）。
- Consumes: Task 10 留下的 `onComposerHold` 发射点。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { classifyGesture, HOLD_MS, CANCEL_SWIPE_PX } from './holdGesture'

describe('classifyGesture (P2-2.2)', () => {
  it('short press = tap (switch to input, not voice)', () => {
    expect(classifyGesture({ durationMs: 120, dy: 0 })).toBe('tap')
  })
  it(`long press ≥ ${HOLD_MS}ms = hold (voice)`, () => {
    expect(classifyGesture({ durationMs: HOLD_MS, dy: 0 })).toBe('hold')
  })
  it('swipe up beyond threshold = cancel', () => {
    expect(classifyGesture({ durationMs: 1200, dy: -(CANCEL_SWIPE_PX + 1) })).toBe('cancel')
    expect(classifyGesture({ durationMs: 1200, dy: -(CANCEL_SWIPE_PX - 1) })).toBe('hold')
  })
})
```

- [ ] **Step 2: 跑测试确认失败** Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
export const HOLD_MS = 300
export const CANCEL_SWIPE_PX = 60
export type GestureVerdict = 'tap' | 'hold' | 'cancel'
export function classifyGesture(press: { durationMs: number; dy: number }): GestureVerdict {
  if (press.dy <= -CANCEL_SWIPE_PX) return 'cancel'
  return press.durationMs >= HOLD_MS ? 'hold' : 'tap'
}
```

1. **移动端**（Task 10 的空闲条）：`pointerdown` 记起点/时间，`pointermove` 累计 dy，`pointerup` 用 `classifyGesture` 分派——`hold`→录音（松开 ASR 填入输入框并切输入态、**不自动提交**），`cancel`→丢弃，`tap`→切输入态。**条级手势排除子控件命中**（P1-5.3 判据，含 ＋/◎/模型/发送）。录音中显示时长/电平（复用既有 mic 录音管线，recon：`grep -rn "is-listening\|MediaRecorder" apps/web/src/components --include=*.vue | head`）；条边框→`--lnk-border-focus` 反馈，`prefers-reduced-motion` 下不脉冲。◎ 独立命中区（Task 4 `::after` + `@click.stop`），点击 ◎ 不触发条手势。
2. **PC 端**（P2-2.1）：DockMicButton 从点击开关改 press-and-hold：`pointerdown` 开始、`release` 发送、上滑取消；保留 `.is-listening` 强化（时长 + 电平条）。

- [ ] **Step 4: 跑测试确认通过**（同 Step 2 命令）

- [ ] **Step 5: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk add apps/web/src/components/agent/composer/holdGesture.ts apps/web/src/components/agent/composer/holdGesture.test.ts apps/web/src/components/canvas/dock-studio/shared/DockMicButton.vue apps/web/src/components/agent/AgentSideRail.vue
git -C /Users/4seven/workspace/pi-lnk commit -m "feat(agent-composer): press-and-hold voice with tap/cancel classification (P2-2)"
```

---

### Task 14: 输入预测（P2-1.1）

**Files:**
- Create: `apps/web/src/components/agent/composer/prediction.ts`
- Test: Create: `apps/web/src/components/agent/composer/prediction.test.ts`
- Modify: `apps/web/src/components/canvas/MentionInput.vue`（ghost 预测层 + Tab 接受）+ `MentionInput.test.ts`

**Interfaces:**
- Produces: `buildGhostPrediction({ draft, history, refs }): string | null`（纯函数，可先返回基于会话末条的高频接续的最小实现）；`acceptPrediction(draft, ghost): string`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { buildGhostPrediction, acceptPrediction } from './prediction'

describe('composer prediction (P2-1.1)', () => {
  it('accepts ghost onto draft', () => {
    expect(acceptPrediction('帮我', '生成三张变体')).toBe('帮我生成三张变体')
  })
  it('no prediction context → null (layer hidden)', () => {
    expect(buildGhostPrediction({ draft: '', history: [], refs: [] })).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败** Expected: FAIL

- [ ] **Step 3: 实现**

```ts
export function acceptPrediction(draft: string, ghost: string): string {
  return draft + ghost
}
export function buildGhostPrediction(input: { draft: string; history: string[]; refs: string[] }): string | null {
  if (!input.draft || input.history.length === 0) return null
  // 最小实现：历史中找以 draft 开头的下一条，返回其剩余部分；无命中 → null
  const hit = input.history.find((h) => h.startsWith(input.draft) && h.length > input.draft.length)
  return hit ? hit.slice(input.draft.length) : null
}
```

MentionInput：预测灰字浮层（`aria-hidden`，Tab 接受 → `acceptPrediction` 后可继续编辑）；有可关闭入口（`Esc` 或 ✕）。

- [ ] **Step 4: 跑测试确认通过**（含 MentionInput.test.ts 回归）

- [ ] **Step 5: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk add apps/web/src/components/agent/composer/prediction.ts apps/web/src/components/agent/composer/prediction.test.ts apps/web/src/components/canvas/MentionInput.vue apps/web/src/components/canvas/MentionInput.test.ts
git -C /Users/4seven/workspace/pi-lnk commit -m "feat(agent-composer): ghost prediction with Tab-accept (P2-1)"
```

---

### Task 15: 终验 —— 门禁全家 + 人工走查 + 规格回填

**Files:**
- Modify: `docs/design/Agent Composer UI-UX 整改规格.md`（§4 跟踪表逐行勾选 + 填体验提升证据）

- [ ] **Step 1: 跑目标测试全家（本机允许的范围）**

```bash
pnpm -C apps/web exec vitest run \
  src/components/canvas/MentionInput.test.ts \
  src/components/canvas/dock-studio/shared/hitTarget.test.ts \
  src/components/agent/composer \
  src/components/agent/AgentSideRail.canvasRefEntry.test.ts \
  src/components/agent/AgentSideRail.bareBar.test.ts \
  src/components/agent/neoUsageRatchet.test.ts \
  src/styles/text-token-guard.test.ts \
  src/styles/design-token.test.ts \
  src/styles/theme-usage.test.ts \
  src/constants/agentSkillMap.keyboard.test.ts
```

Expected: 全 PASS。**不要**跑全量 web 套件（CI 职责）。

- [ ] **Step 2: 规格验收门禁（§7）**：逐条跑对比度脚本、令牌守卫、死样式 grep、命中区 ratchet、占位符检查；`git -C /Users/4seven/workspace/pi-lnk status --short` 必须为空后再 push（代理三步判活见 `docs/agent/delivery.md`）。

- [ ] **Step 3: 人工走查（对照线稿 §6 清单逐项打勾）**：真机 iOS/Android + 桌面双主题；六态截图与线稿并排比对；重点 Review Focus 1–5。

- [ ] **Step 4: 回填规格 §4**：每行勾 `落实✅/AI确认✅/人工确认✅`，体验提升列填实测证据（对比度数值 / 命中区截图 / 走查结论）；§8 追加 v0.6.0 实施完成记录。

- [ ] **Step 5: squash 合并 + 生产复测**（按 `docs/agent/delivery.md`；用户偏好：squash + 上线后复测六项）。

---

## Self-Review 记录（写计划时已核）

1. **Spec 覆盖**：P0×9 → Task 1–4；P1×18 → Task 5–12（P1-2.3 独立 Task 6；P1-4.2 评估在 Task 9）；P2×8 → Task 12–14；§7 门禁 → Task 15。35 子任务无遗漏。
2. **占位符扫描**：两处 recon 依赖（Task 10 旧遮罩类名、Task 13 录音管线符号）已给出确切 rg 命令与「先侦察后回填常量」的步骤，不属于 TBD；所有测试断言均落在新定义符号或已核实的现有符号（`composer-canvas-pick-btn` / `从画布选节点作引用` / `agent-prompt-field` / B8 尺寸 / `--neo-text-muted` / `rgba(0, 0, 0, 0.42)` 均经本仓实测）。
3. **类型一致性**：`classifyGesture` / `barShape` / `buildStatusLine` / `buildTurnReceipt` / `selectExampleUtterances` / `shouldShowModelChip` / `skillMenuMode` / `friendlyModelName` / `acceptPrediction` 的签名在定义任务与消费任务间一致。
4. **Review Focus**：5 条均已钉进 owning task（1→T1、2→T6、3→T2/T11、4→T8、5→T10+走查）。
