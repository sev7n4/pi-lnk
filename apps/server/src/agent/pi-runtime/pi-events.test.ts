import { describe, expect, it } from "vitest";
import {
	createThinkingAccumulator,
	extractCanvasActions,
	extractCanvasCommands,
	mapPiEventToUiEvent,
	type PiRuntimeEvent,
} from "./pi-events";

const toolEnd = (result: unknown, isError = false): PiRuntimeEvent =>
	({
		type: "tool_execution_end",
		ts: Date.now(),
		data: { toolCallId: "c1", toolName: "focus_node", result, isError },
	}) as never;

describe("extractCanvasCommands（UI_COMMAND → canvas_command 派生）", () => {
	it("从 result.details.canvasCommands 提取命令", () => {
		const cmds = extractCanvasCommands(
			toolEnd({
				content: [{ type: "text", text: "{}" }],
				details: { ok: true, canvasCommands: [{ type: "focus_node", nodeId: "n1" }] },
			}),
		);
		expect(cmds).toEqual([{ type: "focus_node", nodeId: "n1" }]);
	});

	it("isError 事件不派生", () => {
		expect(
			extractCanvasCommands(toolEnd({ details: { ok: false, canvasCommands: [{ type: "undo" }] } }, true)),
		).toEqual([]);
	});

	it("非 UI_COMMAND 工具（details 无 canvasCommands）返回空", () => {
		expect(
			extractCanvasCommands(toolEnd({ content: [], details: { ok: true, data: { nodeId: "x" } } })),
		).toEqual([]);
	});

	it("canvasCommands 非数组或缺 type 字段的条目被过滤", () => {
		const cmds = extractCanvasCommands(
			toolEnd({ details: { ok: true, canvasCommands: [{ type: "undo" }, "junk", { nope: 1 }, null] } }),
		);
		expect(cmds).toEqual([{ type: "undo" }]);
	});

	it("非 tool_execution_end 事件返回空", () => {
		expect(extractCanvasCommands({ type: "agent_end", ts: 1, data: {} } as never)).toEqual([]);
	});

	it("既有映射不受影响：tool_execution_end 仍产出 tool_result", () => {
		const ui = mapPiEventToUiEvent(
			toolEnd({ content: [], details: { ok: true, canvasCommands: [{ type: "undo" }] } }),
		);
		expect(ui?.type).toBe("tool_result");
	});

	it("tool_call/tool_result 携带老契约 name 字段（前端读 data.name，缺失渲染为「调用 undefined」）", () => {
		const call = mapPiEventToUiEvent({
			type: "tool_execution_start",
			ts: Date.now(),
			data: { toolCallId: "c1", toolName: "load_skill", args: { name: "ecommerce-product-photo" } },
		} as never);
		expect((call?.data as Record<string, unknown>).name).toBe("load_skill");

		const result = mapPiEventToUiEvent(toolEnd({ content: [] }));
		expect((result?.data as Record<string, unknown>).name).toBe("focus_node");
		expect((result?.data as Record<string, unknown>).toolName).toBe("focus_node"); // 兼容保留
	});
});

describe("extractCanvasActions（B-5 gen 工具 → canvas_action 派生）", () => {
	it("从 result.details.actions 提取合法 CanvasAction", () => {
		const actions = extractCanvasActions(
			toolEnd({
				content: [],
				details: {
					actions: [{ type: "update_node", payload: { id: "n_1", data: { status: "completed" } } }],
				},
			}),
		);
		expect(actions).toEqual([{ type: "update_node", payload: { id: "n_1", data: { status: "completed" } } }]);
	});

	it("非法形状逐条跳过，合法条目保留", () => {
		const actions = extractCanvasActions(
			toolEnd({
				details: {
					actions: [
						{ type: "nonsense_type", payload: {} },
						{ type: "update_node", payload: { id: "n_2" } },
						"junk",
						42,
					],
				},
			}),
		);
		expect(actions).toEqual([{ type: "update_node", payload: { id: "n_2" } }]);
	});

	it("isError 事件不派生", () => {
		expect(
			extractCanvasActions(
				toolEnd({ details: { actions: [{ type: "update_node", payload: { id: "n" } }] } }, true),
			),
		).toEqual([]);
	});

	it("缺 details / actions 非数组 / 非 tool_execution_end 均返回空", () => {
		expect(extractCanvasActions(toolEnd({}))).toEqual([]);
		expect(extractCanvasActions(toolEnd({ details: { actions: "oops" } }))).toEqual([]);
		expect(extractCanvasActions({ type: "message_update", ts: 1, data: {} } as never)).toEqual([]);
	});
});

describe("thinking 透传（可观测性专项 ③）", () => {
	const thinkEvent = (type: string, delta?: string) =>
		({
			type: "message_update",
			ts: 1,
			data: { event: { type, ...(delta !== undefined ? { delta } : {}) } },
		}) as never;

	it("start → running 事件，delta → 累积返回 null，end → done + 截断摘要", () => {
		// brief 原文为 createThinkingAccumulator(10)，但其期望摘要含 11 字符（含〇），
		// 与实现 slice(0, limit)（limit 字符）矛盾；按实现语义取 11，期望字符串逐字保留。
		const acc = createThinkingAccumulator(11);
		expect(acc.feed(thinkEvent("thinking_start"))).toEqual({
			type: "thinking",
			data: { status: "running" },
		});
		expect(acc.feed(thinkEvent("thinking_delta", "一二三四五"))).toBeNull();
		expect(acc.feed(thinkEvent("thinking_delta", "六七八九十〇一二三四"))).toBeNull();
		const end = acc.feed(thinkEvent("thinking_end"));
		expect(end).toEqual({ type: "thinking", data: { status: "done", summary: "一二三四五六七八九十〇" } });
	});

	it("A4: 纯文本流（无 thinking）feed 全程返回 null", () => {
		const acc = createThinkingAccumulator();
		expect(acc.feed({ type: "message_update", ts: 1, data: { event: { type: "text_delta", delta: "hi" } } } as never)).toBeNull();
		expect(acc.feed({ type: "tool_execution_start", ts: 1, data: {} } as never)).toBeNull();
	});
});
