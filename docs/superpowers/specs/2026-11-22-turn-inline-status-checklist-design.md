# 一轮 Turn 内「单一当前态 + 流内折叠任务清单 + 小结归位」设计规格（B 形态 / 推翻重做）

> 状态：🟢 living（2026-11-22 用户拍板：当前态放 A＝对话流内轮首；任务清单收纳选 B＝Codex 式流内折叠清单）
> 基线：`origin/master @ 004ffa2d`（旧三阶段方案 `#969/#970` 已上线，本规格在同一基线上**替换**，不做生产回滚）
> 前序规格：`2026-11-22-turn-phase-progress-design.md` 已退役，保留仅供决策轨迹追溯
> 实施计划：[`../plans/2026-11-22-turn-inline-status-checklist.md`](../plans/2026-11-22-turn-inline-status-checklist.md)
>
> 用户裁定（2026-11-22 生产会话 `cmwrnm9ch0b2fo901p15oscif` 复测）：上一版「探索中/创作中/收尾中」三态并列、
> ①②③ 序号、UI 拼装小结、任务卡钉 composer 底部**均不符合预期，整体推翻重做**。
> 本规格逐条映射用户 6 点反馈（§1），一切结论以一手文档 + 既有代码事实为准（§2、§3）。

## 0. 第一原则与等价物检索结论（强制）

第一原则：**吃满上游、不重复造轮子**。任何新增判据/工具/字段/引擎前过三判据
（① 等价物检索 ② 接线优先于新建，锚已有结构化数据面 ③ 禁造数/禁自报）。

| 需求 | 已存在的等价物（file:line，基线 004ffa2d） | 结论 |
|---|---|---|
| 唯一当前态文本 | `activityLine.ts:41-65` `turnLiveStatus(parts)`：生成回复中 / 深度思考中 / 正在〈工具人话〉/ 正在生成产物 / 等待你确认 / 等待模型响应 | **直接接线**，零新增状态词表；轮首行是它在对话流内的唯一渲染落点 |
| 工具人话 | `toolPresentation.ts` `presentToolStep()`（注册表 + 未知自曝兜底） | 复用，`turnLiveStatus` 内部已调用 |
| 等待态 | `turnStatusBar.ts` `resolveWaitingFromTimeline()` | 复用（含在 `turnLiveStatus` 中），不复活 `turnStatusLine` UI |
| 任务清单数据 | `agentTaskProgress.ts` `AgentTaskProgressState.items`（status/title/activeForm/nodeId/errorHint）、`formatTaskProgressLine()` | **直接接线**：`AgentSideRail` 已有 `taskProgress` ref（`:534`），经既有 `:task-progress` prop 路线上行 |
| 清单折叠契约 | `useDisclosure.ts:45-75`：用户意图优先于展示默认值，`manual` 三态防 patch 弹回 | **复用**：checklist 用 `<details>` + `useDisclosure`，默认折叠 |
| 清单项状态词 | `AgentTaskProgressCard.vue:15-23` `statusLabel`（等待中/进行中/重试中/完成/失败/需你处理/已跳过） | 复用同一份文案映射，不造第二套 |
| 清单项定位入口 | `CanvasLocatePinIcon.vue`，`AgentTaskProgressCard.vue:70-72` 既有 hover 定位 | 复用 |
| 推理小结 | `turnTimeline.ts:559/565/572`：`thinking.data.summary` → `ThinkingPart.text`；`AgentTurnTimeline.vue:486-502` thinking 折叠块已展示该 text | **归位，零新增 UI**：推理摘要本就在 thinking 块内，删旧 UI 拼装的「小结：」即可 |
| 工具结果小结 | `turnTimeline.ts:72` `tool.resultSummary`、`:711/715` 由 `summarizeToolResult(d.result)` 写入；`AgentTurnTimeline.vue:540-552` tool `<details>` 展开已展示 | **归位，零新增 UI**：工具做完什么在其结果展开内，不另起一行 |
| 下一步 / 出错怎么办 | 模型正文 `text` part（既有）；`notice` part 的 `tone:'error'` + `retryLabel` + 重试按钮（`AgentTurnTimeline.vue` 既有） | **不造数**：下一步由模型正文给出，出错由既有重试入口承接；UI 不拼装伪叙事 |
| 历史任务凭据 | `plan` part（`turnTimeline.ts:170-179` steps + activeForm；`AgentTurnTimeline.vue:817-833` 已有有序渲染） | 复用既有 plan part 承担历史凭据，不新增 part kind |
| 收口判定 | `notice:turn-summary` 稳定 id（`turnTimeline.ts:1183-1189`）、`:streaming` prop | 复用双门禁；`isTurnFinalized()` 从旧 `turnPhaseView.ts` 迁入新派生模块，不新增事件 |
| 阶段分类 `phaseForToolName` | `phaseAggregator.ts`（旧方案析出，已被 `AgentExecutionTrace` 消费） | **保留，不删**：它本身正确且是工具分类单源；只删消费它的三阶段视图 |
| Codex 的 plan_delta / OSC 带外状态 | 本项目无终端集成面，`parts` + `taskProgress` 已是单一真相 | 不适用，禁止照搬 |

三判据核对：① 等价物逐项命中既有资产（见上表）；② 接线优先——本规格**零新增数据字段、
零 SSE 事件、零 DB migration、零新令牌、零新增 part kind**，只新增 1 个纯派生模块、1 段组件内
模板与 1 个 `<details>` 折叠；③ 禁造数——当前态只取 `turnLiveStatus`，清单只取 `taskProgress.items`，
推理/结果小结只用真实 `thinking.text` / `tool.resultSummary`，禁 prompt 派生、模型自报、`0/0`、`XXXXXX`。

## 1. 用户 6 点反馈逐条映射（本规格的存在理由）

| # | 用户原文要点 | 旧方案问题 | 本规格裁决 | DoD 判据 |
|---|---|---|---|---|
| 1 | 「探索中/创作中/收尾中」三个状态不应同时出现，且不应出现在 SSE 对话开始处；阶段性状态只显示阶段的叙事 | `AgentTurnTimeline.vue:462-480` 三阶段并列渲染在 parts 之前 | **唯一当前态**，取 `turnLiveStatus(parts)` 的一句叙事（如「深度思考中」「正在感知画布」），轮首单行 | 活跃轮最多 1 条 `[data-testid="turn-current-state"]`，文本 ∈ `turnLiveStatus` 全谱；三阶段词「探索中/创作中/收尾中」在轮首区 0 次 |
| 2 | ①②③ 序号多余 | `PHASE_INDEX_LABELS = ['①','②','③']`（`:384`） | 删除全部序号与编号常量 | `PHASE_INDEX_LABELS` / `①②③` 在 web src 0 次（棘轮扫描） |
| 3 | composer 上面的白色光标矩形为何出现？这里应是 agent 状态出现点 | 白块是 thinking/text 的流式 `▊`（`:502/511`），不是状态位；用户误读为占位 | **澄清 + 归位**：`▊` 是正文/thinking 正在输出的行业惯例指示，保留但明确它≠agent 状态；agent 状态按拍板 A 落在**轮首唯一行**，不在正文尾部空位渲染状态 | 走查确认：`▊` 仅出现在活跃 thinking/text 尾部，收口即消失；轮首状态行存在且非 `▊` |
| 4 | 阶段性小结位置不对；应总结推理之后 / 工具调用之后（做完什么、下一步、出错怎么办） | `turnPhaseView.summarizeStage()` 从工具人话/计数 UI 拼装「小结：…」，挂在轮首 | **归位不新建**：推理摘要看 thinking 折叠块内 `text`；工具结果看 tool `<details>` 内 `resultSummary`；下一步看模型正文；出错看 error notice 重试入口。删 UI 拼装小结 | 轮首区无「小结：」字样；含 summary 的 thinking/含 resultSummary 的 tool 仍在原位展示；error notice 重试入口仍在 |
| 5 | 任务卡片与阶段性小结的边界职责是什么 | 旧版两者都在轮首抢叙事位 | **职责分离**：清单＝结构化进度「做到哪一步」；叙事＝各 part 原位「发生了什么/下一步/出错」。两者不互相生成、不重复文案 | 清单项文案来自 `title/activeForm`；小结文案来自 `thinking.text`/`resultSummary`；两处不出现同一句 |
| 6 | 任务卡片为什么固定在最底部 | `AgentSideRail.vue:3837-3842` `AgentTaskProgressCard` 挂在 composer 上方 | **取消钉底**：删该卡片渲染，清单改为对话流内折叠 checklist（Codex 式）；不再有 composer 上方任务卡 | `showTaskCardAtComposer` / composer 区 `AgentTaskProgressCard` 0 次；流内 `[data-testid="turn-task-checklist"]` 存在 |

## 2. 行业取证（一手优先，标注证据强度）

| 产品 | 与本规格相关的原文事实 | 证据 / 强度 |
|---|---|---|
| **WorkBuddy** | 「WorkBuddy 在执行任务时，会把**关键步骤和结果展示在对话区**中……您通常会看到：WorkBuddy 的回复内容／**执行中的阶段说明**（如"正在分析数据"、"正在生成报告"）／**已生成的结果摘要**／**可展开查看的中间步骤**。」 | [任务对话](https://www.workbuddy.cn/docs/workbuddy/Conversation) 一手，2026-11-22 复核。注意：原文是「阶段说明」动态叙事，**没有**并列阶段列表、没有①②③、没有把清单钉在输入框上沿 |
| **WorkBuddy** | MCP 加载段：「加载中会显示『正在连接 MCP 服务』以及**已连接数/服务总数**，连接成功会实时更新；可以展开查看明细……全部连接完成后，展示『所有 MCP 服务已就绪』；这段进度**只在加载阶段临时出现，加载完成后就会从对话流中消失，不作为历史消息保留**。」 | 同上，一手。**这正是用户「临时进度 + 完成即消失」的原句出处**：临时的是进度块，不是把唯一当前态做成多行阶段 |
| **Codex** | 协议一等公民：`PlanUpdate(UpdatePlanArgs)`、`PlanDelta(PlanDeltaEvent)`；`ItemStartedEvent`/`ItemCompletedEvent` 带 `started_at_ms`/`completed_at_ms`；`TurnCompleteEvent` 带 `last_agent_message`/`error`/`duration_ms`/`time_to_first_token_ms`。`AgentReasoningSectionBreak` 原注释：「Signaled when the model begins a new reasoning summary section (e.g., a new titled block).」 | [protocol.rs](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs) 一手，2026-11-22 复核。**结构在事件层、呈现是单个 plan item**，不是每步都占一行常驻 |
| **Codex** | v0.155.0 原文 changelog：「**Show streaming reasoning summaries in the TUI status row**」（#43921） | [release](https://github.com/openai/codex/releases/tag/rust-v0.155.0) 一手。**推理摘要进状态行、与正文分流**，对应本规格「推理小结留在 thinking 块、不在轮首另起」 |
| **Codex**（2026-11-22 二轮补证，源码级一手） | plan checklist 的**默认折叠态**：`activity_disclosure()` 决定是否可展开，`compact_hyperlink_lines()` 是常态——标题 `• Updated Plan · {completed}/{total} complete` + 最多 `DETAIL_PREVIEW_LINES=3` 行预览（多/长/有 note 才需展开）。 | [history_cell/plans.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/history_cell/plans.rs) `DETAIL_PREVIEW_LINES=3`（activity_preview.rs:7）+ `compact_hyperlink_lines()`。**默认折叠、摘要行带完成计数**＝用户 B 图的实现原型 |
| **Codex**（同上） | plan 步骤的**完成态字形**：`StepStatus::Completed => ("✔ ", Style::default().crossed_out().dim())`；`InProgress => ("□ ", fg(accent).bold())`；`Pending => ("□ ", dim())`。即**完成＝打钩 ✔ 且加删除线 + 置灰**；进行中＝强调色 □；等待＝暗 □。排序 InProgress(0)→Pending(1)→Completed(2)，进行中置顶。 | 同上 `plans.rs:290-292/329-331` `render_step` + `compact_hyperlink_lines`，两处一致。`StepStatus{Pending,InProgress,Completed}` 定义见 [plan_tool.rs](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/plan_tool.rs)。**一手源码，非推测** |

**裁决**：学 WorkBuddy 的「阶段说明＝动态一句叙事 + 结果摘要 + 可展开中间步骤 + 临时完成即消失」；
学 Codex 的「结构化 plan 作为单一 item、推理摘要与正文分流、**默认折叠摘要行带计数、完成项打钩 + 删除线**」。
**不学**上一版的「三阶段并列 + 序号 + UI 拼小结 + 清单钉底」——那四条正是用户否定的东西。

### 2.1 流式光标 `▊` 的身份核验（用户要求"结合生产重放调研清楚"）

**代码层（基线 004ffa2d，逐行）**：全仓 `▊` 仅两处渲染，均绑定 part 的瞬时流式状态：
- `AgentTurnTimeline.vue:502`（thinking 折叠块内）：`<span v-if="part.status === 'running'" class="animate-pulse">▊</span>`
- `AgentTurnTimeline.vue:511`（正文 `<p>` 内）：`<span v-if="isStreamingCursor(part)" class="animate-pulse">▊</span>`，
  而 `isStreamingCursor`（`:358-363`）要求 `props.streaming === true && part.kind === 'text' && part.status === 'streaming'`。

两处都随对应 part 的 `running/streaming → done` 状态生灭，**不是独立的 agent 状态位**；
composer 区、轮首状态行均无 `▊`。同款 `animate-pulse` 小圆点也用于 thinking/tool 的 running 指示（`summary`/工具行），
语义一致＝"这块正在产出"。

**生产重放实证**（2026-11-22，账号 17279698608，生产会话 `cmwrnm9ch0b2fo901p15oscif`，
探针 `.workbuddy/e2e-cdp/cursor-replay-probe.mjs`，250ms 密采样；探针/结果不入库）：
- **历史轮（已收口）**：该会话 assistant 轮 `parts=114`，DOM 中 `span.animate-pulse` 含 `▊` 的节点数
  **=0**，composer 区 `▊=0` ⇒ 收口后光标确实消失，历史干净。
- **流式期（同会话此前真实发送，`rhino-result4.json`）**：`t=254ms` 采样到 `kinds=['thinking:running',
  'text:streaming']`（正是 `▊` 的两处绑定条件），`t=1796ms` 变为 `['thinking:done','text:done',
  'tool:done','tool:failed']`，收口后 `finalStrip=0 / finalGrey=null` ⇒ 光标随 part 从 running/streaming
  转 done 而生灭，不是独立状态位。
- **诚实边界**：本轮重放的新消息因 headless 下 `mention-input` 拦截焦点（CDP `DOM.focus` 后
  `activeElement` 仍为 BODY）＋ agnes 429 外部限流，未能自然抓到新一轮的流式 `▊` 活跃帧；
  流式期结论由上一条历史真实发送的 SSE 采样 + 代码绑定共同支撑，不谎称本轮抓到。

**结论**：`▊` 保留，定位为 thinking/text 的**流式打字指示**（行业惯例），≠ agent 状态位；
agent 唯一当前态按拍板落在轮首叙事行。

## 3. 代码现状事实（基线 004ffa2d，逐行核对）

### 3.1 旧方案（本规格要拆掉）

| 文件 | 旧实现 | 处置 |
|---|---|---|
| `turnPhaseView.ts` + `.test.ts` | `deriveTurnPhaseView()` 产出三阶段 + UI 拼装小结 + `isTurnFinalized()` | **删除文件**；把 `isTurnFinalized()` 迁入新 `turnChecklistView.ts`（纯函数，语义不变） |
| `AgentTurnTimeline.vue:63-67,375-388,462-480,1553-1579` | `taskProgress` prop、`phaseView`/`stripVisible`、`turn-phase-strip` 三行模板与样式、`PHASE_INDEX_LABELS` | **删除** prop / computed / 模板 / 样式 / 序号常量；新增轮首当前态行 + 流内折叠 checklist |
| `AgentSideRail.vue:3837-3842` | composer 上方 `AgentTaskProgressCard`（`showTaskCardAtComposer` 门） | **删除渲染**；`showTaskCardAtComposer` 一并有死则删，无死保留但不得挂 composer |
| `AgentSideRail.vue:3569` 附近 | `:task-progress="isLiveTurnMessage(msg) ? taskProgress : undefined"` 一行接线 | **保留**（checklist 仍从这条线上行），仅把消费方从三阶段 strip 改为 checklist |
| `AgentSideRail.vue:3976-3982` | composer 上沿灰字 `turn-live-status` | **删除渲染**（用户拍板当前态＝A"仅在对话流内"，composer 不是当前态落点）；`activityLine.turnLiveStatus` 函数保留给轮首行调用。守卫 `AgentSideRail.turnLiveStatus.test.ts` 改测"灰字不渲染、轮首行渲染" |

### 3.2 可复用（本规格要接线，勿重建）

| 能力 | 位置 | 说明 |
|---|---|---|
| 唯一当前态文本 | `activityLine.ts:41-65` | 6 态全谱、尾扫 parts、纯函数；轮首行直接调用 |
| 任务进度 | `agentTaskProgress.ts` + `AgentSideRail.vue:534` `taskProgress` ref | SSE `task_list/task_update` 已驱动；checklist 直接读 `items` |
| 折叠契约 | `useDisclosure.ts:45-75` | 防 patch 弹回；checklist 默认值 `() => false`（折叠），用户点过由意图主导 |
| 推理摘要 | `turnTimeline.ts:559/565` → `ThinkingPart.text`；`AgentTurnTimeline.vue:486-502` | 已展示，不新增 |
| 工具结果 | `turnTimeline.ts:711/715` → `tool.resultSummary`；`AgentTurnTimeline.vue:540-552` | 已展示，不新增 |
| 收口持久摘要 | `turnTimeline.ts:1177-1189,1240-1261` `notice:turn-summary`（已生成 N 张 · 用时 · 结算） | 唯一持久小结，不动 |
| 出错重试 | `AgentTurnTimeline.vue` notice error 分支 + `retryTurn` emit | 不动 |

### 3.3 守卫与红线

- `AgentSideRail.mobileLivePin.test.ts:30-46`：禁止复活 `turnStatusLine`/`statusTicker`/`settledDismissed`/
  `describeActivityFromTimeline` import；**要求 `turnLiveStatus` 仍存在**。
- 同文件 `:48-74`：禁止 live 钉底/镜像双轨复生，要求 `v-if="useTimeline(msg)"` 内联通道存在。
- `AgentTurnTimeline.vue:5-7` 头注释：折叠粒度＝单个 part、**无「执行过程」总折叠块**。
  ⚠️ 本规格的 checklist 是**任务清单**（结构化 todo 投影），不是「执行过程总折叠块」，不得把 thinking/tool
  塞进去；规格与实现注释必须写清这个边界，防守卫误伤。
- `AGENTS.md:67-86`：每份 spec/plan 必带第一原则声明与等价物检索结论表。
- CI 棘轮按裸计数匹配整文件含注释：注释里禁写受看守 token 字面量（如 `①` / `探索中` 如被看守）。

## 4. 目标 / 非目标

### 目标

- **G1**：活跃轮 SSE 对话**开始处**（用户气泡之后、parts 之前）有且仅有 1 条当前态叙事行，
  文本取自 `turnLiveStatus(parts)`；无三阶段并列、无序号、无 UI 拼小结。
- **G2**：任务清单以 Codex 式**流内折叠 checklist** 呈现（摘要行「任务 a/b · 展开」，展开见逐项状态），
  不再钉 composer 底部；数据源＝既有 `taskProgress.items`。形态对齐 Codex TUI 一手源码：
  **默认折叠**（`useDisclosure(() => false)`，摘要行带 `a/b` 计数）；展开逐项按
  InProgress→Pending→Completed 排序（进行中置顶）；完成态＝**打钩 ✓ + 删除线 + 置灰**、
  进行中＝强调色、等待＝暗色；不新增删除线以外的语义（不打「×」、不做动画）。
- **G3**：推理小结归 thinking 块、工具结果归 tool 展开、下一步归正文、出错归 error notice 重试入口；
  轮首区不再拼装任何小结。
- **G4**：回合收口后**当前态叙事行消失**（临时进度完成即消失），**checklist 折叠保留为任务凭据**
  （Codex plan checklist 范式，与 UI 对比图 B 一致）；轮末 `notice:turn-summary` 承载结果总览。
- **G5**：移动端 / PC 同组件同形态（AGENTS.md:38-65，不在 PC 组件加移动分支）。
- **G6**：零新增数据字段 / SSE 事件 / DB migration / part kind / 令牌；仅 web-only 部署面。

### 非目标

- 不改 composer 上沿积分条（用户未授权改它）。灰字 `turn-live-status` 的渲染按拍板 A 删除，但其派生函数 `turnLiveStatus()` 保留（轮首行单源）。
- 不改 `task_*` 事件语义、`AgentTaskProgressState` 类型、`turnTimeline.ts` 的 part 派生逻辑。
- 不复活 `turnStatusLine` / `statusTicker` / 钉底镜像 / 秒表 ticker。
- 不新增「执行过程」总折叠块；中间步骤仍按 part 级折叠，thinking/tool 不进 checklist。
- 不做模型自报阶段名、prompt 派生小结、估算数字、`0/0` / `XXXXXX` 占位。
- 不改服务端 / pi-runtime / prompt-registry / DB；不做生产回滚（旧代码由本刀替换）。

## 5. 架构决策

- **AD1 单一当前态**：轮首行是 `turnLiveStatus(parts)` 在对话流内的渲染落点（composer 灰字渲染已删）。
  它不是第三套状态词表，而是既有单源的投影；因此天然只有一条、天然叙事式。
- **AD2 清单与叙事正交**：checklist 只投影 `taskProgress.items`（结构化），叙事只由各 part 原位承担。
  两者互不读取对方文案 → 结构上杜绝用户第 4/5 点的"重复叙事 / 职责混淆"。
- **AD3 checklist 收口折叠留凭据**：按 UI 对比图 B 的形态，checklist **不随 streaming 收口消失**——
  它是会话级 `taskProgress` 的投影，只要该轮仍有任务项就继续以**折叠行**留在对话流末尾，
  用户可展开回看「做到哪一步」；这与「临时进度完成即消失」不矛盾：消失的是**当前态叙事行**
  （一次性状态），保留的是**结构化任务凭据**（Codex plan checklist 范式）。
  **数据面零改动**：`taskProgress` 本就是会话级 ref（`AgentSideRail.vue:534`），收口不清空
  （旧规格 §注：回合收束时 items 仍在）；渲染归属仍走既有 `isLiveTurnMessage(msg)` 门，
  只挂最近一轮，不新建 part、不写库。历史刷新后若 `taskProgress` 重新派生（SSE replay），
  折叠行按派生结果自然恢复或消失，无额外持久化承诺。
- **AD4 折叠默认值**：`useDisclosure(() => false)` 默认折叠（用户视角"清单不抢戏"），用户点开后
  意图优先；同一 `msg.id` 生命周期内复用同一 disclosure 实例（照 thinking 的 `shallowReactive(Map)` 契约）。
- **AD5 收口门禁只管当前态**：`isTurnFinalized(parts)` 从旧模块迁入 `turnChecklistView.ts`，判据仍是
  `notice:turn-summary` 稳定 id；`streaming === false` 亦不渲染**当前态行**。
  checklist 不受此门禁（见 AD3），收口后折叠留存。
- **AD6 不碰正文光标**：`▊` 保留为 thinking/text 的流式指示（行业惯例），只在活跃流尾部出现；
  规格与代码注释明确它≠agent 状态位，轮首状态行才是状态位。

## 6. 数据契约（纯函数，渲染期）

### 6.1 新文件 `turnChecklistView.ts`（唯一新增派生模块）

```ts
import type { TimelinePart } from './turnTimeline'
import type { AgentTaskProgressState } from './agentTaskProgress'

export interface TurnChecklistItem {
  id: string
  title: string
  statusLabel: string      // 仅取 AgentTaskProgressCard.statusLabel 同一映射
  activeForm?: string
  nodeId?: string
  errorHint?: string
  done: boolean            // 仅 done/skipped 为真，供「任务 a/b」计数
}

export interface TurnChecklistView {
  items: TurnChecklistItem[]
  doneCount: number
  total: number
}

/** 收口判定：从旧 turnPhaseView.ts 迁入，判据不变（notice:turn-summary）。 */
export function isTurnFinalized(parts: TimelinePart[]): boolean

/**
 * 纯投影：taskProgress.items → checklist；无任务（items 空 / progress null）⇒ null。
 * 禁 Date.now / setInterval / 造数；statusLabel 必须与 AgentTaskProgressCard 同源。
 */
export function deriveTurnChecklistView(
  progress: AgentTaskProgressState | null | undefined,
): TurnChecklistView | null
```

### 6.2 派生规则

| 编号 | 规则 |
|---|---|
| R1 | `items` 逐项映射：id/title/activeForm/nodeId/errorHint 原样取自 `AgentTaskProgressState.items`，不做截断/改写/补零 |
| R2 | `statusLabel` 取自与 `AgentTaskProgressCard.vue:15-23` **同一份映射**（迁移成共享常量或逐字一致的纯函数），禁第二套词表 |
| R3 | `done = status === 'done' || status === 'skipped'`；`doneCount` 为 done 项数，`total` 为 items.length；`0/0` 时整行不渲染（返回 null） |
| R4 | `isTurnFinalized(parts)` 与旧实现逐字一致：`parts.some(p => p.kind === 'notice' && p.id === 'notice:turn-summary')` |
| R5 | 模块不得 import `Date.now` / `setInterval` / `turnStatusLine` / `phaseForToolName`（清单不依赖阶段分类） |
| R6 | 轮首当前态不新增派生函数：直接 `turnLiveStatus(props.parts)`；空 parts 时返回「等待模型响应」，仍渲染 1 行 |

### 6.3 行为示例

```
parts = [thinking(running)]，taskProgress.items = [编写脚本 running, 生成分镜 done, 导出 pending]

轮首当前态：● 深度思考中
流内清单（折叠）：任务 1/3 · 展开 ▾
  展开：进行中 · 正在编写脚本；完成 · 生成分镜；等待中 · 导出
thinking 折叠块：思考完成，正在按 skill 指引……（来自 data.summary，原位）
composer 上沿灰字：不渲染（拍板 A，已删）

收口后：轮首当前态行消失；清单折叠保留「任务 2/3 · 展开 ▾」作凭据；
历史另留 plan part 步骤 + 「已生成 3 张 · 用时 47s · 已结算…」notice
```

## 7. UI 规范

### 7.1 落点与结构

- `AgentTurnTimeline.vue` 根节点内：
  1. `<div v-if="currentStateVisible" data-testid="turn-current-state">`（轮首当前态）
  2. `<details v-if="checklistVisible" data-testid="turn-task-checklist">`（流内折叠清单）
  3. `<template v-for="part in parts">`（既有 part 渲染，顺序与内容不变）
- 不 Teleport、不进 composer 系统层、不钉底、不进 `agent-turn-head`。随 Turn 滚动。
- checklist 的 `<summary>`＝`任务 {{doneCount}}/{{total}} · 展开/收起`（对齐 Codex
  `Updated Plan · {n}/{total} complete`）；展开区逐项按 InProgress→Pending→Completed 排序，
  每项 `[状态字形] title（activeForm 优先显示）`——完成＝`✓` + `line-through` + muted，
  进行中＝accent 色 `□`，等待＝暗 `□`；`errorHint` 次行，`nodeId` 复用 `CanvasLocatePinIcon`
  定位入口。状态字形与删除线单源在 `turnChecklistView.ts` 的 `checklistItemView()`，不为 CSS 造第二套。

### 7.2 文案格式

- 当前态行：`● {{ turnLiveStatus(parts) }}`，`●` 是 `animate-pulse` 小圆点（既有 thinking running 脉冲同款），
  文本后无冒号、无占位、无序号。
- 清单摘要：`任务 {{doneCount}}/{{total}} · {{ open ? '收起' : '展开' }}`。
- 分隔符沿用 `·`；禁用「探索中/创作中/收尾中」「①②③」「小结：」「XXXXXX」「0/0」。
- 无任务时 checklist 整块不渲染（R3），不留空壳。

### 7.3 样式与可访问性

- 令牌白名单：`--lnk-accent-subtle` / `--lnk-accent-text`（当前态）、`--lnk-text-secondary` /
  `--lnk-text-muted`（清单次级）、`--lnk-border-default`、`--lnk-surface-raised`。
  ⛔ 不用 `--lnk-hi-bg/hi-text` 表状态；不新增 `--neo-*` / hex / `rgba(`。
- 当前态标签 `aria-live="polite"`，只对这一行播报；checklist `<summary>` 原生可键盘操作。
- 移动端 / PC 同构；不新增 `isMobileLayout` 分支。

## 8. 生命周期时序

| 时点 | streaming | notice:turn-summary | 轮首当前态 | 流内 checklist | composer 灰字 |
|---|---|---|---|---|---|
| 发消息、零 parts | true | 无 | ● 等待模型响应 | 无任务⇒不渲染 | 不渲染（已删） |
| 首个 thinking | true | 无 | ● 深度思考中 | 有任务⇒任务 0/n（折叠） | 不渲染（已删） |
| 工具运行 / 任务更新 | true | 无 | ● 正在〈工具人话〉 | 任务 a/n（折叠，可展开） | 不渲染（已删） |
| 等待确认 | true | 无 | ● 等待你确认 | 清单停在当前计数 | 不渲染（已删） |
| 收口 | false | 有 | **消失** | **折叠保留为凭据**（可展开回看） | 不渲染（已删） |
| 刷新历史 | false | 有 | 不渲染 | 按 replay 派生结果恢复/消失 | 不渲染（已删） |
| 上滑回看上一轮 | false | 有 | 历史轮不渲染；活跃轮仍在自己 Turn 内 | 最近一轮的折叠凭据可见 | 不渲染（已删） |

## 9. 变更影响面矩阵

| 文件 | 改动 | 风险 |
|---|---|---|
| `apps/web/src/components/agent/turnPhaseView.ts`（删） + `.test.ts`（删） | 文件删除；`isTurnFinalized` 迁入新模块 | 中；须确认仅 `AgentTurnTimeline` 消费（旧接线全部移除） |
| `apps/web/src/components/agent/turnChecklistView.ts`（新） + `.test.ts`（新） | 纯派生 + 收口判定 | 低；纯函数 TDD |
| `apps/web/src/components/agent/phaseAggregator.ts` | **零改动**（`phaseForToolName` 保留） | 无 |
| `apps/web/src/components/agent/AgentTurnTimeline.vue` | 删三阶段 strip；加轮首当前态行 + checklist；`taskProgress` prop 保留 | 中；不得碰 part 渲染顺序/折叠契约 |
| `apps/web/src/components/agent/AgentSideRail.vue` | 删 composer 卡片渲染（`:3837-3842`）与灰字渲染（`:3976-3982`）；保留 `:task-progress` 接线与 `turnLiveStatus()` 函数 | 低 |
| `apps/web/src/components/agent/turnTimeline.ts` | **零改动** | 不新增 part / notice |
| 服务端 / pi-runtime / prompt-registry / DB | **零改动** | 仅 web-only 部署触发面 |

## 10. 测试策略与验收判据（DoD）

### 10.1 单测（TDD，先红后绿）

1. `turnChecklistView.test.ts`：`items` 空 / null → null；状态词与 `AgentTaskProgressCard` 逐字一致；
   done 计数（done+skipped 计入，running/failed/needs_user 不计）；`errorHint`/`nodeId` 原样保留；
   `isTurnFinalized` 仅认稳定 id；模块不含 `Date.now`/`setInterval`/`phaseForToolName` import（fs-scan）。
2. `AgentTurnTimeline.turnState.test.ts`（mount，仿 `AgentTurnTimeline.plan.test.ts`）：
   活跃轮恰好 1 条 `turn-current-state` 且文本＝`turnLiveStatus(parts)`；`streaming=false` 或
   `notice:turn-summary` 后 0 条；三阶段词 / ①②③ / 「小结：」在根内 0 次；含 summary 的 thinking 与
   含 resultSummary 的 tool 仍在原位；`turn-task-checklist` 默认折叠、展开后出现逐项状态；空任务 0 块。
3. `AgentSideRail.turnChecklistWiring.test.ts`：最新活跃轮拿到 `taskProgress`、历史轮拿不到；
   composer 区 `AgentTaskProgressCard` 0 次、`turn-live-status` 渲染 0 次（守卫的 `turnLiveStatus()` 函数要求仍成立）。
4. 反向守卫（追加到 `AgentSideRail.mobileLivePin.test.ts`）：禁复活 `turnPhaseView` import、
   `turn-phase-strip` testid、`PHASE_INDEX_LABELS`、composer 任务卡；保留 `turnLiveStatus` 要求。
5. `src/styles/design-token.test.ts`：无新增 `--neo-*`；棘轮计数不因注释上升。

### 10.2 生产 CDP 走查（部署后）

- 用测试账号 `17279698608` 输入「请帮我生成一个关于小犀牛的皮克斯动画漫剧」。
- **250ms 密采样**（上游超时可低至 ~1.75s，1s 间隔会全漏）：抓轮首当前态文本变化序列。
- 判据：轮首最多 1 条状态、无三阶段词/序号/UI 拼小结；清单在流内且可展开；
  composer 上方无任务卡；收口后当前态与清单均消失、轮末 summary notice 仍在。
- 截图存 `.workbuddy/e2e-cdp/`，探针脚本同目录（不入库）。

### 10.3 完成定义

全部单测绿 + `vue-tsc -b` 绿 + CI 全绿 + squash 合并 + web-only 部署 + 生产 CDP 走查通过；
不宣告 `ALL_PASS`（历史轮未自然触发的项如实标注边界）。

## 11. 评审裁决记录（2026-11-22 用户已逐项拍板）

1. **当前态 A + 清单 B**：当前态仅对话流内 ⇒ composer 灰字**删除**；清单 Codex 折叠 ⇒
   收口后**折叠留凭据**、不随 streaming 消失。✅ 用户确认。
2. **`▊` 光标**：条件保留——"如果确实是流式指示就保留，请结合生产重放调研清楚"。
   代码层证据：`AgentTurnTimeline.vue:502` 绑 `part.status === 'running'`（thinking）、
   `:511` 绑 `isStreamingCursor(part)`（要求 `props.streaming && kind==='text' && status==='streaming'`），
   两处都随 part 流式状态生灭，非独立状态位。生产重放证据见 §2.1（250ms 密采样 + DOM/pinia
   对应 + 收口归零）。结论：**保留，定位为流式打字指示，≠agent 状态位**。
3. **checklist 默认折叠 + 完成态**：行业最佳实践＝Codex TUI 一手源码：默认折叠、摘要行带
   `n/total complete` 计数、完成项**打钩 ✔ 且加删除线**（`crossed_out().dim()`）。
   本规格据此定：默认折叠 + `a/b` 计数；完成＝✓ + 删除线 + muted；进行中 accent、等待暗色；
   进行中排序置顶。✅ 用户认可此调研方向。
4. **历史刷新**：checklist 按 replay 派生的 `taskProgress` 自然恢复/消失，不做额外持久化。✅ 用户同意。
5. **执行模式**：Native（强顺序耦合单文件簇，SDD 并行收益低）。✅ 用户同意。
