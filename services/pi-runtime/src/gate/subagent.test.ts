/**
 * C4 子代理三件套/白名单/并发闸（spec docs/superpowers/specs/2026-10-10-c4-subagent-design.md §3.3/§3.4）。
 * 「幽灵工具」用例把白名单名单钉在真实注册面上——防猜名空集假绿（备忘「空集假绿家族」）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	SUBAGENT_MAX_CONCURRENT,
	SUBAGENT_TURN_BUDGET,
	SUBAGENT_TIMEOUT_MS,
	SUBAGENT_REPORT_MAX_CHARS,
	SUBAGENT_TOOL_WHITELIST,
	isSubagentTool,
	SubagentSlots,
	SubagentCoordinator,
	type SubagentOutcome,
} from "./subagent.js";
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
				...buildReadDocumentTools(client),
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
