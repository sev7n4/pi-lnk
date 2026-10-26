# ADR-0014: 画布连线校验收口到服务端统一通道，画布定为 DAG（禁环/禁自环）

| 字段 | 值 |
|---|---|
| 状态 | Accepted |
| 日期 | 2026-10-26 |
| 决策者 | 用户（基于 SP-D 规格决策表 D1–D6 推荐项拍板） |

## 背景

画布有两条「加边」入口，待遇分裂且都缺校验（SP-D 规格 §4 代码级取证，基准 origin/master @ c9b62313）：

1. **用户手拉边**（`CanvasPage.onConnect`）：本地 `addEdge` + `persistUserEdit()` 整份 PUT，**完全绕过服务端**——自环（a→a）、反向 2-环（a→b 后 b→a）、悬空边（端点不存在的节点）都能直接落库，连服务端仅有的「有向对去重」都吃不到。
2. **agent 连线**（`connect_nodes` / `create_nodes_batch` edges）：走服务端 `connectNodes` / `addNodesBatch`，但服务端只做有向对去重，**缺端点存在性校验、缺自环拦截、缺环检测**（与 SP-A E1「端点 fail-closed」纪律不一致）。

约束与动机：

- **SP-B §16.1「顺着连线」重排**（`assignRanks` 拓扑分层）隐含假设画布是**有向无环图（DAG）**——一旦存在环，rank 分配失效、重排结果错乱。禁环不是凭空加约束，是保护已上线的 SP-B 能力。
- 本仓 silent-degrade 纪律：悬空边/重复边属于「静默坏数据」，必须 fail-closed。
- `/agent/internal/*` 由 `AgentInternalGuard`（服务间 token）把守，浏览器 JWT 过不去 ⇒ 前端收口不能直接复用该前缀，需要浏览器侧包装端点。

## 考虑过的方案

| 方案 | 优点 | 缺点 | 为什么没选 |
|---|---|---|---|
| D1 允许环（只拦自环） | 实现最小 | 破坏 SP-B `assignRanks` 拓扑分层前提；分镜/流程语义本就有向无环，环是噪声数据 | 环会让已上线的重排能力产出错乱结果 |
| D6-B：保留整份 PUT，仅在 `persistUserEdit` 保存边界前调 `validateEdgeAdditions` | 前端改动面小，不动落库通道 | 两条入口依然分裂（G4 不成立）；保存边界校验只能整体拒绝，给不出逐条可操作错误；整份 PUT 与服务端校验存在竞态窗口 | 统一通道是本决策的核心目标 |
| 前端 `isValidConnection` 实时判环 | 拖线时即时反馈 | 前端不知远端完整图（并发/agent 同回合改动），实时判环必然误拦/漏拦 | 环检测以服务端为权威（D5） |
| D6-A（已选）：手拉边收口到服务端 `connectNodes` 校验通道 | 与 agent 同一条校验逻辑；逐条 fail-closed 错误可点名；符合「图变更经统一通道」纪律 | 手拉连线多一次服务端往返（延迟）；需新增浏览器侧包装端点；改动面较大 | 一致性与正确性优先于一次往返延迟 |

## 决定

1. **画布是 DAG：禁止环**（含自环 a→a；反向 2-环由环检测自动覆盖）。环检测以**服务端为权威**，前端只做廉价本地拦截（自环 + 本地已存在同对有向边），不做实时判环。
2. **端点存在性校验在服务端 fail-closed**：`connectNodes` / `addNodesBatch` 对 source/target 逐条校验，未解析即 400 并点名（对齐 SP-A E1 纪律）。
3. **校验原语唯一**：shared 纯函数 `validateEdgeAdditions` + `wouldCreateCycle`（`packages/shared/src/canvas/graph.ts`），两条入口共用，不维护两套逻辑。
4. **用户手拉边收口到服务端通道（D6-A）**：`onConnect` 不再 `persistUserEdit` 整份直存；改走服务端 `connectNodes` 校验通道。因 `/agent/internal/*` 是服务间 token，浏览器侧新增 `POST /agent/canvas/connect-nodes`（AuthGuard + 属主校验）委托同一服务方法。
5. **重复边幂等跳过（不报错）**；硬非法（端点缺失/自环/成环）整批 fail-closed 拒绝。
6. **存量画布零迁移**：只拦新加边，不清理存量环（提供一次性诊断脚本另行登记）。

## 后果

**正面**：两条入口同一条校验逻辑；悬空边/自环/环从源头被拦；SP-B 拓扑重排的前提得到结构性保护；agent 拿到逐条点名的可重试错误。

**负面 / 代价** ❗：
- 用户手拉连线从「本地即时」变为「服务端往返确认」，弱网下有可感知延迟（乐观本地 add + 失败回滚缓解）。
- 浏览器侧 API 面扩大（新增 `POST /agent/canvas/connect-nodes`），多一个需要属主校验的写端点。
- 存量画布若有环，本决策不清理——会出现「新边加不进、旧环还在」的不一致观感，需靠文档与诊断脚本兜底。

**将来要注意**：
- 若出现「合法的有环需求」（如反馈回路类工作流），本决策需重审——届时 SP-B 拓扑分层需同步支持环处理（SCC 缩点），是双倍代价，不要轻动。
- 若后续引入跨画布/协作编辑，`validateEdgeAdditions` 需升级为基于服务端最新图的原子校验（配合 SP-E 的 canvasVersion CAS）。

## 关联

- 相关 ADR：ADR-0011（提议确认单一表面——本决策不改变确认门语义，仅加结构校验）
- 相关文档：SP-D 规格 `docs/superpowers/specs/2026-10-26-sp-d-edge-validation-design.md`；上游路线图 SP-A §12 / SP-B §15.4 / SP-C §8
- 实施计划：`docs/superpowers/plans/2026-10-26-sp-d-edge-validation.md`
