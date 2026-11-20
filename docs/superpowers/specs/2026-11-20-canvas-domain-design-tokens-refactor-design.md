# PC 画布域 design-tokens 遵从性盘查与重构设计

> 日期：2026-11-20
> 状态：待评审（spec）—— **本轮只做盘查 + 方案，不改代码**
> 范围：PC 画布页（`/workflow/:sessionId` = `CanvasPage.vue`）及其可见 chrome（顶栏 / 左侧竖轨 / 底部缩放条 / 悬浮工具条 / 画布内浮层与对话框）
> 令牌 SSOT：`apps/web/src/styles/design-tokens.css`；视觉 SSOT：`docs/design/Design_system.md`（墨流 Ink Flow）
> 姊妹规格：`2026-11-19-model-settings-design-tokens-refactor-design.md`（其 N3「画布域另案」即本文件）

---

## 0. 第一原则与等价物检索结论

**第一原则：吃满上游、不重复造轮子。** 任何新增组件/字段/守卫前先检索等价物；能接线就不新建；禁造数、禁自报。

| 候选动作 | 等价物检索结果 | 结论 |
|---|---|---|
| 新建令牌映射表 / 重构方法 | `2026-11-19-model-settings-design-tokens-refactor-design.md` §R3 已有完整 `--neo-* → --lnk-*` 映射；`tailwind.config.js:26-109` 已有语义类（`text-fg*` / `bg-surface-*` / `border-line` / `bg-dim` / `accent`） | **直接复用**，本文件 §4 沿用同一映射，不另造命名 |
| 新建设计令牌 | `design-tokens.css` 已含全部 L1/L2/L3 + 状态三件套 + overlay/dim 通道；`--lnk-surface`/`--lnk-hover` 的缺位不是「缺令牌」而是「写错名字」（正确名是 `surface-base` / `hover-overlay`） | **不新增令牌**，只改错误引用 |
| 新建视觉守卫框架 | 已有 `design-token.test.ts`（92 断言）、`theme-usage.test.ts`（9 类棘轮 + 白字 rgba 棘轮 + 4 机制不变量）、`text-token-guard.test.ts`、`palette-parity.test.ts`；`theme-usage-baseline.json` 管存量 | **复用现有守卫**；棘轮存量用下调基线方式消化，不新建框架 |
| 用 CDP 截图回归基建 | 无现成双主题截图 diff 基建；`Design_system.md §6.3` 将其列为待建 | **本轮不做基建**；用一次性 CDP 探针取证（已做，见 §2 F9），静态守卫为准 |
| 把 `--neo-*` 一次性全量 codemod 归零 | `--neo-*` 是**双主题完整的独立色板**（`neowow-tokens.css` 深色 65 变量 / 浅色成对覆写，含 `--neo-bg` 深 `#131318` 浅 `#eef0f5`），由棘轮管理，非失效令牌 | **不全量改**；分域分批，每批下调 `theme-usage-baseline.json`，与设置域策略一致 |

---

## 1. 目标 / 非目标

### 目标
- G1：盘清 PC 画布域「未遵从 design-tokens」的**全部**位置，并区分「真正违规 / 棘轮存量 / 合法例外」三类边界。
- G2：给出可分批实施的重构方案，每批独立可测、可回滚，不动内容性配色。
- G3：修复 2 处「静默失效令牌」（写了 `--lnk-*` 但该变量未定义）及其**反向锁死bug的测试**。

### 非目标
- N1：本轮不改任何代码（规格阶段）。
- N2：不改画布节点内容性配色（节点类型色、连线色、媒体遮罩、Refine 深蓝子品牌）——这些双主题翻转反而是错的（Design_system §7.2）。
- N3：不动服务端 / 提示词 / 工具分层。
- N4：不做双主题截图 diff 基建。

---

## 2. 现状事实（已回代码核对 + CDP 目视，非推测）

| # | 事实 | 证据 |
|---|---|---|
| F1 | `--lnk-surface` 与 `--lnk-hover` **全 src 无定义**；`AppHeader.vue:141` 写 `background: var(--lnk-surface)`、`WorkspaceTopBar.vue:159` 写 `var(--lnk-hover, rgba(0,0,0,.05))` ⇒ 两条声明静默失效（背景透明 / 回落到裸 rgba） | grep 全 src 无定义；正确令牌是 `--lnk-surface-base` / `--lnk-hover-overlay` |
| F2 | `AppHeader.galleryBareBar.test.ts:64` **断言锁死了失效写法** `var(--lnk-surface)`——测试反而成为维持 bug 的守卫，改令牌必须先改这条断言 | 该文件第 64 行 |
| F3 | `neowow-tokens.css` 的 `--neo-*` 是**双主题完整的独立色板**（`:39 --neo-bg:#131318` / `:201 --neo-bg:#eef0f5`），不是别名链；与 `design-tokens.css` 构成**双源** | `neowow-tokens.css:39,165,201` |
| F4 | `main.css` 有 **77 处 `--neo-*`**，是 `.neo-chrome/.neo-glass-lite/.neo-popover/.neo-ctl/.neo-dock-panel-*` 等 chrome 根类的样式来源——顶栏/竖轨/悬浮条都经它上色，改一处收益最大 | grep 计数 77 |
| F5 | `CanvasBottomLeftControls.vue`（截图右下缩放条）27 处 `--neo-*` + 2 处写死 rgba（小地图 mask）；`CanvasFloatingChrome.vue` 5 处；`DockStudioToolbar.vue` 2 处 | 代理扫描 + 回读行号 |
| F6 | CDP 双主题目视：生产画布页浅色/深色切换正常，`agent-side-rail` 深 bg `rgb(19,19,24)` / 浅 bg `rgb(238,240,245)` 均来自语义令牌；截图可见 chrome **无白字消失类显性事故** | CDP `22x3` 探针（一次性，已清理） |
| F7 | CDP 左下角圆钮 `.agent-fab` 是 `NeoAgentLogo` 品牌 IP（conic-gradient aura + img），`backgroundColor:transparent` 是有意设计——合法例外，非穿帮 | `elementFromPoint` + computed style |
| F8 | 少量**真·漏网**写法：`AgentSideRail.vue:5153 #f87171` 裸状态 hex、`:5434 color-mix(#fff)`；`ByokFallbackConfirmDialog.vue:57 bg-indigo-500`；`ImageDockPanel.vue:388 indigo 三件套`；`PromptDockPanel.vue:59 fuchsia`；`VideoSettingsSelector.vue:322,334 bg-black/25`；`MultiSelectToolbar.vue:562-574` 四处状态 hex；`RefineSidePanel.vue:967-969` 亮紫粉 | 两代理扫描 + 部分回读 |
| F9 | 一处需单独确认的映射风险：`WorkspaceTopBar.vue:159` 的 `--lnk-hover` 若改为 `--lnk-hover-overlay`，深度与当前裸 `rgba(0,0,0,.05)` 不同（后者在浅色下偏黑）；应走语义令牌并接受轻微视觉差异 | 代码 + 令牌值对比 |
| F10 | 姊妹规格的映射表已覆盖 F5/F8 全部类别（`--neo-text-*→text-fg*`、`bg-black/遮罩→bg-dim`、`indigo/fuchsia→accent`、裸状态 hex→`text-danger/warning` 三件套） | `2026-11-19-...` §R3 |

---

## 3. 边界裁定：三类分界（本盘查的核心交付）

| 类别 | 判定 | 内容 | 处置 |
|---|---|---|---|
| **A. 真违规（新增/漏网）** | 违反 L2-only、且不在棘轮基线豁免内 | F8 全部（indigo/fuchsia 默认色板、裸 hex、裸白 hex、错误 rgba、写死 mask rgba）+ F1 两处静默失效令牌 | **改**，按 §4 映射 |
| **B. 棘轮存量（双源）** | `--neo-*` 双主题完整、已被 `theme-usage.test.ts` 棘轮管理 | `main.css` 77、`CanvasBottomLeftControls` 27、`CanvasFloatingChrome` 5、`AgentSideRail` 局部、各 dialog/chip 约 30 | **分批迁移**，每批下调 `theme-usage-baseline.json` 对应项；不追求一次归零 |
| **C. 合法例外** | 内容性/品牌性/恒黑遮罩，主题翻转反而错 | 画布节点类型色与选中环、连线 `#818cf8/#7c3aed`、媒体恒黑 scrim、Refine 深蓝子品牌、`NeoAgentLogo`、验证码深卡、二维码白底、HTML 纸白预览、`color-mix(var(--lnk-*))` / `rgb(var(--lnk-overlay-rgb)/A)` 合规通道 | **不改**，在守卫白名单/注释中标注理由 |

> ⚠️ 边界判据一句话：**「是否内容语义色」而非「是否硬编码」**。节点连线色写死 `#818cf8` 是内容（连线本就该那个色），按钮写死 `#f87171` 是 UI（应走 `text-danger`）——外观相同，裁定相反。

---

## 4. 详细设计：分批重构

### R0 · 修静默失效令牌 + 反向测试（最小、最高优先）

| 文件 | 改动 |
|---|---|
| `AppHeader.vue:141` | `background: var(--lnk-surface)` → `background: var(--lnk-surface-overlay)`（毛玻璃顶栏语义；若评审要求不透明则用 `surface-base`）。同时 `:138` 的裸时长 `0.25s` → `var(--lnk-duration-base)`（可选，同批） |
| `AppHeader.galleryBareBar.test.ts:64` | 断言从 `var(--lnk-surface)` 改为 `var(--lnk-surface-overlay)`——**这一步是关键**：不改测试则改实现必红，改测试才让守卫重新指向正确目标 |
| `WorkspaceTopBar.vue:159` | `background: var(--lnk-hover, rgba(0,0,0,0.05))` → `background: var(--lnk-hover-overlay)`；去掉裸 rgba fallback |
| 判据 | 全 src `grep -rn -- '--lnk-surface)'` 与 `--lnk-hover(` 归零；CDP 双主题下 `.app-header.is-material` computed 背景为非空 |

### R1 · 真漏网的默认色板 / 裸 hex（高信号、低风险）

复用姊妹规格 §R3 映射表：

| 文件:行 | 旧 | 新 |
|---|---|---|
| `ByokFallbackConfirmDialog.vue:57` | `bg-indigo-500 hover:bg-indigo-400` | `bg-accent hover:bg-accent-hover` |
| `ImageDockPanel.vue:388` | `border-indigo-400/20 bg-indigo-500/10 text-indigo-200/90` | `border-accent bg-accent-subtle text-fg-accent` |
| `PromptDockPanel.vue:59` | `bg-fuchsia-500/15 text-fuchsia-300` | `bg-accent-subtle text-fg-accent` |
| `VideoSettingsSelector.vue:322,334` | `bg-black/25` | `bg-surface-sunken`（输入框凹面） |
| `MultiSelectToolbar.vue:562,565,571,574` | `color:#f87171 / #fca5a5 / #fbbf24 / #fcd34d` | `var(--lnk-error)` / `var(--lnk-warning)`（或语义类） |
| `AgentSideRail.vue:5153` | `background:#f87171` | `var(--lnk-error)` |
| `AgentSideRail.vue:5434` | `color-mix(in srgb, #fff 42%, transparent)` | `rgb(var(--lnk-overlay-rgb) / .42)` |
| `RefineSidePanel.vue:967-969` | 亮紫粉 `rgb(232 121 249)` 系 | `var(--lnk-accent-subtle)` / `var(--lnk-accent-text)`（先确认非 Refine 子品牌） |

判据：这几处文件的新写法计数归零；`design-token.test.ts` / `theme-usage.test.ts` 棘轮不增（`inline-rgba` 应下降）。

### R2 · 白底黑字按钮 / 输入框（中信号，需逐处确认语义）

`NodeElementEditOverlay.vue:1106-1107`、`AnnotateOverlay.vue:575-576`、`NodeCropOverlay.vue:508-509`、`NodeOutpaintOverlay.vue:510-511`、`NodeInpaintOverlay.vue:684-685`、`refine/ElementEditPanel.vue:331-332,444-445`、`refine/ReplaceImagePicker.vue:260-261`：
`background:#fff; color:#111` → 主按钮用 `bg-accent + text-on-accent`，输入框用 `bg-surface-sunken + text-primary`（**不是一律 accent**，按元素语义选）。

**风险**：这些浮层盖在恒深工具层上，白底黑字可能是刻意的高对比设计（ Design_system §2.3 反直觉取舍的同类）。每处改前需确认：`data-theme=light` 下它落在什么表面？改错比不改更糟 ⇒ 本批改完必须 CDP 双主题目视。

### R3 · 底部缩放条（截图肉眼可见，B 类存量先行）

`CanvasBottomLeftControls.vue`：27 处 `--neo-*`（slider accent / border / text / hover / hi-* / active-bg）+ mask 两处写死 rgba。
按 §R3 映射表逐条替换；`theme-usage-baseline.json` 的 `inline-rgba` 相应下调 2。
先做这一个组件（而非 main.css 全量），因为它是截图里用户直接看到的部分，收益/风险比最好。

### R4 · chrome 根类收敛（收益最大，风险最高，最后做）

`main.css` 77 处 `--neo-*`（`.neo-chrome` / `.neo-glass-lite` / `.neo-popover` / `.neo-ctl` / `.neo-dock-panel-*` / `.dock-seg-btn` 等）统一映射到 L2。
这是**双色板并存的总闸**：改完后 `--neo-*` 只剩 `neowow-tokens.css` 定义本身 + 少数内容性文件。
必须与 `NeoBaseNode` / 节点样式一起回归——节点层大量复用这些 chrome 类。建议单独一个 PR，CDP 双主题全页走查。

### R5 · 不全量改的部分（永久边界）

F10/C 类合法例外保持；`theme-usage-baseline.json` 保留其计数并在注释里写明「内容性保留，见本规格 §3/C」，防止未来被误当漏扫。

---

## 5. 变更影响面矩阵

| 改动 | 潜在风险 | 防线 |
|---|---|---|
| 改 `var(--lnk-surface)` | 测试 `AppHeader.galleryBareBar.test.ts:64` 锁死旧值 → 必红 | R0 同步改测试断言（同批，不可拆） |
| `bg-black/25 → bg-surface-sunken` | 浅色下输入框与容器同亮 → 凹陷感丢失 | CDP 双主题目视；令牌值对比 |
| 白底黑字按钮 → accent | 白字压 accent 渐变末端仅 3.67:1（F-5 已知） | 用实色 `bg-accent` 不用 gradient；`design-token.test.ts` F-5 段守卫 |
| `main.css` chrome 类批量替换 | 节点层复用同类 → 画布全页面貌漂移 | 放最后单独 PR；CDP 全页双主题走查；棘轮只减不增 |
| 下调 `theme-usage-baseline.json` | 下调过头 → 棘轮失去保护 | 每次下调数 = 本批实测减少数，PR 写明前后值 |

---

## 6. 测试策略

| 层 | 判据 | 位置 |
|---|---|---|
| 静态守卫 | R0 后 `--lnk-surface)` / `--lnk-hover(` 全 src 归零；测试断言同步指向新令牌 | 新增 `canvas-domain-tokens.test.ts`（单一职责，锁 R0/R1 规则本体） |
| 回归 | `design-token.test.ts`（92）/ `theme-usage.test.ts`（9 类棘轮）/ `text-token-guard.test.ts` / `palette-parity.test.ts` 全绿；棘轮计数只减不增 | 既有 |
| 组件单测 | 顶栏 material 背景 computed 非空（R0）；漏网色板类归零（R1） | `AppHeader.galleryBareBar.test.ts` + 新守卫 |
| CDP 取证 | 每批后双主题打开 `/workflow/<id>`：顶部/竖轨/底部条文字可读、无突兀白块；截图存档 | 一次性探针，不入基建 |
| 命令 | `vitest --maxWorkers=1 --no-file-parallelism`（nvm node24）；`vue-tsc -b` 不带 `--noEmit` | `docs/agent/delivery.md` |

---

## 7. 验收判据（DoD）

1. PC 画布域 A 类真违规（F8 + F1）全部归零，B 类存量按批下调基线、每批可追溯。
2. C 类合法例外逐条标注理由（注释或守卫白名单），不被未来误扫。
3. `var(--lnk-surface)` / `var(--lnk-hover)` 全 src 归零，且 `AppHeader.galleryBareBar.test.ts` 断言指向正确令牌。
4. `design-token.test.ts` 92 断言 + `theme-usage.test.ts` 全绿，棘轮计数只减不增。
5. CDP 双主题目视：截图里顶栏 / 竖轨 / 底部缩放条 / 节点标题文字清晰、无白字消失、无突兀白块。
6. 每批独立 PR + 独立测试，不做成一个大爆炸 PR。

---

## 8. 风险与诚实边界

- **本轮零代码改动**：所有行号基于 2026-11-20 工作树；实施时若已有其它 PR 动过同文件，按实际行号重新定位。
- **CDP 证据的边界**：一次性探针只覆盖了截图对应的一个画布页 + 深浅两主题；未穷举所有浮层/对话框在各主题下的组合。静态守卫 + 分批目视才是完整防线。
- **`--neo-*` 不是 bug**：它是完整双主题色板（F3），本方案的目标是**收敛双源**，不是修失效。把它当 bug 全量 codemod 会制造大规模视觉回归。
- **视觉正确性已由评审拍板（2026-11-20）**：R0 裁定 `surface-overlay`、R2 裁定「C 类例外保留，不改」，理由见 §10（含 §10.3 双主题实测复核）。原「实施前请确认」已关闭。
- **CDP 边界补充**：§10.2 初稿误判「浮层恒深」，经双主题实测（CDP 9225）修正——浮层随主题反转，但白底按钮自带硬编码对比故结论不变。这提示后续 R1/R2 实施时，凡涉及表面色的判断都必须双主题实测，不得凭单主题截图推断。

---

## 9. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-20 | 初稿：PC 画布域全量盘查（两代理并行扫描 + 主线交叉核实 + CDP 双主题目视），三类边界裁定，R0–R5 分批方案，复用设置域规格映射表与守卫 |
| 2026-11-20 | §10 拍板裁定：R0 顶栏用 `surface-overlay`（毛玻璃语义不可退化为不透明）；R2 白底黑字按钮归 C 类例外保留。两项从「待确认」转「已决」。 |
| 2026-11-20 | 评审追问「是否考虑双主题」→ CDP 9225 实测 dark/light：推翻 §10.2 初稿「浮层恒深」前提（浮层实为随主题反转），修正理由为「按钮自带硬编码白底黑字、16:1 不随主题漂移」，结论不变；新增 §10.3 双主题覆盖总表。 |

---

## 10. 评审拍板裁定（2026-11-20，产品 + 视觉负责人决断）

用户授权以产品负责人 + 视觉负责人身份，结合代码事实对两个悬置判断给出决断。以下裁定**已生效**，是 R0/R2 实施的直接依据，不再二次确认。

### 10.1 R0 顶栏材质令牌 → `var(--lnk-surface-overlay)`（不采纳 surface-base）

**决策**：`AppHeader.is-material`（L141）修为 `var(--lnk-surface-overlay)`；`AppHeader.galleryBareBar.test.ts:64` 同步改断言；`WorkspaceTopBar:159` 修为 `var(--lnk-hover-overlay)`。

**代码事实依据**：
- 顶栏材质态是**滚动驱动的毛玻璃**：`backdrop-filter: blur(24px)` + `box-shadow: inset 0 -0.5px 0 var(--lnk-border-subtle)`。毛玻璃的前提是背景**半透明**——`surface-overlay` 深 `#1a1a1ae0`(0.88) / 浅 `#ffffffe6`(0.9)，正好透出下层内容产生 blur；`surface-base` 深 `#0a0a0f` / 浅 `#fff` 是**不透明实色**，套上去 `backdrop-filter` 完全失效（被实色挡住无内容可模糊），并硬遮挡画布内容，是视觉倒退。
- 顶栏是**覆盖在滚动内容之上**（非文档流占位），语义上就是 overlay 表面，不是 base 表面。`surface-overlay` 是语义精确匹配，非偏好选择。
- `--lnk-surface` / `--lnk-hover` 全 src 无定义（已交叉核实），两条声明静默失效——这是 bug 不是风格问题。fallback `rgba(0,0,0,.05)` 在深主题下几乎不可见，浅 hover 形同虚设。
- 反向测试 `:64` 锁死了失效写法，必须先改测试再改实现，否则测试会「守住 bug」。

**边界**：本裁定只覆盖这两处失效令牌的**正确令牌选型**；不扩大到把顶栏从毛玻璃改成实色、不动 blur/inset 发丝线。

### 10.2 R2 白底黑字按钮 → C 类合法例外，**保留不改**（经双主题复核修正理由）

> **⚠️ 2026-11-20 双主题复核修订**：初版裁定理由是「浮层恒深、与主题无关」——**该前提错误**，已在 CDP 实测中推翻。结论（保留不改）不变，但依据改写如下。感谢评审追问「是否考虑了双主题」触发本次复核。

**决策（不变）**：`NodeElementEditOverlay:1106`、`:annotate-save`、`:node-element-generate`、`NodeCrop/Outpaint/Inpaint` 保存按钮等白底黑字（`background:#fff; color:#111`）**仍归 C 类例外，保留不改**。

**双主题实测事实（CDP 9225，生产页切 data-theme，量计算样式）**：

| 令牌/元素 | 深主题 (dark) | 浅主题 (light) |
|---|---|---|
| `--neo-chrome-bg`（浮层容器） | `rgba(22,22,28,.88)` 深色 | `rgba(255,255,255,.9)` **浅色** |
| `--lnk-overlay-rgb`（浮层遮罩叠加） | `255 255 255`（白叠加） | `0 0 0`（黑叠加） |
| 白底黑字按钮（硬编码） | `#fff` / `#111` | `#fff` / `#111`（**恒定，不随主题**） |

**修正后的判断**：
- 浮层容器**随主题反转**（深深、浅浅），不是恒深——初版"恒深浮层"前提错误。
- 但白底黑字按钮是**硬编码且盖在承载媒体内容的浮层上**：无论深/浅主题，按钮自身始终是白底黑字（≈16:1 对比），不依赖周边浮层色。它的可读性由「自身白底 + 自身黑字」保证，**与浮层是深是浅无关**——这才是"保留不改"的真正理由，而非"浮层恒深"。
- 浅主题下浮层变浅白，白底按钮与浮层对比减弱，但按钮有 `border-radius` + 与浮层的边界，且黑字在其自身白底上仍 16:1；深主题下白按钮在深浮层上是高对比焦点。两主题下按钮文字均清晰，无「白字消失」类事故（与 §7 DoD-5 的 CDP 双主题目视结论一致）。
- 这与 Design_system §2.3「文字色一律实色、保证最差表面对比度」是同一取舍：按钮自带实色底 + 实色字，对比度不随主题漂移。
- 若改成 `bg-accent`：白字压 accent 渐变末端仅 3.67:1（F-5 已知缺陷），对比度**不升反降**，故不改更优。
- `ReplaceImagePicker:260` 的 `background:#111; color:#fff` 是白底选择器上的**反色小圆点**（13px），属内容性配色，同样是 C 类。

**边界**：本裁定依赖「按钮自身硬编码白底黑字」这一事实。若将来这些按钮改用主题令牌（如 `bg-surface-* + text-*`），则失去"自身保对比"特性，需重新评估；当前硬编码成立。**双主题已实测覆盖 dark/light 两态，结论稳健**。

### 10.3 双主题覆盖总表（本次追问的交付）

| 裁定项 | 是否涉及颜色/主题 | 双主题结论 |
|---|---|---|
| 连线剪刀坐标修复（flow 锚点 + 重投影） | 否，纯坐标逻辑 | **正交，不受主题影响**；剪刀 hover 色走 `text-danger` 等语义类，error 令牌深浅成对（深 red-400 / 浅 red-700），安全 |
| R0 顶栏 → `surface-overlay` | 是 | **决策本身由双主题驱动**：深 `rgba(26,26,33,.88)` / 浅 `rgba(255,255,255,.9)`，两主题都半透明保住毛玻璃；CDP 实测确认 |
| R2 白底黑字按钮保留 | 是（表面色） | **复核后成立**：按钮自带硬编码白底黑字，深浅主题下均 16:1，不随浮层反转漂移；CDP 实测确认 |
