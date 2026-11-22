# 一轮 Turn 时间线序列化修复（question 沉底 / todo 通知洪水 / canvas 连排 / replay 用时 1ms）

> 状态：🟢 living（2026-11-22 生产走查实证后推翻性修正；取代前序 B 形态规格中受影响的两条假设）
> 前序：`2026-11-22-turn-inline-status-checklist-design.md`（B 形态，本修复不改动其 UI 形态裁决，只修数据序列化）

## 0. 第一原则

零新增字段 / 零新增事件 / 零迁移。全部修复在客户端 reducer（`turnTimeline.ts`）内闭合；
等价物检索：服务端账本（`metadata.executionEvents`）**本身健康**（154 事件 seq 严格时序，
ask_user 在 seq 5-10），缺陷全在客户端 live/replay 两条路径的合并逻辑，无需动 pi-runtime。

## 1. 生产证据（会话 cmwrnm9ch0b2fo901p15oscif，回合「屎壳郎大战螳螂短剧」，85 parts）

| 现象（用户视角） | 数据证据 |
| --- | --- |
| 「需要你回答」卡片沉底：出现在最终正文、summary notice 与 14 张产物卡**之后**（idx84） | 账本 seq 5-10 是 ask_user（第 2 个工具位）；live 流式期探针实测 question 曾在数组位置 5；replay 后落到 idx84 |
| 同批任务文案重复渲染 3 组 10 行 notice（idx7-10 / 22-25 / 43-44 / 66） | 账本 seq 17 task_list + seq 48/49/50、115/116、149 task_update；每个事件逐项 push notice |
| 「🖼️连接画布节点」连排 13 行（idx46-58） | 账本 seq 119-131 恰 13 条 `canvas_action{type:'add_edge'}`，每事件 push 一个 part |
| 收口行「用时 1ms」（真实回合 ~95s） | replay 时 `createTurnTimeline` 与 `finalizeTurnTimeline` 都是重放墙钟 → 差值 ≈1ms |
| 附带核实（非缺陷）：「已结算 -1 积分」 | `composeSettledSegment` 的「-N」是 C9 规格拍板的扣减记法（turn_settled.credits=1）；如需改口径另立规格 |

**根因**：live 与 replay 序列化分裂。live 路径依赖一个**账本里不存在**的独立 `ask_user` 事件
（0 次出现）建 question 卡；replay 只见 `waiting_user{toolName:'ask_user'}`（不带题面），
`case 'waiting_user'` 明确不建卡（注释「question part 由 ask_user 事件另建」），
最终靠 `reconcileTimelineInterruption` 安全网把卡补建到数组末尾。

## 2. 修复（全部单点在 `turnTimeline.ts`，live/replay 同一条代码路径）

| 刀 | 位置 | 语义 |
| --- | --- | --- |
| F1 question 归位 | `case 'waiting_user'` waiting 分支 | `toolName==='ask_user' && callId` ⇒ 按 `question:${callId}` **原位 upsert**（notice 之后）；题面事件自带则写入，否则留空待 interruption state 补全；resolved 既有逻辑原位翻终态。安全网退化为纯兜底 |
| F2 todo 通知抑制 | `case 'task_update'/'task_list'` | 无 nodeId 项不再逐事件发 notice（与轮首清单完全同文的重复行）；带 nodeId 项的 artifact 对账通道**不变** |
| F3 canvas 折叠 | `case 'canvas_action'` 兜底分支 | 同 `type`+同 `label` 折叠为一行，label 带 `×N` 计数（`count` 字段新增，可选）；不同 label（逐节点标题）保持独立行以保留定位语义 |
| F4 replay 时长 | `replayTimelineEvents` + `finalizeTurnTimeline` | 账本事件自带服务端 `ts` ⇒ `turnStartedAt=首事件 ts`；账本以 `turn_settled` 收束 ⇒ `turnEndedAt=settled.ts`；finalize 改 `??=` 不覆盖已有值（live 行为不变） |

## 3. 验收判据（TDD：`turnTimeline.serialization.test.ts` 12 用例）

- G1：生产同构账本 replay ⇒ question 卡 idx=账本位（工具卡+notice 之后），resolved 原位翻 answered；
  reconcile 后**不追加任何 part**（安全网退位）。
- G2：task_list 3 项 + task_update 2 次（无 nodeId）⇒ 0 条任务 notice；带 nodeId 仍建 artifact。
- G3：13 条 add_edge ⇒ 1 行「连接画布节点 ×13」；不同 label 不合并；live 直喂同构。
- G4：replay 时长 = 事件 ts 区间（95s 而非 1ms）；finalize 不覆盖；无 ts 旧账本行为不变。
- 变异自检 3/3 转 RED（折叠失效 / 原位建卡失效 / finalize 恢复覆盖）。

## 4. 已知边界（诚实声明）

- `waiting_user` 账本形态**不带题面** ⇒ 历史重放的 pending 卡（若有）题面由 interruption state
  同步补全（既有通道）；answered 历史卡只显示终态行，无需题面。
- 产物卡（artifact）在收口后由画布对账（`reconcileFromNodes` 第二通道）批量回填、聚合在
  summary notice 之后——这是既有「成果区」设计，本修复不移动它。
- F4 只认 `turn_settled` 为权威收束；截断账本（truncated）不冒充完整时长。
