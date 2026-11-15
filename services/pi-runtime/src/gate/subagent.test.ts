/**
 * C4 子代理三件套/白名单/并发闸（spec docs/superpowers/specs/2026-10-10-c4-subagent-design.md §3.3/§3.4）。
 * 「幽灵工具」用例把白名单名单钉在真实注册面上——防猜名空集假绿（备忘「空集假绿家族」）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyReportTruncation,
	SUBAGENT_MAX_CONCURRENT,
	SUBAGENT_TURN_BUDGET,
	SUBAGENT_TIMEOUT_MS,
	SUBAGENT_REPORT_MAX_CHARS,
	SUBAGENT_TOOL_WHITELIST,
	isSubagentTool,
	SubagentSlots,
	SubagentCoordinator,
	type SubagentOutcome,
	type SubagentStatus,
} from "./subagent.js";
import { SubtaskLedger } from "./subtask-ledger.js";
import { buildCanvasReadTools, buildWebTools } from "../tools/registry.js";
import { buildTodoTools } from "../tools/todo.js";
import { buildReadDocumentTools } from "../tools/read-document.js";
import { buildMemoryTools } from "../tools/memory.js";
import { NestClient } from "../tools/nest-client.js";

describe("C4 三件套常量（spec §3.4 硬编码不可禁用）", () => {
	it("并发 2 / 预算 30 / 超时 5min / 报告 20k", () => {
		assert.equal(SUBAGENT_MAX_CONCURRENT, 2);
		assert.equal(SUBAGENT_TURN_BUDGET, 30);
		assert.equal(SUBAGENT_TIMEOUT_MS, 300_000);
		assert.equal(SUBAGENT_REPORT_MAX_CHARS, 20_000);
	});
});

describe("白名单判定（spec §3.3 副作用面三类）", () => {
	it("读类 + todo_write + web 双工具在名单", () => {
		for (const name of [
			"todo_write",
			"recall_memory",
			"read_document",
			"web_search",
			"web_fetch",
			"get_canvas_summary",
			"list_model_options",
			"list_user_assets",
		]) {
			assert.ok(isSubagentTool(name), `${name} 应在白名单`);
		}
	});
	it("写域/交互/自身绝不在名单（逐项断言，防猜名空集假绿）", () => {
		for (const name of [
			"spawn_subagent",
			"ask_user",
			"propose_plan",
			"save_memory",
			"connect_nodes",
			"upsert_media_node",
			"set_node_text",
			"propose_generation",
			"delete_nodes",
			"arrange_nodes",
			"render_canvas_view",
			"remove_edges",
		]) {
			assert.ok(!isSubagentTool(name), `${name} 不应在白名单`);
		}
	});
	it("⭐ 白名单每个名字都真实存在于全量工具注册面（幽灵工具 = 名单猜错）", () => {
		const client = new NestClient({ baseUrl: "http://invalid", token: "t" });
		const registered = new Set<string>(
			[
				...buildTodoTools(),
				...buildCanvasReadTools(client),
				...buildWebTools(),
				...buildReadDocumentTools(),
				...buildMemoryTools(client),
			].map((t) => t.name),
		);
		assert.ok(registered.size > 0, "注册面非空（有效性断言）");
		for (const name of SUBAGENT_TOOL_WHITELIST) {
			assert.ok(registered.has(name), `白名单幽灵工具: ${name}`);
		}
	});
});

describe("SubagentSlots 全局并发闸（spec §3.4 并发=2）", () => {
	it("2 个可取，第 3 个拒绝，release 后可再取", () => {
		const s = new SubagentSlots();
		assert.ok(s.acquire());
		assert.ok(s.acquire());
		assert.equal(s.acquire(), false);
		assert.equal(s.active, 2);
		s.release();
		assert.ok(s.acquire());
	});
	it("release 不把 active 打成负数", () => {
		const s = new SubagentSlots();
		s.release();
		assert.equal(s.active, 0);
	});
});

describe("SubagentCoordinator（spawn 工具与 SessionManager 解耦中转）", () => {
	it("未 attach 时 tryRun 返回 not_attached", () => {
		const c = new SubagentCoordinator();
		assert.deepEqual(c.tryRun("k", "t"), { ok: false, reason: "not_attached" });
	});
	it("并发满时 tryRun 拒绝第 3 个且 release 后槽位回收", async () => {
		const c = new SubagentCoordinator();
		const releases: Array<() => void> = [];
		const runner = {
			runSubagent: (): Promise<SubagentOutcome> =>
				new Promise((resolve) => {
					releases.push(() => resolve({ report: "x", turns: 1, durationMs: 1, status: "completed" }));
				}),
		};
		c.attach(runner);
		const first = c.tryRun("k", "t1");
		assert.ok(first.ok);
		const second = c.tryRun("k", "t2");
		assert.ok(second.ok);
		assert.deepEqual(c.tryRun("k", "t3"), { ok: false, reason: "concurrency_full" });
		releases[0]!();
		releases[1]!();
		await Promise.all([first.ok ? first.promise : Promise.resolve(), second.ok ? second.promise : Promise.resolve()]);
		assert.ok(c.tryRun("k", "t4").ok);
	});
	it("runner 抛错：promise 永不 reject，转 status=failed 且槽位归还", async () => {
		const c = new SubagentCoordinator();
		c.attach({
			runSubagent: () => Promise.reject(new Error("boom")),
		});
		const first = c.tryRun("k", "t1");
		assert.ok(first.ok);
		const outcome = await first.promise;
		assert.equal(outcome.status, "failed");
		assert.match(outcome.report, /boom/);
		assert.ok(c.tryRun("k", "t2").ok);
	});
});

// —— 刀B（2026-11-14）：applyReportTruncation 唯一实现点（spec 2026-11-14 §4.3）——
describe("applyReportTruncation 截断边界", () => {
	it("恰 20_000：不截、无 truncated 字段", () => {
		const r = applyReportTruncation("a".repeat(20_000));
		assert.equal(r.report.length, 20_000);
		assert.equal("truncated" in r, false);
	});
	it("20_001：截到 20_000 且 truncated=true", () => {
		const r = applyReportTruncation("b".repeat(20_001));
		assert.equal(r.report.length, 20_000);
		assert.equal(r.truncated, true);
	});
	it("空串：不截", () => {
		const r = applyReportTruncation("");
		assert.equal(r.report, "");
		assert.equal("truncated" in r, false);
	});
});

// —— 刀A（2026-11-14）：coordinator background / collect / 账本（spec 2026-11-14 §6.2/§6.5）——
describe("SubagentCoordinator D2 + non-block", () => {
	/** 可控 deferred runner：手动放行每个子 run */
	function deferredRunner(): { runner: { runSubagent: () => Promise<SubagentOutcome> }; releaseAll: () => void } {
		const releases: Array<() => void> = [];
		return {
			runner: {
				runSubagent: () =>
					new Promise((resolve) => {
						releases.push(() => resolve({ report: "R", turns: 1, durationMs: 1, status: "completed" }));
					}),
			},
			releaseAll: () => releases.forEach((r) => r()),
		};
	}

	it("block：返回 callId，settle 后账本有 spawned+terminal 两记录", async () => {
		const dir = mkdtempSync(join(tmpdir(), "coord-ledger-"));
		const ledger = new SubtaskLedger(dir);
		const c = new SubagentCoordinator(ledger);
		c.attach({ runSubagent: async () => ({ report: "R", turns: 1, durationMs: 1, status: "completed" }) });
		const r = c.tryRun("k", "task-a");
		assert.ok(r.ok);
		assert.ok(r.callId.length > 10);
		await r.promise;
		const text = readFileSync(ledger.filePath, "utf8");
		assert.match(text, /"type":"spawned"/);
		assert.match(text, /"type":"terminal".*"status":"completed"/);
		const collected = c.collect(r.callId);
		assert.equal(collected.status, "completed");
		assert.ok("report" in collected && collected.report === "R");
	});

	it("background：立即返回不阻塞；collect→running→settle→终态；槽位释放", async () => {
		const { runner, releaseAll } = deferredRunner();
		const c = new SubagentCoordinator();
		c.attach(runner);
		const r = c.tryRun("k", "task-b", { mode: "background" });
		assert.ok(r.ok);
		assert.equal(c.collect(r.callId).status, "running");
		releaseAll();
		await r.promise;
		const done = c.collect(r.callId);
		assert.equal(done.status, "completed");
		// 槽位已释放：再来两个 block 也不该拒
		const a = c.tryRun("k", "x");
		const b = c.tryRun("k", "y");
		assert.ok(a.ok && b.ok);
		a.ok && void a.promise;
		b.ok && void b.promise;
	});

	it("并发挤占：2 个 background 占满后第 3 个（block）fail-soft 拒绝，不挂起", async () => {
		const { runner, releaseAll } = deferredRunner();
		const c = new SubagentCoordinator();
		c.attach(runner);
		const r1 = c.tryRun("k", "b1", { mode: "background" });
		const r2 = c.tryRun("k", "b2", { mode: "background" });
		assert.ok(r1.ok && r2.ok);
		const r3 = c.tryRun("k", "b3");
		assert.deepEqual(r3, { ok: false, reason: "concurrency_full" });
		releaseAll();
		await Promise.all([r1.ok && r1.promise, r2.ok && r2.promise].filter(Boolean));
	});

	it("重启取证：新 coordinator 同账本，spawned 无 terminal → interrupted", async () => {
		const dir = mkdtempSync(join(tmpdir(), "coord-restart-"));
		const ledger = new SubtaskLedger(dir);
		const old = new SubagentCoordinator(ledger);
		old.attach({ runSubagent: () => new Promise(() => {}) }); // 永不 settle（模拟进程蒸发）
		const r = old.tryRun("k", "lost", { mode: "background" });
		assert.ok(r.ok);
		// 新进程：新 coordinator 复用同一账本目录
		const fresh = new SubagentCoordinator(ledger);
		const got = fresh.collect(r.callId);
		assert.equal(got.status, "interrupted");
	});

	it("账本无此 callId → unknown；ledger 缺省（旧构造）全链 no-op", async () => {
		const dir = mkdtempSync(join(tmpdir(), "coord-unknown-"));
		const ledger = new SubtaskLedger(dir);
		const c = new SubagentCoordinator(ledger);
		c.attach({ runSubagent: async () => ({ report: "R", turns: 1, durationMs: 1, status: "completed" }) });
		assert.equal(c.collect("nope").status, "unknown");
		// 旧构造（无 ledger）：行为不回归
		const legacy = new SubagentCoordinator();
		legacy.attach({ runSubagent: async () => ({ report: "R", turns: 1, durationMs: 1, status: "completed" }) });
		const r = legacy.tryRun("k", "t");
		assert.ok(r.ok);
		await r.promise;
		assert.equal(legacy.collect(r.callId).status, "completed");
	});

	it("重启后 terminal 在账本：新 coordinator collect 仍能取回 report", async () => {
		const dir = mkdtempSync(join(tmpdir(), "coord-recover-"));
		const ledger = new SubtaskLedger(dir);
		const first = new SubagentCoordinator(ledger);
		first.attach({ runSubagent: async () => ({ report: "可恢复报告", turns: 2, durationMs: 5, status: "completed" }) });
		const r = first.tryRun("k", "t");
		assert.ok(r.ok);
		await r.promise;
		const fresh = new SubagentCoordinator(ledger);
		const got = fresh.collect(r.callId);
		assert.equal(got.status, "completed");
		assert.ok("report" in got && got.report === "可恢复报告");
	});

	it("P3：partial + stream_interrupted 透传进账本与 collect", async () => {
		const dir = mkdtempSync(join(tmpdir(), "coord-partial-"));
		const ledger = new SubtaskLedger(dir);
		const c = new SubagentCoordinator(ledger);
		c.attach({
			runSubagent: async () => ({ report: "半截", turns: 1, durationMs: 1, status: "stream_interrupted", partial: true }),
		});
		const r = c.tryRun("k", "t");
		assert.ok(r.ok);
		await r.promise;
		const text = readFileSync(ledger.filePath, "utf8");
		assert.match(text, /"status":"stream_interrupted"/);
		assert.match(text, /"partial":true/);
		const got = c.collect(r.callId);
		assert.equal(got.status, "stream_interrupted");
		assert.ok("partial" in got && got.partial === true);
		// 重启 replay 也保留 partial
		const fresh = new SubagentCoordinator(ledger);
		const recovered = fresh.collect(r.callId);
		assert.ok("partial" in recovered && recovered.partial === true, "账本 replay 应保留 partial");
	});
});

describe("P1 pending-work：per-session 未收口索引", () => {
	it("background 登记 pending，settle 后清空；block 不登记", async () => {
		const { runner, releaseAll } = (() => {
			const releases: Array<() => void> = [];
			return {
				runner: {
					runSubagent: (): Promise<SubagentOutcome> =>
						new Promise((resolve) => {
							releases.push(() => resolve({ report: "R", turns: 1, durationMs: 1, status: "completed" }));
						}),
				},
				releaseAll: () => releases.forEach((r) => r()),
			};
		})();
		const c = new SubagentCoordinator();
		c.attach(runner);
		const bg = c.tryRun("s1", "bg-task", { mode: "background" });
		assert.ok(bg.ok);
		assert.deepEqual(c.pendingFor("s1"), [bg.callId], "background 应登记 pending");
		assert.deepEqual(c.pendingFor("s2"), [], "别的会话无 pending");
		// block 模式同步跑一个立即完成的
		c.attach({ runSubagent: async () => ({ report: "B", turns: 1, durationMs: 1, status: "completed" }) });
		const blk = c.tryRun("s1", "block-task");
		assert.ok(blk.ok);
		await blk.promise;
		assert.deepEqual(c.pendingFor("s1"), [bg.callId], "block 不应登记 pending");
		releaseAll();
		await (bg.ok && bg.promise);
		assert.deepEqual(c.pendingFor("s1"), [], "settle 后 pending 清空");
	});

	it("awaitSettled：等到终态返回值；deadline 到仍未 settle 则 interrupted", async () => {
		const { runner, releases, releaseAll } = (() => {
			const releases: Array<(s: SubagentStatus) => void> = [];
			return {
				runner: {
					runSubagent: (): Promise<SubagentOutcome> =>
						new Promise((resolve) => {
							releases.push((s) => resolve({ report: "DONE", turns: 1, durationMs: 1, status: s }));
						}),
				},
				releases,
				releaseAll: (s: SubagentStatus) => releases.forEach((r) => r(s)),
			};
		})();
		const c = new SubagentCoordinator();
		c.attach(runner);
		const a = c.tryRun("s", "a", { mode: "background" });
		const b = c.tryRun("s", "b", { mode: "background" });
		assert.ok(a.ok && b.ok);
		// 先只放行 a，b 留到 deadline
		releases[0]!("completed");
		const results = await c.awaitSettled([a.callId, b.callId], { deadlineMs: 60 });
		const byId = new Map(results.map((r) => [r.callId, r]));
		assert.equal(byId.get(a.callId)?.status, "completed");
		assert.equal(byId.get(a.callId)?.report, "DONE");
		assert.equal(byId.get(b.callId)?.status, "interrupted", "deadline 未 settle → interrupted");
		releaseAll("completed"); // 清理挂起的 b，避免测试进程悬挂
		await (b.ok && b.promise);
	});
});
