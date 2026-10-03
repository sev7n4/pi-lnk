# pi-runtime 的 vendor 能力清单

> 记录 `services/pi-runtime` 对 `@earendil-works/pi-*` 各子包的**使用情况与理由**。
> 目的：让"是否吃满内核能力"变成**可核对的事实**，而不是靠印象。
>
> 依据：[ADR-0009](./0009-vendor-capability-first.md)。最近核对：2026-10-03。

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
| `registerTool` | 0 | ⚠️ 我们走 tool 数组配置，**未用扩展式注册** |
| `pi.on(...)` 事件订阅 | 0 | ⚠️ 我们自己实现了事件流（ADR-0006），**未用 vendor 事件** |
| **subagent** | 0 | ❗ **pi 0.85.1 无 subagent 支持**（全仓 0 命中），需 L2 自建（嵌套 Agent 实例或复用 Lane） |

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
| SSE 事件流 + lastEventId | Nest 作宿主，需要跨进程 | vendor 有事件（`pi.on`）但**跨进程不是它的问题** —— 我们的扩展点 |
| metrics（`systemPromptBytes` 等） | 自建 | ⚠️ `pi-telemetry` 未评估，可能有重叠 |
| prompt-registry 提示词组装 | 自建（ADR-0003） | 我们的业务资产，vendor 无对应概念 |
| compaction 摘要解析器 | 自建 | vendor 有 `compact`，但摘要格式是pi 私有的 |

## 四、待办：把"待确认"变成结论

优先确认（按收益排序）：

1. **`telemetry`** —— 我们自建了 metrics，若 vendor 有标准观测，接上能省维护
2. **`evals`** —— 是否有 eval 框架可接，让 `packages/pi-poc` 与后续能力有统一评测
3. **`session-backends`** —— 会话持久化是否有更标准方案
4. **`registerTool` / `pi.on`** —— 我们的工具注册与事件流是否该切到 vendor 机制
5. **`client` / `server` / `chord` / `protocol`** —— 逐个确认"需要 / 不需要"，写进本文件第一节

> 确认方式：读 `vendor/earendil-works/pi/packages/<pkg>/` 的README + `docs/`，
> 并用 `git grep -n "<能力>" -- vendor/earendil-works/pi/packages/` 验证实际可用性。
>
> **不要凭包名猜** —— 就像 #124（视觉能力）教训：靠猜会做出错误判断。

## 五、升级 vendor 时的回归重点

升级 `VENDORED.md` 记录的版本时，按此顺序回归：

1. **本文件第三节的"自研物"** —— 最可能被官方能力取代的地方
2. **工具分层**（ADR-0005）—— 已知易碎，0.0.29/0.0.30 就是在这崩的
3. **事件流 / SSE**（ADR-0006）—— `lastEventId` 与 `from=now` 不能叠加
4. **hook 顺序** —— `before_tool` 在 `prepareToolCall` 之后，别指望它拦"调了不该调的工具"
5. **视觉能力三态**（ADR-0004）—— 端到端验证，别只改一端
