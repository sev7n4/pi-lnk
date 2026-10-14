# 对话时间线重构：让执行过程像 WorkBuddy 一样显性化

> **状态**：待评审
> **日期**：2026-10-13
> **触发**：生产实测 — 一轮 8m38s 的回合里，思考只有一段（且被钉在顶部）、工具调用平铺成一堆、
> 最终总结与产物卡的位置由槽位而非时间决定，用户读到的顺序与真实发生顺序不一致。
> **读者**：产品、前端、Nest 适配层、pi-runtime
> **非范围**：runtime（`services/pi-runtime`）内部逻辑变更；上游 `vendor/earendil-works/pi` 打补丁。

---

## 0. 决策摘要

| 项 | 结论 |
| --- | --- |
| **问题定性** | 不是"渲染顺序写错了"，而是**消息模型缺一层**：上游的有序 content-block 时间线被压成「按类型聚合的两个容器」 |
| **根因层** | ① 模型缺口（block → string + steps[]）② 通道缺口（ts/seq 被丢弃）③ 渲染缺口（模板槽位顺序 ≠ 时间顺序）④ 语义缺口（中间文本被覆盖 + 关键词降维） |
| **主解** | 引入 `TurnTimeline`：一轮 = **有序 part 序列**（thinking / text / tool / canvas / artifact / notice），渲染 = `parts.map()`，折叠单位从"整个回合"下沉到"单个 part" |
| **不重复造轮子** | 正确的 block 模型**上游本来就有**（`AssistantMessage.content`），且**已经通过 SSE 到达前端**（`pi_message_end` 携带完整 `message.content[]`，当前只用了 `entryId`） |
| **分期** | P0 修时序可读性（无模型变更，1 天内可上）→ P1 时间线模型（flag 灰度）→ P2 产物原位 + live/history 统一渲染 |
| **验收** | golden：给定事件序列 → parts 顺序 = 事件顺序 → DOM 顺序 = parts 顺序；回归锁：思考块不得恒为首块 |

---

## 1. 现象拆解（用户口径 → 代码级根因）

| # | 用户看到的现象 | 代码级根因 | 证据 |
| --- | --- | --- | --- |
| 1 | 「思考感觉是一次思考」 | 整轮 thinking 被累积成**一个**字符串，且 reducer 用**固定 id + unshift** 把它钉到列表首位 | `pi-events.ts` `createThinkingAccumulator`（buffer 只累加、`thinking_end` 重发全文、delta 不透传）；`executionTraceReducer.ts` `applyThinking`（`id='thinking:parse'` + `steps.unshift`） |
| 2 | 「后面是调用一堆工具」 | 所有工具按到达顺序 `push` 进同一 `steps[]`，与思考/文本**没有时间关系**；中间轮次的叙述文本没有落点 | `applyToolCall` push；`stores/agent.ts` `beginToolCall/endToolCall` 全部写同一 trace |
| 3 | 「过程的产物在工具执行阶段有，最后也有，位置提前固定」 | 产物卡位置由模板槽位决定，与产物产生时刻无关；且 live/history 用两套数据源 | `AgentSideRail.vue:2837` `<AgentCanvasOutputs>` 固定槽位；`agentCanvasOutputs.ts` `resolveMessageOutputs` 的 `isLiveTurn` 分支 |
| 4 | 「总结摘要出现时间比产物晚，又出现在产物上面」 | 摘要行是 **trace 组件内部**的一部分，而 trace 被**刻意排在正文之前**（2026-10-07 决策） | `AgentExecutionTrace.vue:194-201`（摘要行）；`AgentSideRail.vue:2792-2803`（trace 在正文前，注释写明改动动机） |
| 5 | 「体验很奇怪（流式时一个样、结束后另一个样）」 | live 期间执行过程钉在 composer 上方（dense），回合结束后**搬进气泡**，同一份数据两种容器 | `AgentSideRail.vue:3062-3071`（liveTrace）vs `2795-2802`（历史 trace） |

---

## 2. 差距定位：范式不同，不是参数不同

| 维度 | WorkBuddy / Claude Code / Codex | pi-lnk 现状 |
| --- | --- | --- |
| 消息单位 | 一次 LLM 响应 = 一条消息 + **有序 content blocks** | 一轮 = 一条消息（`content: string`）+ 一个聚合 trace |
| 思考 | 每次思考是**独立块**，按时间出现，各自可折叠 | 整轮合并为**一个**块，且恒定置顶 |
| 工具 | 工具块**内联在时间线上**，紧随产生它的那条消息 | 全部平铺在一个折叠区，与文本/思考无位置关系 |
| 中间叙述 | 每段文本**保留原位** | 被 `text_replace` 覆盖，或经关键词匹配降维成一个阶段标签 |
| 产物 | 作为时间线上的一个块**原位出现** | 固定槽位（正文之后），与发生时刻无关 |
| 折叠粒度 | 单个块 / 单条工具 | 整个回合的「执行过程」 |
| 渲染来源 | 一套渲染路径（live = 更高的更新频率） | live 钉底容器 + 历史气泡容器，两条路径 |

**结论**：WorkBuddy 的体验不是"文案更友好"，而是**信息架构是时间线，而 pi-lnk 是分类槽位**。
文字层面的工作（人话化目录）pi-lnk 已经做完（`toolPresentation.ts` 全量覆盖 28 个工具），
缺的是**结构**。

---

## 3. 根因：四个缺口（含证据）

### G1 模型缺口：block 序列 → 两个"按类型聚合"的容器

上游 `AssistantMessage` 的定义本来就是有序块：

```ts
// vendor/earendil-works/pi/packages/ai/src/types.ts:428
export interface AssistantMessage {
  role: "assistant"
  content: (TextContent | ThinkingContent | ToolCall)[]   // ← 有序，就是时间线
  ...
}
```

而下游把它压成：

```ts
// apps/web/src/stores/agent.ts:35  AgentStreamMessage
{ content: string, executionTrace: { steps: ExecutionStep[] } }
```

`content` 丢失了"这是第几段文本"的边界；`steps[]` 丢失了"这一步发生在哪段思考之后"。
**块的顺序信息在这一步被销毁**，此后无论渲染层怎么排，都只能是"按类型摆槽位"。

### G2 通道缺口：`ts` / `seq` 在适配层被丢弃

上游事件自带时间与单调序：

```ts
// apps/server/src/agent/pi-runtime/pi-events.ts:15
export interface PiRuntimeEvent<T> { type; lane?; ts: number; seq?: number; data: T }
```

映射后只剩 `{ type, data }`（`UiEvent`，同文件 :47），`message_start` / `turn_start` /
`turn_end` 走 `default` 分支变成前端不消费的 `pi_*` 透传事件（:188-190）。
**⇒ 前端没有任何"全局单调序"可用**，只能依赖到达顺序；重连、多 lane、补偿投递都可能让顺序不可靠。
`applyThinking` 更极端：`startedAt` 用的是前端 `Date.now()`，连近似时间都没有。

### G3 渲染缺口：模板槽位的顺序被当成时间顺序

一轮 assistant 消息的 DOM 槽位顺序是硬编码的：

```
AgentExecutionTrace（步骤 + 回合摘要行） → 正文 <p> → 引用条 → AgentCanvasOutputs → Presentation → 操作行
```

（`AgentSideRail.vue:2795 / 2803 / 2837 / 2844`）

于是「回合摘要行」——一个**回合结束时才产生**的元素——永远出现在正文之上（现象 4）。
这不是 bug，是 2026-10-07 那次"先看过程再看总结"的调整留下的**结构性副作用**：调整搬的是
"整块 trace"，而不是"让每段过程落在它发生的位置"。

### G4 语义缺口：中间文本被覆盖 + 关键词降维

```ts
// apps/web/src/stores/agent.ts:270  replaceAssistantText
last.content = text            // 覆盖：上一段中间叙述消失
last.textReplaceHistory.push(text)   // 仅留档，**不参与渲染**
applyTextReplaceStage(trace, text)   // 降维成一个阶段标签
```

阶段标签是关键词启发式：

```ts
// apps/web/src/components/agent/executionStepLabels.ts:11-31
if (t.includes('我来生成') || t.includes('将为你创建')) return '理解需求'
if (t.includes('已在画布创建')) return '创建画布节点'
...
return '处理中'    // ← 兜底：用户截图里的「处理中 · 49ms」
```

再叠加 `applyStep` 的 `removeDuplicateTextStage` 去重，同一轮内多段叙述会被**吃掉**。
pi 链路下 `text_replace` 其实已无生产者（全仓只剩前端消费与历史白名单 `agent.service.ts:88`），
但**这套降维逻辑仍在**，且 `text_delta`(append) 与 `text_replace`(覆盖) 两种语义仍并存。

---

## 4. 目标模型：TurnTimeline

```ts
export type TimelinePart =
  | { kind: 'thinking'; id: string; text: string; status: 'running'|'done'; startedAt: number; endedAt?: number }
  | { kind: 'text';     id: string; text: string; status: 'streaming'|'done' }
  | { kind: 'tool';     id: string; toolName: string; args?: string; status: 'running'|'done'|'failed'
      resultSummary?: string; ms?: number; nodeRef?: string; isError?: boolean }
  | { kind: 'canvas';   id: string; label: string; nodeId?: string }
| { kind: 'artifact'; id: string; nodeId: string; nodeType: string; title: string
    status: 'pending'|'running'|'done'|'failed' }
  | { kind: 'notice';   id: string; text: string; tone: 'info'|'warn'|'error' }

export interface TurnTimeline {
  parts: TimelinePart[]        // 顺序 = 事件发生顺序，唯一真相
  turnStartedAt: number
  turnEndedAt?: number
  usage?: { inputTokens: number; outputTokens: number; cost?: number }
  seq?: number                 // 最后一次写入的服务端 seq（乱序探测用）
}
```

规则：

1. **顺序即时间**：`parts` 只按事件到达/`seq` 追加，不按类型分组、不置顶、不去重。
2. **渲染 = `parts.map()`**：没有"执行过程"总折叠块；折叠粒度 = 单个 part（工具/思考各自折叠）。
3. **产物是 part**：`node_status` / `canvas_action(add_node)` 变成 `artifact` / `canvas` part，
   在它**真正发生的位置**出现（现象 3 的解）。
4. **回合摘要**是末尾的 `notice` part，天然在最后（现象 4 的解）。
5. **live 与 history 同一渲染路径**，dense 只是密度变体（现象 5 的解）。

---

## 5. 落地方案

### P0 — 修时序可读性（不动模型，1 天内可上）

| # | 改动 | 文件 | 判据 |
| --- | --- | --- | --- |
| P0-1 | thinking **分段**：`thinking_end` 发完 summary 后 `buffer = ''`；事件加 `segmentId` + `startedAt/endedAt` | `pi-events.ts` `createThinkingAccumulator` | 一轮 3 段思考 ⇒ 3 个 `thinking` 事件，`segmentId` 递增 |
| P0-2 | thinking **不再置顶**：`applyThinking` 按 `segmentId` upsert 到列表**末尾**（保持时间序），删 `unshift` | `executionTraceReducer.ts` | 单测：思考在工具之后出现时，索引 > 该工具 |
| P0-3 | 事件**带 `seq`**：`UiEvent` 增 `seq?` 字段并从 `PiRuntimeEvent` 透传（mapPiEventToUiEvent + 两个 accumulator 统一经 `ui(type,data)` 辅助）；P0 保持 SSE 到达序渲染，`seq` 仅留待 P1 按序插入 | `pi-events.ts`（server） | server `pi-events.test.ts` 41/41 仍绿（seq 未携带时 `toEqual` 忽略 undefined，零回归） |

> ⚠️ **P0-3 实施偏差（已拍板）**：原 plan 写「`seq`/`ts` 两字段」。实际落地只透传 `seq`：
> `PiRuntimeEvent.ts` 为**必填**，既有 `mapPiEventToUiEvent` 测试用 `toEqual({type,data})` 精确比对、
> 且所有测试输入都带 `ts`，若无条件带 `ts` 会破坏既有断言；`ts` 在 P0 不消费（仍按到达序），
> 故递延到 P1 前端真正按序插入时再补，并同步更新 server 测试为 `toMatchObject`。`seq` 为可选字段、
> 未携带时恒 undefined，对既有测试无影响。 |
| P0-4 | 摘要行**移出** trace 组件，落成回合末尾的独立行 | `AgentExecutionTrace.vue` → `AgentSideRail.vue` | DOM：摘要行 index > 正文与产物卡 index |
| P0-5 | 回归锁：思考块不得恒为首块 | 新增测试 | 断言首块 `kind !== 'thinking'`（当首个事件是工具时） |

P0 是**可达 80% 观感收益**的一档：用户立刻能看到"多次思考 + 思考与工具交错"。

#### P0 实施记录（2026-10-13，分支 `feat/agent-turn-timeline-p0`）

| 项 | 落地 | 验证 |
| --- | --- | --- |
| P0-1/2 思考分段 + 取消置顶 | `executionTraceReducer.applyThinking` 重写：固定 id `thinking:parse`+`unshift` → 按 running 态追踪、新建段 `push` 到尾部；终态落到最近 running 思考段 | `executionTraceReducer.test.ts` 新增 4 例（多段交错/工具先到首步非 thinking/replay 多段/缺 start 兜底），**32/32 绿** |
| P0-4 摘要行移出 trace | `AgentExecutionTrace.vue` 删除内部 `summaryLine` computed+模板块；`AgentSideRail.vue` 新增 `bubbleSummaryLine(msg)` 并在 `AgentCanvasOutputs`（产物）之后渲染 `turn-summary-line` | 模板结构与类型复核通过；组件挂载类测试因本沙箱 vitest worker `fetch /@vite/env` 超时无法跑（环境限制，非回归） |
| P0-3 事件带 seq | `pi-events.ts`：`UiEvent` 增 `seq?`，`mapPiEventToUiEvent`+`createThinkingAccumulator`+`createUsageAccumulator` 经 `ui()` 辅助透传 `event.seq` | `pi-events.test.ts` **41/41 绿**（含 thinking 累加器断言，seq undefined 被 `toEqual` 忽略） |
| P0-5 回归锁 | 上述 4 例 reducer 测试即回归锁（首步非 thinking + unshift 不复活的行为断言）+ replay 一致性 | 已落 |

> ⚠️ **未自动化验证项**：`AgentExecutionTrace.scrollLock.test.ts` / `agentTraceSingleSource.test.ts` 等组件挂载测试在本工作环境 vitest 下因 worker `Timeout calling "fetch" with "[@vite/env","web"]"` 无法收集（jsdom pool 限制），与本次改动无关（失败形态为环境超时、非断言失败）。建议在你本地/CI 正常 vitest 环境回归一次这两个文件。

### P1 — 时间线模型（3-5 天，flag 灰度）

1. 新增 `apps/web/src/components/agent/turnTimeline.ts`：纯函数 reducer
   `applyEvent(timeline, event) → void`，与 `executionTraceReducer` 同形（可单测、可 replay）。
2. 双源接入：
   - **实时**：`pi_message_start` / `pi_message_end`（**已带完整 `message.content[]`**）划分块边界；
     `message_update` 的 `thinking_delta` / `text_delta` 落到**当前块**；
     `tool_execution_*` / `canvas_action` / `node_status` 追加对应 part。
   - **历史**：`metadata.executionEvents`（已是有序数组）直接 replay。
3. 新增 `AgentTurnTimeline.vue`：`v-for="part in parts"` + `component :is` 分发；
   复用现有 `AgentCanvasOutputs`（artifact）、`presentToolStep`（tool 文案）、
   `CanvasLocatePinIcon`（定位）、滚动锚定。
4. flag `TURN_TIMELINE_ENABLED`（缺省 off）；off 时走旧 trace，零行为变化。

> **关键取舍**：不为"保存每段文本"新增 runtime 逻辑。块边界上游已经给了
> （每段 assistant 响应各有 `message_start` / `message_end`），
> 中间叙述文本本来就在 `AssistantMessage.content` 的 `TextContent` 块里。
> 我们要做的是**别再丢它**，而不是**重新造它**。

#### P1 实施记录（2026-10-14，分支 `feat/agent-turn-timeline-p0`）

| 项 | 落地 | 验证 |
| --- | --- | --- |
| P1-1 模型 + reducer | 新增 `turnTimeline.ts`：`TurnTimeline`/`TimelinePart`（thinking/text/tool/canvas/artifact/notice，artifact.status=`pending\|running\|done\|failed`+errorText）；`applyTimelineEvent` 按到达序 push parts（不 unshift/不分组）；`replayTimelineEvents(events, bodyText?)`；`finalizeTurnTimeline` 收 running + 末尾摘要 notice。复用 `summarizeToolArgs`/`canvasActionLabel`/`formatDuration`（与 trace 同文案） | `turnTimeline.test.ts` 10 例（golden 交错/反例锁/思考分段/D1 update_node 不建 part/D2 failed errorText/finalize 摘要/live≡replay/历史 bodyText/文本续接/waiting resolved） |
| P1-2 渲染件 | 新增 `AgentTurnTimeline.vue`：`v-for parts` + `component :is` 等价分发；tool 复用 `presentToolStep`，artifact 复用 `DockTypeIcon`/`CanvasLocateButton`；failed artifact 内联「重试生成」按钮（D2）+ 错误文案；streaming 文本尾部 ▊ | 模板/类型经 vue-tsc 全量检查 |
| P1-3 flag | `useFeatureFlag.ts` 注册 `turn_timeline`（**默认 off**），`?feature=turn_timeline` 本地灰度 | off 时全链路短路 |
| P1-4 store 并行构建 | `agent.ts`：`feedTimeline(event)`（flag off 直接 return，零成本）在各 track 漏斗函数内并行喂事件；`appendText` 喂 `text_delta`；`finishStreaming` 调 `finalizeTurnTimeline`；`loadHistory` 在 flag on 时 `replayTimelineEvents(executionEvents, content)`；新增 `trackWaitingUser` | `executionTraceReducer.test.ts` 32/32 仍绿（P0 回归不破）；store 测试 10 collected 全过（3 文件因沙箱 worker `fetch /@vite/env` 超时无法收集，见下） |
| P1-5 SideRail 切流 | `AgentSideRail.vue`：`turnTimelineOn` computed + `useTimeline(msg)`；flag on 且 msg.timeline 有时渲染 `AgentTurnTimeline`，并**隐藏**旧 trace + 独立 body `<p>` + `AgentCanvasOutputs` + 独立摘要行（避免重复）；`@retry-node`→`emit('generateNode')`（复用既有节点生成 emit）、`@focus-node`→`onFocusNode`；live dense trace（composer 状态行，D3）仍读 executionTrace 保留 | 互斥条件经 vue-tsc 检查 |

> ⚠️ **环境限制（非回归，同 P0）**：本工作环境 vitest 对含组件/store 依赖的文件，worker 在收集期 `Timeout calling "fetch" with "[/@vite/env","ssr"]"`。表现为「EXIT=1 但 collected 用例 0 断言失败」——纯逻辑测试（`turnTimeline.test.ts`、`executionTraceReducer.test.ts`）用 `--pool=forks --environment node` 可完整跑绿；组件挂载/多文件 store 收集类建议在本地/CI 正常 vitest 回归。`AgentTurnTimeline.vue` 是新增 SFC，尚无挂载测试，建议补一条「golden 事件序 ⇒ `[data-part-kind]` DOM 序列」的 jsdom 用例（需正常 vitest 环境）。

> ⚠️ **live dense trace 暂未收敛**：P1 仅让气泡走 `AgentTurnTimeline`；composer 上方的 `liveTrace`（`AgentExecutionTrace` dense 变体，承载 D3「正在X」状态行）仍读 `executionTrace`。live/history 的 `parts` 已同源一致（验收 4），但「完全统一到一个组件」属 P2 范围。

### P2 — 产物原位 + 统一渲染（2-3 天）

1. `artifact` part 内联缩略图（复用 `AgentCanvasOutputs` 的 `resolveNodeUrl`）。
2. live / history 收敛到同一组件，dense 仅控制行密度与折叠默认值（现象 5）。
3. 落库：`metadata.executionEvents` 元素加 `seq`/`ts`/`messageIndex`；
   老消息无 `timeline` 时回退「重放 executionEvents → 旧 trace」（兼容不破）。

#### P2 实施记录（2026-10-14，分支 `feat/agent-turn-timeline-p0`）

| 项 | 落地 | 验证 |
| --- | --- | --- |
| P2-1 artifact 内联缩略图 | `AgentTurnTimeline.vue` artifact part：`done` 且能解析出 url 时渲染内侧缩略图（视频 `#t=0.1` 取首帧 / 图片 `img`），否则 `DockTypeIcon`；`pending` 显「待确认」、`running` 显「生成中…」，`failed` 出内联「重试生成」（D2）+ 错误文案；点击缩略图/定位按钮 → `focusNode` → 画布定位（复用 `resolveNodeUrl`/`CanvasLocateButton`） | `turnTimeline.test.ts` 新增「artifact 状态机 pending→running→done（nodeId upsert 不新建）」「failed 带 errorText」两例 |
| P2-2 live/history 收敛 | `AgentTurnTimeline.vue` 增 `dense?: boolean`：**只**收紧行距/字号 + thinking 默认折叠 + text 三行截断，**不改 parts 语义/顺序/不截断 part 数**；`AgentSideRail.vue` 新增 `liveTimeline` computed（与 `liveTrace` **同判定**：本轮活跃时钉 composer 上方，收束后由气泡内组件接管），flag on 时用 `AgentTurnTimeline(dense)` 顶替 live 的 `AgentExecutionTrace`，与历史气泡同一套 parts 渲染 ⇒ 消除两套组件造成的收束布局跳变（现象 5） | 类型经 vue-tsc；`turnTimeline.test.ts` 加「dense 无关性：模型层 keys 恒为 `parts/turnStartedAt`」回归锁（防渲染态混入模型） |
| P2-3 落库 seq/ts/messageIndex | `packages/shared/src/agentTrace.ts` 新增 `PersistedExecutionEvent`（`seq?`/`ts?`/`messageIndex?` 皆可选，老消息兼容）；`agent.service.ts` 循环内加 `pushTraceEvent(type,data)` 统一落 `{seq(1 起单调), ts(到达时刻), messageIndex(message_end 分段，0 起)}`，替换全部 8 处 `executionEvents.push`；读侧 `replayTimelineEvents` 在事件**全部带 seq** 时先按 seq 稳定排序再回放（数组被裁剪/合并/跨消息拼接也能还原发生序），老消息无 seq 维持原序 | `turnTimeline.test.ts` 加「seq 乱序数组按 seq 回放」「无 seq 维持原序」两例；存量断言按原意放宽（`toContainEqual(objectContaining)`、`canvasCommands` 只取 `{type,data}`） |

> ⚠️ **存量断言调整（P2-3 副作用，非弱化）**：`agent.service.pi-runtime.test.ts` 有两处对落库事件做**深比较**，新增 `seq/ts/messageIndex` 后会失配。已按**原意**放宽：`toContainEqual({type,data})` → `toContainEqual(expect.objectContaining({type,data}))`；`canvasCommands()` helper 改为 `.map(e => ({type,data}))` 后再 `toEqual` —— 锁定的仍是「该通道内容对不对」，只是不再把新增元数据算进形状。两处都保留了原始断言语义，没有降级为「存不存在」。

#### P2 验证记录（2026-10-14）

| 门 | 结果 |
| --- | --- |
| `apps/web` `turnTimeline.test.ts` + `executionTraceReducer.test.ts`（`--pool=forks --environment node`） | ✅ **48/48 绿**（32 = reducer + P0 回归；16 = turnTimeline：10 P1 + 6 P2） |
| `apps/web` `vue-tsc --noEmit` 全量 | ✅ **本次改动文件 0 错**（`apps/web/**`、`packages/shared/**` 无一条 TS 报错）。报告里另有 28 条 `TS2307 Cannot find module '@lnkpi/shared'`，**全部**位于遗留 worktree `../../.worktrees/prc-gate/packages/agent/**`（该 worktree 的 `@lnkpi/shared` 软链失效），与本次改动无关 |
| `apps/server` 三个测试文件首跑 | ⚠️ `2 failed / 1 passed`，**43 例失败全部是 `Error: Test timed out in 5000ms`**（非断言失败），横跨 BYOK 透传 / 409 steer / 侧栏识图 / prompt 组装等**与本次改动无关**领域 ⇒ 判环境超时。**证伪实验**：单跑此前失败的 `BYOK 模型` 两例、`--testTimeout=60000` → **2 passed / 84 skipped，EXIT=0**（实测单例 8.3s / 6.8s ≫ 默认 5s）⇒ 确系沙箱 CPU 慢，非回归 |
| 落库断言（与 P2-3 直接相关） | 单跑 `-t "svg_card"` / `-t "extractCanvasActions"` + `--testTimeout=90000` 复验（结果见下） |

> ⚠️ **本沙箱 vitest 纪律（已多次复现，需写入记忆）**：默认 5s `testTimeout` 对本环境过紧。凡「失败形态 = `Test timed out in 5000ms` 且跨无关领域」一律先按**环境超时**处理，用「单跑 + 放大超时」证伪，**不要**当回归。

---

## 6. 复用清单（不重复造轮子）

| 已有资产 | 位置 | 复用方式 |
| --- | --- | --- |
| 有序 content-block 消息模型 | `vendor/.../ai/src/types.ts:428` | 目标模型直接对齐，不新造类型 |
| block 级消息已到达前端 | `AgentSideRail.vue:2094` `pi_message_end`（当前只用 `entryId`） | 用它划分块边界 |
| SSE 帧保留 text/thinking/toolCall 块 | `sse-sanitize.ts:3-5, 43-46`（只剥离 image data） | 无需改通道即可拿到块 |
| 有序事件落库 | `metadata.executionEvents`（`agent.service.ts:86-96`） | 历史回放的数据源 |
| 工具人话化目录 | `toolPresentation.ts`（28 工具全覆盖） | tool part 直接用 |
| 纯函数 reducer + replay | `executionTraceReducer.ts` | 新 reducer 同形，测试范式照搬 |
| 折叠/定位/滚动锚定交互件 | `AgentExecutionTrace.vue`、`CanvasLocatePinIcon` | part 级折叠复用 |

---

## 7. 验收判据（可证伪）

1. **golden（离线）**：喂入固定事件序列（3 段思考 + 5 工具 + 1 产物 + 1 摘要），
   断言 `parts.map(p => p.kind)` 等于事件序，且渲染 DOM 的 `[data-part-kind]` 序列与其逐项相等。
2. **生产取证**：一次真实回合的 SSE 中 `message_end` 数量 ≥ 2 ⇒ 页面应出现 ≥ 2 个思考块，
   且**存在至少一个工具 part 的 index 小于最后一个思考 part 的 index**（交错成立）。
3. **反例锁**：`applyThinking` 的 `unshift` 不得复活（源码级断言 + 行为级断言各一）。
4. **一致性**：同一轮在 live 结束后与刷新后，`parts` 序列逐项相等（消除 live/history 双源漂移）。
5. **零回归**：flag off 时 `executionTraceReducer` 相关测试全绿、DOM 与线上现状一致。

---

## 8. 风险与回归面

| 风险 | 说明 | 对策 |
| --- | --- | --- |
| 前端 part 数上升 | 大回合可 50+ part，动画 stagger 与滚动重算成本上升 | part 级 `v-memo`；折叠默认收起的 part 不渲染子树 |
| 重跑/fork 依赖 `pi_message_end` | `AgentSideRail.vue:2094-2109` 用它取 user `entryId` | P1 只**增加**消费方，不改既有分支 |
| 老消息兼容 | 库里存量消息只有 trace 快照 | 双读：有 `timeline` 用 timeline，否则 replay → 旧 trace |
| `text_replace` 语义残留 | append/覆盖两种语义并存（`stores/agent.ts:241/270`） | P1 中淘汰 `text_replace` 的覆盖语义，保留历史重放兼容 |
| 折叠态偏好漂移 | 每个 part 都有折叠态，用户"全展开"意愿需记忆 | 会话级（非落库）记忆 + 默认收起工具、展开思考 |

---

## 9. 一句话总结

pi-lnk 和 WorkBuddy 的差距，不在文案、不在组件、也不在 runtime ——
**上游给的是有序的块时间线，pi-lnk 在路上把它压成了"一段文本 + 一列步骤"，再用槽位顺序假装成时间**。
把 `TurnTimeline` 这一层补上，P0 一档就能拿回大部分观感。

## 10. 已决议细节（D 系列）

### D1 — propose 产物：点击「画布生成」后**不补"显式提示条"**，用单个 `artifact` part 的状态机表达

**决策**：一次 `propose_generation` = 一个画布节点 ⇄ **一个** `artifact` part（按 `nodeId` upsert，不新建第二条）。
产物**不做**"点击后补一条 `✓ 已生成`"之类的额外提示；节点从 `pending_confirm` → `running` → `done`
的状态翻转本身就是信号。

**状态链（事件驱动）**：
- `add_node`（propose 建节点）→ `artifact` part，`status: 'pending'`；
- `proposeWaitStart`（`AgentSideRail.vue:2156`，`waiting_user` 且 `toolName==='propose_generation'`）→ 该 part 维持 `pending`，同时 `canvas` part 呈现定位气泡卡片（`pending_confirm`）；
- 用户点「画布生成」→ 生成运行 → `node_status` 开始/进行中 → `artifact.status = 'running'`；
- `node_status` done → `artifact.status = 'done'`，缩略图就位。

**模型改动**：§4 `artifact.status` 联合类型由 `'running'|'done'|'failed'` 扩展为
`'pending'|'running'|'done'|'failed'`（`pending` 专用于 propose 等待确认态）。

**为什么不加额外提示（吸收 WorkBuddy / Claude 范式）**：
产物块 / 工具结果块**自身即信号**，堆"X 已生成"状态条属于冗余噪声。显性化 ≠ 啰嗦文案。
且当前 `deriveLinkedOutputs`（`agent.service.ts:113`）已只收 `add_node` 并标 `status:'done'`，
证明"节点 = 产物"的语义已成立；我们要做的是把这条语义**在时间线里原位渲染**，而非再包一层提示。

**兜底（防卡死）**：若 propose 路径的 `node_status` 未可靠回传（异步生成发生在回合 resume 之后），
在 `finalizeTurn` 以 `linkedOutputs`（`status:'done'`）与画布 SSOT 对账，把对应 `artifact` 翻成 `done`，
确保产物不卡在 `pending`/`running`。`node_status` 已纳入 `TRACE_PERSIST_EVENT_TYPES`（`agent.service.ts:93`），
历史回放同样可驱动状态。

**相邻已决议（同类细节）**：
- 非 propose 直出（agent 直接建节点并生成、无 `waiting_user`）：同样走单个 `artifact` part，状态 `running`→`done`，原位出现，与 WorkBuddy 自动 present 一致。
- 一次回合多个节点 ⇒ 多个 `artifact` part，按 `node_status` 到达序排列，各自独立状态。
- `artifact` 失败（`status:'failed'`）：渲染错误 `notice` + 重试入口，与 `GENERATION_RECOVERY_ENABLED` 灰度机制对齐（当前 off）。
- `artifact` 块点击 ⇒ 定位/高亮画布节点（复用 `AgentCanvasOutputs.resolveNodeUrl` + 滚动锚定），不新增交互。
- 不合成"已生成"自然语言文案：propose 等待期间回合被阻塞、无新 assistant 文本产出，伪装有 assistant 发言会污染对话真相。

### D2 — failed 产物重试入口：文案与位置（对齐 `GENERATION_RECOVERY_ENABLED`）

**位置**：失败 `artifact` part **内联页脚**（card 底部操作行），与失败节点共位，**不**另起浮动 notice / 独立 toast。
理由：与 D1 同源的「产物原位」原则；失败修复入口应紧邻失败产物，符合 WorkBuddy / Claude「失败块自带重试」范式，也避免 §3 现象 5 的「双源容器」复辟。

**失败 `artifact` part 结构**：
```
[失败占位图标]  标题（nodeType 中文 + 节点名）
状态 chip：生成失败
错误 notice（tone=error，单行截断）：<映射原因>
── 页脚操作行 ──
[主] 重试生成     [次] 在画布中查看
```

**文案**：
- 错误行：`生成失败` + 映射原因。原因**复用 `generation-recovery` 已产出的失败原因字符串（PR3 #398）**，保持单一真相；无则兜底 `生成失败，可重试`。**不显示 raw error / upstream 5xx 细节**。
- 主按钮：`重试生成`（对应「重新跑该节点生成」）。
- 次按钮：`在画布中查看` → 定位/高亮画布节点，复用 D1 的 `resolveNodeUrl` + 滚动锚定，零新增交互。

**行为对齐 `GENERATION_RECOVERY_ENABLED`**（当前 off）：
- flag off：失败即停，inline 重试是**唯一**手动入口；点击 = 对该 node 重新触发生成（与「画布生成」同一链路）。
- flag on：生成失败 agent 已自动 re-inject（系统事件 bubble：原因 + 退款状态 + 选项）。此时**若该节点已存在进行中 recovery run（status 非 failed），inline 重试置灰/隐藏**，以 status 为准，避免双重试 UI；recovery 未覆盖时 inline 重试仍作兜底。
- 重试成功 → 该 `artifact` 翻 `running`→`done`，错误行与重试入口消失。

**为什么这套（吸收最佳实践）**：失败块内联重试、错误文案是人话短语非堆栈，是 WorkBuddy / Claude 的既定范式；次按钮复用既有定位能力，零新增成本。

### D3 — 「模型正在做什么」显性化状态行（composer 上方单行，动态换词）

**用户诉求（原话）**：过程中模型正在做什么也要有 —— 像 WorkBuddy 在 composer 上方显示「正在编辑文件」，动态变化「正在回复」「正在思考」「正在探索」，把智能体当前动作**显性化告知用户**。

#### 现状盘点：机制已有约 70%，缺的是"两个骨架态 + 一处去重"

现存的「composer 上方文字」就是**回合状态行**，不是从零新建：

| 环节 | 现状锚点 | 说明 |
| --- | --- | --- |
| 渲染位 | `AgentSideRail.vue:3072-3080`（`data-testid="turn-status-line"`） | 已在 composer 上方，`mode` 驱动 class |
| 文案生成 | `turnStatusBar.ts:53` `turnStatusLine()` | running→`<主语> · Ns`；waiting→`等待你在画布上确认生成`；failed→`生成失败 · 原因` |
| 活动源 A | `stores/agent.ts:118` `activity` ← runtime `activity` 事件（工具**起手**即下发，`pi-events.ts:155`） | 比 trace 更实时 |
| 活动源 B | `activityLine.ts:36` `describeActivity(trace.steps)` ← 最新一步人话 | activity 缺失时兜底 |
| 动词目录 | `toolPresentation.ts:12` `TOOL_PRESENTATION`（38 项 icon+verb） | 文案层已完备 |
| 兜底 | `GENERIC_ACTIVITY='处理中'` / 状态行内 `'生成回复中'` | **两个兜底语义重叠** |
| 阶段分组 | `phaseAggregator.ts:23` `derivePhase()` → exploring/creating/wrapping + `PHASE_BADGE` | ⚠️ 目前**只喂 dense trace 徽章**（`AgentExecutionTrace.vue:144`），**没进状态行** |

#### 四个缺口（都可用现有数据补齐，零新增协议事件）

**缺 1 —— 「正在思考」显示不出来（根因与 P0 完全同源）**
runtime **确实**在思考起手时发了信号：`pi-events.ts:520` `thinking{status:'running'}`（前端 `AgentSideRail.vue:2208` 已消费）。
但 `applyThinking` 用固定 id `'thinking:parse'` 且 **`steps.unshift`（`executionTraceReducer.ts:201-212`）把思考步钉在队头**，
而 `describeActivity` 是**从队尾倒扫取最后一步**（`activityLine.ts:38`）⇒ 只要本轮有 ≥1 个工具步，思考步永远扫不到。
**这正是 P0「thinking 分段 + 取消 unshift」要修的同一个 bug** ⇒ P0 落地后「正在思考」**免费获得**，无需额外改动。

**缺 2 —— 「正在回复」不成立**
vendor 枚举里有 `text_start`（`pi-events.ts:58` 注释），但 `mapPiEventToUiEvent` **只映射 `text_delta`**（`pi-events.ts:86`），无独立起手信号。
目前只有兜底文案 `生成回复中`，与 `处理中` 混用、不成稳定动词集。

**缺 3 —— 同一信息相邻渲染两遍**
`liveTrace` 的 dense 头行 `denseHeadline` = `N 步 · 正在<人话>`（`AgentExecutionTrace.vue:115-122`）
与 `turnStatus` = `<人话> · Ns` 在 composer 上方**相邻两处**（`AgentSideRail.vue:3062` 与 `3072`）输出同一动词。

**缺 4 —— 无主语、动词寄存器混杂**
工具级细动词（`创建节点` / `联网搜索 · 第 2 步`）与骨架兜底（`生成回复中` / `处理中`）混排，
缺 WorkBuddy 那种稳定、可预期的骨架动词与固定主语。

#### 决策

**① 动词集：两层（骨架 always + 工具级细化可选）**

| 骨架态 | 文案 | 信号源 | 现状 |
| --- | --- | --- | --- |
| `thinking` | 正在思考 | `thinking{status:'running'}` 且无工具在跑 | **P0 后可命中**（缺 1） |
| `responding` | 正在回复 | streaming 且无工具在跑（首个 `text_delta` 起手） | 新增（缺 2） |
| `exploring` | 正在探索 | `derivePhase()==='exploring'`（read 类工具） | 复用 phaseAggregator |
| `writing` | 正在编辑 | `derivePhase()==='creating'`（write 类工具，含 propose_generation） | 复用 phaseAggregator |
| `generating` | 正在生成 | `run_*` 工具 / `node_status` generating | 复用 TOOL_PRESENTATION |
| `waiting` | 等待你确认 | `blockingWait`（propose 专用文案已有） | 已有 |
| `recovering` | 会话恢复中 | `agent.recovering` | 已有 |
| `failed` | 生成失败 · 原因 | `turnError` + `failureReason` | 已有 |
| 兜底 | 处理中 | 以上全空 | `GENERIC_ACTIVITY` |

细化后缀沿用现有 `presentToolStep` 输出（如骨架 `writing` + 细化 `创建节点` ⇒ 显示工具级动词，二者同源不重复）。

**② 优先级（严格有序）**

```
waiting  >  failed  >  recovering  >  工具级动词(exploring|writing|generating)
         >  thinking  >  responding  >  处理中
```

即：**有真实工具在跑时，工具级动词优先于「正在思考」**（更具体、信息量更大）；无工具在跑的空档才落到 `thinking` / `responding`。
该序与现状一致（现状已是 activity 优先），改的只是**把 thinking / responding 两个空档填上**。

**③ 一处渲染、两处分工（去重，治理缺 3）**
- `turn-status-line` = **动词的唯一承载体**（骨架 + 细化 + 计时）。
- dense trace 头行 `denseHeadline` **移除动词**，只保留 `N 步` + 展开箭头（展开后仍是完整步骤明细）。
⇒ composer 上方同一时刻只有**一条**动词行。

**④ 措辞**
`模型 · 正在思考 · 12s`：muted `模型` 主语 chip + 动词主体 + muted 计时。
> ⚠️ 备选：单 agent 侧栏内主语略冗余，可去主语降为 `正在思考 · 12s`（一个常量即可切换）。**默认按用户要求保留主语。**

**⑤ 动态节拍（体验关键，吸收 WorkBuddy）**
- **最短驻留 ~200ms**：`activity` 在工具起手即到，密集工具序列会把状态行打成频闪；切换需节流。
- **固定行高 + 动词淡入**（复用现有 `agent-turn-status--{mode}` class hook 做 transition），避免 composer 上下跳动。
- 计时 `· Ns` **沿用现有 ticker**（`AgentSideRail.vue:701-719` 的 `nowSec` 1s interval）——不新增定时器。

**⑥ 纯 live、不落库**
状态行是**瞬时指示器**；回合结束后由气泡内 trace 记录承接（见 §3/§7）。
历史回放**不**重建「模型正在…」行 —— 否则历史里会出现假的进行时态。

**⑦ 零新增协议事件**
数据源全部现有：`agent.activity` / `thinking` / `text_delta` / `derivePhase(trace.steps)` / `blockingWait` / `recovering`。
P0 的 thinking 分段是「正在思考」不被打埋的**前提**，但不新增事件类型。

#### 可证伪验收

| # | 断言 | 现状 |
| --- | --- | --- |
| A1 | 纯思考回合（无工具）流式期间，状态行文本含「正在思考」 | **必失败**（unshift 后扫不到）⇒ P0 后通过 |
| A2 | 工具执行期间状态行含工具级动词，且**不**出现「正在思考」 | 通过（验证优先级 ②） |
| A3 | 回合结束后状态行消失（`turnStatus===null`），历史消息无「模型 · 正在…」行 | 通过（验证 ⑥） |
| A4 | composer 上方同一时刻只有**一条**动词行（dense trace 头行不含动词） | **必失败**（当前两处）⇒ 去重后通过 |

**测试落点**：`turnStatusBar.test.ts`（动词集 + 优先级 ②）、`activityLine.test.ts`（thinking/responding 派生）、DOM 测试（A3/A4 去重与消失）。

### D4 — 状态行承载成本（与 pricing §6.7 第 1 层对齐；不另起成本线，非「活动|成本」竖线复合）

**先回答用户两个子问**
- 现状**没有**「正在执行命令|已消耗X积分」这种复合状态。回合状态行（D3）今天只渲染 `活动 · 秒数`，不含任何积分/成本。
- 但「花了多少钱要显性化」**用户已在 pricing spec §6.7 拍板**（由粗到细 4 层），与今日诉求一致；数据链路半通。本决议是**对齐既有 §6.7，不另造**。

**修订 D3 决策 ③/⑤**：D3 把状态行定为「动词唯一承载体（动词 + 计时）」；本决议在其上追加 **muted 积分后缀** —— 动词为主信息，计时与积分为更暗字重的次要 token（同句、非竖线）。

**现状盘点（cost 当前在哪显）**
| 位置 | 现状 | 说明 |
| --- | --- | --- |
| 气泡回合摘要行（回合结束后） | `turnSummaryLine`（`executionTraceReducer.ts:436`）已有「· 消耗 X tokens」 | token 粒度、回合末、在气泡里，**非实时** |
| 顶栏余额 | `AccountPointsPill`（`AccountChrome.vue:30`）**已存在** | settle 后递减 + 高亮，即「已消耗 X 积分」常驻 live 余额（§6.7 第 4 层，已建） |
| 画布 refine dock | `DockCreditBadge`（`⚡N积分`，canvas dock panels）已建 | 属画布工具侧栏，**非 agent 窗口** |
| **状态行实时积分** | **缺失** | §6.7 第 1 层未落到 `turn-status-line` |
| **中途「预估」** | **缺失** | `createUsageAccumulator` 仅 message_end 才发 → 中途成本平 |

**数据链路半通**
- 已消费：`turn_usage` 事件 → `AgentSideRail.vue:2211` → `trackTurnUsage`（`stores/agent.ts:366`）→ `applyTurnUsage` → `formatTokens`（trace 摘要行数据源）。
- 缺口（归 **pricing P0**，非 timeline P0）：#1 `usage_delta` 即时 emit（让中途有预估）；#2 `turn_settled` 权威值（落账后覆盖预估、驱动 pill 递减）。

**决策**
1. **状态行 = `模型 · 正在思考 · 12s · 预估 -2积分`（running）/ `模型 · 正在回复 · 本次 -5积分（输入 X·输出 Y）`（settled）**。
   动词为主、计时与积分为更暗字重次要 token，**同句不竖线** —— 满足 §6.7 第 1 层，不违背 D3「一处渲染/单一焦点」。
2. **顶栏 `AccountPointsPill` 承担「已消耗 X 积分」常驻 live counter**（用户截图式）。已建，本决议不重建，只确认它承担余额/已消耗叙事。
3. **不做**「活动 | 成本」竖线复合串：竖线分割弱化「正在做什么」语序；WorkBuddy / Claude 也是 `what · tokens` 同句淡化、动词仍为主语。
4. **诚实表达**：running 用「预估」（下限 + 典型区间，与 §6.7「⚡1积分起」同源）；settle 用权威值；偏差 >20% 时明细标注（§6.7 #4）；**绝不显示假精确中途成本**。
5. **scope 边界**：timeline 侧只 (a) 在 `TurnStatusLineInput`（`turnStatusBar.ts`）增 `costHint` 段（running 拼「· 预估 -N」、settled 拼「· 本次 -N积分」）并定义 muted 渲染口径；(b) **不另起成本线**。具体 `usage_delta` / `turn_settled` / 价目表换算归 **pricing §6.7 的 P0 实施**（见 `docs/superpowers/plans/2026-10-13-p0-pricing-equivalent-migration.md`）。

**可证伪验收（timeline 侧）**
| # | 断言 | 范围 |
| --- | --- | --- |
| A5 | running 状态行含 muted「预估 -N积分」token，且积分字重 < 动词、同句非竖线 | timeline D4 |
| A6 | 回合结束（settled）状态行/摘要行含「本次 -N积分（输入 X·输出 Y）」；与中途预估偏差 >20% 时显标注 | timeline D4 |
| A7 | 顶栏 `AccountPointsPill` 在 settle 后余额递减并高亮（复用既有，不回归） | 复用 §6.7 |

**Cross-ref**：pricing §6.7（`2026-10-13-pricing-baseline-config-design.md:312-344`）。
