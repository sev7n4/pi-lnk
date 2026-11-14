import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeCanvasCounts, type CanvasSnapshot } from "./canvas-judge.js";

const snapshot = (nodeCount: number, typeCounts: Record<string, number> = {}): CanvasSnapshot => ({
	nodeCount,
	typeCounts,
});

test("C-2b 共享判据: nodeCount 上界被突破 ⇒ 证据差带实际值与上界", () => {
	const r = judgeCanvasCounts(snapshot(12, { image: 5, text: 7 }), { nodeCount: { max: 8 } });
	assert.equal(r.length, 1);
	assert.match(r[0], /12/);
	assert.match(r[0], /8/);
});

test("C-2b 共享判据: nodeCount 下界未达 ⇒ 证据差（写入未发生）", () => {
	const r = judgeCanvasCounts(snapshot(0), { nodeCount: { min: 1 } });
	assert.equal(r.length, 1);
	assert.match(r[0], /低于下限/);
});

test("C-2b 共享判据: nodeTypeCounts 混合上下界全满足 ⇒ 空数组", () => {
	assert.deepEqual(
		judgeCanvasCounts(snapshot(5, { image: 2, text: 3 }), {
			nodeTypeCounts: { image: { max: 3 }, text: { min: 2 } },
		}),
		[],
	);
});

test("C-2b 共享判据: 缺类型按 0 计 ⇒ 下限不满足", () => {
	const r = judgeCanvasCounts(snapshot(2, { text: 2 }), {
		nodeTypeCounts: { image: { min: 1 } },
	});
	assert.equal(r.length, 1);
	assert.match(r[0], /image 节点数 0/);
});

test("C-2b 共享判据: 空 expect ⇒ 恒通过（守卫层负责拦「至少一谓词」）", () => {
	assert.deepEqual(judgeCanvasCounts(snapshot(99, {}), {}), []);
});

test("C-2b 共享判据: 边界值含等号（min/max 都是闭区间）", () => {
	assert.deepEqual(judgeCanvasCounts(snapshot(3), { nodeCount: { min: 3, max: 3 } }), []);
	assert.equal(judgeCanvasCounts(snapshot(2), { nodeCount: { min: 3 } }).length, 1);
	assert.equal(judgeCanvasCounts(snapshot(4), { nodeCount: { max: 3 } }).length, 1);
});

test("C-2b 共享判据: 多个违例同时上报（证据差完整，不早退）", () => {
	const r = judgeCanvasCounts(snapshot(12, { image: 0 }), {
		nodeCount: { min: 20, max: 8 },
		nodeTypeCounts: { image: { min: 2 } },
	});
	assert.equal(r.length, 3);
});

test("C-2b 共享判据: 未知 type 键按原值计数（oracle 不重命名为 unknown）", () => {
	assert.deepEqual(
		judgeCanvasCounts(snapshot(2, { shot: 2 }), { nodeTypeCounts: {} }),
		[],
	);
	assert.equal(
		judgeCanvasCounts(snapshot(2, { shot: 2 }), {
			nodeTypeCounts: { image: { min: 1 } },
		}).length,
		1,
	);
});
