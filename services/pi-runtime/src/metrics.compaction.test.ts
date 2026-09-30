import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Metrics } from "./metrics.js";
import { SessionManager } from "./session-manager.js";
import { DEFAULT_RUNTIME_CONFIG } from "./runtime-config.js";
import { buildApp } from "./app.js";

describe("metrics 新增四项", () => {
	it("render 输出 sessions_live / resumes / compactions / rejections", () => {
		const m = new Metrics();
		m.observeSessionResume("disk");
		m.observeSessionResume("disk");
		m.observeSessionResume("rebuilt");
		m.observeCompaction("ok");
		m.observePromptRejection("busy");
		const text = m.render(3, "0.0.15");
		assert.match(text, /pi_runtime_sessions_live 3/);
		assert.match(text, /pi_runtime_session_resumes_total\{outcome="disk"\} 2/);
		assert.match(text, /pi_runtime_session_resumes_total\{outcome="rebuilt"\} 1/);
		assert.match(text, /pi_runtime_compactions_total\{result="ok"\} 1/);
		assert.match(text, /pi_runtime_prompt_rejections_total\{reason="busy"\} 1/);
	});

	it("无样本时不输出样本行（Prometheus 语义：只出 HELP/TYPE）", () => {
		const m = new Metrics();
		const text = m.render(0, "0.0.15");
		assert.ok(!text.includes("pi_runtime_session_resumes_total{"));
		assert.ok(!text.includes("pi_runtime_compactions_total{"));
		assert.ok(!text.includes("pi_runtime_prompt_rejections_total{"));
		assert.match(text, /pi_runtime_sessions_live 0/);
	});
});

describe("compaction 事件透传（vendor 事件名 compaction_start / compaction_end）", () => {
	function makeManager(root: string, results: string[]) {
		const handlers = new Map<string, (evt: unknown) => void>();
		const factory = (async () => ({
			harness: {
				events: {
					on: (type: string, cb: (evt: unknown) => void) => {
						handlers.set(type, cb);
						return () => {};
					},
				},
				lane: async () => ({ prompt: async () => ({ ok: true }), setThinkingLevel: async () => {} }),
				close: async () => {},
			},
		})) as never;
		const sm = new SessionManager(
			[],
			"",
			undefined,
			factory,
			undefined,
			undefined,
			{ ...DEFAULT_RUNTIME_CONFIG, dataRoot: root },
			(r) => results.push(r),
		);
		return { sm, handlers };
	}

	it("start/end 均归一为 compaction 事件；只有 completed 计 ok、failed 计 error", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-compact-"));
		try {
			const results: string[] = [];
			const { sm, handlers } = makeManager(root, results);
			await sm.create("s1:t1", {});
			const events: string[] = [];
			sm.subscribe("s1:t1", (e) => events.push(e.type));

			handlers.get("compaction_start")?.({ lane: "main", reason: "threshold" });
			handlers.get("compaction_end")?.({ lane: "main", status: "completed" });
			handlers.get("compaction_end")?.({ lane: "main", status: "failed" });
			handlers.get("compaction_end")?.({ lane: "main", status: "aborted" });
			handlers.get("compaction_end")?.({ lane: "main", status: "declined" });

			assert.deepEqual(events, ["compaction", "compaction", "compaction", "compaction", "compaction"]);
			assert.deepEqual(results, ["ok", "error"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("compaction 事件带 seq 且不打断既有事件序", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-compact-"));
		try {
			const results: string[] = [];
			const { sm, handlers } = makeManager(root, results);
			await sm.create("s1:t1", {});
			const seqs: number[] = [];
			sm.subscribe("s1:t1", (e) => seqs.push(e.seq));
			handlers.get("run_start")?.({ lane: "main" });
			handlers.get("compaction_start")?.({ lane: "main" });
			handlers.get("run_end")?.({ lane: "main" });
			assert.deepEqual(seqs, [0, 1, 2]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("路由层计数接线", () => {
	it("create 计 new/memory；busy 计 rejection", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-metrics-app-"));
		try {
			let release: (v: unknown) => void = () => {};
			const gate = new Promise((r) => {
				release = r;
			});
			const factory = (async () => ({
				harness: {
					events: { on: () => () => {} },
					lane: async () => ({
						prompt: async () => {
							await gate;
							return { ok: true };
						},
						setThinkingLevel: async () => {},
					}),
					close: async () => {},
				},
			})) as never;
			const manager = new SessionManager([], "", undefined, factory, undefined, undefined, {
				...DEFAULT_RUNTIME_CONFIG,
				dataRoot: root,
			});
			const metrics = new Metrics();
			const app = buildApp(manager, { metrics, version: "test" });
			try {
				await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1" } });
				await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1" } });
				await app.inject({ method: "POST", url: "/sessions/s1:t1/prompt", payload: { text: "一" } });
				await app.inject({ method: "POST", url: "/sessions/s1:t1/prompt", payload: { text: "二" } });
				const text = (await app.inject({ method: "GET", url: "/metrics" })).body;
				assert.match(text, /pi_runtime_session_resumes_total\{outcome="new"\} 1/);
				assert.match(text, /pi_runtime_session_resumes_total\{outcome="memory"\} 1/);
				assert.match(text, /pi_runtime_prompt_rejections_total\{reason="busy"\} 1/);
				assert.match(text, /pi_runtime_sessions_live 1/);
			} finally {
				await app.close();
				release(undefined);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("压缩跳过理由独立计数（诊断 F-01 · Review Focus #4）", () => {
	// plan 原稿此处写的是 `m.render()`，但 `render(activeSessions, version)` 两个参数都
	// 是必需的（metrics.ts:110）——无参调用会在 esc(undefined) 上 TypeError，必须给实参。
	it("跳过理由单独计数，不污染 pi_runtime_compactions_total", () => {
		const m = new Metrics();
		m.observeCompactionSkip("below_threshold");
		m.observeCompactionSkip("lane_busy");
		m.observeCompaction("ok");
		const text = m.render(0, "test");
		assert.match(text, /pi_runtime_compaction_skips_total\{reason="below_threshold"\} 1/);
		assert.match(text, /pi_runtime_compaction_skips_total\{reason="lane_busy"\} 1/);
		assert.match(text, /pi_runtime_compactions_total\{result="ok"\} 1/);
		assert.ok(!/compaction_skips_total\{reason="ok"\}/.test(text));
	});

	it("skips 无样本时不输出样本行（Prometheus 语义）", () => {
		const m = new Metrics();
		const text = m.render(0, "test");
		assert.match(text, /# TYPE pi_runtime_compaction_skips_total counter/);
		assert.ok(!text.includes("pi_runtime_compaction_skips_total{"));
	});
});
