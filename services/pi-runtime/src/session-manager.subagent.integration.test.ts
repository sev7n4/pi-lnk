/**
 * C4 spawn_subagent 端到端集成（spec docs/superpowers/specs/2026-10-10-c4-subagent-design.md §3，
 * Review Focus §5 九条 → 本文件兑现 1/2/3/4/5/7 条）。
 *
 * faux provider 真实 harness（骨架同 session-manager.subagent.test.ts / turn-budget.integration.test.ts）。
 * 与单测的区别：spawn_subagent 真实注册进主会话工具表、SubagentCoordinator 真实 attach(sm)、
 * 子 run 由主 run 的 assistant toolUse 真实触发（嵌套 run，非测试直调）。
 *
 * faux 行为备忘（providers/faux.ts 实证）：
 *   - FauxResponseStep 可以是工厂函数（context,options,state,model)=>AssistantMessage|Promise——
 *     返回 never-resolving Promise = LLM 挂起桩（超时/并发场景）；外部持有 resolver 可延迟放行。
 *   - 响应队列空 → stopReason:"error"（"No more faux responses queued"）→ run 结算 failed（异常隔离场景）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { AgentHarness } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, type EventListener } from "./session-manager.js";
import { SubagentCoordinator } from "./gate/subagent.js";
import { createSpawnSubagentTool } from "./tools/spawn-subagent.js";
import { buildWebTools } from "./tools/registry.js";
import { buildTodoTools, resetTodoStoreForTest } from "./tools/todo.js";
import { isSubagentTool } from "./gate/subagent.js";
import { Metrics } from "./metrics.js";
import type { LnkpiTool } from "./tools/types.js";
import type { RuntimeConfig } from "./runtime-config.js";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-subagent-e2e-"));
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

const todoTools = (): LnkpiTool[] => buildTodoTools();

interface HarnessCapture {
	tools: Array<{ name: string }>;
	activeToolNames: string[];
}

/**
 * 集成装配：spawn_subagent 真实入表 + coordinator.attach(sm) + factory spy。
 * 返回 captured（每次 harnessFactory 调用的 tools/activeToolNames，k=0 主会话，k≥1 子会话）。
 */
function makeE2e(
	metrics: Metrics,
	responses: unknown[],
) {
	const captured: HarnessCapture[] = [];
	const coordinator = new SubagentCoordinator();
	const spawnTool = createSpawnSubagentTool(coordinator, metrics);
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
		return AgentHarness.create(...args);
	};
	const tools: LnkpiTool[] = [...buildWebTools(), ...todoTools(), spawnTool];
	const sm = new SessionManager(tools, "", modelFactory, harnessFactory as never, {}, undefined, baseConfig(), undefined, metrics);
	coordinator.attach(sm); // SubagentRunner：runSubagent(piSessionKey, task) 兼容（第 3 参可选）
	return { sm, captured, coordinator, spawnTool };
}

function waitAgentEnd(sm: SessionManager, threadKey: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			sm.unsubscribe(threadKey, listener);
			reject(new Error("agent_end 等待超时"));
		}, 20_000);
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

/** 事件收集器：spawn 工具结果断言 + error 事件隔离断言都从这里取。 */
function collectEvents(sm: SessionManager, threadKey: string): Array<Record<string, unknown>> {
	const events: Array<Record<string, unknown>> = [];
	sm.subscribe(threadKey, (e) => events.push(e as unknown as Record<string, unknown>));
	return events;
}

async function waitSourceIdle(sm: SessionManager, threadKey: string): Promise<void> {
	for (let i = 0; i < 100; i++) {
		const sessions = (sm as unknown as { sessions: Map<string, { prompting: boolean }> }).sessions;
		const entry = sessions.get(threadKey);
		if (!entry || !entry.prompting) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("主会话 settle 等待超时");
}

function toolEndPayload(events: Array<Record<string, unknown>>, toolName: string): string {
	const end = events.find(
		(e) => e.type === "tool_execution_end" && JSON.stringify(e).includes(`"toolName":"${toolName}"`),
	);
	assert.ok(end, `缺少 ${toolName} 的 tool_execution_end 事件`);
	return JSON.stringify(end);
}

function subKeys(sm: SessionManager): string[] {
	const sessions = (sm as unknown as { sessions: Map<string, unknown> }).sessions;
	return [...sessions.keys()].filter((k) => k.includes("__sub_"));
}

test("端到端 fork 正确性：主 run 第一轮 spawn → 子 run 报告回流 tool_result → 主第二轮收尾", async () => {
	resetTodoStoreForTest();
	const metrics = new Metrics();
	const { sm } = makeE2e(metrics, [
		fauxAssistantMessage([fauxToolCall("spawn_subagent", { task: "调研X" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("调研结论：X", { stopReason: "stop" }),
		fauxAssistantMessage("收尾：已引用子代理报告", { stopReason: "stop" }),
	]);
	const threadKey = "s-e2e-fork";
	await sm.create(threadKey, { userId: "u1" });
	const events = collectEvents(sm, threadKey);
	await sm.prompt(threadKey, "开始");
	await waitAgentEnd(sm, threadKey);
	await waitSourceIdle(sm, threadKey);

	// spawn 工具的 tool_execution_end 携带子代理报告（fail-soft JSON 文本）
	const payload = toolEndPayload(events, "spawn_subagent");
	assert.match(payload, /调研结论：X/, "子代理报告未回流到主 run 的 tool_result");
	// 主 run 正常收尾（agent_end 已到）且无 error 事件
	assert.ok(!events.some((e) => e.type === "error"), `主 run 出现 error 事件: ${JSON.stringify(events.filter((e) => e.type === "error"))}`);
});

test("端到端白名单硬边界：子 harness 工具表 ⊆ 白名单，web 双工具在表（裁决 8 可审计面）", async () => {
	resetTodoStoreForTest();
	const metrics = new Metrics();
	const { sm, captured } = makeE2e(metrics, [
		fauxAssistantMessage("主对话第一轮", { stopReason: "stop" }),
		fauxAssistantMessage("调研结论：X", { stopReason: "stop" }),
	]);
	const threadKey = "s-e2e-wl";
	await sm.create(threadKey, { userId: "u1" });
	await sm.prompt(threadKey, "开始");
	await waitAgentEnd(sm, threadKey);
	await waitSourceIdle(sm, threadKey);

	const outcome = await sm.runSubagent(threadKey, "调研任务");
	assert.equal(outcome.status, "completed");
	const sub = captured[captured.length - 1]!;
	assert.ok(sub.tools.length > 0, "子工具表非空（有效性断言）");
	for (const t of sub.tools) {
		assert.ok(isSubagentTool(t.name), `白名单外工具进入子会话: ${t.name}`);
	}
	assert.ok(sub.tools.some((t) => t.name === "web_search"), "web_search 应在子工具表（net-egress 宽派 + 可审计）");
	assert.ok(sub.tools.some((t) => t.name === "web_fetch"), "web_fetch 应在子工具表");
	assert.ok(!sub.tools.some((t) => t.name === "spawn_subagent"), "禁止嵌套派发");
	assert.ok(!sub.tools.some((t) => t.name === "propose_plan"), "C3 旁路：子代理无 propose_plan");
	assert.ok(sub.activeToolNames.length === sub.tools.length, "白名单全量激活（tiering off）");
});

test("端到端并发闸：并发满（2 槽）后第 3 个 spawn 得 subagent_concurrency_full，放行后主 run 正常收尾", async () => {
	resetTodoStoreForTest();
	const metrics = new Metrics();
	// 子 run 的 LLM 响应 = 可外部放行的挂起工厂（faux FauxResponseStep 工厂形态）。
	// 3 个挂起位：①主 run 的 spawn 占槽 1 ②探针 A 占槽 2 ③探针 B 撞闸被拒（MAX=2）。
	const resolvers: Array<(m: AssistantMessage) => void> = [];
	const hangFactory = (): Promise<AssistantMessage> =>
		new Promise<AssistantMessage>((resolve) => {
			resolvers.push(resolve);
		});
	const { sm, spawnTool } = makeE2e(metrics, [
		fauxAssistantMessage([fauxToolCall("spawn_subagent", { task: "长调研" })], { stopReason: "toolUse" }),
		hangFactory,
		hangFactory,
		fauxAssistantMessage("收尾：报告已回流", { stopReason: "stop" }),
	]);
	const threadKey = "s-e2e-conc";
	await sm.create(threadKey, { userId: "u1" });
	const events = collectEvents(sm, threadKey);
	await sm.prompt(threadKey, "开始");

	// 等子 run 真正占住全局槽位（内部 sessions 出现 __sub_ 键——C2 wiring 同族姿势）
	let occupied = false;
	for (let i = 0; i < 100; i++) {
		if (subKeys(sm).length > 0) {
			occupied = true;
			break;
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.ok(occupied, "子 run 未能在 5s 内启动（fork/build 卡住？）");

	// 探针 A：第 2 槽，被接受（其子 run 挂在第 2 个工厂上）
	const invocation = { invocationId: "inv", operationId: "op", turnId: "t", getMemo: async () => undefined, setMemo: async () => {} };
	const execProbe = () =>
		spawnTool.execute("probe", { task: "探针" } as never, () => {}, { piSessionKey: threadKey } as never, invocation as never, {} as never);
	const probeA = execProbe();
	// 等探针 A 的子 run 真正挂起：resolver 在 faux 流的 queueMicrotask 里才赋值，
	// 晚于 sub entry 注册——resolvers.length ≥ 2 才是「第 2 个 LLM 调用已挂」的权威信号
	for (let i = 0; i < 100 && resolvers.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
	assert.equal(resolvers.length, 2, "探针 A 的子 run 未挂起（LLM 调用未到达挂起工厂）");

	// 探针 B：并发满（2/2），fail-soft 被拒——主 run 不打断
	const resB = await execProbe();
	const bodyB = JSON.parse((resB.content as Array<{ text: string }>)[0].text) as Record<string, unknown>;
	assert.equal(bodyB.ok, false);
	assert.equal(bodyB.error, "subagent_concurrency_full");

	// 逆序放行：探针 A（resolver[1]）→ 主 run 的 spawn（resolver[0]）→ 主 run 收尾
	resolvers[1]!(fauxAssistantMessage("延迟报告A", { stopReason: "stop" }));
	await probeA;
	resolvers[0]!(fauxAssistantMessage("延迟报告", { stopReason: "stop" }));
	await waitAgentEnd(sm, threadKey);
	await waitSourceIdle(sm, threadKey);
	const payload = toolEndPayload(events, "spawn_subagent");
	assert.match(payload, /延迟报告/, "放行后报告未回流");
	assert.ok(!events.some((e) => e.type === "error"), "主 run 出现 error 事件");
});

test("端到端超时硬停：挂起子 run 撞 timeoutMs → status=timeout，子 entry 摘除，主会话存活", async () => {
	resetTodoStoreForTest();
	const metrics = new Metrics();
	const { sm } = makeE2e(metrics, [
		fauxAssistantMessage("主对话第一轮", { stopReason: "stop" }),
		() => new Promise<AssistantMessage>(() => {}), // 子 run LLM 永挂
		fauxAssistantMessage("主对话第二轮", { stopReason: "stop" }),
	]);
	const threadKey = "s-e2e-timeout";
	await sm.create(threadKey, { userId: "u1" });
	await sm.prompt(threadKey, "开始");
	await waitAgentEnd(sm, threadKey);
	await waitSourceIdle(sm, threadKey);

	const outcome = await sm.runSubagent(threadKey, "长调研", { timeoutMs: 80 });
	assert.equal(outcome.status, "timeout");
	// 子 entry 已摘除（清理铁律：sessions.delete）
	assert.deepEqual(subKeys(sm), [], "子 entry 未从 sessions map 摘除");
	// 主会话仍可正常跑（env/repo 未被误关）
	await sm.prompt(threadKey, "继续");
	await waitAgentEnd(sm, threadKey);
});

test("端到端用量不丢：sub run 的 LLM 调用进 metrics usage（build 内接线对子 entry 生效）", async () => {
	resetTodoStoreForTest();
	const metrics = new Metrics();
	const { sm } = makeE2e(metrics, [
		fauxAssistantMessage("主对话第一轮", { stopReason: "stop" }),
		fauxAssistantMessage("调研结论：X", { stopReason: "stop" }),
	]);
	const threadKey = "s-e2e-usage";
	await sm.create(threadKey, { userId: "u1" });
	await sm.prompt(threadKey, "开始");
	await waitAgentEnd(sm, threadKey);
	await waitSourceIdle(sm, threadKey);
	const before = metrics.render(1, "test").match(/pi_runtime_usage_tokens_total\{kind="output"\} (\d+)/)?.[1] ?? "0";

	const outcome = await sm.runSubagent(threadKey, "调研任务");
	assert.equal(outcome.status, "completed");
	const after = metrics.render(1, "test").match(/pi_runtime_usage_tokens_total\{kind="output"\} (\d+)/)?.[1] ?? "0";
	assert.ok(Number(after) > Number(before), `sub run 未产生 usage 计量（output ${before} → ${after}）`);
});

test("端到端异常隔离：子 run LLM 失败 → spawn fail-soft 返回 subagent_failed，主 run 零 error 事件正常收尾", async () => {
	resetTodoStoreForTest();
	const metrics = new Metrics();
	// 故障注入（faux 工厂形态，按请求上下文判别）：
	//   call1 主 t1：1 条 user 消息                                → 返回 toolUse 响应
	//   call2 子 run：fork 历史（user+assistant）+ task user = ≥2 条 user 且无 toolResult → throw = LLM 故障
	//   call3 主 t2：含 toolResult（即便错位命中本条也安全返回静态文本）
	const responses: unknown[] = [
		fauxAssistantMessage([fauxToolCall("spawn_subagent", { task: "调研X" })], { stopReason: "toolUse" }),
		(context: { messages: Array<{ role?: string }> }) => {
			const userCount = context.messages.filter((m) => m.role === "user").length;
			const hasToolResult = context.messages.some((m) => m.role === "toolResult");
			if (userCount >= 2 && !hasToolResult) throw new Error("子代理 LLM 故障注入");
			return fauxAssistantMessage("收尾：子代理失败但不影响主对话", { stopReason: "stop" });
		},
		fauxAssistantMessage("收尾：子代理失败但不影响主对话", { stopReason: "stop" }),
	];
	const { sm } = makeE2e(metrics, responses);
	const threadKey = "s-e2e-iso";
	await sm.create(threadKey, { userId: "u1" });
	const events = collectEvents(sm, threadKey);
	await sm.prompt(threadKey, "开始");
	await waitAgentEnd(sm, threadKey);
	await waitSourceIdle(sm, threadKey);

	const payload = toolEndPayload(events, "spawn_subagent");
	assert.match(payload, /subagent_failed/, "子 run 失败未以 fail-soft 语义回流");
	assert.match(payload, /"ok":false/, "spawn 应以 ok:false 报告失败");
	assert.ok(!events.some((e) => e.type === "error"), `主 run 出现 error 事件（异常隔离失效）: ${JSON.stringify(events.filter((e) => e.type === "error"))}`);
});
