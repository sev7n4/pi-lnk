# ADR-0011: 提议确认收敛为单一锚定表面，对齐上游 host-owns-UI 原则

| 字段 | 值 |
|---|---|
| 状态 | Accepted |
| 日期 | 2026-10-19 |
| 决策者 | 项目发起人 |

## 背景

用户从对话页点「提议生成」进入画布页后，同一个 `pending_confirm` 待确认态在画布窗态
（窗 B：画布 + composer + SSE 同屏）被渲染成**三个并存且都可操作**的表面，互相遮挡，
用户无法顺畅查看 / 修改提示词：

1. 对话流里的提议卡（`AgentSideRail.vue`，可操作）
2. 画布上 `pending_confirm` 节点（可操作）
3. 节点被选中 / 激活后**自动弹出**的 studio dock（`CanvasPage.vue:839`「单击图片节点 dock 正常弹出」）

代码里已意识到该冲突：`CanvasPage.vue:1900` 注释
「选中 → studio dock / 快捷工具行弹出，与拾取流互相踩（**三带叠罗汉扳机**）」。

**根因不是"我们做了 propose/ask_user"。** 上游核对结论（2026-10-13 规格 §1.4）已证实：
**pi-agent-core 内核无任何 ask/elicitation 工具**，HITL 仅 steer/followUp 队列 + 权限确认；
我们跑在自定义浏览器画布 host 上（非 coding-agent），自建 ask_user/propose 是合理且必要的超越层。

**真正的偏离在渲染层。** 上游 `coding-agent` 的交互模型是 **"host 拥有 UI，内核只管逻辑"**：

- 阻塞确认通过 host 的 `ui.confirm / select / input`（`ExtensionAPI`，
  `coding-agent/src/core/extensions/types.ts:135-141`）作为**单一 host 原生表面**呈现；
- 并用 `ui_prompt_start / ui_prompt_end`（同文件 `:745-759`）把"正在等用户"建模成一个事件；
- 工具结果由 host 通过 `registerTool` 的 `renderResult`（`:490-498`）渲染成 tool row。

即上游把"工具产出"与"阻塞确认"都收敛到 **host 单一表面**。我们把一次 propose 拆成
「对话卡 + 画布节点 + 自动 dock」三重并存表面，且对话卡与画布节点都承载同一待确认态的
可操作入口——既偏离上游原则，又比上游造得更重。这与 ADR-0009（先查 vendor 能力面、禁止自研
等价物）的精神一致：能力范式（host-native blocking confirm）上游已有，我们没对齐。

## 考虑过的方案

| 方案 | 优点 | 缺点 | 为什么没选 |
|---|---|---|---|
| 维持三表面并存（现状） | 改动最小 | 遮挡；用户无法顺畅改提示词；多表面状态易漂移 | ❌ |
| 确认全部收进对话流，画布只展示节点 | 单一表面简单 | 违背"画布是确认入口"的既有拍板（2026-10-06 规格）；用户被迫回对话页操作 | ❌ |
| **单一锚定表面：节点即确认面，dock 按状态门控（选中）** | 对齐上游 host-owns-UI；零遮挡；状态单一来源 | 需改造对话流渲染分支 + dock 门控 + 窗态；移动端需回归 | ✅ |
| 画布节点内联确认 + 对话卡仍保留可操作（折中） | 兼容性高 | 仍是双可操作表面，没根治遮挡 | ❌ |

## 决定

1. **单一事实来源 = 画布节点。** `propose_generation` 的产物只在画布上建一个 `pending_confirm`
   节点；该节点**本身就是确认表面**，内联渲染提示词摘要、参数（比例 / 分辨率 / 张数）与
   「确认 / 取消」，贴在节点上，不在画布上另飘一张独立对话卡。
2. **对话流降权为只读日志。** 切到画布上下文后，对话流里那条"提议生成"退化为**不可操作**
   日志项（"已提议生成：节点 X"），不再是一个可再点一遍的卡片。避免同一待确认态双份可操作入口。
3. **studio dock 按节点状态门控，不自动弹。** 节点处于 `pending_confirm` 时，主交互是
   确认 / 取消，**dock 不弹出**；仅当「确认 → 生成完成 → 用户主动选中」才打开 dock 做编辑 / 重绘。
   从状态机层面杜绝"三带叠罗汉"。
4. **窗态纪律。** 从对话流点"定位 / 查看"进入画布，意图是"去画布上看 / 改"，进入**纯画布态**
   （composer / SSE 收起），而非窗 B 同屏——同屏才让对话卡与画布节点同时出现。仅在用户明确要在
   画布上继续聊天才开 composer 同屏。
5. **保留既有确定性确认契约。** 节点锚定确认面仍走 `POST /agent/sessions/:id/answers(callId)`
   （2026-10-06 规格的确定性信号），不回退到状态枚举兜推；本决策只改"确认面在哪里 / 有几个"，
   不改"确认由什么信号担保"。
6. **协议语义向 `ui_prompt` 靠拢（低成本、可选）。** 把 `waiting_user` 的"阻塞态 vs 工具产出"
   在协议层区分清楚，命名对齐上游 `ui_prompt_start/end`；前端确认面复用节点组件而非另起一套卡片。
   不改变自有的画布 host。

## 后果

**正面**

- 画布窗态零遮挡，用户查看 / 改提示词顺畅
- 单一状态来源，消除多表面状态漂移风险（与 2026-10-06 规格的 stale-draft 教训同源）
- 与上游 "host owns UI" 模型对齐，未来 upmerge / 对齐成本更低

**负面 / 代价** ❗

- 需改造 `AgentSideRail` 的 propose 渲染分支（可操作 → 只读日志）+ `turnTimeline` 文案 / 角色
- `CanvasPage` 选中态需加"pending_confirm 不弹 dock"前置条件（`:839` 既有逻辑要改）
- 移动端"窗态"分支需回归（纯画布态 vs 同屏态）
- 对话流失去可交互的提议卡——但这是有意收敛，不是损失

**将来要注意**

- 若 vendor 后续为 pi-agent-core 增加浏览器画布 host 或更丰富的 tool-result 渲染原语，
  应优先替换我们的自建渲染，而非继续维护三重表面
- 新增任何"阻塞式 agent → 用户"交互（如新的 HITL 工具），必须先问"它会不会又在两个层各渲染一遍"，
  用本 ADR 的单表面原则把关

## 关联

- [ADR-0001](./0001-vendor-pi-as-kernel.md)（vendor pi 作内核）+ [ADR-0009](./0009-vendor-capability-first.md)
  （先查 vendor 能力面、禁自研等价物）—— 本决策是其精神在"确认渲染层"的落地
- 上游范式实证：`vendor/earendil-works/pi/packages/coding-agent/src/core/extensions/types.ts`
  `ui.confirm/select/input`（`:135-141`）、`ui_prompt_start/end`（`:745-759`）、
  `registerTool.renderResult`（`:490-498`）
- 既有 propose 契约（须保留）：`docs/superpowers/specs/2026-10-06-propose-confirm-deterministic-design.md`
- 既有"画布即确认入口"拍板（须延续）：同上规格 + 2026-10-13 规格 §1.4 行业对比
- 实现排期：`docs/superpowers/plans/2026-10-19-propose-confirm-single-surface.md`
