import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { buildToolEnsemble, createLoadToolsTool, ALWAYS_ON_TOOL_NAMES } from "./tiering.js";
import type { LnkpiTool } from "./types.js";

/** 最小 LnkpiTool 替身（只补 buildToolEnsemble/tool_search 消费的字段）。 */
function fakeTool(name: string, summary?: string): LnkpiTool {
	return {
		tier: "read",
		name,
		label: name,
		description: summary ?? `desc of ${name}`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
	} as never;
}

/** 自定义 description 的替身（用于验证「只撞上 description 不算命中」）。 */
function fakeToolWithDesc(name: string, description: string): LnkpiTool {
	const base = fakeTool(name);
	return { ...base, description } as never;
}

/**
 * **生产真实 label/description 替身**（2026-10-06）。
 * ⚠️ 检索类测试必须用它而不是 `fakeTool`：`fakeTool` 的 label = name（英文），
 * 会掩盖「通用中文词命中另一个工具的中文 label」这类过召回 ——
 * 生产断言就是这么抓到 `query="把刚才的编辑撤销掉"` 误带出 `redo` 的。
 * 真实值取自 `ui-command.ts`（undo/redo）。
 */
function fakeToolReal(name: string, label: string, description: string): LnkpiTool {
	const base = fakeTool(name);
	return { ...base, label, description } as never;
}

const REAL_UNDO_REDO = () => [
	fakeToolReal("undo", "撤销上次画布编辑", "Undo the last local canvas edit (client undo stack)"),
	fakeToolReal("redo", "重做画布编辑", "Redo the last local canvas edit (client undo stack)"),
];

const ALL_NAMES = [
	// read
	"get_canvas_summary",
	"get_canvas_layout",
	"get_node",
	"get_generation_status",
	"get_generation_diagnostic",
	"list_generation_tasks",
	"list_user_assets",
	"list_model_options",
	"web_search",
	"web_fetch",
	"read_document",
	"recall_memory",
	// 记忆写（2026-10-03）：被 memory_scope.tail.md 直接约束，常驻
	"save_memory",
	// write 核心链路
	"upsert_media_node",
	"upsert_prompt_node",
	"set_node_text",
	"update_node",
	"connect_nodes",
	"attach_refs",
	"apply_sidebar_attachments",
	"propose_generation",
	// 以下为「资产点名」而常驻的工具（2026-10-03 生产取证：tool_search 触发率 0 ⇒ 延迟即不可达）
	// 画布编排：drama-* / ecommerce-product-photo 写死 arrange_nodes(along_edges)
	"arrange_nodes",
	// 生成参数预填：规则要求「建节点后落参数才叫完成」
	"set_node_generation_params",
	// 出图后定位：8 个 skill 的「出图后 QA 闸门」第一步
	"focus_node",
	// 错连修正：drama-qc-review 引用审计步骤点名
	"remove_edges",
	// gen
	"run_image_generation",
	"run_video_generation",
	"run_text_generation",
	"run_prompt_generation",
	"run_audio_generation",
	"cancel_generation",
	// 交互与元
	"ask_user",
	"load_skill",
	// 低频 / 资产 / 画布编排 / 破坏性（应被延迟）
	"duplicate_node",
	"upload_media_to_canvas",
	"save_node_to_asset_library",
	"apply_asset_to_node",
	"grid_slice_image",
	"introduce_nodes_to_agent",
	"focus_nodes", // ⚠️ 复数版与常驻的 focus_node 是两个工具（2026-10-06 起它自己也常驻）
	"undo",
	"redo",
	"open_image_editor",
	"delete_nodes",
];
const fakeTools = () =>
	ALL_NAMES.map((n) => fakeTool(n, n === "undo" ? "撤销上一步画布操作" : undefined));

describe("buildToolEnsemble（官方 Dynamic Tool Loading：全注册 + 初始激活集）", () => {
	it("enabled：延迟工具必须留在 registered（vendor ai 层 deferred 机制的前提），activeToolNames 只含常驻 + tool_search", () => {
		const e = buildToolEnsemble(fakeTools(), true);
		const registered = new Set(e.registered.map((t) => t.name));
		for (const n of ALL_NAMES) assert.ok(registered.has(n), `${n} 必须注册进 config.tools`);
		const active = new Set(e.activeToolNames);
		for (const d of ["duplicate_node", "undo", "delete_nodes", "redo"]) {
			assert.ok(!active.has(d), `${d} 初始不得激活`);
		}
		assert.ok(active.has("tool_search"));
		assert.equal(e.registered.length, ALL_NAMES.length + 1);
		assert.equal(e.activeToolNames.length, ALL_NAMES.filter((n) => ALWAYS_ON_TOOL_NAMES.has(n)).length + 1);
	});

	it("核心链路工具必须常驻（prompt 规则 4/5 引用的不可延迟）", () => {
		const e = buildToolEnsemble(fakeTools(), true);
		const names = new Set(e.activeToolNames);
		for (const n of [
			"upsert_media_node",
			"set_node_text",
			"connect_nodes",
			"apply_sidebar_attachments",
			"propose_generation",
			"arrange_nodes",
			"run_image_generation",
			"cancel_generation",
			"ask_user",
			"load_skill",
		]) {
			assert.ok(names.has(n), `${n} 必须常驻`);
		}
	});

	it("enabled=false：全量注册且全量激活、无 tool_search（kill switch 逐字节现状）", () => {
		const e = buildToolEnsemble(fakeTools(), false);
		assert.equal(e.registered.length, ALL_NAMES.length);
		assert.deepEqual(e.activeToolNames.slice().sort(), ALL_NAMES.slice().sort());
		assert.ok(!e.registered.some((t) => t.name === "tool_search"));
	});
});

/**
 * 回归锁：被「资产点名」的工具必须常驻。
 *
 * 依据 2026-10-03 生产取证（uptime 6.87h 窗口）：40 次工具调用全部落在常驻集，
 * `pi_runtime_tool_search_calls_total` 零 outcome 标签、`tool_search_activated_total 0`
 * ⇒ 官方 Dynamic Tool Loading 上线后 search 触发率仍为 0。
 * 凡 prompt 规则 / skills 按名字写成步骤的工具，进延迟集 = 模型直调即吃
 * immediateError "Tool X is unavailable" 且无恢复路径（见文件头注释与 PR #100 教训）。
 */
describe("被资产点名的工具必须常驻（延迟即不可达，回归锁）", () => {
	const NAMED_BY_ASSETS = [
		"arrange_nodes", // 8 个 skill 写死 arrange_nodes(along_edges)
		"set_node_generation_params", // 规则「建节点后落参数才叫完成」
		"save_memory", // memory_scope.tail.md 约束 scope；6 个 drama-* skill 编号步骤
		"focus_node", // 8 个 skill「出图后 QA 闸门」第一步
		"focus_nodes", // ⚠️ 复数版：规则 canvas_daily_ops 第 19 条点名（2026-10-06 从延迟集提上来）
		"remove_edges", // drama-qc-review 引用审计的错连修正
	];

	it("全部进 ALWAYS_ON 且初始即激活", () => {
		const e = buildToolEnsemble(fakeTools(), true);
		const active = new Set(e.activeToolNames);
		for (const n of NAMED_BY_ASSETS) {
			assert.ok(ALWAYS_ON_TOOL_NAMES.has(n), `${n} 必须在 ALWAYS_ON_TOOL_NAMES`);
			assert.ok(active.has(n), `${n} 必须初始激活`);
		}
	});

	it("它们不得出现在 tool_search 的延迟目录里（常驻工具不参与搜索）", async () => {
		const e = buildToolEnsemble(fakeTools(), true);
		const loader = e.registered.find((t) => t.name === "tool_search")!;
		const res = await loader.execute(
			"c1",
			{ query: " " } as never,
			() => {},
			undefined as never,
			{} as never,
			undefined as never,
		);
		const text = res.content[0].type === "text" ? (res.content[0].text ?? "") : "";
		for (const n of NAMED_BY_ASSETS) {
			assert.ok(!text.includes(`${n}：`), `${n} 不该出现在延迟目录`);
		}
	});

	// 2026-10-06 反转：原断言「focus_nodes 保持延迟」的前提是「未被 skill 点名」，
	// 但它漏了 prompt 规则 —— canvas_daily_ops 第 19 条点名了它 ⇒ 按准绳必须常驻。
	// 保留本用例是为了锁「两者是不同工具」，防止后人合并成 focus_node。
	it("focus_node / focus_nodes 是两个工具，且都常驻（规则第 19 条点名的是复数版）", () => {
		assert.ok(ALWAYS_ON_TOOL_NAMES.has("focus_nodes"), "focus_nodes 被规则第 19 条点名 ⇒ 必须常驻");
		assert.ok(ALWAYS_ON_TOOL_NAMES.has("focus_node"), "focus_node 被 6 个 skill 点名 ⇒ 常驻");
	});
});

describe("tool_search（官方 search_tools 语义：搜索 → addedToolNames 原生激活）", () => {
	const setup = () => {
		const e = buildToolEnsemble(fakeTools(), true);
		const loader = e.registered.find((t) => t.name === "tool_search")!;
		const deferredNames = ALL_NAMES.filter((n) => !ALWAYS_ON_TOOL_NAMES.has(n));
		return { loader, deferredNames };
	};
	const run = (loader: LnkpiTool, p: unknown) =>
		loader.execute("call-1", p as never, () => {}, undefined as never, {} as never, undefined as never);
	const textOf = (res: { content: Array<{ type: string; text?: string }> }) =>
		res.content[0].type === "text" ? (res.content[0].text ?? "") : "";

	// 用 delete_nodes 做替身：save_memory 已于 2026-10-03 改为常驻，不再属于延迟集。
	it("关键词命中 → addedToolNames 只含延迟集命中项，content 确认", async () => {
		const { loader, deferredNames } = setup();
		const res = await run(loader, { query: "delete" });
		assert.ok(res.addedToolNames && res.addedToolNames.length > 0);
		for (const n of res.addedToolNames!) {
			assert.ok(deferredNames.includes(n), `${n} 必须来自延迟集（常驻工具不该被 loader 激活）`);
		}
		assert.ok(res.addedToolNames!.includes("delete_nodes"));
		const text = textOf(res);
		assert.match(text, /已加载/);
		assert.match(text, /delete_nodes/);
	});

	it("常驻工具不参与搜索（query 命中常驻名字也不得被再次激活）", async () => {
		const { loader, deferredNames } = setup();
		assert.ok(!deferredNames.includes("save_memory"), "前提：save_memory 不在延迟集");
		const res = await run(loader, { query: "save_memory" });
		assert.ok(!res.addedToolNames || res.addedToolNames.length === 0, "常驻工具不该被 loader 激活");
	});

	it("中文关键词命中（按摘要/描述匹配）：「撤销」→ undo", async () => {
		const { loader, deferredNames } = setup();
		const res = await run(loader, { query: "撤销" });
		assert.ok(deferredNames.includes("undo"), "undo 必须仍在延迟集，否则本用例失去意义");
		assert.ok(res.addedToolNames!.includes("undo"));
	});

	// 2026-10-06 修复（capability-map 发现 C）：中文查询没有空格，整句 includes 必然 miss
	// ⇒ 中文 token 再切 2-gram。以下三条在修复前都会 miss。
	it("中文长句不再 miss：「撤销操作」→ undo", async () => {
		const { loader } = setup();
		const res = await run(loader, { query: "撤销操作" });
		assert.ok(res.addedToolNames!.includes("undo"), "「撤销操作」应命中 undo（2-gram 含「撤销」）");
	});

	// ⚠️ 此用例已从 setup()（替身 label = name，英文）换成**生产真实中文 label**：
	// 相对阈值按「命中 gram 数」判定证据量，英文 label 的替身会低估中文查询的命中质量，
	// 造成假绿/假红。真实 label 下 undo 命中「撤销」+「编辑」= 4 分 ≥ 阈值 3。
	it("中文整句不再 miss：「把刚才的编辑撤销掉」→ undo", async () => {
		const loader = createLoadToolsTool(REAL_UNDO_REDO());
		const res = await run(loader, { query: "把刚才的编辑撤销掉" });
		assert.ok(res.addedToolNames!.includes("undo"), "整句应命中 undo（真实 label 下证据量充足）");
	});

	// 反向护栏：2-gram 让召回变宽，必须有阈值兜住「只撞上英文 description」的误激活。
	// 真实 redo 的 description 含 "undo stack"（query "undo" 曾把它一起激活）。
	it("只命中 description 不算数：权重 1 < 阈值 2 ⇒ 不激活", async () => {
		const loader = createLoadToolsTool([
			fakeToolWithDesc("undo_like", "Undo the last edit (client undo stack)"),
			fakeToolWithDesc("redo_like", "Redo the last edit (client undo stack)"),
		]);
		const res = await run(loader, { query: "undo" });
		const names = res.addedToolNames ?? [];
		assert.ok(names.includes("undo_like"), "name 命中（权重 3）应激活");
		assert.ok(!names.includes("redo_like"), "仅 description 命中（权重 1）不该激活");
	});

	// 生产取证（2026-10-06，真实 dist 断言）暴露的过召回，单测用真实 label 复现并锁住。
	// 绝对阈值下「编辑」命中 redo 的中文 label「重做画布编辑」⇒ 多激活一个无关工具。
	it("长查询不得过召回（生产取证回归）：「把刚才的编辑撤销掉」只命中 undo", async () => {
		const loader = createLoadToolsTool(REAL_UNDO_REDO());
		const res = await run(loader, { query: "把刚才的编辑撤销掉" });
		assert.deepEqual(res.addedToolNames, ["undo"], "只命中 1 个通用词的 redo 应被相对阈值排除");
	});

	it("短中文查询不受相对阈值影响：「撤销操作」「撤销」都命中 undo", async () => {
		const loader = createLoadToolsTool(REAL_UNDO_REDO());
		for (const q of ["撤销操作", "撤销"]) {
			const res = await run(loader, { query: q });
			assert.ok(res.addedToolNames!.includes("undo"), `「${q}」应命中 undo`);
		}
	});

	it("英文短词仍不得带出同类工具：'undo' 只命中 undo", async () => {
		const loader = createLoadToolsTool(REAL_UNDO_REDO());
		const res = await run(loader, { query: "undo" });
		assert.deepEqual(res.addedToolNames, ["undo"]);
	});

	it("未命中 → 文本给完整目录（可点名再试），不激活", async () => {
		const { loader, deferredNames } = setup();
		const res = await run(loader, { query: "no_such_capability_xyz" });
		assert.ok(!res.addedToolNames || res.addedToolNames.length === 0);
		const text = textOf(res);
		assert.match(text, /没有匹配/);
		for (const n of deferredNames.slice(0, 5)) assert.match(text, new RegExp(n));
	});

	it("空 query → 文本给目录，不激活", async () => {
		const { loader } = setup();
		const res = await run(loader, { query: "  " });
		assert.ok(!res.addedToolNames || res.addedToolNames.length === 0);
		assert.match(textOf(res), /可选工具目录/);
	});

	it("重复调用幂等：命中再次搜索照常返回（激活集合由 vendor 去重）", async () => {
		const { loader } = setup();
		const again = await run(loader, { query: "delete" });
		assert.ok(again.addedToolNames!.includes("delete_nodes"));
	});

	it("多关键词 OR 匹配：「duplicate undo」同时命中两者", async () => {
		const { loader } = setup();
		const res = await run(loader, { query: "duplicate undo" });
		assert.ok(res.addedToolNames!.includes("duplicate_node"));
		assert.ok(res.addedToolNames!.includes("undo"));
	});
});

describe("tool_search 观测回调（host 喂 metrics 的钩子）", () => {
	it("hit：outcome=hit + activated=激活个数", async () => {
		const seen: Array<[string, number]> = [];
		const e = buildToolEnsemble(fakeTools(), true, (o, a) => seen.push([o, a]));
		const loader = e.registered.find((t) => t.name === "tool_search")!;
		await loader.execute("c1", { query: "delete" } as never, () => {}, undefined as never, {} as never, undefined as never);
		assert.equal(seen.length, 1);
		assert.equal(seen[0][0], "hit");
		assert.ok(seen[0][1] >= 1);
	});

	it("miss / empty：activated=0", async () => {
		const seen: Array<[string, number]> = [];
		const e = buildToolEnsemble(fakeTools(), true, (o, a) => seen.push([o, a]));
		const loader = e.registered.find((t) => t.name === "tool_search")!;
		await loader.execute("c1", { query: "no_such_xyz" } as never, () => {}, undefined as never, {} as never, undefined as never);
		await loader.execute("c2", { query: "  " } as never, () => {}, undefined as never, {} as never, undefined as never);
		assert.deepEqual(seen, [
			["miss", 0],
			["empty", 0],
		]);
	});

	it("不传回调：execute 正常工作（向后兼容）", async () => {
		const e = buildToolEnsemble(fakeTools(), true);
		const loader = e.registered.find((t) => t.name === "tool_search")!;
		const res = await loader.execute(
			"c3",
			{ query: "delete" } as never,
			() => {},
			undefined as never,
			{} as never,
			undefined as never,
		);
		assert.ok(res.addedToolNames!.includes("delete_nodes"));
	});
});

describe("loader 描述（官方模式：description 承担发现能力，无 system prompt 名单）", () => {
	it("loader 描述说明搜索语义，提及未加载/搜索", () => {
		const e = buildToolEnsemble(fakeTools(), true);
		const loader = e.registered.find((t) => t.name === "tool_search")!;
		assert.match(loader.description, /搜索/);
		assert.match(loader.description, /未加载/);
	});
});

describe("render_canvas_view 常驻", () => {
	it("必须在 ALWAYS_ON_TOOL_NAMES 内（延迟工具触发率为 0，延迟即不可达）", () => {
		assert.equal(ALWAYS_ON_TOOL_NAMES.has("render_canvas_view"), true);
	});
});

/**
 * 2026-10-06 减点名下沉回归锁（R1，roadmap P1「常驻 ≤28」第一批）。
 *
 * 以下 9 个读类诊断工具已同步撤掉全部下发侧点名：
 * - prompt 规则 20/21（canvas_daily_ops）改写为能力描述 + tool_search 指引；
 * - prompt 规则 12（gen_tool_policy）删去 get_generation_status 名字；
 * - 4 个 skill（drama-qc-review / drama-storyboard / ecommerce-product-photo /
 *   drama-audio-design）的点名改为「先 tool_search 搜读工具」。
 * 按准绳（点名 ⇒ 常驻；未点名 ⇒ 可延迟），它们现在必须**不在** ALWAYS_ON：
 * 若有人恢复常驻而不同步撤点名，本用例不拦（常驻是保守方向）；
 * 但若有人**撤了规则点名却忘了下沉**（或反之），上下文白名单与资产就会漂移。
 * 判据（唯一）：`pi_runtime_tool_search_calls_total{outcome="hit"}` 出现 > 0 ⇒ 扩到全量。
 * **2026-10-06 实测结果：hit = 6、miss/empty = 0**（无常驻替代品的探针 4/4 主动搜索命中）
 * ⇒ 扩到本批全量 9 个（见 tiering.ts 文件头「分级下发实验已做完」）。
 */
describe("减点名下沉：读类诊断 9 工具必须延迟（2026-10-06，已由分级下发实验支持）", () => {
	// 2026-10-07：`get_canvas_summary` 已从本清单移出（提回常驻，见下方 describe）
	const DEMOTED = [
		"get_canvas_layout",
		"get_node",
		"list_generation_tasks",
		"get_generation_status",
		"get_generation_diagnostic",
		"list_user_assets",
		"read_document",
		"list_model_options",
	];

	it("全部不在 ALWAYS_ON_TOOL_NAMES（下沉生效）", () => {
		for (const n of DEMOTED) {
			assert.ok(!ALWAYS_ON_TOOL_NAMES.has(n), `${n} 应已下沉（点名已撤，见 canvas_daily_ops 20/21 改写）`);
		}
	});

	// ⭐ 2026-10-07 回归锁：get_canvas_summary 必须常驻。
	// 它的 description 自己写着「Call this first to understand the canvas」，却因减点名被下沉
	// ⇒ 模型拿不到 schema ⇒ 生产实测退化成逐个 get_node（一次会话 10+ 次，244k tokens）。
	// 它零规则/skill 点名（符合 catalog §2 判据），提回常驻代价极小。
	it("get_canvas_summary 必须常驻（2026-10-07：防再次被下沉）", () => {
		assert.ok(
			ALWAYS_ON_TOOL_NAMES.has("get_canvas_summary"),
			"get_canvas_summary 是画布读的入口（自称 Call this first），下沉会让模型退化成逐节点查询",
		);
	});

	it("下沉后仍在延迟目录可被搜到（query 命中名字片段 → get_canvas_layout 等）", async () => {
		const e = buildToolEnsemble(fakeTools(), true);
		const loader = e.registered.find((t) => t.name === "tool_search")!;
		const res = await loader.execute(
			"c-demote",
			{ query: "get_canvas" } as never,
			() => {},
			undefined as never,
			{} as never,
			undefined as never,
		);
		const names = res.addedToolNames ?? [];
		// 2026-10-07：`get_canvas_summary` 已提回常驻（不再在延迟目录，故不在此处断言）
		assert.ok(!names.includes("get_canvas_summary"), "get_canvas_summary 已常驻，不该经搜索激活");
		assert.ok(names.includes("get_canvas_layout"), "「get_canvas」应命中 get_canvas_layout");
	});

	it("真实场景可搜性：中文 label 的下沉工具按中文关键词命中（搜「画布概览」）", async () => {
		const e = buildToolEnsemble(
			ALL_NAMES.map((n) =>
				// 2026-10-07：改测仍在延迟集的 `get_canvas_layout`
				// （`get_canvas_summary` 已提回常驻，不再依赖搜索命中）
				n === "get_canvas_layout" ? fakeToolWithDesc(n, "画布概览：节点清单与统计") : fakeTool(n),
			),
			true,
		);
		const loader = e.registered.find((t) => t.name === "tool_search")!;
		const res = await loader.execute(
			"c-demote-cjk",
			{ query: "画布概览" } as never,
			() => {},
			undefined as never,
			{} as never,
			undefined as never,
		);
		assert.ok((res.addedToolNames ?? []).includes("get_canvas_layout"));
	});
});
