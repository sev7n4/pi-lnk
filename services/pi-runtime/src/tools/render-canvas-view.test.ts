import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	createRenderCanvasViewTools,
	buildTimelineSvg,
	buildTableSvg,
	buildTopologySvg,
} from "./render-canvas-view.js";

const LAYOUT = {
	nodes: [
		{ id: "n1", type: "prompt", title: "镜头 1", position: { x: 0, y: 0 } },
		{ id: "n2", type: "prompt", title: "镜头 2", position: { x: 100, y: 0 } },
		{ id: "n3", type: "prompt", title: "镜头 3", position: { x: 200, y: 0 } },
	],
	edges: [{ source: "n1", target: "n2" }],
};

function makeTool() {
	const calls: string[] = [];
	const tools = createRenderCanvasViewTools({
		fetchLayout: async () => {
			calls.push("fetchLayout");
			return LAYOUT;
		},
	});
	const tool = tools.find((t) => t.name === "render_canvas_view")!;
	return { tool, calls };
}

async function run(tool: ReturnType<typeof makeTool>["tool"], params: unknown) {
	return tool.execute("call-1", params as never, () => {}, { sessionId: "s1" }, {} as never, {} as never);
}

type Details = { ok: boolean; error?: string; missing?: string[]; canvasCommands?: Array<{ svg: string }> };

async function svgOf(params: unknown): Promise<string> {
	const { tool } = makeTool();
	const r = await run(tool, params);
	const d = r.details as Details;
	assert.equal(d.ok, true, `期望成功，实际 error=${d.error}`);
	return d.canvasCommands![0].svg;
}

/** 取所有时间线条的 rect 宽度（等宽刻度断言用）。 */
function barWidths(svg: string): string[] {
	return [...svg.matchAll(/<rect class="bar[^"]*"[^>]*width="(\d+)"/g)].map((m) => m[1]);
}

describe("render_canvas_view 参数契约", () => {
	it("overlay 传给 topology 时返回 ok:false 而非静默忽略", async () => {
		const { tool } = makeTool();
		const r = await run(tool, { view: "topology", overlay: { kind: "emotion", data: {} } });
		assert.equal((r.details as Details).ok, false);
		assert.match((r.details as Details).error!, /overlay/);
	});

	it("overlay.kind 非枚举值时返回 ok:false", async () => {
		const { tool } = makeTool();
		const r = await run(tool, { view: "timeline", overlay: { kind: "bogus", data: [] } });
		assert.equal((r.details as Details).ok, false);
	});

	it("数据源节点不存在时返回 ok:false 且不编造行", async () => {
		const { tool } = makeTool();
		const r = await run(tool, { view: "timeline", node_ids: ["不存在"] });
		const d = r.details as Details;
		assert.equal(d.ok, false);
		assert.deepEqual(d.missing, ["不存在"]);
	});

	it("view 缺省时默认 timeline", async () => {
		const { tool } = makeTool();
		const r = await run(tool, {});
		assert.equal((r.details as Details).ok, true);
	});

	it("不调任何 Nest 写端点：只读 fetchLayout 一次", async () => {
		const { tool, calls } = makeTool();
		await run(tool, { view: "topology" });
		assert.deepEqual(calls, ["fetchLayout"]);
	});

	// finding 1：table 只实现 severity；收下 budget/emotion 却不画 = 静默忽略叠加。
	it("view=table 传budget overlay 时返回 ok:false 而非静默忽略", async () => {
		const { tool } = makeTool();
		const r = await run(tool, { view: "table", overlay: { kind: "budget", data: [{ node_id: "n1", duration_sec: 2, dialogue_chars: 20 }] } });
		const d = r.details as Details;
		assert.equal(d.ok, false);
		assert.match(d.error!, /budget/);
		assert.match(d.error!, /table/);
	});

	it("view=table 传 emotion overlay 时返回 ok:false", async () => {
		const { tool } = makeTool();
		const r = await run(tool, { view: "table", overlay: { kind: "emotion", data: [{ node_id: "n1", emotion: 5 }] } });
		assert.equal((r.details as Details).ok, false);
	});

	it("view=table 传 severity overlay 仍然允许", async () => {
		const { tool } = makeTool();
		const r = await run(tool, { view: "table", overlay: { kind: "severity", data: [{ node_id: "n1", level: "error" }] } });
		assert.equal((r.details as Details).ok, true);
	});
});

// finding 2：description 长度是 spec 硬约束 [80,400]，Task 8 的 lint 会拒 >400。
describe("工具元数据契约", () => {
	const tool = makeTool().tool;

	it("description 落在 [80,400] 字符内", () => {
		assert.ok(tool.description.length >= 80, `过短：${tool.description.length}`);
		assert.ok(tool.description.length <= 400, `过长：${tool.description.length}`);
	});

	it("description 保留 R1–R4：动词开头 / 前提 / 显式否定边界 / 枚举语义", () => {
		const d = tool.description;
		assert.match(d, /^Render /);
		assert.match(d, /must already exist/);
		assert.match(d, /does NOT edit or create nodes/);
		assert.match(d, /does NOT trigger generation/);
		// 三维正交必须写进顶层 description —— 模型靠它知道有三个独立维度可调。
		assert.match(d, /SHAPE with `view`/);
		assert.match(d, /RELATION with `relation`/);
		assert.match(d, /GROUPING with `groupBy`/);
		// 排序契约要写明（业务序号优先），否则模型不知道可以不传 node_ids
		assert.match(d, /business sequence/);
		// ⚠️ 形状清单（layout/tree/timeline/swimlane/matrix + 旧别名）刻意**不在**顶层：
		// 顶层 description 有 [80,400] 硬上限（spec 约束），清单塞进来会挤掉契约。
		// 它在 `parameters.properties.view.description` 里 —— 那是模型读细节时真正会看的位置。
		const viewDesc = (
			tool.parameters as { properties: { view: { description: string } } }
		).properties.view.description;
		for (const name of ["layout", "tree", "timeline", "swimlane", "matrix", "topology", "table"]) {
			assert.ok(viewDesc.includes(name), `view 的参数说明里必须列出 ${name}`);
		}
	});

	// finding 3：声明的 schema 必须与 assertOverlay 的可接受集合一致（array | {}）。
	it("overlay.data 声明为 array | object，与运行时接受集一致", () => {
		const data = (tool.parameters as { properties: { overlay: { properties: { data: { anyOf: Array<{ type?: string }> } } } } }).properties.overlay
			.properties.data;
		const types = data.anyOf.map((s) => s.type).sort();
		assert.deepEqual(types, ["array", "object"]);
	});

	// finding 5：schema 的枚举字面量由 VIEWS / OVERLAYS 经 .map 派生。
	// ⚠️ 本测试只能钉住**字面量取值**（防误写/改名），无法证明「是派生的而非硬编码的」——
	// 二者产出的 schema 完全相同。防漂移靠的是源码里的 `VIEWS.map(...)` / `OVERLAYS.map(...)`
	// 这一事实本身（code review 判据），不是这条断言；变异验证也确认了它对硬编码不敏感。
	it("view / overlay.kind 的字面量取值与冻结枚举一致", () => {
		const props = (tool.parameters as {
			properties: {
				view: { anyOf: Array<{ const: string }> };
				overlay: { properties: { kind: { anyOf: Array<{ const: string }> } } };
			};
		}).properties;
		// 2026-10-05 扩枚举：新增 layout / tree / swimlane / matrix（表达层），
		// `topology` / `table` 作为**别名**保留 —— 删掉会让老 prompt 与老调用直接失效。
		assert.deepEqual(
			props.view.anyOf.map((s) => s.const),
			["layout", "tree", "timeline", "swimlane", "matrix", "topology", "table"],
		);
		// 旧名必须仍在（向后兼容是硬要求，不是可选）
		for (const legacy of ["topology", "table", "timeline"]) {
			assert.ok(
				props.view.anyOf.some((s) => s.const === legacy),
				`旧 view ${legacy} 被删了 —— 老 prompt/调用会直接失效`,
			);
		}
		assert.deepEqual(
			props.overlay.properties.kind.anyOf.map((s) => s.const),
			["emotion", "budget", "severity"],
			"overlay.kind 是行级指标通道，2026-10-05 的 relation 扩展刻意**不动**它（两者正交）",
		);
		// relation / groupBy 枚举
		const props2 = (tool.parameters as {
			properties: {
				relation: { anyOf: Array<{ const: string }> };
				groupBy: { anyOf: Array<{ const: string }> };
				nodes: { items: { properties: { color: { anyOf: Array<{ const: string }> } } } };
			};
		}).properties;
		assert.deepEqual(props2.relation.anyOf.map((s) => s.const), ["dependency", "category"]);
		assert.deepEqual(props2.groupBy.anyOf.map((s) => s.const), ["type", "status", "parentNode"]);
		// 颜色只给语义色名，绝不放色值进 schema（色值通道由 type 自动分配）
		const colors = props2.nodes.items.properties.color.anyOf.map((s) => s.const);
		assert.equal(colors.length > 0, true, "color 应是语义色名枚举");
		assert.equal(
			colors.some((c) => c.startsWith("#") || c.includes("rgb")),
			false,
			`色值不得进schema：${JSON.stringify(colors)}`,
		);
	});
});

describe("buildTimelineSvg", () => {
	it("超预算行（台词字数 > 时长 × 4.5）带 warn class", () => {
		const svg = buildTimelineSvg([
			{ shotId: "S1", label: "镜1", durationSec: 2, dialogueChars: 20 },
		]);
		assert.match(svg, /warn/);
	});

	it("未超预算不带 warn class", () => {
		const svg = buildTimelineSvg([
			{ shotId: "S1", label: "镜1", durationSec: 10, dialogueChars: 20 },
		]);
		assert.doesNotMatch(svg, /warn/);
	});

	it("overlay=emotion 时输出情绪折线 polyline", () => {
		const svg = buildTimelineSvg(
			[
				{ shotId: "S1", label: "镜1", durationSec: 3, emotion: 2 },
				{ shotId: "S2", label: "镜2", durationSec: 3, emotion: 8 },
			],
			{ kind: "emotion", data: {} },
		);
		assert.match(svg, /<polyline/);
	});

	it("overlay=data 非数组时抛错而非渲染空轨道", () => {
		assert.throws(
			() =>
				buildTimelineSvg([{ shotId: "S1", label: "a", durationSec: 1 }], {
					kind: "emotion",
					data: { bad: true },
				} as never),
			/emotion/,
		);
	});

	it("overlay.data 为空对象 {} 时视作无行级数据（不抛）", () => {
		const svg = buildTimelineSvg([{ shotId: "S1", label: "a", durationSec: 3 }], {
			kind: "emotion",
			data: {},
		});
		assert.match(svg, /<svg/);
	});

	it("行缺 durationSec 时按等宽刻度渲染，不编造时长数字", () => {
		const svg = buildTimelineSvg([
			{ shotId: "S1", label: "a" },
			{ shotId: "S2", label: "b" },
		]);
		// 没有真实时长 → 不出现 "3s" 这类凭空造出来的时长文本
		assert.doesNotMatch(svg, />\d+(\.\d+)?s</);
		const widths = barWidths(svg);
		assert.equal(widths.length, 2);
		assert.equal(widths[0], widths[1]);
	});

	it("节点标题被转义，未闭合标签不会吞掉卡片内容", () => {
		const svg = buildTimelineSvg([{ shotId: "S1", label: '<b>&"x"', durationSec: 1 }]);
		assert.match(svg, /&lt;b&gt;&amp;&quot;x&quot;/);
		assert.doesNotMatch(svg, /<b>/);
	});

	it("全部行duration 为 0 时不产生 NaN 宽度（回退等宽刻度）", () => {
		const svg = buildTimelineSvg([
			{ shotId: "S1", label: "a", durationSec: 0 },
			{ shotId: "S2", label: "b", durationSec: 0 },
		]);
		assert.doesNotMatch(svg, /NaN/);
		const widths = barWidths(svg);
		assert.equal(widths.length, 2);
		assert.equal(widths[0], widths[1]);
	});
});

// finding 7：over-budget 的 data-warn 属性与行填充曾会互相矛盾（severity 覆盖掉 .over 类）。
describe("超预算标记与行底色必须一致", () => {
	/** 取每行 rect 的完整属性串。 */
	function rowRects(svg: string): string[] {
		return [...svg.matchAll(/<rect class="bar[^"]*"[^>]*\/>/g)].map((m) => m[0]);
	}

	it("severity 与超预算同时成立时，两个class 都写上（不互相抹除）", () => {
		const svg = buildTimelineSvg(
			[
				{ shotId: "S1", label: "超", durationSec: 2, dialogueChars: 20 },
				{ shotId: "S2", label: "好", durationSec: 10, dialogueChars: 20 },
			],
			{ kind: "severity", data: [{ node_id: "S1", level: "error" }, { node_id: "S2", level: "warn" }] },
		);
		const [over, ok] = rowRects(svg);
		// 超预算行：既标 data-warn（属性），也带 over（视觉），二者不矛盾
		assert.match(over, /data-warn="1"/);
		assert.match(over, /class="bar over sev-error"/);
		// 未超预算行：没有 data-warn 也没有 over
		assert.doesNotMatch(ok, /data-warn/);
		assert.doesNotMatch(ok, /over/);
	});

	it("不存在「有 data-warn 却无 over 视觉」的行", () => {
		const svg = buildTimelineSvg(
			[{ shotId: "S1", label: "超", durationSec: 2, dialogueChars: 20 }],
			{ kind: "severity", data: [{ node_id: "S1", level: "warn" }] },
		);
		for (const rect of rowRects(svg)) {
			// 属性与视觉同进同出：这是本finding 的核心不变量
			assert.equal(/data-warn="1"/.test(rect), /class="[^"]*\bover\b/.test(rect));
		}
	});
});

describe("行级指标与 severity 级别的对齐必须一致", () => {
	/** 取每行 rect 的 class（表格/时间线同一形状：rect 顺序即行序）。 */
	function rowClasses(svg: string): string[] {
		return [...svg.matchAll(/<rect class="([^"]*)"/g)].map((m) => m[1]);
	}

	it("node_ids 过滤后 severity 级别仍贴到正确的行", () => {
		const rows = [
			{ id: "n1", cells: ["n1"] },
			{ id: "n3", cells: ["n3"] },
		];
		// data 只给 n3 标 error；若按位置对齐会错贴到第0 行（n1）
		const svg = buildTableSvg(rows, { kind: "severity", data: [{ node_id: "n3", level: "error" }] });
		assert.deepEqual(rowClasses(svg), ["row0", "sev-error"]);
	});

	it("emotion 折线跳过无 emotion 值的行，不按 0 补点", () => {
		const svg = buildTimelineSvg(
			[
				{ shotId: "S1", label: "a", durationSec: 1, emotion: 8 },
				{ shotId: "S2", label: "b", durationSec: 1 },
				{ shotId: "S3", label: "c", durationSec: 1, emotion: 2 },
			],
			{ kind: "emotion", data: {} },
		);
		const quoted = svg.slice(svg.indexOf("<polyline points=") + "<polyline points=\"".length);
		const list = quoted.slice(0, quoted.indexOf("\""));
		// 只有 2 个真实情绪点（S2 无值 → 既不补 0 也不连线），y 按 trackTop=142 与 0–10 量程算出
		assert.deepEqual(list.split(" "), ["120,154", "680,190"]);
	});
});

describe("行级指标来源（spec §5.1：数据源不存在则不编造）", () => {
	it("无 overlay.data 时全部行等宽、无预算 warn 轨道", async () => {
		const svg = await svgOf({ view: "timeline" });
		assert.doesNotMatch(svg, /warn/);
		assert.doesNotMatch(svg, />\d+(\.\d+)?s</);
		const widths = barWidths(svg);
		assert.equal(widths.length, 3);
		assert.equal(new Set(widths).size, 1);
	});

	it("overlay.data 按 node_id 把时长/台词字数合并到对应行", async () => {
		const svg = await svgOf({
			view: "timeline",
			overlay: { kind: "budget", data: [{ node_id: "n2", duration_sec: 2, dialogue_chars: 20 }] },
		});
		// n2：20 字 > 2s × 4.5 → 超预算
		assert.match(svg, /warn/);
		// 只有 n2 有真实时长 → 只有 1 根按比例的条，其余两行是等宽刻度
		const widths = barWidths(svg);
		assert.equal(widths.length, 3);
		assert.equal(new Set(widths).size, 2);
	});

	it("overlay.data 项缺 node_id 时按顺序对应画布节点", async () => {
		const svg = await svgOf({
			view: "timeline",
			overlay: { kind: "budget", data: [{ duration_sec: 2, dialogue_chars: 20 }] },
		});
		// 无 node_id → 落到首个节点 n1 上，故 warn 出现在第一行
		assert.match(svg, /warn/);
		const firstRow = svg.slice(svg.indexOf("镜头 1"));
		assert.match(firstRow.slice(0, firstRow.indexOf("镜头 2")), /warn/);
	});

	it("overlay.data 里 duration_sec 非有限数字时 ok:false，不当 0 参与渲染", async () => {
		const { tool } = makeTool();
		const r = await run(tool, {
			view: "timeline",
			overlay: { kind: "budget", data: [{ node_id: "n1", duration_sec: "两秒" }] },
		});
		const d = r.details as Details;
		assert.equal(d.ok, false);
		assert.match(d.error!, /duration_sec/);
	});
});

describe("buildTableSvg / buildTopologySvg", () => {
	it("table 按 severity overlay 给行上色", () => {
		const svg = buildTableSvg(
			[
				{ id: "r1", cells: ["a", "b"] },
				{ id: "r2", cells: ["c", "d"] },
			],
			{ kind: "severity", data: [{ level: "error" }, { level: "warn" }] },
		);
		assert.match(svg, /sev-error/);
		assert.match(svg, /sev-warn/);
	});

	it("table 单元格内容被转义", () => {
		const svg = buildTableSvg([{ id: "r1", cells: ["<i>&</i>"] }]);
		assert.match(svg, /&lt;i&gt;&amp;&lt;\/i&gt;/);
	});

	it("topology 渲染节点标题与边，端点不在集合内的边被丢弃", () => {
		const svg = buildTopologySvg(
			[
				{ id: "a", title: "角色" },
				{ id: "b", title: "场景" },
			],
			[
				{ source: "a", target: "b" },
				{ source: "a", target: "不存在" },
			],
		);
		assert.match(svg, /角色/);
		assert.match(svg, /场景/);
		assert.equal([...svg.matchAll(/<line/g)].length, 1);
	});

	it("topology 节点标题被转义", () => {
		const svg = buildTopologySvg([{ id: "a", title: "<x>&" }], []);
		assert.match(svg, /&lt;x&gt;&amp;/);
	});
});
