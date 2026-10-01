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
	// write 核心链路
	"upsert_media_node",
	"upsert_prompt_node",
	"set_node_text",
	"update_node",
	"connect_nodes",
	"attach_refs",
	"apply_sidebar_attachments",
	"propose_generation",
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
	"focus_node",
	"focus_nodes",
	"undo",
	"redo",
	"open_image_editor",
	"arrange_nodes",
	"delete_nodes",
	"remove_edges",
	"save_memory",
];
const fakeTools = () =>
	ALL_NAMES.map((n) => fakeTool(n, n === "arrange_nodes" ? "整理画布节点布局" : undefined));

describe("buildToolEnsemble（官方 Dynamic Tool Loading：全注册 + 初始激活集）", () => {
	it("enabled：延迟工具必须留在 registered（vendor ai 层 deferred 机制的前提），activeToolNames 只含常驻 + tool_search", () => {
		const e = buildToolEnsemble(fakeTools(), true);
		const registered = new Set(e.registered.map((t) => t.name));
		for (const n of ALL_NAMES) assert.ok(registered.has(n), `${n} 必须注册进 config.tools`);
		const active = new Set(e.activeToolNames);
		for (const d of ["duplicate_node", "save_memory", "undo", "arrange_nodes", "delete_nodes"]) {
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
			"run_image_generation",
			"cancel_generation",
			"ask_user",
			"get_canvas_summary",
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

	it("关键词命中 → addedToolNames 只含延迟集命中项，content 确认", async () => {
		const { loader, deferredNames } = setup();
		const res = await run(loader, { query: "memory" });
		assert.ok(res.addedToolNames && res.addedToolNames.length > 0);
		for (const n of res.addedToolNames!) {
			assert.ok(deferredNames.includes(n), `${n} 必须来自延迟集（常驻工具不该被 loader 激活）`);
		}
		assert.ok(res.addedToolNames!.includes("save_memory"));
		const text = textOf(res);
		assert.match(text, /已加载/);
		assert.match(text, /save_memory/);
	});

	it("中文关键词命中（按摘要/描述匹配）：「整理」→ arrange_nodes", async () => {
		const { loader } = setup();
		const res = await run(loader, { query: "整理" });
		assert.ok(res.addedToolNames!.includes("arrange_nodes"));
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
		const again = await run(loader, { query: "memory" });
		assert.ok(again.addedToolNames!.includes("save_memory"));
	});

	it("多关键词 OR 匹配：「memory undo」同时命中两者", async () => {
		const { loader } = setup();
		const res = await run(loader, { query: "memory undo" });
		assert.ok(res.addedToolNames!.includes("save_memory"));
		assert.ok(res.addedToolNames!.includes("undo"));
	});
});

describe("tool_search 观测回调（host 喂 metrics 的钩子）", () => {
	it("hit：outcome=hit + activated=激活个数", async () => {
		const seen: Array<[string, number]> = [];
		const e = buildToolEnsemble(fakeTools(), true, (o, a) => seen.push([o, a]));
		const loader = e.registered.find((t) => t.name === "tool_search")!;
		await loader.execute("c1", { query: "memory" } as never, () => {}, undefined as never, {} as never, undefined as never);
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
			{ query: "memory" } as never,
			() => {},
			undefined as never,
			{} as never,
			undefined as never,
		);
		assert.ok(res.addedToolNames!.includes("save_memory"));
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
