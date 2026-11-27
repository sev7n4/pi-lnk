# 视频编辑时间线工具 P1 交互化实施计划

> 对应规格：[`docs/superpowers/specs/2026-11-27-video-timeline-editor-p1-interaction-design.md`](../specs/2026-11-27-video-timeline-editor-p1-interaction-design.md)（待评审）
> 日期：2026-11-27
> 纪律：本计划**不授权实现**，待用户审规格 + 计划后逐期授权。每期一个独立 PR、独立 CI 门禁、独立合并树核对；不捆绑发布。
> 分支纪律：每期走隔离 worktree + 分支；`gh api` REST 推 commit（本机 git push 502）；合并前查 mergeable + CI 全绿 + 运行队列；squash 后核合并树 == CI head 树。

---

## Global constraints（每期都适用）

1. **第一原则**：每期开工前在 PR 描述里填「等价物检索结论表」（已在规格 §1 给出，逐期引用，不重复造轮子）。
2. **写治理**：任何 `data.timeline` 写回只走 `transactGovernedCanvasOps`，禁止事务外 read-modify-write；白名单不新增条目。
3. **双通道同构**：前端编辑一律表达为 `TimelineOp`；预览 reducer 与服务端写回必须是同一份共享函数。
4. **测试纪律**：改 bug 先写 RED 测试；变异不 RED 先疑伪变异；守卫锁规则本体而非注释。
5. **令牌纪律**：新增样式只用 `design-tokens.css` 的 L2/L3；禁 `--neo-*`、禁新 hex、禁 `rgba(` 文字色；改样式后跑 `design-token.test.ts`。
6. **移动端纪律**：新呈现落 `components/mobile/`，页面级组件不加 `isMobileLayout` 分支；形态切换控件 DOM 下沉 + capture 意图守卫 + 44px 热区；改 `CanvasPage.vue` 行数先跑 spec-figures 11 门禁并审计登记 manifest。
7. **CI 纪律**：vitest 用 nvm node24 + `--maxWorkers=1 --no-file-parallelism`（web 全量后台跑）；`vue-tsc -b` 不加 `--noEmit`；pnpm 用 `env -u NODE_OPTIONS`。

---

## Task 1：数据层——`split` op + `add_*` 假接线修复 + 共享 reducer

**目标**：先把 op 语义做真，作为双通道的共同地基。

**步骤**
1. `packages/shared/src/canvas/videoTimeline.ts`
   - `TimelineOp` 新增 `split`（`node_id` + `at_sec`）。
   - 抽出 `applyTimelineOps(timeline, ops): {ok, timeline?, error?, opIndex?}` 纯函数，把 `service.edit()` 里散落的 op 分派逻辑（remove/set_volume/set_export/move_visual/trim + 新增 add_visual/add_audio/split）整体下沉；服务端 `edit()` 改调它。
2. `apps/server/src/agent/video-timeline.service.ts`
   - `edit()` 改为调共享 reducer，保留 `validateTimeline()`、画布写事务、确认门打点。
   - 补 `add_visual`/`add_audio` 分派（现为静默 no-op，规格 §4.2）；补 `split` 分派（规格 §4.1）。
3. `apps/server/src/agent/video-timeline.service.test.ts`
   - 新增：`split` 正常（区间内）、边界（区间外返回 `invalid_split_point`、音频返回 `unsupported_split_audio`）、split 后时长守恒。
   - 新增：`add_visual`/`add_audio` 回归（删分支必须 RED）。
   - 既有 P0 用例全量不回归。
4. `packages/shared/src/canvas/videoTimeline.test.ts`
   - 新增：`applyTimelineOps` 各 op 覆盖率；`split` 后 `visualDurationSec == 编译 clips 总长`。
   - 变异自检至少 2 项（删 split 分支、删 add_audio 分支）必须 RED。

**判据**：`pnpm --filter @lnkpi/shared test` + server 定向测试全绿；变异 2 项 RED；CI 4/4（Build monorepo / API image / spec figures / rollback guard）。

**风险**：reducer 下沉是重构，可能影响 P0 既有 op 行为 ⇒ 用 P0 全量测试护航；不改变任何 DTO。

---

## Task 2：双通道端点——浏览器 edit + 前端调用链

**目标**：让用户操作与 agent 操作写入同一份 `data.timeline`。

**步骤**
1. `apps/server/src/agent/video-timeline.controller.ts`
   - `VideoTimelineBrowserController` 新增 `@Post('edit')` + `@UseGuards(AuthGuard)`，调 `service.edit()`（规格 §5.1）。
   - 新增 DTO 校验（sessionId/nodeId/ops 数组），userId 从 `req.user.sub` 取，禁止来自 body。
2. `apps/server/src/agent/video-timeline.controller.test.ts`
   - 浏览器 edit：登录用户可写、跨账号 nodeId 返回 403、ops 非法返回明确错误。
3. `apps/web/src/composables/useVideoTimelineEdit.ts`（新建 composable）
   - 封装 `POST /api/video-timeline/edit`；提交后以服务端回读为准刷新节点，不信任本地预览。
   - GET 带 `cache:'no-store'`（项目纪律）。

**判据**：新增端点定向测试全绿；浏览器侧用登录态可写、越权被拒；CI 4/4。

**风险**：不新增写点 ⇒ `canvas-write-governance.test.ts` 白名单不变；若 CI 报白名单变更，说明写点签名逃逸，需停下审计而非改白名单。

---

## Task 3：收起态——比例自适应 + 播放钮 + hover affordance

**目标**：解决竖屏挤压、无播放、hover 无查看入口。

**步骤**
1. `apps/web/src/components/canvas/CanvasNodeVideo.vue`
   - timeline 分支播放钮：取第一条有 url 的 `track`，调 `openMediaPreview({ url: resolveMediaUrl(track.url), kind:'video' })`；`durationEstimated` 片段显示"时长待实测"。
   - 节点外框继续用 `resolveVideoNodeDisplaySize`（已接线，勿重复实现）。
2. `apps/web/src/components/canvas/VideoTimelineCard.vue`
   - 内部布局从固定 54px/10px 改为按外框高度弹性分配；9:16 片段纵向堆叠。
   - 剪刀按钮从 `disabled` 改为可点，emit `request-edit`；title 改「编辑时间线与 agent 共用同一套操作」。
   - hover：播放钮浮现 + 展开入口高亮 + clip 播放头定位（原生 title 保留）。
   - 保持根节点 `nodrag`。
3. `apps/web/src/components/canvas/VideoTimelineCard.test.ts`
   - 播放钮存在且点击触发 preview、编辑按钮可点、hover affordance DOM 事实。

**判据**：16:9 与 9:16 实机截图（生产或本地 build+preview）；`VideoTimelineCard.test.ts` 全绿；design-token 测试全绿。

**风险**：改 `CanvasNodeVideo.vue` 行数可能触发 legacy ratchet ⇒ 先跑本地 spec-figures 门禁，审计式登记。

---

## Task 4：展开态浮层——编辑会话 + 全手势 + undo/redo

**目标**：四项诉求中的 ①④ 在此完整落地。

**步骤**
1. `apps/web/src/composables/useVideoTimelineEditSession.ts`（新建）
   - `EditSession` 结构（base/ops/cursor/redoStack，规格 §4.4）。
   - `applyOp` / `undo` / `redo` / `commit`；预览用共享 `applyTimelineOps`（Task 1 产物），与服务端写回同函数。
2. `apps/web/src/components/canvas/VideoTimelineEditorOverlay.vue`（新建）
   - Teleport 到 body，锚定节点附近（viewport 坐标换算，禁 `position:fixed` 硬编码在组件内）。
   - 顶部播放条（复用 `openMediaPreview` 或内嵌 `<video>` 播 `tracks[].url`）；可缩放时间轴 + 播放头 + trim 手柄；A1/A2；操作行（分割/删除/撤销/重做/完成）；op 摘要区。
   - 手势：拖片段 → `move_visual`；拖手柄 → `trim`；播放头 + 分割 → `split`；选中 + 删除 → `remove`。
   - 「完成」→ Task 2 的 `useVideoTimelineEdit` 提交；失败保留编辑态；关闭询问放弃未保存 ops。
3. `apps/web/src/components/canvas/VideoTimelineEditorOverlay.test.ts`
   - undo/redo/cursor/redoStack 清空语义；各手势映射正确 op；完成提交一次且只一次。
   - 变异自检：redo 不清栈、undo 改 base ⇒ 必须 RED。

**判据**：浮层定向测试全绿 + 变异 RED；生产 CDP 行为取证（拖/分割/undo/redo/完成，服务端回读一致）。

**风险**：双通道语义分叉是最大风险 ⇒ 共享 reducer + 一致性测试锁死；浮层 UX 细节可能需 1 轮微调，先做核心手势。

---

## Task 5：移动端——列表式 timeline tile

**目标**：移动端可见可编辑，且符合移动端呈现规范。

**步骤**
1. `apps/web/src/components/mobile/MobileVideoTimelineTile.vue`（新建）
   - 列表式渲染 `tracks[]`（缩略图/色块 + 标题 + 时长），音轨 A1/A2 标签行。
   - 点片段 → 编辑子面板（分割/删除/裁剪）；长按 → 拖拽排序；播放钮复用 `.mobile-node-video-play`。
   - 外框走 `resolveVideoNodeDisplaySize`；触控热区 ≥44px（`var(--lnk-touch-target)`）。
2. `apps/web/src/components/agent/presentation/NodeTileView.vue`
   - video 分支检测 `data.timeline` → 渲染新 tile（不新增 `isMobileLayout` 分支）。
3. `apps/web/src/components/mobile/MobileVideoTimelineTile.test.ts`
   - 列表项数量、点击/长按接线、热区 token。

**判据**：移动端 tile 测试全绿；`CanvasPage.gestureWiring/mobileEntryWiring/mobileSelectionWiring` 三静态契约不回归；design-token 全绿。

**风险**：形态切换误触 ⇒ DOM 下沉 + capture 意图守卫 + 形态复位（AGENTS.md 三件套）。

---

## Task 6：生产取证与复测

**目标**：真机验证 + 可持续复现。

**步骤**
1. 复用 `scripts/prod-cdp-smoke.mjs` 的 `Cdp`/`PREFLIGHT`/`mintJwt`，写时间线 P1 专属探针（**不另造轮子**，参考已验证的 `vt-cdp-probe3` 模式）。
2. 判据：收起态播放/展开入口；展开态拖/分割/undo/redo/完成（服务端回读一致）；移动端列表/热区。
3. CDP 坑位：导航后重连新 session（坑⑧）；`Runtime.evaluate` 不带 `awaitPromise:true`（坑⑩b）；`window.confirm` 异步点击 + dialog dismiss（坑⑩c）；判据只认 DOM + 服务端事实；token 用 `/api/provider/bootstrap` HTTP 码验活（坑⑨a）。
4. 合并后部署 workflow 全绿 + 生产健康 + 成片可下载（h264/1280×720/4s）。

**判据**：CDP 行为取证 PASS；部署 success；启态 13/13 不回归。

---

## 交付顺序与授权点

| 期 | 内容 | 授权点 |
| --- | --- | --- |
| 1 | Task 1 数据层 | 规格+计划评审通过后授权 |
| 2 | Task 2 端点 | Task 1 合并后授权 |
| 3 | Task 3 收起态 | Task 2 合并后授权 |
| 4 | Task 4 浮层 | Task 3 合并后授权 |
| 5 | Task 5 移动端 | Task 4 合并后授权 |
| 6 | Task 6 生产取证 | 用户单独授权合并-部署-取证-复测 |

**当前状态**：规格与计划已完成，**等待用户审**；未写任何产品代码，未开 PR，未动生产。
