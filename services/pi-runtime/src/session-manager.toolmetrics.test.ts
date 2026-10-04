/**
 * 事件层结算的**端到端接线**测试（spec §3.2）。
 *
 * 为什么必须派发真事件、不能只驱动 `toolMetricsForTest()`：
 * 后者只证明 ToolMetrics 能渲染，证明不了 `attachEvents` 真的订阅了
 * `tool_start`/`tool_end`。**变异验证实测**：把 `attachEvents` 里 `tool_end`
 * 分支的 `observeEnd(...)` 整段注释掉后，只驱动 `toolMetricsForTest()` 的用例
 * **依然全绿**（2/2 pass）——它对接线完全不可证伪。
 * 本文件用真事件派发堵上这个洞：注释掉接线 ⇒ 用例必红。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "./session-manager.js";
import { Metrics } from "./metrics.js";
import type { RuntimeConfig } from "./runtime-config.js";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-toolmetrics-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

let cfgSeq = 0;
function testConfig(): RuntimeConfig {
	return {
		dataRoot: join(TEST_ROOT, `tm${++cfgSeq}`),
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
		sessionsMaxBytes: 10 ** 12,
		sessionsMaxCount: 1000,
		toolTiering: false,
		compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
	};
}

/** 最小 harness 替身：`on` 记录订阅者，`emit` 派发真事件。 */
function makeEmitter() {
	const handlers = new Map<string, Array<(evt: unknown) => void>>();
	return {
		on(type: string, fn: (evt: unknown) => void) {
			const list = handlers.get(type) ?? [];
			list.push(fn);
			handlers.set(type, list);
			return () => {
				handlers.set(type, (handlers.get(type) ?? []).filter((h) => h !== fn));
			};
		},
		emit(type: string, evt: unknown) {
			for (const fn of handlers.get(type) ?? []) fn(evt);
		},
		subscribed: () => [...handlers.keys()].sort(),
	};
}

/** 建一个带 metrics 的 SessionManager，并返回它的事件派发口。 */
async function makeManager(metrics: Metrics) {
	const events = makeEmitter();
	const lane = {
		steer: async () => ({ ok: true }),
		followUp: async () => ({ ok: true }),
		prompt: async () => ({ ok: true }),
	};
	const factory = async () =>
		({
			harness: {
				events: { on: (t: string, fn: (e: unknown) => void) => events.on(t, fn) },
				lane: async () => lane,
				close: async () => {},
			},
		} as never);
	// 构造签名见 session-manager.ts:562 —— metrics 是第 9 个参数（onCompaction 之后）。
	const sm = new SessionManager(
		[],
		"",
		undefined,
		factory,
		undefined,
		undefined,
		testConfig(),
		undefined,
		metrics,
	);
	await sm.create("sess-1", { userId: "u1" });
	return { sm, events };
}

test("真 tool_start/tool_end 事件经 attachEvents 落到 /metrics（接线可证伪）", async () => {
	const metrics = new Metrics();
	const { events } = await makeManager(metrics);

	events.emit("tool_start", { toolCallId: "tc-1", toolName: "save_memory" });
	events.emit("tool_end", {
		toolCallId: "tc-1",
		toolName: "save_memory",
		isError: false,
		terminate: false,
		result: { content: [{ type: "text", text: "saved" }] },
	});

	const out = metrics.render(0, "test");
	assert.match(
		out,
		/pi_runtime_tool_calls_total\{tool="save_memory",result="ok"\} 1/,
		"attachEvents 未把 tool_end 喂给 ToolMetrics（接线断了）",
	);
	// 配对成功 ⇒ 记了耗时（未配对只会计数不记时长）
	assert.match(out, /pi_runtime_tool_duration_seconds_count\{tool="save_memory"\} 1/);
});

test("tool_end 的 isError + resultText 决定 error_class（分类链路端到端通）", async () => {
	const metrics = new Metrics();
	const { events } = await makeManager(metrics);

	events.emit("tool_start", { toolCallId: "tc-2", toolName: "web_fetch" });
	events.emit("tool_end", {
		toolCallId: "tc-2",
		toolName: "web_fetch",
		isError: true,
		terminate: false,
		result: { content: [{ type: "text", text: "HTTP 429 rate limit exceeded" }] },
	});

	const out = metrics.render(0, "test");
	assert.match(out, /pi_runtime_tool_calls_total\{tool="web_fetch",result="error",error_class="upstream_4xx"\} 1/);
});

test("terminate 归 blocked：模型主动终止不污染错误率", async () => {
	const metrics = new Metrics();
	const { events } = await makeManager(metrics);

	events.emit("tool_start", { toolCallId: "tc-3", toolName: "run_video_generation" });
	events.emit("tool_end", {
		toolCallId: "tc-3",
		toolName: "run_video_generation",
		isError: true,
		terminate: true,
		result: { content: [{ type: "text", text: "stopped by model" }] },
	});

	assert.match(
		metrics.render(0, "test"),
		/pi_runtime_tool_calls_total\{tool="run_video_generation",result="blocked",error_class="blocked_terminate"\} 1/,
	);
});

test("只有 tool_end 没有 tool_start：只计数不记时长（孤儿保护端到端通）", async () => {
	const metrics = new Metrics();
	const { events } = await makeManager(metrics);

	events.emit("tool_end", {
		toolCallId: "orphan-1",
		toolName: "get_node",
		isError: false,
		terminate: false,
		result: { content: [{ type: "text", text: "ok" }] },
	});

	const out = metrics.render(0, "test");
	assert.match(out, /pi_runtime_tool_calls_total\{tool="get_node",result="ok"\} 1/);
	assert.equal(
		out.includes('pi_runtime_tool_duration_seconds_count{tool="get_node"}'),
		false,
		"孤儿事件污染了时长直方图",
	);
	assert.equal(metrics.toolMetricsForTest().stats().orphaned, 1);
});

test("重放同一 toolCallId 的 end：幂等，不双计（接线层不绕过幂等）", async () => {
	const metrics = new Metrics();
	const { events } = await makeManager(metrics);

	const end = {
		toolCallId: "tc-dup",
		toolName: "get_node",
		isError: false,
		terminate: false,
		result: { content: [{ type: "text", text: "ok" }] },
	};
	events.emit("tool_start", { toolCallId: "tc-dup", toolName: "get_node" });
	events.emit("tool_end", end);
	events.emit("tool_start", { toolCallId: "tc-dup", toolName: "get_node" });
	events.emit("tool_end", end);

	const out = metrics.render(0, "test");
	assert.match(out, /pi_runtime_tool_calls_total\{tool="get_node",result="ok"\} 1/, "重放被双计");
	assert.equal(metrics.toolMetricsForTest().stats().duplicates, 1);
});

test("retry_scheduled 事件驱动 llm_retries（不进 SSE，只进指标）", async () => {
	const metrics = new Metrics();
	const { events } = await makeManager(metrics);

	events.emit("retry_scheduled", { attempt: 1, errorMessage: "rate limited" });

	assert.match(
		metrics.render(0, "test"),
		/pi_runtime_llm_retries_total\{stage="main_turn",channel="[^"]+",model="[^"]+"\} 1/,
	);
});

test("attachEvents 确实订阅了 tool_start/tool_end/retry_scheduled", async () => {
	const metrics = new Metrics();
	const { events } = await makeManager(metrics);
	const subs = events.subscribed();
	for (const type of ["tool_start", "tool_end", "retry_scheduled"]) {
		assert.ok(subs.includes(type), `attachEvents 未订阅 ${type}（实际：${subs.join(",")}）`);
	}
});

test("未投喂事件时不渲染任何 tool_calls_total 数据行（删除手写埋点后总量不变）", () => {
	const m = new Metrics();
	const out = m.render(0, "test");
	assert.equal(/^pi_runtime_tool_calls_total\{/m.test(out), false);
});
