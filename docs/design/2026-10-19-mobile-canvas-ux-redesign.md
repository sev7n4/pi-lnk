# 移动端画布页 UI/UX 重构设计方案

> 状态：**已批准（2026-10-19）— PR1~PR5 代码全部合并上线**；PR1+PR2（#490）、PR3 多选与 dock（#495）、PR4 视觉与卫生（#497）、PR5 壳层抽取（#500）+ 收尾（#502）均已上线，PC 端形态零变更。**代码项已无缺口**；未落地条目与裁决状态见 §6.5（PC 工具条底部化 ⏸待裁决、形态×能力集拆分 ⛔被配对方案阻塞）。**§8 真机走查仍欠**（合并上线 ≠ 验收完成）
> 范围：**≤767px 画布页签的页面结构 / 操作按钮 / 手势模型 / 视觉规范 / 架构分层**。PC 端形态不动。
> 上游：IA v3.2（PR #478，#482）+ [移动端 Composer/画布/SSE 边界规格](../superpowers/specs/2026-10-17-mobile-composer-sse-boundary-design.md)（composer 条形态已定稿，本方案不改其内部）
> 配对：[移动端对话页 UI/UX 优化设计方案](./2026-10-19-mobile-conversation-ux-redesign.md)（同批；共享 `useLongPress` / `--lnk-hit-min` / 断点「形态 × 能力」拆分，两份的 D 编号互相引用）
> 基线：`feat/propose-confirm-single-surface` @ d6cb79ce（2026-10-19 代码级取证）
> 日期：2026-10-19

---

## 0. 决策摘要

| # | 决策 | 说明 |
|---|---|---|
| **D-1** | **画布主位不变，壳层需要重构** | 数据层 / composer 状态机 / 面板本体零改动；重构集中在「移动端壳 + 手势配置 + 入口编排」三层 |
| **D-2** | **左侧竖轨（NodePanelDock）整体退出移动端** | hover 唤出 + 268px 弹出菜单 + 「常驻/隐藏」开关全是 PC 鼠标遗产，触屏全部降级。以左下 **＋ FAB → 全宽新建 sheet** 取代 |
| **D-3** | **手势模型重新定义：单指=平移，双指=缩放** | 现行 `pan-on-drag=[1,2]` 在触屏被 d3-zoom filter 拒绝（代码级证据 §1.4-P0-1）⇒ 单指拖拽不平移、捏合不缩放，移动端导航只剩缩放胶囊。按断点分流，PC 保持「左键框选 / 中右键+Space 平移」 |
| **D-4** | **多选从「隐藏手势」改为「显式模式」** | 移动端放弃拖拽框选（与平移互斥），改「长按节点 → 进入多选模式 → 点选切换」；多选工具条从「贴选区的 13 个 30px 图标」改为**底部固定动作条 + 「更多」sheet** |
| **D-5** | **入口收敛：一动作一入口** | 添加节点 2→1（＋FAB）；资产库 3→2（画布内只留 ＋sheet 一个，「发现-资料库」复用它）；模型设置 2→1（只留「我的」）；任务从竖轨移入顶栏 ⋯ 动态项 |
| **D-6** | **节点长按 = 统一上下文 sheet** | 长按菜单从 PC 的 `contextmenu` 小浮层升级为 44px 行高的动作 sheet，补「重命名」；`dblclick` 重命名保留仅 PC。长按手势走**单一 composable `useLongPress`**（400ms / 位移 10px / 滚动取消，与对话页气泡菜单共用一份实现，见配对方案 D-2） |
| **D-7** | **触控标准 44px 全线达标** | 现存 30px 图标钮（多选工具条）、13px 引用钮（节点标题栏）、hover-only 分组色下拉，全部重做 |
| **D-8** | **令牌单一：移动端 chrome 只消费 `--lnk-*` L2** | `MobileCanvasTopControls` 仍在用旧 `--neo-*` 体系，与顶栏/页签同屏不同表面；本次作为令牌收敛第一批 |
| **D-9** | **架构：新增 `MobileCanvasShell` 壳组件，收敛 CanvasPage 的 isMobileLayout 分支** | CanvasPage 5526 行、模板内 8+ 处 `isMobileLayout`，组件内又各自 `useAgentMobileLayout`——移动端编排上收为单一壳，画布世界以插槽暴露 |
| **D-10** | **删除死代码** | `CanvasZoomBar.vue` / `GenerationBar.vue` / `CanvasStatus.vue` 零引用，随 PR4 删除 |

**非目标（本期明确不做）**

- composer 裸条内部形态（PR #436/#478 刚定稿，只做热区微调）
- AgentSideRail 对话流门控状态机（已有 spec，另行排期）
- PC 端任何布局 / 交互变更（含框选、快捷键、设置面板）
- 节点参数面板（DockStudioRouter / 各 *DockPanel）内部结构
- 资产库 / 任务面板本体组件（复用，只换承载容器）

---

## 1. 现状盘点（代码级取证）

### 1.1 页面骨架（IA v3.2，已上线）

```
CanvasPage.vue（5526 行）
├─ isMobileLayout = useAgentMobileLayout()（≤767px）
├─ 画布区（mobile-canvas-veiled：对话态 visibility:hidden 保挂载）
│   ├─ CanvasFloatingChrome        ← v-if !isMobileLayout（PC 标题栏+⋯菜单）
│   ├─ VueFlow 画布世界
│   │   ├─ MobileCanvasTopControls ← v-if isMobileLayout && tab==='canvas'（顶部右侧胶囊）
│   │   ├─ CanvasBottomLeftControls← v-if !isMobileLayout（PC 左下视口条）
│   │   ├─ MultiSelectToolbarOverlay → MultiSelectToolbar（PC 设计，无断点适配）
│   │   ├─ NodePanelDock           ← v-if !canvasChromeHidden（⚠️ 无移动端判断，原样上移）
│   │   ├─ DockStudioToolbar       ← 选中节点底部 dock（有 767px media query 清位）
│   │   └─ 各全屏 overlay（精修/切分/裁剪/扩图/重绘/元素编辑/标注）
│   └─ 右上主题/账号簇            ← v-if !isMobileLayout
├─ AgentSideRail（对话侧栏）
│   └─ 移动端 = 贴底 composer 裸条（.agent-panel-mobile-dock）或全屏对话视图
├─ MobileTopBar（teleport body，z-85）
├─ MobileTabBar（z-80，四页签，画布=传送门）
├─ DiscoverPane / ProfilePane（z-75 整页）
└─ mobile-account-pane（积分/订阅二级页，z-90）
```

### 1.2 画布页操作按钮全清单（现状）

| # | 控件 | 位置 | 组件 / 代码 | 触控适配 | 问题 |
|---|---|---|---|---|---|
| 1 | 积分胶囊 | 顶栏右 | MobileTopBar | ✅ 26px 胶囊可点 | — |
| 2 | ⋯ 画布管理菜单（保存/分镜板/发布/导入/导出） | 顶栏右 | MobileTopBar | ✅ 34px | 五项全 PC 工作流概念；手动保存心智 |
| 3 | 小地图开关 | 画布右上胶囊 | MobileCanvasTopControls | ⚠️ 30px | 用 `--neo-*` 旧令牌；弹层仅 132×88 |
| 4 | 缩放 − / % / + | 画布右上胶囊 | 同上 | ⚠️ 30px | 同上 |
| 5 | 适应画布 | 画布右上胶囊 | 同上 | ⚠️ 30px | 同上 |
| 6 | **左侧竖轨：添加（10 类节点）** | 画布左上 top-60px | NodePanelDock | ❌ | 268px 弹出遮 71% 屏宽；desc 文案 PC 密度 |
| 7 | 资产库 | 竖轨 | NodePanelDock → CanvasAssetPanel | ❌ | PC 弹出面板 |
| 8 | 任务 | 竖轨 | NodePanelDock → CanvasTaskHistoryPanel（29KB） | ❌ | PC 弹出面板 |
| 9 | 设置（模型服务） | 竖轨 | NodePanelDock → ProviderConfigDialog（42KB） | ❌ | 与「我的」重复 |
| 10 | 常驻 / 隐藏 | 竖轨 | NodePanelDock | ❌ | hover 唤出机制，触屏无意义 |
| 11 | 多选工具条 ×13 钮 | 贴选区下沿 | MultiSelectToolbar | ❌ | 30px 图标钮；分组色 hover 下拉；布局/导出菜单向下溢出；贴边裁剪 |
| 12 | 分组色 8 色点 | 多选条内 | MultiSelectToolbar | ❌ | hover 展开，触屏不可达 |
| 13 | 选中节点 dock | 底部居中（composer 上方） | DockStudioToolbar | ⚠️ | 收缩态 hover 展开；工具行 10 项（精修/抠图/扩图/裁剪/重绘/元素/标注/旋转禁/下载/存图）无横向滚动 |
| 14 | 节点：加入 Agent 引用 | 节点标题栏右 | NeoBaseNode | ❌ | 13px 图标，热区 ≈13px |
| 15 | 节点：重命名 | 节点标题 | NeoBaseNode | ❌ | 仅 dblclick |
| 16 | 节点：连接手柄 | 节点左右沿 | NeoBaseNode / Handle | ⚠️ | hover/选中才显；hitbox 未见放大 |
| 17 | 长按上下文菜单 | 长按节点 | CanvasContextMenu | ⚠️ | 8 项 PC 小浮层（min-w-160px），无重命名；行高 py-2 |
| 18 | ◎ 引用画布节点 | composer 条内 | AgentSideRail | ✅ | 拾取态跨容器引导已有 placeholder |
| 19 | ＋ 添加引用素材（拍照/图片/文件/资产库） | composer 条内 | AgentSideRail | ✅ | 全屏遮罩修补丁已上 |
| 20 | 模型 ⌄ / 发送 / 按住说话 | composer 条内 | AgentSideRail | ✅ | — |
| 21 | 批量进度卡 | 画布内 | SelectionBatchProgressCard | ⚠️ | PC 卡片尺寸 |
| 22 | 分镜板 / 发布 / 导入 / 导出 | 顶栏 ⋯ | MobileTopBar | ✅ | 同 #2 |

### 1.3 与对话页的交互链路（现状）

- **门（传送门）**：MobileTabBar 画布页签 = 进/出画布的唯一门；`onMobileTabChange('canvas')` ⇒ `mobileCanvasView=true, imm=true` ⇒ composer 一起收（纯画布满屏）。
- **窗 A/B**：对话流内点定位卡 / composer ◎ ⇒ `mobileCanvasView=true, imm=false` ⇒ 画布 + composer 同屏，供「定位引图后继续输入」。
- **回对话**：点「对话」页签 ⇒ `mobileCanvasView=false` ⇒ 画布 `visibility:hidden` 保挂载。
- **顶栏**：对话态 = [≡ 抽屉][积分][+ 新建对话][🕘 历史]；画布态 = [积分][⋯]。
- **生成中跨态**：SSE 流 / 节点状态 / 批量进度卡三处各显一处，无统一「进行中」汇总。

### 1.4 问题清单（按严重度）

#### P0 — 功能级（真机必然体感）

**P0-1 画布手势残缺：单指不能平移、双指不能缩放。**
`CanvasPage.vue:5019` `:pan-on-drag="viewportSettings.viewLocked ? false : [1, 2]"`（中/右键平移）+ `:selection-key-code="true"`。
代码级证据（@vue-flow/core 1.48.2 `vue-flow-core.mjs`）：
- L8469 `shouldSelectOnDrag = selectionKeyCode===true && shouldPanOnDrag!==true` ⇒ 左键/触屏拖空白 = **框选**
- L8571 d3-zoom filter：`Array.isArray(panOnDrag) && !panOnDrag.includes(eventButton) && (mousedown||touchstart) ⇒ return false`；TouchEvent 无 `button`（undefined）⇒ **触屏 touchstart 全部被 filter 拒绝** ⇒ d3-zoom 不挂手势 ⇒ 单指拖拽不 pan、双指捏合不 zoom（L8561 的 pinch 分支也过不了 filter）
⇒ 移动端画布导航只剩：缩放胶囊 ±、适应画布、小地图点击/拖动。节点拖动与连接（useDrag，不走 d3 filter）不受影响。
⚠️ 沙箱推不出真机行为，**需 iOS Safari / Android Chrome 真机复测确认**（若个别 WebKit 版本给 TouchEvent 补了 `button:0`，则表现为「单指拖拽=框选、无平移」，同样是坏结果）。

**P0-2 左侧竖轨原样上移，五项全降级。**
`NodePanelDock.vue` 无任何 767px 适配（全仓仅 DockStudioToolbar / CanvasRefPickOverlay / AgentSideRail 有 media query）：
- 「常驻/隐藏」+ 自动隐藏依赖 `mouseenter/mouseleave`（L139-151）——触屏无 hover；localStorage 默认 pinned ⇒ **永久占位左缘**
- 弹出菜单宽 268px（L279）在 375px 屏遮罩 71%；三个弹出（添加/资产/任务）同位置右开，无 sheet 化
- 五钮竖排 ≈ 250px 高，与 MobileCanvasTopControls（右上）、composer（底部）三方挤画布

**P0-3 多选工具条 13 钮 / 30px / hover 下拉。**
`MultiSelectToolbar.vue`：`.toolbar-action` 30px hit（L498-501）；分组色 `@mouseenter` 展开（L291-292，色点静止 scale(0.7) 仅 hover 放大）；布局/导出菜单 `top-full` 向下开——工具条贴在选区下沿，近屏底必溢出；绝对定位贴选区，选区靠屏缘时横向裁剪。最多同屏 13 个图标钮（已选N/生成视频/阻断/缺词/批量/重生成/分组色/解组|打组/副本/含上游/加引用/布局/导出/删除）。

**P0-4 节点重命名仅 dblclick；长按菜单无重命名。**
`NeoBaseNode.vue:125` `@dblclick.stop="startRename"`；`CanvasContextMenu.vue` 8 项无「重命名」。移动端无可靠双击手势 ⇒ 移动端**无法重命名节点**。

#### P1 — 架构 / 一致性

- **P1-1 入口重复**：添加节点 ×2（竖轨「添加」/ composer＋语义相邻易混）；资产库 ×3（竖轨弹出 / composer＋瓦片 / 发现-资料库）；模型设置 ×2（竖轨 / 我的）。
- **P1-2 hover 依赖蔓延**：NodePanelDock 自动隐藏、DockStudioToolbar 收缩态悬停展开（L163-168 hit 区 + mouseenter）、MultiSelectToolbar 分组色、NeoBaseNode 手柄 hover 显——四类 PC 手势在触屏全部静默降级。
- **P1-3 令牌双轨同屏**：`MobileCanvasTopControls` 用 `--neo-border/hover-bg/text-muted/hi-bg`（旧体系），`MobileTopBar/TabBar` 用 `--lnk-*`（L2）⇒ 同屏两套表面 / 边框 / 文字色，深浅主题各貌；违反 AGENTS.md「组件只消费 L2/L3」。
- **P1-4 isMobileLayout 分支蔓延**：CanvasPage 模板 8+ 处 `isMobileLayout`；AgentSideRail / 各组件又各自 `useAgentMobileLayout()`； DockStudioToolbar 内 767px media query 清位——移动端编排无单一所有者，改动必全文搜索。

#### P2 — 视觉 / 文案 / 卫生

- 顶栏 ⋯ 五项（保存/分镜板/发布/导入/导出）全 PC 工作流概念，无分组无频次排序；「保存画布」手动保存与 PC 心智绑定。
- 竖轨「添加」菜单 10 项 × desc 文案，信息密度 PC 化。
- 死代码：`CanvasZoomBar.vue`（176 行）/ `GenerationBar.vue`（3.9KB）/ `CanvasStatus.vue`（1.8KB）**零引用**。
- 画布空态无移动端引导（新用户进画布页签面对空白 + 一排控件无所适从）。

---

## 2. 设计原则

1. **画布主位，composer 脊柱**（延续 IA v3：三态下画布份额最大化；恒同屏的只有画布 + composer）
2. **触控优先**：44px 最小热区；tap 取代 hover；bottom sheet 取代 hover 下拉；显式模式取代隐藏手势
3. **一动作一入口**：同一语义只保留一个画布内入口，其余按场景（浏览 / 引用）明确分工
4. **渐进披露**：高频平铺（生成 / 引用 / 新建），低频进「更多」sheet，设置进「我的」页
5. **令牌单一**：移动端 chrome 只消费 `--lnk-*` L2/L3，深浅成对（design-token.test.ts 守卫）
6. **状态可预期**：多选 / 拾取 / 生成中都是显式模式，有明确进入与退出，不靠用户猜手势

---

## 3. 目标信息架构

### 3.1 三区

```
┌─────────────────────────────┐
│ 全局壳   MobileTopBar + MobileTabBar（不变，⋯菜单重排） │
├─────────────────────────────┤
│                             │
│  画布世界（唯一主位）          │
│   · 节点 / 连线 / 视口胶囊    │
│   · ＋ FAB（左下，唯一新建）   │
│   · 长按 → 上下文 sheet      │
│   · 多选 → 底部动作条        │
│                             │
├─────────────────────────────┤
│ 脊柱   composer 裸条（PR#436 定稿，仅热区微调）│
└─────────────────────────────┘
```

### 3.2 六态状态机

| 态 | 进入 | 界面 | 退出 |
|---|---|---|---|
| **S0 纯画布** | 门（页签）进入 | 无 composer；视口胶囊 + FAB | 点对话页签 / 长按节点 |
| **S1 画布 + composer** | 窗 A/B 进入、默认态 | ＋FAB + composer | 同上 |
| **S2 单节点 dock** | 点选节点 | 底部 dock（参数+生成+工具行）替代 composer | 点空白 / 关闭 |
| **S3 多选态** | 长按节点 →「多选」 | 底部动作条 + 已选节点勾选徽标 | 完成 / 取消 |
| **S4 拾取态** | composer ◎ | 节点可点高亮 + 顶部引导条 | 再点 ◎ / 选满 |
| **S5 全屏工作台** | 精修/切分/裁剪/扩图/重绘/元素/标注 | 全屏 overlay（现状保留） | 关闭 |

S2/S3 与 composer 的互斥沿用现状（`has-studio-dock` ⇒ composer 收）；S3 动作条贴在 composer/dock 之上，不叠 z。

### 3.3 手势模型（本期核心交付，按断点分流）

| 手势 | 移动端（新） | PC（不变） |
|---|---|---|
| 单指拖空白 | **平移画布** | 左键 = 框选；中/右键/Space+拖 = 平移 |
| 双指捏合 | **缩放** | ctrl+滚轮 / 滚轮 |
| 单指点节点 | 选中 → S2 | 同 |
| 单指拖节点 | 移动节点 | 同 |
| 长按节点 | **上下文 sheet**（重命名/引用/副本/删除…） | 右键菜单（现状） |
| 长按节点 →「多选」 | **进入 S3**，此后点选切换 | Shift/⌘ 点选 + 左键框选 |
| 拖手柄 | 连线（connectionRadius 48 保留） | 同 |
| 双击节点 | （空） | 重命名保留 |

实现：VueFlow props 按 `isMobileLayout` 计算——移动端 `panOnDrag=true`、`selectionKeyCode=null`、`zoomOnPinch=true`（默认）、`panOnScroll=false`；多选由应用层「选择模式」状态驱动（点选切换 + 全选/取消），**不依赖 selectionKeyCode 框选**。

---

## 4. 页面重构详设

### 4.1 全局壳（微调）

- **MobileTopBar 画布态**：`[积分] [⋯]` 不变。⋯ 菜单按移动频次重排并分组：
  1. 发布作品（高频）
  2. 分镜板
  3. 导出工作流（full_package 默认；轻量/清单两项进二级）
  4. 导入工作流
  5. ~~保存画布~~ → 改为**自动保存状态行**（保存中/已保存 时间戳，点按可手动存），从菜单移除
- **MobileTabBar**：不变（四页签 + 传送门语义已定稿）。
- **积分胶囊**：不变；点按进「我的-积分」（现状已通）。

### 4.2 画布主区

- **视口胶囊**（MobileCanvasTopControls 保留，改造）：
  - 令牌迁 `--lnk-*`：`--lnk-surface-overlay` 底 + `--lnk-border-subtle` 0.5px 边；钮 34px、条高 40px
  - 小地图弹层 132×88 → **160×104**，遮罩 `--lnk-accent-subtle`
  - 增加持久化：小地图开关态写入画布设置（与 PC `minimapExpanded` 同源，跨端一致）
  - 排序：小地图 | − % + | 适应（现状不变）
- **＋ FAB（新，取代左侧竖轨）**：
  - 位置：画布区左下，composer 上方（`bottom: calc(composer-h + 12px)`，发布 `--lnk-agent-dock-h` 同 dock 清位机制）；48px 圆；`--lnk-accent-gradient` 底 + 白加号；`:active` scale(0.92)
  - ⚠️ **定位契约（2026-10-20 真机走查补）**：底部锚定元素必须用 **`position: fixed` 贴可见视口底**，**不得**用 `absolute` 贴 100vh 根容器底边——移动浏览器带地址栏 + 底部工具条时 `100vh` 比可见视口高约 105px（真机实测 100vh 804px / 可见 699px）⇒ 锚底的 `absolute` 元素**整颗掉出可见区**（＋FAB 不可见 ⇒ 空态文案「点左下 ＋」成死指引；保存状态行、多选动作条同理）。页签栏 / 顶栏本就是 `fixed`，同坐标系才有一致的避让关系。
  - ⚠️ **同位互压**：＋FAB（48px 圆，`left:12px`）与自动保存状态行曾**完全同位**（同一 `left` + 同一 `bottom` 公式）⇒ FAB(z60) 压住状态行(z54)的圆点与首字。状态行须横向让开（`left: 68px` = 12 + 48 + 8）并与 FAB 垂直居中（`bottom` +10px = (48−28)/2）。
  - **多选态不出 FAB**：多选动作条接管同一条底部清位（与自动保存状态行同一规则）。
  - 点击 → **全宽 bottom sheet「新建」**（≈ 60vh）：
    - 顶部通栏瓦片：**资产库**（插入节点语义）
    - 2 列宫格：10 类节点（图标 + 名称 + 单行 desc，行高 56px）
    - 拖拽把手 + 遮罩点按收起；`--lnk-scrim`
  - 空画布时 FAB 呼吸微动效 + 空态文案（两变体，按是否纯画布满屏 `mobileCanvasImm`）：
    - **窗态**（composer 在场）：「点 ＋ 新建节点，或按住底部条说话」
    - **纯画布满屏**（无底部条）：「点左下 ＋ 新建节点；想交给 AI，先切到对话页」（ADR-0011 T6 引入，2026-10-20 回填）
- **节点级交互**：
  - 长按 → **上下文 sheet**（44px 行高）：重命名 / 加入 Agent 引用 / 编辑图像 / 下载 / 存入资产库 / 解组（group）/ 新建副本 / 副本（含上游）/ 删除（danger 置底）
  - 标题栏「加入引用」钮 13px → **32px 热区**（或移除，统一走长按 sheet；建议保留可见钮，降低发现成本）
  - 手柄：选中即显（现状），hitbox 扩至 40px（`.handle-hitbox` 放大）
  - dblclick 重命名：仅 PC 保留
- **多选态 S3**：见 4.4。

### 4.3 底部 composer 脊柱

- 内部形态不变（PR #436/#478 定稿）。
- 微调：＋ / ◎ / 发送热区标注 44px（现状 h-8=32px，扩至 36-40px + `agent-hit-expand` 已部分覆盖，补齐 ◎ 与发送）；生成中「停止」与「排队」视觉区分保持。
- ◎ 拾取态（S4）：顶部引导条（CanvasRefPickOverlay 已有）增加「已选 N · 点 ◎ 完成」。

### 4.4 选中态与多选态

**S2 单节点 dock（DockStudioToolbar）**：
- 收缩态由 hover 展开改为 **tap 切换**（底部把手指条 = 折叠/展开，同 iOS 抽屉把手）；生成中/锁定不折叠（现状保留）
- 工具行 10 项 → **横向滚动**（`overflow-x:auto` + `scroll-snap`），44px 钮；「旋转（禁用）」**隐藏**，点亮时再出现
- 文件组（下载/存图）保留行内右端
- 清位公式不变：`bottom = --lnk-agent-dock-h + --lnk-tabbar-h + safe-area + 12px`

**S3 多选动作条（MultiSelectToolbar 重构）**：
- 形态：**底部固定条**（贴 dock/composer 上方，全宽 - 24px 边距），不再贴选区绝对定位
- 条内（≤4 钮，44px）：已选 N ｜ 批量生成 N（主操作，accent）｜ 停止（运行中）｜ 更多 ⋯
- 「更多」sheet：分组 / 解组 / 分组色（8 色网格 44px 格）/ 新建副本 / 副本（含上游）/ 加入 Agent 引用 / 整理布局（顺着连线 / 自动网格）/ 导出（完整 / 仅 JSON / 媒体清单）/ 删除（danger 置底）
- 阻断 / 缺词徽章：保留语义，改为条内 warning 徽章 + 点击定位
- 已选节点加勾选角标；点空白 / 「完成」退出 S3

### 4.5 入口收敛表（减法落点）

| 语义 | 现状入口 | 目标 |
|---|---|---|
| 新建节点 | 竖轨「添加」 | **＋ FAB sheet**（唯一） |
| 资产库（插入节点） | 竖轨弹出 | **＋ FAB sheet 顶部瓦片**（唯一画布内） |
| 资产库（加引用） | composer＋瓦片 | 保留（引用语义） |
| 资料库（浏览） | 发现页签 | 保留，复用同一面板组件 |
| 任务 | 竖轨「任务」 | 顶栏 ⋯ 动态项「任务（N）」——有运行中/近期任务才出现 |
| 模型设置 | 竖轨「设置」+ 我的 | **只留「我的」** |
| 常驻/隐藏 | 竖轨开关 | **删除** |
| 保存 | ⋯ 手动保存 | 自动保存 + 状态行 |
| 分组色 | 工具条 hover 下拉 | 多选「更多」sheet 色板 |
| 布局/导出 | 工具条内下拉 | 多选「更多」sheet 列表 |

### 4.6 视觉规范（移动端 chrome）

| 维度 | 规范 | 令牌 |
|---|---|---|
| 表面 | 毛玻璃胶囊 / sheet | `--lnk-surface-overlay` / `--lnk-surface-raised` |
| 边框 | 0.5px 发丝线 | `--lnk-border-subtle` |
| 圆角 | 胶囊 999 / 卡 12-16 / sheet 顶 20 | `--lnk-radius-*` |
| 主操作 | 渐变实心 + 白字 | `--lnk-accent-gradient` + `--lnk-text-on-accent` |
| 触控反馈 | `:active` scale(0.94) + `--lnk-pressed-overlay`；禁 hover-only | — |
| 动效 | 微反馈 120ms；sheet 250ms `cubic-bezier(.22,1,.36,1)` | `--lnk-duration-*` / `--lnk-ease-*` |
| 触控 | 最小 44×44（下沉为 `--lnk-hit-min` 令牌 + `data-hit` 全站约定，与配对方案 D-6 同一份）；`touch-action: manipulation`；`-webkit-tap-highlight-color: transparent` | — |
| 主题 | 深浅成对，`design-token.test.ts` 守卫 | — |

---

## 5. 减法清单（汇总）

| 动作 | 对象 | 方式 | 理由 |
|---|---|---|---|
| **删** | NodePanelDock 竖轨（移动端） | 组件保留供 PC，移动端 `v-if` 摘除 | hover 遗产 + 268px 弹出 + 永久占位 |
| **删** | 「常驻/隐藏」开关（移动端） | 同上 | 触屏无意义 |
| **删** | dblclick 重命名（移动端） | 长按 sheet 取代 | 无可靠双击手势 |
| **删** | 分组色 hover 下拉 | 「更多」sheet 色板 | hover 不可达 |
| **删** | CanvasZoomBar / GenerationBar / CanvasStatus | 文件删除 | 零引用死代码 |
| **删** | 「保存画布」菜单项（移动端） | 自动保存状态行 | PC 手动心智 |
| **移** | 任务面板 | 竖轨 → ⋯ 动态项 | 低频，不该占常驻位 |
| **移** | 模型设置（画布内） | 竖轨 → 我的 | 与「我的」重复 |
| **并** | 资产库 3 入口 | ＋sheet / composer＋ / 发现=3 语义 2 组件 | 一动作一入口 |
| **改** | 添加节点菜单 | 竖轨 268px 弹出 → ＋FAB 全宽 sheet | 触控 + 信息密度 |
| **改** | 多选工具条 | 贴选区 13×30px → 底部动作条 + 更多 sheet | 触控 + 溢出 + 贴边裁剪 |
| **改** | 视口胶囊 | `--neo-*` → `--lnk-*`，34px 钮 | 令牌纪律 |
| **改** | 节点引用钮 | 13px → 32px 热区 | 触控 |
| **留** | composer 裸条 / 四页签 / 顶栏 / 各全屏工作台 / 面板本体 | 不动 | 刚定稿或数据面风险 |

---

## 6. 架构评估与重构建议

### 6.1 结论：壳层重构，数据层不动

**需要重构（三层）**：

1. **移动端壳层**——新增 `apps/web/src/components/mobile/MobileCanvasShell.vue`：
   - 拥有：MobileTopBar/MobileTabBar 编排、＋FAB、新建 sheet、多选动作条、任务动态项
   - CanvasPage 保留画布世界（VueFlow + 各 overlay + dock），以 props/插槽与壳交互；**画布世界 overlay（含视口胶囊、空态 `mobile-canvas-empty`）按此归 CanvasPage**——它们依赖 VueFlow 内部定位（胶囊包在 `<Panel>` 内、空态是 canvasArea 内 `absolute inset:0`），而壳层挂在画布外的 fixed 层，搬入会破坏定位
   - 消灭 CanvasPage 模板内 8+ 处 `isMobileLayout` 分支（收敛为壳边界一处）
2. **手势配置层**——新增 `useViewportGestures(isMobileLayout)`（或 computed props）：
   - 单一出处产出 VueFlow 的 `panOnDrag / selectionKeyCode / zoomOnPinch / panOnScroll`
   - 移动端：平移优先 + 应用层多选模式；PC：现状不变
   - **P0-1 修复落在这一层，按断点分流，零 PC 风险**
3. **呈现适配层**——清除 PC 组件内的 hover 依赖（DockStudioToolbar 收缩态 tap 化、MultiSelectToolbar 底部化改造、NodePanelDock 移动端摘除）；`MobileCanvasTopControls` 令牌迁移作为令牌收敛第一批

**不需要重构**：

- VueFlow 数据模型 / 节点 / 边 / 撤销栈（`useCanvasUndoStack` 等）
- AgentSideRail composer 状态机（PR #478 刚重构，本方案只热区微调）
- CanvasAssetPanel / CanvasTaskHistoryPanel / DockStudioRouter 面板本体（复用，只换承载容器：弹出 → sheet）
- 积分 / 订阅 / 资产等服务层

**PR5 落地结果（#500）——与本节有两处有意偏差，已确认为最终形态**：

- 壳层已落地 `apps/web/src/components/mobile/MobileCanvasShell.vue`（约 400 行），CanvasPage 以 `v-if="isMobileLayout"` 单点委托；`isMobileLayout` 分支由 **31 处降至 20 处**。
- **偏差 1：共享状态真源仍留在 CanvasPage**（`mobileAppTab` / `mobileCanvasView` / `mobileCanvasImm` 被 `AgentSideRail`、`mobileStudioDockOpen`、`focusNodeById`、`pickMode` watch 共用）⇒ 壳层经**函数式 actions prop**（`agentActions` / `batchActions` / `onTabChange` …）触发本页逻辑、**不回写共享状态**；未使用插槽——壳层自行渲染其子组件，无内容需回传。
- **形态归属（已按规格归位，非偏差）**：空态 `mobile-canvas-empty` 与 VueFlow 内胶囊 `MobileCanvasTopControls` 属**画布世界 overlay**，由 CanvasPage 承载——二者依赖 VueFlow 内部定位（胶囊包在 `<Panel>` 内、空态是 canvasArea 内 `absolute inset:0`），而壳层挂在画布外的 fixed 层。本节首条「拥有」清单已据此移除「空态」，使规格与实现自洽。
- 残余 20 处 `isMobileLayout` 全部**非移动端编排**。口径 = CanvasPage 内出现次数（**脚本 8 + 模板 12**）：PC 自身门控 6（模板）／画布世界 4（模板：画布 veil 类、VueFlow 内胶囊、空态、非画布页签时隐藏画布）／共享状态真源消费 3（`mobileStudioDockOpen`、pickMode watch、AgentSideRail `:mobile`）／脚本内行为分流 4（定位⇒纯画布满屏 ADR-0011 ×2、拾取⇒显式进画布、PC 才自动开面板）／壳层唯一挂载点 1／composable 取用与返回 2。

**PR5 收尾修复（#502）——壳层抽取带出的一个类型层缺陷（**非**运行时功能回归）**：

- `MobileShellBatchActions.download` 曾被声明为 `() => void`，而 `MobileMultiSelectBar` 的
  `download` 事件**带 mode 载荷**（`full_package` / `lightweight` / `media_list_only`）。已改为显式
  透传 `$event` 并补齐三值联合类型；`layout` / `groupColor` / `blockedHint` 三个带载荷事件同步
  改为显式 `$event`。
- ⚠️ **事实校正（2026-10-20 上线后逐环核对）**：这**不是**运行时载荷丢失，线上从未「静默退化成默认
  完整包」。已上线版本的实参链路是通的——`MobileMultiSelectMoreSheet` `emit('download', mode)` →
  `MobileMultiSelectBar` `@download="emit('download', $event)"` → 壳层 `@download="batchActions.download"`
  （Vue 编译后把 emit 实参透传给 handler）→ bridge `download: handlePackageDownload` →
  `handlePackageDownload(mode)` → `exportWorkflowPackage({ exportMode: mode })`。
  原声明 `() => void` 只是**类型层不精确**：TS 允许把「形参更少」的函数赋给 `() => void`（多余实参合法），
  既不报错也不影响实参传递。修正的价值在于类型准确 + 可被静态契约钉死。
- 教训：这类「声明无参 + 实际带载荷」的错配**不产生任何运行时症状** ⇒ 判断「是否真丢载荷」必须沿
  emit→handler 逐环看实参，不能只看接口声明；已加进 `CanvasPage.mobileSelectionWiring.test.ts`。
- 另摘除壳层两个未被使用的死 prop（`mobileCanvasView` / `mobileCanvasImm`）：共享状态真源仍在
  CanvasPage，壳层只订阅真正用到的 `mobileAppTab`。
- 治理守卫（`CanvasPage.mobileChromeHygiene.test.ts`）：CanvasPage 零直接渲染移动端子组件、壳层自身零
  `isMobileLayout`、壳层零 `--neo-*`——把 AGENTS.md「移动端呈现」第 1 条从约定变成机器判据。

### 6.2 isMobileLayout 治理规则（写入 AGENTS.md 前端节）

- 移动端**编排**只归 `MobileCanvasShell` 一个所有者；页面级组件不再新增 `isMobileLayout` 条件
- 组件内局部响应式差异允许 `useAgentMobileLayout()`，但**禁止在 PC 组件内新增 767px media query 补丁**（**评估已完成，见下**）
- 新增移动端专用呈现必须落 `components/mobile/` 或 `*Mobile*` 命名，与 PC 组件对望

**media query 上收评估结论（2026-10-20 代码级复核）**：本方案点名的三处**已无 767px media query**——
`DockStudioToolbar`（清位）与 `AgentSideRail`（composer/抽屉）均已改用 `useAgentMobileLayout()` composable
（AGENTS.md 允许的「组件内局部响应式差异」通道），`CanvasRefPickOverlay` 已不含任何断点分支。全仓仅剩一处
`@media (max-width: 767px)`，在 `styles/neo-node.css`（PR1 触控适配：`-webkit-touch-callout: none` /
`user-select: none` / 44px 画布空间热区）——该类效果**只能由 CSS 承载**（JS 无法设置
`-webkit-touch-callout`），且断点值与 `design-tokens.css` 的 `--lnk-bp-mobile: 767px` 一致（media query
不支持 CSS 变量，只能硬编码同一数值）。结论：**禁令未被违反，亦无需再上收**；三处 legacy 标记按 AGENTS.md
留在「历史遗留，随各自下次改动上收」。

- ⛔ **未落地（被阻塞，见 §6.5）**：断点语义与配对方案（对话页 D-7）**同一次改造**——`useAgentMobileLayout`
  从「一个 767px 布尔」拆为**形态**（`conversation / canvas-window / canvas-full`）× **能力集**
  （`longPress / hover / finePointer / keyboardHint`）两个维度；画布页的手势分流（D-3）消费「形态」，
  触控降级（D-6/D-7）消费「能力集」。**要求保留，但本轮不实施**——能力集 composable 属配对《对话页方案》
  PR4，而该方案仍是 `Draft — 待评审`；只拆形态侧会留下没有消费者的半成品。

### 6.3 令牌收敛

- `MobileCanvasTopControls` 先行迁移 `--neo-*` → `--lnk-*`（本次 PR4）
- `--neo-*` 体系剩余消费者盘点后列入迁移 backlog（CanvasFloatingChrome / MultiSelectToolbar / NodePanelDock / CanvasBottomLeftControls 等 PC 组件，随各自下次改动时迁移，不阻塞本方案）

### 6.4 风险与回退

| 风险 | 缓解 |
|---|---|
| 手势模型变更误伤 PC | 按断点分流，PC props 逐字不变；PR1 只加移动端分支 |
| d3-zoom filter 行为与源码推断不符（P0-1） | PR1 第一步 = 真机复测（iOS Safari / Android Chrome），据实调整 props 组合 |
| ＋FAB 与 composer＋语义混淆 | 文案区分：「新建节点」vs「添加引用」；sheet 标题明示 |
| 多选动作条遮 dock/composer | z 序分层 + S2/S3 互斥规则沿用 `has-studio-dock` |
| sheet 化面板复用失真 | CanvasAssetPanel / TaskHistory 面板本体不动，只换容器；走查表专项 |
| 与配对方案（对话页）改动交叉 | 共享三件事只写一份：`useLongPress`、`--lnk-hit-min`、断点拆分；两份方案的 PR5 合成 `MobileAppShell` 时对齐 |
| 回退 | 每 PR 独立分支；P0 修复可单独 revert；壳层重构前保持旧竖轨代码一版 |

### 6.5 未落地的规格条目与裁决状态（2026-10-20）

本方案**代码项已全部上线**（PR1~PR5 + #502 收尾，均含生产取证）。下列条目**不是漏做**，而是各自有
阻塞或与规格其他条款冲突，在此登记裁决状态以免被误当作「已完成」：

| 条目 | 出处 | 状态 | 理由与建议 |
|---|---|---|---|
| PC `MultiSelectToolbar` 底部化改造 | §6.1③「清除 PC 组件内 hover 依赖」 | ⏸ **待裁决（规格内部冲突）** | 本方案范围行（与配对方案）两处写明「**PC 端形态不动**」，而 §6.1③ 要改 PC 工具条的呈现方式 ⇒ 两条自相矛盾。代码现状：PC 工具条仍是**选区锚定**浮条（`MultiSelectToolbar` 走 `screenPosition` 绝对定位），未底部化。§6.1③ 的另两项（dock 收缩态 tap 化、竖轨摘除）均已上线。**建议**：要么明确豁免范围行、单独立项评审 PC 形态变更；要么把 §6.1③ 该项移出本方案。移动端工具条已底部化（`MobileMultiSelectBar`），故 mobile 侧无缺口。 |
| `useAgentMobileLayout` 拆「形态 × 能力集」 | §6.2 第 3 条 | ⛔ **被阻塞** | 能力集 composable 属配对《移动端对话页 UI/UX 优化设计方案》**PR4**，而该方案仍是 `Draft — 待评审`（未批准）。只拆形态侧会留下无消费者的半成品，且两份方案要求「共享三件事只写一份」。**建议**：对话页方案评审通过后，按其 PR1→PR4 顺序推进，PR5「壳层合并」时与本方案合流出 `MobileAppShell`，届时一并对齐断点拆分。 |

另记：PC「保存画布」菜单项（`CanvasFloatingChrome`）确认**功能上冗余**（`saveCanvas` 已由数十处 watch /
出图 / 拖节点 / undo-redo 自动触发，每次编辑自动落库；移动端 PR4 已改用状态行），但它是 PC 端**唯一可见的
存储指示**，摘除需先补 PC 状态行。因涉及 PC 形态，同属上表第一项的裁决范畴。

---

## 7. 分期实施计划

| PR | 内容 | 依赖 | 验收 | 上线 |
|---|---|---|---|---|
| **PR1 触控地基** | P0-1 真机复测 + 手势断点分流；44px 达标（多选条/dock 工具行/节点引用钮/视口胶囊）；长按上下文 sheet（补重命名）；composer 热区微调 | 无 | 走查表 §8 触控 8 项 | ✅ #490（与 PR2 同 PR） |
| **PR2 新建收敛** | 摘除移动端竖轨；＋FAB + 新建 sheet；资产库/任务/设置入口收敛；空态 | PR1 | 走查表入口 6 项 | ✅ #490 |
| **PR3 多选与 dock** | 多选底部动作条 + 更多 sheet；dock 收缩态 tap 化 + 工具行滚动；批量进度卡移动端尺寸 | PR1 | 走查表多选 7 项 | ✅ #495 |
| **PR4 视觉与卫生** | 视口胶囊令牌迁移；自动保存状态行；⋯ 菜单重排；删死代码；AGENTS.md isMobileLayout 治理规则 | PR2/3 | design-token.test.ts + 走查表视觉 6 项 | ✅ #497 |
| **PR5 壳层重构** | MobileCanvasShell 抽取；CanvasPage 分支收敛；media query 上收评估 | PR2-4 | 全量回归 + PC 零 diff 走查 | ✅ #500 + 收尾 #502 |

每 PR 完必须真机走查（iOS Safari + Android Chrome 各一轮），遵循 `docs/agent/delivery.md` 分支纪律。

> ⚠️ **合并上线 ≠ 验收完成**：PR1~PR5 均已合并并完成生产取证，但 **§8 真机走查仍在进行**——不可只凭 CI 绿灯判定通过。已跑轮次与处置：
>
> - **第 1 轮（画布空态 · iOS/Android 浏览器）**：抓到整类缺陷 —— 壳层三处底部锚定元素用 `absolute` 贴 100vh 根底，在带浏览器工具条的真机上**整颗掉出可见区**（＋FAB 不可见 ⇒ 空态文案成死指引；保存状态行、多选动作条同样不可见）。**jsdom 无视口 ⇒ CI 原理上看不见**。已修（#509，三处改 `fixed` 贴可见视口 + 状态行横向让开 + 多选态 FAB 让位 + 3 条静态守卫）。
> - **第 2 轮（提议待确认态）**：① T-6 不达标 —— 节点内联确认面的「确认生成 / 编辑 / 取消」三按钮真机实测仅 **28px** 高 < 44px（仅移动端提至 44px，PC 逐字不动，栏高常量同步 40→56）；② **等确认期不报进度** —— 节点待确认（等用户点确认）时批量 state 仍是 `running`、进度 0% 且不会推进，而满宽进度卡把 ＋FAB 与保存状态行横穿在同一底部带，且「批量生成中 0%」与 toast「在节点上点确认生成」自相矛盾 ⇒ 有待确认节点时进度卡整卡让位。
>
> 剩余：T-1~T-5 / T-7~T-8、I-2~I-7、I-8、V-1~V-6 尚待逐项跑。

---

## 8. 验收走查表（真机）

### 触控与手势（PR1）

| # | 项 | 通过标准 |
|---|---|---|
| T-1 | 单指拖空白 | 画布平移，跟手无卡顿 |
| T-2 | 双指捏合 | 缩放，以双指中心为锚点 |
| T-3 | 长按节点 | 200ms 内出上下文 sheet，行高 ≥44px |
| T-4 | 长按 → 多选 | 进入 S3，已选节点有徽标，点选切换 |
| T-5 | 拖手柄连线 | 40px 热区内稳定命中，不断连 |
| T-6 | 所有可点元素 | ≥44×44（含 FAB / 胶囊钮 / 工具行 / 动作条） |
| T-7 | :active 反馈 | 每个按钮有点按缩放/叠层反馈 |
| T-8 | composer 热区 | ＋/◎/发送/模型 36px+，升键盘不互抢 |

### 入口与信息架构（PR2/3）

| # | 项 | 通过标准 |
|---|---|---|
| I-1 | ＋FAB | 左下常驻可**见**（贴可见视口底；DOM 存在 ≠ 真机可见，见 §4.2 定位契约），sheet 全宽，10 类节点 + 资产库可达；多选态让位给动作条 |
| I-8 | 保存 | 自动保存状态行可见且**不被 ＋FAB 压盖**（横向错开）；无手动保存菜单项 |
| I-2 | 竖轨 | 移动端不存在（左缘无竖排钮） |
| I-3 | 资产库 | 画布内仅 ＋sheet 一个插入入口；composer＋ 为引用入口；发现页浏览入口三者文案不混 |
| I-4 | 任务 | ⋯ 菜单动态出现，定位/重试可用 |
| I-5 | 模型设置 | 画布内无入口；我的页可达 |
| I-6 | 多选动作条 | 底部固定不溢屏；更多 sheet 9 项可达；分组色 44px 格 |
| I-7 | dock | tap 折叠/展开；工具行横滑；旋转隐藏 |
| I-8 | 保存 | 自动保存状态行可见且**不被 ＋FAB 压盖**（横向错开）；无手动保存菜单项 |

### 视觉（PR4）

| # | 项 | 通过标准 |
|---|---|---|
| V-1 | 令牌 | 移动端 chrome 无 `--neo-*` / hex / rgba 文字色 |
| V-2 | 双主题 | 深浅切换后所有 chrome 对比度达标（AA） |
| V-3 | 空态 | 新用户首进画布有引导 |
| V-4 | 走查一致性 | 顶栏/胶囊/FAB/sheet/动作条五处表面语言统一 |
| V-5 | PC 零回归 | PC 走查项全绿，git diff 无 PC 文件改动（PR1/2/3） |
| V-6 | 门语义 | 门进入=纯画布；窗进入=画布+composer；回对话无缝 |

---

## 附：取证索引

- `apps/web/src/pages/CanvasPage.vue`（5019 行 props、5246 竖轨无移动端判断、5158-5175 双视口条分支、5519-5524 veiled 注释）
- `apps/web/src/components/canvas/NodePanelDock.vue`（139-151 hover 唤出、279 行 268px 弹出）
- `apps/web/src/components/canvas/MultiSelectToolbar.vue`（498-501 30px、291-292 hover 色菜单、413-475 向下菜单）
- `apps/web/src/components/canvas/DockStudioToolbar.vue`（163-168 收缩态 hover、231-236 移动端清位）
- `apps/web/src/components/canvas/NeoBaseNode.vue`（125 dblclick、173-183 13px 引用钮、205-228 手柄）
- `apps/web/src/components/canvas/CanvasContextMenu.vue`（8 项无重命名）
- `apps/web/src/components/canvas/MobileCanvasTopControls.vue`（`--neo-*` 令牌、88px 小地图）
- `apps/web/src/components/mobile/MobileTopBar.vue` / `MobileTabBar.vue` / `DiscoverPane.vue`
- `node_modules/.pnpm/@vue-flow+core@1.48.2*/vue-flow-core.mjs`（8465-8576 panOnDrag/selectOnDrag/filter 逻辑）
- `apps/web/src/composables/useAgentMobileLayout.ts`（767px 断点）
