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
3. **侧车 op 通道（C2a，已落地 2026-11-02）**：`set_groups` / `set_composition_run_group` 两类 op（SSOT=`packages/shared/src/agentContract.ts`；applier=`packages/agent/src/tools/executor.ts` 单实现三端共用；服务端 `sanitizeClientOps` 白名单放行 + 形状校验；web `useCanvasActions.applyActionsToFlow` 显式 no-op case 防静默丢弃）。这是第 2 条「关闭 PUT」的前置——已达成。
4. **状态转移 API 幂等面定型**（P1-D 依赖输入）：文档化一页——节点状态全部合法转移及其幂等键（proposeEpoch / generationRecordId / P0-1 dedup / cancel 通道），作为 P1-D「审批分级」的状态机输入。

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
