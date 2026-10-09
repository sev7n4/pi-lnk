---
id: plan-gate
title: C3 Plan 确认门（generation-gate 泛化）设计规格
version: 1.0.0
date: 2026-10-10
status: draft-review
upstream: docs/superpowers/specs/2026-10-09-task-management-module-design.md §C3
---

# C3 Plan 确认门设计规格

> 一句话：新增 `propose_plan` 工具把「整场方案」提给用户阻塞确认（复用 ask_user 通道，前端零改动）；方案未确认期间 `before_tool` 拦截全部写类工具（generation-gate 同款 fail-closed）；确认后 `before_run_end {followUp}` 强制追加执行轮。零 vendor patch、零新表、零新端点、零前端改动。

## 1. 背景与目标

### 1.1 输入

- **对标分析 L2**（`docs/analysis/2026-10-09-workbuddy-task-planning-benchmark.md`）：Plan 模式 = 先出方案、用户确认后再执行，**确认前绝不执行**——「放手程度光谱」的中间档。
- **模块全景 §C3**：Plan 确认门（generation-gate 泛化 + 会话级 planMode）；拦截用 `before_tool`（HITL gate 同款，已验证可用），方案确认后追加执行轮用 `before_run_end {followUp}`。
- **C1 已上线**（`75d3105e` + V-B′ `ad6c09ef`）：todo_write 全量覆写管道 + 任务卡（含 activeForm）+ details 快照持久化/播种，是本设计的方案载体与执行透明化通道。

### 1.2 目标

1. 多步任务（≥3 步）用户表达「先出方案」意图（或 agent 自判方案值得先讨论）时，agent 用 `propose_plan` 提交方案：步骤清单落任务卡（C1 管道）+ 确认卡片（ask_user 通道）阻塞等待。
2. 方案提出后、用户确认前，**一切写类工具调用被 harness 强制拦截**（确认权收归 harness，模型不能自批自审）。
3. 用户确认后，模型即使想收尾也被 `before_run_end {followUp}` 拉回执行轮；执行中逐步 todo_write 打勾（V-B′ 已闭环的呈现链）。
4. 全链路 kill switch 可退化为逐字节旧行为。

### 1.3 非目标（二期另立）

- Ask 模式（只读不执行的光谱另一端）。
- 前端方案面板 / UI 模式开关（WorkBuddy 右侧面板式审阅）——本设计的「确认通道」升级点，状态机与门禁原样复用。
- 子代理并行执行（C4）。

## 2. 方案选型（2026-10-10 已拍板）

| 决策点 | 选定 | 否决项与理由 |
|---|---|---|
| 确认交互 | **复用阻塞确认**（ask_user 机制 + todo_write 任务卡承载方案） | 前端方案面板 + 确认按钮：产品形态最像 WorkBuddy，但要新前端 UI + 新确认端点 + 跨 run 状态机，体量 3-4 倍且风险面全新；文本确认：语义靠文本判断不可靠。本方案三机制全部生产验证过，确认契约（「按钮我点过你才能动手」）完整成立 |
| 触发方式 | **提议式 `propose_plan`**（无 UI 开关） | UI 开关：忘关 = 写操作持续被拦，挫败感强且要动前端；画布已有 propose_generation 的提议式确认心智，一致性最好。二期开关 = 「预置 pending 方案的快捷入口」，是本设计的严格超集，升级不做废 |

## 3. 架构

### 3.1 状态机（会话级，PlanGateStore）

```
                    propose_plan 返回 decision
  ┌─────────┐   ┌───────────────────────────────┐
  │  idle   │──▶│ propose_plan 执行中（阻塞等确认） │
  │ (放行写) │   └───────────────────────────────┘
  └─────────┘            │ decision
       ▲                 ├─ execute ──▶ idle（放行写）+ 执行轮保障（§3.4）
       │                 ├─ refine ───▶ planPending（拦写；agent 改方案后再次 propose_plan）
       │                 ├─ keep ─────▶ planPending（拦写；方案保留在任务卡）
       │                 └─ timeout/aborted ─▶ planPending（fail-closed）
       │                            │
       └── （无自动回 idle 路径）◀──┘ 用户后续轮：模型可再次 propose_plan 征求确认
```

- **唯一解锁写操作的通道 = propose_plan 卡片上用户点「开始执行」**。`keep`（仅保留方案）保持拦写：用户明确表达了「不要执行」，后续任何执行仍须一次显式确认——这是「确认前绝不执行」的完整语义，不给文本判断留口子。
- planPending 不因新用户轮自动清空（WorkBuddy 语义：确认前绝不执行）。出口只有两条：再次 propose_plan → execute；或 kill switch。
- 内存 store 仅加速，SSOT = transcript details 快照（§3.5），与 C1 同构。

### 3.2 新工具 propose_plan

- **tier = `ui_command`**（ask_user 同族：产出给用户的交互卡片，不写库）。
- 常驻集：`task_tool.md` 点名 ⇒ 进 `ALWAYS_ON_TOOL_NAMES`（todo_write 先例，tiering.ts 铁律「被点名 ⇒ 必须常驻」）。
- 参数 schema：

```ts
{
  summary: string,                    // 方案一句话概括（确认卡片题面）
  steps: [{ content: string, activeForm?: string }],  // ≥1 步，祈使句；形态与 todo_write 一致
}
```

- 行为（一次调用完成「写清单 + 等确认」，不做两步组合——组合会让 gate 状态识别脆弱）：
  1. **步骤落任务卡**：内部把 steps 作为全量覆写写进 todo store（复用 C1 `TodoSessionState` 写入路径），details 快照与 todo_write 同形态持久化 → 前端任务卡零改动展示 pending 步骤。
  2. **阻塞确认**：经 onUpdate 下发单题确认卡片（canvas_command `type:"ask_user"` 通道，复用 ask_user 的 callId / POST /answers 回流），`registry.waitForUser(sessionId, id, "propose_plan", timeoutMs, { meta })`。三选项：`开始执行` / `调整计划`（allowOther 收意见）/ `仅保留方案`。
  3. **返回**：`{ confirmed, decision: "execute"|"refine"|"keep"|"timeout"|"aborted", feedback?: string }`；refine 时 feedback = 用户意见文本。
- 超时/中止语义沿袭 ask_user 铁律（B-4）：registry resolve 不 reject，超时交还 `decision:"timeout"`，fail-closed 保持拦写。

### 3.3 before_tool 拦截（src/gate/plan-gate.ts，新模块）

- `PlanGateStore`：`Map<sessionId, { pending: boolean; updatedTurn: number }>`，`resetSession` 挂 onSessionCreated（GenerationGateStore 同款）。
- 拦截矩阵：`planPending(session) && tier ∈ {gen, destructive, graph_batch, write_light}` → `block`，reason 引导：「方案待用户确认；请先用 propose_plan 征得确认，或与用户澄清下一步」。tier ∈ {read, present, ui_command, skill} 天然放行；`todo_write` / `ask_user` 显式豁免名单（改方案与再提问是 planPending 期间的合法动作）。
- fail-closed：store 查询异常按拦截处理。
- 与 generation-gate 的关系：**并存不合并**。generation-gate 管「单节点生成确认」（SSOT=节点 status），plan-gate 管「整场方案确认」（SSOT=transcript 快照）；两者在 before_tool hook 内先后判定。强行合并会把两套语义（节点级 V-γ 预算 / 会话级 pending）耦进一个 store，违背「各自独立可测」。
- 关键语义澄清：无方案提出时 gate 不拦（= 现状 Agent 模式，用户没要方案时 agent 照常干活）。plan-gate 只在「方案已提出、未确认」窗口收紧——这是提议式与 UI 开关的本质差异，也是它零前端的原因。

### 3.4 执行轮保障（before_run_end followUp）

- 触发条件：**本 run 内发生过 `decision:"execute"` 且 todo store 存在非 completed 步骤**（执行未完）→ 注入 `followUp = "用户已确认方案，继续执行下一步：…（首个未完成步骤）"`。vendor boundary.ts:177 已验证：followUp 转合成 user 消息 replan 继续。
- 双保险不双执行：模型确认后已在跑时，run 正常结束后 followUp 仅在「还有未完成步骤」时注入；全部完成则不注入（模型自己会用 todo 状态收尾汇报）。
- 执行中逐步 todo_write 打勾：由 prompt 规则（task_tool.md 既有「每完成一项即更新状态」）驱动，V-B′ 呈现链已闭环。

### 3.5 持久化与跨重建

- **SSOT = transcript details 快照**：propose_plan 的 details 携带 `{ plan: { summary, steps, decision } }`，随工具结果进 transcript——fork/branch 天然跟随、跨压缩不丢（C1 details 快照同构）。
- 播种：session-manager 会话 open/resume/rebuild 后读 transcript 最后一条 propose_plan details → `seedPlanState`（seedTodoState 同位置同键约定）。decision=execute 之后的会话恢复为 idle；refine/keep/timeout 恢复为 planPending。
- Nest 侧零改动、零新表：plan 状态不进 SQLite（与 C1 的「details 快照 = SSOT」一致；GenerationRecord.metadata 观测降级通道不适用——pi-runtime 有 Metrics，见 §3.7）。

### 3.6 前端与事件

- **前端零改动**：方案步骤 = C1 任务卡（task_list/task_update 既有事件）；确认卡片 = ask_user 既有卡片通道（单题三选项）。无需新事件类型、无需新组件。
- 确认卡片与任务卡的组合呈现：任务卡展示步骤清单（方案本体），确认卡片承载动作（开始执行/调整/仅保留）——卡片本身不需要「方案感」排版，P0 接受；二期面板升级时换确认通道即可。

### 3.7 工程面

| 项 | 设计 |
|---|---|
| kill switch | `PI_RUNTIME_PLAN_GATE=off` → propose_plan 不注册 + gate 不挂 + followUp 不注入。⚠️ 已知降级：task_tool.md 点名悬空，模型直调吃 vendor "Tool propose_plan is unavailable" error 后自行回退为不提方案直接干活（= 现状行为，生产实证过该回退形态，tiering.ts:8）。仅作生产止血用，不承诺半开 |
| 常驻集 | `ALWAYS_ON_TOOL_NAMES` + `propose_plan`（task_tool.md 点名；tiering.test.ts 显式登记归属） |
| Metrics | `plan_proposed_total` / `plan_decision_total{decision}` / `plan_gate_blocked_total`（pi-runtime Metrics 原生计数，无需 Nest metadata 降级） |
| prompt 规则 | task_tool.md 追加一句点名：「用户要求先出方案或任务需要先对齐做法时，先 propose_plan 征得确认再执行；确认前不写画布、不调生成」。⚠️ 预算余量 89 字符（PROMPT_SPEC.md §5 为权威），追加约 45 字符，`pnpm prompt:lint` 实测定夺，超了就精简措辞。**6 处同步纪律**：磁盘 .md + MANIFEST（version 1.0.0→1.1.0 + contentHash）+ loader COMPOSED_IDS（已含）+ FALLBACK_BY_ID + fallback 内嵌常量 + assembler EXPECTED |
| tool description | 行为细则（何时提方案/三选项语义/确认前禁写）写进 description，不占 prompt-registry 预算（ask_user 先例：description 必须带「何时用」与「不得怎样」，否则弱模型不调用） |
| 机检 | `pnpm verify-tool-contract` 比对 HookMap 依赖字段（before_tool / before_run_end 均为官方契约，本设计零新增自由形态依赖）；tool-capability-catalog.md 登记新工具四列 |

## 4. 测试设计（TDD）

1. **plan-gate 状态机单测**：四 decision × 状态转换 × 拦截矩阵（per tier 全覆盖）+ 豁免名单 + fail-closed（store 异常）。
2. **propose_plan 单测**：execute/refine/keep/timeout/aborted 五路返回形态；steps 落 todo store（含 activeForm 透传）；details 快照形态；off 开关不注册。
3. **followUp 单测**：execute + 有未完成步骤 → 注入且含首未完成步骤；execute + 全部完成 → 不注入；refine/keep/timeout → 不注入。
4. **播种单测**：transcript 末条 propose_plan details → seedPlanState 恢复 idle / planPending 两态。
5. **事件回归**：确认卡片 canvas_command 派生不破坏既有 ask_user 断言；task 卡片事件形态逐字节不变。
6. **prompt 机检**：`pnpm prompt:lint` 绿（磁盘=内嵌常量逐字符 + 预算实测）。
7. CI 全量门禁（web 全量不本地跑，交 CI）。

## 5. 风险与开放问题

1. **模型不调 propose_plan 直接干活**（用户要了方案但模型忽略）= 现状行为，不是回归；缓解：tool description「何时必用」强约束 + task_tool.md 点名，观测 plan_proposed_total。
2. **planPending 长期悬挂**（用户既不确认也不理）：确认卡片有界超时（askUserTimeoutMs）→ timeout 保持 pending；用户回来后模型可重新 propose。观测 plan_gate_blocked_total 判断误拦率，异常升高再考虑「N 用户轮后自动降级」——**P0 不做自动降级**（违反「硬边界可关不可破」的宁紧勿松）。
3. **上游 upmerge**：before_tool / before_run_end 均 HookMap 官方契约（agent-harness.ts:439/464），verify-tool-contract 机检在 CI；1.0.0 harness→pi-durable 拆分触发重审时，落点重映射清单 = plan-gate.ts（hooks 挂点）+ session-manager（播种）+ index.ts（装配）。
4. **open question（实现计划显式 case）**：propose_plan 与 propose_generation 并存窗口——plan 确认（execute）后 agent 走到具体节点仍须 propose_generation 单节点确认，两层确认叠加是否体验冗余？P0 判断：不冗余（整场方案 ≠ 单节点参数确认，后者携带视觉预览），观测两个确认卡片的连续出现率后再议。

## 6. 与 C1 不变面的关系

- **只消费不修改**：todo store 写入路径、details 快照形态、task_list/task_update 事件、前端任务卡、composeEntryAndObserve 注入、planMarkers 兼容层——全部原样复用（C1 spec §8.3 不变面承诺逐条成立）。
- **红线自查**：未引入「绕过全量快照直接改状态」旁路（propose_plan 写 steps 走 todo store 同一入口）。
