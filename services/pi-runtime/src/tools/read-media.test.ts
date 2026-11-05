import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadMediaTools } from "./read-media.js";
import type { NestClient } from "./nest-client.js";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";

const CTX: LnkpiToolContext = {
	sessionId: "s1",
	attachments: [{ url: "http://h:8888/api/uploads/u1/a.png", mediaType: "image" }],
};

function fakeClient(result?: unknown, fail = false) {
	let calls = 0;
	const client = {
		post: async (_path: string, _body: unknown) => {
			calls += 1;
			if (fail) throw new Error("connect ECONNREFUSED");
			return result;
		},
		get callCount() {
			return calls;
		},
	};
	return client as unknown as NestClient & { callCount: number };
}

// 调用惯例镜像 view-canvas-media.test.ts 的 run()（execute 六参）。
function run(
	tool: LnkpiTool,
	params: unknown,
	ctx: LnkpiToolContext = CTX,
): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }> {
	return tool.execute!(
		"t1",
		params,
		() => {},
		ctx,
		{} as never,
		undefined as never,
	) as Promise<{
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	}>;
}

test("3a: ref → 工具侧解析为 url → Nest 返回时回传 text+image", async () => {
	const [tool] = createReadMediaTools(
		fakeClient({ ok: true, base64: "AAAA", mimeType: "image/png", fileName: "a.png", downscaled: false }),
	);
	const res = await run(tool, { ref: "I1" });
	assert.ok(res.content.some((c) => c.type === "image"));
});

test("3b: 直接给 url 透传", async () => {
	const [tool] = createReadMediaTools(
		fakeClient({ ok: true, base64: "AAAA", mimeType: "image/jpeg", fileName: "b.jpg", downscaled: true }),
	);
	const res = await run(tool, { url: "http://h:8888/api/uploads/u1/b.jpg" });
	assert.ok(res.content.some((c) => c.type === "image"));
});

test("3c: ref 解析失败（非图片 T1/越界 I9）→ ok:false 明确指引，不调 Nest", async () => {
	const client = fakeClient({ ok: false, error: "x" });
	const [tool] = createReadMediaTools(client);
	const res = await run(tool, { ref: "T1" });
	const text = JSON.stringify(res.content);
	assert.match(text, /false/);
	assert.match(text, /view_canvas_media/);
	assert.equal((client as unknown as { callCount: number }).callCount, 0);
});

test("3d: Nest 网络失败 → ok:false 文本，不抛错", async () => {
	const [tool] = createReadMediaTools(fakeClient(undefined, true));
	const res = await run(tool, { url: "http://h:8888/api/uploads/u1/a.png" });
	assert.match(JSON.stringify(res.content), /false/);
});
