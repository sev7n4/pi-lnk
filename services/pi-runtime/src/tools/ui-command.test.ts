/** UI_COMMAND×5 契约测试：本地无 IO、输出 camelCase canvasCommands、tier=ui_command、metrics 计数。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createUiCommandTools } from "./ui-command.js";
import { Metrics } from "../metrics.js";
import type { LnkpiTool } from "./types.js";

function setup() {
	const metrics = new Metrics();
	const tools = createUiCommandTools(metrics);
	const find = (name: string) => {
		const tool = tools.find((t) => t.name === name);
		assert.ok(tool, `tool ${name} not registered`);
		return tool;
	};
	return { metrics, tools, find };
}

/** 对齐 harness execute 六参签名（同 canvas-write.test.ts 的调用方式）。 */
async function run(tool: LnkpiTool, params: unknown) {
	return tool.execute!(
		"tc1",
		params as never,
		() => {},
		{ sessionId: "s1" } as never,
		{} as never,
		undefined as never,
	);
}

describe("UI_COMMAND 本地工具", () => {
	it("5 个工具全部注册且 tier=ui_command", () => {
		const { tools } = setup();
		assert.deepEqual(
			tools.map((t) => t.name).sort(),
			["focus_node", "focus_nodes", "open_image_editor", "redo", "undo"],
		);
		for (const t of tools) assert.equal(t.tier, "ui_command");
	});

	it("focus_node 返回 camelCase canvasCommands（content 与 details 同构）", async () => {
		const { find } = setup();
		const r = await run(find("focus_node")!, { node_id: "n1" });
		const expected = { ok: true, canvasCommands: [{ type: "focus_node", nodeId: "n1" }] };
		assert.deepEqual(JSON.parse((r.content[0] as { text: string }).text), expected);
		assert.deepEqual(r.details, { ok: true, canvasCommands: [{ type: "focus_node", nodeId: "n1" }] });
	});

	it("focus_nodes 的 node_ids 映射为 nodeIds", async () => {
		const { find } = setup();
		const r = await run(find("focus_nodes")!, { node_ids: ["a", "b"] });
		assert.deepEqual(r.details, { ok: true, canvasCommands: [{ type: "focus_nodes", nodeIds: ["a", "b"] }] });
	});

	it("undo / redo 无参数，返回裸命令", async () => {
		const { find } = setup();
		assert.deepEqual((await run(find("undo")!, {})).details, {
			ok: true,
			canvasCommands: [{ type: "undo" }],
		});
		assert.deepEqual((await run(find("redo")!, {})).details, {
			ok: true,
			canvasCommands: [{ type: "redo" }],
		});
	});

	it("open_image_editor 返回 nodeId", async () => {
		const { find } = setup();
		const r = await run(find("open_image_editor")!, { node_id: "img-9" });
		assert.deepEqual(r.details, { ok: true, canvasCommands: [{ type: "open_image_editor", nodeId: "img-9" }] });
	});

	it("每次调用计 pi_runtime_tool_calls_total（本地工具不走 NestClient，须自计）", async () => {
		const { find, metrics } = setup();
		await run(find("focus_node")!, { node_id: "n1" });
		const rendered = metrics.render(0, "test");
		assert.match(rendered, /pi_runtime_tool_calls_total\{tool="focus_node",result="ok"\} 1/);
	});
});
