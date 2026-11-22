# 决策面收归对话页：移除画布两处提议操作胶囊（规格）

> 状态：**已拍板**（2026-11-22 用户裁决：移除操作面、保留状态面、移动端加「去对话处理」跳转）
> 日期：2026-11-22
> 范围：`apps/web` 画布页 + 移动壳层 + 相关守卫测试 + 历史规格状态回填
> 上游裁决：`ADR-0011`（提议确认单一锚定表面）、`2026-11-02-propose-card-ux-optimization`（画布=预览+产物二次编辑）、`2026-10-28` 等待态单一真相根治

---

## 0. 结论先行

**本项目通过对话驱动 agent 操作画布：所有决策与操作面职责在对话页；画布页承担预览查看。**
据此移除画布上的两个提议操作胶囊，保留状态展示，并给移动端状态带一个通往对话页的跳转，避免它变成死通知。

| 决策点 | 裁决 | 理由 |
|---|---|---|
| PC `ProposeConfirmOverlay` | **整个退场**（确认生成 / 编辑 / 取消三钮一并移除） | 它的全部职责就是那三个按钮；状态展示另由 `NodePendingPrompt` 承载，不会丢 |
| 移动 `MobileNodeStatusBar` | **移除「拒绝 / 确认」两钮**，保留「N 个生成中 / 待确认·XXX」文本与任务 sheet 入口 | 「看到哪些在等」= 查看，符合画布定位；「拍板」= 决策，归对话页 |
| 移动端可达性 | 状态带新增 **「去对话处理」** 跳转（`onTabChange('chat')`） | 对话与画布是两个 Tab，不能让用户看到「待确认」却无处可去 |
| 对话页决策能力 | **不动**（`AgentTurnTimeline` proposal 卡：落锚生成 / 调整 / 取消 + 页脚定位） | 三动作 + `ProposeTuneSheet` 真写回已闭环，能力无缺口 |
| 确定性确认契约 | **不动**（`POST /answers {callId, decision}`） | 移除的是入口位置，不是确认语义 |
| 服务端治理门 | **不动** | 与本次 UI 职责调整正交 |

---

## 1. 第一原则：吃满上游、不重复造轮子

**声明**：任何新增判据 / 工具 / 数据字段 / 引擎，立项前必须过三判据——① 等价物检索；② 接线优先于新建，判据锚到既有结构化数据面；③ 禁造数 / 禁自报。本节逐项给出结论。

### 1.1 等价物检索结论表

| 拟移除的画布能力 | 对话页既有等价物（真实路径） | 结论 | 本次如何接线 |
|---|---|---|---|
| PC「确认生成」 | `AgentTurnTimeline.vue` proposal 卡 `data-test="confirm"` → `onConfirmProposal` | ✅ 完全等价 | 无需新增；直接靠既有入口 |
| PC「取消」 | proposal 卡 `data-test="cancel"` → `onCancelProposal` → `POST /answers {decision:'decline'}` | ✅ 完全等价 | 同上 |
| PC「编辑」（开 dock 改提示词/参数） | `ProposeTuneSheet.vue`（2026-11-02 PM 裁决：**真写回**模型/比例/分辨率/提示词/张数，`patchNodeData`+落库成功才 `confirmProposal`） | ✅ 更强等价 | 对话卡「调整」钮（`data-test="tune"`）承接；「在画布精修」逃生钮保留产物二次编辑 |
| 移动「拒绝 / 确认」 | 同 PC 两入口 | ✅ 完全等价 | 状态带跳转对话 Tab 后可达 |
| 「待确认」状态展示 | `NodePendingPrompt.vue`（节点上只读 chip + 提示词摘要，PC/移动瓦片共用） | ✅ 已存在、独立组件 | 保留，不受本次移除影响 |
| 「去对话处理」跳转 | `MobileCanvasShell` 已有 `onTabChange: (tab: MobileAppTab) => void` prop | ✅ 现成通道 | `MobileNodeStatusBar` emit `go-chat`，壳层直接转 `props.onTabChange('chat')`，零新通道 |

**检索结论**：本次**零新增判据、零新增字段、零新增请求通道、零新增组件**。唯一新增是一个 emit（`go-chat`）与一条既有 prop 的转发，属接线而非造轮子。
⚠️ 反向核对（`grep -E`）：`handleProposeConfirmCancel` 仅被画布 overlay 与移动状态栏接线使用；移除两处后该函数成为死代码，须一并清理（`handleAgentGenerateNode` 是核心生成入口，**保留**）。

### 1.2 禁造数 / 禁自报约束

- 不新增任何「用户已确认」的本地镜像状态——确认仍以 `POST /answers` 的确定性结果为准。
- 移动端跳转只切 Tab，不伪造确认/拒绝事件；`pendingNodes` 仍来自 `summarizeMobileNodeTasks` 的结构化数据面，不读 prompt 文本推断。

---

## 2. 现状取证：两个胶囊都是「第二入口」

| 表面 | 组件 | 源码自述 | 决策入口 |
|---|---|---|---|
| PC 节点胶囊 | `components/canvas/ProposeConfirmOverlay.vue` | 「行为同源（不新造第二套确认语义）」「与侧栏取消同一函数」 | 确认 → `handleAgentGenerateNode`；取消 → `cancelProposeForNode`；编辑 → 开 dock |
| 移动底部胶囊 | `components/mobile/MobileNodeStatusBar.vue` | 「确认/拒绝动作复用桌面同一套语义，本组件只 emit，不自己发请求」 | 确认 → `onNodePendingConfirm`；拒绝 → `onNodePendingCancel` |
| 对话时间线卡 | `components/agent/AgentTurnTimeline.vue` | 「对话内决策中枢 —— 三动作 + 终态折叠行」 | 落锚生成 / 调整 / 取消 / 页脚定位 |

**历史演进（本次是收尾，不是推翻）**：
- 10-06：对话流靠文案嗅探冒出的确认卡全下线（误触事故 `cmus6ha64`）。
- 10-19 ADR-0011：为解「对话卡 + 节点 + 自动弹 dock」三带叠罗汉，把确认收拢到画布节点。当时对话卡只有定位/取消，dock 自动弹且是唯一确认入口。
- 10-28：等待态单一真相 = 时间线 proposal part；对话流外浮卡整体下线。
- 11-02：PM 裁决「画布 = 预览 + 产物二次编辑/再生成主场」，`ProposeTuneSheet` 从 preview-only 升级为真写回。
- ⇒ 前提已变：对话卡现在是完整决策中枢，画布胶囊是重复入口。本次把它移除。

---

## 3. 方案与接线清单

### 3.1 PC：overlay 整体退场

| # | 文件 | 改动 |
|---|---|---|
| 1 | `pages/CanvasPage.vue` | 删 `ProposeConfirmOverlay` import 与 template 块（`:126`、`:6404-6414`）；删仅服务它的 `handleProposeConfirmEdit`（`:4922`）与 `handleProposeConfirmCancel`（`:4836`，移动删除后无调用方）；清理相关注释中的「画布确认面」措辞 |
| 2 | `components/canvas/ProposeConfirmOverlay.vue` | 删除文件 |
| 3 | `components/canvas/ProposeConfirmOverlay.test.ts` | 删除文件；其覆盖的「可见判据 / 触控 44px / emit」契约由对话卡与状态带测试承接 |
| 4 | `components/canvas/NodePendingPrompt.vue` | 改注释：`11` 行「编辑入口统一走 ProposeConfirmOverlay「编辑」→ dock」改为「编辑入口在对话卡『调整』（`ProposeTuneSheet`）」 |
| 5 | `stores/agent.ts:787`、`components/agent/executionTraceReducer.ts:21`、`AgentSideRail.vue:783,4008` | 注释中的「画布节点内联确认面 / ProposeConfirmOverlay」改为「对话时间线 proposal 卡」 |

⚠️ **不删** `deriveProposeConfirmAnchor` / `proposeWaitNodeId` / `proposeConfirmNode`：它们同时服务 `NodePendingPrompt` 的 `proposeWaiting`（等待期强制显示摘要）与批量进度卡门控（`!proposeConfirmNode`），删掉会丢失状态展示。

### 3.2 移动：状态带只留状态 + 一个跳转

| # | 文件 | 改动 |
|---|---|---|
| 6 | `components/mobile/MobileNodeStatusBar.vue` | 删「拒绝 / 确认」两钮与其 emit；新增 `go-chat` emit 与「去对话处理」按钮（有 `firstPending` 时渲染，44px 触控、复用 `--lnk-*` 令牌）；保留 `generatingCount` / `pendingTargetText` / `open-tasks` |
| 7 | `components/mobile/MobileCanvasShell.vue` | `MobileNodeStatusBar` 接线去掉 `@confirm` / `@cancel`；加 `@go-chat="props.onTabChange('chat')"`；删 `onNodePendingConfirm` / `onNodePendingCancel` 两个 prop 定义与注释里的「确认/拒绝入口」措辞 |
| 8 | `pages/CanvasPage.vue` | 删 `:on-node-pending-confirm` / `:on-node-pending-cancel` 两行接线；保留 `handleAgentGenerateNode`（核心生成入口，另有调用方） |
| 9 | `components/mobile/MobileCanvasShell.nodeActions.test.ts` | 改「窗态常驻即见确认/取消」断言为「窗态常驻状态 + 去对话处理可达」；删两 prop mock |

### 3.3 与「自动审批闸门」规格的交叉（必须显式处理）

未拍板规格 `2026-11-22-generation-auto-approve-gate-design.md` 在 §4.2 / §5 计划把「以后自动生成」快捷开关放到 `ProposeConfirmOverlay`（PC）与 `MobileNodeStatusBar` 的「确认/拒绝」旁。本次裁决后：

- 该规格的 **PC 场景内入口从 `ProposeConfirmOverlay` 改挂 `AgentTurnTimeline` proposal 卡操作区**（与「调整 / 取消」同区，唯一场景入口）。
- 该规格的 **移动场景内入口仍挂 `MobileNodeStatusBar`**，但不再与「确认/拒绝」并列，改为与「去对话处理」同条（本规格落地后该条已无决策按钮）。
- 该规格的状态徽标落点（`AgentSideRail.agent-system-layer` / 移动底部状态带）**不受影响**，仍按原规格。
- ⇒ 该规格实施前须按本条回写其 §4.2 / §5；本刀不搭车实现自动闸门。

---

## 4. 不变量（写进测试）

1. 对话时间线 proposal 卡的三动作（落锚生成 / 调整 / 取消）与页脚定位**完全不变**。
2. `POST /answers` 的 callId / decline 语义**完全不变**；画布上不再有第二处触发点。
3. 节点状态展示（待确认 chip + 提示词摘要、生成中计数 / 耗时、任务 sheet 入口）**逐字保留**。
4. 移动端「去对话处理」只切 Tab，**不发答案、不改节点状态**。
5. 服务端治理门、stagedActions、missing_refs 硬门禁**不变**。

---

## 5. 验收判据

- 静态守卫：`ProposeConfirmOverlay.vue` 文件不存在；`CanvasPage.vue` 无 `ProposeConfirmOverlay` 引用；`MobileNodeStatusBar.vue` 无 `confirm` / `cancel` emit，有 `go-chat` emit。
- 对话卡回归：`AgentTurnTimeline.proposal.test.ts` 三动作与定位仍绿。
- 状态带回归：`MobileNodeStatusBar.test.ts` / `MobileCanvasShell.nodeActions.test.ts` 断言状态文本保留、决策按钮消失、跳转可达。
- `design-token.test.ts` 绿（新增按钮只用 L2/L3 令牌，零 hex/rgba）。
- 生产 CDP 走查：PC 画布无确认胶囊、对话卡三动作可用；移动画布状态带显示「待确认·XXX」与「去对话处理」，点击落到对话 Tab 且 proposal 卡可见。

> 本规格不写 ALL_PASS。闭环判据以上线后生产复测为准。
