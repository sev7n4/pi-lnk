# 意图去重误杀 + 失败轮不可重试：规格与根因结论

> 2026-11-28 生产只读取证（会话 `cmx05m9d200a6pb01n0dxfvd7`）。
> 本文同时覆盖：用户要求的 5 条改进建议，以及「已超时」背后的真实失败原因定位。

## 1. 事实链（全部来自生产只读取证）

| 时间（UTC） | 事实 | 证据 |
|---|---|---|
| 10:02:59 | 模型 `agnes-2.5-flash` 返回一条 assistant 消息，含 `toolCall{id:"", name:"", arguments:{}}` | pi-runtime `events.jsonl` seq 39288 |
| 10:03:00 | harness 把空 call 执行为 `Tool "" is unavailable`，写出 `toolResult{toolCallId:"",toolName:""}`；该消息**进入 transcript** | seq 39290–39293 |
| 10:03:20 / 10:03:54 / 10:42:07 / 10:42:26 | 连续 4 轮 `400 invalid_request_error / json_parse_error`：`messages[135]` 与 `messages[55]: missing field tool_call_id`；0 tokens | seq 39298 / 39307 / 39316 / 39325 |
| 10:03:51 | 手工 compaction 完成，但坏消息仍在 ⇒ 400 复现 | seq 39300–39307 |
| 10:41:59 | 第一条「继续推进」→ run `01a221bf`，27ms 失败、0 tokens、仍结算 1 积分 | Nest 事件账本 + IdempotencyRecord |
| 10:42:xx | 该轮幂等记录 `normalizedIntent="继续推进"`, `status="completed"`（**失败被记为完成**） | `IdempotencyRecord ik_..._5d1w` |
| 10:42:xx | 第二条「继续推进」命中 `findDuplicateIntent`（60s 窗 + completed）⇒ 直接 `turn_not_submitted` + 「已为你复用」，**未开 run、未落消息** | controller 去重分支 |
| 截图 | 首轮回复显示「已超时」——这是 `ask_user` 终态卡的 `expired → 已超时` 文案，**不是本轮 400 的原因** | `AgentTurnTimeline.vue` 终态映射 |

## 2. 根因判定（用户关注的三问）

### 2.1 是否没吃满上游？——**部分是**

- 上游 `@earendil-works/pi-ai@0.99.2` 的 `transformMessages` 已具备：孤儿 toolCall 补合成结果、跳过 `stopReason=error/aborted` 的 assistant、`normalizeToolCallId` 跨渠道归一。
- 但它**不处理 `id="" / name=""` 的畸形 toolCall**：空 call 被 harness 当成真实工具执行，写出空 `toolCallId` 的 toolResult，随后 `openai-completions.js` 原样发出 `tool_call_id: ""`，agnes 反序列化报 missing field。
- 项目已在 `before_compaction` / `transform_context` 挂了宿主 hook（`trust-boundary.ts`、`compaction-retention.ts`），说明**接线通道已存在**；把「畸形 toolCall 入库前剔除/补全」接进 `transform_context` 属于接线，不是另造一套上下文引擎。
- 错误分类方面：`packages/shared/src/generationDiagnostics.ts` 已有 `invalid_input` 规则与脱敏文案，但 Nest 侧 `classifyPiRunError` 只有 5 类（无 invalid_input）⇒ 400 落 `unknown`，前端无法给出真实提示。**应复用 shared 的字面规则，不新造分类器。**

### 2.2 是否自身架构/产品缺陷？——**是，且是本次直接可改的部分**

1. `completeIdempotencyKey()` 在 stream 收尾**无条件**写 `completed`，没有失败出口（schema 允许 `error` 但零写入方）⇒ 失败轮污染去重窗。
2. 意图指纹用 prompt 文本，控制性语句（「继续推进」）也参与 ⇒ 失败后最需要重发的语句被误杀。
3. 命中去重时只发固定文案「已为你复用」，**没有 reconcile、没有产物回填**，文案与事实不符。
4. UI 的「已超时」来自历史 `ask_user` 过期卡，与本轮 400 无关 ⇒ 用户被误导到错误方向。
5. 0 tokens 的失败轮仍结算 1 积分（独立问题，另案）。

### 2.3 是否重复造轮子带来的缺陷？——**间接是**

- 项目有 3 套错误分类（`pi-runtime/llm-error-class.ts`、`server/pi-runtime/pi-events.ts`、`shared/generationDiagnostics.ts`），规则不共享 ⇒ 同一会话的生图 400 已归类 `invalid_input`，对话 400 却落 `unknown`。
- 宿主自建 compaction 摘要 hook、trust boundary、tool-result budget 等上下文改写层，但**没有任何一层做最基础的 toolCall 结构校验** ⇒ 造了很多上层能力，漏了入口卫生。
- 结论：本次不新增引擎/表/分类器；只在既有结构上收窄与补状态出口。

## 3. 等价物检索结论表（第一原则：吃满上游、接线优先于新建）

| 需求 | 已有等价物 | 决策 |
|---|---|---|
| 同句重发防护 | `intent-dedup.ts` + `IdempotencyRecord` + controller 门 | **收窄**，不新建去重表 |
| 失败状态 | schema `status` 注释已允许 `error` | **补写入方**，不改 schema |
| 去重命中结构化原因 | `turn_not_submitted{reason}` 事件 + store `turnRefusal` | **扩展字段**，不新增事件 |
| 产物复用/文案 | `resultSummary` 字段 + `checkIdempotencyKey` | **读真实字段**，做不到就不说「复用」 |
| 强制重发 | `sendMessage(message, _, isRetry)` + composer | **加 force 参数**，不新增发送通道 |
| 错误分类 | `shared/generationDiagnostics` 的 `invalid_input` 字面规则 + 脱敏 | **接线复用**，不在 Nest 新造分类器 |
| 畸形 toolCall 清洗 | 上游 `transformMessages` + 已有 `transform_context` hook | **另案接线**（本次不改运行时语义） |

## 4. 5 条建议的落地规格

### S1 收窄去重触发面
- 新增 `isDedupEligibleIntent(prompt)`：仅明确生成/创作动作（`生成/画/绘制/创作/制作/出图/生图/做一张/视频/image/generate/draw/create…`）参与去重；控制性/继续类语句（`继续推进/继续/下一步/重试/再试一次/然后呢/continue…`）不参与。
- `isRegenerationIntent` 保留且优先。
- 服务端登记时：不可去重意图写 `normalizedIntent = null`（仍保留随机幂等键语义）。
- 验收：`normalizeIntent('继续推进')` 仍返回原文，但 `isDedupEligibleIntent('继续推进') === false`。

### S2 失败轮写 error
- 新增 `failIdempotencyKey(key, reason)`：`status='error'`，`resultSummary` 写脱敏后的短原因（≤500）。
- `streamConversation` 记录本轮是否出现 `type='error'` 事件或抛错；收尾按 `failed ? fail : complete` 分支。
- `findDuplicateIntent` 查询条件维持 `processing|completed`（error 天然立即可重试）。
- 验收：失败轮后同句再次提交**不再命中**去重；成功轮仍命中。

### S3 结构化原因 + 真实文案
- `findDuplicateIntent` 保持 boolean（兼容既有 mock）；新增 `getDuplicateIntent(threadId, normalizedIntent, windowMs)` 返回 `{status, createdAt, resultSummary} | null`（`IdempotencyRecord` 无 runId 列，不新增字段）。
- `turn_not_submitted` 扩展 `data.reason = 'duplicate_intent'` 并带 `detail: {status, createdAt, hasResult}`。
- 文案按事实分三种：
  - `processing` → 「这条内容仍在处理中，未重复提交。」
  - `completed` 且有 `resultSummary` → 「相同内容刚已完成：{摘要}；未重复提交。」
  - `completed` 无摘要 / 其他 → 「相同内容在 1 分钟内已提交，但未找到可复用的结果；如需重新生成请点『仍要发送』。」
- **删除「已为你复用，无需重复发送」这句无条件断言。**
- 错误分类：`classifyPiRunError` 的 `PiRunErrorKind` 增加 `invalid_input`，复用 shared 的 `invalid_request` 字面族但不带 `\\b`（生产文本是 `invalid_request_error`，词边界会被下划线吃掉）；UI 显示真实错误类型而非过期卡文案。

### S4 强制重发入口
- DTO `ConversationDto` 新增可选 `force?: boolean`（由 composer 传）。
- controller 去重门：`if (!dto.force && ...) { ... }`。
- store `turnRefusal` 扩展 `'duplicate_intent'`；前端 callout 显示真实文案 + 「仍要发送」按钮，点击调用 `sendMessage(message, undefined, true, {force:true})`（保持既有 isRetry 语义，新增 force 末位参数）。
- 不新开气泡、不落库拒绝轮（与既有 turnRefusal 契约一致）。

### S5 真 reconcile / 不说谎
- 优先读 `resultSummary` 作为可复用产物摘要；无摘要不宣称复用。
- 若上一轮 `status='processing'`，文案引导等待而非重发；若 `error`，根本不命中去重门（S2 保证）。
- 不做跨服务产物回填（当前无可靠锚点），因此文案只陈述「已提交 / 已完成 / 有摘要」，不承诺产物已插入画布。

## 5. 明确不在本次范围
- 畸形 toolCall 的 transcript 清洗（根因层，需单独规格 + 上游 hook 验证）。
- 0 tokens 仍计费的结算问题（独立计费缺陷）。
- 三套分类器合并（影响面大，另案）。
- 合并 / 部署 / 生产复测需单独授权。
