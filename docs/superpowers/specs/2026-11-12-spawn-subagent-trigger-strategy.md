# spawn_subagent 触发策略 · 规格（基于行业最佳实践）

> 关联调研：`docs/superpowers/research/2026-11-12-subagent-trigger-best-practices.md`
> 日期：2026-11-12
> 状态：草案（待评审）

---

## 1. 决策结论（一句话）

**保持 `spawn_subagent` 常驻；真正要补的是 L2/L3 点名（prompt 授权 + description 触发信号强化），而非继续纠结 tier。**

---

## 2. 决策依据（来自调研）

| 决策点 | 行业最佳实践 | 本项目对齐结论 |
|---|---|---|
| 子代理原语是否常驻 | Claude/Codex/WorkBuddy 均**始终常驻**（核心控制面） | ✅ 保持常驻（`ALWAYS_ON_TOOL_NAMES`） |
| 延迟集适用对象 | 仅长尾低频工具 | spawn 不属于此类 |
| 防"凑答"幻觉 | 常驻工具不得给延迟领域凑部分答案 | ✅ `web_search`/`web_fetch` 常驻可凑答 spawn 领域 ⇒ 常驻有独立正当性 |
| 触发策略 | description 写**触发条件**（非能力名） | 部分满足，待强化 |
| 主动委派 | 需 system prompt / 策略文件**显式授权** | ❌ 当前缺（L2/L3 零点名） |
| 有界性 | 范围 + 并行 + 返回形态 + fallback | ✅ spawn 已 fail-soft，待补 fallback 文案 |

---

## 3. 当前状态与缺口（实证）

- ✅ 常驻：`tiering.ts:168` 在 `ALWAYS_ON_TOOL_NAMES`。
- ✅ description 含 when/why：`spawn-subagent.ts:32-36`（"何时必用：大范围查资料/核对多文件/联网调研…子代理只能读不能写"）。
- ✅ fail-soft / `tier=write_light` 进 plan-gate / 三重硬边界（并发/轮次/时长）。
- ❌ **L2 点名缺失**：`prompt-registry/rules/`（13 条，含 `core`/`writeTools`/`genTools` 分组，结构比扁平 `AGENTS.md` 更先进）**零引用** spawn——"主动委派"策略从未注入。
- ❌ **L3 缺"委派策略"接入**：本项目**已有** L3 实体 `skills/`（`SKILL.md` 渐进式披露，pi-runtime 经 `skill-tool.ts`/`SkillRegistry` 消费，格式对齐 Anthropic/WorkBuddy 事实标准），9 个技能全是领域工作流（drama/html/ecommerce），**没有任何技能编排 `spawn_subagent`**，也没有"研究类应委派"的策略级技能。
- ⚠️ **预算更正**：规格初稿称"L6 静态段余量 ~25"已失效/指错段。当前 `prompt-registry` `STATIC_BUDGET_CHARS=3200`、全组合实测 3085、**余量 115 字符**（`PROMPT_SPEC.md` 机检表，CI `prompt:lint` 校验）。L2 规则走 prompt-registry 预算，须以 `pnpm prompt:lint` 实测为准，不是 25。

> 实证呼应：`2026-11-12` 真实驱动中，模型仅在用户**显式写"请使用 spawn_subagent"**时才调用 ⇒ 自发性委派完全依赖 description 匹配，印证 L2/L3 缺位。

---

## 3.1 行业 L3 落点 anatomy 与本项目映射（回答"L3 在哪里设计"）

业界所谓"L3 点名层"实际是**三种不同实体**，常被混为一谈，但各自职责不同：

| 实体 | 代表实现 | 加载方式 | 承载内容 | 本项目对应 |
|---|---|---|---|---|
| **① 策略文件（always-loaded policy）** | Claude `CLAUDE.md`、Codex `AGENTS.md`/codex.md、通用 `AGENTS.md` | 每次会话恒注入 | "某类任务**应**主动委派"等跨会话一致规则 | **`prompt-registry/rules/` + `PROMPT_SPEC.md`**（已存在，比扁平 md 更结构化，有预算纪律 + CI lint） |
| **② 命名子代理定义（named sub-agent persona）** | Codex `.codex/agents/*.toml`、Claude `.claude/agents/*.md` | 始终可见（description=路由规则） | 带独立 system prompt / 工具白名单 / 模型的**可复用子代理角色**（researcher/reviewer…） | **缺失**：`spawn_subagent` 只按 `task` 文本派一个通用只读子代理，无"角色注册表" |
| **③ 技能 / 工作流（on-demand workflow）** | WorkBuddy `SKILL.md`、Claude `.claude/skills/`、Codex `skills.config` | 按需（description 命中或 `@skill` 才读正文） | 标准化多步流程、领域知识 | **`skills/`**（已存在，pi-runtime 经 `skill-tool.ts`/`SkillRegistry` 消费，格式对齐 Anthropic/WorkBuddy 事实标准） |

**关键区分（决定 spawn 点名该落在哪层）**：
- ① **策略**（"研究类任务应委派"恒适用）→ 属于 always-loaded policy，应进 **L2（prompt-registry 规则）**，不是技能。
- ② **命名角色**（"researcher 子代理"）→ 是 Codex/Claude 的自定义子代理，pi-lnk 当前**无此概念**；只有当委派要"角色专业化"时才需要，属架构级扩展。
- ③ **技能**（"deep-research 标准化流程：派研究员子代理→汇总"）→ 是 on-demand 工作流，应进 **L3（SKILL.md）**，仅当该工作流成为高频、可复用、场景特定的多步程序时才立。

> 结论：**spawn 的"主动委派"基线修复 = L2 规则（①），不是 L3 技能（③）**。把一条恒适用策略塞进按需技能会错层——技能不恒注入，策略就时灵时不灵。L3 技能只在"研究委派"演进成标准化工作流后才该立。

### 3.2 各厂商可借鉴 / 复用判定（尤其 WorkBuddy）

- **WorkBuddy `SKILL.md` 模式 → 已复用（零机制缺口）**：pi-lnk 的 `skills/` 直接采用 WorkBuddy/Anthropic 的 `SKILL.md` 渐进式披露（name+description 常驻上下文、正文按需 `load_skill`）。机制已就位，**无需"补 WorkBuddy 技能机制"**。
- **WorkBuddy 无独立 `agent.md`** → 用户所说的"agent.md"对应业界 `CLAUDE.md`/`AGENTS.md`（项目级 always-loaded 策略文件）。pi-lnk 的等价物是 `prompt-registry/rules/` + `PROMPT_SPEC.md`，**已比扁平 md 更先进**（有预算门禁、anchor 引用扫描 L10/L11、CI 机检）。无缺口，反超前。
  - 唯一可补的"可读策略文档"：若团队想要一份**人类可读**的"产品 agent 行为策略总纲"对标 CLAUDE.md，那是 `PROMPT_SPEC.md`（已存在，但它是规格非注入体）；注入体是 rules。这属文档/可发现性，非机制缺口。
- **Codex `.codex/agents/*.toml`（命名子代理） → 缺口但超当前范围**：若日后要"角色化委派"（researcher/reviewer 各有独立 prompt+工具+模型），需新增"子代理 persona 注册表"，并让 `spawn_subagent` 支持按 persona 名派发。属架构扩展，本次不做。
- **Claude 的"description=路由规则 + CLAUDE.md 策略"组合 → 直接对齐本项目**：CLAUDE.md 管"何时该找子代理"（=L2 rules），`.claude/agents/*.md` 的 description 管"该路由到哪个角色"（= 未来 ②）。本项目用 ①（rules）+ ③（skills）+ 工具 description 已覆盖其 L2/L3 的 90%，缺的是 ②（命名角色）。

---

### 3.3 子代理上下文架构（决定 L3/persona 设计的关键约束）

实证 `session-manager.ts:2963-2998` + `gate/subagent.ts`：子代理 `build` 时 `systemPrompt: source.basePrompt`（**继承主会话的 L6 静态拼装 + prompt-registry 规则**），`subagentTools:true` 按白名单过滤工具（`SUBAGENT_TOOL_WHITELIST`）。

**关键事实**：
- ✅ **L2 规则被注入子代理**：§4.2 的 `subagent-delegation` 规则进 `basePrompt` ⇒ 子代理自身也受"应委派"策略约束；但白名单排除 `spawn_subagent`，故子代理**不可再嵌套派生**，递归天然封死。
- ❌ **L3 技能体不进子代理**：白名单排除 `load_skill` 与 `tool_search`，子代理**拿不到任何 SKILL.md 正文**。因此 L3 `research-delegate` 的详细步骤**只指导主代理如何委派**，子代理的行为只由 `basePrompt`（L2）+ 白名单工具 + 模型决定。
- 子代理可用：`get_canvas_summary`/`get_node`/`read_document`/`recall_memory`/`web_search`/`web_fetch` 等**只读 + 网络出口**；不可用：`ask_user`/`spawn_subagent`/`load_skill`/所有写工具。

⇒ **L3 设计铁律**：L3 技能是"主代理侧的委派工作流编排器"，不是"子代理侧的行为脚本"。任何指望 L3 在子代理内生效的设计都是错的；persona 同理——硬 persona 必须改 `build` 的 `systemPrompt` 合成（见 §4.5）。

## 4. 落地方案

### 4.1 保持常驻（无需改动 tiering）
- 不动 `ALWAYS_ON_TOOL_NAMES` 中的 `spawn_subagent`。
- **文档更正**：`tiering.ts:159-167` 注释中"该通道无动机时触发率 0 ⇒ 不可达"的归因偏弱，改为："延迟集时 spawned 恒 0 的真根因是点名缺失（L2/L3），且 web_search/web_fetch 常驻可凑答其领域（铁律）→ 故提回常驻。" 避免误导后续 tiering 决策。

### 4.2 L2 点名：prompt-registry 最小授权规则（核心补强，基线修复）
在 `prompt-registry/rules/` 新增一条 `subagent-delegation.md`（`group: core`，**恒注入**），约 80–120 字符：

```
研究/探索/多源核对/联网查资料类任务（尤其会塞满主窗口的探索过程）→ 优先 spawn_subagent 派只读子代理独立做完，你只汇总要点。
```

- **预算**：走 prompt-registry `STATIC_BUDGET`（当前余量 115 字符，`PROMPT_SPEC.md` 机检表）。规则净增须 `pnpm prompt:lint` 实测不破硬线；若逼近预警线，用 §4.3 把 description 散文收敛为关键词信号腾出空间。
- **同步 6 处**（遵 `PROMPT_SPEC.md §6`）：frontmatter · `MANIFEST.yaml`（`version`+`contentHash`）· `COMPOSED_IDS` · `FALLBACK_BY_ID`+`prompt-registry.fallback.ts` · `renderStaticFallback()` 拼装顺序 · `pi-prompt-assembler.service.test.ts` 的 `EXPECTED`。
- **判据（回归 + 变异自检）**：用户消息含"调研/研究/探索/查资料/核对多源/整理报告"等信号词 → 主对话应出现 `spawn_subagent` 调用（或明确委派意图）。无上述信号且任务可主会话独立完成 → 不应强制派发（description 的"勿用"条件兜底）。变异自检：删该规则 → 真实生产夹具下"调研类"话术委派率下降（判据真实依赖规则，非恒真）。

### 4.3 L1 强化：description 触发信号化（顺带压缩，换取预算）
`spawn-subagent.ts:32-36` description 改为更"信号化"且更短：

```
把一项只读调研派给子代理：它带完整上下文独立工作（查画布/读文档/联网），返回报告后阻塞本回合。
优先用：任务含"调研/研究/探索/多源核对/联网查资料"，且探索过程不值得占主窗口。
禁用：要改画布/生成内容时别派，自己做。
```

> 预算账：description 是常驻工具 schema（每轮下发，不占 prompt-registry 预算），但把它的散文**收敛为关键词信号**有两个作用——① 与 §4.2 规则形成"描述+策略"双保险、减少歧义；② 缩短的 description 降低整体上下文噪声，让 L2 规则（走 prompt-registry `STATIC_BUDGET`，余量 115）的净增更易被 `prompt:lint` 接纳。两者合计目标接近零净增或微增。

### 4.4 L3 设计（细化）：复用现有技能 + 单一横切 `research-delegate`，且只服务主代理侧

**定位**（重申）：L3（`skills/` 的 `SKILL.md`）承载**标准化、可复用、场景特定的多步工作流**，按需加载；**不承载恒适用策略**（那是 L2）。基线修复 = §4.2 L2 规则，L3 不是基线修复手段（错层会时灵时不灵）。

**§3.3 约束落地**：因子代理白名单排除 `load_skill`/`tool_search`，L3 技能体**只在主代理侧生效**——它教主代理"如何把研究委派出去"，子代理拿不到技能正文、只继承 `basePrompt`（L2）。

**现有 9 个技能的复用判定（回答"哪些可融入"）**：
- 9 个技能全是**内容生产**工作流（7×drama / ecommerce-product-photo / html-craft），`grep` 实证零引用 spawn。它们不是"研究委派"技能，而是"生产"技能。
- 但它们**各自隐含一个研究/取参阶段**（drama-script-writing 收集同类作品、ecommerce-product-photo 收集竞品参考、html-craft 读画布/读最佳实践）。
- **正确复用 = 横切而非复制**：不要给 9 个技能各塞一份委派步骤（9× 重复，且子代理根本加载不到技能），而是建**一个**横切 `research-delegate` 技能，由主代理在任意生产技能的研究阶段调用；生产技能用"见 `research-delegate`"式锚点引用（仿 `PROMPT_SPEC.md §6.1` 的 anchor 引用约定），不复制正文。
- 结论：**9 个现有技能无需改动即可"融入"**——它们继续管生产，研究阶段统一交给 `research-delegate`。这是最低风险、零重复的复用。

**何时把 L2 升级为 L3 技能（升级判据，同 §3.2）**：同一类"派子代理做研究 + 固定汇总格式"被反复触发且希望仅在命中场景才加载详细步骤（省常驻 token），或需跨团队版本化复用。满足任一 → 立 `skills/research-delegate/SKILL.md`。

**L3 技能模板（对齐 WorkBuddy/Anthropic `SKILL.md` 渐进式披露；只编排主代理侧委派）**：
```markdown
---
name: research-delegate
version: 1
description: 当用户要"深度调研/多源核对/生成研究报告"且过程会塞满主窗口时使用；本技能编排主代理调用 spawn_subagent 派只读子代理独立研究后由你汇总。
---
# 研究委派工作流（主代理侧）
1. 识别研究目标与范围（主题、需核对的来源、返回形态）。
2. 必要时在 task 前加 persona 前缀（见 §4.5 软 persona 模板：researcher/reviewer/comparator）。
3. 调用 spawn_subagent，task 写清：目标、范围、允许的只读工具、返回报告格式（要点+来源）。
4. 子代理返回后，你**只汇总要点**，不重复其探索过程。
5. 若 spawn 返回 ok:false（不可用/并发满），自行联网/读文档完成，不要卡死。
```
- 部署影响：`skills/**` 改动触发 `runtime-deploy` → 需走闸门 + 生产取证。
- 触发：话术命中 description（自动）或 `@research-delegate`（手动），与现有 drama/html 技能同机制。

### 4.5 命名子代理 persona —— 软（免费，与 L3 同批）/ 硬（架构扩展，路线图）两档

**现状**：`spawn_subagent` 仅收 `task` 一个参数；子代理 `systemPrompt` 恒等于主会话 `basePrompt`（§3.3）。无"角色"概念。

**软 persona（无代码改动，推荐与 L3 同批做）**：
- 主代理在 `task` 文本前**自加 persona 前缀**即可给子代理注入角色，例如：
  - `researcher:` "你是细致的研究员，只列可核验的来源与要点…"
  - `reviewer:` "你是严格的事实核查员，只挑矛盾与证据缺口…"
  - `comparator:` "你是对比分析师，按维度表输出异同…"
- 因子代理继承 `basePrompt`，这些前缀与 L2 策略**叠加**生效，零运行时改动。
- L3 `research-delegate` 技能可把这套前缀标准化为模板（§4.4 第 2 步），使 persona 成为"可复用约定"而非即兴文本。
- **代价**：前缀占 `task` 预算、不强制、不可约束工具白名单/模型。对"角色化委派"的早期需求足够。

**硬 persona（架构扩展，列入路线图 §7，本次不做）**：
- 扩展 `spawn_subagent` schema 增 `persona` 参数 + 新增 `PersonaRegistry`（`persona` → `systemPromptPatch` + 可选 `toolWhitelistOverride` + 可选 `modelOverride`）。
- `session-manager.runSubagent` 的 `systemPrompt: source.basePrompt` 改为 `source.basePrompt + registry[persona].patch`（并按 override 调白名单/模型）。
- 对齐 Codex `.codex/agents/*.toml` / Claude `.claude/agents/*.md`：每个命名角色带独立 system prompt + 工具白名单 + 模型。
- **收益**：角色真正隔离（不同 persona 不同工具/模型）、可版本化、可观测（metric 按 persona 打标）。
- **代价**：动 pi-runtime 核心（`spawn-subagent.ts` schema + `runSubagent` build）+ `runtime-deploy` + 生产取证；须先有"角色化委派"的真实高频需求才划算。
- **裁决**：先以软 persona 跑通，待 orchestrator/planner 层（§8）把"按角色路由"变成刚需后再上硬 persona。

### 4.6 fallback 兜底（对齐 Codex "if unavailable, continue solo"）
`spawn-subagent.ts` 已 fail-soft（`execute` 永不 throw，返回 `ok:false`）。**补一处文案**：当 `subagent_not_available` / `concurrency_full` 时，返回里加一句"子代理暂不可用，请自行联网/读文档完成调研"——避免模型在失败时卡死或静默放弃。

---

## 5. 验证与判据（含变异自检）

1. **单元/集成**：在 `spawn-subagent.test.ts` 增加用例——description 收敛后仍能从任务文本识别触发信号（关键词匹配断言）。
2. **prompt 规则回归**：新增 `prompt-trigger.spawn.test.ts`（或并入现有 prompt 校验）断言 prompt-registry 规则含 spawn 授权；变异自检：删该规则 → 真实生产夹具下"调研类"话术的委派率下降（判据真实依赖规则）。
3. **生产实证**（同 D2 方式）：用测试号 + 非显式话术（只说"帮我调研 XX"）驱动一轮，**回查 `SubagentTask` 表是否落行**——验证 L2 点名后自发性委派生效。
4. **护栏**：`pnpm prompt:lint` 必须仍通过（规则净增不破 `STATIC_BUDGET` 硬线）。

---

## 6. `tool_search` 根因复核结论（写入本规格以闭环）

- 原"延迟即不可达"归因混淆了"tool_search 坏"与"无动机"。证据：`tool_search` 机制有效（实验 hit=6）、0 调用 = 模型从未搜索 = 点名缺失。
- 保持常驻**结论不变**，但理由更正为"委派原语 + 替代品幻觉铁律"。
- 正解是补 L2/L3 点名，而非"只常驻等自发"。

---

## 7. 路线图总览（L3 → persona → orchestrator 三层递进）

本规格分三档推进，风险与改动面递增：

| 档 | 内容 | 改动面 | 状态 |
|---|---|---|---|
| **基线修复（立即可做）** | §4.1 注释更正 + §4.2 L2 规则 + §4.3 description 收敛 + §4.6 fallback 文案 | prompt-registry + pi-runtime 文案（触发 `runtime-deploy`） | In scope，见配套实施计划 |
| **L3 + 软 persona（近期）** | §4.4 横切 `research-delegate` 技能 + §4.5 软 persona 模板 | `skills/**`（触发 `runtime-deploy`） | 条件扩展点 |
| **硬 persona（中期）** | §4.5 硬 persona：`persona` 参数 + `PersonaRegistry` + `runSubagent` 合成 | pi-runtime 核心（runtime-deploy） | 路线图，待需求 |
| **orchestrator/planner 决策层（远期）** | §8 显式分解 + 路由 + 聚合；可选 `propose_plan` 委派意图 | 主要为 prompt/skill 侧，可选 runtime 钩子 | 路线图 |

**递进逻辑**：先让模型"被授权主动委派"（基线 L2）→ 再给"标准化委派工作流 + 角色约定"（L3/软 persona）→ 角色刚需出现后固化为硬 persona → 最后在顶层加"先分解再路由"的决策层，把 delegate/inline/produce 的判据从"逐工具自发"升级为"显式决策"。每一档都可独立验收、独立回滚。

## 8. orchestrator/planner 决策层（远期路线图规格）

### 8.1 动机与缺口
- 当前委派是**机会主义**的：主代理在每个工具节点自决是否 spawn，仅靠 §4.2 L2 规则轻推。没有**显式分解 + 路由**步骤。
- 既有 `propose_plan`（plan-gate）管"写前确认"、`todo_write` 管"任务追踪"，但**都不管"哪些部分该委派、哪些该内联"**。复杂多部分请求下，模型可能把本可并行的研究塞进主窗口、或漏派。
- 行业对照：Codex "SDK owns structured parts, prompt owns delegation strategy"——决策层即 prompt 侧的"委派策略"；Claude 顶层 Agent 自带分解。本项目缺这一**显式决策面**。

### 8.2 设计（以 prompt/skill 侧为主，低风险提示）
新增**决策层**（prompt 策略 + 可选 `orchestrate` 元技能），对复杂多部分请求：
1. **分类（classify）**：把请求拆子任务，逐一定性——`research`（委派 spawn）/ `produce`（加载生产技能）/ `write`（进 plan-gate）/ `trivial`（内联）。
2. **路由（route）**：research → `spawn_subagent` 结构化 task（联动 §4.4 L3 + §4.5 persona 前缀）；produce → 加载对应生产技能（drama/html/ecommerce）；write → `propose_plan` 闸门。
3. **聚合（aggregate）**：收集子代理报告、去重、按用户要的形态呈现；失败项 fallback 到主代理自做。

### 8.3 与既有件的边界
- **不替代 plan-gate**：plan-gate 是"写前确认门"，决策层是"委派 vs 内联"判据；二者组合——决策层分类，plan-gate 拦写部分。
- **不替代 L2 规则**：L2 是恒适用的"应委派"授权；决策层是复杂请求的**分解编排**，可引用 L2 作为分类依据。

### 8.4 可选 runtime 钩子（高风险，按需）
- 扩展 `propose_plan` 让其产物显式列出"委派意图"（哪些子任务将 spawn、用何 persona）——提升透明度与可观测，但动 plan-gate + `runtime-deploy`，列为可选。
- 决策层主体保持 prompt/skill 侧 ⇒ 大部分落地**不触发 `runtime-deploy`**，风险远低于硬 persona。

### 8.5 验收判据（远期）
- 复杂多部分话术下，主对话出现"先分类→再 spawn/produce"的结构化痕迹（非随机自发）。
- 同一请求的研究子任务被委派且报告被聚合，主窗口不被探索过程塞满。

## 9. 范围与 No-Go（原 §7 重编号）

- **In scope（基线修复）**：4.1 注释更正、4.2 prompt-registry 规则（`core` 分组，恒注入）、4.3 description 收敛、4.6 fallback 文案、§5 验证。
- **L3 技能（4.4）= 条件扩展点**：基线修复靠 L2 规则；仅当"研究委派"演进成高频标准化工作流时才立 `skills/research-delegate/SKILL.md`（届时也触发 `runtime-deploy`）。
- **软 persona（4.5）= 与 L3 同批的零代码增强**：通过 L3 技能模板标准化 task 前缀实现，不单独立项。
- **Out of scope（本次不做）**：4.5 硬 persona（角色化委派，架构扩展）；§8 orchestrator/planner 决策层（远期路线图）；把 spawn 改回延迟集（已证不利）。
- **pi-runtime 发布风险**：4.1–4.3/4.6 均为 pi-runtime 文案/规则改动，会触发 `runtime-deploy`（与 D2 零 pi-runtime 改动不同）。L3/软 persona 的 `skills/**` 改动同样触发 `runtime-deploy`。硬 persona 与 §8 可选钩子另计。
