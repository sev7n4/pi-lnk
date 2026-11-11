# 任务管理工程复盘与演进路标：外部建议核验、缺口分析与分期方案

> 日期：2026-11-11 · 版本 v1 · 状态：已拍板（2026-11-11，用户授权 PR #834 合并时拍板；阶段 A/B/C 代码刀仍须各自立项 + 单独授权）
> 定位：**分析与路标规格（决策门性质）**。输入为一次外部建议（DeepSeek，2026-11-10）+ 三路取证：本项目代码/生产、上游 pi 0.85.1 源码、行业一手实践。本文不直接授权任何代码刀；阶段 A/B/C 各自立项时独立成文，走 spec → plan → implementation 循环（遵守 `2026-10-09-task-management-module-design.md` §3 立项规则）。
> 取证时点：2026-11-10 23:xx GMT+8。生产镜像 `141d5d97`（落后真 master `31808ec0` 十七个提交）；生产数据来自只读 DB 副本（`docker cp lnkpi-api:/app/apps/server/data/lnkpi.db /tmp/pi-probe.db` → 宿主机 `sqlite3 "file:...?mode=ro"`），未修改任何生产状态。
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
