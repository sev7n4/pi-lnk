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

/**
 * 每百万 token 费率（USD）。审计 P0-③：vendor 的 calculateCost 只认 model.cost，
 * 此前两处硬写 0 把整条 cost 链抹平（BYOK 超支无法归因）。未配置 = 0（行为不变），
 * 配置即全链生效：usage.cost 由 openai-completions 适配器在响应时自动算好。
 */
function costRatesFromEnv() {
	const num = (raw: string | undefined): number => {
		if (raw === undefined || raw.trim() === "") return 0;
		const n = Number(raw);
		return Number.isFinite(n) && n >= 0 ? n : 0;
	};
	return {
		input: num(process.env.AGNES_COST_INPUT_PER_M),
		output: num(process.env.AGNES_COST_OUTPUT_PER_M),
		cacheRead: num(process.env.AGNES_COST_CACHE_READ_PER_M),
		cacheWrite: num(process.env.AGNES_COST_CACHE_WRITE_PER_M),
	};
}

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
				// 声明 image 输入：spec §1.5 spike 实测生产同款模型经 api.agnes-ai.cn/v1 接受
				// OpenAI image_url（data URI）视觉输入（返回正确识别结果，usage.prompt_tokens_details
				// .image_tokens=64）——生产线认可视觉。不声明则 openai-completions 适配器会静默丢弃
				// tool-result 里的 image block，自评闭环断在最后一步。
				input: ["text", "image"],
				cost: costRatesFromEnv(),
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
	/**
	 * 渠道费率（USD / 百万 token）。seam：Nest 今日无渠道费率目录、不填此字段
	 * （cost 全 0 = 现状）；将来接费率目录时在这里透传即可，vendor calculateCost
	 * 会自动消费。key 只进 Model 对象（pi 内部消费），不出现在日志。
	 */
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/**
	 * 该渠道模型是否接受视觉输入。**缺省 = false（不猜）**。
	 *
	 * 2026-10-03 事故：此前本字段根本不存在，BYOK 一律 `input:["text"]`，
	 * 于是 vendor `transform-messages.ts:36` 的 `downgradeUnsupportedImages`
	 * 把每张图静默替换成 `(image omitted: model does not support images)`，
	 * 上游照常 200、assistant 照常落库——用户只看到「模型说看不见图」。
	 * 「不猜」是对的，但必须**可声明**：声明不了就等于永久静默失效。
	 *
	 * 由 Nest 侧的能力解析填入（渠道 models[].capability + 探针）。
	 * 运维兜底见 `VISION_CAPABLE_MODELS`。
	 */
	supportsVision?: boolean;
}

/** 保守能力默认：非 reasoning、128k 上下文、8k 输出（spec §3.2 三层解析第 3 层）。 */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

/**
 * 运维兜底：强制声明视觉能力的模型名白名单（逗号分隔，**精确匹配**模型名）。
 * 用于渠道声明缺失/错的场景，不必等发版。留空 = 不覆盖。
 * 精确匹配而非子串：子串会让 "flash" 误伤 "flash-vision" 之外的模型。
 */
function visionCapableModels(): ReadonlySet<string> {
	const raw = process.env.VISION_CAPABLE_MODELS;
	if (!raw || raw.trim() === "") return new Set();
	return new Set(
		raw
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter((s) => s.length > 0),
	);
}

/**
 * 该 override 是否声明视觉输入。三层（后覆盖前）：
 *   1. `VISION_CAPABLE_MODELS` env 白名单（运维兜底，最高优先）
 *   2. Nest 传入的 `supportsVision`（渠道能力解析结果）
 *   3. 都无 → false（不猜，避免让非视觉渠道 400）
 */
function resolveSupportsVision(override: SessionLlmOverride): boolean {
	if (visionCapableModels().has(override.model.trim().toLowerCase())) return true;
	return override.supportsVision === true;
}

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
				// 视觉输入声明：见 SessionLlmOverride.supportsVision 的事故说明。
				// 声明 image ⇒ vendor transform-messages 放行图片；不声明 ⇒ 图片被静默
				// 替换成占位符（这正是 2026-10-03「模型说看不见图」的根因）。
				// 旧注释「误报 image 会让非视觉渠道 400，比静默丢弃更糟」的前提是「无法
				// 得知用户模型能力」——该前提已不成立：Nest 现在会把能力解析结果传进来。
				input: resolveSupportsVision(override) ? ["text", "image"] : ["text"],
				cost: override.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
