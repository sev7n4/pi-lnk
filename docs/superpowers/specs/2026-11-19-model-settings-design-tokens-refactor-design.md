# 模型设置页入口收敛与 design-tokens 重构设计

> 日期：2026-11-19
> 状态：待评审（spec）
> 范围：PC 画布页【设置】入口迁移 + 设置域按 `design-tokens.css` 重构
> 令牌 SSOT：`apps/web/src/styles/design-tokens.css`；视觉 SSOT：`docs/design/Design_system.md`（墨流 Ink Flow）

---

## 0. 第一原则与等价物检索结论

**第一原则：吃满上游、不重复造轮子。** 任何新增组件/字段/守卫前，先检索等价物；能接线就不新建；禁止造数、禁止自报。

| 候选动作 | 等价物检索结果 | 结论 |
|---|---|---|
| 新建「设置行 / 设置卡片」公共组件 | 无 `SettingRow`/`BaseDialog`；移动端 `ProfilePane` 有私有 `row-item` 样式 | **不新建公共组件**。PC 用 `ProfilePage` 现有语义类体系写，移动端保留私有样式；两端形态不同（路由页 vs App 页签），强行共用会引入条件分支 |
| 弹层 A11y（role/aria-modal/焦点陷阱/Esc）自实现 | Element Plus 2.14.2 `el-dialog` 内置 `role=dialog`、`aria-modal`、焦点陷阱、`close-on-press-escape`（默认开） | **复用上游**，实施时用 DOM 断言核验四证；仅补自定义 header 的 `aria-labelledby` |
| 新增颜色/间距令牌 | `design-tokens.css` 已有全部所需 L2 语义令牌 + `tailwind.config.js` 语义类 | **不新增令牌**，全部消费现有 `--lnk-*` / 语义类 |
| 配置状态管理改造 | `useProviderBootstrap` 模块级单例 + 弹层 `watch(open)` 自加载 | **零改动**，换挂载点天然安全 |
| 新建视觉守卫测试框架 | 已有 `design-token.test.ts` / `theme-usage.test.ts` / `text-token-guard.test.ts` | **复用现有守卫**，仅新增一条针对设置域的静态接线判据 |

---

## 1. 背景与问题

用户在 PC 画布页左上角竖轨看到【设置】入口，与移动端「用户信息 → 设置 → 模型配置」的路径不一致，提出两点：

1. 去掉 PC 画布页菜单里的【设置】入口，存放位置是否与移动端一样收敛到用户信息【设置】页 -【模型配置】？
2. 整个设置页遵循 `design-tokens.css` 做一轮重构。

### 1.1 现状事实（已回代码核对，非推测）

| # | 事实 | 证据 |
|---|---|---|
| F1 | PC 竖轨【设置】按钮 emit `open-settings`，`CanvasPage` 接为 `showModelSettings = true` | `NodePanelDock.vue:214-232`、`:19`；`CanvasPage.vue:6553`、`:391` |
| F2 | 移动端【设置 → 模型配置】emit `open-model-settings`，同样汇入 `showModelSettings = true` | `ProfilePane.vue:167-172`、`MobileCanvasShell.vue:371`、`CanvasPage.vue:6669` |
| F3 | 两端打开的是**同一个** `ProviderConfigDialog`（标题「配置与用户偏好」，4 Tab：渠道/模型/生成偏好/WebDAV） | `ProviderConfigDialog.vue:602-620` |
| F4 | PC 用户中心 `ProfilePage.vue`（路由 `/profile`）只有 `account`/`billing` 两 Tab，**无设置区** | `ProfilePage.vue:17-27`、`:107` |
| F5 | 弹层全篇旧 `--neo-*` 令牌（模板 ~24 处 + style 段 ~10 处），无裸 hex/rgba/text-white | `ProviderConfigDialog.vue:613-1027`、`:1064-1124` |
| F6 | `ProfilePage.vue` / `ProfilePane.vue` 已合规：ProfilePage 用语义类（`text-fg`/`bg-surface-elevated`），ProfilePane 全用 `--lnk-*` | 静态核对 |
| F7 | 配置数据是模块级单例，弹层 `watch(open)` 打开时 `load(true)` 自加载 → 换宿主页无需改数据层 | `useProviderBootstrap.ts:11-14`、`ProviderConfigDialog.vue:234-246` |
| F8 | 顶栏「⋯」菜单已于 2026-10-30 移除（`WorkspaceTopBar.vue:9-11`），本项目无第二个画布设置入口 | 静态核对 |

**结论**：问题 1 的答案是「是」。同一功能存在两个入口、且 PC 入口落在错误的域（画布工具区），应收敛到用户域。

---

## 2. 目标 / 非目标

### 目标
- G1：PC 画布页不再有【设置】入口；PC 用户在 `/profile` 通过新增「设置」Tab 进入【模型配置】。
- G2：设置域（PC 设置 Tab + `ProviderConfigDialog` + 移动端设置区）全部遵循 `design-tokens.css`，`--neo-*` 在设置域归零。
- G3：弹层满足设计系统 §3.4 A11y 契约（复用上游 + 补 `aria-labelledby`）。
- G4：两端入口/行为可测、guided by 静态守卫，防回归。

### 非目标
- N1：不改配置数据层、API、提示词、服务端。
- N2：不新建公共设置组件（见 §0）。
- N3：不动画布域其它 `--neo-*`（`NodePanelDock`、`CanvasBottomLeftControls`、`AccountUserMenu` 等）——聚焦设置域，画布域清理另案。
- N4：不改移动端信息架构（移动端的设置区已合规，仅做令牌校准核验）。
- N5：不做深浅主题的视觉回归截图基建（已有 `design-token.test.ts` 静态守卫覆盖）。

---

## 3. 已拍板决策

| # | 决策 | 用户选择 |
|---|---|---|
| D1 | PC 用户中心用**新增「设置」Tab** 承载模型配置入口（与账户/用量并列），而非在账户页加卡片区 | 新增「设置」Tab |
| D2 | 本轮重构边界=**设置域为主**：`ProviderConfigDialog` 全量迁 `--lnk-*` + PC 新增设置区 + 移动端设置区令牌校准；画布域其它 `--neo-*` 另案 | 设置域为主 |

### 3.1 架构决策（我作为负责人拍板，理由记录于此）

- **AD1 弹层挂载点**：`ProviderConfigDialog` 保持单组件实现，两个宿主页各挂一个实例——`ProfilePage`（PC 新入口）与 `CanvasPage`（移动端入口，ProfilePane 在画布 shell 内）。理由：数据层是模块级单例 + 打开自加载，双实例无状态冲突；提升到 App 级全局单例需引入新的全局 store 概念，超出范围且与 N1 冲突。
- **AD2 弹层宽度**：保留 `980px` 但改为 `width="min(980px, 96vw)"`。理由：模型配置是高密度表格（渠道列表、模型勾选），强行套 §3.4 的 xl=800 会挤压表格；用响应式上限兼顾窄屏。此为视觉细节的产品判断，如需严格 800 可在评审推翻。
- **AD3 移动端设置区**：`ProfilePane` 已全用 `--lnk-*`，本轮只核验不改结构；若发现个别硬编码再就地校准。

---

## 4. 详细设计

### R1 · 入口收敛（PC 去竖轨设置按钮）

| 文件 | 改动 |
|---|---|
| `NodePanelDock.vue` | 删除【设置】按钮块（`:214-232`）、`open-settings` emit 声明（`:19`）及触发它的 tooltip/title。竖轨其余按钮不变 |
| `CanvasPage.vue` | 删除 `@open-settings="showModelSettings = true"` 绑定（`:6553`）；保留 `showModelSettings` ref 与移动端 `:open-model-settings` 绑定（`:6669`）及弹层实例（`:6697`） |
| 判据 | PC 画布 DOM 不再有 `title="模型服务配置"` 的按钮；移动端入口仍可打开弹层 |

> 注意：`CanvasPage.mobileEntryWiring.test.ts:32` 的注释明确「设置 emit 保留」，指移动端 `open-model-settings`；R1 删除的是 PC 的 `open-settings`，两者不要混淆。

### R2 · PC 新增「设置」Tab

`ProfilePage.vue`：

| 项 | 设计 |
|---|---|
| Tab 类型 | `ProfileTab = 'account' \| 'billing' \| 'settings'`；`activeTab` 解析 `?tab=settings` |
| Tab 条 | 数组加 `['settings', '设置']`，保持 `role=tablist` / `aria-selected` / `aria-controls` 契约 |
| 面板 `panel-settings` | 复用现有 `space-y-4` + 卡片语义类；含两行：「外观」→ `<ThemeToggle />`；「模型配置」→ 可点击行，打开弹层 |
| 弹层实例 | 页内新增 `const showModelSettings = ref(false)` + `<ProviderConfigDialog v-model="showModelSettings" />`（组件从 `@/components/canvas/ProviderConfigDialog.vue` 引入） |
| 入口一致性 | 头像菜单 `AccountUserMenu.vue` 的「个人资料」跳 `/profile?tab=account` 不变；用户在 Tab 条上点「设置」即可到达 |
| 文案 | 入口标签统一叫「模型配置」（与移动端一致，不另造「配置模型」）；遵循设计系统 §4：专业克制、第二人称，弹层内按钮避免「确定/取消」 |

### R3 · 弹层令牌重构（设置域主战场）

`ProviderConfigDialog.vue` 模板 + `<style>` 段，按 §0 等价物结论全量映射：

| 旧写法 | 新写法（Tailwind 语义类 / CSS 变量） |
|---|---|
| `text-[var(--neo-text-primary)]` | `text-fg` |
| `text-[var(--neo-text-secondary)]` | `text-fg-2` |
| `text-[var(--neo-text-muted)]` | `text-fg-3` |
| `text-[var(--neo-warm)]` | `text-warning` |
| `border-[var(--neo-border)]` | `border-line`（或 `border-line-subtle`） |
| `var(--neo-surface-card)` | `var(--lnk-surface-raised)` / `bg-surface-elevated` |
| `var(--neo-accent-text)` | `var(--lnk-accent-text)` / `text-fg-accent` |
| `var(--neo-accent)` | `var(--lnk-accent)` / `bg-accent` |
| `var(--neo-hover-bg)` | `var(--lnk-hover-overlay)` |
| `var(--neo-text-disabled)` | `var(--lnk-text-disabled)` / `text-fg-disabled` |
| style 段裸圆角 `8px`/`6px` | `var(--lnk-radius-md)` / `var(--lnk-radius-sm)` |
| 能力标签裸 `font-size: 11px` | `var(--lnk-text-2xs)`（纯英文缩写可用；中文场景禁用 2xs，见设计系统 F-2） |

> 迁移后 `ProviderConfigDialog.vue` 的 `--neo-*` 计数必须为 **0**。warning 三件套（`border-warning-border bg-warning-bg`）已是新令牌，保留。

### R4 · 弹层 A11y（复用上游 + 补缺口）

| 契约 | 来源 | 动作 |
|---|---|---|
| `role=dialog` / `aria-modal=true` | Element Plus `el-dialog` 内置 | 复用；实施时用 DOM 断言核验 |
| 焦点陷阱 | `el-dialog` 内置 | 复用；核验打开后焦点落在弹层内 |
| Esc 关闭 | `el-dialog` `close-on-press-escape` 默认开 | 复用；**确认未被显式关闭**（当前未设 false） |
| `aria-labelledby` 指向标题 | 自定义 `#header` slot，上游无法自动关联 | 补：header 标题加 `id="provider-config-title"`，`el-dialog` 加 `aria-labelledby="provider-config-title"` |

### R5 · 移动端设置区令牌校准

- `ProfilePane.vue` 已是 `--lnk-*`，本轮核验不改结构；若无硬编码则零改动，在验收证据中记录「核验通过」。

---

## 5. 变更影响面矩阵（改什么会静默坏什么）

| 改动 | 潜在风险 | 防线 |
|---|---|---|
| 删 `open-settings` emit | 若有其它调用方残留 → 编译/类型报错 | 全仓 grep `open-settings` 归零（仅测试注释可留） |
| `ProfilePage` 加 `settings` Tab | `activeTab` 解析漏 `settings` → Tab 无法选中 | 单测锁 `?tab=settings` 解析 |
| 弹层换宿主页 | 数据没加载 → 空弹层 | 保留 `watch(open) → load(true)`；E2E/组件测确认打开后触发 bootstrap |
| 令牌替换 | 语义类映射错（如 `--neo-warm` 误用 credit）→ 颜色语义漂移 | 逐条按 §R3 映射表 + `design-token.test.ts` / `text-token-guard.test.ts` |
| `aria-labelledby` | id 拼错 → 无关联 | DOM 断言 `aria-labelledby` 指向存在元素 |
| 弹层宽度 `min()` | 老浏览器不支持 min() → 宽度异常 | 现代浏览器基线；保留 `max-width:96vw` 兜底 |

---

## 6. 测试策略

| 层 | 判据 | 位置 |
|---|---|---|
| 静态守卫 | `ProviderConfigDialog.vue` 中 `--neo-*` 计数 == 0（新增一条接线判据，锁规则本体：出现任一 `--neo-` 即红）；同时断言 PC 竖轨无「模型服务配置」按钮、`ProfilePage` 的 `?tab=settings` 接线存在 | 新增 `settings-domain-tokens.test.ts`（单一职责，不塞进既有守卫） |
| 组件单测 | PC 设置 Tab 渲染 + `?tab=settings` 解析 + 点「配置模型」弹层 `v-model` 置真 | `ProfilePage.test.ts` |
| 组件单测 | 删按钮后竖轨无 `title="模型服务配置"`；移动端 `open-model-settings` 仍接线 | `NodePanelDock` / `CanvasPage.mobileEntryWiring.test.ts` |
| 组件单测 | 弹层打开触发 `load(true)`；`aria-labelledby` 指向存在标题；Esc 关闭未被禁 | `ProviderConfigDialog.test.ts` |
| 回归 | `design-token.test.ts`（92 断言）/ `theme-usage.test.ts`（棘轮）/ `palette-parity.test.ts` 全绿 | 既有 |
| 命令 | `vitest --maxWorkers=1 --no-file-parallelism`（nvm node24）；`vue-tsc -b` 不带 `--noEmit` | `docs/agent/delivery.md` |

---

## 7. 验收判据（DoD）

1. PC 画布页无任何【设置】入口；`/profile?tab=settings` 可见「外观 + 配置模型」。
2. 点「配置模型」打开「配置与用户偏好」弹层，4 Tab 数据正常加载（bootstrap 触发）。
3. 移动端「我的 → 设置 → 模型配置」仍打开同一弹层，行为无回归。
4. `ProviderConfigDialog.vue` 的 `--neo-*` 计数为 0；设置域其它文件无新增硬编码颜色。
5. 弹层 DOM：`role=dialog` + `aria-modal=true` + `aria-labelledby` 指向真实标题 + Esc 可关。
6. 全量单测 + 类型检查 + 三个视觉守卫全绿。
7. 静态守卫锁死 R1/R3/R4：删按钮、令牌归零、A11y 接线任一回退即 CI 红。

---

## 8. 风险与边界

- **R-1 移动端与 PC 双弹层实例**：两实例并存于不同路由/壳层，无同屏冲突；未来若要做「画布内快捷入口」需重新评估，本轮不做。
- **R-2 视觉回归未覆盖**：本轮靠静态守卫 + 单测，不做截图回归；审美正确性在评审阶段由用户目视确认（见 §3.1 AD2 宽度决策）。
- **R-3 画布域残留 `--neo-*`**：`NodePanelDock`/`CanvasBottomLeftControls`/`AccountUserMenu` 仍有旧令牌，按 N3 不在本轮，避免范围蔓延。
- **诚实边界**：本轮不证明「设置项比移动端少」（PC 无触感反馈，因 haptics 是移动端能力）；两端入口语义对齐，但字段按各自平台裁剪。

---

## 9. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-19 | 初稿：入口收敛 + 设置域 design-tokens 重构；含第一原则检索表、等价物结论、已拍板决策、5 刀设计、影响面矩阵、测试与 DoD |
