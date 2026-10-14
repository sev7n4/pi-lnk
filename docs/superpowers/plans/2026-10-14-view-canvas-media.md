# view_canvas_media 视觉感知闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让模型能按需「看到」画布/侧栏图片的像素（view_canvas_media 工具），并修复 T2 图片降级占位符指向断头路（read_document）的问题，改为带节点锚点的可恢复占位。

**Architecture:** 纯 pi-runtime 改动。新读工具 view_canvas_media 复用既有 `fetchImageAsBlock`（image-refine）与 Nest `/agent/internal/get-node` 端点，图片以 ImageContent 进 tool result；T2 出站治理（governImagePayload）自动覆盖新来源的图片。run_image_generation 附图时在文本 JSON 写入 `canvasNode` 锚，T2 降级占位时用锚生成可恢复的提示。

**Tech Stack:** TypeScript (ESM, node:test), vendored pi-agent-core 0.85.1（不改）, typebox。

**Spec:** `docs/superpowers/specs/2026-10-14-view-canvas-media-design.md`

## Global Constraints

- **只改 `services/pi-runtime/`**，零 Nest / 零 web / 零 prompt-registry / 零 vendor 改动。prompt-registry 不动 ⇒ 不跑 prompt:lint。
- 新工具 **常驻**（加入 `ALWAYS_ON_TOOL_NAMES`），tier=`read`；禁止进延迟集。
- 所有失败路径返回 `{ok:false, error}` 文本结果，**不抛错**（读工具 fail-soft 纪律）。
- 复用 `fetchImageAsBlock`，不新增 npm 依赖（禁 sharp；>2MB 拒绝而非缩图）。
- 图片锚点 key 固定为 `canvasNode`（payload-images.labelFor 的提取正则 `"canvasNode":"([^"]+)"` 与生成方必须逐字对齐）。
- Git 纪律：禁 `git add -A`，只 add 显式路径；工作区在别的分支 ⇒ 本任务在**独立 worktree** 中进行。
- worktree 依赖坑（MEMORY 实证）：`services/pi-runtime/node_modules` 软链主仓；二进制一律 `./node_modules/.bin/<bin>`。

## Review Focus

1. **非视觉模型调用 view_canvas_media**：图片进请求后被 vendor 静默换成 `(image omitted)`——不炸、上游 200，模型看到占位文本。期望：不报错、行为可理解（BYOK supportsVision 显式声明是 #123 既有纪律，本计划不重复处理，但要确认工具失败路径不依赖模型视觉）。测试钉住：工具层对 fetch 成功只回 content，不判断模型能力（无此类分支即通过）。
2. **focusNodeId 回落到非图片节点**（prompt/text 节点或生成中的节点无 url）：期望 ok:false + 明确原因，而不是抛错或返回空图。测试钉住：Task 2 步骤 1 的「focus 回落非图片节点」用例。
3. **p.url 直传非图片 / 过期 url**：fetchImageAsBlock 返回 mime/http 失败 ⇒ ok:false 带原因。测试钉住：Task 2 步骤 1 的 mime/http 用例。
4. **占位锚点提取与生成方逐字对齐**：`"canvasNode":"n_x"` 若生成方改成 `canvasNodeId` 或空格变化，labelFor 静默失配（假阴性家族）。测试钉住：Task 4 用 generation.ts 真实产物 JSON 形态（`JSON.stringify({ok:true,data:{canvasNode:"n_1",...}})`）喂 labelFor 的断言。
5. **view 结果自身被 T2 降级后的可恢复性**：view_canvas_media 返回的图在 2 轮后同样被降级，占位必须带 canvasNode 锚（闭环自证）。测试钉住：Task 4 的「view 形态结果降级」用例。

---

### Task 1: Worktree 与依赖接线

**Files:**
- Create: `.worktrees/view-canvas-media/`（worktree，非仓库文件）

**Interfaces:**
- Consumes: 主仓 master（本地 `master` = `82b4914c`，与 origin/master 一致）。
- Produces: 分支 `feat/view-canvas-media`，pi-runtime 可跑 tsc / node --test。

- [ ] **Step 1: 创建 worktree（从本地 master，不切主仓分支）**

```bash
git -C /Users/4seven/workspace/pi-lnk fetch origin master:master 2>&1 | tail -1
git -C /Users/4seven/workspace/pi-lnk worktree add -b feat/view-canvas-media /Users/4seven/workspace/pi-lnk/.worktrees/view-canvas-media master
```

Expected: `Preparing worktree` + `new branch feat/view-canvas-media`。主仓保持在 `feat/usage-credits-display` 不受影响。

- [ ] **Step 2: 软链 pi-runtime node_modules（绝对路径）**

```bash
ln -s /Users/4seven/workspace/pi-lnk/services/pi-runtime/node_modules /Users/4seven/workspace/pi-lnk/.worktrees/view-canvas-media/services/pi-runtime/node_modules
```

- [ ] **Step 3: 验证工具链可用**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/view-canvas-media/services/pi-runtime && ./node_modules/.bin/tsc --noEmit
```

Expected: exit 0（基线干净）。

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/view-canvas-media/services/pi-runtime && node --import ./node_modules/.bin/tsx --test src/tools/image-refine.test.ts 2>&1 | tail -5
```

Expected: 全 pass（证明 tsx + node:test 可用）。

### Task 2: view_canvas_media 工具（TDD + 注册接线）

**Files:**
- Create: `services/pi-runtime/src/tools/view-canvas-media.ts`
- Test: `services/pi-runtime/src/tools/view-canvas-media.test.ts`
- Modify: `services/pi-runtime/src/tools/registry.ts`、`services/pi-runtime/src/tools/config.ts`、`services/pi-runtime/src/tools/tiering.ts`、`services/pi-runtime/src/tools/tiering.test.ts`

**Interfaces:**
- Consumes: `fetchImageAsBlock(url, { fetchImpl }) from "./image-refine.js"`（返回 `{ok:true, block:{type:"image",data,mimeType}} | {ok:false, reason}`）；`NestClient.post(path, body)`；`LnkpiToolContext.focusNodeId?/sessionId`。
- Produces: `createViewCanvasMediaTools(client: NestClient, deps?: { fetchImpl?: typeof fetch }): LnkpiTool[]`；工具名 `view_canvas_media`；结果文本 JSON 锚字段 `canvasNode`。

- [ ] **Step 1: 写失败测试**

```ts
// services/pi-runtime/src/tools/view-canvas-media.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createViewCanvasMediaTools } from "./view-canvas-media.js";
import type { LnkpiToolContext, LnkpiTool } from "./types.js";

const CTX: LnkpiToolContext = { sessionId: "s1" };

function fakeClient(nodeResponse?: unknown, fail = false) {
	return {
		post: async (_path: string, body: Record<string, unknown>) => {
			if (fail) throw new Error("boom");
			assert.equal((body as { nodeId?: string }).nodeId !== undefined || fail, true);
			return nodeResponse;
		},
	} as never;
}

function run(tool: LnkpiTool, params: unknown, ctx: LnkpiToolContext = CTX) {
	return tool.execute("t1", params, undefined, ctx) as Promise<{
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	}>;
}

function viewTool(client: unknown, fetchImpl?: typeof fetch): LnkpiTool {
	return createViewCanvasMediaTools(client as never, { fetchImpl })[0];
}

function pngServer(bytes: number, contentType = "image/png"): Promise<{ url: string; close: () => Promise<void> }> {
	return new Promise((resolve) => {
		const body = Buffer.alloc(bytes, 1);
		const server = http.createServer((_req, res) => {
			res.writeHead(200, { "content-type": contentType, "content-length": String(body.length) });
			res.end(body);
		});
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			resolve({ url: `http://127.0.0.1:${port}/a.png`, close: () => new Promise((r) => server.close(r)) });
		});
	});
}

test("node_id 命中：返回 text(JSON 含 canvasNode 锚) + image content", async () => {
	const { url, close } = await pngServer(10);
	try {
		const tool = viewTool(fakeClient({ id: "n_1", type: "image", data: { url } }), async () => new Response(await fetch(url)));
		const res = await run(tool, { node_id: "n_1" });
		assert.equal(res.content.length, 2);
		const text = JSON.parse(res.content[0]!.text!);
		assert.equal(text.ok, true);
		assert.equal(text.data.canvasNode, "n_1");
		assert.equal(res.content[1]!.type, "image");
		assert.equal(res.content[1]!.mimeType, "image/png");
	} finally {
		await close();
	}
});

test("node_id 缺省回落 tc.focusNodeId", async () => {
	const { url, close } = await pngServer(10);
	try {
		let seen = "";
		const client = { post: async (_p: string, b: { nodeId: string }) => { seen = b.nodeId; return { type: "image", data: { url } }; } } as never;
		const tool = viewTool(client, async (u) => fetch(u));
		const res = await run(tool, {}, { ...CTX, focusNodeId: "n_focus" });
		assert.equal(seen, "n_focus");
		assert.equal(JSON.parse(res.content[0]!.text!).data.canvasNode, "n_focus");
	} finally {
		await close();
	}
});

test("focus 回落到非图片节点 → ok:false 不抛错", async () => {
	const tool = viewTool(fakeClient({ type: "prompt", data: { content: "文案" } }));
	const res = await run(tool, {});
	assert.equal(JSON.parse(res.content[0]!.text!).ok, false);
	assert.equal(res.content.length, 1);
});

test("节点无 url（未生成完成）→ ok:false", async () => {
	const tool = viewTool(fakeClient({ type: "image", data: {} }));
	const res = await run(tool, { node_id: "n_1" });
	assert.equal(JSON.parse(res.content[0]!.text!).ok, false);
});

test("video 节点 → ok:false 提示不支持", async () => {
	const tool = viewTool(fakeClient({ type: "video", data: { url: "http://x/v.mp4" } }));
	const res = await run(tool, { node_id: "n_1" });
	const out = JSON.parse(res.content[0]!.text!);
	assert.equal(out.ok, false);
	assert.match(out.error, /video/);
});

test("get-node 抛错 → ok:false", async () => {
	const tool = viewTool(fakeClient(undefined, true));
	const res = await run(tool, { node_id: "n_1" });
	assert.equal(JSON.parse(res.content[0]!.text!).ok, false);
});

test("url 直传：跳过 get-node，直接 fetch", async () => {
	const { url, close } = await pngServer(10);
	try {
		let called = false;
		const client = { post: async () => { called = true; return {}; } } as never;
		const tool = viewTool(client, async (u) => fetch(u));
		const res = await run(tool, { url });
		assert.equal(called, false);
		assert.equal(res.content[1]!.type, "image");
		const out = JSON.parse(res.content[0]!.text!);
		assert.equal(out.ok, true);
		assert.equal(out.data.canvasNode, undefined);
	} finally {
		await close();
	}
});

test("无任何来源 → ok:false 给出用法提示", async () => {
	const tool = viewTool(fakeClient());
	const res = await run(tool, {});
	assert.equal(JSON.parse(res.content[0]!.text!).ok, false);
});

test("fetch mime 不符 → ok:false 带原因", async () => {
	const tool = viewTool(fakeClient({ type: "image", data: { url: "http://127.0.0.1:1/x.png" } }), async () => new Response("nope", { headers: { "content-type": "text/html" } }));
	const res = await run(tool, { node_id: "n_1" });
	const out = JSON.parse(res.content[0]!.text!);
	assert.equal(out.ok, false);
	assert.match(out.error, /png\/jpeg\/webp|mime|图片/);
});

test("fetch 超大 → ok:false", async () => {
	const tool = viewTool(fakeClient({ type: "image", data: { url: "http://x/big.png" } }), async () => new Response(Buffer.alloc(3 * 1024 * 1024), { headers: { "content-type": "image/png" } }));
	const res = await run(tool, { node_id: "n_1" });
	assert.equal(JSON.parse(res.content[0]!.text!).ok, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/view-canvas-media/services/pi-runtime && node --import ./node_modules/.bin/tsx --test src/tools/view-canvas-media.test.ts 2>&1 | tail -5
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 最小实现**

```ts
// services/pi-runtime/src/tools/view-canvas-media.ts
/**
 * view_canvas_media（P0 感知闭环，spec 2026-10-14-view-canvas-media-design.md §2）：
 * 按需把画布/侧栏图片的像素以 ImageContent 回流 tool result。
 * 来源优先级：node_id > url > tc.focusNodeId。复用 image-refine 的 fetchImageAsBlock
 * （2MB 上限、mime 白名单、fail-soft）；全部失败路径 ok:false 文本，不抛错。
 * 文本 JSON 携带 canvasNode 锚：T2 降级占位（payload-images.labelFor）据此生成可恢复提示。
 */
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import type { NestClient } from "./nest-client.js";
import { fetchImageAsBlock } from "./image-refine.js";

type ViewResult = {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	details: undefined;
};

function viewResult(payload: Record<string, unknown>): ViewResult {
	return { content: [{ type: "text", text: JSON.stringify(payload) }], details: undefined };
}

const NON_IMAGE_TYPES = new Set(["video", "audio", "text", "prompt"]);

export function createViewCanvasMediaTools(
	client: NestClient,
	deps: { fetchImpl?: typeof fetch } = {},
): LnkpiTool[] {
	return [
		{
			tier: "read" as const,
			name: "view_canvas_media",
			label: "查看图片内容",
			description:
				"View the actual pixels of an image (canvas node or media url). Use whenever the user asks about an image's visual content, references an image node, or a context placeholder says an image was removed from context. Params: node_id (canvas node, falls back to the current focus node) or url (direct media url, e.g. from a sidebar attachment). Returns the image itself in the result.",
			parameters: Type.Object({
				node_id: Type.Optional(
					Type.String({ description: "Canvas image node id (e.g. n_abc123). Omit both params to use the current focus node." }),
				),
				url: Type.Optional(
					Type.String({ description: "Direct image url (e.g. from a sidebar attachment). Use when no node id is known." }),
				),
			}),
			execute: async (
				_id,
				p: { node_id?: string; url?: string },
				_u,
				tc: LnkpiToolContext,
			): Promise<ViewResult> => {
				const nodeId = (p?.node_id ?? "").trim() || (tc?.focusNodeId ?? "").trim();
				let url = (p?.url ?? "").trim();
				let canvasNode: string | undefined;
				if (nodeId) {
					let node: { type?: unknown; data?: { url?: unknown } } | null;
					try {
						node = await client.post("/agent/internal/get-node", {
							sessionId: tc.sessionId,
							nodeId,
						});
					} catch (err) {
						return viewResult({
							ok: false,
							error: `节点 ${nodeId} 不存在或不可读: ${err instanceof Error ? err.message : String(err)}`,
						});
					}
					const t = String(node?.type ?? "");
					if (NON_IMAGE_TYPES.has(t)) {
						return viewResult({ ok: false, error: `节点 ${nodeId} 是 ${t} 节点，本工具仅支持图片（image/mediaInput）` });
					}
					url = String(node?.data?.url ?? "").trim();
					if (!url) {
						return viewResult({ ok: false, error: `节点 ${nodeId} 没有图片 url（可能尚未生成完成）` });
					}
					canvasNode = nodeId;
				}
				if (!url) {
					return viewResult({
						ok: false,
						error: "缺少图片来源：请传 node_id 或 url；可先 get_canvas_summary / get_node 找到目标节点 id",
					});
				}
				const fetched = await fetchImageAsBlock(url, { fetchImpl: deps.fetchImpl });
				if (!fetched.ok) {
					const reasonText: Record<string, string> = {
						disabled: "view_canvas_media 已被关闭（PI_RUNTIME_IMAGE_REFINE=off）",
						"empty-url": "图片 url 为空",
						timeout: "图片下载超时",
						network: "图片下载网络失败",
						http: "图片 url 返回非 200（可能已过期）",
						mime: "该 url 不是 png/jpeg/webp 图片",
						"too-large": "图片超过 2MB 上限",
					};
					return viewResult({
						ok: false,
						error: `取图失败（${reasonText[fetched.reason] ?? fetched.reason}）: ${url}`,
					});
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								ok: true,
								data: { ...(canvasNode ? { canvasNode } : {}), url },
							}),
						},
						fetched.block satisfies { type: "image"; data: string; mimeType: string },
					],
					details: undefined,
				};
			},
		},
	];
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/view-canvas-media/services/pi-runtime && node --import ./node_modules/.bin/tsx --test src/tools/view-canvas-media.test.ts 2>&1 | tail -5
```

Expected: 全 pass。

- [ ] **Step 5: 注册接线（registry / config / tiering / tiering.test）**

`registry.ts` 追加（import 区 + 文件尾）：

```ts
import { createViewCanvasMediaTools } from "./view-canvas-media.js";

/** P0 感知闭环（spec 2026-10-14-view-canvas-media-design.md）：view_canvas_media
 *  （tier=read，按需读画布/侧栏图片像素，复用 image-refine fetcher，零 Nest 改动）。 */
export function buildViewCanvasMediaTools(client: NestClient): LnkpiTool[] {
	return createViewCanvasMediaTools(client);
}
```

`config.ts`：import 行加入 `buildViewCanvasMediaTools`，在 `...buildCanvasReadTools(client),` 之后插入：

```ts
		...buildViewCanvasMediaTools(client),
```

`tiering.ts` 的 `ALWAYS_ON_TOOL_NAMES`（read 区块，`"get_canvas_summary",` 之后）追加：

```ts
	// P0 感知闭环（2026-10-14）：T2 图片降级占位文案点名它作恢复路径（payload-images.labelFor
	// ⇒ 占位含 view_canvas_media(node_id:…)）——按「被点名 ⇒ 必须常驻」准绳必须常驻；
	// 且「看图」是高频刚需，延迟即不可达（tool_search 语义靠不住的教训见文件头）。
	"view_canvas_media",
```

`tiering.test.ts` 的 `ALL_NAMES` read 区块（`"read_document",` 之后）追加：

```ts
	"view_canvas_media",
```

- [ ] **Step 6: 跑 tiering 测试 + 工具全量测试**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/view-canvas-media/services/pi-runtime && node --import ./node_modules/.bin/tsx --test src/tools/tiering.test.ts 2>&1 | tail -5
```

Expected: 全 pass（ALL_NAMES 新成员默认走「未点名 ⇒ 延迟」断言组——它已在 ALWAYS_ON 内，故 active 断言通过；若有「延迟集」白名单数组测试需同步把 view_canvas_media 排除，按失败信息修）。

- [ ] **Step 7: typecheck + 提交**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/view-canvas-media/services/pi-runtime && ./node_modules/.bin/tsc --noEmit
git -C /Users/4seven/workspace/pi-lnk/.worktrees/view-canvas-media add services/pi-runtime/src/tools/view-canvas-media.ts services/pi-runtime/src/tools/view-canvas-media.test.ts services/pi-runtime/src/tools/registry.ts services/pi-runtime/src/tools/config.ts services/pi-runtime/src/tools/tiering.ts services/pi-runtime/src/tools/tiering.test.ts
git -C /Users/4seven/workspace/pi-lnk/.worktrees/view-canvas-media commit -m "feat(pi-runtime): view_canvas_media 按需读图工具——画布/侧栏图片像素回流 tool result（P0 感知闭环）"
```

### Task 3: P1 锚点——generation.ts 带 canvasNode + T2 占位修复（TDD）

**Files:**
- Modify: `services/pi-runtime/src/tools/generation.ts:128-138`（附图路径）
- Modify: `services/pi-runtime/src/payload-images.ts`（placeholder/labelFor/drop）
- Modify: `services/pi-runtime/src/tools/read-document.ts:86-89`（错误文案）
- Test: `services/pi-runtime/src/tools/generation.test.ts`（新增 1 例）、`services/pi-runtime/src/payload-images.test.ts`（改 1 断言 + 新增 2 例）

**Interfaces:**
- Consumes: Task 2 的锚字段约定 `canvasNode`（文本 JSON 内）；`withImageRefine(base, data, mark)`（generation.ts:80）。
- Produces: 占位文案三种形态（见 Step 3 代码）；`governImagePayload` 对外签名不变。

- [ ] **Step 1: 写失败测试（generation 锚 + 占位锚恢复 + 无锚新文案）**

`generation.test.ts` 追加（镜像既有 attached 用例的 fake 形态，参考 :205 附近 `imageFetch` helper）：

```ts
test("视觉自评闭环：attached 时文本 JSON 带 canvasNode 锚（T2 降级恢复的依据）", async () => {
	const tool = createGenerationTools(client as never, { fetchImpl: imageFetch() }).find(
		(t) => t.name === "run_image_generation",
	)!;
	const res = await run(tool, { node_id: "n_1" });
	const text = JSON.parse((res.content[0] as { text: string }).text);
	assert.equal(text.data.canvasNode, "n_1");
	assert.equal(res.content.length, 2);
});
```

`payload-images.test.ts` 追加：

```ts
test("canvasNode 锚：同消息文本含 canvasNode 时占位带节点 id 与 view_canvas_media 恢复路径", () => {
	const payload = {
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: '结果 {"ok":true,"data":{"canvasNode":"n_9","url":"http://x/a.png"}}',
					},
					{ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(100)}` } },
				],
			},
		],
	};
	const r = governImagePayload(payload, 0, 4); // historyRounds=0 ⇒ 全部降级
	const parts = (r.messages as Array<{ content: unknown[] }>)[0].content as Array<{ type: string; text?: string }>;
	const ph = parts.find((p) => p.type === "text" && p.text?.includes("已从上下文移除"))?.text ?? "";
	assert.match(ph, /view_canvas_media\(node_id:"n_9"\)/);
});

test("无锚旧文案：占位恢复提示指向 view_canvas_media 而非 read_document", () => {
	const payload = {
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "[I1=a.png]" },
					{ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(100)}` } },
				],
			},
		],
	};
	const parts = (governImagePayload(payload, 0, 4).messages as Array<{ content: unknown[] }>)[0]
		.content as Array<{ type: string; text?: string }>;
	const ph = parts.find((p) => p.type === "text" && p.text?.includes("已从上下文移除"))?.text ?? "";
	assert.match(ph, /view_canvas_media/);
	assert.doesNotMatch(ph, /read_document/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/view-canvas-media/services/pi-runtime && node --import ./node_modules/.bin/tsx --test src/tools/generation.test.ts src/payload-images.test.ts 2>&1 | tail -8
```

Expected: 新增 3 例 FAIL（canvasNode 缺失 / 占位仍是 read_document）。

- [ ] **Step 3: 实现**

`generation.ts:137`（attached 分支，仅此一行改动）：

```ts
			const attached = withImageRefine(base, { ...data, canvasNode: p.node_id }, "attached");
```

`payload-images.ts` 替换 `placeholder`、`drop`、`labelFor`（其余不动）：

```ts
function placeholder(label: string, canvasNodeId?: string): string {
	if (canvasNodeId) {
		return `[图片（画布节点 ${canvasNodeId}）已从上下文移除，可用 view_canvas_media(node_id:"${canvasNodeId}") 取回]`;
	}
	return `[图片${label} 已从上下文移除，可调 view_canvas_media 重新查看]`;
}
```

```ts
interface ImageLabel {
	text: string;
	canvasNodeId?: string;
}
```

`drop` 的第三参从 `label: string` 改为 `info: ImageLabel`：

```ts
	const drop = (ref: ImageRef, reason: TrimReason, info: ImageLabel) => {
		remove.set(`${ref.msgIdx}:${ref.partIdx}`, placeholder(info.text, info.canvasNodeId));
		trimCounts[reason] += 1;
	};
```

三处 `drop(...)` 调用点的 `labelFor(...)` 改为传整个返回对象（`labelFor` 返回 `ImageLabel`）。`labelFor` 重写：

```ts
/** 占位标签：从同消息 text parts 恢复锚。优先 canvasNode（view_canvas_media 可精确恢复）；
 *  否则用 `[I{n}=` 侧栏芯片编号；两者都没有则空标签。 */
function labelFor(messages: unknown[], normalized: (NormalizedPart[] | undefined)[], ref: ImageRef): ImageLabel {
	const parts = normalized[ref.msgIdx];
	if (!parts) return { text: "" };
	let canvasNodeId: string | undefined;
	for (const p of parts) {
		if (p.kind !== "text" || !p.text) continue;
		if (!canvasNodeId) {
			const nm = /"canvasNode":"([^"]+)"/.exec(p.text);
			if (nm) canvasNodeId = nm[1];
		}
		const im = /\[I(\d+)=/.exec(p.text);
		if (im) return { text: ` I${im[1]}`, canvasNodeId };
	}
	return { text: "", canvasNodeId };
}
```

`read-document.ts:89` 错误文案改为：

```ts
					error:
						hit.key +
						" 是 " +
						hit.item.mediaType +
						" 素材，read_document 仅支持文本素材；图片素材可用 view_canvas_media 传 url（或节点 node_id）查看",
```

同时把 `payload-images.test.ts:41` 的既有断言 `includes("read_document")` 改为 `includes("view_canvas_media")`。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/view-canvas-media/services/pi-runtime && node --import ./node_modules/.bin/tsx --test src/tools/generation.test.ts src/payload-images.test.ts src/tools/read-document.test.ts 2>&1 | tail -8
```

Expected: 全 pass（read-document.test 若断言旧错误文案，同步更新断言为新文案）。

- [ ] **Step 5: 提交**

```bash
git -C /Users/4seven/workspace/pi-lnk/.worktrees/view-canvas-media add services/pi-runtime/src/tools/generation.ts services/pi-runtime/src/payload-images.ts services/pi-runtime/src/tools/read-document.ts services/pi-runtime/src/tools/generation.test.ts services/pi-runtime/src/payload-images.test.ts
git -C /Users/4seven/workspace/pi-lnk/.worktrees/view-canvas-media commit -m "fix(pi-runtime): T2 图片降级占位改指向 view_canvas_media 并带 canvasNode 锚——修复断头恢复路径（P1）"
```

### Task 4: 登记与全量验证

**Files:**
- Modify: `docs/agent/tool-capability-catalog.md`（按该文档既有四列格式追加一行）

- [ ] **Step 1: catalog 登记（读文档既有表格式后追加，四列口径）**

`view_canvas_media`：点名资产 = T2 降级占位文案（payload-images.ts，恢复路径）＋ 视觉自评闭环 spec；归属 = 常驻（ALWAYS_ON_TOOL_NAMES）；触发话术 = 「看看这张图 / 对照产物 / 图片被移除后取回」。

- [ ] **Step 2: 全量验证（本分支全部改动面）**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/view-canvas-media/services/pi-runtime && ./node_modules/.bin/tsc --noEmit && node --import ./node_modules/.bin/tsx --test "src/**/*.test.ts" 2>&1 | tail -6
```

Expected: tsc exit 0 + 全套件 pass（若个别历史用例与本改动无关地红，单跑复验区分伪影与回归，只对本分支触碰文件负责）。

- [ ] **Step 3: 提交文档**

```bash
git -C /Users/4seven/workspace/pi-lnk/.worktrees/view-canvas-media add docs/agent/tool-capability-catalog.md docs/superpowers/specs/2026-10-14-view-canvas-media-design.md docs/superpowers/plans/2026-10-14-view-canvas-media.md
git -C /Users/4seven/workspace/pi-lnk/.worktrees/view-canvas-media commit -m "docs(agent): view_canvas_media 登记 tool-capability-catalog + spec/plan 归档"
```

### Task 5: push + PR

**Files:** 无新增。

- [ ] **Step 1: 确认工作区干净后 push**

```bash
git -C /Users/4seven/workspace/pi-lnk/.worktrees/view-canvas-media status --short
git -C /Users/4seven/workspace/pi-lnk/.worktrees/view-canvas-media push -u origin feat/view-canvas-media
```

Expected: status 为空（本地绿≠CI 绿：push 前工作区必须干净）。

- [ ] **Step 2: 开 PR（gh，代理按环境纪律处理）**

```bash
gh pr create --repo <org>/pi-lnk --base master --head feat/view-canvas-media \
  --title "feat(pi-runtime): view_canvas_media 视觉感知闭环（P0 工具 + P1 占位锚点修复）" \
  --body "spec: docs/superpowers/specs/2026-10-14-view-canvas-media-design.md；plan: docs/superpowers/plans/2026-10-14-view-canvas-media.md"
```

- [ ] **Step 3: 合并后部署与生产复测（用户偏好：squash 合并 + 生产复测）**

合并后核对 deploy run；pi-runtime 为 k3s 部署（charts/pi-lnk-runtime），确认 runtime 镜像重建。生产复测话术：生成一张图 → 隔 2 轮以上问「把刚那张图的构图问题逐条列出来」——期望模型调 view_canvas_media 并描述图片内容，而非「看不到」。

---

## Self-Review 记录

- Spec 覆盖：§2 P0 → Task 2；§3 P1 → Task 3；§4 不做清单 → Global Constraints。无缺口。
- 类型一致性：`ImageLabel`（Task 3 定义）在 drop/labelFor/三处调用点一致；`canvasNode` 锚字段在 Task 2（view 工具）、Task 3（generation + labelFor 正则）三处逐字一致。
- Placeholder 扫描：所有步骤含完整代码/命令，无 TBD。
