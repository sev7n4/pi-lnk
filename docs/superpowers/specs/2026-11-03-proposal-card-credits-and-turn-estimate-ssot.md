# 积分展示单一真相源 v2——SSE 对话卡（提议卡 / 产物卡）与回合流式预估

- **日期**：2026-11-03
- **状态**：实施中
- **前序**：`2026-11-02-points-display-single-source.md`（PR #682，dock 面板已收敛）——本篇是其生产复测暴露的残留面
- **归属**：P-SSOT 展示层收敛（非 P1 主线四包）

## 1. 生产复测暴露的两个残留点（用户实测，2026-11-03 01:21）

PR #682 上线后复测：WEB 节点 dock 已显示 33 ✓，但同一会话里仍有两处展示与账单对不上：

| # | 现象（移动端 SSE 对话流） | 实际账单 | 根因定位 |
|---|---|---|---|
| R1 | 提议生成卡「预计 10 积分」、产物卡「消耗 10 积分」 | 图像生成 -33（`v2-launch`） | **PR #674**（提议卡 UX 优化）新增卡片积分 pill，取数 `resolveProposalNodeData()` 兜底 `estimateImageCredits`（旧常量 10）；其预留的 `node.data.creditCost` 服务端权威位（C-later）从未被写入 ⇒ 恒走兜底 |
| R2 | 回合摘要「≈1 积分（预估）」 | 对话回合结算 -14/-7（token 反比率） | 流式预估走 `estimateCreditsFromUsdCost`（USD 成本×FX×毛利，Q2 2026-10-14 口径），结算走 `quoteTextTokens`（token 反比率）——**两套公式**；#682 规格 §12 登记的 P-later |

两处的共性：**展示公式 ≠ 计费公式**。计费侧（价目表 SSOT）自洽正确，坏在展示层另起炉灶。

## 2. 修复设计（延续「价目表 = 唯一真相源，改价零代码」不变式）

### 2.1 R1 提议卡 / 产物卡积分 pill

- `useProposalNodeData.ts` 新增 `proposalCreditCost(data)`，优先级：
  **服务端 `node.data.creditCost`（#674 C-later 接管位）> `GET /api/pricing/quote`（与计费同源同表）> 本地常量估算（仅端点不可达时的瞬时兜底）**。
- 实现约束：`resolveProposalNodeData` 是渲染期纯函数（模板逐帧调用），不能起 composable
  ⇒ 模块级 `reactive Map` 报价缓存 + inflight 去重：同步返回缓存值/本地兜底（防闪烁），
  quote 返回后响应式写回。fetch 失败 fail-soft 保留兜底，绝不抛错打断渲染。
- `AgentTurnTimeline.vue` 5 处取数（proposal 卡 预计/未扣减、artifact 卡 预扣/消耗/未扣减）统一改走 `proposalCredit()`。
- video/audio 节点：无本地常量可兜（`estimateImageCredits` 对它们本来就是错的）⇒ quote 未返回前返回 undefined，**pill 缺省不渲染（宁可不显示，绝不显示假数字）**。

### 2.2 R2 回合流式预估与结算同引擎

- `pricing.service.ts` 抽出纯公式 `computeTextTokenCredits(ratios, usage)`（单一真相）：
  `quoteTextTokens`（结算）与新方法 `prepareTextTokenQuote()`（预估预读）共用，**改一處两端生效**。
- `prepareTextTokenQuote(userId, modelKey)`：回合开始时预读一次价目表 token 比率
  （灰度/global 解析顺序与 quoteTextTokens 逐字同构），返回带同步 `compute()` 的计划；
  非 token 模型 / constants / degraded / 缺行 / 异常 → null（**静默**，回合级预读不刷 warn）。
- `agent.service.ts` 的 `estimateTurnCredits`：plan 存在 ⇒ 同步用 `plan.compute`（与结算同式，
  全零 usage 仍不出预估，杜绝 0 假象）；plan 为 null ⇒ 回落 USD 成本预估（即结算 degraded 兜底公式，口径仍一致）。
- 效果：流式「≈N 积分（预估）」与账单「对话回合结算」**同源同式**，只差流式中途 token 收敛；
  `turn_settled` 权威值覆盖机制（#682 已落地）不变，预估仍只是过程展示。

### 2.3 明确不做

- 不改价目表条目数值；不动 `node.data.creditCost` 的服务端写入（属画布写路径治理范围，#674 已留 C-later 接管位，本修复的优先级链已为其就位）。
- 不动 `CANVAS_TOOL_CREDITS`（画布本地工具，非 AI 计费）。

## 3. 验证判据

1. `pricing.service.test.ts`：核心契约 `plan.compute(usage) === quoteTextTokens(usage).credits` 逐笔相等（含 cacheWrite 并入 in、cache 行缺两形态）；非 token 模型/constants/DB 异常 → null 且静默。
2. `useProposalNodeData.credit.test.ts`：image 首帧兜底 10 → quote 后翻 33；同参去重单请求；video 未返回前 undefined；服务端 creditCost 优先不发请求；fetch 失败保留兜底。
3. `AgentTurnTimeline.creditQuote.test.ts`（组件契约）：quote=33 时 artifact done 卡显「消耗 33 积分」、proposal 卡显「预计 33 积分」——**展示值==计费值由构造保证**。
4. 改价生效路径：管理后台改 `image:1K:1` / `text:<model>:in` 任意行 ⇒ 卡片 pill 与账单同时变化，零代码改动。
