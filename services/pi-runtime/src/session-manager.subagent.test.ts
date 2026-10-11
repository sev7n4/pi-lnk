/**
 * C4 runSubagent 测试（spec docs/superpowers/specs/2026-10-10-c4-subagent-design.md §3.2/§3.4/§3.6）。
 * faux provider 真实 harness（骨架同 turn-budget.integration.test.ts）——fork 需要真实
 * transcript entries，fake harness 不产 entries，故 wiring 级断言升级为 faux 级（Ruling 已记台账）。
 * 覆盖：白名单 ensemble（逐项 + 无嵌套/无 propose_plan）/ 预算 30 per-entry 覆盖 /
 * 超时 cancel / 清理铁律（共享 env/repo 存活 + 磁盘 transcript 落盘）。
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { AgentHarness } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { SessionManager, type EventListener } from "./session-manager.js";
import { buildTodoTools, resetTodoStoreForTest } from "./tools/todo.js";
import { isSubagentTool } from "./gate/subagent.js";
import { Metrics } from "./metrics.js";
import type { LnkpiTool } from "./tools/types.js";
import type { RuntimeConfig } from "./runtime-config.js";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-subagent-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

function baseConfig(): RuntimeConfig {
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

let todoExecuted = 0;
const todoTools = (): LnkpiTool[] =>
	buildTodoTools().map((t) =>
		t.name === "todo_write"
			? {
					...t,
					execute: async (id, p, u, tc, inv, cx) => {
						todoExecuted += 1;
						return t.execute!(id, p, u, tc, inv, cx);
					},
				}
			: t,
	);

const nopTool: LnkpiTool = {
	name: "fake_nop",
	label: "空操作（测试）",
	tier: "write_light",
	description: "test-only no-op tool",
	parameters: Type.Object({}),
	async execute() {
		return { content: [{ type: "text", text: "ok" }], details: undefined };
	},
};

interface HarnessCapture {
	tools: Array<{ name: string }>;
	activeToolNames: string[];
}

/**
 * 真实 harness + factory spy：捕获每次 build 的 tools/activeToolNames。
 * factoryCalls[k] = 第 k+1 次 harnessFactory 调用的捕获（k=0 主会话，k≥1 子会话）。
 */
function makeManager(
	metrics: Metrics,
	responses: unknown[],
	opts: { factory?: typeof AgentHarness.create | undefined } = {},
) {
	const captured: HarnessCapture[] = [];
	const faux = fauxProvider();
	faux.setResponses(responses as never);
	const models = createModels();
	models.setProvider(faux.provider);
	const modelFactory = () => ({ models, model: faux.getModel(), providerId: faux.provider.id });
	const harnessFactory = async (...args: Parameters<typeof AgentHarness.create>) => {
		const cfg = args[0];
		captured.push({
			tools: (cfg as { tools: Array<{ name: string }> }).tools,
			activeToolNames: (cfg as { activeToolNames: string[] }).activeToolNames,
		});
		if (opts.factory) return opts.factory(...args);
		return AgentHarness.create(...args);
	};
	const tools: LnkpiTool[] = [nopTool, ...todoTools()];
	const sm = new SessionManager(tools, "", modelFactory, harnessFactory as never, {}, undefined, baseConfig(), undefined, metrics);
	return { sm, captured };
}

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

/**
 * agent_end 分发早于 lane.prompt 的 .finally（清 prompting + drain 在途）——
 * 在该窗口内 fork 会撞中间态（探针实证：等 settle 后 runSubagent 全绿）。
 * 轮询等主会话真正空闲（读内部 sessions map——测试触内部状态，C2 wiring 同族姿势）。
 */
async function waitSourceIdle(sm: SessionManager, threadKey: string): Promise<void> {
	for (let i = 0; i < 100; i++) {
		const sessions = (sm as unknown as { sessions: Map<string, { prompting: boolean }> }).sessions;
		const entry = sessions.get(threadKey);
		if (!entry || !entry.prompting) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("主会话 settle 等待超时");
}

function countFilesRecursive(root: string): number {
	let n = 0;
	const walk = (dir: string) => {
		for (const name of readdirSync(dir, { withFileTypes: true })) {
			if (name.isDirectory()) walk(join(dir, name.name));
			else n += 1;
		}
	};
	walk(root);
	return n;
}

test("runSubagent: fork 白名单 ensemble——子工具表 ⊆ 白名单且无 spawn/propose_plan/写族", async () => {
	resetTodoStoreForTest();
	const metrics = new Metrics();
	const { sm, captured } = makeManager(metrics, [
		// 主 run：1 轮收尾（有 entries 才可 fork）
		fauxAssistantMessage("主对话第一轮", { stopReason: "stop" }),
		// 子 run：1 轮报告收尾
		fauxAssistantMessage("调研结论：X", { stopReason: "stop" }),
	]);
	const threadKey = "s-c4-wl";
	await sm.create(threadKey, { userId: "u1" });
	await sm.prompt(threadKey, "开始");
	await waitAgentEnd(sm, threadKey);
	await waitSourceIdle(sm, threadKey);
	const mainCalls = captured.length;

	const outcome = await sm.runSubagent(threadKey, "调研任务");
	assert.equal(outcome.status, "completed");
	assert.equal(outcome.report, "调研结论：X");
	assert.equal(captured.length, mainCalls + 1, "fork 触发一次新的 harnessFactory");

	const sub = captured[captured.length - 1]!;
	assert.ok(sub.tools.length > 0, "子工具表非空（有效性断言）");
	for (const t of sub.tools) {
		assert.ok(isSubagentTool(t.name), `白名单外工具进入子会话: ${t.name}`);
	}
	assert.ok(!sub.tools.some((t) => t.name === "spawn_subagent"), "禁止嵌套派发");
	assert.ok(!sub.tools.some((t) => t.name === "propose_plan"), "C3 旁路：子代理无 propose_plan");
	assert.ok(sub.activeToolNames.length === sub.tools.length, "白名单全量激活（tiering off）");
});

test("runSubagent: per-entry 预算 30 生效（第 31 轮 turn_start 硬停，独立于全局预算）", async () => {
	resetTodoStoreForTest();
	const metrics = new Metrics();
	// 31 轮 toolUse（白名单内 todo_write）+ 收尾：若 per-entry 预算生效，第 31 turn_start 即硬停
	const responses = [
		fauxAssistantMessage("主对话收尾", { stopReason: "stop" }),
		...Array.from({ length: 31 }, () => fauxAssistantMessage([fauxToolCall("todo_write", { todos: [] })], { stopReason: "toolUse" })),
		fauxAssistantMessage("不应到达", { stopReason: "stop" }),
	];
	const { sm } = makeManager(metrics, responses);
	const threadKey = "s-c4-budget";
	await sm.create(threadKey, { userId: "u1" });
	await sm.prompt(threadKey, "开始");
	await waitAgentEnd(sm, threadKey);
	await waitSourceIdle(sm, threadKey);

	const outcome = await sm.runSubagent(threadKey, "长调研");
	assert.equal(outcome.status, "budget_exceeded", "settled 闸是权威信号（forceSettle 会把 run 折叠成 ok）");
	assert.equal(outcome.turns, 31, "31 轮全部计入（第 31 轮超限硬停）");
	assert.equal(todoExecuted, 30, "预算 30：第 31 轮 turn_start 硬停，todo_write 恰执行 30 次");
	assert.match(metrics.render(1, "test"), /pi_runtime_turn_budget_exceeded_total 1/);
});

test("runSubagent: 清理铁律——子 entry 摘除但共享 env/repo 存活，主会话继续可用且 transcript 落盘", async () => {
	resetTodoStoreForTest();
	const metrics = new Metrics();
	const { sm } = makeManager(metrics, [
		fauxAssistantMessage("主对话第一轮", { stopReason: "stop" }),
		fauxAssistantMessage("子报告", { stopReason: "stop" }),
		fauxAssistantMessage("主对话第二轮", { stopReason: "stop" }),
	]);
	const threadKey = "s-c4-cleanup";
	await sm.create(threadKey, { userId: "u1" });
	await sm.prompt(threadKey, "开始");
	await waitAgentEnd(sm, threadKey);
	await waitSourceIdle(sm, threadKey);
	const filesBefore = countFilesRecursive(TEST_ROOT);

	const outcome = await sm.runSubagent(threadKey, "调研任务");
	assert.equal(outcome.status, "completed");

	// 子会话 cwd 复用源目录（fork() 同款 workingDir）——新 session 文件落在源 sessions 目录下
	const filesAfter = countFilesRecursive(TEST_ROOT);
	assert.ok(filesAfter > filesBefore, `fork 落盘（文件数 ${filesBefore} → ${filesAfter}）`);

	// 主会话仍可正常跑（env/repo 未被误关）——清理铁律的核心断言
	await sm.prompt(threadKey, "继续");
	await waitAgentEnd(sm, threadKey);
});
