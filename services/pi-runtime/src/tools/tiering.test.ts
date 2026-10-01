import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { splitTools, buildDeferredIndexBlock, ALWAYS_ON_TOOL_NAMES } from "./tiering.js";
import type { LnkpiTool } from "./types.js";

/** 最小 LnkpiTool 替身（只补 splitTools/load_tools 消费的字段）。 */
function fakeTool(name: string): LnkpiTool {
	return {
		tier: "read",
		name,
		label: name,
		description: `desc of ${name}`,
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
const fakeTools = () => ALL_NAMES.map(fakeTool);

describe("splitTools（审计 P0-④：常驻/延迟分层）", () => {
	it("常驻 + 延迟 = 全集，无交集", () => {
		const { alwaysActive, deferred } = splitTools(fakeTools(), true);
		assert.equal(alwaysActive.length + deferred.length, ALL_NAMES.length);
		const active = new Set(alwaysActive.map((t) => t.name));
		for (const d of deferred) assert.ok(!active.has(d.name));
	});

	it("核心链路工具必须常驻（prompt 规则 4/5 引用的不可延迟）", () => {
		const { alwaysActive } = splitTools(fakeTools(), true);
		const names = new Set(alwaysActive.map((t) => t.name));
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

	it("enabled=false：全部常驻、无 load_tools、无索引块（逐字节现状）", () => {
		const r = splitTools(fakeTools(), false);
		assert.equal(r.alwaysActive.length, ALL_NAMES.length);
		assert.equal(r.deferred.length, 0);
		assert.equal(r.loadToolsTool, undefined);
		assert.equal(r.deferredIndexBlock, "");
	});

	it("有延迟工具时返回 load_tools（tier=skill，常驻名单收录其名）", () => {
		const { loadToolsTool } = splitTools(fakeTools(), true);
		assert.ok(loadToolsTool);
		assert.equal(loadToolsTool!.name, "load_tools");
		assert.equal(loadToolsTool!.tier, "skill");
		assert.ok(ALWAYS_ON_TOOL_NAMES.has("load_tools"));
	});
});

describe("load_tools（vendor addedToolNames 原生激活）", () => {
	it("合法名单 → addedToolNames 原样返回，content 为确认文本", async () => {
		const { loadToolsTool, deferred } = splitTools(fakeTools(), true);
		const target = deferred[0].name;
		const res = await loadToolsTool!.execute("call-1", { tools: [target] } as never, () => {}, undefined as never, {} as never, undefined as never);
		assert.deepEqual(res.addedToolNames, [target]);
		const text = res.content[0].type === "text" ? res.content[0].text : "";
		assert.match(text, new RegExp(target));
	});

	it("未知名 → 文本报错列出可加载清单，addedToolNames 为空（不激活）", async () => {
		const { loadToolsTool, deferred } = splitTools(fakeTools(), true);
		const res = await loadToolsTool!.execute("call-2", { tools: ["no_such_tool"] } as never, () => {}, undefined as never, {} as never, undefined as never);
		const text = res.content[0].type === "text" ? res.content[0].text : "";
		assert.match(text, /no_such_tool/);
		for (const d of deferred.slice(0, 3)) assert.match(text, new RegExp(d.name));
		assert.ok(!res.addedToolNames || res.addedToolNames.length === 0);
	});

	it("混合合法 + 未知名 → 保守：只报错不激活（模型重试即可）", async () => {
		const { loadToolsTool, deferred } = splitTools(fakeTools(), true);
		const target = deferred[0].name;
		const res = await loadToolsTool!.execute("call-3", { tools: [target, "bogus"] } as never, () => {}, undefined as never, {} as never, undefined as never);
		assert.ok(!res.addedToolNames || res.addedToolNames.length === 0);
	});

	it("重复调用幂等：已加载名再次加载照常返回（激活集合由 vendor 去重）", async () => {
		const { loadToolsTool, deferred } = splitTools(fakeTools(), true);
		const target = deferred[0].name;
		const again = await loadToolsTool!.execute("call-4", { tools: [target] } as never, () => {}, undefined as never, {} as never, undefined as never);
		assert.deepEqual(again.addedToolNames, [target]);
	});
});

describe("buildDeferredIndexBlock", () => {
	it("每行 name — summary，块内含 load_tools 指引，体积可控", () => {
		const { deferred } = splitTools(fakeTools(), true);
		const block = buildDeferredIndexBlock(deferred);
		assert.match(block, /load_tools/);
		for (const d of deferred) assert.match(block, new RegExp(`- ${d.name}：`));
		assert.ok(block.length < 2000, `block length=${block.length}`);
	});

	it("空延迟集 → 空串", () => {
		assert.equal(buildDeferredIndexBlock([]), "");
	});
});

it("索引块是强指令：明示必须先 load_tools、直调会 unavailable（0.0.29 生产实证：模型会无视引导直调延迟工具）", () => {
	const { deferredIndexBlock } = splitTools(fakeTools(), true);
	assert.match(deferredIndexBlock, /必须先调用 load_tools/);
	assert.match(deferredIndexBlock, /unavailable/);
});
