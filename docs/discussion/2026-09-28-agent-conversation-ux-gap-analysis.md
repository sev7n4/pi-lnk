# Agent 对话过程体验：行业最佳实践 × pi-lnk 差距分析

> 2026-09-28 · 对标对象：OpenAI Codex、Claude Code、ChatGPT Agent、Cursor、Manus、Devin、WorkBuddy
> 素材：Codex 官方 best practices、setproduct《16 AI agent UI design patterns》、zylos《Agentic UX 2026》、aydesign《Best AI agent interfaces 2026》、jacar.es《UI design for agents》+ pi-lnk 代码全链路盘点

---

## §0 声明

本文无图表（无 § Figure 声明需求核对项）。文中所有代码位置均来自 2026-09-28 主分支盘点。

---

## 1. 行业共识：对话过程的体验是怎么设计的

成熟 agent 产品的对话体验有一条几乎收敛的分层结构：**对话流负责意图与决策，活动面板（Activity Panel）负责过程透明，卡片负责结构化交互**。逐环节拆解：

### 1.1 意图理解与澄清

| 实践 | 代表产品 |
|---|---|
| **Plan Mode / Ask Mode 两段式**：复杂任务先进入"只读规划态"——收集上下文、反问澄清、产出计划，用户批准后才切换到执行态 | Codex（/plan、Shift+Tab）、Claude Code（plan mode） |
| **Interview 模式**：明确允许 agent "挑战用户假设"，把模糊想法问成具体需求；官方把「让 Codex 向你提问」列为标准动作 | Codex best practices |
| **结构化澄清卡**：澄清不是纯文本反问，而是选项卡（2-4 个 chip + 推荐项高亮 + "Other" 自由输入），用户一次点击即回流，不打断上下文 | ChatGPT Agent、Manus、WorkBuddy ask_user 类交互 |
| 提示词四要素（Goal / Context / Constraints / Done-when）作为产品内的引导框架（输入框模板、@ 引用文件） | Codex |

### 1.2 思考过程展示

- **默认折叠、一行摘要可见**：reasoning 是每步一个可展开的 "Thinking" 区块，闭合时只显示一行摘要。Claude Code、Cursor、ChatGPT（reasoning summary）、Manus 全部如此。
- **判据**：「改变了世界的是 tool call，改变了主意的才是 reasoning」——思考不占对话主位，但出错时可审计。
- **红线**：需要用户行动的决策绝不能藏在折叠区里。

### 1.3 现状探索 / 过程透明

- **Live Step Ledger（步骤账本）**：垂直列表 + 状态字形（pending 空心圆 / running 动画 / done ✓ / failed ✗），运行中的步骤 pin 住，失败的步骤**留在原地标记**（只显示成功的账本=隐藏审计线索）。Claude Code task list、Cursor agent mode、Manus 侧栏全部收敛到这一模式。
- **Activity Panel 与对话分离**：对话列管澄清与反馈，活动面板管自主工作（工具调用、子任务、进度、审批）。两家研究都把「混在一起导致认知过载、无法事后审计」列为反模式。
- **渐进披露（Progressive Disclosure）三层**：步骤摘要（3/7 完成）→ 展开看工具调用 → 再展开看原始请求/响应。默认全展开=过载，默认全折叠=不信任。

### 1.4 任务规划

- **可编辑计划 + 执行中活清单**：计划在执行前可增删改步骤；执行时计划变成逐项勾选的清单，随完成实时更新。Claude Code 的 editable plan + live checklist 被评为 2026 多步信任 UX 最强。
- **计划外部化**：长任务把计划写进 PLANS.md / todo 工具（文件或 UI 一等公民），agent 边做边更新，防漂移。Codex 官方列为核心手法。
- **里程碑自验证**：每个里程碑强制验证（build/test pass）再进下一步——UX 上体现为步骤卡里的"验证"子步骤。

### 1.5 工具调用可视化

- **每个外部动作一张卡**：工具名 + 输入 + 输出（截断可展开）+ **耗时** + 状态。相同连续调用合并为一张带计数。
- **耗时必须上卡**："40s 的 npm install" 不标时长会被读成 agent 在发呆。
- **读写分层徽章**：Read=灰不打扰 / Write=蓝（每会话每域问一次，可 always-allow）/ Destructive=红（每次必问）。徽章同时出现在工具卡和确认弹窗上。
- **审批即知情决策**：确认请求必须携带上下文（已做了什么、这步做什么、下一步是什么）——纯 "Approve/Deny" 是反模式。审批用领域视觉语义（diff、表格、渲染预览），不是盲按钮。
- 流式展示工具输出（而非等回合结束），被多家 2025-2026 复盘列为**单点价值最高的 UX 改进**。

### 1.6 多方案多路径推荐卡

- 方案卡 = 每张卡含：方案名、一句话差异、关键属性对比、**明确标注的推荐项（默认选中）**、缩略图/预览。
- 选择回流为下一轮输入，且选择历史保留在对话里可回溯。
- 代表：ChatGPT Agent 方案选择、Manus 计划确认、WorkBuddy 的多方案卡（风格/交付/拓扑卡）。

### 1.7 图形化解释

- agent 主动调用绘图（流程图、架构图、示意图）来**澄清问题**而非仅做交付物——Claude artifacts、ChatGPT canvas、WorkBuddy 的 inline SVG widget 都验证了「一张图胜过一段澄清文字」。
- 图形必须是 agent 的一等工具（模型可决定何时画），而不是前端把已有数据勉强渲染。
- 产出的 mermaid/diagram 必须真正渲染，源码折叠只作为兜底。

### 1.8 中间摘要与推送

- **长任务的中间叙事**：每完成一个里程碑主动汇报一句（Manus 式 "已完成 A，正在 B"），而不是静默后一次性倒出。
- **后台模式 + 状态 pill**：任务脱离对话页跑时，导航栏 pill 显示运行数；**必须区分「工作中」与「等待你输入」**——两者长得一样会让用户干等几小时（行业明文教训）。
- 超时/完成后主动通知（Devin 推 Slack、Manus 完成通知）。

### 1.9 完成后的总结

- **结构化总结**：产物列表（带缩略图、可点击放大/定位）、改动清单、耗时与用量。
- 产物是可交互对象：图片/视频/文件可预览、可打开、可导出；引用可 hover 预览。
- 后续动作入口（suggested follow-ups：3-5 个下一步 chip）。

### 1.10 错误恢复

- 三段式错误面：**发生了什么（具体失败）→ 为什么（最可能原因）→ 下一步怎么办（具体动作，不是 "try again"）**。通用 "something went wrong" 在 agent 场景是重罪——用户无法区分是提示词问题、API 故障、权限问题还是推理错误。
- 程序化检测卡死（重复工具调用、无进展）并主动路由到 fallback。
- 中断后从断点恢复，而非重开。

---

## 2. pi-lnk 现状盘点（代码实证）

链路：pi-runtime（SSE 11 种归一事件）→ Nest `pi-events.ts` 映射 → `AgentSideRail.vue` 手工解析 → `stores/agent.ts` + `executionTraceReducer`。

| # | 环节 | 现状 | 位置 |
|---|---|---|---|
| 1 | 流式响应 | text_delta 逐字流式 + 光标 ✅；thinking 只累积不透传（v1 注释明确不做），折叠为 end 后 200 字摘要，trace 里一行「思考中」；无骨架屏，静默期只有秒数计时 | pi-events.ts:214-231、AgentSideRail.vue:2441 |
| 2 | 阶段进度 | **阶段条半休眠**：reducer 支持 8 类步骤，但 pi 路径 server 只产出 8 种事件，step/phase_hint/explore/task_update 全部零生产者；journeyTrace 是死契约 | agent.service.ts:696-747 |
| 3 | 工具调用 | 一行 10px 灰字 `⚙ name · args`；trace 时间线有 running 动画；结果只有 80 字摘要、**无折叠展开**；参数摘要仅覆盖 4/12 工具；**isError 透传了但前端丢弃，失败显示为绿 ✓** | AgentSideRail.vue:2487-2489、pi-events.ts:84-90 |
| 4 | 规划 | **无 plan/todo 面板**。TaskProgressCard 靠画布节点对账+轮询兜底，非 agent 一等汇报 | AgentSideRail.vue:2158-2182 |
| 5 | 澄清卡 | **最强的一块**：ask_user chip 卡（单选即回传/多选+确认/Other 自由文本）+ arrange_nodes + 5 个 focus/undo 类，7 个 ui_command 全通；但刷新后 ask_user 不恢复（questions 不落 metadata） | AskUserCard.vue |
| 6 | 图形化 | **无绘图工具**；mermaid 有数据但只渲染为折叠 `<pre>` 源码 | AgentTopoCardList.vue |
| 7 | 中间摘要 | 无主动进度叙事；gen_progress 契约（W15）服务端在、前端 0 引用，死接口 | agentContract.ts:566-593 |
| 8 | 完成总结 | 交付摘要表卡 + 画布产出挂件 ✅；但产出列表**纯文本无缩略图**、无视频预览、无点击放大；非视觉线回合只有一行 turnSummary | AgentCanvasOutputs.vue |
| 9 | 停止/中断 | **完整**：双态按钮 → cancelActiveStream → runtime abort + userAborted 抑制假警报；带「完成 x/y」callout | DockGenerateButton.vue |
| 10 | 状态恢复 | thread-state + executionTrace replay 恢复 ✅；但每轮销毁 runtime 会话，重连靠**文本 snippet 匹配轮询**（脆弱）；ask_user/pending 状态刷新即失；AgentPanel/AgentFloatingWindow 是 SideRail 残缺复制版，**三入口漂移** | AgentSideRail.vue:1850-1922 |
| 11 | 事件契约 | Nest 映射表里 **error → pi_error 透传，前端无 default 分支静默丢弃**——pi 运行中报错用户只看到空文本兜底 | agent.service.ts:706 |

---

## 3. 差距定级（按用户可感知伤害排序）

### P0 — 断裂/反模式（修复成本低、伤害最高）

1. **错误呈现链路断裂（bug 级）**：pi error → `pi_error` 透传前端不识别；tool isError 丢弃、失败显示绿 ✓。用户视角=「沉默的空回复」。与行业三段式错误面差距最大，且只是前端消费 + reducer 标红的问题。→ `AgentSideRail.vue` handleEvent 加 error 分支、`executionTraceReducer.ts:298-328` applyToolCall 尊重 isError、错误按「发生了什么/为什么/下一步」三段渲染。
2. **思考过程无独立面板**：目前只有 end 后一行摘要。对齐行业做法：thinking 事件透传（哪怕节流 delta），渲染为每回合一个可折叠 "思考" 区块（默认折叠、首行摘要可见）。

### P1 — 体验主干缺失

3. **工具调用卡太薄**：一行灰字 → 改为可折叠卡片（名称+参数摘要+完整结果+耗时+状态徽章）；参数摘要覆盖全部 12 工具；连续同调用合并。`toolArgSummary.ts` 从 4 个工具扩到全量。
4. **阶段级进度叙事**：激活休眠的 step/phase_hint 链路（reducer 8 类分支已就绪，缺生产者）——pi-runtime 侧在 run 开始/里程碑产出阶段事件，前端已有渲染。同时清理 journeyTrace、PHASE_LABELS 等死代码，避免"看似有阶段条"的假象。
5. **计划/todo 一等公民**：多步任务让 agent 维护 todo（激活 task_update 事件生产者），复用 TaskProgressCard 而非轮询兜底；计划在执行前可编辑是进阶项。
6. **完成产物可视化**：产出列表加缩略图（图片/视频首帧）、点击放大/定位；非视觉线回合补结构化总结卡。
7. **ask_user 刷新恢复**：questions 落 message metadata / thread-state，重连后可恢复待答卡片；卡片与工具调用行做关联标注。

### P2 — 增强与治理

8. **mermaid 真渲染**：引入 mermaid.js 渲染 `presentation.body.mermaid`，源码折叠为兜底；中期给 agent 加绘图工具（SVG/图表），让「画图澄清」成为一等能力。
9. **中间进度推送**：接通或删除 gen_progress 死契约（按项目规范：明确决策，不留悬空）；长任务里程碑主动插一句进度文本。
10. **三入口收敛**：AgentPanel/AgentFloatingWindow 与 SideRail 漂移是持续劣化源，收敛为单一组件 + 差异化外壳。
11. **重连机制去脆弱化**：snippet 匹配轮询改为服务端回合终态查询（thread-state 已有一半能力）。

### 已达标项（无需动）

- 停止/中断全链路（双态按钮 + abort + 完成进度 callout）——好于多数产品。
- ask_user 卡片交互本身（chip 即回传、Other 自由文本）——形态对齐行业。
- 幂等发送、SSE 断线检测、执行轨迹 replay 恢复的骨架。

---

## 4. 一句话总结

我们**最强的**是澄清卡与停止链路，**最危险的**是错误链路静默断裂，**最欠的**是过程透明度（工具卡、阶段叙事、计划清单）和产物可视化「最后一公里」。P0 两项合计改动面小、感知提升最大，建议先行立项。
