# 画布设置面板设计规格

日期：2026-10-13
状态：待评审
主题：自定义画布设置面板（收编既有偏好 + 低成本新交互开关）

## 1. 背景与目标

用户复测友商产品后提出：画布应有一个集中的「自定义画布」设置面板。我们已具备 14+1 项画布用户偏好（网格、吸附、连线样式、主题、视图锁定、小地图、Dock 缩放等），但散在两个 composable + 多个浮层 popover 里，没有统一入口；同时一批友商有的交互开关我们没有。

本规格定义：一个集中设置面板（壳 + 通用控件 + 收编 + 新开关），用自有墨流（Ink Flow）设计体系实现同布局范式与同信息密度，**不做友商视觉的逐像素复刻**。

## 2. 范围

### 2.1 保留并实现（13 项）

| # | 设置项 | 控件 | 现状与接线点 |
|---|---|---|---|
| 1 | 滚轮默认操作：平移/缩放 | Segmented | 已并存实现（CanvasPage.vue `:pan-on-scroll`/`:zoom-on-scroll`），改互斥 |
| 2 | 空白区域操作：右键/双击 | Segmented | 两者均已存在（`onPaneContextMenu`/`onPaneDoubleClick`），改单选 |
| 3 | 生成完成通知 | Toggle | dockNotice 基建已有；生成完成当前静默，需触发 |
| 4 | 生成失败通知 | Toggle | 同上，失败路径触发 |
| 5 | 视频悬停自动播放 | Toggle | 新增：CanvasNodeVideo mouseenter/leave 控制 `play()/pause()` |
| 6 | Shift + 回车提交 | Toggle | MentionInput 已有 `submitOnEnter` 模式，扩展为偏好 |
| 7 | 网格开关 + 点阵/线格 | Toggle + Segmented | 已有（`useCanvasViewportSettings`） |
| 8 | 网格间距 / 点大小 | Slider | 已有 |
| 9 | 网格颜色 | Color | 已有 |
| 10 | 连线：动画/粗细/颜色/发光/虚实 | Toggle/Slider/Color/Segmented | 已有（友商拆两类，本规格合并为「连线」一类） |
| 11 | 画布主题：暗色/亮色 | Segmented | 已有（`useCanvasTheme`），收编入口 |
| 12 | 拖拽吸附网格 | Toggle | 已有 |
| 13 | 视图锁定 / 小地图 / Dock 缩放 | Toggle + Segmented + Slider | 已有 |

### 2.2 后置（4 项，引擎级，另立专项）

对齐辅助线（拖拽对齐引擎）、极简模式缩放（LOD 渲染层）、@ 引用命名名称模式（改引用分配与解析约定）、自定义背景图（背景上传/纯色系统）。

### 2.3 裁掉（8 项）

图/视延迟提交、拖动节点获取焦点、节点提交后取消焦点、联动预览画布素材、定位动画节点上限、触摸点吸附范围（无触摸场景）、简化配色、平移灵敏度（vue-flow 无原生 prop，自算换算收益低）。

## 3. 布局范式

三选一（A 左分类导航+右设置行 / B 单列长滚动 / C 顶部 tab 分段），**选定 A**：与友商范式一致、分类定位强、容纳 20+ 项不拥挤；与底部左下浮层（高频快调）形成分工。

面板结构（mockup 见设计评审记录）：

- el-dialog，宽 ~880px
- 左导航 168px：6 分类（交互操作 / 生成通知 / 网格与显示 / 连线 / 画布主题 / 视图与布局），选中态消费 `--neo-hi-bg`/`--neo-hi-text`
- 右设置区：滚动，行结构 = 名称（13px/500）+ 描述（12px secondary）+ 右置控件；行间 0.5px `--neo-border` 分隔

分类归属：交互操作（1/2/5/6）、生成通知（3/4）、网格与显示（7-9）、连线（10）、画布主题（11）、视图与布局（12-13）。

默认值：wheelMode=平移、blankAction=双击（mockup 所示，两者当前行为等价，单选不损失能力）；其余新开关默认开启，videoHoverAutoplay 默认关闭（省流考虑）。

## 4. UI/UX 设计

### 4.1 通用控件（新增，L3 令牌化）

| 控件 | 规范 | 令牌 |
|---|---|---|
| Toggle | 36×20 圆角，200ms 过渡，`role="switch"` + aria | `--lnk-switch-on` / `--lnk-switch-off` / `--lnk-switch-knob`（design-tokens.css 双主题成对，过 `design-token.test.ts`） |
| Segmented | 既有 `.seg-btn` 模式（is-on 高亮），统一提取为组件 | `--lnk-segment-*` |
| Slider | 原生 `input[range]` + `accent-color: var(--neo-slider-accent)` + 数值 badge | 既有令牌 |
| Color | `input[color]` + 预设色板（既有模式提取） | 既有令牌 |

组件落位：`apps/web/src/components/settings/`（`NeoSettingsDialog.vue` 壳 + `SettingRow.vue` + 四个控件组件）。

### 4.2 令牌与主题纪律

- 组件样式**只消费语义令牌**（`--neo-*` 既有 + `--lnk-*` L3 新增），零硬编码色值；深浅主题自动适配，无需双份样式。
- 新 L3 令牌写入 `design-tokens.css` 并过成对守卫。

### 4.3 生效模型与动效

- 变更即时生效并立即写 localStorage；**无保存按钮**，关闭即完成（与底部浮层快调语义一致）。
- 动效仅功能性的：el-dialog 既有淡入、Toggle 200ms；无装饰性动效。

### 4.4 无障碍

- Toggle 带 `role="switch"`/aria-checked；Segmented 为 radiogroup 语义；控件均可键盘操作（el-dialog 自带焦点圈养）。
- 导航选中态不只靠颜色（字重 500 + 背景双重编码）。

### 4.5 入口

- 画布名「...」菜单（CanvasFloatingChrome）新增「画布设置」项。
- 底部左下浮层（CanvasBottomLeftControls）保留为高频快调，不删。

## 5. 架构设计

### 5.1 数据层：`useCanvasSettings`（新 composable）

- 落位 `apps/web/src/composables/useCanvasSettings.ts`。
- 单一 settings 对象收编全部 13 项（迁入 `useCanvasViewportSettings` 的 14 键 + `useCanvasTheme` 主题 + 新键：`wheelMode`、`blankAction`、`notifyOnComplete`、`notifyOnFailure`、`videoHoverAutoplay`、`shiftEnterSubmit`）。
- 持久化沿用既有模式：`STORAGE_KEY` + deep watch → localStorage；默认值集中一处。
- `useCanvasViewportSettings` 与 `useCanvasTheme` 的既有消费者全部改接新 composable（或薄适配层过渡），主题 `<html data-theme>` 引导脚本（index.html 内联）保持不变。

### 5.2 组件层

- `NeoSettingsDialog.vue`：壳（导航 + 分类注册表）。分类以数据数组注册（label/icon/rows），行以数据描述（label/desc/control 类型 + settings key），面板本身无 if-else 分支硬编码。
- 控件四组件纯受控（props value + emit change），单测独立。

### 5.3 接线点（行为开关）

| 设置 | 接线位置 |
|---|---|
| wheelMode | CanvasPage.vue `:pan-on-scroll`/`:zoom-on-scroll` 互斥 |
| blankAction | onPaneContextMenu / onPaneDoubleClick 的启用判断 |
| notifyOnComplete/Failure | CanvasPage 生成轮询成功/失败回调 push dockNotice |
| videoHoverAutoplay | CanvasNodeVideo mouseenter/leave |
| shiftEnterSubmit | MentionInput submitOnEnter 扩展 |

### 5.4 数据流

设置变更 → deep watch 持久化 → 各消费点（vue-flow props / 组件 watch / CSS 变量注入）即时响应。无服务端同步（既有偏好均为本机存储，保持）。

## 6. 测试策略

- 控件四组件单测（受控渲染 + emit + aria 语义）。
- `useCanvasSettings` 单测：默认值 / 持久化 round-trip / 部分损坏 JSON 容错。
- 对话框结构测试：6 分类注册表完整、行渲染、入口菜单 emit。
- `design-token.test.ts` 新 L3 令牌成对守卫自动覆盖。
- 每 PR 变异验证（关键锁至少一组变异红）。

## 7. 实施分期（每 PR 独立：worktree + 测试 + 变异 + CI + squash + 部署 + 生产取证）

- **PR 1（面板壳 + 收编）**：通用四控件 + `useCanvasSettings` 收编 13 项既有偏好 + 对话框壳 + 入口接线；底部浮层改接新 store。
- **PR 2（新行为开关）**：6 个新设置项的接线（滚轮互斥 / 空白区选择 / 双通知 / 视频悬停 / Shift+回车）。

## 8. 非目标

- 不做友商视觉逐像素复刻（自有令牌体系重绘）。
- 不做后置 4 项（引擎级，另立专项）。
- 不引入服务端设置同步。
- 不删底部左下浮层（高频快调保留）。
