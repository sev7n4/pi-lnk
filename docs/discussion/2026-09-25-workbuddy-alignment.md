# WorkBuddy 对齐：迁移北极星升级与四层缺口映射（2026-09-25）

- **状态**：已确认（用户 2026-09-25 10:16 拍板「落盘 + 同步更新 P1 路线图」）
- **来源**：用户外部讨论记录 `/Users/4seven/workspace/docs/discuss.md`（agent 契约论、载体选择逻辑、WorkBuddy 架构拆解、SDK 借鉴分析、Jev typesafe）
- **关系**：给 `docs/superpowers/plans/2026-09-24-p1-roadmap-revision.md` 补一条北极星注释并上调 D-η'（skill）优先级；不改变其退役判据与批次定义
- **分支约定**：本文档不含实现；后续各批次开工前按 writing-plans 出独立实现计划

## 0. 配图索引

本文档不含图（意图对齐与缺口映射，用表格表达，无状态机/拓扑需要图示）。

## 1. 意图陈述（北极星升级）

**迁移的终点不是「内核替换成功」，而是「追上 WorkBuddy 的架构与工程设计哲学」。**

三句话版本：

1. pi-agent-core 只是发动机（Agent Loop / 工具执行 / 事件流 / steering），WorkBuddy 是整车——发动机之外每一层都要自己造；
2. 要学的不是功能清单，是 **Harness Engineering**：上下文怎么组织、工具怎么渐进加载、记忆怎么准入、skill 怎么版本化、护栏怎么设；
3. **契约优先**：先写契约再选载体；一份 Schema 单一来源同时派生 API 文档 / 工具定义 / MCP 声明，避免多套定义漂移。

## 2. discuss.md 要点提炼

| 主题 | 核心结论 | 对 pi-lnk 的启示 |
|---|---|---|
| 契约论 | 契约是贯穿 API/工具/MCP 的"约定本身"：接口 Schema + 语义描述（何时用/不用）+ 行为规则 + 质量约束 | 工具注册时 description 语义契约（何时不该调用）与技术 schema 同等重要；单一 schema 来源 |
| 载体选择 | 原型用框架原生，生产跨端上 MCP，单模型紧耦合留 Function Calling；MCP 不是必须的 | 单 runtime 内部工具（B-1/B-2）维持现形态；跨系统/跨 Agent 复用时才引 MCP 网关 |
| WorkBuddy 三层抽象 | 连接器（MCP，能力底座）+ Skill（作业指导书）+ 专家（领域特化包）；严格区分"有工具可用"与"知道怎么做" | Skill 不塞长期记忆；SKILL.md 文件即配置，天然获得版本化/评审/回滚 |
| 动态发现 | 不一次性把所有工具塞进上下文：先看工具名，需要时再加载详情 | pi-runtime 当前全量注入 systemPrompt，需工具渐进加载（与 #11 tool registry 衔接） |
| Claude SDK 借鉴 | Built-in Tools 闭环、Hooks 生命周期清单、SKILL.md 文件约定、Subagents | Hook 覆盖面对齐其清单（SessionStart/End、UserPromptSubmit…），按需补 |
| OpenAI SDK 借鉴 | Handoffs（主导权交接）vs Agents-as-Tools（借用专家能力）必须区分；Guardrails 并行校验 | 多 Agent 阶段（阶段三）再做，现在不做 |
| Jev typesafe | 快判断层（分类/路由/护栏）从大模型慢思考剥离，延迟/成本优势大 | **实验性 park**：工具风险门控（before_tool 处）、意图路由、输出护栏是甜点区，但不进 P1 主线 |

## 3. 四层缺口 × pi-lnk 现状映射

| 层 | WorkBuddy 对应 | pi-lnk 现状（2026-09-25） | 缺口动作 |
|---|---|---|---|
| ① 工具/连接器基建 | MCP 连接器网关、内置工具集、工具渐进加载 | 🟡 B-1 7 读 + B-2 13 写 + UI_COMMAND 5 本地工具 + B-5 5 gen + cancel 已闭环；工具一次性全量注入；无 MCP 接入层 | 工具渐进加载随 #11 tool registry 演进；MCP 网关推迟到阶段二 |
| ② Skill 系统 | SKILL.md 文件约定、版本化/可评审/可回滚、按需注入 | 🔴 **零 skill 概念**（roadmap §3.2 已核查：Nest PiPromptAssembler 无 skill；老 runtime 体系完整待迁） | **= D-η'，上调为下一个主攻项**（见 §5） |
| ③ 记忆/上下文工程 | 五类记忆 + 准入判断 + 用户级/项目级作用域 + 压缩策略 | 🔴 全缺（transform_context 钩子可用，无策略） | 阶段二再做；影子期不阻塞退役判据 |
| ④ 编排/护栏/执行环境 | Subagents、Handoffs/Agents-as-Tools、Guardrails、HITL 确认门控 | 🟢 半成：before_tool HITL Gate（fail-closed，canvas SSOT pending_confirm）已上线；规则组护栏已有；subagent 需 L2 自建（A.6 已知） | Handoffs/Subagents 阶段三；Jev 快判断层实验性 park |

## 4. 设计哲学吸收清单（优先级排序）

**执行原则：Seam first, policy later**——只把工程量花在「类型、注入点、契约、观测」这类回改成本高的结构上；所有策略（渐进加载阈值、记忆准入规则、skill 路由算法）等注入观测数据到位后再定。

代码核对结论（2026-09-25 10:40）：`pi-prompt-assembler.service.ts`（120 行）已是 `parts.push() → join` 线性分节管道，Nest 装配完整 systemPrompt、pi-runtime 原样透传——**架构底子兼容 harness 分层，无需大改**。真正的差距是「三缺」：分节无类型、无注入观测、skill/记忆层不存在。

| # | 动作 | 时机 | 理由 |
|---|---|---|---|
| 1 | assembler 升级 typed layers：`parts: string[]` → `PromptLayer[] { id, kind: rules\|canvas\|sidebar\|skill\|memory, content, approxTokens }`，最终 join | **D-η' 批次内** | skill 是第一个必须按层管理的住客；120 行小文件改动窗口最便宜 |
| 2 | 注入 manifest 观测：每轮 log/metrics 落 `{layer_id → tokens, 注入清单, prompt_hash}` | **D-η' 顺带** | harness 调优的数据地基；渐进加载/skill 路由/记忆准入的裁决依据；约半天 |
| 3 | #11 `LnkpiTool` 加 `summary` / `deferred?` 元数据字段（占位不实现加载） | #11 开工时 | 渐进加载将来是注册表改造，现在加字段 = 以后零迁移 |
| 4 | 契约收敛：双 CanvasAction 收敛为单一 schema 派生 | 独立小批次穿插 | 半天量级，拖久漂移风险增大 |
| 5 | 记忆层 / MCP 网关 / hooks 扩面 / subagent | 阶段二/三 park | seam 已由 #1 预留（kind 枚举含 `memory`），策略等数据 |
| 6 | Jev 快判断层 | park（实验性） | before_tool Gate 已覆盖最痛的风险拦截 |

以下为原吸收清单（排序依据保留）：

1. **契约单一来源**——现存契约债：`packages/shared` 两套 CanvasAction（agentContract zod 版 nodeType:string vs index.ts interface 版 NodeType），extractCanvasActions 靠 zod 校验 + NodeType 白名单收窄兜底。应收敛为单一 schema 派生，作为 D-η' 批次的附带小项或独立小批次。
2. **Skill = 文件即配置**（SKILL.md + frontmatter 元数据）——直接做进 D-η' 设计，天然获得版本化/评审/回滚；"做事方法"绝不进长期记忆。
3. **工具渐进加载**（先名后详情 / 检索制）——#11 tool registry skeleton 落地后的自然演进方向，控制上下文规模。
4. **Hook 覆盖面对齐** Anthropic 清单——pi 现有 before_tool / transform_context 之外，按生命周期节点需求逐个补，不一次铺全。
5. **Handoffs 与 Agents-as-Tools 区分**——多 Agent 编排阶段（阶段三）的建模前提，现在只记录不实现。

## 5. 与 P1 路线图的关系

| roadmap 条目 | 处理 |
|---|---|
| ① UI_COMMAND（0.0.7）| ✅ 已完成 |
| ② B-5+B-3（0.0.8，PR #9 fb006e1）| ✅ 已完成 |
| ③ D-η' skill 缺口 | **上调确认为下一个主攻项**，并追加 WorkBuddy Skill 层对齐口径：SKILL.md 文件约定 + 版本化 + 按需注入；先核查生产 skill 使用数据（原计划不变）；批次内并做 §4 #1（typed layers）+ #2（注入 manifest）。**2026-09-25 11:07 范围定案**：老商业 skills 不迁（非最佳实践），使用数据核查降级为顺手项；格式对齐 Anthropic 事实标准（frontmatter + 渐进披露）；验收线 = 第三方 skill 免改码 drop-in 自然触发；双验证用例（官方仓 1 个 + 老 `ecommerce-product-visual` 领域知识按标准格式重写 1 个）；MCP/connector/expert 不先搭（时序见上表） |
| ④ B-4 使用率数据裁决 | 照旧，等数据 |
| 新增 | 契约债收敛（双 CanvasAction）挂为独立小批次或 D-η' 附带项 |
| 新增（非 P1）| MCP 连接器网关、记忆系统、subagent 编排 → 阶段二/三节奏；Jev → 实验性 park |

## 6. 阶段视图（粗粒度，不排死期）

- **阶段一（≈当前）**：核心循环闭环 ✅；skill 注入（D-η'）→ 端到端真实任务能力
- **阶段二**：工具渐进加载 + skill 版本管理/评审流 + 记忆系统（用户级/项目级两层带准入）+ MCP 连接器网关
- **阶段三**：多 Agent 编排（Handoffs / Agents-as-Tools / subagent L2）+ 项目空间 + 跨会话任务延续
- **阶段四**：生态化（skill/连接器开放创建与分享）+ 企业权限/审计/租户隔离

> 老 runtime 退役判据（roadmap §4）不受本次修订影响：K4 diff=0 + top-20 使用率覆盖 + shadow 7 天无差异，仍为 P1 north star；D-η' skill 是退役前必须补齐的最大剩余缺口（roadmap §4 说明段已认定）。
