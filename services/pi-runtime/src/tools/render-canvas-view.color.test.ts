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
