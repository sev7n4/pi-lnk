# Model Settings Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 PC 画布竖轨的【设置】入口收敛到个人中心新增的「设置」Tab，并把设置域（弹层 + 两端入口）从旧 `--neo-*` 令牌迁移到 `--lnk-*` 设计系统令牌。

**Architecture:** 单组件实现、双宿主挂载——`ProviderConfigDialog` 保持一份；PC 由 `ProfilePage` 新「设置」Tab 挂载，移动端仍由 `CanvasPage` 挂载。配置数据是 `useProviderBootstrap` 模块级单例 + 弹层 `watch(open)→load(true)` 自加载，换宿主无需改数据层。

**Tech Stack:** Vue 3.5 + TypeScript + Element Plus 2.14.2 + Vitest + Tailwind 语义类（`design-tokens.css` 为令牌 SSOT）。

**Spec:** `docs/superpowers/specs/2026-11-19-model-settings-design-tokens-refactor-design.md`

## Global Constraints

- 令牌 SSOT = `apps/web/src/styles/design-tokens.css`；组件只消费 `--lnk-*` 或 tailwind 语义类，禁止新增 hex / rgba / `--neo-*` / `text-white` / `bg-[#`（设置域内）。
- 弹层 `ProviderConfigDialog.vue` 迁移后 `--neo-` 出现次数必须为 **0**（大小写不敏感）。
- 入口标签统一为「模型配置」，不另造「配置模型」；PC 新增 Tab 标签「设置」。
- 移动端 `open-model-settings` 链路保持不变；PC 删除的是 `open-settings`（两者不可混淆）。
- 弹层 A11y：复用 Element Plus 内置 `role=dialog` / `aria-modal` / 焦点陷阱 / Esc，只补 `aria-labelledby` 指向真实标题。
- 测试：`cd apps/web && ./node_modules/.bin/vitest run <file> --maxWorkers=1 --no-file-parallelism`；类型 `pnpm --filter @lnkpi/web exec vue-tsc -b`（不带 --noEmit）。
- 分支纪律：所有改动在 `.worktrees/model-settings-tokens`（`feat/model-settings-tokens`）内，master 零直提。
- 第一原则：不新建公共设置组件、不新增令牌、不新建测试框架（复用既有守卫模式）。

## Review Focus

- **PC 用户打开 `/profile?tab=settings`**：期望看到「外观」+「模型配置」两行，点模型配置弹出配置弹层且数据已加载——Task 2 测试覆盖解析与弹层置真。
- **老用户仍从画布找设置**：期望画布竖轨不再有【设置】按钮，但移动端「我的→设置→模型配置」仍能打开同一弹层——Task 1 + Task 4 静态/组件测试覆盖。
- **深色/浅色主题下的弹层**：期望文字/边框/表面随主题翻转且对比度达标（旧 `--neo-*` 已达标，迁移不能降）——Task 3 令牌映射 + 既有 `design-token.test.ts` 覆盖。
- **键盘/读屏用户**：期望弹层有可访问名、`aria-labelledby` 指向真实标题、Esc 可关——Task 3 补 `aria-labelledby` + 测试断言。
- **未登录用户**：期望 `/profile` 仍跳登录、`settings` Tab 不绕过鉴权——Task 2 保留既有 `onMounted` 鉴权路径，测试复核不回归。

---

### Task 1: 删 PC 画布竖轨设置入口（R1）

**Files:**
- Modify: `apps/web/src/components/canvas/NodePanelDock.vue:19`、`:212-234`
- Modify: `apps/web/src/pages/CanvasPage.vue:6553`
- Test: `apps/web/src/pages/CanvasPage.mobileEntryWiring.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `NodePanelDock` 不再 emit `open-settings`；`CanvasPage` 不再监听该事件。

- [ ] **Step 1: 写失败测试——竖轨不再暴露设置按钮**

在 `apps/web/src/pages/CanvasPage.mobileEntryWiring.test.ts` 末尾追加（若该文件是静态源码扫描则同样用源码断言）：

```ts
it('PC 画布竖轨不再有【设置】入口（open-settings 已迁到个人中心）', () => {
  const sfc = readFileSync(join(HERE, '../components/canvas/NodePanelDock.vue'), 'utf8')
  expect(sfc).not.toContain("title=\"模型服务配置\"")
  expect(sfc).not.toContain('open-settings')
})
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/model-settings-tokens/apps/web && ./node_modules/.bin/vitest run src/pages/CanvasPage.mobileEntryWiring.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: FAIL（源码仍含 `open-settings` / 标题）。

- [ ] **Step 3: 删按钮与 emit**

`NodePanelDock.vue`：删除 emit 声明 `'open-settings': []`（`:19`）；删除 `:214-232` 的设置按钮整块；保留相邻两条分隔线之一（删按钮上方的 `:212` 或下方的 `:234` 之一，避免留下连续分界线）。

`CanvasPage.vue`：删除 `@open-settings="showModelSettings = true"`（`:6553`），保留 `:open-model-settings="() => (showModelSettings = true)"`（`:6669`）与 `<ProviderConfigDialog v-model="showModelSettings" />`（`:6697`）。

- [ ] **Step 4: 运行确认通过**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/model-settings-tokens/apps/web && ./node_modules/.bin/vitest run src/pages/CanvasPage.mobileEntryWiring.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git -C /Users/4seven/workspace/pi-lnk/.worktrees/model-settings-tokens add apps/web/src/components/canvas/NodePanelDock.vue apps/web/src/pages/CanvasPage.vue apps/web/src/pages/CanvasPage.mobileEntryWiring.test.ts
git -C /Users/4seven/workspace/pi-lnk/.worktrees/model-settings-tokens commit -m "feat(web): remove canvas rail settings entry, move to profile"
```

---

### Task 2: PC 个人中心新增「设置」Tab（R2）

**Files:**
- Modify: `apps/web/src/pages/ProfilePage.vue:17-27`、`:101-121`、`:229-234`
- Test: `apps/web/src/pages/ProfilePage.test.ts`

**Interfaces:**
- Consumes: `ProviderConfigDialog`（`@/components/canvas/ProviderConfigDialog.vue`）的 `v-model:boolean`；`ThemeToggle`（`@/components/layout/ThemeToggle.vue`）。
- Produces: `?tab=settings` 可解析；`data-testid="profile-settings-panel"` 面板。

- [ ] **Step 1: 写失败测试——settings Tab 解析与弹层接线**

在 `ProfilePage.test.ts` 的 describe 内追加（复用现有 `routeQuery` / `mountProfile`）：

```ts
it('?tab=settings 解析为设置 Tab 并展示外观/模型配置两行', async () => {
  routeQuery.tab = 'settings'
  const wrapper = await mountProfile()
  const panel = wrapper.find('[data-testid="profile-settings-panel"]')
  expect(panel.exists()).toBe(true)
  expect(panel.text()).toContain('外观')
  expect(panel.text()).toContain('模型配置')
  const tabs = wrapper.findAll('[role="tab"]')
  expect(tabs.some((t) => t.text() === '设置' && t.attributes('aria-selected') === 'true')).toBe(true)
})

it('点模型配置行打开配置弹层（v-model 置真）', async () => {
  routeQuery.tab = 'settings'
  const wrapper = await mountProfile()
  const row = wrapper.find('[data-testid="open-model-settings"]')
  expect(row.exists()).toBe(true)
  await row.trigger('click')
  await flushPromises()
  // ProviderConfigDialog 在测试里被 stub 成带 data-open 的 div，读其属性确认 v-model 传入 true
  expect(wrapper.find('[data-testid="provider-config-dialog"]').attributes('data-open')).toBe('true')
})
```

并在文件顶部的 mock 区追加（避免 Element Plus 在单测里实例化）：

```ts
vi.mock('@/components/canvas/ProviderConfigDialog.vue', () => ({
  default: {
    props: ['modelValue'],
    template: '<div data-testid="provider-config-dialog" :data-open="String(modelValue)" />',
  },
}))
vi.mock('@/components/layout/ThemeToggle.vue', () => ({
  default: { template: '<div class="theme-toggle-stub" />' },
}))
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/model-settings-tokens/apps/web && ./node_modules/.bin/vitest run src/pages/ProfilePage.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: FAIL（找不到 `profile-settings-panel`）。

- [ ] **Step 3: 实现 settings Tab**

`ProfilePage.vue`：

import 追加：
```ts
import ProviderConfigDialog from '@/components/canvas/ProviderConfigDialog.vue'
import ThemeToggle from '@/components/layout/ThemeToggle.vue'
```

类型与解析：
```ts
type ProfileTab = 'account' | 'billing' | 'settings'
// activeTab 内：if (raw === 'settings') return 'settings'
```

状态：
```ts
const showModelSettings = ref(false)
```

Tab 数组改为：
```ts
[['account', '账户'], ['billing', '用量'], ['settings', '设置']] as const
```

在 `panel-billing` 之后、`TopupModal` 之前插入面板（样式沿用既有语义类）：

```vue
<div v-if="activeTab === 'settings'" id="panel-settings" role="tabpanel"
     aria-labelledby="tab-settings" data-testid="profile-settings-panel" class="space-y-4">
  <section class="rounded-2xl border border-overlay/8 bg-surface-elevated p-6">
    <h2 class="mb-4 text-base font-medium text-fg">设置</h2>
    <div class="flex items-center justify-between gap-4 py-3">
      <span class="text-sm text-fg-2">外观</span>
      <ThemeToggle />
    </div>
    <div class="border-t border-overlay/8" />
    <button type="button" data-testid="open-model-settings"
            class="flex w-full items-center justify-between gap-4 py-3 text-left transition hover:text-fg"
            @click="showModelSettings = true">
      <span class="text-sm text-fg-2">模型配置</span>
      <svg class="h-4 w-4 text-fg-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="m9 5 7 7-7 7" />
      </svg>
    </button>
  </section>
</div>

<ProviderConfigDialog v-model="showModelSettings" />
```

- [ ] **Step 4: 运行确认通过（含既有用例不回归）**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/model-settings-tokens/apps/web && ./node_modules/.bin/vitest run src/pages/ProfilePage.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: PASS（既有 `只有一个 h1` 用例仍绿——新增的是 h2）。

- [ ] **Step 5: 提交**

```bash
git -C /Users/4seven/workspace/pi-lnk/.worktrees/model-settings-tokens add apps/web/src/pages/ProfilePage.vue apps/web/src/pages/ProfilePage.test.ts
git -C /Users/4seven/workspace/pi-lnk/.worktrees/model-settings-tokens commit -m "feat(web): add settings tab with model config entry in profile"
```

---

### Task 3: 弹层令牌重构 + A11y（R3 + R4）

**Files:**
- Modify: `apps/web/src/components/canvas/ProviderConfigDialog.vue:613-1027`、`:602-616`、`:1064-1124`
- Test: `apps/web/src/components/canvas/ProviderConfigDialog.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `ProviderConfigDialog` v-model 契约（不变）。
- Produces: 迁移后的弹层；A11y `aria-labelledby="provider-config-title"`。

- [ ] **Step 1: 写失败测试——无旧令牌 + A11y 接线**

在 `ProviderConfigDialog.test.ts` 追加（`readFileSync` / `join` 按本文件已有 import 风格补充）：

```ts
it('设置域令牌已迁移：弹层无任何 --neo-* 残留', () => {
  const sfc = readFileSync(join(HERE, 'ProviderConfigDialog.vue'), 'utf8')
  expect(sfc.match(/--neo-/g) ?? []).toHaveLength(0)
})

it('弹层 aria-labelledby 指向真实存在的标题', async () => {
  const wrapper = mount(ProviderConfigDialog, {
    props: { modelValue: true },
    global: { plugins: [ElementPlus] },
    attachTo: document.body,
  })
  await flushPromises()
  const dialog = wrapper.find('[role="dialog"]')
  const labelId = dialog.attributes('aria-labelledby')
  expect(labelId).toBeTruthy()
  expect(document.getElementById(labelId!)).toBeTruthy()
  wrapper.unmount()
})
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/model-settings-tokens/apps/web && ./node_modules/.bin/vitest run src/components/canvas/ProviderConfigDialog.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: FAIL（`--neo-` 计数非 0）。

- [ ] **Step 3: 全量令牌映射（按出现次数逐一替换，共 9 种 / 67 处）**

`ProviderConfigDialog.vue` 全文替换（模板用语义类，style 段用 `--lnk-*` 变量）：

| 旧令牌（次数） | 模板写法 | `<style>` 写法 |
|---|---|---|
| `--neo-text-muted`（42） | `text-fg-3` | `var(--lnk-text-muted)` |
| `--neo-border`（8） | `border-line` | `var(--lnk-border-default)` |
| `--neo-text-secondary`（6） | `text-fg-2` | `var(--lnk-text-secondary)` |
| `--neo-text-primary`（6） | `text-fg` | `var(--lnk-text-primary)` |
| `--neo-warm`（2） | `text-warning` | — |
| `--neo-surface-card`（1） | `bg-surface-elevated` | `var(--lnk-surface-raised)` |
| `--neo-hover-bg`（1） | — | `var(--lnk-hover-overlay)` |
| `--neo-accent-text`（1） | — | `var(--lnk-accent-text)` |
| `--neo-accent`（1） | — | `var(--lnk-accent)` |

模板中 `text-[var(--neo-text-primary)]` → `text-fg`，`border-[var(--neo-border)]` → `border-line`，`text-[var(--neo-warm)]` → `text-warning`，以此类推。注意 warning 三件套 `border-warning-border bg-warning-bg`（`:622`）已合规，保留不动。

style 段补令牌化圆角：`:1101` `border-radius: 8px` → `var(--lnk-radius-md)`；`:1119` `border-radius: 6px` → `var(--lnk-radius-sm)`；`:1122` `font-size: 11px` → `var(--lnk-text-2xs)`（该标签是英文能力缩写，2xs 允许）。

- [ ] **Step 4: 补 A11y**

`el-dialog`（`:603-610`）加属性：
```vue
    aria-labelledby="provider-config-title"
```
`#header` 内标题（`:613`）加 id：
```vue
        <div id="provider-config-title" class="text-base font-semibold text-fg">配置与用户偏好</div>
```

- [ ] **Step 5: 运行确认通过**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/model-settings-tokens/apps/web && ./node_modules/.bin/vitest run src/components/canvas/ProviderConfigDialog.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: PASS（含既有窗口化/能力筛选/unavailable 灰显两用例）。

- [ ] **Step 6: 核验既有全局守卫不回归**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/model-settings-tokens/apps/web && ./node_modules/.bin/vitest run src/styles/design-token.test.ts src/styles/theme-usage.test.ts src/styles/palette-parity.test.ts src/styles/text-token-guard.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git -C /Users/4seven/workspace/pi-lnk/.worktrees/model-settings-tokens add apps/web/src/components/canvas/ProviderConfigDialog.vue apps/web/src/components/canvas/ProviderConfigDialog.test.ts
git -C /Users/4seven/workspace/pi-lnk/.worktrees/model-settings-tokens commit -m "feat(web): migrate provider config dialog to design tokens and add a11y label"
```

---

### Task 4: 静态守卫锁死 R1/R3/R4 + 移动端核验（R5）

**Files:**
- Create: `apps/web/src/styles/settings-domain-tokens.test.ts`
- Verify（不改）: `apps/web/src/components/mobile/ProfilePane.vue`

**Interfaces:**
- Consumes: Task 1–3 的源码产物。
- Produces: 单一职责的静态守卫文件。

- [ ] **Step 1: 写守卫测试（一次写全，直接锁住前三刀）**

```ts
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(join(HERE, rel), 'utf8')

describe('settings domain wiring + tokens', () => {
  it('R1: PC canvas rail exposes no settings entry', () => {
    const dock = read('../components/canvas/NodePanelDock.vue')
    expect(dock).not.toContain('open-settings')
    expect(dock).not.toContain('模型服务配置')
  })

  it('R1: mobile model-settings entry stays wired', () => {
    const page = read('../pages/CanvasPage.vue')
    expect(page).toContain('open-model-settings')
    expect(page).toContain('<ProviderConfigDialog v-model="showModelSettings" />')
    const pane = read('../components/mobile/ProfilePane.vue')
    expect(pane).toContain("emit('open-model-settings')")
  })

  it('R2: profile settings tab is reachable', () => {
    const page = read('../pages/ProfilePage.vue')
    expect(page).toContain("'settings'")
    expect(page).toContain('data-testid="profile-settings-panel"')
    expect(page).toContain('data-testid="open-model-settings"')
  })

  it('R3: provider config dialog has zero legacy tokens', () => {
    const sfc = read('../components/canvas/ProviderConfigDialog.vue')
    expect(sfc.match(/--neo-/g) ?? []).toHaveLength(0)
  })

  it('R4: dialog labelled by a real title, escape not disabled', () => {
    const sfc = read('../components/canvas/ProviderConfigDialog.vue')
    expect(sfc).toContain('aria-labelledby="provider-config-title"')
    expect(sfc).toContain('id="provider-config-title"')
    expect(sfc).not.toContain(':close-on-press-escape="false"')
  })
})
```

- [ ] **Step 2: 运行确认通过**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/model-settings-tokens/apps/web && ./node_modules/.bin/vitest run src/styles/settings-domain-tokens.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: PASS。

- [ ] **Step 3: 变异自检——确认守卫能转 RED**

依次做三处临时破坏，每次运行后必须 FAIL + exit≠0，随后**还原**（用 `git checkout -- <file>` 只还原被临时改的源码文件，不要动测试）：

1. 在 `ProviderConfigDialog.vue` 任一处塞回 `text-[var(--neo-text-muted)]` → R3 用例红。
2. 把 `ProfilePage.vue` 的 `data-testid="profile-settings-panel"` 改名 → R2 用例红。
3. 在 `NodePanelDock.vue` 塞回 `title="模型服务配置"` → R1 用例红。

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/model-settings-tokens/apps/web && ./node_modules/.bin/vitest run src/styles/settings-domain-tokens.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected（每次）: FAIL，退出码 1。全部 RED 后还原并复跑确认 PASS。

- [ ] **Step 4: 移动端令牌核验（不改代码）**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/model-settings-tokens && grep -c -- '--neo-' apps/web/src/components/mobile/ProfilePane.vue || echo "0 legacy tokens"
```
Expected: 0。若非 0，就地按 Task 3 映射表校准后重跑守卫。

- [ ] **Step 5: 提交**

```bash
git -C /Users/4seven/workspace/pi-lnk/.worktrees/model-settings-tokens add apps/web/src/styles/settings-domain-tokens.test.ts
git -C /Users/4seven/workspace/pi-lnk/.worktrees/model-settings-tokens commit -m "test(web): guard settings domain entry wiring and token migration"
```

---

### Task 5: 类型检查与提交前门禁

- [ ] **Step 1: 类型检查**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/model-settings-tokens && pnpm --filter @lnkpi/web exec vue-tsc -b
```
Expected: 无错误（不带 --noEmit）。

- [ ] **Step 2: 定向测试汇总**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/model-settings-tokens/apps/web && ./node_modules/.bin/vitest run src/pages/ProfilePage.test.ts src/pages/CanvasPage.mobileEntryWiring.test.ts src/components/canvas/ProviderConfigDialog.test.ts src/styles/settings-domain-tokens.test.ts src/styles/design-token.test.ts src/styles/theme-usage.test.ts src/styles/text-token-guard.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: ALL PASS。

- [ ] **Step 3: 工作区洁净检查**

```bash
git -C /Users/4seven/workspace/pi-lnk/.worktrees/model-settings-tokens status --short
```
Expected: 空（本地绿≠CI绿，未提交改动会让 CI 结论相反）。

---

## Self-Review（已对照 spec 逐条核查）

- **Spec 覆盖**：G1→Task 1+2；G2→Task 3+4；G3→Task 3 Step4；G4→Task 4；N1–N5→全局约束与非目标遵守，无越界任务。
- **占位符扫描**：无 TBD/TODO；每个代码步骤均给出真实代码。
- **类型一致性**：`showModelSettings`、`profile-settings-panel`、`open-model-settings`、`provider-config-title`、`settings` Tab 在 Task 2/3/4 中拼写一致。
- **Review Focus**：五类输入各有对应测试（Task 2 解析/弹层、Task 1+4 双入口、Task 3 主题令牌与 A11y、Task 2 鉴权不回归）。
- **变异验证**：Task 4 Step 3 对 R1/R2/R3 三条守卫各做一次 RED 自检，符合"判据必须能真的失败"。
