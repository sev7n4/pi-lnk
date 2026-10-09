import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { graphIRFromGv } from "./graph-ir.js";
import { ACCENT_MAX_RATIO, severityOf, visualRoles } from "./visual-role.js";

/**
 * mark 通道 + 视觉角色。
 *
 * ⭐ 本文件的存在前提：`GraphIRNode.mark` **有真实输入**（`overlay.kind=severity`
 * 经 `graphIRFromGv({ marks })` 写入）。通道没接通时 `visualRoles` 恒返回
 * `muted`，写它就是死代码 —— 所以第一条测的是通道本身。
 */

function irWith(
	marks: Record<string, { kind: string; level: number; text?: string }>,
	n = 10,
) {
	return graphIRFromGv({
		view: "layout",
		relation: "dependency",
		nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, title: `节点 ${i}`, type: "a" })),
		edges: [],
		marks,
	});
}

test("阈值本身：ACCENT_MAX_RATIO = 0.1（业界共识，不是计划的 20%）", () => {
	assert.equal(ACCENT_MAX_RATIO, 0.1);
});

test("通道：marks 写进 IR 节点的 mark，没有条目的节点没有 mark", () => {
	const ir = irWith({ n3: { kind: "severity", level: 2 } });
	assert.deepEqual(ir.nodes[3].mark, { kind: "severity", level: 2 });
	assert.equal(ir.nodes[0].mark, undefined);
});

test("R5：全部节点都带 mark 时，强调色仍 ≤ 总数 10%", () => {
	const ir = irWith(
		Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`n${i}`, { kind: "severity", level: i }])),
		10,
	);
	const roles = visualRoles(ir);
	const accent = [...roles.values()].filter((r) => r === "accent").length;
	// ⭐ 字面量：ceil(10 * 0.1) = 1
	assert.equal(accent, 1);
	// 最高的那个被选中
	assert.equal(roles.get("n9"), "accent");
});

test("26 节点全标 ⇒ 只强调 3 个（ceil(26*0.1)）", () => {
	const ir = irWith(
		Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`n${i}`, { kind: "severity", level: 1 }])),
		26,
	);
	const accent = [...visualRoles(ir).values()].filter((r) => r === "accent").length;
	assert.equal(accent, 3);
});

test("mark 缺失 ⇒ 回落点缀色 primary，不是 accent（无标注就没有重点可言）", () => {
	const ir = irWith({});
	assert.equal(visualRoles(ir).get("n0"), "primary");
	assert.equal([...visualRoles(ir).values()].filter((r) => r === "accent").length, 0);
});

test("既无 mark 又无 type ⇒ muted（最弱一级）", () => {
	const ir = graphIRFromGv({
		view: "layout",
		relation: "category",
		nodes: [{ id: "n0", title: "无类型" }],
		edges: [],
	});
	assert.equal(visualRoles(ir).get("n0"), "muted");
});

test("level = 0 不算标注（有 mark 但不该被强调）", () => {
	const ir = irWith({ n0: { kind: "severity", level: 0 } });
	assert.equal(visualRoles(ir).get("n0"), "primary");
	assert.equal([...visualRoles(ir).values()].filter((r) => r === "accent").length, 0);
});

test("按 level 降序取，不是按 id 或输入顺序", () => {
	const ir = irWith(
		{ n0: { kind: "severity", level: 1 }, n5: { kind: "severity", level: 9 }, n7: { kind: "severity", level: 5 } },
		10,
	);
	const roles = visualRoles(ir);
	assert.equal(roles.get("n5"), "accent");
	assert.equal(roles.get("n7"), "primary");
	assert.equal(roles.get("n0"), "primary");
});

test("只有 1 个节点带 mark ⇒ 它就是唯一被强调的（cap 至少 1）", () => {
	const ir = irWith({ n2: { kind: "severity", level: 1 } }, 26);
	const roles = visualRoles(ir);
	assert.equal(roles.get("n2"), "accent");
	assert.equal([...roles.values()].filter((r) => r === "accent").length, 1);
});

test("R1：空图不抛错，返回空 Map", () => {
	const ir = graphIRFromGv({ view: "layout", relation: "category", nodes: [], edges: [] });
	assert.equal(visualRoles(ir).size, 0);
});

test("角色覆盖每个节点（不多不少）", () => {
	const ir = irWith({ n1: { kind: "severity", level: 3 } }, 7);
	const roles = visualRoles(ir);
	assert.equal(roles.size, 7);
	assert.deepEqual([...roles.keys()].sort(), ir.nodes.map((n) => n.id).sort());
});

/**
 * `severityOf` 的**第二道防线**单元断言。
 *
 * ⭐ 为什么必须有这条独立用例（不能只靠集成断言）：
 *   `render-canvas-view.ts` 入口已过滤 `if (level !== "error" && level !== "warn") return;`
 *   ⇒ 集成路径上 `critical` 根本进不到 `severityOf`，集成断言**永远绿**（假绿）。
 *   `severityOf` 的白名单是防御性第二层 —— 只有直接构造 IR 才能证伪它。
 *   （变异验证时正是靠这条才抓得住：把白名单换成 `as` 强转时集成断言全绿、
 *    只有这条转红。若没有它，那次变异就是「看起来测过了其实没测」。）
 */
describe("severityOf：只有 error / warn 有对应视觉语言", () => {
	const rolesOf = (ir: ReturnType<typeof irWith>) => visualRoles(ir);

	test("error / warn 正常返回", () => {
		// ⛔ 必须用 n=3（cap=ceil(3*0.1)=1）逐个测，不能一次标两个：
		//   10 节点时 cap=1，两个 mark 只有一个能进前 10%，另一个必然 primary
		//   —— 我第一版就踩了这个坑，把「上限」当成「两个都能强调」写了进去。
		const e = irWith({ n0: { kind: "severity", level: 2, text: "error" } }, 3);
		assert.equal(severityOf(e, rolesOf(e), "n0"), "error");
		const w = irWith({ n0: { kind: "severity", level: 1, text: "warn" } }, 3);
		assert.equal(severityOf(w, rolesOf(w), "n0"), "warn");
	});

	test("⭐ 同批两个标记，只有高 level 进前 10%（上限真的会筛掉人）", () => {
		const ir = irWith({
			n0: { kind: "severity", level: 2, text: "error" },
			n1: { kind: "severity", level: 1, text: "warn" },
		});
		const r = rolesOf(ir);
		assert.equal(r.get("n0"), "accent");
		assert.equal(r.get("n1"), "primary");
		assert.equal(severityOf(ir, r, "n0"), "error");
		assert.equal(severityOf(ir, r, "n1"), undefined, "warn 越过了 10% 上限");
	});

	test("⛔ 未知级别（critical / info / 高风险）⇒ undefined，不 `as` 强转成 error", () => {
		for (const t of ["critical", "info", "高风险", "", "ERROR"]) {
			const ir = irWith({ n0: { kind: "severity", level: 5, text: t } });
			assert.equal(severityOf(ir, rolesOf(ir), "n0"), undefined, `text=${t} 被渲染成了级别色`);
		}
	});

	test("⛔ 无 mark 的节点 ⇒ undefined（不靠 mark 缺失猜级别）", () => {
		const ir = irWith({ n0: { kind: "severity", level: 2, text: "error" } });
		assert.equal(severityOf(ir, rolesOf(ir), "n5"), undefined);
	});

	test("⛔ 被 10% 上限挤掉的节点 ⇒ undefined（只被标不算被强调）", () => {
		// ⚠️ 判据必须让「更高级别的节点占掉唯一名额」：10 节点 ⇒ cap=1。
		//   若只标 n9 一个，它就是第一名（必然 accent），测不到「被挤掉」。
		const ir = irWith({
			n0: { kind: "severity", level: 2, text: "error" },
			n9: { kind: "severity", level: 1, text: "warn" },
		});
		const r = rolesOf(ir);
		assert.equal(r.get("n0"), "accent");
		assert.equal(r.get("n9"), "primary", "n9 应被上限挤掉");
		assert.equal(severityOf(ir, r, "n9"), undefined, "被挤掉的节点仍被画上了级别色");
	});

	test("text 缺失（只有 level）⇒ undefined，不猜级别", () => {
		const ir = irWith({ n0: { kind: "severity", level: 2 } });
		assert.equal(severityOf(ir, rolesOf(ir), "n0"), undefined);
	});
});
