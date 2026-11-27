# 视频编辑时间线工具 P1 交互化设计规格

> 状态：**待评审（2026-11-27）**；本文件只定义设计与判据，**不授权写业务代码**；确认后另起实施计划。
> 日期：2026-11-27
> 前置：2026-11-25 视频编辑时间线工具设计规格（P0 已全流程闭环，#1001–#1007）。
> 范围：`apps/web` 画布卡片与浮层编辑器、移动端 tile、`apps/server` op 语义与浏览器端点、`packages/shared` op 类型、测试门禁。
> 三项拍板（2026-11-27 用户确认）：① 展开态 = **就地浮层**（Teleport 到 body，不撑破节点）；② 撤销/重做 = **时间线独立历史栈**（浮层会话内维护，确认时一批 ops 一次写回）；③ 比例来源 = **复用节点 `data.videoSettings.aspectRatio`**，不新增字段。

---

## 0. 结论先行

P0 已把「agent 编排 → 服务端编译 → worker 渲染 → 成片节点」跑通。本轮补的是**第二条通道**：用户直接在画布上用鼠标/触控编辑同一份时间线。

核心架构一句话：

```
手工浮层编辑 ──┐
               ├──> 同一套 TimelineOp ──> service.edit() ──> transactGovernedCanvasOps ──> data.timeline
agent 工具调用 ─┘                                                       │
                                                                       └──> 渲染仍走 render 端点
```

三条不变量：

1. **双通道同构**：手工编辑产生的操作必须表达为与 `video_timeline_edit` 完全相同的 `TimelineOp`，走同一个 `service.edit()`、同一个事务写通道。禁止前端另造一套本地 timeline 就地渲染后整体 PUT（会绕过 P1-C 写治理）。
2. **保存 ≠ 渲染**不变：浮层「完成」只写 `data.timeline`，不启动渲染；成片仍只能由导出按钮（确认门）或 `video_timeline_render` 产生。
3. **不新增节点类型 / 不新增 op 字段绕过模型**：草稿与成片仍是现有 `video` 节点；比例从节点既有 data 取。

| 决策点 | 结论 | 理由 |
| --- | --- | --- |
| 编辑入口 | 收起态卡片单点展开为就地浮层 | 节点内撑开会破坏比例外框与画布布局（用户拍板①） |
| 撤销/重做 | 浮层会话内独立历史栈，确认时一批写回 | 画布级 undo 粒度太粗；剪辑交互要求细粒度（用户拍板②） |
| 比例来源 | 节点 `data.videoSettings.aspectRatio`，经 `resolveVideoNodeDisplaySize` | 零新增字段、与视频节点壳逐像素一致（用户拍板③） |
| 手工编辑服务端路径 | Browser controller 新增 `POST /video-timeline/edit`（AuthGuard），复用 `service.edit()` | 接线而非新建服务逻辑；service token 的 agent internal 端点不能被浏览器直连 |
| 播放源 | 逐片段播 `tracks[].url`（create 时从上游节点复制的真实 url） | 草稿节点自身无 url（保存不渲染）；片段 url 是既有结构化数据面，禁造数 |
| 移动端形态 | `NodeTileView` 的 video 分支加 timeline 呈现，列表式 | AGENTS.md：移动端编排收敛到 `components/mobile/`，页面级不加 `isMobileLayout` 分支 |

---

## 1. 第一原则：吃满上游、不重复造轮子

**声明**：任何新增判据 / 工具 / 数据字段 / 引擎，立项前必须过三判据——① 等价物检索；② 接线优先于新建，判据锚到既有结构化数据面；③ 禁造数 / 禁自报。

### 1.1 开源等价物检索结论表

| 候选 | 一手事实 | 结论 | 本方案如何接线 |
| --- | --- | --- | --- |
| `mifi/editly` | 已在 P0 采纳为渲染内核，MIT，声明式 spec | ✅ 不新增 | 手工编辑只改 op，渲染仍复用现有 `compileTimelineToEditly` |
| `OpenCut-app/OpenCut` | MIT，99k★，时间线交互实现完整（拖拽片段、分割、undo/redo） | ⚠️ 仅作交互参考 | 借鉴其「片段块 + 播放头 + 缩放时间轴」信息架构；不引入依赖、不采用其引擎 |
| `ffmpeg.wasm` / 浏览器端剪辑 | 需把媒体下载到浏览器，CVM 上传目录归属校验会重复 | ❌ 不采用 | 播放只做 `<video>` 预览，编辑只改 op；真正合成仍在服务端 worker |
| 通用时间线库（`vis-timeline` / `d3-timeline`） | 依赖体积大、样式与设计体系冲突，且自带模型与本仓 `trackOrder` 分叉 | ❌ 不采用 | 时间轴排布复用卡片现有 `widthPct/leftPct`（`VideoTimelineCard.vue:30-36`） |

**检索结论**：无新增开源依赖。交互层用本仓组件 + 现有 `TimelineOp` 表达。

### 1.2 本项目等价物检索结论表

| 候选等价物 | 真实路径 / 符号 | 结论 | 本方案如何接线 |
| --- | --- | --- | --- |
| 比例 → 尺寸换算 | `apps/web/src/components/canvas/mediaNodeDisplaySize.ts:22-104`：`parseRatioString` / `resolveVideoNodeDisplaySize` | ✅ 直接复用 | 时间线节点外框沿用同一函数（320 包络），PC/移动端共用；**不新增比例字段** |
| 比例容器 CSS | `apps/web/src/components/canvas/refine/CompareView.vue:66-74`：`stageStyle` 动态 `aspectRatio` | ⚠️ 参考但不强用 | 本仓主流是「JS 算 px + inline 外框」，时间线沿主流量法（与视频节点逐像素一致），避免两套比例口径 |
| 媒体预览壳 | `apps/web/src/components/canvas/CanvasNodeVideo.vue:138-148` `openMediaPreview()`；`neo-node.css:520-556` | ✅ 复用 | 播放按钮点击调 `openMediaPreview({ url: resolveMediaUrl(track.url), kind:'video' })`，不新建播放器 |
| 移动端媒体壳 | `apps/web/src/components/agent/presentation/NodeTileView.vue:980-1012` `.mobile-node-media-box` / `.mobile-node-video-play` | ✅ 复用 | 移动端时间线 tile 复用其播放徽标与 44px 热区 |
| 卡片布局与排布 | `apps/web/src/components/canvas/VideoTimelineCard.vue:30-36,50-106` | ✅ 复用并扩展 | 收起态沿用 header/ruler/track/audio/footer；展开态抽出共享的片段块渲染 |
| 时间线 op 类型 | `packages/shared/src/canvas/videoTimeline.ts:42-50` `TimelineOp` | ✅ 复用 + 补 split | 手工编辑全部映射为既有 op；`split` 是本轮唯一新增 op |
| 服务端 op 执行 | `apps/server/src/agent/video-timeline.service.ts:134-208` `edit()` | ✅ 复用并补全 | 浏览器端点直接调 `service.edit()`；先修 `add_visual`/`add_audio` 假接线 |
| 画布写治理 | `apps/server/src/sessions/canvas-op-write.ts:transactGovernedCanvasOps()` | ✅ 唯一合法写通道 | 浮层「完成」= 一次 `service.edit()` 调用，仍走事务内 applier，不新增写点 |
| 确认门机制 | `CanvasNodeVideo.vue:92` `window.confirm` + `propose-render` | ✅ 复用 | 渲染确认门保持不变；浮层「完成」是保存，不需二次确认 |
| 触控热区 token | `MobileNodeTile.vue:245-250,276-279` `var(--lnk-touch-target)` | ✅ 复用 | 移动端列表项与按钮沿用既有热区，禁写死 px |
| 设计令牌 | `apps/web/src/styles/design-tokens.css`（L2/L3） | ✅ 唯一色源 | 浮层只用 L2/L3 令牌；禁新 hex / `--neo-*` / `rgba(` 文字色 |

**检索结论**：需要新增的只有 4 类东西——**`split` op 语义、浏览器 edit 端点、浮层编辑器（含 undo/redo 本地栈）、移动端 timeline tile**。不新增节点类型、不新增比例字段、不新建播放器、不新建写通道、不新增 npm 依赖。

### 1.3 禁造数 / 禁自报约束

- 播放源必须是 `tracks[].url`（create 时由服务端从上游节点真实 url 复制而来），**不得**用标题、占位符或模型自报 url 播放。
- 分割产生的两个片段，其 `sourceInSec/sourceOutSec` 必须由真实播放头位置 + `clipDurationSec()` 推导，禁止造一个"看起来对"的时长。
- 手工编辑的每一步必须落为具体 op 并在浮层显示 op 摘要（"镜头1 分割于 00:02"），确认时提交；禁止把 UI 状态当成已保存事实。
- 撤销/重做只回退浮层会话内的 op 序列，不得直接改 `data.timeline`（服务端是唯一真相源）。

---

## 2. 目标与非目标

### 2.1 目标（用户四项诉求逐条落地）

| # | 用户诉求 | 本轮落地 |
| --- | --- | --- |
| ① | 节点应能拖拽移动 | **展开态**片段可拖拽排序（映射 `move_visual`）、两端裁剪手柄（映射 `trim`）；**收起态保持 `nodrag`**（防误触，节点整体仍从标题栏可拖） |
| ② | 应有播放按钮播放上游分镜 | 收起态画中播放钮 + 展开态播放头；逐片段播 `tracks[].url`，复用 `openMediaPreview`；播放头点击定位到对应片段首帧 |
| ③ | hover 应显示时间线查看 | 卡片本身已常驻时间轴；hover 额外浮现「展开编辑」入口 affordance 与播放头高亮，不新增重复信息层 |
| ④ | 分割/删除/撤回/重做可用 | 新增 `split` op；删除映射既有 `remove`；撤销/重做走浮层独立历史栈；确认后一批 ops 一次写回 |

### 2.2 非目标（本轮明确不做）

- 不做浏览器端视频合成 / 编码（仍走服务端 worker）。
- 不做音频波形绘制（P0 音轨是色块，P1 列表式仍以文字 + 时长呈现）。
- 不新增比例字段、不新增节点类型、不改渲染内核。
- 不改「保存 ≠ 渲染」与导出确认门语义。
- 不做多人协同编辑（staged/conflict 已由画布写治理处理）。

---

## 3. 现状核对：四项诉求的根因（回代码取证）

| 现象 | 代码事实 | 判定 |
| --- | --- | --- |
| 节点整体"不能拖" | `CanvasPage.vue:6290` `:nodes-draggable="!viewportSettings.viewLocked"`，**没有** timeline 专属禁用；但 `VideoTimelineCard.vue:51` 根节点带 `nodrag`，从卡片区域按下不拖节点 | 不是缺陷；用户真实诉求是**卡片内片段拖拽排序/裁剪**（见 §2.1①） |
| 没有播放按钮 | `VideoTimelineCard.vue:50-106` 无 `<video>`/播放钮；`CanvasNodeVideo.vue:186` 播放钮只在 `v-if="!timelineCard"` 分支，播的是成片节点自身 `data.url` | 真实缺口：草稿节点无 url，但 `tracks[].url` 有真实上游 url 可播（见 §4.3） |
| hover 无查看 | `VideoTimelineCard.vue` 只有 clip 原生 `title`；`NeoBaseNode.vue:91-109` hover 只显示连线 handle | 部分合理：卡片已常驻时间轴；缺的是展开入口 affordance |
| 编辑能力不可用 | `VideoTimelineCard.vue:55` 剪刀按钮 `disabled` + title「用 agent 编辑时间线」（规格 P0 要求，非漏做）；op 类型无 `split`/`undo`/`redo`；`remove`/`trim` 存在但只在 agent 通道 | 真实缺口（P1 范围） |
| 隐藏缺陷：add op 假接线 | `TimelineOp` 声明 `add_visual`/`add_audio`（`videoTimeline.ts:43-44`），工具描述宣称支持（`video-timeline.ts:52`），但 `service.edit()` 循环（`video-timeline.service.ts:138-184`）**无对应分派分支** ⇒ 静默 no-op | **P0 必修**：双通道共用 op 语义，op 层不能是假的 |

---

## 4. 数据与语义设计

### 4.1 `split` op（唯一新增 op）

```ts
| { op: 'split'; node_id: string; at_sec: number }
```

语义（服务端 `edit()` 新增分派分支）：

1. 只在 `trackOrder` 中的视觉片段（video/image）上合法；音频轨 split 返回 `unsupported_split_audio`。
2. `at_sec` 必须落在片段当前有效区间 `(sourceInSec, sourceOutSec)` 内，否则返回 `invalid_split_point`。
3. 拆成两条 track：原 `nodeId` 保留并缩短为 `sourceOutSec = at_sec`；新 track 用新 id（`vtseg_<uuid>`）、`sourceInSec = at_sec`、`sourceOutSec = 原值`、继承 type/title/url/volume 等。
4. `trackOrder` 在原位置后插入新 id；`clipCount` 同步更新。
5. 两条新片段时长都走 `clipDurationSec()`，保证 `visualDurationSec` 与 Editly 编译器总长一致（P0 已锁单一真相源）。

### 4.2 `add_visual` / `add_audio` 假接线修复（P0 必修）

`service.edit()` 循环补齐两个分支，语义对齐 `create()` 构造 track 的规则：

- `add_visual`：校验 node_id 存在且 type ∈ {video,image}、归属当前 session；按 `at` 插入 `trackOrder`；`duration_sec` 缺省按 5s 并标记 `durationEstimated:true`。
- `add_audio`：校验 type=audio、`audio_track_index` ∈ {0,1}、音频轨上限 2；写 `startSec/sourceInSec/sourceOutSec/volume/muted`。
- 两条都必须通过 `validateTimeline()` 与既有归属校验，禁止裸 URL 注入。
- 加变异测试：删掉分支 ⇒ 测试必须转 RED（防"假绿"）。

### 4.3 播放源契约

- 收起态/展开态播放都取 `track.url`（`create()` 从上游节点 `data.url` 复制，形如 `/api/uploads/<userId>/<file>`）。
- 前端经 `resolveMediaUrl()` 处理后传给 `openMediaPreview()`；归属校验由 `MediaService.resolveDownloadSource()` 在服务端完成，前端不做跨账号拼接。
- `durationEstimated:true` 的片段播放时显示「时长待实测」提示，不把估算值冒充真实时长（禁造数）。

### 4.4 撤销/重做历史栈（浮层会话内）

```ts
interface EditSession {
  base: VideoTimeline              // 打开浮层时的服务端快照（只读锚点）
  ops: TimelineOp[]                // 已执行但尚未写回的 op 序列
  cursor: number                   // 当前 op 游标
  redoStack: TimelineOp[]          // cursor 之后的 op
}
```

- `undo()`：把 `ops.pop()` 压入 `redoStack`，UI 从 `base` 重放 `ops` 得到预览（纯前端预览，不落库）。
- `redo()`：从 `redoStack` 弹回 `ops`。
- 新 op 在 undo 后产生 ⇒ 清空 `redoStack`（标准编辑器语义）。
- 「完成」= 把当前 `ops` 作为**一批**提交 `service.edit()`，一次事务写回；失败时浮层保留编辑态并提示，不静默丢弃。
- 预览重放必须复用 `packages/shared` 的同一套 op 纯函数（若在服务端内部则抽出为共享 reducer），**禁止**前端另写一份"差不多"的 reducer——双通道语义分叉是最大风险。

### 4.5 比例来源（用户拍板③）

- 时间线节点外框 = `resolveVideoNodeDisplaySize({ videoSettings: { aspectRatio }, mediaInfo })`，与 `CanvasNodeVideo.vue:96` 逐像素一致。
- 比例取值优先级沿用既有函数：probe 实测 > 请求比例 > 320×320 兜底。
- 收起态内部布局改为按外框高度弹性分配（替代固定 54px/10px）；9:16 竖屏时片段块纵向堆叠。
- **不**在 `VideoTimeline`/`TimelineExport` 加比例字段。

---

## 5. 双通道架构

### 5.1 浏览器编辑端点（接线）

`VideoTimelineBrowserController`（`video-timeline.controller.ts:36-56`）新增：

```ts
@Post('edit')
@UseGuards(AuthGuard)
edit(@Req() req: AuthedRequest, @Body() dto: { sessionId: string; nodeId: string; ops: TimelineOp[] }) {
  return this.service.edit({ sessionId: dto.sessionId, userId: req.user.sub, nodeId: dto.nodeId, ops: dto.ops })
}
```

与 agent internal `edit` 共用 `service.edit()`，差异只在鉴权（AuthGuard vs AgentInternalGuard）与 userId 来源（登录态 vs DTO）。不改写点数量（仍是 `transactGovernedCanvasOps` 内的 `update_node`），不触发 `canvas-write-governance.test.ts` 白名单变更。

### 5.2 前端调用链

```
浮层编辑 → 本地 EditSession（ops + undo/redo）
        → 「完成」→ POST /api/video-timeline/edit { sessionId, nodeId, ops }
        → service.edit() → transactGovernedCanvasOps → data.timeline
        → 画布节点重渲染（服务端回读为准，不信任本地预览）
```

---

## 6. UI 设计

### 6.1 收起态（画布节点）

- 外框按 §4.5 比例函数定尺寸；内部改为弹性布局，杜绝竖屏挤压。
- 保留现有 header（文件名 + 时长）、ruler、视觉轨、A1/A2、footer 信息架构。
- 画中播放钮：复用 `.neo-gen-video-play-btn` 样式与 `openMediaPreview`，播第一条有 url 的视觉片段；hover 时浮现。
- clip 块保留原生 `title`（标题·时长）；hover 时播放头定位到该片段并高亮。
- 保持 `nodrag`（防误触）；节点整体移动仍从 `NeoBaseNode` 标题栏拖。
- 「展开编辑」入口：header 剪刀按钮从 disabled 改为可点（点开浮层），title 改为「编辑时间线与 agent 共用同一套操作」。

### 6.2 展开态（就地浮层）

- Teleport 到 body 的浮层面板，锚定在节点附近，跟随节点位置；不写死 `position: fixed` 在组件内（用 VueFlow viewport 坐标换算）。
- 结构：顶部播放条（播放/暂停 + `当前/总长`）→ 可缩放时间轴（视觉轨片段块 + 播放头 + 两端 trim 手柄）→ A1/A2 音轨 → 操作行（分割/删除/撤销/重做/完成）→ op 摘要区。
- 片段块拖拽排序 → `move_visual`；拖手柄 → `trim`；播放头 + 分割 → `split`；选中片段 + 删除 → `remove`。
- 所有编辑先落 `EditSession`（§4.4），「完成」才写回；关闭浮层询问是否放弃未保存 ops。
- 样式只用 design-tokens L2/L3；按钮热区桌面 ≥24px、移动 ≥44px（`var(--lnk-touch-target)`）。

### 6.3 hover（用户诉求③）

- 卡片本身常驻时间轴，不再叠加重复信息；hover 只提供两个增量 affordance：播放钮浮现 + 展开编辑入口高亮 + 播放头定位。
- 遵循移动端防误触纪律：形态切换瞬间出现的控件必须 DOM 下沉（`v-if`）+ capture 阶段点击意图守卫，不能用 CSS `display:none`（AGENTS.md 已立规）。

### 6.4 移动端列表式（用户诉求②的比例适配）

- 落点：`NodeTileView.vue` 的 video 分支检测 `data.timeline`，走新 `MobileVideoTimelineTile`（`components/mobile/` 下），不塞进 320px 横轨。
- 列表项：每行一个片段（缩略图/色块 + 标题 + 时长），音轨用「A1/A2」标签行。
- 点片段 → 进入该片段的编辑子面板（分割/删除/裁剪）；长按 → 拖拽排序；播放钮复用 `.mobile-node-video-play`。
- 外框尺寸仍走 `resolveVideoNodeDisplaySize`（与 tile 同源）；列表在 tile 内滚动，触控热区 ≥44px。
- 页面级组件（`CanvasPage.vue`）不得新增 `isMobileLayout` 分支（AGENTS.md 移动端呈现规则 1）。

---

## 7. 测试与取证判据

### 7.1 单元测试（红→绿，变异自检）

- `videoTimeline.service.test.ts`：`split` 正常/边界（区间外、音频轨）、`add_visual`/`add_audio` 修复回归（删分支 ⇒ RED）。
- `videoTimeline.test.ts`：`split` 后 `visualDurationSec == 编译 clips 总长`。
- 浮层 EditSession reducer：undo/redo/cursor/redoStack 清空语义；变异（改 redo 不清栈）⇒ RED。
- `VideoTimelineCard.test.ts`：播放钮存在、`data-timeline-edit` 可点、hover affordance。
- 移动端 tile：列表项数量、触控热区 token、长按拖拽接线。

### 7.2 静态契约 / 门禁

- design-token 测试（`design-token.test.ts`）：新增样式只用 L2/L3，禁新 hex。
- `CanvasPage.gestureWiring/mobileEntryWiring/mobileSelectionWiring` 三份静态契约：不得因本轮改动新增页面级 `isMobileLayout` 分支。
- 行数棘轮：改 `CanvasPage.vue` / `NodeViewerView.prod_refs` 会触发 `pc-canvas-legacy-manifest.json` 与 `phase4-delete-scope-manifest.json`，须审计式登记。

### 7.3 生产 CDP 行为取证（复用现成探针，不造轮子）

复用 `scripts/prod-cdp-smoke.mjs` 的 `Cdp`/`PREFLIGHT`/`mintJwt`，新增时间线专属判据（参考本轮已验证的 `vt-cdp-probe3` 模式）：

- 收起态：播放钮存在且 `openMediaPreview` 可达（dialog/预览层 DOM 事实）；展开入口可点。
- 展开态：拖片段 → 服务端回读 `trackOrder` 变化；分割 → `tracks` 数量 +1 且时长守恒；undo/redo → op 序列回退；「完成」→ 服务端回读 timeline 与浮层一致。
- 移动端：tile 列表项渲染、44px 热区、长按排序接线。
- 坑位遵循：导航后重连新 CDP session（坑⑧）、`Runtime.evaluate` 不带 `awaitPromise:true`（坑⑩b）、`window.confirm` 用异步点击 + dialog dismiss（坑⑩c）、判据只认 DOM + 服务端事实。

---

## 8. 完成定义

- [ ] `split` op 落地且变异测试 RED 验证通过
- [ ] `add_visual`/`add_audio` 假接线修复且变异测试 RED 验证通过
- [ ] 浏览器 edit 端点上线，手工编辑与 agent 写回同一 `data.timeline`
- [ ] 收起态比例自适应（16:9/9:16 实机截图）、播放钮、hover affordance
- [ ] 展开态浮层：拖拽排序/裁剪/分割/删除/撤销/重做/完成，公开 op 摘要
- [ ] 移动端列表式 tile（触控热区 ≥44px、长按排序）
- [ ] 单测全绿 + design-token + 移动端三静态契约 + 行数棘轮审计
- [ ] 生产 CDP 行为取证：关键交互路径 PASS，服务端回读一致
- [ ] 合并树 == CI 验证 head 树；部署后复测可持续

---

## 9. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 双通道 op 语义分叉（前端 reducer 与服务端 reducer 不一致） | 抽共享 reducer 到 `packages/shared`，前端预览与服务端写回调用同一函数；加一致性测试 |
| 浮层「完成」遇 staged/conflict | 沿用 `transactGovernedCanvasOps` 的 `onStaged:'conflict'`；浮层保留编辑态提示，不静默丢弃 |
| 竖屏(9:16) 时间线挤压 | 收起态改纵向堆叠；展开态浮层不受节点比例约束；实机截图纳入判据 |
| 移动端误触 | DOM 下沉 + capture 意图守卫 + 形态复位（AGENTS.md 三件套）+ 44px 热区 |
| 行数棘轮 CI 红 | 改动前先跑本地 spec-figures job 11 条门禁，审计式登记 manifest |
| 新增 op 破坏既有草稿 | `split` 纯新增；`add_*` 修复只补缺失分支；既有 P0 测试全量回归 |

**回滚**：浮层与移动端 tile 为纯前端呈现，feature flag 关闭即可回到 P0 卡片；服务端 `split`/`add_*` 为纯新增 op，不改既有 op 行为。

---

## 10. 实施分期建议（详见实施计划）

1. **P1.1 数据层**：`split` op + `add_*` 假接线修复 + 共享 reducer 抽取（后端与测试先行）。
2. **P1.2 双通道端点**：浏览器 edit 端点 + 前端调用链。
3. **P1.3 收起态**：比例自适应 + 播放钮 + hover affordance + 展开入口。
4. **P1.4 展开态浮层**：编辑会话 + undo/redo + 全部编辑手势。
5. **P1.5 移动端**：列表式 tile。
6. **P1.6 取证**：生产 CDP 行为验证 + 复测。

每期独立 PR、独立 CI 门禁；不捆绑发布。
