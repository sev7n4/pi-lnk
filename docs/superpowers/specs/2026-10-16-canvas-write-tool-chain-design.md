# Canvas 写工具编排：创建→提议生成 id 结构性绑定（Phase 1 原生编排护栏为主修复 + Phase 2 chain 工具暂缓）

> 日期：2026-10-16  
> 状态：**已批准（2026-10-16，v3 自审修订后经用户指令「按 skills 流程推进写计划」批准；Phase 1 授权执行）**  
> 产品：超创平台（lnkpi）无限画布 / Agent Runtime  
> 上级：[2026-09-14-agent-atomic-as-tools-design.md](./2026-09-14-agent-atomic-as-tools-design.md)（管辖 `propose_generation` 契约 / HITL / `run_*` 禁可见 / 节点 SSOT）  
> 相关：[propose-node-binding-engineering-design.md](../../../agent/propose-node-binding-engineering-design.md)（事故取证 + 工程分析，本规格技术来源）、[2026-09-14-codex-style-tool-plan-harness-design.md](./2026-09-14-codex-style-tool-plan-harness-design.md)（工具编排 harness 参考）  
> **修订声明（v3 自审修订）：** 经对 pi-agent-core 0.85.1（npm dist）与 `vendor/earendil-works/pi` 源码逐层核实，两次修正——① 根因仍是缺编排层护栏，但护栏可**全部用 pi 上游原生原语实现（零新工具、零重试）**：`executionMode:"sequential"`（串行前置）+ `after_tool` 捕获 upsert 返回 id（runId 作用域）+ `before_tool` args 重写（harness 层 `applyBeforeToolDecision` 源码实证：支持 args 整体替换并按工具 schema 重校验后执行）⇒ **Phase 1 即正确性主修复**。② `delegate_task`/`pi-fabric`/`fabric_exec` 未在本仓库 vendored 副本中核实存在（仅上游 `subagent` 例子，其 `chain` 为跨进程 agent 委派、靠 `{previous}` 文本传递，形态不符），D6 已更正为分两级核实表述；Phase 2 chain 工具降为**暂缓**的人机工效优化（多操作单调用），与事故修复解耦。底层原子工具契约不变；不新增复合工具。

---

## 0. 决策摘要

| # | 决策 |
|---|------|
| **D1** | **根因定性**：这不是前端 bug 或单次模型失误，而是 agent 工程层把「id 从工具结果文本搬运到下一调用参数」的脆弱契约完全交给模型，且无结构性护栏——**缺第 2 层（编排包装层）**。 |
| **D2** | **Phase 1 即充分的正确性修复（吃满上游原生能力，零新工具、零重试）**：pi-agent-core 提供三个原生原语——① 每工具 `executionMode:"sequential"`（同批写调用服务端串行，保证 upsert 先执行并 finalize）；② `after_tool` 钩子（捕获 upsert 返回 nodeId，以 `HookInvocation` 原生 `runId` 为作用域暂存）；③ `before_tool` 钩子（对 set/propose 以正确 id **重写 args**，harness 按工具 schema 重校验后执行）。三者组合**原生、结构性、零重试**消除「同批 create+propose 用旧 id」类事故。无需任何新工具。 |
| **D3** | **Phase 2 = 暂缓的可选增强（多操作单调用），正确性与零重试均不依赖它**：harness 层 `before_tool` 钩子的 result 支持 **`args` 整体替换**，实现会按工具 schema **重新校验**替换参后执行（源码实证 `harness/execution/tools.js` 的 `applyBeforeToolDecision`：`decision.args → validateToolArguments → 以替换参执行`）；配合 `after_tool` 钩子捕获 upsert 返回 id（`HookInvocation` 原生携带 `runId` 供精确作用域），**Phase 1 即可零重试自动注入正确 id**。（澄清：低层 `AgentLoopConfig.beforeToolCall` 确为 block-only，但 pi-runtime 挂的是 harness 钩子层。）`run_canvas_plan` chain 工具的唯一剩余价值 = 让模型一次调用表达多操作（省轮次/token），属人机工效优化，**暂缓**，待 Phase 1 生产数据再评。 |
| **D4** | **撤回复合工具**：原拟「新增复合工具 `create_media_node`」已撤回——违背 pi 原子性哲学；组合/编排应由编排层（原生 `before_tool` 钩子 / 可选 chain 工具）承载，而非把组合塞进工具定义。 |
| **D5** | **实施门禁**：Phase 1（P1-A~F）全绿并测稳为**强制交付**；Phase 2 暂缓，是否启动待 Phase 1 生产数据评估。禁止跳过 Phase 1。 |
| **D6** | **行业佐证（分层哲学共识，已分两级核实）**：① **Codex 源码实证**（`codex-rs/core/src/tools/parallel.rs` 的 `ToolCallRuntime` 据 `tool_supports_parallel` 用 RwLock 读/写锁门控 + `orchestrator.rs` 的 `ToolOrchestrator` 中间件）——「工具原子无状态、组合/并发决策在编排层」。**已读源码确认**。② **pi 生态**：上游 `examples/extensions/subagent` 提供 `single|parallel|chain` 编排范式（chain = 跨进程 agent 委派、靠 `{previous}` 文本占位），印证「组合是上层编排工具的事」；`delegate_task`/`pi-fabric`/`fabric_exec` 据上游知识存在但**未在本仓库 vendored 副本中核实**（见 §8 开放项），故本规格不以之作为已验证依赖，仅将其列为「未来可替换 Phase 2 实现」的候选。两层结论一致：编排在编排层、绝不靠文本搬运——本方案非特例。 |

### 0.1 与工程分析文档的关系

`docs/agent/propose-node-binding-engineering-design.md` 已完成事故取证（生产快照 `cmv95a7sd000fqh01k1za6w1g`）与三层编排模型论证，是本规格的技术来源。**本规格不做重复论证**，仅将其结论固化为可批准、可计划、可验收的规格，并锁定验收硬表与实施门禁。

---

## 1. 背景与问题（事故 `cmv95a7sd000fqh01k1za6w1g`）

现象：用户在画布手动新建「老奶奶」图片节点并生成图片后，【提议生成】卡片的【定位】按钮指向**旧「未来机器人」节点**，导致流程卡死——点新建老奶奶节点无法解卡，点机器人节点才解。

取证结论（生产库 + 执行事件）：

- `08:26:14` 模型**同批并行**发射 `upsert_media_node` + `set_node_generation_params` + `propose_generation`；后两者在 `upsert` 返回真实 id 之前就已发出，且其 `node_id` 用了上下文里的**旧机器人节点 id**（`image-1792068062784-4`，来自 `get_canvas_summary`）。
- Nest `proposeGeneration` 仅校验「节点存在 + 有 prompt」，不校验「是否本轮创建 / 是否已生成过」——旧机器人节点确实存在且有 prompt，故**放行**到错误节点。
- 次生：`set_node_generation_params` 400 `unknown guideSceneId`（模型把 skill 名 `drama-character-design` 当 scene id）；机器人节点 SSOT 卡死 `pending_confirm`；`save_memory` 把错误「画布基准节点」写入记忆污染。

**根因三链路串起事故全貌**：

| 缺陷 | 说明 | 取证来源 |
|---|---|---|
| **D1** 缺省并行 + 无依赖栅栏 | 模型同批发射三写工具，后两者在 create 返回前就发出 | executionEvents `1792110374852/856` 三调用同 ts |
| **D2** node id 仅靠 `tool_result` 文本传递 | 模型自己从结果文本读 id 再填回；无结构化带外绑定，猜错无惩罚 | `result-with-actions.ts` 仅返回 `data.nodeId` 文本 |
| **D3** 服务端无轮次归属校验 | `proposeGeneration` 仅校验节点存在+有 prompt，不校验本轮归属/已生成 | `agent-canvas-tools.service.ts:1097-1190` |

**结论**：D1+D2+D3 的本质是**缺编排层护栏**——我们把「create→set→propose 的 id 流转」这种组合直接甩给模型用文本搬运，于是必然出错。正确修复是**在编排层补护栏，且护栏全部用 pi 上游原生原语搭建**：`executionMode:"sequential"`（串行前置）+ `after_tool` 捕获 upsert 返回 id（runId 作用域）+ `before_tool` 以正确 id 重写 args（schema 重校验，零重试）——而非新增原子工具、也非只靠响应式护栏；chain 工具（Phase 2）与事故修复解耦、暂缓。

---

## 2. 目标、非目标、硬不变量

### 2.1 目标

1. **结构性消除「id 猜错 / 用旧 id」类问题**：create 返回的 node id 由编排层钩子（原生 `after_tool` 捕获 + `before_tool` 重写）**零重试自动注入**后续步骤，模型永不直接跨步填错 id——错绑即使发生也会被原生重写纠正。
2. **Phase 1 主修复（原生、零新工具、零重试）**：写工具串行化 + after_tool 捕获 + before_tool 注入，全部用 pi 上游现成能力结构性修复事故。
3. **Phase 2 暂缓（可选）**：`run_canvas_plan` chain 工具让模型一次调用表达多操作（省模型轮次/token）；正确性与零重试均已由 Phase 1 原生能力达成，是否值得引入待 Phase 1 生产数据评估。
4. **保持 pi 哲学与上游兼容**：不新增复合工具、不重造 `subagent`/`pi-fabric`；未来上游若落地**会话内** composition 原语（区别于跨进程 `subagent` chain），可直接替换本 domain 实现。

### 2.2 非目标（本规格不强制）

- 改动底层原子工具 `upsert_media_node` / `set_node_generation_params` / `propose_generation` 的**模型面契约**（名称/参数/返回/可独立调用性）。
- 引入上游 `pi-fabric` / `delegate_task`（二者未在本仓库 vendored 副本中核实存在，见 §8；若上游确有**会话内** composition 原语，另开 plan 引入并替换 Phase 2 自研实现）。
- Phase 3 防御纵深（propose 解绑强制状态对账 / 生成生命周期权威覆盖 / 记忆污染防护）——见 §4.3，本规格不强制，另开 plan。
- 修改 `guideSceneId` 注册表本身（仅做错误文案引导 + skill 修正，见 P1-E / P2-E）。

### 2.3 硬不变量

| ID | 规则 |
|----|------|
| **H1** | 底层原子工具保持**最小、可独立调用**；其对外契约不变。wrapper 在**编排层**复用其执行逻辑（必要时将核心逻辑抽为共享函数，原子工具行为不变），不把组合塞进工具定义。 |
| **H2** | create→set→propose 的 **id 流转必须结构性绑定**，绝不依赖模型文本搬运的正确性：Phase 1 以原生「`after_tool` 捕获 upsert 返回 id（runId 作用域）+ `before_tool` 重写 args（schema 重校验）」实现零重试绑定。 |
| **H3** | 组合/依赖编排在**编排层**（Phase 1 = 原生 `before_tool` 钩子；Phase 2 = chain 工具 wrapper），不在工具定义；不新增复合原子工具。 |
| **H4** | 计费 `run_*` 执行仍只在用户确认后走 Nest 确定性路径（继承上级规格 H1/H2）；chain 工具的 `propose_generation` 步骤**不**调用 `run_*`、仍触发确认卡。 |
| **H5** | 同批依赖 id 注入是 Phase 1 的**主修复路径**（非 backstop）：同批窗口内含 `upsert_media_node` ⇒ 同批 set/propose 的 node_id 以其返回 id 重写（schema 重校验；fail-closed 兜底），规则为确定性判定，不能单靠「节点存在」；窗口外（后续消息）的旧节点引用放行（合法用户点名）。 |
| **H6** | **Phase 1（P1-A~F 全绿）并测稳为强制交付**；Phase 2 暂缓，若未来启动须以 Phase 1 生产数据评估为前提，且始终不得跳过 Phase 1。 |
| **H7** | **原生优先、不重复造轮子**：Phase 1 仅用 pi-agent-core 原生原语（`executionMode:"sequential"` + `after_tool` 捕获 + `before_tool` args 重写），**零新工具、零重试**；Phase 2 的 `run_canvas_plan` **暂缓**——多操作单调用的人机工效优化，非 id 绑定所必需，且**非**跨进程 `subagent`/未核实的 `delegate_task`/`pi-fabric` 重造；未来上游若落地会话内 composition 原语，本实现应可替换为官方委托调用。 |

---

## 3. 目标架构

```
Model（意图：建节点→填参→提议生成）
   │  声明有序操作列表，不填跨步 node id
   ▼
run_canvas_plan({ ops: [                     ◀── Phase 2 暂缓（多操作单调用工效优化；id 绑定已由 Phase 1 原生钩子零重试达成）
   {op:"upsert_media_node", args:{...}},
   {op:"set_node_generation_params", args:{...}},
   {op:"propose_generation", args:{...}},
]})
   │  wrapper 服务端按序执行，自动注入上一步返回的 nodeId
   ├─① upsert_media_node  ──► 返回 nodeId ──┐
   ├─② set_node_generation_params(args + nodeId)  ◀── 注入  ┘
   └─③ propose_generation(args + nodeId)  ──► 节点 pending_confirm + 确认卡（不调 run_*）
        │
        ▼（用户确认）── 同一 Nest 执行路径（≡ 节点 dock 生成）

───────────────────────────────────────────
Phase 1 主修复（原生三原语，与 Phase 2 并存、先落地，正确性与零重试均由其达成）：
   • 串行化落在 run 级：session-manager 接线 `AgentHarness.create` options `toolExecution:"sequential"`
       （harness 运行时栈不消费 per-tool executionMode——源码实证 harness/runtime/harness.js:46 默认 "parallel"、
       per-tool 字段仅低层 agent-loop 消费；run 级声明见 agent-harness.d.ts:632。三工具 per-tool 声明保留 =
       P1-A 验收 + 意图文档化，上游 harness 消费后自然生效）
       （串行是捕获/注入的前置：只有 upsert 先执行并 finalize（after_tool 已跑），后续 set/propose 的 before_tool 才能读到记录 id）
   • after_tool 钩子捕获：upsert_media_node 成功 → 从 result content/details 解析 nodeId，
       以 runId 为键开「同批窗口」暂存（窗口在下次 before_request 关闭 = 对齐单条 assistant 消息批次；
       无需 Map<sessionId>；⚠️ 不能只按 runId 作用域——run 可跨多条消息）
   • before_tool 钩子注入：set/propose 的 node_id ≠ 记录 id 时，**直接以正确 id 重写 args**（零重试）
       （源码实证 applyBeforeToolDecision：decision.args → validateToolArguments 按工具 schema 重校验 → 以替换参执行）
       兜底：args 无 node_id 可解析 / 重写后校验失败 → fail-closed 返回 actionable error，指名正确 id
       边界：同批含 >1 个 upsert（多节点创建）无法消歧 → 退化为 fail-closed block + actionable error（列出各 id）
   （无同批 upsert 时，set/propose 允许指向任意已存在节点，沿用现有 Nest 存在性校验——合法「用户点名旧节点」场景）
```

### 3.1 关键文件与落点（file:func）

| 组件 | 文件 | 说明 |
|---|---|---|
| 原子工具（契约不变） | `services/pi-runtime/src/tools/canvas-write.ts`（`upsert_media_node` ~144-173、`set_node_generation_params` ~277、`propose_generation` ~386-613） | Phase 2 wrapper 复用其执行逻辑 |
| 串行化参考 | `services/pi-runtime/src/tools/todo.ts:97` | `executionMode:"sequential"` 现成范例 |
| **chain 编排工具（Phase 2 暂缓）** | `services/pi-runtime/src/tools/canvas-plan.ts`（如未来引入：`run_canvas_plan` / `delegate_canvas_ops`） | 多操作单调用的人机工效优化（省模型轮次/token）；非 id 绑定所必需；Phase 1 生产数据后再评 |
| **id 捕获 + 注入（Phase 1 主修复，原生）** | `services/pi-runtime/src/index.ts:188`（`harness.hooks.on("before_tool", …)` 挂载点范式，新增独立 `after_tool` + `before_tool` + `before_request` 钩子注册，复用 `plan-gate-wiring.ts:37` 同款闭包模式）；捕获态以 `event.runId` 为键开「同批窗口」（下次 `before_request` 关闭，对齐单条 assistant 消息批次），**无需 `Map<sessionId>` 注册表** | `after_tool` 解析 upsert 返回 id；`before_tool` 对 set/propose 重写 `args.node_id`（harness 按 schema 重校验后执行，源码 `applyBeforeToolDecision`）；`before_request` 关窗；零新机制、纯原生 |
| 服务端校验（D3 治理） | `apps/server/src/agent/agent-canvas-tools.service.ts` `proposeGeneration` / `setNodeGenerationParams` | 本规格内仅做 `unknown guideSceneId` 文案引导（P1-E）；Nest 层轮次归属/已生成校验属 Phase 3 另开 plan（id 绑定已由 pi-runtime `before_tool` 层强制，见 P1b） |
| 前端定位（D2 表象） | `apps/web/src/components/agent/AgentSideRail.vue:849-852,896-907`（`locateProposeNode` / `confirmProposeWait`）、`apps/web/src/components/agent/proposeWaitActions.ts`（`resolveProposeConfirmCallId`） | 绑定须为 `proposeWait.nodeId`，主修复后该 id 恒为 create 返回 id |
| skill / 提示词 | `skills/drama-character-design/SKILL.md` 及 prompt-registry 规则 | Phase 1 仅修 `guideSceneId` 误用（P1c）；「优先走 chain 工具」的提示词改造随 Phase 2 暂缓（若启动按 AGENTS.md「同步 6 处」纪律，跑 `pnpm prompt:lint`） |

---

## 4. Phase 实施节奏（强制顺序）

### 4.1 Phase 1 — 主修复（**本规格批准后可执行**）

- **P1a 写工具串行化（run 级接线）**：session-manager 在 `AgentHarness.create` options 传 **run 级** `toolExecution:"sequential"`（三工具定义的 per-tool `executionMode:"sequential"` 保留——P1-A 验收 + 意图文档化）。**为何 run 级**：harness 运行时栈不消费 per-tool executionMode（源码实证 pi-agent-core `harness/runtime/harness.js:46` 默认 `"parallel"`、`harness/agent-harness.d.ts:632` 才是 run 级消费点；per-tool 字段仅低层 agent-loop 读取，harness 栈下为死配置）→ 串行必须由 session-manager 接线在 create options 落地。任何含写工具的 run 内批次整体串行 → create 返回真实 id 后 set/propose 才跑。**（串行是 P1b 校验的前置：只有 create 先执行并落 id，before_tool 校验 set/propose 时才能拿到正确 id；并行下三钩子并发触发、id 尚未产生，校验无从谈起。）**
- **P1b 同批依赖 id 自动注入（原生 `after_tool` 捕获 + `before_tool` 重写，Phase 1 正确性锚点，零重试）**：
  - **捕获**：`after_tool` 钩子（挂载点范式同 `index.ts:188`，新增独立注册，复用 `plan-gate-wiring.ts:37` 闭包模式）在 `upsert_media_node` 成功后从 `event.content`/`event.details` 解析返回 `nodeId`，以 **`event.runId` 为键开「同批窗口」暂存，窗口在下一次 `before_request` 关闭**——精确对齐「同一条 assistant 消息的批次」（`HookInvocation` 原生携带 `runId`/`lane`，无需 `Map<sessionId>`；⚠️ 不能只按 runId 作用域：一个 run 可跨多条消息，后一条消息合法提名旧节点会被误重写）。
  - **重写（主路径）**：`before_tool` 钩子对 `set_node_generation_params` / `propose_generation`：若同批窗口内已有 upsert 记录且 `args.node_id` ≠ 该 id → 返回 `{ args: { ...event.args, node_id: <记录 id> } }`；harness 按工具 schema **重校验**替换参后以正确 id 执行（源码 `applyBeforeToolDecision` 实证）。模型侧无感知、零重试轮。
  - **兜底（fail-closed）**：`args.node_id` 缺失/不可解析、或重写后 schema 校验失败 → 返回 actionable error，指名正确 id。**边界：同批窗口内含 >1 个 `upsert_media_node`（多节点创建）无法消歧 → 一律 fail-closed block + actionable error（列出各候选 id），不做猜测性重写。**
  - **放行**：同批窗口关闭（无 pending upsert）→ set/propose 指向任意已存在节点放行（合法「用户点名旧节点」场景，沿用 Nest 存在性校验）。
  - 该规则为**结构性、确定性**，不依赖「节点存在」单条件（旧机器人节点存在+有 prompt 仍会被纠正，因非本 run upsert 返回 id）。**依赖 P1a 串行**：只有 upsert 先执行并 finalize（after_tool 已跑），后续 set/propose 的 before_tool 才能读到记录 id。
- **P1c `guideSceneId` 文案引导 + skill 修正**：Nest `unknown guideSceneId` 补「调用 `list_generation_scenes` 取合法 id；角色设计类若无匹配场景，省略 `guide_scene_id`」；同步修正 `skills/drama-character-design/SKILL.md`。

**回滚**：P1a 可经工具定义回退为并行（仅紧急）；P1b 误杀用 actionable error + 模型自纠（≤3 轮）+ 灰度。

### 4.2 Phase 2 — 暂缓（多操作单调用 chain 工具，**Phase 1 上线并取得生产数据后另评**）

- **定位**：让模型一次调用表达「建节点→填参→提议」多操作，省模型轮次/token。**正确性与零重试均已由 Phase 1 原生钩子达成，本 Phase 与事故修复解耦**，是否值得引入以 Phase 1 生产数据为准（如同批写调用频率、fail-closed 兜底是否真实出现）。
- 若引入：新增 `run_canvas_plan`（或 `delegate_canvas_ops`）：入参为**有序操作列表** `ops`；wrapper 服务端按序执行每步，把上一步返回的 `nodeId` **自动注入**下一步参数（模型提供的跨步 `node_id` 一律被权威返回值覆盖）；返回聚合结果。
- 底层 `upsert_media_node` / `set_node_generation_params` / `propose_generation` **契约不变**，其执行逻辑由 wrapper 复用（必要时抽共享函数，原子工具行为不变）。
- `propose_generation` 步骤仍触发确认卡（不调 `run_*`），HITL 不变。
- skill / 提示词规则改造：优先走 chain 工具声明有序操作列表，而非分步裸调原子工具。

### 4.3 后续（Phase 3 防御纵深，**本规格不强制，另开 plan**）

- P3a propose 解绑强制状态对账；P3b 生成生命周期权威覆盖；P3c 记忆污染防护（详见工程分析文档 §3 Phase 3）。Phase 1 已零重试纠正「同批错绑」，P3 为纵深加固。

---

## 5. 验收金标

### 5.1 Phase 1 硬表（合入门禁）

| ID | 检查 | 唯一期望 |
|----|------|----------|
| **P1-A** | 三写工具定义含 `executionMode:"sequential"` | 与 `todo.ts:97` 同款声明；pi-runtime 单测/配置断言 |
| **P1-B** | 同批含写工具的调用 | create 返回真实 id 后 set/propose 才执行（run 级 `toolExecution:"sequential"` 串行——harness 栈不消费 per-tool `executionMode`，见 P1a 与风险表） |
| **P1-C** | 同批依赖注入：同批窗口内含 `upsert_media_node` 时，`set`/`propose` 的 `node_id` ≠ 该 upsert 返回 id | 以正确 id **重写 args** 后执行（零重试）；harness 按 schema 重校验（`applyBeforeToolDecision`）；无重试轮 |
| **P1-D** | 兜底与放行规则 | args 无 node_id/重写校验失败/同批多 upsert → fail-closed actionable error；同批窗口关闭时指向已存在旧节点放行（合法用户点名，**后续消息不误重写**） |
| **P1-E** | `unknown guideSceneId` 错误文案 | 含「调用 `list_generation_scenes` 取合法 id；无匹配则省略 `guide_scene_id`」 |
| **P1-F** | 生产复测（合入后） | 同会话 propose 卡 `blockingWait.nodeId` 与 `upsert_media_node` 返回 id **恒等**；无错绑卡死 |

### 5.2 Phase 2 硬表（合入门禁）

| ID | 检查 | 唯一期望 |
|----|------|----------|
| **P2-A** | 新增 `run_canvas_plan` 工具 | 入参为有序 `ops` 列表；注册进 tool surface |
| **P2-B** | wrapper 自动注入 node id | 模型不提供跨步 `node_id` 时，wrapper 用上一步返回 id 注入后续步骤；重放事故序列无错绑 |
| **P2-C** | 原子工具契约不变 | `upsert_media_node`/`set_node_generation_params`/`propose_generation` 模型面契约未改；被 wrapper 复用 |
| **P2-D** | 事故重放 | 同批 create+propose 错 id 序列经 chain 工具后，propose 目标 = create 返回 id（100%） |
| **P2-E** | skill/提示词改造 | `drama-character-design` 优先走 chain 工具；提示词规则按 AGENTS.md 同步 6 处，`pnpm prompt:lint` 通过 |
| **P2-F** | HITL 不变 | chain 工具内 `propose_generation` 步骤触发确认卡、不调 `run_*`；确认后走同一 Nest 路径 |

**Done when（= P1-A~F 全绿即达成本规格强制目标；P2-A~F 仅当 Phase 2 获授权排期时适用）**

---

## 6. 风险与缓解

| 风险 | 缓解 |
|------|------|
| P1a 串行化降低写工具吞吐 | 写工具本就不该并行；正确性 ≫ 吞吐。**如实代价：串行落在 run 级 ⇒ 本 run 全部批次（含读工具）串行**；极端序 [propose 阻塞确认, read] 的读会等确认/超时——代价已接受（正确性 ≫ 吞吐） |
| P1b 重写掩盖模型真实意图（如同批多节点 create 被强制绑到单一 id） | 同批 >1 upsert 时**不做猜测性重写**，退化为 fail-closed block + actionable error（列出各候选 id）+ 模型自纠（≤3 轮）+ 灰度；rewrite/block 均落 `console.warn`（`[pi-runtime] canvas-id-binding …`，含 runId/toolName/from→to/reason）供灰度回滚判定 |
| Phase 2 wrapper 复用原子逻辑导致行为漂移 | H1 锁死原子工具契约；wrapper 单测断言每步返回与直调原子工具一致 |
| chain 工具内 `propose_generation` 阻塞导致 wrapper 长驻 | wrapper 在 propose 步骤返回 pending 结果即结束，确认由既有人机交互流程承接（H4） |
| `guideSceneId` 仍可能传错 | P1-E 文案引导 + P2-E skill 修正；属独立小问题，不阻塞主修复 |

---

## 7. 文档与 ADR 后续

- 本规格批准后，工程分析文档 `docs/agent/propose-node-binding-engineering-design.md` 顶部加 banner 指向本规格为「执行依据」。
- 若引入上游 `pi-fabric` / `delegate_task(chain)`，本 chain 工具可迁移为官方委托调用（H7），届时另开 plan。
- 改提示词规则须按 AGENTS.md「改提示词规则 ⇒ 同步 6 处」纪律，跑 `pnpm prompt:lint`（P2-E）。

---

## 8. 开放项

| 项 | 何时钉 |
|----|--------|
| chain 工具最终命名（`run_canvas_plan` vs `delegate_canvas_ops`） | **Phase 2 plan 前**（writing-plans 阶段钉死） |
| wrapper 复用原子逻辑的具体抽函数方式（共享函数 vs 直接调用内部 service） | Phase 2 plan |
| Phase 3 是否随本规格一并排期 | 另开 plan（本规格不强制） |
| `delegate_task`/`pi-fabric`/`fabric_exec` 是否在本仓库 vendored 副本（或 npm `@earendil-works/*`）中存在可引入 | **已核实（2026-10-16）**：`vendor/earendil-works/pi` 全树 + npm 侧（仅 `pi-agent-core`/`chord`/`pi-ai`/`pi-telemetry`）三字符串零命中；唯一 chain 范式 = `subagent` 例子（跨进程 agent 委派、`{previous}` 文本传递，对会话内 id 绑定形态不符）。⇒ Phase 2 自研实现仍成立；若上游未来落地**会话内** composition 原语，替换评估再开 |

---

## 9. 批准记录

| 项 | 内容 |
|----|------|
| 批准日 | 2026-10-16（v3 自审修订后经用户指令批准；执行令见下） |
| 根因定性 | 缺编排层护栏（§1 根因三链路 D1-D3） |
| 主修复（正确性） | Phase 1 原生三原语：`executionMode:"sequential"` + `after_tool` 捕获 + `before_tool` args 重写（D2），零新工具、零重试、充分必要 |
| 暂缓项 | Phase 2 `run_canvas_plan` chain 工具（D3）：多操作单调用工效优化；正确性与零重试已由 Phase 1 原生达成，待 Phase 1 生产数据另评 |
| 执行令 | **Phase 1 必须实施**（P1-A~F）；Phase 2 暂缓，待 Phase 1 生产数据评估 |
| 上级规格 | 2026-09-14-agent-atomic-as-tools-design.md（HITL / run_* 禁可见 / 节点 SSOT 继承） |
| 行业佐证 | Codex `parallel.rs`/`ToolOrchestrator`（源码实证）+ pi 上游 `subagent` chain 范式（跨进程，形态参考）（D6） |
