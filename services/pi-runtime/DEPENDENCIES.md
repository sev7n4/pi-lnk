# pi-runtime 的 vendor 能力清单

> 记录 `services/pi-runtime` 对 `@earendil-works/pi-*` 各子包的**使用情况与理由**。
> 目的：让"是否吃满内核能力"变成**可核对的事实**，而不是靠印象。
>
> 依据：[ADR-0009](../../docs/adr/0009-vendor-capability-first.md)。最近核对：2026-10-03。

## 一、子包使用现状

vendor 有 **11 个子包**，当前 **2 个在用**：

| 子包 | npm 名 | 用量 | 状态 | 理由 / 缺口 |
|---|---|---|---|---|
| `agent` | `@earendil-works/pi-agent-core` | 14 处 | ✅ **核心依赖** | Agent 运行时、tool use、hook（`before_tool` / `transform_context`） |
| `ai` | `@earendil-works/pi-ai` | 2 处 | ✅ 在用 | 模型调用、类型 |
| `client` | `@earendil-works/pi-client` | 0 | ⚠️ **待确认** | 交互式客户端？我们跑在 Nest + Web 场景，可能不需要 |
| `chord` | `@earendil-works/chord` | 0 | ⚠️ **待确认** | 编排/协作相关，**未评估** |
| `coding-agent` | `@earendil-works/pi-coding-agent` | 0 | ⚠️ **待确认** | ⚠️ **但它的 `docs/extensions.md` 是我们的扩展面权威文档** —— 不用它的代码，却必须读它的文档 |
| `protocol` | `@earendil-works/pi-protocol` | 0 | ⚠️ **待确认** | 协议定义，可能已由 agent-core 传递 |
| `server` | `@earendil-works/pi-server` | 0 | ⚠️ **待确认** | server 形态？我们用 fastify 自建，**可能刻意不用** |
| `session-backends` | （无 package.json） | 0 | ⚠️ **待确认** | 会话后端，值得单独评估 |
| `telemetry` | `@earendil-works/pi-telemetry` | 0 | ❗**疑似欠账** | 观测能力，我们自建了 metrics（见下"已知自研"） |
| `tui` | `@earendil-works/pi-tui` | 0 | ✅ **大概率不需要** | 终端 UI，我们是 Web 画布 |
| `evals` | `@earendil-works/pi-evals` | 0 | ❗**疑似欠账** | 评测能力，本仓库有 `packages/pi-poc`（5/5 PASS）但没接这个 |

> ⚠️ = 待确认 ≠ 吃不满。**确认后把理由写回本文件**，别让"未用"变成想不起来为什么。

## 二、已用到的 vendor 能力面

从 `vendor/earendil-works/pi/packages/coding-agent/docs/extensions.md` 对照：

| 能力 | 用在哪 | 状态 |
|---|---|---|
| `before_tool` hook | 7 个文件 | ✅ 已用 |
| `transform_context` | 5 个文件 | ✅ 已用（ADR-0008的信任边界） |
| `compact`（上下文压缩） | 19 个文件 | ✅ 已用 |
| thinking level | 6 个文件 | ✅ 已用 |
| `fork`（后端线程截断） | 4 个文件 | ✅ 已用 |
| `registerTool` | 0 | ⚠️ 属**coding-agent**（非依赖包，见下方「层次纠正」）。核心里等价物 `setTools`/`setActiveTools` **也是 0 调用** ⇒ 真欠账，见 [四节 T2](#四待办把待确认变成结论) |
| `pi.on(...)` 事件订阅 | 15+2 个事件类型 | 🔴 **原记「0/未用」有误** —— 我们用的是 `harness.events.on`（agent-core），**已在用**。`pi.on` 属 coding-agent，不可用 |
| **`watch` / `resnapshot`（断线重连）** | 0 | ❗ **真欠账，且原先完全未登记**。`LaneTranscriptSnapshot` 注释明写「remote consumers」= 跨进程就是它的目标场景，见 [四节 T1](#四待办把待确认变成结论) |
| **subagent** | 0 | ❗ **pi 0.85.1 无 subagent 支持**（全仓 0 命中），需 L2 自建（嵌套 Agent 实例或复用 Lane） |

### ⭐ 层次纠正：`pi.on` / `registerTool` 不是 pi-agent-core 的能力（2026-10-04 复核）

上面两行曾长期记成「未用 vendor 扩展机制」，**前提是错的**，会导出「把 SSE 事件流切到
coding-agent 的 `pi.on`」这种架构级误判。实测结论：

| 层 | 包 | 我们是否依赖 | 该层扩展面 |
|---|---|---|---|
| 内核 | **`pi-agent-core`** | ✅ **唯一依赖** | `AgentHarness.events.on` ✅已在用· `harness.hooks.*` ✅ 已在用 · `setTools`/`setActiveTools` ❌ 未用 · `watch`/`watchSession` ❌ 未用 |
| 宿主 | `pi-coding-agent` | ❌ 未依赖 | `pi.on` / `pi.registerTool` / `registerCommand` / `registerShortcut` / `registerFlag` / `ui.*` / `navigateTree` —— 全部绑定**交互式终端会话**（Ink TUI、CLI 参数、ResourceLoader） |

判据：`interface ExtensionAPI` 全仓唯一实现在
`packages/coding-agent/src/core/extensions/types.ts:1252`；
`git grep "pi\.on\b" -- packages/agent/` → **0 命中**。

> **别再把 coding-agent 的 API 当 pi-agent-core 的能力面。** `docs/extensions.md` 是扩展面**全景**，
> 但**不在我们这一层**。ADR-0006「Nest 作宿主」的技术选型没错，错的是为此自研 `buffer`+`seq`+重放
> （vendor 的 `watch` 提供了快照+重取，见四节 T1）。

**扩展面全景**（`extensions.md` 的目录，供规划时对照）：
Events（Lifecycle / Resource / Session / **Agent** / Model / **Tool** / User Bash / Input）·
ExtensionContext（`ui` / `sessionManager` / `modelRegistry` / `isIdle` / `abort` /
`hasPendingMessages` / `shutdown` / **`getContextUsage`** / `compact` / `getSystemPrompt`）·
ExtensionCommandContext（`getSystemPromptOptions` / `waitForIdle` / `newSession` / **`fork`** /
`navigateTree` / `switchSession` / `reload`）·
ExtensionAPI（**`registerTool`** / `sendMessage` / `sendUserMessage` / `appendEntry` / `setSessionName`）

## 三、已知自研（可能与 vendor 重叠，需持续对照）

| 自研物 | 为什么自研 | 与 vendor 的关系 |
|---|---|---|
| 工具分层（常驻/延迟） | ~~自研索引块方案~~ | ❗**已失败并改为对齐官方**（PR #100，见 ADR-0005） |
| SSE 事件流 + lastEventId | Nest 作宿主，需要跨进程 | ❗**原判断「vendor 跨进程不是它的问题」有误**。vendor 有 `watch()`+`LaneTranscriptSnapshot`（注释原文 "published to **remote** transcript consumers"）+ `reduceLaneSnapshot()` 重取信号。**我们的事件源本来就接的是 `harness.events.on`（vendor 机制）**，自研的只是末端 buffer 重放 ⇒ 见 T1 |
| metrics（`systemPromptBytes` 等） | 自建 | ⚠️ `pi-telemetry` 未评估，可能有重叠 |
| prompt-registry 提示词组装 | 自建（ADR-0003） | 我们的业务资产，vendor 无对应概念 |
| compaction 摘要解析器 | 自建 | vendor 有 `compact`，但摘要格式是pi 私有的 |

## 四、待办：把"待确认"变成结论

优先确认（按收益排序）：

1. **`telemetry`** —— 我们自建了 metrics，若 vendor 有标准观测，接上能省维护
2. **`evals`** —— 是否有 eval 框架可接，让 `packages/pi-poc` 与后续能力有统一评测
3. **`session-backends`** —— 会话持久化是否有更标准方案
4. ~~**`registerTool` / `pi.on`**~~ ✅ **2026-10-04 结案**（复核见 [四节 T1/T2](#t1--t2-2026-10-04-复核结论)）：
   `pi.on` 属 coding-agent 不可用，我们的事件源**本就是** `harness.events.on`；
   `registerTool` 的等价物在核心里 ⇒ 转成 T1 / T2 两条可执行待办
5. **`client` / `server` / `chord` / `protocol`** —— 逐个确认"需要 / 不需要"，写进本文件第一节

### T1 / T2（2026-10-04 复核结论）

复核全文：[`docs/discussion/2026-10-04-vendor-ext-review-registertool-pion.md`](../../docs/discussion/2026-10-04-vendor-ext-review-registertool-pion.md)

| # | 待办 | vendor 能力 | 我们的现状 | 收益 | 成本 |
|---|---|---|---|---|---|
| **T1** 🔴 | 断线重连改用 vendor 快照机制 | `lane.watch()` → `WatchHandle{snapshot,start,resnapshot}`、`reduceLaneSnapshot()`→`"rebase"`、纯 JSON 的 `LaneTranscriptSnapshot`/`LaneWatchEvent` |自研 `entry.buffer`+`seq`+`afterSeq` 重放；`BUFFER_LIMIT` 溢出后 `shift()` 丢事件，重连 best-effort、**状态可能永久错位**（`session-manager.ts:1029`注释自认） | 修**已知正确性缺陷**：重连从「尽力而为」变「重取权威快照+重放增量」；顺带白拿 `watchSession` 与 `config_update` 等目前收不到的事件 | 中（动事件主链路，须先补测试基线） |
| **T2** ⚠️ | 工具集运行时增删 | `AgentHarness.setTools()` / `lane.setActiveTools()` / `getTools()`（**全仓 0 调用**） | 工具集在 `harnessFactory.create` 时求值一次（`session-manager.ts:726-727`）；**skill 工具在会话创建时注入**（`:1533`） | 中途装/卸 skill 不必重建会话（`skills/` 是活资产，ADR-0009 记PR #29 脱节教训） | 低（纯增量） |

**权威参考实现**：`vendor/earendil-works/pi/packages/coding-agent/src/experimental/services/transcript-provider.ts`
（128 行，完整跨进程消费者）—— T1 直接照抄它的三点：
① 先发全量快照再接增量 ② `reduceLaneSnapshot(...) === "rebase"` 是官方「该重取快照」信号
③ `toLaneWatchEvent` 过滤进程内噪声事件（`turn_start`/`turn_end`/`handler_error`）。

⚠️ **别把 `recovery` 当重连**：`drive/recovery.ts` 的 `recovery: true` 是**崩溃恢复**
（从已提交帧前缀重放孤儿assistant 请求），与断线重连是两回事。

> ⚠️ **本环境 `grep` / `git grep` 有假阴性**（PATH 首位 shim）。本轮多次出现「`git grep` 返0 命中、
> python 直读确认文件内确有该符号」（`HarnessEventType`、`pi-agent-core`、`setTools` 均如此）。
> **任何「全仓 0 命中」的结论，必须用 python 直读复核后才能写进本文件。**

## 五、升级 vendor 时的回归重点

升级 `VENDORED.md` 记录的版本时，按此顺序回归：

1. **本文件第三节的"自研物"** —— 最可能被官方能力取代的地方
2. **工具分层**（ADR-0005）—— 已知易碎，0.0.29/0.0.30 就是在这崩的
3. **事件流 / SSE**（ADR-0006）—— `lastEventId` 与 `from=now` 不能叠加
4. ⭐ **`watch` / `reduceLaneSnapshot` / `WatchHandle`**（若采纳 T1）—— vendor 改了
   `LaneWatchSourceEvent` 的**事件裁剪集合**（`agent-harness.ts:399-406`，会增删被过滤的事件类型）
   或 `reduceLaneSnapshot` 的归约规则时，**我们的重连正确性直接受影响**。
   判据：升级后必须验证「重连拿到的快照 == 重放事件归约出的状态」，不能只测事件条数
4. **hook 顺序** —— `before_tool` 在 `prepareToolCall` 之后，别指望它拦"调了不该调的工具"
5. **视觉能力三态**（ADR-0004）—— 端到端验证，别只改一端
