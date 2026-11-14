# C-2a · acceptance 生成 oracle 子域：实施计划（2026-11-14）

> 规格：`docs/superpowers/specs/2026-11-14-c2a-acceptance-generation-oracle-design.md`
> 基线：`master 3811c3f2` 干净快照 `/tmp/c2-work`（tarball 解包，非本地工作树）。
> 纪律：TDD（RED→GREEN）、变异自检必 RED、断言禁 `as never`、tools 层 `node --import tsx --test`（非 vitest）、PR 正文回读长度、CI 全绿停合并前等单独授权。

## 步骤（每步可独立验证）

### S1 · 纯判据层（零生产接线，可先 RED→GREEN）
- 新文件 `services/pi-runtime/src/tools/acceptance.ts`：
  - `export interface GenerationLatest { id: string; status: string; createdAt?: string }`
  - `export type AcceptanceRequirement = { requireSucceeded?: boolean }`
  - `export function judgeGenerationAcceptance(latest: GenerationLatest | undefined, req: AcceptanceRequirement): { ok: true } | { ok: false; evidence: string }`
  - `export function parseAcceptance(value: unknown): { ok: true; requirement: AcceptanceRequirement } | { ok: false; reason: string }`（守卫式解析，禁 `as` 强转；kind `"generation"` 封死）
  - `export interface GenerationOracle { inspect(...): Promise<...> }`
  - `export function createNestGenerationOracle(client: NestClient): GenerationOracle`（POST `/agent/internal/list-generation-tasks`，守卫解析 `data.tasks[0]`；异常统一转 `{ok:false,reason}`）
- 新文件 `services/pi-runtime/src/tools/acceptance.test.ts`：判据 7 例 + 解析 5 例 + oracle 适配 3 例（含 200 包络错误/形态不符/恰好 50 条不截断）。
- 验证：`PATH=$HOME/.nvm/versions/node/v24.13.0/bin:$PATH node --import tsx --test src/tools/acceptance.test.ts`（cwd=`services/pi-runtime`）。

### S2 · schema + execute 校验（本刀核心）
- `tools/task-state.ts`：`TodoItem` 增 `acceptance?: TodoAcceptance`（纯类型，字段形状对齐 §4.1；`TodoItemInput` 继承不变）；`TodoAcceptance` 类型在此定义或从 acceptance.ts 导入（选后者，避免两处定义漂移）。
- `tools/todo.ts`：
  - `todoSchema` item 增 `acceptance: Type.Optional(acceptanceSchema)`（从 acceptance.ts 导出 TypeBox 定义或就地声明，保证与 parseAcceptance 语义一致）；
  - `buildTodoTools(deps: TodoToolDeps = {})`，零参兼容；
  - execute 内按规格 §4.2 顺序：收集 → `parseAcceptance` 结构校验（硬拒）→ 开关/依赖 fail-open → 一次 `oracle.inspect` → `judgeGenerationAcceptance` → fail-closed 硬拒（同 A-2' 回执：当前快照 + `diff.updates=[]`）→ 正常写入；
  - 硬拒文案含「期望/实际证据差 + 当前清单不变 + 请继续干活或如实降级」；fail-open 软提醒追加到 `content` 末尾；
  - `isAcceptanceEnabled()`（`PI_RUNTIME_ACCEPTANCE !== "off"`）。
- `tools/todo.test.ts` 新 9 例（规格 §6），保持既有 17+ 例全绿。

### S3 · 生产接线 + 指标
- `tools/config.ts`：`client` 存在时注入 oracle 与 `onAcceptanceOutcome`；纯文本模式零参不变；`isAcceptanceEnabled()` 参与注入判定。
- `metrics.ts`：新增 `private acceptance = new Map<string, number>()`、`observeAcceptance(outcome: "declared"|"pass"|"fail_closed"|"fail_open")`、render 段 `pi_runtime_acceptance_total{outcome="..."}`（空 Map 不渲染数据行）；`metrics.test.ts` 补 1 例断言渲染。
- `tools/config.test.ts` 或新 wiring 守卫：断言生产工具表的 `todo_write` 参数含 `acceptance` 且注入生效（fake NestClient 可不发请求，只查接线）。

### S4 · 最小教学 + wiring 守卫
- `skills/task-decomposition/SKILL.md` 纪律 ⑥ 追加一句（规格 §4.4）；
- `services/pi-runtime/src/skills/task-decomposition.wiring.test.ts` 加 body 关键句守卫（`acceptance` / `kind` / `requireSucceeded`）。

### S5 · 全量验证 + 变异自检
- `node --import tsx --test "src/**/*.test.ts"`（node24，`--test-concurrency=1` 视环境）；
- 根仓全量：`env -u NODE_OPTIONS pnpm -r --if-present test`；`vue-tsc -b` 不带 `--noEmit`；L0 eval 与全量 eval 按既有命令；
- **变异清单**（每个必须 RED，记录结果）：① `judgeGenerationAcceptance` 恒 true ② fail-open 分支改 fail-closed ③ hard-reject 移到 `overwriteTodos` 之后 ④ 空集也调 oracle ⑤ `parseAcceptance` 去掉 kind 校验 ⑥ config 生产不注入 oracle（wiring 守卫须 RED）。

### S6 · 文档状态回填 + 推 PR
- 路标 spec **只回填状态行**（本刀立项 spec/plan 落档，不追加整章，§16.3 冻结）；
- 工作日志 `.workbuddy/memory/2026-11-14.md` 追加；
- REST 推 PR（blob→tree(`base_tree` 只传改动路径)→commit→ref→PR）：推前逐路径裸 blob sha 比对 master，推后 `compare` 核验 `DELTA=改动路径` + `ALL_PARALLEL_KEPT`；PR 正文回读长度（禁 @文件路径静默丢内容）；
- CI 三 check 全绿 ⇒ **停合并前等用户单独授权**（用户惯例；合并会触发手工部署链）。

### S7 · 授权后全链（本计划不预执行）
合并树==CI head 树核验 → 手工 dispatch runtime-deploy（JSON body，tag=merge sha）→ `pending_deployments` 数字 env id 审批 → 上线取证（pod image/env + 容器内特征串 grep + Nest 零扰动）→ 真实模型探针复测（429 墙需重试/间隔）→ 状态回填。

## 文件清单（预计 DELTA）

| 路径 | 动作 |
|---|---|
| `docs/superpowers/specs/2026-11-14-c2a-acceptance-generation-oracle-design.md` | 新增 |
| `docs/superpowers/plans/2026-11-14-c2a-acceptance-generation-oracle-plan.md` | 新增（本文件） |
| `docs/superpowers/specs/2026-11-11-task-planning-engineering-roadmap-design.md` | 状态行回填（1 行） |
| `services/pi-runtime/src/tools/acceptance.ts` + `acceptance.test.ts` | 新增 |
| `services/pi-runtime/src/tools/task-state.ts` | 类型增字段 + reduce 四分支显式列字段（acceptance 是调用级声明，不进快照 SSOT） |
| `services/pi-runtime/src/tools/todo.ts` | schema/execute 校验（零副作用硬拒唯一构造点） |
| `services/pi-runtime/src/tools/todo.acceptance.test.ts` | 新增 9 例（独立文件，既有 todo.test.ts 零改动） |
| `services/pi-runtime/src/tools/acceptance.wiring.test.ts` | 新增接线守卫三段 |
| `services/pi-runtime/src/tools/config.ts` | 生产注入 oracle + 指标回调（纯文本模式零参不变） |
| `services/pi-runtime/src/metrics.ts` | 指标 `pi_runtime_acceptance_total{outcome}` |
| `skills/task-decomposition/SKILL.md` + `task-decomposition.wiring.test.ts` | 最小教学 + 守卫 |

## 验收门槛（本刀「完成」的定义，不宣告未闭环项）

- 全量测试绿 + L0/eval 绿 + 变异自检 6/6 RED；
- PR CI 三 check 全绿、DELTA 恰为计划路径、合并树==CI 验证树（合并后）；
- 生产取证 4/4 + 行为探针（若 429 墙仍阻断，如实记录为环境限制，不以结构证据冒充行为闭环）；
- C-1a/C-1b 基线回填仍欠（429 墙），§8.6 观测数据仍只到「自纠 1/1」，不宣告 ALL_PASS。
