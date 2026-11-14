# A-3 propose_plan 声明式假设与范围字段 — 立项规格

- **状态**：设计稿·待评审（遵循路标 v1.3 冻结纪律：本文件是细化产物，不回写路标 SSOT；停在用户审阅 gate，未 commit / 未推 PR / 未动产品代码）
- **归属**：任务管理工程主线 → 阶段 A 补契约 → §7 立项队列第 2 项（A-2' 已合 #863，A-3 为队列下一未立项项）
- **上游锚**：路标 `2026-11-11-task-planning-engineering-roadmap-design.md` §5.2 阶段 A③「`propose_plan` 摘要增 `assumptions[]`（声明式假设结构化落点）」、§7 队列、§16.5（表述升级为「`assumptions[] + scope`」）、§19.4-2（「后续立项 spec 引用 A-3 时以 §16.5 表述为准」）；A-2' spec `2026-11-13-a2-model-side-id-contract-design.md:99/109`（「assumptions 引用属后续刀 A-3」「跨工具 id 引用（A-3 assumptions[] 另立项）」）

---

## 0. 摘要

`propose_plan` 当前只暴露 `summary` / `steps` / `explanation` 三个字段。假设（assumptions）只能塞进自由文本 `explanation`，**非结构化、不可机检、用户在确认卡上看不到一条条假设**。本刀把「声明式假设」与「范围边界」从自由文本提升为**结构化字段**，使：

1. 用户在 plan-gate 确认卡上能看到**显式假设清单 + 范围边界**，决策质量提升；
2. C-1 eval 能机检「非平凡方案是否带显式假设」（拆解质量 G2 的可观测信号）；
3. 假设不污染 `explanation`（思路概述）语义，各司其职。

**不改动**：plan-gate 的 `decision` 语义、overwriteTodos 落清单行为、todo 清单结构、A-2' 的 id 契约。

---

## 1. 背景与动机

- **缺口 G2（拆解质量）的抓手之一**：路标 §4 五缺口中 G2 为「拆解质量」，eval 闭环（阶段 C①）需要可观测信号。假设是否显式化是拆解成熟度的一阶信号——但当前假设淹没在 `explanation` 自由文本里，eval 无法断言。
- **plan-gate 决策点信息缺失**：确认卡渲染 `question.plan.{summary, explanation, steps}`，用户看不到「本方案基于哪些假设」。关键假设未被用户校验即可能进入执行。
- **`explanation` 语义被挪用**：模型常把假设写进 `explanation`，使它兼具「思路概述」与「假设清单」双重职责，前端渲染与 eval 都无法区分。
- **A-2' 已落地 id 契约**（#863），A-3 在其之后立项，二者正交：A-3 只捕捉**文本假设**，不引入跨工具 id 引用（那属 A-3 之外、且路标 No-Go 已排除 `task_create` 三工具族）。

---

## 2. 现状锚（2026-11-15 核 master `741bfcb`）

`services/pi-runtime/src/tools/propose-plan.ts` 的 `parameters`：

```ts
Type.Object({
  summary: Type.String({ description: "方案一句话概括（确认卡片题面…）" }),
  steps: Type.Array(
    Type.Object({
      content: Type.String({ description: "步骤内容（祈使句…）" }),
      activeForm: Type.Optional(Type.String({ description: "进行时文案…" })),
    }),
    { description: "方案步骤…", min: 1, max: 20 },
  ),
  explanation: Type.Optional(Type.String({ description: "方案思路/取舍概述（1-2 句）…" })),
})
```

`execute` 内构造的 `plan` 工件（进 `question.plan` 与 `details.plan`）：

```ts
plan: {
  summary: p.summary,
  ...(p.explanation ? { explanation: p.explanation } : {}),
  steps: p.steps.map((s) => ({ content: s.content, ...(s.activeForm ? { activeForm: s.activeForm } : {}) })),
}
```

**消费方核查**：
- `gate/plan-gate.ts`：仅 `markPlanDecision(sessionId, decision)`，`PlanDecision` 枚举 `execute|refine|keep|aborted|timeout`，**从不读取 `plan` 对象形态** → 加字段纯增量、零破坏。
- 前端确认卡：读 `question.plan.{summary, explanation, steps}` 渲染（需同步扩展以展示新增字段，见 §3.3）。
- `propose-plan.test.ts`：现有断言围绕 decision 语义与 steps 落清单，加字段不需改既有断言（向后兼容）。

---

## 3. 设计

### 3.1 工具参数新增

```ts
assumptions: Type.Array(
  Type.String({ description: "方案依赖的声明式假设（每条一句，如「用户已登录」「目标画布为空」「数据源 X 可访问」）；非平凡方案应显式列出" }),
  { description: "方案成立所依赖的假设清单（结构化，供确认卡展示与 eval 机检）", min: 0, max: 12 },
),
scope: Type.Optional(Type.Object(
  {
    inScope: Type.Array(Type.String({ description: "本方案明确覆盖的事项" }), { min: 1, max: 12 }),
    outOfScope: Type.Array(Type.String({ description: "本方案明确排除的事项" }), { min: 0, max: 12 }),
  },
  { description: "方案范围边界：明确覆盖与明确排除，帮助用户校准预期" },
)),
```

> `min: 0` 而非 `min: 1`：保持向后兼容（旧调用不传不报错），是否「必须带假设」交由 eval 判据（§3.4）与 Skill SOP 纪律约束，不由 schema 强拒。

### 3.2 `plan` 工件透传

`execute` 构造 `plan` 时追加：

```ts
...(p.assumptions?.length ? { assumptions: p.assumptions } : {}),
...(p.scope ? { scope: p.scope } : {}),
```

两处都加（`question.plan` 供前端、`details.plan` 供 transcript/eval 取证），保持与 `explanation` 同构的「有则透传」风格。

### 3.3 前端确认卡渲染（配套改动）

确认卡组件读取 `question.plan.assumptions` / `question.plan.scope`，在 `steps` 之上新增两个区块：
- **假设**（assumptions）：列表展示，每条一行；
- **范围**（scope）：分组展示「覆盖 / 排除」。

若上游未传则区块不渲染（保持旧卡形态）。此改动属前端展示层，与 `AskUserCard` 族同域；**可独立 staging**，但本刀验收要求至少「假设区块」可见（范围区块可随 scope 可选性滞后）。

### 3.4 不动的部分

- `plan-gate.ts` 的 `decision` 语义、超时/中止铁律（B-4）一律不变。
- `overwriteTodos` 落清单逻辑、`snapshot`/`diff` 结构不变。
- `explanation` 语义回归纯「思路概述」；Skill SOP 纪律可提示「假设放 assumptions、思路放 explanation」，但运行时不强校验分流。

---

## 4. 裁决

- **D1 字段形态**：`assumptions: string[]`（每条一句假设）、`scope: { inScope: string[]; outOfScope: string[] }`（§16.5「assumptions[] + scope」的字面落地）。
- **D2 必填性**：schema `min:0`（向后兼容）；「非平凡方案应带假设」由 C-1 eval 判据（D4）+ SOP 纪律承载，不在工具层硬拒（避免误伤旧调用）。
- **D3 与 A-2' 边界**：A-3 不引入跨工具 id 引用；假设是纯文本，不引用任务 `id`（那属路标 No-Go 之外的后续，且本次不做）。
- **D4 eval 判据（扩展 C-1）**：在 C-1 canvas 拆解 eval 集增加「**假设显式化**」判据——`steps.length ≥ N`（如 ≥3）或涉及写操作的方案，若 `assumptions` 为空且无 `explanation` 内含假设句式，判 `decomposition-quality: weak`；命中则记观测指标 `pi_runtime_plan_assumptions_present{scenario}`。仅观测、不自动 replan（遵循路标阶段 C① 门禁）。
- **D5 前端 staging**：假设区块随本刀必上；范围区块可滞后一独立小刀，但本刀验收清单记一笔「范围区块待补」。
- **D6 默认值/回填**：不修改历史 `plan` 记录（append-only events.jsonl 不受影响）；新字段缺省即「未提供」，旧 transcript 自然无该键。

---

## 5. 与既有资产接口

| 资产 | 影响 |
| --- | --- |
| `tools/propose-plan.ts` | 新增 `assumptions` / `scope` 参数 + `plan` 工件透传 |
| `gate/plan-gate.ts` | **零改动**（只消费 `decision`） |
| `tools/todo.ts` / `task-state.ts` | **零改动** |
| 前端确认卡组件 | 扩展渲染 `question.plan.assumptions` / `scope`（D5） |
| C-1 eval 集（`2026-11-14-c1-*` 族） | 新增「假设显式化」判据（D4），扩展而非重写 |
| Skill SOP（`skills/task-decomposition/SKILL.md`） | 纪律⑥补充「假设入 assumptions、思路入 explanation」 |
| A-2' spec | 本刀兑现其 `:99/:109` 对 A-3 的引用 |

---

## 6. 验收标准（AC）

- **AC1**（schema）：`propose_plan` 参数含 `assumptions: string[]`（max 12）与可选 `scope:{inScope,outOfScope}`；旧调用不传不报错。
- **AC2**（透传）：`execute` 返回的 `details.plan` 与 `canvasCommands` 中 `ask_user` 的 `question.plan` 含 `assumptions`/`scope`（有则存在、无则缺省）。
- **AC3**（前端）：确认卡渲染「假设」区块（列表）；传 `scope` 时渲染「范围」区块（覆盖/排除分组）。
- **AC4**（回归）：`propose-plan.test.ts` 全绿，既有 decision/steps 断言不被破坏；`plan-gate` 相关测试不受影响。
- **AC5**（eval 扩展）：C-1 eval 新增假设显式化判据，可区分「带假设 / 无假设」两类方案并落指标，不自动 replan。
- **AC6**（SOP）：SKILL.md 纪律⑥含假设/思路分流指引，且 C-1 eval 验证模型经 SOP 触发后假设入 `assumptions` 比例提升（观测，非硬门禁）。

---

## 7. 变异自检（mutation）

- **M1**：删除 `assumptions` 透传 → AC2 断言 RED；恢复后 GREEN。
- **M2**：删 `scope` 透传 → AC2/scope 断言 RED；恢复 GREEN。
- **M3**：前端渲染分支改为恒不渲染 assumptions → AC3 断言 RED；恢复 GREEN。
- **M4**：C-1 eval 判据删「假设显式化」分支 → AC5 退化（weak 永不触发）→ RED；恢复 GREEN。
- 判 RED 用完整 stdout 退出码 + 漂移标记，不吃管道退出码（遵循保命纪律：BSD grep 用 `grep -E`、变异脚本防恒绿/恒红）。

---

## 8. 诚实边界

1. **假设真值不可机检**：本刀只结构化「假设存在/形态」，不验证「假设是否成立」。eval 判据仅查 presence/structure，不对假设内容做事实核查（那超出 canvas agent oracle 能力，路标 No-Go 已排除）。
2. **`min:0` 的非强制**：schema 不强制假设，弱方案仍可能不带假设通过运行时——质量提升依赖 SOP + eval 观测，非硬拦截。
3. **前端 staging 风险**：若前端渲染滞后，假设虽进 `plan` 工件但用户看不见；本刀验收要求假设区块至少上线，范围区块可滞后（D5）。
4. **不作「验收完成」结论**：含前端改动，需 CI 全绿 + 生产复测（确认卡实渲染）+ SOP 触发观测后才可宣告闭环。
5. **与路标冻结关系**：本文件是 §19.5 冻结后的细化产物，路标 SSOT 仅回填状态行（A-3 合入后于 §14 类状态表追加一行）。

---

## 9. 放行门禁

- 本刀**含前端代码**，非纯 docs-only → 合并前需**单独授权** + 生产复测（确认卡实渲染 assumptions/scope 区块、plan-gate decision 行为零变化、C-1 eval 新判据基线建档）。
- 推 PR 前基于 `gh api tarball/master` 干净快照重建（保命纪律：绝不读脏工作树）；逐路径 blob 比对 + compare `DELTA` 核验。
- 合入后 `services/pi-runtime` / `skills` 不在 `deploy.yml` paths → 须手工 dispatch `runtime-deploy.yml`（tag=合并后 master 短 SHA）+ `production-runtime` 闸门审批。
- 路标 §14 类状态表追加 `A-3 声明式假设/范围字段 | ✅ 已合并上线 | PR #___ → squash <sha> → pi-runtime 上线；确认卡渲染 + C-1 eval 假设判据扩展`。
