# 子代理任务在 SSE 对话流可见（任务卡 + 详情面板）· 设计规格

> 立项日期：2026-11-17。状态：**待评审（spec 阶段，未实现）**。
> 用户诉求：参考/复刻 WorkBuddy，子代理任务在 SSE 对话流可见，点击可看运行任务详情与最终报告。
> 前序闭环：子代理 barrier + 上下文隔离 + 结果交付（PR #894，master `786624f6`，生产取证 14/14 + 确定性复测 12/12/8/8）——本刀在其**已上线的数据面**之上只做 web 呈现，**pi-runtime / Nest 零改动**。
> 遵循：AGENTS.md「第一原则——吃满上游、不重复造轮子」（§8 附逐项等价物检索结论表）。
> 用户已拍板（2026-11-17）：**A 档纯前端接线**；background 报告缺口用「引导 collect + 兜底文案」；命名用「短码 + 任务摘要」；B 档（一等事件回灌子会话轨迹）留二期。

## 1. 背景与目标

子代理（block/background 两种模式）的派发与结果回流，目前**已经完整走 SSE 到前端**，但被当成普通工具调用折叠成一行「🤖 派生子代理」，用户无法：

1. 在对话流里一眼看到「派了几个子代理、各自状态、耗时」；
2. 点开看**下发的任务全文**与**最终报告全文**（现在是 80 字摘要 + 需要展开 details）。

目标一句话：**把已经在 SSE 里的子代理数据聚合成一等任务卡 + 可点开的详情面板，后端零新协议、零新事件类型。**

## 2. 现状证据锚（回代码核对，真实 master `b97e8acf`，2026-11-17）

| # | 事实 | 位置 |
|---|---|---|
| E1 | `spawn_subagent` 的 `tool_execution_start` 携带 `args:{task,background,reportFormat,mode}`；`tool_execution_end` 携带 `result:{ok,callId,report,usage:{turns,durationMs,status},truncated,partial,error}` | `services/pi-runtime/src/tools/spawn-subagent.ts:64-140`（真实 master 175 行版） |
| E2 | background 模式 `spawn` 立即返回 `{ok:true,callId,status:"running"}`；`collect_subagent_result` 终态返回同构 result（含 report） | 同文件 `:120-131`、`:148-175` |
| E3 | Nest `mapPiEventToUiEvent` 把两者映射为 `tool_call{name,args}` / `tool_result{name,result,isError}`，**args/result 全量透传不裁剪** | `apps/server/src/agent/pi-runtime/pi-events.ts:170-181` |
| E4 | 子会话事件按 P2 隔离**刻意不进父 SSE**；父 SSE 只看得到 spawn/collect 两个工具壳的 start/end | `services/pi-runtime/src/session-manager.ts`（P2 设计，子 key 独立 entry） |
| E5 | `tool_call`/`tool_result` 均在落库白名单 ⇒ 历史会话刷新后可按同一 reducer 重建任务卡 | `apps/server/src/agent/agent.service.ts:150-163` |
| E6 | web `turnTimeline.ts` 的 `applyTimelineEvent` 把两类事件 upsert 成 `kind:'tool'` part；`args` 经 `summarizeToolArgs`、`result` 经 `summarizeToolResult`（**80 字截断**） | `apps/web/src/components/agent/turnTimeline.ts:556-618,379-386` |
| E7 | `AgentTurnTimeline.vue` 对 `kind:'tool'` 渲染一行 + `<details>` 摘要；无点击弹面板能力 | `AgentTurnTimeline.vue:456-485` |
| E8 | 已有 sheet 组件范式 `SkillPickSheet.vue`（`sheet-head/sheet-body/sheet-close` + `role="dialog"`），可直接仿 | `apps/web/src/components/agent/SkillPickSheet.vue` |
| E9 | `toolPresentation.ts` 已登记 `spawn_subagent:🤖 派生子代理` 与 `collect_subagent_result:📥 收取子代理结果` | `apps/web/src/components/agent/toolPresentation.ts:75-78` |
| E10 | barrier 把后台子任务结果拼成**纯文本 followUp** 回注（`composeBarrierFollowUp`），**不产生结构化 tool_result** ⇒ 模型未显式 collect 时报告无结构化载体 | `services/pi-runtime/src/gate/subagent-barrier.ts:20-33` |

## 3. 范围

### 3.1 做
- 新增 `subagent_task` timeline part（一等公民，与 tool part 并存；**不改 tool part 语义**）。
- `spawn_subagent` / `collect_subagent_result` 的 `tool_call`/`tool_result` 事件：既走原 tool part（保持执行轨迹兼容），又派生/更新一个 `subagent_task` part。
- 任务卡：显示短码名 + 任务摘要 + 状态 + 耗时，可点击。
- 详情面板（Sheet）：下发任务全文（折叠引用块）+ 状态/耗时/报告 + 断流/截断标记。
- 完整 task/report 存入 part 的新字段（不走摘要函数）。
- background 无结构化报告时：卡片显示兜底文案「结果已并入回复」。

### 3.2 明确不做（分期/他刀）
- B 档：新增 `subagent_*` SSE 事件类型、把子会话逐步执行轨迹回灌父流（破坏 P2 隔离，二期另立 spec）。
- pi-runtime / Nest 任何改动（含给 spawn 加 `label` 参数——命名用短码替代）。
- 移动端单独交互（复用桌面 Sheet，走响应式；如需专属形态按移动端壳纪律另立）。

## 4. 关键设计

### 4.1 数据模型（新增 TimelinePart 变体）
```ts
| {
    kind: 'subagent_task'
    id: string                    // `subagent:${callId ?? toolCallId}`
    toolCallId?: string
    callId?: string
    displayName: string           // 短码，如 `子代理 a1b2c3d4`（callId 前 8 位）
    task: string                  // 完整下发的 task（含 background 拼装）
    status: 'running' | 'completed' | 'failed' | 'timeout' | 'budget_exceeded' | 'stream_interrupted' | 'interrupted'
    durationMs?: number
    turns?: number
    report?: string               // 完整报告（≤20k，来自 result.report）
    partial?: boolean             // P3 断流标记
    truncated?: boolean           // 报告截断标记
    degraded?: boolean            // 无结构化报告兜底（background 回注走文本）
    startedAt: number
  }
```

### 4.2 派生规则（reducer，live SSE 与 executionEvents 重放同源）
- `tool_call` 且 `name==='spawn_subagent'`：建 `subagent_task`，`status='running'`，从 `args.task`/`args.background` 拼 `task`，`displayName=短码(callId 缺省用 toolCallId)`。
- `tool_result` 且 `name==='spawn_subagent'`：
  - block 模式终态（`result.report` 存在）→ 按 toolCallId upsert，写 report/status/duration/turns/partial/truncated。
  - background 模式（`result.status==='running'`）→ 保持 running，不写 report。
- `tool_result` 且 `name==='collect_subagent_result'`：按 `result.callId` 找 `subagent:${callId}` upsert 终态；若找不到（调用方换了 toolCallId）则用 `result.callId` 直接定位。
- 兜底：若有 `spawn`(background,running) 无对应 `collect` 终态且 turn 已结束（`turn_settled`/`agent_end`），标 `degraded=true`，UI 显示「结果已并入回复」。
- **幂等**：同一 callId/toolCallId 的重复事件（重连、重放）只 upsert 不重复 push。

### 4.3 完整数据保留（反截断硬约束）
- `summarizeToolArgs` / `summarizeToolResult` 只服务旧 tool part 的摘要展示；`subagent_task` 的 `task`/`report` 直接读原始 `event.data.args` / `event.data.result`，**禁止复用摘要函数**（E6）。
- 落库：`subagent_task` part 由 reducer 从已落库的 `tool_call`/`tool_result` 重放派生（E5），**不新增落库字段**——历史会话刷新后自动重建。

### 4.4 组件与交互
- `AgentTurnTimeline.vue`：在 `kind:'tool'` 分支前加 `v-else-if="part.kind === 'subagent_task'"` 分支，渲染任务卡；点击 `emit('open-subagent-task', part)`。
- 新增 `SubagentTaskSheet.vue`：仿 `SkillPickSheet` 结构（`role="dialog"` + `sheet-head/body/close`），props 收 `part`，展示：
  - 标题 `displayName + '的任务'` + 关闭按钮；
  - 「下发任务详情」`<details>` 折叠块，内含完整 `task`（保留换行）；
  - 状态行：`已完成/运行中/失败 + durationMs`，断流/截断/兜底标记；
  - 「最终报告」全文（有 report 时）；无 report + degraded 时显示兜底文案。
- Sheet 挂载点：`AgentSideRail.vue`（与 SkillPickSheet 同级），由 `open-subagent-task` 事件驱动，`close` 关闭。

### 4.5 上游资产复用清单（硬约束——第一原则）
| 复用项 | 来源 | 用法 |
|---|---|---|
| SSE 事件管道 | E3 | 零新增事件，读既有 tool_call/tool_result |
| 落库重放 | E5 | reducer 同源派生，零新增落库 |
| sheet 结构 | E8 | 仿 `SkillPickSheet`，不新造 modal 框架 |
| 工具图标/动词 | E9 | 卡片图标复用 `toolPresentation` |
| 状态枚举 | E1/E2 | 直接映射 result.status，不新造状态机 |

## 5. 行为判据（C 系列，验收口径）
- **C1**：block 模式 `spawn_subagent` 派发→报告回流，对话流出现一张 `subagent_task` 卡，状态 completed、耗时正确；点开 Sheet 见完整 task + report。
- **C2**：background 模式 `spawn`(running) + `collect`(终态) 通过同一 callId 配对，卡片从 running 收敛到终态，报告正确。
- **C3**：`stream_interrupted`/`partial:true` 的报告，卡片与 Sheet 显式标记「结果不完整」，不冒充成功。
- **C4**：background 有 spawn 无 collect、turn 已结束 → 卡片显示「结果已并入回复」兜底，不显示空白报告。
- **C5**：断线重连 / 历史会话刷新，任务卡由落库事件重建，数量与状态正确（幂等、无重复卡）。
- **C6**：非子代理工具（`run_text_generation` 等）不受影响——仍走原 tool part，不产生 `subagent_task`。

## 6. 负例 / 变异（N 系列，转红判据）
- **N1**：把 reducer 里 `name==='spawn_subagent'` 判定去掉 → C1 必须有 RED（不产卡）。
- **N2**：把 `report` 改走 `summarizeToolResult` → C1 的 Sheet 全文断言必须 RED（只剩 80 字）。
- **N3**：把 collect 配对键从 callId 改成 toolCallId → C2 必须 RED（配不上，卡停在 running）。
- **N4**：去掉 degraded 兜底 → C4 必须 RED（空白报告）。
- **N5**：去掉幂等 upsert → C5 必须 RED（重复卡）。
- **N6**：把判定放宽到所有 tool → C6 必须 RED（普通工具也出卡）。

## 7. 诚实边界
- 子代理的**逐步执行轨迹**（如「运行命令/读取任务输出」）不进父 SSE（P2 隔离，E4），本刀**不展示**——截图右侧面板的核心信息（下发任务 + 报告）已覆盖，细粒度轨迹属 B 档二期。
- 命名用 callId 短码，不是截图里的 `general-purpose-1` 语义名（需给 spawn 加 label，用户已拍板不做）。
- background 报告的「并入回复」路径是纯文本 followUp（E10），本刀无法结构化挂到卡片，只能兜底提示——这是 A 档已知取舍。

## 8. 依赖与部署
- 触发面：仅 `apps/web` → `deploy.yml` web job（push 自动分流 web-only）。**不碰 pi-runtime / Nest，无需 runtime-deploy / 环境审批**。
- 验证：`pnpm --filter web test`（含 `turnTimeline.*.test.ts`）、`vue-tsc -b`、design-token.test（若改样式）、变异 N1–N6 全 RED。
- 无 CI 前置依赖；可与其它 web-only 刀并行（遵守分支纪律）。

## 8.5 验证策略（行为级 + 变异自检）
- 行为级：以 timeline reducer 为纯函数喂入真实 SSE 事件夹具（block / background / partial / degraded / 重放），断言 part 结构。
- 组件级：`AgentTurnTimeline` 渲染任务卡、点击 emit；`SubagentTaskSheet` 展示完整 task/report。
- 变异：按 §6 逐条做 RED 验证（完整 stdout 判定，不用 `| tail`）。

## 9. 分刀实施顺序
1. **刀 1（数据与 reducer）**：`turnTimeline.ts` 加 `subagent_task` 变体 + 派生/upsert 逻辑 + 完整数据保留；纯函数测试 + N1/N2/N3/N5/N6 变异。
2. **刀 2（呈现）**：`AgentTurnTimeline.vue` 任务卡分支 + 新建 `SubagentTaskSheet.vue` + `AgentSideRail.vue` 挂载；组件测试 + N4 变异。
3. **刀 3（验证闭环）**：全量 web 测试 + 类型 + design-token + 静态门禁；docs-only 回填本 spec 状态（如需）。

## 10. 待评审决策点（已拍板，记录备查）
| # | 决策 | 结论 |
|---|---|---|
| D1 | background 报告缺口 | 引导 collect + 兜底文案「结果已并入回复」；B 档事件化留二期 |
| D2 | 命名 | callId 前 8 位短码 + 任务摘要；不加 label 参数 |
| D3 | 聚合落点 | turnTimeline 对话流（非 executionTrace 侧栏） |
| D4 | 与 tool part 关系 | 并存：保留原 tool part（执行轨迹兼容），另派生 subagent_task 卡 |

## 11. 等价物检索结论表（第一原则 · 逐项）

> 判「不存在」用 `grep -E` + 已知词反向对照；核实基于真实 master `b97e8acf`（gh api，非本地陈旧工作树）。

| 检索项 | 命令/方式 | 结论 |
|---|---|---|
| 已有 subagent SSE 事件类型 | `grep -nE "subagent_start\|subagent_end\|subtask" session-manager.ts` 的 EVENT_MAP | **无**；子代理数据全在既有 tool_call/tool_result 的 args/result 中 ⇒ 复用而非新建事件 |
| 已有 task 卡组件 | `grep -riE "SubagentTask\|TeamMemberCard" components/agent` | **无**；但 `kind:'tool'` part + `<details>` 是现成底座 ⇒ 派生新 part 变体，不新造时间线框架 |
| 已有详情 Sheet | `grep -ri "sheet-head" components/agent` | `SkillPickSheet.vue` 现成 ⇒ 仿其结构，不新造 modal |
| args/result 是否全量到前端 | 读 `pi-events.ts:170-181` | 全量透传 ⇒ 完整 task/report 已在 SSE，只差前端保留（反摘要截断） |
| 历史会话可否重建 | 读 `agent.service.ts:150-163` 落库白名单 | tool_call/tool_result 在白名单 ⇒ 同源 reducer 重放即可，零新增落库 |
| 是否已有人做过同样 UI | `grep -ri "子代理.*卡\|subagent.*card" apps/web` | **无**；真缺口 |
| 命名可读源 | `grep -n "label\|name" spawn-subagent.ts 参数` | 无 label 字段，只有 callId ⇒ 短码方案（用户已拍板不加参数） |
