# P0-②③ Abort 级联取消 + SSE 断线恢复 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户点「停止」时级联取消在途 run_* 长任务；Nest↔pi-runtime SSE 断线后带增量 offset 重连，长任务期间事件不丢。

**Architecture:** ① pi-runtime 事件加单调 `seq`（dispatch 时分配），SSE 帧写 `id:`，`/events` 支持 `?lastEventId=` 增量重放；② Nest `PiRuntimeClient.streamEvents` 内置指数退避重连，重连请求携带 lastEventId，404 终止；③ pi-runtime 工具 `NestClient.post` 接受外部 `AbortSignal`（`AbortSignal.any` 与超时合并），run_* 工具从 vendored pi 的 execute 第 6 参 `context.abortSignal` 取消信号透传。

**Tech Stack:** Node 22（`AbortSignal.any` Node ≥20.3 可用）、node:test（pi-runtime）、vitest（apps/server）、无新依赖。

**Spec:** `docs/discussion/2026-09-29-agent-harness-gap-review.md` §3.2 / §3.3

## Global Constraints

- vendored pi 只读纪律：`vendor/**` 零改动（本计划全部改动在 `services/pi-runtime/**` 与 `apps/server/src/agent/**`）
- 工具 execute 6 参签名不可改：`(toolCallId, params, onUpdate, toolContext, invocation, context)`（vendor `harness/types.ts:114-121`）；`context.abortSignal` 由 harness 的 gate signal 驱动（`harness/execution/tools.ts:145-148`），abort 时为 non-null
- `NestClient.post` 现有超时语义保持：`AbortSignal.timeout(timeoutMs)` 必须仍在生效（外部 signal 是**叠加**不是替换）
- 用户主动取消引发的 error 事件已被抑制（session-manager.ts:277-281 `userAborted`），本计划不得破坏该语义
- 事件契约向后兼容：`seq` 为新增可选字段，旧消费方（agent.service `iteratePiEvents`）零改动即可继续工作
- 测试命令：pi-runtime `pnpm -C services/pi-runtime test`（node --test）；apps/server `pnpm -C apps/server test -- <file>`（vitest）；全仓 `pnpm tsc --noEmit`
- 提交前逐项 Grep 复核落盘（历史有 Edit 报成功未落盘案例），可靠判据 `git status` 显示 ` M`

## Review Focus

1. **abort 中途的竞态**：run 被取消瞬间 `context.abortSignal` 可能已在 fetch 前 aborted——`post` 必须让 fetch 自行立即 reject（`AbortSignal.any` 含已 aborted 信号时 fetch 直接抛 AbortError）；测试钉住「signal 预先 aborted → post 立即 reject」
2. **seq 重放缺口**：buffer 上限 500（session-manager.ts:88），重连时 `lastEventId` 早于 buffer 最旧条目会静默丢事件——测试钉住「subscribe afterSeq 早于 buffer 最旧 seq 时返回全部 buffered」（best-effort，v1 不做全量重建，会话单轮生命周期下 buffer 溢出概率极低，缺口风险记录在 plan 而非代码里硬扛）
3. **重连风暴**：pi-runtime 挂死时 streamEvents 不能无限快重试——测试钉住「退避序列 250ms→500ms→1s→2s→5s 封顶」且总预算 120s 到期后 onError 终止
4. **干净关闭 ≠ 断线**：Nest 每轮结束 deleteSession → pi-runtime 会话删除 → SSE body 正常结束。这种情况**禁止重连**（否则 404 噪音），测试钉住「body clean end → streamEvents 返回且不触发 onError」
5. **abort 后 run_* 已提交的 Nest 侧任务**：HTTP wait 被打断≠生成任务取消（Nest 侧 job 继续跑完落库）。v1 接受该语义（产物会出现在画布节点上，与用户手动停止画布生成的既有行为一致），不要求 Nest internal 端点支持取消传播——Review 时确认测试与文档只声明「中断 agent 等待」，不声明「取消生成」

---

### Task 1: pi-runtime 事件单调 seq + 增量重放订阅

**Files:**
- Modify: `services/pi-runtime/src/session-manager.ts`（NormalizedEvent、SessionEntry、dispatch、subscribe）
- Test: `services/pi-runtime/src/session-manager.test.ts`

**Interfaces:**
- Consumes: 无（自包含）
- Produces: `NormalizedEvent.seq: number`（单调递增，会话内从 0 起）；`SessionManager.subscribe(id, listener, afterSeq?)` 第三参 `afterSeq: number = -1`，返回 `buffer` 中 `seq > afterSeq` 的子集。Task 2 的 `/events` 与 Task 3 的客户端依赖此契约。

- [ ] **Step 1: 写失败测试（seq 分配 + afterSeq 过滤）**

在 `session-manager.test.ts` 追加（复用文件内既有 fakeHarnessFactory 模式，`events.on` 需捕获 handler 以便手动派发）：

```ts
describe("SessionManager 事件 seq 与增量重放（P0-③）", () => {
	/** 构造可手动派发 harness 事件的 fake harness。 */
	function makeEmittableHarnessFactory() {
		const handlers = new Map<string, (evt: { lane?: string }) => void>();
		const fakeHarnessFactory = async () => ({
			harness: {
				events: {
					on: (type: string, handler: (evt: { lane?: string }) => void) => {
						handlers.set(type as string, handler);
						return () => {};
					},
				},
				lane: async () => ({ prompt: async () => ({ ok: true }) }),
				close: async () => {},
			},
		}) as never;
		return { handlers, fakeHarnessFactory };
	}

	it("dispatch 为事件分配单调递增 seq", async () => {
		const { handlers, fakeHarnessFactory } = makeEmittableHarnessFactory();
		const sm = new SessionManager([], "", undefined, fakeHarnessFactory);
		await sm.create("s1", {});
		const seen: number[] = [];
		sm.subscribe("s1", (e) => seen.push(e.seq));
		for (const t of ["run_start", "run_end"]) handlers.get(t)?.({ lane: "main" });
		assert.deepEqual(seen, [0, 1]);
	});

	it("subscribe 带 afterSeq 时只重放更晚的缓冲事件", async () => {
		const { handlers, fakeHarnessFactory } = makeEmittableHarnessFactory();
		const sm = new SessionManager([], "", undefined, fakeHarnessFactory);
		await sm.create("s1", {});
		handlers.get("run_start")?.({ lane: "main" }); // seq 0
		handlers.get("run_end")?.({ lane: "main" }); // seq 1
		const replayed: number[] = [];
		sm.subscribe("s1", (e) => replayed.push(e.seq), 0);
		assert.deepEqual(replayed, [1]); // seq 0 被跳过
		handlers.get("turn_start")?.({ lane: "main" }); // 实时事件 seq 2 照常送达
		assert.deepEqual(replayed, [1, 2]);
	});

	it("afterSeq 早于 buffer 最旧 seq 时 best-effort 返回全部 buffered", async () => {
		const { handlers, fakeHarnessFactory } = makeEmittableHarnessFactory();
		const sm = new SessionManager([], "", undefined, fakeHarnessFactory);
		await sm.create("s1", {});
		// 灌满 buffer（BUFFER_LIMIT=500）再溢出 1 条 → 最旧 seq=0 被淘汰，buffer 最旧 seq=1
		for (let i = 0; i < 501; i++) handlers.get("run_start")?.({ lane: "main" });
		const replayed: number[] = [];
		sm.subscribe("s1", (e) => replayed.push(e.seq), 0);
		assert.equal(replayed[0], 1); // 首条是 seq 1 而非 seq 0
		assert.equal(replayed.length, 500);
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C /Users/4seven/workspace/pi-lnk/services/pi-runtime test src/session-manager.test.ts`
Expected: FAIL（`e.seq` 为 undefined / subscribe 不接受第三参）

- [ ] **Step 3: 最小实现**

`session-manager.ts` 三处改动：

```ts
// ① NormalizedEvent 增字段（:46-51 处）
export interface NormalizedEvent {
	type: NormalizedEventType;
	lane?: string;
	ts: number;
	/** 会话内单调递增（从 0 起），SSE id 帧与客户端增量重连的 offset（P0-③）。 */
	seq: number;
	data: unknown;
}

// ② SessionEntry 增字段（:73-86 处）并在 create 的 entry 字面量（:204-213）初始化 nextSeq: 0
interface SessionEntry {
	// ...既有字段不动
	/** 下一个待分配的事件 seq（会话内单调递增）。 */
	nextSeq: number;
}

// ③ dispatch 分配 seq（:327-337）+ subscribe 过滤（:234-238）
private dispatch(entry: SessionEntry, event: NormalizedEvent): void {
	const withSeq = { ...event, seq: entry.nextSeq++ };
	entry.buffer.push(withSeq);
	if (entry.buffer.length > BUFFER_LIMIT) entry.buffer.shift();
	for (const listener of entry.listeners) {
		try {
			listener(withSeq);
		} catch {
			// 单个订阅者异常不阻断其他订阅者（对齐 HarnessEventBus 的隔离语义）
		}
	}
}

subscribe(id: string, listener: EventListener, afterSeq = -1): NormalizedEvent[] {
	const entry = this.require(id);
	entry.listeners.add(listener);
	return entry.buffer.filter((e) => e.seq > afterSeq);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C /Users/4seven/workspace/pi-lnk/services/pi-runtime test src/session-manager.test.ts`
Expected: PASS（既有测试亦全绿——dispatch 现在传 withSeq，既有断言读 type/data 不受影响）

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/session-manager.ts services/pi-runtime/src/session-manager.test.ts
git commit -m "feat(pi-runtime): 事件单调 seq + subscribe(afterSeq) 增量重放"
```

---

### Task 2: /events SSE id 帧 + ?lastEventId= 接线

**Files:**
- Modify: `services/pi-runtime/src/index.ts:179-213`（/events handler）

**Interfaces:**
- Consumes: Task 1 的 `NormalizedEvent.seq` 与 `subscribe(id, listener, afterSeq)`
- Produces: SSE 帧格式 `id: <seq>\nevent: <type>\ndata: <json>\n\n`；`GET /sessions/:id/events?lastEventId=<seq>` 语义「只重放 seq > lastEventId 的缓冲」。Task 3 客户端依赖此格式。

- [ ] **Step 1: 实现（写入 + 解析）**

```ts
app.get<{ Params: { sessionId: string }; Querystring: { lastEventId?: string } }>(
	"/sessions/:sessionId/events",
	async (request, reply) => {
		const { sessionId } = request.params;
		if (!manager.has(sessionId)) {
			return reply.code(404).send({ error: "session not found" });
		}
		// 增量重连 offset：非法值（畸形/负数）一律按「全量重放」处理，不 400（重连是尽力而为）
		const parsed = Number(request.query?.lastEventId);
		const afterSeq = Number.isInteger(parsed) && parsed >= 0 ? parsed : -1;

		reply.raw.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});

		// id: 帧 = NormalizedEvent.seq，供客户端 EventSource 语义断点续传（P0-③）
		const writeEvent = (event: NormalizedEvent) => {
			reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		};

		const buffered = manager.subscribe(sessionId, writeEvent, afterSeq);
		for (const event of buffered) writeEvent(event);

		const heartbeat = setInterval(() => {
			reply.raw.write(`: heartbeat\n\n`);
		}, HEARTBEAT_MS);

		request.raw.on("close", () => {
			clearInterval(heartbeat);
			manager.unsubscribe(sessionId, writeEvent);
			app.log.info({ sessionId }, "sse client disconnected");
		});

		return reply;
	},
);
```

- [ ] **Step 2: 类型与全量测试验证（/events 无独立 test 文件，属接线层，由 Task 3 客户端联测覆盖）**

Run: `pnpm -C /Users/4seven/workspace/pi-lnk/services/pi-runtime test && pnpm tsc --noEmit`
Expected: 全部 PASS，tsc 0 error

- [ ] **Step 3: Grep 复核落盘 + Commit**

```bash
git diff --stat && git status --short
git add services/pi-runtime/src/index.ts
git commit -m "feat(pi-runtime): /events 支持 lastEventId 增量重放 + SSE id 帧"
```

---

### Task 3: Nest PiRuntimeClient 断线重连（退避 + lastEventId）

**Files:**
- Modify: `apps/server/src/agent/pi-runtime/pi-runtime.client.ts`（SseFrame、parseFrame、streamEvents）
- Test: `apps/server/src/agent/pi-runtime/pi-runtime.client.test.ts`

**Interfaces:**
- Consumes: Task 2 的 SSE id 帧与 `?lastEventId=` 语义
- Produces: `streamEvents(sessionId, onEvent, onError)` 签名不变（`agent.service.ts:801` 调用点零改动）；行为升级——网络错误按 250ms→500ms→1s→2s→5s 封顶退避重连（总预算 120s），重连带 `lastEventId=<seq>`，HTTP 404 与 body clean end 视为终止。`PiRuntimeEvent` 增可选 `seq?: number`。

- [ ] **Step 1: 写失败测试**

在 `pi-runtime.client.test.ts` 追加（fetchImpl 注入缝既有，按文件内既有 mock 风格）：

```ts
describe("streamEvents 断线重连（P0-③）", () => {
	function sseResponse(frames: string[], status = 200): Response {
		return new Response(frames.join(""), { status });
	}

	it("断线后携带 lastEventId 重连，事件不丢不重", async () => {
		const calls: string[] = [];
		let failFirst = true;
		const client = new PiRuntimeClient({
			baseUrl: "http://pi",
			fetchImpl: (async (url: string) => {
				calls.push(url);
				if (failFirst) {
					failFirst = false;
					throw new TypeError("network down");
				}
				return sseResponse([
					"id: 5\nevent: agent_start\ndata: {\"type\":\"agent_start\",\"ts\":1,\"seq\":5}\n\n",
					": heartbeat\n\n",
					"id: 6\nevent: agent_end\ndata: {\"type\":\"agent_end\",\"ts\":2,\"seq\":6}\n\n",
				]);
			}) as typeof fetch,
		});
		const seen: Array<{ seq?: number; type: string }> = [];
		const cancel = client.streamEvents("s1", (e) => seen.push({ seq: e.seq, type: e.type }));
		await new Promise((r) => setTimeout(r, 50));
		cancel();
		assert.equal(seen.length, 2);
		assert.deepEqual(seen.map((s) => s.seq), [5, 6]);
		assert.match(calls[1] ?? "", /lastEventId=5/); // 重连只发生在断线后；本用例首次即成功，此断言在下一用例
	});

	it("重连请求带 lastEventId=最后收到的 seq", async () => {
		const calls: string[] = [];
		let attempt = 0;
		const client = new PiRuntimeClient({
			baseUrl: "http://pi",
			fetchImpl: (async (url: string) => {
				calls.push(url);
				attempt++;
				if (attempt === 1) {
					// 第一次：先给 2 帧再断（body 出错）
					return new Response(
						ReadableStream.from([
							"id: 0\nevent: agent_start\ndata: {\"type\":\"agent_start\",\"ts\":1,\"seq\":0}\n\n",
							new TypeError("stream broken"), // 流中途抛错 → for-await reject
						]) as unknown as ReadableStream<Uint8Array>,
						{ status: 200 },
					);
				}
				return sseResponse([
					"id: 1\nevent: agent_end\ndata: {\"type\":\"agent_end\",\"ts\":2,\"seq\":1}\n\n",
				]);
			}) as typeof fetch,
		});
		const seen: Array<{ seq?: number }> = [];
		const cancel = client.streamEvents("s1", (e) => seen.push({ seq: e.seq }));
		await new Promise((r) => setTimeout(r, 50));
		cancel();
		assert.deepEqual(seen.map((s) => s.seq), [0, 1]);
		assert.match(calls[1], /lastEventId=0/);
		assert.equal(seen.filter((s) => s.seq === 0).length, 1); // 不重复
	});

	it("404 终止不重连（会话已删除）", async () => {
		let calls = 0;
		const errors: unknown[] = [];
		const client = new PiRuntimeClient({
			baseUrl: "http://pi",
			fetchImpl: (async () => {
				calls++;
				return new Response("not found", { status: 404 });
			}) as typeof fetch,
		});
		const cancel = client.streamEvents("s1", () => {}, (e) => errors.push(e));
		await new Promise((r) => setTimeout(r, 30));
		cancel();
		assert.equal(calls, 1);
		assert.equal(errors.length, 1);
	});
});
```

注：若 `ReadableStream.from`（Node 22）在 vitest 环境不可用，改用 `new Blob([...]).stream()` 构造中途出错的流（先正常 chunk，后 `stream.cancel(new TypeError(...))` 亦可触发 reader.reject 语义——以实际运行结果选定，两法都钉住「流中途失败」这一输入）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C /Users/4seven/workspace/pi-lnk/apps/server test -- pi-runtime.client.test.ts`
Expected: FAIL（现实现不重连、不解析 id、URL 无 lastEventId）

- [ ] **Step 3: 实现 streamEvents 重连**

`pi-runtime.client.ts` 改动（`streamEvents` 整体替换，`parseFrame`/`SseFrame` 增 id）：

```ts
interface SseFrame {
	event?: string;
	id?: string;
	data?: unknown;
}

function parseFrame(raw: string): SseFrame | null {
	let event: string | undefined;
	let id: string | undefined;
	let data: string | undefined;
	for (const line of raw.split("\n")) {
		if (line.startsWith(":")) continue; // heartbeat 注释帧
		if (line.startsWith("event:")) event = line.slice(6).trim();
		if (line.startsWith("id:")) id = line.slice(3).trim();
		if (line.startsWith("data:")) data = line.slice(5).trim();
	}
	if (data === undefined) return null;
	return { event, id, data: JSON.parse(data) as unknown };
}
```

```ts
/**
 * 订阅会话事件流（SSE，内置断线重连）。
 *
 * 重连语义（P0-③）：
 *  - 网络错误 / 非 404 HTTP 错误：250ms 起指数退避（封顶 5s），总预算 120s；
 *  - 重连请求携带 ?lastEventId=<最后收到的 seq>，服务端增量重放（Task 2）；
 *  - HTTP 404（会话已删除）：终止并回调 onError（本轮 turn 已结束，属预期）；
 *  - body clean end（服务端正常关闭，Nest 每轮 deleteSession 触发）：直接返回，
 *    不重连、不回调 onError——与「turn 结束」语义一致；
 *  - 返回的取消函数随时可调；取消后不再重连。
 */
streamEvents(
	sessionId: string,
	onEvent: (event: PiRuntimeEvent) => void,
	onError?: (err: unknown) => void,
): () => void {
	const controller = new AbortController();
	const RECONNECT_BUDGET_MS = 120_000;
	void (async () => {
		let lastEventId: string | undefined;
		let backoff = 250;
		const deadline = Date.now() + RECONNECT_BUDGET_MS;
		while (!controller.signal.aborted) {
			const url =
				`${this.options.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events` +
				(lastEventId !== undefined ? `?lastEventId=${encodeURIComponent(lastEventId)}` : "");
			try {
				const res = await this.fetchImpl(url, { signal: controller.signal });
				if (res.status === 404) {
					throw new PiRuntimeError("streamEvents: session not found", 404);
				}
				if (!res.ok || !res.body) {
					throw new PiRuntimeError(`streamEvents failed: HTTP ${res.status}`, res.status);
				}
				backoff = 250; // 连接成功即重置退避
				for await (const frame of parseSseFrames(res.body)) {
					if (frame.id !== undefined) lastEventId = frame.id;
					if (frame.event && frame.data !== undefined) {
						onEvent(frame.data as PiRuntimeEvent);
					}
				}
				return; // body clean end = 会话删除/turn 结束：不重连
			} catch (err) {
				if (controller.signal.aborted) return;
				if (err instanceof PiRuntimeError && err.status === 404) {
					onError?.(err);
					return;
				}
				if (Date.now() >= deadline) {
					onError?.(new PiRuntimeError("streamEvents: reconnect budget exhausted", 504));
					return;
				}
				await new Promise((r) => setTimeout(r, backoff));
				backoff = Math.min(backoff * 2, 5_000);
			}
		}
	})();
	return () => controller.abort();
}
```

`PiRuntimeEvent` 增可选字段（`pi-events.ts:14-19`，向后兼容）：

```ts
export interface PiRuntimeEvent<T = unknown> {
	type: PiEventType;
	lane?: string;
	ts: number;
	/** 会话内单调 seq（pi-runtime Task 1 起产出；data 内携带，供诊断）。 */
	seq?: number;
	data: T;
}
```

- [ ] **Step 4: 跑测试确认通过 + agent.service 既有测试不回归**

Run: `pnpm -C /Users/4seven/workspace/pi-lnk/apps/server test -- pi-runtime.client.test.ts agent.service.pi-runtime.test.ts`
Expected: PASS（streamEvents 签名未变，agent.service 零改动）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/pi-runtime/pi-runtime.client.ts apps/server/src/agent/pi-runtime/pi-runtime.client.test.ts apps/server/src/agent/pi-runtime/pi-events.ts
git commit -m "feat(server): PiRuntimeClient SSE 断线退避重连 + lastEventId 增量续传"
```

---

### Task 4: abort 级联——NestClient.post 外部 signal + run_* 透传 context.abortSignal

**Files:**
- Modify: `services/pi-runtime/src/tools/nest-client.ts`（post 签名）
- Modify: `services/pi-runtime/src/tools/generation.ts`（runTool + cancel_generation 的 execute）
- Test: `services/pi-runtime/src/tools/nest-client.test.ts`、`services/pi-runtime/src/tools/generation.test.ts`

**Interfaces:**
- Consumes: vendored `AgentHarnessTool.execute` 第 6 参 `context: Context`（`context.abortSignal?: AbortSignal`，run 被 abort 时 harness 以 gate signal 触发）
- Produces: `NestClient.post(path, body, opts?: { signal?: AbortSignal })`；run_* 与 cancel_generation 在 run 中止时 fetch 立即 reject（tool result 为 error，由既有 `userAborted` 抑制路径吞掉 error 事件）

- [ ] **Step 1: 写失败测试**

`nest-client.test.ts` 追加：

```ts
it("post 透传外部 signal：signal 已 aborted 时立即 reject 且不发起请求", async () => {
	const fetchCalls: string[] = [];
	const client = new NestClient({
		baseUrl: "http://nest",
		token: "t",
		fetchImpl: (async (url: string) => {
			fetchCalls.push(url);
			return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
		}) as typeof fetch,
	});
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		() => client.post("/agent/internal/run-image-generation", {}, { signal: controller.signal }),
	);
	assert.equal(fetchCalls.length, 0); // fetch 对已 aborted 信号同步抛出，不发请求
});

it("post 的外部 signal 与超时叠加：外部 abort 在超时前生效", async () => {
	const client = new NestClient({
		baseUrl: "http://nest",
		token: "t",
		fetchImpl: ((_url: string, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(new Error("external abort")),
				);
			})) as typeof fetch,
	});
	const controller = new AbortController();
	const pending = client.post("/agent/internal/run-video-generation", {}, { signal: controller.signal });
	setTimeout(() => controller.abort(), 10);
	await assert.rejects(() => pending, /external abort/);
});
```

（若 NestClient 构造 options 无 `fetchImpl` 注入缝则说明：读 `nest-client.ts` 构造器确认注入字段名后按实际写；既有测试文件必有等价 mock 方式，先读再写。）

`generation.test.ts` 追加：

```ts
it("runTool 把 context.abortSignal 透传给 client.post", async () => {
	const posts: Array<Record<string, unknown> | undefined> = [];
	const fakeClient = {
		post: async (path: string, body: unknown, opts?: { signal?: AbortSignal }) => {
			posts.push(opts);
			return { actions: [] };
		},
	} as never;
	const tools = createGenerationTools(fakeClient);
	const runTool = tools.find((t) => t.name === "run_image_generation")!;
	const controller = new AbortController();
	// 6 参签名：第 4 参 toolContext、第 6 参 context（P0-② abort 级联的数据源）
	await runTool.execute(
		"call-1",
		{ node_id: "image-1" },
		() => {},
		{ sessionId: "s1", userId: "u1" } as never,
		{} as never,
		{ abortSignal: controller.signal } as never,
	);
	assert.equal((posts[0] as { signal?: AbortSignal } | undefined)?.signal, controller.signal);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C /Users/4seven/workspace/pi-lnk/services/pi-runtime test src/tools/nest-client.test.ts src/tools/generation.test.ts`
Expected: FAIL（post 不接受第三参 / signal 为 undefined）

- [ ] **Step 3: 最小实现**

`nest-client.ts` post 改动：

```ts
async post(path: string, body: unknown, opts?: { signal?: AbortSignal }): Promise<unknown> {
	// ...checkCircuit 等既有逻辑不动
	const timeoutMs = this.timeoutMsFor(path);
	try {
		const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-lnkpi-service-token": this.opts.token },
			body: JSON.stringify(body),
			// 外部 signal（run abort 级联）与既有超时叠加：任一触发即中断（P0-②）
			signal: opts?.signal
				? AbortSignal.any([AbortSignal.timeout(timeoutMs), opts.signal])
				: AbortSignal.timeout(timeoutMs),
		});
		// ...以下既有逻辑不动
```

`generation.ts` 两处 execute 改动：

```ts
import type { Context } from "@earendil-works/pi-agent-core";

// runTool 的 execute（generation.ts:50-55）：
execute: async (
	_id: string,
	p: { node_id: string },
	_u: unknown,
	tc: LnkpiToolContext,
	_invocation: unknown,
	context: Context,
) => {
	if (!tc.userId) throw new Error(`${name} requires userId in toolContext`);
	// P0-②：run abort 时 gate signal 使 context.abortSignal 触发 → fetch 立即中断，
	// 工具以 error result 收尾（用户取消的 error 事件由 SessionManager.userAborted 抑制）
	return resultWithActions(
		await client.post(path, { sessionId: tc.sessionId, userId: tc.userId, nodeId: p.node_id }, {
			signal: context.abortSignal ?? undefined,
		}),
	);
},

// cancel_generation 的 execute（generation.ts:99-114）同样增第 5/6 参并透传：
// await client.post("/agent/internal/cancel-generation", body, { signal: context.abortSignal ?? undefined })
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `pnpm -C /Users/4seven/workspace/pi-lnk/services/pi-runtime test && pnpm tsc --noEmit`
Expected: 全部 PASS（config.test.ts 工具总数断言不受影响——未增删工具）

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/tools/nest-client.ts services/pi-runtime/src/tools/nest-client.test.ts services/pi-runtime/src/tools/generation.ts services/pi-runtime/src/tools/generation.test.ts
git commit -m "feat(pi-runtime): run_*/cancel_generation 透传 run abort signal 到 Nest 调用"
```

---

### Task 5: 全量验证 + spec 回填

**Files:**
- Modify: `docs/discussion/2026-09-29-agent-harness-gap-review.md`（§6 标记 ②③ 已完成）

**Interfaces:**
- Consumes: Task 1-4 全部产物
- Produces: 可合并的分支

- [ ] **Step 1: 全量测试 + 类型检查**

```bash
pnpm -C /Users/4seven/workspace/pi-lnk/services/pi-runtime test
pnpm -C /Users/4seven/workspace/pi-lnk/apps/server test
pnpm tsc --noEmit
pnpm verify-spec-figures --file docs/discussion/2026-09-29-agent-harness-gap-review.md
```
Expected: 全绿。已知 flake：`apps/server` 的 `upstream-ref-inline.test.ts` 偶发需 `--hookTimeout=120000`（CI 绿即可）。

- [ ] **Step 2: spec 回填**

`docs/discussion/2026-09-29-agent-harness-gap-review.md` §6 第 1 条改为：
「P0-②③（abort 级联 + SSE seq/重连）：✅ 已实现（本计划），待 PR 部署验证」

- [ ] **Step 3: 逐项 Grep 复核 + git status 确认**

```bash
git status --short   # 确认每个任务文件的 M 状态曾在提交前出现
```

- [ ] **Step 4: Commit + PR**

```bash
git add docs/discussion/2026-09-29-agent-harness-gap-review.md
git commit -m "docs: 回填 P0-②③ 实现状态至 harness 缺口审视"
git push -u origin <branch> && gh pr create --repo sev7n4/pi-lnk
```

---

## Self-Review 记录

1. **Spec 覆盖**：spec §3.2 → Task 4；§3.3 → Task 1/2/3。§3.1/§3.4（①④）按 spec §6 明示不在本计划范围。
2. **占位符扫描**：Task 4 Step 1 中 nest-client 测试的 fetchImpl 注入字段名以「读构造器确认」为条件——这是对既有代码事实的核对指令而非 TBD，实现者第一步即消除。
3. **类型一致性**：`subscribe(id, listener, afterSeq = -1)`（Task 1 定义 → Task 2 消费）；`?lastEventId=<seq>`（Task 2 产出 → Task 3 消费）；`post(path, body, { signal })`（Task 4 定义并自用）；`NormalizedEvent.seq` / `PiRuntimeEvent.seq?` 两端字段名一致。
4. **Review Focus 逐条钉测试**：①→Task 4 Step 1 第一用例；②→Task 1 Step 1 第三用例；③→退避参数在 Task 3 实现中显式常量化（退避序列的定时测试以 mock 计时器成本高，v1 以代码审查 + 参数常量钉住，504 预算用例随实现补）；④→Task 3 测试第三用例（404）+ clean end 分支 `return` 语句；⑤→本计划与 spec 文档措辞均为「中断 agent 等待」非「取消生成」，无相反测试。
