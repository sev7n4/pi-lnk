# pi-runtime 工具注册表骨架（P1-④/#11）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## 文档头（SPEC-CONVENTIONS）

- **状态**：已评审待执行（本计划由 P1-①②③ 盘点文档推导，事实依据见 Spec 列出的三份文档）
- **前置**：P1-① prompt 盘点 / P1-② 使用率证据 / P1-③ Nest HTTP 契约梳理（全部完成）；pi-runtime 0.0.2 已在 K3s 运行（NodePort 30100）
- **分支约定**：在 pi-lnk 仓库新建 feature 分支 `p1/tool-registry-skeleton` 执行；完成经人工 review 后 merge master（发布门对 `services/pi-runtime/**` 的触发行为需在首次 push 后用 `gh run list` 观察确认，不预设）
- **部署**：本计划不含部署。骨架 merge 后 pi-runtime 仍以纯文本模式运行（未配 NEST env 时工具自动禁用），实流验证在 #12/#13 进行

## 0. 配图索引

本文档不含图。理由：本计划是代码实现计划，全部内容由文件级改动、接口签名与代码块表达；架构关系图已在被引用的 spec（`2026-09-23-p1-nest-http-contract-audit.md`）与 postmortem 中归档，此处不重复。

**Goal:** 在 pi-runtime 内建最小工具注册表骨架：tier 元数据 + Nest HTTP 转发层（包络/超时/熔断/计数器）+ B-1 批次 7 个 read 工具，使 `SessionManager` 携带真实工具创建会话，且未配置 NEST env 时行为与现状完全一致（纯文本）。

**Architecture:** 零新增运行时依赖。工具实现 harness 原生 `AgentHarnessTool` 接口（TypeBox schema）；会话级 `sessionId`/`userId` 经 harness 的 `toolContext` 注入（per-session 值），工具在 execute 时读取；Nest 转发层用全局 `fetch` + AbortSignal 超时 + per-path 简易熔断；调用计数暴露到既有 `/metrics`。工具参数命名与老 runtime 保持 snake_case（shadow 比对行为对齐），出站 Nest body 映射为 camelCase。

**Tech Stack:** TypeScript ESM、`@earendil-works/pi-agent-core 0.85.1`（AgentHarnessTool）、`typebox 1.3.7`、node:test + tsx 测试。

**Spec:**
- `docs/superpowers/plans/2026-09-23-p1-nest-http-contract-audit.md`（端点/包络/超时/熔断契约）
- `docs/superpowers/plans/2026-09-23-p1-tool-usage-evidence.md`（tool_calls_total 必须内建的依据）
- `docs/superpowers/plans/2026-09-23-p1-prompt-context-audit.md`（sessionId/userId 上下文来源）
- 事实源代码：`services/agent-runtime/app/tools/{nest_client.py,definitions.py,tool_registry.py}`

## Global Constraints

- 零新增运行时依赖（devDeps 不动；测试用 node:test，禁 jest/vitest）
- import 后缀一律 `.js`（ESM 既有约定，见 session-manager.ts）
- TypeBox 从 `"typebox"` 包导入（**不是** `@sinclair/typebox`，pi-agent-core 0.85 同源）
- 工具对外参数名 = 老 runtime 的 snake_case（`node_id`）；Nest 出站 body = camelCase（`nodeId`）
- Nest 请求头必带 `x-lnkpi-service-token`；响应包络 `{code,message,data}`，`code !== 0` 必须抛错（HTTP 200 也算失败）
- 超时分层：默认 10s（本批全部为 canvas read）；预留 map：image 210s / video 690s（后续批次用，本批只实现默认值 + map 机制）
- 熔断参数与老 runtime 对齐：连续失败 5 次开路、冷却 60s，可被 env 覆盖（`NEST_BREAKER_THRESHOLD` / `NEST_BREAKER_COOLDOWN_MS`）
- `NEST_BASE_URL` 或 `NEST_SERVICE_TOKEN` 任一缺失 → 工具整体禁用（tools=[]），启动打 warning，**不得**让现有纯文本会话路径报错
- metrics 计数器名固定 `pi_runtime_tool_calls_total{tool,result}`，result ∈ ok|error|circuit_open
- 每个任务一个 commit，提交前 `pnpm typecheck` 必须过

## Review Focus

1. **HTTP 200 但 `code!==0`**：必须抛错且错误文案含 Nest 的 message（模型要能读到失败原因），不能把 `data=undefined` 塞给模型。→ Task 2 测试 2
2. **Nest 挂死**：调用必须在配置超时后失败，不能阻塞整个 run。→ Task 2 测试 3
3. **熔断误伤/不恢复**：开路期间不真正发请求（fail fast）；冷却结束后恢复放行。→ Task 2 测试 4
4. **env 缺失静默降级**：未配 NEST env 时 SessionManager 建会话、prompt、SSE 全链路与现状逐字节一致（tools=[] 而非抛错）。→ Task 5 测试 + 既有 /healthz 冒烟
5. **per-session 上下文串号**：两个并发会话调用同名工具，Nest 收到的 `sessionId` 必须各自正确（toolContext 闭包捕获错误会串画布）。→ Task 4 测试（双会话双 client 断言）

---

### Task 1: 测试基建 + 工具类型与 tier 元数据

**Files:**
- Modify: `services/pi-runtime/package.json`（scripts.test）
- Create: `services/pi-runtime/src/tools/types.ts`
- Test: `services/pi-runtime/src/tools/types.test.ts`

**Interfaces:**
- Consumes: `AgentHarnessTool`（`@earendil-works/pi-agent-core`，已装）
- Produces: `type ToolTier`、`type LnkpiToolContext { sessionId: string; userId?: string }`、`type LnkpiTool = AgentHarnessTool<LnkpiToolContext> & { tier: ToolTier }`（后续所有任务引用）

- [ ] **Step 1: 加 test script**

`package.json` scripts 增加：

```json
"test": "node --import tsx --test src/**/*.test.ts"
```

- [ ] **Step 2: 写失败测试**

`src/tools/types.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";

test("LnkpiTool 类型接受带 tier 的工具定义", () => {
	const ctx: LnkpiToolContext = { sessionId: "s1" };
	const tool: LnkpiTool = {
		name: "t1",
		label: "T1",
		description: "d",
		parameters: Type.Object({}),
		tier: "read",
		execute: async () => ({ content: [{ type: "text", text: "x" }], details: undefined }),
	};
	assert.equal(tool.tier, "read");
	assert.equal(ctx.sessionId, "s1");
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd services/pi-runtime && pnpm test`
Expected: FAIL（找不到 ./types.js）

- [ ] **Step 4: 最小实现 `src/tools/types.ts`**

```ts
/**
 * 工具注册表类型（P1-④）
 *
 * tier 与老 runtime `app/tools/tool_registry.py: TOOL_TIERS` 一一对应，
 * 供 before_tool 审批（B-3）与 metrics 分组使用；harness 不感知 tier。
 */
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";

export type ToolTier =
	| "read"
	| "write_light"
	| "lifecycle"
	| "workflow_io"
	| "export"
	| "gen"
	| "graph_batch"
	| "destructive";

/** 每会话注入 toolContext 的值；SessionManager.create 时构造。 */
export interface LnkpiToolContext {
	sessionId: string;
	userId?: string;
}

export type LnkpiTool = AgentHarnessTool<LnkpiToolContext> & { tier: ToolTier };
```

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add services/pi-runtime/package.json services/pi-runtime/src/tools/
git commit -m "feat(pi-runtime): tool type with tier metadata + node:test setup"
```

---

### Task 2: Nest 转发层（包络/超时/熔断/计数钩子）

**Files:**
- Create: `services/pi-runtime/src/tools/nest-client.ts`
- Test: `services/pi-runtime/src/tools/nest-client.test.ts`

**Interfaces:**
- Consumes: 无（独立模块）
- Produces: `class NestClient`，构造参数 `NestClientOptions`，方法 `post(path: string, body: unknown): Promise<unknown>`；`NestToolError`（含 `kind: "http"|"envelope"|"timeout"`）；`NestCircuitOpenError`；`loadNestConfig(): { baseUrl: string; token: string } | null`

- [ ] **Step 1: 写失败测试**（node:http 起本地桩服务，零依赖）

`src/tools/nest-client.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { NestClient, NestToolError, NestCircuitOpenError, loadNestConfig } from "./nest-client.js";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

async function withServer(handler: Handler, fn: (base: string, hits: () => number) => Promise<void>) {
	let hits = 0;
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (c: Buffer) => (raw += c));
		req.on("end", () => { hits += 1; handler(req, res, raw); });
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;
	try {
		await fn(`http://127.0.0.1:${port}`, () => hits);
	} finally {
		server.close();
	}
}

test("成功包络返回 data 且带上鉴权头与出站 body", async () => {
	await withServer(
		(req, res, body) => {
			assert.equal(req.headers["x-lnkpi-service-token"], "tok");
			assert.deepEqual(JSON.parse(body), { sessionId: "s1" });
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ code: 0, message: "ok", data: { nodes: [] } }));
		},
		async (base) => {
			const c = new NestClient({ baseUrl: base, token: "tok" });
			const data = await c.post("/agent/internal/get-canvas-summary", { sessionId: "s1" });
			assert.deepEqual(data, { nodes: [] });
		},
	);
});

test("HTTP 200 但 code!=0 必须抛错且文案含 Nest message", async () => {
	await withServer(
		(_req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ code: 4001, message: "canvas not found", data: null }));
		},
		async (base) => {
			const c = new NestClient({ baseUrl: base, token: "t" });
			await assert.rejects(
				() => c.post("/x", {}),
				(err: unknown) => err instanceof NestToolError && /canvas not found/.test((err as Error).message),
			);
		},
	);
});

test("Nest 挂死时按超时失败，不阻塞", async () => {
	await withServer(
		(_req, res) => { /* 永不响应 */ },
		async (base) => {
			const c = new NestClient({ baseUrl: base, token: "t", defaultTimeoutMs: 80 });
			await assert.rejects(() => c.post("/x", {}), NestToolError);
		},
	);
});

test("熔断：连续 5 次失败后 fail fast，冷却后恢复", async () => {
	await withServer(
		(_req, res) => { res.statusCode = 500; res.end("boom"); },
		async (base, hits) => {
			const c = new NestClient({ baseUrl: base, token: "t", breakerThreshold: 5, breakerCooldownMs: 60 });
			for (let i = 0; i < 5; i++) {
				await assert.rejects(() => c.post("/x", {}), NestToolError);
			}
			await assert.rejects(() => c.post("/x", {}), NestCircuitOpenError);
			assert.equal(hits(), 5, "开路期间不得真实发请求");
			await new Promise((r) => setTimeout(r, 80));
			await assert.rejects(() => c.post("/x", {}), NestToolError, "冷却后应放行并再次真实请求");
			assert.equal(hits(), 6);
		},
	);
});

test("onCall 钩子记录 ok/error/circuit_open", async () => {
	const seen: Array<[string, string]> = [];
	await withServer(
		(_req, res) => { res.statusCode = 500; res.end("x"); },
		async (base) => {
			const c = new NestClient({ baseUrl: base, token: "t", breakerThreshold: 1, breakerCooldownMs: 10_000, onCall: (t, o) => seen.push([t, o]) });
			await assert.rejects(() => c.post("/agent/internal/get-node", {}), NestToolError);
			await assert.rejects(() => c.post("/agent/internal/get-node", {}), NestCircuitOpenError);
			assert.deepEqual(seen, [["get-node", "error"], ["get-node", "circuit_open"]]);
		},
	);
});

test("loadNestConfig：env 齐全返回配置，缺任一返回 null", () => {
	const prev = { b: process.env.NEST_BASE_URL, t: process.env.NEST_SERVICE_TOKEN };
	try {
		delete process.env.NEST_BASE_URL; delete process.env.NEST_SERVICE_TOKEN;
		assert.equal(loadNestConfig(), null);
		process.env.NEST_BASE_URL = "http://x"; 
		assert.equal(loadNestConfig(), null);
		process.env.NEST_SERVICE_TOKEN = "tok";
		assert.deepEqual(loadNestConfig(), { baseUrl: "http://x", token: "tok" });
	} finally {
		if (prev.b === undefined) delete process.env.NEST_BASE_URL; else process.env.NEST_BASE_URL = prev.b;
		if (prev.t === undefined) delete process.env.NEST_SERVICE_TOKEN; else process.env.NEST_SERVICE_TOKEN = prev.t;
	}
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test`
Expected: FAIL（nest-client.js 不存在）

- [ ] **Step 3: 实现 `src/tools/nest-client.ts`**

```ts
/**
 * Nest HTTP 转发层（P1-④）。契约对齐老 runtime nest_client.py：
 * POST JSON + x-lnkpi-service-token 头 + {code,message,data} 包络 +
 * per-path 熔断（5 次/60s）+ 按路径超时（默认 10s；image 210s / video 690s 预留）。
 * 零依赖：fetch + AbortSignal.timeout。
 */
export interface NestClientOptions {
	baseUrl: string;
	token: string;
	fetchImpl?: typeof fetch;
	defaultTimeoutMs?: number;
	/** 按路径前缀覆盖超时，如 { "/agent/internal/run-video": 690_000 }（后续批次用）。 */
	timeoutOverrides?: Record<string, number>;
	breakerThreshold?: number;
	breakerCooldownMs?: number;
	onCall?: (pathTail: string, outcome: "ok" | "error" | "circuit_open") => void;
}

export class NestToolError extends Error {
	constructor(message: string, readonly kind: "http" | "envelope" | "timeout") {
		super(message);
	}
}
export class NestCircuitOpenError extends Error {}

interface BreakerState {
	failures: number;
	openUntil: number;
}

const pathTail = (p: string) => p.split("/").pop() ?? p;

export class NestClient {
	private readonly breaker = new Map<string, BreakerState>();
	private readonly fetchImpl: typeof fetch;
	private readonly defaultTimeoutMs: number;
	private readonly threshold: number;
	private readonly cooldownMs: number;

	constructor(private readonly opts: NestClientOptions) {
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 10_000;
		this.threshold = opts.breakerThreshold ?? 5;
		this.cooldownMs = opts.breakerCooldownMs ?? 60_000;
	}

	private timeoutMsFor(path: string): number {
		for (const [prefix, ms] of Object.entries(this.opts.timeoutOverrides ?? {})) {
			if (path.startsWith(prefix)) return ms;
		}
		return this.defaultTimeoutMs;
	}

	private checkCircuit(path: string): void {
		const st = this.breaker.get(path);
		if (st && st.openUntil > Date.now()) throw new NestCircuitOpenError(`circuit open for ${path}`);
	}

	private recordSuccess(path: string): void {
		this.breaker.delete(path);
	}

	private recordFailure(path: string): void {
		const st = this.breaker.get(path) ?? { failures: 0, openUntil: 0 };
		st.failures += 1;
		if (st.failures >= this.threshold) {
			st.openUntil = Date.now() + this.cooldownMs;
			st.failures = 0;
		}
		this.breaker.set(path, st);
	}

	async post(path: string, body: unknown): Promise<unknown> {
		this.checkCircuit(path);
		const timeoutMs = this.timeoutMsFor(path);
		try {
			const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-lnkpi-service-token": this.opts.token },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
			const payload = (await res.json().catch(() => null)) as { code?: number; message?: string; data?: unknown } | null;
			if (!res.ok) {
				this.recordFailure(path);
				this.opts.onCall?.(pathTail(path), "error");
				throw new NestToolError(`nest ${path} http ${res.status}: ${payload?.message ?? res.statusText}`, "http");
			}
			if (!payload || payload.code !== 0) {
				this.recordFailure(path);
				this.opts.onCall?.(pathTail(path), "error");
				throw new NestToolError(`nest ${path} code=${payload?.code}: ${payload?.message ?? "empty envelope"}`, "envelope");
			}
			this.recordSuccess(path);
			this.opts.onCall?.(pathTail(path), "ok");
			return payload.data;
		} catch (err) {
			if (err instanceof NestToolError || err instanceof NestCircuitOpenError) throw err;
			const isTimeout = err instanceof Error && err.name === "TimeoutError";
			this.recordFailure(path);
			this.opts.onCall?.(pathTail(path), "error");
			throw new NestToolError(`nest ${path} ${isTimeout ? "timeout after " + timeoutMs + "ms" : "network error"}: ${err instanceof Error ? err.message : String(err)}`, isTimeout ? "timeout" : "http");
		}
	}
}

export function loadNestConfig(): { baseUrl: string; token: string } | null {
	const baseUrl = process.env.NEST_BASE_URL;
	const token = process.env.NEST_SERVICE_TOKEN;
	if (!baseUrl || !token) return null;
	return { baseUrl, token };
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 6 个测试 PASS

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/tools/nest-client.ts services/pi-runtime/src/tools/nest-client.test.ts
git commit -m "feat(pi-runtime): Nest forwarding layer with envelope/timeout/breaker/counter hook"
```

---

### Task 3: `pi_runtime_tool_calls_total` 指标

**Files:**
- Modify: `services/pi-runtime/src/metrics.ts`
- Test: `services/pi-runtime/src/metrics.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `Metrics.observeToolCall(tool: string, outcome: "ok" | "error" | "circuit_open"): void`；render 输出 `pi_runtime_tool_calls_total{tool,result}`

- [ ] **Step 1: 写失败测试**

`src/metrics.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Metrics } from "./metrics.js";

test("tool_calls_total 按 tool|result 聚合并渲染", () => {
	const m = new Metrics();
	m.observeToolCall("get_node", "ok");
	m.observeToolCall("get_node", "ok");
	m.observeToolCall("get_node", "error");
	const out = m.render(0, "test");
	assert.match(out, /pi_runtime_tool_calls_total\{tool="get_node",result="ok"\} 2/);
	assert.match(out, /pi_runtime_tool_calls_total\{tool="get_node",result="error"\} 1/);
	assert.doesNotMatch(out, /result="circuit_open"/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test`
Expected: FAIL（observeToolCall 不存在）

- [ ] **Step 3: 实现**——`metrics.ts` 增加字段与方法，render 增加输出段（沿用既有 Map 计数风格）：

```ts
// 类内新增字段
private toolCalls = new Map<string, number>(); // key: tool|result

// 新增方法
observeToolCall(tool: string, outcome: "ok" | "error" | "circuit_open"): void {
	const key = `${tool}|${outcome}`;
	this.toolCalls.set(key, (this.toolCalls.get(key) ?? 0) + 1);
}

// render() 内、llm_prompt_errors 段之后追加：
lines.push("# HELP pi_runtime_tool_calls_total Tool invocations by tool and result.");
lines.push("# TYPE pi_runtime_tool_calls_total counter");
for (const [key, count] of [...this.toolCalls.entries()].sort()) {
	const [tool, result] = key.split("|");
	lines.push(`pi_runtime_tool_calls_total{tool="${esc(tool)}",result="${result}"} ${count}`);
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/metrics.ts services/pi-runtime/src/metrics.test.ts
git commit -m "feat(pi-runtime): pi_runtime_tool_calls_total counter (K2 gap from usage audit)"
```

---

### Task 4: B-1 七个 read 工具 + 注册工厂

**Files:**
- Create: `services/pi-runtime/src/tools/canvas-read.ts`
- Create: `services/pi-runtime/src/tools/registry.ts`
- Test: `services/pi-runtime/src/tools/canvas-read.test.ts`

**Interfaces:**
- Consumes: `LnkpiTool/LnkpiToolContext`（Task 1）、`NestClient`（Task 2）
- Produces: `buildCanvasReadTools(client: NestClient): LnkpiTool[]`（7 个）；每个工具 `execute` 期望 `toolContext: LnkpiToolContext`，出站 body 由工具内部映射

**工具清单**（端点与出站 body 逐条对照 `nest_client.py:216-596`，参数名保持老 runtime 的 snake_case）：

| tool | Nest 端点 | 工具入参（TypeBox） | 出站 body |
|---|---|---|---|
| get_canvas_summary | /agent/internal/get-canvas-summary | `{}` | `{sessionId}` |
| get_node | /agent/internal/get-node | `node_id` (required) | `{sessionId, nodeId}` |
| get_generation_status | /agent/internal/get-generation-status | `node_id` (required) | `{sessionId, nodeId}` |
| get_generation_diagnostic | /agent/internal/get-generation-diagnostic | `generation_record_id?`, `node_id?`（至少一个） | `{sessionId, nodeId?, generationRecordId?}` |
| get_canvas_layout | /agent/internal/get-canvas-layout | `{}` | `{sessionId}` |
| list_generation_tasks | /agent/internal/list-generation-tasks | `type?` | `{sessionId, userId?, type?}` |
| list_user_assets | /agent/internal/list-user-assets | `{}` | `{userId}` |

（`optimize_prompt` 与 3 个 deferred read 工具不在本批：optimize_prompt 非 HTTP 直译端点、deferred 者按 tool_registry `DEFERRED_TOOL_NAMES` 不迁。）

- [ ] **Step 1: 写失败测试**

`src/tools/canvas-read.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LnkpiToolContext } from "./types.js";
import { buildCanvasReadTools } from "./registry.js";

const EXPECTED = new Set([
	"get_canvas_summary", "get_node", "get_generation_status", "get_generation_diagnostic",
	"get_canvas_layout", "list_generation_tasks", "list_user_assets",
]);

function fakeClient() {
	const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
	return {
		calls,
		post: async (path: string, body: unknown) => {
			calls.push({ path, body: body as Record<string, unknown> });
			return { ok: true };
		},
	};
}

const ctx = (sessionId: string, userId?: string): LnkpiToolContext => ({ sessionId, userId });

test("注册 7 个 read 工具且 tier 正确", () => {
	const tools = buildCanvasReadTools(fakeClient() as never);
	assert.equal(tools.length, 7);
	assert.deepEqual(new Set(tools.map((t) => t.name)), EXPECTED);
	assert.ok(tools.every((t) => t.tier === "read"));
});

test("get_node 映射 snake_case 入参到 camelCase body 并带 sessionId", async () => {
	const fake = fakeClient();
	const [tool] = buildCanvasReadTools(fake as never).filter((t) => t.name === "get_node");
	const res = await tool.execute("c1", { node_id: "n1" }, () => {}, ctx("s1"), {} as never, undefined as never);
	assert.deepEqual(fake.calls[0], { path: "/agent/internal/get-node", body: { sessionId: "s1", nodeId: "n1" } });
	assert.match((res.content[0] as { text: string }).text, /"ok":true/);
});

test("双会话并发调用不串号（toolContext 各自带 sessionId）", async () => {
	const fake = fakeClient();
	const [tool] = buildCanvasReadTools(fake as never).filter((t) => t.name === "get_canvas_summary");
	await Promise.all([
		tool.execute("c1", {}, () => {}, ctx("sess-A"), {} as never, undefined as never),
		tool.execute("c2", {}, () => {}, ctx("sess-B"), {} as never, undefined as never),
	]);
	assert.deepEqual(
		fake.calls.map((c) => (c.body as { sessionId: string }).sessionId).sort(),
		["sess-A", "sess-B"],
	);
});

test("list_generation_tasks：userId 存在才带上；type 透传", async () => {
	const fake = fakeClient();
	const tools = buildCanvasReadTools(fake as never);
	const t = tools.find((x) => x.name === "list_generation_tasks")!;
	await t.execute("c", { type: "image" }, () => {}, ctx("s1", "u1"), {} as never, undefined as never);
	await t.execute("c", {}, () => {}, ctx("s1"), {} as never, undefined as never);
	assert.deepEqual(fake.calls[0].body, { sessionId: "s1", userId: "u1", type: "image" });
	assert.deepEqual(fake.calls[1].body, { sessionId: "s1" });
});

test("list_user_assets：无会话但有 userId；get_canvas_summary 无参", async () => {
	const fake = fakeClient();
	const tools = buildCanvasReadTools(fake as never);
	await tools.find((x) => x.name === "list_user_assets")!.execute("c", {}, () => {}, ctx("s1", "u9"), {} as never, undefined as never);
	await tools.find((x) => x.name === "get_canvas_summary")!.execute("c", {}, () => {}, ctx("s1"), {} as never, undefined as never);
	assert.deepEqual(fake.calls[0], { path: "/agent/internal/list-user-assets", body: { userId: "u9" } });
	assert.deepEqual(fake.calls[1], { path: "/agent/internal/get-canvas-summary", body: { sessionId: "s1" } });
});

test("get_generation_diagnostic：两个可选 id 至少一个，否则抛错（不打 Nest）", async () => {
	const fake = fakeClient();
	const tools = buildCanvasReadTools(fake as never);
	const t = tools.find((x) => x.name === "get_generation_diagnostic")!;
	await t.execute("c", { node_id: "n1" }, () => {}, ctx("s1"), {} as never, undefined as never);
	assert.deepEqual(fake.calls[0].body, { sessionId: "s1", nodeId: "n1" });
	await assert.rejects(() => t.execute("c", {}, () => {}, ctx("s1"), {} as never, undefined as never), /generation_record_id|node_id/);
	assert.equal(fake.calls.length, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test`
Expected: FAIL（registry.js 不存在）

- [ ] **Step 3: 实现 `src/tools/canvas-read.ts`**

```ts
/** B-1 批次 read 工具（7 个）。端点/body 对照 services/agent-runtime/app/tools/nest_client.py:216-596。 */
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import type { NestClient } from "./nest-client.js";

const ID_OPTS = "pass generation_record_id or node_id (at least one)";

function textResult(data: unknown): { content: [{ type: "text"; text: string }]; details: undefined } {
	return { content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }], details: undefined };
}

export function createCanvasReadTools(client: NestClient): LnkpiTool[] {
	const base = { tier: "read" as const };
	return [
		{
			...base,
			name: "get_canvas_summary",
			label: "画布摘要",
			description: "Get a lightweight summary of the current canvas (node list with ids, types and counts). Call this first to understand the canvas.",
			parameters: Type.Object({}),
			execute: async (_id, _p, _u, tc: LnkpiToolContext) => {
				return textResult(await client.post("/agent/internal/get-canvas-summary", { sessionId: tc.sessionId }));
			},
		},
		{
			...base,
			name: "get_node",
			label: "读取节点",
			description: "Get full details of one canvas node by its id (content, media url, refs, connections).",
			parameters: Type.Object({ node_id: Type.String({ description: "canvas node id, e.g. n_abc123" }) }),
			execute: async (_id, p: { node_id: string }, _u, tc: LnkpiToolContext) => {
				return textResult(await client.post("/agent/internal/get-node", { sessionId: tc.sessionId, nodeId: p.node_id }));
			},
		},
		{
			...base,
			name: "get_generation_status",
			label: "生成状态",
			description: "Get the current generation status of one media node (queued/running/succeeded/failed).",
			parameters: Type.Object({ node_id: Type.String({ description: "media node id" }) }),
			execute: async (_id, p: { node_id: string }, _u, tc: LnkpiToolContext) => {
				return textResult(await client.post("/agent/internal/get-generation-status", { sessionId: tc.sessionId, nodeId: p.node_id }));
			},
		},
		{
			...base,
			name: "get_generation_diagnostic",
			label: "生成诊断",
			description: "Get diagnostic details for a generation task (error message, retry hints). Requires generation_record_id or node_id.",
			parameters: Type.Object({
				generation_record_id: Type.Optional(Type.String()),
				node_id: Type.Optional(Type.String()),
			}),
			execute: async (_id, p: { generation_record_id?: string; node_id?: string }, _u, tc: LnkpiToolContext) => {
				if (!p.generation_record_id && !p.node_id) throw new Error(`get_generation_diagnostic requires ${ID_OPTS}`);
				const body: Record<string, unknown> = { sessionId: tc.sessionId };
				if (p.node_id) body.nodeId = p.node_id;
				if (p.generation_record_id) body.generationRecordId = p.generation_record_id;
				return textResult(await client.post("/agent/internal/get-generation-diagnostic", body));
			},
		},
		{
			...base,
			name: "get_canvas_layout",
			label: "画布布局",
			description: "Get the current canvas layout (nodes and edges with positions and sizes).",
			parameters: Type.Object({}),
			execute: async (_id, _p, _u, tc: LnkpiToolContext) => {
				return textResult(await client.post("/agent/internal/get-canvas-layout", { sessionId: tc.sessionId }));
			},
		},
		{
			...base,
			name: "list_generation_tasks",
			label: "任务列表",
			description: "List generation records for the current session (task panel). Optional type filter e.g. image/video.",
			parameters: Type.Object({ type: Type.Optional(Type.String()) }),
			execute: async (_id, p: { type?: string }, _u, tc: LnkpiToolContext) => {
				const body: Record<string, unknown> = { sessionId: tc.sessionId };
				if (tc.userId) body.userId = tc.userId;
				if (p.type) body.type = p.type;
				return textResult(await client.post("/agent/internal/list-generation-tasks", body));
			},
		},
		{
			...base,
			name: "list_user_assets",
			label: "资产库",
			description: "List assets in the user's asset library.",
			parameters: Type.Object({}),
			execute: async (_id, _p, _u, tc: LnkpiToolContext) => {
				return textResult(await client.post("/agent/internal/list-user-assets", { userId: tc.userId }));
			},
		},
	];
}
```

- [ ] **Step 4: 实现 `src/tools/registry.ts`**

```ts
/** 注册工厂：按批次组合工具集。后续批次（B-2+）在此追加，不改调用方。 */
import type { NestClient } from "./nest-client.js";
import type { LnkpiTool } from "./types.js";
import { createCanvasReadTools } from "./canvas-read.js";

export function buildCanvasReadTools(client: NestClient): LnkpiTool[] {
	return createCanvasReadTools(client);
}
```

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add services/pi-runtime/src/tools/canvas-read.ts services/pi-runtime/src/tools/canvas-read.test.ts services/pi-runtime/src/tools/registry.ts
git commit -m "feat(pi-runtime): 7 B-1 read tools wired to Nest endpoints (snake_case args, camelCase bodies)"
```

---

### Task 5: SessionManager toolContext 改造 + 入口装配 + 降级守卫

**Files:**
- Modify: `services/pi-runtime/src/session-manager.ts`（泛型 `Record<string, never>` → `LnkpiToolContext`；create opts 增 `userId`；`toolContext: { sessionId: id, userId }`）
- Modify: `services/pi-runtime/src/index.ts`（装配 NestClient + 工具 + metrics）
- Modify: `services/pi-runtime/src/tools/config.ts`（Create，降级守卫）
- Test: `services/pi-runtime/src/tools/config.test.ts`

**Interfaces:**
- Consumes: `buildCanvasReadTools`（Task 4）、`loadNestConfig`（Task 2）、`Metrics.observeToolCall`（Task 3）
- Produces: `resolveTools(metrics: Metrics): LnkpiTool[]`（env 齐全→7 工具；缺失→[] 且打一次 warning）；`SessionManager` 构造签名变为 `constructor(tools: AgentHarnessTool<LnkpiToolContext>[] = [], systemPromptDefault?: string)`

- [ ] **Step 1: 写失败测试**

`src/tools/config.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Metrics } from "../metrics.js";
import { resolveTools } from "./config.js";

test("env 缺失 → 返回空数组（纯文本模式不受影响）", () => {
	const prev = { b: process.env.NEST_BASE_URL, t: process.env.NEST_SERVICE_TOKEN };
	delete process.env.NEST_BASE_URL; delete process.env.NEST_SERVICE_TOKEN;
	try {
		assert.deepEqual(resolveTools(new Metrics()), []);
	} finally {
		if (prev.b !== undefined) process.env.NEST_BASE_URL = prev.b;
		if (prev.t !== undefined) process.env.NEST_SERVICE_TOKEN = prev.t;
	}
});

test("env 齐全 → 返回 7 个 read 工具", () => {
	process.env.NEST_BASE_URL = "http://127.0.0.1:1";
	process.env.NEST_SERVICE_TOKEN = "tok";
	try {
		const tools = resolveTools(new Metrics());
		assert.equal(tools.length, 7);
	} finally {
		delete process.env.NEST_BASE_URL; delete process.env.NEST_SERVICE_TOKEN;
	}
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test`
Expected: FAIL（config.js 不存在）

- [ ] **Step 3: 实现 `src/tools/config.ts`**

```ts
/** 工具装配与降级守卫：NEST env 齐全才启用工具，否则保持纯文本模式。 */
import { NestClient, loadNestConfig } from "./nest-client.js";
import { buildCanvasReadTools } from "./registry.js";
import type { LnkpiTool } from "./types.js";
import type { Metrics } from "../metrics.js";

let warned = false;

export function resolveTools(metrics: Metrics): LnkpiTool[] {
	const cfg = loadNestConfig();
	if (!cfg) {
		if (!warned) {
			warned = true;
			console.warn("[pi-runtime] NEST_BASE_URL/NEST_SERVICE_TOKEN not set — canvas tools disabled (pure-text mode)");
		}
		return [];
	}
	const client = new NestClient({
		...cfg,
		onCall: (tool, outcome) => metrics.observeToolCall(tool, outcome),
	});
	return buildCanvasReadTools(client);
}
```

- [ ] **Step 4: 改造 `session-manager.ts`**

- import 增加 `import type { LnkpiToolContext } from "./tools/types.js";`
- `SessionEntry`/`AgentHarness.create` 的泛型 `Record<string, never>` 全部替换为 `LnkpiToolContext`
- 构造器：`private readonly tools: AgentHarnessTool<LnkpiToolContext>[] = []`
- `create(id, opts: { systemPrompt?: string; workingDir?: string; userId?: string })`，`toolContext: { sessionId: id, userId: opts.userId }`

- [ ] **Step 5: 改造 `index.ts` 装配段**

```ts
import { Metrics, VERSION, routeLabel } from "./metrics.js";
import { resolveTools } from "./tools/config.js";

const manager = new SessionManager(resolveTools(metrics));
```

（`resolveTools` 引用 `metrics` 的声明需在 `manager` 之前：把 `const metrics = new Metrics();` 提到 `manager` 之前。）

- [ ] **Step 6: 跑测试确认通过 + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 全部 PASS

- [ ] **Step 7: 本地冒烟（不配 NEST env）**

```bash
cd services/pi-runtime && PORT=8188 timeout 8 npx tsx src/index.ts & sleep 3; curl -s localhost:8188/healthz; curl -s localhost:8188/metrics | grep -c pi_runtime_tool_calls_total; wait
```

Expected: healthz 返回 `{"status":"ok",...,"sessions":0}`；metrics grep 计数为 0（无工具调用但进程正常）

- [ ] **Step 8: Commit**

```bash
git add services/pi-runtime/src/session-manager.ts services/pi-runtime/src/index.ts services/pi-runtime/src/tools/config.ts services/pi-runtime/src/tools/config.test.ts
git commit -m "feat(pi-runtime): wire tool registry into SessionManager with per-session toolContext and env-gated fallback"
```

---

### Task 6: 全量回归 + 推送观察 CI

- [ ] **Step 1: 全量验证**

Run: `cd services/pi-runtime && pnpm test && pnpm typecheck && pnpm build`
Expected: 全部 PASS，dist 产出正常

- [ ] **Step 2: 推送 feature 分支**

```bash
git push -u origin p1/tool-registry-skeleton
gh run list -R sev7n4/pi-lnk -L 3
```

Expected: 记录是否触发了任何 workflow（预期：无部署触发；若触发，核对 paths-filter 归属并评估是否需要停止）

- [ ] **Step 3: 在 PR 描述中链接 spec**（三份盘点文档路径），请求人工 review 后合入 master
