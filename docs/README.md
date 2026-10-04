# docs 目录说明

整理于 2026-10-03，2026-10-04 补提示词审计报告登记。

## 根目录的两份提示词工程审计报告

| 文件 | 内容 | 性质 |
|---|---|---|
| `2026-10-02-prompt-engineering-audit.html` | **Round 1 · 现状审视**：16 条缺口（P0×4 / P1×6 / P2×6）+ 五窗口路线图。基线 `0593c3d` | 活资产 —— 缺口清单仍是唯一一份完整 P0/P1/P2 分级 |
| `2026-10-02-prompt-engineering-audit-round2.html` | **Round 2 · 重构路线**：Round 1 每条建议 × vendor 能力对照（现成/半/未用三档）+方案 A/B/C + W1–W8 路线图。基线 `d574b8b` | 活资产 —— 唯一一份「哪条能吃 vendor、哪条要自建」的取证 |

配套的**进展对账**见
[`superpowers/plans/2026-10-04-prompt-audit-gap-status.md`](./superpowers/plans/2026-10-04-prompt-audit-gap-status.md)
—— 16 条缺口逐条对到 `origin/master 006af0a` 的代码事实。

⚠️ **这两份 HTML 曾一度丢失**：它们原本是未跟踪文件，一次 `git stash -u` 把它打进
`d31f739`（stash commit）后该 stash 被 drop，文件从工作区与 master 双双消失，
只存在于悬空对象里，靠 `git fsck --lost-found` 才捞回。2026-10-04 已恢复为 tracked。
**教训：审计报告这类"结论资产"必须入库，不能只放工作区。**

## Agent 工程规范（2026-10-04 整改）

| 文件 | 内容 | 性质 |
|---|---|---|
| [`../AGENTS.md`](../AGENTS.md) | **agent 在本仓库工作的唯一权威规范** —— 新增系统地图、角色边界、变更影响面矩阵、完成定义（DoD）、PR 规范 5 节；纠正 CI 触发面描述错误；计数改为可实测获取 | 活资产 —— **每次改动需回代码核实** |
| [`superpowers/specs/2026-10-04-agents-md-hardening-design.md`](./superpowers/specs/2026-10-04-agents-md-hardening-design.md) | 本次整改的设计规格（含身份三层归属的决策依据） | 活资产 |
| [`superpowers/plans/2026-10-04-agents-md-hardening.md`](./superpowers/plans/2026-10-04-agents-md-hardening.md) | 实施计划 | 活资产 |
| [`agents-md-review-2026-10-04.html`](./agents-md-review-2026-10-04.html) | AGENTS.md 评审报告（7 维度评分 + P0/P1/P2 问题清单），基线 `352b44f` | 活资产 —— **结论资产，已入库** |

⚠️ **本节的存在理由**：同目录的两份提示词审计 HTML 曾一度丢失（未跟踪文件被 `git stash -u`
打进 stash 后该 stash 被 drop），只存在于悬空对象里，靠 `git fsck --lost-found` 捞回。
**审计/评审报告这类"结论资产"必须入库，不能只放工作区。** 本次评审报告从创建起即为tracked。

⚠️ **外部引用契约**：`AGENTS.md` 的以下章节名被 ADR 与 charts README 按名引用，
**改动时必须保持标题文本不变**（注意部分标题含 emoji 与副标题，如`## ⭐ 分支纪律（最高优先级）`）：
`分支纪律` / `文档管理规范` / `pi 内核版本` / `端口约定` / `仓库结构` /
`必须先做的事` / `核心 skill 路由` / `本机环境`

引用方：`adr/0001`（pi 内核版本）、`adr/0008`（文档管理规范）、
`adr/0009`（pi-runtime 开发纪律）、`charts/pi-lnk-runtime/README.md`（端口表）。

## 保留的目录

| 目录 | 内容 | 性质 |
|---|---|---|
| `adr/` | **架构决策记录**（0001-0009 + 模板）—— 回答"为什么这么定"。Accepted 后不删不改，被取代标Superseded。说明见 `adr/README.md` |
| `workflow/` | Agent 工作流交换契约（`README.md` + `examples/*.json`） | **活跃资产** —— 外部 Agent（WorkBuddy / Codex 等）靠它生成可导入画布的 JSON。校验函数是 `@lnkpi/shared` 的 `validateWorkflow`，代码里由 `useWorkflowExchange.ts`、`compositionLint.ts` 等消费。**不要删。** |
| `superpowers/` | 历史 spec 与 plan（283 份：specs 137 / plans 146） | **从 [`superpowers/INDEX.md`](./superpowers/INDEX.md) 进** —— 按主题 +状态（🟢living / 🔒frozen / ⛔superseded）分组。索引可重跑：`python3 gen_index.py && python3 gen_index_md.py` |
| `discussion/` | 讨论文档（第一资产） | 项目方向与决策来源 |
| `ops/` | 部署 runbook | 生产运维 |

## 已删除的目录（2026-10-03）

以下目录**无代码引用**，且内容为已完成的阶段性产物，故删除：

| 已删目录 | 删除原因 |
|---|---|
| ~~`adr/`~~ | ❗**已恢复**（2026-10-03 同日）。原3 份是 LangGraph 时代的 ADR，但**ADR 这个目录形态本身是对的** —— 补录了 8 份已上线决策的 ADR（0001-0008），见 `adr/README.md`。 |
| `mockups/` | 3 份 UX 线框稿，对应实现均已在代码里：<br>· `agent-progress-ux-system.html` → `apps/web/src/components/agent/turnStatusBar.ts`、`activityLine.ts`<br>· `agent-background-tasks-card.html` → `AgentTaskProgressCard.vue`<br>· `agent-queued-message-card.html` → `queueDelivery.ts` |
| `diagnostics/` | `2026-09-30-agent-architecture-diagnosis.html` —— 一次性架构诊断报告（对照 Codex / Claude Code / WorkBuddy），无后续演进价值。 |
| `archive/` | `2026-09-20-branch-cleanup.md` —— 2026-09-20 的一次性分支清理留痕（99 → 18 个分支）。**同类信息现由 `AGENTS.md` 的「分支纪律」与 `branch-first-dev-workflow` skill 承载**，留旧文档反而会让人以为还有第二套规则。 |

**删除前已核实**：这 4 个目录在 `apps/` `packages/` `services/` `charts/` `deploy/` 里的引用数均为 **0**。

## 内核能力清单（不在 docs/ 下）

`@earendil-works/pi-*-` 各子包的使用情况与理由记录在
**[`services/pi-runtime/DEPENDENCIES.md`](../services/pi-runtime/DEPENDENCIES.md)** ——
让"是否吃满内核能力"变成可核对的事实，而不是靠印象。依据见
[ADR-0009](./adr/0009-vendor-capability-first.md)。

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

## `superpowers/` 索引（2026-10-03 已补）

283 份文档**正文未改动**，新增 [`superpowers/INDEX.md`](./superpowers/INDEX.md) 做导航：
按 16 个主题分组，每份标 living / frozen / superseded，判定规则写在索引文末。

- 状态分布：🟢 living 92 · 🔒frozen 186 · ⛔ superseded 5
- 判定优先读文档开头的 `状态：` 字段，其次按月份 + 主题推断
- **判定错了的修法**：改文档开头的状态字段，然后重跑脚本（不要手工涂改索引）
- 重新生成：`python3 gen_index.py > index_data.json && python3 gen_index_md.py`

> 决策依据见 [ADR-0008](./adr/0008-docs-index-over-doc-edits.md)——
> 为什么不批量改正文（283 文件 diff 失控），以及为什么不用"按月份删/归档"（丢决策追溯价值）。
