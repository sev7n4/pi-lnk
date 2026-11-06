/**
 * VISP Phase 2（Path C，spec 2026-11-05-agent-canvas-visual-perception-design.md §2.1 S-4 / §5.4 / §10.1）：
 * validate_canvas_layout 工具——确定性布局校验（R-V6：报告是事实源，不采信模型自述）。
 * 数据契约：/agent/internal/get-canvas-layout 的 nodes[].absolutePosition + size（服务端 getNodeSize 已算好）。
 * 校验逻辑 = packages/shared validateCanvasLayout 的镜像（validateCanvasLayoutLocal），
 * parity 由 validate-canvas-layout.contract-mirror.test.ts 锁（pi-runtime 无 @lnkpi/shared 依赖）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildValidateCanvasLayoutTools } from "./validate-canvas-layout.js";
import type { NestClient } from "./nest-client.js";
import type { LnkpiToolContext } from "./types.js";

const CTX: LnkpiToolContext = { sessionId: "s1", userId: "u1" };

/** get-canvas-layout 返回形态（agent-canvas-tools.service.ts:3238 实证）。 */
function layoutPayload(nodes: Array<{ id: string; x: number; y: number; w: number; h: number }>) {
	return {
		nodes: nodes.map((n) => ({
			id: n.id,
			type: "text",
			title: "",
			status: "ok",
			position: { x: n.x, y: n.y },
			absolutePosition: { x: n.x, y: n.y },
			size: { w: n.w, h: n.h },
		})),
		groups: [],
		edges: [],
	};
}

function makeClient(payload: unknown, fail = false) {
	const calls: { path: string; body: unknown }[] = [];
	return {
		calls,
		client: {
			post: async (path: string, body: unknown) => {
				calls.push({ path, body });
				if (fail) throw new Error("nest down");
				return payload;
			},
		} as unknown as NestClient,
	};
}

const run = (tool: ReturnType<typeof buildValidateCanvasLayoutTools>[number], params: unknown) =>
	tool.execute("1", params as never, undefined as never, CTX as never, undefined as never, undefined as never);

const parseOk = (out: { content: Array<{ text: string }> }) => JSON.parse(out.content[0]!.text) as {
	ok: boolean;
	data?: unknown;
	error?: string;
};

test("tier=present；调 get-canvas-layout 且 body 只带 sessionId", async () => {
	const { client, calls } = makeClient(layoutPayload([]));
	const [tool] = buildValidateCanvasLayoutTools(client);
	assert.equal(tool.tier, "present");
	assert.equal(tool.name, "validate_canvas_layout");
	await run(tool, {});
	assert.equal(calls[0]?.path, "/agent/internal/get-canvas-layout");
	assert.deepEqual(calls[0]?.body, { sessionId: "s1" });
});

test("重叠节点 → 1 条 OVERLAP，文本报告含节点 id 与交集尺寸（§5.4 报告形态）", async () => {
	const { client } = makeClient(
		layoutPayload([
			{ id: "n_a", x: 0, y: 0, w: 200, h: 100 },
			{ id: "n_b", x: 80, y: 20, w: 200, h: 100 },
		]),
	);
	const [tool] = buildValidateCanvasLayoutTools(client);
	const out = parseOk((await run(tool, {})) as never as { content: Array<{ text: string }> });
	assert.equal(out.ok, true);
	const data = out.data as { violations: Array<{ type: string; nodeIds: string[]; metric: string }>; summary: string };
	assert.equal(data.violations.length, 1);
	assert.equal(data.violations[0]!.type, "OVERLAP");
	assert.deepEqual(data.violations[0]!.nodeIds, ["n_a", "n_b"]);
	assert.ok(data.violations[0]!.metric.includes("120"), `metric 应含交集尺寸: ${data.violations[0]!.metric}`);
	assert.ok(data.summary.includes("n_a") && data.summary.includes("n_b"), "文本报告应含节点 id");
	assert.ok(data.summary.includes("120"), "文本报告应含量化结果");
});

test("干净画布 → violations 空 + summary「未检出违规」", async () => {
	const { client } = makeClient(
		layoutPayload([
			{ id: "a", x: 0, y: 0, w: 100, h: 100 },
			{ id: "b", x: 200, y: 0, w: 100, h: 100 },
		]),
	);
	const [tool] = buildValidateCanvasLayoutTools(client);
	const out = parseOk((await run(tool, {})) as never as { content: Array<{ text: string }> });
	const data = out.data as { violations: unknown[]; summary: string };
	assert.equal(data.violations.length, 0);
	assert.ok(data.summary.includes("未检出违规"));
});

test("min_spacing 参数透传 → 间距不足报 MIN_SPACING", async () => {
	const { client } = makeClient(
		layoutPayload([
			{ id: "a", x: 0, y: 0, w: 100, h: 100 },
			{ id: "b", x: 110, y: 0, w: 100, h: 100 },
		]),
	);
	const [tool] = buildValidateCanvasLayoutTools(client);
	const out = parseOk((await run(tool, { min_spacing: 20 })) as never as { content: Array<{ text: string }> });
	const data = out.data as { violations: Array<{ type: string }> };
	assert.equal(data.violations.length, 1);
	assert.equal(data.violations[0]!.type, "MIN_SPACING");
});

test("min_spacing 缺省 → 不判 MIN_SPACING（同布局零违规）", async () => {
	const { client } = makeClient(
		layoutPayload([
			{ id: "a", x: 0, y: 0, w: 100, h: 100 },
			{ id: "b", x: 110, y: 0, w: 100, h: 100 },
		]),
	);
	const [tool] = buildValidateCanvasLayoutTools(client);
	const out = parseOk((await run(tool, {})) as never as { content: Array<{ text: string }> });
	const data = out.data as { violations: unknown[] };
	assert.equal(data.violations.length, 0);
});

test("Nest 失败 → ok:false 明确错误文本（R-V8 fail-soft，不抛不编造）", async () => {
	const { client } = makeClient(null, true);
	const [tool] = buildValidateCanvasLayoutTools(client);
	const out = parseOk((await run(tool, {})) as never as { content: Array<{ text: string }> });
	assert.equal(out.ok, false);
	assert.ok((out.error ?? "").includes("布局校验失败"));
});

test("schema 不含 sessionId（上下文注入字段不进模型参数面）", () => {
	const { client } = makeClient(layoutPayload([]));
	const [tool] = buildValidateCanvasLayoutTools(client);
	assert.ok(!JSON.stringify(tool.parameters).includes("sessionId"));
});
