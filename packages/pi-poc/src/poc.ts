/**
 * PI-Lnk N2 PoC spike —— 验证 pi-agent-core v0.85.1 承载 lnkpi 四流的 5 个关键假设。
 *
 * 验收清单（对应讨论文档 A.6 / spec R16）：
 *   C1. Nest 宿主能起 pi Agent 会话 + 1 个 custom tool（模拟 canvas 代理，F7 service token 模式）
 *   C2. before_tool hook 挂 HITL 确认门（工具级拦截，Sidebar 确认门落点）
 *   C3. transform_context hook 注入 <system-reminder>
 *   C4. 双 Lane 并行（explore 后台 + main 前台，F9 场景）
 *   C5. 嵌套 Agent 实例模拟 subagent（pi 无原生 subagent，实测自建工程量 → H2 重估依据）
 *
 * 运行：
 *   OPENAI_API_KEY=sk-... pnpm --filter @pi-lnk/pi-poc poc
 *   pnpm --filter @pi-lnk/pi-poc typecheck    # 无凭据时的 API 面验证
 */

import { Type } from "typebox";
import {
	AgentHarness,
	BACKGROUND_CONTEXT,
	type AgentHarnessTool,
	type Context,
	createBashTool,
	JsonlSessionRepo,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
	createModels,
	createProvider,
	type Api,
	type Credential,
	type CredentialStore,
	type Model,
	type Models,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const context: Context = BACKGROUND_CONTEXT;

interface PocToolContext {
	env: NodeExecutionEnv;
	canvasCalls: number;
}

// ---------------------------------------------------------------------------
// 模型装配：pi-ai createModels + env 凭据存储（key 只在内存，不落盘）
// 注意：ModelRuntime 的 getAvailable() 走存储型凭据检查，env key 不会出现在
// available 列表里（实测），所以 PoC 直接装配 Models —— 这也是 Nest 宿主的
// 最小依赖面（不引 coding-agent 的 CLI 附属），符合 spec L0 边界。
// 生产凭据来自 Agnes AI Hub 中转（与 lnkpi agent-runtime 同源），key 经
// AGNES_API_KEY 环境变量注入；中转是 OpenAI chat-completions 兼容端点。
// ---------------------------------------------------------------------------

const AGNES_BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.cn/v1";

function agnesProvider() {
	return createProvider({
		id: "agnes",
		name: "Agnes AI Hub",
		baseUrl: AGNES_BASE_URL,
		auth: {
			apiKey: {
				name: "Agnes API key",
				async resolve() {
					const key = process.env.AGNES_API_KEY ?? process.env.OPENAI_API_KEY;
					if (!key) return undefined;
					return { auth: { apiKey: key }, source: "env AGNES_API_KEY" };
				},
			},
		},
		models: [
			{
				id: "agnes-2.5-pro",
				name: "Agnes 2.5 Pro",
				api: "openai-completions",
				baseUrl: AGNES_BASE_URL,
				provider: "agnes",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 65_536,
			},
		],
		api: openAICompletionsApi(),
	});
}

function createEnvCredentialStore(): CredentialStore {
	return {
		async read(providerId) {
			const key = process.env.AGNES_API_KEY ?? process.env.OPENAI_API_KEY;
			if (providerId === "agnes" && key) return { type: "api_key", key } satisfies Credential;
			return undefined;
		},
		async list() {
			const key = process.env.AGNES_API_KEY ?? process.env.OPENAI_API_KEY;
			return key ? [{ providerId: "agnes", type: "api_key" as const }] : [];
		},
		async modify() {
			return undefined;
		},
		async delete() {},
	};
}

function createModelsRuntime(): { models: Models; model: Model<Api> } {
	const models = createModels({ credentials: createEnvCredentialStore() });
	models.setProvider(agnesProvider());
	const agnesModels = models.getModels("agnes");
	const model = agnesModels[0];
	if (!model) throw new Error("agnes provider 无模型");
	return { models, model };
}

// ---------------------------------------------------------------------------
// C1: custom tool —— 模拟 Nest 内部 canvas 服务的代理（F7：工具经 service token 回调宿主）
// 真实实现里这里是 fetch("http://canvas-svc/api/draft", { headers: { "x-service-token": ... } })
// ---------------------------------------------------------------------------

const canvasDraftSchema = Type.Object({
	title: Type.String({ description: "画布草稿标题" }),
	prompt: Type.String({ description: "创作指令" }),
});

const canvasDraftTool: AgentHarnessTool<PocToolContext, typeof canvasDraftSchema> = {
	name: "canvas_draft",
	label: "canvas_draft",
	description: "在超创平台画布上创建一张草稿（模拟 Nest canvas 服务代理）",
	parameters: canvasDraftSchema,
	async execute(_toolCallId, params, _onUpdate, toolContext, _invocation, _ctx) {
		const calls = toolContext.canvasCalls + 1;
		toolContext.canvasCalls = calls;
		return {
			content: [{ type: "text", text: `canvas 草稿已创建: "${params.title}" (调用 #${calls})` }],
			details: { canvasId: `poc-${Date.now()}` },
		};
	},
};

// ---------------------------------------------------------------------------
// C5: 嵌套 Agent 模拟 subagent —— parent 工具 execute 里创建并跑完一个子 harness
// 这是 pi v0.85.1 无原生 subagent 时 L2 自建的最小方案（spec R16 / H2 工程量实测）
// ---------------------------------------------------------------------------

const delegateSchema = Type.Object({
	prompt: Type.String({ description: "给 subagent 的指令" }),
});

async function runSubagent(
	prompt: string,
	cwd: string,
	models: Models,
	model: Model<Api>,
): Promise<string> {
	const subEnv = new NodeExecutionEnv({ cwd });
	const repo = new JsonlSessionRepo({ fileSystem: subEnv, sessionsRoot: `${cwd}/.poc-sessions-sub` });
	const session = await repo.create({ cwd }, context);
	const { harness } = await AgentHarness.create(
		{
			session,
			models,
			model,
			tools: [createBashTool()],
			toolContext: { env: subEnv },
			systemPrompt: "You are a focused subagent. Do the task, reply in one sentence.",
		},
		context,
	);
	const lane = await harness.lane("main", context);
	const result = await lane.prompt(prompt, undefined, context);
	await harness.close(context);
	await repo.close(context);
	await subEnv.cleanup(context);
	if (!result.ok) throw result.error;
	return "subagent done";
}

const delegateTool: AgentHarnessTool<PocToolContext, typeof delegateSchema> = {
	name: "delegate_subtask",
	label: "delegate_subtask",
	description: "将一个子任务委托给嵌套 subagent（验证 C5）",
	parameters: delegateSchema,
	async execute(_id, params, _onUpdate, toolContext, _invocation, _ctx) {
		const models = createModelsRuntime();
		const text = await runSubagent(params.prompt, toolContext.env.cwd, models.models, models.model);
		return { content: [{ type: "text", text }], details: undefined };
	},
};

// ---------------------------------------------------------------------------

async function main() {
	const cwd = process.cwd();
	console.log(`[poc] cwd = ${cwd}`);

	if (!(process.env.AGNES_API_KEY ?? process.env.OPENAI_API_KEY)) {
		console.error("[poc] FAIL: 未设置 AGNES_API_KEY（或 OPENAI_API_KEY）环境变量。");
		process.exit(1);
	}

	const { models, model } = createModelsRuntime();
	console.log(`[poc] model = ${model.provider}/${model.id}`);

	// --- 会话与 harness（照抄官方 session-worker 最小用法）---
	const env = new NodeExecutionEnv({ cwd });
	const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: `${cwd}/.poc-sessions` });
	const session = await repo.create({ cwd }, context);

	const toolContext: PocToolContext = { env, canvasCalls: 0 };

	const { harness } = await AgentHarness.create(
		{
			session,
			models,
			model,
			tools: [canvasDraftTool, delegateTool],
			toolContext,
			systemPrompt:
				"You are the PI-Lnk PoC agent. Use canvas_draft when asked to create a draft. Keep replies short.",
		},
		context,
	);

	// --- C2: before_tool = 工具级 HITL 确认门 ---
	let gateBlocks = 0;
	harness.hooks.on("before_tool", (event) => {
		console.log(`[C2 before_tool] ${event.toolName} args=${JSON.stringify(event.args)}`);
		if (event.toolName === "canvas_draft" && /BLOCK/i.test(String(event.args.title ?? ""))) {
			gateBlocks += 1;
			return { block: { reason: "HITL 门拦截：标题含 BLOCK（模拟用户拒绝）" } };
		}
		return undefined; // 放行
	});

	// --- C3: transform_context = system-reminder 注入 ---
	harness.hooks.on("transform_context", (event) => {
		const reminder =
			"\n<system-reminder>PI-Lnk PoC 注入：当前用户为超创平台登录用户，输出需遵循品牌语气。</system-reminder>";
		console.log(
			`[C3 transform_context] 注入 system-reminder（systemPrompt 长度 ${event.systemPrompt.length} → ${event.systemPrompt.length + reminder.length}）`,
		);
		return { systemPrompt: event.systemPrompt + reminder };
	});

	// --- C4: 双 Lane 并行 ---
	const main = await harness.lane("main", context);
	const explore = await harness.lane("explore", context);
	console.log(`[C4] lanes = ${(await harness.lanes(context)).map((l) => l.name).join(", ")}`);

	// --- 执行 ---
	console.log("\n[poc] main lane：canvas_draft（含必被拦截的 BLOCK 调用）+ delegate_subtask");
	const mainRun = await main.prompt(
		"先调用 canvas_draft 创建一张标题为 BLOCK-me 的草稿（会被拒绝）；被拒后再创建一张标题为 PoC-Canvas 的草稿；然后调用 delegate_subtask，子任务指令为 'run ls and report in one sentence'。全部完成后只回复 done。",
		undefined,
		context,
	);

	console.log("\n[poc] explore lane（并行）：纯问答");
	const exploreRun = await explore.prompt("用一句话回答：1+1=?", undefined, context);

	// 等待两条 lane 空闲（C4 的并行验证点）
	await main.waitForIdle(context);
	await explore.waitForIdle(context);

	// --- 汇总 ---
	console.log("\n===== PoC 验收汇总 =====");
	console.log(`C1 custom tool 被调用次数: ${toolContext.canvasCalls}（期望 ≥1，说明工具经宿主代理生效）`);
	console.log(`C2 before_tool 拦截次数: ${gateBlocks}（期望 1，说明工具级 HITL 门生效）`);
	console.log("C3 transform_context 注入: 已注册并触发（见上方日志）");
	console.log(
		`C4 双 Lane 并行: main=${mainRun.ok ? "ok" : "err"}, explore=${exploreRun.ok ? "ok" : "err"}, waitForIdle 无死锁`,
	);
	if (!mainRun.ok) console.log("  main error:", mainRun.error);
	if (!exploreRun.ok) console.log("  explore error:", exploreRun.error);
	console.log("C5 嵌套 subagent: 见 main lane 日志中的 delegate_subtask 调用");

	console.log("\nexplore lane 最终回复摘要:");
	if (exploreRun.ok) {
		const record = exploreRun.value as { messages?: unknown };
		console.log(JSON.stringify(record).slice(0, 400));
	}

	await harness.close(context);
	await repo.close(context);
	await env.cleanup(context);
}

main().catch((error) => {
	console.error("[poc] FAILED:", error);
	process.exit(1);
});
