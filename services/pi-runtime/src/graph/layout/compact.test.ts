import { strict as assert } from "node:assert";
import { test } from "node:test";
import { graphIRFromGv } from "../graph-ir.js";
import { layoutLayout } from "./layout.js";
import { layoutSwimlane } from "./swimlane.js";
import { layoutTimelineFlow } from "./timeline.js";
import { layoutTree } from "./tree.js";
import { W, bboxArea, hasOverlap, nodeAreaSum, overlapArea, whitespaceRatio } from "./types.js";

/**
 * D3-1 布局紧凑化 —— **本任务的落地结论是「不紧凑化」**，所以目录里没有 `compact.ts`。
 *
 * 计划 Task 7 Step 1 的原文：先量基线，**若 R0 < 0.3 就把本任务降级为只补断言，
 * 不要为了改而改**。实测（26 节点，见下方各条）结果：
 *
 * | 视图     | 画布      | 包围盒   | 节点框    | 空白率 | 画布填充 | 重叠 |
 * |----------|-----------|----------|-----------|--------|----------|------|
 * | layout   | 720×740   | 554×676  | 554×26    | 0.000  | 0.703    | 0    |
 * | timeline | 720×750   | 554×670  | 554×20    | 0.224   | 0.533    | 0    |
 * | tree     | 720×740   | 202×670  | 150×20    | 0.424   | 0.146    | 0    |
 * | swimlane | 720×172   | 616×66   | 112×20    | −0.433  | 0.470    | 25 对 |
 *
 * ⇒ **layout（本任务的目标视图）行连续、整宽，包围盒内没有任何可压缩的空白**
 * （空白率恒为 0）。去「紧凑」它只能靠砍行高或砍框宽，那会直接损害 D3-2 的文字预算
 * （框宽变小 ⇒ `labelBudgetFor` 预算变小 ⇒ 标签更短）⇒ 与 D3 的目的一次性冲突。
 *
 * ⭐ 真正的发现是两个**在 layout 之外**的事实，已各用一条断言钉住：
 *   ① swimlane 同泳道同阶段的节点**完全重叠**（26 节点只露出 10 个位置，16 个被盖住）；
 *   ② tree 的画布填充率只有 0.146（节点框 150px，画布 720px，右侧 51% 全空）。
 *   这两条都不属于「压缩空白」，而是**重叠**与**宽度未利用**，改它们会动字节 ⇒ 不在本任务做。
 */

/** 26 个节点：5 个阶段 / 2 种 type / 2 种 status，父节点形成 3 层。 */
function manyNodes() {
	return Array.from({ length: 26 }, (_, i) => ({
		id: `n${i}`,
		title: `节点 ${i}`,
		type: i % 3 === 0 ? "a" : "b",
		status: i % 2 === 0 ? "done" : "todo",
		...(i > 0 ? { parentNode: i < 6 ? "n0" : `n${Math.floor((i - 6) / 5)}` } : {}),
	}));
}
const MANY_EDGES = manyNodes()
	.slice(1)
	.map((n) => ({ source: "n0", target: n.id }));

function layoutOf() {
	return layoutLayout(
		graphIRFromGv({ view: "layout", relation: "dependency", nodes: manyNodes(), edges: MANY_EDGES }),
	);
}

test("D3-1 基线：layout 26 节点的包围盒内**没有**空白（行连续且整宽）", () => {
	const l = layoutOf();
	assert.equal(l.nodes.length, 26);
	// 几何量用字面量断言，不用被测模块导出的常量自证
	assert.equal(bboxArea(l), 554 * 676);
	assert.equal(nodeAreaSum(l), 26 * 554 * 26);
	assert.equal(whitespaceRatio(l), 0);
	assert.equal(hasOverlap(l), false);
});

test("D3-1 基线：layout 的画布填充率 ≥ 0.70（余下的是左侧标签带与上下留白，不是浪费）", () => {
	const l = layoutOf();
	const fill = nodeAreaSum(l) / (l.width * l.height);
	assert.ok(fill >= 0.7, `画布填充率 ${fill.toFixed(3)} 低于 0.70`);
	assert.equal(l.width, 720);
	assert.equal(l.height, 740);
});

test("R1：0 / 1 节点时空白率与重叠量都是 0，不出现 NaN", () => {
	for (const n of [0, 1]) {
		const l = layoutLayout(
			graphIRFromGv({
				view: "layout",
				relation: "dependency",
				nodes: manyNodes().slice(0, n),
				edges: [],
			}),
		);
		assert.equal(l.nodes.length, n);
		assert.equal(Number.isNaN(l.width), false);
		assert.equal(Number.isNaN(l.height), false);
		assert.equal(whitespaceRatio(l), 0);
		assert.equal(hasOverlap(l), false);
	}
});

test("基线：timeline / tree 无重叠，空白率可判读（钉住实测值，改动需说明理由）", () => {
	const tl = layoutTimelineFlow(
		graphIRFromGv({ view: "timeline", relation: "category", nodes: manyNodes(), edges: MANY_EDGES }),
	);
	assert.equal(tl.nodes.length, 26);
	assert.equal(hasOverlap(tl), false);
	// 行高 26 而节点框 20 ⇒ 每行 6px 间隙
	assert.equal(nodeAreaSum(tl), 26 * 554 * 20);
	assert.ok(Math.abs(whitespaceRatio(tl) - 0.224) < 0.005, `timeline 空白率 ${whitespaceRatio(tl)}`);

	const tr = layoutTree(
		graphIRFromGv({ view: "tree", relation: "category", nodes: manyNodes(), edges: MANY_EDGES }),
	);
	assert.equal(tr.nodes.length, 26);
	assert.equal(hasOverlap(tr), false);
	assert.equal(nodeAreaSum(tr), 26 * 150 * 20);
	assert.ok(Math.abs(whitespaceRatio(tr) - 0.424) < 0.005, `tree 空白率 ${whitespaceRatio(tr)}`);
	// ⭐ tree 的画布填充率只有 0.146：节点框 150px，画布 720px ⇒ 右侧 51% 全空。
	//    这不是「可压缩的空白」（缩进是层级信号），而是**宽度未利用** ⇒ 属于另一类问题。
	const fill = nodeAreaSum(tr) / (tr.width * tr.height);
	assert.ok(fill < 0.2, `tree 画布填充率 ${fill.toFixed(3)}，若已改善请更新本条与注释`);
});

test("⚠️ 已知缺陷基线：swimlane 同泳道同阶段的节点**完全重叠**（26 节点只露出 10 个位置）", () => {
	const sl = layoutSwimlane(
		graphIRFromGv({
			view: "swimlane",
			relation: "category",
			nodes: manyNodes(),
			edges: MANY_EDGES,
			groupBy: "type",
		}),
	);
	assert.equal(sl.nodes.length, 26);
	// 2 条泳道 × 5 个阶段 = 10 个格子，26 个节点 ⇒ 16 个被完全盖住
	const spots = new Set(sl.nodes.map((n) => `${Math.round(n.x)},${Math.round(n.y)}`));
	assert.equal(spots.size, 10);
	assert.equal(hasOverlap(sl), true);
	// 重叠量占节点面积的 96%
	assert.ok(
		overlapArea(sl) / nodeAreaSum(sl) > 0.9,
		`重叠占比 ${(overlapArea(sl) / nodeAreaSum(sl)).toFixed(3)}`,
	);
	// ⭐ 负的空白率**不能**被读成「非常紧凑」—— 它只说明这个指标在此视图不适用
	assert.ok(whitespaceRatio(sl) < 0, `swimlane 空白率 ${whitespaceRatio(sl)} 应为负（= 重叠）`);
	// 修掉重叠时必须同时改这一条，并重生成黄金快照
	assert.ok(sl.width <= W);
});
