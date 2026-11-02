# 对话流内产物交付卡（delivery card v1）Implementation Plan

状态：待执行（2026-11-02 写就，随规格评审通过后开工）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 生成产物完成后，对话流时间线内的产物行升级为可消费的交付卡（内联媒体、精确子态、版本锚、批次归组），用户不离开对话面板即可确认产物。

**Architecture:** 三段式增量——①pi-runtime 在既有 `node_status` 事件上扩 v2 可选元数据（不改三态词表）；②Nest `pi-events` 白名单透传 + 回合外通报补拍；③web `turnTimeline` artifact part 同构扩展 + 纯函数（状态映射/动作矩阵/批次归组）+ `AgentTurnTimeline.vue` 渲染增强。零新事件类型、零 agent 工具、零 canvasData PUT。

**Tech Stack:** TypeScript（node:test + tsx / vitest）、Vue 3（`--lnk-*` 令牌）、NestJS。

**Spec:** `docs/superpowers/specs/2026-11-02-delivery-card-v1-design.md`（判据 D-1~D-5、图 1~3、动作矩阵为本计划的上位依据，执行者必须同读）。

## Global Constraints

- 测试纪律：`services/pi-runtime` 用 `node --import tsx --test <file>`（在 `services/pi-runtime/` 内执行）；`apps/web`、`apps/server` 用 vitest：`nvm use 24 && npx vitest run <file> --maxWorkers=1 --no-file-parallelism`（4 核 8GB，禁并发，分批 ≤12 文件）。
- 改 `apps/web` 组件后必跑 `cd apps/web && npx vue-tsc -b`。
- commit 只在 worktree；禁 `git add -A`；push 走 api.github.com REST（https 被代理挡）；PR squash merge。
- 新增前端样式一律 `--lnk-*` 语义令牌（`neoUsageRatchet` 只减不增）；禁新增 hex/`--neo-*`。
- 「有正据才动」：`status: "done"` 必须携带 `url`（媒体）或 `summary`（文本）；`terminalState` 是 running 之子态，绝不独立翻终态（spec D-2）。
- `content` 文本 JSON 形态不变（`ok/type/bytes/truncated`）；v2 字段只走事件 data 与 details（spec D-4）。
- 内联媒体禁 autoplay，起播必须用户手势（spec §11.3）。
- version 字段生产方在 2026-11-01 根因包：本包所有代码对 `version` 缺失必须降级（隐藏徽标，不报错，spec D-3）。

## Review Focus

1. **SSE 重连乱序**：timeout 子态拍晚于 done 到达 → 不得把 done 回退成 running。 pinned by Task 4 单测。
2. **旧 runtime + 新前端**：`node_status` 无任何 v2 字段 → artifact part 行为逐字节等同旧版（不得写入 `undefined` 覆盖）。pinned by Task 4 单测。
3. **fallback_pending 无 url**：`emitTerminalFromResult` 不得发 `done`（无正据）。pinned by Task 1 单测。
4. **propose 快捷生成无 runId**：`dispatchNodeStatus` stamp 不到 `entry.currentRunId` → roundKey 缺省，批次归组不得猜并（独立卡）。pinned by Task 1 + Task 7 单测。
5. **自动播放**：内联 `<audio>/<video>` 不得带 autoplay 属性。pinned by Task 6 组件契约测试。

---

### Task 1: pi-runtime `NodeStatusData` v2 + run_* 工具交付元数据发射

**Files:**
- Modify: `services/pi-runtime/src/session-manager.ts:159-166`（`NodeStatusData`）、`:2143-2153`（`dispatchNodeStatus` stamp roundKey）
- Modify: `services/pi-runtime/src/tools/generation.ts:142-154`（`emitTerminalFromResult`）
- Test: `services/pi-runtime/src/tools/generation.test.ts`、`services/pi-runtime/src/session-manager.test.ts`

**Interfaces:**
- Consumes: 既有 `emitNodeStatus(tc, data)`、`emitTerminalFromResult(tc, nodeId, data)`（改为四参）、`entry.currentRunId`（run_start 已置位，session-manager.ts:1567）。
- Produces: `NodeStatusData` v2（可选字段 `kind/mimeType/durationMs/posterUrl/version/roundKey/terminalState/summary`）；导出纯函数 `deliveryMetaFromData(kind, data)`，Task 2/3 复用。

- [ ] **Step 1: 写失败测试（deliveryMetaFromData 纯函数）**

在 `services/pi-runtime/src/tools/generation.test.ts` 追加（文件是 node:test 的 `test()` 风格，从 `./generation.js` 补 import `deliveryMetaFromData`）：

```ts
test("deliveryMetaFromData：timeout → terminalState=timeout，无 url 语义", () => {
	const meta = deliveryMetaFromData("image", { status: "timeout" });
	assert.equal(meta.terminalState, "timeout");
});

test("deliveryMetaFromData：fallback_pending → terminalState=fallback_pending", () => {
	assert.equal(deliveryMetaFromData("video", { status: "fallback_pending" }).terminalState, "fallback_pending");
});

test("deliveryMetaFromData：正常终态 → terminalState undefined，提取 mimeType/durationMs", () => {
	const meta = deliveryMetaFromData("audio", { mimeType: "audio/mpeg", durationMs: 1200 });
	assert.equal(meta.terminalState, undefined);
	assert.equal(meta.mimeType, "audio/mpeg");
	assert.equal(meta.durationMs, 1200);
});

test("deliveryMetaFromData：text 摘要 ≤80 字且压空白；非 text 不产 summary", () => {
	const long = "a".repeat(200);
	const s = deliveryMetaFromData("text", { content: `  ${long}  ` }).summary!;
	assert.equal(s.length, 80);
	assert.equal(deliveryMetaFromData("image", { content: long }).summary, undefined);
});

test("deliveryMetaFromData：非法值 fail-soft（负数/空串/错型 → undefined）", () => {
	const meta = deliveryMetaFromData("image", { durationMs: -1, mimeType: "", version: "x" });
	assert.equal(meta.durationMs, undefined);
	assert.equal(meta.mimeType, undefined);
	assert.equal(meta.version, undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd services/pi-runtime && node --import tsx --test src/tools/generation.test.ts`
Expected: FAIL（`deliveryMetaFromData` 未导出）

- [ ] **Step 3: 最小实现**

`generation.ts` 顶部工具域新增并导出：

```ts
type DeliveryKind = "image" | "video" | "audio" | "text";

function strField(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key];
  return typeof v === "string" && v ? v : undefined;
}
function numField(data: Record<string, unknown>, key: string): number | undefined {
  const v = data[key];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** 交付卡 v2 元数据（spec 2026-11-02-delivery-card-v1 §5.2）：全部 fail-soft 可选。 */
export function deliveryMetaFromData(
  kind: DeliveryKind,
  data: Record<string, unknown>,
): Pick<
  import("../session-manager.js").NodeStatusData,
  "kind" | "mimeType" | "durationMs" | "posterUrl" | "version" | "terminalState" | "summary"
> {
  const status = strField(data, "status");
  const terminalState =
    status === "timeout" ? ("timeout" as const)
    : status === "fallback_pending" ? ("fallback_pending" as const)
    : undefined;
  const raw = kind === "text"
    ? (strField(data, "summary") ?? strField(data, "content") ?? strField(data, "preview"))
    : undefined;
  return {
    kind,
    mimeType: strField(data, "mimeType"),
    durationMs: numField(data, "durationMs"),
    posterUrl: strField(data, "posterUrl"),
    version: numField(data, "version"),
    terminalState,
    summary: raw ? raw.replace(/\s+/g, " ").trim().slice(0, 80) || undefined : undefined,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd services/pi-runtime && node --import tsx --test src/tools/generation.test.ts`
Expected: PASS

- [ ] **Step 5: 写失败测试（emitTerminalFromResult v2 发射 + dispatchNodeStatus roundKey stamp）**

`generation.test.ts` 追加（复用文件头既有 `run()` 与 `fakeClient()` 手法；fakeClient 改造为可注入响应）：

```ts
test("run_image_generation v2：done 拍携带 kind/url/mimeType 元数据", async () => {
	const seen: Array<Record<string, unknown>> = [];
	const fake = fakeClient();
	const tool = createGenerationTools(fake as never, {
		onNodeStatus: (_sid, d) => seen.push(d as Record<string, unknown>),
	}).find((t) => t.name === "run_image_generation")!;
	await run(tool, { node_id: "n1" });
	const shot = seen.at(-1)!;
	assert.equal(shot.status, "done");
	assert.equal(shot.kind, "image");
	assert.equal(shot.url, "https://x/y.png");
});

test("timeout → 下发 {status:'generating', terminalState:'timeout'}（此前不下发任何拍）", async () => {
	const seen: Array<Record<string, unknown>> = [];
	const fake = fakeClient();
	fake.post = async () => ({ status: "timeout" });
	const tool = createGenerationTools(fake as never, {
		onNodeStatus: (_sid, d) => seen.push(d as Record<string, unknown>),
	}).find((t) => t.name === "run_image_generation")!;
	await run(tool, { node_id: "n1" });
	assert.equal(seen.length, 1);
	assert.equal(seen[0]?.status, "generating");
	assert.equal(seen[0]?.terminalState, "timeout");
});

test("PI_RUNTIME_DELIVERY_META=off → 回滚开关：timeout 拍不下发、done 无 v2 字段", async () => {
	process.env.PI_RUNTIME_DELIVERY_META = "off";
	try {
		const seen: Array<Record<string, unknown>> = [];
		const fake = fakeClient();
		fake.post = async () => ({ status: "timeout" });
		const t1 = createGenerationTools(fake as never, { onNodeStatus: (_sid, d) => seen.push(d as Record<string, unknown>) })
			.find((t) => t.name === "run_image_generation")!;
		await run(t1, { node_id: "n1" });
		assert.equal(seen.length, 0);

		const seen2: Array<Record<string, unknown>> = [];
		const fake2 = fakeClient();
		const t2 = createGenerationTools(fake2 as never, { onNodeStatus: (_sid, d) => seen2.push(d as Record<string, unknown>) })
			.find((t) => t.name === "run_image_generation")!;
		await run(t2, { node_id: "n1" });
		assert.equal(seen2[0]?.status, "done");
		assert.equal("kind" in (seen2[0] ?? {}), false);
	} finally {
		delete process.env.PI_RUNTIME_DELIVERY_META;
	}
});
```

（`fakeClient()` 返回对象需把 `post` 声明为可覆写属性——把 `const calls` 返回对象改为 `post: async (...)` 普通属性即可直接赋值覆盖。）

`session-manager.test.ts` 追加（currentRunId 是内部态，白盒置位；用 `as unknown as` 双段断言，禁 `as never`——CI tsc 编译测试文件）：

```ts
it("dispatchNodeStatus v2：roundKey 缺省 stamp entry.currentRunId；显式 roundKey 不覆盖", async () => {
	const sm = smWithSession();
	await sm.create("thread-rk", { canvasSessionId: "canvas-rk" });
	const seen: Array<{ type: string; data: Record<string, unknown> }> = [];
	sm.subscribe("thread-rk", (e) => seen.push({ type: e.type, data: e.data as Record<string, unknown> }));
	const internal = sm as unknown as {
		sessions: Map<string, { currentRunId?: string }>;
	};
	for (const entry of internal.sessions.values()) entry.currentRunId = "r1";
	sm.dispatchNodeStatus("canvas-rk", { nodeId: "n1", status: "done", url: "https://x/a.png" });
	assert.equal(seen[0]?.data.roundKey, "r1");
	sm.dispatchNodeStatus("canvas-rk", { nodeId: "n1", status: "done", url: "https://x/a.png", roundKey: "explicit" });
	assert.equal(seen[1]?.data.roundKey, "explicit");
});

it("无 currentRunId（propose 快捷路径）→ 不 stamp（独立卡，不猜归组）", async () => {
	const sm = smWithSession();
	await sm.create("thread-nork", { canvasSessionId: "canvas-nork" });
	const seen: Array<{ type: string; data: Record<string, unknown> }> = [];
	sm.subscribe("thread-nork", (e) => seen.push({ type: e.type, data: e.data as Record<string, unknown> }));
	sm.dispatchNodeStatus("canvas-nork", { nodeId: "n1", status: "done", url: "https://x/a.png" });
	assert.equal("roundKey" in (seen[0]?.data ?? {}), false);
});
```

- [ ] **Step 6: 跑测试确认失败 → 实现 → 通过**

`session-manager.ts` `NodeStatusData`（:159）追加可选字段：

```ts
	/** 交付卡 v2（spec 2026-11-02-delivery-card-v1 §5.2）：全部可选，旧消费者忽略。 */
	kind?: "image" | "video" | "audio" | "text";
	mimeType?: string;
	durationMs?: number;
	posterUrl?: string;
	version?: number;
	/** 交付批次键；缺省由 dispatchNodeStatus stamp entry.currentRunId。 */
	roundKey?: string;
	/** 精确子态：running 之下的 timeout / fallback_pending（D-2：不翻终态）。 */
	terminalState?: "timeout" | "fallback_pending";
	summary?: string;
```

`dispatchNodeStatus`（:2143）dispatch 前补 stamp：

```ts
const stamped: NodeStatusData =
  data.roundKey || entry.currentRunId
    ? { ...data, ...(data.roundKey ? {} : { roundKey: entry.currentRunId }) }
    : data;
this.dispatch(entry, { type: "node_status", ts: Date.now(), data: stamped });
```

`generation.ts` `emitTerminalFromResult`（:142）改四参并按 v2 发射：

```ts
const deliveryMetaEnabled = () => process.env.PI_RUNTIME_DELIVERY_META !== "off";

const emitTerminalFromResult = (
  tc: LnkpiToolContext, nodeId: string, kind: DeliveryKind, data: Record<string, unknown>,
) => {
  // 回滚开关（spec §11.1）：off → 逐字节旧行为（不发 v2 字段、timeout 拍不下发）
  if (!deliveryMetaEnabled()) {
    const url = typeof data.url === "string" && data.url ? data.url : undefined;
    if (url) { emitNodeStatus(tc, { nodeId, status: "done", url }); return; }
    const error = typeof data.errorMessage === "string" && data.errorMessage ? data.errorMessage : undefined;
    if (error) emitNodeStatus(tc, { nodeId, status: "failed", error });
    return;
  }
  const meta = deliveryMetaFromData(kind, data);
  const url = typeof data.url === "string" && data.url ? data.url : undefined;
  if (url) { emitNodeStatus(tc, { nodeId, status: "done", url, ...meta }); return; }
  const status = String(data.status ?? "");
  const error = typeof data.errorMessage === "string" && data.errorMessage ? data.errorMessage : undefined;
  if (status === "error" || status === "failed" || error) {
    emitNodeStatus(tc, { nodeId, status: "failed", error, ...meta }); return;
  }
  if (meta.terminalState) {
    // timeout / fallback_pending：无正据，保「有正据才动」——status 保持 generating（D-2）
    emitNodeStatus(tc, { nodeId, status: "generating", ...meta });
  }
  // 其他中间态：维持既有口径不下发
};
```

`runTool` 内调用点（:198）改 `emitTerminalFromResult(tc, p.node_id, kindOfName(name), data)`，其中：

```ts
const kindOfName = (name: string): DeliveryKind =>
  name.includes("image") ? "image" : name.includes("video") ? "video"
  : name.includes("audio") ? "audio" : "text";
```

Run: `cd services/pi-runtime && node --import tsx --test src/tools/generation.test.ts src/session-manager.test.ts`
Expected: PASS（既有用例零回归）

- [ ] **Step 7: Commit**

```bash
git add services/pi-runtime/src/session-manager.ts services/pi-runtime/src/tools/generation.ts services/pi-runtime/src/tools/generation.test.ts services/pi-runtime/src/session-manager.test.ts
git commit -m "feat(pi-runtime): node_status v2 交付元数据 + timeout/fallback 子态下发"
```

---

### Task 2: pi-runtime notifyGenerationTerminal 同步补拍 node_status v2

**Files:**
- Modify: `services/pi-runtime/src/session-manager.ts:174-185`（`GenerationTerminalNotice`）、`:2202-2222`（`notifyGenerationTerminal`）
- Test: `services/pi-runtime/src/session-manager.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `NodeStatusData` v2。
- Produces: `GenerationTerminalNotice` 增 `mediaKind?: "image"|"video"|"audio"|"text"`、`roundKey?: string`、`version?: number`；补拍行为供 Task 3 Nest 侧透传消费。

- [ ] **Step 1: 写失败测试**

`session-manager.test.ts` 追加（`smWithSession` 的 fake lane 缺 `followUp`——本地建带 followUp 桩的工厂，不改共享 helper）：

```ts
describe("notifyGenerationTerminal v2 补拍", () => {
	async function smWithFollowUp() {
		const fakeHarnessFactory = async () =>
			({
				harness: {
					events: { on: () => () => {} },
					lane: async () => ({
						prompt: async () => ({ ok: true }),
						followUp: async () => ({ ok: true }),
					}),
					close: async () => {},
				},
			}) as never;
		return new SessionManager([], "", undefined, fakeHarnessFactory, undefined, undefined, testConfig());
	}
	async function setup() {
		const sm = await smWithFollowUp();
		await sm.create("thread-late", { canvasSessionId: "canvas-late" });
		const shots: Array<Record<string, unknown>> = [];
		const others: string[] = [];
		sm.subscribe("thread-late", (e) => {
			if (e.type === "node_status") shots.push(e.data as Record<string, unknown>);
			else others.push(e.type);
		});
		return { sm, shots, others };
	}

	it("completed 且有 url → 先补拍 {status:'done',url,roundKey,mediaKind} 再入 followUp", async () => {
		const { sm, shots } = await setup();
		await sm.notifyGenerationTerminal("thread-late", {
			nodeId: "n1", status: "completed", url: "https://x/v.mp4",
			mediaKind: "video", roundKey: "r9",
		});
		assert.equal(shots.length, 1);
		assert.deepEqual(shots[0], { nodeId: "n1", status: "done", url: "https://x/v.mp4", kind: "video", roundKey: "r9" });
	});

	it("completed 无 url → 不补拍 done（D-2 有正据才动）", async () => {
		const { sm, shots } = await setup();
		await sm.notifyGenerationTerminal("thread-late", { nodeId: "n1", status: "completed" });
		assert.equal(shots.length, 0);
	});

	it("failed → 补拍 {status:'failed',error,kind}；error 缺省省键", async () => {
		const { sm, shots } = await setup();
		await sm.notifyGenerationTerminal("thread-late", {
			nodeId: "n1", status: "failed", error: "上游 500", mediaKind: "image",
		});
		assert.deepEqual(shots[0], { nodeId: "n1", status: "failed", error: "上游 500", kind: "image" });
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd services/pi-runtime && node --import tsx --test src/session-manager.test.ts`
Expected: 新用例 FAIL

- [ ] **Step 3: 实现**

`GenerationTerminalNotice`（:174）追加：

```ts
	/** 交付卡 v2：产物类型（区别于 kind 的中文通报文案）。 */
	mediaKind?: "image" | "video" | "audio" | "text";
	/** 交付批次键（原 runId，Nest 通报体尽力携带；缺省降级独立卡）。 */
	roundKey?: string;
	version?: number;
```

`notifyGenerationTerminal`（:2202）在 `await this.followUp(...)` 之前插入：

```ts
		// 交付卡 v2 补拍（spec §7）：roundKey 使迟到终态归入原回合组卡；
		// done 仅在有 url 时发（D-2 有正据才动）；backfill 轮询保留为降级兜底，幂等由
		// web mapNodeStatus 单调守卫保证（乱序补发无害）。
		const shot: NodeStatusData | undefined =
			data.status === "completed" && data.url
				? { nodeId: data.nodeId, status: "done", url: data.url,
					...(data.mediaKind ? { kind: data.mediaKind } : {}),
					...(typeof data.version === "number" ? { version: data.version } : {}),
					...(data.roundKey ? { roundKey: data.roundKey } : {}) }
				: data.status === "failed"
					? { nodeId: data.nodeId, status: "failed",
						...(data.error ? { error: data.error } : {}),
						...(data.mediaKind ? { kind: data.mediaKind } : {}),
						...(data.roundKey ? { roundKey: data.roundKey } : {}) }
					: undefined;
		if (shot) this.dispatchNodeStatus(canvasId, shot);
```

- [ ] **Step 4: 跑测试确认通过**（同 Step 2 命令，Expected: PASS）

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/session-manager.ts services/pi-runtime/src/session-manager.test.ts
git commit -m "feat(pi-runtime): notify-generation 同步补拍 node_status v2（roundKey 归组）"
```

---

### Task 3: Nest 侧透传（pi-events 白名单 + late-generation-notify + client/app 契约）

**Files:**
- Modify: `apps/server/src/agent/pi-runtime/pi-events.ts:220-237`（node_status 白名单）
- Modify: `apps/server/src/agent/pi-runtime/late-generation-notify.ts`（通知体补 mediaKind/roundKey）
- Modify: `apps/server/src/agent/pi-runtime/pi-runtime.client.ts:466-485`（notifyGeneration 载荷类型）
- Test: `apps/server/src/agent/pi-runtime/pi-events.test.ts`、`apps/server/src/agent/pi-runtime/late-generation-notify.test.ts`

**Interfaces:**
- Consumes: Task 1/2 的 v2 字段名（逐字一致）。
- Produces: Nest → web 的 `node_status` 事件 data 含 v2 字段；`GenerationTerminalNotice` 通报体含 `mediaKind/roundKey`。

- [ ] **Step 1: 写失败测试**

`pi-events.test.ts` 追加：

```ts
it("node_status v2 字段白名单透传（kind/mimeType/durationMs/posterUrl/version/roundKey/terminalState/summary）", () => {
  const out = mapPiEventToUiEvent({ type: "node_status", ts: 1, data: {
    nodeId: "n1", status: "generating", terminalState: "timeout",
    kind: "image", version: 3, roundKey: "r1", summary: "x",
  } } as never);
  expect(out?.type).toBe("node_status");
  expect(out?.data).toMatchObject({ terminalState: "timeout", kind: "image", version: 3, roundKey: "r1" });
});
it("旧载荷（无 v2 字段）→ 输出不含 v2 键（逐字节兼容）", () => {
  const out = mapPiEventToUiEvent({ type: "node_status", ts: 1, data: { nodeId: "n1", status: "done", url: "u" } } as never);
  expect(out?.type).toBe("node_status");
  for (const k of ["kind", "mimeType", "durationMs", "posterUrl", "version", "roundKey", "terminalState", "summary"])
    expect(k in (out?.data ?? {})).toBe(false);
});
```

`late-generation-notify.test.ts` 追加（prisma/client 桩复用本文件既有 describe 内的构造手法；client 桩形态 = `{ notifyGeneration: async (body) => { bodies.push(body); return { delivered: true } } }`，同 ：159 先例）：

```ts
it("通报体携带 mediaKind（record.type 映射）与 roundKey（metadata.runId，尽力而为）", async () => {
  // 桩：record = { type: 'video', metadata: JSON.stringify({ runId: 'r9', ... }) }，status='failed' 落终态
  const handled = await notifyLateGenerationTerminals(prisma, captureClient, silentLogger);
  expect(handled).toBe(1);
  expect(captureClient.bodies[0]).toMatchObject({ mediaKind: "video", roundKey: "r9" });
});

it("metadata 无 runId → 不带 roundKey（不猜）", async () => {
  // 桩：metadata 不含 runId
  await notifyLateGenerationTerminals(prisma, captureClient, silentLogger);
  expect(captureClient.bodies[0]).not.toHaveProperty("roundKey");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `nvm use 24 && npx vitest run apps/server/src/agent/pi-runtime/pi-events.test.ts apps/server/src/agent/pi-runtime/late-generation-notify.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: 新用例 FAIL

- [ ] **Step 3: 实现**

`pi-events.ts` node_status 分支（:225-236）扩白名单：

```ts
		const d = event.data as {
			nodeId?: string; status?: string; url?: string; error?: string;
			kind?: string; mimeType?: string; durationMs?: number; posterUrl?: string;
			version?: number; roundKey?: string;
			terminalState?: string; summary?: string;
		};
		return ui("node_status", {
			nodeId: d.nodeId, status: d.status, url: d.url, error: d.error,
			// 交付卡 v2（spec §5.2）：白名单逐字段透传，缺省不落键（旧载荷逐字节兼容）
			...(d.kind ? { kind: d.kind } : {}),
			...(d.mimeType ? { mimeType: d.mimeType } : {}),
			...(typeof d.durationMs === "number" ? { durationMs: d.durationMs } : {}),
			...(d.posterUrl ? { posterUrl: d.posterUrl } : {}),
			...(typeof d.version === "number" ? { version: d.version } : {}),
			...(d.roundKey ? { roundKey: d.roundKey } : {}),
			...(d.terminalState ? { terminalState: d.terminalState } : {}),
			...(d.summary ? { summary: d.summary } : {}),
		});
```

`late-generation-notify.ts`：构造通知处按 `record.type` 映射 `mediaKind`（`image/image_edit/image_upscale→image`、`video→video`、`tts/audio/music→audio`、其余→`text`，映射表提为模块常量 `MEDIA_KIND_BY_TYPE`），`roundKey` 取 `parseMeta(rec.metadata).runId`（`typeof === 'string'` 才带）。

`pi-runtime.client.ts` `notifyGeneration` 载荷类型同步加 `mediaKind?/roundKey?/version?`。

- [ ] **Step 4: 跑测试确认通过**（同 Step 2 命令 + `npx vitest run apps/server/src/agent/pi-runtime/pi-runtime.client.test.ts --maxWorkers=1 --no-file-parallelism`）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/pi-runtime/pi-events.ts apps/server/src/agent/pi-runtime/pi-events.test.ts apps/server/src/agent/pi-runtime/late-generation-notify.ts apps/server/src/agent/pi-runtime/late-generation-notify.test.ts apps/server/src/agent/pi-runtime/pi-runtime.client.ts
git commit -m "feat(server): node_status v2 白名单透传 + 回合外通报携带 mediaKind/roundKey"
```

---

### Task 4: web turnTimeline artifact part v2 + 单调守卫

**Files:**
- Modify: `apps/web/src/components/agent/turnTimeline.ts:61-80`（artifact part）、`:534-565`（case node_status）
- Test: `apps/web/src/components/agent/turnTimeline.test.ts`

**Interfaces:**
- Consumes: Task 3 透传的 v2 字段。
- Produces: artifact part 新可选字段（`kind/terminalState/version/roundKey/summary/mimeType/durationMs/posterUrl`）；导出 `deliveryKindOf(part)` 供 Task 5/6 复用；`TimelineEvent` node_status data 类型同步扩展（`:167`）。

- [ ] **Step 1: 写失败测试**

`turnTimeline.test.ts` 追加（复用文件头既有 `feed()` / `byKind()` 助手）：

```ts
describe('delivery card v2: node_status 映射', () => {
  const gen = (id: string) => addNode(id)

  it('timeout 拍：status 保持 running + terminalState/kind 落 part', () => {
    const tl = feed([
      gen('n1'),
      { type: 'node_status', data: { nodeId: 'n1', status: 'generating', terminalState: 'timeout', kind: 'image' } },
    ])
    const p = byKind(tl, 'artifact')[0]!
    expect(p.status).toBe('running')
    expect(p.terminalState).toBe('timeout')
    expect(p.kind).toBe('image')
  })

  it('单调守卫：done 后晚到的 generating/timeout 拍不回退', () => {
    const tl = feed([
      gen('n1'),
      { type: 'node_status', data: { nodeId: 'n1', status: 'done', url: 'http://img/x.png', kind: 'image' } },
      { type: 'node_status', data: { nodeId: 'n1', status: 'generating', terminalState: 'timeout' } },
    ])
    const p = byKind(tl, 'artifact')[0]!
    expect(p.status).toBe('done')
    expect(p.terminalState).toBeUndefined()
  })

  it('timeout → done 原地翻正（terminalState 清空、url 落盘）', () => {
    const tl = feed([
      gen('n1'),
      { type: 'node_status', data: { nodeId: 'n1', status: 'generating', terminalState: 'timeout' } },
      { type: 'node_status', data: { nodeId: 'n1', status: 'done', url: 'http://img/x.png', version: 3 } },
    ])
    const p = byKind(tl, 'artifact')[0]!
    expect(p.status).toBe('done')
    expect(p.url).toBe('http://img/x.png')
    expect(p.version).toBe(3)
    expect(p.terminalState).toBeUndefined()
  })

  it('旧载荷无 v2 字段 → part 不新增键（逐字节旧行为）', () => {
    const tl = feed([gen('n1'), { type: 'node_status', data: { nodeId: 'n1', status: 'done', url: 'http://img/x.png' } }])
    const p = byKind(tl, 'artifact')[0]! as Record<string, unknown>
    for (const k of ['kind', 'version', 'roundKey', 'terminalState', 'summary', 'mimeType', 'durationMs', 'posterUrl'])
      expect(k in p).toBe(false)
  })

  it('roundKey / summary 落 part（Task 7 归组数据源）', () => {
    const tl = feed([
      gen('n1'),
      { type: 'node_status', data: { nodeId: 'n1', status: 'done', url: 'http://img/x.png', roundKey: 'r1', summary: '首图完成' } },
    ])
    const p = byKind(tl, 'artifact')[0]!
    expect(p.roundKey).toBe('r1')
    expect(p.summary).toBe('首图完成')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `nvm use 24 && npx vitest run apps/web/src/components/agent/turnTimeline.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: 新用例 FAIL

- [ ] **Step 3: 实现**

artifact part（:61-80）追加字段：

```ts
      /** 交付卡 v2（spec §5.2/§7）：全部可选；缺省时渲染层走旧路径。 */
      kind?: 'image' | 'video' | 'audio' | 'text'
      mimeType?: string
      durationMs?: number
      posterUrl?: string
      version?: number
      roundKey?: string
      terminalState?: 'timeout' | 'fallback_pending'
      summary?: string
```

`TimelineEvent` node_status data 类型（:167）同构扩展。case 'node_status'（:534）重写：

```ts
    case 'node_status': {
      const d = event.data
      const status = nodeStatusToArtifact(d.status)
      const mediaUrl =
        d.status !== 'failed' && typeof d.url === 'string' && d.url ? d.url : undefined
      const existing = timeline.parts.find(
        (p): p is Extract<TimelinePart, { kind: 'artifact' }> =>
          p.kind === 'artifact' && p.nodeId === d.nodeId,
      )
      if (existing) {
        // 单调守卫（v2，Review Focus 1）：done/failed 是吸收态，晚到的 running/子态拍不得回退
        if ((existing.status === 'done' || existing.status === 'failed') && status === 'running') return
        existing.status = status
        if (mediaUrl) existing.url = mediaUrl
        if (d.status === 'failed') {
          existing.errorText = typeof d.url === 'string' && d.url ? d.url : '生成失败，可重试'
        }
        // v2 字段：缺省不落键（Review Focus 2 逐字节兼容）；子态只在 running 态有效
        if (d.kind === 'image' || d.kind === 'video' || d.kind === 'audio' || d.kind === 'text') existing.kind = d.kind
        if (typeof d.version === 'number') existing.version = d.version
        if (typeof d.roundKey === 'string' && d.roundKey) existing.roundKey = d.roundKey
        if (typeof d.summary === 'string' && d.summary) existing.summary = d.summary
        if (typeof d.mimeType === 'string' && d.mimeType) existing.mimeType = d.mimeType
        if (typeof d.durationMs === 'number') existing.durationMs = d.durationMs
        if (typeof d.posterUrl === 'string' && d.posterUrl) existing.posterUrl = d.posterUrl
        existing.terminalState =
          status === 'running' && (d.terminalState === 'timeout' || d.terminalState === 'fallback_pending')
            ? d.terminalState
            : undefined
        return
      }
      timeline.parts.push({
        kind: 'artifact', id: nextPartId('artifact'), nodeId: d.nodeId, nodeType: 'image',
        title: '未命名', status, url: mediaUrl,
        errorText: d.status === 'failed' ? '生成失败，可重试' : undefined,
        ...(d.kind === 'image' || d.kind === 'video' || d.kind === 'audio' || d.kind === 'text' ? { kind: d.kind } : {}),
        ...(typeof d.roundKey === 'string' && d.roundKey ? { roundKey: d.roundKey } : {}),
        ...(typeof d.summary === 'string' && d.summary ? { summary: d.summary } : {}),
        ...(typeof d.version === 'number' ? { version: d.version } : {}),
      })
      return
    }
```

新增导出（Task 5/6 消费）：

```ts
export type DeliveryKind = 'image' | 'video' | 'audio' | 'text'
/** 交付路由：显式 kind 优先，缺省按 nodeType 兜底（旧数据路径）。 */
export function deliveryKindOf(p: Extract<TimelinePart, { kind: 'artifact' }>): DeliveryKind {
  if (p.kind) return p.kind
  const t = p.nodeType
  return t === 'video' || t === 'audio' || t === 'text' ? t : 'image'
}
```

- [ ] **Step 4: 跑测试确认通过**（同 Step 2 命令）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agent/turnTimeline.ts apps/web/src/components/agent/turnTimeline.test.ts
git commit -m "feat(web): turnTimeline artifact part v2 + done/failed 吸收态单调守卫"
```

---

### Task 5: 动作矩阵与交付遥测（纯函数）

**Files:**
- Create: `apps/web/src/components/agent/deliveryActions.ts`
- Create: `apps/web/src/components/agent/deliveryTelemetry.ts`
- Test: `apps/web/src/components/agent/deliveryActions.test.ts`

**Interfaces:**
- Consumes: Task 4 的 artifact part 字段与 `deliveryKindOf`。
- Produces: `deliveryActionsOf(part): DeliveryAction[]`（spec §6 动作矩阵唯一出处）；`deliveryKindOf` **从 `./turnTimeline` re-export**（Task 4 已定义，此处不重复实现）；`deliveryTelemetry.ts` 的事件 API（`reportDeliveryImpression/Open/InlinePlay`，waitTelemetry 同型：dev console.debug + prod stub）。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { deliveryActionsOf, type ArtifactLike } from './deliveryActions'

const base = (over: Partial<ArtifactLike>): ArtifactLike => ({
  nodeId: 'n1', status: 'done', ...over,
} as ArtifactLike)

describe('deliveryActionsOf（spec §6 动作矩阵）', () => {
  it('done·image → [locate, download]', () =>
    expect(deliveryActionsOf(base({ kind: 'image' }))).toEqual(['locate', 'download']))
  it('done·video / audio → [inline_play, locate]', () => {
    expect(deliveryActionsOf(base({ kind: 'video' }))).toEqual(['inline_play', 'locate'])
    expect(deliveryActionsOf(base({ kind: 'audio' }))).toEqual(['inline_play', 'locate'])
  })
  it('done·text → [locate]（阅读视图 P2-A）', () =>
    expect(deliveryActionsOf(base({ kind: 'text', summary: 'x' }))).toEqual(['locate']))
  it('kind 缺省按 nodeType 兜底（旧数据）', () =>
    expect(deliveryActionsOf(base({ nodeType: 'video' }))).toEqual(['inline_play', 'locate']))
  it('running 无动作；running·fallback_pending → [confirm_fallback]', () => {
    expect(deliveryActionsOf(base({ status: 'running' }))).toEqual([])
    expect(deliveryActionsOf(base({ status: 'running', terminalState: 'fallback_pending' }))).toEqual(['confirm_fallback'])
  })
  it('failed → [retry]（满足 D-1-4 重试或诊断之一）', () =>
    expect(deliveryActionsOf(base({ status: 'failed' }))).toEqual(['retry']))
})
```

- [ ] **Step 2: 跑测试确认失败**（`npx vitest run apps/web/src/components/agent/deliveryActions.test.ts --maxWorkers=1 --no-file-parallelism`，Expected: FAIL）

- [ ] **Step 3: 实现 `deliveryActions.ts`**

```ts
/**
 * 交付卡动作矩阵（spec 2026-11-02-delivery-card-v1 §6 的代码化，渲染层唯一动作来源）。
 * ArtifactLike 是 turnTimeline artifact part 的结构窄面（避免循环 import，测试同用）。
 * deliveryKindOf 从 ./turnTimeline re-export（Task 4 定义，单一出处）。
 */
import { deliveryKindOf } from './turnTimeline'
export { deliveryKindOf }

export type DeliveryAction = 'locate' | 'download' | 'inline_play' | 'confirm_fallback' | 'retry'

export interface ArtifactLike {
  nodeId: string
  status: 'pending' | 'running' | 'done' | 'failed'
  nodeType: string
  kind?: 'image' | 'video' | 'audio' | 'text'
  terminalState?: 'timeout' | 'fallback_pending'
}

export function deliveryActionsOf(p: ArtifactLike): DeliveryAction[] {
  if (p.status === 'failed') return ['retry']
  if (p.status === 'running')
    return p.terminalState === 'fallback_pending' ? ['confirm_fallback'] : []
  if (p.status !== 'done') return []
  switch (deliveryKindOf(p)) {
    case 'image': return ['locate', 'download']
    case 'video':
    case 'audio': return ['inline_play', 'locate']
    case 'text': return ['locate']
  }
}
```

- [ ] **Step 4: 跑测试确认通过 → 实现 `deliveryTelemetry.ts`（waitTelemetry.ts 同型拷贝改事件）**

```ts
/**
 * 交付卡可观测打点（spec §2 埋点项 / §10 验收④）。V1 与 waitTelemetry 同型：
 * console.debug（dev）+ stub（prod），后续接 analytics 平台只改这一处。
 */
export type DeliveryEvent =
  | { name: 'delivery_card_impression'; payload: { nodeId: string; kind: string; status: string } }
  | { name: 'delivery_card_open'; payload: { nodeId: string; action: string } }
  | { name: 'delivery_inline_play'; payload: { nodeId: string; kind: string } }

const impressions = new Set<string>()

export function reportDeliveryImpression(nodeId: string, kind: string, status: string): void {
  const key = `${nodeId}:${status}`
  if (impressions.has(key)) return
  impressions.add(key)
  emit({ name: 'delivery_card_impression', payload: { nodeId, kind, status } })
}

export function reportDeliveryOpen(nodeId: string, action: string): void {
  emit({ name: 'delivery_card_open', payload: { nodeId, action } })
}

export function reportDeliveryInlinePlay(nodeId: string, kind: string): void {
  emit({ name: 'delivery_inline_play', payload: { nodeId, kind } })
}

function emit(event: DeliveryEvent): void {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.debug('[telemetry]', event.name, event.payload)
  }
}
```

（同命令 Expected: PASS；Task 6 的组件测试再补 impression 幂等断言）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agent/deliveryActions.ts apps/web/src/components/agent/deliveryActions.test.ts apps/web/src/components/agent/deliveryTelemetry.ts
git commit -m "feat(web): 交付卡动作矩阵与遥测纯函数（waitTelemetry 同型）"
```

---

### Task 6: AgentTurnTimeline.vue 交付卡渲染增强 + Dev 样例

**Files:**
- Modify: `apps/web/src/components/agent/AgentTurnTimeline.vue:307-358`（artifact 分支）、`:118-123`（handler 区）
- Modify: `apps/web/src/pages/DevTimelinePreviewPage.vue`（六场景 fixture）
- Test: `apps/web/src/components/agent/AgentTurnTimeline.deliveryCard.test.ts`（新建，组件挂载契约）

**Interfaces:**
- Consumes: Task 4 part 字段、Task 5 `deliveryActionsOf/deliveryKindOf/reportDelivery*`；既有 emits `focusNode/retryNode`（:118-123）。
- Produces: 交付卡渲染（内联媒体/子态词/版本徽标/动作按钮）；**不新增 emit**——`confirm_fallback` 与 `locate` 同走 `focusNode`（确认面板在画布节点上，spec §6 动作矩阵）。

- [ ] **Step 1: 写失败组件测试（先钉契约）**

`AgentTurnTimeline.deliveryCard.test.ts`（挂载手法对齐同目录既有 `AgentSideRail.*.test.ts` 的 `@vue/test-utils` mount；props 以组件 `defineProps` 实参为准，`resolveNodeUrl` 等可选桩按需传）：

```ts
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentTurnTimeline from './AgentTurnTimeline.vue'
import * as telemetry from './deliveryTelemetry'
import type { TimelinePart } from './turnTimeline'

const art = (over: Partial<Extract<TimelinePart, { kind: 'artifact' }>> = {}): TimelinePart =>
  ({ kind: 'artifact', id: 'a1', nodeId: 'n1', nodeType: 'image', title: 'T', status: 'done', ...over }) as TimelinePart

const mountCard = (parts: TimelinePart[]) =>
  mount(AgentTurnTimeline, { props: { parts, streaming: false } as never })

describe('交付卡 v1 渲染契约', () => {
  it('done·audio → <audio controls> 且无 autoplay（Review Focus 5）', () => {
    const w = mountCard([art({ kind: 'audio', url: 'https://x/a.mp3' })])
    const el = w.find('audio')
    expect(el.exists()).toBe(true)
    expect(el.attributes('controls')).toBeDefined()
    expect(el.attributes('autoplay')).toBeUndefined()
  })

  it('done·video → <video controls>，posterUrl 在位时带 poster', () => {
    const w = mountCard([art({ kind: 'video', url: 'https://x/v.mp4', posterUrl: 'https://x/p.jpg' })])
    expect(w.find('video').attributes('poster')).toBe('https://x/p.jpg')
  })

  it('running·timeout → 文案含「仍在生成」，无任何动作按钮', () => {
    const w = mountCard([art({ status: 'running', terminalState: 'timeout' })])
    expect(w.text()).toContain('仍在生成')
    expect(w.findAll('button')).toHaveLength(0)
  })

  it('running·fallback_pending → 「去确认」按钮点击 emit focusNode', async () => {
    const w = mountCard([art({ status: 'running', terminalState: 'fallback_pending' })])
    const btn = w.findAll('button').find((b) => b.text().includes('去确认'))!
    await btn.trigger('click')
    expect(w.emitted('focusNode')![0]).toEqual(['n1'])
  })

  it('done·image → 下载链接 download 属性；version=3 → v3 徽标；缺省无 v 字样', () => {
    const w = mountCard([art({ kind: 'image', url: 'https://x/i.png', version: 3 })])
    expect(w.find('a[download]').attributes('href')).toBe('https://x/i.png')
    expect(w.text()).toContain('v3')
    const w2 = mountCard([art({ kind: 'image', url: 'https://x/i.png' })])
    expect(w2.text()).not.toMatch(/v\d/)
  })

  it('done·text → 摘要渲染；failed → 重试按钮 emit retryNode', async () => {
    const w = mountCard([art({ kind: 'text', summary: '首行摘要' })])
    expect(w.text()).toContain('首行摘要')
    const w2 = mountCard([art({ status: 'failed' })])
    await w2.findAll('button').find((b) => b.text().includes('重试'))!.trigger('click')
    expect(w2.emitted('retryNode')![0]).toEqual(['n1'])
  })

  it('impression：done part 首渲染上报恰一次（重渲染不重复）', async () => {
    const spy = vi.spyOn(telemetry, 'reportDeliveryImpression')
    const w = mountCard([art({ kind: 'image', url: 'https://x/i.png' })])
    w.vm.$forceUpdate()
    await w.vm.$nextTick()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `nvm use 24 && npx vitest run apps/web/src/components/agent/AgentTurnTimeline.deliveryCard.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL

- [ ] **Step 3: 实现**

artifact 分支（:307-358）按动作矩阵重写。核心结构（样式全部 `--lnk-*`，沿用 :362 起 proposal 分支的令牌纪律注释先例）：

```vue
      <!-- artifact → 交付卡 v1（spec 2026-11-02-delivery-card-v1 §6）：动作矩阵唯一来源
           deliveryActionsOf；内联媒体禁 autoplay（起播必须用户手势）；令牌一律 --lnk-*。 -->
      <div v-else-if="part.kind === 'artifact'" class="rounded border px-2 py-1.5"
        :class="part.status === 'failed' ? 'border-[var(--lnk-danger-border)]' : 'border-[var(--lnk-border-default)]'">
        <div class="flex items-center gap-1.5">
          <span>{{ statusIcon(part.status) }}</span>
          <span class="min-w-0 flex-1 truncate text-[var(--lnk-text-primary)]">{{ part.title }}</span>
          <span v-if="typeof part.version === 'number'"
            class="shrink-0 rounded bg-[var(--lnk-accent-subtle)] px-1 text-[10px] text-[var(--lnk-accent-text)]">v{{ part.version }}</span>
        </div>
        <!-- done·audio：内联起播（用户手势） -->
        <audio v-if="actions(part).includes('inline_play') && deliveryKindOf(part) === 'audio'"
          controls preload="none" class="mt-1 w-full" :src="artifactUrl(part)"
          @play="reportInlinePlay(part)" />
        <!-- done·video：内联起播 -->
        <video v-else-if="actions(part).includes('inline_play') && deliveryKindOf(part) === 'video'"
          controls preload="metadata" class="mt-1 w-full rounded" :src="artifactUrl(part)"
          :poster="part.posterUrl" @play="reportInlinePlay(part)" />
        <!-- done·image：缩略图（既有） + 下载 -->
        <a v-else-if="actions(part).includes('download') && artifactUrl(part)"
          :href="artifactUrl(part)" :download="part.title"
          class="mt-1 inline-block text-[10px] text-[var(--lnk-accent-text)] underline">下载</a>
        <p v-if="part.summary" class="mt-0.5 line-clamp-2 text-[10px] text-[var(--lnk-text-secondary)]">{{ part.summary }}</p>
        <span v-if="part.status === 'running'" class="text-[10px] text-[var(--lnk-text-muted)] animate-pulse">
          {{ part.terminalState === 'timeout' ? `仍在生成${elapsedLabel(part)}（生成仍在继续，完成后就地更新）` : part.terminalState === 'fallback_pending' ? '需确认平台 fallback' : `生成中${elapsedLabel(part)}` }}
        </span>
        <div class="mt-1 flex items-center gap-1.5">
          <CanvasLocateButton v-if="actions(part).includes('locate')" title="在画布中定位" @click="onLocate(part.nodeId)" />
          <button v-if="actions(part).includes('confirm_fallback')" type="button"
            class="shrink-0 rounded border border-[var(--lnk-accent-border)] bg-[var(--lnk-accent-subtle)] px-2 py-0.5 text-[10px] text-[var(--lnk-accent-text)]"
            @click="onLocate(part.nodeId)">去确认</button>
          <button v-if="actions(part).includes('retry')" type="button"
            class="shrink-0 rounded border border-[var(--lnk-danger-border)] px-1.5 py-0.5 text-[10px] text-[var(--lnk-danger-text)]"
            @click="onRetry(part.nodeId)">重试生成</button>
        </div>
      </div>
```

script 区配套（:118 后追加；`actions` 为逐 part computed——模板内用 `deliveryActionsOf(part)` 直调即可，避免函数声明遗漏）：

```ts
import { deliveryActionsOf, deliveryKindOf } from './deliveryActions'
import { reportDeliveryImpression, reportDeliveryInlinePlay } from './deliveryTelemetry'
type TimelineArtifactPart = Extract<TimelinePart, { kind: 'artifact' }>
const actions = (p: TimelineArtifactPart) => deliveryActionsOf(p)
function reportInlinePlay(p: TimelineArtifactPart) {
  reportDeliveryInlinePlay(p.nodeId, deliveryKindOf(p))
}
// impression（幂等在 telemetry 内）：done 首渲染报一次
watch(() => props.parts, (parts) => {
  for (const p of parts) {
    if (p.kind === 'artifact' && p.status === 'done')
      reportDeliveryImpression(p.nodeId, deliveryKindOf(p), 'done')
  }
}, { immediate: true, deep: true })
```

（`TimelineArtifactPart` = `Extract<TimelinePart, { kind: 'artifact' }>`，从 `./turnTimeline` import。）

`DevTimelinePreviewPage.vue` 增补六场景事件序列（§6 验收：单图 done+version / 四格同 roundKey / timeout→done 补拍 / fallback_pending / audio done / text summary）。

- [ ] **Step 4: 跑组件测试确认通过 + 类型检查**

Run: `npx vitest run apps/web/src/components/agent/AgentTurnTimeline.deliveryCard.test.ts apps/web/src/components/agent/turnTimeline.test.ts --maxWorkers=1 --no-file-parallelism && cd apps/web && npx vue-tsc -b`
Expected: PASS，`vue-tsc` 零错误

- [ ] **Step 5: 跑令牌守卫（新增样式必跑）**

Run: `nvm use 24 && npx vitest run apps/web/src/styles/design-token.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/agent/AgentTurnTimeline.vue apps/web/src/components/agent/AgentTurnTimeline.deliveryCard.test.ts apps/web/src/pages/DevTimelinePreviewPage.vue
git commit -m "feat(web): 交付卡 v1 渲染——内联媒体/精确子态/版本徽标/动作矩阵"
```

---

### Task 7: 批次归组（渲染期聚合）

**Files:**
- Create: `apps/web/src/components/agent/deliveryGroup.ts`
- Modify: `apps/web/src/components/agent/AgentTurnTimeline.vue`（模板按 RenderPart 渲染，组卡折叠为「本轮交付 · N 项」）
- Test: `apps/web/src/components/agent/deliveryGroup.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `part.roundKey`。
- Produces: `groupDeliveryCards(parts): RenderPart[]` 纯函数（D-5：确定性、不改 parts）。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { groupDeliveryCards, type RenderPart } from './deliveryGroup'
import type { TimelinePart } from './turnTimeline'

const art = (id: string, over: Partial<Extract<TimelinePart, { kind: 'artifact' }>> = {}): TimelinePart => ({
  kind: 'artifact', id, nodeId: `n_${id}`, nodeType: 'image', title: id, status: 'done', ...over,
} as TimelinePart)
const text = (id: string): TimelinePart => ({ kind: 'text', id, text: 'hi', status: 'done' })

describe('groupDeliveryCards（spec §5.4 图 3）', () => {
  it('相同 roundKey 的 artifact 归并到首个出现位（保序）', () => {
    const out = groupDeliveryCards([art('a1', { roundKey: 'r1' }), text('t1'), art('a2', { roundKey: 'r1' })])
    expect(out.map((p) => (p.kind === 'delivery_group' ? 'G' : p.id))).toEqual(['G', 't1'])
    const g = out[0] as Extract<RenderPart, { kind: 'delivery_group' }>
    expect(g.roundKey).toBe('r1')
    expect(g.parts.map((p) => p.id)).toEqual(['a1', 'a2'])
  })

  it('roundKey 缺失 → 独立卡原位（不猜归组）', () => {
    const out = groupDeliveryCards([art('a1'), art('a2', { roundKey: 'r1' }), art('a3')])
    expect(out.map((p) => (p.kind === 'delivery_group' ? 'G' : p.id))).toEqual(['a1', 'G', 'a3'])
  })

  it('不同 roundKey 各自成组，穿插保序', () => {
    const out = groupDeliveryCards([art('a1', { roundKey: 'r1' }), art('a2', { roundKey: 'r2' }), art('a3', { roundKey: 'r1' })])
    expect(out.map((p) => (p.kind === 'delivery_group' ? p.roundKey : p.id))).toEqual(['r1', 'r2'])
  })

  it('回合外通报补拍（同 roundKey 晚到）归入原组', () => {
    const out = groupDeliveryCards([art('a1', { roundKey: 'r1', status: 'running' }), text('t1'), art('a1', { roundKey: 'r1', status: 'done', url: 'u' })])
    const g = out[0] as Extract<RenderPart, { kind: 'delivery_group' }>
    expect(g.parts).toHaveLength(2)
  })

  it('确定性：同输入两次调用输出 deep-equal', () => {
    const input = [art('a1', { roundKey: 'r1' }), text('t1'), art('a2', { roundKey: 'r1' })]
    expect(groupDeliveryCards(input)).toEqual(groupDeliveryCards(input))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**（`npx vitest run apps/web/src/components/agent/deliveryGroup.test.ts --maxWorkers=1 --no-file-parallelism`，Expected: FAIL）

- [ ] **Step 3: 实现**

```ts
/**
 * 批次归组（spec 2026-11-02-delivery-card-v1 §5.4）：渲染期聚合，绝不改 parts 数组。
 * 判据：roundKey 相同 → 归并到组内首个成员的出现位；缺失 → 独立卡原位（D-5 / 图 3 Q1）。
 */
import type { TimelinePart } from './turnTimeline'

export type ArtifactPart = Extract<TimelinePart, { kind: 'artifact' }>
export interface DeliveryGroupPart {
  kind: 'delivery_group'
  id: string
  roundKey: string
  parts: ArtifactPart[]
}
export type RenderPart = TimelinePart | DeliveryGroupPart

export function groupDeliveryCards(parts: TimelinePart[]): RenderPart[] {
  const groups = new Map<string, DeliveryGroupPart>()
  const out: RenderPart[] = []
  for (const p of parts) {
    if (p.kind === 'artifact' && p.roundKey) {
      let g = groups.get(p.roundKey)
      if (!g) {
        g = { kind: 'delivery_group', id: `dg_${p.roundKey}`, roundKey: p.roundKey, parts: [] }
        groups.set(p.roundKey, g)
        out.push(g)
      }
      g.parts.push(p)
      continue
    }
    out.push(p)
  }
  return out
}
```

组件：`const renderParts = computed(() => groupDeliveryCards(props.parts))`，模板 `v-for` 从 `parts` 切到 `renderParts`，`delivery_group` 分支渲染组头（「本轮交付 · {{ parts.length }} 项」）+ 逐成员复用 artifact 卡（抽局部子模板或 v-for 内联同款标记）。

- [ ] **Step 4: 跑测试确认通过 + `cd apps/web && npx vue-tsc -b`**（Expected: PASS / 零错误）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agent/deliveryGroup.ts apps/web/src/components/agent/deliveryGroup.test.ts apps/web/src/components/agent/AgentTurnTimeline.vue
git commit -m "feat(web): 交付卡批次归组（roundKey 渲染期聚合，保序确定性）"
```

---

### Task 8: 收尾——全量回归 + 契约镜像核对 + PR

**Files:** 无新增（只跑验证）

- [ ] **Step 1: 全量相关测试（分批，禁并发）**

```bash
nvm use 24
cd services/pi-runtime && npm test
npx vitest run apps/server/src/agent/pi-runtime/pi-events.test.ts apps/server/src/agent/pi-runtime/late-generation-notify.test.ts apps/server/src/agent/pi-runtime/pi-runtime.client.test.ts --maxWorkers=1 --no-file-parallelism
npx vitest run apps/web/src/components/agent/turnTimeline.test.ts apps/web/src/components/agent/AgentTurnTimeline.deliveryCard.test.ts apps/web/src/components/agent/deliveryActions.test.ts apps/web/src/components/agent/deliveryGroup.test.ts --maxWorkers=1 --no-file-parallelism
cd apps/web && npx vue-tsc -b
```
Expected: 全 PASS；`vue-tsc` 零错误

- [ ] **Step 2: 契约镜像核对（spec §10）**：逐字比对 `generation.ts` v2 字段名 ↔ `pi-events.ts` 白名单 ↔ `turnTimeline.ts` part 字段三处拼写一致（字段漂移 = 静默丢字段，PR 描述里贴三段 diff 佐证）。

- [ ] **Step 3: 目视验收（spec §6 六场景）**：`DevTimelinePreviewPage` 逐场景核对桌面 + 移动（sheet 基座）两形态，截图贴 PR。

- [ ] **Step 4: push + PR（REST 通道）**

```bash
# push 走 api.github.com REST Git Data API（https 直推被代理挡）；
# PR 标题：feat: 对话流交付卡 v1（node_status v2 + 内联媒体 + 批次归组）
# PR 描述链接 spec：docs/superpowers/specs/2026-11-02-delivery-card-v1-design.md
```

Expected: CI 绿；squash merge。
