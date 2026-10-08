import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { GraphIREdge, GraphIR } from "./graph-ir.js";
import { edgeDirected } from "./edge-direction.js";

/**
 * C1：方向语义的**唯一**判定处。
 *
 * ⭐ 这些用例的价值全在「变异能让它们转红」：
 *   - `edgeDirected` 恒返回 true ⇒ 「category 无向」转红；
 *   - 恒返回 false ⇒ 「dependency 有向」转红。
 *   只断言「有向为true」的话，恒 false 的实现也能过 —— 那样这条判据就没钉住任何东西。
 */

function irWith(rel: GraphIR["relation"], edges: readonly GraphIREdge[] = []): GraphIR {
	return {
		view: "layout",
		relation: rel,
		nodes: [{ id: "a", label: "a", sourceKind: "canvas" }],
		edges: [...edges],
	};
}

test("C1：dependency 的边有向、category 的边无向（规格 §4.2(2)）", () => {
	const dep = irWith("dependency", [{ source: "a", target: "b", kind: "dependency" }]);
	const cat = irWith("category", [{ source: "a", target: "b", kind: "category" }]);
	assert.equal(edgeDirected(dep, dep.edges[0]), true);
	assert.equal(edgeDirected(cat, cat.edges[0]), false);
});

test("C1：kind 优先于 relation —— relation=category 但 kind=dependency 时仍有箭头", () => {
	// ⭐ 这条是防「又退回看 relation」的护栏。规格写的是「方向由 view + relation 决定」，
	//   但真正决定方向的是**这条边是什么关系**：IR 允许一条 category 图里出现
	//   dependency 边（例如混合来源）。若只看 relation，会把这条边的方向抹掉。
	const ir = irWith("category", [{ source: "a", target: "b", kind: "dependency" }]);
	assert.equal(edgeDirected(ir, ir.edges[0]), true);
});

test("C1：sequence / flow / containment 有向，category 无向", () => {
	const kinds: Array<GraphIREdge["kind"]> = ["sequence", "flow", "containment", "dependency"];
	for (const kind of kinds) {
		const ir = irWith("dependency", [{ source: "a", target: "b", kind }]);
		assert.equal(edgeDirected(ir, ir.edges[0]), true, `${kind} 应有向`);
	}
	const cat = irWith("category", [{ source: "a", target: "b", kind: "category" }]);
	assert.equal(edgeDirected(cat, cat.edges[0]), false);
});

test("C1：只有 category 无向；flow 在任何图里都有向", () => {
	// ⭐ 这条钉住「判定只看 kind」：若实现改成「先看 relation 再看 kind」，
	//   `relation=category` + `kind=flow` 这条就会转红 —— 那是把 IR 的关系语义
	//   降级成图级开关，一图多关系时就废了。
	const ir = irWith("category", [{ source: "a", target: "b", kind: "flow" }]);
	assert.equal(edgeDirected(ir, ir.edges[0]), true);
});