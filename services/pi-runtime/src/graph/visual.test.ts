/**
 * D3-3 视觉语言断言（配色 / 虚框 / 对比度）。
 *
 * ⭐ 为什么单独一个文件：黄金快照只能证明「输出没变」，**不能证明「新规则真的生效」**
 *   —— 一个恒返回输入的 `nodeRect` 也能让逐字节快照保持不变。D3-3 改的正是
 *   「像素级外观」，所以它的判据必须落在**规则本身**上，而不是字节上。
 *
 * ⛔ 本文件不改任何输出，只观察。颜色值全部从 `graph/palette.ts` 取，
 *   不断言写死的 hex —— 写死 hex 的话「改了调色板」和「忘了改断言」会互相掩盖。
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
	CARD_BG,
	CONTAINER_DASH,
	NODE_FILL,
	NODE_STROKE,
	SEVERITY,
	TEXT_FILL,
} from "./palette.js";
import { BASE3, MIXED6, svgOfCase, TREE5 } from "./snapshot.js";

/** 相对亮度（WCAG 2.1 定义）。 */
function luminance(hex: string): number {
	const m = /^#([0-9a-f]{6})$/i.exec(hex);
	assert.ok(m, `不是 6 位 hex：${hex}`);
	const n = parseInt(m[1], 16);
	const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.2992 * ch[2]!;
}

/** WCAG 对比度（1:1 ~ 21:1）。 */
function contrast(a: string, b: string): number {
	const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (l1 + 0.05) / (l2 + 0.05);
}

/**
 * 只取**节点框**（含描边/底色的 rect），排除色条、图例、容器、卡片底。
 *
 * ⭐ 为什么不能直接 `svg.includes(color)`：调色板常量同时出现在 CSS 类、
 *   `.w` 警示文本、容器描边上（`CONTAINER_STROKE` 与节点描边同源），
 *   全局搜会命中非节点元素 ⇒ 「节点用了强调色」这种判据会假绿。
 *   反过来我最初写「assert(!svg.includes(error))」也踩了同一个坑（假红）。
 */
/** D3-3 节点框用的 class（fill/stroke/stroke-width 全在 CSS 里，见 buildCssRules）。 */
const NODE_CLASSES = ["nv", "nvE", "nvW", "nvx"] as const;

/**
 * 只取**节点框** rect，排除色条 / 图例 / 容器 / 卡片底。
 *
 * ⭐ 为什么不能直接 `svg.includes(color)`：调色板常量同时出现在 CSS 类、
 *   `.w` 警示文本、容器描边上，全局搜会命中非节点元素 ⇒ 判据会假绿/假红。
 *   反过来我最初写「assert(!svg.includes(error))」也踩了同一个坑。
 */
function nodeRects(svg: string): string[] {
	return [...svg.matchAll(/<rect [^>]*class="(?:nv|nvE|nvW|nvx)"[^>]*\/>/g)].map((m) => m[0]);
}

/**
 * 数**顶部类型色条**的条数。
 *
 * ⭐ D3-3 字节优化后色条不再是 `<rect>`，而是「每种颜色一个 `<path>`，
 *   多个矩形用 `M…h…v4h-…z` 拼在同一条 `d` 里」（63 节点 3747B → ~1200B）。
 *   ⇒ 必须数**子路径**（按 `M` 切分），不能数 `<path>` 个数（后者 = 颜色数，不是节点数）。
 */
function typeBarSegments(svg: string): number {
	let n = 0;
	for (const m of svg.matchAll(/<path class="cf[a-z0-9]+" d="([^"]*)"/g)) {
		n += m[1].split("M").filter(Boolean).length;
	}
	return n;
}

/**
 * 取出 SVG 里**全部** `<style>` 的 CSS 文本。
 *
 * ⛔ 渲染层输出**两个** `<style>`：`buildCssRules()`（配色）与 `svgTail()`（排版）。
 *   单个 `match` 只拿到第一个 ⇒ 查第二个里的任何 class 都会**恒假**。
 */
function allCss(svg: string): string {
	return [...svg.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("");
}

/**
 * 节点框的**视觉身份**（class ⇒ 其 CSS 规则里的 stroke 色）。
 * ⭐ 必须查 CSS 块来解析 —— D3-3 起描边从内联 hex 改成 class 引用（省 2.4KB），
 *   所以从 rect 上读不到颜色了。这条链路本身就是「省字节没牺牲表达」的判据。
 */
function nodeStrokes(svg: string): string[] {
	const css = /<style>([\s\S]*?)<\/style>/.exec(svg)?.[1] ?? "";
	const colorOf = (cls: string): string | undefined =>
		new RegExp(`\\.${cls}\\{[^}]*stroke:(#[0-9A-Fa-f]{6})`).exec(css)?.[1];
	return nodeRects(svg)
		.map((r) => colorOf(/class="([^"]+)"/.exec(r)?.[1] ?? ""))
		.filter((x): x is string => x !== undefined);
}

describe("D3-3 三层配色：节点中性底 + 顶部类型色条", () => {
	test("节点边界靠**描边**而非底色差（浅色主题下唯一达标路径）", async () => {
		const svg = await svgOfCase({ view: "layout" }, BASE3);
		const boxes = nodeRects(svg);
		assert.ok(boxes.length > 0, "没匹配到任何节点框");
		for (const b of boxes) {
			assert.ok(/class="(?:nv|nvE|nvW|nvx)"/.test(b), `节点框 class 不对：${b}`);
			assert.ok(!/fill="/.test(b), `节点框仍内联 fill（应用 class 省字节）：${b}`);
		}
		assert.ok(svg.includes(`.nv{fill:${NODE_FILL}`), "CSS 里 .nv 未绑定白底");
		// ⭐ 判据是描边对比度，不是底色差。白 vs #F7F8FA 只有 1.06:1，
		//   任何「靠底色分层」的方案在浅色主题里都不可能达标。
		const c = contrast(NODE_STROKE, NODE_FILL);
		assert.ok(c >= 3, `节点描边 vs 节点底对比度 ${c.toFixed(2)} < 3:1`);
		// 描边必须在节点框上真实出现（不是只定义了一个常量）
		assert.ok(nodeStrokes(svg).includes(NODE_STROKE), "节点框上没有 NODE_STROKE 描边");
		// ⭐ 且 class 必须在 CSS 块里被定义（防「class 写了但 CSS 没发」= 静默无样式）
		assert.ok(svg.includes(`.nv{`), "CSS 块缺 .nv 规则");
	});

	test("每个节点框顶部都有一条 4px 类型色条（主色的唯一载体）", async () => {
		const svg = await svgOfCase({ view: "layout" }, BASE3);
		const boxes = nodeRects(svg);
		// ⭐ D3-3 字节优化：色条从「每节点一个 `<rect height="4">`」改成
		//   「每种颜色一个 `<path>`，多个矩形拼在同一条 `d` 里」（63 节点 3747B → ~1200B）。
		//   ⇒ 判据从「数 rect 个数」改成「数 `d` 里的矩形子路径个数」，且仍要断言
		//   **条数 == 节点框数**（不能只查「有色条」—— 那会在漏渲染时假绿）。
		const bars = typeBarSegments(svg);
		assert.equal(bars, boxes.length, `色条 ${bars} ≠ 节点框 ${boxes.length}`);
		assert.ok(bars > 0, "一个色条都没有");
		// 每条色条必须是 4px 高（`v4`）且闭合（`z`）
		for (const m of svg.matchAll(/<path class="cf[a-z0-9]+" d="([^"]*)"/g)) {
			const segs = m[1].split("M").filter(Boolean);
			for (const s of segs) {
				assert.ok(/v4h[\d.-]+z$/.test(s), `色条几何不对（应 4px 高且闭合）：${s}`);
			}
		}
	});

	test("⛔ 色条只承载主色：节点框描边不得是类型色 class", async () => {
		const svg = await svgOfCase({ view: "layout" }, BASE3);
		// 迁移前节点框是 `class="cf<X> cs<X> n"`（整框类型色）。
		// 现在框是白底 + 内联中性描边，类型色只留顶部色条 ⇒ 不该再有 cs 类。
		for (const b of nodeRects(svg)) {
			assert.ok(!/\bcs[a-z0-9]\b/.test(b), `节点框仍带类型描边 class：${b}`);
			assert.ok(!/stroke="/.test(b), `节点框仍内联描边色：${b}`);
		}
	});
});

describe("D3-3 容器一律虚框（§4.2(2)：实线会被误读成节点）", () => {
	test("swimlane 泳道框与阶段头都是虚线", async () => {
		const svg = await svgOfCase({ view: "swimlane", groupBy: "type" }, MIXED6);
		// ⭐ D3-3 字节优化：虚框的 fill/stroke/dasharray 全走 class（内联 124B/容器 ⇒ 993B）。
		//   判据必须查**CSS 规则**而不是元素上的内联属性。
		const css = allCss(svg);
		assert.match(css, /\.cb\{[^}]*stroke-dasharray:/, "swimlane 阶段头（.cb）无虚框");
		assert.match(css, /\.cg\{[^}]*stroke-dasharray:/, "swimlane 泳道（.cg）无虚框");
		// ⛔ 容器元素上不得再出现内联 dasharray（说明还有漏改的）
		assert.equal(
			svg.includes(`stroke-dasharray="${CONTAINER_DASH}"`) && !svg.includes("class=\"cb\"") && !svg.includes("class=\"cg\""),
			false,
			"容器仍有内联 dasharray",
		);
		// ⚠️ matrix 单元格按 on/off 变两套配色，暂未 class 化，它**应该**还有内联 dasharray
		//（保留这条注释，避免后人误以为 matrix 漏改了）
	});

	test("matrix 单元格虚框（它是最容易被误读成节点的容器）", async () => {
		const svg = await svgOfCase({ view: "matrix", rowBy: "type", colBy: "status" }, MIXED6);
		assert.ok(svg.includes(`stroke-dasharray="${CONTAINER_DASH}"`), "matrix 无虚框");
	});
});

describe("D3-3 对比度（§4.2(3)：WCAG AA）", () => {
	test("节点标签文本 vs 节点底色 ≥ 4.5:1", () => {
		const c = contrast(TEXT_FILL, NODE_FILL);
		assert.ok(c >= 4.5, `文本对比度 ${c.toFixed(2)} < 4.5:1`);
	});

	test("severity 两档描边 vs 节点底色 ≥ 3:1（图形元素门槛）", () => {
		for (const [k, v] of Object.entries(SEVERITY)) {
			const c = contrast(v.stroke, NODE_FILL);
			assert.ok(c >= 3, `severity.${k} 描边对比度 ${c.toFixed(2)} < 3:1`);
		}
	});

	test("⭐ error / warn 必须靠色相可区分（亮度接近是刻意的，见 palette 注释）", () => {
		// ⚠️ 不用「亮度差」当判据：红/琥珀同属暖色族，业界惯例就是靠色相区分
		//   （GitHub / Jenkins 徽标如此）。若强行拉开亮度，warn 会变成又暗又黄的褐。
		const h = (x: string): number => {
			const n = parseInt(x.slice(1), 16);
			const r = ((n >> 16) & 255) / 255;
			const g = ((n >> 8) & 255) / 255;
			const b = (n & 255) / 255;
			const mx = Math.max(r, g, b);
			const mn = Math.min(r, g, b);
			return mx === mn ? 0 : (mx - mn) / mx;
		};
		const se = h(SEVERITY.error.stroke);
		const sw = h(SEVERITY.warn.stroke);
		assert.ok(se > 0.4 && sw > 0.4, `两档饱和度不足：error ${se.toFixed(2)} / warn ${sw.toFixed(2)}`);
		assert.notEqual(SEVERITY.error.stroke, SEVERITY.warn.stroke);
	});
});

describe("D3-3 severity 强调描边（消费端最小形态）", () => {
	const SEV_ERR = { kind: "severity", data: [{ node_id: "n2", level: "error" }] };

	test("error 节点用 SEVERITY.error 描边，且只出现在被强调节点上", async () => {
		const svg = await svgOfCase({ view: "layout", overlay: SEV_ERR }, BASE3);
		// ⭐ 判据落在**节点框的描边**上，不是全局搜色（CSS 与 .w 文本里也有这个色）。
		const strokes = nodeStrokes(svg);
		assert.ok(strokes.includes(SEVERITY.error.stroke), "被强调节点未用 error 描边");
		// 3 节点 ⇒ cap=1 ⇒ 恰好 1 个节点被强调
		assert.equal(strokes.filter((s) => s === SEVERITY.error.stroke).length, 1, "强调节点数不为 1");
		assert.equal(strokes.filter((s) => s === NODE_STROKE).length, 2, "未强调节点数不为 2");
	});

	test("warn 不画成 error 色（级别贴错 = 在图上编造严重度）", async () => {
		const svg = await svgOfCase(
			{ view: "layout", overlay: { kind: "severity", data: [{ node_id: "n2", level: "warn" }] } },
			BASE3,
		);
		const strokes = nodeStrokes(svg);
		assert.ok(strokes.includes(SEVERITY.warn.stroke), "warn 节点未用 warn 描边");
		assert.ok(!strokes.includes(SEVERITY.error.stroke), "warn 被画成了 error 描边");
	});

	test("⛔ 未知级别（如 critical）不产生任何强调描边（不 `as` 强转成 error）", async () => {
		const svg = await svgOfCase(
			{
				view: "layout",
				overlay: { kind: "severity", data: [{ node_id: "n2", level: "critical" }] },
			},
			BASE3,
		);
		const strokes = nodeStrokes(svg);
		assert.ok(!strokes.includes(SEVERITY.error.stroke), "未知级别被当成 error 上色了");
		assert.ok(!strokes.includes(SEVERITY.warn.stroke), "未知级别被当成 warn 上色了");
		// 全部退回中性描边
		assert.equal(strokes.filter((s) => s === NODE_STROKE).length, 3);
	});

	test("不传 overlay ⇒ 全部节点走中性描边（黄金快照的前提）", async () => {
		const svg = await svgOfCase({ view: "layout" }, BASE3);
		const strokes = nodeStrokes(svg);
		assert.ok(strokes.every((s) => s === NODE_STROKE), `出现非中性描边：${strokes.join(",")}`);
	});
});

describe("D3-3 失败态角标（状态信号不因配色改造而丢失）", () => {
	test("status=failed 的节点带失败角标，正常节点不带", async () => {
		const svg = await svgOfCase(
			{ view: "layout" },
			{
				nodes: [
					{ id: "a", title: "A", type: "prompt", status: "failed" },
					{ id: "b", title: "B", type: "prompt", status: "completed" },
					{ id: "c", title: "C", type: "prompt", status: "draft" },
				],
				edges: [],
			},
		);
		const badges = [...svg.matchAll(/<g data-node="([^"]+)"[^>]*>((?:(?!<\/g>).)*)/g)].filter((m) =>
			m[2]!.includes('data-fail="1"'),
		);
		assert.equal(badges.length, 1, `失败角标数 ${badges.length}，应为 1`);
		assert.ok(badges[0]![1]!.includes("a"), `角标贴错了节点：${badges[0]![1]}`);
	});

	test("⛔ 角标与 severity 描边正交：failed + error 同时成立，两者都要在", async () => {
		const svg = await svgOfCase(
			{ view: "layout", overlay: { kind: "severity", data: [{ node_id: "a", level: "error" }] } },
			{
				nodes: [
					{ id: "a", title: "A", type: "prompt", status: "failed" },
					{ id: "b", title: "B", type: "prompt", status: "completed" },
					{ id: "c", title: "C", type: "prompt", status: "completed" },
				],
				edges: [],
			},
		);
		assert.ok(svg.includes('data-fail="1"'), "失败角标丢失");
		assert.ok(nodeStrokes(svg).includes(SEVERITY.error.stroke), "error 强调描边丢失");
	});
});

describe("SVG 必须能被 XML 解析器吃下（无值属性 = 整图不渲染）", () => {
	/**
	 * ⛔⛔ 为什么这条独立成suite 而不是塞进配色断言里
	 *
	 * SVG 有**两种解析模式**：
	 * - HTML 解析器（浏览器里`<img src=x.svg>` 走的就是这条）：对无值属性**容错**
	 * - XML 解析器（`DOMParser` / `xmllint` / 某些前端框架的 innerHTML）：**规范错误**
	 *
	 * 写 `data-x`（无值）在HTML 下看着没事，切到 XML 就报：
	 *   `error on line 1: Specification mandates value for attribute data-x`
	 *   ⇒ **整张图渲染中断**（只剩红错框 + 首个错误之前的片段）。
	 *
	 * #296（D2 迁移）引入的 `data-x` / `data-o` 一直是无值的，
	 * 从 2026-10-08 合入到 2026-10-09 被发现，**跨了一整天没人看见**——
	 * 因为所有既有测试都在比字节/比 class，没人会去「用 XML 解析一遍」。
	 */
	test("⛔ 不得出现无值属性（data-x / data-o 都必须带 =\"1\"）", async () => {
		// ⛔ fixture 必须**真的触发** data-x，否则这条断言是空转。
		//   （第一版用 MIXED6 —— 6 个节点坐标递增、无编号标题 ⇒ 渲染结果里一个 data-x
		//     都没有，变异回无值属性后测试**依然全绿**，是典型假绿。）
		// ⛔ 标题必须带 `EPnn` 编号：`auditOrder` 的业务序是从 **title** 解析的
		//   （见 expressive.ts `auditOrder`），写「第一/第二」解析不出序号 ⇒ 不判错位。
		//   画布 y 乱序（300/100/200/50）+ 编号递增（01/02/03/04）⇒ 恰好触发错位。
		const TRIGGER = {
			nodes: [
				{ id: "t1", type: "prompt", title: "EP01 开头", position: { x: 0, y: 300 } },
				{ id: "t2", type: "prompt", title: "EP02 第二", position: { x: 0, y: 100 } },
				{ id: "t3", type: "image", title: "EP03 第三", position: { x: 0, y: 200 } },
				{ id: "t4", type: "image", title: "EP04 第四", position: { x: 0, y: 50 } },
			],
			edges: [{ source: "t1", target: "t2" }, { source: "t2", target: "t3" }],
		};
		for (const view of ["layout", "tree", "swimlane", "matrix", "timeline"] as const) {
			const svg = await svgOfCase({ view } as never, TRIGGER);
			// `<g ... data-x`（后面是空格或 >）而不是 `data-x="..."`
			const bare = [...svg.matchAll(/\s(data-[a-z-]+)(?=[\s/>])/g)].map((m) => m[1]);
			assert.deepEqual(
				[...new Set(bare)],
				[],
				`view=${view} 有无值属性 ${JSON.stringify([...new Set(bare)])} ⇒ XML 解析时会整图渲染失败`,
			);
		}
		// ⛔ 自检：fixture 必须真的含 data-x，否则上面那条是空转。
		//   （变异验证：把 `data-x="1"` 改回无值 `data-x`，本测试转红 ⇒ 判据有效。）
		for (const view of ["layout", "tree"] as const) {
			const svg = await svgOfCase({ view } as never, TRIGGER);
			assert.match(svg, /data-x="1"/, `fixture 没在 view=${view} 触发错位标记 data-x ⇒ 无值属性断言覆盖不到`);
		}
		// ⚠️ `data-o`（孤儿标记）当前 fixture 触发不到 —— tree 的孤儿判定基于 IR containment，
		//   完全孤立的节点仍会被当作根。它与 data-x 是同一段代码的同一个模板，
		//   data-x 的变异验证已覆盖这条路径；等能稳定造出孤儿 fixture 再补断言。
	});

	test("⛔ 整图能被严格 XML 解析器解析（端到端判据，不靠正则猜）", async () => {
		// 正则只能查出「已知的那几个」；这一条用真解析器兜住**所有**未来的无值属性。
		// ⚠️ fixture 必须真含错位节点（标题带 EP 编号 + 画布 y 乱序），否则测不到 data-x。
		const svg = await svgOfCase({ view: "tree" }, {
			nodes: [
				{ id: "t1", type: "prompt", title: "EP01 开头", position: { x: 0, y: 300 } },
				{ id: "t2", type: "prompt", title: "EP02 第二", position: { x: 0, y: 100 } },
				{ id: "t3", type: "image", title: "EP03 第三", position: { x: 0, y: 200 } },
			],
			edges: [{ source: "t1", target: "t2" }, { source: "t2", target: "t3" }],
		});
		const tmp = join(tmpdir(), `svg-xmlcheck-${process.pid}.svg`);
		writeFileSync(tmp, svg, "utf8");
		try {
			// xmllint --noout = 只做良构性检查，不取 DTD/联网
			execFileSync("xmllint", ["--noout", tmp], { stdio: "pipe" });
		} catch (e) {
			const err = e as { code?: string; stderr?: Buffer; stdout?: Buffer; message?: string };
			// ⛔⛔ 必须区分「工具不存在」与「XML 真不合法」
			//   （2026-10-09 实踩：CI 的 ubuntu-latest 不自带 xmllint，
			//    ENOENT 混进 catch 后被报成「xmllint 报 XML 不合法」——
			//    错误归因完全错位，害我差点去改渲染代码。）
			//   也绝不能 skip 成假绿：这条是唯一兜住「无值属性」的判据，
			//   一旦工具缺失就静默跳过 ⇒ 缺陷可无声回归（正是它当初漏了一整天）。
			//   正确处置 = 响亮失败 + 指明装法；CI 侧已在 ci.yml 装 libxml2-utils。
			if (err.code === "ENOENT") {
				assert.fail(
					"xmllint 不存在（ENOENT），XML 良构性判据未执行 —— 这不是通过，是没测到。\n" +
						"macOS 自带；Debian/Ubuntu: sudo apt-get install -y libxml2-utils\n" +
						"（CI 已在 .github/workflows/ci.yml 显式安装；若此处失败说明该配置被移除）",
				);
			}
			assert.fail(
				`xmllint 报 XML 不合法（view=tree）：\n${err.stderr?.toString() ?? err.stdout?.toString() ?? err.message ?? String(e)}`,
			);
		} finally {
			rmSync(tmp, { force: true });
		}
	});
});

describe("D3-3 覆盖全部图形视图（不能只改一个）", () => {
	test("tree / swimlane 与 layout 同样有白底 + 中性描边 + 顶部色条", async () => {
		for (const view of ["tree", "swimlane"] as const) {
			const svg = await svgOfCase({ view }, view === "tree" ? TREE5 : MIXED6);
			const boxes = nodeRects(svg);
			assert.ok(boxes.length > 0, `${view} 未匹配到节点框`);
			assert.ok(nodeStrokes(svg).every((c) => c === NODE_STROKE), `${view} 未用中性描边`);
			// ⭐ 色条已是 `<path>` 聚合形态（见 `typeBarSegments`），且条数须等于节点框数
			assert.equal(typeBarSegments(svg), boxes.length, `${view} 色条数 ≠ 节点框数`);
		}
	});
});