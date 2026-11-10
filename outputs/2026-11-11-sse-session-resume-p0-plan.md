# SSE 会话恢复 P0 实施计划（收口版）

> 日期：2026-11-11　|　基线：真 master `e9e02515`（2026-11-10 16:57Z）　|　性质：实施计划 + 测试用例 + 变异自检
> 母文档：`outputs/2026-11-11-sse-session-resume-diagnosis.md`
> **本计划只改 `apps/web`，零后端、零 schema、零 vendor patch。**

## 0. 与诊断基线的偏差（必须先读）

诊断基于 `31808ec0`。此后 master 已前进到 `e9e02515`，**部分 P0 工作已合入**：

- ✅ 统一 reducer 主体已落地：`applyTimelineEvent` 已有 `ask_user` case（`turnTimeline.ts:772`）与成熟的 `waiting_user` 终态映射（`:666-725`）。
- ✅ 历史重放已走统一 reducer：`mapPersistedToMessage`（`stores/agent.ts:973`）→ `replayTimelineEvents`（`:988`），按 `gSeq` 排序。
- ❌ **但历史路径缺一道归一化**：服务端至今仍按旧形态落库 `canvas_command`（生产实证：目标会话 `canvas_command:1 / ask_user:0`，近期会话 `ask_user` 全为 0）。`replayTimelineEvents` 把 `canvas_command` 喂给 `applyTimelineEvent` 会撞 `default: return`（`turnTimeline.ts:879`）→ **确认卡片被吞**。`AgentSideRail.vue:1126` 注释「已由 ask_user 事件收敛接管」是**规格-实现漂移**，现实并非如此。
- ❌ **生命周期 reconcile 入口仍缺失**：`useAgentObserver.ts:409-431` 的可见性处理只管旁观 SSE，`loadHistory`（`AgentSideRail.vue:1080`）仅在 mount（bootstrapThread）时跑。切回不重挂载 → 不 hydrate → 停在失效实时态 → 只剩 user 气泡（刷新=重挂载=走对路径）。
- ❌ **`historySanitize.ts:45-50` 仍剔除正文为空的 assistant 行**，但服务端允许"有 thinking/toolCalls 无正文"的回合落库 → 这类回合历史回放被静默丢行。

## 1. 范围（P0 收口三刀）

| # | 改动 | 文件:行 | 解决的现象 |
|---|---|---|---|
| A | 历史回放 `canvas_command{ask_user}` → `ask_user` 归一化 | `turnTimeline.ts:1106` `replayTimelineEvents` 循环内加 `normalizePersistedTimelineEvent` | 刷新/切回后**确认卡片不回来** |
| B | `visibilitychange→visible` / `pageshow(persisted)` 触发 `loadHistory()`（单飞、非流式时） | `AgentSideRail.vue`（新增 onMounted/onUnmounted 监听） | **切回只剩 user 气泡** |
| C | `historySanitize` 不剔除"正文空但 executionEvents 非空"的 assistant 行 | `historySanitize.ts:45-50` | 无正文的纯过程回合被静默丢行 |

## 2. 改动详设

### A. `replayTimelineEvents` 归一化（核心，治本点）

在 `turnTimeline.ts` 内、紧邻 `replayTimelineEvents` 上方新增纯函数：

```ts
/**
 * 历史回放归一化：服务端落库形态 `canvas_command{type:'ask_user'}` 收敛为时间线原生
 * `ask_user`，使历史路径与实时路径（trackAskUser → feedTimeline({type:'ask_user'})）
 * 共用同一个 applyTimelineEvent 分支，避免确认卡片在历史回放中被 default 吞掉。
 * 仅转换 ask_user 子类型；其它 canvas_command（set_group_color/focus_node/add_node 等）
 * 是画布侧事件，不在时间线 parts 内，保持原样（撞 default 与现状一致，不引入行为变化）。
 */
function normalizePersistedTimelineEvent(
  e: { type: string; data?: unknown; seq?: number; gSeq?: number },
): { type: string; data?: unknown; seq?: number; gSeq?: number } {
  if (e.type === 'canvas_command') {
    const d = e.data as { type?: string } | undefined
    if (d?.type === 'ask_user') {
      return { type: 'ask_user', data: e.data, seq: e.seq, gSeq: e.gSeq }
    }
  }
  return e
}
```

`replayTimelineEvents` 循环改为：
```ts
for (const event of ordered) {
  applyTimelineEvent(timeline, normalizePersistedTimelineEvent(event) as TimelineEvent)
}
```

**为什么放这里**：`replayTimelineEvents` 是 `loadHistory` 与 `prependHistory` 共用的唯一历史重放入口（`stores/agent.ts:988 / :1057`），一处归一化两路受益，且不影响 `replaySvgCardPresentation`（独立函数，测 `agent.svgCardReplay.test.ts:89` 不受影响）。

### B. 生命周期 reconcile 入口

在 `AgentSideRail.vue` 新增（与现有 `loadHistory` 同文件，沿用其 `props.sessionId` / `agentThreadId` / `historyLoadState`）：

```ts
// P0-B（SSE 会话恢复）：切后台再回来 / bfcache 恢复时不重挂载 → 不 hydrate → 停在失效实时态。
// 此时若会话已非流式（最常见：已收束的对话被切走），直接以服务端权威快照重放，
// full-replay 整体替换（loadHistory 内置 merge 逻辑保留本地流式气泡、去重幂等）。
// 单飞：historyLoadState==='loading' 时由 loadHistory 自身挡重入；再加组件级 single-flight 防
// visibilitychange 与 pageshow 同拍双触发。
let reconcileSingleFlight = false
function reconcileOnVisible() {
  if (reconcileSingleFlight) return
  if (document.visibilityState !== 'visible') return
  if (agent.isStreaming) return            // 流式回合：实时 SSE 是权威，clear 会丢半条消息
  if (navigator.onLine === false) return   // 无网不赌：clear 后失败 → 整页空白（既有陷阱）
  if (!agentThreadId.value) return
  reconcileSingleFlight = true
  void loadHistory().finally(() => { reconcileSingleFlight = false })
}
function onPageShowReconcile(e: PageTransitionEvent) {
  if (e.persisted) reconcileOnVisible()    // bfcache 恢复：JS 被冻结未卸载，bootstrapThread 未重跑
}
onMounted(() => {
  document.addEventListener('visibilitychange', reconcileOnVisible)
  window.addEventListener('pageshow', onPageShowReconcile)
})
onUnmounted(() => {
  document.removeEventListener('visibilitychange', reconcileOnVisible)
  window.removeEventListener('pageshow', onPageShowReconcile)
})
```

**判定**：不重挂载的情形（SPA 路由不变 → `App.vue:49 :key` 不变 → 不重挂载；或 WebView 冻结 JS）由本入口覆盖；重挂载情形已由 `bootstrapThread` 覆盖。两条路径合起来 = 任意"切回/恢复"都 hydrate。

**风险边界**：流式回合在后台断开连接的情形（live SSE 死、isStreaming 仍为 true）本刀不修——会停在冻结态，需手动刷新。这是主会话 SSE 自身的健康/重连议题（独立于本刀），已在母文档 §3.1 标注；本案报告的是**已收束对话**切走切回，完全覆盖。

### C. `historySanitize` 修正

`historySanitize.ts:45-50` 的剔除条件由
```ts
if (r.role === 'assistant' && contentEmpty) {
```
改为：仅当"正文空 且 无有效 executionEvents"才剔除：
```ts
if (r.role === 'assistant' && contentEmpty) {
  // 服务端允许"有 thinking/toolCalls 无正文"的回合落库（agent.service.ts 已实证）。
  // 仅剔除"正文空且无任何过程事件"的真空行；带 executionEvents 的空正文行保留，
  // 否则整段过程态在历史回放中被静默丢行（母文档 P0 第5项）。
  const hasEvents = !!(r.metadata && /"executionEvents"\s*:\s*\[/.test(r.metadata))
  if (!hasEvents) {
    droppedEmptyAssistant++
    continue
  }
}
```

## 3. 测试与变异自检（按交付纪律 §判据必须能真的失败）

### 3.1 新增 `apps/web/src/components/agent/turnTimeline.replayAskUser.test.ts`
- **正向**：构造 `executionEvents` 含 `{type:'canvas_command', data:{type:'ask_user', callId, questions:[...]}}`（= 服务端真实落库形态） + `bodyText`，调用 `replayTimelineEvents(events, bodyText)` → 断言 `parts` 中存在 `kind==='question' && status==='pending_answer' && callId 匹配`。（**直接读真实 `replayTimelineEvents` 跑，不抄逻辑。**）
- **变异自检 1（删归一化 ⇒ RED）**：临时把 `replayTimelineEvents` 循环改回直接 `applyTimelineEvent(timeline, event)` → 断言转红、exit≠0。
- **变异自检 2（同构证明）**：把输入改成原生 `{type:'ask_user', data:{...}}` → 同一断言仍 GREEN（证明两路径同构，归一化只是桥接）。
- **阴性对照**：构造不含 ask_user 的样本 → 断言无 question part（防误建）。

### 3.2 新增 `apps/web/src/components/agent/historySanitize.keepEventfulEmpty.test.ts`
- 输入一条 `role:'assistant', content:'', metadata:'{"executionEvents":[{"type":"thinking"}]}'` → 断言 `droppedEmptyAssistant===0` 且 `rows` 仍含该行。
- 变异：把 C 的 `hasEvents` 判定删掉 → 断言转红（证明不是恒绿）。
- 对照：纯真空 `{content:'', metadata:null}` → `droppedEmptyAssistant===1`。

### 3.3 reconcile 入口（轻量、不依赖真实 DOM 生命周期）
- 在 `AgentSideRail` 既有测试文件体系中补一个用例：stub `document.visibilityState='visible'`、`agent.isStreaming=false`，派发 `visibilitychange` → 断言 `loadHistory` 被调用一次（single-flight：连发两次只调用一次）。`loadHistory` 用 mock fetch 返回目标会话两行（带 canvas_command） → 断言最终消息里含 question part。
- 该用例同时验证 A+B 串联：模拟"切回"后，历史里的 `canvas_command` 经归一化重建出可点的确认卡片。

## 4. 验收判据（生产实证，非只单测）

1. 不刷新、切后台再回来（或 bfcache）→ 思考/工具/计划/**确认卡片**全部可见且卡片可点。
2. 重复切 5 次无双气泡、无闪烁（single-flight + merge 去重）。
3. 刷新态确认卡片恢复（A 生效）。
4. 飞行模式断流后恢复（非流式）→ 无需刷新。
5. 生产取证：对目标会话 `cmwauqze8012pt901tl5ns577` 重跑无头 Chrome，断言 `agent-turn--assistant`≥2 且「三步制作Codex」≥1（卡片重建）。

## 5. 落地纪律（本仓约束）

- 本机 `git push` 被网络阻断 → 经 `gh api` REST 推 PR（裸 blob sha + `base_tree`=真 master 树 + 逐路径比对 + 建分支 ref）。
- P0 只改 `apps/web` → 合并触发 `deploy.yml` 生产发布 ⇒ **合并窗口需单独授权 + 生产复测**（A-6 真机走查：iOS Safari + Android Chrome + 鉴权会话，本环境不可代跑，**不宣告验收完成**）。
- `push` 前 `git status --short` 必须为空（本地改动须全部进 PR）；定向 vitest + `vue-tsc -b` 零错误。
- 回滚：PR 合入即单 commit，回滚 = revert 该 commit；零 schema/后端，无数据迁移风险。
