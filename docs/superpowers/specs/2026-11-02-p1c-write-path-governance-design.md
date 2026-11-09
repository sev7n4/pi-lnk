# P1-C 写路径治理实施规格：C0 守卫止血 · C1 patch 化 · C2 单 owner 收敛（v1）

> 上游：`2026-10-31-p1-root-cure-roadmap-design.md` §6 P1-C 概要 + §2 贯穿不变量。
> 前置：P1-B 四包已上线（B1 `4e99f594` / B2 `7eb85708` / B6 `5b04264e`），生成终态写者已收归 Nest。
> 状态：**待评审**。裁决点 §7。

## 0. 侦察实锤（2026-11-02，`git show 5b04264e` 逐条核实）

| # | 事实 | 位置 | 影响 |
|---|---|---|---|
| F-C1 | 浏览器保存主面 = `saveCanvas()` → `PUT /sessions/:id` **整份替换**：`foldGroups` + `flowToCanvasData` 全量序列化后 PUT；消费者 10+ 处（undo/redo ×6、`useNodeGeneration` ×5、viewport 防抖、节点编辑、agent 投影注释均以「画布 SSOT 在前端内存图」为心智） | `apps/web/src/pages/CanvasPage.vue:5191`、`:5251` | C1 主体 |
| F-C2 | **守卫旁路缺口**：`PUT /agent/canvas/update`（canvas.service.update）整份替换 canvasData 且**零守卫**——sessions.service 有 `guardPendingConfirmStatuses`，此面没有。当前 web 侧仅 `useProjectWorkspace.ts:180` 用它改 title（canvasData 载荷为 0 ⇒ 未被利用的旁路），但契约上任何持有 token 的客户端可整份提交绕过 P0-4 | `apps/server/src/canvas/canvas.service.ts:66-70`、`canvas.controller.ts:80` | **C0 止血** |
| F-C3 | **服务端 ops 级 applier 已在生产**：`applyCanvasActions`（@lnkpi/agent，5 类 ops：`add_node`/`update_node`/`add_edge`/`remove_edge`/`remove_node`）+ `persist()` 的 `$transaction`（读→apply→写回）；agent 链路（update-node/update-nodes-batch/propose/clear-propose）全走它 | `apps/server/src/agent/agent-canvas-tools.service.ts`（persist + `UPDATE_NODE_WRITABLE_FIELDS`）、`packages/agent/src/tools/executor.ts` | C1 服务端复用 |
| F-C4 | 前端节点 status 写面 B2 已收敛：web ratchet（写点 14+1+0 只减不增）+ runtime 硬零守卫在 CI。sessions 守卫的合法出口集仍含 `generating`（`PENDING_CONFIRM_CLIENT_EXITS`）——整份 PUT 形态下客户端仍可写 generating 节点的其余字段（generationRecordId 等） | `apps/server/src/sessions/sessions.service.ts:84-127` | C1/C2 |
| F-C5 | SP-E 画布并发 CAS（canvasVersion）PR #625 **OPEN 待评审**：与 C1 并发语义叠加——patch 语义天然缩小冲突面，CAS 从「整份覆盖的救生圈」降级为「ops 级的可选增强」 | PR #625 | §7 裁决 4 |
| F-C6 | saveCanvas 已有两道前端防线：`canvasLoadGuard`（未加载禁止保存，2026-10-26 空画布事故）+ 视口 tracker 防抖；**3s 自动 PUT 形态已被 P0 系列瓦解**（当前触发面=显式变更后保存，无固定间隔定时器） | `CanvasPage.vue:5191-5213` | 风险面收窄佐证 |

## 1. 分包裁决：C0 先行止血，C1 主体，C2 收口

```
C0（S）→ C1（XL，分 C1a 服务端 + C1b 前端两 PR）→ C2（S，收口守卫）
```

- **C0 守卫止血（S，独立小 PR，先行）**：`canvas.service.update` 补齐 sessions 同款 `guardPendingConfirmStatuses`。理由：旁路缺口独立于 patch 化存在，任何时点补都是净收益；等 C1 才补等于让缺口再活一个 XL 周期。
- **C1 patch 化（XL）**：服务端 PATCH 端点 + 前端 diff 引擎。
- **C2 单 owner 收口（S）**：PATCH 白名单守卫进 CI + PUT 弃用期观测面板 + 状态转移幂等面定型（P1-D 输入）。

## 2. C0：守卫止血（首 PR）

1. `canvas.service.update` 与 `sessions.service.update` 同款守卫：pending_confirm 节点客户端 status 非法 ⇒ 字段级保留服务端值。
2. **守卫实现抽公共**（`guardPendingConfirmStatuses` 从 SessionsService 提为共享纯函数，两处调用）——禁止复制粘贴两份漂移。落点：`apps/server/src/canvas/pending-confirm-guard.ts`（纯函数 + 单测），sessions/canvas 两侧 import。
3. 判据：构造 pending_confirm 画布 → `PUT /agent/canvas/update` 提交 status=completed ⇒ 服务端保留 pending_confirm、其余字段照常落库；变测试锁进 CI（sessions 侧既有用例平移一份）。
4. 不做：不动 PUT 形态本身、不动 title 路径、不做打点（C2 统一）。

## 3. C1：patch 化

### 3.1 服务端（C1a）

- **新增 `PATCH /sessions/:id/canvas`**（sessions.controller）：
  - 载荷 `{ ops: CanvasAction[] }`，**ops 级**（复用 F-C3 的 5 类 op；不发明新 op 方言）。
  - 校验链：AuthGuard → 属主（同 sessions.update 口径）→ **客户端 ops 白名单**：
    - `update_node.data` 禁写服务端字段：`status`、`generationRecordId`、`generationStartedAt`、`errorMessage`、`proposalEpoch`（B6 新字段一并纳入）——**patch 语义下客户端根本提交不了 status**（总纲 §2 不变量 3 的落地形态）。
    - 禁 op：`remove_node` 对 generating/pending_confirm 节点 ⇒ 409（取消走既有 cancel 通道）。
  - 落库：复用 `applier.apply` + `$transaction`（同 persist，stagedActions 冲突同样 409）。
  - 返回：`{ applied, canvasVersion? }`（canvasVersion 见 §7 裁决 4）。
- **PUT 弃用期**：`PUT /sessions/:id` 与 `PUT /agent/canvas/update` 保留不动（旧 web 缓存自愈，P0-4 过渡期经验）；服务端加 **PUT 调用打点**（logger 计数即可，格式 `canvas_put_deprecated sessionId nodes=N`，供 C2 观测清零）。打点必须零阻塞。

### 3.2 前端（C1b）

- **diff 引擎**（新 `apps/web/src/utils/canvasDiff.ts`，纯函数 + 完整单测）：
  - 输入 `lastSavedSnapshot`（每次成功保存后重建）+ 当前 `foldGroups` 后的 CanvasData；
  - 输出 ops[]：节点按 id 分桶 → 新增=add_node、删除=remove_node、存活=逐字段 diff（浅比较 data 键值，仅提交**变化键**——客户端白名单外键变化直接丢弃并 console.warn，不静默带上）；edges 同构。
  - 空差异 ⇒ 零请求（顺带消灭「无变更也 PUT」的历史浪费面）。
- **saveCanvas 切换**：`api.put('/sessions/:id')` → `canvasApi.patchCanvas(sessionId, ops)`；成功后重建 lastSavedSnapshot。失败路径：补做一次全量 GET 对账（Nest SSOT 重建内存图）后再 diff——**不做本地重放**，fail-safe 对齐 canvasLoadGuard 纪律。
- **并发编辑**：diff 粒度=节点级 ops，双端同时改同一节点的不同字段在服务端 merge 天然共存；同字段后写胜（与今日整份 PUT 的「后写全胜」相比严格改善）。
- **foldGroups / viewport / compositionRunGroup**：均为 saveCanvas 输入侧逻辑，零改动——diff 只替换「序列化之后 → 传输」的一段。

> ⚠️ **C1b 落地修正（2026-11-02，PR #669）**：上行「零改动」不准确——viewport 与侧车都是落库载荷的一部分。实际处置：viewport 变化走 `set_viewport` op（executor 原生第 6 类，C1b 同步放行白名单）；groups / compositionRunGroup 无 op 通道，C1b 过渡期回退整份 PUT。
>
> ✅ **C2a 补齐（2026-11-02）**：`CanvasActionTypeSchema` 增 `set_groups` / `set_composition_run_group`（全量替换语义，后者 null=删键）；applier、服务端 sanitize 白名单（含畸形载荷剥除）、web canvasDiff 同步扩展。此后 web 主路径**不再有任何带 canvasData 的 PUT**，侧车 op 化成为关 PUT 的达成前提而非缺口。`sidecarChanged` 旗标退役为观测面。

### 3.3 明确不做（防膨胀）

- 不做 ops 冲突解决/OT/CRDT（同字段后写胜足够，红队 Part E 未要求）。
- 不做 runtime/agent 链路改造（它们已是 ops 级）。
- 不做 PUT 服务端拒绝/降级只读（观测清零前 PUT 是旧缓存自愈通道）。

## 4. C2：单 owner 收口

1. **PATCH 白名单守卫进 CI**：服务端单测锁「客户端 ops 提交 status ⇒ 被丢弃/拒绝」；web 侧 `canvasDiff` 单测锁「白名单外键变化不进 ops」。与 B2 双守卫（web ratchet + runtime 硬零）合并成三件套。
2. **PUT 观测清零流程**：C1 上线后观测 `canvas_put_deprecated` 日志计数；连续两周清零 ⇒ 关闭 PUT 的 canvasData 写入（保留 title）——独立小 PR，届时另评估。
   > 📊 **观测注记（2026-11-03，代码面收官日）**：C0/C1/C2a/C2b/防回退守卫已全部合并上线（#667→#668→#669→#670→#687→#689，本规格**代码面任务全部完成**）。生产观测：11-02 nginx 口径 419 次 PUT（旧 web 主路径）→ 11-03 仅零星 1-2 次（移动端旧缓存 EdgA 走 `PUT /agent/canvas/update`）；两个 PUT 端点（`sessions.service.update` 与 `apps/server/src/canvas/canvas.service.ts` update）打点齐备。
   >
   > ✅ **C2② 提前执行（2026-11-03，现网无真实用户 ⇒ 「旧缓存自愈窗」前提失效，无需等 ~11-16）**：两个 PUT 端点的 canvasData 写入已关闭——带 canvasData 的 PUT ⇒ **整包忽略**（返回 200，title 照常落库，服务端画布不被 stale 载荷覆盖），打点升级 `canvas_put_rejected` 留痕观测残留调用方；旧客户端下次 GET 对账即回真值（fail-safe 对齐 canvasLoadGuard 纪律）。连带收尾：`guardPendingConfirmStatuses`（C0 整份形态守卫）随其唯一两个调用面消失而退役删除，pending_confirm 客户端防线由 PATCH 白名单（sanitizeClientOps）承接；防回退守卫签名补裸局部变量形态（历史 `canvas.service` 用 `data: { ...data, canvasData }` spread 逃过签名——已堵），白名单删 PUT 弃用期条目。**本规格至此全部完成，可归档。**
3. **侧车 op 通道（C2a，已落地 2026-11-02）**：`set_groups` / `set_composition_run_group` 两类 op（SSOT=`packages/shared/src/agentContract.ts`；applier=`packages/agent/src/tools/executor.ts` 单实现三端共用；服务端 `sanitizeClientOps` 白名单放行 + 形状校验；web `useCanvasActions.applyActionsToFlow` 显式 no-op case 防静默丢弃）。这是第 2 条「关闭 PUT」的前置——已达成。
4. **侧道写者收编（C2b，已落地 2026-11-03）**：客户端写面收编后，审计发现服务端仍残留**绕过 op 语义直接 read-modify-write 整份 canvasData** 的侧道写者。全部写者清单（`git grep` 全量核实）：合规（`agent-canvas-tools.persist*` 家族 / `agent.service.finalizeTurn` applier 分支 / `sessions-canvas-node-status`（事务+staged 守卫+状态机三全））之外，两个缺口——
   - `assets/persist-remote.service.rewriteNodeUrl`：**无事务、无 stagedActions 守卫**的裸写（storageTier/url 回写）；
   - `agent/composition.service.confirm`：compositionRunGroup 侧车回写**事务外读 afterImport 再整份写回**（与 import 落地之间的窗口覆盖中间写者 = 丢更新，红车事故同族形态），且无 stagedActions 守卫。

   收编方式：新增共享合规落库通道 `apps/server/src/sessions/canvas-op-write.ts`（`transactGovernedCanvasOps`）——事务内读最新 → `applyCanvasActions` op 语义 → 事务内写回，stagedActions 在场按 `onStaged` 处置（`skip`=后台写者退让 / `conflict`=调用方映射 409，与 persist 家族同语义）。persist-remote 改走 `update_node` op（storageTier/url 是服务端字段 owner，不经客户端白名单——合规 = op 语义 + 事务 + staged 守卫，非白名单本身）；composition confirm 改走 `set_composition_run_group` op（C2a 侧车通道服务端复用）并与 compositionPreview 同事务原子落库，parseCanvas 抛错语义原样保留（tx 内抛 ⇒ 零写入）。行为级判据：`canvas-op-write.test.ts` 六判据 + persist-remote 两判据（staged 退让/节点缺失零写入）+ composition 409 判据。

   **防回退机器守卫（2026-11-03 追加）**：`apps/server/src/sessions/canvas-write-governance.test.ts`——全目录扫描（排除测试文件）所有画布写点签名（`canvasData: JSON.stringify(...)` 整份覆盖 / 行级 copy-through；`? JSON.parse` 格式化读取行不匹配），与白名单逐文件核对数量；白名单条目各带合规理由（通道本体 / persist 家族 / applier 兜底 / PUT 弃用期 / node-status / session.create 种子与拷贝），**改白名单 = 审计动作**。变异测试已验：注入伪造绕过写点 ⇒ 精确报 file:line 并指路 `transactGovernedCanvasOps`；AGENTS.md 变更影响面矩阵同步立规。
5. **状态转移 API 幂等面定型**（P1-D 依赖输入）：文档化一页——节点状态全部合法转移及其幂等键（proposeEpoch / generationRecordId / P0-1 dedup / cancel 通道），作为 P1-D「审批分级」的状态机输入。

## 5. 验收判据（行为级）

| # | 判据 |
|---|---|
| C0-1 | 旁路 PATCH 提交 pending_confirm→completed ⇒ 服务端保留 pending_confirm，其余字段落库 |
| C1-1 | 前端无变更 ⇒ 零网络请求（diff 空直接返回） |
| C1-2 | 拖动节点 ⇒ PATCH 载荷仅含该节点 position 变更（1 条 update_node，data 仅 position 键） |
| C1-3 | 客户端手写 ops 提交 status/errorMessage ⇒ 服务端丢弃该键并 console.warn（服务端侧则直接拒绝） |
| C1-4 | 旧 web 缓存发整份 PUT ⇒ 依旧成功（弃用期），守卫字段级回填不回归 |
| C1-5 | 双端并发改同一节点不同字段 ⇒ 两字段均落库 |
| C2-1 | 三件套守卫（web diff 白名单 / 服务端 PATCH 白名单 / web ratchet）任一回归 ⇒ CI 红 |
| C2-2 | P1-D 状态机输入文档存在且经评审 |

## 6. 文件级改动清单

| 包 | 文件 | 动作 |
|---|---|---|
| C0 | `apps/server/src/canvas/pending-confirm-guard.ts` | 新（共享纯函数） |
| C0 | `apps/server/src/canvas/canvas.service.ts` | update 接守卫 |
| C0 | `apps/server/src/sessions/sessions.service.ts` | 改 import 共享守卫 |
| C0 | `apps/server/src/canvas/pending-confirm-guard.test.ts` | 新 |
| C1a | `apps/server/src/sessions/sessions.controller.ts` + service | +PATCH 端点 + ops 校验 + 打点 |
| C1a | `apps/server/src/sessions/sessions-patch.service.test.ts` | 新（C1-1/3/5 判据） |
| C1b | `apps/web/src/utils/canvasDiff.ts` + 单测 | 新 |
| C1b | `apps/web/src/services/canvas-api.ts` | +patchCanvas |
| C1b | `apps/web/src/pages/CanvasPage.vue` | saveCanvas 切 diff/PATCH + lastSavedSnapshot |
| C2 | `apps/server/src/agent/agent-canvas-tools.*`（白名单测试挂靠）+ 文档 | 收口 |

## 7. 裁决点（评审拍板）

1. **C0 先行是否同意**（建议：同意，独立小 PR 不等 C1）。
2. **patch 形态**：ops 级（本规格）vs 字段级 JSON Merge Patch（总纲原文二选一措辞）——建议 ops 级：applier 已生产、diff 天然映射、禁写白名单好表达；字段级 merge 的数组语义（nodes 数组）表达力差。
3. **`update_node` 客户端白名单范围**：本规格禁 status/recordId/startedAt/errorMessage/proposalEpoch 五键；position/title/prompt/模型参数/localRefs/viewport 等放行。是否有遗漏的客户端合法写字段？（若不确定，C1a 可先「禁 5 键 + 观测 unknown-key warn」渐进收窄。）
4. **SP-E PR #625 处置**：并入 C1（canvasVersion 作为 PATCH 可选响应字段+冲突 409，opt-in）vs 维持独立评审（C1 先行、CAS 后叠）。建议：**维持独立**——C1 已含并发语义改善，CAS 作为独立增强在 C1 落地后重新评审其必要性（冲突面已缩小，CAS 的边际价值需重估）。
5. **PUT 关闭节奏**：观测两周清零后关闭（本规格）vs 上线即降级只读合并——建议前者（旧缓存自愈优先，2026-10-29 事故的教训是客户端形态不可假设）。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| diff 引擎漏字段 ⇒ 静默丢改动 | canvasDiff 全量单测（每字段类型一例）+ C1b 上线初期双跑（diff PATCH + 低频兜底 PUT 对账，观测一周后撤）——**双跑期**是否保留见评审 |
| 白名单误伤客户端合法写字段 | §7-3 渐进收窄策略（先禁 5 键 + unknown-key 打点） |
| stagedActions 与 PATCH 并发 409 | 复用 persist 同款 409 语义，前端对账重试一次 |
| 双端同时 remove+update 同节点 | remove op 对不存在节点幂等（applier 现状），后写胜 |

## 9. 执行时状态回填：SP-E CAS 必要性重估（2026-11-09，只追加）

> 本节为只追加状态回填，**不改写** §7-4 的历史裁决与 §8 的风险表。历史时点结论一律以其取证时点为准。

- **触发**：§7-4 第 4 条要求「C1 先行、CAS 后叠……CAS 作为独立增强在 C1 落地后重新评审其必要性（冲突面已缩小，CAS 的边际价值需重估）」。该重估于 2026-11-09 执行，此前从未发生：PR #625 的 v2 规格只把收益主体从「PUT 整份覆盖」换成「PATCH op 流」，11-06 评审意见同样基于 11-02 基线（PR `updated_at` 仍为 `2026-11-06T16:32:26Z`、head 仍为 `bdc2bd9713e36d9d01f998f2ded24b4cb48d9326`）。
- **执行时事实基线**：true master `2b6693c579ff2931a84d1954e93fecf5617db91`；本节取证时点 v2 规格基线 `d407ad98` 已前进 **121 提交 / 300 文件**；生产容器 `lnkpi-api:b1190a2a`（服务端写路径治理代码已在生产 bundle 命中 `canvas_put_rejected` 与 `transactGovernedCanvasOps`）。取证全程走 `gh api` Git Data REST 裸 blob，不信任本地 ref。
- **重估结论（代码事实）**：C1 / C2② / P1b / Phase 5 已全部落地 ⇒ 整份 PUT 关闭、7 文件 12 写点全部事务化 + op 语义、服务端专属键由 5 键扩至 8 键、op 应用收敛为 `packages/shared/src/canvasActionApplier.ts` 单一 SSOT、前端只提交变化键。v2 的 9 条实施陈述被证伪；真实残损面只剩「过期基线 op 静默 no-op」与「同字段后写赢」两类。
- **重估结论（生产证据）**：生产 nginx 11-02~11-09 共 **9088 次** `PATCH /api/sessions/:id/canvas` / 83 个 session / 相邻 ≤2s **3534 对**；状态 `200=9019`、`404=57`、`502=4`、`401=7`、`403=1`，**零冲突信号**。现有日志分辨率只有 `(IP, UA, 秒)`，无法区分同一 session 的两个客户端内存基线 ⇒ 收益论证缺少分母；而 3534 对近距写同时说明「任何写都 bump」会制造假 409 风暴。
- **裁决**：对 PR #625 v2 原案判 `NO_GO_FOR_IMPLEMENTATION`；主线改走 **A 决策门** —— 阶段 0 决策门规格（本次）、阶段 1 零契约观测 + op 幂等加固（零 DB 列 / 零 migration / 零 409 / 零 UX 变化）、阶段 2 14 天数据门（`stale_conflict ≥ 30` 且 `≥ 3` session + `≥ 1` 起可复现用户丢失 + 预估 `409 率 < 0.5%`，三条同时满足才升级 409，否则 NO-GO 定案）。
- **后继资产**：[`2026-11-09-sp-e-canvas-cas-decision-gate-design.md`](./2026-11-09-sp-e-canvas-cas-decision-gate-design.md)（13 章规格）、[`../plans/2026-11-09-sp-e-phase1-observability.md`](../plans/2026-11-09-sp-e-phase1-observability.md)（8 task 实施计划）。
- **完成定义**：不宣告未闭环项 ALL_PASS；数据门不达标即关闭或改写 PR #625 为「观测结项 + 幂等加固」，并把结论继续只追加回填到本节。
