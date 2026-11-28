# 畸形 toolCall 污染 transcript：进 LLM 前清洗（根因修复）规格

## 1. 事实与问题

生产会话 `cmx05m9d200a6pb01n0dxfvd7` 事件账本（`/data/sessions/<id>-a3b344ae/events.jsonl`）：

| 时间(UTC) | 事实 | 证据 |
|---|---|---|
| 18:02:59 | `agnes-2.5-flash` 产出 assistant 消息，content 含 `toolCall{id:"", name:"", arguments:{}}`（文本混 base64 SVG / `</parameter>`） | seq 39288–39289 |
| 18:03:00 | harness 将空调用执行为 `Tool "" is unavailable`，写出 `toolResult{toolCallId:"", toolName:""}` | seq 39290–39293 |
| 18:03:20 / 18:03:54 / 18:42:07 / 18:42:26 | 连续 4 轮上游 `400 invalid_request_error: messages[135/55]: missing field tool_call_id`，0 tokens | pi-runtime 日志 |
| 18:03:51 | compaction 完成后仍复现：坏消息留在 transcript，压缩不清除 | 事件账本 |

结论：**一次畸形工具调用永久污染会话**，其后每一轮都 400；UI 侧却显示历史 expired 卡文案「已超时」并叠加去重误杀。

## 2. 等价物检索结论表（第一原则：吃满上游、接线优先于新建）

| 候选等价物 | 已有能力 | 是否能解决本问题 | 结论 |
|---|---|---|---|
| `@earendil-works/pi-ai@0.99.2` `transformMessages`（`dist/api/transform-messages.js`） | 跨模型 thinking 转换、toolCallId 归一化、孤儿 toolCall 自动补 synthetic toolResult、跳过 errored/aborted assistant | **不能**：只按 id 记账，不校验 id/name 非空；空 id 被当成合法 key 透传；补齐逻辑反而会为畸形调用再造空 id 结果 | 接线调用，不重写；在更上游增加结构卫生 |
| `@earendil-works/pi-agent-core@0.99.2` `transform_context` hook | `performGeneration` 中先于 `toProviderMessages`/`transformMessages` 执行（`execution/assistant.js:64-67`），多 listener 链式 merge；`before_compaction` 是整体替代、不适合只改 messages | **能**：现成切入点，项目已有 `applyTrustBoundary` 使用该通道 | 复用同一 hook，新增独立 listener，不造新管道 |
| 项目 `trust-boundary.ts` `applyTrustBoundary` | 纯函数、目标复述 + 工具结果来源标注 | 能承载但不该合并：其开关 `PI_RUNTIME_TRUST_BOUNDARY` 语义不同，关闭它不应关闭结构卫生 | 独立纯函数 + 独立 listener，注册在 trust boundary **之前**（链式下后者看到清洗后的干净消息） |
| 项目 `hook-contract.ts` `readRecord/readStringField` | strict 形态读取（不静默 `as`） | 配套用：判断 toolCall 块 / toolResult 字段形态 | 复用，不新造形态守卫 |
| `before_payload` 图片治理 |  Provider payload 层裁剪 | 晚于 `toProviderMessages`，空 id 此时已生成 | 不采用 |

## 3. 规格

### R1 清洗规则（纯函数，输入 `AgentMessage[]`）

1. assistant content 中 `type === "toolCall"` 且 **`id` 或 `name` 不是非空字符串**（含全空白）→ 剔除该 block；记录被剔除的 id 到 `droppedIds`。
2. `role === "toolResult"` 且 `toolCallId` 不是非空字符串 → 剔除整条消息。
3. `role === "toolResult"` 且 `toolCallId ∈ droppedIds` → 剔除整条消息（避免只删调用留下孤儿结果）。
4. assistant 因规则 1 变成零 content 且原本只有 toolCall → 整条 assistant 消息剔除；若还有 text/thinking 等其他 block，保留其余内容。
5. 其余消息逐字节原样返回（引用相同对象），无命中返回 `undefined`。
6. 不修改 transcript 磁盘内容：清洗只作用于发送给 LLM 的上下文快照，历史仍完整可审计。

### R2 接线

- 新文件 `services/pi-runtime/src/tool-call-sanitizer.ts`，导出纯函数 + `count...`（可选）。
- `index.ts` `onSessionCreated` 内在 `trustBoundary` listener **之前**注册独立 `transform_context` listener：
  - `PI_RUNTIME_TOOL_CALL_SANITIZATION`（默认 true，`parseBool`）关闭时不注册；
  - 命中时 `console.warn` 一次计数摘要（不打印 transcript 正文，避免 base64 噪声）；
  - 打点 `metrics.observeToolCallSanitization(removedCalls, removedResults)`。
- 子 harness 同一 `onSessionCreated` 路径自动覆盖。

### R3 观测

`Metrics` 增加累计计数 + `/metrics` 输出：
- `pi_runtime_tool_call_sanitized_calls_total`
- `pi_runtime_tool_call_sanitized_results_total`
未打点时输出 0，便于确认开关是否生效。

### R4 不做

- 不改上游包、不加 patch、不改 provider payload 结构。
- 不做「空 id 自动补随机 id」：补出来的结果没有对应工具语义，会伪造模型输出。
- 不在本次改结算（0 tokens 仍扣 1 积分是独立问题）。
- 不在本次推送/合并/部署。

## 4. 验证计划

- Node test（`node --import tsx --test`）：空 id/name、孤儿 toolResult、混合 text 保留、零命中返回 undefined、不修改输入对象、compaction 后重复请求仍清洗。
- **边界验收**：直接调用上游 `transformMessages` 喂入生产形态的畸形历史——未清洗时确实漏出空 `tool_call_id`，清洗后输出不再含空 id（证明修复落在真正的 provider 入口之前）。
- metrics 单测：计数与输出行。
- `services/pi-runtime` 全量 `npm test`、`tsc --noEmit`。
- 变异自检：把「剔除空 id」改成放行，相关测试必须变红。
