/**
 * 图形化表达观测的**端到端接线**测试（D1）。
 *
 * ⚠️ 为什么必须派发真事件 / 真发 HTTP 请求，而不能只驱动 `GraphMetrics`：
 *   只驱动类只证明「类能渲染」，证明不了 `session-manager.attachEvents` 真的订阅了
 *   `message_update` / `tool_start` / `turn_end`，也证明不了 `app.ts` 的 prompt 路由
 *   真的把**用户问句**喂了进来 —— 而用户问句正是「该画没画」的唯一分母来源。
 *   （同款教训见 `session-manager.toolmetrics.test.ts` 文件头：只驱动结算器时
 *   把 `attachEvents` 的接线整段注释掉依然全绿。）
 *
 * 变异验证实测见本文件末尾注释。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../session-manager.js";
import { Metrics } from "../metrics.js";
import { buildApp } from "../app.js";
import { DEFAULT_RUNTIME_CONFIG } from "../runtime-config.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { graphTurnObserver } from "./observer-instance.js";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-graphobs-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

let cfgSeq = 0;
function testConfig(): RuntimeConfig {
	return {
		...DEFAULT_RUNTIME_CONFIG,
		dataRoot: join(TEST_ROOT, `g${++cfgSeq}`),
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
	};
}

/** 最小 harness 替身：记录订阅者、派发真事件（抄 `session-manager.toolmetrics.test.ts`）。 */
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
	};
}

/**
 * 读某个指标族当前的累计值（跨 label 求和）。
 *
 * ⚠️ 为什么必须读**增量**而不是写死绝对值：`graphMetrics` 是进程级单例，
 * 同一测试文件内多个用例会累加。写死 `1` 会让第二个用例因为拿到 `2` 而假红
 * （那是测试自己的问题，不是实现的）—— 增量才是「这一轮贡献了多少」的正确判据。
 */
function readCounter(out: string, name: string): number {
	let total = 0;
	for (const line of out.split("\n")) {
		if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
		const m = line.match(/\s(\d+)$/);
		if (m) total += Number(m[1]);
	}
	return total;
}

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
	const sm = new SessionManager([], "", undefined, factory, undefined, undefined, testConfig(), undefined, metrics);
	await sm.create("sess-graph", { userId: "u1" });
	return { sm, events };
}

test("真事件经 attachEvents → /metrics：模型自述 + 绕路 + 画图 + view/param 全部落地", async () => {
	const metrics = new Metrics();
	const { events } = await makeManager(metrics);
	const base = metrics.render(0, "test");
	const before = {
		signal: readCounter(base, "pi_runtime_graph_signal_total"),
		drew: readCounter(base, "pi_runtime_graph_drew_total"),
		view: readCounter(base, "pi_runtime_graph_view_total"),
		legacy: readCounter(base, "pi_runtime_graph_view_legacy_total"),
	};

	events.emit("turn_start", {});
	// 模型自述（绕路自白）：命中严格词表里的「时间线」
	events.emit("message_update", { event: { type: "text_delta", delta: "我先画一个时间线" } });
	events.emit("tool_start", { toolCallId: "c1", toolName: "web_search", args: {} });
	events.emit("tool_start", {
		toolCallId: "c2",
		toolName: "render_canvas_view",
		args: { view: "topology", relation: "dependency", title: "沙丘" },
	});
	events.emit("turn_end", {});

	const out = metrics.render(0, "test");
	assert.match(out, /pi_runtime_graph_signal_total\{source="assistant"\}/);
	assert.equal(readCounter(out, "pi_runtime_graph_signal_total") - before.signal, 1);
	assert.equal(readCounter(out, "pi_runtime_graph_drew_total") - before.drew, 1);
	assert.match(out, /pi_runtime_graph_detour_total\{tool="web_search"\} 1/);
	// topology 归一到 layout，且 legacy 单独计数（不双计）
	assert.match(out, /pi_runtime_graph_view_total\{view="layout"\} 1/);
	assert.equal(readCounter(out, "pi_runtime_graph_view_total") - before.view, 1);
	assert.equal(readCounter(out, "pi_runtime_graph_view_legacy_total") - before.legacy, 1);
	// 参数只进名字
	assert.match(out, /pi_runtime_graph_param_total\{param="relation"\} 1/);
	assert.match(out, /pi_runtime_graph_param_total\{param="title"\} 1/);
	// ⛔ 参数值（用户可控文本「沙丘」）绝不能出现在 /metrics 里
	assert.equal(out.includes("沙丘"), false);
});

test("该画没画：命中信号但零调用 ⇒ 分母 +1、分子 +0（补当前唯一盲区）", async () => {
	const metrics = new Metrics();
	const { events } = await makeManager(metrics);
	const base = metrics.render(0, "test");
	const sigBefore = readCounter(base, "pi_runtime_graph_signal_total");
	const drewBefore = readCounter(base, "pi_runtime_graph_drew_total");

	events.emit("turn_start", {});
	events.emit("message_update", { event: { type: "text_delta", delta: "我来梳理成图说明关系" } });
	events.emit("turn_end", {});

	const out = metrics.render(0, "test");
	assert.match(out, /pi_runtime_graph_signal_total\{source="assistant"\}/);
	assert.equal(readCounter(out, "pi_runtime_graph_signal_total") - sigBefore, 1);
	assert.equal(readCounter(out, "pi_runtime_graph_drew_total") - drewBefore, 0);
});

test("用户问句经 /sessions/:id/prompt 进入观测（app.ts 接线可证伪）", async () => {
	const root = join(TEST_ROOT, "app");
	const manager = new SessionManager([], "", undefined, (async () => ({
		harness: {
			events: { on: () => () => {} },
			lane: async () => ({ prompt: async () => ({ ok: true }), setThinkingLevel: async () => {} }),
			close: async () => {},
		},
	})) as never, undefined, undefined, { ...DEFAULT_RUNTIME_CONFIG, dataRoot: root });
	const metrics = new Metrics();
	const app = buildApp(manager, { metrics, version: "test" });
	await manager.create("sess-app", { userId: "u1" });
	const base = metrics.render(0, "test");
	const sigBefore = readCounter(base, "pi_runtime_graph_signal_total");
	const drewBefore = readCounter(base, "pi_runtime_graph_drew_total");

	const res = await app.inject({
		method: "POST",
		url: "/sessions/sess-app/prompt",
		payload: { text: "帮我画个示意图说明这几个资产的关系" },
	});
	assert.equal(res.statusCode, 202);

	// 结算这一轮（真事件流里由 turn_end 触发）
	graphTurnObserver.feed({ kind: "turn_end" });

	const out = metrics.render(0, "test");
	assert.match(out, /pi_runtime_graph_signal_total\{source="user"\}/);
	assert.equal(readCounter(out, "pi_runtime_graph_signal_total") - sigBefore, 1);
	assert.equal(readCounter(out, "pi_runtime_graph_drew_total") - drewBefore, 0);
});

/*
 * 变异验证（实测）：
 *   1. 注释掉 `session-manager.ts` 里 `tool_start` 分支的 `graphTurnObserver.feed(...)`
 *      ⇒ 用例 1 的 `drew_total 1` / detour / view / param 断言全红。
 *   2. 注释掉 `app.ts` prompt 路由里的 `graphTurnObserver.feed({kind:"user_text"})`
 *      ⇒ 用例 3 的 `signal_total{source="user"}` 断言红。
 *   3. 去掉 `metrics.ts` 里的 `graphMetrics.renderInto(lines)`
 *      ⇒ 三个用例全部红（指标算了但没出口）。
 */
