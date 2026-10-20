# 移动端对话页 UI/UX 优化设计方案

> 状态：**Draft — 待评审**
> 范围：**≤767px 对话页签的页面结构 / 操作按钮 / 手势模型 / 视觉规范 / 架构分层**，以及与画布页的接缝。PC 端形态不动。
> 上游：[移动端画布页 UI/UX 重构设计方案](./2026-10-19-mobile-canvas-ux-redesign.md)（同批，D-1..D-10 已定稿）+ [移动端 Composer/画布/SSE 边界规格](../superpowers/specs/2026-10-17-mobile-composer-sse-boundary-design.md)
> 基线：`feat/propose-confirm-single-surface` @ a4446a9b（2026-10-19 代码级取证）
> 日期：2026-10-19

---

## 0. 决策摘要

| # | 决策 | 说明 |
|---|---|---|
| **D-1** | **对话页与画布页同构：新增 `MobileConversationShell` 壳** | 今天 `AgentSideRail.vue`（6255 行）同时是「PC 侧栏 + 移动对话整页 + 移动贴底裸条 + 移动画布 composer」四重身份。移动端专属组件只有 TopBar / TabBar / CanvasTopControls 三个——**对话页一个都没有**。壳层把编排上收，内容渲染留在原地 |
| **D-2** | **长按（long-press）升为移动端一等交互原语** | 全仓零长按实现（grep `longPress/touchstart` = 0）。6 个气泡按钮 + 引用芯片删除 + 提议取消 + 节点菜单全靠 hover/右键。抽 `useLongPress` 单一 composable，画布页与对话页共用 |
| **D-3** | **消息操作从「hover 显隐」改为「常显 2 个 + 长按 sheet 全量」** | 现状 6 个 26px 按钮 `opacity:.55` + `:hover→1`，触屏永远半透明且不可发现。收敛为常显「复制 / 编辑（user）· 复制 / 复用（assistant）」+ 长按出完整 sheet |
| **D-4** | **输入区上方系统层从「堆叠」改为「单轨 + 抽屉」** | 现状状态行 / 插话槽 / 取消提示 / turn 状态行 / 收据行 五类浮层可同时占位，移动端吃掉 1/3 屏。改为互斥单轨（≤32px）+ 点按展开抽屉 |
| **D-5** | **能力裁剪从「静默 display:none」改为「显式能力集 + 入口重定向」** | 思考档位在移动端 `display:none`（`AgentSideRail.vue:5994`）= 功能彻底消失；Tab 接受预测 ghost（`composer/prediction.ts`）在无 Tab 键设备上不可达。裁剪可以，但必须换一个入口 |
| **D-6** | **触控规范下沉为设计令牌** | 现有 `agent-hit-expand`（`:5787-5830`）只在 composer 内覆盖 3 个控件。升为 `--lnk-hit-min: 44px` + `data-hit` 全站约定 |
| **D-7** | **断点从「一个数字」拆为「形态 × 能力」两个维度** | `useAgentMobileLayout` 只有 `max-width:767px` 一个判据，同时决定布局形态与能力裁剪。应拆为 `layout: 'conversation' \| 'canvas-window' \| 'canvas-full'` 与 `capabilities: { longPress, hover, finePointer, keyboardHint }` |
| **D-8** | **弹层在移动端一律 bottom sheet** | ForceChoiceDialog（桌面居中）、AgentAssetPicker（420px 定高）、propose 卡片就地展开——三处都按桌面心智写 |
| **D-9** | **减法：删 4 项死控件、并 3 处入口、移 4 处形态** | 汇总见 §5 |
| **D-10** | **壳层与画布页壳合并为一个 PR 收尾** | `MobileCanvasShell`（画布方案 D-9）与 `MobileConversationShell` 共用 `useLongPress` / 能力集 / 触控令牌；PR5 时合成一次 `MobileAppShell` |

**非目标（本期明确不做）**

- composer 裸条三态内部形态（PR #436/#478 定稿，只补能力入口与热区）
- SSE 流 / 消息渲染本体 / `presentation/*` 组件树
- propose 状态机（ADR-0011 已收敛为节点内联面）
- PC 端任何布局与交互变更
- 画布页本体（另见画布页方案）

---

## 1. 现状盘点（代码级取证）

### 1.1 一个组件承载四种移动端形态

```
AgentSideRail.vue（6255 行：script 1-3276 / template 3278-4616 / style 4618-6265）
├─ 移动端形态判定（:3396-3420）
│   isMobileLayout ? (mobileCanvasView ? 'is-canvas-view' : 'is-conversation-view') : ...
│   + { 'is-canvas-imm', 'has-studio-dock' }
├─ 四种移动端视觉形态（全部靠 .agent-panel-mobile-dock 类作用域 CSS）
│   ① is-conversation-view   :4755-4764  整页不透明面板（SSE 流 + composer）
│   ② is-canvas-view + imm   :4784-4789  纯画布满屏（对话 chrome 全 display:none）
│   ③ is-canvas-view 窗态    :4766        画布 + composer 同屏（顶栏/SSE 流 display:none，#466 裁决）
│   ④ 基准贴底裸条           :4680-4694  left/right:12px，pointer-events:none
└─ 移动端专属代码量
   ├─ isMobileLayout 分支：27 处
   ├─ .agent-panel-mobile-dock CSS 规则：54 处
   └─ 移动端专属组件：0 个（MobileTopBar / MobileTabBar / MobileCanvasTopControls 在 components/mobile 与 canvas/，均不属对话页）
```

> ⚠️ 2026-10-21 修正：③ 窗态「对话流仍 40vh」是本文成稿时的过时描述。#466（10-18）已裁决
> 画布视图两态一律隐藏顶栏 + SSE 流（修「窗 A/B 进入画布后 SSE 压画布重叠」），窗态保留的
> 只有 composer。系统层卡片的可见性契约见 §1.1.1。

### 1.1.1 系统层容器与可见性矩阵（2026-10-21 根治）

```
.chat-wrap（消息流）之后的「等待/收口系统层」四卡包进 .agent-system-layer 容器：
  propose 等待提示（canvas-always）｜收口状态行｜ask_user 卡（canvas-with-composer）｜取消回执卡
画布视图：容器默认 display:none，白名单放行——漏登记的代价从「静默 bug」翻为「可见的功能缺失」。
```

| chrome 元素 | 所属面 | 对话页签 | 画布·窗态 | 画布·imm / dock |
|---|---|---|---|---|
| 顶栏（新建/历史） | 对话模式 | 显 | 藏 | 藏 |
| SSE 对话流 | 对话模式 | 显 | 藏 | 藏 |
| composer 裸条 | 输入面 | 显 | 显 | 藏 |
| ask_user 卡 | 阻塞交互面 | 显 | **显** | 藏 |
| propose 等待提示 | 待确认状态面 | 显 | 显 | 显 |
| 收口状态行 | 回合播报 | 显 | 藏 | 藏 |
| 取消回执卡 | 回合播报 | 显 | 藏 | 藏 |

**可见性规则**：交互式阻塞面（ask_user 卡）跟随 composer——pending 期间 composer 自由文本
一律按 answer 提交（spec §5.3），输入面与阻塞问题永不分离；播报式 chrome（状态行/取消回执）
不跟随。propose 提示属待确认状态面，画布三态恒显（有画布专属文案）。

**病史（为何用容器而不是继续往清单里加）**：系统层移出 chat-wrap（P1-5）后逐卡登记漏了
三次——状态行（#496）、ask 卡+取消回执（#516）、更早的 railHiddenByTab；每次失败模式静默，
靠真机截图才发现。现由 `mobileMaskTabbar.test.ts` 五条断言守护：容器默认全隐、两个白名单
落位、旧逐卡选择器不得回归、四卡位置不变量。

### 1.2 对话页操作按钮全清单（现状）

图例：🚫 触屏不可达 ｜ ⚠️ 触控目标 < 44px ｜ ⛔ 恒 disabled

#### A. 顶栏（由 `MobileTopBar.vue` 接管，chat 态）

| # | 控件 | 尺寸 | 问题 |
|---|---|---|---|
| A1 | ≡ 会话与项目抽屉 | 34×34 | ⚠️ |
| A2 | 积分胶囊（无点击） | h26 | — |
| A3 | 新建对话胶囊 | h28 | ⚠️ |
| A4 | 🕘 对话历史 | 34×34 | ⚠️ |
| — | 模型选择 | — | **顶栏无入口**（仅 composer 内，且空草稿隐藏） |
| — | 思考档位 | — | **顶栏无入口 + composer 内 display:none** |
| — | 「更多」总菜单 | — | **不存在** |

#### B. 消息气泡操作行（`.agent-msg-actions`，`:3776-3870`）

| # | 控件 | 角色 | 尺寸 | 出现条件 | 问题 |
|---|---|---|---|---|---|
| B1 | 👍 有帮助 | assistant | 26×26 | `canShowMessageActions` | 🚫 hover-only + ⚠️ |
| B2 | 👎 无帮助 | assistant | 26×26 | 同上 | 🚫 + ⚠️ |
| B3 | 复制回复 | assistant | 26×26 | 同上 | 🚫 + ⚠️ |
| B4 | ✎ 编辑 | user | 26×26 | `!streaming && !readOnly` | 🚫 + ⚠️ |
| B5 | 复制 | user | 26×26 | 同上 | 🚫 + ⚠️ |
| B6 | ↺ 复用本轮 | user | 26×26 | `canReuseTurn` | 🚫 + ⚠️ |

出现机制（`:5382-5394` / `:5576-5579`）：
```css
.agent-msg-actions { opacity: 0.55; }
.agent-turn--assistant:hover .agent-msg-actions,
.agent-msg-actions:focus-within { opacity: 1; }
```
`grep agent-msg-action` 全文件 **零条 `.agent-panel-mobile-dock` 作用域覆盖** ⇒ 触屏永久停在 0.55，且无长按、无选中态、无任何替代入口。

#### C. 输入区（`.composer-bare-bar` 裸条三态 + 系统层）

系统层（条上方，可叠加）：

| # | 控件 | 尺寸 | 出现条件 |
|---|---|---|---|
| C1 | 生成中状态行（阶段 + 进度 + 耗时 + 积分） | ≤24px | `isStreaming` |
| C2 | 历史复用 coachmark + 「知道了」 | — | 一次性 |
| C3 | 插话槽：立即插话 / 等它跑完 / 取回内容 / 放弃 | 4 按钮 | `queuedBubble` |
| C4 | 取消提示 callout + 「发起新任务」 | — | `showCancelledCallout` |
| C5 | turn 状态行（waiting / failed / settled） | — | `turnStatus` |
| C6 | AskUserCard（选项 26px / 提交 26px / 跳过 18px） | 见 §4.4 | `pendingAskUser` |
| C7 | turn 收据行：定位到画布 / 全部保留 / 撤销本轮 | ~20px | `lastTurnReceipt`（其中「撤销本轮」⛔ 恒 disabled） |
| C8 | propose 等待卡：⚠失败告警 + 「定位」h28 + 「取消」26px | — | `proposeWait` |

裸条内：

| # | 控件 | 移动端可见性 | 问题 |
|---|---|---|---|
| C9 | ＋ 素材菜单（拍照/图片/文件/资产库/专家disabled/技能二级/连接器disabled） | ✅ 唯一常驻 | 两级嵌套；3 项废位 |
| C10 | ◎ 引用画布节点（骑缝绝对定位） | ✅ | 垂直半露进画布区，易误触 |
| C11 | MentionInput（34px 单行 / 120px 展开） | ✅ | @提及下拉依赖 ↑↓/Enter |
| C12 | ghost 预测补全 | ✅ 显示 | 🚫 **Tab 接受 = 触屏不可达** |
| C13 | 模型 chip | ⚠️ 空草稿隐藏（`:5981-5983`） | 想换模型必须先打字 |
| C14 | 思考档位 chip | ⛔ `display:none`（`:5994`） | 🚫 功能消失 |
| C15 | 独立麦克风 | ⛔ `display:none`（`:5995`） | 改由条长按（`holdGesture.ts`） |
| C16 | 发送 / 停止 | idle 隐藏，输入态显示 | — |
| C17 | 录音态（转写 + 电平 + M:SS + 上滑取消） | ✅ 移动端专属 | 良好 |

#### D. 对话流内其他浮层与按钮

| # | 控件 | 尺寸 | 出现条件 | 问题 |
|---|---|---|---|---|
| D1 | 回到底部浮标 `.agent-jump-latest` | h28 | `!followLatest` | ⚠️ 无移动端覆盖 |
| D2 | 重试生成（artifact 行） | ~18px | `failed` | ⚠️ |
| D3 | CanvasLocateButton（产物/trace/进度卡） | 24×24 | 有 nodeId | ⚠️ |
| D4 | 任务进度卡定位图钉 | opacity-0 → hover | hover | 🚫 |
| D5 | trace 步骤定位图钉 | — | hover 显 | 🚫 |
| D6 | 引用芯片 ×（`AgentSidebarRefChip:317-330`） | 14×14，`display:none`→`:hover` | hover | 🚫 **移动端无法删除引用** |
| D7 | 引用芯片 hover 预览 | mouseenter+200ms | hover | 🚫 |
| D8 | 引用芯片拖拽排序 | HTML5 DnD | 桌面 | 🚫 触屏无 DnD |
| D9 | AgentNodeGraph 三按钮（新窗口/导入画布/导出HTML） | 14×14 图标 | — | ⚠️ 图标无语义 |
| D10 | AgentProseBlock 展开/收起 | — | — | — |
| D11 | AgentAssetPicker（资产库） | max-h 420px / 55vh | ＋菜单 | 整页对话下遮 tabbar |
| D12 | ForceChoiceDialog | 居中弹窗，按钮 ~30px | 3 种 kind | 桌面形态 |
| D13 | CanvasRefPickOverlay「完成」 | — | ◎ 拾取 | 「Esc」文案触屏无意义 |
| D14 | 知道了一律 4 处（coachmark / turn 拒绝 / 取消提示 / 插话放弃） | — | — | 文案重复占位 |

### 1.3 触控达标现状（已有机制）

唯一补救：`agent-hit-expand`（`:5787-5830`）
```css
@media (max-width: 767px) {
  .agent-hit-expand[data-hit='m']::after { inset: -10px; }  /* 24→44px */
  .agent-hit-expand[data-hit='l']::after { inset: -2px -8px; } /* 只横扩 */
}
```
覆盖 **仅 3 个控件**：DockMicButton、DockGenerateButton、＋按钮、模型 chip。
`data-hit='l'` 故意只横扩（注释 `:5820-5822`：垂直外扩会侵入文本行）⇒ 垂直方向仍 < 44px。
**未覆盖**：气泡 6 按钮、引用芯片 ×、重试生成、CanvasLocateButton、回到底部、AskUserCard 全套、收据行、propose 按钮、ForceChoiceDialog、AssetPicker 关闭。

已做对的基础设施（保留）：
- `touch-action: manipulation` + `-webkit-tap-highlight-color: transparent`（`AgentSideRail.vue:4966-4967`、`MobileTopBar:209`、`MobileTabBar:110`、`MobileCanvasTopControls:141`）
- `:active` 反馈（`:4970-4972`）
- 移动端 Enter 不发送（`:4304 :mobile-enter-newline="isMobileLayout"`）
- 上滑取消手势（`holdGesture.ts`：`HOLD_MS=300` / `CANCEL_SWIPE_PX=60`）
- 空闲态条 `touch-action:none` + `-webkit-touch-callout:none`（`:5884-5891`）
- ＋ 卡移动端全屏遮罩修「点空白收不拢」（`:4364-4374`、`:5942-5949`）
- 三重安全区令牌链：`--lnk-topbar-h`（`MobileTopBar:60-69`）/ `--lnk-tabbar-h`（`MobileTabBar:25-34`）/ `--lnk-agent-dock-h`（`AgentSideRail:209-238` ResizeObserver）

---

## 2. 目标形态

### 2.1 页面结构（对话页整页态）

```
┌─────────────────────────────────────────┐
│ ≡  会话名（可改）          [积分] ⋯      │ 44px MobileTopBar（chat 态）
├─────────────────────────────────────────┤
│                                         │
│  ┌ user bubble ─────────────┐           │
│  │ 提示词正文                 │           │ 对话流（flex:1）
│  │ 引用芯片 ×N            [复制][编辑]  │ ← 常显 2 个 44px
│  └───────────────────────────┘           │
│  ┌ assistant bubble ────────┐           │
│  │ 正文 / trace / 产物卡      │           │
│  │              [复制] [⋯]   │           │ ← 常显 1 个 + 长按入口
│  └───────────────────────────┘           │
│                        (⊕) 回到底部 44px │ 圆形 FAB
├─────────────────────────────────────────┤
│ ▸ 单轨：阶段 · 进度 · 耗时 · 积分   [⋯] │ ≤32px，点按展开抽屉
├─────────────────────────────────────────┤
│  ＋  │ 输入区…            │ 模型◣ │发送 │ 裸条（现状保留）
└─────────────────────────────────────────┘
│ 对话 · 画布 · 发现 · 我的                │ 56px MobileTabBar
```

### 2.2 长按 sheet（消息级）

```
╭──────────────────────────────╮
│ 助手回复 · 10:24              │  ← 拖拽把手 20px
├──────────────────────────────┤
│ ↺ 复用本轮（提示词 + 引用）    │  56px
│ ⧉ 复制回复                    │  56px
│ ⌫ 删除这条回复        ← danger │  56px
├──────────────────────────────┤
│  👍 有帮助     👎 无帮助       │  并排 44px（低频，二级）
╰──────────────────────────────╯
```

规则：
- 触发 400ms 位移 < 10px；触发瞬间 haptic（`navigator.vibrate(8)`，iOS 静默降级）
- sheet 从底部升起 250ms `--lnk-ease-decelerate`；遮罩 `--lnk-scrim`
- 长按**用户气泡**时，编辑态直接从 sheet 进（沿用 `isMessageUnderEdit` 状态机，不新建）
- 滚动中不触发（`touchmove` > 8px 即取消），避免与对话流滚动冲突
- PC 端 sheet 永不渲染（能力集 `longPress: false`）

### 2.3 输入区系统层「单轨 + 抽屉」

现状五类浮层互斥化：

| 优先级 | 内容 | 轨道呈现 |
|---|---|---|
| 1（最高） | `AskUserCard` | 抽屉全展开（阻塞式，必须作答） |
| 2 | `proposeWait` 警告 | 抽屉展开（阻塞确认） |
| 3 | 生成中状态行 | 单轨：阶段 · 进度条 · 耗时 · 积分 · [⋯停止] |
| 4 | `queuedBubble` 插话槽 | 单轨：「已排队 · [立即插话] [⋯]」 |
| 5 | `turnStatus` / 收据行 / 取消提示 / coachmark | 折叠进单轨 [⋯] 抽屉 |

单轨 ≤32px，抽屉按需展开至 ≤40vh。这样常态下系统层从「1/3 屏」回到「32px 一行」。

### 2.4 能力裁剪与入口重定向（D-5 明细）

| 被裁能力 | 现状 | 目标入口 |
|---|---|---|
| 思考档位 | composer `display:none`（`:5994`） | **长按模型 chip → 参数 sheet**（模型 / 思考档位 / 技能 三合一），或顶栏 ⋯ → 「思考档位」 |
| Tab 接受预测 ghost | 无键盘设备不可达 | ghost 尾部加 32px 「补全」按钮，点按接受；或移动端直接不显示 ghost |
| 引用芯片拖拽排序 | HTML5 DnD | 长按芯片 400ms 起拖（与 sheet 区分：芯片拖 = 排序，空白拖 = 滚动） |
| @提及下拉键盘导航 | ↑↓/Enter/Tab | 点按选项即选中；下拉上移至键盘上方（`visualViewport` 监听） |
| 「撤销本轮」 | ⛔ 恒 disabled（20px 死按钮） | 移动端不渲染 |
| 独立麦克风 | `display:none`，改条长按 | 保留条长按；空闲提示文案升级为可发现（见 §4.6） |

---

## 3. 交互原语规范（D-2）

| 原语 | 阈值 | 用途 | 实现 |
|---|---|---|---|
| tap | — | 所有主按钮 | 现状 |
| long press | **400ms**，位移 < 10px | 气泡菜单 / 引用芯片菜单 / 模型参数 sheet | 新 `useLongPress` |
| 条级 hold | 300ms（`HOLD_MS`，**不改**） | 语音输入 | 现状 `holdGesture.ts`（阈值已随录音体感调定，改动收益低于风险） |
| swipe up | 60px（`CANCEL_SWIPE_PX`，不改） | 录音取消 | 现状 |
| drag | long-press 后位移 > 10px | 引用排序 / 节点移动 | 新 |

`useLongPress(target, { ms: 400, moveTolerance: 10, haptic: true, ignoreWhen: () => isScrolling })`
—— 单一实现，画布页节点长按菜单直接复用（消除画布页方案里的第二份实现）。

---

## 4. 交互与视觉规范（逐控件）

### 4.1 触控规范（D-6 令牌下沉）

```
新增 L2 令牌（design-tokens.css）：
  --lnk-hit-min: 44px;          /* 最小命中区边长 */
  --lnk-hit-row: 52px;          /* sheet 行高 */
  --lnk-touch-tap: scale(0.94); /* 按下反馈 */
  --lnk-scrim: rgba(0,0,0,.55); /* sheet 遮罩，深浅成对 */
约定：
  - 所有移动端可点元素带 data-hit，视觉尺寸可保持 24/28/32（桌面观感不变）
  - ::after 外扩由一条全局规则承担，不再逐组件手写 inset
  - 行内元素（data-hit="inline"）只横扩，避让文本行——沿用现有 l 档教训
```

达标清单（移动端对话页 ≥44px）：

| 元素 | 现状 | 目标 |
|---|---|---|
| 气泡操作按钮 ×6 | 26×26 hover-only | 常显 2 个 44×44（图标 14px 内联）+ 长按入口 44 |
| 引用芯片 | 32×32 | 视觉不变，命中 44；× 恒显（不 hover-only） |
| 重试生成 | 18px | 36px 高 + `data-hit` |
| CanvasLocateButton | 24×24 | 32px + `data-hit` → 44 |
| 回到底部 | h28 | 48×48 圆形 FAB |
| propose 定位 / 取消 | 28 / 26 | 40px 高 |
| 收据行 3 钮 | ~20px | 40px 高 |
| AskUserCard 全套 | 18-26px | 选项改**全宽行 52px**（不是 chip），提交/跳过 44 |
| AssetPicker × / ForceChoice 按钮 | 28 / 30 | 44 |

### 4.2 消息气泡

- **user 气泡**：右对齐；常显 [复制][编辑] 两枚 44px 图标钮（`:before` 区下方，无背景）
- **assistant 气泡**：左对齐；常显 [复制] 一枚 + 末尾「⋯」44px（长按 sheet 同一入口，降低记忆成本）
- 👍/👎 从常显移入 sheet（**减法**：常驻 6 → 2）
- hover 显隐规则**保留在 PC**；移动端走 `.is-mobile` 分支的常显态（零 hover 依赖）

### 4.3 引用芯片

| 项 | 现状 | 目标 |
|---|---|---|
| × 删除 | 14px + `display:none`→hover | **32px 常显**，视觉 14px，`data-hit` 补到 44 |
| hover 预览 | mouseenter+200ms | 点按芯片即展开预览卡（`AgentRefHoverPreview` 复用） |
| 拖拽排序 | HTML5 DnD | 长按 400ms 起拖 + 位移 >10px 阈值 |
| 数量提示 | 横滚无 affordance | 首屏右侧渐隐遮罩 + 「+N」角标 |

### 4.4 AskUserCard（阻塞式，改造最重）

现状选项是 26px chip 墙 + 18px「跳过此题」纯文字。移动端改为：

```
╭──────────────────────────────╮
│ 这个问题需要你决定       已答 1/3│
├──────────────────────────────┤
│ ○ 方案 A：分镜优先           │ 52px 全宽行
│ ● 方案 B：动效优先      ✓    │ 52px（选中态 accent 边）
│ ○ 方案 C：成本优先           │ 52px
├──────────────────────────────┤
│ [ 其他（请说明）        ]     │ 44px 输入
│ [ 跳过此题 ]        [ 提交 ]  │ 44px
╰──────────────────────────────╯
```
- 单选题不再用 chip 网格（chip 天然暗示「可多选」），改**单选列表行**
- 「跳过此题」从 18px 纯文字升为 44px 次级按钮（放在提交左侧，不与正文混排）
- 多选题保留 chip 网格但升到 36px 高

### 4.5 弹层统一（D-8）

| 弹层 | 现状 | 目标 |
|---|---|---|
| `ForceChoiceDialog` | 居中 `max-w-md` | 移动端 bottom sheet，按钮 44px 全宽，安全区避让 |
| `AgentAssetPicker` | `max-h-[min(420px,55vh)]` 居中浮层 | 移动端 70vh sheet，顶部搜索吸顶、网格 3 列 88px 格 |
| `AgentRefHoverPreview` | hover 弹层 | 移动端点按展开，锚在芯片上方 |
| 提议等待卡 | 就地内联 | 抽屉全展开（§2.3） |

### 4.6 空态与可发现性

- 空闲态裸条当前只有 11px 灰字「按住说话 · 点按输入」（`:4325`、`:6000-6011`）——**语音这个核心能力完全靠一行灰字被发现**
- 目标：条内加 28px 麦克风图标（**保留视觉引导，交互仍走长按**，不新增独立按钮），文案升级为「按住说话 · 或点此输入」，`:active` 态条边框变 accent

---

## 5. 减法清单（汇总）

| 动作 | 对象 | 方式 | 理由 |
|---|---|---|---|
| **删** | 气泡 👍/👎 常驻位 | 移入长按 sheet | 6 → 2 常驻；反馈数据价值远低于发现成本 |
| **删** | 「撤销本轮」按钮（移动端） | `v-if` 摘除 | ⛔ 恒 disabled 的 20px 死按钮 |
| **删** | ＋菜单「专家」「连接器」项（移动端） | 移除 | `disabled` + 「待后续开发」，废位 |
| **删** | CanvasRefPickOverlay「Esc」提示（移动端） | 文案改「点 ◎ 完成」 | 无键盘设备 |
| **删** | 五处重复的「知道了」按钮 | 合并到单轨抽屉 | 文案重复占位 |
| **删** | 移动端 `prefers-reduced-motion` 之外的 hover-only 规则 | 全局禁用 hover 依赖 | 触屏无 hover |
| **移** | 独立麦克风按钮 | 已移（现状）+ 视觉引导补回 | 长按更优，但需可发现 |
| **移** | 思考档位 chip | composer → 模型参数 sheet | 位置被裁，功能不能消失 |
| **移** | Tab 键预测接受 | → ghost 尾按钮 / 移动端不显示 | 无键盘 |
| **移** | 引用芯片 HTML5 DnD | → 长按拖 | 触屏无 DnD |
| **并** | 消息操作行 6 钮 | → 常显 2 + 长按 sheet | 密度 |
| **并** | 五类系统层浮层 | → 单轨 + 抽屉（优先级仲裁） | 屏幕占用 |
| **并** | ① 模型 ② 思考档位 ③ 技能 三个下拉 | → 一个参数 sheet | 入口收敛 |
| **改** | AskUserCard chip 网格 | → 单选全宽行 / 多选 36px chip | 语义 + 触控 |
| **改** | 弹层居中形态（ForceChoice / AssetPicker） | → bottom sheet | 桌面心智 |
| **改** | hover 显隐 | tap 常显 / 长按展开 | 触屏原生 |
| **留** | composer 三态裸条 / 按住说话 / 上滑取消 / 双行组织 / 安全区三令牌 / TabBar 四页签 / 顶栏 chat 三入口 | 不动 | 已定稿或已达标 |

---

## 6. 架构评估与重构建议

### 6.1 结论：三层重构，数据与状态机零改动

**需要重构**

1. **移动端编排壳层** —— 新增 `apps/web/src/components/mobile/MobileConversationShell.vue`
   - 拥有：对话页签的顶栏编排、系统层单轨、composer 门控、弹层（sheet）宿主、长按入口
   - `AgentSideRail` 退为内容渲染器（对话流 + composer），只通过 props 接收形态
   - 收益：`isMobileLayout` 分支从 27 处降到壳边界；移动端专属组件从 0 个变成 1 个
   - 与画布页方案 `MobileCanvasShell` 同构，两壳最终合为 `MobileAppShell`（D-10）
2. **手势层** —— 新增 `apps/web/src/composables/useLongPress.ts`
   - 单一长按实现（阈值/容差/haptic/滚动取消）
   - 对话页（气泡菜单、引用拖）与画布页（节点菜单）共用，画布页方案里的第二份实现取消
3. **能力层** —— 扩展 `useAgentMobileLayout.ts`
   ```ts
   // 形态（决定布局）
   type MobileLayout = 'conversation' | 'canvas-window' | 'canvas-full'
   // 能力（决定呈现与可达性）
   type MobileCapabilities = {
     longPress: boolean       // hover:none 媒体查询
     finePointer: boolean     // pointer:coarse 反向
     keyboardHint: boolean    // 有物理键盘 / 建议显示 Esc 类提示
   }
   ```
   断点仍是 767px 单值，但**消费方读语义而非读 `isMobileLayout` 布尔**
   - 修掉 D-5 的根因：`display:none` 式裁剪 ⇒ 改为「能力集里没有的入口不给，替代入口必须给」
4. **呈现适配层** —— 触控令牌全局化 + `data-hit` 约定；hover-only 规则在移动端作用域内一律不生效
5. **弹层层** —— 新增 `MobileSheet.vue`（`components/mobile/`）作为移动端弹层单一宿主，ForceChoice / AssetPicker / 消息菜单 / 参数 sheet 全部复用

**不需要重构**

- `AgentSideRail` 的 composer 状态机、`barShape` 三态路由（`mobileBarLayout.ts`）、`holdGesture` 阈值
- SSE 流、消息渲染本体、`presentation/*` 组件树、产物卡
- propose / turn receipt 状态机（ADR-0011 已收敛）
- 积分 / 计费 / 资产服务层

### 6.2 `isMobileLayout` 治理（与画布页方案 §6.2 合并条款）

- 移动端**编排**只归壳组件所有；页面级组件不再新增 `isMobileLayout` 条件
- PC 组件内**禁止新增 767px media query 补丁**（现存对话侧 4 处：`:5815` 命中区、`:5923` 附件卡、`:5994` 思考档、`:5995` 麦克风 —— 前 2 处随壳层上收，后 2 处由 D-5 能力重定向消除）
- 移动端专属呈现必须落 `components/mobile/` 或 `*Mobile*` 命名

### 6.3 风险与回退

| 风险 | 缓解 |
|---|---|
| 长按与对话流滚动打架 | `touchmove > 8px` 立即取消；`ignoreWhen` 钩子接滚动状态 |
| 条级 300ms hold 与气泡 400ms 长按阈值混淆 | 两者作用于不同元素不相交；阈值差 100ms 足够，`holdGesture.ts` 不动 |
| 常显按钮撑高气泡 | 只增 44px 一行，且 user 侧改 `min-width:0` 截断；用户气泡原本就有编辑态布局逻辑可复用 |
| 参数 sheet 塞模型+思考+技能过载 | sheet 内分组（模型 / 推理 / 技能），技能仍走二级列表 |
| 壳层抽取回归面大 | 分 PR 独立分支；PR1-4 均为局部改动，壳层抽取放最后且可单独 revert |
| PC 零回归 | 所有移动端分支在 `.agent-panel-mobile-dock` / 能力集内；PR1-4 要求 `git diff` 无 PC 路径改动 |
| 断点语义化改造波及 CanvasPage | 与画布页方案 D-9 同一个 PR 做，避免两次改同一文件 |

---

## 7. 分期实施计划

| PR | 内容 | 依赖 | 验收 |
|---|---|---|---|
| **PR1 触控地基** | `--lnk-hit-*` 令牌 + `data-hit` 全局规则；对话页 14 项触控达标（§4.1）；回到底部改 48px FAB；重试生成/CanvasLocateButton 扩区 | 无 | 走查 T-1..T-6 |
| **PR2 长按与消息操作** | `useLongPress`；消息常显 2 钮 + 长按 sheet（新增 `MessageActionSheet`）；👍👎 移入 sheet；引用芯片 × 常显 + 点按预览 + 长按拖 | PR1 | 走查 M-1..M-6 |
| **PR3 系统层与弹层** | 单轨 + 抽屉仲裁；AskUserCard 移动端行化；`MobileSheet` 落地，ForceChoice / AssetPicker 收编；propose 抽屉化；「撤销本轮」摘除 | PR1 | 走查 S-1..S-6 |
| **PR4 能力重定向** | 能力集 composable；模型参数 sheet（模型 + 思考档位 + 技能）；Tab 预测改点按；@提及点按选中；MicButton 空态可发现性 | PR2/3 | 走查 C-1..C-5 |
| **PR5 壳层合并** | `MobileConversationShell` + `MobileCanvasShell` → `MobileAppShell`；`isMobileLayout` 分支收敛；media query 上收；hook 治理写入 AGENTS.md | PR1-4 | 全量回归 + PC 零 diff 走查 |

与画布页方案的关系：PR1-4 两份方案同序推进（对话页 PR2 ↔ 画布页 PR1 的长按实现合并为一次）；PR5 双方合并为一个壳。

每 PR 完必须真机走查（iOS Safari + Android Chrome 各一轮），遵循 `docs/agent/delivery.md` 分支纪律。

---

## 8. 验收走查表（真机）

### 触控（PR1）

| # | 项 | 通过标准 |
|---|---|---|
| T-1 | 气泡操作按钮 | 免 hover 即见，常驻 ≤2 枚，≥44×44 |
| T-2 | 全部移动端可点元素 | ≥44×44（含引用芯片 ×、回到底部、propose 钮、AskUserCard） |
| T-3 | `:active` 反馈 | 每个按钮有缩放/叠层反馈 |
| T-4 | 键盘弹起 | composer 不被遮挡，系统层不被顶穿 |

### 消息与手势（PR2）

| # | 项 | 通过标准 |
|---|---|---|
| M-1 | 长按气泡 | 400ms 出 sheet；滚动中不误触；遮罩点按收起 |
| M-2 | sheet 项 | 6 项语义与现状一致，删除带二次确认 |
| M-3 | 长按引用芯片 | 先出预览还是先起拖？判定明确且不误触 |
| M-4 | 引用删除 | 无需 hover，× 常显可点 |
| M-5 | 👍👎 | sheet 内可达，有选中态 |
| M-6 | 拖排序 | 长按后拖动有插入位指示，松手生效 |

### 系统层与弹层（PR3）

| # | 项 | 通过标准 |
|---|---|---|
| S-1 | 常态系统层 | ≤32px 一行，不超过输入区上方 40px |
| S-2 | 生成中 | 单轨显示阶段/进度/耗时/积分，抽屉可停 |
| S-3 | 插话槽 | 折叠进单轨，抽屉内「立即插话/等它跑完/取回/放弃」齐全 |
| S-4 | AskUserCard | 单选行 52px 可点；跳过/提交 44px；必答题不被遮挡 |
| S-5 | ForceChoice / AssetPicker | 均从底部升起，按钮 44px，不遮 tabbar |
| S-6 | propose | 抽屉展开，定位/取消 ≥40px |

### 能力（PR4）

| # | 项 | 通过标准 |
|---|---|---|
| C-1 | 思考档位 | 移动端有入口且生效 |
| C-2 | 模型切换 | 空草稿即可换模型（不需先打字） |
| C-3 | 预测补全 | 无 Tab 键也能接受，或不显示 |
| C-4 | @提及 | 点按可选中；下拉不被键盘遮挡 |
| C-5 | 语音 | 空态可发现（图标 + 文案 + accent 反馈） |

### 视觉与回归（PR5）

| # | 项 | 通过标准 |
|---|---|---|
| V-1 | 令牌 | 移动端对话 chrome 无 `--neo-*` / hex / rgba 文字色 |
| V-2 | 双主题 | 深浅切换后全部 chrome 对比度达标（AA） |
| V-3 | 表层语言 | 顶栏 / FAB / sheet / 轨道 / 裸条 五处统一 |
| V-4 | PC 零回归 | 走查全绿，PR1-4 diff 无 PC 路径改动 |
| V-5 | 与画布页接缝 | 长按/能力集/触控令牌三处无重复实现 |

---

## 附：取证索引

- `apps/web/src/components/agent/AgentSideRail.vue`（3396-3420 形态类、3776-3870 消息操作行、3878-3907 收据行、3908-3913 进度卡、3988-4001 回到底部、4006-4046 propose 卡、4049-4057 turn 状态、4067-4086 取消提示、4096-4115 状态行、4153-4224 插话槽、4263-4286 录音态、4292-4343 输入/隐藏 file、4350-4524 ＋菜单、4531-4576 模型/思考、4583-4599 mic/发送、4680-4694 贴底壳、4755-4764 对话整页、4784-4789 画布视图裁剪、5382-5414 气泡操作样式、5576-5579 user hover、5787-5830 命中区扩展、5884-5891 idle 条、5923-5949 附件卡+遮罩、5981-6037 三态减法、6199-6213 ◎ 锚点）
- `apps/web/src/composables/useAgentMobileLayout.ts`（全文 30 行，767px 单判据）
- `apps/web/src/components/agent/AgentSidebarRefChip.vue`（62-80 hover 预览、104-127 芯片、152-162 × 14px、312-330 hover-only、245-248 history tooltip）
- `apps/web/src/components/agent/AgentRefStrip.vue`（37-82 HTML5 DnD、125-145 横滚无 affordance）
- `apps/web/src/components/agent/AskUserCard.vue`（115-145 按钮组、179-188 chip 26px、202-212 确认、220-243 提交/取消、253-262 跳过 18px）
- `apps/web/src/components/agent/AgentTaskProgressCard.vue`（55-73 进度项、70-72 hover 图钉）
- `apps/web/src/components/agent/AgentTurnTimeline.vue`（212-229 thinking、246-268 tool、278-282/325-335 定位与重试 18px、361-365 dense 46vh）
- `apps/web/src/components/agent/AgentExecutionTrace.vue`（134-147 折叠、159-184 步骤 hover、201-205 dense 46vh）
- `apps/web/src/components/agent/AgentCanvasOutputs.vue`（121-127 全部定位、169-174 单项、181-188 展开全部）
- `apps/web/src/components/agent/ForceChoiceDialog.vue`（14-42 kind 文案、65-95 居中弹窗 30px 按钮）
- `apps/web/src/components/agent/AgentAssetPicker.vue`（78 × 28px、89 max-h 420px/55vh、95-114 网格）
- `apps/web/src/components/agent/present/AgentNodeGraph.vue`（331-371 三枚 14px 图标钮）
- `apps/web/src/components/agent/composer/mobileBarLayout.ts`（三态路由）、`holdGesture.ts`（300/60）、`prediction.ts`（Tab 接受）、`statusLine.ts`、`thinkingLevels.ts`
- `apps/web/src/components/mobile/MobileTopBar.vue`（197-211 34px、223-240 28px 胶囊、268-283 26px 积分）
- `apps/web/src/styles/design-tokens.css`（L2 表面/边框/圆角/动效/遮罩已有；**无触控命中区令牌 = D-6 缺口**）
- 姊妹方案：`./2026-10-19-mobile-canvas-ux-redesign.md`