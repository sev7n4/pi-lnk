# 实施计划：C-2b canvas_state 扩展 + isError 语义补正（双刀单 PR）

> 日期：2026-11-14 · 对应规格：
> - `docs/superpowers/specs/2026-11-14-c2b-acceptance-canvas-state-design.md`
> - `docs/superpowers/specs/2026-11-14-iserror-rejection-flag-design.md`
>
> 工作区：干净 tarball 快照 `/tmp/c2b-work`（master `685bdb49`）。**不在主仓工作树改代码**（源码常陈旧）。
> 测试：`PATH=$HOME/.nvm/versions/node/v24.13.0/bin:$PATH env -u NODE_OPTIONS node --import tsx --test ...`

## 阶段划分（每阶段可独立验证，失败即停）

| 阶段 | 归属 | 内容 | 完成判据 |
|---|---|---|---|
| S1 | C-2b | 新建 `src/canvas-judge.ts` + `.test.ts`；`eval/golden-cases.ts` 改 import/继承/薄封装 | eval 侧全量测试零回归；`judgeCanvasState` 签名不变 |
| S2 | C-2b | `acceptance.ts` 扩 DSL / `CanvasOracle` / `createNestCanvasOracle` / `judgeCanvasAcceptance` + `.test.ts` 新例 | 纯函数测试全绿；结构非法守卫覆盖 kind/载荷匹配/至少一谓词/min≤max |
| S3 | C-2b | `todo.ts` 多 kind verdict 聚合（`reject>fail_open>pass`）+ `todo.acceptance.test.ts` 新例 | C-2a 既有 9 例零回归 + 多 kind 组合新例全绿 |
| S4 | C-2b | `config.ts` 注入 canvasOracle；`metrics.ts` 增 `pi_runtime_acceptance_kind_total`；`acceptance.wiring.test.ts` 扩段 | wiring 守卫绿；纯文本零参模式逐字节旧行为 |
| S5 | isError | `rejectionResult` 增 `rejected:true`；新建 `src/tool-rejection-flag.ts` + `.test.ts`；`index.ts` 最前注册 | 单元测试 + **真实 harness 集成例**（`tool_execution_end.isError===true`）全绿 |
| S6 | isError | `extractTaskEvents` 兼容性回归测试（硬拒载荷仍返回 `[]`）；wiring 守卫（注册序 + 标记） | 前端侧零改动、测试证实兼容 |
| S7 | 双刀 | `SKILL.md` 纪律⑥ 教学句；路标 §14 **仅状态行**；两份 spec + 本 plan 定稿 | 文档与代码一致 |
| S8 | 双刀 | 全量测试 + tsc + 三静态门禁 + 变异自检 + 推 PR + CI | 见下「验证矩阵」 |

## 关键实施纪律

1. **判据共享（D1）**：`judgeCanvasCounts` 是**唯一**判据实现；`golden-cases.ts` 的 `judgeCanvasState` 只做转发。禁止在 `acceptance.ts` 复制判据逻辑。
2. **零副作用（C-2a 不变量）**：`overwriteTodos` 只在 verdict 非 reject 时调用；`rejectionResult` 的 `diff.updates=[]` 不许改。
3. **拒绝文案逐字节不变**：新增 `rejected` 标记只在 `details.todo`，`content` 一个字都不动（A-2' 自纠依赖）。
4. **fail-open 边界**：oracle 查询故障放行 + 软提醒 + 计数；但**不覆盖其他 kind 的 reject**（D4 优先级）。
5. **本机 tsc 基线**：本机 pi-agent-core 0.85.1 缺 `isError`/`details` 类型，允许既有基线错误；**不得新增**。CI Build monorepo（0.99.2）为类型权威。
6. **`as never` 禁用**；守卫用 `readRecord` / `readBooleanField`（`hook-contract.ts`）。
7. **变异判据**：用完整 stdout 的 `AssertionError` / `failing tests` 标记判 RED，不用被 `| tail` 吞掉的退出码。
8. **BSD grep 一律 `grep -E`**（BRE `\|` 在本机不生效，多次复踩）。

## 验证矩阵

| 项 | 命令 / 判据 |
|---|---|
| 全量单测 | `node --import tsx --test --test-concurrency=1 "src/**/*.test.ts"` ⇒ 全绿，新增例数可核对 |
| 类型 | `./node_modules/.bin/tsc --noEmit` ⇒ 无新增错误（基线 `isError` 错误除外） |
| 静态门禁 | `npx tsx scripts/verify-tool-contract.ts` / `verify-tool-tiering.ts` / `verify-spec-figures.ts` ⇒ 0 错误 |
| 变异（C-2b 8 项） | ① 上下界反转（eval+C-2b 同时红）② oracle 恒 ok ③ fail-open 改 fail-closed ④ 聚合忽略 reject ⑤ 去「至少一谓词」⑥ 生产不注入 ⑦ 误传 focus 截断 ⑧ kind counter 不渲染 |
| 变异（isError 5 项） | ① 去 `rejected` 标记 ② listener 恒 undefined ③ kill switch 失效 ④ 注册序后移 ⑤ 删 `diff.updates=[]` |
| PR 推前 | 逐路径**改动前基准**（tarball 原版）裸 blob sha vs master ⇒ `ALL_PARALLEL_KEPT` |
| PR 推后 | `compare` ⇒ `DELTA=预期路径`；正文回读长度一致 |
| CI | 三 check 全 success ⇒ **停合并前等单独授权** |

## 文件清单（预期 DELTA）

**新增**：`src/canvas-judge.ts`、`.test.ts`；`src/tool-rejection-flag.ts`、`.test.ts`；
`docs/superpowers/specs/2026-11-14-c2b-acceptance-canvas-state-design.md`、
`docs/superpowers/specs/2026-11-14-iserror-rejection-flag-design.md`、
`docs/superpowers/plans/2026-11-14-c2b-and-iserror-implementation-plan.md`（本文）；
可能的 `src/tools/todo.acceptance.canvas.test.ts`（若新增测试独立成文件）。

**修改**：`src/eval/golden-cases.ts`、`src/tools/acceptance.ts` + `.test.ts`、
`src/tools/todo.ts` + `todo.acceptance.test.ts`、`src/tools/config.ts`、`src/metrics.ts`、
`src/tools/acceptance.wiring.test.ts`、`src/index.ts`、`skills/task-decomposition/SKILL.md`、
`docs/superpowers/specs/2026-11-11-task-planning-engineering-roadmap-design.md`（仅 §14 状态行）、
`apps/server/src/agent/pi-runtime/pi-events.test.ts` 或等价（extractTaskEvents 兼容回归，若已有合适文件则就地加例）。

## 部署与上线取证（**合并授权后**才执行，本计划不含）

1. `gh api .../pulls/{n}/merge -X PUT -f merge_method=squash`；核验合并树/parent/逐路径 blob（master 可能并行前移）。
2. 手工 dispatch `runtime-deploy.yml`（JSON body `{"ref":"master","inputs":{"tag":<sha>,"feature_grep":...}}`）；`pending_deployments` 用**数字环境 id 23398119885** 批准。
3. 上线取证：pod `-n pi-lnk-runtime` 版本/env、容器内 dist 特征串、SKILL.md 新句、config 注入、Nest 零重启。
4. 生产复测：真实会话探针分别触发 `canvas_state` 证据不足硬拒与幻觉 id 硬拒，取证 `isError` / 快照不变 / 指标 kind 可查 / 429 如实记录。
