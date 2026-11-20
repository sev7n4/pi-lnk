# 对话页模型选择卡 iOS 化 · 设计（全宽 Sheet + 模型配置 + 驱动手势）

> 需求来源：用户 2026-11-20 三项诉求——① 参考 WorkBuddy 重做模型卡的尺寸/样式（移动端全宽底部抽屉）；② 右上角设置按钮进入"模型配置"，可设当前模型的思考强度、并显示上下文窗口；③ 移动端支持下滑手柄关闭。
> 参照物：用户提供两张 WorkBuddy 截图（选择模型全宽卡 / 模型配置二级页）。

## 0. 第一原则与等价物检索结论（强制）

第一原则：**吃满上游、不重复造轮子**。任何新增判据/工具/字段/引擎前过三判据（①等价物检索 ②接线优先于新建，锚已有结构化数据面 ③禁造数/禁自报）。

| 需求 | 等价物检索（已 `grep -E` + 回代码核对） | 结论 |
|---|---|---|
| ③ 下滑手柄关闭 | `MobileSheet.vue` 已有 `swipeToDismiss`（默认开）+ 80px 阈值 + `startAtTop` 顶部起手势 + grabber + Teleport + safe-area + reduce-motion，`SkillPick.selectAndGo.guards.test.ts` 已锁规则本体 | **直接复用**：模型卡接入 MobileSheet，零新增手势代码、零第二套皮肤（G-15/G-15b 守卫放行） |
| ① 移动端全宽卡 | `AgentSideRail.skillSheetMobile.test.ts` 已有技能卡「PC 锚定 popover / 移动 MobileSheet」双形态模板；`neo-node.css:1437` 的模型卡 12px 留白是当前缺陷 | **对齐模板**：模型卡照搬技能卡双形态，删除 12px 补丁；PC 分支保留锚定卡不动 |
| ② 思考强度设置 | 三档状态 + 能力判定 + DTO + 发送链路 + `mapThinkingLevel` 映射全链路在位（`AgentSideRail.vue:885-950,1905`、`thinking-level.ts`），默认档入口被注释移出待接入 | **接线**：不新建档位引擎；配置页复用三档与同一写回函数（复用 `setPlanningThinkingLevel`） |
| ② 思考强度"按模型"作用域 | 上游 `AgentState.thinkingLevel` 是会话级单值；唯一 per-model 是 `pi-coding-agent` 的 `modelThinkingLevels` **种子表**；Claude Code `modelSettings.<model>.effortLevel` 同构 | **混合模式**：复用 `usePreferences` localStorage 通道建按模型种子表 + 切模型查表种入单值；不新建 store、不动 DTO/DB/runtime |
| ② 上下文窗口展示值 | 服务端 `resolveModelCapability().contextWindow`（`model-capability.ts:3-55`）按模型名派生；bootstrap 的 `ProviderPreferencesPublic` **无此字段** | **只读展示**：前端从已有 bootstrap 数据推导展示串（claude 200K / gpt-5 400K / gemini 1M / 其余 128K），与服务端同源规则；**禁止**新增用户可改字段（用户已拍板只读） |
| ② 设置按钮 / 二级页 | `MobileSheet` header 现为 title + subtitle + close，无 actions slot；仓库无"sheet 内二级页"先例 | **扩展基座**：给 MobileSheet 加可选 `titleLeading` / `headerActions` 插槽（纯附加、零破坏存量 8+ 调用点），二级页在同一 sheet 内切换，不新建浮层 |
| 双主题令牌 | `--lnk-surface-raised/base`、`--lnk-text-primary/secondary/muted`、`--lnk-border-subtle/default/strong`、`--lnk-accent-subtle/text/border`、`--lnk-touch-target(44px)`、`--lnk-radius-2xl`、`--lnk-shadow-lg` 全为成对 L2 | **直接消费**：零新增令牌、零 hex；选中态用 accent 三件套，禁翻转令牌 `--lnk-hi-bg/hi-text`（旧模型卡正在误用，本次一并清零） |
| 守卫 | `AgentSideRail.skillSheetMobile.test.ts`、`SkillPick.selectAndGo.guards.test.ts`、`mobileVisualLanguage.guards.test.ts`、`design-token.test.ts`、`UniversalModelSelector.test.ts` | **复用并改写**：新增模型卡双形态守卫，沿用技能卡判据结构；不新建测试框架 |

## 1. 背景与现状（已回代码核对）

1. 模型卡是 `UniversalModelSelector.vue` 内的锚定 popover（`:202-255`），PC/移动端同一组件；移动端仅靠 `neo-node.css:1437-1450` 把 `.dock-inline-card` 左右各留 12px 铺满**面板**——非全宽、无遮罩、无 grabber、无下滑关闭。
2. 模型卡选中态用 `--neo-hi-bg / --neo-hi-text`（`UniversalModelSelector.vue:223`）——翻转令牌，深主题黑底白字，违反选中态规范（见项目备忘与 `Design_system.md`）。
3. composer 的 thinking 是组件级 ref（`AgentSideRail.vue:885-895`），默认档入口在 `:4421-4422` 被注释移出；配置页正好补这个缺口。
4. 上下文窗口服务端由 `resolveModelCapability` 按正则派生（claude 200K / gemini 1M / gpt-5 400K / 默认 128K），生产另有全局 `PI_RUNTIME_COMPACTION_CONTEXT_WINDOW` 覆盖压缩判定——本需求**只展示派生值、不提供修改**。
5. `MobileSheet.vue`（268 行）已是成熟的 iOS 全宽底部抽屉基座，技能卡、技能管理页均已接入，双形态守卫齐备。

## 2. 用户已拍板（本轮 AskUserQuestion）

- **Q1 上下文窗口** → 只读展示（服务端派生值），不提供修改；真可配置另立议题。
- **Q2 思考强度作用域** → 采用混合模式（持久按模型种子 + 运行时会话单值），详见 §0 与 §3 AD3。
- **Q3 交付形态** → 先出规格+计划，拍板后单独开 worktree 实施。

## 3. 目标 / 非目标

### 目标
- 移动端模型卡 = 全宽底部 Sheet（grabber + 遮罩 + 下滑关闭 + safe-area），样式对齐 WorkBuddy 参考图；PC 保留锚定卡。
- Sheet 标题栏右侧设置按钮 → 同一 Sheet 内切到"模型配置"二级页，含"当前模型 / 思考强度 / 上下文窗口"三项。
- 思考强度三档可在配置页设置，按模型记忆（种子表），切模型自动套用；上下文窗口只读展示。
- 旧翻转令牌从模型卡清零，双主题下选中态稳定。
- 全量守卫绿、变异自检证伪有效。

### 非目标
- 不新增上下文窗口的用户可改字段、不动服务端 DTO / DB / pi-runtime。
- 不改思考档位三档枚举与 `mapThinkingLevel` 映射（避免与上游 7 档语义塌缩冲突）。
- 不做视觉截图回归、不改 DOCX/PDF 等其他面。
- 不重构 `MobileSheet` 既有手势逻辑（仅加可选插槽）。

## 4. 架构决策

- **AD1 双形态而非统一组件**：PC 保留 `UniversalModelSelector` 锚定 popover；移动端加 `isDesktopDock` 分支走 MobileSheet。理由：直接复用技能卡已验证的模板与守卫，风险最低；避免动 PC 既有行为与测试。
- **AD2 配置页是 Sheet 内视图切换，不是新浮层**：在模型 Sheet 内用 `view: 'list' | 'config'` 切换，header 随 view 变（列表页=设置按钮；配置页=返回按钮）。理由：iOS 设置层级是在同一 modal 内 push，非再弹一层（WorkBuddy 图 2 亦然）。
- **AD3 思考强度混合作用域**：
  - 持久层：`usePreferences` localStorage 加 `thinkingByModel: Record<string, '标准'|'深入'|'极限'>`，key = `catalogModelKeyFromValue(modelValue)`（与能力判定同源，非裸 provider/modelId）。
  - 运行时：仍是 `planningThinking` + `planningThinkingEffort` 单值，与 `SessionEntry.thinkingLevel` 一一对应；切模型时查种子表 → 若新模型支持且有种则种入 → 否则强制 off。
  - 写回：配置页改档调现有 `setPlanningThinkingLevel`，并同步写种子表；发送链路零改动。
  - 理由：Claude Code (`modelSettings.<model>.effortLevel`) 与上游 `pi-coding-agent` (`modelThinkingLevels`) 均验证此形态；规避运行时 per-model 与上游 `setThinkingLevel`/`reasoning` 能力位/`meta.json` 不落盘的三处冲突；规避纯 composer 级"当前模型的思考强度"语义造假。
- **AD4 上下文窗口只读、前端派生展示串**：前端 `thinkingLevels` 旁加纯函数 `contextWindowLabel(modelValue)`，按与服务端 `CONTEXT_WINDOW_RULES` 同源的正则返回 `'200K'/'400K'/'1M'/'128K'`。**共享真相源的约束**：服务端规则在 `packages/shared`，前端直接引用，禁止两边各写一份正则（否则双源漂移，正是 `modelCapability.ts:24-25` 警告的形态）。若上移成本过高，退路是在 `shared` 新增纯常量表并由服务端 reverse-import，前端只读。
- **AD5 选中态与列表令牌**：选中行用 `--lnk-accent-subtle / --lnk-accent-text / --lnk-accent-border`（主题稳定）；分组卡用 `--lnk-surface-base`，分割线 `--lnk-border-subtle`，行高 `--lnk-touch-target(44px)`；禁用行用 `--lnk-text-muted`。零 hex、零翻转令牌。
- **AD6 手势继承而非复制**：配置页与列表页共用同一 MobileSheet 实例，swipeToDismiss 天然继承；配置页若有未保存态不需禁用手势（改档即时写回，无未保存态）。

## 5. 详细设计

### R1 · MobileSheet 基座扩展（可选插槽，零破坏）
- `MobileSheet.vue` props 增 `titleLeading?: 'back'`（或 `showBack?: boolean`）+ emit `back: []`；header 内 title 前加返回按钮（`aria-label="返回"`，44×44，`data-testid="m-sheet-back"`，`:lnk-touch-target`），仅 `showBack` 为真时渲染。
- header 右侧 close 前加可选 `<slot name="headerActions" />`（`data-testid` 由消费方给），用于设置齿轮按钮。
- 存量 8+ 调用点零参数变化 ⇒ 行为不变；`design-token.test.ts` 的 z 阶梯消费守卫继续锁 `MobileSheet` 用 `--lnk-z-modal`。

### R2 · 模型卡双形态（`AgentSideRail.vue`）
- 在 `agent-dock-params` 处：`<UniversalModelSelector v-if="isDesktopDock" ... />`；`v-else` 渲染移动触发 chip（复用 `currentLabel` 展示，点击 `modelSheetOpen = true`）+ `<MobileSheet v-if="modelSheetOpen" title="选择模型" max-height="72vh" @close="...">`。
- 列表内容：**复用而非复制** `UniversalModelSelector` 的 `selectableOptions`/`current`/`unavailableTitle` 逻辑——抽成 composable `useModelSelectorOptions(modelValue, type, modality, audioKind)`（纯逻辑，无 DOM），PC popover 与移动 Sheet 共用同一数据源。选中/不可用/健康点/可识图角标在移动 Sheet 内用 L2 令牌重绘（可提取共享 `ModelOptionRow.vue` 子组件承载两形态，减少重复）。
- Sheet 内点击模型：调 `select(id)` → 写回 `planningModel` → 关闭 sheet（与 PC 同语义）。
- `neo-node.css` 删除 `.dock-inline-card` 的移动端 12px 覆盖块（`:1437-1450`），改由双形态守卫锁定"移动端不再出现锚定卡"。

### R3 · 设置按钮 + 模型配置二级页
- 列表页 header 右侧插槽放设置齿轮按钮（`aria-label="模型配置"`，`data-testid="model-config-open"`，44×44，SVG 齿轮，禁字符图标 G-16）。
- 点击 → `view = 'config'`；header 变：显示返回按钮 + title "模型配置" + subtitle "当前模型：{friendlyModelName}"；设置按钮隐藏。
- 二级页内容严格复刻 WorkBuddy 截图（iOS inset-grouped disclosure 列表）：分组卡 `--lnk-surface-base` + `--lnk-radius-xl` + 1px `--lnk-border-subtle`：
  - 行 1「思考强度」：右侧显示当前档（`标准/深入/极限`）+ chevron；点击 push 到同 Sheet `view='thinking'` 三行 radio 选择页，选中态 accent checkmark，选完自动 pop 回配置页并写回。
  - 行 2「上下文窗口」：右侧显示 `contextWindowLabel(planningModel)` + chevron；点击 push 到同 Sheet `view='context'` 只读详情页，明确文案"由当前模型能力推导，暂不可配置"，无输入框/选择器。
- 返回按钮按 push/pop 逐级回退：`config → list`，`thinking/context → config`（不关 Sheet）；close / 遮罩 / 下滑 → 关整个 Sheet（回到列表态复位 `view`，下次打开从列表起）。
- 齿轮按钮只在列表页渲染：进入配置/二级页后 header 仅保留返回、标题/副标题、关闭，与参考图一致。

### R4 · 思考强度按模型种子（`usePreferences.ts` + `AgentSideRail.vue`）
- `usePreferences` 的 `preferences` 类型加 `thinkingByModel?: Record<string, ThinkingLevel>`；读写走现有 localStorage 通道（`lnkpi.preferences`），不新建 key。
- `setPlanningThinkingLevel(level)` 增加副作用：若 `planningModel` 当前支持 thinking（`showPlanningThinkingControls`）则写 `thinkingByModel[catalogModelKeyFromValue(planningModel)] = level`；否则仍写（种子与当前能力解耦，切回支持的模型时用得上）。
- `watch(planningModel)` 或新 watcher：切模型后查种子表 → 若 `showPlanningThinkingControls` 且种子存在 → 种入 `planningThinking/Effort`；若不支持 → 强制 off（现有 `watch(showPlanningThinkingControls)` 逻辑保持）。
- 动机注释写明：上游会话单值 + 上层种子表，切模型只种一次，运行时仍单值下传。

### R5 · 上下文窗口只读展示（共享规则）
- 在 `packages/shared/src` 增 `contextWindowOf(modelValue): number` + `contextWindowLabel()`（200K/400K/1M/128K），规则与 `CONTEXT_WINDOW_RULES` 同源（建议直接把规则常量上移 shared，服务端 reverse-import，做到单一真相源）。
- `apps/server/src/provider/model-capability.ts` 改为 import shared 的规则常量，行为不变（其 4 条单测保持绿）。
- 前端配置页只调 `contextWindowLabel()` 展示，不写回、不进 DTO。

### R6 · 守卫与测试
- 新建 `AgentSideRail.modelSheetMobile.test.ts`：静态锁 PC 分支 `v-if="isDesktopDock"` + 移动 `<MobileSheet>` + `title="选择模型"` + `model-config-open` + `view`/`m-sheet-back` + 手势默认开；反转锁 `neo-node.css` 无 `.dock-inline-card` 移动端 12px 块。
- 新建 `UniversalModelSelector.tokenGuard.test.ts`：锁模型卡源码无 `--neo-hi-bg/hi-text`、选中态用 `accent-subtle/text/border`；变异测试改回翻转令牌须转 RED。
- 扩展 `MobileSheet.test.ts`（新建）：`showBack` 渲染返回按钮 + emit back、`headerActions` 插槽渲染、存量不传时两者不出现。
- 新建 `thinkingByModel.test.ts`（或并入 `thinkingLevels.test.ts`）：种子按 `catalogModelKeyFromValue` 写读、切模型种入、不支持时强制 off。
- 新建 `contextWindowLabel.test.ts`：4 档派生值与服务端同源（对 `resolveModelCapability` 做交叉断言）。
- 复用 `SkillPick.selectAndGo.guards.test.ts` 的手势判据：新增断言模型卡走 MobileSheet（G-15 白名单正确），零新增手势实现。

## 6. 变更影响面矩阵

| 文件 | 改动 | 破坏风险 |
|---|---|---|
| `MobileSheet.vue` | 加 `showBack`/`back` emit + `headerActions` slot | 存量 8+ 调用点零参数变化；插槽默认空 ⇒ 低风险，但需全量回归 |
| `AgentSideRail.vue` | 双形态分支 + 种子表写读 + 配置页视图 | 文件 6000+ 行，测试靠 fs-scan，需精确锚点；`thinking.test.ts` 的反转注释要同步 |
| `UniversalModelSelector.vue` | 抽 composable + 令牌清零 | 现有 5 组单测（可识图/audio/unavailable/health）必须保持绿 |
| `neo-node.css` | 删移动端 12px 覆盖块 | 若有其他调用点依赖该覆盖需先 grep 确认（仅模型卡用） |
| `usePreferences.ts` | 加 thinkingByModel 字段 | localStorage 反序列化需容错旧值（可选字段） |
| `packages/shared` + `model-capability.ts` | 规则上移 shared，server reverse-import | 服务端 4 条单测交叉验证；导入方向别造成循环依赖 |
| 守卫测试集合 | 新增 4 个 + 扩展 1 个 | 守卫锁规则本体非接线表象，变异自检逐个证伪 |

## 7. 测试策略

- TDD 每刀：失败测试 RED → 实现 → GREEN → 提交。
- 定向 vitest（node24 + `--maxWorkers=1 --no-file-parallelism`）：
  - `UniversalModelSelector.test.ts`、`AgentSideRail.thinking.test.ts`、`AgentSideRail.skillSheetMobile.test.ts`、新增 4 个守卫。
  - 视觉守卫：`design-token.test.ts`、`theme-usage.test.ts`、`palette-parity.test.ts`、`text-token-guard.test.ts`、`mobileVisualLanguage.guards.test.ts`。
  - 服务端：`model-capability.test.ts`。
- 类型检查：`pnpm --filter @lnkpi/web exec vue-tsc -b`（勿加 `--noEmit`）；shared/server 用各自 tsc。
- 变异自检：对"双形态守卫 / 令牌守卫 / 种子表守卫 / 手势守卫"各做一次改坏→RED→还原，确认证伪能力。
- 静态脚本：`verify-pc-canvas-legacy-scope.py` / `verify-pc-visual-regression.py`（若行数登记漂移按实测值同步 manifest，只写实测值）。

## 8. 验收判据（DoD）

1. 移动端点击 composer 模型 chip → 弹出全宽底部 Sheet，含 grabber、遮罩、下滑关闭；宽度占满屏（无 12px 留白）。
2. Sheet 标题栏设置按钮 → 同一 Sheet 内切"模型配置"，显示当前模型、思考强度（可设三档）、上下文窗口（只读派生值）。
3. 思考强度按模型记忆：A 模型设"极限"→ 切到 B 模型 → 切回 A 仍"极限"；切到不支持模型强制关且配置页隐藏/禁用思考行。
4. 上下文窗口展示值与服务端 `resolveModelCapability` 对该模型的派生值一致。
5. 双主题下选中态清晰可辨（accent 稳定色），模型卡源码零 `--neo-*`；无新 hex。
6. 全量定向测试 + 视觉守卫 + 类型检查绿；变异自检 4/4 转 RED。
7. CI 绿 → squash 合并 → web 部署 → 生产 CDP 走查（单会话内切双主题）命中新 chunk 特征串。

## 9. 风险与边界

- `AgentSideRail.vue` 巨大且静态测试依赖精确字符串锚点，改动须小步、每刀跑相关守卫。
- `MobileSheet` 加插槽虽兼容，但 `design-token.test.ts:626-663` 的 z 阶梯消费守卫锁死了消费文件清单，改文件可能需同步断言（改的是既有文件，通常不需动）。
- 思考种子表与上游"会话单值"是刻意的混合：注释必须写清"种子只在切模型时用一次，运行时仍单值下传"，避免后续维护者误改成运行时 Map。
- 配置页无未保存态（改档即写回），故 swipeToDismiss 保持开；若未来加"应用"按钮需重评。
- 生产 CDP 走查移动形态必须在同一 CDP 会话内 `setDeviceMetricsOverride` + reload（跨脚本会丢触摸仿真，历史坑）。

## 10. 变更记录

- 2026-11-20 初版：用户拍板上下文只读 / 先出规格计划；思考强度作用域经行业+上游取证后定混合模式。
