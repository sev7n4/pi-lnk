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
 * key 只从环境变量读，永不落盘、永不打印。
 */
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

export interface AssembledModel {
	models: Models;
	model: Model<Api>;
	providerId: string;
}

export function assembleModel(): AssembledModel {
	const models = createModels({ credentials: envCredentialStore() });
	models.setProvider(agnesProvider());
	const model = models.getModels("agnes")[0];
	if (!model) throw new Error("agnes provider 装配失败");
	return { models, model, providerId: "agnes" };
}
