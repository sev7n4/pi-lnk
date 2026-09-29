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
		// 超时用例会留下未完成的连接；close() 不终止在途 socket，需显式销毁，否则 node --test 挂起。
		server.closeAllConnections?.();
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
