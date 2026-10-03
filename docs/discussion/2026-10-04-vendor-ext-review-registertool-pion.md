# 复核：`registerTool` / `pi.on` 两个 vendor 扩展机制，自研能否掰回vendor

| 字段 | 值 |
|---|---|
| 日期 | 2026-10-04 |
| 触发 | 用户提问：「vendor 的 registerTool 和 pi.on 完全没用（工具注册和事件流都是自研），是合理架构选择还是没吃满？」 |
| 依据 | [ADR-0009](./0009-vendor-capability-first.md) · [ADR-0006](./0006-single-socket-transport-for-queue.md) · [ADR-0005](./0005-tool-tiering-official-dynamic-loading.md) |
| 核实方式 | 逐条回vendor 源码 + pi-runtime 源码对账（`grep` 在本环境有假阴性，全部用 python 直读复核） |
| 结论 | **一半是误判，一半是真欠账。** `pi.on` 我们其实**早就在用**（记错了）；`registerTool` 是真欠账但优先级低；另有一处**未登记的真欠账**（`watch`/`resnapshot` 断线重连） |

---

## 一、先纠正提问里的前提：`pi.on` 我们不是「没用」，是**已经在用**

`DEPENDENCIES.md` 第二节写着「`pi.on(...)` 事件订阅 0 —— 我们自己实现了事件流（ADR-0006），未用 vendor 事件」。

**这条记录是错的。** pi-runtime 侧：

```
services/pi-runtime/src/session-manager.ts:805  private attachEvents(entry, harness) {
services/pi-runtime/src/session-manager.ts:808    harness.events.on(harnessType as never, (evt) => {
services/pi-runtime/src/session-manager.ts:835    harness.events.on("queue_update" as never, ...)
services/pi-runtime/src/session-manager.ts:849    harness.events.on("usage" as never, ...)
```

- `AgentHarness.events` 就是 vendor 的事件总线（`agent/src/harness/agent-harness.ts:610readonly events: Events`）
- 15 个事件类型走 `EVENT_MAP` 归一表全量透传（`session-manager.ts`），另加 `queue_update` / `usage` 两条专用订阅
- `session-manager.ts:1506` 的注释明写着「单个订阅者异常不阻断其他订阅者（**对齐 HarnessEventBus 的隔离语义**）」—— 说明当初就是**刻意对齐 vendor 语义**实现的

### 为什么当初会记成「0」

因为 `pi.on` 这个**方法名**确实一次都没出现。真相是分层不同：

| 我们该用的 | vendor 位置 | 状态 |
|---|---|---|
| `harness.events.on(type, listener)` | `pi-agent-core`（**我们依赖的包**） | ✅ **已在用，15+2 个事件类型** |
| `pi.on(event, handler)` | `pi-coding-agent`（**另一个包，我们没依赖**） | ❌ 不可用，见下 |

`ExtensionAPI` 接口定义在 `vendor/earendil-works/pi/packages/coding-agent/src/core/extensions/types.ts:1252`，
属于 coding-agent 这个**交互式 CLI/TUI 宿主**。它的整个价值面绑定在终端会话上：
`ui.select` / `ui.custom` 弹窗、`registerCommand` slash 命令、`registerShortcut` 键盘绑定、
`registerFlag` CLI 参数、`navigateTree` / `switchSession` 会话切换。

**这些在 Nest + Web 画布场景里一条都不存在。** 「跨进程 vendor 不管」这个猜测**方向对但理由不对**——
真实理由是：**`pi` 这个对象属于我们没跑的另一个宿主进程**，不是「vendor 跨进程能力缺失」。

> 判据：`git grep -n "pi\.on\b" -- vendor/earendil-works/pi/packages/agent/` → **0 命中**。
> `interface ExtensionAPI` 全仓唯一实现点在 coding-agent。**别再把coding-agent 的API 当pi-agent-core 的能力面。**

---

## 二、`registerTool`：**真欠账，但不该照搬**

### 现状

工具注册走**构造期数组配置**（`session-manager.ts:717-727`）：

```ts
const { harness } = await this.harnessFactory<LnkpiToolContext>({
  tools: toolEnsemble.registered,        // 全量工具
  activeToolNames: toolEnsemble.activeToolNames,  // 常驻集 + tool_search
  ...
});
```

装配在 `tools/registry.ts`（11 个 `build*Tools` 工厂，按批次组合）。这条路是**对齐 vendor 官方Dynamic Tool Loading 模式**的
（ADR-0005，PR #100 教训换来的），**不是自研**。

### 但确实缺了 vendor 的一件事：运行时增删

`AgentHarness` 提供了三个我们**一次都没调**的方法（核实：pi-runtime 全仓 `setTools` / `setActiveTools` / `getTools` 均 0 命中）：

| 方法 | 位置 | 我们的状态 |
|---|---|---|
| `getTools(ctx)` | `agent-harness.ts:594` | ❌ 0 调用 |
| `setTools(tools, ctx)` | `agent-harness.ts:595` | ❌ 0 调用 |
| `lane.setActiveTools(names, ctx)` | `agent-harness.ts:578` | ❌ 0 调用 |

对应 `coding-agent` 的 `pi.registerTool()`：工具可在 `session_start`、命令处理器里注册，
**立即刷新进 `getAllTools()` 并对 LLM 可见，无需 `/reload`**（CHANGELOG #1720）。

**这个能力我们不需要吗？** 需要，而且有一个已经埋好的真实场景：

>⚠️ **`skills` 工具集就是运行期注入的**（`session-manager.ts:1533`）：
> `[...this.tools, ...(this.skills?.tools ?? [])]`。即 skill 带来的工具在**会话创建时**求值一次。
> 若用户中途装/卸skill，工具集无法更新——只能重建会话。
> `skills/` 目录是活的（dock 技能与 pi-runtime 真实安装列表曾不对齐，ADR-0009 记为 PR #29 教训）。

### 能不能直接换成 `pi.registerTool()`

**不能。** 三条硬理由：

1. **包不对**：`pi.registerTool` 在 coding-agent，我们只依赖 pi-agent-core。要用它的动态注册能力，
   得把 coding-agent 拉进来当依赖 —— 它是终端宿主（含 Ink TUI、CLI flag 解析、ResourceLoader），
   为拿一个注册函数拖进整个 CLI 是净负。
2. **等价能力已在核心里**：`setTools` + `setActiveTools` 就是 agent-core 原生的动态注册，
   同一个 `AgentHarness` 实例上调用，无需重启会话。
3. **我们的工具有上下文依赖**：`toolContext` 是**函数形态**，每轮 LLM 调用前求值（`session-manager.ts:732`），
   依赖 `entry.canvasSessionId` / `entry.turn`。`setTools` 换掉整组工具时这层闭包要一起搬，不是纯数组替换。

**⇒ 结论：`registerTool` 不必掰，但 `setTools` / `setActiveTools` 这条动态增删路应当登记为待办。**
收益明确（skill 热更新不必重建会话），成本低（核心里现成的）。

---

## 三、🔴 真正的欠账：`watch` / `resnapshot` —— vendor 有跨进程断线重连，我们自研了 buffer 替代

**这一条 `DEPENDENCIES.md` 完全没登记，是本次复核最重要的发现。**

### 我们自研的方案（ADR-0006）

`session-manager.ts` 里一套手写的 SSE 缓冲重放：

| 我们的实现 | 位置 |
|---|---|
| `NormalizedEvent.seq` 会话内单调递增 | `:105` |
| `entry.buffer: NormalizedEvent[]` 累积 | `:154` |
| `nextSeq++` 分配 | `:1499` |
| `BUFFER_LIMIT` 溢出 `shift()` | `:1501` |
| `afterSeq` 过滤重放 | `:1031` |
| 「早于 buffer 最旧条目时 best-effort 返回全部」 | `:1029-1030` |

**已知缺陷（代码注释自己承认）**：buffer 溢出后 `shift()` 丢事件，重连只能 best-effort，
**不做全量重建 ⇒ 状态可能永久错位**。且 Nest 侧靠 `lastEventId` 传offset（`pi-runtime.client.ts` 10 处）。

### vendor 的方案（我们完全没用）

`AgentLane.watch(ctx)` / `AgentHarness.watchSession(ctx)` 返回 `WatchHandle`（`agent-harness.ts:579, 608`）：

```ts
export interface WatchHandle<T> {
  snapshot: T;                              // ①全量快照：权威状态，不是事件流
  start(listener: EventListener): void;    // ② 快照之后接增量事件
  resnapshot(context: Context): Promise<T>; // ③ 断线 ⇒ 重新取全量
  unsubscribe(): void;
}
```

配套三件套全在公开导出面（`dist/index.d.ts` 里 `export * from "./harness/agent-harness.ts"`）：

| 能力 | 导出 | 我们的状态 |
|---|---|---|
| 快照 + 增量 + 重取| `WatchHandle<LaneSnapshot>` | ❌ 0 |
| **纯 JSON 快照，专为跨进程消费者设计** | `LaneTranscriptSnapshot` | ❌ 0 |
| **纯 JSON 事件，专为跨进程消费者设计** | `LaneWatchEvent` | ❌ 0 |
| 事件归约成快照 | `reduceLaneSnapshot(snapshot, event)` → `"rebase" \| undefined` | ❌ 0 |

### ⭐ 决定性证据：vendor 就是为跨进程准备的

`agent-harness.ts:408-411` 的注释原文：

```ts
/** Strict-JSON snapshot representation published to remote transcript consumers. */
export type LaneTranscriptSnapshot = JsonRepresentation<LaneSnapshot>;
/** Reducer-relevant strict-JSON Harness events published to remote transcript consumers. */
export type LaneWatchEvent = JsonRepresentation<LaneWatchSourceEvent>;
```

**「published to remote transcript consumers」** —— vendor 明确把这套 API 的定位写成「给远端消费者用」。
`LaneWatchSourceEvent` 还**剔除了** `turn_start`/`turn_end`/`handler_error` 等只在进程内有意义的噪声
（`:399-406`），即**已经替跨进程场景做过一次裁剪**。

> 我们原先的假设「vendor 不管跨进程，事件流得自研」**是错的**。ADR-0006 的技术选型没错（Nest 作宿主是对的），
> 但**为此自研 `buffer` + `seq` + 重放是重复造轮子**。

### 而且 vendor 给了官方参考实现，可直接抄

`coding-agent/src/experimental/services/transcript-provider.ts`（128 行）就是一个**完整的跨进程 transcript 消费者**：

```ts
const opened = await lane.watch(BACKGROUND_CONTEXT);
watch = opened;
publishSnapshot(opened.snapshot, null, BACKGROUND_CONTEXT);  // ①先给全量快照
opened.start(onEvent);                                        // ②再接增量

const onEvent = (event, context) => {
  const forwarded = toLaneWatchEvent(event);   // 裁剪成纯 JSON 的 LaneWatchEvent
  if (forwarded === undefined) return;
  const snapshot = state.state.snapshot;
  if (reduceLaneSnapshot(snapshot, event) === "rebase") scheduleRebase(context);  // ③归约失败要重取快照
  state.state.event = forwarded;
  state.publish(context);
};
```

三点正是我们手写 buffer 时处理不对的地方：
1. **先快照后增量**，不是只留事件流
2. `reduceLaneSnapshot(...) === "rebase"` 是**官方的「归约不动了，该重取快照」信号**，
   我们靠 `BUFFER_LIMIT` 硬猜
3. `toLaneWatchEvent` 过滤进程内噪声事件

配套 `harness/runtime/drive/recovery.ts` 还提供了崩溃后从**已提交帧前缀**恢复的
`recoverAssistantGeneration`（`recovery: true` 标记）——
⚠️ 注意这个 `recovery` 是**崩溃恢复**，**不是**断线重连，两者别混。

---

## 四、总结：三类判定

| # | 机制 | 层次 | 判定 | 动作 |
|---|---|---|---|---|
| 1 | `pi.on` | coding-agent | ❌**不可用**（非依赖包 / 终端绑定）。我们用的 `harness.events.on` **就是 vendor 机制，已在用** | **改文档**：`DEPENDENCIES.md` 的「0 / 未用」是错的 |
| 2 | `registerTool` | coding-agent |⚠️ **真欠账但不必照搬**。等价能力 `setTools`/`setActiveTools` 在核心里，0 调用 | **登记待办**：skill 热更新（真实场景） |
| 3 | `watch`/`resnapshot` | **pi-agent-core** | 🔴 **真欠账，且未登记**。`LaneTranscriptSnapshot` 注释明写「remote consumers」= 跨进程就是它的目标场景 | **优先做**：抄 `transcript-provider.ts` 替掉自研 buffer 重放 |

### 优先级建议

**#3 收益最高**。当前自研方案的缺陷是**已知的正确性问题**（buffer 溢出后状态可能永久错位），
不是「不够优雅」。换成 `watch` + `reduceLaneSnapshot` 后：
- 重连不再best-effort，而是「重取权威快照 + 重放增量」
- buffer 正确性交给vendor 维护，`rebase` 信号比 `BUFFER_LIMIT` 硬得多
- 顺带白拿 `watchSession`（`SessionSnapshot`）与 `config_update` 等我们目前完全收不到的事件

**#2 顺带做**，纯增量改动，落在 skill 装配处。

**#1 只改文档**，但必须改 —— 它是`DEPENDENCIES.md` 第四节待办清单第4 条
「`registerTool` / `pi.on` —— 我们的工具注册与事件流是否该切到 vendor 机制」，
按现在的错误前提会导出「把 SSE 事件流切到 coding-agent 的 `pi.on`」这种**架构级误判**。

### 落地纪律提醒

按 ADR-0009 第2 条，任何自研等价物在 PR 里必须说明「vendor 有什么 / 为什么不能用」。
本复核的产出是**发现清单**，不是立即改代码 —— 三条都应各自开分支走七步流程
（`branch-first-dev-workflow`），且 #3 动的是事件主链路，
按 `DEPENDENCIES.md` 第五节属升级 vendor 时的回归重点，改前先补测试基线。

---

## 附：核实方法与踩坑

**⚠️ `grep` 在本环境有假阴性**（`git grep` 也一样）。本轮多次出现
`git grep`返回 0 命中、而python 直读确认文件内确有该符号的情况
（`HarnessEventType`、`pi-agent-core`、`setTools` 均如此）。
判据：**任何「全仓 0 命中」的结论，必须用 python 直读复核后才能写进文档。**
