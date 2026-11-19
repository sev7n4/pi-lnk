# 设置入口层级修正与外观主题区分 · 设计（返工 v2）

> 本文是对 `2026-11-19-model-settings-design-tokens-refactor-design.md`（v1，已随 PR #957 上线）的返工修正。
> v1 的两处决策被用户推翻：① 设置入口挂在「个人中心」Tab（应为头像菜单一级项）；② 外观只放一个裸 `ThemeToggle` 图标按钮（应做浅/深视觉区分）。
> v1 中未被推翻的部分（弹层 `--neo-*` 令牌归零、A11y 标题、竖轨入口删除、移动端链路）继续有效，本文不重复。

## 0. 第一原则与等价物检索结论（强制）

第一原则：**吃满上游、不重复造轮子**。任何新增判据/工具/字段/引擎前过三判据（①等价物检索 ②接线优先于新建，锚已有结构化数据面 ③禁造数/禁自报）。

| 需求 | 等价物检索 | 结论 |
|---|---|---|
| 「设为指定主题」能力 | `useCanvasTheme` 已有 `theme` ref + `toggleTheme` + `watch` 落地 DOM/localStorage | **扩展**：加 `setTheme(value)` 复用同一 watch 链路；不新建 store、不另造真相源 |
| 外观浅/深双选项 | 已有 `ThemeToggle`（单图标按钮）+ `CanvasTheme = 'dark' \| 'light'` | **改造呈现**：新增设置页内的双选项卡片，底层仍调 composable；保留 ThemeToggle 原样（画布/全站 header 仍在用） |
| 缩略预览恒定浅/深色 | 设计系统「主题不变式」L2 令牌：`stamp-face-on-signature`（恒白）、`stamp-ink-on-signature`（恒墨）、`surface-signature`/`text-on-signature`（恒深/恒浅），且 `design-token.test.ts` 已守卫其两主题同值 | **直接消费**：零新增令牌、零硬编码 hex，符合「组件只消费 L2/L3」硬规则 |
| 选中态配色 | `--lnk-accent-subtle` / `--lnk-accent-text` / `--lnk-accent-border`（主题稳定）；反例 `--lnk-hi-bg/hi-text` 会随主题翻转 | **复用**：用 accent 三件套；禁用翻转令牌 |
| 独立设置页路由壳 | `/profile`、`/subscription`、`/points` 均为「返回 + 标题 + max-w 容器」的 PC 外壳页 | **对齐**：新建 `SettingsPage.vue` 沿用同一壳，不造新布局范式 |
| 模型配置弹层 | `ProviderConfigDialog`（v1 已令牌化 + A11y）、配置状态模块级单例、打开自加载 | **复用**：新页挂一个实例，数据层零改动 |
| 守卫 | `settings-domain-tokens.test.ts`（v1 建）+ `design-token/theme-usage/palette-parity/text-token-guard` | **复用并改写**：R2 判据从「ProfilePage 有 settings Tab」改为「/settings 路由 + 外观双选项 + 头像菜单入口」；不新建测试框架 |

## 1. 背景与问题

### 1.1 现状事实（已回 master 代码核对）

1. **入口层级错了**：v1 把「设置」做成 `ProfilePage.vue` 的第三个 Tab（`account | billing | settings`）。但用户期望的位置是头像下拉菜单里与「我的主页 / 个人资料 / 退出登录」**同级**的一级项。`AccountUserMenu.vue:110-135` 目前只有这三项，没有设置。
2. **外观没有区分**：v1 的设置面板外观行只有一个 `<ThemeToggle />` 图标按钮（`ProfilePage.vue:247-250`）。用户点开看不到浅色/深色长什么样、当前选了哪个——没有视觉区分。
3. **主题能力是二值**：`CanvasTheme = 'dark' | 'light'`，`useCanvasTheme` 只暴露 `toggleTheme`，无法「点浅色就设浅色」。
4. **不变式令牌现成可用**：`stamp-face-on-signature` / `stamp-ink-on-signature` / `surface-signature` / `text-on-signature` 均两主题同值，被 `design-token.test.ts` 守卫。

### 1.2 用户已拍板（本轮 AskUserQuestion）

- **Q1 落点**：新建独立 `/settings` 设置页，头像菜单「设置」直接跳转；移除个人中心里的设置 Tab。
- **Q2 外观区分**：做浅色/深色带缩略预览的双选项 + 稳定 accent 选中态；**不做**多套强调色（那是另一个量级）。

## 2. 目标 / 非目标

### 目标
- 头像菜单出现一级「设置」项，与主页/资料/登出同级，点击进独立设置页。
- 个人中心恢复为 `account | billing` 两个 Tab，不再有设置。
- 独立设置页含「外观」（浅/深双选项带预览 + 选中态）与「模型配置」（打开现有弹层）。
- 移动端链路、弹层令牌/A11y、竖轨删除等 v1 成果零回归。

### 非目标
- 不新增强调色维度（多主题色）。
- 不改 `ThemeToggle` 组件本身（画布/header 仍在用）。
- 不动 `ProviderConfigDialog` 内部（v1 已重构完）。
- 不做视觉截图回归。

## 3. 架构决策

- **AD1 设置页独立成路由**：`/settings` → `SettingsPage.vue`。理由：用户明确要求与「个人资料」等一级项同级，且「设置页」是页不是弹层；fold 进 Profile 会重蹈 v1 覆辙。
- **AD2 外观选择器落在设置页内，不改 ThemeToggle**：新写双选项卡片（纯展示 + `setTheme`），ThemeToggle 保持。理由：前者要展示两个选项与预览，是不同信息形态；强行给 ThemeToggle 加 `variant` 会污染一个被多处复用的简洁组件（违反其「无 props」设计约束）。
- **AD3 缩略预览用不变式令牌**：浅预览 `stamp-face-on-signature` 底 + `stamp-ink-on-signature` 示意条；深预览 `surface-signature` 底 + `text-on-signature` 示意条。理由：预览必须**恒定**示意各自主题，不随当前主题翻转，否则失去区分意义；这些 L2 令牌恰好两主题同值且被守卫，零新增、零 hex。
- **AD4 选中态用 accent 稳定色**：`border-accent-border` + `bg-accent-subtle` + `text-accent-text`。理由：`hi-bg/hi-text` 随主题翻转，深色下黑底白字，落上去会反色（v1 已踩过，见项目备忘）。
- **AD5 设置入口插在「个人资料」与「退出登录」之间**：登出恒为菜单末项。理由：设置属账号级操作，紧邻资料；登出垫底是通用菜单惯例。
- **AD6 设置页沿用 ProfilePage 登录守卫**：未登录 `auth.openLogin()`。理由：含账号级「模型配置」，与 ProfilePage 口径一致。

## 4. 详细设计

### R1 · 新增 `/settings` 路由与独立设置页
- `router/index.ts`：在 `/profile` 之后加 `{ path: '/settings', name: 'settings', component: () => import('@/pages/SettingsPage.vue') }`。
- 新建 `SettingsPage.vue`：
  - 外壳对齐 `ProfilePage`：`<div class="mx-auto max-w-3xl px-6 py-10">` + 返回按钮（`data-testid="settings-back"`）+ `<h1>设置</h1>`（保持每页唯一 h1）。
  - 登录守卫同 ProfilePage（`onMounted` 检查 `auth.isLoggedIn`）。
  - 外观卡片：标题「外观」+ 两个选项按钮：
    - 浅色：`data-testid="theme-option-light"`，`aria-pressed`，点击 `setTheme('light')`；缩略条用不变式浅令牌。
    - 深色：`data-testid="theme-option-dark"`，点击 `setTheme('dark')`；缩略条用不变式深令牌。
    - 选中态由 `theme === option` 决定，class 用 accent 三件套。
  - 模型配置行：`data-testid="open-model-settings"`，点击 `showModelSettings = true`（与 v1 同名 testid，便于守卫复用）。
  - `<ProviderConfigDialog v-model="showModelSettings" />` 挂页尾。

### R2 · 外观主题能力扩展（`useCanvasTheme.ts`）
- 新增 `function setTheme(value: CanvasTheme) { theme.value = value }`，加入返回对象。
- 现有 `watch(theme)` 负责写 localStorage + `applyTheme`（含 `.dark` class），新函数复用它，零重复逻辑。
- `theme` 是模块级单例 ref，设置页与 ThemeToggle 共享同一真相源。

### R3 · 头像菜单加一级「设置」项（`AccountUserMenu.vue`）
- `openSettings()`：`closeMenu(); void router.push('/settings')`。
- 菜单项插在「个人资料」按钮之后、「退出登录」之前：`data-testid="account-settings"`，文案「设置」，样式沿用 `neo-popover-item`，与其余三项同级同padding。

### R4 · 移除个人中心设置 Tab（`ProfilePage.vue`）
- imports 删除 `ProviderConfigDialog`、`ThemeToggle`。
- `type ProfileTab` 回退为 `'account' | 'billing'`；`activeTab` 删除 `settings` 分支。
- `showModelSettings` ref 删除；tab 列表删除 `['settings','设置']`；`panel-settings` 整块删除；`<ProviderConfigDialog ... />` 删除。
- 移动端 `ProfilePane` / `CanvasPage` 竖轨入口不动。

### R5 · 守卫与测试改写
- `settings-domain-tokens.test.ts`：
  - R1（竖轨无 open-settings）、R3（弹层 --neo- 归零）、R4（A11y 标题 id）判据保留。
  - R2 判据改写：断言 `router/index.ts` 含 `/settings`；`SettingsPage.vue` 含 `theme-option-light`/`theme-option-dark`/`open-model-settings` 且用法正确；`AccountUserMenu.vue` 含 `account-settings` 且 `router.push('/settings')`；`ProfilePage.vue` **不再含** `panel-settings`（反转判据，锁死返工不回退）。
  - 新增外观令牌判据：设置页用 `stamp-face-on-signature`/`surface-signature` 做预览、用 `accent-subtle`/`accent-text` 做选中态；禁用 `hi-bg/hi-text` 于选中行。
- `AccountUserMenu.test.ts`：加「设置项存在 + 点击到 /settings」用例；保留既有用例。
- `ProfilePage.test.ts`：删除 v1 加的两个 settings Tab 用例与两个 stub mock，恢复纯 account/billing。
- 新建 `SettingsPage.test.ts`：外观双选项渲染/选中态/点击 setTheme/aria-pressed、模型配置开弹层、登录守卫。
- `useCanvasTheme` 行为：在 `SettingsPage.test.ts` 用 `vi.resetModules()` + 动态 import 复现 DOM 真相源，断言 `setTheme('light')` 落地 DOM + localStorage（不改 ThemeToggle.test）。

## 5. 变更影响面矩阵

| 文件 | 改动 | 破坏风险 |
|---|---|---|
| `router/index.ts` | 加 /settings | 路由顺序、懒加载 chunk 名变化 → 部署取证需换特征 |
| `SettingsPage.vue`（新） | 全新 | h1 唯一性、登录守卫、令牌合规 |
| `useCanvasTheme.ts` | 加 setTheme |  observação: watch 链路不变；ThemeToggle 仍可用 toggleTheme |
| `AccountUserMenu.vue` | 加设置项 | 菜单布局、点击 outside 关闭、既有用例 |
| `ProfilePage.vue` | 回退 settings Tab | 影响 v1 的测试与守卫 → 必须同步改写 |
| `settings-domain-tokens.test.ts` | R2 反转 + 新增外观判据 | 守卫若锁错对象会假绿 → 变异自检 |
| `scripts/fixtures/pc-canvas-legacy-manifest.json` | 若登记 router/Profile 行数需同步 | v1 已因 CanvasPage 行数漂移踩过 → 本轮先跑 verify 脚本实测 |

## 6. 测试策略
- TDD：每刀先写失败测试 → RED → 实现 → GREEN → 提交。
- 定向 vitest：`--maxWorkers=1 --no-file-parallelism`（node24）。
- 视觉守卫全回归：design-token / theme-usage / palette-parity / text-token-guard / settings-domain-tokens。
- 静态脚本：`verify-pc-canvas-legacy-scope.py`、`verify-pc-visual-regression.py`（行数登记同步）。
- 类型检查：`pnpm --filter @lnkpi/web exec vue-tsc -b`。
- 变异自检：对 R1/R2/R3/R4 守卫各做一次「改坏源码→守卫转 RED→还原」，确认守卫证伪能力。

## 7. 验收判据（DoD）
1. 头像菜单出现「设置」一级项，点击到 `/settings`。
2. 个人中心只有账户/用量两个 Tab，无设置。
3. 设置页外观有两个带预览的选项，选中态双主题清晰可辨；点击可切换并落地 DOM/localStorage。
4. 模型配置按钮打开现有弹层，令牌/A11y 无回归。
5. 全量定向测试 + 4 视觉守卫 + 2 静态脚本 + 类型检查全绿；变异自检 4/4 转 RED。
6. CI 全绿 → squash 合并 → web 部署 → 生产取证命中新特征串 → CDP 目视走查双主题外观选项。

## 8. 风险与边界
- 生产 CDP 走查深浅主题选项需同一会话内切主题再截图（主题存在模块 ref + DOM，`Emu` 参数跨脚本会丢）。
- 弹层宽度 980px 决策（v1 AD2）不变。
- 不做截图回归；审美正确性由用户在评审/生产走查确认。

## 9. 变更记录
- 2026-11-19 v2：用户返工——入口层级改头像一级项 + 独立 /settings 页；外观改浅/深双选项带预览。
