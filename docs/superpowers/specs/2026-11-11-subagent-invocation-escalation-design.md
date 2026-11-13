# spawn_subagent 调用升级预案——「点名替代」路径裁决（观测期预案刀）

> 状态：**预案（PLAN_ONLY）**——本规格只裁决「若观测期判据触发，升级走哪条路」，不批准任何代码改动。
> **⚠️ 2026-11-13 状态更新（v1.3 复审，SSOT=路标 §9.2/§17.2）**：T1∧T2 触发条件（7 天/200 run spawned 恒 0）**已被生产事实打破**——spawned_total=3 且 3/3 completed（build `16e4fc99` 存续期），「触发后升级路径（P4→P3→P5→止损）」不再适用，观测重心转为 spawned 持续性与 tool_search internal error 观察项。本文 F1–F6 取证、行业对照（§7）与三层点名模型**仍有效**（作为 A-2'/SOP 刀的设计输入保留）。
> 前置：PR #838（spawn_subagent 提回常驻）已合并（master `49fb699d`）并部署生产（镜像同 sha）。
> 关联：`2026-11-11-subagent-tier-promotion-design.md`（可达性刀，其 §边界 第 6 条即本规格的触发来源）、
> `2026-11-11-task-planning-engineering-roadmap-design.md`（G3「上游原语未吃满」）。

## 1 背景与触发来源

C4 `spawn_subagent` 生产零调用（`pi_runtime_subagent_spawned_total 0`）。根因链分两半：

1. **schema 不可达**（tiering 延迟集）——#838 已修：提回 ALWAYS_ON 常驻集，schema 每轮随请求下发。
2. **无点名/无动机**——tiering.ts 文件头铁律：「点名 ⇒ 模型会直调 ⇒ 必须常驻；未点名 ⇒ 可延迟（靠 tool_search 发现）」，而「tool_search 无动机时触发率实测为 0」。#838 的修复选择了「提回常驻 + description 承担发现能力」（group_nodes 先例），**未做 prompt-registry 点名**，理由是 L6 预算封锁（见 §2-F2）。

#838 spec 边界第 6 条原文：「『提回常驻 ⇒ 模型会用』是合理推断非保证……观测周期内若 spawned 仍为 0，回头评估 prompt 点名替代方案（需先解决预算）」。本规格即该「回头评估」的预案——**提前把裁决做完，观测触发后零等待直接执行**。

## 2 关键事实取证（2026-11-11，全部本机核实）

- **F1 上游原语归属**：`promptGuidelines` / `promptSnippet` 是 **coding-agent 包**（`packages/coding-agent/src/core/agent-session.ts:1068-1096` + `system-prompt.ts`）的机制；pi-runtime 依赖的 **pi-agent-core（packages/agent）全包零命中**——`AgentHarnessTool`（`packages/agent/src/harness/types.ts:108`）继承的 `AgentTool` 无此字段。⇒ 「直接给工具定义挂 promptGuidelines」对本项目**不可用**，pi-runtime `src/**` 亦零使用（grep 实证）。
- **F2 L6 预算封锁**：prompt-registry `STATIC_BUDGET_CHARS=3200`，全组合实测长期贴预警线（2720）之上、距硬线余量极小（历史值 115/154/6 三个时点并存于文档——**以 `pnpm prompt:lint` 实跑为唯一权威源，勿信任何常驻副本**）。加规则或扩正文物理可行性趋近于零，且「点名 ⇒ 必须常驻」意味着点名不解决可达性（可达性已由 #838 解决）。
- **F3 pi-runtime 动态预算独立且宽裕**：systemPrompt 是动态组装（`session-manager.ts:2352 composeEntryAndObserve` = `composeSystemPrompt(staticPrompt, dynamicBlocks, budget)`），每轮 LLM 请求重求值（跨压缩存活的实现点）；`dynamicBudgetTotalChars ?? 48_000`（session-manager.ts:2332），默认开启（`dynamicBudget ?? true`）。⇒ **48k 口径下加一段 guideline 块余量巨大**，与 L6 的 3200 硬线是两套预算。
- **F4 description 已含触发场景**：`spawn-subagent.ts:32-36` 已写「何时必用：需要大范围查资料/核对多文件/联网调研，且探索过程不值得占用主对话窗口时」——group_nodes 同款「零点名常驻、description 承担发现」姿势**已就位**。⇒ #838 部署后模型可见面 = schema + 触发场景描述，点名缺口比调查时预估的小。
- **F5 plan-gate 拦截面含 spawn_subagent**：`gate/plan-gate.ts:70` `PLAN_GATED_TIERS` 含 `write_light`，spawn_subagent tier 即 `write_light`（spawn-subagent.ts:28）。⇒ **planPending 期间派发被拦**（豁免表只有 todo_write）。而「大范围调研」最高发于多步任务的 plan 待确认阶段——**设计意图与拦截时机结构性错位**，是此前所有调查均未记录的潜在抑制因素。
- **F6 生产基线已锚**（2026-11-11 16:00，#838 部署后）：`pi_runtime_subagent_spawned_total 0`、`pi_runtime_tool_search_activated_total 0`。观测起点 = 本锚点之后。

## 3 触发条件（唯一开关）

沿用 #838 spec 边界第 6 条，细化判据——**观测期内同时满足以下两条才触发本预案执行**：

- **T1 计数判据**：观测期 ≥ 7 天（或 ≥ 200 个生产主对话 run，先到为准）后 `pi_runtime_subagent_spawned_total` 仍为 0。
- **T2 场景判据（区分「没场景」vs「有场景不用」）**：抽样 executionEvents 中包含「联网搜索/多文件核对/大范围调研」意图的生产 run ≥ 5 条（以用户消息或后续 web_search 调用为标记）——证明触发场景真实存在，模型是「有 schema 有场景但选择不派」，而非「根本没场景」。若场景本身不存在，零调用是正常分布，本预案整体 No-Go（不动 prompt，等画像变化）。

## 4 升级路径对比与裁决

| 路径 | 机制 | 预算 | 判定 |
|---|---|---|---|
| **P1 prompt-registry rules 点名** | 新增 rule 或扩 `task_tool` 正文 | L6 3200 硬线，余量趋零（F2） | **否决**——物理不可行，且需同步 6 处 + lint 门禁，改动面最大 |
| **P2 移植 coding-agent promptGuidelines 原语** | 给 `AgentHarnessTool` 加字段 + 组装管线 | 不占 L6 | **否决（本刀）**——属 vendor 面改动 + 新机制，收益单点（只服务点名一件事），违反「不重复造轮子/最小刀」；G3 阶段 B 若整体吃原语再议 |
| **P3 session-manager 动态 guideline 块** | `assembleDynamicBlocks` 增加一个静态 guideline 块（如 collaboration kind），或并入既有动态块体系 | 48k 口径余量巨大（F3） | **裁决=触发后首选**——不改 vendor、不碰 L6、天然跨压缩存活（每轮重求值）、改动收敛在一个函数 + 一个 kind 预算份额 |
| **P4 plan-gate 豁免 spawn_subagent** | `PLAN_EXEMPT_TOOLS` 加入 spawn_subagent（或独立只读豁免语义） | 零预算 | **裁决=与 P3 并列同刀评估**——F5 错位若被生产证据坐实（被拦计数 `pi_runtime_plan_gate_blocked_total{tool="spawn_subagent"}` > 0），豁免比点名更对症；但豁免改变 C3 安全语义（C4 spec 曾裁决进拦截面），须独立评审，不得搭车 |
| **P5 强化 description** | spawn-subagent.ts description 扩写触发词 | 随 schema 下发零预算 | **兜底**——若 P3 落地后仍 0，且 T2 场景成立，先做 P5（成本最低）再观察一轮 |

**执行顺序（触发后）**：先核 `plan_gate_blocked_total{tool="spawn_subagent"}`——若 > 0 走 P4 独立评审刀；否则走 P3；P3 后一个观测周期仍 0 → P5 → 仍 0 → 接受「生产画像无子代理需求」结论，C4 保留为常驻能力不再追加投入（诚实止损）。

## 5 观测纪律

- 基线 = F6 锚点。观测判据只看 `pi_runtime_subagent_spawned_total` / `pi_runtime_plan_gate_blocked_total{tool="spawn_subagent"}` / `pi_runtime_tool_search_calls_total` 三个序列，不做未立项的新增 metrics。
- P3 落地时同步 metrics：新增块 kind 走 dynamic-budget 既有 `observeDynamicBudgetDrop(kind)` 通道，不另起炉灶。
- **不得在观测期内做任何 P3/P4/P5 改动**——观测期内动手 = 基线作废、归因失效（#838 spec 已明确裸常驻观测意图）。

## 6 诚实边界

- 「提回常驻 + description 触发场景 ⇒ 调用回升」仍是推断：模型行为受流量画像主导，可能 T1 触发仅因画布产品会话天然无调研需求——所以 T2 场景判据是**前置门**，不满足即 No-Go，不做无效升级。
- F5 的 plan-gate 错位是**候选抑制因素非已证根因**：`plan_gate_blocked_total{tool="spawn_subagent"}` 生产值为 0（从未被调过自然从未被拦），该因素只在「点名生效、开始有调用」后才可能显形——它是第二阶段的预案，不是本轮零调用的解释。
- 本规格不改任何代码、不动生产；全部裁决在触发条件满足后才可执行，且 P3/P4 各自仍需独立 spec/plan + 授权。
- tool_search 通道（hit 历史值 4/6 两时点）不是本预案对象：它已有 prompt 指引（tiering.ts 文件头记录的规则改写），其 activated=0 属流量画像问题，单独评估。

## 7 行业对照（2026-11-11 补，用户问询触发；来源标注，非本地取证）

- **W1 Anthropic Tool Search Tool（官方 engineering 博客）**：`defer_loading: true` 的延迟工具 + 常驻「最关键、高频」核心集 + 搜索按需展开——与 pi-lnk tiering「ALWAYS_ON 常驻 + 延迟集 + tool_search」**逐层同构**，内部评测 Opus 4 MCP evals 49%→74%。⇒ 架构方向无需自疑；「零点名」的对治不在架构层。
- **W2 MCP 官方 Client Best Practices**：progressive discovery 三层（catalog→inspect→execute），建议阈值 1–5% context 才启用渐进发现；检索策略 keyword/embedding/subagent/hybrid 四选。⇒ pi-lnk 工具总量远未到 token 压力线，tiering 的动机本就是「可达性/聚焦」而非省 token——与上游 pi 官方模式一致。
- **W3 Anthropic 子代理委派机制（官方 docs）**：「Claude uses each subagent's **description** to decide when to delegate tasks. When you create a subagent, **write a clear description** so Claude knows when to use it.」⇒ **F4 的 description 姿势正是行业一等做法**（用 description 做触发判断，非系统提示点名）；另有 `system-prompt-subagent-delegation-restraint` 系统提示片段管「委派克制」——即 Claude Code 同时用了 description 层 + 系统提示层两道点名（后者对应 P3）。
- **W4 Claude Code plan mode 明确允许 `subagent dispatch via Task`**（permission-modes 文档：plan mode 白名单含 Read/Glob/Grep/WebSearch/WebFetch/**Task**/AskUserQuestion），且内置 **Plan 子代理**定义为「plan mode 期间做调研、产出留在子上下文」。⇒ **F5 错位被行业做法反向坐实**：只读调研子代理在 plan 待确认阶段正是被鼓励的能力，pi-lnk 的 `PLAN_GATED_TIERS` 拦 spawn_subagent 与此相悖——P4 从「候选抑制因素」升级为「有行业对标的设计偏差」，但豁免仍属 C3 安全语义变更，须独立评审。
- **W5 WorkBuddy（本产品，会话内直接观察）**：三级同构——常驻核心工具 + `available_deferred_tools` 延迟不下发 schema + `ToolSearch`（MiniSearch 关键词/模糊检索）发现后经延迟执行器激活；且**系统提示里有检索路由指引段**（何时用知识检索/会话检索/域检索），即系统提示级点名真实存在于生产级产品。⇒ P3（动态 guideline 块）在一线产品有同款先例，非本项目首创。
- **对照小结**：行业对「何时该用某工具」的答案分三层——① description 自足（最低成本，已就位 F4）；② 系统提示点名触发时机（P3，有 W3/W5 先例）；③ 时机面豁免（plan 期只读调研放行 = P4，有 W4 对标）。三层不必全做：先靠 F4 裸观测，触发后按 §4 顺序上 ②/③，与 Claude Code 的实际组合（②+③）收敛。
