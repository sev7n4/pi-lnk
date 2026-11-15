# A-3 propose_plan assumptions/scope — 实施计划

> spec：`docs/superpowers/specs/2026-11-15-a3-propose-plan-assumptions-design.md`（设计稿·待评审）
> 基准：master `efcfe756` 干净 tarball（`/tmp/a3-src/sev7n4-pi-lnk-efcfe75`）；本计划与 spec 同 PR 落档。

## 1. 改动面（7 文件，含 2 测试）

| # | 文件 | 改动 | 对应 AC |
| --- | --- | --- | --- |
| 1 | `services/pi-runtime/src/tools/propose-plan.ts` | 参数增 `assumptions`(Optional, string[], min1 max12) / `scope`(Optional {inScope,outOfScope})；`planMeta` 透传进 `question.plan` 与 `details.plan`；调用 `metrics.observePlanAssumptions` | AC1/AC2 |
| 2 | `services/pi-runtime/src/metrics.ts` | `planAssumptions` Map + `observePlanAssumptions(present)` + `pi_runtime_plan_assumptions_total{present}` 暴露 | AC5 观测面 |
| 3 | `services/pi-runtime/src/tools/propose-plan.test.ts` | stub 补 `observePlanAssumptions`；+2 用例（透传 present / 缺省键不出现 absent） | AC4/AC2 |
| 4 | `apps/web/src/components/agent/AskUserCard.vue` | plan 类型扩展；模板加「假设/范围」区块（v-if 有则渲染）；样式只消费 `--lnk-*` 令牌 | AC3 |
| 5 | `apps/web/src/stores/agent.ts:819` | trackAskUser 内联 plan 类型同步扩展（纯 TS，运行时本就透传） | AC3 |
| 6 | `apps/web/src/components/agent/AskUserCard.plan.test.ts`（新建） | 3 用例：假设区渲染 / 范围两行 / 缺省不渲染 | AC3 |
| 7 | `skills/task-decomposition/SKILL.md` 纪律③ | 补「假设入 assumptions、思路入 explanation、边界入 scope」分流指引 | AC6（SOP 面） |

## 2. 实施分期（本刀 vs 后续刀）

- **本刀**：上表 7 文件 = schema + 透传 + 渲染 + 打点 + SOP。
- **后续刀（不在本 PR）**：① C-1 eval 新增「假设显式化」判据 case（AC5 判据面——需 C-1 框架内造 case，独立小刀）；② 时间线 plan part（P1-2 存档）同步展示 assumptions（存档面，独立小刀）。PR 正文如实声明。

## 3. 验证

- 离线：`node --import tsx --test services/pi-runtime/src/tools/propose-plan.test.ts`（9/9）+ `vitest run AskUserCard.plan AgentTurnTimeline.plan`（干净树装 `@lnkpi/web` 依赖后跑）。
- 类型权威 = CI Build monorepo（本地 pi-agent-core 陈旧 0.85.1，tsc 基线报错为已知噪声）。
- 变异自检：M1 删 assumptions 透传→AC2 RED；M2 删 scope 透传→RED；M3 前端恒不渲染→AC3 RED；M4 删打点调用→absent/present 断言 RED（spec §7）。

## 4. 放行

- 推 PR 后停在合并前等单独授权（含前端代码，非 docs-only）。
- 合并后需手工 dispatch `runtime-deploy.yml`（skills + pi-runtime dist 变化）+ `production-runtime` 闸门 + 生产复测（确认卡渲染 + plan-gate 行为零变化 + 指标出现）。
