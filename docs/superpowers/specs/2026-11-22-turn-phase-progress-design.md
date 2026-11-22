> ⛔ SUPERSEDED（2026-11-22）：用户生产复测否定三阶段并列 / ①②③ 序号 / UI 拼装小结 / 钉底任务卡。
> 本方案由 `2026-11-22-turn-inline-status-checklist-design.md` 取代，保留本文仅供决策轨迹追溯。

# 一轮 Turn 内「阶段性状态 + 阶段小结」设计规格（临时进度 / 完成即消失）

> 状态：🟢 living（2026-11-22 用户已拍板边界，待评审实现）
> 基线：`origin/master @ 2b98f446`
> 实施计划：[`../plans/2026-11-22-turn-phase-progress.md`](../plans/2026-11-22-turn-phase-progress.md)
>
> 用户拍板（2026-11-22）：阶段小结借鉴 WorkBuddy 的「**临时进度 + 完成时收口**」——
> 只在 Turn 活跃期显示；回合收口即从对话流消失，**不写进 `parts`、不进历史消息**。
> 历史轮只保留既有的轮末 `notice:turn-summary` 作为唯一持久总结。

## 0. 第一原则与等价物检索结论（强制）

第一原则：**吃满上游、不重复造轮子**。任何新增判据/工具/字段/引擎前过三判据
（① 等价物检索 ② 接线优先于新建，锚已有结构化数据面 ③ 禁造数/禁自报）。

| 需求 | 已存在的等价物（file:line） | 结论 |
|---|---|---|
| 阶段命名（探索/创作/收尾） | `phaseAggregator.ts:4-43`：`AgentPhase` 三态 + `WRITE_TOOLS` + `derivePhase()` + `PHASE_BADGE` | **接线复用**：把 `phaseForToolName()` 从既有分类逻辑中析出，不改枚举、不造第四态 |
| 原子状态（思考/工具/生成/等待） | `activityLine.ts:41-65` `turnLiveStatus()` 全谱；`AgentTurnTimeline.vue:444-461/494-523/546-642/651-789/796-810` 各 part 自带 status | **复用，不新增第二套状态词表**；composer 灰字保持原样 |
| 等待态判定 | `turnStatusBar.ts:118-125` `resolveWaitingFromTimeline()`（纯函数，时间线单一真相） | **接线复用**；只取函数，不复活 `turnStatusLine` UI（守卫见 `AgentSideRail.mobileLivePin.test.ts:30-46`） |
| 任务进度 / 阶段说明 | `agentTaskProgress.ts:10-37` `AgentTaskProgressState`（含 `activeForm`）、`:102-113` `formatTaskProgressLine()`；`AgentSideRail.vue:540-549,3904-3909` 已有任务卡 | **重新锚定**：作为 prop 传入 timeline 内阶段视图，不新建数据源、不改 `task_*` 事件 |
| 方案骨架 / 有序步骤 | `turnTimeline.ts:170-179` `plan` part（steps + `activeForm`）；`AgentTurnTimeline.vue:817-833` 已有有序渲染 | **复用**：把 plan steps 当作阶段骨架的可读细节，不另造 step 模型 |
| 阶段耗时 | `turnTimeline.ts:49-56` thinking `startedAt/endedAt`、`:67-75` tool `ms`；`executionStepLabels.ts:77-83` `formatDuration()` | **只用真实字段**；缺字段则整段省略，禁止 `now` 计时与秒表 ticker |
| 阶段小结文案 | `presentToolStep()`（`toolPresentation.ts:107-135`）、`formatTaskProgressLine()`、`:1183-1189` 稳定 id `notice:turn-summary` | **渲染期派生**，不新增 part kind / status / SSE 事件 / DB 列 |
| 收口信号 | `AgentSideRail.vue:3629-3645` 已有 `:streaming` prop；`turnTimeline.ts:1183-1189` `notice:turn-summary` 稳定 id | **双条件复用**；不新增 `turn.phase` / `phase_done` 事件 |
| Codex 的 plan_delta / OSC 带外状态 | 本项目无终端集成面，`parts` 已是单一真相 | **不适用**，禁止照搬 |

三判据核对：① 等价物逐项检索（见上表，全部命中既有资产）；② 接线优先——本次只析出
`phaseForToolName()` 一个纯函数、新增一个渲染期派生视图与一个 prop，**零新增数据字段、
零 SSE 事件、零 DB migration**；③ 禁造数——阶段名只能来自 `PHASE_BADGE`，小结只能来自
真实 `parts` / `taskProgress` 计数与时间戳，禁止 prompt 派生、模型自报、补零占位（`0/0`、`XXXXXX`）。

## 1. 背景与用户边界

用户连续两轮澄清后的边界：

1. **不是**把会话级灰字（composer 上沿「生成回复中」）整条搬到对话开头。
   该灰字已存在（`AgentSideRail.vue:4043-4049`），且 2026-10-31 的「状态行整条退役」事故
   （`AgentSideRail.mobileLivePin.test.ts:1-18` 记载：上滑回看时 `followLatest=false`
   导致第 2 轮全盲）证明「搬走」会退回老坑。
2. **是**一轮 Turn 内部：复杂任务里模型多轮思考/输出，缺的是把原子 part 聚合成
   「**命名阶段 + 阶段小结**」的那一层。
3. 阶段小结必须是 **WorkBuddy 式临时进度**：活跃期可见、收口即消失、历史干净。

### 1.1 行业取证（一手优先，标注证据强度）

| 产品 | 一轮内部的阶段做法 | 证据 / 强度 |
|---|---|---|
| **WorkBuddy** | 文档原文：「执行中的阶段说明（如"正在分析数据"、"正在生成报告"）」+「已生成的结果摘要」+「可展开查看的中间步骤」，都在**对话区**同一处。MCP 加载段更明确：「加载中显示已连接数/服务总数，实时更新……全部完成后展示『所有 MCP 服务已就绪』；这段进度**只在加载阶段临时出现，加载完成后就会从对话流中消失，不作为历史消息保留**。」 | [任务对话](https://www.workbuddy.cn/docs/workbuddy/Conversation) 一手。**注意**：官方文档未描述 composer 上沿灰字，本项目「WorkBuddy 同款」注释属观测非文档 |
| **Codex** | 协议里阶段是一等公民：`plan_update`/`plan_delta`（带 `turn_id`/`item_id`）、`AgentReasoningSectionBreak`（原文注释：模型开始新的推理摘要小节，如一个带标题的新块）、`ReasoningContentDelta.summary_index`、`ItemStarted/ItemCompleted`（`started_at_ms`/`completed_at_ms`）、`TurnComplete`（`duration_ms`/`time_to_first_token_ms`）。**但 TUI 把 live reasoning summary 放在 status row，不放进正文** | [protocol.rs](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs) 一手；[v0.155.0 release](https://github.com/openai/codex/releases/tag/rust-v0.155.0) 原文「shows live reasoning summaries in the status row」一手 |
| **Cursor** | 最接近用户设想：对话流里串起 `Thought 3s → Read 3 files, 1 search 1s → Planned 2s → Worked for 14m 22s` 的带耗时胶囊。但论坛里「按状态给 chat pane 常驻提示」的诉求，官方只回「solid idea」、无 ETA | 官网演示一手；[官方论坛](https://forum.cursor.com/t/color-the-agent-chat-background-by-status-running-needs-input-done/168083/5) 一手（**未落地**） |
| **Claude Agent SDK** | 工具态 `[Using Read...]` 直接 inline 打印在流中，思考态先显示再转正文 | SDK streaming-output 文档镜像（准一手）；「相位行置流式区上方 + aria-live 仅切换时播报」为第三方总结，未采信为规范 |

**裁决**：学 WorkBuddy 的「inline 阶段说明 + 结果摘要 + 完成即消失」；学 Codex 的
「结构化 plan 骨架 + 真实时间戳」；**不学** Codex 把状态挪进独立 status row；
**不学** Cursor 的秒表 ticker（本项目 `statusTicker` 已被守卫删除）。

## 2. 代码现状事实（基线 2b98f446，逐行核对）

### 2.1 已有

| 能力 | 位置 | 说明 |
|---|---|---|
| 原子级状态 | `AgentTurnTimeline.vue:444-461`（thinking「思考中」+运行脉冲）、`:494-523`（tool 脉冲/✓/✗/⏹）、`:546-642`（artifact「生成中 X」）、`:651-789`（proposal「待确认」）、`:796-810`（question） | 每个 part 都有自己的 status，流式渲染完整 |
| 会话级当前态 | `activityLine.ts:41-65` + `AgentSideRail.vue:594-606,4043-4049` | 全谱 6 态、时间线单一真相、活跃期显隐，与内联卡同源 |
| 方案骨架 | `turnTimeline.ts:170-179` + `AgentTurnTimeline.vue:817-833` | `plan` part 有有序 steps 与 `activeForm`，是唯一带 `{{i+1}}` 的结构 |
| 任务进度 | `agentTaskProgress.ts:102-113` + `AgentTaskProgressCard.vue:25-30,48-53` + `AgentSideRail.vue:3904-3909` | 「已完成 a/b · 正在生成：{activeForm}」，但**落在 composer 上沿**，不在 timeline 内 |
| 阶段徽章 | `phaseAggregator.ts:4-43`（`derivePhase`/`PHASE_BADGE`）实际消费于 `AgentExecutionTrace.vue:132-134,151-154` | 经 `AgentSideRail.vue:3607` 的 `!useTimeline(msg)` 门禁 ⇒ **timeline 路径不可见** |
| 轮末总结 | `turnTimeline.ts:1149-1191`（`finalizeTurnTimeline`）、`:1183-1189`（稳定 id `notice:turn-summary`）、`:1240-1309`（`summarizeTimeline`：已生成 N 张 + 用时 + 结算） | 唯一持久总结，收口时追加，晚到回填可原地刷新（`:1201-1210`） |

### 2.2 缺失

| 缺口 | 证据 |
|---|---|
| 阶段命名不可见 | `phaseAggregator.ts` 只在 `!useTimeline` 分支被消费（`AgentSideRail.vue:3607` vs `:3630`） |
| 阶段小结缺失 | `step` / `phase_hint` 事件被降级成普通 notice（`turnTimeline.ts:1095-1112`），无小结语义；只有轮末一条总览（`:1183-1189`） |
| 阶段耗时/编号未聚合 | thinking `startedAt/endedAt`（`:49-56`）、tool `ms`（`:67-75`）存在但模板从不读；`plan` steps 有编号但不与执行阶段对齐 |
| 阶段级折叠不存在 | `AgentTurnTimeline.vue:5-7` 明确「折叠粒度 = 单个 part，无总折叠块」 |

### 2.3 守卫与红线

- `AgentSideRail.mobileLivePin.test.ts:30-46`：禁止复活 `turn-status-line`/`statusTicker`/
  `settledDismissed`/`turnStatusLine` import/`describeActivityFromTimeline`；**要求**
  `turnLiveStatus` 仍存在。
- 同文件 `:48-74`：禁止 live 钉底/镜像双轨复生，要求 `v-if="useTimeline(msg)"` 内联通道存在。
- `AgentTurnTimeline.vue:5-7`：不得新增「执行过程」总折叠块。
- `AGENTS.md:67-86`：每份 spec/plan 必须携带第一原则声明与等价物检索结论表。

## 3. 目标 / 非目标

### 目标

- **G1**：在活跃 Turn 的 `AgentTurnTimeline` 内，把原子 parts 聚合成 3 个命名阶段
  （探索中 / 创作中 / 收尾中），显示当前阶段与已完成阶段。
- **G2**：为已完成阶段给出**小结**（来自真实工具人话、产物计数、plan 步数、真实耗时），
  并随活跃阶段推进实时更新。
- **G3**：回合收口（流结束或 `notice:turn-summary` 到达）后阶段视图**整块消失**；
  历史轮 0 个阶段条，不写入 `parts`、不落库、不发新事件。
- **G4**：阶段视图与 composer 灰字共用同一份时间线真相；阶段名只来自既有 `PHASE_BADGE`，
  等待态只来自既有 `resolveWaitingFromTimeline`。
- **G5**：移动端 / PC 同组件同形态（遵守 `AGENTS.md:38-65`：不在 PC 组件新增移动端分支）。

### 非目标

- 不搬动 / 删除 / 改写 composer 上沿的 `turn-live-status` 灰字与积分条。
- 不新增 `TimelinePart` kind/status、`turn.phase` 字段、SSE 事件、DB 列或 migration。
- 不复活 `turnStatusLine` / `statusTicker` / 钉底镜像 / 秒表计时。
- 不新增总折叠块；中间步骤继续沿用 part 级折叠（`AgentTurnTimeline.vue:5-7`）。
- 不做模型自报阶段名、prompt 派生阶段、估算数字或 `0/0` / `XXXXXX` 占位。
- 不改 `task_*` 事件语义与 `AgentTaskProgressCard` 的 composer 呈现（双通道并存）。

## 4. 架构决策

- **AD1 渲染期派生视图**：阶段视图是 `parts → view` 的纯函数投影，不进 `parts`、不进
  `executionEvents`、不进 DB。刷新后历史轮自然无视图，符合「历史干净」。
- **AD2 分类复用 `derivePhase` 语义**：在 `phaseAggregator.ts` 中把既有分类抽成
  `phaseForToolName(toolName)`，`derivePhase()` 改为调用它；`turnPhaseView` 只读这个函数。
  阶段集合仍是 `AgentPhase` 三态，写工具集合仍是同一个 `WRITE_TOOLS`。
- **AD3 骨架优先级**：`taskProgress.items`（确定性 todo 域） > `plan.steps`（模型显式方案）
  > 纯 part 序列（兜底）。前两者只提供**可读细节**，阶段推进仍由工具序列决定。
- **AD4 小结只说真实事**：工具人话走 `presentToolStep()`，任务进度走
  `formatTaskProgressLine()`，耗时只在字段齐全时由 `formatDuration()` 生成；否则整段省略。
- **AD5 收口双门禁**：组件层 `props.streaming === true` **且** `!isTurnFinalized(parts)`
  （后者检测稳定 id `notice:turn-summary`）才渲染；任一不满足即整块不渲染。
- **AD6 双通道不重复播报**：composer 灰字回答「此刻 atom 在干嘛」；阶段条回答
  「这一轮走到哪个阶段、上一阶段留下了什么」。两者不使用同一句式，也不合并成一个组件。
- **AD7 只锚最新活跃轮**：`AgentSideRail.vue` 传 `:task-progress` 时以既有
  `isLiveTurnMessage(msg)`（`:555-558`）为门，避免把会话级 task 状态错误挂到历史轮。

## 5. 数据契约（纯函数，渲染期）

### 5.1 新增/导出的接口

```ts
// apps/web/src/components/agent/phaseAggregator.ts（仅新增导出，derivePhase 内部改为调用它）
export function phaseForToolName(toolName: string): AgentPhase | null

// apps/web/src/components/agent/turnPhaseView.ts（新文件）
export type TurnPhaseStageStatus = 'done' | 'running' | 'pending'

export interface TurnPhaseStage {
  id: AgentPhase                 // 'exploring' | 'creating' | 'wrapping'
  label: string                  // 只允许 PHASE_BADGE[id].label
  status: TurnPhaseStageStatus
  /** 已完成阶段的小结；无可信数据即 undefined，禁止占位符 */
  summary?: string
  /** 仅当该阶段所有耗时字段均为真实值时给出 */
  durationLabel?: string
  /** 仅活跃阶段给出，来自 taskProgress / plan step / 运行中工具人话 */
  detail?: string
}

export interface TurnPhaseView {
  stages: TurnPhaseStage[]       // 固定 3 项，顺序 exploring → creating → wrapping
  activeIndex: number            // 0|1|2
}

export function deriveTurnPhaseView(
  parts: TimelinePart[],
  taskProgress?: AgentTaskProgressState | null,
): TurnPhaseView | null

export function isTurnFinalized(parts: TimelinePart[]): boolean
```

### 5.2 派生规则

| 编号 | 规则 |
|---|---|
| R1 | 逐 part 顺序扫描；tool part 的 `phaseForToolName(p.toolName)` 非 null 时推进当前阶段（单调，不回退）。`cancel_generation` → `wrapping`；`WRITE_TOOLS` 或 `run_*` → `creating`；read/未知工具保持 `exploring`。 |
| R2 | 无工具但已有 thinking/text/artifact 时，当前阶段按 `exploring` 显示（**仅展示默认**，不改 `derivePhase` 的 null 语义）；`parts` 为空 ⇒ 返回 `null`（此时 composer 灰字负责「等待模型响应」）。 |
| R3 | 阶段 status：下标 < active = `done`；= active = `running`；> active = `pending`。等待态不改变阶段 status。 |
| R4 | 活跃阶段 detail 优先级：① `resolveWaitingFromTimeline(parts)` ⇒ `等待你确认（阶段暂不推进）`；② `taskProgress` 存在且 `!finished` ⇒ `formatTaskProgressLine(items)`；③ 末尾 `plan.steps` 中有 `activeForm` 的步骤 ⇒ `正在：{activeForm}`；④ 末尾 running tool ⇒ `正在：{presentToolStep(...).label}`；⑤ 无 ⇒ `undefined`（不渲染 detail 行）。 |
| R5 | 已完成阶段 summary（纯函数返回**不含前缀**的内容）：工具人话去重后取前 2 个 + 超出数量 `等 N 步`；artifact `done` 数 ⇒ `生成 N 张`；plan 存在 ⇒ `方案已提出（N 步）`；阶段内只有 thinking 段 ⇒ `思考完成`（thinking 是真实素材，非造数）；以上皆无 ⇒ `undefined`。UI 统一加前缀 `小结：` 与耗时后缀 `（…）`，无素材时不渲染该行。 |
| R6 | 已完成阶段 `durationLabel`：仅当该阶段全部 tool 都有 `ms` 且 thinking 都有 `startedAt/endedAt` 时，`formatDuration(tool.ms 总和 + thinking 时长和)`；字段缺失 ⇒ `undefined`。活跃/未开始阶段**永不出耗时**。 |
| R7 | `isTurnFinalized(parts)` = 存在 `kind==='notice' && id==='notice:turn-summary'`（复用 `turnTimeline.ts:1185` 稳定 id）。 |
| R8 | 纯函数不得 import `Date.now()` / `setInterval` / `turnStatusLine`；不得写 `parts`（只读输入）。 |

### 5.3 行为示例（真实数据，非造数）

```
parts = [thinking(running), tool(get_canvas_summary, done, ms=820),
         tool(upsert_prompt_node, running), plan(steps=[…])]
taskProgress.items = [{ title:'编写脚本', activeForm:'正在编写脚本', status:'running' }, …]

①「探索中」· 已完成 · 小结：感知画布（820ms）
②「创作中」· 进行中 · 正在编写脚本
③「收尾中」· 待开始

composer 灰字（不变）：正在写入提示词节点
```

回合收口后：上述 3 行整体消失，只留既有的
`已生成 2 张 · 用时 47s · 已结算 -N 积分（文本）` 持久摘要 notice。

## 6. UI 规范

### 6.1 位置与结构

- 落点：`AgentTurnTimeline.vue` 根节点内、`v-for="part in parts"` **之前**，新增
  `<div v-if="stripVisible" class="turn-phase-strip" data-testid="turn-phase-strip">`。
- 不新建页面级组件、不 Teleport、不进 composer 系统层、不进 `agent-turn-head`
  （那是每轮固定抬头，阶段条属于时间线内容）。
- 阶段条随 Turn 滚动：用户上滑回看时它跟着自己的 Turn 走；不新增任何钉底/镜像。

### 6.2 文案格式

- 阶段胶囊：`「{{stage.label}}」· {{statusLabel}}`，statusLabel = `已完成` / `进行中` / `待开始`。
- 活跃阶段可追加一行 detail：`· {{stage.detail}}`（有 detail 才渲染，无则不渲染分隔符）。
- 已完成阶段可追加一行：`小结：{{stage.summary}}`，耗时以 `（{{durationLabel}}）` 附在小结之后。
- 分隔符一律 `·`（沿用 `turnStatusBar.ts:59-64` 既有约定），不用 `:`——中文冒号会被误读为标题。
- 阶段编号用 ①②③ 前缀（与 `plan` part 的 `1..n` 区分：那是步骤序号，这是阶段序号）。
- 无任何真实小结/细节时，只渲染胶囊本身，**不输出占位符**。

### 6.3 样式与可访问性

- 令牌白名单：`--lnk-accent-subtle` / `--lnk-accent-text`（活跃阶段，主题稳定）、
  `--lnk-text-secondary` / `--lnk-text-muted`（已完成/待开始）、`--lnk-border-default`、
  `--lnk-surface-raised`。⛔ 不用 `--lnk-hi-bg/hi-text`（深主题黑底白字，禁用于状态）、
  不新增 `--neo-*` / hex / `rgba(`（现有 `AgentTaskProgressCard.vue:38` 的 `--neo-*` 是历史债，不复制）。
- 活跃阶段标签带 `aria-live="polite"`；只对标签播报，不对整条 strip 播报，避免流式刷屏。
- 运行脉冲沿用既有 `animate-pulse` 小圆点（`AgentTurnTimeline.vue:453-456` 同款）。
- 移动端与 PC 同构；不新增 `isMobileLayout` 分支（AGENTS.md 移动端规则 2）。

## 7. 生命周期时序

| 时点 | `streaming` | `notice:turn-summary` | 阶段条 | composer 灰字 |
|---|---|---|---|---|
| 发消息、零 parts | true | 无 | 不渲染（R2） | 等待模型响应 |
| 首个 thinking | true | 无 | `「探索中」· 进行中` | 深度思考中 |
| 读工具完成 | true | 无 | 探索中 ✓ + 小结（真实工具人话/耗时） | 正在感知画布 |
| 写工具运行 | true | 无 | 探索中 ✓ / 创作中 · 进行中 + task detail | 正在写入提示词节点 |
| 等待确认 | true（挂起时由 `mainTurnSuspended` 对齐） | 无 | 阶段停在创作中，detail=等待你确认 | 等待你确认 |
| 收口 | false | 有 | **整块消失** | 消失（灰字同口径隐藏） |
| 刷新历史 | false | 有 | 不渲染 | 不渲染 |
| 上滑回看上一轮 | false | 有 | 历史轮不渲染；活跃轮（若有）仍在自己 Turn 内 | 活跃期灰字仍可见（防老坑） |

## 8. 变更影响面矩阵

| 文件 | 改动 | 风险 |
|---|---|---|
| `apps/web/src/components/agent/phaseAggregator.ts` | 析出 `phaseForToolName()`，`derivePhase()` 改调用 | 低；既有 `phaseAggregator.test.ts:5-44` 锁死语义 |
| `apps/web/src/components/agent/turnPhaseView.ts`（新） | 纯派生视图 | 中；所有数字必须可追溯到 parts/task 字段 |
| `apps/web/src/components/agent/AgentTurnTimeline.vue` | 新增 strip 模板 + `taskProgress` 可选 prop + 样式 | 中；不得影响既有 part 渲染顺序与折叠契约 |
| `apps/web/src/components/agent/AgentSideRail.vue` | 1 行 prop 接线（`:task-progress="isLiveTurnMessage(msg) ? taskProgress : undefined"`） | 低；不改灰字、积分条、任务卡 |
| `apps/web/src/components/agent/turnTimeline.ts` | **零改动** | 不新增 part / notice，收口语义保持 |
| 服务端 / pi-runtime / prompt-registry / DB | **零改动** | 无部署流水线额外触发面（仅 web-only） |

## 9. 测试策略与验收判据（DoD）

### 9.1 单测（TDD，先红后绿）

1. `turnPhaseView.test.ts`：`parts` 为空 → `null`；仅 thinking → exploring running 无小结；
   读工具 → 探索中推进；写工具 → 创作中推进且探索中变 done；`run_*` 与 `cancel_generation`
   与 `derivePhase` 分类一致；plan/task detail 优先级；等待态冻结阶段；耗时字段缺失不出数字；
   `notice:turn-summary` ⇒ `isTurnFinalized === true`。
2. `AgentTurnTimeline.phaseStrip.test.ts`（mount，仿 `AgentTurnTimeline.plan.test.ts:33-67`）：
   `streaming=true` 才有 strip；`streaming=false` / 历史轮 0 条；收口后 `notice:turn-summary`
   保留而 strip 消失；detail/summary 缺失时不出现 `0/0` 与占位符。
3. `AgentSideRail.phaseStripWiring.test.ts`：最新活跃轮拿到 `taskProgress`，历史轮拿不到；
   composer `turn-live-status` 文案与位置断言（`AgentSideRail.turnLiveStatus.test.ts:128-161`）
   保持原样通过。
4. 守卫扩展 `AgentSideRail.mobileLivePin.test.ts`：不得复活 `statusTicker` / `turnStatusLine` /
   钉底镜像；新增源码扫描断言 `turnPhaseView.ts` 无 `Date.now` / `setInterval`、
   `turnTimeline.ts` 无 `notice:phase-` 之类新稳定 id。
5. `design-token.test.ts` + `vue-tsc -b` 全绿（令牌与类型守卫）。

### 9.2 变异自检（判据必须能转 RED）

- 把 `stripVisible` 改成恒 `true` ⇒ 用例 2 的「历史轮 0 条」转 RED。
- 把 `durationLabel` 改成无字段时也输出 ⇒ 用例 1 的「字段缺失不出数字」转 RED。
- 把 detail 来源换成硬编码字符串 ⇒ 用例 3 的 task `activeForm` 断言转 RED。
- 把 `phaseForToolName` 的 `run_` 分支删掉 ⇒ 与 `derivePhase` 等价性断言转 RED。

### 9.3 生产 CDP 走查（上线后，一次性探针不入库）

用既有 headless CDP 模式（单会话、触摸仿真在同一会话内设置）跑五态：
发消息零 parts → 首 thinking → 读工具 → 写工具/任务进度 → 等待确认 → 收口。
判据：阶段条只出现在活跃 Turn；收口后 DOM 中 `turn-phase-strip` 计数为 0；
历史轮计数为 0；composer `turn-live-status` 在上滑回看期间仍可见且文案未变；
双主题下活跃阶段对比度可读。

## 10. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 与主服务/pi-runtime 的 SSE 事件时序不一致，阶段提前推进 | 阶段只由已落到 `parts` 的工具事件推进；只读重放同源，不预测未到达事件 |
| 出现「阶段说完成、原子 part 仍 running」的矛盾 | 阶段 status 只看阶段边界（下一个阶段出现才把前一个标 done），同阶段内原子状态以 part 为准 |
| `taskProgress` 是会话级单例，误挂到历史轮 | `isLiveTurnMessage(msg)` 门禁 + `streaming` 双门；测试锁死历史轮 prop 为 undefined |
| 阶段条变成第二套「播报式状态行」 | 不复活 ticker / 不写 notice / 不钉底；守卫扩展转 RED 即回滚 |
| web-only 部署未生效 | 判据=产物 chunk 含 `turn-phase-strip` 字符串；缺失则按 `deploy_web_only=true` 补派 |
| 需要回滚 | 纯前端、无 DB/事件/migration：revert 单个 squash commit → web-only 重部署即可，旧历史轮天然无残留 |

## 11. 变更记录

- 2026-11-22：用户拍板「阶段小结 = 临时进度 + 完成时消失（WorkBuddy 规则，历史干净）」，
  按此边界由讨论稿转正式规格；明确否决「把会话级灰字整条搬进对话开头」。
- 2026-11-22（开工前审核）：R5 补 thinking 素材项（`思考完成` 是真实素材非造数，与实现对齐）；
  接线契约逐行复核（`taskProgress` ref `:540` 永非 null、`isLiveTurnMessage` `:555-559`、
  `AgentTurnTimeline` 裸 `defineProps` `:38-60`、`useTimeline` = role+timeline 判定
  `agentMessageRender.ts:150-152`），评审结论与判据修正见 plan §8。
