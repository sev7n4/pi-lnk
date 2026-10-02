/** arrange_nodes 契约测试：单向 canvasCommands 形态 + L2 只读校验富化 + L3 by-mode 观测。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createArrangeNodesTools } from "./arrange-nodes.js";
import { Metrics } from "../metrics.js";
import { NestClient } from "./nest-client.js";
import type { LnkpiTool } from "./types.js";

const CTX = { sessionId: "s1" };

/** 对齐 harness execute 六参签名（同 ui-command.test.ts）。 */
async function run(tool: LnkpiTool, params: unknown, ctx: unknown = CTX) {
	return tool.execute!(
		"tc1",
		params as never,
		() => {},
		ctx as never,
		{} as never,
		undefined as never,
	);
}

function setup(client?: NestClient) {
	const metrics = new Metrics();
	const tools = createArrangeNodesTools(metrics, client);
	const tool = tools.find((t) => t.name === "arrange_nodes");
	assert.ok(tool, "arrange_nodes not registered");
	return { metrics, tool };
}

/** 只读 NestClient 替身：把 get-canvas-layout 的响应固定为给定 layout。 */
function fakeClient(layout: unknown): NestClient {
	return new NestClient({
		baseUrl: "http://nest.test",
		token: "t",
		fetchImpl: (async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({ code: 0, message: "ok", data: layout }),
		})) as never,
	});
}

/** 会抛错的替身（模拟超时/熔断/包络错）——校验必须降级为「不校验」而不是让工具失败。 */
function brokenClient(): NestClient {
	return new NestClient({
		baseUrl: "http://nest.test",
		token: "t",
		fetchImpl: (async () => {
			throw new Error("network down");
		}) as never,
	});
}

function payloadOf(res: Awaited<ReturnType<typeof run>>): Record<string, unknown> {
	return JSON.parse((res.content[0] as { type: "text"; text: string }).text) as Record<string, unknown>;
}

function commandOf(res: Awaited<ReturnType<typeof run>>): Record<string, unknown> {
	const details = res.details as { canvasCommands: Record<string, unknown>[] };
	return details.canvasCommands[0]!;
}

describe("arrange_nodes 基础契约（无 client，逐字节旧行为）", () => {
	it("tier=ui_command，mode 脏值收窄 grid，gap 缺省 40", async () => {
		const { tool } = setup();
		assert.equal(tool.tier, "ui_command");
		const r = await run(tool!, { node_ids: ["a", "b"], mode: "xyz" });
		assert.deepEqual(commandOf(r), { type: "arrange_nodes", nodeIds: ["a", "b"], mode: "grid", gap: 40 });
	});

	it("along_edges 无 edges → 降级 grid 并标 degraded", async () => {
		const { tool } = setup();
		const r = await run(tool!, { node_ids: ["a", "b"], mode: "along_edges" });
		assert.equal(commandOf(r)["mode"], "grid");
		assert.equal(payloadOf(r)["degraded"], "no_edges_fallback_grid");
		assert.equal(payloadOf(r)["verified"], false);
	});

	it("along_edges 带 edges → 透传，node_ids 去重", async () => {
		const { tool } = setup();
		const r = await run(tool!, {
			node_ids: ["a", "b", "a"],
			mode: "along_edges",
			gap: 24,
			edges: [{ source: "a", target: "b" }],
		});
		assert.deepEqual(commandOf(r), {
			type: "arrange_nodes",
			nodeIds: ["a", "b"],
			mode: "along_edges",
			gap: 24,
			edges: [{ source: "a", target: "b" }],
		});
		assert.equal(payloadOf(r)["degraded"], undefined);
	});
});

describe("arrange_nodes L2 只读校验（有 client）", () => {
	it("报告 missing ids 与真实 arranged 数", async () => {
		const { tool } = setup(fakeClient({ nodes: [{ id: "a" }, { id: "b" }], edges: [] }));
		const r = await run(tool!, { node_ids: ["a", "b", "ghost"], mode: "grid" });
		assert.deepEqual(payloadOf(r)["missing"], ["ghost"]);
		assert.equal(payloadOf(r)["arranged"], 2);
		assert.equal(payloadOf(r)["verified"], true);
		// 命令仍下发全集：存在的照样排，前端按 id 匹配
		assert.deepEqual(commandOf(r)["nodeIds"], ["a", "b", "ghost"]);
	});

	it("along_edges 显式边有效 → 不降级", async () => {
		const { tool } = setup(fakeClient({ nodes: [{ id: "a" }, { id: "b" }], edges: [] }));
		const r = await run(tool!, {
			node_ids: ["a", "b"],
			mode: "along_edges",
			edges: [{ source: "a", target: "b" }],
		});
		assert.equal(commandOf(r)["mode"], "along_edges");
		assert.equal(payloadOf(r)["degraded"], undefined);
	});

	it("along_edges 漏传边但画布有边 → 用画布边兜底并标注（不再静默变网格）", async () => {
		const { tool } = setup(
			fakeClient({
				nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
				edges: [{ source: "a", target: "b" }, { source: "b", target: "c" }, { source: "x", target: "y" }],
			}),
		);
		const r = await run(tool!, { node_ids: ["a", "b", "c"], mode: "along_edges" });
		assert.equal(commandOf(r)["mode"], "along_edges");
		assert.deepEqual(commandOf(r)["edges"], [{ source: "a", target: "b" }, { source: "b", target: "c" }]);
		assert.equal(payloadOf(r)["degraded"], "edges_missing_used_canvas_edges");
	});

	it("along_edges 且画布上也无边 → 降级 grid", async () => {
		const { tool } = setup(fakeClient({ nodes: [{ id: "a" }, { id: "b" }], edges: [] }));
		const r = await run(tool!, { node_ids: ["a", "b"], mode: "along_edges" });
		assert.equal(commandOf(r)["mode"], "grid");
		assert.equal(payloadOf(r)["degraded"], "no_edges_fallback_grid");
	});

	it("有效节点 < 2 → 标注 below_two_nodes（前端不重排，工具仍返回 ok）", async () => {
		const { tool } = setup(fakeClient({ nodes: [{ id: "a" }], edges: [] }));
		const r = await run(tool!, { node_ids: ["a", "ghost"], mode: "grid" });
		assert.equal(payloadOf(r)["arranged"], 1);
		assert.equal(payloadOf(r)["degraded"], "below_two_nodes");
	});

	it("校验失败（Nest 读异常）→ 不阻断：按入参原样下发且 verified=false", async () => {
		const { tool } = setup(brokenClient());
		const r = await run(tool!, {
			node_ids: ["a", "b"],
			mode: "along_edges",
			edges: [{ source: "a", target: "b" }],
		});
		assert.equal(commandOf(r)["mode"], "along_edges");
		assert.equal(payloadOf(r)["verified"], false);
		assert.deepEqual(payloadOf(r)["missing"], []);
	});

	it("无 sessionId（无画布上下文）→ 跳过校验，行为同无 client", async () => {
		const { tool } = setup(fakeClient({ nodes: [{ id: "a" }], edges: [] }));
		const r = await run(tool!, { node_ids: ["a", "b"], mode: "along_edges" }, {});
		assert.equal(payloadOf(r)["verified"], false);
		assert.equal(commandOf(r)["mode"], "grid");
	});
});

describe("arrange_nodes L3 by-mode 观测", () => {
	it("grid / along_edges 分别计数 tool=\"arrange_nodes_<mode>\"", async () => {
		const client = fakeClient({ nodes: [{ id: "a" }, { id: "b" }], edges: [{ source: "a", target: "b" }] });
		const { metrics, tool } = setup(client);
		await run(tool!, { node_ids: ["a", "b"], mode: "grid" });
		await run(tool!, { node_ids: ["a", "b"], mode: "along_edges" });
		const rendered = metrics.render(0, "test");
		assert.match(rendered, /pi_runtime_tool_calls_total\{tool="arrange_nodes_grid",result="ok"\} 1/);
		assert.match(rendered, /pi_runtime_tool_calls_total\{tool="arrange_nodes_along_edges",result="ok"\} 1/);
	});
});
