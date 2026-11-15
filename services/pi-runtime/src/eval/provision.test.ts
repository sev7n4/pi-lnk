import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
 archiveEvalCanvas,
 createEvalCanvas,
 decideProvisioning,
 runStamp,
} from "./provision.js";

const NEST = { baseUrl: "http://127.0.0.1:5100/api", token: "svc-token" };

function jsonRes(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("decideProvisioning（纯函数判定）", () => {
	it("显式画布 id ⇒ 不供给（单画布复现模式，验收 3）", () => {
		const d = decideProvisioning({ canvasSessionId: "sess-x", userId: "u1", nest: NEST });
		assert.equal(d.provision, false);
		assert.equal(d.reason, "explicit-canvas-session");
	});

	it("缺 userId 或 nest ⇒ 不供给（回落 runL1 既有 fail-fast）", () => {
		assert.equal(decideProvisioning({ userId: "u1", nest: NEST }).provision, true);
		const noUser = decideProvisioning({ nest: NEST });
		assert.equal(noUser.provision, false);
		const noNest = decideProvisioning({ userId: "u1" });
		assert.equal(noNest.provision, false);
	});

	it("其余（自动模式）⇒ 供给", () => {
		const d = decideProvisioning({ userId: "u1", nest: NEST });
		assert.equal(d.provision, true);
		assert.equal(d.reason, "auto-provision-mode");
	});
});

describe("createEvalCanvas（D1/D3）", () => {
	it("成功：POST internal/create-canvas，解析 data.id，标题带 runStamp", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fetchImpl = (async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return jsonRes(200, { code: 0, message: "ok", data: { id: "sess-new", title: "eval-run-x" } });
		}) as typeof fetch;
		const out = await createEvalCanvas(NEST, "u1", { runStamp: "20261115-210000", fetchImpl });
		assert.equal(out.sessionId, "sess-new");
		assert.equal(out.title, "eval-run-20261115-210000");
		assert.equal(out.archiveTitle, "eval-used-20261115-210000");
		const call = calls[0]!;
		assert.ok(call.url.endsWith("/agent/internal/create-canvas"));
		// ⭐ internal 鉴权 header 是 x-lnkpi-service-token 原值（非 Bearer）
		assert.equal((call.init.headers as Record<string, string>)["x-lnkpi-service-token"], "svc-token");
		assert.deepEqual(JSON.parse(String(call.init.body)), {
			userId: "u1",
			title: "eval-run-20261115-210000",
		});
	});

	it("HTTP 401 ⇒ 抛错（D3 fail-fast，由 CLI 转 exit 2）", async () => {
		const fetchImpl = (async () =>
			jsonRes(401, { message: "Invalid service token" })) as typeof fetch;
		await assert.rejects(
			() => createEvalCanvas(NEST, "u1", { fetchImpl }),
			/HTTP 401/,
		);
	});

	it("响应缺 data.id ⇒ 抛错（画布未建成不能继续跑）", async () => {
		const fetchImpl = (async () => jsonRes(200, { code: 0, data: {} })) as typeof fetch;
		await assert.rejects(
			() => createEvalCanvas(NEST, "u1", { fetchImpl }),
			/缺 data\.id/,
		);
	});

	it("网络异常 ⇒ 抛错且消息带端点路径", async () => {
		const fetchImpl = (async () => {
			throw new Error("ECONNREFUSED");
		}) as typeof fetch;
		await assert.rejects(
			() => createEvalCanvas(NEST, "u1", { fetchImpl }),
			/create-canvas/,
		);
	});
});

describe("archiveEvalCanvas（D2 归档不删）", () => {
	it("成功：POST internal/rename-canvas，三字段齐备", async () => {
		const calls: Array<{ url: string; body: string }> = [];
		const fetchImpl = (async (url: string, init: RequestInit) => {
			calls.push({ url, body: String(init.body) });
			return jsonRes(200, { code: 0, message: "ok", data: { id: "sess-x" } });
		}) as typeof fetch;
		const out = await archiveEvalCanvas(NEST, "sess-x", "u1", "eval-used-20261115-210000", { fetchImpl });
		assert.equal(out.ok, true);
		assert.ok(calls[0]!.url.endsWith("/agent/internal/rename-canvas"));
		assert.deepEqual(JSON.parse(calls[0]!.body), {
			sessionId: "sess-x",
			userId: "u1",
			title: "eval-used-20261115-210000",
		});
	});

	it("失败：不抛，返回 {ok:false,error}（CLI 记 warning 不改退出码）", async () => {
		const fetchImpl = (async () => jsonRes(404, { message: "Session not found" })) as typeof fetch;
		const out = await archiveEvalCanvas(NEST, "sess-x", "u1", "eval-used-x", { fetchImpl });
		assert.equal(out.ok, false);
		assert.match(out.error ?? "", /HTTP 404/);
	});
});

describe("runStamp", () => {
	it("格式 yyyymmdd-HHMMSS（补零）", () => {
		assert.equal(runStamp(new Date(2026, 10, 15, 9, 3, 7)), "20261115-090307");
	});
});
