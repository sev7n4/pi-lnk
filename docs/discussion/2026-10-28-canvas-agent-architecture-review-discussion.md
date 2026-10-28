# 画布 Agent 架构审视：从「移动端连线不可见」到状态同步的系统性治本

> 2026-10-28 · 讨论文档（方向/决策来源）。触发事件：用户在移动端画布  
> `cmvrrx4cj00punx01px28kmlz` 通过 agent 生成剧本，agent 有 `connect_nodes` 工具调用，  
> 前端却看不到节点连线。本文不就事论事——把这一症状当作 canary，对  
> 「agent 产物 → 服务端持久化 → 多客户端同步 → 移动端呈现」全链路做一次架构级审视，  
> 并对照上游 pi-agent（vendor v0.85.1）能力与 Codex / Claude / WorkBuddy 的产品工程实践，  
> 给出分阶段治本路线。
>
> 取证基线：origin/master 当日工作区 + 生产 DB（119.29.173.89 lnkpi.db）直查。  
> 文中所有 文件:行号 均经实读核实，非凭印象。

---

## 0. 结论速览（TL;DR）

1. **连线不可见不是 bug 孤例，是「有损派发通道 + 双真相源 + 移动端二等公民」三重系统性缺陷的一个可见切面。** 本次个案本身（生产库 13 条边全部落库、端点全有效）数据链路完好，纯粹是移动端渲染层视觉不可见（边样式 alpha 0.3 × 40px 磁贴缝隙 × fitView 缩放 ≈ 亚像素淡线）——但沿链路排查出的 18 类静默失败模式（§4）说明：**今天不可见的是边，明天不可见的就是任何一类 canvas 产物。**
2. **与上游 pi 内核的真实设计冲突只有一处根因**：画布领域状态放在上游 Session 存储域之外的 Prisma `Session.canvasData`（双真相源），由此派生出 stagedActions / 409 / CAS / 双路径落库 / 前端守卫整条自建链。上游单存储域（`Storage.commit` + bound Values + mutation line + `outcome_ready` 事务）本可承载同一语义（§3）。
3. **上游至少有 7 项一等能力全零使用**：`after_tool` details 改写、`CustomEntry`/`EntryProjector`、invocation memos/`step.do`、bound Values 自定义 namespace、`WatchHandle.resnapshot()` 主推、`deferred` 异步生成、工具 `replay` 声明。其中前三项直接对应本项目三处自建补偿层（§3.2）。
4. **治本顺序是「可观测 → 收敛真相源 → 同步协议化 → 移动端一等公民」**（§6）。P0（指标）是其余一切的前提——当前最安静的失败路径（Zod continue、TTL 清 stage、前端悬空边过滤）恰好零日志零计数，不补观测，后面每一步都无法验收。
5. **但用户可见症状不能等路线图节奏**：本次个案的直接修复（移动端边可见性）是一行级热修（Q1，§6.0），随下一个 web 发布即走，不被 P3 拖住。
6. **明确不做**：CRDT/语义级字段合并、服务端订阅合并、把画布状态迁入 session 存储域近期排期（P4 方向性判断，SP-E 落地后紧迫性下降）。不另起炉灶——本路线图是 SP-E / ADR-0015 / #596 规格组的上游补充，不是替代（§7）。本文是**讨论稿**：P0/P1c/Q1 之外的实施项，动手前须各自立 spec/plan（§9-G7）。

---

## 1. 问题重定义：连线不可见只是 canary

### 1.1 个案取证（生产直查，2026-10-28）

```sql
-- Session.canvasData (cmvrrx4cj00punx01px28kmlz)
nodeCount = 15, edgeCount = 13, stagedActions = null
13 条边端点全部命中节点 id 集合，无悬空边
```

数据链路（`connect_nodes` → `POST /agent/internal/connect-nodes` → `persist()` 事务 → `canvasData.edges` → `loadSession` → `hydrateCanvasEdges`）逐环节核实完好。边**在 DOM 里渲染了**，不可见是三重视觉因素叠加：

| #  | 因素                                                                                                                                              | 证据                                                                                                              |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| V1 | 默认边样式极淡：`--neo-edge` dark `rgba(148,151,180,0.3)` / light alpha 0.22，1.5px                                                                      | `apps/web/src/styles/neowow-tokens.css:104,259`                                                                 |
| V2 | `MobileNodeTile` 无 vue-flow `<Handle>`（import 面零 `@vue-flow/core`），锚点退化为节点底/顶边中点；磁贴高 160px、纵列间距 220px ⇒ 边只露出 ~60px 缝隙段，且被不透明磁贴（z-index 在边层之上）夹住 | `apps/web/src/components/mobile/MobileNodeTile.vue:2-19,211-216`；vue-flow `getHandlePosition` null-handle 回退已核实 |
| V3 | 画布跨度 ~2400px，手机 fitView 后 zoom ≈ 0.25 ⇒ 屏上缝隙 ~15px、线宽 ~0.4px × 0.3 alpha = 亚像素淡线                                                                | 坐标直查 + `CanvasPage.vue:6037 :edges="flowEdges"`                                                                 |

### 1.2 为什么这是 canary 而不是孤例

同一症状家族（「agent 说做了、画布上没有」）在链路上还有 17 个已取证的兄弟失败模式（§4 F1–F18）：Zod 静默丢弃、isError 不派发、SSE 单槽位让位、lane TTL 窗口外丢帧、回合末对账只覆盖 image 物料……**边的特殊性只是「失败后症状恰好是视觉上什么都没有」，最容易最先被用户撞见。** 治理必须面向整条链路，而不是给边加一条 if。

---

## 2. 取证方法（可复现）

1. **生产 DB 直查**：`sqlite3 /var/lib/docker/volumes/lnkpi_lnkpi-data/_data/lnkpi.db`（容器内无 sqlite3/python，宿主卷直读只读查询）；
2. **上游源码实读**：`vendor/earendil-works/pi`（v0.85.1，`VENDORED.md` 钉版本）+ `node_modules/@vue-flow/core/dist`（EdgeWrapper/getHandlePosition 退化行为）；
3. **双路并行深研**：上游内核能力对照（6 题）× 本项目状态同步盘点（6 题），全部结论带 文件:行号；
4. **规格/ADR 交叉核对**：SP-E CAS 规格、ADR-0014/0015、#596 规格组、移动端 UX 重构方案，确认本文建议不与已拍板决策冲突。

---

## 3. 上游 pi 内核能力对照：未用满与绕开清单

### 3.1 消费面基本盘（先说做对了的）

- durable `AgentHarness`/`Lane` 路径、`lane.steer()/followUp()` durable 队列、`lane.compact({customInstructions})` 注入 `RetentionState`（上游为「宿主领域状态跨压缩」设计的唯一合法入口）、tiering 对齐官方 Dynamic Tool Loading（`addedToolNames` 原生合并）、runtime↔Nest 的 `lane.watch()` 快照+增量（2026-10-18 对齐）、`hook-contract.ts` 类型钉 + conformance 测试防上游漂移。**这些是「吃满上游」的正确姿势，应保持。**

### 3.2 全零使用的上游一等能力（未用满清单）

| #  | 上游能力                                                                                                             | 位置                                                      | 本项目对应缺口                                                                                                                                                                                                                                                             |
| -- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1 | **`after_tool` hook 可读可改写 `result.details`**                                                                     | `harness/agent-harness.ts:468-487`、`hooks.ts:294-335`   | runtime 已注册 `after_tool` 但只做 usage 观测、`return undefined`（`services/pi-runtime/src/session-manager.ts:1710-1717`）。`details.actions` 的归一化/校验/计数因此缺失，Nest 侧 `extractCanvasActions` 只能 safeParse 失败静默 continue（`apps/server/src/agent/pi-runtime/pi-events.ts:497-500`） |
| U2 | **`CustomEntry` + `EntryProjector`**（宿主领域状态进会话树的正式抽象，*`appendCustomEntry`* 是 Lane/Branch 一等方法）                   | `harness/session/types.ts:52-64`、`agent-harness.ts:544` | 全仓零调用。画布产物完全走 Prisma 旁路，transcript 里没有「这台画布改过什么」的权威记录                                                                                                                                                                                                               |
| U3 | **invocation memos / `step.do`**（"exactly-once recorded, at-least-once executed"，`invocationId = resultEntryId`） | `harness/types.ts:95-105`、`tool-durability.md:447-487`  | 长生成任务幂等全靠自建 `(threadId,runId)` 唯一索引 + P2002 兜底（`agent.service.ts:2884-2953`）                                                                                                                                                                                        |
| U4 | **bound Values 自定义 namespace**（类型化地址 `value<T>(namespace, key)`，上游的 artifact 层）                                  | `session/values.ts:98-196`                              | 未用。画布状态本可入 session 存储域（见 §3.3）                                                                                                                                                                                                                                      |
| U5 | **`WatchHandle.resnapshot()`** 主动重取快照                                                                            | `agent-harness.ts:181-186`                              | Nest↔前端是被动 resync，不消费 resnapshot                                                                                                                                                                                                                                    |
| U6 | **`deferred` 异步生成**（provider 异步续跑 + run 挂起，`run_suspend` 一等支持）                                                   | `harness/types.ts:146`                                  | 长视频生成用自建轮询 + followUp 通报（`session-manager.ts:168-173, 2193+`）                                                                                                                                                                                                       |
| U7 | **工具 `replay: "safe"/"never"` 声明**                                                                               | `harness/types.ts`                                      | harness 工具未显式声明，崩溃恢复的幂等语义靠约定俗成                                                                                                                                                                                                                                      |

### 3.3 与上游设计冲突的根因（唯一一处）

**画布领域状态在两个存储域之间靠「双写 + 对账 + 守卫」维持一致**：

- 上游：transcript = 单一 `Storage`，消息与副作用同一 `commit()` 原子落域（`session/types.ts:387-397`）；工具执行期禁直写 Session，结果与状态同事务生效（`tool-durability.md:507-514`）；staged write + `outcome_ready` 事务提升是**文档化的官方 staging 模式**（`tool-durability.md:489-514`）。
- 本项目：`Session.canvasData` JSON 字符串（Prisma）是上游 Session 之外的第二个真相源。由此派生：
  - `stagedActions`/`commitStage`/`rollbackStage`/`expireStaleStage`（`agent-canvas-tools.service.ts:3550-3618`）= 上游 staging 模式的手写版，但 stage 在 Prisma、不挂 `outcome_ready`；
  - 409 冲突 + CAS（PR #625）= 上游 `SessionMutation`「second attempt rejects」+ ownership fence（`session/types.ts:509-513`）的自建版；
  - 双路径落库 + 回合末 `persistCanvasEntities` 对账 + 前端 `canvasLoadGuard`（`agent.service.ts:2612-2623, 2960-2994`；`canvasLoadGuard.ts:2-39`）= 跨域一致性的补偿层。

**判定**：这不是「错误」，是 vendor+pin 策略下的有意识取舍（且 stagedActions 方向与上游文档一致）。但必须清醒：**这条补偿链的每一环都是独立故障面**（§4 F3/F4 就是它自己的失败模式）。P4（§6）给出消解方向，SP-E 落地前不动作。

### 3.4 对抗上游设计的既有裁决（尊重，不翻案）

以下四处经取证确认是有意识取舍、有注释佐证，本文**不**建议翻案，仅登记在案：  
禁用上游崩溃恢复自动 resume（`session-manager.ts:1431-1459`，Nest 10s 超时 vs 上游 612s）；取消走 context cancel 不走 `requestOperationAbort`（:2788-2791）；计时/分类用 raw 事件不用 `after_tool`（:1701-1709，vendor 事件缺字段）；vendor 错误物化盲区旁路探测（:1570, 2065）。  
⚠️ 注意 U1 与第三条不矛盾：那条裁决针对的是**计时/分类**（P3 遥测），U1 提议的 `after_tool` 用途是 **actions 归一化**（正确性面），维度不同。

---

## 4. 系统性缺陷归因

### 4.1 静默失败模式全清单（F1–F18）

| #   | 失败模式                                                             | 位置                                              | 症状                                                  |
| --- | ---------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------- |
| F1  | Zod safeParse 失败静默 continue（无日志无计数）                              | `pi-events.ts:497-500`（含 nodeType 白名单 continue） | 服务端已落库、前端不更新                                        |
| F2  | isError 结果不派发 canvas_action                                      | `pi-events.ts:492`                              | 部分成功的工具连已发生的动作都不下发                                  |
| F3  | persist 409（staged 非空拒写）无 canvas 专属归因                            | `agent-canvas-tools.service.ts:3786-3790`       | 工具失败；只有 `tool_error_kinds_total{upstream_4xx}` 兜底   |
| F4  | stage TTL 过期静默清空（无日志）                                            | 同上 `:3652-3663`                                 | 暂存动作无痕蒸发                                            |
| F5  | SSE 重连间隙丢 canvas_action（lane 内存态 30min TTL）                      | `follow-up-tail.ts:392-401`、文件头 :16-25          | 窗口外动作帧永久丢失，只剩回合末回拉                                  |
| F6  | 全局 SSE 单槽位让位（hidden ⇒ abort），移动端单页 App 切后台无接管者                   | `AgentSideRail.vue:2930-2985`（注释自认 :2926-2928）  | 移动端实时真空                                             |
| F7  | shared-subscription 只广播 3 类事件（text_delta/canvas_action/turn_end） | `shared-subscription.ts:44-47`                  | follower 页缺 node_status/canvas_command/error 等 7+ 类 |
| F8  | `pi_` 前缀透传被前端丢弃（多处注释自证）                                          | `pi-events.ts:282-283` 等                        | 新增事件类型静默白费                                          |
| F9  | hydrate 过滤悬空边（continue 无计数）                                      | `CanvasPage.vue:5249-5268`                      | 边静默消失；瞬时悬空（loadSession 先到）也丢                        |
| F10 | 保存时过滤悬空边                                                         | `useCanvasActions.ts:193-200`                   | 用户看到过的连线下次保存后消失                                     |
| F11 | 重复节点收敛保留首条                                                       | `canvasNodeMerge.ts:55-64`（生产 30/253 画布命中）      | 末条（可能带新 url）静默丢弃                                    |
| F12 | saveCanvas 失败吞异常只置布尔                                             | `CanvasPage.vue:5140-5142`                      | 静默失败                                                |
| F13 | 加载失败守卫常闭 ⇒ 用户编辑全部无法落库                                            | `CanvasPage.vue:5086-5094, 5343-5354`           | 直到刷新前是黑洞                                            |
| F14 | 回合末对账 60s 窗口错过慢生成（8min 案例注释自证）                                   | `CanvasPage.vue:1787-1806, 1734-1736`           | 产物行停「待确认」                                           |
| F15 | update_node 目标不存在静默 no-op（时间线却已记账）                               | `useCanvasActions.ts:101-108`                   | 时间线说改了、画布没改                                         |
| F16 | remove_edge 缺 id 静默 break                                        | `useCanvasActions.ts:130-136`                   | 删边失败无感知                                             |
| F17 | PiRuntimeClient 断连/掐断（D2：Nest ~118s vs pi 618s）                  | `agent.service.ts:2293-2299, 2617-2623`         | truncated 前缀内的动作缺失                                  |
| F18 | 移动端后台丢实时，回前台游标续传超 lane 窗口即丢                                      | F6 + `follow-up-tail.ts:455-466`                | 回合外 canvas_command 彻底丢                              |

### 4.2 六条根因（从症状到结构）

1. **双真相源 + 粒度不对称**：持久层 9/10 写点有事务 rebase，唯独面向用户的整份 PUT（`sessions.service.ts:116-131`）无版本校验——SP-E 规格 §4.1 已正确诊断，待评审落地。
2. **事件派发与持久化分离，且派发通道有损**：真相在 `persist()` 落库，前端画面靠 `details.actions → extractCanvasActions → SSE` **重新派生**；派生层（F1/F2/F8）× 传输层（F5/F6/F7/F18）每段独立丢包，丢包后无动作级重放（回合末回拉是唯一兜底，粒度整画布、时机回合末）。
3. **对账是显示层补丁而非状态层协议**：`persistCanvasEntities` 只管 image+parentShotId 物料（`agent.service.ts:2979-2994`）；railReconcile 只管时间线产物行；reconcileMissingGenerationRecords 只管生成字段。**边、坐标、分组、视口——恰好是覆盖最严重的字段——没有任何回合末对账。**
4. **移动端是几何与交互上的二等公民**：坐标网格 280×220 是桌面尺寸假设（`agent-canvas-tools.service.ts:73-74`），磁贴 280 宽 ⇒ 横向间距恰好 0；父链 +320/+20 垂直偏移会让两枚 160px 磁贴重叠 140px（`useCanvasActions.ts:63-64`）；无 Handle ⇒ 无锚点、无连线交互入口。移动端无独立保存/对账路径 ⇒ 桌面全部 F1-F18 等比例存在，再叠加 F6/F18 移动端特有真空。
5. **失败不可观测**：§4.1 最安静的路径恰好零日志零计数；`ops/dashboard/index.html` 无一个 canvas 同步条目。当前只能靠生产事故复盘（#594/#598/#601/#602 四连补丁模式）而非指标发现回归。
6. **守卫补丁化轨迹**：pending_confirm 字段守卫（10-13）→ 空画布禁存守卫（10-26）→ stale pending_confirm 前端守卫，每次事故加一道专项守卫——收敛点应是统一版本化（CAS），方向 SP-E 已指明。

---

## 5. 行业对标：Codex / Claude / WorkBuddy 与生态实践

| 实践                                                                    | 来源                                             | 对本项目的启示                                                                                                                                  | 对应阶段     |
| --------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **Event-sourced SSOT + 客户端投影**：会话日志是唯一真相，客户端是日志的投影/重放                 | OpenAI Codex（cloud 会话）；上游 pi transcript 本身即此模型 | 本项目 transcript↔canvasData 双域是偏离；短期先让派发通道无损（P1），远期消解双域（P4）                                                                                | P1/P2/P4 |
| **单一原子变更原语 + 回读确认**：`apply_patch` 一次原子改多个文件，工具结果回显最终状态让模型自纠错          | Codex CLI；Claude Code 的 Write/Edit 回执          | `connect_nodes` 目前连端点存在性都不校验（`agent-canvas-tools.service.ts:1260-1285`），且成功回执不含落库结果——补 fail-closed 校验 + 回执带落库边数/被拒边清单（P1c），这是本次个案最直接的对症药 | P1c      |
| **版本化 Artifact + 增量 patch**：文档式产物带版本号，更新以 patch 传输、冲突以版本裁决            | Claude Artifacts                               | canvasVersion（SP-E）+ 动作 seq（P2a）正是同构物                                                                                                    | P1a/P2a  |
| **快照 + 增量 + 主动 resnapshot**：重连语义成文（`outcome_ready` 在快照中显示为 settled 行） | 上游 pi `WatchHandle`（runtime↔Nest 已对齐）          | 把同一模式**下移到 Nest↔前端**：前端丢包不再靠 60s 回拉，而是 resnapshot + sinceSeq 增量                                                                          | P2a      |
| **Durable execution**：`step.do`「记录恰好一次、执行至少一次」                        | Temporal；上游 invocation memos                   | 长生成幂等（U3）、异步生成挂起（U6）的上游原语，替代自建轮询                                                                                                         | P4       |
| **失败路径可观测优先于功能迭代**                                                    | SRE / WorkBuddy 工程实践                           | P0 先行：没有指标，P1-P3 无法验收                                                                                                                    | P0       |
| **移动端不是降级副本**：触屏交互一等设计（长按语义、一级 ≤5 项、浮层统一基座）                           | WorkBuddy 移动端；本项目自己的 §4.11 跨端组件哲学              | 边渲染/Handle/布局网格按移动端显式设计，而非桌面假设的降级消费                                                                                                      | P3       |

**吸收原则**：不引入 CRDT/OT（Figma 式实时协同）——当前写者规模是「单用户 × 单会话 × 少数标签页」，SP-E §2 已裁决不做语义合并，正确。Codex/Claude 的启发在**协议形态**（版本化 + 原子变更 + 回读），不在协同算法。

---

## 6. 治本路线图（Q0 → P4）

> 原则：每阶段独立可验收；P0 是 P1-P3 的验收前提；P1 与既有 SP-E 合流不另起炉灶。

### Q0 · 快赢（不等路线图，随下一个 web 发布即走）

| 项 | 内容 | 依据 |
|---|---|---|
| Q1 | **移动端边可见性热修**：复用既有 `--canvas-edge-color` 覆盖路径（`CanvasPage.vue:577` 的 viewportSettings 机制），为移动端布局注入默认更强的边样式（alpha ≥ 0.6、2px）——不动 `--neo-*` 令牌本体（禁再生长），只走既有变量注入面。改后必跑 design-token/theme-usage/text-token-guard/dead-styles 四测试 | §1.1 V1；用户可见症状不应被 P3 整包节奏拖住（§9-G6）。⚠️ V3 的 zoom≈0.25 属纸面推算，真机效果以走查复核为准；Q1 只抬可见性下限，锚点退化（V2）仍留 P3a |

### P0 · 可观测先行（小改动，先做）

| 项 | 内容 | 验收 |
|---|---|---|
| O1 | `canvas_action_extract_total{outcome=ok\|zod_drop\|whitelist_drop\|is_error_skip\|empty}`（Nest `extractCanvasActions` 三处 continue 补计数）；前端 `canvas_action_apply_total{outcome=applied\|no_op\|dangling}` | 「今天派发空转率多少」一问可答 |
| O2 | persist 409 补 `canvas_cas_conflict_total{surface=staged}`（与 SP-E §8.1 指标对齐）；`expireStaleStage` 补日志 | F3/F4 有痕 |
| O3 | shared-subscription 状态（leader/peers/degraded/lastEventSeq）周期上报 | F6/F7 丢失率可测 |
| O4 | 前端悬空边过滤/重复节点收敛/update no-op 计数（F9/F10/F11/F15） | 静默 continue 全部归零「无观测」状态 |

⚠️ **P0 前置项（评审补，§9-G1）**：本项目前端没有日志/埋点通道（报告 B §6.2 自证「前端无日志系统」，`getLiveCount`/`SharedSubscriptionStatus` 只是内存查询口）。O1/O3/O4 的「前端计数 + 上报」依赖一个**不存在**的最小遥测通道——P0 第一个 task 应是「建最小前端 beacon（复用 Nest 既有日志入口或独立 `/telemetry` 端点，零 PII、按会话聚合计数）」，否则 P0 无法落地。

### P1 · 收敛真相源（与 SP-E 合流）

| 项 | 内容 | 依据 |
|---|---|---|
| P1a | **评审合入 PR #625**（CAS fail-closed + opt-in 兼容 + `canvas_legacy_write_total` 七天归零门禁），把视口/分组侧车纳入版本 | SP-E 规格已完备，只差评审与实施 |
| P1b | **actions 归一化上移到 runtime `after_tool` hook**（U1）：在 hook 内对 `details.actions` 做 Zod 校验、失败打点、归一化写回 details；Nest 侧 `extractCanvasActions` 退化为纯传输不再裁决 ⇒ F1/F2 从结构上消除 | 上游 `after_tool` 可整体替换 details（`agent-harness.ts:468-487`）；与「计时用 raw 事件」既有裁决不冲突（§3.4）。⚠️ 部署序（§9-R3）：runtime 与 Nest 是两条流水线——归一化写回**同形状** `details.actions`，旧 Nest 消费方零感知，天然向后兼容，无先后约束；仍需契约测试钉住形状 |
| P1c | **`connect_nodes` 端点 fail-closed 校验**：source/target 必须命中画布节点集（对齐 `addNodesBatch` E1 解析与 ADR-0014 `validateEdgeAdditions`）；工具回执带 `{applied, rejected:[{edge, reason}]}` 让模型自纠错。⚠️ rejected 明细限 top-N（≤10）防 transcript 膨胀（§9-R5） | 本次个案的直接预防；Codex/Claude 回读确认实践 |
| P1d | isError 部分成功改为派发 `{partial:true}` 标记的 action + 计数（F2） | 部分成功的动作不陪葬 |

### P2 · 同步协议化（快照 + 增量 + 对账升级）

| 项 | 内容 | 依据 |
|---|---|---|
| P2a | Nest↔前端复用「快照+游标」：SSE 事件带单调 seq，重连/丢包走 `GET 快照 + sinceSeq 增量`而非 60s 回拉；重放窗口从 lane 内存（30min TTL）移到 Nest 落库的 executionEvents 账本。⚠️ 实施前先核实 executionEvents 是否已记录 canvas_action（若已含则成本减半，§9-R4） | 上游 LaneSnapshot/resnapshot 模式下移（U5）；F5/F17/F18 |
| P2b | 回合末对账升级为状态层协议：服务端回合末产出 canvasData 版本指纹/规范 diff，前端按需增量合并，覆盖 edge/坐标/分组/视口（现状四类漏网）。15 节点级 JSON 的回合末 diff 成本可忽略 | §4.2-3；Claude Artifacts 版本化实践 |
| P2c | shared-subscription 白名单扩全量或改事件透传 + 前端过滤 ⇒ F7 消除 | F7 |
| P2d | 单槽位让位的移动端退化修复：单页 App（无可见同伴可接管）切后台改「降级保活或回前台立即 resnapshot」，补进 #596 规格未覆盖的退化场景 | F6/F18；#596 §2.3 边界 |

### P3 · 移动端一等公民

| 项 | 内容 | 依据 |
|---|---|---|
| P3a | `MobileNodeTile` 补 vue-flow `<Handle>`（锚点对齐桌面语义）；边渲染样式沿用 Q1 注入面；布局网格按磁贴实际尺寸计算（消灭 280×220 桌面假设导致的 0 间距/140px 重叠） | V1/V2/V3；§4.2-4；改令牌/样式须跑 design-token 四测试（AGENTS.md 硬约束） |
| P3b | 移动端连线交互入口（长按 sheet 增「连接」项，或双节点多选连接），对齐桌面 hover 手柄的触屏等价物 | 移动端 UX 重构 §1.4 P1-2 |
| P3c | 移动端 UX 重构 §8 真机走查（含连线可见性专项）纳入验收，清欠账 | 该规格自记「合并上线 ≠ 验收完成」 |

### P4 · 远期方向（缓行，不排期）

1. **画布状态入 session 存储域**（U2/U4）：CustomEntry/EntryProjector 记录产物动作 + bound Values 存领域状态，`outcome_ready` 事务提升 staged write（上游文档化模式）——消解双真相源，stagedActions/409/守卫补丁整条补偿链随之退役。SP-E 落地后紧迫性显著下降，作为方向性判断保留。⚠️ 前提复验（§9-R2）：U2/U4 的「全零使用」是 grep 级结论，立项前须按 AGENTS.md grep 纪律（`git grep`、变量加花括号、先看 fatal）逐条复验。
2. **invocation memos / `step.do`（U3）+ `deferred` 异步生成（U6）**：长生成幂等与挂起重构，替代自建轮询。
3. 显式声明 harness 工具 `replay` 策略（U7）。

### 明确不做

- CRDT/OT/语义级字段合并（SP-E §2 已裁决）；
- 服务端订阅合并、HTTPS/h2c（#596 已实测撤回）；
- 把画布内容塞 CustomEntry 进模型上下文（L6 预算余量仅 68 字符，EntryProjector 只做投影不做注入）；
- 为移动端另建第二套保存/对账路径（延续「无分叉」现状，分叉才是债）。

---

## 7. 与既有规划的关系（不另起炉灶）

| 既有资产                   | 本路线图的关系                                               |
| ---------------------- | ----------------------------------------------------- |
| SP-E CAS 规格 / PR #625  | P1a = 其评审与落地本身；O2 指标与其 §8.1 对齐                        |
| ADR-0015 多端单会话         | P2 的订阅通道改进是其「已知限制④」（fork 后订阅键指向死 lane）的解法延伸           |
| #596 会话级订阅规格组          | P2c/P2d 是其「明确不做」边界的重议提案，需走规格修订而非直接改码                  |
| 多端一致性规格（2026-10-21）    | 其 vendor `lane.watch()` 盘点是 P2a 的上游依据，本文将其下移到 Nest↔前端 |
| 移动端 UX 重构 + 节点生命周期系列   | P3 全部承接其未完成项（§6.5、§8 走查、P1-2 hover 降级），不新立规格          |
| 回合连续性（turn-continuity） | P2b 对账协议与其「第四份状态」思路同源，合并设计避免两套对账                      |

---

## 8. 全局验收判据（自上而下自审）

1. **任何一类画布不同步，5 分钟内用指标定位到环节**（P0）；
2. **agent 工具不存在「静默成功」**：每个写工具的回执可审计（applied/rejected 明细），每个失败路径有归因计数（P1b/c/d）；
3. **前端断连/丢包后，一次 resnapshot 即恢复一致**，不依赖回合末回拉的时机与粒度（P2a/b）；
4. **同一会话在 PC 与移动端呈现同一真相**：边可见、锚点正确、间距合理、实时无真空（P2d/P3）；
5. **与上游漂移的防线不退化**：hook-contract / conformance 钉继续绿；新增对上游能力的消费（U1/U5）同样有契约钉；
6. **不为治本引入新真相源**：P4 之前的所有改动仍以 `Session.canvasData` 为唯一持久真相 + canvasVersion 为唯一并发裁决。

---

## 9. 评审（2026-10-28 · 自上而下全盘自审）

> 评审人视角：agent 产品经理 × 架构师，立场是「充分性与遗漏优先于正确性复述」。
> 评审方法：对 §0-§8 逐章追问「证据够不够、有没有遗漏、可不可实施、可不可回滚」。

### 9.1 评审结论

**通过（作为方向讨论稿）**——根因判定（双真相源 + 有损派发 + 移动端二等公民）与阶段顺序（可观测先行）成立；但发现 8 处修订项（G1-G8），其中 G1/G6 为 **P0 级**（不修则 P0 无法落地 / 用户可见症状被节奏拖住），已在本文直接应用修订。

### 9.2 修订项清单

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| G1 | 🔴 P0 | **P0 有未声明的前置项**：前端不存在日志/埋点通道（§4.2-5 自证），O1/O3/O4 的「计数+上报」无承载面 | 已修订：P0 节补前置 task「最小前端 beacon」 |
| G2 | 🔴 P0 | **快赢缺失**：V1 是一行级修复，原稿把它捆进 P3 整包——用户撞见的症状以路线图节奏解决是产品失职 | 已修订：新增 §6.0 Q1 |
| G3 | 🟡 P1 | **证据置信度未分级**：生产 DB 直查（个案数据）、源码实读（F 清单、上游 API）、grep 级（U1-U7 零使用）、纸面推算（V3 zoom）四种置信度混排，读者无从判断哪些可直接指导实施 | 已修订：§9.3 分级 + 高风险项标注复验要求 |
| G4 | 🟡 P1 | **P1b 部署序未写**：runtime 与 Nest 两条流水线，规格体系对此极敏感（SP-E §11.1 教训） | 已修订：P1b 节补部署序分析（同形状写回 ⇒ 向后兼容，无先后约束，契约测试钉形状） |
| G5 | 🟡 P1 | **每阶段缺回滚路径与工作量量级**——本规格体系的 PR 惯例（Review Focus + 回滚顺序）在本文缺席 | 保留给实施 spec：§9.5 要求转化时逐项补齐 |
| G6 | 🔴 P0 | 同 G2 的机理面：V3 纸面推算未标注，若真机实测 zoom 更高则 Q1 的参数（alpha/线宽）需走查校准 | 已修订：Q1 节标注「真机走查复核为准」 |
| G7 | 🟡 P1 | **文档性质约束**：本文是 discussion，按 `docs/agent/docs.md` 不能直接指导实施——Q1/P0/P1c 之外任何一项动手前须立 spec+plan（P1a 例外，SP-E 已有） | 已修订：TL;DR 末条明示 |
| G8 | 🟢 P2 | **遗漏场景：跨账号只读访问**（`agentReadOnly`，`CanvasPage.vue:5292`）与未来协作场景不在写者矩阵内——CAS/对账设计隐含「单用户多端」假设 | 登记：P4 重估时一并评估；SP-E 实施不受影响（其写者矩阵已按现状取证） |

### 9.3 证据置信度分级

| 级别 | 覆盖内容 | 实施前要求 |
|---|---|---|
| A（生产实测） | §1.1 个案数据（15 节点/13 边/端点全效/staged 空） | 可直接引用 |
| B（源码实读） | F1-F18 定位、上游 API 语义（after_tool/WatchHandle/getHandlePosition 等）、§3.3/§3.4 | 可直接引用；行号随代码演进会漂移，实施 spec 须重新锚定 |
| C（grep 级） | U1-U7「全零使用」、F7 白名单边界 | ⚠️ 立项前按 AGENTS.md grep 纪律逐条复验（`git grep`、变量花括号、先看 fatal——本仓有 grep 假阴前科） |
| D（纸面推算） | V3 的 zoom≈0.25 与亚像素结论、Q1 参数有效性 | 真机走查复核后才可作为验收口径 |

### 9.4 追问记录（充分性自检）

- **「对账升级为状态层协议」与 turn-continuity 的「第四份状态」会不会长成两套对账？** → §7 已声明合并设计；实施 spec 时须给出单一「回合末 canvas 对账点」的归属（建议落 Nest finalizeTurn，与 persistCanvasEntities 同址演进），否则 G 级风险。
- **P2c 事件透传会不会把 SSE 带宽问题放大？** → 当前事件量级（文本 delta 占大头，canvas_action 是低频小帧）下无虞；#596 的连接预算规则不变，只动广播白名单。
- **Q1 走 viewportSettings 注入面会不会和用户显式设置的 edgeColor 打架？** → 语义定为「默认值」：用户显式设置仍覆盖移动端默认（`s.edgeColor.trim()` 分支优先级不变）。
- **P1c 回执让模型自纠错，会不会诱发重试风暴？** → rejected 明细限 top-N + 错误 reason 给出可行动短语（「节点已删除」而非「校验失败」）；与既有 `canvas_daily_ops` 规则的连线话术对齐属提示词工程线 R1 的事，实施时同步。

### 9.5 实施转化要求

1. Q1 可直接以 hotfix PR 实施（唯一例外，因不新增机制只调默认值），PR 描述引用本文 §6.0；
2. P0 立实施 plan（含 beacon 前置 task）；P1b/P1c/P1d 各立 spec（P1a 走既有 SP-E 评审）；
3. P2 先出「快照+游标」协议草案（含 executionEvents 复验结论）再评审；
4. 每个 spec/plan 按 PR 惯例补 Review Focus + 回滚顺序（G5）。
