# 视觉自评闭环 P0 · 实现计划

> **执行结果（2026-09-29 归档）**：本计划已按 SDD 全量实施并合入 master（PR #72 → squash `e14f136`），生产 pi-runtime **0.0.19**（helm rev 31；验收六件套 + `prod-agent-thread-verify.py` PASS=16）。执行期对本计划的裁决（Task 3 补 `imageRefine:"attached"`、Task 3b 泛型放宽为 `T extends object`、Gate 三振必须给出「SSOT 再确认即 `clearRun`」的出路等）与终审 2 个 Critical（provider 能力门吞图 → `model-assembly` agnes 通道补 `input:["text","image"]`；`message_start/end`、`turn_end` 事件泄图 → `TOOL_RESULT_EVENT_TYPES` 四事件全接 `stripImageBlocks`）均已修入合并代码；裁决台账在 `.superpowers/sdd/2026-09-29-vision-self-refine-loop/`（gitignore，仅本机留存）。
>
> **前置缺陷已解除**：#70 回归的「画布会话 id ≠ pi 会话键」（agent 画布工具全 404）曾使本功能在 0.0.19 上不可达；PR #74（`aec7104`，`sessionId: entry.canvasSessionId ?? key`）已修复并随 **0.0.20** 上线，视觉闭环与画布工具在生产并存（镜像内 `canvasSessionId`×5、`fetchImageAsBlock`/`imageRefine`/`stripImageBlocks` 特征串齐备）。
>
> **遗留**：真实出图端到端冒烟须在 0.0.20 上补做——确认生成图以 image block 回流模型、`imageRefine` 四态语义与重试预算生效；SSE 侧因图数据被剥离只能验证文本自评与工具计数，图回流本身以模型回复中的看图证据 + `/metrics` 工具计数佐证。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `run_image_generation` 的成功结果携带生成图（image block）回流给模型，模型可看图自评并按预算重试一次，质检标准由 skill 承载。

**Architecture:** 机制全部落在 pi-runtime 业务侧（Nest 零改动）：新 `fetchImageAsBlock` 帮助函数把图片 URL 取成 harness 原生支持的 image block；`run_*` 工具结果 content 从「纯文本」扩为「文本 + 可选图」；图**只进模型上下文**——SSE/会话缓冲副本由 `stripImageBlocks` 剥离图数据；Gate 增加 per-session/per-node 重试预算（第 2 次放行、第 3 次拦截转 `ask_user`），预算只在 Gate 内部消费；质检清单升级进 `ecommerce-product-photo` skill。失败一律 fail-open（自评是增强，绝不阻塞生成主链路）。

**Tech Stack:** TypeScript、node:test（`node --import tsx --test`）、TypeBox、pi-agent-core AgentHarness（vendored 0.85.1）、Prometheus 文本指标、helm/K3s 部署。

**Spec:** `docs/superpowers/specs/2026-09-29-vision-self-refine-loop-design.md`

## Global Constraints

- 图片回流上限：**单结果 1 张图**；`Content-Length > 2MB` 或实际读取超 2MB 一律放弃
- fetch 超时 **15_000ms**；mimeType 白名单仅 `image/png`、`image/jpeg`、`image/webp`
- 特性开关 **`PI_RUNTIME_IMAGE_REFINE`**（缺省 `on`；`off` 时工具结果与 0.0.14 逐字节一致）
- Gate 重试语义（V-γ）：同会话同节点第 **2** 次 `run_*` 直接放行并打 `kind="retry"`；第 **3** 次起拦截
- 工具总数保持 **32**（本计划不新增工具）；不触碰 `vendor/**`
- **图只进模型上下文**：image block 仅由 harness 消息管道送给模型；**SSE / 会话 replay buffer 的副本必须剥离图数据**（`SessionManager` dispatch 前过 `stripImageBlocks`，替换为 `{type:"image", mimeType, bytes, omitted:true}`），保持 Nest/前端零改动与帧体积可控
- **HITL 预算只在 Gate 内部消费**：重试计数只能由 `checkGenerationGate` 在「GATED 且放行」分支自增；任何非 GATED 工具（`get_node`/`set_node_text` 等）不得写预算，否则会污染计数并绕过 SSOT 确认校验
- 失败降级文案固定为 `imageRefine: "skipped", imageRefineReason: "<原因>"`（成功为 `imageRefine: "attached"`，无 url 或不适用为 `imageRefine: "n/a"`）
- skill 版本：`ecommerce-product-photo` 0.4.0 → **0.5.0**，frontmatter `version` 与文末「变更记录」同步
- 部署版本号：pi-runtime **0.0.15**（`0.0.13`/`0.0.14` 已被占用——生产当前 **0.0.14**；构建必须 `--no-cache` + dist 特征串验证 + helm 显式 tag）

## Review Focus

以下七类输入/失败模式 spec 隐含但任何单个任务的测试都不会覆盖，最可能咬到使用者；每条都在对应任务的步骤中落一个测试（⑥⑦ 为写计划时回代码核对发现的既有链路风险，已确认成立）：

1. **URL 返回 200 但内容不是图片**（如 HTML 错误页，`Content-Type: text/html`）→ 必须跳过注入并降级，不得把 HTML 当图片塞进上下文
2. **`Content-Length` 缺失**（chunked）→ 仍须按实际累计字节熔断，不能无限读
3. **`run_*` 成功但无 `url`**（`status=timeout` / `fallback_pending`）→ 不 fetch、不标记 attached，且模型不得被误导为"已自检"
4. **开关 `off` 时的回退一致性**→ 工具结果与 0.0.14 完全一致（无额外字段、无 image block）
5. **跨会话重建后预算清零**（用户在新会话重新确认真实意图）→ 不得误判"预算已尽"而拦截首次生成
6. **非 GATED 工具污染预算 → Gate 绕过**（P0）：若 `markRun` 放在通用放行路径上，模型只要先调一次带 `node_id` 的读/写工具（如 `get_node`），真正的第 1 次 `run_*` 就会被判成 retry、**跳过 SSOT `pending_confirm` 校验**——HITL 确认权被架空
7. **图数据泄漏进 SSE/前端**：`tool_end.result` 原样透传（`session-manager` → Nest `tool_result` → 前端 store），2MB 图变 ~2.7MB base64 进帧与 replay buffer；且前端把 `result` 存进消息历史

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `services/pi-runtime/src/metrics.ts` | 改 | 允许 `observeToolCall` 在 `ok` 上带 kind（retry 打点） |
| `services/pi-runtime/src/metrics.test.ts` | 改 | 上述行为的测试 |
| `services/pi-runtime/src/tools/image-refine.ts` | 新建 | `fetchImageAsBlock`：URL → image block（超时/体积/mime 三重闸门，fail-open） |
| `services/pi-runtime/src/tools/image-refine.test.ts` | 新建 | 该函数的全部降级分支测试（本地 http server + 注入 fetchImpl） |
| `services/pi-runtime/src/tools/generation.ts` | 改 | `run_image_generation` 成功后回流 + `imageRefine` 字段 + 开关 |
| `services/pi-runtime/src/tools/generation.test.ts` | 改 | 结果形态断言（attached / skipped / n/a / off 一致性） |
| `services/pi-runtime/src/sse-sanitize.ts` | 新建 | `stripImageBlocks`：SSE/缓冲副本剥离图数据（纯函数，③b） |
| `services/pi-runtime/src/sse-sanitize.test.ts` | 新建 | 剥离行为测试（含无图时引用不变） |
| `services/pi-runtime/src/session-manager.ts` | 改 | `tool_end` 事件在 dispatch 前过 `stripImageBlocks` |
| `services/pi-runtime/src/gate/generation-gate.ts` | 改 | 重试预算计数与放行/拦截（V-γ），**计数在 Gate 内部消费** |
| `services/pi-runtime/src/gate/generation-gate.test.ts` | 改 | 预算行为测试（第 2 次放行、第 3 次拦截、跨节点隔离、会话重置清零、非 GATED 不污染） |
| `services/pi-runtime/src/index.ts` | 改 | 重试放行时打 `kind="retry"` 观测（**不再调用 markRun**） |
| `skills/ecommerce-product-photo/SKILL.md` | 改 | 0.5.0：QA 闸门从"盲检"升级为看图自评 + 预算 + ask_user 转交 |

---

### Task 1: metrics 支持在 `ok` 结果上带 kind（retry 打点基础）

**Files:**
- Modify: `services/pi-runtime/src/metrics.ts`（`observeToolCall`，约 53-57 行）
- Test: `services/pi-runtime/src/metrics.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `observeToolCall(tool: string, outcome: "ok" | "error" | "circuit_open", kind?: ToolErrorKind)` —— `kind` 现在对**任意 outcome** 生效（此前仅 `error`）；`ToolErrorKind` 联合类型新增 `"retry"`

- [ ] **Step 1: 写失败测试**

在 `metrics.test.ts` 末尾追加：

```ts
test("③ retry：ok 结果带 kind 单独一行渲染（V-γ 重试打点）", () => {
	const m = new Metrics();
	m.observeToolCall("run_image_generation", "ok", "retry");
	m.observeToolCall("run_image_generation", "ok");
	const out = m.render(0, "test");
	assert.match(out, /pi_runtime_tool_calls_total\{tool="run_image_generation",result="ok",kind="retry"\} 1/);
	assert.match(out, /pi_runtime_tool_calls_total\{tool="run_image_generation",result="ok"\} 1/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C services/pi-runtime exec node --import tsx --test src/metrics.test.ts`
Expected: FAIL —— `kind="retry"` 行不存在（当前实现要求 `outcome === "error"` 才带 kind）

- [ ] **Step 3: 最小实现**

`metrics.ts` 中三处改动：

```ts
/** 工具调用错误分类（③）；`retry` 为 V-γ 重试放行打点（非错误）。 */
export type ToolErrorKind =
	| "upstream_4xx" | "upstream_5xx" | "envelope" | "timeout" | "network" | "gate_blocked" | "retry";
```

```ts
	observeToolCall(tool: string, outcome: "ok" | "error" | "circuit_open", kind?: ToolErrorKind): void {
		const key = kind ? `${tool}|${outcome}|${kind}` : `${tool}|${outcome}`;
		this.toolCalls.set(key, (this.toolCalls.get(key) ?? 0) + 1);
	}
```

（`render()` 的 kind 标签渲染逻辑已存在，无需改。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C services/pi-runtime exec node --import tsx --test src/metrics.test.ts`
Expected: PASS（含既有用例）

- [ ] **Step 5: 提交**

```bash
git add services/pi-runtime/src/metrics.ts services/pi-runtime/src/metrics.test.ts
git commit -m "feat(pi-runtime): metrics 支持 ok 结果带 kind（retry 打点基础）"
```

---

### Task 2: `fetchImageAsBlock` 帮助函数（三重闸门 + fail-open）

**Files:**
- Create: `services/pi-runtime/src/tools/image-refine.ts`
- Test: `services/pi-runtime/src/tools/image-refine.test.ts`

**Interfaces:**
- Consumes: 无（仅 node 内置 fetch/AbortSignal）
- Produces:
  ```ts
  export interface ImageBlock { type: "image"; data: string; mimeType: string }
  export type ImageFetchResult =
    | { ok: true; block: ImageBlock }
    | { ok: false; reason: "disabled" | "empty-url" | "timeout" | "network" | "http" | "mime" | "too-large" };
  export function isImageRefineEnabled(): boolean;   // 读 PI_RUNTIME_IMAGE_REFINE，缺省 on
  export function fetchImageAsBlock(
    url: string,
    deps?: { fetchImpl?: typeof fetch; maxBytes?: number; timeoutMs?: number },
  ): Promise<ImageFetchResult>;
  ```
  默认 `maxBytes = 2 * 1024 * 1024`、`timeoutMs = 15_000`

- [ ] **Step 1: 写失败测试**

创建 `image-refine.test.ts`（本地 http server 提供各种响应；`fetchImpl` 用全局 fetch + 指向本地端口）：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchImageAsBlock, isImageRefineEnabled } from "./image-refine.js";

async function withServer(
	handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
	fn: (url: string) => Promise<void>,
) {
	const server = http.createServer(handler);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as { port: number };
	try {
		await fn(`http://127.0.0.1:${port}/img.png`);
	} finally {
		server.close();
	}
}

test("成功：image/png 返回 image block（data 为 base64）", async () => {
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	await withServer(
		(_req, res) => {
			res.setHeader("content-type", "image/png");
			res.setHeader("content-length", String(png.length));
			res.end(png);
		},
		async (url) => {
			const res = await fetchImageAsBlock(url);
			assert.equal(res.ok, true);
			if (!res.ok) return;
			assert.equal(res.block.type, "image");
			assert.equal(res.block.mimeType, "image/png");
			assert.equal(res.block.data, png.toString("base64"));
		},
	);
});

test("Review Focus ①：200 但 text/html → mime 拒绝，不注入", async () => {
	await withServer(
		(_req, res) => {
			res.setHeader("content-type", "text/html");
			res.end("<html>error</html>");
		},
		async (url) => {
			const res = await fetchImageAsBlock(url);
			assert.deepEqual(res, { ok: false, reason: "mime" });
		},
	);
});

test("Review Focus ②：无 content-length 且超 maxBytes → too-large（实际读取熔断）", async () => {
	await withServer(
		(_req, res) => {
			res.setHeader("content-type", "image/png"); // 无 content-length
			res.write(Buffer.alloc(64 * 1024));
			res.write(Buffer.alloc(64 * 1024));
			res.end(Buffer.alloc(64 * 1024));
		},
		async (url) => {
			const res = await fetchImageAsBlock(url, { maxBytes: 100 * 1024 });
			assert.deepEqual(res, { ok: false, reason: "too-large" });
		},
	);
});

test("content-length 声明超限 → 直接放弃（不读 body）", async () => {
	await withServer(
		(_req, res) => {
			res.setHeader("content-type", "image/jpeg");
			res.setHeader("content-length", String(5 * 1024 * 1024));
			res.end(Buffer.alloc(10));
		},
		async (url) => {
			const res = await fetchImageAsBlock(url);
			assert.deepEqual(res, { ok: false, reason: "too-large" });
		},
	);
});

test("超时 → timeout；空 url → empty-url；http 404 → http", async () => {
	await withServer(
		() => undefined,
		async (url) => {
			const res = await fetchImageAsBlock(url, { timeoutMs: 50 });
			assert.deepEqual(res, { ok: false, reason: "timeout" });
		},
	);
	assert.deepEqual(await fetchImageAsBlock(""), { ok: false, reason: "empty-url" });
	await withServer(
		(_req, res) => {
			res.statusCode = 404;
			res.end("nope");
		},
		async (url) => {
			const res = await fetchImageAsBlock(url);
			assert.deepEqual(res, { ok: false, reason: "http" });
		},
	);
});

test("开关：PI_RUNTIME_IMAGE_REFINE=off 时 disabled；缺省 on", async () => {
	const prev = process.env.PI_RUNTIME_IMAGE_REFINE;
	try {
		process.env.PI_RUNTIME_IMAGE_REFINE = "off";
		assert.equal(isImageRefineEnabled(), false);
		assert.deepEqual(await fetchImageAsBlock("http://127.0.0.1:1/x.png"), { ok: false, reason: "disabled" });
		process.env.PI_RUNTIME_IMAGE_REFINE = "on";
		assert.equal(isImageRefineEnabled(), true);
		delete process.env.PI_RUNTIME_IMAGE_REFINE;
		assert.equal(isImageRefineEnabled(), true);
	} finally {
		if (prev === undefined) delete process.env.PI_RUNTIME_IMAGE_REFINE;
		else process.env.PI_RUNTIME_IMAGE_REFINE = prev;
	}
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C services/pi-runtime exec node --import tsx --test src/tools/image-refine.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

创建 `image-refine.ts`（要点：Content-Length 预检 → mime 白名单 → 流式累计字节熔断 → base64；任何异常归一为 reason，绝不 throw）：

```ts
/** 视觉自评闭环（spec 2026-09-29 §4.2）：生成图 → image block 回流。fail-open：任何失败只降级不抛错。 */
export interface ImageBlock { type: "image"; data: string; mimeType: string }
export type ImageFetchResult =
	| { ok: true; block: ImageBlock }
	| { ok: false; reason: "disabled" | "empty-url" | "timeout" | "network" | "http" | "mime" | "too-large" };

const ALLOWED_MIMES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export function isImageRefineEnabled(): boolean {
	return (process.env.PI_RUNTIME_IMAGE_REFINE ?? "on").toLowerCase() !== "off";
}

export async function fetchImageAsBlock(
	url: string,
	deps: { fetchImpl?: typeof fetch; maxBytes?: number; timeoutMs?: number } = {},
): Promise<ImageFetchResult> {
	if (!isImageRefineEnabled()) return { ok: false, reason: "disabled" };
	if (!url) return { ok: false, reason: "empty-url" };
	const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
	const fetchImpl = deps.fetchImpl ?? fetch;
	try {
		const res = await fetchImpl(url, { signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
		if (!res.ok) return { ok: false, reason: "http" };
		const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
		if (!ALLOWED_MIMES.has(mime)) return { ok: false, reason: "mime" };
		const declared = Number(res.headers.get("content-length") ?? "");
		if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: "too-large" };
		const chunks: Uint8Array[] = [];
		let total = 0;
		if (res.body) {
			for await (const chunk of res.body) {
				const buf = chunk as Uint8Array;
				total += buf.byteLength;
				if (total > maxBytes) return { ok: false, reason: "too-large" };
				chunks.push(buf);
			}
		}
		return { ok: true, block: { type: "image", data: Buffer.concat(chunks).toString("base64"), mimeType: mime } };
	} catch (err) {
		const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
		return { ok: false, reason: isTimeout ? "timeout" : "network" };
	}
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C services/pi-runtime exec node --import tsx --test src/tools/image-refine.test.ts`
Expected: 6 个 test 全 PASS

- [ ] **Step 5: 提交**

```bash
git add services/pi-runtime/src/tools/image-refine.ts services/pi-runtime/src/tools/image-refine.test.ts
git commit -m "feat(pi-runtime): fetchImageAsBlock（2MB/15s/mime 白名单三重闸门，fail-open）"
```

---

### Task 3: `run_image_generation` 结果回流 + `imageRefine` 字段 + 开关

**Files:**
- Modify: `services/pi-runtime/src/tools/generation.ts`（`runTool` 内部，约 35-56 行）
- Test: `services/pi-runtime/src/tools/generation.test.ts`

**Interfaces:**
- Consumes: `fetchImageAsBlock`、`ImageBlock`（Task 2）
- Produces: `run_image_generation` 结果形态 —— `content: [ {type:"text",text:<JSON>}, {type:"image",...}? ]`，文本 JSON 的 `data` 增加 `imageRefine: "attached" | "skipped" | "n/a"`（skipped 时加 `imageRefineReason: <reason>`）；`details.actions` 不变

- [ ] **Step 1: 写失败测试**

在 `generation.test.ts` 末尾追加（`fakeClient` 已返回 `url: "https://x/y.png"`；用注入的 `fetchImpl` 打桩，需要 Task 3 给 `createGenerationTools` 增加可选第二参 `{ fetchImpl }`）：

```ts
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function imageFetch(): typeof fetch {
	return (async (u: string | URL | Request) => {
		if (String(u) !== "https://x/y.png") throw new Error("unexpected url");
		return new Response(PNG, { headers: { "content-type": "image/png", "content-length": String(PNG.length) } });
	}) as typeof fetch;
}

test("V-β：run_image_generation 成功 → 文本 + image block，imageRefine=attached", async () => {
	const tools = createGenerationTools(fakeClient() as never, { fetchImpl: imageFetch() });
	const tool = tools.find((t) => t.name === "run_image_generation")!;
	const res = await run(tool, { node_id: "n_1" });
	assert.equal(res.content.length, 2);
	const text = JSON.parse((res.content[0] as { text: string }).text);
	assert.equal(text.data.imageRefine, "attached");
	assert.equal((res.content[1] as { type: string }).type, "image");
	assert.deepEqual(res.details?.actions, [{ type: "update_node", payload: { id: "n_1", data: { status: "completed" } } }]);
});

test("V-ζ：图片取不到 → 仅文本 + imageRefine=skipped:http（fail-open）", async () => {
	const failFetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
	const tools = createGenerationTools(fakeClient() as never, { fetchImpl: failFetch });
	const tool = tools.find((t) => t.name === "run_image_generation")!;
	const res = await run(tool, { node_id: "n_1" });
	assert.equal(res.content.length, 1);
	const text = JSON.parse((res.content[0] as { text: string }).text);
	assert.equal(text.data.imageRefine, "skipped");
	assert.equal(text.data.imageRefineReason, "http");
});

test("Review Focus ③：成功但无 url（timeout/fallback_pending）→ imageRefine=n/a 且不 fetch", async () => {
	let fetched = false;
	const spyFetch = (async () => {
		fetched = true;
		return new Response(PNG, { headers: { "content-type": "image/png" } });
	}) as typeof fetch;
	const clientNoUrl = {
		post: async () => ({ status: "timeout", generationRecordId: "g1", actions: [] }),
	};
	const tools = createGenerationTools(clientNoUrl as never, { fetchImpl: spyFetch });
	const tool = tools.find((t) => t.name === "run_image_generation")!;
	const res = await run(tool, { node_id: "n_1" });
	const text = JSON.parse((res.content[0] as { text: string }).text);
	assert.equal(text.data.imageRefine, "n/a");
	assert.equal(res.content.length, 1);
	assert.equal(fetched, false, "无 url 时不得发起 fetch");
});

test("Review Focus ④：开关 off → 结果与旧版一致（无 imageRefine 字段、无 image block）", async () => {
	const prev = process.env.PI_RUNTIME_IMAGE_REFINE;
	process.env.PI_RUNTIME_IMAGE_REFINE = "off";
	try {
		const tools = createGenerationTools(fakeClient() as never, { fetchImpl: imageFetch() });
		const res = await run(tools.find((t) => t.name === "run_image_generation")!, { node_id: "n_1" });
		assert.equal(res.content.length, 1);
		const text = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal("imageRefine" in text.data, false);
	} finally {
		if (prev === undefined) delete process.env.PI_RUNTIME_IMAGE_REFINE;
		else process.env.PI_RUNTIME_IMAGE_REFINE = prev;
	}
});

test("其余 run_* 不回流（V-ε）：run_video_generation 结果无 image block", async () => {
	const tools = createGenerationTools(fakeClient() as never, { fetchImpl: imageFetch() });
	const res = await run(tools.find((t) => t.name === "run_video_generation")!, { node_id: "n_1" });
	assert.equal(res.content.length, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C services/pi-runtime exec node --import tsx --test src/tools/generation.test.ts`
Expected: FAIL —— `createGenerationTools` 第二参未支持、无 image block

- [ ] **Step 3: 实现**

`generation.ts` 改动：

```ts
import { fetchImageAsBlock, isImageRefineEnabled, type ImageBlock } from "./image-refine.js";

export function createGenerationTools(
	client: NestClient,
	deps: { fetchImpl?: typeof fetch } = {},
): LnkpiTool[] {
	// ... runTool 内：
	execute: async (_id, p, _u, tc, _invocation, context) => {
		if (!tc.userId) throw new Error(`${name} requires userId in toolContext`);
		const data = (await client.post(
			path,
			{ sessionId: tc.sessionId, userId: tc.userId, nodeId: p.node_id },
			// P0-② 保留：run abort → context.abortSignal → fetch 立即中断（勿丢这个第三参）
			{ signal: context?.abortSignal ?? undefined },
		)) as { url?: string } & Record<string, unknown>;
		const base = resultWithActions(data); // 现有：{ content:[text], details:{actions} }
		if (name !== "run_image_generation") return base;
		if (!isImageRefineEnabled()) return base; // Review Focus ④：回退一致性，不加任何字段
		const url = typeof data.url === "string" ? data.url : "";
		if (!url) {
			// Review Focus ③：不 fetch，仅标注 n/a
			return withImageRefine(base, data, "n/a");
		}
		const fetched = await fetchImageAsBlock(url, { fetchImpl: deps.fetchImpl });
		if (!fetched.ok) return withImageRefine(base, data, "skipped", fetched.reason);
		return {
			...base,
			content: [...base.content, fetched.block satisfies ImageBlock],
		};
	},
```

`withImageRefine(base, data, mark, reason?)`：把 `imageRefine`（与可选 `imageRefineReason`）并入文本 JSON 的 `data` 后重建 content 第 0 项；`details` 透传。注意 JSON.stringify 顺序稳定以便断言。

**同时更新工具 description**（V-α 挂点）：在 `run_image_generation` 的 description 末尾追加：

```
When the result includes imageRefine="attached", the generated image is attached — inspect it against the task checklist before reporting; if it fails, revise the prompt (set_node_text) and run once more, then report honestly.
```

`config.ts` 调用点不变（`createGenerationTools(client)` 第二参可选）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C services/pi-runtime exec node --import tsx --test src/tools/generation.test.ts src/tools/image-refine.test.ts`
Expected: 全 PASS（既有 6 工具注册/生命周期用例不回归）

- [ ] **Step 5: 提交**

```bash
git add services/pi-runtime/src/tools/generation.ts services/pi-runtime/src/tools/generation.test.ts
git commit -m "feat(pi-runtime): run_image_generation 结果带回生成图（image block）+ imageRefine 字段 + 开关"
```

---

### Task 3b: SSE / replay buffer 副本剥离图数据（保 Nest/前端零改动）

**背景（Review Focus ⑦）**：`SessionManager` 订阅 `tool_end` 时用 `data: evt` 原样派发（`session-manager.ts:229`），`tool_end.result: AgentToolResult` 是**完整**结果（`vendor/.../agent-harness.ts:327`）。于是 image block 会经 SSE 帧 → Nest `mapPiEventToUiEvent` → 前端 `endToolCall`（`AgentSideRail.vue:1941`）进浏览器 store。图只服务模型上下文，SSE 副本必须瘦身。

**Files:**
- Create: `services/pi-runtime/src/sse-sanitize.ts`
- Test: `services/pi-runtime/src/sse-sanitize.test.ts`
- Modify: `services/pi-runtime/src/session-manager.ts`（EVENT_MAP 订阅回调，约 222-233 行）

**Interfaces:**
- Consumes: 无
- Produces:
  ```ts
  /** 非文本块 → 轻量描述符；无图时**返回原对象引用**（开关 off 下逐字节一致）。 */
  export function stripImageBlocks<T extends { result?: unknown }>(evt: T): T;
  ```

- [ ] **Step 1: 写失败测试**

创建 `sse-sanitize.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripImageBlocks } from "./sse-sanitize.js";

const withImage = {
	toolName: "run_image_generation",
	isError: false,
	result: {
		content: [
			{ type: "text", text: '{"ok":true}' },
			{ type: "image", data: "AAAA".repeat(1000), mimeType: "image/png" },
		],
		details: { actions: [{ type: "update_node" }] },
	},
};

test("Review Focus ⑦：image block 被替换为轻量描述符，text/details 原样保留", () => {
	const out = stripImageBlocks(withImage) as typeof withImage;
	const content = out.result.content as Array<Record<string, unknown>>;
	assert.equal(content.length, 2);
	assert.deepEqual(content[0], { type: "text", text: '{"ok":true}' });
	assert.equal(content[1].type, "image");
	assert.equal(content[1].mimeType, "image/png");
	assert.equal(content[1].omitted, true);
	assert.equal(content[1].bytes, 3000); // 4000 base64 字符 → 3000 字节
	assert.equal("data" in content[1], false, "base64 不得残留");
	assert.deepEqual(out.result.details, { actions: [{ type: "update_node" }] });
	assert.equal(out.toolName, "run_image_generation");
});

test("无图 / 无 result / 非数组 content → 返回原引用（零开销，off 下一字节不变）", () => {
	const noResult = { toolName: "get_node" };
	assert.equal(stripImageBlocks(noResult), noResult);
	const textOnly = { result: { content: [{ type: "text", text: "x" }] } };
	assert.equal(stripImageBlocks(textOnly), textOnly);
	const weird = { result: { content: "not-an-array" } };
	assert.equal(stripImageBlocks(weird), weird);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C services/pi-runtime exec node --import tsx --test src/sse-sanitize.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

```ts
/**
 * SSE / 会话 replay buffer 副本瘦身：`tool_end.result` 是完整 AgentToolResult，
 * image block（最多 2MB → base64 ≈2.7MB）只服务模型上下文，前端/SSE 不需要。
 * 替换为 `{type:"image", mimeType, bytes, omitted:true}`——保留语义、去掉 data。
 * 无图时返回**原对象**（避免无谓重建，保证开关 off 下事件逐字节一致）。
 */
export function stripImageBlocks<T extends { result?: unknown }>(evt: T): T {
	const result = evt.result as { content?: unknown } | undefined | null;
	if (!result || !Array.isArray(result.content)) return evt;
	let changed = false;
	const content = result.content.map((block) => {
		const b = block as { type?: unknown; data?: unknown; mimeType?: unknown } | null | undefined;
		if (!b || typeof b !== "object" || b.type !== "image") return block;
		changed = true;
		return {
			type: "image",
			mimeType: typeof b.mimeType === "string" ? b.mimeType : "image/*",
			bytes: typeof b.data === "string" ? Math.floor((b.data.length * 3) / 4) : 0,
			omitted: true,
		};
	});
	if (!changed) return evt;
	return { ...evt, result: { ...(result as object), content } };
}
```

`session-manager.ts` 订阅回调（仅 `tool_end` 分支过一层，其余事件零改动）：

```ts
				harness.events.on(harnessType as never, (evt: { lane?: string }) => {
					this.dispatch(entry, {
						type: sseType,
						lane: evt.lane,
						ts: Date.now(),
						// ⑦：图只进模型上下文，SSE/缓冲副本剥离（无图时原引用返回）
						data: harnessType === "tool_end" ? stripImageBlocks(evt) : evt,
					});
				}),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C services/pi-runtime exec node --import tsx --test src/sse-sanitize.test.ts src/session-manager.test.ts`
Expected: 全 PASS（若无 `session-manager.test.ts` 则只跑前者，并在提交说明中记明）

- [ ] **Step 5: 提交**

```bash
git add services/pi-runtime/src/sse-sanitize.ts services/pi-runtime/src/sse-sanitize.test.ts services/pi-runtime/src/session-manager.ts
git commit -m "feat(pi-runtime): SSE/缓冲副本剥离 image block（图只进模型上下文）"
```

---

### Task 4: Gate 重试预算（V-γ）+ retry 打点

**Files:**
- Modify: `services/pi-runtime/src/gate/generation-gate.ts`
- Modify: `services/pi-runtime/src/index.ts`（before_tool hook，约 44-47 行）
- Test: `services/pi-runtime/src/gate/generation-gate.test.ts`

**Interfaces:**
- Consumes: `GenerationGateStore`（既有）、`metrics.observeToolCall` 的 `retry` kind（Task 1）
- Produces:
  - `GenerationGateStore.runCount(sessionId: string, nodeId: string): number`
  - `GenerationGateStore.markRun(sessionId: string, nodeId: string): void`（`resetSession` 一并清零）
  - `GateCheckResult` 增加 `retry?: boolean`（true = 走的是放行重试路径）
- **契约（Review Focus ⑥）**：预算**只由 `checkGenerationGate` 在「GATED 且放行」分支自增**；调用方（`index.ts`）只读 `check.retry`，**绝不调用 `markRun`**。非 GATED 工具走 `!GATED_TOOLS.has` 早返回，永不触碰预算

- [ ] **Step 1: 写失败测试**

在 `generation-gate.test.ts` 末尾追加（fake client 让 get-node 返回 `{data:{status:"pending_confirm"}}`，与既有用例模式一致）：

```ts
// 一个已 propose 且已跨轮的节点：SSOT 返回 pending_confirm（首跑成功后会变 completed）
function gateClientReturning(status: string) {
	return { post: async () => ({ data: { status } }) };
}

test("V-γ：第 1 次 run 走 SSOT 校验；第 2 次直接放行（retry=true）；第 3 次拦截", async () => {
	const store = new GenerationGateStore();
	// 第 1 次：SSOT=pending_confirm → 放行（非 retry），并消费掉 1 次预算
	const first = await checkGenerationGate(store, gateClientReturning("pending_confirm"), "s1", "run_image_generation", { node_id: "n1" });
	assert.deepEqual(first, { allowed: true });
	assert.equal(store.runCount("s1", "n1"), 1);

	// 第 2 次：预算=1 → 直接放行 retry（此刻 SSOT 已变 completed，仍须放行）
	const retry = await checkGenerationGate(store, gateClientReturning("completed"), "s1", "run_image_generation", { node_id: "n1" });
	assert.deepEqual(retry, { allowed: true, retry: true });
	assert.equal(store.runCount("s1", "n1"), 2);

	// 第 3 次：预算=2 → 拦截，转 ask_user / propose
	const third = await checkGenerationGate(store, gateClientReturning("completed"), "s1", "run_image_generation", { node_id: "n1" });
	assert.equal(third.allowed, false);
	assert.match(third.reason ?? "", /ask_user|propose_generation/);
});

test("V-γ 边界：预算按节点隔离；非 pending 节点的首次 run 被拦且**不消费预算**", async () => {
	const store = new GenerationGateStore();
	await checkGenerationGate(store, gateClientReturning("pending_confirm"), "s1", "run_image_generation", { node_id: "n1" });
	assert.equal(store.runCount("s1", "n2"), 0);
	const other = await checkGenerationGate(store, gateClientReturning("idle"), "s1", "run_image_generation", { node_id: "n2" });
	assert.equal(other.allowed, false);
	assert.match(other.reason ?? "", /待确认状态/);
	assert.equal(store.runCount("s1", "n2"), 0, "被拦不消费预算");
});

test("Review Focus ⑥（P0 回归）：非 GATED 工具不得写预算，否则首次 run 会绕过 SSOT", async () => {
	const store = new GenerationGateStore();
	// 模型先读节点（很自然的动作）——不得污染预算
	const read = await checkGenerationGate(store, gateClientReturning("idle"), "s1", "get_node", { node_id: "n1" });
	assert.deepEqual(read, { allowed: true });
	assert.equal(store.runCount("s1", "n1"), 0, "非 GATED 工具写预算 = Gate 可被绕过");

	// 紧接着首次 run：SSOT=idle → 必须被拦（若预算被污染，这里会误放行）
	const run = await checkGenerationGate(store, gateClientReturning("idle"), "s1", "run_image_generation", { node_id: "n1" });
	assert.equal(run.allowed, false, "预算被 get_node 污染会导致 HITL 确认权被架空");
	assert.match(run.reason ?? "", /待确认状态/);
});

test("Review Focus ⑤：会话重置后预算清零（重新确认 = 新会话新意图）", async () => {
	const store = new GenerationGateStore();
	await checkGenerationGate(store, gateClientReturning("pending_confirm"), "s1", "run_image_generation", { node_id: "n1" });
	await checkGenerationGate(store, gateClientReturning("completed"), "s1", "run_image_generation", { node_id: "n1" });
	assert.equal(store.runCount("s1", "n1"), 2);
	store.resetSession("s1");
	assert.equal(store.runCount("s1", "n1"), 0);
	const after = await checkGenerationGate(store, gateClientReturning("pending_confirm"), "s1", "run_image_generation", { node_id: "n1" });
	assert.deepEqual(after, { allowed: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C services/pi-runtime exec node --import tsx --test src/gate/generation-gate.test.ts`
Expected: FAIL —— `markRun`/`runCount` 不存在；`retry` 字段不存在

- [ ] **Step 3: 实现**

`generation-gate.ts`：

```ts
export class GenerationGateStore {
	private readonly proposals = new Map<string, Map<string, number>>();
	private readonly turns = new Map<string, number>();
	private readonly runs = new Map<string, Map<string, number>>(); // 会话 → 节点 → 已放行 run 次数（V-γ）

	runCount(sessionId: string, nodeId: string): number {
		return this.runs.get(sessionId)?.get(nodeId) ?? 0;
	}

	markRun(sessionId: string, nodeId: string): void {
		const map = this.runs.get(sessionId) ?? new Map<string, number>();
		map.set(nodeId, (map.get(nodeId) ?? 0) + 1);
		this.runs.set(sessionId, map);
	}

	resetSession(sessionId: string): void {
		this.proposals.delete(sessionId);
		this.turns.delete(sessionId);
		this.runs.delete(sessionId);
	}
}

export interface GateCheckResult {
	allowed: boolean;
	reason?: string;
	/** true = 本次放行走的是 V-γ 重试路径（供 index.ts 打 kind="retry"）。 */
	retry?: boolean;
}
```

`checkGenerationGate` 在 `GATED_TOOLS`/`node_id` 校验之后插入（**预算在此函数内部消费**，fail-closed 分支不动预算）：

```ts
	const runs = store.runCount(sessionId, nodeId);
	if (runs >= 2) {
		return {
			allowed: false,
			reason: `节点 ${nodeId} 的重试预算已尽（已尝试 ${runs} 次）；请用 ask_user 向用户说明自评结论与可选方向，或先 propose_generation 重新征得确认`,
		};
	}
	if (runs === 1) {
		store.markRun(sessionId, nodeId); // 放行才消费：1 → 2
		return { allowed: true, retry: true }; // V-γ：用户首次确认已表达该节点生成意图
	}
	// runs === 0：走既有双重校验（同轮自批 + SSOT pending_confirm）
	if (store.wasProposedThisTurn(sessionId, nodeId)) {
		return { allowed: false, reason: "本轮刚调用过 propose_generation，……" };
	}
	try {
		const node = await client.post("/agent/internal/get-node", { sessionId, nodeId });
		const status = extractNodeStatus(node);
		if (status !== "pending_confirm") {
			return { allowed: false, reason: `节点 ${nodeId} 不在待确认状态（当前 ${status ?? "unknown"}）；……` };
		}
		store.markRun(sessionId, nodeId); // 放行才消费：0 → 1
		return { allowed: true };
	} catch {
		return { allowed: false, reason: "生成前置校验暂时不可用（fail-closed），请稍后重试" };
	}
```

> 实施提示：以上是替换既有 `checkGenerationGate` 主体（`generation-gate.ts:77-95`）的完整逻辑，原 `reason` 文案原样保留即可；关键点有二——① `!GATED_TOOLS.has(toolName)` 早返回仍在最前，非 GATED 工具零接触预算；② `markRun` 只在**两个放行分支**调用，被拦不消费。

`index.ts` before_tool hook（**不调用 `markRun`**，只读 `check.retry` 打点）：

```ts
		harness.hooks.on("before_tool", async (event) => {
			const check = await checkGenerationGate(gateStore, gateClient, sessionId, event.toolName, event.args);
			if (!check.allowed) {
				metrics.observeToolCall(event.toolName, "error", "gate_blocked");
				return { block: { reason: check.reason ?? "generation gated" } };
			}
			if (check.retry) metrics.observeToolCall(event.toolName, "ok", "retry"); // V-γ 重试放行打点
			return undefined;
		});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C services/pi-runtime exec node --import tsx --test src/gate/generation-gate.test.ts`
Expected: 全 PASS（既有用例不回归）

- [ ] **Step 5: 提交**

```bash
git add services/pi-runtime/src/gate/generation-gate.ts services/pi-runtime/src/gate/generation-gate.test.ts services/pi-runtime/src/index.ts
git commit -m "feat(pi-runtime): Gate 重试预算 V-γ（第 2 次放行打 retry、第 3 次拦截转 ask_user）"
```

---

### Task 5: `ecommerce-product-photo` skill 0.5.0（QA 闸门升级为看图自评）

**Files:**
- Modify: `skills/ecommerce-product-photo/SKILL.md`

**Interfaces:**
- Consumes: `run_image_generation` 结果的 `imageRefine` 字段语义（Task 3）、Gate 预算语义（Task 4）
- Produces: 模型侧可遵循的看图自评流程与预算纪律（无代码接口）

- [ ] **Step 1: 改 skill 正文**

将「执行步骤」第 8 步与「出图后 QA 闸门」按下列语义重写（保持原有四 gate 条目不变，新增"看图"前提与循环预算）：

- 第 8 步：出图后先 `focus_node` 定位；**若 `run_image_generation` 结果 `imageRefine="attached"`，必须先看图再自检**（图已在上下文）；`imageRefine="skipped"` 时如实说明"未能获取图片用于自检"，不得假装已自检；`imageRefine="n/a"`（生成未完成）时走原 status 分支
- QA 闸门新增小节「自评与重试预算」：
  - PASS → 直接交付并给出自评结论（逐 gate 一句）
  - REVISE → 归因到具体 gate 与项 → `set_node_text` 修正 prompt → **再次 `run_image_generation`（同节点第 2 次，系统自动放行）**
  - 第二次仍不过 / 第 3 次调用被系统拦截 → **必须 `ask_user`**：给出两次自评对比与可选方向（如"往冷调/保留原图"），不得继续无提示重试
  - 禁止把 `skipped` 当 PASS 交付

- [ ] **Step 2: 升版本 + 写变更记录**

frontmatter `version: "0.5.0"`；文末「变更记录」追加：

```md
- **0.5.0** (2026-09-29, 视觉自评闭环 P0)：QA 闸门从盲检升级为看图自评。
  - 明确 `run_image_generation` 结果 `imageRefine="attached"` 时图已在上下文，必须先看图再自检
  - 新增"自评与重试预算"小节：REVISE → 改 prompt 重跑一次（系统放行）；仍不过或第 3 次被拦截 → 必须 ask_user 给结论与选项
  - `imageRefine="skipped"` 不得当 PASS；`"n/a"` 走原 status 分支
```

- [ ] **Step 3: 校验**

Run: `pnpm -C /Users/4seven/workspace/pi-lnk exec node --import tsx --test services/pi-runtime/src/tools/skill-tool.test.ts`
Expected: PASS（skill 解析/加载用例；若既有测试断言 skill 数量或版本，同步更新并在此说明）

- [ ] **Step 4: 提交**

```bash
git add skills/ecommerce-product-photo/SKILL.md
git commit -m "docs(skill): ecommerce-product-photo 0.5.0——QA 闸门升级为看图自评 + 重试预算纪律"
```

---

### Task 6: 集成验证与生产部署（0.0.15）

**Files:**
- None（运行 runbook 命令流）

**Interfaces:**
- Consumes: 前 5 个任务的产物
- Produces: 生产 pi-runtime 0.0.15（含视觉回流）

- [ ] **Step 1: 本地全量验证**

Run: `pnpm -C services/pi-runtime test && pnpm -C services/pi-runtime typecheck`
Expected: 全绿（含既有 39+ 用例与本次新增 ~20 用例）

- [ ] **Step 2: 提交 PR，CI 三项全绿 + 队列清空后 squash 合并**

Run: `gh pr checks <n>`（三项 pass）→ 确认 `busy: 0` → `gh pr merge <n> --squash --delete-branch`

- [ ] **Step 3: CVM 构建 0.0.15（runbook 命令流）**

```bash
# 本机（前台 + dangerouslyDisableSandbox + -o StrictHostKeyChecking=accept-new）
rsync -az --delete --exclude node_modules --exclude dist --exclude .git vendor/ services/pi-runtime/ skills/ ...
ssh ... "cd /root/pi-lnk-build && docker build --no-cache -f services/pi-runtime/Dockerfile -t 127.0.0.1:5000/pi-runtime:0.0.15 . && docker push ..."
ssh ... "helm upgrade pi-lnk-runtime-dev ... --set image.tag=0.0.15 --set env.PI_RUNTIME_VERSION=0.0.15 ..."
```

- [ ] **Step 4: 验收（四件套 + 特征串 + 冒烟）**

```bash
curl -s --noproxy '*' localhost:30100/healthz                     # version=0.0.15
kubectl exec deploy/pi-lnk-runtime -n pi-lnk-runtime -- grep -c 'fetchImageAsBlock' /app/services/pi-runtime/dist/tools/image-refine.js
kubectl exec deploy/pi-lnk-runtime -n pi-lnk-runtime -- grep -c 'imageRefine' /app/services/pi-runtime/dist/tools/generation.js
kubectl exec deploy/pi-lnk-runtime -n pi-lnk-runtime -- grep -c 'stripImageBlocks' /app/services/pi-runtime/dist/sse-sanitize.js
kubectl exec deploy/pi-lnk-runtime -n pi-lnk-runtime -- grep -c 'runCount' /app/services/pi-runtime/dist/gate/generation-gate.js
curl -s --noproxy '*' localhost:30100/metrics | grep skills_loaded  # skill 数不变（1）
```

Expected: 特征串命中 ≥1；healthz/build_info=0.0.15；`PI_RUNTIME_MODE=active`

- [ ] **Step 5: 端到端人工冒烟（真实链路）**

在公网跑一次「帮我做一张 XX 的白底图」：propose → 用户确认 → `run_image_generation` → 观察 SSE 与模型回复是否包含看图自评结论；随后构造一次 fail 场景（prompt 明显缺项）验证重试放行与 `kind="retry"` 指标。**验证后记录结果到当日 memory 日志。**

- [ ] **Step 6: 回退预案演练（不执行升级回退，仅确认开关可用）**

```bash
# 确认开关生效路径（pod 内 env 改 on/off 需 helm）
helm get values pi-lnk-runtime-dev -n pi-lnk-runtime | grep -i IMAGE_REFINE || echo "开关未显式设置 → 默认 on（符合 spec）"
```

---

## Self-Review 记录

1. **Spec 覆盖**：§4.2（Task 2/3 + 3b SSE 瘦身）、§4.3 V-γ（Task 4）、§4.4 观测（Task 1 + Task 4 打点）、§4.5 前端零改动（Task 3b 显式保障）、§5 skill 0.5.0（Task 5）、§6 验收（Task 6）、§9 回退（Task 2 开关 + Task 6 Step 6）——无缺口
2. **占位符扫描**：无 TBD/TODO；每个代码步骤含实际代码
3. **类型一致性**：`ImageFetchResult`/`ImageBlock`/`GateCheckResult.retry`/`runCount`/`markRun`/`stripImageBlocks` 在各任务间命名一致；`createGenerationTools(client, deps?)` 第二参在 Task 3 定义并被测试使用；`stripImageBlocks` 在 Task 3b 定义、`session-manager` 消费
4. **Review Focus**：①→Task 2 Step 1（text/html 用例）；②→Task 2 Step 1（无 content-length 熔断用例）；③→Task 3 Step 1（无 url 不 fetch 用例）；④→Task 3 Step 1（off 一致性用例）；⑤→Task 4 Step 1（resetSession 清零用例）；⑥→Task 4 Step 1（非 GATED 不污染预算 + 首次 run 仍被拦，P0 回归）；⑦→Task 3b Step 1（image block 剥离 + 无图原引用）

## 写计划时回代码核对发现的偏差（已修正）

| # | 发现 | 处置 |
|---|---|---|
| A | `index.ts` 通用放行路径上调 `markRun` 会让 `get_node(n1)` 先把预算吃到 1 → 首次 `run_*` 被判 retry、**跳过 SSOT pending_confirm 校验**（HITL 绕过，P0） | 预算消费移入 `checkGenerationGate` 放行分支；`index.ts` 只读 `check.retry`；加 P0 回归测试（Task 4） |
| B | 计划原 Task 3 的 `execute` 片段重写时漏了 `{ signal: context?.abortSignal }` → 会打回 P0-②「停止即中断生成」 | 片段补回第三参并注明勿丢（Task 3 Step 3） |
| C | `tool_end.result` 是完整 `AgentToolResult`（vendored `agent-harness.ts:327`），`SessionManager` 用 `data: evt` 原样派发（`session-manager.ts:229`）→ 2MB 图会进 SSE 帧、replay buffer、前端 store（`AgentSideRail.vue:1941` → `endToolCall`） | 新增 Task 3b：`stripImageBlocks` + `session-manager` 单点剥离 |
| D | Nest 侧 pi 链路**不落库**工具结果（`compress-recent-turns.ts:4` 明确记载）→ 无 DB 膨胀风险 | 无需处置，仅记录（收窄 ⑦ 的暴露面） |
| E | Nest 每轮 `createSessionReplacingStale` → `onSessionCreated` → `resetSession`，预算**按轮**累积 | 与 V-γ 语义一致（重试发生在同一条 agent 循环内）；Task 6 Step 5 冒烟须在同一轮内制造第 2/3 次调用 |
| F | 部署版本号写 `0.0.13`、开关回退基线写 `0.0.12` 已过时（生产当前 **0.0.14**，registry tag 0.0.14 亦被占用） | 修正：部署版本 → **0.0.15**；`off` 一致性基线 → **0.0.14**（与产线实际对齐） |
