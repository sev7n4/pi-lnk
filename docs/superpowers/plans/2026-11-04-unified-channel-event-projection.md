# 统一事件通道派生缺失修复（P0 projector + P1 注入通道）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** flag on（`STREAM_MAIN_FROM_PIRUNTIME=on`）下，`GET /runs/events` 通道的事件集恢复与旧主流语义等价——askuser 卡、svg_card、canvas_action、task、thinking、usage、结构化 error 全部实时可达；流控制事件（turn_ack 等）经注入通道补齐。

**Architecture:** `pi-events.ts` 新增投影编排工厂 `createUiEventProjector`（复用既有提取函数，`role: 'owner' | 'observer'` 双形态），`runEventStream` 回调从单次 `mapPiEventToUiEvent` 换为 projector 派生循环（P0）；结构上不可从 raw lane 事件派生的流控制事件由 `startConversationRun` drain 侧经 `SessionEventBus` 新增的 run_control 通道广播、`runEventStream` 订阅推入队列（P1）。usage 积分折算用进程内 estimator 直传 Map（`turnEstimators`）复用主流同款闭包，零口径漂移、零额外查询。

**Tech Stack:** NestJS service / EventEmitter、pi-events 提取函数族、Vitest、nvm node24。

**Spec:** `docs/superpowers/specs/2026-11-04-unified-channel-event-projection-design.md`（PR #713 已合并，master `1a8845c4`）

## 已落地事实（自审核实，执行时不得重做）

| 事实 | 证据 |
|---|---|
| `runEventStream` 起始 :1256；raw 回调仅 `mapPiEventToUiEvent` 单次归一（:1277-1282）；credit_tx 订阅先例 :1271-1276（`subscribeSession` → `queue.push` + `notify?.()`） | `apps/server/src/agent/agent.service.ts`（master `1a8845c4` 前基线 f6cc25f7 实测行号） |
| 主链路编排顺序（streamFromPiRuntime 循环 :3070 起）：creditQueue flush → runId 围栏 → agent_end/error 置 done → `classifyPiRunError`(:3126) → `extractCanvasCommands`(:3148) → `extractCanvasActions`(:3173) → `extractTaskEvents`(:3180) → thinking(:3188) → usage(:3198) → text_end flush（无 yield）→ `mapPiEventToUiEvent`（text_delta 内 stripPlanMarkers + plan 派生先于 ui 本身 yield） | 同上 |
| 流控制事件全部在主链路 yield 流（不在 lane buffer）：`turn_not_submitted` :2980、`turn_suspended` :3285（循环出口）、`turn_ack` :3379、`turn_settled` :3427 | 同上 |
| `startConversationRun` :1142 的 `drain()` 内 `for await (const _ev of gen)` 目前**完全丢弃**事件本体（:1163-1170）——P1 注入点即此循环；fork 分支 threadId 与 baseThreadId 不同 | 同上 |
| `SessionEventBus`（`apps/server/src/points/session-event-bus.service.ts`）：`sessionEmitters: Map<string, EventEmitter>`，私有 `subscribe()` **硬编码 'credit_tx' 事件名**；扩展须参数化事件名 | 该文件全文（81 行） |
| `AgentService` 构造器 10 参：前 3 必填（prisma/materialService/providerResolver），`eventBus` 第 10 位 `@Optional()` | agent.service.ts:281-330 |
| 主流 usage 折算：`estimateTurnCredits` 闭包 :3020-3046（textQuotePlan.compute / USD 兜底），`createUsageAccumulator(estimateTurnCredits)` :3047 | 同上 |
| accumulator 无残留 flush：thinking done 由事件驱动、usage turn_usage 由 agent_end 驱动（`createThinkingAccumulator` :685 / `createUsageAccumulator` :805 均只暴露 `feed`） | `apps/server/src/agent/pi-runtime/pi-events.ts` |
| `stripPlanMarkers` 位于 `apps/server/src/agent/planMarkers.ts`（pi-events.ts 内 import 须写 `../planMarkers`） | master 文件树 |
| `TaskWireEvent = { type: 'task_list'|'task_update', data: unknown }` 形状兼容 UiEvent 可直接 push | pi-events.ts:600-604 |
| controller id 行纪律：`seq === undefined ? '' : id: ${seq}`（无 seq 合成事件不写 id 行） | `apps/server/src/agent/agent.controller.ts:706-711` |
| 集成测试 harness 先例：假 pi-runtime client（内存 buffer + streamEvents 三种订阅语义）+ 真实 AgentService；文件在 `apps/server/src/agent/multi-device-stream.consistency.test.ts`（非 test/integration——vitest include 只覆盖 src，有偏离注记） | 该文件 1-60 行注释 |
| 前端 `handleEvent` 按全量语义设计、零改动（服务端少发非前端缺能力） | 规格 §2 引 `AgentSideRail.vue:3002` |

## Global Constraints

- 分支约定：feature 分支 + PR + **squash merge**；在新 worktree 开发（主检出被并行会话占用，一律不碰）；基线 = master `1a8845c4`（动手前重新 `gh api repos/sev7n4/pi-lnk/commits/master --jq .sha` 确认未前移，若前移须重新 diff 定性）。
- 推送纪律：git https 被代理挡死 ⇒ 全程 REST Git Data API（blobs → tree(base_tree=master HEAD) → commit → refs；blob 必须 `-f content=@file`；推后核对 blob sha == `git hash-object` 本地值；compare API 核对零夹带）。ref 已存在用 `-X PATCH`。
- 测试纪律：vitest 用 nvm node24 + `--maxWorkers=1 --no-file-parallelism`，分批 ≤12 文件；挂载类测试 OOM 时 `NODE_OPTIONS=--max-old-space-size=3584` 逐文件跑。
- **测试 mock 断言禁 `as never`**（CI `pnpm -r build` 的 tsc 编译 `*.test.ts`）：用 `as unknown as NestClient & {...}` 双段 cast（本仓既有模式）。推前必跑 `npx tsc --noEmit`。
- **红线（全部不可碰）**：`streamFromPiRuntime` 与 POST 响应流路径零改动（flag off 逐字节不变）；`services/pi-runtime/**` 与 `vendor/**` 零改动（免 runtime-deploy）；前端零改动；`prisma/schema.prisma` 零改动；落库/计费/围栏副作用零改动（pushTraceEvent 只存在于主链路，projector observer 形态不落库）。
- 事件产出顺序 = 主链路既有顺序（error → canvas_command → canvas_action → task → thinking → usage → plan 派生 → map 归一）；任何重排都是对「双重等价」的破坏。
- 派生事件继承宿主 raw 事件的 `seq`（accumulator 产物已带；`extract*` 派生事件须补 `seq: event.seq`——与主链路 map 产物形状对齐）。
- run_control 注入事件**不带 seq**（controller 既有纪律：无 seq 不写 id 行 ⇒ 不参与游标续传，重连由 reconcile/历史重放兜底）。

## Review Focus

1. **observer mid-join**（中途接入在跑回合）：usage/thinking accumulator 只从接入点起算（部分值）——期望：与旧旁观行为一致，UI 按「预估」呈现，不崩不重复。Task 3 测试钉住。
2. **observer 早接**（连上时 run 未启动或回合已过 agent_end）：`turnEstimators` Map 无条目 → estimator 转发闭包返回 null → usage 事件照发但无 `estimatedCredits`（「无预估」形态，**绝不显示 0 积分假象**）。Task 3 测试钉住。
3. **run_control 无 seq 断线重连**：重连重放不含 turn_ack/turn_suspended——期望：reconcile + waiting_user 兜底呈现，不误报失败。Task 4 注记（行为级人工核对，已有 harness 难以低成本模拟）。
4. **同宿主多派生共享 seq**（一条 update 同时派生 canvas_command + generation_progress）：SSE `id:` 行重复——期望：EventSource 协议容忍重复 id，游标以 raw seq 单调性为准。Task 5 fixture 覆盖。
5. **drain 发布与 lane 投影的交错顺序**：turn_settled 在 agent_end 的投影事件之后到达（主流 yield 序保证）——期望：前端先见 turn_usage 再见 turn_settled，权威值覆盖预估。Task 4 测试钉住。

---

### Task 1: SessionEventBus 扩展 run_control 通道

**Files:**
- Modify: `apps/server/src/points/session-event-bus.service.ts`
- Test: `apps/server/src/points/session-event-bus.run-control.test.ts`（新建）

**Interfaces:**
- Consumes: 既有 `SessionEventBus`（credit_tx 专用 Map + 私有 `subscribe()`）。
- Produces: `emitRunControl(sessionKey: string, ev: { type: string; data: unknown }): void`；`subscribeRunControl(sessionKey: string, fn: (ev: { type: string; data: unknown }) => void): () => void`（返回退订函数）。Task 3/4 依赖这两个方法名与签名。

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/src/points/session-event-bus.run-control.test.ts
import { describe, expect, it, vi } from 'vitest'
import { SessionEventBus } from './session-event-bus.service'

describe('SessionEventBus run_control 通道（统一事件通道 P1 注入）', () => {
  it('emitRunControl 只广播给同 key 的订阅者，退订后不再收到', () => {
    const bus = new SessionEventBus()
    const got: Array<{ type: string; data: unknown }> = []
    const unsub = bus.subscribeRunControl('T1', (ev) => got.push(ev))
    const other: Array<{ type: string; data: unknown }> = []
    bus.subscribeRunControl('T2', (ev) => other.push(ev))

    bus.emitRunControl('T1', { type: 'turn_suspended', data: {} })
    unsub()
    bus.emitRunControl('T1', { type: 'turn_ack', data: { mode: 'run' } })

    expect(got).toEqual([{ type: 'turn_suspended', data: {} }])
    expect(other).toEqual([])
  })

  it('credit_tx 通道与 run_control 通道互不串台', () => {
    const bus = new SessionEventBus()
    const control: unknown[] = []
    const credit: unknown[] = []
    bus.subscribeRunControl('T1', (ev) => control.push(ev))
    bus.subscribeSession('T1', (ev) => credit.push(ev))

    bus.emitRunControl('T1', { type: 'turn_ack', data: {} })
    bus.emitCreditTx({ sessionId: 'T1', userId: 'u1', delta: -3 } as never)

    expect(control).toEqual([{ type: 'turn_ack', data: {} }])
    expect(credit).toHaveLength(1)
  })

  it('同 key 多订户广播（多端各收一份）；无订户 emit 不抛', () => {
    const bus = new SessionEventBus()
    const a: unknown[] = []
    const b: unknown[] = []
    bus.subscribeRunControl('T1', (ev) => a.push(ev))
    bus.subscribeRunControl('T1', (ev) => b.push(ev))
    bus.emitRunControl('T9', { type: 'turn_settled', data: {} }) // 无订户：静默
    bus.emitRunControl('T1', { type: 'turn_settled', data: { holdId: 'h1' } })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })

  it('vi 已注入：事件顺序保持发布序（FIFO）', () => {
    const bus = new SessionEventBus()
    const got: string[] = []
    bus.subscribeRunControl('T1', (ev) => got.push(ev.type))
    bus.emitRunControl('T1', { type: 'turn_suspended', data: {} })
    bus.emitRunControl('T1', { type: 'turn_ack', data: {} })
    expect(got).toEqual(['turn_suspended', 'turn_ack'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/points/session-event-bus.run-control.test.ts --maxWorkers=1 --no-file-parallelism`（nvm node24 环境）
Expected: FAIL — `subscribeRunControl is not a function`

- [ ] **Step 3: 最小实现**

在 `session-event-bus.service.ts` 中（credit_tx 三件套之后）追加，并把私有 `subscribe` 参数化事件名：

```ts
export type RunControlEvent = { type: string; data: unknown }
export type RunControlListener = (ev: RunControlEvent) => void

// 类体内新增：
/** 统一事件通道 P1：drain 侧发布、runEventStream 订阅的流控制事件通道
 *  （turn_ack / turn_not_submitted / turn_suspended / turn_settled）。
 *  与 credit_tx 同形不同名：第二个 Map 隔离事件名，防互串。 */
private readonly runControlEmitters = new Map<string, EventEmitter>()

/** startConversationRun drain 侧：消费 streamConversation 时对四类流控制事件调用。
 *  无订户静默（与 emitCreditTx 同语义）。 */
emitRunControl(sessionKey: string, ev: RunControlEvent): void {
  this.runControlEmitters.get(sessionKey)?.emit('run_control', ev)
}

/** runEventStream 在流建立时订阅本 thread；结束时调用返回函数退订。 */
subscribeRunControl(sessionKey: string, fn: RunControlListener): () => void {
  return this.subscribe(this.runControlEmitters, sessionKey, 'run_control', fn)
}
```

既有 `subscribe` 签名追加事件名参数（私有方法，两个 credit_tx 调用点同步补 `'credit_tx'`）：

```ts
private subscribe(
  registry: Map<string, EventEmitter>,
  key: string,
  event: string,
  fn: (ev: never) => void,
): () => void {
  // ……原逻辑不变，仅把两处硬编码 'credit_tx' 换成 event：
  if (!emitter.listeners(event).includes(fn as never)) {
    emitter.on(event, fn as never)
  }
  return () => {
    if (unsubscribed) return
    unsubscribed = true
    emitter!.removeListener(event, fn as never)
    if (emitter!.listenerCount(event) === 0) {
      registry.delete(key)
    }
  }
}
```

credit_tx 侧调用改为 `return this.subscribe(this.sessionEmitters, sessionId, 'credit_tx', fn)`（`subscribeSession` 内）与 `this.subscribe(this.userEmitters, userId, 'credit_tx', fn)`（`subscribeUser` 内）。listener 类型用仓内既有 cast 风格收敛，**不得使用 `as never` 于测试断言**（服务内部 cast 允许）。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx vitest run src/points/session-event-bus.run-control.test.ts src/points --maxWorkers=1 --no-file-parallelism`（若有既有 session-event-bus 测试一并回归）
Expected: PASS（新 4 条 + 既有 credit_tx 测试全绿——参数化不得改变 credit_tx 行为）

- [ ] **Step 5: Commit**

```bash
git add src/points/session-event-bus.service.ts src/points/session-event-bus.run-control.test.ts
git commit -m "feat(points): SessionEventBus 扩展 run_control 通道（事件名参数化，credit_tx 零行为变化）"
```

---

### Task 2: createUiEventProjector 投影编排工厂（P0 核心）

**Files:**
- Modify: `apps/server/src/agent/pi-runtime/pi-events.ts`
- Test: `apps/server/src/agent/pi-runtime/pi-events.projector.test.ts`（新建）

**Interfaces:**
- Consumes: 同文件既有 `extractCanvasCommands` / `extractCanvasActions` / `extractTaskEvents` / `mapPiEventToUiEvent` / `classifyPiRunError` / `createThinkingAccumulator` / `createUsageAccumulator`（**实现零改动，只编排**）；`stripPlanMarkers`（`../planMarkers`）。
- Produces: `createUiEventProjector(opts: { role: 'owner' | 'observer'; estimateTurnCredits?: (totals: { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokens?: number; cost?: number }) => number | null }): { feed(event: PiRuntimeEvent): UiEvent[]; flush(): UiEvent[] }`。Task 3 依赖 `feed` 逐事件调用、`flush` 收尾（P0 返回 `[]`，契约前瞻位——accumulator 无残留态）。

- [ ] **Step 1: 写失败测试（fixture 白名单 + 顺序断言）**

fixture 形状参照 `pi-events.test.ts` 既有 helper（`toolEnd` / `toolUpdate` 工厂；text_delta 内嵌在 `message_update` 的 `data.event`——裸 `{delta}` 会被丢）：

```ts
// apps/server/src/agent/pi-runtime/pi-events.projector.test.ts
import { describe, expect, it } from 'vitest'
import { createUiEventProjector, type PiRuntimeEvent } from './pi-events'

const ev = (type: PiRuntimeEvent['type'], data: unknown, seq = 1): PiRuntimeEvent =>
	({ type, ts: Date.now(), seq, data }) as never

const toolUpdate = (partialResult: unknown): PiRuntimeEvent =>
	({
		type: 'tool_execution_update',
		ts: Date.now(),
		seq: 7,
		data: { toolCallId: 'c1', toolName: 'ask_user', partialResult },
	}) as never

describe('createUiEventProjector（统一事件通道 P0：单一派生源）', () => {
	it('ask_user update 快照 → canvas_command（事故主场景）', () => {
		const p = createUiEventProjector({ role: 'observer' })
		const questions = [{ id: 'scene', question: '？', options: [{ label: 'a', value: 'a' }] }]
		const out = p.feed(
			toolUpdate({ content: [{ type: 'text', text: '{}' }], details: { ok: true, canvasCommands: [{ type: 'ask_user', callId: 'c1', questions }] } }),
		)
		expect(out).toEqual([{ type: 'canvas_command', data: { type: 'ask_user', callId: 'c1', questions }, seq: 7 }])
	})

	it('顺序断言：error → canvas_command → canvas_action → task → thinking → usage → map 归一（与主链路 :3126-3240 同序）', () => {
		const p = createUiEventProjector({ role: 'observer', estimateTurnCredits: () => 5 })
		// 一条 error 事件同时命中 classify + map 的 error 分支之外的多类派生时按固定序产出。
		// 用 agent_end 单事件验证 usage(turn_usage) 与 map 归一（done）的相对顺序。
		const out = p.feed(ev('agent_end', { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }, 9))
		expect(out.map((o) => o.type)).toEqual(['turn_usage', 'done'])
	})

	it('usage：estimateTurnCredits 注入时 usage_delta 带 estimatedCredits；不注入时事件仍产出但无该字段（无 0 假象）', () => {
		const withEst = createUiEventProjector({ role: 'observer', estimateTurnCredits: () => 12 })
		const out1 = withEst.feed(ev('message_update', { event: { type: 'usage_delta', inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } }, 3))
		// ⚠️ usage_delta 的真实载体形状以 extractUsageDelta 契约为准（实施时对照 pi-events.ts 与既有 pi-events.test.ts 用例修正本 fixture）
		expect((out1.find((o) => o.type === 'usage_delta')?.data as { estimatedCredits?: number }).estimatedCredits).toBe(12)

		const noEst = createUiEventProjector({ role: 'observer' })
		const out2 = noEst.feed(ev('message_update', { event: { type: 'usage_delta', inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } }, 3))
		expect(out2.find((o) => o.type === 'usage_delta')).toBeTruthy()
		expect((out2.find((o) => o.type === 'usage_delta')?.data as { estimatedCredits?: number }).estimatedCredits).toBeUndefined()
	})

	it('text_delta：plan 标记剥离 + 派生先于 ui 本身（与主链路同序）', () => {
		const p = createUiEventProjector({ role: 'observer' })
		const out = p.feed(ev('message_update', { event: { type: 'text_delta', delta: '⟦plan:1:第一步⟧开始' } }, 4))
		expect(out.map((o) => o.type)).toEqual(['task_list', 'text_delta'])
		expect((out[1].data as { text: string }).text).toBe('开始')
	})

	it('同宿主多派生共享宿主 seq（update 快照同时含 canvasCommands 与 generating）', () => {
		const p = createUiEventProjector({ role: 'observer' })
		const out = p.feed(
			toolUpdate({ content: [{ type: 'text', text: '{}' }], details: { ok: true, canvasCommands: [{ type: 'focus_node', nodeId: 'n1' }], generating: { nodeId: 'n2', phase: 'running' } } }),
		)
		// canvas_command 与 generation_progress（若该快照派生）同 seq=7
		for (const o of out) expect(o.seq).toBe(7)
	})

	it('error 事件：classifyPiRunError 命中产出结构化 error（provider/model 属 owner-enriched，observer 不带）', () => {
		const p = createUiEventProjector({ role: 'observer' })
		const out = p.feed(ev('error', { kind: 'provider_timeout', message: '上游响应超时', retry_hint: '稍后重试' }, 8))
		const err = out.find((o) => o.type === 'error')
		expect(err).toBeTruthy()
		expect((err!.data as { error_type?: string }).error_type).toBeTruthy()
		expect((err!.data as { provider?: string }).provider).toBeUndefined()
	})

	it('flush() 返回空数组（accumulator 无残留态，契约前瞻位）', () => {
		const p = createUiEventProjector({ role: 'observer' })
		expect(p.flush()).toEqual([])
	})

	it('role=observer 纯产出：feed 全程不调用任何持久化注入（estimateTurnCredits 之外无回调面）', () => {
		const p = createUiEventProjector({ role: 'observer' })
		p.feed(ev('tool_execution_start', { toolCallId: 'c1', toolName: 'x', args: {} }))
		p.feed(ev('message_end', {}))
		expect(p.flush()).toEqual([])
	})
})
```

⚠️ 实施时两个 fixture 细节必须对照源码核实后修正（plan 写作时未逐字段验证）：
1. `extractUsageDelta` 的真实载体形状（`pi-events.test.ts` 有现成用例可抄）；
2. `error` raw 事件的 data 形状（`classifyPiRunError` :352 的判别键）与 `mapPiEventToUiEvent` 对 error 的映射分支（:137-296）——确保 error 不被双产（主链路 classify 命中后 map 对同一事件产出什么就保持什么，顺序 = 主链路 yield 序）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/agent/pi-runtime/pi-events.projector.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL — `createUiEventProjector is not exported`

- [ ] **Step 3: 最小实现（pi-events.ts 末尾追加）**

```ts
// ── 统一事件通道派生缺失修复（spec 2026-11-04-unified-channel-event-projection-design）──
//
// 单一派生源判据（spec §4.4-1）：同一 raw 事件的 UI 派生编排只允许一份实现。
// 本工厂把主链路 streamFromPiRuntime 循环体的派生段（:3126-3240）逐字复刻为
// 「纯产出、无落库」的编排单元——实现全部复用本文件既有提取函数，本工厂不重写
// 任何提取逻辑。与主链路的等价由契约测试（multi-device-stream.consistency.test.ts
// 双重等价断言）钉死；主链路本包不切换（落库/计费/围栏耦合，spec §5.1 P2 演进）。
export interface UiEventProjectorOptions {
	/** owner：主链路形态（预留）；observer：统一通道形态（无落库、无围栏）。 */
	role: 'owner' | 'observer'
	/** usage 积分折算回调（Nest business-owned）。P0 observer 必须注入（经
	 *  AgentService.turnEstimators 转发闭包），否则 usage 预估行不可达（spec §6.8）。 */
	estimateTurnCredits?: (totals: {
		inputTokens?: number
		cacheReadTokens?: number
		cacheWriteTokens?: number
		outputTokens?: number
		cost?: number
	}) => number | null
}

export interface UiEventProjector {
	/** 输入一条 raw 事件，产出 0..n 个 UI 事件（顺序 = 主链路既有顺序）。 */
	feed(event: PiRuntimeEvent): UiEvent[]
	/** 流收尾。accumulator 无残留态（thinking done / turn_usage 均由事件驱动），
	 *  P0 返回 []；保留为契约前瞻位（P2 主链路切换时承接 textPersister.flush 的
	 *  等价物——届时 owner 形态才有非空实现）。 */
	flush(): UiEvent[]
}

export function createUiEventProjector(opts: UiEventProjectorOptions): UiEventProjector {
	const thinkingAccumulator = createThinkingAccumulator()
	const usageAccumulator = createUsageAccumulator(opts.estimateTurnCredits)
	return {
		feed(event: PiRuntimeEvent): UiEvent[] {
			const out: UiEvent[] = []
			// 1) 结构化 error（主链路 :3126 同点位同序）。provider/model 是主链路从
			//    会话上下文 enrich 的 owner 字段，observer 不带（契约测试对 error 剥离比较）。
			const turnErr = classifyPiRunError(event)
			if (turnErr) {
				out.push({
					type: 'error',
					data: { message: turnErr.message, error_type: turnErr.kind, retry_hint: turnErr.retry_hint },
					seq: event.seq,
				})
			}
			// 2) canvas_command（ask_user 卡 / svg_card / UI_COMMAND；B-6 契约）
			for (const cmd of extractCanvasCommands(event)) {
				out.push({ type: 'canvas_command', data: cmd, seq: event.seq })
			}
			// 3) canvas_action（画布数据动作 + 节点状态）
			for (const action of extractCanvasActions(event)) {
				out.push({ type: 'canvas_action', data: action, seq: event.seq })
			}
			// 4) task_list / task_update（todo_write diff）
			for (const task of extractTaskEvents(event)) {
				out.push(task as UiEvent)
			}
			// 5) thinking 折叠
			const thinkingUi = thinkingAccumulator.feed(event)
			if (thinkingUi) out.push(thinkingUi)
			// 6) usage 累积（agent_end 时 turn_usage）
			const usageUi = usageAccumulator.feed(event)
			if (usageUi) out.push(usageUi)
			// 7) map 归一 + plan 标记派生（派生先于 ui 本身，与主链路同序）
			const ui = mapPiEventToUiEvent(event)
			if (ui) {
				if (ui.type === 'text_delta') {
					const rawText = (ui.data as { text: string }).text
					const stripped = stripPlanMarkers(rawText)
					;(ui.data as { text: string }).text = stripped.text
					if (stripped.plan?.length) {
						out.push({
							type: 'task_list',
							data: { items: stripped.plan.map((it) => ({ id: `plan-${it.n}`, title: it.title, status: 'running' })) },
							seq: event.seq,
						})
					}
					if (stripped.doneN != null) {
						out.push({ type: 'task_update', data: { id: `plan-${stripped.doneN}`, status: 'done' }, seq: event.seq })
					}
				}
				out.push(ui)
			}
			return out
		},
		flush(): UiEvent[] {
			return []
		},
	}
}
```

同时在该文件 import 区补 `import { stripPlanMarkers } from "../planMarkers";`（注意该文件用双引号 + tab 缩进，保持一致）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/agent/pi-runtime/pi-events.projector.test.ts src/agent/pi-runtime --maxWorkers=1 --no-file-parallelism`
Expected: PASS（新用例 + pi-events 既有三测试文件全绿）

- [ ] **Step 5: 变异测试（验收动作，做完必须恢复源码）**

临时注释 `feed` 内第 2 步 `extractCanvasCommands` 循环 → 跑测试：ask_user 用例与同宿主多派生用例必须红；恢复。再临时删除 `estimateTurnCredits` 传参（`createUsageAccumulator()`）→ usage 预估用例必须红；恢复。两次变异各跑一次并确认恢复后全绿。

- [ ] **Step 6: Commit**

```bash
git add src/agent/pi-runtime/pi-events.ts src/agent/pi-runtime/pi-events.projector.test.ts
git commit -m "feat(agent): pi-events 新增 createUiEventProjector 投影编排工厂（单一派生源 P0）"
```

---

### Task 3: runEventStream 接入 projector + estimator 直传 Map

**Files:**
- Modify: `apps/server/src/agent/agent.service.ts`（runEventStream 回调 :1277-1288；streamConversation :3047 附近；新增字段 `turnEstimators`）
- Test: `apps/server/src/agent/agent.service.unified-projection.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的 `createUiEventProjector`；主流 `estimateTurnCredits` 闭包（:3020-3046）。
- Produces: `runEventStream` 产出全量 UI 事件集；私有字段 `turnEstimators: Map<string, (totals) => number | null>`（Task 4 无依赖，但契约测试依赖其行为）。

- [ ] **Step 1: 写失败测试（复用 multi-device-stream.consistency.test.ts 的 harness 模式）**

```ts
// apps/server/src/agent/agent.service.unified-projection.test.ts
import { describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import type { PiRuntimeEvent } from './pi-runtime/pi-events'

let seqCounter = 0
function piEvent(type: PiRuntimeEvent['type'], data: unknown, runId = 'run-1'): PiRuntimeEvent {
  return { type, lane: 'T1', ts: Date.now(), seq: ++seqCounter, runId, data }
}

/** askuser 阻塞回合 lane：update 快照携带 canvasCommands（B-6 唯一实时载体） */
function askUserRunBuffer(): PiRuntimeEvent[] {
  seqCounter = 0
  return [
    piEvent('turn_start', {}),
    piEvent('tool_execution_start', { toolCallId: 'c1', toolName: 'ask_user', args: {} }),
    piEvent('tool_execution_update', {
      toolCallId: 'c1', toolName: 'ask_user',
      partialResult: { content: [{ type: 'text', text: '{}' }], details: { ok: true, canvasCommands: [{ type: 'ask_user', callId: 'c1', questions: [{ id: 'q1', question: '？', options: [] }] }] } },
    }),
    piEvent('waiting_user', { status: 'waiting', callId: 'c1' }),
    piEvent('agent_end', {}),
  ]
}

// makeService / collect 与 multi-device-stream.consistency.test.ts 相同模式
// （构造器 3 mock + getPiRuntimeUrl/createPiRuntimeClient override + AbortController 收集）
function makeService(buffer: PiRuntimeEvent[]): AgentService {
  const service = new AgentService(
    { idempotencyRecord: { findMany: vi.fn().mockResolvedValue([]) } } as never,
    { createFromAgent: vi.fn() } as never,
    { resolveForGeneration: vi.fn() } as never,
  )
  const s = service as unknown as Record<string, unknown>
  s.getPiRuntimeUrl = vi.fn().mockReturnValue('http://pi-runtime')
  s.createPiRuntimeClient = vi.fn().mockReturnValue(makeFakePiRuntime(buffer))
  return service
}
// makeFakePiRuntime 与 collect() 从 multi-device-stream.consistency.test.ts 复制（不 import——测试文件独立性优先）

describe('统一通道投影接入（P0）：runEventStream 产出全量事件集', () => {
  it('事故主场景：askuser 回合 canvas_command 实时到达（此前被 pi_ 前缀静默丢弃）', async () => {
    const service = makeService(askUserRunBuffer())
    const out = await collect(service, { lastEventId: '0', stopAfter: (e) => e.type === 'done' || e.type === 'pi_turn_end' })
    expect(out.some((e) => e.type === 'canvas_command' && (e.data as { type: string }).type === 'ask_user')).toBe(true)
    // 归一事件照常（waiting_user 既有通路不回归）
    expect(out.some((e) => e.type === 'waiting_user')).toBe(true)
    // 不再产出 pi_ 前缀的工具 update 裸透传（旧缺陷形态）
    expect(out.some((e) => e.type === 'pi_tool_execution_update')).toBe(false)
  })

  it('estimator 直传：turnEstimators 有条目时 usage 带 estimatedCredits；无条目时「无预估」形态', async () => {
    const buffer = askUserRunBuffer()
    const service = makeService(buffer)
    const s = service as unknown as Record<string, unknown>
    // 模拟主流已注册（streamConversation 在订阅 lane 前构造并 set——时序保证）
    s.turnEstimators = new Map([['T1', () => 42]])
    const out = await collect(service, { lastEventId: '0', stopAfter: (e) => e.type === 'turn_usage' })
    const usage = out.find((e) => e.type === 'turn_usage')
    expect(usage).toBeTruthy()
    expect((usage!.data as { estimatedCredits?: number }).estimatedCredits).toBe(42)
  })

  it('mid-join：从中间接入也能收到后续 canvas_command（幂等由前端 callId upsert 兜底）', async () => {
    const buffer = askUserRunBuffer()
    const service = makeService(buffer)
    const out = await collect(service, { lastEventId: '2', stopAfter: (e) => e.type === 'done' })
    expect(out.some((e) => e.type === 'canvas_command')).toBe(true)
  })
})
```

⚠️ 注入 `s.turnEstimators = new Map(...)` 是**字段替换**——实现侧须保证 `runEventStream` 读的是 `this.turnEstimators`（实例字段）且测试替换后生效；若实现用 `readonly`，测试改为调用一个 `@internal` 的 set 方法或构造时注入。实施时择一，保持生产代码无测试专用面。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/agent/agent.service.unified-projection.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL — 第一条用例 canvas_command 缺失（现状 = `pi_tool_execution_update` 被前端丢弃的形态），第三条断言 `pi_tool_execution_update` 不出现也可能红。

- [ ] **Step 3: 实现**

3a. `agent.service.ts` 类字段区（`outOfTurnProjecting` :337 附近）新增：

```ts
// 统一事件通道 P0（spec 2026-11-04-unified-channel-event-projection §5.1）：
// 主流回合的 usage 折算闭包按 threadKey 直传——observer（runEventStream）经转发
// 闭包复用**同一**estimator 实例，零口径漂移、零额外查询。生命周期 =
// streamConversation 构造后 set、finally 收尾 delete。observer 早接（Map 无条目）
// ⇒ 转发闭包返回 null ⇒ usage 走「无预估」形态（Q2 纪律：绝不显示 0 假象）。
private readonly turnEstimators = new Map<
  string,
  (totals: {
    inputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    outputTokens?: number
    cost?: number
  }) => number | null
>()
```

3b. `streamConversation` :3047（`const usageAccumulator = createUsageAccumulator(estimateTurnCredits)` 之后）：

```ts
// P0：estimator 直传给统一通道 observer（转发闭包按 threadKey 查本 Map）。
const threadKey = threadId?.trim() || sessionId
this.turnEstimators.set(threadKey, estimateTurnCredits)
```

3c. `streamConversation` 的 `finally` 块（`textPersister.flush()` 附近，:3295+ 区域首个 finally）开头补 `this.turnEstimators.delete(threadKey)`。⚠️ `threadKey` 常量声明位置须在 try 之前可达处（3b 的 set 在 :3047、属于 try 内——把 `const threadKey` 声明上移到 try 块之前的既有 `let done = false` :3050 区域，set/delete 均引用它）。

3d. `runEventStream` 回调（:1277-1288）替换：

```ts
const unsubscribe = client.streamEvents(
  sessionKey,
  (event) => {
    // 统一事件通道 P0：回调从单次 mapPiEventToUiEvent 换为投影编排工厂——
    // 与主链路共享同一批 pi-events 提取实现（单一派生源判据 spec §4.4-1）。
    // 契约等价由 multi-device-stream.consistency.test.ts 双重等价断言钉死。
    const projector = this.getProjector(sessionKey)
    for (const ui of projector.feed(event)) {
      queue.push(ui as AgentStreamEvent)
    }
    notify?.()
  },
  ...
```

配套私有方法（或直接在 `runEventStream` 开头构造一次——**每连接一次**而非每事件一次）：

```ts
// runEventStream 内、client.streamEvents 调用之前：
const projector = createUiEventProjector({
  role: 'observer',
  estimateTurnCredits: (totals) => this.turnEstimators.get(sessionKey)?.(totals) ?? null,
})
```

（回调闭包直接捕获 `projector`，无需 `getProjector` 方法——每连接构造一次，转发闭包每次 feed 时查 Map，天然兼容「observer 先连、主流后注册 estimator」的时序。）import 区把 `mapPiEventToUiEvent` 的既有 import 保留（其他方法仍用），补 `createUiEventProjector`。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx vitest run src/agent/agent.service.unified-projection.test.ts src/agent/multi-device-stream.consistency.test.ts src/agent/agent.service --maxWorkers=1 --no-file-parallelism`（分批：前两文件一批，agent.service* 按既有分批纪律）
Expected: PASS。既有 agent.service.* 测试零红（flag off 路径未动的证明）。

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent.service.ts src/agent/agent.service.unified-projection.test.ts
git commit -m "feat(agent): runEventStream 接入投影编排 + estimator 直传 Map（P0）"
```

---

### Task 4: drain 侧 run_control 发布 + runEventStream 订阅注入（P1）

**Files:**
- Modify: `apps/server/src/agent/agent.service.ts`（`startConversationRun` drain :1163-1170；`runEventStream` 订阅区 :1271-1276 附近 + finally）
- Test: `apps/server/src/agent/agent.service.unified-projection.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `emitRunControl` / `subscribeRunControl`；真实 `SessionEventBus`（测试直接 new）。
- Produces: 流控制事件（`turn_ack` / `turn_not_submitted` / `turn_suspended` / `turn_settled`）在统一通道可达。

- [ ] **Step 1: 写失败测试**

在 `agent.service.unified-projection.test.ts` 追加：

```ts
describe('run_control 注入通道（P1）：drain 发布 → runEventStream 订阅', () => {
  it('行为级：runEventStream 订阅者收到同 thread 发布的 run_control 事件', async () => {
    const bus = new SessionEventBus()
    const service = makeService(askUserRunBuffer())
    // 构造器第 10 参注入真 bus（前 3 mock + 6 个 undefined 占位）
    // ⚠️ 若 makeService 不便传参，可 (service as any) 直接赋私有字段 eventBus
    const s = service as unknown as Record<string, unknown>
    s.eventBus = bus

    const got: Array<{ type: string; data: unknown }> = []
    const ac = new AbortController()
    const consumer = (async () => {
      for await (const ev of service.runEventStream('T1', { signal: ac.signal })) {
        const e = ev as { type: string; data: unknown }
        if (e.type.startsWith('turn_')) got.push({ type: e.type, data: e.data })
        if (got.length >= 2) { ac.abort(); break }
      }
    })()
    await new Promise((r) => setTimeout(r, 50)) // 等订阅挂载
    bus.emitRunControl('T1', { type: 'turn_suspended', data: {} })
    bus.emitRunControl('T1', { type: 'turn_ack', data: { mode: 'run' } })
    await consumer
    expect(got.map((g) => g.type)).toEqual(['turn_suspended', 'turn_ack'])
  })

  it('跨会话隔离：T2 发布的事件不进 T1 的流', async () => {
    // 同上 harness，emit 到 'T2'，收集 200ms 后断言 got 为空
  })

  it('eventBus 缺省（单测不传第 10 参）时 runEventStream 照常工作（@Optional 退化语义）', async () => {
    const service = makeService(askUserRunBuffer())
    const out = await collect(service, { lastEventId: '0', stopAfter: (e) => e.type === 'done' })
    expect(out.length).toBeGreaterThan(0)
  })
})
```

drain 发布侧的行为级测试（驱动真 `streamConversation` 全链）mock 面大，**登记为 Task 5 契约测试的一部分**（契约测试必然驱动真 streamConversation，turn_ack 的发布在其中顺带断言）——本 Task 的单测覆盖订阅侧与隔离性。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/agent/agent.service.unified-projection.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL — turn_ 前缀事件收集不到（订阅未接）。

- [ ] **Step 3: 实现**

3a. `startConversationRun` drain 改造（:1163-1170）：

```ts
// 统一事件通道 P1：drain 消费的 generator 只为副作用执行，但四类流控制事件
// 结构性不存在于 lane buffer（主流生命周期合成事件）——经 eventBus run_control
// 通道旁路广播给本 thread 的 runEventStream 订阅者（spec §5.3）。注入事件不带
// seq ⇒ 不参与游标续传（controller 无 seq 不写 id 行纪律），断线由 reconcile 兜底。
const RUN_CONTROL_TYPES = new Set(['turn_ack', 'turn_not_submitted', 'turn_suspended', 'turn_settled'])
const drain = (threadKey: string): void => {
  void (async () => {
    try {
      for await (const ev of gen) {
        if (this.eventBus && RUN_CONTROL_TYPES.has(ev.type)) {
          this.eventBus.emitRunControl(threadKey, {
            type: ev.type,
            data: (ev as { data: unknown }).data,
          })
        }
        // 事件本体其余照旧不投递（GET /runs/events 从 lane 重投影）
      }
    } catch (err) {
      this.piLogger?.error?.(`background drain failed (thread=${threadKey}): ${String(err)}`)
    }
  })()
}
```

三个调用点：fork 成功分支 `drain(forkedId)`（:1188 附近）；fork error 分支 `drain(baseThreadId)`（:1196 附近）；末尾 `drain(baseThreadId)`（:1211 附近）。⚠️ fork 成功分支的 run_control 必须发到 **forkedId**（observer 订阅的是新线程），错误分支事件类型不在四类内实际不发布。

3b. `runEventStream` 订阅区（credit_tx 订阅 :1271-1276 之后）：

```ts
// 统一事件通道 P1：订阅 run_control 注入通道（同 credit_tx 先例：推入本方法
// 既有 queue，主循环已会 yield；退订在 finally）。无 flag 门控——注入通道非
// 计费特性，@Optional 缺省 = 空转。
let controlUnsub: (() => void) | undefined
if (this.eventBus) {
  controlUnsub = this.eventBus.subscribeRunControl(sessionKey, (ev) => {
    queue.push(ev as AgentStreamEvent)
    notify?.()
  })
}
```

finally 块（:1329-1332）补 `controlUnsub?.()`。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx vitest run src/agent/agent.service.unified-projection.test.ts src/points/session-event-bus.run-control.test.ts src/agent/agent.service.credit-tx-stream.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: PASS（credit-tx-stream 回归 = eventBus 既有消费路径零破坏）。

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent.service.ts src/agent/agent.service.unified-projection.test.ts
git commit -m "feat(agent): drain 侧 run_control 发布 + runEventStream 订阅注入（P1）"
```

---

### Task 5: 双重等价契约测试（核心防回归）

**Files:**
- Modify: `apps/server/src/agent/multi-device-stream.consistency.test.ts`
- Consumes: Task 2/3/4 全部产物；`streamConversation` 真路径（mock prisma 全家，参照 `agent.service.pi-runtime.test.ts` 既有 harness——该文件已有 streamConversation 的最小 mock 集，**复制其 harness 而非重写**）。
- Produces: 「A==B 且 A==旧主流」双重等价断言进 CI。

- [ ] **Step 1: 构造契约 fixture（覆盖 spec §6 场景 1/5/6/7/8/9）**

在 `multi-device-stream.consistency.test.ts` 新增 fixture 工厂（lane raw 事件序列，一条序列覆盖多场景）：

```ts
/** 契约等价 fixture：askuser 卡（场景1）+ propose waiting（场景5）+ canvas_action（场景6）
 *  + thinking（场景7）+ usage（场景8）+ error（场景9）。形状逐字段对照 pi-events 提取函数契约
 *  （实施时以 pi-events.test.ts 现成 fixture 为准修正）。 */
function contractRunBuffer(): PiRuntimeEvent[] {
  seqCounter = 0
  return [
    piEvent('turn_start', {}),
    piEvent('message_update', { event: { type: 'text_delta', delta: '我来画' } }),
    piEvent('message_update', { event: { type: 'thinking', phase: 'start' } }),   // 形状待核
    piEvent('message_update', { event: { type: 'thinking', phase: 'end' } }),
    piEvent('message_update', { event: { type: 'usage_delta', inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
    piEvent('tool_execution_start', { toolCallId: 'g1', toolName: 'run_image_generation', args: {} }),
    piEvent('tool_execution_update', { toolCallId: 'g1', toolName: 'run_image_generation', partialResult: { details: { generating: { nodeId: 'n1', phase: 'running' } } } }),
    piEvent('tool_execution_end', { toolCallId: 'g1', toolName: 'run_image_generation', result: { details: { ok: true, canvasCommands: [{ type: 'focus_node', nodeId: 'n1' }] } } }),
    piEvent('tool_execution_update', { toolCallId: 'a1', toolName: 'ask_user', partialResult: { content: [{ type: 'text', text: '{}' }], details: { ok: true, canvasCommands: [{ type: 'ask_user', callId: 'a1', questions: [{ id: 'q', question: '？', options: [] }] }] } } }),
    piEvent('waiting_user', { status: 'waiting', callId: 'a1' }),
    piEvent('agent_end', {}),
  ]
}
```

⚠️ thinking/usage 的 raw 载体形状以 `extractThinking`(:660) / `extractUsageDelta` 的实现为准——写测试时先读这两个函数的判别键再定 fixture，禁止凭本 plan 猜测形状直接提交。

- [ ] **Step 2: 写双重等价断言**

```ts
describe('双重等价契约（spec §4.3 判据 3）：A==B 且 A==旧主流', () => {
  it('owner 流（streamConversation 真路径 yield）与 observer 流（runEventStream）事件集语义等价', async () => {
    const buffer = contractRunBuffer()
    // owner 侧：真 streamConversation（prisma mock 参照 agent.service.pi-runtime.test.ts，
    // TEXT_TOKEN_BILLING 未设 → 免预扣；收集 yield 序列）
    const ownerEvents = await collectFromStreamConversation(buffer, 'T1')
    // observer 侧：runEventStream（既有 collect + makeService harness）
    const observerEvents = await collectFromRunEventStream(buffer, 'T1')

    const strip = (events: Array<{ type: string; data: unknown }>) =>
      events
        // 剥离 owner 专属/落库上下文字段：thread_forked（fork 场景产物）、
        // error 的 provider/model（owner-enriched）、turn_ack/turn_settled（P1 注入
        // 时序在 owner 流内不同位——按类型集合比较补齐）
        .map((e) => {
          if (e.type === 'error') {
            const { provider, model, ...rest } = e.data as Record<string, unknown>
            return { type: e.type, data: rest }
          }
          return e
        })
        .filter((e) => !['thread_forked'].includes(e.type))
    const stripTypes = (events: Array<{ type: string }>) => new Set(events.map((e) => e.type))

    // 等价一：事件类型集合相等（旧主流有 ⇒ observer 必有）
    expect([...stripTypes(observerEvents)].sort()).toEqual([...stripTypes(ownerEvents).values()].sort())
    // 等价二：逐条 type+data 等价（同类型事件按序对齐，剥离字段后）
    //   ⚠️ turn_ack/turn_settled 等 owner 流末尾事件在 observer 侧经注入通道
    //   时序不同 ⇒ 逐条比对只覆盖「lane 派生面」，注入面用类型集合 + 顺序单测覆盖
    const laneTypes = new Set(['canvas_command', 'canvas_action', 'task_list', 'task_update', 'thinking', 'usage_delta', 'turn_usage', 'text_delta', 'text_replace', 'done', 'waiting_user', 'node_status'])
    expect(strip(observerEvents.filter((e) => laneTypes.has(e.type))))
      .toEqual(strip(ownerEvents.filter((e) => laneTypes.has(e.type))))
  })

  it('发起端 A 与旁观端 B 仍逐条相同（既有判据 1 回归）', async () => { /* 既有用例保持 */ })
})
```

⚠️ 实施注记：逐条比对的范围限定在 **lane 派生面**（上表类型集），注入面（turn_ack 等）在 owner 流与 observer 流的产出位置结构性不同（主流流末尾 yield vs observer 订阅期广播），用「类型集合相等 + Task 4 顺序单测」覆盖——这是 spec §10.2 剥离清单（gSeq/messageIndex）之外的显式第二剥离维度，须在测试注释中写明，防止未来被误判为「比较不充分」。

- [ ] **Step 3: 跑测试**

Run: `npx vitest run src/agent/multi-device-stream.consistency.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: PASS。若 owner/observer 逐条比对红 → **先怀疑实现漂移而非改测试**（这正是契约测试的用途）；确认是实现差异后修实现，禁止放宽断言消红。

- [ ] **Step 4: Commit**

```bash
git add src/agent/multi-device-stream.consistency.test.ts
git commit -m "test(agent): 双重等价契约——observer 流与主流事件集语义等价进 CI"
```

---

### Task 6: 规格回写 + 全量回归 + PR

**Files:**
- Modify: `docs/superpowers/specs/2026-11-04-unified-channel-event-projection-design.md`（实施注记）
- Modify: `docs/superpowers/plans/2026-11-04-unified-channel-event-projection.md`（本文件，勾选执行状态）

- [ ] **Step 1: 规格回写（三处实施注记）**

1. §5.1 接口草案注记：`flush()` P0 返回 `[]`（accumulator 无残留态；P2 owner 形态才承接 textPersister.flush 等价物）。
2. §6 场景 8 注记：observer 的 estimatedCredits 经 `turnEstimators` 进程内直传复用主流同款闭包；observer 早接/解析失败时为「无预估」形态（Q2 纪律），非规格偏离。
3. §12 补一行：canary 第 7/8 锚的取数口径（生产复测时 askuser 回合 + canvas_action 到达日志/截图）。

- [ ] **Step 2: 全量回归**

Run（分批，nvm node24）:
```bash
npx vitest run src/agent/pi-runtime --maxWorkers=1 --no-file-parallelism
npx vitest run src/points --maxWorkers=1 --no-file-parallelism
npx vitest run src/agent/agent.service.unified-projection.test.ts src/agent/multi-device-stream.consistency.test.ts src/agent/agent.service.credit-tx-stream.test.ts --maxWorkers=1 --no-file-parallelism
# agent.service* 既有测试按 ≤12 文件分批全跑
npx tsc --noEmit   # CI tsc 编译测试文件，推前必过
```
Expected: 全绿零红。

- [ ] **Step 3: 推分支 + 开 PR**

REST Git Data API 推送（Global Constraints 纪律）；PR 标题 `feat(agent): 统一事件通道派生补全——P0 投影编排 + P1 run_control 注入`；正文列 spec 链接、四任务产物、双重等价证明、flag off 零改动证明（既有测试零红）。CI 全绿 + `gh pr diff` 零夹带核对后 squash merge（预留环境 gate 自批：`current_user_can_approve` 时 `POST /actions/runs/<id>/pending_deployments`）。

- [ ] **Step 4: 生产取证（合并部署后）**

1. `curl :8888/api/health` healthy + 容器内 git sha 核对。
2. 事故会话形态复现：发起 askuser 回合（无刷新）⇒ 问题卡实时出现（canary 第 7 锚）。
3. 生成回合 canvas_action 实时推进（第 8 锚）。
4. `turn_suspended` 挂起回合：前端保持等待态呈现不断链文案。
5. flag off 回归抽查：任一文本回合 POST 响应流事件形态与部署前一致（比对无新增/缺失事件类型）。

## Self-Review 记录（计划完成时自检结论）

1. **Spec 覆盖**：§4.3 矩阵 1-6 行 = Task 2/3（feed 编排全类派生）；7-9 行 = Task 4（注入通道）；10 行（P2 围栏）显式不做（spec §12）；§8 mid-join 单测 = Task 3 第三用例；§10.1 变异 = Task 2 Step 5；§10.2 契约 = Task 5；§10.5 canary 锚 = Task 6 Step 4。无缺口。
2. **占位符扫描**：Task 2 fixture 两处「形状待核」、Task 5 fixture 形状警示——均为**显式核实指令**（指向确定源文件与行号），非 TBD；实施动作是「读源码定形状」而非「自行发挥」。
3. **类型一致性**：`createUiEventProjector` 签名在 Task 2 定义 / Task 3 消费一致（`role` + `estimateTurnCredits`）；`emitRunControl(threadKey, {type, data})` 在 Task 1 定义 / Task 4 消费一致；`turnEstimators` 值类型与主流 `estimateTurnCredits` 闭包签名一致（五可选 token 字段 → number|null）。
4. **Review Focus 落点**：五项分别钉在 Task 3（mid-join、早接）、Task 4（无 seq 注记）、Task 5（共享 seq fixture、注入面时序剥离注记）。
