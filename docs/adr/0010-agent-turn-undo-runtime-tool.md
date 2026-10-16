# ADR-0010: 回合级撤销（撤销本轮）需要 runtime 批量移除工具 —— 立项评估，暂不实现

| 字段 | 值 |
|---|---|
| 状态 | 待立项评审（本 ADR 只做评估，**不拍板、不实现**） |
| 日期 | 2026-10-16 |
| 关联规格 | agent-composer-uiux P1-4.2 |
| 触发来源 | P1-4.1 回合产出收据行的「撤销本轮」按钮（UI 已落地，按钮 disabled 等此能力） |

## 背景

P1-4.1 在消息流末尾加了回合产出收据行，其中「撤销本轮」承诺把**最近一轮对话产出的全部画布节点**一次性移除。这是一个**批量、回合粒度**的删除动作，与现有的单节点操作不同。

本 ADR 回答一个问题：这个能力在现有 runtime 里有没有入口？没有的话，该怎么补？

### 基线核查（2026-10-16，worktree `feat/agent-composer-uiux`）

在 `apps/web/src` 与 `docs/` 范围 grep `deleteNode|removeNode`：**无任何现成入口命中**（唯一命中是本规格文档自身的原文）。也就是说：

- 前端没有「删除节点」类用户操作可以复用；
- services/pi-runtime 侧未核实出对等的批量移除工具（P1-4.2 规格即按「无现成入口」立项）。

## 考虑过的方案

| 方案 | 优点 | 缺点 / 风险 |
|---|---|---|
| **A. 新增 runtime 工具 `remove_turn_nodes`**（回合粒度批量移除） | 语义干净：以「轮次」为单位，runtime 侧天然知道本轮产出哪些节点；撤销是**可逆意图**的显式动作，未来可配合 checkpoint/回滚做真正的 undo | 需要走完工具分层全套纪律（见下节「影响面」）；L6 prompt 预算余量极小（AGENTS.md 记录余量 68 字符，以 `prompt-registry/PROMPT_SPEC.md` §5 为准）；「回合内产出」的归属口径需要先定义（哪些节点算本轮产出？用户手动改过的还算吗？） |
| **B. 复用既有图编辑通道**（前端把「撤销本轮」翻译成 N 次既有单节点编辑调用） | 不新增工具，零分层成本，UI 侧即可实现 | 现有通道是**单节点粒度**，逐个删除慢且中途失败会留下半删状态；如果既有通道也没有单节点删除（基线 grep 显示没有），此方案不成立，只是假复用 |

> 注意：方案 B 的前提「存在可复用的单节点删除入口」已被基线 grep 否定。把它保留在表里，是因为立项评审时若先补了单节点删除能力，B 会重新变成候选。

## 影响面：工具分层纪律（若走方案 A）

按 AGENTS.md「改工具分层 ⇒ 必答『哪个资产点名了它』」：

1. **点名问题**：新增 `remove_turn_nodes` 默认进延迟集前，必须回答 —— `prompt-registry` 规则或 `skills/*.md` 里，**哪个资产按名字点名了它？** 目前没有任何资产点名它。答不上来按「未点名」处理 ⇒ **必须常驻**。
2. **常驻即预算**：常驻意味着挤占 L6 prompt 预算（上限 3200 字符，权威值见 `prompt-registry/PROMPT_SPEC.md` §5 budget-table），加工具前必须先跑 `pnpm prompt:lint` 看余量。
3. **登记义务**：须在 `services/pi-runtime/src/tools/tiering.test.ts` 显式声明归属，并在 `docs/agent/tool-capability-catalog.md` 补四列登记（点名资产 × 归属 × 触发话术）。
4. **vendor 优先核查**（ADR-0009）：动手前先查 `vendor/earendil-works/pi/packages/coding-agent/docs/extensions.md` 与 vendor 代码，确认 pi 官方没有等价的批量移除/回滚能力（如 session 级 undo、checkpoint 恢复），有则必须用 vendor 的。

## 待立项评审时必须先回答的问题

1. 「本轮产出」的权威口径：以 `resolveMessageOutputs` 的产物清单为准，还是以 runtime 侧的节点创建记录为准？两边不一致时谁赢？
2. 用户在收据出现后手动改过/删除过部分节点，「撤销本轮」是全删还是只删仍存在的？
3. 撤销要不要做真正的可恢复 undo（配合 checkpoint），还是一次性删除？
4. 若走方案 A：点名资产如何补（先在 skill 里写触发话术，再下沉）？

## 结论

**待立项评审。** 本 ADR 不拍板方案、不排期。UI 侧的「撤销本轮」按钮保持 disabled + `title="需 runtime 批量移除工具，见 ADR"`，直到上述问题有结论、且 runtime 侧能力按分层纪律落地。

## 关联

- [ADR-0005](./0005-tool-tiering-official-dynamic-loading.md) —— 工具分层纪律的来源
- [ADR-0009](./0009-vendor-capability-first.md) —— 新增工具前的 vendor 能力面核查义务
- `AGENTS.md`「改工具分层 ⇒ 必答『哪个资产点名了它』」
- `docs/agent/tool-capability-catalog.md` —— 工具四列登记
- 规格：`docs/superpowers/plans/2026-10-16-agent-composer-uiux.md`（P1-4.1 / P1-4.2）
