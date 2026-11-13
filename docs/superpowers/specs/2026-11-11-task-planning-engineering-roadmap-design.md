# 任务管理工程复盘与演进路标：外部建议核验、缺口分析与分期方案

> 日期：2026-11-11 · 版本 v1.3 · 状态：已拍板（2026-11-11，用户授权 PR #834 合并时拍板；阶段 A/B/C 代码刀仍须各自立项 + 单独授权）
> **v1.1（2026-11-12）**：按用户裁决追加 §9 校准注记（G1/G4/G5 现状重算 + 优先级重排 + C-1 提前），v1 正文与取证口径全部保留不动。
> **v1.2（2026-11-12 深夜）**：按用户裁决追加 §10 校准注记（第二轮外部调研核验：六支柱同构判定 + 四点增量校准），v1/v1.1 全部保留不动。
> **v1.2 增补（2026-11-13）**：细化探讨轮五方向产物追加 §11（A-2' 语义细化 + 三项拍板）/ §12（replan 观测判据）/ §13（Skill SOP × C-1 闭环 + §9.5 纠偏）/ §14（C-2 acceptance）/ §15（一致性核对），配套 C-1 立项 spec §8 判据细化（含 §8.6 A-2' 前置观测判据）；§5.3 No-Go 表增补一行（标 v1.2）。全部纯追加，推送时机由用户单独给出。
> **v1.2 增补二（2026-11-13 凌晨）**：追加 §16（六支柱吸收度终审 + ②③ 对抗性复审）——§10.2 六支柱判词的逐支柱吸收度复核；② DAG 判词修正（已吸收 WorkBuddy 真实形态，引擎双方皆无）；③ 文件状态层部署形态决定论与重构 No-Go 裁决（含重审触发条件）；§16.5 支柱① 三子项分解——**新增 scope 半缺口登记，A-3 表述修订为 assumptions[] + scope**；§16.6 支柱② 三子项分解——**新增并行/串行提示条文缺口登记（→ SOP skill 候选）**；§16.7 支柱⑥ 三子项核查（无新缺口，六支柱子项级审计至此全部完成）；§16.8 部署形态演进澄清（客户端 APP 形态 A/B 分野，形态 B 接线 §16.3 触发条件）；§16.9 上游 subagent 编排核验（四角色/三 preset/三模式事实表——**纠偏 §10.1「上游无轮子」：examples 层有完整编排实现，阶段 B 清单增补角色分化与编排模式**；规划职责边界裁决 = Planner-Executor 轻分离，pi-lnk 现状正确）。两个新候选均「登记 + 等数据触发」。纯追加，仍本地落档未推 PR。
> **v1.2 增补三（2026-11-13 上午）**：追加 §18（第四轮专项复审：设计哲学 vs 行业最佳实践 + 造轮子再审计）——哲学 10 立场全绿（两条获新一手佐证：全量覆写定位论、in-repo eval 资产论）；**一处哲学半缺口：eval 运行节奏缺「定时跑批/变更触发」档 ⇒ 模型漂移不可见，登记候选不立项（§18.2）**；造轮子再审计一处顺序改判：未来 replan 先「N 轮未更新→提醒注入」轻机制、后重检测（§18.3，Kimi/CC attention_check 先例）。C-1 spec 配套增补 §8.7。纯追加，仍本地落档未推 PR。
> **v1.3（2026-11-13 上午）**：第三轮对抗复审 §17——上游版本纠错（0.85.1→**0.99.2**，正文【v1.3 纠错】标注处）+ 上游代际图景（1.x = harness 替换，阶段 C 表述升级「pi-durable 迁移评估」）+ §12.2 指标名纠错 + §17.4 终版吸收矩阵（取代 §16.1/§16.4 对应行）+ #841 跨文档状态注记。（头部记录此前缺失，第五轮复审补记。）
> **v1.3 增补（2026-11-13 午）**：第五轮专项复审 §19（极简哲学 + 内部重复/冲突 + 遗漏）——五处就地修正（§16.9 挪位、§16.1 取代指针、§18.2 触发机制矛盾、§14.2 `note` 字段砍除、§14.4 措辞）+ 两处登记（§7 A-3 解释优先级、A-2' 行为观测补项）+ **§19.5 规格生命周期冻结——用户拍板生效（v1.3 起评审完毕，后续审视仅进各立项 spec）**。
> 定位：**分析与路标规格（决策门性质）**。输入为一次外部建议（DeepSeek，2026-11-10）+ 三路取证：本项目代码/生产、上游 pi 0.85.1 源码、行业一手实践。本文不直接授权任何代码刀；阶段 A/B/C 各自立项时独立成文，走 spec → plan → implementation 循环（遵守 `2026-10-09-task-management-module-design.md` §3 立项规则）。
> 取证时点：2026-11-10 23:xx GMT+8。生产镜像 `141d5d97`（落后真 master `31808ec0` 十七个提交）；生产数据来自只读 DB 副本（`docker cp lnkpi-api:/app/apps/server/data/lnkpi.db /tmp/pi-probe.db` → 宿主机 `sqlite3 "file:...?mode=ro"`），未修改任何生产状态。【v1.3 版本号纠错：本文所述「上游 pi 0.85.1」有误，实际 vendored 版本为 `@earendil-works/pi-agent-core@0.99.2`（harness 末代，见 §17.1），0.85.1 属陈旧文档分支 `5926ac72` 的数字，误入早期会话记忆】
> 裁决权：本文所列方案与门禁需评审拍板后方可立项执行；自动化产出不构成批准。

---

## 1. 问题背景

用户提供了一份外部（DeepSeek）关于「Codex 等产品如何做需求分析 → 任务规划拆解 → 执行落地」的建议，核心主张包括：

1. 「基于 pi-agent 自带的 TODO 是否直接可以满足」是首要问题；
2. 需要构建 **Planner-Executor 分层架构**（主张多 Agent 角色分工，引用「Sol 军师 / Luna 执行」）；
3. 「需求澄清应被显式设计为规划阶段的一个必要步骤」；
4. 行业最佳实践落在方法论 / Skill / Tool 三层。

**为什么不能直接采信**：a) 其前提（本项目从零开始建规划层）未经本项目代码核验；b) 其行业论据多处来自二手来源，与官方一手文档存在可证伪的偏差；c) 本项目已于 2026-10-09 立项自建任务管理体系（C1–C5），任何新方案必须以增量方式落在既有纪律内，而非另起炉灶。本文按「先取证、再核验、后裁决」的顺序处理。

## 2. 关键事实取证与分析（代码 + 生产双证）

### 2.1 上游内核：不存在「pi 自带 TODO」这个选项

- vendored `@earendil-works/pi-agent-core@0.85.1` 明确拒绝内置任务原语：`vendor/earendil-works/pi/packages/coding-agent/README.md:501`（`No sub-agents.`）、`:505`（`No plan mode.`）、`:507`（`No built-in to-dos. They confuse models. Use a TODO.md file, or build your own with extensions.`）。
- `packages/agent/src` 全仓检索：`phase` 0 命中；`plan/todo/task/subagent` 语义命中 0。
- 官方一等示例扩展在仓库内：`examples/extensions/todo.ts`（details 快照 + 分支扫描重建，**自带自增 id**，`:18-29`/`:114-129`）、`examples/extensions/plan-mode/`（`setActiveTools` 只读切换 + `[DONE:n]` 步进）、`examples/extensions/subagent/`（planner / reviewer / scout / worker 四角色 + 三套编排模板）。注意：这些属 coding-agent 扩展层（ExtensionAPI），本项目按 `VENDORED.md:20` 只用 agent-core harness 层，**模式可移植、代码不可复制**。
- 上游 1.0.0（据本项目规格记载与二手）将 harness 整体迁出至 `pi-durable`；vendored 0.85.1 中无该包（仅工作包文档 `packages/agent/docs/work-packages/05-direct-durable-drive.md`），upmerge 属总纲 §7 既列风险。

### 2.2 本项目已有体系（非白纸）

- 五期分期（总纲 `docs/superpowers/specs/2026-10-09-task-management-module-design.md` §3）：C1 `todo_write` 已上线（PR #319 → `75d3105e`，2026-10-09）；C2 turnBudget 已立项已实现；C3 `propose_plan` + plan-gate 已实现（PR #329 → `f459d1f9`）；C4 `spawn_subagent` 源码在 master（`tools/spawn-subagent.ts` 3804 bytes，`config.ts:57,84` 注册、`index.ts:273` attach）；C5 Automations P0 已实现。
- prompt 契约：`prompt-registry/rules/task_tool.md:11`（v1.1.0，一行规则）进生产默认四组之一（`apps/server/src/agent/pi-runtime/rule-groups.ts:30-39`；`prompt-registry.loader.ts:111-130` 双通道）。
- 澄清链路：`ask_user` 阻塞式工具（`tools/ask-user.ts:72-157`，schema 强校验 ≤4 题，超时全 skipped）；澄清决策矩阵已拍板（`2026-10-13-propose-confirm-evidence-and-clarify-matrix-design.md` §1.5-1.6，纲领「问卡是决策原语，不是默认动作」）。

### 2.3 生产实证（时点快照，2026-11-10）

来源：只读 DB 副本，展开 `AgentMessage.metadata.executionEvents`（12,229 条消息 / 1,054 条带事件，覆盖 2026-07-16 → 2026-11-10）。

| 信号 | 全量 | 2026-10 | 2026-11 | 判读 |
|---|---|---|---|---|
| `todo_write` 调用 | 282 | 89 | 193 | C1 上线后放量，活跃链路 |
| `ask_user` 调用 | 271 | 108 | 163 | 高活；#828（AskUserCard 修复）在合并未上线 |
| `propose_plan` 调用 | 42 | 12 | 30 | ≈ todo_write 的 15%，「先方案确认」非主流路径 |
| `web_search` / `web_fetch` | 26 / 9 | — | — | 占 6,249 次 tool_call 约 0.4% |
| `tool_search` / `load_skill` | 37 / 73 | — | — | 延迟加载与 Skill 渐进披露在跑 |
| `spawn_subagent` | **0** | 0 | 0 | 未进入生产运行时（见 §4 G4） |
| `task_list` / `task_update` 事件 | 111 / 656 | — | — | task_list 首现 2026-10-09 10:49（与 C1 上线日吻合） |

- 最近一条生产 `task_list` 载荷（原文）：`{"items":[{"id":"plan-4","title":"创建教学脚本大纲节点","status":"done","activeForm":"编写脚本"},{"id":"plan-7",...},{"id":"plan-9",...}]}` —— id 为位置序且跳号，字段全集仅 `content / activeForm / status`。
- **C4 产物断层**：生产运行镜像全量搜索（排除 `*.db`/`*.bak*`）`spawn_subagent` **0 命中**；Nest `dist` 内 `todo_write` 命中 6 处、`propose_plan` 1 处、C4 为 0。源码（master 与 `141d5d97` 两棵树）均在且已注册装配 ⇒ **「源码在、运行时不在」**，根因（构建输入 vs 部署链路）未定位。
- **2026-11-11 复核纠偏（同日，B-4 调查刀）**：上条「源码在、运行时不在」**被证伪**——根因是取证范围错误：只搜了 Nest `lnkpi-api` 容器，而 pi-runtime 是 K3s 独立部署单元（`deploy/pi-lnk-runtime`，NodePort 30100，见 `docs/ops/RUNBOOK-pi-runtime-deploy.md`），从未被搜过（Nest dist 内 `todo_write` 6 处命中实为 prompt fallback 常量文本）。复核实证：生产 pi-runtime 镜像 `d9085d33` 的 dist 内 `spawn_subagent` **6 文件全命中**（`tools/config.js` 装配两处、`index.js` SubagentCoordinator 构造、`gate/subagent.js`、`metrics.js`），`/metrics` 暴露 `pi_runtime_subagent_spawned/rejected/outcome_total` 三系列 ⇒ **C4 已进入生产运行时且已注册**；`spawned_total=0` 为模型零调用，根因是 `prompt-registry/` 与 `skills/` **零点名**（AGENTS.md 工具分层纪律：未点名 ⇒ 模型不知道用，与 `tool_search` 激活率 0 同构）。§2.4① 与 §4 G4① 的「运行时不在」表述一并以此为准；阶段 B-4「定位根因 + 上线刀」**作废**（无需上线），替代动作 = 按点名纪律补 prompt/skill 点名（独立小刀）。另记构建输入风险：pi-runtime 构建源为主仓 rsync 工作树快照，而主仓工作树 pi-runtime 源码陈旧（工作树 `index.ts` 缺 coordinator 接线而 HEAD 有）——本次镜像内容与 master 一致未受影响，但后续构建须先核对工作树新鲜度。
- 可观测性：Nest `/metrics` 返回 200 但无 `pi_runtime_plan_*` / `subagent_*` / `turn_budget_*` 命名指标暴露；交付清单 `docs/ops/2026-10-09-task-tool-delivery-checklist.md` 实测 14 个 `- [ ]` / 0 个 `- [x]`；`[legacy-plan-marker]` 近 7 天日志 0 次（达标但未回填）。
- 版本漂移：生产镜像 `141d5d97`（11-10 04:49Z）落后真 master `31808ec0`（11-10 15:27Z）**17 个提交**（多为 docs-only 与前端修复）。

### 2.4 场景差异判据

本项目是 **canvas agent**，不是 coding agent：「代码探索」的等价物是 `get_canvas_summary`(652 次) / `view_canvas_media`(547) / `get_node`(85)；「执行落地」**没有 compiler / 单元测试 / LSP 这类确定性 oracle**，验收只能锚定画布 SSOT、生成记录与用户确认。因此 coding agent 的 Planner → Executor → Reviewer + 测试验证闭环**不可整体迁移**。

## 3. 外部建议逐条核验

核验口径：一手来源优先（官方文档 / 官方博客 / 官方仓库），二手标注；OpenAI 三处官方页 WebFetch 被拒，引文取自该域名搜索索引原文快照（已在调研中标注）。

| 原结论 | 判定 | 核验要点 |
|---|---|---|
| Pi 核心不内置 plan mode / todo，靠 `pi-todo` / `@capdiem/pi-todo` 等扩展 | **部分成立** | 核心不内置属实（README:505/507）。但举错对象：所举为**第三方社区 npm 包**；官方一等示例是 `examples/extensions/` 下的 `todo.ts` / `plan-mode/` / `subagent/`，且 `subagent/` 已含四角色与编排模板；monorepo 层另有 `pi-durable`，「无任务状态」只在 CLI 核心成立 |
| Codex 多 Agent 分工：主 Agent 调度、Sol 军师规划、Luna 执行 | **不成立** | **Sol / Luna / Astra 是 GPT-6 系列模型 ID**（`codex -m gpt-6.1-sol` / `gpt-6-luna`），不是 agent 角色。真实机制：`/plan`（Shift+Tab）切换 Plan mode、AGENTS.md 开放格式、sandbox + approval policy、用户/指令触发的 subagents（默认继承父模型与 reasoning effort）、`/review` |
| TodoWrite → TaskCreate/Update/List；Tasks 更新引入 DAG 依赖与跨会话 | **部分成立** | 工具族为 `TaskCreate/TaskGet/TaskList/TaskUpdate`；**「DAG」是二手夸大**（官方只说 dependencies / blocked，无环约束未声明）；**新模型上整套默认关闭**（Anthropic 2026-04：模型变强后工具可能反而成为束缚）；启动子代理的 `Task` 工具已更名 `Agent`（v2.1.63），不可与任务工具族混淆；跨会话共享的是任务列表（`CLAUDE_CODE_TASK_LIST_ID`）不是团队 |
| 需要构建 Planner-Executor 硬分层（独立模型 / 独立上下文） | **与实证相反** | 2025–2026 主流是**轻分离**：同一 loop 内 plan mode 收缩工具面 + 结构化计划工件 + 人工审批（Codex `/plan`、Claude Code `EnterPlanMode/ExitPlanMode`、WorkBuddy「先出方案再执行」、pi 官方 `plan-mode/` 皆如此）；硬分离主要存在于 LangGraph 参考架构与可选 subagent 委派 |
| 需求澄清应做成规划阶段的强制必要步骤 | **反模式** | 三家一手证据一致：Claude Code「only when blocked on a decision genuinely the user's to make」、Codex「bias to action unless truly blocked」、WorkBuddy「全部跳过时模型自行假设并在方案中标注」；本项目已拍板纲领「问卡是决策原语，不是默认动作」（澄清矩阵 §1.6），与外部建议冲突 |
| WorkBuddy「七层架构」 | **无一手来源** | workbuddy.cn 官方文档无此表述，社区归纳互相矛盾（七层/八层/六层）；本项目 `docs/analysis/2026-10-09-workbuddy-task-planning-benchmark.md` 是内部蒸馏快照（总纲 §7 自标「不随实现更新」），以二手归纳当架构基线属需登记风险 |
| 方法论 / Skill / Tool 三层分工 | **成立且适用** | 全文最有价值部分；本项目已有对应物（总纲 §2.2 五原则 / `load_skill` 生产 73 次 / `todo_write`·`propose_plan`·`ask_user`），但**缺第四层：Eval / 门禁** |

## 4. 五个真实缺口

**G1 · 规划产物不是一等契约（最核心）**
任务项字段全集 = `content / activeForm? / status`（`services/pi-runtime/src/tools/task-state.ts:6-16`、`todo.ts:53-65`），id 为位置序 `plan-<n>`（`task-state.ts:50`），生产载荷实证跳号（plan-4/7/9）。**无稳定 id / 依赖 / 验收条件 / owner / 文件边界** ⇒ 无法可靠引用单任务，依赖、跨会话引用、增量更新、并行派发全部堵死。总纲 §3 对 C4 的「只读语义下依赖环消解」是绕开而非解决。反讽：上游官方 `todo.ts:18-29` 本来有自增 id，本项目按「行业共识均无 id」（总纲 §1 输入二）砍掉了——自建时丢了上游已有能力。

**G2 · 拆解质量零工程保障，且 prompt 预算物理封死**
全部规划契约只有一行（`task_tool.md:11`）；L6 组合 `core+writeTools+genTools+todoTools` 在交付清单时点实测 3175/3200（权威值以 `prompt-registry/PROMPT_SPEC.md` §5 budget-table 为准，AGENTS.md 手工行记 3132/余 68，两处口径需以机器生成为准核对）；项目自证「提示词层对该模型的约束力已被生产证伪两次，解法重心必须是机制编码」（澄清矩阵 §1.2）。现有测试只保链路正确性（`task-state.test.ts` 13 例、`pi-events.test.ts` 10 例、gate 守卫），无拆解语义评测；规格自认「模型不调 propose_plan 直接干活 = 现状行为，不是回归」（`plan-gate-design.md:131`）；生产 `propose_plan`/`todo_write` ≈ 15% 说明大部分清单是模型即兴列出，plan-gate 仅在 propose 后生效。

**G3 · 上游原生能力没吃满（「不重复造轮子」的反面）**
生产代码 0 命中的上游原语：`appendCustomEntry` + `EntryProjector`（`agent-harness.ts:544`、`session/types.ts:59-62`）、`promptSnippet` / `promptGuidelines`（`coding-agent/docs/extensions.md:1917-1921`）、`setActiveTools` 只读切换（官方 `plan-mode/index.ts:104-112`）、`before_navigation` + branch summarization（`agent-harness.ts:496-499`）、`terminate: true`（`agent/src/types.ts:375`）、`before_run` / `before_drive` / `after_response`（`agent-harness.ts:431-438,460-463`）、官方 `subagent/` 编排模板。已吃满部分（11 个 HookMap 钩子、Dynamic Tool Loading、`before_compaction`、`transform_context`、`lane.findEntries` 分支扫描、`details` 快照重放、steer/followUp）不必再动。

**G4 · 生产落地与可观测性断层**
① C4「源码在、运行时不在」（§2.3）；因此**总纲 §5 的 C1-B 触发条件①「C4 子代理落地出现并行清单需求」至今未满足**——C1-B「未立项」是门禁生效，不是遗漏。② 交付清单 14 项全未勾选，生产取证与指标基线未回填。③ 生产镜像落后 master 17 提交。④ 规划链路指标未暴露到 Nest `/metrics`；`plan-gate-design.md:114` 记 `plan_decision_total`（单数）与实际渲染 `plan_decisions_total`（复数）不一致。

> **2026-11-11 复核纠偏**：①中「C4 源码在、运行时不在」被同日 B-4 调查刀证伪（取证范围漏了 pi-runtime K3s 独立部署单元）——真实状态：**C4 已进入生产运行时且已注册，零调用为用量缺口（prompt/skill 零点名）**；触发条件①证据面更新为「C4 已落地但零调用」，判定结论不变（仍未满足），C1-B「未立项」仍是门禁生效。详见 §2.3 复核纠偏条。

**G5 · 规格-实现漂移与上游升级悬崖**
状态自相矛盾：总纲 `:3` 头「待评审」但 §3 记 C1 已上线；`plan-gate-design.md:6` `draft-review` 但代码已合 #329；C4 spec 写「PR 待合并」但源码已在 master。文档债：早期四份 Python 侧规格（`intent-planning-guard` / `codex-style-tool-plan-harness` / `workflow-recipe-planner` / `planner-confirm-instantiate-gate`）有设计无实现（`services/agent-runtime/**` 工作树与 HEAD 均不存在），其中 codex harness spec 自身 §0 已标注 V7 废止、`select_narrow_write_tools` 退役——易被误读为「规划层从未设计」或「已实现」。上游 1.0.0 breaking（harness → `pi-durable`）使一切绑定 harness hook 的新工程带重映射成本（总纲 §1 坑位 3 / §7 维护规则 2）。

## 5. 最佳解决方案（不新增第六层架构，只补三件事）

**总原则**：不推翻 C1–C5、不新建独立 Planner 层、不 patch vendor、不新建 Task 表（总纲 §2.2 红线「全量快照 SSOT」；§5 红线「B→A 反向不可行，禁止绕过全量快照直接改状态的旁路」）。

### 5.1 载体分层

| 载体 | 该承载 | 不该承载 |
|---|---|---|
| 上游 harness 原语 | 状态持久化、上下文注入、工具面切换、门禁、分支语义、收尾控制 | 任何业务语义 |
| Tool（结构化契约） | `todo_write` 全量快照 + 稳定 id / 依赖 / 验收字段；`propose_plan` 方案工件（含 assumptions）；`ask_user` 决策原语 | 拆解方法论（预算已死；改走 `promptGuidelines` 或 schema） |
| Skill（按需加载 SOP） | 「这类任务怎么拆」：探索顺序、粒度判据、何时 propose、何时声明默认 | 每轮必注入的规则 |
| 方法论 / 规格 | 触发门禁、不变面、红线、验收判据 | 运行时逻辑 |
| **Eval + 门禁（新增第四层）** | 拆解质量评分、checkpoint、replan 触发条件、指标基线 | 靠 prompt 自觉 |

关键判断：契约从文本**下沉到工具 schema + Skill + EntryProjector 注入**，与项目自己的「提示词层已被生产证伪两次」结论一致。

### 5.2 三阶段与放行门禁

- **阶段 A · 补契约（最小刀）**：① 回填交付清单 14 项生产取证（数据见 §2.3，可直接引用）；② 任务快照 item 增稳定 `id` 字段 + `applyIncremental` fold（总纲 §5 早已预留的 C1-B 升级点，保持全量快照 SSOT 与事件格式不变面）；③ `propose_plan` 摘要增 `assumptions[]`（声明式假设结构化落点）。**门禁**：全量快照不变面测试全绿 + 生产零行为变更复测（沿用注释类刀取证纪律，不用 chunk hash 当锚点）+ 合并窗口单独授权。
- **阶段 B · 吃满上游 + C4 决策门**：① 移植 `setActiveTools` 只读切换；② `EntryProjector` + `appendCustomEntry` 承载任务契约注入；③ `promptSnippet`/`promptGuidelines` 下沉工具引导；④ C4 先定位产物断层根因，单 PR 上线 + 生产复测，按真实调用量决定是否触发总纲 §5 条件①（沿用 SP-E「条件触发、不硬锁窗口」纪律）。**门禁**：C4 断层根因定位报告 + 生产端点行为断言；C1-B 立项按总纲 §5 字面判定。

  > **2026-11-11 可达性修正刀（B-4 收口后的最小代码刀）**：上条复核纠偏归因「零点名」为表层症状，后续调查钉死结构根因——`spawn_subagent` 落在 tiering **延迟集**（`ALWAYS_ON_TOOL_NAMES` 不含它，生产 `PI_RUNTIME_TOOL_TIERING=true`），模型拿不到 schema，发现通道只剩 `tool_search`（无动机触发率 0），属 C4 与 tiering 两刀间的规范-实现漂移（C4 spec 对 tiering 零提及、守卫 A1 对「零点名+延迟」组合恒绿）。修复 = 提回常驻（`get_canvas_summary`/分组三工具先例：description 承担发现能力 + 唯一入口性），设计见 `2026-11-11-subagent-tier-promotion-design.md`；prompt 点名路径仍封锁（L6 余量 25 字符且点名不解决 schema 可达性）。
- **阶段 C · 质量闭环 + upmerge 预研**：① 按 Anthropic trial/transcript/outcome 建 30–50 条 canvas 场景 eval，判据锚定画布终态（节点存在 / 参数已设 / 生成记录存在），**只观测与门禁、不自动 replan**；② 任务项增可选 `acceptance` / `dependsOn`（依赖稳定 id），`after_tool` 收尾校验，仅在确定性 oracle 子域启用；③ HookMap 依赖面收敛到 `scripts/verify-tool-contract.ts` 可机检范围 + 1.0.0/`pi-durable` 迁移映射预研。**门禁**：eval 基线建档 + upmerge 评审。

### 5.3 No-Go 清单（明确不做）

| 不做 | 理由 |
|---|---|
| 独立 Planner 子 Agent / 独立模型调用 | 行业实证为轻分离；Claude Code 已随模型变强默认关闭任务工具；plan-gate 已是同 loop 有效门禁 |
| 引入 `task_create/task_update/task_list` 三工具族 | 回摆能力 + 与现有 SSE 事件名冲突 + 破坏总纲 §5 不变面；C1-B 未立项 |
| 继续往 prompt-registry 加规划规则条文 | L6 余量贴线 + 项目自证「提示词层已被生产证伪两次」 |
| patch vendor / 新建 Task 数据库表 | 总纲红线；上游 details 快照与 Claude Code 文件持久化已证够用 |
| 把 `ask_user` 做成强制规划阶段 | 三家一手证据 + 本项目纲领均反对，审讯式交互 |
| 照抄 coding agent 的 Glob/Grep + 单测验证闭环 | canvas agent 无确定性 oracle |
| 照搬多 agent 编排的动态 DAG 调度器（v1.2 增补，详见 §10.3-2） | 单 loop canvas agent 无需调度器；「DAG」为二手夸大（§3）；dependsOn 降级为记录性元数据（§11.2-10） |

## 6. 诚实边界

1. 生产取证为 2026-11-10 23:xx 时点快照，来源只读 DB 副本与只读容器命令；生产镜像落后 master 17 提交，结论只对应该镜像运行时。
2. `spawn_subagent` 只证实「源码在、运行时不在」，**根因（构建输入 vs 部署链路）未定位**，不宣称「C4 未合入」。
3. `pi 1.0.0 / pi-durable` 细节来自本项目规格记载与二手，vendored 0.85.1 源码中无该包，未做上游新版本源码取证。
4. 行业核验以官方一手为主；`developers.openai.com` 三处页面抓取被拒，相关引文取自该域名搜索索引原文快照并已标注；「DAG」「七层架构」等二手说法未采信。
5. 本次分析未做端到端 / 真机复测；本文为分析文档，不构成对任何代码刀的执行授权，不下「验收完成」结论。
6. 本文中引用的 prompt 预算等手工数字存在双口径（3175/25 与 3132/68），以 `prompt-registry/PROMPT_SPEC.md` §5 机器生成为准；落地时先跑 `pnpm prompt:lint` 取实测。

## 7. 与既有资产的接口与后续立项队列

**直接更新目标（docs-only，零发布）**：
- `docs/ops/2026-10-09-task-tool-delivery-checklist.md`：回填生产取证（本文 §2.3）；
- `docs/superpowers/specs/2026-10-09-task-management-module-design.md`：§3 状态列纠偏（C4 改为「源码已合 master、生产运行时缺失（2026-11-10 取证）」，C5 待部署验证维持）+ §5 追加 2026-11-11 触发条件取证注记（条件①未满足证据）；
- `docs/superpowers/specs/2026-10-10-plan-gate-design.md`：状态行纠偏（`draft-review` → 已实现，PR #329 事实不变，只改状态标注不改历史口径）。

**后续立项队列（各自独立 spec → plan → implementation）**：
1. 阶段 A-2「任务快照稳定 id + 增量 fold」（对应总纲 C1-B 升级点，先走总纲 §5 字面判定）；
2. 阶段 A-3「propose_plan assumptions 字段」；
3. 阶段 B-1/B-2/B-3 上游原语移植三刀；
4. 阶段 B-4 C4 产物断层定位 + 上线决策门；
5. 阶段 C-1 canvas 拆解 eval 集；C-3 upmerge 映射表。

## 8. 验收标准（本文档落地验收，docs-only）

1. 交付清单回填**只勾有实证的项**：调用量 / 事件量 / `legacy-plan-marker`=0 有数据可勾；「fork 正确」「compaction 存活」等未逐项实测的项标注「证据待补」，不得虚勾。
2. 总纲状态纠偏**只追加时点注记、不改写历史口径**（沿用 #825「纯追加 + 旧行按序全保留」判据）。
3. `pnpm verify-claims` / `verify-links`：本地主仓脏工作树下可能假红，以 **CI 干净 checkout 为权威**（既有判据）。
4. docs-only 零发布确认：`ci.yml` `paths-ignore` 含 `**/*.md` ⇒ 合并后「无 master CI run」为预期非失败；权威证据 = PR CI 全绿 + 合并树 == 已验证 PR head 树。
5. 本文状态由「待评审」推进需评审拍板；阶段 A/B/C 任一代码刀合入前需单独授权 + 生产复测。

---

## 9. 2026-11-12 校准注记（v1.1，用户裁决「落成 v1.1 并起草 C-1 立项 spec」）

> 校准基准：master `16e4fc99`（PR #858 合并后）+ 生产取证（11-12 全天五刀上线）。v1 各章结论按其写作时点保留有效，本章只记录**现状重算**与**优先级重排**。

### 9.1 G1 部分解——「稳定 id + 增量 fold」系统侧已落地（v1 写作时未知）

master `task-state.ts` 现状（逐行核实）：

- `TodoItemWithId`：id 恒在；`reduce()` 对**同 content 复用旧 id**（id 跟随任务而非位置），新项取「历史最大 n + 1」**不回收计数器**——v1 §2.3 记录的「生产载荷跳号（plan-4/7/9）」由此成为**正常语义**（删除后不复用），不再是对账缺陷。
- **增量 fold 已存在**：结构变化 → 全量 `list` 事件；仅状态变化 → `updates[{id,status}]`；纯重排 → 零事件（防前端卡片抖动）。v1 阶段 A-② 所写的 `applyIncremental` 等价物已在事件管道生效。
- `pickLatestSnapshot` 同时识别 `todo_write` 与 `propose_plan` 的快照（P1-2：propose_plan 经 `overwriteTodos` 落清单但不写 todo_write transcript 条目，不识别它则重启播种为空）——**「方案→任务清单」管道已闭环**。

**G1 剩余缺口（精确化）**：模型侧 `todo_write` schema 仍是无 id 的全量覆写（`todos:[{content,activeForm?,status}]`），id 由 runtime reduce 分配——**模型不能按 id 寻址更新**（只能全量重发 content），「可动态更新」对模型而言是覆写不是寻址。且 `dependsOn`/`acceptance` 字段未做（阶段 C-②）。⇒ **A-2 重述为「模型侧 id 契约」**：todo_write schema 增可选 `id` 字段，带 id 精准寻址、不带 id 走 content 匹配保持兼容——全量快照 SSOT 不变面零破坏，在 §5.3 No-Go「三工具族」红线之内（不新增工具、不加旁路）。

### 9.2 G4 大幅收口——可达性链五刀闭环，spawned 历史首次 0→1

11-11/11-12 两天的实际推进（均已有合并+生产取证）：

| 刀 | 内容 | 对 v1 的影响 |
|---|---|---|
| #838 | spawn_subagent 提回 ALWAYS_ON 常驻（tiering 延迟集 → schema 不可达的结构根因） | §2.4① / G4① 的「零调用」归因链修正完成 |
| #839 | propose_plan 一等公民化：`plan_proposed` 一等事件 + 重连播种 + ask_user 超时护栏（P0+P1） | 「方案可见性」闭环；G1 的方案→清单管道随之闭环（9.1） |
| #841 | 调用升级预案 spec（F1–F6 + §7 行业对照：Anthropic defer_loading 同构、Claude Code plan mode 白名单含 Task） | G3 的 promptGuidelines 归属钉死：coding-agent 包所有、pi-agent-core 不带 |
| #850 | D2 `SubagentTask` 一等单据（Nest SQLite，cuid 主键 + CAS 终态 + sweep） | 子代理「完成」从进程内存迁到跨 pod 持久化，可跟踪面升一级 |
| #858 | L2 点名 `subagent-delegation`（todoTools 组合 3197/3200 余 3）+ description 关键词化 + fallback 兜底 | **spawn_subagent 历史首次真实调用**（spawned 0→1、completed=1、主回合整合子代理报告） |

⇒ §5.2 阶段 B-4 注记中「prompt 点名路径仍封锁（L6 余量 25 字符）」**已过时**：#858 用 L2 组合（非 L6）完成了点名，且模型真实调用已发生。⇒ **G4①触发条件①（C4 并行清单需求）证据面再更新**：「已落地、已点名、已有真实调用」，但仅 1 次，C1-B 立项判定仍按总纲 §5 字面等持续数据。⇒ #841 预案的 T1∧T2（spawned 恒 0 才触发）**基线已被动**：观测重心从「是否回升」转为「spawned 持续性」（7 天/200 run 复核，仍欠）。

### 9.3 G5 收口

总纲 / plan-gate / C4 三处状态矛盾已由 #834（清单回填）/ #835（状态拍板 + §7 索引）/ #836（B-4 纠偏）纯追加注记解决；SSE 事件一等化 #845–#847（账本投影 / PendingInterruption durable / D1 止血）与 W1c #848 落地后，事件跟踪面较 v1 写作时强一个量级。

### 9.4 G2 成为最大真缺口 → C-1 提前

v1 §5.2 把 eval 排在阶段 C，理由是「先补契约与可达性」。现状重算后该前提反转：可达性（G3/G4）已收口，而**拆解质量仍是零工程保障**——prompt 契约仅一行且 L6/L2 预算双双贴线（#858 后余 3），`propose_plan`/`todo_write` ≈ 15% 的使用比说明拆解时机与粒度无门禁可言。⇒ **C-1 提前为当前最高优先级刀**，立项 spec：`2026-11-12-c1-canvas-decomposition-eval-design.md`（同日立项，只观测与门禁、不自动 replan——阶段 C 原文边界不变）。

### 9.5 Skill SOP 刀补进立项队列（v1 盲点）

§5.1 载体分层已定位「Skill 层管『这类任务怎么拆』（探索顺序、粒度判据、何时 propose、何时声明默认）」，但 §5.2 三阶段无任何一刀对应。#858 验证了 `skills/` 尾部固定小节（R5 通道）是可用注入面（L2 组合预算内）。⇒ 队列新增：**「拆解 SOP skill」**——垂类拆解流程落 `skills/` 尾部小节，与 C-1 eval 构成「SOP 定义质量 → eval 验证质量」闭环。

### 9.6 修订后优先级（取代 v1 §5.2 的阶段顺序，阶段编号保留）

1. **C-1 eval 集（提前）**——「精准拆解」之根，G2 唯一解法；
2. **A-2' 模型侧 id 契约**（重述，见 9.1）——「可动态更新」的真缺口；
3. **Skill SOP 刀**（新增，见 9.5）——拆解质量第二支点；
4. **C-2 acceptance + after_tool 收尾校验**——依赖 A-2'；先做本域确定性 oracle 子域（生成任务状态可查）；
5. **清单回填 + G4④ 指标命名注记**——低风险 docs 刀，随时可做。

No-Go 清单（§5.3）全部维持不变；「观测期内禁改动」类纪律（#841 §5）与 D6 观测规则按各自 spec 继续有效。

---

## 10. 2026-11-12 深夜校准注记（v1.2，第二轮外部调研核验；用户裁决「落成 v1.2，暂不推 PR，继续细化探讨」）

> 输入：用户提供的第二轮 DeepSeek 调研长文（主题：WorkBuddy/Codex 如何做到「需求→规划→拆解→跟踪闭环→动态更新→落地→replan」，归纳为六大工程支柱：规格 Schema / DAG 调度器 / 文件级状态层 / 验收器 / 预算化 replan 控制器 / 横向设施）。核验口径与 v1 §3 一致：一手来源优先，本注记全部结论只影响 docs 层，不改任何代码裁决。

### 10.1 引文可信度三层核验（先验输入，再吸收）

- **✅ 一手可证实**（本产品运行现场直接观察）：Task 工具族带结构化契约（subject/description/activeForm + pending→in_progress→completed 状态机 + `blockedBy` 依赖边）；「不许把部分完成标为 completed」验收纪律写在工具 schema 描述内；「无依赖并行发、有依赖串行等」写死在系统提示；SKILL 文件 / 分层 Markdown 记忆（append-only 日志 + 30 天蒸馏）/ `pipeline-state.yaml`（docx 流水线 stage 交接工件）/ Agent-Plan-Ask 三工作模式（human-in-loop 节点）/ automations，均属实。
- **⚠️ 二手未核实**：「SQLite 只承载高频查询、文件系统为状态层」的取舍细节来自第三方博客；「七步执行模型」「变更视图」等表述无一手来源（与 v1 §3 对「七层架构」的判定同构）。
- **❌ 张冠李戴**：cascade-auto、axc-agent-engine、BRACE、hydra-agents、zeph-orchestration 是**外部开源项目，不是 WorkBuddy 组件**——引文将其与 WorkBuddy 并列叙述易致误读；「动态 DAG 调度」主要出自这些项目，属多 agent 编排场景。后续调研引用同一来源时须先做此层过滤。

**上游源码补充取证**：pi-agent-core 全仓 `acceptance / replan / todo / plan-mode` 语义检索 **0 命中**（`acceptance` 命中全为 `acceptCompaction` 命名巧合；检索曾因 BSD grep BRE `\|` 轮替假 0，改 `grep -E` 重跑确认）——上游在 acceptance/replan/todo 维度无轮子可抄，自建 C1–C5 是唯一路径，再次坐实。

### 10.2 六支柱逐项对照——方向同构，v1.1 无方向性修订

| 支柱 | pi-lnk 现状 | 裁决 |
|---|---|---|
| 规格 Schema（acceptance_criteria / dependencies，验收=可执行判据） | todo 契约 `content/activeForm/status`（+9.1 系统 id）；acceptance/dependsOn 在阶段 C-② | **同构**。C-1「硬断言优先 + 画布终态 oracle」与「验收判据=可执行」是同一哲学 |
| DAG 调度器 | 无依赖图；并行靠工具批调用纪律 | **不采**。单 loop canvas agent 无需调度器；v1 §3 已核验「DAG」为二手夸大；dependsOn 保留但降级（见 10.3-2） |
| 文件级状态层 | DB（SQLite）+ 一等事件 + #850 SubagentTask 跨 pod | **基底不采、原则已满足**。文件作 SSOT 对多 pod 服务端是倒退（#850 内存→DB 正是反方向）；审计=executionEvents、断点续跑=W1c+播种、留痕=账本投影，三原则均有对应物 |
| 验收器（不接受模型自述完成） | plan-gate + CAS 终态 + C-2 queued | **同构**，C-2 是正解 |
| 预算化 replan 控制器 | D6 观测规则 + turnBudget + 阶段 C「只观测不自动 replan」 | **哲学同构、其粒度更细**；触发三分类/停滞检测/max_replans 吸收为设计输入（见 10.3-3），不改变「先观测后立项」 |
| 横向设施（工具总线/权限/压缩/human hooks） | tiering + plan-gate + ask_user + compaction 存活 | **基本吃满**；压缩存活等 8 项证据回填仍欠（§9 既有欠账不变） |

**总判定**：第二轮框架与 v1.1 在四个关键裁决上完全一致——契约下沉 schema（非 prompt）、验收器不接受自述、replan 先观测后立项、不建独立 Planner——且本项目各裁决持有更硬的一手证据（Anthropic / Claude Code / Codex 官方文档 + 生产取证）。**方向经第二轮冲击成立，无需方向性修订**；v1.2 只落以下四点增量校准。

### 10.3 四点增量校准（本注记的实质产出）

1. **C-2 边界强化**：`acceptance` 字段撰写时明确「**可执行判据优先，拒绝主观完成描述**」——与 C-1 硬断言立场对齐；判据形态 = 画布终态断言 / `get_generation_status` 可查 / 用户确认记录，三者之一必须可机检或在 C-2 立项 spec 中声明为何不可机检。
2. **dependsOn 降级声明**：明确为「**记录性元数据，不做调度**」——给未来实施刀划 scope 红线，防止膨胀成 DAG 调度器（§5.3 No-Go 增补一行：照搬多 agent 编排的动态 DAG 调度器）。依赖的「执行面」仍由工具批调用纪律 + plan-gate 承担。
3. **replan 预研输入吸收（只登记，不立项）**：将以下三项落为未来 replan 立项的设计输入与 D6 之后的第二观测规则候选——① 触发三分类（原假设被推翻 / 路径卡死报错 / 发现更优路径），三类应映射不同 replan 模式而非一律重规划；② 停滞检测（连续 N 回合既无任务进展亦无新有效事实 ⇒ 触发信号）；③ `max_replans` 预算帽（与 turnBudget 并列的双预算约束，防 replan 成为成本黑洞）。
4. **事实纠偏登记**：cascade-auto / BRACE 等非 WorkBuddy、「文件系统状态层」不适用多 pod 服务端——登记进本注记 §10.1，防止后续调研再被同一来源误导。

### 10.4 与既有队列的接口

本注记不改 §9.6 优先级排序（C-1 → A-2' → Skill SOP → C-2 → 清单/指标）；10.3-1/2 的边界声明在 C-2 / A-2' 各自立项 spec 撰写时生效；10.3-3 仅作为阶段 C replan 预研的输入登记，不产生新刀。本文当前仅本地落档（用户裁决：暂不推 PR，先继续细化探讨）；推送时机由用户单独给出。

---

## 11. A-2' 模型侧 id 契约——语义细化与三项拍板（2026-11-13，细化探讨轮产物；用户裁决「给我决策建议并纳入规格」⇒ 三项裁决按架构建议采纳拍板）

### 11.1 现行语义基线（master `task-state.ts` 130 行逐行核实，2026-11-13）

| 场景 | 现行行为 | 代码依据 |
|---|---|---|
| content 唯一匹配 | 续用旧 id；status 变 → `updates` 事件 | `prevByContent` + `usedIds` 守卫 |
| content 改动（一字即算） | **identity 断裂**：旧项消失（删除）+ 新项新 id（新增）→ `list` 事件 | `:43-50, :55-56` |
| 重复 content 第二次出现 | 判新项、发新 id | `prevByContent` 只留首个 |
| 快照缺席项 | 删除（结构变化） | `:54-56` |
| 纯重排 | 零事件（防卡片抖动） | 文件头注释 |
| 模型侧 schema / 可见性 | **无 id 字段且 `renderTodoBlock` 不渲染 id**（`- [x] content`）——模型连 id 都看不见 | `:124-130` |

### 11.2 十项语义裁决（A-2' 立项 spec 的直接输入）

1. **id = 身份提示，非补丁通道**：全量快照写法不变（文件头原文「勿加旁路」红线），模型每次仍提交完整 items 全集，`id` 为可选字段。部分 id 场景完整性由三层兜底：全量提交（缺席=删除）→ 缺 id 项 content 匹配 → 事件回执（summarize + list/updates）自纠。**不做 delta API**（第二条写路径破坏 `pickLatestSnapshot` 播种；列表 ≤10 项 token 成本可忽略）。
2. **id 优先于 content**：带 id 且存在 ⇒ 身份锁定，content 变化 = 重命名（identity 存活——A-2' 核心价值）；带 id 但 content 撞另一 item ⇒ id 为准，另一项走新项路径（重复 content 允许，id 的存在意义即消此歧义）。`usedIds` 防双用保留。
3. **幻觉/已删除 id ⇒ 工具级硬拒绝【拍板 1】**：错误回执附当前快照摘要（id+content+status）供一次重发自纠。
4. **content 兜底歧义规则**（未带 id 项）：唯一匹配续 id / 多匹配取首个未被本次调用占用的（现行不变，id 通道上线后重复 content 将大幅减少）/ 零匹配新项。
5. **事件不变面零破坏**：list/updates/零事件三分法不动，不加新事件类型。带 id 重命名仍发 `list`（content 集合变化）⇒ 事件面完全一致，仅 list 内 id 稳定，前端零改动。
6. **schema 形态**：`todos:[{id?, content, activeForm?, status}]`；只校验「存在于当前快照」，不锁 `plan-N` 格式（runtime 未来换语义 id 无需动契约）。
7. **identity 断裂 = 现行真实生产缺陷**：模型改措辞重发全列表即触发误删+新增+事件风暴+前端闪烁；todo_write 已 282 次生产调用，场景几乎必然发生过 ⇒ **这是 A-2' 的立项证据**，由 C-1 Q3 观测判据先行量化（见 C-1 spec §8.6）。
8. **`renderTodoBlock` 行格式加 id【拍板 3】**：`- [x] plan-3 content`——必要配套（模型看不见 id 则契约失效），与 A-2' 同刀上线，避免「schema 先行、模型看不见 id」中间态。
9. **回归锁**：task-state.test.ts 现有 13 例全绿不动；新增五例：重命名保 id / 幻觉 id 拒绝 / 部分 id + content 兜底 / 重复 content + id 消歧 / usedIds 防双用保留。
10. **边界**：id 不跨工具（子代理派发引用、assumptions 引用属后续刀）；不做依赖排序（§10.3-2 降级裁决沿用）。

### 11.3 三项拍板（2026-11-13，用户委托按架构建议裁决）

**拍板 1 · 幻觉 id 硬拒绝（非软容错）**。理由：① 现行「不硬校验」哲学（`summarize` 软提醒）针对**语义质量**（多项 in_progress），引用完整性是外键级纪律，两类不冲突；② 静默容错的失败形态是「模型以为更新成功、实际语义漂移」——不可观测的静默失败比显式错误更危险（工具回执是 debug 时唯一真相源）；③ 成本：todo_write 重发极廉价，回执带快照摘要 = 单次自纠回路，无死循环风险；④ 行业先例：Claude Code `TaskUpdate` 对不存在 taskId 直接报错。**防误伤设计**：错误信息必须 actionable（附完整合法 id 清单），不做限流（单次修复回路足够）。

**拍板 2 · C-1 先观测、数据说话后再立项 A-2'（不并行代码刀）**。理由：① A-2' 触生产核心管道（task-state reduce + schema），按纪律须单独授权 + 生产复测；② identity 断裂率是 A-2' 的**价值证明**——若实测极低（模型很少改措辞），A-2' 降级为可选甚至搁置，先观测避免为不存在的问题建机制（「条件触发、不硬锁窗口」一贯纪律）；③ C-1 本就是最高优先级刀（§9.6），Q3 加一条观测判据边际成本 ≈ 0；④ 不并行避免「价值未证明先动核心管道」。**触发捷径**：C-1a 人工跑批期间若观测到断裂率异常偏高、或发生一次真实误删形态，A-2' 立项可即时启动，不等 C-1c 基线建档（条件触发纪律）。配套：C-1 spec §8.6 已加前置观测判据（编写期人工标注「编辑目标 item」，运行时追踪其 id 跨快照存活，只观测不计分）。

**拍板 3 · `renderTodoBlock` 加 id（与 A-2' 同刀）**。理由：① 必要性——看不见 id 则引用契约失效，非可选项；② 预算核算——每项约 +8 字符，20 项清单 ≈ 160 字符，占 48k 动态预算 <0.4%，无膨胀风险；L6 3200 硬线不受影响（renderTodoBlock 属 pi-runtime 动态块，非 prompt-registry）；③ 干扰面评估——id 在动态块中是「可引用的事实清单」，与快照事件 id 一致，无语义噪音；残余风险 = 模型把 id 写进给用户看的回复文本，属文本风格面（summarize 紧凑回执不带 id 的现行设计保留），实测出现再调，不构成否决理由。

### 11.4 依赖链与优先级更新

**C-1（Q3 §8.6 观测）→ A-2'（schema + reduce + renderTodoBlock 同刀）→ C-2（acceptance 引用稳定 id）**。§9.6 排位不变（A-2' 仍第 2），但 A-2' 立项门禁增补一条：**立项评审须引用 §8.6 观测基线数据或触发捷径证据**。Skill SOP / C-2 / 清单注记排位与门禁不变。本节与 C-1 spec §8.6 同为本地落档，推送时机由用户单独给出。

---

## 12. replan 观测判据细化（2026-11-13，方向 3 探讨轮产物；§10.3-3 的展开，仍只登记不立项）

### 12.1 定位与载体

阶段 C 边界「只观测与门禁、不自动 replan」不变。本节产出**观测判据设计**——未来 replan 立项的证据机器。载体与 C-1/D6 同款：**离线 executionEvents 反查 + 既有 metrics，零生产代码**。D6 现行判据（`gate_blocked>0 ∧ 最终文本含已创建 ⇒ 告警`）为本判据集兄弟集，独立有效不替代。

### 12.2 三分类在 canvas 场景的可观测信号（全部已有数据面）

**A 类 · 假设被推翻**：

| 形态 | 信号 |
|---|---|
| A1 参数-实态矛盾 | 读探针（`get_canvas_summary`/`get_node`）→ 紧跟 `ask_user`/`propose_plan` 的「探查→澄清」序列 |
| A2 生成结果不符 | `run_*` 到 terminal 后同轮/下轮出现 `cancel_generation` |
| A3 下轮用户纠正 | 下一条用户消息纠正词（文本层弱信号） |

误报甄别：`ask_user` 是良性问卡原语——判别式 = **澄清前是否发生「探针结果与话术参数矛盾」**，有矛盾先例归 A 类，无矛盾归正常澄清。对应 replan 模式：局部重规划（刷新被推翻假设子集，不动已验证步骤）。

**B 类 · 卡死/路径不可行（信号最硬，先观测）**：

| 形态 | 信号 |
|---|---|
| B1 重复失败 | 同工具+同参数连续 error（`tool-error-class` 结构化分类：`gate_blocked`/`upstream_4xx`） |
| B2 生成反复失败 | `run_*` terminal 非 success（timeout/fallback_pending）≥ 2 次 |
| B3 门反复拦截 | 同 tool 连续被 plan-gate 拒（`pi_runtime_tool_calls_total{result="error",error_class="gate_blocked"}`——**v1.3 纠错**：初稿误写 `plan_decisions_total`，生产指标全集核实无此名，真实观测面 = tool_calls_total 的 gate_blocked 错误分类标签，`tool-error-class.ts:19`） |
| B4 停滞 | 连续 N 回合「无进展 ∧ 无新事实」（§12.3） |

误报甄别：合法单次重试靠连续性阈值排除；**长等待型工具进排除清单**（`run_image_generation` ~3min 等待是正常行为）。对应模式：换路重规划（abort 当前路径，回退上一已验证检查点）。

**C 类 · 更优路径（几乎不可直接机检，只有代理信号）**：C1 执行开始后出现 `plan_proposed`（中途改方案，#839 一等事件可观测）；C2 todo 快照中途全量重写——**与 identity 断裂（§11 拍板 2）区分**：断裂率测非故意丢失，C2 测有意计划修订，判别 = 重写后语义重叠率（编写期人工标注，运行时零推断）；C3 spawn_subagent 返回后主回合换向（弱 → 登记 judge）。对应模式：计划修订（保留已完成步骤 + 重写剩余，行业 split/rework 朴素版）。

### 12.3 停滞检测：三维代理 + N 裁决

「无进展」三维代理（合取判定，防单维误报）：**P1** 本回合无 todo `updates` 事件（status 未前进）；**P2** 无新的成功读探针返回新信息（同工具+同参数判重）；**P3** 回合结束文本无新建/修改类断言（D6 同款文本判据思路）。**停滞 = P1 ∧ P2 ∧ P3 连续 N 回合**。

N 裁决：先验 **N=3**（三维合取下单维误报已压掉）；上界约束 = 远小于 `DEFAULT_TURN_BUDGET=120`（告警须在预算耗尽前留 ≥2 轮自纠，量级上限约 budget 5%）；防呆重置 = 停滞窗口内出现任一 `ask_user`(answered) 即重置（用户介入=新事实）；**数字基线期定**（C-1 同款纪律，先验 3 只作起点）。

### 12.4 max_replans 预算帽的观测期变体

replan 未实现 ⇒ 帽子无处安放。观测期先量**自然重规划倾向率**：A1/A2/C1/C2 信号频次（每千 run）。未来立项时帽子 = 基线 P95 × 安全系数——把「max_replans 取多少」从拍脑袋变为有数据锚的问题。

### 12.5 观测分期（按信号硬度）

先 B 类（B1–B3，结构化数据判据最硬）→ 次 A 类（需先沉淀「探查→澄清」序列离线解析器）→ 后 C 类 + 停滞三维（代理信号最弱，搭前两类解析基建）。远期登记：C-1 Q3 多轮 case 结构构造「必然卡死」剧本观测换路行为——需环境故障注入，超出 eval 现有能力，只登记不承诺。

### 12.6 诚实边界

1. 三分类非正交完备——一次 run 可先后经历 A→B，观测须支持序列记录，「首个触发类」归因会失真；
2. C 类几乎不可机检是**本质限制**（模型不显式声明动机），代理信号 + 未来 judge 是全部手段；
3. 所有阈值（连续失败次数、N、重叠率）基线期定；
4. 本判据集全离线零生产代码；执行时读生产 DB 只读副本（既有纪律）。

---

## 13. Skill SOP × C-1 闭环形态（2026-11-13，方向 4 探讨轮产物；§9.5 的展开与纠偏）

### 13.1 §9.5 表述纠偏（纯追加，不改历史口径）

§9.5「skills/ 尾部固定小节（R5 通道）」混称了两个机制，以本节为准：① prompt-registry **`.tail.md` 后缀规则**（`sidebar_vision.tail` / `memory_scope.tail` 两先例，常驻注入 prompt 尾部、占 L2 组合预算）；② **skills/ 按需加载**（`load_skill` 工具，SKILL.md frontmatter description 承担发现、body 加载后进上下文、零常驻成本）。本节裁决 SOP 走②。

### 13.2 通道裁决：按需加载 skill 是唯一可行通道

| 通道 | 预算现实 | 裁决 |
|---|---|---|
| prompt-registry 新 tail rule（常驻） | L2 todoTools 组合 3197/3200 余 3 字符，物理封死 | ❌ 短期 No-Go（腾挪旧条文须独立评审） |
| `task_tool.md` 扩写（L6） | 同封死 | ❌ |
| **skills/ 新增拆解 SOP skill（按需）** | 零常驻成本 | ✅ 唯一可行 |
| 双层（skill 主体 + 常驻一行） | 余 3 字符放不下任何一行 | ❌ |

**时序悖论与缓解**：SOP 是「拆解前」需要的知识，模型不拆就不会 load——三层缓解：① description 关键词化是生命线（`ecommerce-product-photo` 0.5.1 生产实证：description 缺触发词 → load_skill 0 调用 → 指引不进上下文；触发词族覆盖「多步任务/规划/方案/一步步/先做啥/任务清单」）；② 接受部分激活率，用 C-1 AB 量化差值（#858 的 27%↔70% 方法学直接复用）；③ 远期升级路径 = tail rule 常驻通道，前置 = 腾挪 L2 旧条文（独立评审不搭车）。

### 13.3 闭环核心设计：SOP 条文与 eval 判据一一映射

**每一条 SOP 纪律必须能在 C-1 四象限中找到对应判据，找不到判据的条文禁入 SOP**：多步先 propose ⇔ Q1 正例 / 单步不拆 ⇔ Q1 负例（§8.2）/ 首步收集 ⇔ `firstStepPredicate` / 清单规模互斥 ⇔ `minItems/maxItems+requireDistinctContent` / 增量维护收尾清态 ⇔ Q3 / 调研派发 ⇔ Q4（观测期）。反向：「粒度适中」类无判据条文禁入——防 SOP 退化成不可证伪的 prompt 装饰（「提示词层被生产证伪两次」教训）。这使「SOP 定义质量 → eval 验证质量」闭环成为机械保证：SOP 每句话都有对应红绿灯。

### 13.4 闭环运转与归因纪律

C-1a 基线（SOP 缺席）→ SOP 上线 → AB 对比（激活 vs 不激活的触发率/结构达标率）→ C-1b 门禁防回退；eval fail 三分类归因（模型行为/判据/环境），**只有模型行为失败且跨 case 模式化才触发 SOP 修订**（单次抖动不动，repeat 表决已滤；判据问题修判据）；SOP 修订本身须过 AB，防条文膨胀。

### 13.5 排期与部署陷阱

**C-1a 先行（无基线则 SOP 效果不可证伪），SOP 刀在其后、可与 C-1b 并行；分开 PR**——C-1 是测试侧资产（`src/eval/**`），SOP 的 skills/ 是生产注入面。⚠️ **部署陷阱（#858 同款前科）**：`deploy.yml` push.paths **不含 skills/** ⇒ 改 skills/ 不触发自动部署，须手工 dispatch `runtime-deploy`（构建源 = 主仓 rsync 快照会进镜像但不触发 CI/CD）——合并≠上线，此条不登记必重演「合并了以为上线了」。诚实边界：① 激活率是最大未证假设，AB 差值趋零则止损（SOP 不值得常驻）；② 本节裁决通用拆解 SOP，垂类步骤内指引已存在（drama-* workflow），不重复建设；③ `buildSkillIndexBlock` 索引块预算归属立项时核。

---

## 14. C-2 · acceptance 字段与 after_tool 收尾校验（2026-11-13，方向 5 探讨轮产物；阶段 C-② 的展开）

### 14.1 现状锚（2026-11-13 核实）

- **接线点已证**：`after_tool` 钩子真实存在且已在生产使用（`session-manager.ts:616` HITL Gate 注册 per-session before_tool/after_tool 先例；`:1704-1710` after_tool 已做增量观测，hooks 缺席 fail-soft）——收尾校验是既有钩子的第二消费者，非新机制；
- **oracle 底层已证**：`get_generation_status`/`list_generation_tasks` 底层实现（`canvas-read.ts`）直接复用；
- **生产先例**：write-guard-002「只建节点不落参数视为未完成」（规则 15）——acceptance 是该文本规则的结构化升级；
- **依赖链**（§11.4 拍板）：C-2 依赖 A-2'（acceptance 引用稳定 id），不并行（两刀同触 task-state 管道）。

### 14.2 字段形态：声明式判据 DSL，与 C-1 §8.3 同一套（核心复用点）

```ts
acceptance?: {
  kind: "generation" | "canvas_state" | "user_confirm";  // 枚举封死：只允许三类可机检 oracle
  generation?: { requireSucceeded?: boolean };            // 缺省 = submitted 级（弱判据，仅收尾提交类任务）
  canvasState?: { nodeCount?; nodeTypeCounts?; noOverlap? };  // 与 C-1 expectCanvasState 同款子集
};
```

**一套 DSL、两个消费方**：`expectCanvasState`（C-1 eval 离线）与 `acceptance.canvasState`（C-2 生产实时）共享判据函数——eval 验证过的判据在生产语义相同，杜绝「eval 绿、生产拦」分裂。**自由文本禁入**：不设任何自由文本字段（v1.3 减法裁决，路标 §19.1：初稿的 `note` 字段砍除——说明性内容已有 item `content` 与 propose_plan `explanation` 两个载体，防字段膨胀且消除与「自由文本禁入」的自相矛盾；实施时确有需要再加）；「用户满意/效果好看」类语义判据无处安放即设计意图——不可机检的验收不许声明。

### 14.3 校验语义：fail-closed / fail-open 二分

模型把带 acceptance 的 item 标 `completed` 时 `after_tool` 校验：

| 情形 | 处置 | 理由 |
|---|---|---|
| 判据不满足（如 generation status=timeout） | **拒绝该 todo_write**，错误回执 = 证据差 | 与 §11.3 拍板 1 同构：引用完整性硬拒（A-2'）+ 自述完成不被证据支持硬拒（C-2）=「不接受自述完成」哲学的两半 |
| oracle 查询本身故障 | **放行 + 软提醒 + fail-open 计数** | 环境故障不伪装成模型作弊；fail-open 率是机制健康度指标 |

拒绝非绝路：模型收证据差后**继续干活**（重试生成）或**如实降级**（分项说明哪些真完成）均正确——谎报是唯一被堵死的路。

### 14.4 防游戏化与豁免面

schema 层最低强度约束（不靠 prompt）：generation 二选一——显式 `requireSucceeded: true` 或缺省（缺省即 submitted 级，不存在第三种「显式声明 submitted」形态，v1.3 措辞修正）；canvas_state 至少一谓词；kind 缺失 = 字段非法（validation error，同 A-2' 幻觉 id 处置）。豁免面：探索/澄清类任务无 oracle，acceptance 可选不强制；事实强制面 = 生成类任务收尾。fail-open / fail-closed 边界的可判定定义（探针超时阈值等）立项 spec 给出，本节不锁数。

### 14.5 观测面、分期与诚实边界

立项证据三指标：**写入率**（模型声明意愿——A-2' 同款风险，SOP 教写、判据入 C-1 Q3）/ **fail-closed 拦截率**（真问题发现率）/ **fail-open 率**（机制健康度）。分期按信号硬度：C-2a 生成 oracle 子域（最硬）→ C-2b canvas_state 扩展（探针复用 C-1 已扩展两处）→ C-2c 基线建档 + 阈值提案（人工拍板）。诚实边界：① oracle 子域覆盖面有限（美学/语义任务永不覆盖）——acceptance 是「收尾机检」非「全部验收」，用户满意度永远在机检之外；② 模型不写则机制空转——写入率趋零则止损（同 §13.5 SOP 激活率条款）；③ acceptance 判「生成成功」不判「用户满意」，两者不矛盾。

---

## 15. 五方向产物一致性核对（2026-11-13，方向 5 收尾时执行；用户裁决「核对一致性但不推 PR，继续讨论」）

### 15.1 交叉引用核验清单（全部通过）

| 引用 | 状态 |
|---|---|
| §11.2-7 / §11.3 拍板 2 ⇄ C-1 spec §8.6（双向：立项证据 ⇄ 前置观测判据） | ✅ |
| §12.2 C2 类 ⇄ §11 拍板 2（identity 断裂 vs 有意计划修订的判别） | ✅ |
| §13.3 SOP 条文 ⇄ C-1 §8.3 字段（firstStepPredicate/minItems/maxItems/requireDistinctContent） | ✅ 字段名一致 |
| §14.2 acceptance.canvasState ⇄ C-1 §8.3 expectCanvasState（子集复用 + generation 两级映射） | ✅（submitted/succeeded 两级 ⇔ requireSucceeded 缺省语义，语义对齐） |
| §10.3-3（只登记）→ §12（展开，仍只登记不立项） | ✅ |
| §10.3-2 dependsOn 降级 ⇄ §11.2-10 边界 | ✅ |
| §13.1 对 §9.5「R5 尾部小节」的纠偏（纯追加，未改 §9.5 历史口径） | ✅ |
| §11.3 拍板 1（幻觉 id 硬拒绝）⇄ §14.3（acceptance 校验拒绝）哲学同构声明 | ✅ |

### 15.2 本次核对发现并修复的三处（均纯追加/澄清，不改历史口径）

1. **§5.3 No-Go 表悬空引用**：§10.3-2 写「No-Go 增补一行」但 v1.2 落档时未真加到 §5.3 表 ⇒ 本次补行（标「v1.2 增补」）；
2. **C-1 spec §8.6 时序矛盾**：原文「C-1a 人工跑批观测」与 §6 分期矛盾（identity 断裂是 Q3 多轮判据，正式落地在 C-1b）⇒ 已澄清：正式判据随 Q3 在 C-1b 生效，C-1a 捷径指人工跑批**顺手观测**（不需正式判据）；
3. **头部注记滞后**：版本行只记到 §10 ⇒ 已补记 §11–§15 与 §5.3 增补。

### 15.3 时序澄清（§9.6 线性排序为优先级语义，非严格时序）

细化后的实际时序：**C-1a 基线 → { A-2' 评审（引 §8.6 数据或 §11.3 拍板 2 捷径）、SOP 刀（可与 C-1b 并行，§13.5）} → C-2（依赖 A-2'，§14.1）**。§9.6 的「C-1 → A-2' → Skill SOP → C-2」排序表达的是优先级与依赖方向，与上述时序不矛盾；后续立项 spec 引用时以本节时序为准。

### 15.4 全局一致性总判定

五方向产物（§11–§14 + C-1 §8）无相互矛盾；三条主线（质量可测 = C-1、质量可产 = Skill SOP、质量可判 = A-2'/C-2）与观测线（§12 replan）的判据复用关系成立：**一套声明式 DSL（C-1 §8.3）服务四个消费方**——C-1 eval 离线、A-2' 快照契约、C-2 生产校验、§12 观测脚本。止损条款横向统一（SOP 激活率 / acceptance 写入率 / A-2' 断裂率三者同为「数据说话、趋零止损」纪律）。状态：两文件仍全部本地落档未推 PR；讨论可继续，推送时机由用户单独给出。

---

## 16. 六支柱吸收度终审 + ②③ 对抗性复审（2026-11-13 凌晨，用户两轮追问产物；本地落档未推 PR）

> 输入：用户先问「六支柱是否充分吸收」，再对抗性追问「②③ 为什么不能充分吸收、WorkBuddy 若是最佳实践是否应跳出当前实现重构照抄」。本章是对 §10.2 粗判定的逐支柱复核，比较对象以本产品运行现场的一手观察为准（不是引文的二手描述）。

### 16.1 六支柱吸收度终审表（取代 §10.2 的粗判定行；**后被 §17.4 终版矩阵取代——本表仅存历史比对价值，判定一律以 §17.4 为准**）

| 支柱 | 吸收度 | 落点 | 审计意见 |
|---|---|---|---|
| ① 规格 Schema | ✅ 充分吸收 | §9.1（系统 id）、§11（A-2'）、§14（acceptance DSL）、C-1 §8（硬断言） | 三层契约（目标描述/寻址/验收判据）比引文原方案更细；「验收=可执行判据」经 §10.3-1 与 §14.2 采纳 |
| ② DAG 调度器 | ⚠️ 判词修正见 §16.2 | §10.3-2 + §5.3 No-Go 行 | 「不吸收」表述不准确——已吸收 WorkBuddy 真实形态（声明式依赖边），拒绝的引擎 WorkBuddy 自身也没有 |
| ③ 文件级状态层 | ⚠️ 拒机制、采原则，见 §16.3 | 运行时 DB+事件态（#845–847/#850/W1c）；研发流程层已照抄（specs/plans/memory 全文件化） | 不变式（审计/恢复/留痕）全覆盖；机制是部署形态的函数 |
| ④ 验收器 | ✅ 充分吸收（最大增量） | §14 fail-closed/fail-open + after_tool 机检 + 防游戏化 + golden-cases 纪律 | 「验收固化成脚本」字面落地：acceptance 与 C-1 eval 共享同一份判据 DSL |
| ⑤ 预算化 replan 控制器 | ✅ 观测级吸收、实现按纪律后置 | §12（三分类 + 停滞 N=3 + 倾向率基线）+ turnBudget=120 + D6 | 「双预算帽」哲学进入：步骤帽已有，replan 帽转基线先行，数值等数据 |
| ⑥ 横向设施 | ✅ 基本吃满，**一处欠账** | tiering（#841 §7 同构）+ plan-gate + ask_user + compaction 设计 | 欠账：压缩存活等 8 项交付清单证据待回填（§9.6 优先级 5 清单刀），是六支柱唯一未闭环项 |

### 16.2 ② 的判词修正——「不吸收」改为「已吸收真实形态，引擎双方皆无」

**一手观察修正比较对象**：WorkBuddy 的 Task 工具族确有 `blockedBy` 依赖边（本产品运行现场的 TaskUpdate schema 即含 `addBlockedBy`），但**没有调度引擎**——任务由模型自建、依赖由模型自填、执行顺序由模型自律判断、状态由模型自行更新，不存在按依赖边并行派发的 orchestrator。「动态 DAG 调度（split/rework/refine）」出自 cascade-auto 等外部项目（§10.1 张冠李戴登记）。

⇒ **WorkBuddy 的真实最佳实践 = 声明式依赖元数据 + 模型自律 + 人工可读清单**，而 §10.3-2（dependsOn 降级为记录性元数据）采纳的正是这个形态。真正的分歧只剩一个可操作问题：**pi-lnk 现在要不要加 dependsOn 字段**。

**裁决：登记为候选、不现在加（等数据触发）**。理由：canvas agent 清单 ≤10 项、生产 282 次 todo_write 无「顺序混乱」类故障报告（失败面不存在）；id/acceptance 的契约价值已有证据锚定而 dependsOn 没有。触发条件 = C-1 Q3 观测到模式化「顺序混淆」失败（模型因顺序判断重做/重排）。这与 §15.3 时序纪律一致：等数据，不是拒绝借鉴。

### 16.3 ③ 的部署形态决定论——优劣势对比与重构 No-Go

**核心命题：文件态 vs DB 态不是优劣之分，是部署形态的函数。** 文件态的全部优雅性严格依赖「单用户、单机、单写者、会话作用域」前提——WorkBuddy 满足（本产品即如此运行）；pi-lnk 天然不满足（多 pod 并发、多会话、多端访问）。

| 维度 | WorkBuddy 文件态 | pi-lnk DB+事件态 |
|---|---|---|
| 人工审计 | ✅ 直接 cat/git（杀手锏） | ⚠️ 需工具辅助（已有替代：executionEvents 账本投影 + 只读取证流程） |
| 并发正确性 | ❌ 无锁竞态裸奔——**WorkBuddy 自身事故实证**：并发 worktree 冲突、误覆盖他人改动、状态漂移需人工纠偏（均有项目级纪律条文背书） | ✅ 事务 + CAS——#850 的 CAS 终态正是因两 pod 竞写子代理状态而建，反向实证 |
| 断点恢复 | ✅ 读文件即恢复 | ✅ W1c + pickLatestSnapshot 播种 + PendingInterruption durable（同问题不同解） |
| 查询能力 | ❌ 全量解析无索引 | ✅ SQL 按需查询（metrics/取证/观测脚本全依赖） |
| 用户可修 | ✅ 手改文件即生效 | ⚠️ 需管理面（当前受控数据清理流程，笨但可用） |
| 零迁移/可移植 | ✅ 拷走即用 | ❌ schema migration |

佐证：WorkBuddy 自身的**协作类资产**（腾讯文档/资料库/云端知识库）同样走服务端存储——它在多端并发场景也选了数据库。「状态放文件系统」是「单机单写者」形态的最佳匹配，不是普适最佳实践。

**重构照抄裁决：No-Go。** 三层理由：① **问题不存在**——文件态三大优点（审计/恢复/留痕）全部有生产实证的对应物，DB 态代价要么被工具缓解要么只影响管理侧，无失败面不值得重写；② **反事实成本**——动持久层触碰 session-manager + Nest + 事件管道 + 前端折叠 + migration，多周级重写换收益趋零 + 回归风险满格，与项目「小刀可回滚数据说话」纪律全面相悖；③ **照抄悖论**——不变式已满足，机制是形态的函数，照抄机制不匹配形态抄来的是负债（把 WorkBuddy 自己都被咬过的竞态事故引入多 pod 环境）。

**重审触发条件**（非永久关闭）：部署形态变化（出现单用户本地模式）；多 agent 并行编排成为真实需求（届时是新编排子系统而非重构持久层）；C-1 Q3 观测到顺序混淆模式化失败（届时按 §16.2 加 dependsOn）。

**增量让步两项**（文件态确实值得借鉴的部分）：① 运维面「一眼看懂全局」不如 cat 一个文件——低成本补法 = 观测/取证报告保持「清单化终态快照」惯例（复测报告已在做），不改架构；② WorkBuddy 记忆的分层纪律（append-only 日志 + 30 天蒸馏 + 索引层）是文件态真正好的部分，且 `.workbuddy/memory/` 已逐条照抄——**在研发流程层本项目已经在照抄 WorkBuddy**。

### 16.4 总判定

六支柱中四个充分吸收（①④⑤⑥）、两个为「有理由的部分吸收」且判词经本轮复审修正：②实为已吸收真实形态（引擎双方皆无）、③为拒机制采原则（不变式全覆盖 + 机制随形态）。**不存在「WorkBuddy 是最佳实践所以应重构照抄」的情形**——本规格对六支柱的处理已达到「吸收问题-解法匹配、拒绝形态错配」的完备度；后续引文调研继续按 §10.1 三层核验过滤。本章与 §15 一致：全部本地落档未推 PR，推送时机由用户单独给出。

### 16.5 支柱① 三子项分解映射 + scope 半缺口登记（2026-11-13，用户追问「三条子项是否重复吸收」）

对 §16.1 支柱①做子项级核查（引文三 bullet：结构化规格 Schema / 规格清单落盘版本化 / 目标层→任务层降维），锚点为 master `propose-plan.ts` 逐行核实：

**子项 1 · 结构化规格 Schema——四字段三有一缺**：

| 引文字段 | pi-lnk 对应物 | 状态 |
|---|---|---|
| title / description | todo 契约 `content`（祈使句、字面精确匹配用于状态追踪）+ `activeForm` | ✅ 生产已有（master propose-plan.ts:46-47） |
| acceptance_criteria | C-2 §14 acceptance DSL（kind 枚举封死、可机检判据） | ✅ 已落档待实施 |
| dependencies | §16.2 dependsOn 候选登记 | ✅ 有裁决有触发条件 |
| **scope（改动边界）** | **无契约载体** | ⚠️ **半缺口** |
| 「验收=可执行命令非主观描述」 | §10.3-1 + §14.2（`note` 自由文本禁入判定） | ✅ 哲学全文吸收 |

**scope 半缺口取证**：master `propose-plan.ts` schema 为 `{summary, steps[], explanation?}`——`explanation` 是自由文本兜底，**无结构化边界声明**；工作记忆中的「propose_plan assumptions[]」是阶段 A 队列项**尚未实施**（核查纠正了一处差点误引为「已有」的表述）。机制层有部分对应物（plan-gate 拦截面管写操作时机、write tier 管权限），但「本方案会改哪些节点、明确不碰哪些」的契约语义无处安放——canvas agent 的爆炸半径是画布改动半径，语义成立、载体缺失。

**裁决：scope 并入阶段 A-3 队列项**，表述修订为「propose_plan 增结构化 `assumptions[]`（前提假设）+ `scope`（改动边界声明）」——两者同为方案边界契约、同刀落成本最低；且 C-2 acceptance 未来可引用 scope 做对照锚（改了什么 vs 说了要改什么）。不现在加的理由同 dependsOn：等 A-2'/C-1a 数据先行，且 propose_plan schema 改动须与 #831/#839 可见性链合并评审。

**子项 2 · 落盘与版本化——机制层全覆盖**：`pipeline-state.yaml` ↔ todo 快照 + `pickLatestSnapshot` 播种；版本化 ↔ **executionEvents append-only 账本**（#845–847，比 md 文件更强：可查询/可投影/防篡改）；SKILL 文件与记忆 Markdown ↔ 研发流程层已逐条照抄；用户可审计 ↔ 前端 todo 卡片 + 时间线 + `plan_proposed` 一等事件卡（#839）。

**子项 3 · 目标层→任务层降维——充分吸收（含判词修正）**：拆解粒度自适应 ↔ C-1 Q2 + Skill SOP（§13 条文↔判据映射）；「保证 DAG 而非线性列表」↔ §16.2 已裁决双方真实形态均为线性清单 + 模型自律，DAG 引擎双方皆无；「规划器只产出制品、不直接动手」↔ plan-gate（PLAN_GATED_TIERS 拦写）即该语义，#841 §7 已有 Claude Code plan mode 对标。

**本节总判定**：三子项中两项充分吸收；子项 1 暴露一个真实的 scope 半缺口——**这是多轮审视后首次新增的契约队列项**，已并入 A-3 表述，其余吸收判定不变。仍全部本地落档未推 PR。

### 16.6 支柱② 三子项分解映射 + 并行/串行条文缺口登记（2026-11-13，用户追问「拆解与调度三子项是否充分吸收」）

对 §16.1 支柱②做子项级核查（引文三 bullet：动态 DAG 调度 / 依赖感知并行串行策略 / 单窗可执行粒度）。

**子项 1 · 动态 DAG 调度——能力层吸收（观测级），引擎层拒绝（判词已立）**：

| 引文要素 | pi-lnk 对应物 | 状态 |
|---|---|---|
| split / rework / refine / remove（中途改图） | 中途 `propose_plan`（§12 C1 信号）+ 快照全量重写（§12 C2 信号，与 identity 断裂判别 = 语义重叠率） | ✅ 能力被 §12 吸收为观测判据 |
| 6 状态 FSM | todo 3 状态机 + SubagentTask 状态机（CAS 终态） | ✅ 状态机存在，规模刻意简单（防误报，§11 语义矩阵锚） |
| 边携带 contract（上游承诺/下游期望） | 最近似 = spawn_subagent 派发 prompt + SubagentTask CAS 终态承诺 | ⚠️ 弱对应物——单 loop 无边则无边契约，不需要而非缺失 |
| 调度引擎本体 | 无 | ❌ §10.1 张冠李戴 + §16.2 判词（外部项目产物，WorkBuddy 亦无） |

**子项 2 · 依赖感知的并行/串行策略——⚠️ 新缺口：提示层零条文**。取证：`prompt-registry/rules/` 全目录 + pi-runtime 提示层「并行/串行」纪律 **零命中**（grep -E，规避 BSD 轮替假 0）。L6 `task_tool.md` 仅有「先 propose 征确认、确认前不写画布不调生成」——该最关键依赖（确认→执行）的串行是**机械层 plan-gate 承担**（PLAN_GATED_TIERS 拦写），非提示条文。缺口实际权重低：① 机械层已覆盖最危险依赖（比条文更硬）；② 并行批调用的省 token 收益属 coding agent 重读场景，canvas 读探针便宜；③ 乱序写有 write-guard 规则 15 + HITL ask_user 兜底；④ 补条文通道双双封死（L6 余 3 / L2 组合余 3，§13.2 锚）。**裁决：登记为 SOP skill 条文候选，判据 = C-1 Q3「乱序调用导致的失败重试」观测信号，等 C-1a 数据触发（与 §16.2 dependsOn 同款纪律）**。

**子项 3 · 单窗可执行粒度——充分吸收**：「一窗内完成 + 边界清晰」↔ C-1 Q2 判据（items 区间/互斥/无巨石项）+ 巨石项失配代理（§8.2）；「改哪些文件、不碰哪些模块」↔ scope 半缺口已在 §16.5 登记（A-3 修订），交叉引用即可；「失败可回退」↔ todo 重发 + 子代理 CAS + W1c 重连恢复——诚实边界：画布操作可逆性靠 write-guard + ask_user 控在**事前**，不做事后回滚（画布域特性而非缺口）。

**本节总判定**：子项 3 充分吸收、子项 1 能力层吸收引擎层拒绝、子项 2 暴露提示层零纪律缺口但权重低（机械层 plan-gate 扛最危险依赖）——处理 = 并入 SOP 条文候选登记。**多轮审视累计新增的两个「登记 + 等数据」候选：§16.5 scope（→ A-3）、§16.6 并行串行条文（→ SOP skill）**，均不立即实施。仍全部本地落档未推 PR。

### 16.7 支柱⑥ 三子项分解核查——无新缺口（2026-11-13；§16.1 判定经子项级复核成立）

**子项 1 · 工具总线与权限闸门——形态适配画布域的充分吸收**：JSON Schema 契约 ↔ 全工具 TypeBox schema + description 承担发现（#858 生产实证）✅；写操作串行/并发写语义 ↔ **SP-E 并发写专项闭环**（#802/#805/#810/#813 + #625 NO_GO，独立已收口工程线）✅；三道闸 ↔ **plan-gate（机械闸）+ write-guard 提示词规则 + HITL ask_user / propose_generation 用户批准** ✅；「沙箱」↔ 形态差异非缺口——画布域爆炸半径是画布改动而非文件删除，沙箱职能被 tiering + 三道闸拆分承担。「读并行写串行」提示条文缺口与 §16.6 子项 2 同源，交叉引用不重复登记。

**子项 2 · 上下文工程与压缩——大体吸收，残留即已知欠账**：长内容外置 ↔ **生成结果天然外置于画布**（不进上下文，`get_generation_status` 查询式读回——canvas 域比 coding 域更彻底）✅；压缩 ↔ compaction 存活设计已建、**8 项交付清单证据待回填**（§16.1 已登记的支柱⑥唯一欠账，无新增）；「每 turn / 每 run 固定管线」↔ `composeEntryAndObserve` 每 turn 重求值（48k）+ `pickLatestSnapshot` 恢复期播种，两条固定管线同构 ✅；记忆召回管线 ↔ 无对应物，session-scoped canvas agent 无长期记忆需求，非缺口。

**子项 3 · 人类介入的接口化——充分吸收且比引文更具体**：定目标 ↔ 用户输入 + `propose_plan` 方案确认（#839 一等事件）；纠偏 ↔ ask_user 决策原语 + 澄清矩阵；审批 ↔ plan-gate + propose_generation 确认闸；验收 ↔ C-2 acceptance（待实施 §14）；「显式 hook/状态出口，不靠人读聊天记录猜」↔ **生产实证最强对应**：`plan_proposed` 一等事件卡 + ask_user 终态卡三态（已回答/已超时/已跳过）+ PendingInterruption durable（#846/#848 W1c）——介入状态是结构化持久化对象，前端刷新/重连可重建。

**本节总判定**：三子项全部有落点、无新缺口；§16.1「⑥ 充分吸收、一处欠账（压缩证据回填）」经子项级复核成立。**至此六支柱子项级审计全部完成**：①②③⑤⑥ 已分解核查，④ 经 §16.1 整支柱判定充分（acceptance DSL 与 C-1 共享判据函数即为子项级证据）。

### 16.8 部署形态演进澄清——客户端 APP 的两种形态与 §16.3 触发条件接线（2026-11-13，用户澄清事项）

**问题**：本项目后续部署形态是否可演进/迭代为 WorkBuddy 式客户端 APP 产品？

**现状锚**（仓库核实）：`apps/{server, web}` + `packages/{agent, pi-poc, shared}`，前端 Vue 3 + Vite，无 electron/tauri/react-native 包装痕迹——server-first Web 产品。

**裁决：可演进，但「客户端 APP」有两种形态，对规格含义完全不同**：

- **形态 A · 瘦客户端（客户端 = UI 壳，运行时仍在服务端）——架构零障碍，属迭代**。前后端已分离，事件一等化（#845–847）+ W1c 重连恢复（#848）+ PendingInterruption durable 使前端成为「可任意替换的薄壳」——换 Electron/Tauri 桌面壳或移动壳，改动只在 UI 层，C1–C5 任务管理体系原封不动。**部署形态未变**（agent 运行时仍多 pod 服务端）⇒ §16.3 文件态裁决不触发，DB + 事件账本仍正确。
- **形态 B · 本地运行时（agent 跑在用户机器上）——部署形态真变化，属新产品线而非迭代**。触发的改动面：pi-runtime 打包形态（K3s → 本地进程）、工具面重构（画布工具 → 本地/混合）、持久层（本地 SQLite + 云同步，冲突消解重做）、plan-gate/write-guard 爆炸半径语义全变（本地真实文件系统危险等级远高于画布）。**这正是 §16.3 已登记的重审触发条件第一条**——若走此路，文件态/持久层重审按已登记条款启动，本轮裁决无需推翻（规格写的即「形态函数」）。

**WorkBuddy 参照**：客户端 APP ≠ 本地一切——其形态为「本地工具壳 + 云服务」混合（协作资产仍在服务端存储）。即使形态 B，任务状态的多端同步层大概率仍是服务端 DB。

**对任务管理路标的含义**：① C-1/A-2'/C-2/Skill SOP 的**原则层与部署形态正交**（硬断言、可执行判据、寻址契约、观察门禁在哪边都成立），仅机制载体（SubagentTask DB CAS、plan-gate tier 拦截）在形态 B 下需本地等价物；② §16.3 触发条件已预埋，形态 B 启动即触发重审而非推翻；③ **诚实边界**：形态选择是产品/商业决策（目标用户、分发渠道、离线需求），超出技术裁决范围。技术判据一句话：**形态 A 是前端替换（迭代），形态 B 是运行时重打包（新产品线）**——后者启动前应立独立形态可行性 spec，且建议先用「瘦壳 + 现有服务端」验证客户端分发价值再决定投入。

本节仍为本地落档，未推 PR；推送时机由用户单独给出。

---

### 16.9 上游 subagent 编排机制核验——四角色/三 preset/三模式事实表、借鉴度判定、取证盲区纠偏、规划职责边界裁决（2026-11-13，用户澄清事项）

**前提核验命中（用户记忆正确，我方此前结论需精确化）**：上游 `packages/coding-agent/examples/extensions/subagent/` 确有完整编排实现，全部一手读码核实。

**事实表**：

- **四角色**（各带 system prompt + tools 白名单 + model 分级）：`scout`（haiku 便宜模型、只读侦察、输出压缩上下文供交接）/ `planner`（read/grep/find/ls、明禁改动、接收 scout 上下文产出实施计划）/ `reviewer`（只读 bash: git diff/log/show，且写明「假设权限不可完美执行，严格只读」——纵深防御提示词纪律）/ `worker`（全能力通用）。
- **三套编排 preset**：`scout-and-plan`（侦察→计划，不实施）/ `implement`（侦察→计划→实施）/ `implement-and-review`（实施→评审→整改闭环）。
- **三种调用模式**（index.ts:462-493）：`single` / `parallel`（tasks 数组）/ `chain`（顺序 + `{previous}` 占位符跨步骤传输出）。

**借鉴度判定**：生产 `spawn_subagent`（master 核实）schema 仅一个 `task` 参数——已借鉴 = 核心原语「隔离上下文委派 + 报告回传」（#838 常驻 + #850 单据 + #858 点名线）；**零借鉴 = 角色分化（per-role tools 白名单 + model 分级）、parallel/chain 编排、`{previous}` 交接**。「零借鉴」≠「应立即借」：spawned 刚 0→1（1 次），角色分化价值（haiku 侦察省 token、隔离评审）同样数据触发。

**取证盲区纠偏**：§10.1「上游在 subagent 维度无轮子可抄」须精确化——pi-agent-core（packages/agent）无 subagent 属实（README 声明），但 **coding-agent examples 层有完整编排参考实现**，此前检索漏 examples 层（B-4「漏部署单元」教训的代码层变体）。⇒ **阶段 B「上游原语吃满」清单增补：subagent 角色分化 + 编排模式**（本轮审视新登记项，数据触发后立项）。

**规划职责边界裁决**（问题：任务规划拆解是 subagent 还是主 agent 的职责？）：上游三条 preset 的结构即答案——**技术实施计划起草可下放给 planner subagent**（只依赖侦察摘要、不需完整对话史），但**何时触发链、链的编排、结果采纳全部留在主 agent**（preset 是主 agent 按需调用的模板）。行业收敛（Claude Code plan mode 为主 agent 模式 + Plan/Explore 只读调研；WorkBuddy propose_plan/todo 由主 agent 调用）= **Planner-Executor 轻分离**：目标层规划（要不要做/方向/与用户往返）= 主 agent 保留——它依赖完整对话上下文，恰是 subagent 隔离上下文牺牲掉的东西；技术层拆解与重上下文工作（侦察/大规模阅读/评审）可下放，前提是「拆解所需信息可被压缩传递」。**pi-lnk 现状（主 agent 调 propose_plan/todo_write + plan-gate 用户审批 + spawn_subagent 委派调研）即该边界，现状正确无需改**。planner/scout 角色分化登记为数据触发候选：判据 = 长调研后上下文质量衰减信号（与 C-1 Q4、#841 预案观测面衔接）。

本节仍为本地落档，未推 PR；推送时机由用户单独给出。

---

## 17. 第三轮对抗复审——版本纠错、上游代际图景、生产取证更新、矛盾消解（2026-11-13 上午，推送前用户要求「不轻易采信、结合生产最新取证、研究上游项目版本与最新版本」）

> 本轮方法：① 上游版本对照（gh api 直读 upstream releases）；② 生产 metrics 全集取证；③ §9–§16.9 内部矛盾扫描；④ 事实性引用逐条对源码核验。产出四处修正 + 一处跨文档注记 + 一处表述升级，全部在推送前完成（未推内容直接改，已推历史用注记）。

### 17.1 版本号纠错与上游代际图景（重大）

**纠错**：本文头部「上游 pi 0.85.1」有误。实际 vendored 版本 = **`@earendil-works/pi-agent-core@0.99.2`**（`VENDORED.md` 明写：v0.99.2 是 harness（AgentHarness/Lane/drive）**存续最后一版**；0.85.1 属本地陈旧文档分支 `5926ac72` 的数字，误入早期会话记忆并被引用——#850 相关 spec 早已正确记载，本轮复审校正）。

**上游代际图景**（gh api 直读 upstream releases，v1.5.2 = 2026-11-10 发布）：

- **v1.0.0 起 harness 整体移除**，改由实验性 `pi-durable` 承接——**上游 1.x 不是 0.99.2 的迭代而是 harness 的替换**（`2026-11-12-subagent-task-ledger-design.md` §3.2 已判定「两代不是同代能力」，pi-durable 契约在 0.99.2 上不可调用）。
- coding-agent 线持续演进至 v1.5.2，与本任务管理路标相关的新能力：**codemode**（并行脚本与进程内 subagent 排队而非失败，`PI_CODEMODE_MAX_WORKERS`）；**compaction/branch 摘要去固定输出上限**（v1.4.0，长推理不再使摘要失败）；**cache warming**（空闲期保持 prompt cache 热，v1.5.1）；**Anthropic message threads**（增量发送，v1.5.1，成本优化）；**session fork**（v1.5.2）。

**对路标的实质影响**：阶段 C 原文「1.0.0 upmerge 预研」表述**升级为「pi-durable 迁移评估」**——upmerge 一词暗示版本推进，实际是 harness→durable 的架构迁移决策，性质完全不同。冻结 0.99.2 期间「吃满上游」的正确姿势 = **概念 backport**（把 1.x 的机制思想移植进本项目实现），而非版本升级。三个 backport 候选只登记：① compaction 摘要去上限思想（对「压缩存活 8 项证据」欠账的改进方向）；② codemode 排队思想（spawn_subagent parallel 模式实现时的队列语义参照，§16.9 已登记编排模式为阶段 B 增补）；③ cache warming / Anthropic threads（成本优化面，与 usage_cost_total 指标联动观测）。

### 17.2 生产取证更新（2026-11-13 10:25，build `16e4fc99` 存续期计数器）

| 指标 | 现值 | 判读 |
|---|---|---|
| `subagent_spawned_total` | **3** | **#841 预案 T1∧T2（7 天/200 run spawned 恒 0 才触发）正式死亡**——spawned 持续 >0，观测重心=持续性（§9.2 判读被证实） |
| `subagent_outcome_total{completed}` | **3** | 3/3 完成，零孤儿 |
| `tool_calls_total{tool="spawn_subagent"}` | ok=3, error(internal)=1 | 4 次尝试 1 次内部错误（错误率 1/4，观察项非事故） |
| `tool_calls_total{tool="todo_write",result="ok"}` | 12 | 本 build 存续 12 次（v1 的 282 为历史累计，不可混用——**指标口径纪律：build 存续 vs 全历史**） |
| `plan_proposed_total` | **0** | 本 build 零方案提出——C-1 Q1 召回关注点的数据面（与 15% 使用比观察一致） |
| `tool_calls_total{tool="tool_search"}` | error(internal)=1, activated=0 | **模型开始尝试调 tool_search 但命中 internal 错误**——#858 点名的下游效应信号，需观察是否模式化 |
| `pending_ops_total{ask_user}` | answered=1, timeout=1 | ask_user 生产正常流转 |

### 17.3 事实性引用纠错（推送前直接改，未推历史）

§12.2 B3 初稿引用 `plan_decisions_total`——生产指标全集核实**无此名**。真实观测面 = `pi_runtime_tool_calls_total{result="error",error_class="gate_blocked"}`（`tool-error-class.ts:19` 枚举确认）。已就地修正 §12.2。**教训**：探讨轮产出引用指标名时未逐一对照生产 metrics 全集——后续任何 spec 引用指标名必须先 `curl /metrics` 核名（与「引用代码须读 master」同级纪律）。

### 17.4 内部矛盾消解（§16.4 矩阵被后续小节超越 → 终版判定）

§16.4 写于 §16.5/§16.6/§16.9 之前，其「① 充分吸收」与「② 已吸收真实形态」的判定被后续子项核查部分超越。**终版吸收度矩阵（以本表为准，取代 §16.1/§16.4 对应行）**：

| 支柱 | 终版判定 |
|---|---|
| ① 规格 Schema | **充分吸收但有一个已登记半缺口**（scope 无契约载体 → A-3 修订，§16.5）——「充分吸收」指已有四字段中的三个与哲学层，scope 缺口不推翻判定但必须随 A-3 闭环 |
| ② DAG 调度器 | **已吸收真实形态（引擎双方皆无）+ 两个登记候选**（dependsOn §16.2、并行串行条文 §16.6）——均为「登记 + 等数据」，不构成缺口性缺陷 |
| ③ 文件状态层 | 不变（拒机制采原则，§16.3） |
| ④ 验收器 | 不变（充分吸收，§16.7 子项级复核背书） |
| ⑤ replan 控制器 | 不变（观测级吸收；§12.2 指标名已纠错） |
| ⑥ 横向设施 | 不变（充分吸收 + 压缩证据欠账，§16.7） |

**排位 vs 门禁语义澄清**（§9.6 与 §11.3 表面张力）：§9.6 把 A-2' 排优先级第 2 是**优先级语义**（若要做它先于 SOP/C-2）；§11.3 拍板 2 的「C-1 先观测后立项」是**立项门禁**（做不做由 §8.6 数据裁决）。两者不矛盾：门禁通过则按第 2 优先级排期，门禁不过则降级/搁置。§15.3 时序图已按此语义绘制，无需再改。

### 17.5 跨文档注记（同 PR 第三文件）

`2026-11-11-subagent-invocation-escalation-design.md`（#841 预案）头部追加状态注记：T1∧T2 触发条件已被生产事实（spawned=3）打破，预案的「触发后升级路径」不再适用；其 F1–F6 取证与三层点名模型仍有效；观测重心与 SSOT 以路标 §9.2/§17.2 为准。**跨文档状态矛盾（本文已更新、#841 未动）是本轮扫描发现的第五处问题**——注记后消除。

### 17.6 本轮总判定

规格经第三轮对抗复审：修正版本号错误（0.85.1→0.99.2）、升级阶段 C 表述（upmerge→pi-durable 迁移评估）、纠错一处指标名（plan_decisions_total）、消解一处内部矛盾（§16.4 终版矩阵 + 排位/门禁语义）、消除一处跨文档冲突（#841 注记）；生产取证证实 spawned 持续性（3/3 完成）与 C-1 Q1 关注点（plan_proposed=0）。**结论与方向均不变**（六支柱终版矩阵、优先级、No-Go 全部维持），推送就绪。新增纪律一条：**spec 引用指标名须先核生产 metrics 全集**。

---

## 18. 第四轮专项复审——设计哲学 vs 行业最佳实践、造轮子再审计（2026-11-13，用户指令「再次审核」）

> 本轮方法：两轮行业一手检索（评测运行节奏：Claude Academy《Evals in production》课程 + AI-Native SDLC playbook + 社区评测工程文；todo 契约形态：CC Tasks 增量 CRUD vs Codex `update_plan` 整单替换的形态分野）+ 规格哲学立场逐条对照 + 造轮子清单（§5.2 / G3 / §16.9 / §17.1）重走。

### 18.1 设计哲学逐条对照——10 立场全绿（两条获新佐证），1 条半缺口

| 哲学立场 | 行业一手证据 | 判定 |
|---|---|---|
| 全量快照 SSOT（拒 delta API，§11.2-1） | Codex `update_plan` 整单替换同形态（schema 极简、无 id 无依赖边）；行业定性为**定位之争**：整单替换=「计划」（一次性想清、偶尔修订），增量 CRUD 按 id=「看板」（长期存活、多写者、文件锁并发防护）。本产品 session 单写者、清单 ≤10 项、并发由 pi-runtime 管道承担 ⇒ 属「计划」侧 | ✅ **新佐证**：A-2'「全量覆写 + 可选 id」= 计划侧修 identity 断裂，不越界到看板形态——中介形态经行业分野佐证成立 |
| 单 `in_progress` 注意力锚 | CC/Codex 把「同一时刻最多一个 in_progress」写进工具描述（行业称反直觉硬约束：逼模型开工前承诺） | ✅ 本项目 summarize 软提醒同语义（软非硬，与「语义质量软校验」哲学一致） |
| 轻分离（主 agent 规划，§5.3） | 前三轮已取证 | ✅ |
| bias to action（问卡是决策原语） | 前三轮已取证 | ✅ |
| 硬断言优先、judge 兜底（C-1 §4） | Claude Academy/社区一致：judge 是 fallback 不是 default；judge 噪声大 ⇒ 固定 judge 模型、rubric 锚点、单维评分、多数表决 | ✅ L4 语义面 judge 只观测不卡闸与行业「judge 不卡闸」一致；repeat 表决与行业「borderline 跑 2-3 次多数表决」同款 |
| **eval 运行节奏** | 行业分层四档：① PR smoke 小集卡门；② merge 全量；③ **nightly 定时跑批防漂移（非阻塞 + 漂移趋势图）**；④ 模型/提示词/工具定义变更触发全量。Anthropic 课程明文「eval 在上线后仍要跑：prompt 会改、真实输入会变，drift 只靠定时跑才可见」。本项目现状 = L0 进 CI（≈档①）+ 发版前人工跑 —— **前两档对齐，③④ 缺失**：模型静默升级（`platform::agnes-*` 平台侧路由可变）与 L2/L6 prompt、SOP skill、task-state 变更后的行为漂移不可见 | ⚠️ **半缺口 → §18.2 裁决登记** |
| 只观测不自动 replan（阶段 C 边界） | 自动 replan step 属 LangGraph 类自主编排器场景；Claude Code 路线 = 人审计划修订（superpowers 式 spec→plan→execute 全程人门） | ✅（§10.3-3/§12 已按「观测先行」吸收其粒度） |
| fail-closed 拒自述完成（§14.3） | CC 任务纪律「不许把部分完成标为 completed」**停在工具描述 prompt 层**；本项目 after_tool 机检是结构化执行 | ✅ 且**强于行业**（接受为有意超越，非冲突） |
| 契约下沉 schema 非 prompt | 前三轮已取证 | ✅ |
| in-repo eval 资产（不自研/不外购平台） | OpenAI Evals 平台 2026-10-31 起只读、11-30 关停（搜索快照）⇒ 行业明文「数据集进仓 + 脚本在手才不随供应商漂移」；托管评测平台不可依赖 | ✅ **新佐证**：本项目自建被部署形态（驱动 pi-runtime 部署形态 + 生产反查来源）与 vendor 冻结纪律正当化，且范围已压到最小面（case 数据 + 两类判据字段 + 两个新探针），非造轮子 |

### 18.2 半缺口裁决：eval 运行节奏补「定时跑批」候选（登记不立项，C-1c 后触发）

**登记候选**：C-1c 基线建档后，增「定时自动跑批（观测非阻塞）」档——CI schedule 或等价自动化跑种子集，产出漂移趋势（pass-rate over time），不卡任何门。**变更触发全量跑批**的事件清单：L2/L6 prompt 改动（#858 类点名刀）、模型版本变更、SOP skill 上线（§13）、task-state/propose_plan 代码改动——触发核对面 = **PR changed-files 清单**（必须直接核对改动文件、覆盖 `skills/` 与 `prompt-registry/`；不能复用 deploy.yml push.paths 作触发面——其不含 skills/，SOP 上线事件将永不命中，与 §13.5 部署陷阱同源；当前 CI 完全不跑 eval，属盲区）。【v1.3 增补纠错：初稿误写「deploy.yml paths 命中」，与 §13.5 矛盾，第五轮复审修正】同时吸收两条行业纪律：① **事故→eval 回灌**：每起生产拆解类故障样本回灌 eval 集成永久回归 case（C-1 §3 双源纪律的自然延伸，防 eval 集「不进新 case 就静默失去区分力」——AI-Native SDLC playbook 原话级警告）；② **基线对比不止阈值**：per-case 对比上一通过 run，防「总分涨了但换了个地方坏」。**「真模型 eval 不进 PR 卡门」裁决不变**（成本 + flaky 理由仍成立；L0 契约层即行业档① smoke）。

### 18.3 造轮子再审计——一处顺序改判（未来 replan：轻提醒先于重检测）

重走造轮子清单（task-state id 溯源自上游 todo.ts、eval DSL、SOP skill 通道、acceptance DSL、观测脚本、spawn 编排、compaction backport），全部已登记或有正当性论证，无新增「已造轮子」。**新增一处防造轮顺序裁决**：§12 停滞检测（P1∧P2∧P3 三维合取）是**重机制**；行业存在更轻的先例——Kimi Code「轮次驱动过期提醒」（连续 N turn 未写清单 ⇒ 注入 system-reminder，是 feature 不是检测器）与 CC attention_check 同族。未来 replan 立项时的正确顺序 = **先上「N 轮未更新清单 → 提醒注入」轻机制**（复用 pi-runtime 动态块注入面，零检测基建），观测提醒无效再升三维检测重机制。§12 观测判据保留且不冲突：它正是证明「提醒无效与否」的数据机器——链条 = 观测（§12）→ 轻提醒 → 重检测。

### 18.4 C-1 spec 配套增补（§8.7，同 PR）

① **model id 固定纪律**：行业明文「pin model IDs——模型变更应成为可见 diff」；生产路由 `platform::agnes-*` 可被平台侧变更，C-1 runner 须记录每 case 实际 model id 并在报告固定展示，跨 run 对比须声明模型同 id。② 定时跑批候选 + 事故回灌 + per-case 基线对比登记（指向本节）。详见 C-1 spec §8.7。

### 18.5 A-2' 实施清单补一条（登记，立项 spec 时生效）

同轮并发 `todo_write` 的合并语义：行业有 per-step 防重先例（同 step 二次调用返回错误文本不改状态，防并行工具调用竞态）。本产品 reduce() 顺序应用天然无存储竞态，但 A-2' 立项 spec 须核「同回合多次 todo_write 调用」的 pi-runtime 实际执行序（串行则一行注释锁语义，可并行则须防重/合并），并写进回归。

### 18.6 本轮总判定

设计哲学 10 立场全绿、无与行业最佳实践的冲突；两条获新一手佐证（全量覆写的「计划 vs 看板」定位论、in-repo eval 资产论）；一条哲学半缺口（eval 运行节奏缺定时档）按「登记 + C-1c 后触发」纪律处理，不改变 §9.6 优先级；造轮子清单重走无新增已造轮子，新增一条防造轮顺序裁决（轻提醒先于重检测）。推送就绪状态维持。

---

## 19. 第五轮专项复审——极简哲学、内部重复/冲突、遗漏（2026-11-13 午，用户指令）

> 方法：全文 688 行重读 + 三条线地毯式核对。全部修正只动未推送内容（v1/v1.1 已推历史不动，沿用 §17.3「推送前直接改」先例）。

### 19.1 极简哲学审计——运行时设计面全绿，一处字段级违背（已裁决砍除）

- **机制面证据链**：不新增工具/数据库表/事件类型（§5.3、§11.2-5）、判据 DSL 枚举封死（C-1 §8.3 / §14.2）、eval 新增探针仅两处（C-1 §8.5）、全部新候选「登记不立项」（§16.2 / §16.5 / §16.6 / §18.2）——运行时增量收敛到最小，极简哲学在实现面成立。
- **一处字段级违背（实质产出）**：§14.2 acceptance 的 `note?: string`——① 与自身「自由文本禁入」立场自相矛盾；② 说明性内容已有 item `content` 与 propose_plan `explanation` 两个载体，纯冗余；③ YAGNI——实施时证明需要再加。**裁决：砍除**（已就地修正 §14.2，§14.4 措辞一并修正）。
- **「纸面规模 ≠ 运行时规模」澄清（防误读登记）**：§12 replan 三分类 10 信号观测判据是全文纸面最重的一节，但其运行时成本 = 0（全离线零生产代码），且 §12.5 已按信号硬度分期（先 B 类）——不构成违背，登记解读口径。
- 规格自身的膨胀治理 → §19.5 冻结提案。

### 19.2 内部冲突盘点——四处，全部修复

1. **§18.2 触发机制与 §13.5 部署陷阱矛盾（本轮唯一实质冲突）**：初稿写「deploy.yml paths 命中即应跑 eval」，但 deploy.yml push.paths 不含 skills/ ⇒ SOP 上线（§18.2 明列的触发事件）将**永不命中**——机制自相矛盾。已就地修正为 PR changed-files 核对面。
2. **§16.9 物理位置在 §17 之后**：章节序断裂，且读者线性阅读会先遇「§17.4 终版」再遇编号更小的 §16.9。已就地挪回 §16.8 之后（未推内容，移动安全）。
3. **版本链断裂**：正文两处【v1.3 纠错】标注，但头部注记链止于「v1.2 增补三」，§17（第三轮）无头部记录——从头部无法还原版本史。已补头部 v1.3 两条注记，行 3 版本号升 v1.3。
4. **§14.4「显式声明 submitted 级」无字段支撑**：schema 只有 requireSucceeded 缺省语义，不存在第三种显式声明形态——措辞已修正。

### 19.3 内部重复盘点——三处，两处澄清、一处可接受

1. **六支柱判定表共 4 个版本**（§10.2 → §16.1 → §16.4 → §17.4 超越链）：§16.1 标题自称「终审表」但已被 §17.4 取代，存在误信风险 ⇒ §16.1 已加取代指针；§10.2/§16.4 的被取代地位分别在 §16.1/§17.4 有声明，不再加注。
2. **§9.1 与 §11.1 双写 task-state 语义**：**§11.1 六场景表为权威语义基线**（§9.1 是其发现过程缩写）——解读规则登记于此，不改正文。
3. **§18.4 重复登记 §18.2 候选**：属跨文档摘要性质，保留。
4. B-4 历史三写（§2.3 / §4 / §5.2）各带纠偏注记，append-only 纪律的固有形态，可接受。

### 19.4 遗漏盘点——一处实质遗漏，一处解释规则

1. **A-2' 上线后的行为观测空白（实质遗漏）**：§11.2-9 回归锁只测 reduce() 单元语义、§18.5 补了执行序核验，但「模型收到幻觉 id 硬拒绝后的**重发自纠成功率**」无人观测——而这是拍板 1 的核心假设（错误回执 = 单次自纠回路、无死循环）。**登记为 A-2' 立项 spec 必含观测项**：复用 C-1 Q3 多轮 case 构造改措辞重发场景，观测「拒绝→重发→成功」链路成功率。
2. **§7 队列 A-3 表述解释优先级**：v1 §7 行 152 仍为「propose_plan assumptions 字段」（已推历史不改写），§16.5 已修订为「assumptions[] + scope」——**后续立项 spec 引用 A-3 时以 §16.5 表述为准**（§13.1 对 §9.5 纠偏的同一先例）。
3. 其余核对（§16.4 被取代链、#841 注记、C-1 §8.7、§15.3 时序、§17.4 排位/门禁澄清、§13.2 双层通道拒绝）均有落点，无新遗漏。

### 19.5 规格生命周期冻结（极简哲学对规格自身的应用；**2026-11-13 已拍板生效**）

本文件经五轮审视已 700+ 行、19 章。继续向本文件追加整章将稀释「路标 SSOT」的可读性。**裁决（用户拍板）：自 v1.3 起本文件视为评审完毕**（方向、No-Go、优先级、判据复用、部署形态条款均已终审），后续审视/细化产物直接进对应立项 spec（C-1b/C-1c、A-2'、A-3、SOP、C-2 各自 spec），本文件只回填状态行。冻结不关闭：新证据（生产数据 / 上游大版本 / 部署形态变化）触发重审时按既有触发条款（§16.3 / §16.9 / §18.2）执行。

### 19.6 本轮总判定

极简哲学：运行时设计面全绿，一处字段级违背（`note`）已砍；内部冲突四处全修复（一处实质：§18.2 触发机制）；重复三处两澄清一保留；遗漏一处实质（A-2' 行为观测）已登记。**结论与方向不变**，推送就绪状态维持——§19.5 冻结提案拍板后可与本次推送一并定夺（先推后冻结、或拍板后一并推，均由用户定）。
