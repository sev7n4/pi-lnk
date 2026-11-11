/**
 * createUiEventProjector（统一事件通道 P0：单一派生源，spec
 * 2026-11-04-unified-channel-event-projection-design §5.1/§8）：
 *
 * - 逐类 fixture 断言产出事件类型与字段（ask_user update 快照 / usage / error /
 *   thinking / plan 标记派生）；
 * - 顺序断言：与主链路 streamFromPiRuntime 循环（agent.service.ts :3126-3240）
 *   的派生顺序逐位一致；map 归一产物（tool_result / pi_tool_execution_update /
 *   pi_message_end 等）与派生事件共存——主链路本就双产（提取 + map 归一），
 *   observer 忠实复刻，前端按类型分派（未知 pi_ 前缀静默丢弃）。
 * - usage 契约（Q2 纪律，createUsageAccumulator 既有行为）：estimateTurnCredits
 *   注入 ⇒ usage_delta 快照实时产出（transient）；不注入 ⇒ usage_delta 不产
 *   （无预估快照无意义，绝不显示 0 积分假象），agent_end 的 turn_usage 照发
 *   （无 estimatedCredits，权威预估由重放的落库值补齐——#714 裁决）。
 * - observer 形态纯产出（无落库面）；flush 为契约前瞻位（accumulator 无残留态）。
 *
 * 变异锁定（spec §10.1）：删 feed 内 extractCanvasCommands 调用 ⇒ ask_user 用例红；
 * 删 estimateTurnCredits 传参 ⇒ usage_delta 用例红（实施时人工执行）。
 */
import { describe, expect, it } from "vitest";
import { createUiEventProjector, type PiRuntimeEvent } from "./pi-events";

const ev = (type: PiRuntimeEvent["type"], data: unknown, seq = 1): PiRuntimeEvent =>
	({ type, ts: Date.now(), seq, data }) as never;

const toolUpdate = (partialResult: unknown, toolName = "ask_user", seq = 7): PiRuntimeEvent =>
	({
		type: "tool_execution_update",
		ts: Date.now(),
		seq,
		data: { toolCallId: "c1", toolName, partialResult },
	}) as never;

const usageMessageEnd = (seq = 3): PiRuntimeEvent =>
	ev(
		"message_end",
		{ message: { usage: { input: 5, output: 3, cacheRead: 1, cacheWrite: 2 } } },
		seq,
	);

describe("createUiEventProjector（统一事件通道 P0：单一派生源）", () => {
	it("事故主场景：ask_user update 快照 → canvas_command（宿主 seq 继承）", () => {
		const p = createUiEventProjector({ role: "observer" });
		const questions = [{ id: "scene", question: "？", options: [{ label: "a", value: "a" }] }];
		const out = p.feed(
			toolUpdate({
				content: [{ type: "text", text: "{}" }],
				details: { ok: true, canvasCommands: [{ type: "ask_user", callId: "c1", questions }] },
			}),
		);
		// 派生 + map 归一双产（主链路同形）：canvas_command 建卡；pi_ 前缀透传被前端丢弃
		expect(out[0]).toEqual({
			type: "canvas_command",
			data: { type: "ask_user", callId: "c1", questions },
			seq: 7,
			ts: expect.any(Number),
		});
		expect(out[1].type).toBe("pi_tool_execution_update");
	});

	it("UI_COMMAND（tool_execution_end）→ canvas_command + tool_result 归一双产", () => {
		const p = createUiEventProjector({ role: "observer" });
		const out = p.feed(
			ev(
				"tool_execution_end",
				{
					toolCallId: "g1",
					toolName: "run_image_generation",
					result: {
						content: [{ type: "text", text: "{}" }],
						details: { ok: true, canvasCommands: [{ type: "focus_node", nodeId: "n1" }] },
					},
				},
				11,
			),
		);
		expect(out[0]).toEqual({ type: "canvas_command", data: { type: "focus_node", nodeId: "n1" }, seq: 11, ts: expect.any(Number) });
		expect(out[1].type).toBe("tool_result");
	});

	it("顺序断言：usage(turn_usage) 先于 map 归一产物（done），与主链路 :3198→:3236 同序", () => {
		const p = createUiEventProjector({ role: "observer", estimateTurnCredits: () => 5 });
		p.feed(usageMessageEnd()); // seenUsage 置位 + usage_delta
		const out = p.feed(ev("agent_end", {}, 9));
		expect(out.map((o) => o.type)).toEqual(["turn_usage", "done"]);
	});

	it("usage：estimateTurnCredits 注入时 usage_delta 带 estimatedCredits", () => {
		const withEst = createUiEventProjector({ role: "observer", estimateTurnCredits: () => 12 });
		const out1 = withEst.feed(usageMessageEnd());
		const delta1 = out1.find((o) => o.type === "usage_delta");
		expect(delta1).toBeTruthy();
		expect((delta1!.data as { estimatedCredits?: number }).estimatedCredits).toBe(12);
	});

	it("usage：不注入 estimateTurnCredits 时 usage_delta 不产（无预估快照无意义，无 0 假象）；turn_usage 照发（无 estimatedCredits）", () => {
		const noEst = createUiEventProjector({ role: "observer" });
		const out2 = noEst.feed(usageMessageEnd());
		// usage_delta 不产；map 归一的 pi_message_end 仍在（主链路同形）
		expect(out2.find((o) => o.type === "usage_delta")).toBeUndefined();
		expect(out2.some((o) => o.type === "pi_message_end")).toBe(true);

		const out3 = noEst.feed(ev("agent_end", {}, 9));
		const turnUsage = out3.find((o) => o.type === "turn_usage");
		expect(turnUsage).toBeTruthy();
		expect((turnUsage!.data as { estimatedCredits?: number }).estimatedCredits).toBeUndefined();
	});

	it("turn_usage 由 agent_end 驱动（seenUsage 门：无 usage 不发）", () => {
		const p = createUiEventProjector({ role: "observer" });
		const out = p.feed(ev("agent_end", {}, 9));
		expect(out.map((o) => o.type)).toEqual(["done"]);
	});

	it("thinking：start→running、end→done（与 accumulator 契约一致）", () => {
		const p = createUiEventProjector({ role: "observer" });
		const start = p.feed(ev("message_update", { event: { type: "thinking_start" } }, 21));
		expect(start).toEqual([{ type: "thinking", data: { status: "running" }, seq: 21, ts: expect.any(Number) }]);
		const end = p.feed(ev("message_update", { event: { type: "thinking_end" } }, 23));
		expect(end.map((o) => o.type)).toEqual(["thinking"]);
		expect((end[0].data as { status: string }).status).toBe("done");
	});

	it("text_delta：plan 标记剥离 + 派生先于 ui 本身（与主链路 text_delta 分支同序）", () => {
		const p = createUiEventProjector({ role: "observer" });
		const out = p.feed(
			ev("message_update", { event: { type: "text_delta", delta: '⟦plan⟧[{"n":1,"title":"第一步"}]\n开始' } }, 4),
		);
		expect(out.map((o) => o.type)).toEqual(["task_list", "text_delta"]);
		expect((out[1].data as { text: string }).text).toBe("\n开始");
		expect((out[0].data as { items: Array<{ id: string; status: string }> }).items).toEqual([
			{ id: "plan-1", title: "第一步", status: "running" },
		]);
	});

	it("task-done 标记 → task_update 派生", () => {
		const p = createUiEventProjector({ role: "observer" });
		const out = p.feed(ev("message_update", { event: { type: "text_delta", delta: "⟦task-done⟧1" } }, 5));
		expect(out.map((o) => o.type)).toEqual(["task_update", "text_delta"]);
		expect(out[0].data).toEqual({ id: "plan-1", status: "done" });
	});

	it("error 事件：classify 结构化 error 先于 map 归一 error（主链路双产形态忠实复刻）", () => {
		const p = createUiEventProjector({ role: "observer" });
		const out = p.feed(ev("error", { message: "rate limit 429: too many requests" }, 8));
		expect(out.map((o) => o.type)).toEqual(["error", "error"]);
		// classify 产物：结构化（owner-enriched 的 provider/model 不在 observer 形态）
		const classified = out[0].data as { error_type?: string; retry_hint?: string; provider?: string };
		expect(classified.error_type).toBe("rate_limit");
		expect(classified.retry_hint).toBeTruthy();
		expect(classified.provider).toBeUndefined();
		// map 产物：透传形状
		expect((out[1].data as { message?: string }).message).toBe("rate limit 429: too many requests");
	});

	it("agent_end 非错误状态不触发 classify（正常收束单产 done）", () => {
		const p = createUiEventProjector({ role: "observer" });
		const out = p.feed(ev("agent_end", { status: "ok" }, 9));
		expect(out.map((o) => o.type)).toEqual(["done"]);
	});

	it("同宿主多派生共享宿主 seq", () => {
		const p = createUiEventProjector({ role: "observer" });
		const out = p.feed(
			toolUpdate(
				{
					content: [{ type: "text", text: "{}" }],
					details: { ok: true, canvasCommands: [{ type: "focus_node", nodeId: "n1" }] },
				},
				"run_image_generation",
				13,
			),
		);
		// 双产（canvas_command + pi_ 前缀透传）均继承宿主 seq
		expect(out.length).toBeGreaterThanOrEqual(2);
		for (const o of out) expect(o.seq).toBe(13);
	});

	it("flush() 返回空数组（accumulator 无残留态，契约前瞻位）", () => {
		const p = createUiEventProjector({ role: "observer" });
		p.feed(usageMessageEnd());
		expect(p.flush()).toEqual([]);
	});
});
