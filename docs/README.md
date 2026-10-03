# docs 目录说明

整理于 2026-10-03。

## 保留的目录

| 目录 | 内容 | 性质 |
|---|---|---|
| `workflow/` | Agent 工作流交换契约（`README.md` + `examples/*.json`） | **活跃资产** —— 外部 Agent（WorkBuddy / Codex 等）靠它生成可导入画布的 JSON。校验函数是 `@lnkpi/shared` 的 `validateWorkflow`，代码里由 `useWorkflowExchange.ts`、`compositionLint.ts` 等消费。**不要删。** |
| `superpowers/` | 历史 spec 与 plan（`plans/` 284 份中的两部分：specs 138 / plans 146，5.7M） | 历史决策与实施记录。⚠️ **无索引平铺**，查特定主题需按文件名日期定位。 |
| `discussion/` | 讨论文档（第一资产） | 项目方向与决策来源 |
| `ops/` | 部署 runbook | 生产运维 |

## 已删除的目录（2026-10-03）

以下目录**无代码引用**，且内容为已完成的阶段性产物，故删除：

| 已删目录 | 删除原因 |
|---|---|
| `adr/` | 3 份 ADR 全是 **LangGraph 时代产物**（"Subgraph vs LangGraph Subgraphs"、"Atomic Studio vs Campaign Orchestration Boundary" 等），而老 LangGraph Runtime 已彻底退役（`services/agent-runtime` 已删除，pi-runtime 是唯一链路）。决策本身已完成使命。 |
| `mockups/` | 3 份 UX 线框稿，对应实现均已在代码里：<br>· `agent-progress-ux-system.html` → `apps/web/src/components/agent/turnStatusBar.ts`、`activityLine.ts`<br>· `agent-background-tasks-card.html` → `AgentTaskProgressCard.vue`<br>· `agent-queued-message-card.html` → `queueDelivery.ts` |
| `diagnostics/` | `2026-09-30-agent-architecture-diagnosis.html` —— 一次性架构诊断报告（对照 Codex / Claude Code / WorkBuddy），无后续演进价值。 |
| `archive/` | `2026-09-20-branch-cleanup.md` —— 2026-09-20 的一次性分支清理留痕（99 → 18 个分支）。**同类信息现由 `AGENTS.md` 的「分支纪律」与 `branch-first-dev-workflow` skill 承载**，留旧文档反而会让人以为还有第二套规则。 |

**删除前已核实**：这 4 个目录在 `apps/` `packages/` `services/` `charts/` `deploy/` 里的引用数均为 **0**。

## 已知的历史文档断链

`superpowers/` 下的历史 plan/spec 有 4 处指向已删文件。这些引用本身是**历史任务描述或模板参考**，不是需要保持可用的活跃链接，因此**未做修改**（改历史记录比留死链更糟）：

| 引用方 | 原引用 |
|---|---|
| `superpowers/specs/2026-09-19-pi-lnk-fast-ramp-k3s-design.md:973` | 参考 `docs/adr/p4-atomic-create-adr.md` 等 ADR 模板 |
| `superpowers/plans/2026-08-04-atomic-intent-hybrid-phases.md:346` | Create `docs/adr/p5-atomic-orchestration-boundary-adr.md` |
| `superpowers/plans/2026-08-07-platform-route-skill-boundary.md:70,581` | Modify `docs/adr/p5-atomic-orchestration-boundary-adr.md` |
| `superpowers/specs/2026-08-07-platform-route-skill-boundary-design.md:6` | supersede `docs/adr/p5-...` 规则 3 |
| `superpowers/plans/2026-10-01-agent-progress-visible.md:15` | Spec 来源 `docs/mockups/agent-progress-ux-system.html`（线框稿，四张图与「待决项 1-10」即该计划任务来源） |
| `superpowers/plans/2026-09-30-compaction-wiring.md:11` | Spec 来源 `docs/diagnostics/2026-09-30-...html` §06 F-01 |

> 若日后需要追溯这些内容，从 git 历史取回：
> `git show <commit>:docs/adr/p5-atomic-orchestration-boundary-adr.md`
> （删除前的最后一个 commit 即删除前状态）

## 待决策：`superpowers/` 规模

`superpowers/` 下有 **284 份文档、5.7M、无索引平铺**：

| 月份 | 份数 |
|---|---|
| 2026-07 | 41 |
| 2026-08 | 79 |
| 2026-09 | 155 |
| 2026-10 | 8 |

这是 docs 里体量最大、最难维护的部分。**是否要按时间线归档/精简，需要单独决策**（如"保留 discussion + 近两月，其余移入 archive 或删除"），
涉及取舍偏好，不宜由 agent 自行决定。
