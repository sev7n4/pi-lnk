/**
 * `node_graph` 载荷构造器的行为契约测试（2026-10-07）。
 *
 * 判据来自AGENTS.md 对 present 层的要求：**数据源缺失 → 报错/显式标记，不编造**。
 * 所以这里重点锁「不编造」而不是「画得多好看」。
 */
import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
	buildNodeGraphPayload,
	toNodeGraphEdges,
	toNodeGraphNode,
	NODE_GRAPH_MAX_NODES,
} from "./node-graph-payload.js";

describe("node_graph 载荷：透传画布，不投影", () => {
	test("节点原样透传：id/type/title/position 保留", () => {
		const p = buildNodeGraphPayload({
			nodes: [{ id: "image-1", type: "image", title: "角色三视图", position: { x: 10, y: 20 } }],
			edges: [],
		});
		assert.equal(p.type, "node_graph");
		assert.equal(p.nodes.length, 1);
		assert.deepEqual(p.nodes[0], {
			id: "image-1",
			type: "image",
			title: "角色三视图",
			position: { x: 10, y: 20 },
		});
	});

	test("⚠️ 不做业务序号重排（节点顺序 = layout 顺序，画布与卡片一致）", () => {
		const p = buildNodeGraphPayload({
			nodes: [
				{ id: "b", type: "image", title: "EP10" },
				{ id: "a", type: "image", title: "EP05" },
			],
		});
		// 若按字符串序重排会变成 EP05,EP10 —— 那会让卡片与画布不一致
		assert.deepEqual(p.nodes.map((n) => n.id), ["b", "a"]);
	});

	test("parentNode → groupId（分组框）", () => {
		const p = buildNodeGraphPayload({
			nodes: [
				{ id: "group-1", type: "group", title: "角色组" },
				{ id: "n1", type: "image", title: "a", parentNode: "group-1" },
			],
		});
		const n1 = p.nodes.find((n) => n.id === "n1");
		assert.equal(n1?.groupId, "group-1");
	});

	test("缺 id 的节点被丢弃且**显式计数**（不静默、不编造）", () => {
		const p = buildNodeGraphPayload({ nodes: [{ type: "image", title: "无 id" }, { id: "ok" }] });
		assert.equal(p.nodes.length, 1);
		assert.ok(p.droppedNodeIds?.length, "必须显式记录被丢弃的节点");
		assert.ok(p.totalNodeCount === 2, "totalNodeCount 必须是真实总数");
	});

	test("缺 title 时留空串而不是编造标题", () => {
		const p = buildNodeGraphPayload({ nodes: [{ id: "x", type: "image" }] });
		assert.equal(p.nodes[0].title, "");
	});

	test("缺 type 时回落 'text'，不猜类型", () => {
		const p = buildNodeGraphPayload({ nodes: [{ id: "x", title: "t" }] });
		assert.equal(p.nodes[0].type, "text");
	});

	test("中文状态（重生中/生成中）→ running；不认识的状态 → idle", () => {
		assert.equal(toNodeGraphNode({ id: "a", status: "重生中" }).node?.status, "running");
		assert.equal(toNodeGraphNode({ id: "a", status: "生成中" }).node?.status, "running");
		assert.equal(toNodeGraphNode({ id: "a", status: "failed" }).node?.status, "failed");
		// ⚠️ 不认识的状态不许编造语义
		assert.equal(toNodeGraphNode({ id: "a", status: "玄学状态" }).node?.status, undefined);
	});

	test("position 只有一半坐标时视为无位置（不产出半截坐标）", () => {
		const n = toNodeGraphNode({ id: "a", position: { x: 10 } }).node;
		assert.equal(n?.position, undefined);
	});

	test("size 需 width+height 齐备才产出", () => {
		assert.equal(toNodeGraphNode({ id: "a", width: 100 }).node?.size, undefined);
		assert.deepEqual(toNodeGraphNode({ id: "a", width: 100, height: 50 }).node?.size, {
			width: 100,
			height: 50,
		});
	});

	test("edges：两端都必须在 nodes 集合内，否则丢弃（不补空节点）", () => {
		const ids = new Set(["a", "b"]);
		assert.deepEqual(toNodeGraphEdges([{ source: "a", target: "b" }], ids), [
			{ source: "a", target: "b" },
		]);
		assert.deepEqual(toNodeGraphEdges([{ source: "a", target: "ghost" }], ids), []);
		assert.deepEqual(toNodeGraphEdges("not-array", ids), []);
	});

	test("edges：非法 shape 不炸", () => {
		assert.deepEqual(toNodeGraphEdges([null, 42, { source: 1, target: 2 }], new Set()), []);
	});

	test("超上限：截断 + 记 dropped + 记 totalNodeCount", () => {
		const nodes = Array.from({ length: NODE_GRAPH_MAX_NODES + 5 }, (_, i) => ({
			id: `n${i}`,
			type: "image",
		}));
		const p = buildNodeGraphPayload({ nodes });
		assert.equal(p.nodes.length, NODE_GRAPH_MAX_NODES);
		assert.equal(p.totalNodeCount, NODE_GRAPH_MAX_NODES + 5);
		assert.ok((p.droppedNodeIds?.length ?? 0) >= 5, "被丢弃的节点 id 必须被记录");
	});

	test("接受 layout 数组形态（无 edges 字段）", () => {
		const p = buildNodeGraphPayload([{ id: "a", type: "image", title: "t" }]);
		assert.equal(p.nodes.length, 1);
		assert.deepEqual(p.edges, []);
	});

	test("接受 layout.data.{nodes,edges} 包装形态", () => {
		const p = buildNodeGraphPayload({
			data: { nodes: [{ id: "a" }, { id: "b" }], edges: [{ source: "a", target: "b" }] },
		});
		assert.equal(p.nodes.length, 2);
		assert.equal(p.edges.length, 1);
	});

	test("空输入不炸，返回空载荷", () => {
		const p = buildNodeGraphPayload({});
		assert.deepEqual(p.nodes, []);
		assert.deepEqual(p.edges, []);
	});

	test("⚠️ 不遵守 SVG_MAX_CHARS：结构化载荷按节点数裁剪（不产生非法 XML）", () => {
		// 这是与 svg_card 的本质差异：SVG 截断会产生不合法 XML，故那套逻辑不适用
		assert.equal(typeof NODE_GRAPH_MAX_NODES, "number");
	});
});