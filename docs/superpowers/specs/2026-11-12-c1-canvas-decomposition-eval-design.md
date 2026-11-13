# C-1 · canvas 拆解质量 Eval 集——立项规格（决策门性质，不授权代码刀）

> 日期：2026-11-12 · 状态：**待评审拍板**（立项后走 spec → plan → implementation，实施需单独授权）
> 2026-11-13：判据细化讨论轮产物合入 §8（六级粒度阶梯 / Q1 负例边界 / 声明式字段形态 / 来源澄清 / §8.6 A-2' 前置观测判据），状态不变仍待拍板，推送时机由用户单独给出。
> 上位锚：路标规格 `2026-11-11-task-planning-engineering-roadmap-design.md` §9.4（v1.1 校准将 C-1 提前为最高优先级）+ 阶段 C 原文边界「**只观测与门禁、不自动 replan**」。
> 缺口锚：G2「拆解质量零工程保障」——prompt 契约仅一行（`task_tool.md:11`），L6/L2 预算双双贴线，`propose_plan`/`todo_write` ≈ 15% 使用比，拆解时机与粒度无任何机检。

## 1. 问题定义

「需求 → 精准规格和方案 → 任务清单」链条中，**拆解环节**（什么时候 propose、清单粒度对不对、步骤覆盖全不全）目前完全靠模型自觉：

- 拆解质量没有评测：现有 eval（W1b L0/L1）锁的是「工具调用行为」（该调 A 不该调 B），不锁「拆出来的清单结构好不好」；
- 拆解时机没有观测：「该 propose 而没 propose 直接干活」被 plan-gate spec 明文定义为「现状行为，不是回归」（`plan-gate-design.md:131`）——它确实不是回归，但也**永远不会被看见**；
- 拆解结果没有锚点：todo 快照的 items 数、粒度、互斥性、首步是否含信息收集，生产上无任何断言。

本项目自己的纪律（澄清矩阵 §1.2「提示词层约束力已被生产证伪两次，解法重心必须是机制编码」）要求：**质量保障必须落在 Eval 第四层，不是继续加 prompt 条文**（路标 §5.3 No-Go 第 3 条）。

## 2. 目标与非目标

**目标**：
1. 建 30–50 条 canvas 拆解场景的 eval 集，判据**硬断言优先**（沿用 golden-cases 文件头已论证的立场：硬断言失败可定位「该调 A 调了 B」，judge 只会说「不符合预期」；LLM-judge 待 case 积累后逐个加）；
2. 覆盖「该 propose 没 propose」的**召回**维度（不只判清单质量，也判拆解时机）；
3. 生产基线建档：当前模型在场景集上的通过率作为 G2 的第一个可比较数字；
4. 为后续刀提供门禁：改 prompt（L2 点名）、动 task-state、动 propose_plan 时 eval 不回退。

**非目标（边界，违反即偏离立项）**：
- ❌ 不做自动 replan / 自动改写清单——阶段 C 原文边界；
- ❌ 不做 LLM-judge 自动评分门禁（首批全部硬断言，见 §4）；
- ❌ 不改 prompt-registry / task-state / propose_plan 任何生产代码——本刀只加 eval 资产与判据（若判据实现需要 runner 扩展，见 §5.3，属测试侧代码）；
- ❌ 不进 CI 卡门（真模型 eval 烧 token + flaky，沿用 PROMPT_AB_SCENARIOS「不进 CI、发版前人工跑」的既有裁决）；进 CI 的只有 L0 契约层。

## 3. 场景集设计（30–50 条，四象限）

来源纪律：golden-cases 现行纪律「首批不允许 `synthetic`（不要把想象的失败当真实失败）」。本集改为**双源**：① 生产 `executionEvents` 反查真实多步任务话术（主源，`origin:"production"`）；② 结构覆盖必需的自造场景（显式 `origin:"synthetic"` + note 说明为何生产反查不到，例：多场景并行派发的边界态）。**不允许无标注 synthetic。**

| 象限 | 判什么 | case 形态 | 数量 |
|---|---|---|---|
| **Q1 拆解时机（召回）** | 多步任务该 propose/todo 而没做（直接闷头干活） | 多步意图话术 → `expectTools` 必含 `propose_plan` 或 `todo_write`；负例：单步任务 → `forbidTools` 含二者（过度拆解也是质量缺陷） | 10–14 |
| **Q2 清单结构（粒度）** | 拆出来的快照结构达标 | 判 `details.todo.snapshot` / `plan.steps`：items 数在话术合理区间、`content` 互斥不重叠、首步为信息收集/澄清类（当话术含未定参数时）、无「一步做完所有事」的巨石项 | 10–14 |
| **Q3 拆解→执行→跟踪** | 清单被真实维护而非一次性摆设 | 多轮 case（driver 已支持 sessionId 复用追加 prompt）：步骤 1 拆解、步骤 2 执行中途、步骤 3 收尾——判 `updates` 增量事件序列 + 终态 `status` 分布（全 completed 或显式清空） | 8–12 |
| **Q4 拆解→派发（C4 协同）** | 该派子代理的调研步骤是否派发（#858 首次调用后的行为观测） | 大范围调研话术 → `expectTools` 含 `spawn_subagent`（或至少含其前置读工具族）；对照：只读小查询 → `forbidTools` 含 `spawn_subagent`（委派克制） | 4–6 |

Q4 刻意最小（4–6 条）：spawn_subagent 行为数据刚起步（11-12 首次真实调用），样本薄，**先观测不设强门禁**——与 #841 预案 §5 观测纪律一致，扩量等持续性数据。

## 4. 判据设计（可判定性优先）

- **判据全部落在 transcript/events 已有形状上**（`EvalTranscript.toolNames/toolCalls` + RuntimeEvent 展开），不新增遥测；
- **todo 快照断言**：todo_write/propose_plan 的 toolCall details 里取快照（`pickLatestSnapshot` 同构解析，防御式字段访问）——快照结构是**确定性数据**，硬断言零歧义；
- **画布终态 oracle（本域独有优势）**：生成类任务的收尾断言用 `list_generation_tasks`/`get_generation_status` 结果或 canvas 探针（`fetchCanvasNodeCount` 先例扩展），**不判文本、判状态**——这是 canvas agent 相对 coding agent 少有的可机检验收面；
- **LLM-judge 延后**：仅当某条判据确需语义判定（如「粒度是否过碎」）且硬断言表达不了时，单条加 `judge:true` 并 `judgeThreshold:null`（只观测），沿用 golden-cases 既定演进路径；
- **随机性处置**：行为类 case `repeat:3` 多数表决（既有机制，实测 27%↔70% 抖动教训），多数表决仍稳定 fail = 真问题，不加大 repeat 掩盖。

## 5. 基建复用与缺口

### 5.1 直接复用（零新建）
`eval/driver.ts`（HTTP 驱动部署形态 + SSE 订阅就绪 + agent_end 收手）、`golden-cases.ts` 的 `GoldenCase` 形状与 L0/L1 分层、`requiresCanvasNodes` 环境预检、`repeat` 多数表决、`PROMPT_AB_SCENARIOS` 的 anchor/groups 校验思路（`verify-ab-scenarios.ts` 先例）。

### 5.2 需扩展（测试侧，非生产代码）
- `GoldenCase` 增可选 `expectTodoSnapshot?: {...}`（items 数区间 / content 互斥 / 首步谓词）与 `expectCanvasState?: {...}`（节点数区间 / 生成记录存在性）两类判据字段——纯 eval 资产文件 + runner 判据函数；
- 多轮 case 支持：driver 的 sessionId 复用已是追加语义（`prompt` 追加、systemPrompt 首次生效），只需 case 结构上支持 steps[]。

### 5.3 运行环境约束（从 W1b 实测教训继承）
- 跑真模型 eval 须在部署形态 pi-runtime 上（不进程内直调）；`userId` 必须真实（假值 → 画布工具全 4xx → 全超时的假失败）；「先订阅就绪再 prompt」契约不得回退；
- 场景需要真实画布初始态的（Q2/Q3 多数需要），预检先查节点数，**环境不足直接抛错标「环境问题」，绝不静默跑空画布**（fetchCanvasNodeCount 注释里的 1/3→3/3 教训）。

## 6. 分期与验收

| 期 | 交付 | 验收 |
|---|---|---|
| **C-1a 种子集** | Q1+Q2 各 5–7 条（生产反查来源）+ runner 判据扩展 + L0 契约测试 | L0 全绿（无 token）；种子集人工跑一轮有完整报告（含失败归因分类：模型行为/判据过强/环境） |
| **C-1b 全量集** | 扩到 30–50 条（四象限齐）+ Q3 多轮 + Q4 观测 + 画布终态 oracle | 全集跑通 ≥ 2 轮，抖动率（repeat 表决后仍翻脸的 case 占比）< 20%，超线先修判据不是加 repeat |
| **C-1c 基线建档** | 生产模型基线数字入档 + 门禁阈值提案（人工拍板） | 基线报告落 `docs/ops/`；阈值只提案不自动生效——门槛数字是决策，不是技术参数 |

**门禁**：C-1 各期均为 eval 资产刀（services/pi-runtime/src/eval/** 测试侧 + docs），不触生产路径；但按仓库纪律，改 `services/` 仍须 PR + CI + 授权，合并后无需 runtime-deploy（eval 不进生产镜像构建输入——立项评审时核对此点，若 dist 含 eval 文件则需补部署影响面评估）。

## 7. 诚实边界

1. 场景集规模 30–50 是路标 §5.2 的原值，不因提前而缩水；但 Q4 数据薄是事实，首版 Q4 判据只观测；
2. 生产反查「真实多步话术」依赖 executionEvents 的用户消息可及性——若反查产出不足，缺口用显式 synthetic 补并在 note 登记比例，不虚报来源；
3. 本 spec 不含任何阈值数字（items 数区间等在 C-1a 实施时按生产样本定，立项阶段定数 = 拍脑袋）；
4. eval 判据本身可能过强/过弱——C-1a 的失败归因分类是判据校准期，**判据与模型行为的责任必须分开归因**（golden-cases 文件头第三条立场）；
5. 本立项不解决 G2 全部：prompt 一行契约的表述质量、Skill SOP（路标 §9.5）与 eval 是三条互补线，本 spec 只覆盖「质量可测」，不覆盖「质量可产」。

---

## 8. 判据细化（2026-11-13 讨论轮产物；C-1a 实施 spec 的直接输入）

### 8.0 来源澄清（四象限与六级粒度怎么来的——诚实登记，非行业标准框架）

- **行业真实存在的是三个方法层**：① 硬断言优先 / LLM-judge 兜底（Anthropic evals 指南立场，golden-cases 文件头已有本仓论证）；② 测试金字塔思想（按获取成本/确定性给断言分层）；③ eval case 按能力维度组织覆盖（Anthropic/Claude Code eval 集按 capability 切分）。本文借的是**方法**，不是现成框架。
- **四象限是沿本项目生产管道时间轴的构造**：拆解在我们管道上只有四个可观测时刻——触发与否（Q1）→ 快照结构（Q2）→ 跨轮维护（Q3）→ 派发决策（Q4，本项目 C4 特有）。每个时刻对应一种失败面：该拆没拆 / 拆得太碎太粗 / 拆完就扔 / 该委派没委派。轴选生命周期时刻而非任务类型（生成/排版/问答）：任务类型无限膨胀，时刻有限稳定，eval 集才可维护。
- **六级粒度是穷举本项目可观测数据面再按成本排序**：六个面的存在是本项目架构事实，数字六不可迁移。本质是测试金字塔在断言数据源上的应用。
- **局限声明**：四象限不是正交互斥的完备划分——Q3 以 Q1/Q2 发生为前提，Q4 样本薄。它是一张覆盖清单。**检验标准**：C-1a/1b 若跑出四个象限都装不下的失败样本 ⇒ 划分有洞，届时补轴并在此登记。

### 8.1 六级粒度阶梯（按数据源成本递增）

| 级 | 数据源 | 断什么 | 成本 | 确定性 |
|---|---|---|---|---|
| L0 行为层 | `transcript.toolNames` | expectTools/forbidTools（既有机制） | 零 | 高 |
| L1 参数意图层 | `transcript.toolCalls[].input`（已采集，当前无判据消费） | 子集匹配：如 `upsert_media_node` 的 `kind==="image"`、`set_node_text` 非空 | 零 | 高 |
| L2 快照结构层 | todo_write/propose_plan toolCall details（`pickLatestSnapshot` 同构解析） | items 数区间 / 互斥 / 首步谓词 | 零 | 高 |
| L3 节点存在层 | `fetchCanvasNodeCount` 先例扩展 | 节点数区间 / 按类型计数 | 低（HTTP 探针） | 高 |
| L4 布局关系层 | `get_canvas_layout` 读回坐标 | **仅锚可机检子集：无重叠（bbox 相交）+ 顺序保持**；左右/对齐/美观 → judge 观测 | 低 | 中 |
| L5 生成 oracle | `list_generation_tasks` / `get_generation_status` | 生成记录存在性 | 低 | 高（慢路径） |

三条裁决：
1. **L1 是被忽视的免费层**——零新增遥测。但 input 断言只证「模型想写什么」不证「写进画布」（被 plan-gate 拒的调用也留 input），必须配对 `expectCompleted` + errors 空判据；意图层与终态层不得混用（混用即假绿）。
2. **生成 oracle 分两级**：`generationSubmitted`（提交过，判模型行为）与 `generationSucceeded`（跑成功，判端到端）分开设。成功级受用户确认/额度/fallback 态影响是 flaky 源（`run_image_generation` status=timeout/fallback_pending 先例）——判模型行为用提交级；仅端到端 case 开成功级并标 `requiresGenerationWait` 慢路径。
3. **L4 诚实声明上限**：硬断言只锁「无重叠 + 顺序保持」两个确定性谓词，其余语义关系全部 `judge:true, judgeThreshold:null` 只观测（golden-cases 文件头第三条立场：judge 会混淆「判据错了」与「模型坏了」，语义面不卡闸）。

### 8.2 Q1 负例边界——「过度拆解」的操作化定义

语义判断前置到 case 编写期人工完成，运行时只做映射断言（保持硬断言纪律）：

> **正式定义**：话术经人工标注为「≤1 个原子工具调用可完成」（原子性在编写期锁定，写进 case 的 `about`），而模型触发 `todo_write`/`propose_plan` 且快照 items ≥ 2 ⇒ 判过度拆解。

- **判据形态**：`forbidTools: ["todo_write", "propose_plan"]`——与 `tool-discovery-002` 同机制换用，零新增 runner 能力。
- **三条豁免边界**（均为已证实的合理行为，负例话术须规避）：① 先查再确认不算（tool-discovery-001 教训，负例话术须自带无歧义参数）；② ask_user 澄清不算拆解（澄清矩阵纲领「问卡是决策原语」）；③ 1 项清单 + 方案说明（assumptions/依据性表述）不算——1 项且逐字复述原文才是过度。
- **对偶缺陷（欠拆解）与正例对称**：标注「≥2 个可分辨子目标」的话术 → expectTools 含 `todo_write`/`propose_plan` 且快照 items ≥ 2。Q1 整象限 = 子目标数（人工标注）→ 拆解触发与否的映射断言，不判拆得好不好（Q2 职责）。
- **巨石项**：无完美硬断言。初版只做失配代理（`items=1 ∧ 标注子目标≥2`）；content 长度/动作连词启发式登记为 judge 观测候选，不进硬断言。

### 8.3 判据字段形态（§5.2 两扩展字段具体化——纯声明式数据，无函数字段）

```ts
expectTodoSnapshot?: {
  minItems?: number; maxItems?: number;
  requireDistinctContent?: boolean;        // 精确串重复判重；语义重叠留 judge
  firstStepPredicate?: "clarify" | "collect" | "any";  // 枚举 ⇒ 可被 L0 校验
};
expectCanvasState?: {
  nodeCount?: { min?: number; max?: number };
  nodeTypeCounts?: Record<string, { min?: number; max?: number }>;
  generationSubmitted?: boolean;           // L5 提交级（判模型）
  generationSucceeded?: boolean;           // L5 成功级（判端到端，必须同时标 requiresGenerationWait）
  noOverlap?: boolean;                     // L4 确定性子集
};
```

声明式约束的意义：两个结构无函数字段 ⇒ 可进 L0 契约层校验（registry.ts case 合法性检查先例扩展：min≤max、枚举合法、成功级必须配慢路径开关），把「判据写错」挡在无 token 阶段。

### 8.4 粒度 × 象限映射（避免过度武装）

| 象限 | 用到的层 | 说明 |
|---|---|---|
| Q1 时机 | L0 + L2 触发与否 | 终态层不掺和——时机只看「调没调 + 快照在不在」 |
| Q2 结构 | L2 + L1 | 快照结构为主，参数意图为辅 |
| Q3 跟踪 | L2 updates 序列 + L3 收尾 | 多轮 steps 每步断言独立成立 |
| Q4 派发 | L0 only | 刻意最小（观测期） |
| 终态 oracle（L3–L5） | 非独立象限 | 是 Q3 收尾步的判据升级件 |

### 8.5 校准纪律与新增探针清单（C-1a 实施输入）

- 失败归因三分类不变（模型行为 / 判据过强 / 环境）；`requiresCanvasNodes` 声明式预检先例扩展到全部新探针；
- 判据过强诊断信号：同一 case 跨模型/跨配置稳定 fail 于同一断言 ⇒ 先疑判据再疑模型；
- 阈值数字（minItems、nodeCount 区间）按 §7.3 纪律 C-1a 生产样本期定；
- **新增探针仅两处**：按类型数节点（L3 扩展）、生成记录存在性（L5 读回）；其余全部复用既有数据面。

### 8.6 A-2' 前置观测判据（2026-11-13 拍板 2 配套，Q3 新增；锚 = 路标规格 §11）

- **观测对象**：identity 断裂率——模型改措辞/重发清单时「同一任务」的 id 跨快照存活率（现行 `reduce()` 按 content 匹配，content 一字之差即旧 id 消失+新 id 新增，`task-state.ts:43-50,55-56`）。
- **判据形态**：语义前置到 case 编写期（Q1 负例同款纪律）——编写期人工标注「本 case 中哪条 item 会被编辑/重发」，运行时追踪该标注 item 的 id 是否跨快照存活；id 变化 ⇒ 记 identity 断裂一次。**只观测不计分**（不设门、不影响 pass/fail）。
- **产出**：断裂率基线（断裂次数 / 编辑次数）进 C-1c 基线档案，作为 A-2'（模型侧 id 契约）立项评审的价值证明输入——路标 §11.3 拍板 2：A-2' 立项须引用本判据数据。
- **触发捷径**：正式判据随 Q3 多轮 case 在 **C-1b** 生效（§6 分期：C-1a 只有 Q1+Q2）；C-1a 期间人工跑批**顺手观测**到断裂率异常偏高或真实误删形态（不需要正式判据，人工记录）同样可触发 A-2' 提前立项，不等 C-1c（条件触发纪律）。

### 8.7 运行节奏与漂移防护（2026-11-13 第四轮行业对照产物；锚 = 路标规格 §18）

- **model id 固定纪律**（行业明文：pin model IDs——模型变更应成为可见 diff）：生产路由 `platform::agnes-*` 可被平台侧变更，runner 必须记录每 case 实际 model id 并在报告固定展示；跨 run 对比须声明模型同 id，否则基线数字不可比。
- **运行节奏定位**（行业分层四档对照，路标 §18.1）：本 eval 集 = 人工档——L0 契约层进 CI（≈行业档① smoke，裁决不变），真模型集发版前人工跑；「nightly 定时跑批（观测非阻塞）+ 变更触发全量（L2/L6 prompt 改动 / 模型版本变更 / SOP skill 上线 / task-state 代码改动）」登记为 **C-1c 后候选**，不改变本 spec 非目标边界（仍不进 PR 卡门）。
- **事故→eval 回灌**：每起生产拆解类故障样本回灌 eval 集为永久回归 case（§3 双源纪律的自然延伸，C-1b 起执行）——防 eval 集不进新 case 而静默失去区分力。
- **报告格式**：per-case 对比上一通过 run（不只看总分阈值），防「总分涨了但换了个地方坏」（C-1c 基线档案格式输入）。
