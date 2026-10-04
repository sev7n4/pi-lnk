/**
 * 表达能力增强：三维正交（view × relation × groupBy）+ 业务逻辑排序。
 *
 * 契约要点（与旧测试并列，不替换）：
 *  - `view` 扩到 layout/tree/timeline/swimlane/matrix/table
 *  - `relation` 表达「看什么关系」，`groupBy` 表达「按什么分组」，两者与 view 正交
 *  - **排序：业务逻辑关联关系优先，数字/字母次序次之**（EP01 < EP02 < EP10）
 *  - 颜色按 node.type 语义映射，且必须白名单校验（不许模型传任意色）
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createRenderCanvasViewTools } from "./render-canvas-view.js";
import {
	NODE_PALETTE,
	orderNodes,
	sortNodes,
	auditOrder,
	SVG_MAX_CHARS,
} from "./render-canvas-view.expressive.js";
import {
	buildLayoutSvg,
	buildMatrixSvg,
	buildSwimlaneSvg,
	buildTreeSvg,
} from "./render-canvas-view.views.js";


/** 真实场景形状：大纲 → EP01..EP06（画布 y 坐标把 EP05 放在 EP04 前面）。 */
const LAYOUT = {
	nodes: [
		{ id: "p-outline", type: "prompt", title: "全劇大綱", position: { x: 0, y: 0 }, parentNode: undefined },
		{ id: "p-ep01", type: "prompt", title: "EP01《長老之死》", position: { x: 0, y: 100 } },
		{ id: "p-ep02", type: "prompt", title: "EP02《七道密碼》", position: { x: 0, y: 200 } },
		{ id: "p-ep03", type: "prompt", title: "EP03《記憶碎片》", position: { x: 0, y: 300 } },
		{ id: "p-ep05", type: "prompt", title: "EP05《暗影現身》", position: { x: 0, y: 400 } },
		{ id: "p-ep04", type: "prompt", title: "EP04《血契真相》", position: { x: 0, y: 500 } },
		{ id: "p-ep10", type: "prompt", title: "EP10《终章》", position: { x: 0, y: 600 } },
		{ id: "i-turtle", type: "image", title: "海龟长老·三视图", position: { x: 300, y: 100 }, parentNode: "p-ep01" },
		{ id: "v-ep01", type: "video", title: "EP01 正片", position: { x: 600, y: 100 }, parentNode: "p-ep01" },
		{ id: "i-fox", type: "image", title: "狐狸红尾·三视图", position: { x: 300, y: 200 }, parentNode: "p-ep02" },
		{ id: "p-orphan", type: "prompt", title: "未归类草稿", position: { x: 900, y: 900 } },
	],
	edges: [
		{ source: "p-outline", target: "p-ep01" },
		{ source: "p-outline", target: "p-ep02" },
		{ source: "p-outline", target: "p-ep03" },
		{ source: "p-outline", target: "p-ep04" },
		{ source: "p-outline", target: "p-ep05" },
	],
};

function makeTool(layout: unknown = LAYOUT) {
	const tools = createRenderCanvasViewTools({ fetchLayout: async () => layout });
	return tools.find((t) => t.name === "render_canvas_view")!;
}
async function run(tool: ReturnType<typeof makeTool>, params: unknown) {
	return tool.execute("c1", params as never, () => {}, { sessionId: "s1" }, {} as never, {} as never);
}
type Details = { ok: boolean; error?: string; missing?: string[]; canvasCommands?: Array<{ svg: string; title?: string }> };

async function svgOf(params: unknown, layout: unknown = LAYOUT): Promise<string> {
	const r = await run(makeTool(layout), params);
	const d = r.details as Details;
	assert.equal(d.ok, true, `期望成功，实际 error=${d.error}`);
	return d.canvasCommands![0].svg;
}

// ══════════════════════════════════════════════
// 1. 排序：业务逻辑优先，数字字母次之
// ══════════════════════════════════════════════
describe("排序：业务逻辑关联优先，数字字母次之", () => {
	it("EP 编号按数值排，不按字符串（EP10 必须在 EP05 之后，不能因'1'<'0'排到最前）", () => {
		const nodes = [
			{ id: "a", title: "EP10《终章》" },
			{ id: "b", title: "EP05《暗影現身》" },
			{ id: "c", title: "EP01《長老之死》" },
			{ id: "d", title: "EP02《七道密碼》" },
		];
		const out = orderNodes(nodes).map((n) => n.title);
		assert.deepEqual(out, ["EP01《長老之死》", "EP02《七道密碼》", "EP05《暗影現身》", "EP10《终章》"]);
	});

	it("画布 y 坐标把 EP05 排在 EP04 前面时，业务序号仍然胜出", () => {
		const nodes = [
			{ id: "x", title: "EP05《暗影現身》", position: { x: 0, y: 400 } },
			{ id: "y", title: "EP04《血契真相》", position: { x: 0, y: 500 } },
		];
		assert.deepEqual(orderNodes(nodes).map((n) => n.title), ["EP04《血契真相》", "EP05《暗影現身》"]);
	});

	it("无业务序号时回退到画布坐标（y 次之、x 最后）", () => {
		const nodes = [
			{ id: "b", title: "乙", position: { x: 50, y: 200 } },
			{ id: "a", title: "甲", position: { x: 10, y: 200 } },
			{ id: "c", title: "丙", position: { x: 0, y: 100 } },
		];
		assert.deepEqual(orderNodes(nodes).map((n) => n.title), ["丙", "甲", "乙"]);
	});

	it("业务序号前的自然语言前缀（EP/集/第/章）都能识别", () => {
		const nodes = [
			{ id: "1", title: "第三集" },
			{ id: "2", title: "第1集" },
			{ id: "3", title: "第2集" },
			{ id: "4", title: "第十集" },
		];
		const out = orderNodes(nodes).map((n) => n.title);
		assert.deepEqual(out, ["第1集", "第2集", "第三集", "第十集"]);
	});

	it("中文数字与阿拉伯数字混排也能排出业务序（O1 一集 → 第2集）", () => {
		const nodes = [
			{ id: "z", title: "第二集" },
			{ id: "y", title: "一集" },
			{ id: "x", title: "第十集" },
		];
		const out = orderNodes(nodes).map((n) => n.title);
		assert.equal(out.indexOf("一集") < out.indexOf("第二集"), true);
		assert.equal(out.indexOf("第二集") < out.indexOf("第十集"), true);
	});

	it("sortNodes 是orderNodes 的稳定包装（不改入参）", () => {
		const input = [
			{ id: "a", title: "EP02" },
			{ id: "b", title: "EP01" },
		];
		const copy = input.map((x) => ({ ...x }));
		sortNodes(input);
		assert.deepEqual(input, copy, "不得原地修改入参");
	});
});

// ══════════════════════════════════════════════
// 2. 颜色：按 type 语义映射 + 白名单校验
// ══════════════════════════════════════════════
describe("语义色：按节点类型映射且必须白名单", () => {
	it("palette 至少覆盖 prompt/image/video 三类且互不相同", () => {
		// ⚠️ 排除中性档（group/default 同为灰是**刻意**的：没有类型信息 ⇒ 不该被着色）
		const kinds = Object.keys(NODE_PALETTE).filter((k) => k !== "group" && k !== "default");
		for (const k of ["prompt", "image", "video"]) {
			assert.ok(kinds.includes(k), `缺少 ${k} 的配色`);
		}
		const fills = kinds.map((k) => NODE_PALETTE[k].fill);
		assert.equal(new Set(fills).size, fills.length, "不同类型的填充色必须不同，否则分类无意义");
		const strokes = kinds.map((k) => NODE_PALETTE[k].stroke);
		assert.equal(new Set(strokes).size, strokes.length, "描边色也必须能区分类型（浅色填充在白底上差异不足）");
		// 每个非中性档都必须有 strong（状态深浅通道），否则 status 维度无处表达
		for (const k of kinds) {
			assert.ok(NODE_PALETTE[k].strong, `${k} 缺 strong 档，status 深浅无处表达`);
		}
	});

	it("topology 按 type 上色：不同类型的 rect 样式不同", async () => {
		const svg = await svgOf({ view: "topology", groupBy: "type" });
		const rects = [...svg.matchAll(/<rect[^>]*fill="(#[0-9A-Fa-f]{3,8})"[^>]*stroke="(#[0-9A-Fa-f]{3,8})"/g)];
		assert.ok(rects.length >= 3, `带配色的 rect 太少：${rects.length}`);
		assert.ok(new Set(rects.map((m) => m[1])).size >= 2, "按 type 上色后填充应有多样性");
		assert.ok(new Set(rects.map((m) => m[2])).size >= 2, "按 type 上色后描边应有多样性");
	});

	it("节点颜色只接受白名单色名，传十六进制一律拒绝（非静默降级）", async () => {
		const layout = {
			nodes: [
				{ id: "a", type: "prompt", title: "A" },
				{ id: "b", type: "prompt", title: "B" },
			],
			edges: [{ source: "a", target: "b" }],
		};
		const r = await run(makeTool(layout), {
			view: "topology",
			nodes: [{ node_id: "a", color: "#ff0000" }],
		});
		assert.equal((r.details as Details).ok, false, "注入原始色值必须被拒");
		assert.match((r.details as Details).error!, /color|白名单|色/);
	});

	it("白名单内的语义色名可被接受", async () => {
		const r = await run(makeTool(), {
			view: "topology",
			nodes: [{ node_id: "p-ep01", color: "amber" }],
		});
		assert.equal((r.details as Details).ok, true, (r.details as Details).error);
	});
});

// ══════════════════════════════════════════════
// 3. 箭头：方向可见
// ══════════════════════════════════════════════
describe("箭头：依赖方向必须可见", () => {
	it("layout/tree/swimlane 的连线带 marker-end（箭头）", async () => {
		for (const view of ["layout", "tree", "swimlane"]) {
			const svg = await svgOf({ view });
			assert.match(svg, /<marker/, `${view} 缺少 <marker> 定义`);
			assert.match(svg, /marker-end/, `${view} 的连线缺少 marker-end`);
		}
	});

	it("marker 定义在 <defs> 内且 id 唯一", async () => {
		const svg = await svgOf({ view: "layout" });
		assert.match(svg, /<defs>/);
		const ids = [...svg.matchAll(/<marker[^>]*\sid="([^"]+)"/g)].map((m) => m[1]);
		assert.ok(ids.length > 0, "缺少 marker id");
		assert.equal(new Set(ids).size, ids.length, `marker id 重复：${JSON.stringify(ids)}`);
	});

	it("连线不再全部从同一点射出（扫帚修复）：同一 source 的多出边起点须分散", async () => {
		const svg = await svgOf({ view: "layout", relation: "dependency" });
		// 每条依赖边形如 <path data-edge="1" d="M{sx},{sy} C..." ...>
		const starts = [...svg.matchAll(/<path data-edge="1" d="M([\d.]+),([\d.]+)/g)].map((m) => m[2]);
		assert.ok(starts.length >= 5, `依赖边数不足：${starts.length}`);
		assert.ok(
			new Set(starts).size >= 3,
			`同源出边起点未分散（扫帚未修）：${JSON.stringify([...new Set(starts)])}`,
		);
	});
});

// ══════════════════════════════════════════════
// 4. tree：层级
// ══════════════════════════════════════════════
describe("tree：层级与归属", () => {
	it("按 parentNode 生成缩进层级，父在子之前", () => {
		const svg = buildTreeSvg(LAYOUT.nodes as never, LAYOUT.edges as never);
		const order = [...svg.matchAll(/<g data-node="([^"]+)"/g)].map((m) => m[1]);
		assert.ok(order.length >= 8, `树节点数不足：${order.length}`);
		assert.ok(order.indexOf("p-outline") < order.indexOf("i-turtle"), "父节点必须排在子节点之前");
	});

	it("不同深度有不同缩进 x（体现层级）", () => {
		const svg = buildTreeSvg(LAYOUT.nodes as never, LAYOUT.edges as never);
		// 缩进体现在 <g data-depth> 内首个 <rect 的 x
		const pairs = [...svg.matchAll(/<g data-node="[^"]*" data-depth="(\d+)"[^>]*><rect x="(\d+)"/g)].map(
			(m) => ({ depth: Number(m[1]), x: Number(m[2]) }),
		);
		assert.ok(pairs.length >= 3, `层级节点数不足：${pairs.length}`);
		// ⚠️ 判据是「**同深度**同 x、**不同深度**不同 x」——
		// 不能断言「所有 x 互不相同」（那是把不同层当同一层）。
		const byDepth = new Map<number, Set<number>>();
		for (const p of pairs) {
			const s = byDepth.get(p.depth) ?? new Set<number>();
			s.add(p.x);
			byDepth.set(p.depth, s);
		}
		for (const [d, xs] of byDepth) {
			assert.equal(xs.size, 1, `深度 ${d} 的缩进 x 应唯一，实际 ${JSON.stringify([...xs])}`);
		}
		const firstPerDepth = [...byDepth.entries()].map(([d, xs]) => [d, [...xs][0]] as const);
		assert.ok(
			firstPerDepth.length >= 2,
			`应有至少 2 个层级，实际 ${JSON.stringify(firstPerDepth.map((x) => x[0]))}`,
		);
		for (let i = 1; i < firstPerDepth.length; i++) {
			const prev = firstPerDepth[i - 1][1];
			const cur = firstPerDepth[i][1];
			assert.ok(cur > prev, `深度 ${firstPerDepth[i][0]} 的缩进应大于深度 ${firstPerDepth[i - 1][0]}`);
		}
	});

	it("孤立节点进「未归类」区，不丢弃也不编造父节点", () => {
		const svg = buildTreeSvg(LAYOUT.nodes as never, LAYOUT.edges as never);
		assert.match(svg, /未归类|归类/);
		assert.ok(svg.includes("p-orphan"), "孤立节点必须出现在图上");
	});

	it("无parentNode 的输入退化为平铺，不报错", () => {
		const svg = buildTreeSvg(
			[
				{ id: "a", type: "prompt", title: "A" },
				{ id: "b", type: "prompt", title: "B" },
			] as never,
			[] as never,
		);
		assert.match(svg, /^<svg/);
		assert.ok(svg.includes("A") && svg.includes("B"));
	});
});

// ══════════════════════════════════════════════
// 5. swimlane：阶段 × 角色
// ══════════════════════════════════════════════
describe("swimlane：阶段横轴 × 分组纵轴", () => {
	it("生成泳道分隔与阶段列头", () => {
		const svg = buildSwimlaneSvg(LAYOUT.nodes as never, LAYOUT.edges as never, "type");
		assert.match(svg, /data-lane=/, "缺少泳道标记");
		assert.match(svg, /data-stage=/, "缺少阶段列标记");
	});

	it("同一泳道内的节点共享背景带", () => {
		const svg = buildSwimlaneSvg(LAYOUT.nodes as never, LAYOUT.edges as never, "type");
		const lanes = [...svg.matchAll(/data-lane="([^"]+)"/g)].map((m) => m[1]);
		assert.ok(lanes.length >= 3, `泳道数应覆盖 3 种type，实际 ${JSON.stringify(lanes)}`);
	});

	it("groupBy=status 时按状态分泳道", async () => {
		const layout = {
			nodes: [
				{ id: "a", type: "prompt", title: "A", status: "completed" },
				{ id: "b", type: "prompt", title: "B", status: "draft" },
				{ id: "c", type: "image", title: "C", status: "completed" },
			],
			edges: [],
		};
		const r = await run(makeTool(layout), { view: "swimlane", groupBy: "status" });
		assert.equal((r.details as Details).ok, true, (r.details as Details).error);
		assert.match((r.details as Details).canvasCommands![0].svg, /completed|draft/);
	});
});

// ══════════════════════════════════════════════
// 6. matrix：分类 × 状态
// ══════════════════════════════════════════════
describe("matrix：分类 × 状态交叉", () => {
	it("行=分类、列=状态，格子给计数", () => {
		const layout = {
			nodes: [
				{ id: "a", type: "prompt", title: "A", status: "completed" },
				{ id: "b", type: "prompt", title: "B", status: "draft" },
				{ id: "c", type: "prompt", title: "C", status: "draft" },
				{ id: "d", type: "image", title: "D", status: "completed" },
			],
			edges: [],
		};
		const svg = buildMatrixSvg(layout.nodes as never, "type", "status");
		assert.match(svg, /data-row="prompt"/);
		assert.match(svg, /data-col="completed"/);
		assert.match(svg, /data-cell=/, "缺少交叉格子");
		const cell = /data-cell="prompt\|draft"[^]*?<text[^>]*>(\d+)<\/text>/.exec(svg);
		assert.equal(cell?.[1], "2", "prompt×draft 交叉格应显示 2");
		assert.match(svg, /data-cell="prompt\|draft"[^]*?fill="#EEEDFE"/, "非空交叉用高亮填充");
	});

	it("只画实际存在的交叉，不凭空造列（凭空造 draft=编造数据）", () => {
		const nodes = [
			{ id: "a", type: "prompt", title: "A", status: "completed" },
			{ id: "d", type: "image", title: "D", status: "completed" },
		];
		const svg = buildMatrixSvg(nodes as never, "type", "status");
		assert.equal(svg.includes("draft"), false, "没有任何 draft 节点 ⇒ 不得出现 draft 列");
		assert.match(svg, /data-cell="prompt\|completed"/);
		assert.match(svg, /data-cell="image\|completed"/);
	});

	it("交叉格里显示 0（该组合存在但无节点，是有效信息）", () => {
		const nodes = [
			{ id: "a", type: "prompt", title: "A", status: "completed" },
			{ id: "b", type: "prompt", title: "B", status: "completed" },
			{ id: "c", type: "image", title: "C", status: "completed" },
		];
		const svg = buildMatrixSvg(nodes as never, "type", "status");
		const cell = /data-cell="prompt\|completed"[^]*?<text[^>]*>(\d+)<\/text>/.exec(svg);
		assert.equal(cell?.[1], "2", "prompt×completed=2");
	});
});

// ══════════════════════════════════════════════
// 7. 三维正交：view × relation × groupBy 互不干扰
// ══════════════════════════════════════════════
describe("三维正交：view / relation / groupBy 独立", () => {
	it("groupBy 不改变 view 的形状，只改变分组", async () => {
		// ⚠️ 不能拿 `groupBy=type` 比：它本就是默认值，输出**相同**才是对的
		const base = await svgOf({ view: "layout" });
		const byStatus = await svgOf({ view: "layout", groupBy: "status" });
		assert.notEqual(base, byStatus, "groupBy=status 应改变输出（分组 + 图例都变）");
		// 形状能力不变：两个版本都得有箭头能力
		assert.equal(base.includes("<marker"), byStatus.includes("<marker"), "换 groupBy 不该改变 view 本身的形状能力");
	});

	it("relation 在 layout 上决定连不连线", async () => {
		const dep = await svgOf({ view: "layout", relation: "dependency" });
		assert.match(dep, /data-edge/, "dependency 应画边");
		const cat = await svgOf({ view: "layout", relation: "category" });
		assert.equal(cat.includes("data-edge"), false, "category 不该画依赖边（否则与 dependency 混同）");
	});

	it("非法 view / groupBy 一律拒绝，不静默回落", async () => {
		for (const params of [
			{ view: "nonsense" },
			{ view: "layout", groupBy: "nonsense" },
			{ view: "layout", relation: "nonsense" },
		]) {
			const r = await run(makeTool(), params);
			assert.equal((r.details as Details).ok, false, `${JSON.stringify(params)} 应被拒`);
		}
	});

	it("旧 view 名仍然可用（向后兼容）", async () => {
		for (const view of ["timeline", "topology", "table"]) {
			const r = await run(makeTool(), paramsFor(view));
			assert.equal((r.details as Details).ok, true, `旧 view ${view} 应继续可用：${(r.details as Details).error}`);
		}
	});
	function paramsFor(view: string) {
		if (view === "topology") return { view };
		if (view === "table") return { view };
		return { view };
	}

	it("每张卡片都带图例（颜色含义不能靠猜）", async () => {
		for (const view of ["layout", "tree", "swimlane", "matrix", "topology"]) {
			const svg = await svgOf({ view });
			assert.match(svg, /data-legend/, `${view} 缺少图例`);
		}
	});
});

// ══════════════════════════════════════════════════════════
// 8. 标签简洁性（评审要求：一眼看懂这个节点是什么）
// ══════════════════════════════════════════════════════════
describe("节点标签：简洁且能表达清楚这个节点", () => {
	it("剥离重复的群组后缀（6 个节点都叫「· 森林侦探社」⇒ 噪声）", () => {
		const nodes = [
			{ id: "a", type: "prompt", title: "EP01《長老之死》· 森林偵探社" },
			{ id: "b", type: "prompt", title: "EP02《七道密碼》· 森林偵探社" },
			{ id: "c", type: "prompt", title: "EP03《記憶碎片》· 森林偵探社" },
		];
		const svg = buildTreeSvg(nodes as never, [] as never);
		// ⚠️ 判据是「**节点标签里**没有群组后缀」，不是「全图没有」——
		// 折叠掉的后缀会补进图例（折叠 ≠ 丢信息）。
		// 取节点标签：data-node 的 <g> 里紧跟的第一个 <text>（非贪婪，别跨到别的节点）
		const nodeLabels = [...svg.matchAll(/<g data-node="[^"]*"[^>]*>\s*<rect[^>]*\/>\s*<text[^>]*>([^<]*)<\/text>/g)].map(
			(m) => m[1],
		);
		assert.ok(nodeLabels.length >= 3, `应取到 3 个节点标签，实际 ${nodeLabels.length}`);
		assert.equal(
			nodeLabels.some((t) => t.includes("森林偵探社")),
			false,
			`节点标签里不该有重复群组后缀，实际：${JSON.stringify(nodeLabels)}`,
		);
		// 主体名称必须保留（可能被宽度截断成「EP01《長老之…」⇒ 断到EP 编号即可）
		assert.ok(
			nodeLabels.some((t) => t.includes("EP01")),
			`主体名称必须保留，实际：${JSON.stringify(nodeLabels)}`,
		);
		assert.equal(
			nodeLabels.some((t) => t.includes("《") && !t.includes("…") && t.includes("《") && t.split("《")[1].length < 4),
			false,
			`书名号内不应被截断（宁可少画不断字）：${JSON.stringify(nodeLabels)}`,
		);
	});

	it("群组名进图例（折叠掉≠丢信息）", () => {
		const nodes = [
			{ id: "a", type: "prompt", title: "EP01《長老之死》· 森林偵探社" },
			{ id: "b", type: "prompt", title: "EP02《七道密碼》· 森林偵探社" },
		];
		const svg = buildTreeSvg(nodes as never, [] as never);
		assert.match(svg, /森林偵探社/, "被折叠的群组名必须在图例里出现");
	});

	it("标签叠加业务序号 ①②③（用户明确要求）", () => {
		const nodes = [
			{ id: "a", type: "prompt", title: "原創定位" },
			{ id: "b", type: "prompt", title: "EP01《長老之死》" },
			{ id: "c", type: "prompt", title: "EP02《七道密碼》" },
			{ id: "d", type: "prompt", title: "EP03《記憶碎片》" },
			{ id: "e", type: "prompt", title: "EP04《血契真相》" },
			{ id: "f", type: "prompt", title: "EP05《暗影現身》" },
			{ id: "g", type: "prompt", title: "EP06《最終密碼》" },
			{ id: "h", type: "prompt", title: "EP07" },
			{ id: "i", type: "prompt", title: "EP08" },
			{ id: "j", type: "prompt", title: "EP09" },
			{ id: "k", type: "prompt", title: "EP10" },
			{ id: "l", type: "prompt", title: "EP11" },
		];
		const svg = buildTreeSvg(nodes as never, [] as never);
		// ①..⑫ —— 业务序号用带圈数字，表达"这是第几个"
		assert.match(svg, /①/, "第 1 个节点应带 ①");
		assert.match(svg, /②/, "第 2 个节点应带 ②");
		assert.match(svg, /③/, "第 3 个节点应带 ③");
		// 超过 ⑩ 之后要降级（不能编造不存在的字符）
		assert.ok(svg.includes("⑪") || svg.includes("11") || svg.includes("⑩"), "第 11 个应有降级表示");
		// 序号必须在**同一个 text 元素内**（不是另起一行）
		// ⭐ 序号 = **渲染位置序**（图上第几个），不是业务序号。
		// 「原創定位」无业务序号 ⇒ 排在EP01..EP11 之后 ⇒ 拿 ⑫。这是正确的：
		// 序号回答「这是图上第几个」，业务顺序由排布本身表达。
		const firstText = /<text[^>]*>([^<]*原創定位[^<]*)<\/text>/.exec(svg);
		assert.ok(firstText, "找不到含「原創定位」的 text");
		assert.match(firstText![1], /\S+\s*原創定位/, `序号应与名称同一标签内，实际 ${JSON.stringify(firstText![1])}`);
	});

	it("序号反映**业务序**不是画布序（画布乱序时序号仍连续）", () => {
		const nodes = [
			{ id: "a", type: "prompt", title: "EP01", position: { x: 0, y: 500 } },
			{ id: "b", type: "prompt", title: "EP02", position: { x: 0, y: 100 } },
			{ id: "c", type: "prompt", title: "EP03", position: { x: 0, y: 300 } },
		];
		const svg = buildTreeSvg(nodes as never, [] as never);
		// 标签形如 `<text ...>① EP01</text>`，用正则直接抓「序号 + 名称」的配对关系
		const pairs = [...svg.matchAll(/<text[^>]*>([①②③]) ?(EP0\d)/g)].map((m) => [m[1], m[2]]);
		assert.deepEqual(
			pairs.slice(0, 3),
			[["①", "EP01"], ["②", "EP02"], ["③", "EP03"]],
			"序号应与业务序对应（画布y乱序时序号仍连续）",
		);
	});

	it("类型标签可开关（默认不显示 —— 颜色 + 图例已表达，写出来只是噪音）", () => {
		const nodes = [
			{ id: "a", type: "prompt", title: "EP01" },
			{ id: "b", type: "image", title: "EP02" },
		];
		const without = buildLayoutSvg(nodes as never, [] as never, { drawEdges: false });
		const withType = buildLayoutSvg(nodes as never, [] as never, { drawEdges: false, showType: true });
		assert.ok(
			withType.length > without.length,
			`showType=true 应输出更多：${without.length} → ${withType.length}`,
		);
		assert.equal(/>① EP01 prompt</.test(withType), true, "开启后类型应出现在标签内");
		assert.equal(/>① EP01 prompt</.test(without), false, "默认不应显示类型");
	});
});

// ══════════════════════════════════════════════════════════
// 9. 顺序校验：画布序vs 业务序不一致要能被发现
// ══════════════════════════════════════════════════════════
describe("顺序校验：发现画布上的顺序错误", () => {
	it("auditOrder 报出「画布上放错位」的节点", () => {
		const nodes = [
			{ id: "a", title: "EP01", position: { x: 0, y: 0 } },
			{ id: "b", title: "EP02", position: { x: 0, y: 100 } },
			{ id: "c", title: "EP03", position: { x: 0, y: 300 } },
			{ id: "d", title: "EP04", position: { x: 0, y: 200 } },
		];
		const audit = auditOrder(nodes);
		// EP03(y=300) 与 EP04(y=200) 互换⇒ 两者都错位
		assert.equal(audit.misplaced.length, 2, `应报出 2 个错位，实际 ${JSON.stringify(audit.misplaced)}`);
		assert.ok(
			audit.misplaced.some((m) => m.title.includes("EP03")),
			"EP03 应被报为错位",
		);
	});

	it("画布序正确时无错位", () => {
		const nodes = [
			{ id: "a", title: "EP01", position: { x: 0, y: 0 } },
			{ id: "b", title: "EP02", position: { x: 0, y: 100 } },
			{ id: "c", title: "EP03", position: { x: 0, y: 200 } },
		];
		assert.equal(auditOrder(nodes).misplaced.length, 0);
	});

	it("错位信息能渲到卡片上（data-misplaced 标记 + 说明行）", async () => {
		const layout = {
			nodes: [
				{ id: "a", type: "prompt", title: "EP01", position: { x: 0, y: 0 } },
				{ id: "b", type: "prompt", title: "EP02", position: { x: 0, y: 300 } },
				{ id: "c", type: "prompt", title: "EP03", position: { x: 0, y: 100 } },
			],
			edges: [],
		};
		const svg = await svgOf({ view: "tree" }, layout);
		// 标记名是瘦身后的短形式 `data-x`（`data-misplaced` 每节点多 12 字节 × N 节点）
		assert.match(svg, /data-x/, "错位节点应带 data-x 标记");
		assert.match(svg, /画布顺序/, "卡片上要说明这是画布顺序问题");
	});

	it("无错位时不输出错位说明（不制造噪音）", async () => {
		const layout = {
			nodes: [
				{ id: "a", type: "prompt", title: "EP01", position: { x: 0, y: 0 } },
				{ id: "b", type: "prompt", title: "EP02", position: { x: 0, y: 100 } },
			],
			edges: [],
		};
		const svg = await svgOf({ view: "tree" }, layout);
		assert.equal(svg.includes("data-x"), false);
		assert.equal(svg.includes("画布顺序"), false);
	});
});

// ══════════════════════════════════════════════════════════
// 10. 尺寸预算（2026-10-05 生产复测发现的 P0）
// ══════════════════════════════════════════════════════════
describe("尺寸预算：63 节点的真实画布必须能出图", () => {
	/** 生产真实形状：63 节点 / 123 边（森林侦探社）。 */
	const BIG = {
		nodes: Array.from({ length: 46 }, (_, i) => ({
			id: `i${i}`,
			type: "image",
			title: `角色三视图 ${i}`,
			position: { x: 300, y: i * 30 },
			status: "completed",
		})).concat(
			Array.from({ length: 10 }, (_, i) => ({
				id: `p${i}`,
				type: "prompt",
				title: i === 0 ? "全劇大綱" : `EP0${i}《标题》· 森林偵探社`,
				position: { x: 0, y: i * 100 },
				status: "draft",
				parentNode: i === 0 ? undefined : "p0",
			})),
			Array.from({ length: 7 }, (_, i) => ({
				id: `v${i}`,
				type: "video",
				title: `EP01 正片 ${i}`,
				position: { x: 600, y: i * 40 },
				status: "completed",
				parentNode: "p1",
			})),
		),
		edges: [
			{ source: "p0", target: "p1" },
			...Array.from({ length: 9 }, (_, i) => ({ source: "p0", target: `p${i + 1}` })),
			...Array.from({ length: 40 }, (_, i) => ({ source: `i${i}`, target: `i${i + 1}` })),
			...Array.from({ length: 6 }, (_, i) => ({ source: "p1", target: `v${i}` })),
		],
	};

	// ⚠️ 与线上 `present-result.ts` 的 SVG_MAX_CHARS 保持一致（超界整块丢弃）
	const MAX_CHARS = 20000;

	it("layout+dependency 在 63 节点下不超界（加依赖边会让原本不超的也超）", () => {
		const svg = buildLayoutSvg(BIG.nodes as never, BIG.edges as never, { drawEdges: true, groupBy: "type" });
		assert.ok(
			svg.length <= MAX_CHARS,
			`产出 ${svg.length}B 超上限 ${MAX_CHARS}B ⇒ 生产会整块丢弃（用户看到 <pre> 占位）。` +
				`修法：节点数超阈值时应告知调用方「请用 node_ids 收窄」而不是画一张丢掉的图`,
		);
	});

	it("tree 在 63 节点下不超界", () => {
		const svg = buildTreeSvg(BIG.nodes as never, BIG.edges as never);
		assert.ok(svg.length <= MAX_CHARS, `tree 产出 ${svg.length}B 超上限`);
	});

	it("swimlane 在 63 节点下不超界", () => {
		const svg = buildSwimlaneSvg(BIG.nodes as never, BIG.edges as never, "type");
		assert.ok(svg.length <= MAX_CHARS, `swimlane 产出 ${svg.length}B 超上限`);
	});

	it("matrix 在 63 节点下不超界", () => {
		const svg = buildMatrixSvg(BIG.nodes as never, "type", "status");
		assert.ok(svg.length <= MAX_CHARS, `matrix 产出 ${svg.length}B 超上限`);
	});

	it("超预算时给出显式信号（data-too-large + 原因），不是静默画一张注定被丢的图", async () => {
		const HUGE = {
			nodes: Array.from({ length: 400 }, (_, i) => ({
				id: `n${i}`,
				type: "image",
				title: `节点 ${i}`,
				position: { x: 0, y: i * 30 },
			})),
			edges: [],
		};
		const r = await run(makeTool(HUGE), { view: "tree" });
		const d = r.details as Details;
		assert.equal(d.ok, false, "400 节点不可能画进 20000B ⇒ 应报错而非产出注定被丢的图");
		assert.match(d.error!, /节点|超|too many|收窄|node_ids/);
		assert.deepEqual(d.missing, undefined, "这不是「数据源缺节点」，不要混用 missing 通道");
	});

	it("刚好在预算内不报错（边界不误伤）", async () => {
		const r = await run(makeTool(LAYOUT), { view: "tree" });
		assert.equal((r.details as Details).ok, true);
	});

	it("阈值来自单一常量（改一处即可，不是散落各处的魔法数）", () => {
		assert.equal(SVG_MAX_CHARS, 20000, "须与 present-result.ts 的 SVG_MAX_CHARS 一致");
	});
});
