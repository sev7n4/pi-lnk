/**
 * C1 todo 快照的磁盘 resume + 跨压缩注入（spec 2026-10-09-task-tool-design.md §3.4）。
 *
 * 真 harness + faux 模型（合法性同 toolmetrics-realharness：只替换 LLM 边界，
 * 工具执行/details 持久化/jsonl 落盘全是真的）。用两个 SessionManager 实例指向
 * 同一 dataRoot 构造「进程重启后磁盘 resume」——第二个实例内存 miss → meta 命中 →
 * openExisting → build（resume 收敛点播种 transcript 快照）→ system prompt 含任务清单块。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager, toSessionKey, type EventListener } from "./session-manager.js";
import { buildTodoTools, getTodoState, resetTodoStoreForTest } from "./tools/todo.js";
import type { RuntimeConfig } from "./runtime-config.js";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-todo-resume-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

/** 同一 dataRoot 的共享配置（两个实例指向同一磁盘 = 模拟重启）。 */
function sharedConfig(): RuntimeConfig {
	return {
		dataRoot: TEST_ROOT,
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

function makeManager(): SessionManager {
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("todo_write", { todos: [{ content: "起稿", status: "in_progress" }] }, { id: "call-todo-1" })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done", { stopReason: "stop" }),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const modelFactory = () => ({ models, model: faux.getModel(), providerId: faux.provider.id });
	return new SessionManager(buildTodoTools(), "", modelFactory, undefined, undefined, undefined, sharedConfig());
}

/** 等 agent_end（prompt 是 fire-and-forget）。 */
function waitAgentEnd(sm: SessionManager, threadKey: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			sm.unsubscribe(threadKey, listener);
			reject(new Error("agent_end 等待超时"));
		}, 15_000);
		const listener: EventListener = (e) => {
			if (e.type === "agent_end") {
				clearTimeout(timer);
				sm.unsubscribe(threadKey, listener);
				resolve();
			}
		};
		sm.subscribe(threadKey, listener);
	});
}

test("todo resume：磁盘 resume 后播种快照 + dynamicBlock 注入", async () => {
	resetTodoStoreForTest();
	const threadKey = "sess-todo-resume";
	const key = toSessionKey(threadKey);

	// ── 第一段「进程」：跑一次真实 todo_write（details 快照落 jsonl）──
	const sm1 = makeManager();
	await sm1.create(threadKey, { userId: "u1" });
	await sm1.prompt(threadKey, "开始多步任务");
	await waitAgentEnd(sm1, threadKey);

	// 工具真执行过：内存 store 有快照（同进程动态块的直接数据源）
	assert.equal(getTodoState(key)[0]?.content, "起稿");
	assert.equal(getTodoState(key)[0]?.status, "in_progress");

	// ── 第二段「进程」：新 SessionManager 同 dataRoot → 内存 miss → 磁盘 resume ──
	// 先清 store：下断言只能靠「resume 收敛点播种」生效，排除第一段进程的内存残留（防假绿）。
	resetTodoStoreForTest();
	const sm2 = makeManager();
	const result = await sm2.create(threadKey, { userId: "u1" });
	assert.equal(result.status, "resumed");

	// 播种：resume 收敛点从 transcript 重建（Review Focus：快照经 pickLatestSnapshot 而非空播种）
	const seeded = getTodoState(key);
	assert.equal(seeded[0]?.content, "起稿");
	assert.equal(seeded[0]?.status, "in_progress");

	// 注入：system prompt 含任务清单块（in_progress 标记 = [~]）
	const sp = sm2.resolveSystemPromptForTest(threadKey);
	assert.ok(sp.includes("## 当前任务清单"), "system prompt 必须含任务清单块");
	assert.ok(sp.includes("[~] 起稿"), "in_progress 项必须以 [~] 标记渲染");
});

test("todo 零快照不注入（spec §3.4）", async () => {
	resetTodoStoreForTest();
	const threadKey = "sess-todo-empty";
	const sm = makeManager();
	await sm.create(threadKey, { userId: "u1" });
	const sp = sm.resolveSystemPromptForTest(threadKey);
	assert.ok(!sp.includes("## 当前任务清单"), "无快照不得注入任务清单块");
});
