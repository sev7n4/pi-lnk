/**
 * UI_COMMAND×5 本地工具（P1 批次）：不落数据、不走 Nest，返回 canvasCommands，
 * 由 Nest pi-events.extractCanvasCommands 派生 canvas_command SSE 事件，
 * 前端 AgentSideRail.vue canvas_command 分支消费。
 * 输出契约对齐老链路 definitions.py:472-489（camelCase，前端免转换）。
 *
 * ⚠️ 2026-10-04：不再自计 `pi_runtime_tool_calls_total`。这 5 个工具同样在 harness 的
 * `tool_start`/`tool_end` 覆盖范围内，事件层统一结算（39 工具全覆盖），
 * 工具内自埋会与事件层**双计**（见 spec §3.2）。
 */
import { Type } from "typebox";
import type { LnkpiTool } from "./types.js";

export interface CanvasCommand {
	type: string;
	nodeId?: string;
	nodeIds?: string[];
}

function uiResult(commands: CanvasCommand[]): {
	content: [{ type: "text"; text: string }];
	details: { ok: true; canvasCommands: CanvasCommand[] };
} {
	return {
		content: [{ type: "text", text: JSON.stringify({ ok: true, canvasCommands: commands }) }],
		details: { ok: true, canvasCommands: commands },
	};
}

export function createUiCommandTools(): LnkpiTool[] {
	const tier = { tier: "ui_command" as const };
	const tools: LnkpiTool[] = [
		{
			...tier,
			name: "focus_node",
			label: "定位到节点",
			description: "Pan/zoom the canvas viewport to a node (UI command)",
			parameters: Type.Object({ node_id: Type.String({ description: "Canvas node id" }) }),
			execute: async (_id, p: { node_id: string }) => {
				return uiResult([{ type: "focus_node", nodeId: p.node_id }]);
			},
		},
		{
			...tier,
			name: "focus_nodes",
			label: "定位到多个节点",
			description: "Pan/zoom the canvas viewport to multiple nodes (UI command)",
			parameters: Type.Object({ node_ids: Type.Array(Type.String(), { description: "Canvas node ids" }) }),
			execute: async (_id, p: { node_ids: string[] }) => {
				return uiResult([{ type: "focus_nodes", nodeIds: p.node_ids }]);
			},
		},
		{
			...tier,
			name: "undo",
			label: "撤销上次画布编辑",
			description: "Undo the last local canvas edit (client undo stack)",
			parameters: Type.Object({}),
			execute: async () => {
				return uiResult([{ type: "undo" }]);
			},
		},
		{
			...tier,
			name: "redo",
			label: "重做画布编辑",
			description: "Redo the last undone canvas edit (client undo stack)",
			parameters: Type.Object({}),
			execute: async () => {
				return uiResult([{ type: "redo" }]);
			},
		},
		{
			...tier,
			name: "open_image_editor",
			label: "打开图片精修",
			description: "Open the image refine editor for a node (UI command)",
			parameters: Type.Object({ node_id: Type.String({ description: "Image node id" }) }),
			execute: async (_id, p: { node_id: string }) => {
				return uiResult([{ type: "open_image_editor", nodeId: p.node_id }]);
			},
		},
	];
	return tools;
}
