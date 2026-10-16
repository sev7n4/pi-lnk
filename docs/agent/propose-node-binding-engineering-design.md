# 画布「创建节点 → 提议生成」id 绑定错误的工程根因与系统化解决方案

> 关联事故：`cmv95a7sd000fqh01k1za6w1g`（2026-10-16）。现象：提议生成卡的「定位」指向旧「未来机器人」节点，点新建老奶奶节点无法解卡、点机器人节点才解。
> 角色定位：本文是**架构审视 + 工程方案**，不是单点补丁。目标是把"agent 工程层缺位"这一根因系统性补齐。

## 0. 结论先行（TL;DR）

这不是前端 bug，也不是单次模型失误，而是 **agent 工程层把"id 从工具结果文本搬运到下一调用参数"这种脆弱契约完全交给模型，且无任何结构性护栏**。

最佳方案 = 三层编排模型（对齐 pi 生态：**执行策略由 `toolExecution` 配置 + 工具编排包装层 + 上层组合/委托工具，共同决定组合**）：

1. **编排包装层（Layer 2，主修复·constructive）**——引入一个 delegate/chain 式的 canvas 编排工具（对标上游 `delegate_task(chain:[...])` / `fabric_exec`）：模型只声明"按顺序 create→set→propose"，**id 流转由 wrapper 服务端绑定**，绝不经模型之手。这直接消除"id 猜错 / 用旧 id"这一类问题（对应"上层组合工具"层，而非新造原子工具）。
2. **执行策略（Layer 1，加固）**——写工具组 `executionMode:"sequential"`（上游现成）；注意它只保证服务端执行顺序，不能阻止同消息参数定稿，故为确定性加固非根因修复。
3. **拦截护栏 + 兜底（Layer 3 / backstop）**——`before_tool` provenance 校验作为"模型仍直接调原子工具"时的 backstop（fail-closed 指名正确 id）；失败可自纠 + propose 解绑强制清 `pending_confirm`。

> ⚠️ **两次修正（2026-10-16 讨论后）**：
> - 原"新增复合工具 `create_media_node`"已**撤回**——违背 pi 原子性哲学、重造上游不提供的东西。
> - 经用户指出并核实：上游生态确有 `delegate_task`（**single / parallel / chain** 三模式）与 `pi-fabric` / `fabric_exec` 这类**编排包装层 + 上层组合工具**（`chain` 模式见于 `packages/coding-agent/examples/extensions/subagent/index.ts:164`；`delegate_task` / `pi-fabric` 未在我们的 vendored 副本中出现，属**尚未引入的上游生态包**）。pi 的设计哲学正是"**工具保持最小、无状态、可独立调用；组合由编排层决定**"。故正确做法不是把组合塞进工具定义，也不是只靠响应式护栏，而是**补上我们缺失的编排包装层**（一个 domain 内的 chain 工具）。详见 §1.5 与 §3 Phase 2。

## 1. 上游 pi-agent 能力盘点（吃满，不重造）

经核对 vendored `@earendil-works/pi-agent-core` 0.85.1（`docs/agent/architecture.md`）：

- **默认并行工具执行**；`ToolExecutionMode = "parallel" | "sequential"`，**且单工具 `executionMode:"sequential"` 会强制整批串行**（harness `drive/tools.ts` 批次选择逻辑）。我们代码 `todo_write` 已在用（`services/pi-runtime/src/tools/todo.ts:97`）。✅ 可直接复用。**但注意**：它只决定同一 batch 内**服务端执行顺序**，**不能**阻止模型在**同一条 assistant 消息**里就把猜的 id 填进 propose 参数（同消息多个 tool_use 的参数在看到任何结果前已定稿）——故它是确定性加固，非根因修复。
- **无内置 `waiting_user` 原语**：HITL 挂点是 `before_tool`（可 block/改参，运行在 schema 校验之后）与 `transform_context`。我们自建的阻塞等待是正确的，无需改。
- **关键约束**：批内工具调用**看不到彼此结果**，数据依赖必然跨 turn。即"同轮第二个调用想引用第一个调用返回的 node id"在内核层**不支持**——必须由应用层结构化解决。
- **Schema 校验**：`prepareToolCall → validateToolArguments`（TypeBox）会在调用前拒绝未知 enum，但**只校验 shape，不跨调用校验业务依赖**。
- **动态工具加载**：`addedToolNames` 是"一个工具解锁另一个工具"的内建原语（ADR-0005）。

> 结论：串行化与"执行层权威"都是 pi 上游的正道，不是 hack。我们要做的只是善用这些能力 + 在应用层加薄薄一层语义校验。

### 1.5 pi 生态编排层启发（delegate_task / pi-fabric / chain 模式）

用户指出并补充的 pi 生态事实，经核实部分可确认、部分属未引入的上游包：

- **`single | parallel | chain` 三模式真实存在**：位于 `vendor/.../packages/coding-agent/examples/extensions/subagent/index.ts:164`（`mode: "single" | "parallel" | "chain"`；`chain` 即按序执行、数据在步骤间流转）。这是 pi 把"组合/编排"作为**委托层显式模式**的设计证据。
- **`delegate_task` / `pi-fabric` / `fabric_exec` 不在我们 vendored 副本与已 pin 的 `pi-agent-core`/`pi-ai` 中**：全仓（含 `services/pi-runtime/node_modules/@earendil-works`）零命中。它们属于更上层的生态包，我们尚未引入——但其在上游的存在本身就是"组合由编排层/上层工具承载"这一哲学的工程兑现。
- **pi 的组合分层（用户总结，与代码一致）**：
  1. **执行策略层**：由 `toolExecution` 配置（parallel/sequential）；
  2. **工具编排包装层**：中间层负责把多个原子工具按依赖串起来；
  3. **上层组合/委托工具**：如 `fabric_exec`、`delegate_task`，对外暴露"组合动作"。
  三层共同决定"怎么组合"，**底层原子工具始终保持最小、无状态、可独立调用**。

> 对我们方案的启发（结构性）：本次事故的**根因不是缺护栏，而是缺第 2 层**——我们没有编排包装层，把"create→set→propose 的 id 流转"这种组合直接甩给模型去用文本搬运，于是必然出错。正确修复是**补上编排包装层**（一个 domain 内的 chain 工具），让 id 绑定由 wrapper 服务端完成，而非新增原子工具、也非只靠响应式拦截。我们的基础原子工具 `upsert_media_node` / `set_node_generation_params` / `propose_generation` 保持原子、不动。

## 2. 自身架构缺陷诊断（对照取证）

| 缺陷 | 说明 | 取证来源 |
|---|---|---|
| **D1** 缺省并行 + 无依赖栅栏 | 模型同批发射 `upsert_media_node`+`set_node_generation_params`+`propose_generation`，后两者在 create 返回前就发出 | executionEvents：`1792110374852/856` 三调用同 ts |
| **D2** node id 仅靠 `tool_result` 文本传递 | 模型要自己从结果文本里读出 id 再填回；无结构化带外绑定，猜错无惩罚 | `result-with-actions.ts` 仅返回 `data.nodeId` 文本；`get_canvas_summary` 会漏报 |
| **D3** 服务端无轮次归属校验 | `proposeGeneration` 仅校验"节点存在 + 有 prompt"，不校验"是否本轮创建 / 是否已生成过" | `agent-canvas-tools.service.ts:1097-1190` |
| **D4** `guideSceneId` 与 skill 名混淆 | 模型把 skill 名 `drama-character-design` 当 scene id 传入 → 400 | `setNodeGenerationParams` unknown guideSceneId |
| **D5** propose 解绑未强制状态对账 | 等待挂错节点后，机器人节点 SSOT 卡死 `pending_confirm`（虽有 P0-B 守卫，仍残留） | 事故现场 `Session.canvasData`：机器人节点 `status:"pending_confirm"` 且带已完成生成 |
| **D6** 记忆污染 | `save_memory` 把错误"画布基准节点：image-1792068062784-4"写入 canvas 记忆 | executionEvents `save_memory` 参数 |

**D1+D2+D3 串起来就是事故全貌**：并行 → 用上下文旧 id → 服务端放行 → 错误节点挂起等待 → 前端 `locateProposeNode` 与 `confirmProposeWait` 全部绑在错误 id 上。

## 3. 系统化方案（分阶段，全是执行层权威）

### Phase 1 — 立即止血（低成本，零重建）

**P1a · 写工具强制串行（最高性价比）**
给 `upsert_media_node` / `set_node_generation_params` / `propose_generation` 三个工具定义加 `executionMode: "sequential"`（仿 `todo.ts:97`）。
效果：任何含这些写工具的批次整体串行 → create 返回真实 id 后 set/propose 才跑 → **D1 物理消除**。
风险：含写工具的批次不再并行。写工具本就不该并行，正确性收益 ≫ 吞吐损失（对齐 Codex 默认串行 posture）。

**P1b · 轮次级实体溯源护栏（provenance guardrail）**
在 pi-runtime 应用层维护 `Map<sessionId, { turnCreated: string[] }>`（create 成功回写 id；新 user 消息/turn 开始重置）。`propose_generation` / `set_node_generation_params` 执行时校验：
- 引用的 `node_id` ∈ 本轮创建集，**或** ∈ 用户在当前 user 消息中明确点名的节点，
- 否则 **fail-closed 返回 actionable error**，指名"你本轮创建了 `image-xxx`，请对该 id 操作（或先 `upsert_media_node` 取回 id）"。
这直接抓住"引用了别的已存在节点（机器人）"这一类错配（对齐 Amex Tool Sequence Guardrails + OpenAI `task_handle` 注册表）。注意：纯"节点存在"校验拦不住（机器人节点确实存在），必须"本轮归属 / 用户点名"双条件。

**P1c · `guideSceneId` 错误文案引导 + skill 修正**
Nest 端 `unknown guideSceneId` 错误补一句："调用 `list_generation_scenes` 取合法 id；角色设计类若无匹配场景，请省略 `guide_scene_id` 直接设 aspect/resolution/model"。同步修正 `skills/drama-character-design/SKILL.md` 对相关工具的说明（D4）。

### Phase 2 — 修正：撤回复合工具；根因修复 = 补上"编排包装层"（chain 工具）

经核实并据用户补充的 pi 生态事实（见 §1.5）：

- **原拟"新增复合工具 `create_media_node`"已撤回**——它把"组合"问题错误地下沉到"定义"层，违背 pi 原子性哲学，也重造了上游 `delegate_task`/`pi-fabric` 已承担的"上层组合工具"角色；合并工具还丢失步骤级可观测性。
- **真正缺的是第 2 层（工具编排包装层），不是护栏**：pi 的组合由"执行策略 + 编排包装层 + 上层组合/委托工具"共同决定（`delegate_task` 的 `chain` 模式即其工程兑现）。我们只有零散原子工具，**没有把"create→set→propose 的 id 流转"串起来的包装层**，于是把组合甩给模型用文本搬运 → 事故。
- **主修复 = 引入一个 domain 内的 chain 编排工具**（对标 `delegate_task(chain:[...])` / `fabric_exec`，但**不重造整个 pi-fabric**）：模型只声明有序的 canvas 操作列表（如 `[{op:"upsert_media_node",...},{op:"set_node_generation_params",...},{op:"propose_generation"}]`），**wrapper 服务端按序执行，并把上一步返回的 node id 自动注入下一步参数**——id 流转完全在 wrapper 闭包内完成，模型永不直接填 id。这直接消除 D1/D2 这类"id 猜错 / 用旧 id"问题（对应"上层组合工具"层，而非新造原子工具）。
  - 底层 `upsert_media_node` / `set_node_generation_params` / `propose_generation` **保持原子、零改动**。
  - 这是 **constructive 修复**：让正确组合成为最小阻力路径，而非事后拦截。
- **`before_tool` provenance 拦截（P1b）降级为 backstop**：仅当模型仍直接调原子工具（如用户对已有节点发起生成）时生效，作防御纵深；不再是主防线。
- **`executionMode:"sequential"`（P1a）维持 Layer-1 加固**：只保证服务端执行顺序，不能阻止同消息参数定稿，不可高估。

**P2b · skill / 提示词规则改造（保持，仅文案）**
`drama-character-design` 等 skill 改为**优先走 chain 编排工具**（声明有序操作列表），而非分步裸调原子工具；涉及提示词规则按 AGENTS.md「改提示词规则 ⇒ 同步 6 处」纪律改，跑 `pnpm prompt:lint`。

### Phase 3 — 防御纵深 + 状态对账

**P3a · propose 解绑强制状态对账**
`waiting_user` resolved（answered/declined）→ 服务端同步 `clear-propose-generation`，把节点从 `pending_confirm` 迁出（D5 根因）。

**P3b · 生成生命周期权威覆盖**
`generateForNode` 启动与完成写入时，强制 `status` 走 `generating→completed`，明确覆盖残留 `pending_confirm`（扩展 P0-B 守卫白名单，使 `completed` 也是合法出口）。

**P3c · 记忆污染防护**
`save_memory` 若写入"画布基准节点"且指向本轮 propose 节点，校验其与 provenance 注册表一致；不一致告警而非静默落库（D6）。

## 4. 关键实现落点（file:func）

| 改动 | 文件 | 说明 |
|---|---|---|
| 加 `executionMode:"sequential"` | `services/pi-runtime/src/tools/canvas-write.ts`（三处 write 工具定义） | 仿 `todo.ts:97` |
| **chain 编排工具（主修复·对应 Layer 2）** | `services/pi-runtime/src/tools/` 新增 `run_canvas_plan`（或 `delegate_canvas_ops`），入参为有序操作列表，wrapper 按序执行并自动注入上一步返回的 node id；复用既有 Nest 端点 | 补上缺失的编排包装层，对标 `delegate_task(chain)` / `fabric_exec`，不重造 pi-fabric、不动原子工具 |
| 轮次节点注册表 + provenance 拦截（backstop） | pi-runtime 的 `before_tool` 钩子（或 canvas-write.ts 内语义校验），配合 module 级 `Map<sessionId,{turnCreated:string[]}>` | 仅当模型仍直接调原子工具时生效，作防御纵深 |
| 服务端校验加强 | `apps/server/src/agent/agent-canvas-tools.service.ts` `proposeGeneration` / `setNodeGenerationParams` | provenance 双条件 |
| 错误文案 | 同文件 `unknown guideSceneId` 分支 | 引导 `list_generation_scenes` |
| 状态对账 | `apps/server/src/agent/agent-canvas-tools.service.ts` propose 解绑路径 + `generateForNode` | 防 D5 |
| skill 修正 | `skills/drama-character-design/SKILL.md` | D4/P2b |

## 5. 为什么这是"最佳"而非治标

- **治标方案（已被证伪）**：加提示词"请串行、请用返回值 id" —— 被 D1/D2 证伪，模型仍会并行、会猜 id；纯前端修 `locateProposeNode` 只改表象，换节点仍错。
- **本方案对齐的头部实践**：
  - Claude parallel tool use：依赖调用必须串行；`disable_parallel_tool_use` 强制单调用/轮（说明"同消息多调用参数已定稿"的铁律，正是 P1a 不可高估的原因）。
  - **Codex（OpenAI，源码实证，2026-10-16 复核）**：`codex-rs/core/src/tools/` 把"工具定义"与"编排执行"在目录与 trait 层级就**明确分离**，与 pi 哲学同构：
    - **工具定义层（原子/无状态）**：`Tool`/`ToolRuntime` trait 保持最小可独立调用；并发能力**由工具自己声明**——`router.tool_supports_parallel(&call) → bool`，调度器不替工具拍板。
    - **编排门控层（L2 同构）**：`tools/parallel.rs` 的 `ToolCallRuntime` 持有 `parallel_execution: Arc<RwLock<()>>`；`handle_tool_call_with_source` 据 `supports_parallel` 决定 **read 锁（共享·可并行）/ write 锁（独占·强制串行）**——**并发决策完全落在编排层，而非工具内部**。
    - **中间件层**：`tools/orchestrator.rs` 的 `ToolOrchestrator`（模块注释原文 _"Coordinates tool approval, sandbox selection, and retries after sandbox denial"_）夹在 agent loop 与具体 `tool.run()` 之间，专管审批/沙箱/重试。
    - **结论**：Codex 同样**不把组合塞进工具定义、不让模型用文本搬运依赖**，而是用编排/中间件层据工具声明的能力做并发与依赖门控。这是从另一个主流开源实现角度**实证**了我们"主修复 = 补 L2 编排包装层（chain 工具）"的正确性，而非特例。
  - Amex Tool Sequence Guardrails / OpenAI `task_handle` 注册表：执行前校验依赖、后端持有 create→id 映射（**对应本方案 backstop：P1b provenance 拦截 + 会话级 node-id 注册表**）。
  - **pi 生态 `delegate_task(chain)` / `pi-fabric` / `fabric_exec`**：上游把"组合"作为委托层显式模式（chain = 按序执行、步骤间数据流转）。**这正是本方案主修复（`run_canvas_plan` chain 工具）所对齐的上游范式**——我们只是在 domain 内做了一个最小等价实现，而非重造整个 pi-fabric。
  - 共识："模型是偶尔出错的意图源，你的代码才是执行权威；依赖/组合关系必须落在编排层，不是 prompt、也不是把组合塞进工具定义。" 该共识已被 **pi 上游生态（`delegate_task(chain)`/`pi-fabric`）与 Codex 源码（`parallel.rs` 编排门控 + `ToolOrchestrator` 中间件）双独立实现交叉印证**，非某一家私见。
- **不重复造轮子**：`executionMode` 是 pi 上游现成能力；chain 编排工具是对标 `delegate_task(chain)` 的**最小 domain 等价物**（复用既有 Nest 端点、底层原子工具零改动）；provenance 拦截挂在 pi 指定的 `before_tool` 层作 backstop。无自研并发框架、无自研 id 协议、无新原子工具定义。若后续引入上游 `pi-fabric`，可直接替换为官方 `delegate_task(chain:[...])`。

## 6. 风险与回滚

- **P1a 串行化**：写工具批次整体串行。可接受（写本就不并行）；若担心吞吐，可仅对"同批含 propose/upsert 的写工具"串行，读工具仍可并行。**但重申：它不是根因修复**（同消息参数已定稿）。
- **P1b 误杀**：provenance 双条件有误杀可能 → 用 actionable error + 模型自纠，设 ≤3 轮上限，配合灰度。
- **Phase 2 复合工具已撤回**：无需同步改 skill/提示词为复合路径，仅维持分步文案（P2b）。

## 7. 验证

- **单测**：provenance guard 对"引用非本轮创建节点"返回带正确 id 的错误；`executionMode` 串行已在 `todo` 路径有范式可参照。
- **复现脚本**：用 `cmv95a7sd` 的 tool_call 序列（同批 create+propose 错 id）重放，断言被拦截或强制串行化；断言 propose 解绑后节点状态离开 `pending_confirm`。
- **生产复盘**：上线后核实同会话"提议生成"卡的 `blockingWait.nodeId` 与 `upsert_media_node` 返回 id 恒等。
