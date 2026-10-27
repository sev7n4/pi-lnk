# 三页顶栏统一重构（移动端 + WEB）实施计划

> 配套规格：`docs/superpowers/specs/2026-10-27-mobile-web-three-page-topbar-redesign.md`（**v2**）
> 上游已完成：门面收敛（PR #614）、v2.2 hotfix（#618）、v2.3 双根因（#619）、v2.4 黑屏（#622）、统一单对话 ADR-0015（#609/#611）均已合 master + 生产。
> 本计划落地规格 v2 判定的全部事项：**创作空间极简裸栏（移动+WEB 统一）、对话/画布补 ‹ 返回创作空间 + 项目名（次级静默截断）、画布 ⤢ 上提、WEB 工作台统一顶栏、聊天栏去冗余入口**，并修掉自审抓出的「双栏」坑。
> ⚠️ **分支前提**：从 `origin/master` 最新起新分支（如 `feat/mobile-web-topbar-redesign`）。本机 git https 通道常被代理挡（502/超时），推送走 REST Git Data API 纪律（blob 字节级双校验、tree/commit/refs 全量 diff `REMOTE_MASTER..LOCAL_HEAD`）；合并用 squash PR。本地 master ref 可能落后于远端，起分支前先 `git fetch && git branch -f master origin/master` 校准。

## 0. 真机问题 → 根因 → 本计划任务 映射

| 真机现象（用户反馈） | 根因（代码级） | 对应规格 | 本计划任务 |
|---|---|---|---|
| ① 创作首页密度过高：顶栏 H1「创作首页」+ 副标题 + 新建项目 + 常驻搜索框 + 管理 + 账户 chrome | `CanvasesPage` 自写大标题栏 + 全站常驻 `AppHeader` 双栏叠加；账户属性/常驻搜索违反 iOS 减法 | §6.1/§6.7、G4/G7 | **T1 / T2** |
| ② 对话页：`新对话 / 历史对话` 入口多余 + 双回城（抽屉→创作首页、品牌→品牌页）+ **缺项目名** | `MobileTopBar` chat 分支含 `open-drawer/go-home/new-chat/open-history`，未渲染 `projectName` | §6.2、G3/G5 | **T3** |
| ③ 画布页：**缺项目名 + 进画布即迷路**（顶栏近乎空白、无返回） | `MobileTopBar` canvas 分支仅 `⋯`，⤢ 在 `MobileCanvasTopControls` 浮动实例 | §6.3、G2/G3 | **T4** |
| ④ WEB 创作主页同 ①（双栏 + 密度高） | 同 ①，且 `AppHeader` 在 `/canvases` 渲染全量 创作/发现/主题/账号 | §6.7、G7 | **T1 / T2** |
| ⑤ WEB 工作台（对话+画布同屏）：无返回、无项目名、漂浮 ThemeToggle/AccountChrome 簇 + 聊天栏 新对话/历史 | `App.vue:39` 沉浸画布不挂 `AppHeader` ⇒ 无全局导航；漂浮簇未收口；`AgentSideRail` 头部冗余入口 | §6.8、G8 | **T5** |
| 硬约束：项目名不能太显眼/太长 | 无统一次级静默+截断样式 | §6.4 | 贯穿 **T3/T4/T5** |
| ⚠️ 自审坑：若 `CanvasesPage` 自写栏 + `AppHeader` 并存 → 双栏 | `AppHeader` 全站常驻（仅沉浸画布隐藏） | §11/S1 | **T1/T2 强约束** |

## 1. 任务清单

### T1 · AppHeader 按路由渲染裸栏 + 共享搜索态（P1/P5）
- **文件**：`apps/web/src/components/layout/AppHeader.vue`、`apps/web/src/composables/useProjectWorkspace.ts`（新增 `gallerySearchOpen`）
- **改动（§6.1/§6.7、§9-1/§9-9）**：
  - 新增路由判断：`route.path === '/canvases'` → 渲染**裸栏**：左 `BrandLogo`（`router.push('/workflow')`）；右 `🔍`（切换模块级 `gallerySearchOpen` ref）+ `＋`（`useProjectWorkspace().create`，`data-testid="gallery-create"`）。
  - `/canvases` 时**隐藏**：`tabs` 导航（创作/发现）、`ThemeToggle`、`AccountChrome`。
  - `/workflow` 与其他路由维持当前渲染（不被改动）；画布路由由 `App.vue` 的 `isImmersiveCanvas` 控制不渲染（不变）。
  - 在 `useProjectWorkspace` 新增 `gallerySearchOpen = ref(false)`（模块级，供 T2 搜索输入共享）。
- **验收**：`/canvases` 时 grep/视觉确认 `AppHeader` 无 `创作`/`发现`/`ThemeToggle`/`AccountChrome` 渲染；点 `gallery-create` 触发 `create`；点 `🔍` 翻转 `gallerySearchOpen`。
- **依赖**：无。

### T2 · CanvasesPage 去自写栏 + 标题行（P1）
- **文件**：`apps/web/src/pages/CanvasesPage.vue`
- **改动（§6.1、§9-2）**：
  - **删除**自写顶栏：大 `h1`+副标题、`← 返回主页`、`新建项目` 主按钮、常驻搜索 `input`、`管理` 链接、批量删除按钮（顶部 chrome 全清，职责移交 `AppHeader` 裸栏）。
  - **新增**一行标题：「**创作空间 · N 个**」（N=项目数，次级灰小字，无按钮）置于网格上方。
  - 搜索输入改为**监听 `gallerySearchOpen`**，展开时出现在标题下方（复用 `sessions.sessionSearch` 双向绑定）。
  - 批量管理改为**长按项目卡**进入多选态（沿用既有多选态或新增），顶栏不再放「管理」。
- **验收**：`/canvases` 页面 `h1`/`返回主页`/`管理`/`新建项目` 零命中；标题仅「创作空间 · N 个」；`🔍` 展开后出现搜索框且绑定 `sessionSearch`（V1/V3）。
- **依赖**：T1（`gallerySearchOpen`）。

### T3 · 对话页顶栏重构（P2）
- **文件**：`apps/web/src/components/mobile/MobileTopBar.vue`
- **改动（§6.2、§9-3）**：
  - chat 分支**删除**：`open-drawer`(≡)、`go-home`(墨鱼π)、`new-chat`(新对话)、`open-history`(🕘) 四块 DOM 与对应 emit/文案。
  - chat 分支**新增**：左 `‹ 返回创作空间`（`emit('go-gallery')`）+ `projectName` span（§6.4 样式）+ 右 `⋯` 菜单（复用 canvas 现有 `bar-menu` + `showTaskItem`）。
  - 新增 props：`projectName: string`；新增 emits：`go-gallery`；移除 emits：`go-home`、`open-drawer`、`new-chat`、`open-history`。
  - 新增 testid：`mobile-topbar-back`、`mobile-topbar-project-name`、`mobile-topbar-menu`。
  - 顶栏高度、`--lnk-topbar-h`、毛玻璃/边线样式不变。
- **验收**：chat 分支 `mobile-topbar-brand`/`new-chat`/`open-history`/`open-drawer` 零命中；`mobile-topbar-back` 存在且 `projectName`=sessionTitle；点 back → `/canvases`（V4/V5）。
- **依赖**：无（壳层传 `projectName` 由 T4 完成）。

### T4 · 画布页顶栏重构 + ⤢ 上提（P3）
- **文件**：`apps/web/src/components/mobile/MobileTopBar.vue`、`apps/web/src/components/mobile/MobileCanvasShell.vue`、`apps/web/src/pages/CanvasPage.vue`、`apps/web/src/components/canvas/MobileCanvasTopControls.vue`
- **改动（§6.3、§9-3/4/5/6）**：
  - `MobileTopBar` canvas 分支与 chat **同构**：左 `‹ 返回创作空间` + `projectName`；右 `⤢`（`emit('fit-view')`，置于 `⋯` 前）+ `⋯` 菜单。
  - `MobileCanvasShell`：新增 prop `projectName` 透传 `MobileTopBar`；新增 `go-gallery` 处理（`router.push('/canvases')`）、`fit-view` 处理（调用由页面下发的 fitView）；**移除** `MobileCanvasTopControls` 浮动实例渲染。
  - `CanvasPage`（移动端分支）：向 `MobileCanvasShell` 传 `:project-name="sessionTitle"`（补充既有 `:default-title`）；新增 `go-gallery` handler、`fit-view` handler（`useVueFlow().fitView({ padding:0.2, duration:200 })`）；停止移动端渲染 `MobileCanvasTopControls` 浮动 ⤢。
  - `MobileCanvasTopControls`：移动端不再渲染浮动 ⤢；无桌面用途则删除组件。
  - `MobileTopBar` 新增 testid：`mobile-topbar-fit`。
- **验收**：画布页顶栏含 ‹ + 项目名 + ⤢ + ⋯；移动端无浮动 ⤢；点 `mobile-topbar-fit` 视口适应 fitView（V6/V8）。
- **依赖**：T3（同文件顺序编辑）；壳层/页面桥接与 T3 协同。

### T5 · WEB 工作台统一顶栏（P6）
- **文件**：`apps/web/src/components/canvas/WorkspaceTopBar.vue`（**新增**）、`apps/web/src/pages/CanvasPage.vue`、`apps/web/src/components/agent/AgentSideRail.vue`
- **改动（§6.8、§9-5/7/8）**：
  - 新增 `WorkspaceTopBar.vue`：WEB 工作台整页顶栏。左 `‹ 返回创作空间` + `projectName`(§6.4 样式，prop)；右簇 `发现`(`/community`)/`我的`(账户页)/`ThemeToggle`/`AccountChrome`/`⋯`(项目菜单 发布/导出/导入/任务)；emits `go-gallery`。视觉与 `AppHeader` 同族（高度、毛玻璃、边线）。
  - `CanvasPage`（WEB 分支）：画布路由顶部挂载 `WorkspaceTopBar`，传 `:project-name="sessionTitle"`；**删除**画布右上漂浮簇（`ThemeToggle + AccountChrome` 浮动实例）。
  - `AgentSideRail`：删除头部「新对话(＋)」「历史(🕘)」按钮（ADR-0015）；保留 `收起(×)` 与栏内会话标题；不在此另设 logo 回城。
  - 移动端分支不变（仍走 `MobileCanvasShell` + `MobileTopBar`）。
- **验收**：WEB 画布路由可见 `WorkspaceTopBar`（‹+项目名+发现/我的/主题/账号/⋯）；画布无漂浮簇；`AgentSideRail` 头部无 新对话/历史（V12/V13）。
- **依赖**：T4（`sessionTitle` 已接顶栏真源）。

### T6 · 测试与守卫总装
- **单测**（§9-10）：
  - `AppHeader` 路由条件：`/canvases` → 裸栏（无 创作/发现/ThemeToggle/AccountChrome）；`/workflow`/其他 → 维持。
  - `CanvasesPage.test.ts`：页面仅「创作空间 · N 个」+ 网格；`gallery-search-toggle` 切 `gallerySearchOpen` 并展开搜索；h1/返回主页/管理 零命中。
  - `MobileTopBar.chat.test.ts` / `MobileTopBar.taskMenu.test.ts`：移除 抽屉/品牌/新对话/历史 断言；新增 `mobile-topbar-back`(go-gallery)、`mobile-topbar-project-name`(=sessionTitle、截断)、`mobile-topbar-menu` 断言。
  - `CanvasPage.mobileChromeHygiene.test.ts`：chat/canvas 顶栏呈现 ‹ 返回创作空间 + 项目名；canvas 含 ⤢；移动端无浮动 ⤢。
  - `WorkspaceTopBar.test.ts`（新增）：‹ 返回创作空间 + 项目名(§6.4) + 发现/我的/主题/账号/⋯；`AgentSideRail` 头部无 新对话/历史。
  - 项目名样式断言：次级灰、字重 500、超长截断（如「agent 模特换装工作流…」）。
- **grep 守卫**：`AppHeader` 在 `/canvases` 无 `创作`/`发现`/`ThemeToggle`/`AccountChrome` 渲染分支；`AgentSideRail` 头部 `new-chat`/`open-history` 零命中；`MobileCanvasTopControls` 浮动 ⤢ 实例零挂载。
- **类型/构建**：`vue-tsc -b` 通过（noUnusedLocals 卡构建，本机用 nvm node 24 + `--max-old-space-size=2048`）。
- **依赖**：T1–T5。

### T7 · 跨规格回写 + 合并 / 部署 / 生产复测
- **跨规格回写**：gallery 规格（`2026-10-26-project-gallery-consolidation-design.md`）§6.5「画布视图不承载返回」加修订注「2026-10-27 被 mobile-web-three-page-topbar-redesign 取代」（V10）。
- **分支/合并**：`feat/mobile-web-topbar-redesign` → PR（squash）→ 合 master。推送走 REST Git Data API 纪律（blob 字节级双校验 + 全量 diff）。
- **部署**：Tencent Cloud；纯前端改动命中 deploy.yml `apps/web/**` ⇒ `Build API` skipped；prod 取证四层（入口 chunk / 字面量 / CSS / 无头注入或 nginx 真实流量）。
- **真机复测**：①移动+WEB 创作空间单栏裸栏、密度下降；②对话页 ‹ 返回创作空间 + 项目名、无 新对话/历史/抽屉/品牌；③画布页顶栏 ‹+项目名+⤢、可返回；④WEB 工作台顶栏 ‹+项目名+发现/我的、无漂浮簇、聊天栏无冗余入口；⑤项目名次级静默、超长截断。
- **依赖**：T6。

## 2. 实施顺序（建议）

```
T1 (AppHeader 裸栏+共享态) ─┐
T2 (CanvasesPage 去栏)      ─┤
T3 (对话页顶栏)             ─┼─→ T6 (测试/守卫) ─→ T7 (回写/PR/部署/复测)
T4 (画布页顶栏+⤢)          ─┤   （T4 依赖 T3 同文件顺序编辑）
T5 (WEB 工作台顶栏)         ─┘
```

T1/T2 可并行（T2 依赖 T1 的 `gallerySearchOpen`，故 T1 先落共享态）；T3→T4 顺序（同文件）；T5 独立；T6 收口；T7 末置。

## 3. 不回退项（已落地，禁止因本次改动退化）

- **ADR-0015 单对话模型**：对话页无 新对话/历史 是目标（非回归）；「1 项目=1 对话+1 画布」不变。
- **门面收敛 v2.1/v2.2 已落地**：创作首页列表=续作面、微信式返回（对话→创作空间）、主页纯品牌+锚（ADR-0012）。
- **v2.4 黑屏修复**：封面按钮 `relative` 定位修复、封面墨点兜底（.wav/.mp4）**禁止改回**——本次只动顶栏，不碰卡片渲染。
- **移动端四页签壳 `MobileTabBar`**：组成与逻辑不动（工作区仍用底部页签；WEB 改顶部栏为同层不同形态）。
- **`sessionTitle` 真源**：已是项目名真源，本计划只新增「渲染到顶栏」，不新造状态。
- **gallery 规格 §6.5 取代**：实施须回写修订注（见 T7），不可静默矛盾。

## 4. 风险（详 §11 规格）

- **双栏坑（强约束）**：`AppHeader` 全站常驻，若 `CanvasesPage` 仍自写栏会双栏叠加 ⇒ T1/T2 必须「AppHeader 渲染裸栏 + CanvasesPage 去自写栏」同时落地。
- **搜索状态共享**：🔍 在全局 `AppHeader`、输入框在 `CanvasesPage`，必须共享 `gallerySearchOpen`，否则 🔢 点了页面无反应。
- **fitView 上下文**：⤢ 上提后必须在 VueFlow 上下文内调用（经 `CanvasPage` 桥接），勿从 teleported 顶栏直调。
- **项目名样式双端复用**：`WorkspaceTopBar` 与 `MobileTopBar` 必须复用 §6.4 同一 class/token，禁止各写一份。
- **测试单例污染**：`useProjectWorkspace` 模块级单例跨用例泄漏 ⇒ 用例前置 `resetProjectStoreForTest`；reactive 必须经 proxy setter 触发 watch。
