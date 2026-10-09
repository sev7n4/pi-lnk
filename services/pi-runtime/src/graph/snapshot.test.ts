import { strict as assert } from "node:assert";
import { test } from "node:test";
import { captureGolden, diffGolden, loadGolden, saveGolden, svgOfCase, BASE3 } from "./snapshot.js";

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

/**
 * ⭐ D3-3 引入的**常驻**分层回归（比重生快照本身更重要）。
 *
 * 为什么逐字节快照不够：重生时它只说「变了」，不说「变了什么」。
 * D3-3 是**有意改像素**的，所以必须有一道判据证明「视觉可以变、坐标不许变」——
 * 否则「改配色顺手挪了节点」会被快照重生静默盖掉（而快照正是用来发现这个的）。
 *
 * ⛔ 本测试在快照**已重生**之后仍然有意义：它锁住的是「几何 = 布局层算出的坐标」，
 *   与快照里的视觉值无关。任何人日后动 `layout/*` 的坐标，本测试立刻转红。
 */
test("分层回归：原有元素的几何/文本必须全保留（允许纯新增）", async () => {
	const golden = loadGolden();
	const fresh = await captureGolden(golden.commit);
	const diffs = diffGolden(golden, fresh);
	const broken = diffs.filter((d) => !d.geometricIntact);
	for (const d of diffs) {
		if (!d.identical) console.log(`  ~ ${d.name}: ${d.detail}`);
	}
	assert.deepEqual(
		broken.map((d) => `${d.name} —— ${d.detail}`),
		[],
		"以下用例的原有元素被删或被改（视觉可改、坐标不可改）",
	);
});
