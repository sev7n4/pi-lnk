/**
 * 契约镜像测试（read-media.contract-mirror.test.ts 先例）：validate-canvas-layout.ts 的
 * validateCanvasLayoutLocal 与 packages/shared/src/canvas/layout.ts validateCanvasLayout 逐语义一致。
 * fixture 与 packages/shared/src/canvas/layout.test.ts 的「VISP Phase 2 §8」describe 完全同源；
 * 改任一侧实现必须同步另一侧与本文件。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCanvasLayoutLocal } from "./validate-canvas-layout.js";

const box = (id: string, x: number, y: number, width: number, height: number) => ({ id, x, y, width, height });

test("mirror §8-1 无节点 → []", () => {
	assert.deepEqual(validateCanvasLayoutLocal({ nodes: [], canvas: { width: 1920, height: 1080 } }), []);
});

test("mirror §8-2 两节点不重叠、在界内 → []", () => {
	assert.deepEqual(
		validateCanvasLayoutLocal({
			nodes: [box("a", 0, 0, 100, 100), box("b", 200, 0, 100, 100)],
			canvas: { width: 1920, height: 1080 },
		}),
		[],
	);
});

test("mirror §8-3 重叠 120×80 → OVERLAP + metric 含交集 + severity=high", () => {
	const out = validateCanvasLayoutLocal({ nodes: [box("a", 0, 0, 200, 100), box("b", 80, 20, 200, 100)] });
	assert.equal(out.length, 1);
	assert.equal(out[0]!.type, "OVERLAP");
	assert.deepEqual(out[0]!.nodeIds, ["a", "b"]);
	assert.ok(out[0]!.metric.includes("120") && out[0]!.metric.includes("80"));
	assert.equal(out[0]!.severity, "high");
});

test("mirror §8-4 右边界超画布 40px → OVERFLOW severity=medium；mirror §8-4b 无 canvas 不判", () => {
	const out = validateCanvasLayoutLocal({
		nodes: [box("a", 0, 0, 100, 100), box("b", 1960, 500, 100, 100)],
		canvas: { width: 1920, height: 1080 },
	});
	const overflows = out.filter((v) => v.type === "OVERFLOW");
	assert.equal(overflows.length, 1);
	assert.deepEqual(overflows[0]!.nodeIds, ["b"]);
	assert.ok(overflows[0]!.metric.includes("40"));
	assert.equal(overflows[0]!.severity, "medium");
	// 无边界不判 OVERFLOW（无限画布范式，R-V8 不编造）
	assert.deepEqual(validateCanvasLayoutLocal({ nodes: [box("a", 999999, 999999, 100, 100)] }), []);
});

test("mirror §8-5 minSpacing=20 间距 10 → MIN_SPACING severity=low", () => {
	const out = validateCanvasLayoutLocal({
		nodes: [box("a", 0, 0, 100, 100), box("b", 110, 0, 100, 100)],
		minSpacing: 20,
	});
	assert.equal(out.length, 1);
	assert.equal(out[0]!.type, "MIN_SPACING");
	assert.deepEqual(out[0]!.nodeIds, ["a", "b"]);
	assert.equal(out[0]!.severity, "low");
});

test("mirror §8-6 同输入重复 3 次逐字节相同", () => {
	const input = {
		nodes: [box("a", 0, 0, 200, 100), box("b", 80, 20, 200, 100), box("c", 5000, 5000, 300, 300)],
		canvas: { width: 1920, height: 1080 },
		minSpacing: 12,
	};
	const r1 = JSON.stringify(validateCanvasLayoutLocal(input));
	const r2 = JSON.stringify(validateCanvasLayoutLocal(input));
	const r3 = JSON.stringify(validateCanvasLayoutLocal(input));
	assert.equal(r1, r2);
	assert.equal(r2, r3);
});

test("mirror §8-7 相切面积 0 不计 OVERLAP；§8-8 重叠对跳过 MIN_SPACING 防双报", () => {
	assert.deepEqual(
		validateCanvasLayoutLocal({ nodes: [box("a", 0, 0, 100, 100), box("b", 100, 0, 100, 100)] }),
		[],
	);
	const out = validateCanvasLayoutLocal({
		nodes: [box("a", 0, 0, 200, 100), box("b", 80, 20, 200, 100)],
		minSpacing: 40,
	});
	assert.equal(out.filter((v) => v.type === "OVERLAP").length, 1);
	assert.equal(out.filter((v) => v.type === "MIN_SPACING").length, 0);
});

// ---- Phase 2b ④：focusNodeIds 子集（fixture 与 shared §12b-④ 同源）----

test("mirror §12b-④ focusNodeIds 只留涉及 focus 的违规；缺省/空数组全量", () => {
	const boxes = [
		box("a", 0, 0, 100, 100),
		box("b", 50, 0, 100, 100),
		box("c", 400, 0, 100, 100),
		box("d", 450, 0, 100, 100),
	];
	const focusA = validateCanvasLayoutLocal({ nodes: boxes, focusNodeIds: ["a"] });
	assert.equal(focusA.length, 1);
	assert.deepEqual(focusA[0]!.nodeIds, ["a", "b"]);
	const focusCD = validateCanvasLayoutLocal({ nodes: boxes, focusNodeIds: ["c", "d"] });
	assert.equal(focusCD.length, 1);
	assert.deepEqual(focusCD[0]!.nodeIds, ["c", "d"]);
	assert.equal(validateCanvasLayoutLocal({ nodes: boxes }).length, 2);
	assert.equal(validateCanvasLayoutLocal({ nodes: boxes, focusNodeIds: [] }).length, 2);
	assert.equal(validateCanvasLayoutLocal({ nodes: boxes, focusNodeIds: ["ghost"] }).length, 0);
});

test("mirror §12b-④ focusNodeIds 过滤 OVERFLOW 且不破坏确定性", () => {
	const input = {
		nodes: [box("a", 0, 0, 100, 100), box("b", 50, 0, 100, 100), box("e", 1960, 0, 100, 100)],
		canvas: { width: 1920, height: 1080 },
		focusNodeIds: ["e"],
	};
	const out = validateCanvasLayoutLocal(input);
	assert.equal(out.length, 1);
	assert.equal(out[0]!.type, "OVERFLOW");
	assert.deepEqual(out[0]!.nodeIds, ["e"]);
	const r1 = JSON.stringify(validateCanvasLayoutLocal(input));
	const r2 = JSON.stringify(validateCanvasLayoutLocal(input));
	assert.equal(r1, r2);
});
