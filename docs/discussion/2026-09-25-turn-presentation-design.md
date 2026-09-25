# 回合呈现层设计（Turn Presentation）

## §0 图形声明

本文档无任何示意图（无 SVG/Mermaid/图片），为纯文字设计文档。

> 状态：设计定稿（2026-09-25），经 WorkBuddy 呈现体验对标评审修订。
> 关联：P0 实现计划 `docs/superpowers/plans/2026-09-25-execution-trace-observability.md`（执行过程可观测性专项，Task 1-6）；P1/P2 增量见该计划「后继章节」。
> 背景侧输入：2026-09-25 侧栏实测七问复盘（重复步骤、入参不可见、思考丢弃、隐性 skill、无结构化呈现、工具选择黑盒）。

## 1. 目标与对标

以 WorkBuddy 的回合呈现体验为对标：状态行（生成回复中 · 已处理 Ns · 已消耗积分）、过程时间线（深度思考/已搜索/技能图标/工具步骤逐个流式完成）、结果层（摘要、总结、产物卡）、刷新可回放。pi-lnk 画布 agent 当前只渲染「工具名列表 + 一段流式文本」，本设计定义四层呈现模型与事件契约增量，全部由现有事件流派生，**不碰 pi-agent-core vendor、不碰 before_tool Gate**。

## 2. 四层呈现模型

### 第 1 层：状态行（回合进行中的实时元信息）

| WorkBuddy 要素 | pi-lnk 数据源 | 现状 / 增量 |
|---|---|---|
| 阶段徽标（生成回复中 / 已搜索 / 深度思考 / 技能） | 当前 running 步骤的 kind | 已有；标签经工具注册表人话化（§3） |
| 已处理 Ns（实时） | trace.turnStartedAt 前端计时 | 增量：running 态实时显示（现仅结束后 totalMs） |
| **已消耗（事后实耗）** | pi harness usage（message_end/turn_end 携带 tokens）累积 | **新增 `turn_usage` UI 事件**：Nest 在 agent_end 前从事件流汇总 `{ inputTokens, outputTokens }`，前端显示「已消耗 1.2k tokens」 |
| **预计消耗（事前预估）** | 输入 prompt 长度 + 该场景历史均值 × 单价 | P2：粗估即可；换算函数 `usageToCredits(usage): number` 独立纯函数预留，将来接计费不改契约 |
| **等待确认态** | trace 中 `waiting_user` 步骤（propose_generation 后） | **P1 必做**：streaming footer 消费 waiting_user → 显示「等待你确认」并停止秒数累加；现状转圈不止，体验错误 |
| 失败态 | failed 步骤 + formatStructuredError | P1：状态行显示「生成失败 · 原因摘要」，不纳入注册表 |

### 第 2 层：过程时间线（人话标签 + 图标 + 认知负荷控制）

**工具展示注册表**（前端纯映射，展示层翻译不进事件契约——改文案不需要后端发版）：

| 工具 | 图标 | 动词短语 | 参数摘要 | 完成态文案 |
|---|---|---|---|---|
| load_skill | ⚡ | 加载技能 | skill 名（P0 Task 2 已做） | 已加载技能 |
| get_canvas_summary | 🔍 | 感知画布 | N 个节点 | 已感知画布 |
| upsert_media_node | ✏️ | 创建节点 | 节点标题（P0 已做） | 已创建「标题」 |
| propose_generation | 🖼️ | 提议生成 | N 张图（P0 已做） | 等待你确认 |
| run_* | 🎨 | 生成 | 节点标题 | 已生成 |
| cancel_generation | ⏹ | 取消生成 | 节点 id | 已取消 |
| 其他未知工具 | ⚙ | 调用 {name} | —（兜底） | 完成 |

原则：**读工具 ≠ 写工具**——感知类读工具翻译成「已感知画布」类完成态，不赤露工具名。

**认知负荷控制（P1 优先于注册表）**：

- 执行过程**默认折叠**，头行只显示「N 步 · 最新：🖼️ 提议生成 3 张图」；
- 展开（点击）才显示全量步骤列表；
- 步骤逐个流式出现，running→done 有动效节拍（纯 CSS：出现 stagger + 完成 ✓ 过渡）；
- 当前实测的 13 步全量平铺不再出现。

### 第 3 层：结果层（摘要 + 产物）

- **摘要行**（P1）：回合结束（done）时前端汇总一行：「已创建 6 个节点 · 提议生成 3 张 · 用时 16s · 消耗 3.4k tokens」。数据全部来自 trace + turn_usage，零后端改动。
- **产物链（P2 拆两步）**：
  1. **linkedOutputs 先行**（近零成本）：canvas 数据与前端 `AgentCanvasOutputs` 组件均已存在，pi 路径 canvas_action → linkedOutputs 接线即可获得产物缩略卡；
  2. **生成占位 → 完成替换**：确认生成后画布节点「生成中」占位态，node_status 事件到达后替换为图（数据通道已有，接线问题）；
  3. **presentation envelope 单独立项**：老链路 journey/presentation 是老 agent 硬编码产出（9 步工作流、方案卡等），pi 路径产出同形态需先设计「模型按 schema 输出 or Nest 派生」契约，工作量周级，**不并入本专项**。
- 元素编辑面板形态（编辑内容清单 + 取消/生成按钮）作为产物卡交互参照。

### 第 4 层：持久化回放

executionEvents 全量持久化（P0 Task 3 已含 pi 路径收集 + buildTurnMetadata），刷新后 replayExecutionTraceEvents 重建第 1-3 层。第 4 层是其余各层的唯一前置依赖，P0 交付。

## 3. thinking 可控性（P1）

「深度思考」不只是展示，先让思考可控：老链路 `streamFromRuntime` 已有 `thinking / thinkingEffort` 参数，pi 路径 `ensurePiSession` 未透传。P1 增量：

- pi-runtime create body 增 `thinking?: boolean`（或映射到模型装配参数）；
- Nest `ensurePiSession` 透传前端开关；
- 前端思考步骤仅在开关开启时展示（无思考流的模型零事件，UI 不悬挂——P0 Task 3 测试 A4 已覆盖）。

## 4. 分期汇总

| 期 | 内容 | 前置 |
|---|---|---|
| P0（已立项） | 去重、入参摘要、thinking 透传、/skill 显性调用、executionEvents 持久化 | 无 |
| P1 状态行 + 收口 | 实时秒数、waiting_user 收口、turn_usage 事件 + token 实耗、失败态、摘要行 | P0 |
| P1 时间线 | 认知负荷控制（默认折叠露最新一步）、步骤动效节拍、工具展示注册表、thinking 开关透传 | P0 |
| P2 结果层 | linkedOutputs 接线、生成占位→替换、预计消耗、侧栏技能选择器（**正式项，非可选**——显性调用的主要形态，文本指令仅验证链路） | P1 |
| P2 后（独立立项） | presentation envelope 输出契约设计 | P2 |

## 5. 决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | usage v1 显示 token 数，不显示积分 | pi-lnk 无计费系统；换算留 `usageToCredits` 纯函数接口 |
| D2 | 工具注册表放前端纯映射 | 展示翻译不进事件契约，改文案不需后端发版；老链路事件语义不同，复用性不是理由 |
| D3 | 产物层先 linkedOutputs 后 presentation | 前者零成本拿缩略卡；后者需输出契约设计，独立立项 |
| D4 | 侧栏技能选择器为 P2 正式项 | WorkBuddy 经验：slash/@ 引用是主要形态，纯文本 /skill 记不住技能名 |
| D5 | 认知负荷控制优先于注册表 | 折叠+最新一步比图标更能解决「用户看不懂」 |

## 6. 体验验收标尺（P1/P2 done 定义）

对标 WorkBuddy 截图逐项核验：

1. 发送后 1s 内状态行出现「生成回复中 · 0s」，秒数持续跳动；
2. 等待确认时状态行变「等待你确认」，秒数停止；
3. 失败时状态行变「生成失败 · <原因摘要>」；
4. 过程默认折叠，头行含步数与最新一步人话；展开可见逐条带图标与人话标签；
5. thinking 开启时出现「深度思考」步骤，可展开看摘要；
6. 回合结束出现摘要行（节点数/生成数/耗时/tokens）；
7. 刷新页面后以上 1-6 的历史回放完整；
8. `/skill` 与侧栏选择器（P2）均能显性触发技能，执行过程显示「已加载技能 · <名>」。
