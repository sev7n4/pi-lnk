import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createRenderCanvasViewTools } from "./render-canvas-view.js";
import { buildLayoutSvg } from "./render-canvas-view.views.js";

/**
 * 配色 class 的 CSS 规则必须真实存在 —— 否则节点渲染成黑条。
 *
 * ## 生产事故（2026-10-05 截图评审发现）
 *
 * `nodeRect` 用 `class="cf0 cs1"` 省字节（内联 fill 63 次约 3.2KB），
 * 但 `svgHeader()` 在**渲染开始时**就调用，那时 `CSS_CLASSES` 还是**空 Map**
 * （颜色是渲染每个节点时才逐个登记的）⇒ `<style>` 里一条 `.cf` 规则都没有。
 *
 * 后果：`rect` 拿不到 fill ⇒ SVG 默认 fill 是黑 ⇒ **整张卡片全是黑条、文字不可见**。
 *
 * ## ⭐ 为什么必须独立成一个文件
 *
 * `CSS_CLASSES` 是**模块级状态**，在同进程内被前面的测试填过之后，
 * 任何放在后面的测试都拿到"脏状态"⇒ 规则非空 ⇒ 断言通过 ⇒ **假绿**。
 * 2026-10-05 实测：把这段测试放在大文件末尾时 **63/63 全绿**，
 * 而同一时刻生产线上每一张卡片都是黑条。
 *
 * ⇒ 本文件是**独立测试文件**（`node --test` 每个文件一个进程）⇒ 天然冷启动。
 * **不要把这些 `it` 合并进 expressive.test.ts。**
 */

/** 与 expressive.test.ts 同款的调用方式（本文件自带，避免跨文件 import 测试助手）。 */
function makeTool(layout: unknown) {
	const tools = createRenderCanvasViewTools({ fetchLayout: async () => layout });
	return tools.find((t) => t.name === "render_canvas_view")!;
}
async function run(tool: ReturnType<typeof makeTool>, params: unknown) {
	return tool.execute("c1", params as never, () => {}, { sessionId: "s1" } as never, {} as never, {} as never);
}

describe("SVG 配色 class：<style> 里必须有规则（冷启动）", () => {
	const NODES = [
		{ id: "p1", type: "prompt", title: "全劇大綱", position: { x: 0, y: 0 } },
		{ id: "i1", type: "image", title: "S01A 觸須顫抖", position: { x: 0, y: 100 } },
		{ id: "v1", type: "video", title: "EP01 正片", position: { x: 0, y: 200 } },
		{ id: "p2", type: "prompt", title: "EP01《長老之死》", position: { x: 0, y: 300 } },
	];

	function styleOf(svg: string): string {
		return [...svg.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
	}

	it("首张图的 <style> 里必须有 .cf* 配色规则（这是生产的真实路径）", () => {
		const svg = buildLayoutSvg(NODES as never, [] as never, { drawEdges: true });
		const css = styleOf(svg);
		const rules = css.match(/\.cf[a-z0-9]+\{fill:/g) ?? [];
		assert.ok(
			rules.length > 0,
			`<style> 里没有任何 .cf*fill 规则 ⇒ 节点会是黑条。实际 style（${css.length} 字符）：${css.slice(0, 240)}`,
		);
	});

	it("rect 用的每个 class 都必须有对应规则（class 与规则一一配对）", () => {
		const svg = buildLayoutSvg(NODES as never, [] as never, { drawEdges: true });
		const css = styleOf(svg);
		const used = new Set(
			[...svg.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean),
		);
		const BUILTIN = new Set(["n", "l", "w", "gv-t", "gv-s", "gv-warn", "gv-info", "gv-e"]);
		const orphans = [...used].filter((c) => !BUILTIN.has(c) && !css.includes(`.${c}{`));
		assert.deepEqual(
			orphans,
			[],
			`这些 class 没有对应 CSS 规则 ⇒ 走浏览器默认样式（黑/透明）：${orphans.join(" ")}`,
		);
	});

	it("配色规则必须覆盖 prompt/image/video 三种类型", () => {
		const svg = buildLayoutSvg(NODES as never, [] as never, { drawEdges: true });
		const css = styleOf(svg);
		const fills = [...css.matchAll(/\.cf[a-z0-9]+\{fill:(#[0-9A-Fa-f]{3,8})\}/g)].map((m) =>
			m[1].toUpperCase(),
		);
		assert.ok(
			new Set(fills).size >= 3,
			`三种类型应产生 ≥3 种不同填充色，实际 ${new Set(fills).size} 种：${fills.join(" ")}`,
		);
	});

	it("每张图都自带完整规则（不能靠上一张的残留）", () => {
		for (const nodes of [
			NODES,
			// 第二张图引入新颜色（draft 状态色），规则必须随之出现
			[{ id: "x1", type: "prompt", title: "新節點", status: "draft", position: { x: 0, y: 0 } }],
		]) {
			const css = styleOf(buildLayoutSvg(nodes as never, [] as never, { drawEdges: true }));
			const used = new Set(
				[...buildLayoutSvg(nodes as never, [] as never, { drawEdges: true })
					.matchAll(/class="([^"]*)"/g)]
					.flatMap((m) => m[1].split(/\s+/))
					.filter(Boolean),
			);
			for (const c of used) {
				if (/^(n|l|w|gv-)/.test(c)) continue;
				assert.ok(css.includes(`.${c}{`), `class "${c}" 在这张图里没有对应规则`);
			}
		}
	});
});

// ══════════════════════════════════════════════════════════
// 14. 超预算建议必须对当前 view 可行（截图评审发现的误导）
// ══════════════════════════════════════════════════════════
describe("超预算建议：scope/focus 只对 layout/topology 有效", () => {
	/**
	 * `scope` / `focus` 只作用于**依赖图**（layout / 旧名 topology）。
	 * 泳道 / tree / timeline 不受它们约束 —— 给这些视图建议「改用 scope」
	 * 是**指一条不存在的路**，用户照做仍拿不到图。
	 *
	 * 2026-10-05 截图评审发现：真实画布（63 节点/123 边）上泳道超预算，
	 * 报错文案仍推「改用 scope 收窄观察尺度」，而泳道根本不认这个参数。
	 */
	// ⭐ 规模要够大才必然超预算：泳道/tree 的节点行虽按「阶段 × 组」聚合，
	// 但每行仍带标签与分组框；用 layout 的量级（56 节点）测不出超限 ⇒ 断言会假绿。
	// 实测：200 节点 / 199 边 ⇒ swimlane 48723B / tree 52008B / layout 50295B，均超。
	const MANY = Array.from({ length: 160 }, (_, i) => ({
		id: `i${i}`, type: "image", title: `镜头 ${i}`, position: { x: 300, y: i * 30 },
	})).concat(
		Array.from({ length: 40 }, (_, i) => ({
			id: `p${i}`, type: "prompt", title: `EP${i}《标题》`, position: { x: 0, y: i * 100 },
		})),
	);
	const CHAIN = Array.from({ length: 199 }, (_, i) => ({ source: `i${i}`, target: `i${i + 1}` }));

	function tool() {
		return makeTool({ nodes: MANY, edges: CHAIN });
	}

	it("泳道超预算时不能说「改用 scope」（它不受 scope 约束）", async () => {
		const r = await run(tool(), { view: "swimlane", groupBy: "type" });
		const d = r.details as { ok: boolean; error?: string };
		assert.equal(d.ok, false, "本用例前提是超预算（若哪天泳道能出图，本用例无意义）");
		assert.ok(
			!/改用 scope/.test(d.error!),
			`泳道不受 scope 约束，建议「改用 scope」是指一条不存在的路：${d.error}`,
		);
	});

	it("泳道超预算时必须给出 node_ids 这条唯一可行出路", async () => {
		const r = await run(tool(), { view: "swimlane", groupBy: "type" });
		const d = r.details as { ok: boolean; error?: string };
		assert.match(d.error!, /node_ids/, "scope/focus 都不可用时，必须明确给出 node_ids");
	});

	it("layout 超预算时仍应先劝 scope（那是它真正有效的手段）", async () => {
		const r = await run(tool(), { view: "layout", relation: "dependency", scope: "detail" });
		const d = r.details as { ok: boolean; error?: string };
		assert.equal(d.ok, false);
		assert.match(d.error!, /scope/, "layout + detail 超预算时，scope 收窄是有效手段，应被提及");
	});

	it("tree 超预算时也不应推 scope（它同样不受约束）", async () => {
		const r = await run(tool(), { view: "tree" });
		const d = r.details as { ok: boolean; error?: string };
		if (d.ok) return; // tree 若能出图，本用例无意义
		assert.ok(!/改用 scope/.test(d.error!), `tree 不受 scope 约束：${d.error}`);
	});
});

// ══════════════════════════════════════════════════════════
// 15. 局部视图出线策略（2026-10-05 UX 评审：不能硬编码一种）
// ══════════════════════════════════════════════════════════
describe("focus_anchor：出线策略可切换，且默认真正错开", () => {
	/**
	 * 真实场景：焦点（资产表）有 **18 个下游**，远超聚合阈值 8。
	 *
	 * 起因：`edgePath()` 早就把同源多出边起点沿源节点高度分散，但**分散范围被源节点
	 * 20px 高度限死** ⇒ 18 条边塞进 20px、每条只隔 1px，**视觉上仍是一条实线**。
	 * 实测：真实画布 focus=資產表 的 31 条边全部视觉重叠。
	 *
	 * 三种策略对应不同诉求（不硬定一种）：
	 * - `spread`（默认）拉高焦点节点 ⇒ 真正错开
	 * - `bus` 高度不变 + 右侧垂直汇流条 ⇒ 保留"连出一片"的整体感
	 * - `aggregate` 超阈值聚合成单箭头 ⇒ 只关心数量时最省
	 */
	const FANOUT = (() => {
		const nodes = [
			{ id: "c", type: "prompt", title: "EP01《長老之死》· 資產表", position: { x: 0, y: 0 } },
		];
		const edges: Array<{ source: string; target: string }> = [];
		for (let i = 0; i < 18; i++) {
			nodes.push({
				id: `d${i}`,
				type: "image",
				title: "S01" + String.fromCharCode(65 + i) + " 镜头 " + i,
				position: { x: 300, y: i * 30 },
			} as never);
			edges.push({ source: "c", target: `d${i}` });
		}
		return { nodes, edges };
	})();

	function svgOf(anchor?: string) {
		return buildLayoutSvg(FANOUT.nodes as never, FANOUT.edges as never, {
			drawEdges: true,
			scope: "detail",
			focus: "c",
			focusAnchor: anchor as never,
		});
	}

	function startYs(svg: string): string[] {
		return [...svg.matchAll(/<path data-edge="1" d="M\d+,(\d+)/g)].map((m) => m[1]);
	}

	it("默认 spread：焦点被拉高，18 条边起点真正错开", () => {
		const ys = startYs(svgOf(undefined));
		assert.equal(ys.length, 18, `应画 18 条边，实际 ${ys.length}`);
		assert.equal(new Set(ys).size, 18, `18 条边起点应各不相同，实际只有 ${new Set(ys).size} 个不同 y`);
	});

	it("bus：节点高度**不变**（这是它与 spread 的区别），边画在汇流条上", () => {
		const spread = svgOf("spread");
		const bus = svgOf("bus");
		// ⚠️ 判据是**焦点行自身的高度**，不是整图高度 ——
		// spread 只拉伸焦点那一行（本例19 行里 18 行不变）⇒ 整图高度几乎相同。
		const focusH = (svg: string) => {
			const m = /<rect x="150" y="30" width="554" height="(\d+)"/.exec(svg)
				?? /<rect x="\d+" y="30" width="\d+" height="(\d+)"/.exec(svg);
			return m ? Number(m[1]) : 0;
		};
		assert.ok(
			focusH(spread) > focusH(bus),
			`spread 应拉高焦点行：spread 焦点高=${focusH(spread)} bus=${focusH(bus)}`,
		);
		// 一行高是 26（含2px 边框余量），spread 应远大于它
		assert.ok(focusH(bus) <= 30, `bus 刻意不拉高焦点行，实测 ${focusH(bus)}`);
		// ⭐ bus 的代价要说清楚：高度不拉 ⇒ 18 条边挤在 20px 内，起点必然有重合
		// （这不是 bug，是「保留整体感、放弃逐条可辨」的取舍）
		const ys = startYs(bus);
		assert.ok(
			new Set(ys).size < ys.length,
			`bus 刻意不拉高 ⇒ 起点会有重合（取舍），实际 ${new Set(ys).size}/${ys.length}`,
		);
		// 但边**一条不少**（不丢信息，这是与 aggregate 的关键区别）
		assert.equal(ys.length, 18, "bus 必须保留全部 18 条边");
	});

	it("aggregate：超阈值时聚合成单箭头并标明总数（不静默丢弃）", () => {
		const svg = svgOf("aggregate");
		const drawn = (svg.match(/data-edge="1"/g) || []).length;
		assert.ok(drawn < 18, `aggregate 应减少边数，实际仍画了 ${drawn} 条`);
		assert.match(svg, /18 个下游/, "必须标明聚合了多少条，否则用户不知道有信息被省掉");
		// ⭐ 标签必须**完整落在画布内**（之前画在 x=712 > 宽 720 ⇒ 被裁成「个下游」）。
		const m = /<text x="(\d+)"[^>]*>→ 18 个下游</.exec(svg);
		assert.ok(m, "聚合标签应带完整文案");
		assert.ok(Number(m![1]) + "→ 18 个下游".length * 6 <= 720, `标签起点 ${m![1]} 超出画布宽 720，会被裁掉`);
	});

	it("出边少时不聚合（阈值 8 以下保持逐条画）", () => {
		const small = {
			nodes: [
				{ id: "c", type: "prompt", title: "小焦点", position: { x: 0, y: 0 } },
				...Array.from({ length: 3 }, (_, i) => ({
					id: `s${i}`, type: "image", title: `x${i}`, position: { x: 300, y: i * 30 },
				})),
			],
			edges: [0, 1, 2].map((i) => ({ source: "c", target: `s${i}` })),
		};
		const svg = buildLayoutSvg(small.nodes as never, small.edges as never, {
			drawEdges: true, scope: "detail", focus: "c", focusAnchor: "aggregate",
		});
		assert.equal((svg.match(/data-edge="1"/g) || []).length, 3, "3 条出边不该被聚合");
	});

	it("focus_anchor 非法值被拒（不静默回落）", async () => {
		const nodes = [{ id: "x", type: "prompt", title: "n", position: { x: 0, y: 0 } }];
		const t = makeTool({ nodes, edges: [] });
		const r = await run(t, { view: "layout", scope: "structure", focus_anchor: "nonsense" });
		assert.equal((r.details as { ok: boolean }).ok, false);
	});

	it("策略只影响局部视图（非 focus 时输出完全不变）", () => {
		const plain = buildLayoutSvg(FANOUT.nodes as never, FANOUT.edges as never, { drawEdges: true });
		for (const a of ["spread", "bus", "aggregate"]) {
			const withAnchor = buildLayoutSvg(FANOUT.nodes as never, FANOUT.edges as never, {
				drawEdges: true, focusAnchor: a as never,
			});
			assert.equal(withAnchor, plain, `非 focus 视图下 focus_anchor=${a} 不应改变输出`);
		}
	});
});
