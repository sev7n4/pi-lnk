/**
 * 模型装配（spec L0 边界，PoC 实测结论的产物化）
 *
 * PoC（packages/pi-poc，5/5 PASS）验证过的最小依赖面：
 *   只依赖 pi-agent-core + pi-ai，不引 pi-coding-agent。
 *   ModelRuntime.getAvailable() 只认存储型凭据，env key 进不了 available 列表
 *   —— 所以直接用 pi-ai createModels + createProvider + env 凭据。
 *
 * 凭据来源（优先级）：
 *   1. AGNES_API_KEY + AGNES_BASE_URL   —— lnkpi 生产同款中转（apihub.agnes-ai.cn/v1，
 *      OpenAI chat-completions 兼容，模型 agnes-2.5-pro 系列）
 *   2. OPENAI_API_KEY                   —— 官方 OpenAI（pi-ai 内置目录）
 *
 * K-1：会话可带 BYOK override（Nest create 注入）覆盖上述 env 装配，见 assembleModel。
 *
 * key 只从环境变量或会话注入读，永不落盘、永不打印。
 */
import { createHash } from "node:crypto";
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

const AGNES_BASE_URL = process.env.AGNES_BASE_URL ?? "https://apihub.agnes-ai.cn/v1";

function envCredentialStore(): CredentialStore {
	return {
		async read(providerId): Promise<Credential | undefined> {
			const key = process.env.AGNES_API_KEY ?? process.env.OPENAI_API_KEY;
			if (providerId === "agnes" && key) return { type: "api_key", key };
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
				id: process.env.AGNES_MODEL_ID ?? "agnes-2.5-pro",
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

/**
 * K-1：会话级模型 override（BYOK）。
 *
 * 由 Nest 在 createSession 时注入；pi-runtime 不从任何其它来源读取。
 * 生命周期 = 会话 entry，DELETE 会话即释放引用（security model 对齐 toolContext 惯例）。
 */
export interface SessionLlmOverride {
	model: string;
	apiKey: string;
	baseUrl: string;
	providerRef: string;
	source: "user" | "platform";
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
}

/** 保守能力默认：非 reasoning、128k 上下文、8k 输出（spec §3.2 三层解析第 3 层）。 */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

/** providerRef → 12 位十六进制，用于 providerId（避免多渠道在 Models 里键冲突）。 */
function providerIdFrom(ref: string): string {
	return createHash("sha1").update(ref).digest("hex").slice(0, 12);
}

/** 会话作用域凭据源：只认本会话的 providerId，不读 env、不落盘、不打印。 */
function overrideCredentialStore(providerId: string, apiKey: string): CredentialStore {
	return {
		async read(id) {
			return id === providerId ? { type: "api_key", key: apiKey } : undefined;
		},
		async list() {
			return [{ providerId, type: "api_key" as const }];
		},
		async modify() {
			return undefined;
		},
		async delete() {},
	};
}

/**
 * 用会话注入的渠道装配 provider。
 *
 * 红线①（spec §3.2）：此处**禁止打印 override 的任何字段**——model id 可打，
 * apiKey / baseUrl 不可；日志只出现哈希后的 providerId。
 */
function overrideProvider(override: SessionLlmOverride) {
	const providerId = `byok-${providerIdFrom(override.providerRef)}`;
	// 红线：下方对象里 apiKey 只进 auth.resolve 闭包，不进任何可序列化字段
	return createProvider({
		id: providerId,
		name: "Session BYOK channel",
		baseUrl: override.baseUrl,
		auth: {
			apiKey: {
				name: "BYOK API key",
				async resolve() {
					return { auth: { apiKey: override.apiKey }, source: "session override" };
				},
			},
		},
		models: [
			{
				id: override.model,
				name: override.model,
				api: "openai-completions",
				baseUrl: override.baseUrl,
				provider: providerId,
				// reasoning 写死 true 是禁止项：非 reasoning 模型 + thinkingLevel 透传会发
				// reasoning_effort → 网关 400；contextWindow 写死 1M 是禁止项：harness
				// 压缩/截断永不触发 → 长对话超上游限制。
				reasoning: override.reasoning ?? false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: override.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
				maxTokens: override.maxTokens ?? DEFAULT_MAX_TOKENS,
			},
		],
		api: openAICompletionsApi(),
	});
}

export interface AssembledModel {
	models: Models;
	model: Model<Api>;
	providerId: string;
}

/** env 装配（现状原样抽取，平台用户/无 override 时走这条）。 */
function assembleModelFromEnv(): AssembledModel {
	const models = createModels({ credentials: envCredentialStore() });
	models.setProvider(agnesProvider());
	const model = models.getModels("agnes")[0];
	if (!model) throw new Error("agnes provider 装配失败");
	return { models, model, providerId: "agnes" };
}

/** override 装配（BYOK：createProvider 与 agnesProvider 同构，仅凭据与模型换源）。 */
function assembleModelFromOverride(override: SessionLlmOverride): AssembledModel {
	const provider = overrideProvider(override);
	const models = createModels({
		credentials: overrideCredentialStore(provider.id, override.apiKey),
	});
	models.setProvider(provider);
	const model = models.getModels(provider.id)[0];
	if (!model) throw new Error("会话 override provider 装配失败");
	return { models, model, providerId: provider.id };
}

/** 有 override 走会话渠道，无 override 走 env（行为与改造前一致）。 */
export function assembleModel(override?: SessionLlmOverride): AssembledModel {
	if (!override) return assembleModelFromEnv();
	return assembleModelFromOverride(override);
}
