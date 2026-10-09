import { describe, expect, it } from "vitest";
import {
	createThinkingAccumulator,
	createUsageAccumulator,
	extractCanvasActions,
	extractCanvasCommands,
	extractTaskEvents,
	mapPiEventToUiEvent,
	type PiRuntimeEvent,
} from "./pi-events";

const toolEnd = (result: unknown, isError = false): PiRuntimeEvent =>
	({
		type: "tool_execution_end",
		ts: Date.now(),
		data: { toolCallId: "c1", toolName: "focus_node", result, isError },
	}) as never;

const toolUpdate = (partialResult: unknown): PiRuntimeEvent =>
	({
		type: "tool_execution_update",
		ts: Date.now(),
		data: { toolCallId: "c1", toolName: "ask_user", partialResult },
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

	it("ask_user canvas_command 从 tool_execution_update 提取并透传 callId（B-6 阻塞卡唯一可见路径）", () => {
		const questions = [{ id: "scene", question: "？", options: [{ label: "a", value: "a" }] }];
		const cmds = extractCanvasCommands(
			toolUpdate({
				content: [{ type: "text", text: "{}" }],
				details: { ok: true, canvasCommands: [{ type: "ask_user", callId: "c1", questions }] },
			}),
		);
		expect(cmds).toEqual([{ type: "ask_user", callId: "c1", questions }]);
	});

	it("update 快照缺 callId 时回落 toolCallId（前端 POST /answers 提交依据不可缺）", () => {
		const cmds = extractCanvasCommands(
			toolUpdate({
				details: { ok: true, canvasCommands: [{ type: "ask_user", questions: [{ id: "q", question: "？", options: [{ label: "a", value: "a" }] }] }] },
			}),
		);
		expect(cmds[0]?.callId).toBe("c1");
	});

	it("update 路径非 ask_user 命令不注入 callId；无 canvasCommands 返回空", () => {
		expect(
			extractCanvasCommands(toolUpdate({ details: { ok: true, canvasCommands: [{ type: "focus_node", nodeId: "n1" }] } })),
		).toEqual([{ type: "focus_node", nodeId: "n1" }]);
		expect(extractCanvasCommands(toolUpdate({ details: { ok: true } }))).toEqual([]);
	});

	it("end 事件 ask_user（blocking off 旧路径）callId 原样透传", () => {
		const cmds = extractCanvasCommands(
			toolEnd({
				details: { ok: true, canvasCommands: [{ type: "ask_user", callId: "c9", questions: [{ id: "q", question: "？", options: [{ label: "a", value: "a" }] }] }] },
			}),
		);
		expect(cmds[0]?.callId).toBe("c9");
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

	it("nodeType=audio 保留（2026-09-28 补入 NODE_TYPES，此前被静默丢弃）", () => {
		const actions = extractCanvasActions(
			toolEnd({
				details: { actions: [{ type: "add_node", payload: { id: "a1", nodeType: "audio" } }] },
			}),
		);
		expect(actions).toEqual([{ type: "add_node", payload: { id: "a1", nodeType: "audio" } }]);
	});

	it("白名单外 nodeType 仍被丢弃：mediaInput / videoComposition / worldModel 有意不支持", () => {
		for (const nodeType of ["mediaInput", "videoComposition", "worldModel"]) {
			expect(
				extractCanvasActions(
					toolEnd({ details: { actions: [{ type: "add_node", payload: { nodeType } }] } }),
				),
			).toEqual([]);
		}
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

describe("error 映射（P0 错误链路修复）", () => {
	it("pi error 事件映射为 UI error 事件（不再 pi_error 透传静默丢弃）", () => {
		const ui = mapPiEventToUiEvent({
			type: "error",
			ts: 1,
			data: { message: "上游 429", error_type: "rate_limit" },
		} as never);
		expect(ui).not.toBeNull();
		expect(ui!.type).toBe("error");
		expect((ui!.data as { message?: string }).message).toBe("上游 429");
		expect((ui!.data as { error_type?: string }).error_type).toBe("rate_limit");
	});
});

describe("turn_usage（P1 状态行）", () => {
	const msgEnd = (usage?: Record<string, unknown>) =>
		({
			type: "message_end",
			ts: 1,
			data: { message: usage ? { usage } : {} },
		}) as never;

	it("T3-1: 多条 message_end 累积（inputTokens=input+cacheRead+cacheWrite），agent_end 触发一次", () => {
		const acc = createUsageAccumulator();
		expect(acc.feed(msgEnd({ input: 100, cacheRead: 40, cacheWrite: 10, output: 20 }))).toBeNull();
		expect(acc.feed(msgEnd({ input: 50, output: 30 }))).toBeNull();
		const done = acc.feed({ type: "agent_end", ts: 1, data: {} } as never);
		expect(done).toEqual({ type: "turn_usage", data: { inputTokens: 200, outputTokens: 50 } });
	});

	it("T3-2: 从未出现 usage → agent_end 不发 turn_usage；出现过 usage → 全零也发", () => {
		const accNone = createUsageAccumulator();
		accNone.feed(msgEnd());
		expect(accNone.feed({ type: "agent_end", ts: 1, data: {} } as never)).toBeNull();
		const accZero = createUsageAccumulator();
		accZero.feed(msgEnd({ input: 0, output: 0 }));
		expect(accZero.feed({ type: "agent_end", ts: 1, data: {} } as never)).toEqual({
			type: "turn_usage",
			data: { inputTokens: 0, outputTokens: 0 },
		});
	});

	it("T3-3: 无 message_end 直接 agent_end → 不发（null）", () => {
		const acc = createUsageAccumulator();
		expect(acc.feed({ type: "agent_end", ts: 1, data: {} } as never)).toBeNull();
	});
});

describe("thinking 全文透传（P0 思考面板）", () => {
	it("end 时全文透传，clamp 2000 字", () => {
		const acc = createThinkingAccumulator();
		const longText = "a".repeat(2500);
		acc.feed({ type: "message_update", ts: 1, data: { event: { type: "thinking_start" } } } as never);
		acc.feed({ type: "message_update", ts: 2, data: { event: { type: "thinking_delta", delta: longText } } } as never);
		const out = acc.feed({ type: "message_update", ts: 3, data: { event: { type: "thinking_end" } } } as never);
		expect(out?.type).toBe("thinking");
		const summary = (out!.data as { summary?: string }).summary ?? "";
		expect(summary.length).toBe(2000);
	});
});

describe("waiting_user 透传（2026-10-01 阻塞等待可见化）", () => {
	it("waiting（含 nodeId/timeoutMs）→ 同名 UI 事件，不带 pi_ 前缀", () => {
		const out = mapPiEventToUiEvent({
			type: "waiting_user",
			ts: 1,
			data: { status: "waiting", toolName: "propose_generation", callId: "c1", nodeId: "node-9", timeoutMs: 300000 },
		} as never);
		expect(out).toEqual({
			type: "waiting_user",
			data: { status: "waiting", toolName: "propose_generation", callId: "c1", timeoutMs: 300000, nodeId: "node-9", reason: undefined },
		});
	});

	it("resolved → 携带 reason，前端据此清等待态", () => {
		const out = mapPiEventToUiEvent({
			type: "waiting_user",
			ts: 2,
			data: { status: "resolved", toolName: "ask_user", callId: "c1", reason: "answered" },
		} as never);
		expect(out).toEqual({
			type: "waiting_user",
			data: { status: "resolved", toolName: "ask_user", callId: "c1", timeoutMs: undefined, nodeId: undefined, reason: "answered" },
		});
	});

	it("status 缺失/非法一律按 waiting 处理（前端宁可多提示，也不要漏）", () => {
		const out = mapPiEventToUiEvent({
			type: "waiting_user",
			ts: 3,
			data: { toolName: "propose_generation", callId: "c2" },
		} as never);
		expect((out!.data as { status: string }).status).toBe("waiting");
	});
});

describe("activity 透传（决策 8 · 正在做什么）", () => {
	it("tool_start 的 activity → 同名 UI 事件，不带 pi_ 前缀", () => {
		const out = mapPiEventToUiEvent({
			type: "activity",
			ts: 11,
			data: { toolName: "upsert_media_node", done: 1 },
		} as never);
		expect(out).toEqual({ type: "activity", data: { toolName: "upsert_media_node", done: 1, total: undefined } });
	});

	it("载荷只有英文工具名：中文翻译是客户端目录的责任（决策 7）", () => {
		const out = mapPiEventToUiEvent({
			type: "activity",
			ts: 12,
			data: { toolName: "web_search", done: 2 },
		} as never);
		const data = out!.data as { toolName?: string; done?: number };
		expect(data.toolName).toBe("web_search");
		expect(data.done).toBe(2);
		expect(JSON.stringify(out!.data)).not.toContain("搜索");
	});

	it("runtime 不伪造 total：缺省就是 undefined（前端别渲染假分母）", () => {
		const out = mapPiEventToUiEvent({
			type: "activity",
			ts: 13,
			data: { toolName: "arrange_nodes", done: 3 },
		} as never);
		expect((out!.data as { total?: number }).total).toBeUndefined();
	});

	it("compaction 显式映射：start 带 phase=start+reason，end 带 phase=end+status", () => {
		const start = mapPiEventToUiEvent({
			type: "compaction",
			ts: 14,
			data: { reason: "threshold", startedAt: 1 },
		} as never);
		expect(start!.type).toBe("pi_compaction");
		expect(start!.data).toMatchObject({ phase: "start", reason: "threshold" });

		const end = mapPiEventToUiEvent({
			type: "compaction",
			ts: 15,
			data: { status: "completed", entryId: "e1", endedAt: 2 },
		} as never);
		expect(end!.type).toBe("pi_compaction");
		expect(end!.data).toMatchObject({ phase: "end", status: "completed" });
	});
});

describe("turn_usage cost（审计 P0-③）", () => {
	const msgEnd = (usage?: Record<string, unknown>) =>
		({
			type: "message_end",
			ts: 1,
			data: { message: usage ? { usage } : {} },
		}) as never;

	it("T3-4: usage.cost 存在时按四字段求和累积，agent_end 的 turn_usage 附带 cost", () => {
		const acc = createUsageAccumulator();
		acc.feed(msgEnd({ input: 100, output: 20, cost: { input: 0.25, output: 0.1, cacheRead: 0, cacheWrite: 0 } }));
		acc.feed(msgEnd({ input: 50, output: 30, cost: { input: 0.5, output: 0.15, cacheRead: 0, cacheWrite: 0 } }));
		const done = acc.feed({ type: "agent_end", ts: 1, data: {} } as never);
		expect(done).toEqual({
			type: "turn_usage",
			data: { inputTokens: 150, outputTokens: 50, cost: 1 },
		});
	});

	it("T3-5: 无 cost 字段（未配费率）→ turn_usage 不带 cost 字段（向后兼容）", () => {
		const acc = createUsageAccumulator();
		acc.feed(msgEnd({ input: 100, output: 20 }));
		const done = acc.feed({ type: "agent_end", ts: 1, data: {} } as never);
		expect(done).toEqual({ type: "turn_usage", data: { inputTokens: 100, outputTokens: 20 } });
	});
});

describe("extractTaskEvents（C1：todo_write diff → task_list/task_update 派生，V-B′ 三态映射）", () => {
	const mkEnd = (details: unknown, isError = false): PiRuntimeEvent =>
		({
			type: "tool_execution_end",
			ts: Date.now(),
			data: { toolCallId: "t1", toolName: "todo_write", isError, result: { details } },
		}) as never;

	it("结构变化 → 单条 task_list 全量（title=content，activeForm 附加）", () => {
		const events = extractTaskEvents(
			mkEnd({
				todo: {
					snapshot: [],
					diff: {
						list: [
							{ id: "plan-1", content: "起稿", status: "in_progress", activeForm: "正在起稿" },
							{ id: "plan-2", content: "配图", status: "pending" },
						],
						updates: [],
					},
				},
			}),
		);
		expect(events.length).toBe(1);
		expect(events[0].type).toBe("task_list");
		expect(events[0].data).toEqual({
			items: [
				{ id: "plan-1", title: "起稿", status: "running", activeForm: "正在起稿" },
				{ id: "plan-2", title: "配图", status: "pending" },
			],
		});
	});

	it("V-B′：pending 与 in_progress 在 payload 中可区分（前端消费迭代）", () => {
		const events = extractTaskEvents(
			mkEnd({
				todo: {
					snapshot: [],
					diff: {
						list: [
							{ id: "plan-1", content: "起稿", status: "in_progress" },
							{ id: "plan-2", content: "配图", status: "pending" },
							{ id: "plan-3", content: "导出", status: "completed" },
						],
						updates: [],
					},
				},
			}),
		);
		expect(events[0].data).toEqual({
			items: [
				{ id: "plan-1", title: "起稿", status: "running" },
				{ id: "plan-2", title: "配图", status: "pending" },
				{ id: "plan-3", title: "导出", status: "done" },
			],
		});
	});

	it("V-B′：updates 路径 pending→pending（重开条目）", () => {
		const events = extractTaskEvents(
			mkEnd({ todo: { snapshot: [], diff: { updates: [{ id: "plan-1", status: "pending" }] } } }),
		);
		expect(events).toEqual([{ type: "task_update", data: { id: "plan-1", status: "pending" } }]);
	});

	it("仅状态变化 → task_update（completed→done，其余→running）", () => {
		const events = extractTaskEvents(
			mkEnd({ todo: { snapshot: [], diff: { updates: [{ id: "plan-1", status: "completed" }] } } }),
		);
		expect(events).toEqual([{ type: "task_update", data: { id: "plan-1", status: "done" } }]);
	});

	it("updates 命中 snapshot → task_update 附 title/activeForm（呈现链对增量更新成立）", () => {
		const events = extractTaskEvents(
			mkEnd({
				todo: {
					snapshot: [
						{ id: "plan-1", content: "起稿", status: "in_progress", activeForm: "正在起稿" },
						{ id: "plan-2", content: "配图", status: "pending" },
					],
					diff: {
						updates: [
							{ id: "plan-1", status: "in_progress" },
							{ id: "plan-2", status: "completed" },
						],
					},
				},
			}),
		);
		expect(events).toEqual([
			{ type: "task_update", data: { id: "plan-1", status: "running", title: "起稿", activeForm: "正在起稿" } },
			{ type: "task_update", data: { id: "plan-2", status: "done", title: "配图" } },
		]);
	});

	it("updates 未命中 snapshot（防御）→ task_update 退化为 {id,status}", () => {
		const events = extractTaskEvents(
			mkEnd({
				todo: {
					snapshot: [{ id: "plan-9", content: "无关项", status: "pending" }],
					diff: { updates: [{ id: "plan-1", status: "completed" }] },
				},
			}),
		);
		expect(events).toEqual([{ type: "task_update", data: { id: "plan-1", status: "done" } }]);
	});

	it("非 tool_execution_end / isError / 无 details.todo → 空", () => {
		expect(extractTaskEvents({ type: "message_update", ts: 1, data: {} } as never)).toEqual([]);
		expect(
			extractTaskEvents(mkEnd({ todo: { snapshot: [], diff: { updates: [] } } }, true)),
		).toEqual([]);
		expect(extractTaskEvents(mkEnd({ other: 1 }))).toEqual([]);
	});

	it("空 diff（无变化）→ 空（不打扰前端）", () => {
		expect(extractTaskEvents(mkEnd({ todo: { snapshot: [], diff: { updates: [] } } }))).toEqual([]);
	});
});
