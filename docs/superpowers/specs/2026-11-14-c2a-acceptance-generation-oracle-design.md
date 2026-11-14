# C-2a · acceptance 生成 oracle 子域：立项规格（2026-11-14）

> 路标 SSOT：`docs/superpowers/specs/2026-11-11-task-planning-engineering-roadmap-design.md` §14（C-2）/ §19.1（v1.3 减法）/ §16.3（规格冻结）。
> **按 v1.3 冻结裁决**：路标评审完毕，本刀所有细化只进本 spec；路标仅回填状态行，不改正文。
> 依赖链：A-2' 模型侧稳定 id（PR #863 合 `c9ca3641`，生产 4/47 断裂已消解）→ Skill SOP（PR #864 合 `3811c3f2`，生产复测闭环）→ **C-2a（本刀）**。
> 基线快照：`gh api .../tarball/3811c3f2`，master HEAD=`3811c3f2`。

## 1. 目标与非目标

**目标**：让 todo item 可以**声明一条可机检的收尾验收判据**；模型把带判据的项标 `completed` 时，生产侧用生成 oracle 查证；证据不支持则**零副作用拒绝该 todo_write**，并附证据差回执供模型自纠/如实降级。首期只做 `kind="generation"` 子域（§14.5 分期 C-2a，信号最硬）。

**非目标（明确不做，防范围膨胀）**：
- 不做 `canvas_state` / `user_confirm` kind（C-2b），不在 schema 暴露尚未校验的枚举；
- 不强制模型声明 acceptance（§14.4 豁免面：探索/澄清类任务无 oracle）——「声明即校验」，写入率是观测指标而非硬性门槛；
- 不改 C-1 eval 判据（Q3 收尾断言入 C-2c；C-1a/C-1b 基线仍被 agnes 429 实名墙挡住，跨时段 AB 不可控）；
- 不新增自由文本字段（`note` 类，§19.1 减法裁决）；不引入独立验收器/新工具族/子代理；
- 不判「用户满意/效果好看」（§14.2 设计意图：不可机检的验收不许声明）。

## 2. 立项前接口事实核验（对抗性复核，纠正路标 §14.1 陈旧锚）

| 事项 | 路标 §14.1 表述 | 快照实证 | 对本刀的影响 |
|---|---|---|---|
| `after_tool` 位置 | `session-manager.ts:616` HITL Gate、`:1704-1710` 增量观测 | 真实：HITL Gate 在 `index.ts:95-240`（`onSessionCreated`），`after_tool` 增量观测在 `session-manager.ts:1837-1844`；`:616` 现为 `turnBudgetLimit?: number`、`:1704` 为 `entry.currentRunId = undefined` | 行号纠偏，不影响机制存在性 |
| **拒绝语义** | 「after_tool 收尾校验是既有钩子的第二消费者」 | ⭐ `after_tool` 在工具 **执行后** 触发：vendor `agent-harness.ts:478-486` 只允许 patch `content/details/isError/usage/terminate`；`hooks.ts:294-335` 链式 replace。**此时 `overwriteTodos` 内存写入已发生、事件已投影**，得不到 §14.3 要求的「拒绝该 todo_write」 | **裁决 D1（见 §3）** |
| 生成 oracle | 「`get_generation_status`/`list_generation_tasks` 底层直接复用」 | `get_generation_status` 入参只有 `node_id`（无 taskId）、`status=String(node.data?.status ?? 'draft')` 自由字符串；`list_generation_tasks` 强依赖 `userId`，`studio.listGenerations` 已 `orderBy createdAt desc, take 50`（首项=本会话最新），`trimData` 只在 **>50** 时截断（恰好 50 不截） | **裁决 D2（见 §3）** |
| DSL 共享面 | 「与 C-1 §8.3 同一套」 | `golden-cases.ts:76-80` 实际只实现 `nodeCount` / `nodeTypeCounts` / `generationSubmitted`；`noOverlap` / `generationSucceeded` **代码零实现**（只存于 spec 草案） | **裁决 D3（见 §3）** |
| 工具装配 | — | `buildTodoTools()` 零参（`todo.ts:108`），生产装配 `tools/config.ts:59,80`；`resolveToolsWithClient` 持有 `NestClient`（纯文本模式 `client=null`）；`LnkpiToolContext` 是纯数据（无 client 字段） | 注入点成立，且零参调用（大量既有测试）必须保持兼容 |
| SKILL.md 编号 | SOP 设计 spec 映射表写「第 7 条完成须证据」 | SKILL.md 实际 **7 条**，不谎报完成是第 **⑥** 条（`:43-44`），⑦ 是派发；SKILL.md 全文无 C-2 字样 | 教学改在纪律 ⑥，编号按实际文件 |

## 3. 三项裁决

- **D1 · 校验位置 = `todo.ts` execute 内，不用 after_tool。**
  §14.3「拒绝该 todo_write」与 §11.3 拍板 1（A-2' 幻觉 id 硬拒）哲学同构，硬条件是**零副作用**：A-2' 的 `rejectUnknownIds` 正是先于 `overwriteTodos` 返回 `isError:true` + `details.todo.diff={updates:[]}`（`todo.ts:130-141`）。after_tool 只能给「错误回执 + 状态已写入 + `task_list` 已投影」的组合，是**伪拒绝**。另两个候选：`before_tool` 的 `block`（`index.ts:226-239` 先例）虽能零副作用，但校验逻辑散到 hook 层、拿不到 `toolContext.storeScopeKey`、且 hooks 缺席 fail-soft；execute 内与 A-2' 同处、同回执形态、同测试面。**路标 §14.1「after_tool 第二消费者」在本刀按本裁决实例化，不修改路标正文。**
- **D2 · oracle = 会话级最新生成任务，DSL 不新增锚点字段。**
  复用 `list_generation_tasks`（`sessionId` + `userId`），取返回 `tasks[0]`（服务端已 desc 排序）。判据：
  - `requireSucceeded: true` ⇒ 最新任务 `status === "succeeded"`；
  - 缺省（submitted 级）⇒ 本会话存在生成记录。
  与 C-1 §8.3 `generationSubmitted` 的**会话级布尔语义**对齐（该判据查 transcript 是否有 `propose_generation`，同样是会话级）；不新增 `nodeIds[]`：草稿 §14.2 只给 `{requireSucceeded?: boolean}`，加字段属 §19.1 禁止的字段膨胀，且节点 id 由模型手写会引入新的引用完整性问题（A-2' 刚处理过一轮）。**诚实边界**：会话级判据不能证明「这一项对应的那次生成」成功，只能证明「收尾时本会话最近一次生成成功/存在」；历史生成污染与多任务混淆留 C-2b 的 canvas_state 子域解决。
- **D3 · 分期落地「一套 DSL」的真实子集。**
  C-2a 只暴露 `kind: Literal("generation")` + `generation?: { requireSucceeded?: boolean }`；`canvas_state` 的 `nodeCount` / `nodeTypeCounts` 复用 `judgeCanvasState` 留 C-2b（`noOverlap` 无实现，不承诺）；`user_confirm` 留 C-2c。**枚举封死仍然成立**：不是放开自由文本，而是只注册已实现校验的枚举值，避免「写了不校验」的伪验收。

## 4. 契约设计

### 4.1 schema（TypeBox，挂在每个 todo item 上）

```ts
const acceptanceSchema = Type.Object({
  kind: Type.Literal("generation", { description: "生成类收尾验收：要求本会话最近一次生成有证据" }),
  generation: Type.Optional(Type.Object({
    requireSucceeded: Type.Optional(Type.Boolean({
      description: "true=要求最近生成 status=succeeded；缺省=仅要求已提交生成记录（弱判据）",
    })),
  })),
}, { description: "可选。仅当本项标 completed 时生效；不接受自由文本/主观描述" });
```

- `acceptance?: ...` 可选（§14.4 豁免面）；**kind 缺失或未知 = 字段非法**，双保险：TypeBox required/Literal 由 harness 参数校验拦一层，execute 内再显式校验一层（模型未必遵守 schema，A-2' 硬拒同款纪律）；
- `generation` 缺省 = submitted 级；不存在「显式声明 submitted」第三种形态（§14.4 v1.3 措辞修正）；
- `requireSucceeded` 只在 `kind="generation"` 内有意义（C-2a 唯一 kind，无需交叉约束）。

### 4.2 校验流程（execute 内，先于任何写入）

1. 收集 `params.todos` 中 `status === "completed" && acceptance !== undefined` 的项；**空集 ⇒ 逐字节旧行为**（不查 oracle、不改回执、不计数）。
2. 结构校验：kind 必须是 `"generation"`，`requireSucceeded` 若存在必须是 boolean ⇒ 违规：**zero-side-effect 硬拒**（`isError:true` + 当前快照 + `diff.updates=[]`，同 A-2' 回执形态）。
3. 开关/依赖：kill switch `PI_RUNTIME_ACCEPTANCE === "off"`、未注入 oracle（纯文本模式 / 零参测试）、`userId` 缺失 ⇒ **fail-open 放行**（不查），逐字节旧行为；生产注入齐全才进入查询。
4. 调 oracle **一次**（多个 completed 项合并一次查询，性能上界=1 次 Nest 调用/todo_write）：
   - 查询异常（http/envelope/timeout/network/circuit_open、返回形态不符）⇒ **fail-open**：放行 + `content` 追加一行软提醒（模型可见）+ 计数 `fail_open` + `console.warn` 留痕。理由 §14.3：环境故障不伪装成模型作弊。
   - 查询成功 ⇒ 对每项跑纯函数 `judgeGenerationAcceptance(latest, requirement)`：
     - **任一不满足 ⇒ fail-closed 硬拒**：`isError:true`，回执 = 期望 vs 实际证据差（期望 succeeded/已提交；实际 `status=xxx`（task id=...）或「无生成记录」）+ 当前清单不变说明 + 「请继续干活或如实降级，不要标 completed」；`details.todo.snapshot=当前清单`、`diff.updates=[]`（零事件、零副作用）；计数 `fail_closed`。
     - 全通过 ⇒ 正常 `overwriteTodos` 写入，计数 `pass`。
5. 计数 `declared`：步骤 1 命中即打（写入率分子）；分母取既有 `tool_calls_total{tool="todo_write"}`（事件层已有，不新增指标）。

### 4.3 可注入依赖（工具层不持 Metrics / 不持 NestClient 实例）

```ts
export interface GenerationOracle {
  inspect(input: { sessionId: string; userId: string }): Promise<
    | { ok: true; latest?: { id: string; status: string; createdAt?: string } }
    | { ok: false; reason: string }
  >;
}
export interface TodoToolDeps {
  oracle?: GenerationOracle;                       // 生产注入 NestGenerationOracle
  onAcceptanceOutcome?: (o: "declared"|"pass"|"fail_closed"|"fail_open") => void;
}
export function buildTodoTools(deps: TodoToolDeps = {}): LnkpiTool[]  // 零参兼容
```

- 生产实现 `createNestGenerationOracle(client: NestClient)`：POST `/agent/internal/list-generation-tasks`，守卫式解析 `payload.data.tasks`（`JsonValue` 不 `as` 强转，仿 `hook-contract.ts`）；取 `tasks[0]`，`status` 按字符串比对（**非枚举**，Nest `nodeStatus` 是自由串）；
- `tools/config.ts`：`client` 存在时 `buildTodoTools({ oracle: createNestGenerationOracle(client), onAcceptanceOutcome: (o) => metrics.observeAcceptance(o) })`；纯文本模式仍零参；
- 超时：**沿用 NestClient 默认 10s**（`list-generation-tasks` 无 override），不新增参数，超时归 fail-open；
- `metrics.ts` 新增 `pi_runtime_acceptance_total{outcome}` counter（Map 空不渲染数据行，同 `skill_loads_total` 范式）。

### 4.4 最小教学（提高写入率，同刀）

`skills/task-decomposition/SKILL.md` 纪律 **⑥「不谎报完成」** 追加一句：「生成类任务收尾时在清单项上写 `acceptance:{kind:"generation"}`（要求确认生成成功时加 `requireSucceeded:true`）——证据不足会被工具拒绝并附证据差」。`task-decomposition.wiring.test.ts` 加一段 body 关键句守卫。
> ⚠️ 诚实边界：SKILL.md 文本变更 ⇒ SOP 刀「激活率」长线观测以本刀上线为新起点（跨文本版本不可直接 AB）。

## 5. 观测面（§14.5 三指标，本刀只建「可查」不设阈值）

| 指标 | 本刀可得 | 说明 |
|---|---|---|
| 写入率 | `declared / tool_calls_total{tool="todo_write"}` | 声明即校验；趋零 ⇒ 按 §14.5 止损（kill switch 一行） |
| fail-closed 拦截率 | `fail_closed / declared` | 真问题发现率；需真实流量累积，本刀不拍阈值 |
| fail-open 率 | `fail_open / declared` | 机制健康度；Nest 故障会抬高 |

C-2c 才做基线建档与阈值提案（人工拍板），本刀不拍数、不宣告验收。

## 6. 测试计划（tools 层用 `node:test` + `node --import tsx --test`，非 vitest）

- **纯判据单测**（`judgeGenerationAcceptance`）：succeeded 级通过 / 失败 status / 无记录 / submitted 级通过 / 无记录失败 / 未知 status 字符串 / `requireSucceeded` 非 boolean 结构非法；
- **todo.test.ts 新例**：① acceptance 通过正常写入（diff 正常）② fail-closed `isError` + 快照不变 + `diff.updates=[]` ③ oracle 抛错 fail-open 放行 + 软提醒 + 回调计数 ④ kind 缺失/未知硬拒 ⑤ 无 acceptance 逐字节零差异（不调 oracle）⑥ pending/in_progress 带 acceptance 不查 ⑦ kill switch off 不查 ⑧ 多个 completed 项只查一次 ⑨ userId 缺失 fail-open；
- **wiring 守卫三段**（仿 `html-craft.wiring` / SOP 刀）：schema 暴露 `acceptance` 且 kind 枚举封死 / `config.ts` 生产注入 oracle + 指标接线 / SKILL.md 纪律 ⑥ 关键句；
- **变异自检**（必须 RED）：判据恒真/恒假、fail-open 改 fail-closed、硬拒改为写入后回执、空集误查 oracle、结构校验删除——任一变异未 RED 先疑伪变异与判据自匹配恒绿；
- 回归：既有 `todo.test.ts` / `task-state.test.ts` / `session-manager.*` 全量绿；L0 eval + 全量测试套件（按记忆纪律：nvm node24、`--maxWorkers=1 --no-file-parallelism`）。

## 7. 部署与上线（复用前两刀路径）

- 改动落在 `services/pi-runtime/**` 与 `skills/**`，**deploy.yml 两个都不含** ⇒ 合并后零自动发布，须手工 dispatch `runtime-deploy`（JSON body + `pending_deployments` 数字 env id 审批）；
- 上线取证：pod image/env 版本 + 容器内 `dist/tools/todo.js` grep `acceptance` 特征串 + `/app/skills/task-decomposition/SKILL.md` 新句 + Nest 零扰动；
- 生产行为复测（授权后）：真实模型探针观察 ①带 acceptance 的 completed 项在证据不足时被拒 ②模型按证据差自纠或如实降级 ③指标 `pi_runtime_acceptance_total` 可查；agnes 429 实名墙仍在 ⇒ 探针须带重试+间隔，环境失败不计判据。

## 8. 风险与回滚

- **写入率趋零**（模型不声明 ⇒ 机制空转）：kill switch `PI_RUNTIME_ACCEPTANCE=off` 一行回滚；不删 schema（C-2b 需要）；
- **伪拒绝回归**：D1 是最强约束，测试 ② 与变异「硬拒改为写入后回执」守此红线；
- **oracle 抖动放大 fail-open**：已有软提醒 + 计数；不新增重试（NestClient 自身熔断/超时已存在）；
- **跨会话污染**：`list_generation_tasks` 按 `sessionId` 过滤，但同一画布会话内历史生成会影响「最新」——诚实边界写入 §3 D2，C-2b 用 canvas_state 细化；
- **429 墙**：行为跑批/基线回填仍被 agnes 平台「请实名认证」阻断（run3 终局 error 6/fail 3/pass 0），本刀不依赖跑批数据，不宣告 C-1a/C-1b 闭环。
