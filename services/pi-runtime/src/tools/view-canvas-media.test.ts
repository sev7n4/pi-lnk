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

function run(
	tool: LnkpiTool,
	params: unknown,
	ctx: LnkpiToolContext = CTX,
): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }> {
	return tool.execute!(
		"t1",
		params as never,
		() => {},
		ctx as never,
		{} as never,
		undefined as never,
	) as Promise<{
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	}>;
}

function viewTool(client: unknown, fetchImpl?: typeof fetch): LnkpiTool {
	return createViewCanvasMediaTools(client as never, { fetchImpl })[0]!;
}

function pngServer(
	bytes: number,
	contentType = "image/png",
): Promise<{ url: string; close: () => Promise<void> }> {
	return new Promise((resolve) => {
		const body = Buffer.alloc(bytes, 1);
		const server = http.createServer((_req, res) => {
			res.writeHead(200, { "content-type": contentType, "content-length": String(body.length) });
			res.end(body);
		});
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			resolve({ url: `http://127.0.0.1:${port}/a.png`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
		});
	});
}

test("node_id 命中：返回 text(JSON 含 canvasNode 锚) + image content", async () => {
	const { url, close } = await pngServer(10);
	try {
		const tool = viewTool(
			fakeClient({ id: "n_1", type: "image", data: { url } }),
			async (u) => fetch(u),
		);
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
		const client = {
			post: async (_p: string, b: { nodeId: string }) => {
				seen = b.nodeId;
				return { type: "image", data: { url } };
			},
		} as never;
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
		const client = {
			post: async () => {
				called = true;
				return {};
			},
		} as never;
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

test("I-1：PI_RUNTIME_IMAGE_REFINE=off 时 view_canvas_media 仍可用（开关只闸生成自评，不闸按需读图）", async () => {
	const { url, close } = await pngServer(10);
	const prev = process.env.PI_RUNTIME_IMAGE_REFINE;
	try {
		process.env.PI_RUNTIME_IMAGE_REFINE = "off";
		const tool = viewTool(fakeClient({ type: "image", data: { url } }), async (u) => fetch(u));
		const res = await run(tool, { node_id: "n_1" });
		assert.equal(res.content.length, 2);
		assert.equal(res.content[1]!.type, "image");
	} finally {
		if (prev === undefined) delete process.env.PI_RUNTIME_IMAGE_REFINE;
		else process.env.PI_RUNTIME_IMAGE_REFINE = prev;
		await close();
	}
});

test("M-1：focus 为非图片节点但显式给了 url → 用 url 直取，不因 focus 类型报错", async () => {
	const { url, close } = await pngServer(10);
	try {
		let called = false;
		const client = {
			post: async () => {
				called = true;
				return { type: "prompt", data: {} };
			},
		} as never;
		const tool = viewTool(client, async (u) => fetch(u));
		const res = await run(tool, { url }, { ...CTX, focusNodeId: "n_prompt" });
		const out = JSON.parse(res.content[0]!.text!);
		assert.equal(out.ok, true);
		assert.equal(called, false);
		assert.equal(res.content[1]!.type, "image");
	} finally {
		await close();
	}
});

test("fetch mime 不符 → ok:false 带原因", async () => {
	const tool = viewTool(
		fakeClient({ type: "image", data: { url: "http://127.0.0.1:1/x.png" } }),
		async () => new Response("nope", { headers: { "content-type": "text/html" } }),
	);
	const res = await run(tool, { node_id: "n_1" });
	const out = JSON.parse(res.content[0]!.text!);
	assert.equal(out.ok, false);
	assert.match(out.error, /png\/jpeg\/webp|mime|图片/);
});

test("fetch 超大 → ok:false", async () => {
	const tool = viewTool(
		fakeClient({ type: "image", data: { url: "http://x/big.png" } }),
		async () =>
			new Response(Buffer.alloc(3 * 1024 * 1024), { headers: { "content-type": "image/png" } }),
	);
	const res = await run(tool, { node_id: "n_1" });
	assert.equal(JSON.parse(res.content[0]!.text!).ok, false);
});
