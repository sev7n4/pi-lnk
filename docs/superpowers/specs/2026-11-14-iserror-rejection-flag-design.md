# isError 语义补正：硬拒的 transcript / 事件 / 前端标志位（立项规格）

> 日期：2026-11-14 · 状态：待实施 · 触发：C-2a（#866）生产复测取证发现的**既有语义差异**
> 与 `2026-11-14-c2b-acceptance-canvas-state-design.md` 同一 PR 交付，两把刀各自 kill switch 可独立回滚。
> 按 v1.3 规格生命周期冻结：细化只进本文，路标不为此刀改正文。

## 1. 问题陈述

A-2' 幻觉 id 硬拒与 C-2a acceptance 证据不足硬拒，共用 `tools/todo.ts` 的 `rejectionResult()`：

```ts
// services/pi-runtime/src/tools/todo.ts:126-134
return {
  content: [{ type: "text", text }],           // 「调用被拒绝：… 当前清单保持不变 …」
  isError: true,
  details: { todo: { snapshot: getTodoState(key), diff: { updates: [] } } },
};
```

注释声称「`isError` + 当前快照 + `diff.updates=[]` ⇒ 前端零事件、store 零写入」。**零副作用属实**（`overwriteTodos` 未调用、前端 `extractTaskEvents` 因 `updates=[]` 返回空），但 C-2a 生产探针（session `c2a-probe-1794622717`）取证发现：

- `tool_execution_end` 事件 `data.isError=False`
- transcript `toolResult.isError=False`

⇒ 硬拒在可观测层与前端是**普通成功结果**，只有 content 文本在说「被拒绝」。这是一个语义不一致，本刀补正它。

## 2. 根因链（干净快照 `685bdb49`，vendor **0.99.2**，逐条 `文件:行号`）

| # | 事实 | 位置 |
|---|---|---|
| 1 | ⭐ **`executeToolCall` 恒返回 `{result, isError: false}`，完全不读 `result.isError`**；只有 `catch`（工具抛异常）才 `isError:true` | `vendor/.../harness/execution/tools.ts:138-153` |
| 2 | `AgentToolResult<T>` 类型**不含 `isError`**（字段是 `content` / `details` / `usage` / `addedToolNames` / `terminate`）—— 我们塞的 `isError` 是多余字段，被中继挑字段丢弃 | `vendor/.../agent/src/types.ts:362-376`；`tools.ts:166-180` |
| 3 | `finalizeToolCall`: `isError: patch?.isError ?? executed.isError` —— **唯一入口是 after_tool patch** | `tools.ts:178` |
| 4 | `createToolResultMessage`: `isError: call.isError` ⇒ transcript `ToolResultMessage.isError` | `tools.ts:202` |
| 5 | `HookMap["after_tool"]["result"]` 允许 `isError?: boolean`；聚合器 `if (result.isError !== undefined) aggregate.isError = result.isError` 且链式 replace 传给后续 listener | `vendor/.../harness/agent-harness.ts:478-484`；`harness/hooks.ts:294-324` |
| 6 | ⭐ **patch 时序正确**：`after_tool` → `finalizeToolCall` → `createToolResultMessage`，之后下一轮才发 LLM 请求 ⇒ patch 早于 message 生成，无竞态 | `vendor/.../harness/runtime/drive/tools.ts:410-433` |
| 7 | `throw` 路径 `createErrorToolResult()` 置 `details: undefined` ⇒ **丢失快照证据** | `tools.ts:60-65, 149-153` |
| 8 | 聚合器对每个 listener 的异常 `catch + reportError`，无注册则 `aggregate` 空 ⇒ **fail-soft** | `hooks.ts:305, 325-331`；`session-manager.ts:1708-1710` |
| 9 | `TaskDiffSchema` 是 `z.object`（默认 strip）；硬拒时 `diff.updates=[]` ⇒ `extractTaskEvents` 本就 `return []` | `apps/server/.../pi-events.ts:579, 626, 645` |

## 3. ⭐ 收益定位纠偏：模型看不到 `isError`

**这是本刀最重要的裁决，写进正文以防止过度宣称。**

生产模型装配走 `openai-completions`（`services/pi-runtime/src/model-assembly.ts:86-90, 102`；BYOK 同款 `:219, 237`）。该适配器把 `toolResult` 转成 `role:"tool"` 消息时**只取 content 文本**（`vendor/.../ai/src/api/openai-completions.ts:1398-1420`），丢弃 `isError`。其他 provider（Anthropic `is_error`、Bedrock `ToolResultStatus.ERROR`、Google、Mistral `[tool error] ` 前缀）会带错误标志，但**生产主路径不带**。

⇒ **无论 return / throw / patch，模型所见字节不变**。硬拒之所以有效，靠的是 `content` 里的「调用被拒绝：…」文本（A-2' 生产自纠 1/1 已证文本有效），不是标志位。

**因此本刀定位为「transcript / 事件 / 前端错误态的语义补正」，明确不宣称改善模型行为、不改变零副作用机制、不改变任何拒绝文案。**

## 4. 五项裁决

### E1 · 选 `after_tool` patch，不选 throw、不选纯文档

| 方案 | 模型可见 | 前端/事件可见 | details 证据 | 零副作用 | 裁定 |
|---|---|---|---|---|---|
| (a) execute 内 `throw` | ❌ | ✅ | ❌ **丢失**（`details:undefined`） | ❌ 断 todo 事件链 | **否决** |
| (b) `after_tool` patch `isError` | ❌（§3） | ✅ | ✅ 完整保留 | ✅ | **采纳** |
| (c) 只补文档 | ❌ | ❌ | ✅ | ✅ | 否决（不解决问题） |

(b) 是 vendor 一等机制（§2 事实 3/5/6），不动工具实现、不改 content、不改 details 语义。

### E2 · 识别硬拒用显式 details 标记，不靠文本匹配

`after_tool` event 里 `isError` 恒为 `false`（`drive/tools.ts:422` ← `tools.ts:148`），`result.isError` 不在 event 中 ⇒ 无法直接判定。三种候选：

- content 文本前缀匹配「调用被拒绝」——脆（文案一改就失效，且模型可见文本属行为契约）。**否决**。
- `toolName==="todo_write" && diff.updates.length===0` —— 会把「空清单清空」等合法调用误判。**否决**。
- ⭐ **`details.todo.rejected: true` 显式标记**：`rejectionResult` 单点写入；listener 用 `readRecord` + `readBooleanField`（`src/hook-contract.ts:36, 61`）守卫读取，形态不符 fail-soft 返回 `undefined`。**采纳**。

A-2' 幻觉 id 硬拒与 C-2a/C-2b acceptance 硬拒共用 `rejectionResult` ⇒ 一处标记覆盖全部硬拒，自动一致。

**兼容性确证**：`TaskDiffSchema` 是 `z.object`（默认 strip）⇒ `details.todo` 多一个 `rejected` 字段不会让 `safeParse` 失败（§2 事实 9）。

### E3 · 注册序：新 listener 排最前

`index.ts` 的 `onSessionCreated` 里现有注册序为 `registerCanvasIdBindingHooks` → 合并 after_tool listener（propose/体积/截断/视频纠偏）→ `registerResultSignalListener`（`index.ts:99, 105, 155`，注释明确「注册序即正确性」）。

⇒ 新增 listener 注册在 **`registerCanvasIdBindingHooks` 之前**，返回 `{isError:true}` 后，后续所有 consumer 经 `hooks.ts:310, 322` 的链式 replace 看到 `event.isError=true`，其 `!event.isError` 分支正确短路（硬拒本就不该触发 id 绑定 / 提议记录 / 信号注入）。

### E4 · 独立 kill switch + fail-soft

- `PI_RUNTIME_REJECTION_FLAG=off` ⇒ 不注册 listener，逐字节回到本刀前行为（与 `isAcceptanceEnabled()` 读 `PI_RUNTIME_ACCEPTANCE` 同款：在模块内直接读 `process.env`，不扩 `runtime-config.ts` 的类型/测试面）。
- `harness.hooks` 缺席 ⇒ 不注册（沿用 `session-manager.ts:1710` 的 fake harness 守卫纪律）。
- 守卫读取失败（details 形态不符）⇒ `return undefined`，不打日志风暴、不抛错。

### E5 · 副作用逐条裁定（**这是对抗性审视的重点**）

patch `isError=true` 会改变多个下游分支，逐条核实：

| 下游 | 代码 | 影响裁定 |
|---|---|---|
| `extractTaskEvents` 的 `if (d.isError) return []` | `pi-events.ts:625` | ✅ **零影响**：硬拒时 `diff.updates=[]`，不短路也 `return []`（`:645`）。**加测试锁死此不变量** |
| `extractCanvasCommands` / `canvas_actions` / `extractPlanProposedEvent` 的同类门控 | `pi-events.ts:482, 546, 697` | ✅ 零影响：`todo_write` 不产 canvasCommands / plan 载荷 |
| `result-signal-wiring` 的 `event.isError ? signalFromErrorContent(...)` | `result-signal-wiring.ts:92` | ✅ 零影响：`signalFromErrorContent` 只匹配 `\bhttp ([1-5]\d{2})\b`（`result-signal-listener.ts:51-62`），硬拒文本无 HTTP 码 ⇒ `undefined` ⇒ 零接触、不打点 |
| `appendVideoContract(..., event.isError, ...)` | `index.ts:135-148` | ✅ 零影响：只对 `upsert_media_node` 生效 |
| `metrics.observeEnd({isError: true})` 工具错误率 | `session-manager.ts:1606-1615` | ⚠️ **预期变化**：硬拒计入工具失败率。语义正确（拒绝确实是错误），但监控面板会看到 `todo_write` 错误率上升 —— 写进 PR 正文与上线取证，不掩饰 |
| 前端 `executionTraceReducer` 标 `failed` | `executionTraceReducer.ts:400-401` | ✅ **期望改善**：用户在执行轨迹里看到「被拒绝」而非「成功」 |
| `tool_end` 事件 / 409 重连对账 `runningTools[].isError` | `drive/tools.ts:284`；`session-manager.ts:200, 275` | ✅ 语义修正为 true，无逻辑分支依赖它做硬拒特判 |

**不可接受的变化（守卫覆盖）**：拒绝文案逐字节不变、details 结构除新增 `rejected` 外不变、store 零写入、task 事件仍为 `[]`、模型可见 content 不变。

## 5. 接口设计（要点）

| 位置 | 改动 |
|---|---|
| `tools/todo.ts` `rejectionResult` | `details.todo` 增 `rejected: true`；`TodoResult` 类型同步（新增可选字段，不破坏既有断言） |
| 新 `src/tool-rejection-flag.ts` | `export function registerToolRejectionFlag(hooks: Hooks | undefined): void` —— 注册 after_tool listener；kill switch 在模块内判定 |
| `src/index.ts` `onSessionCreated` | 在所有既有 after_tool 注册**之前**调 `registerToolRejectionFlag(harness.hooks)` |
| 新 `src/tool-rejection-flag.test.ts` | 纯函数 / fake hooks 单测：标记命中 ⇒ patch、缺标记 ⇒ undefined、形态异常 ⇒ fail-soft、kill switch ⇒ 不注册、注册序可由调用点守卫覆盖 |
| 新 wiring 守卫 | 源码文本锁：`index.ts` 的注册调用位于 `registerCanvasIdBindingHooks` 之前；`todo.ts` 的 `rejectionResult` 含 `rejected: true` |

## 6. 验证计划

1. **TDD**：先写 `tool-rejection-flag.test.ts`（含 vendor 聚合语义的 fake hooks 模拟）⇒ RED，再实现 ⇒ GREEN。
2. **真实 harness 集成例**：用 `session-manager.tool-execution.test.ts` 同款姿势构造一次 `todo_write` 硬拒，断言 `tool_execution_end.isError===true` 且 `details.todo.diff.updates===[]` —— **不能只测纯函数**（记忆纪律：守卫须行为级）。
3. **回归**：`extractTaskEvents` 现有测试 + 新增「硬拒载荷（含 rejected 标记）仍返回 []」用例；`pi-events` 侧不改动但需证明兼容。
4. **变异自检（每项必须 RED）**：① 去掉 `rejected` 标记 ② listener 恒返回 undefined ③ kill switch 失效 ④ 注册序移到最后（由 wiring 守卫捕获）⑤ `rejectionResult` 删 `diff.updates=[]`。判 RED 用完整 stdout 的 `AssertionError` / `failing tests` 标记。
5. **生产复测**（合并上线后）：真实会话触发一次幻觉 id 硬拒，取证 `tool_execution_end.isError=true` / `toolResult.isError=true` / 快照不变 / 前端轨迹标 failed；同时确认模型自纠仍靠文本（1/1 或如实说明 429 阻断）。

## 7. 诚实边界与 No-Go

- ⚠️ **不宣称改善模型行为**：生产 `openai-completions` 丢弃 `isError`（§3），模型所见字节不变。若未来切到 Anthropic/Bedrock provider，届时 `isError` 才对模型可见，需重新评估（本刀不预设）。
- **不改 vendor**：`No-Go: patch vendor`（路标既有纪律）。只用 vendor 公开的 HookMap patch 能力。
- **不把 return 改 throw**：会丢 `details.todo.snapshot` 证据、断事件链（§2 事实 7）。
- **不改任何拒绝文案**：A-2' 自纠 1/1 建立在现有文本上，文案属行为契约。
- **不碰 C-2a 已合并代码的其他语义**：本刀只加标记 + 加 listener。
- 与 C-2b 同 PR 交付但**独立可回滚**：`PI_RUNTIME_REJECTION_FLAG=off` 只关标志补正，`PI_RUNTIME_ACCEPTANCE=off` 只关 acceptance 校验。
- 429 实名墙仍阻断模型侧行为复测（run3/run4 实证），**不冒充全绿**：工具级/事件级证据足，模型自纠面待墙解锁补测。

## 8. 回滚

- 一行：`PI_RUNTIME_REJECTION_FLAG=off` ⇒ 不注册 listener，transcript/事件/前端逐字节回到本刀前。
- `details.todo.rejected` 是 additive 字段，前端 `z.object` strip 掉，回滚后残留也无害。
