import { strict as assert } from "node:assert";
import { test } from "node:test";
import { graphIRFromGv } from "../graph-ir.js";
import { layoutMatrix } from "./matrix.js";

/** 6 节点 2×2：type × status，两个维度各 2 个取值（与 golden `matrix-type-status` 同形）。 */
const MIXED6 = [
	{ id: "m1", type: "a", status: "todo", title: "甲" },
	{ id: "m2", type: "a", status: "done", title: "乙" },
	{ id: "m3", type: "b", status: "todo", title: "丙" },
	{ id: "m4", type: "b", status: "done", title: "丁" },
	{ id: "m5", type: "c", status: "todo", title: "戊" },
	{ id: "m6", type: "c", status: "done", title: "己" },
];

const mk = (nodes: typeof MIXED6) =>
	layoutMatrix(
		graphIRFromGv({ view: "matrix", relation: "category", nodes, edges: [], groupBy: "type" }),
		"type",
		"status",
	);

test("矩阵是完整的笛卡尔积：行 × 列 每个交叉都有格子（含 0）", () => {
	const l = mk(MIXED6);
	assert.deepEqual(l.matrix.rows, ["a", "b", "c"]);
	assert.deepEqual(l.matrix.cols, ["todo", "done"]);
	// ⭐ 3×2 = 6 个格子，一个都不能少 —— 空交叉本身是信息
	assert.equal(l.matrix.cells.length, 6);
	assert.equal(l.matrix.cells.filter((c) => c.count === 0).length, 0);
});

test("交叉计数正确", () => {
	const l = mk(MIXED6);
	const at = (r: string, c: string) => l.matrix.cells.find((x) => x.row === r && x.col === c)!.count;
	assert.equal(at("a", "todo"), 1);
	assert.equal(at("a", "done"), 1);
	assert.equal(at("b", "todo"), 1);
	assert.equal(at("c", "done"), 1);
});

test("空交叉必须存在且 count=0（删掉它就丢了「这一类没有该状态的东西」）", () => {
	const l = layoutMatrix(
		graphIRFromGv({
			view: "matrix",
			relation: "category",
			nodes: [
				{ id: "x", type: "a", status: "todo" },
				{ id: "y", type: "b", status: "done" },
			],
			edges: [],
		}),
		"type",
		"status",
	);
	// a×done 与 b×todo 都应为 0，且**格子仍在**
	assert.equal(l.matrix.cells.length, 4);
	assert.equal(l.matrix.cells.find((x) => x.row === "a" && x.col === "done")!.count, 0);
	assert.equal(l.matrix.cells.find((x) => x.row === "b" && x.col === "todo")!.count, 0);
});

test("R1：零节点的矩阵高度有限（不得 NaN），行列皆空", () => {
	const l = layoutMatrix(
		graphIRFromGv({ view: "matrix", relation: "category", nodes: [], edges: [] }),
		"type",
		"status",
	);
	assert.equal(Number.isFinite(l.height), true);
	assert.equal(l.matrix.rows.length, 0);
	assert.equal(l.matrix.cols.length, 0);
	assert.equal(l.matrix.cells.length, 0);
});

test("R1：单节点矩阵坐标有限", () => {
	const l = layoutMatrix(
		graphIRFromGv({ view: "matrix", relation: "category", nodes: [{ id: "only", type: "a" }], edges: [] }),
		"type",
		"status",
	);
	assert.equal(Number.isFinite(l.height), true);
	assert.equal(Number.isFinite(l.matrix.cw), true);
	assert.equal(l.matrix.cw > 0, true);
});

test("维度缺失时用「未分类」占位（不静默丢节点）", () => {
	const l = layoutMatrix(
		graphIRFromGv({
			view: "matrix",
			relation: "category",
			nodes: [
				{ id: "x", type: "a" }, // 无 status
				{ id: "y", type: "a", status: "done" },
			],
			edges: [],
		}),
		"type",
		"status",
	);
	assert.deepEqual(l.matrix.cols, ["未分类", "done"]);
	// 两个节点都进了 a×未分类 ⇒ 计数 1，不是 0
	assert.equal(l.matrix.cells.find((x) => x.row === "a" && x.col === "未分类")!.count, 1);
});

test("行/列顺序按首次出现（**不排序** —— 迁移前就是 `nodesIn` 原序）", () => {
	const l = layoutMatrix(
		graphIRFromGv({
			view: "matrix",
			relation: "category",
			nodes: [
				{ id: "1", type: "zebra", status: "later" },
				{ id: "2", type: "apple", status: "now" },
				{ id: "3", type: "zebra", status: "now" },
			],
			edges: [],
		}),
		"type",
		"status",
	);
	// ⭐ matrix 是**交叉表**，行的含义是「用户自己建的分类」⇒ 排序会打乱分类逻辑。
	//   （与 tree/timeline 的「业务序优先」刻意不同，别顺手改成orderNodes。）
	assert.deepEqual(l.matrix.rows, ["zebra", "apple"]);
	assert.deepEqual(l.matrix.cols, ["later", "now"]);
});

test("列宽按列数均分并取整（1 列时铺满绘图区）", () => {
	const l1 = layoutMatrix(
		graphIRFromGv({ view: "matrix", relation: "category", nodes: [{ id: "x", type: "a" }], edges: [] }),
		"type",
		"status",
	);
	// ⭐ 用字面量断言：写 `Math.floor((720-150)/1)` 是拿公式自证
	assert.equal(l1.matrix.labelW, 150);
	assert.equal(l1.matrix.cw, 570);
	const l2 = mk(MIXED6);
	assert.equal(l2.matrix.cw, 285);
	assert.equal(l2.matrix.cw * 2, 570);
});

test("格子坐标：x = labelW +列序*列宽，y = 首行 y + 行序*行高", () => {
	const l = mk(MIXED6);
	const c = l.matrix.cells.find((x) => x.row === "b" && x.col === "done")!;
	assert.equal(c.x, 150 + 1 * 285);
	// ⭐ firstRowY 用**字面量**断言（44）：写 `l.matrix.firstRowY` 是拿被测对象自证
	assert.equal(l.matrix.firstRowY, 44);
	assert.equal(l.matrix.colLabelY, 30);
	assert.equal(c.y, 44 + 1 * 30);
	// 格子比行列间距小 4（内缩 2）
	assert.equal(c.w, 285 - 4);
	assert.equal(c.h, 30 - 4);
});

test("行高固定 30，高度公式 50 + 行数*30 + 30", () => {
	// ⭐ 字面量断言，别用导出的 ch 自证
	const l = mk(MIXED6);
	assert.equal(l.matrix.ch, 30);
	assert.equal(l.height, 50 + 3 * 30 + 30);
});

test("列数很多时列宽不小于 1（防 0 宽格子 = 不可见）", () => {
	const many = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, type: "a", status: `s${i}` }));
	const l = layoutMatrix(
		graphIRFromGv({ view: "matrix", relation: "category", nodes: many, edges: [] }),
		"type",
		"status",
	);
	// 40 列 ⇒ 列宽本应被压到 14；「至少 1px」这条下限保证格子不会被压成不可见
	assert.equal(l.matrix.cw >= 1, true);
	assert.equal(l.matrix.cells.length, 40);
});

test("图例位置由布局层给出（渲染层不再自己算 H-26）", () => {
	const l = mk(MIXED6);
	assert.equal(l.matrix.legendY, l.height - 26);
});