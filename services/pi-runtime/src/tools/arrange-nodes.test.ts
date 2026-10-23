/** arrange_nodes 契约测试：单向 canvasCommands 形态 + L2 只读校验富化。
 *  2026-10-04：L3 by-mode 观测用例已删——计数移交事件层后本文件直调 execute
 *  不经过 harness，事件层不产生事件；`arrange_nodes_<mode>` 动态 label 的
 *  消失正是要消除的基数风险（mode 会随前端加模式增长）。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createArrangeNodesTools } from "./arrange-nodes.js";
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
	const tools = createArrangeNodesTools(client);
	const tool = tools.find((t) => t.name === "arrange_nodes");
	assert.ok(tool, "arrange_nodes not registered");
	return { tool };
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
	it("tier=ui_command，gap 缺省 40", async () => {
		const { tool } = setup();
		assert.equal(tool.tier, "ui_command");
		const r = await run(tool!, { node_ids: ["a", "b"], mode: "grid" });
		assert.deepEqual(commandOf(r), { type: "arrange_nodes", nodeIds: ["a", "b"], mode: "grid", gap: 40 });
	});

	// ⛔ 2026-10-23 契约消歧：旧行为「mode 脏值收窄 grid」是把**歧义写成了期望**——
	//   模型把 align 拼成 "aligned" 时会静默执行网格重排（前端注释早已警告：
	//   「静默落到 grid 分支 ⇒ 对齐意图被换成网格重排」）。现在必须**报错**让模型自纠。
	it("⛔ mode 脏值 → 抛错并列出允许值（不再静默收窄 grid）", async () => {
		const { tool } = setup();
		await assert.rejects(
			() => run(tool!, { node_ids: ["a", "b"], mode: "aligned" }),
			/mode 必须是 grid \| along_edges \| align \| distribute/,
		);
		await assert.rejects(
			() => run(tool!, { node_ids: ["a", "b"], mode: "" }),
			/mode 必须是/,
		);
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

describe("arrange_nodes align/distribute 扩 mode（canvas_command 透传，不点名 prompt）", () => {
	it("mode=align 带 alignMode 透传命令", async () => {
		const { tool } = setup();
		const r = await run(tool!, { node_ids: ["a", "b", "c"], mode: "align", align_mode: "left" });
		const cmd = commandOf(r);
		assert.equal(cmd["type"], "arrange_nodes");
		assert.equal(cmd["mode"], "align");
		assert.equal(cmd["alignMode"], "left");
	});
	it("mode=distribute 带 axis 透传命令", async () => {
		const { tool } = setup();
		const r = await run(tool!, { node_ids: ["a", "b", "c"], mode: "distribute", axis: "x" });
		const cmd = commandOf(r);
		assert.equal(cmd["mode"], "distribute");
		assert.equal(cmd["axis"], "x");
	});

	// 等距分布需 ≥3 节点：前端对 <3 是 no-op ⇒ 若不回灌，模型会以为「已经排好了」
	it("distribute 仅 2 个有效节点 → 标 degraded（不静默无反应）", async () => {
		const { tool } = setup(fakeClient({ nodes: [{ id: "a" }, { id: "b" }] }));
		const r = await run(tool!, { node_ids: ["a", "b"], mode: "distribute", axis: "x" });
		assert.equal(payloadOf(r)["degraded"], "distribute_below_three_nodes");
	});
	// ⛔ 2026-10-23 契约消歧：旧行为「缺 align_mode → 命令不带 alignMode 键」= 静默发残缺命令
	//   ⇒ 前端对缺参命令 no-op ⇒ 用户看到「点了没反应」且无从得知原因。现在必须报错。
	it("⛔ mode=align 缺 align_mode → 抛错（不再发残缺命令）", async () => {
		const { tool } = setup();
		await assert.rejects(
			() => run(tool!, { node_ids: ["a", "b", "c"], mode: "align" }),
			/mode=align 必须带 align_mode/,
		);
	});
	it("⛔ mode=align 的 align_mode 非法值 → 抛错（列允许值）", async () => {
		const { tool } = setup();
		await assert.rejects(
			() => run(tool!, { node_ids: ["a", "b", "c"], mode: "align", align_mode: "leftish" }),
			/left \| centerH \| right \| top \| centerV \| bottom/,
		);
	});
	it("⛔ mode=distribute 缺 axis / 非法 axis → 抛错", async () => {
		const { tool } = setup();
		await assert.rejects(
			() => run(tool!, { node_ids: ["a", "b", "c"], mode: "distribute" }),
			/mode=distribute 必须带 axis/,
		);
		await assert.rejects(
			() => run(tool!, { node_ids: ["a", "b", "c"], mode: "distribute", axis: "horizontally" }),
			/mode=distribute 必须带 axis/,
		);
	});
});

// 2026-10-23 契约消歧：description 必须把四个 mode 按**两个语义层**讲清，
// 否则模型只有一条安全路径（用 grid 糊弄一切）——这正是用户「说了左对齐却拿到网格重排」的成因。
describe("arrange_nodes 契约描述（语义分层可发现性）", () => {
	it("description 含两层判据与四 mode 的选择依据", () => {
		const { tool } = setup();
		const d = tool!.description;
		assert.match(d, /重排层/, "应说明重排层");
		assert.match(d, /规整层/, "应说明规整层");
		assert.match(d, /mode=grid/, "应点名 grid");
		assert.match(d, /mode=along_edges/, "应点名 along_edges");
		assert.match(d, /mode=align/, "应点名 align");
		assert.match(d, /mode=distribute/, "应点名 distribute");
		assert.match(d, /重排结果本身已含对齐与等距/, "应说明重排与规整的关系（避免叠加无意义操作）");
	});
	it("description 声明参数非法会报错（模型据此自纠而非猜）", () => {
		const { tool } = setup();
		assert.match(tool!.description, /写错或缺参会直接报错/);
	});
});
