import { strict as assert } from "node:assert";
import { test } from "node:test";
import { captureGolden, loadGolden, svgOfCase, BASE3 } from "./snapshot.js";

test("黄金快照：8 个用例的 SVG 逐字节不变", async () => {
	const golden = loadGolden();
	const fresh = await captureGolden(golden.commit);
	assert.equal(fresh.cases.length, golden.cases.length);
	for (let i = 0; i < golden.cases.length; i++) {
		assert.equal(fresh.cases[i].svg, golden.cases[i].svg, `用例 ${golden.cases[i].name} 的 SVG 变了`);
	}
});

test("R4：view=table + overlay 走行级渲染器，迁移后仍渲染且 overlay 真的生效", async () => {
	// 生产数据显示 table 用了 40 次（docs/ops/graph-observation-baseline-2026-10-08.md），
	// 它走行级渲染器、**不进 IR 坐标路径** ⇒ 后续四个视图的迁移不得把它带坏。
	const withOverlay = await svgOfCase(
		{ view: "table", overlay: { kind: "severity", data: [{ node_id: "n1", level: "error" }] } },
		BASE3,
	);
	const plain = await svgOfCase({ view: "table" }, BASE3);
	assert.match(withOverlay, /^<svg/);
	assert.ok(withOverlay.length > 200);
	// overlay 被静默忽略的话，两者会逐字节相同。
	assert.notEqual(withOverlay, plain, "severity overlay 被静默忽略了");
});
