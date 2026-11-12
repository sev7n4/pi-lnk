# C-1 · canvas 拆解质量 Eval 集——立项规格（决策门性质，不授权代码刀）

> 日期：2026-11-12 · 状态：**待评审拍板**（立项后走 spec → plan → implementation，实施需单独授权）
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
