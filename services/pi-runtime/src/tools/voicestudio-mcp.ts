/**
 * VoiceStudio MCP 桥（P2，spec 2026-11-24-voicestudio-p1p2-implementation-spec.md §5）。
 *
 * 职责切分（第一原则：等价物检索结论表 §1）——
 * - **协议传输吃 vendor**：`@earendil-works/pi-mcp@0.99.2` 的 McpClient +
 *   StreamableHttpTransport（Streamable HTTP + Bearer 鉴权，spike 实测 200）。
 *   禁自研 MCP 协议（ADR-0009 vendor-first）。
 * - **LnkpiTool 包装是 host 侧职责**：四工具 schema/label/summary/tier/呈现纪律是
 *   pi-lnk 语义（vendor 不知道 LnkpiTool），且入参要重定义（资产引用 → base64 下发），
 *   故静态定义而非动态枚举 MCP tools/list 转换（Type.Unsafe 转换兼容性风险归零）。
 * - **MCP 输出模式 = VS 默认 resources（base64/JSON）**：不启用 files 模式——
 *   VS 在宿主 docker、pi-runtime 在 K3s pod，文件系统不同 namespace；
 *   本桥四工具产物都是 profile_id 或文本，无音频字节（generate_speech 走 P1 REST 落盘管线）。
 *
 * 连接管理：
 * - 单例按 url 键控（BYOK 多实例防串），lazy connect + in-flight 复用；
 * - 连接类错误（连接关闭/会话过期）关闭旧连接重连一次再试，仍败则显式报错；
 * - **失败显式报错禁静默换道**（soundhelix 教训）：VS 未部署/停机时四工具返回
 *   结构化中文错误 + 切云端指引，画布其余工具不受影响。
 *
 * env 门（与 P1 同款零影响设计）：`OMNIVOICE_MCP_URL` + `OMNIVOICE_API_KEY`
 * 任一缺失 ⇒ 四工具不注册（目录零感知；配 env 即自动启用）。
 *
 * tier=gen：plan pending 期随 gen 族收缩（计划确认前不跑克隆，语义正确）；
 * 不触发 generation-gate HITL（该门按 run_* 工具名集合拦截，本桥四件不在集合）。
 *
 * ⚠️ A1 红线适配：四工具进延迟集（env 门强制——ALWAYS_ON 是静态 Set，env 缺失时
 * 不注册的名字进了常驻名单会吃 A2 幽灵项），故 skills/prompt 规则**禁止出现
 * 本文件四个 name 字面量**（verify-tool-tiering A1 扫 skills/*.md 全文）；
 * skill 指引用「能力描述 + tool_search 搜索关键词」表达（drama-audio-design v0.3）。
 */
import { Type } from "typebox";
import {
	McpClient,
	StreamableHttpTransport,
	toLlmContent,
	McpConnectionClosedError,
	McpSessionExpiredError,
	type McpRequestOptions,
} from "@earendil-works/pi-mcp";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import type { NestClient } from "./nest-client.js";

/** callTool 按工具覆盖超时（vendor 默认 30s）：克隆/转写是 CPU 重活（WhisperX /
 * 克隆管线），设计余量对齐 config.ts 的 audio 档位 330s。 */
const TOOL_TIMEOUT_MS: Record<string, number> = {
	clone_voice: 330_000,
	transcribe: 330_000,
	design_voice: 180_000,
	list_voices: 30_000,
};

export interface VoiceStudioMcpEnv {
	url: string;
	apiKey: string;
}

/**
 * env 门：双 env 齐备才启用（与 P1 `isVoiceStudioEnvConfigured` 同判据口径，
 * 但读的是 pi-runtime 自身 env——MCP URL 在 K3s pod 侧单独配，REST 侧在 Nest 配）。
 */
export function loadVoiceStudioMcpEnv(env: NodeJS.ProcessEnv = process.env): VoiceStudioMcpEnv | null {
	const url = (env.OMNIVOICE_MCP_URL ?? "").trim();
	const apiKey = (env.OMNIVOICE_API_KEY ?? "").trim();
	if (!url || !apiKey) return null;
	return { url, apiKey };
}

/* ------------------------------------------------------------------ */
/* 连接管理（单例按 url 键控 + in-flight 复用 + 连接类错误重连一次）      */
/* ------------------------------------------------------------------ */

interface McpConn {
	client: McpClient;
	connecting: Promise<McpClient> | null;
}

const conns = new Map<string, McpConn>();

export interface VoiceStudioMcpDeps {
	/** 注入点（测试替身）：默认 vendor StreamableHttpTransport。 */
	createTransport?: (env: VoiceStudioMcpEnv) => { connect(client: McpClient): Promise<unknown> };
	/** 注入点（测试替身）：默认 vendor McpClient 构造。 */
	createClient?: () => McpClient;
}

async function ensureConnected(env: VoiceStudioMcpEnv, deps: VoiceStudioMcpDeps): Promise<McpClient> {
	let conn = conns.get(env.url);
	if (conn?.connecting) return conn.connecting;
	if (conn) return conn.client;
	const connecting = (async () => {
		const transport =
			deps.createTransport?.(env) ??
			new StreamableHttpTransport({
				url: env.url,
				headers: { Authorization: `Bearer ${env.apiKey}` },
			});
		const client =
			deps.createClient?.() ??
			new McpClient({ name: "pi-lnk-runtime", version: "1.0.0" });
		await client.connect(transport as Parameters<McpClient["connect"]>[0]);
		conn = { client, connecting: null };
		conns.set(env.url, conn);
		return client;
	})();
	conns.set(env.url, { client: undefined as unknown as McpClient, connecting });
	try {
		return await connecting;
	} catch (err) {
		// 连接失败：清掉半成品槽位，下次调用重试（fail-explicit，调用方报错）
		conns.delete(env.url);
		throw err;
	}
}

function isConnectionError(err: unknown): boolean {
	return err instanceof McpConnectionClosedError || err instanceof McpSessionExpiredError;
}

/** 单次 MCP 调用：连接复用；连接类错误关闭旧连接重连一次再试（仍败显式抛）。 */
async function callVoiceStudioTool(
	env: VoiceStudioMcpEnv,
	tool: string,
	args: Record<string, unknown>,
	deps: VoiceStudioMcpDeps,
): Promise<Awaited<ReturnType<McpClient["callTool"]>>> {
	const timeoutMs = TOOL_TIMEOUT_MS[tool] ?? 60_000;
	const opts: McpRequestOptions = { timeoutMs };
	let client = await ensureConnected(env, deps);
	try {
		return await client.callTool(tool, args, opts);
	} catch (err) {
		if (!isConnectionError(err)) throw err;
		// 会话失效/连接关闭：销毁旧 client 重连一次（BYOK 死实例每次重建，不缓存坏连接）。
		// ⚠️ 槽位可能是连接中的半成品（client 未就绪）——先取到实体再关。
		const stale = conns.get(env.url)?.client;
		if (stale) await stale.close().catch(() => {});
		conns.delete(env.url);
		client = await ensureConnected(env, deps);
		return await client.callTool(tool, args, opts);
	}
}

/** 测试复位：清空连接单例（连接是进程级状态，测试间必须归零——探活缓存同款纪律）。 */
export function __resetVoiceStudioMcpForTests(): void {
	for (const conn of conns.values()) void conn.client?.close().catch(() => {});
	conns.clear();
}

/* ------------------------------------------------------------------ */
/* 结果提取：VS 工具失败契约 = 返回 {error} JSON（isError 不置位）        */
/* ------------------------------------------------------------------ */

type McpJsonOutcome = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

function extractMcpJson(result: {
	isError?: boolean;
	content?: unknown;
	structuredContent?: unknown;
}): McpJsonOutcome {
	if (result.isError === true) {
		return { ok: false, error: mcpTextOf(result) || "VoiceStudio 工具返回 isError" };
	}
	// resources 模式：文本块是 JSON 字符串（VS 四工具全走 json.dumps）；structuredContent 兜底
	const raw = mcpTextOf(result);
	if (raw) {
		try {
			const data = JSON.parse(raw) as Record<string, unknown>;
			if (data && typeof data.error === "string" && data.error) {
				return { ok: false, error: data.error };
			}
			return { ok: true, data };
		} catch {
			return { ok: false, error: `VoiceStudio 返回了非 JSON 文本：${raw.slice(0, 200)}` };
		}
	}
	if (result.structuredContent && typeof result.structuredContent === "object") {
		const data = result.structuredContent as Record<string, unknown>;
		if (typeof data.error === "string" && data.error) return { ok: false, error: data.error };
		return { ok: true, data };
	}
	return { ok: false, error: "VoiceStudio 工具返回为空" };
}

function mcpTextOf(result: { content?: unknown }): string {
	const texts: string[] = [];
	for (const block of toLlmContent(result as Parameters<typeof toLlmContent>[0])) {
		if (block.type === "text") texts.push(block.text);
	}
	return texts.join("\n");
}

/* ------------------------------------------------------------------ */
/* 命名规范（合规三件套 #3 提前量：PR3 只剩 Nest 资产表）               */
/* ------------------------------------------------------------------ */

/**
 * VS 侧 profile 命名规范 `lnk-<userId8>-<name>`（spec §6#3）：可审计、可清理。
 * - userId 取 toolContext（缺失回退 nosession，仍可按前缀审计）；
 * - name 清洗为可读安全段：空白折叠成 `-`，剔除中文字母数字-_. 外的字符，截 40；
 * - 清洗后为空回退 `voice`。
 */
export function buildVoiceProfileName(rawName: string, userId: string | undefined): string {
	const id8 = (userId ?? "nosession").slice(0, 8) || "nosession";
	const cleaned = (rawName ?? "")
		.trim()
		.replace(/\s+/g, "-")
		.replace(/[^-\p{L}\p{N}_.]/gu, "")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `lnk-${id8}-${cleaned || "voice"}`;
}

/* ------------------------------------------------------------------ */
/* 音频资产解析：uploads 引用 → Nest read-audio → base64（R-V9 同款）    */
/* ------------------------------------------------------------------ */

type ReadAudioOutcome =
	| { ok: true; base64: string; mimeType: string; fileName: string }
	| { ok: false; error: string };

async function resolveAudioBase64(
	client: NestClient,
	source: { url?: string; sessionId?: string; nodeId?: string },
): Promise<ReadAudioOutcome> {
	let data: ReadAudioOutcome;
	try {
		data = (await client.post("/agent/internal/read-audio", source)) as ReadAudioOutcome;
	} catch (err) {
		return { ok: false, error: `取音频服务不可达: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!data?.ok) return { ok: false, error: data?.error ?? "取音频失败" };
	return data;
}

/**
 * P3 合规台账登记（spec §6#3 来源标记）：克隆/设计成功后 upsert 到
 * Nest `/agent/internal/voice-profiles`（userId+profileId 幂等）。
 * 返回 null = 登记失败（网络/校验），调用方以 registered:false + warning 如实呈现——
 * profile 已在 VS 创建是既成事实，报 ok:false 会误导 agent「克隆失败」，静默又违反
 * 「显式报错禁静默」纪律；warning 是唯一既不谎报也不哑报的形态。
 */
async function registerVoiceProfileToNest(
	client: NestClient,
	payload: {
		userId: string | undefined;
		profileId: string;
		profileName: string;
		displayName: string;
		source: "cloned" | "designed";
		refUrl?: string;
	},
): Promise<string | null> {
	try {
		await client.post("/agent/internal/voice-profiles", {
			userId: payload.userId,
			profileId: payload.profileId,
			profileName: payload.profileName,
			displayName: payload.displayName,
			source: payload.source,
			...(payload.refUrl ? { refUrl: payload.refUrl } : {}),
		});
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

/* ------------------------------------------------------------------ */
/* 四工具                                                               */
/* ------------------------------------------------------------------ */

function textResult(payload: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], details: undefined };
}

/**
 * 四工具工厂。`client` 为空（纯文本模式）或 env 缺失 ⇒ 返回 []（env 门）。
 * deps 仅测试注入用；生产零参走 vendor 真实现。
 */
export function createVoiceStudioMcpTools(
	client: NestClient | null,
	deps: VoiceStudioMcpDeps & { env?: VoiceStudioMcpEnv | null } = {},
): LnkpiTool[] {
	const env = deps.env !== undefined ? deps.env : loadVoiceStudioMcpEnv();
	if (!client || !env) return [];
	const callTool = (tool: string, args: Record<string, unknown>) =>
		callVoiceStudioTool(env, tool, args, deps);

	const unavailable = () =>
		textResult({
			ok: false,
			error:
				"本地声纹引擎（VoiceStudio）不可达：未部署、未配置或已停机。请如实告知用户该能力暂不可用，可改用云端音频模型（生成链路不受影响），不要静默换道或声称已克隆/转写。",
		});

	const tools: LnkpiTool[] = [
		{
			tier: "gen",
			name: "clone_voice",
			label: "克隆音色",
			summary: "用用户上传的参考音频克隆可复用音色，返回音色 id",
			description:
				"Clone a reusable voice profile from the user's OWN uploaded reference audio (5-30s clean single-speaker). " +
				'Params: url = uploads audio reference (sidebar A{n} row url= field or canvas audio node url); name = display name. ' +
				"Returns profile_id — pass it as run_audio_generation's voice param to speak with the cloned voice. " +
				"COMPLIANCE: only audio the user uploaded to this canvas (uploads reference); external URLs are refused; " +
				"the user must own the voice rights. VS-side failures (duplicate name, audio too short, quality gate) surface as explicit errors — relay them, never silently fall back.",
			parameters: Type.Object({
				url: Type.String({
					description:
						'参考音频的 uploads 引用（侧栏音频素材行 url= 字段，如 /api/uploads/u1/ref.mp3）。仅限用户上传的自有素材。',
				}),
				name: Type.String({
					description: '音色显示名（如角色名「老板娘」）。落库名会自动加 lnk-<用户>- 前缀用于审计。',
				}),
				ref_text: Type.Optional(
					Type.String({ description: "参考音频的文字稿（可选，部分引擎可提升克隆质量）" }),
				),
				instruct: Type.Optional(
					Type.String({ description: "风格指令（可选，如 whisper / excited）" }),
				),
				language: Type.Optional(
					Type.String({ description: "参考音频语言（ISO 代码或 Auto，默认 Auto）" }),
				),
			}),
			promptGuidelines: [
				"仅当用户明确要求克隆音色且素材是用户自己上传的音频时使用；外部 URL / 他人声音素材一律拒绝并说明合规边界。",
				"克隆成功后把返回的音色 id 登记进节点参数/角色 bible，同角色全剧复用同一音色 id。",
				"引擎报错（重名/音频过短/质检不过）时如实转达，不静默换云端音色冒充克隆结果。",
			],
			execute: async (_id, p: { url: string; name: string; ref_text?: string; instruct?: string; language?: string }, _u, tc: LnkpiToolContext) => {
				const url = (p?.url ?? "").trim();
				const name = (p?.name ?? "").trim();
				if (!url || !name) {
					return textResult({ ok: false, error: "缺少参数：url（uploads 音频引用）与 name（音色名）必填" });
				}
				const audio = await resolveAudioBase64(client, { url });
				if (!audio.ok) return textResult({ ok: false, error: audio.error });
				const profileName = buildVoiceProfileName(name, tc?.userId);
				try {
					const out = extractMcpJson(
						await callTool("clone_voice", {
							name: profileName,
							ref_audio_base64: audio.base64,
							...(p.ref_text ? { ref_text: p.ref_text } : {}),
							...(p.instruct ? { instruct: p.instruct } : {}),
							language: p.language?.trim() || "Auto",
						}),
					);
					if (!out.ok) return textResult({ ok: false, error: out.error });
					// P3 合规台账：克隆成功即登记（source/refUrl 留痕，§6#3）；失败不吞——
					// registered:false + warning 如实呈现（profile 已存在，不可谎报克隆失败）
					const regErr = await registerVoiceProfileToNest(client, {
						userId: tc?.userId,
						profileId: String(out.data.profile_id ?? ""),
						profileName: profileName,
						displayName: name,
						source: "cloned",
						refUrl: url,
					});
					return textResult({
						ok: true,
						profile_id: out.data.profile_id,
						name: out.data.name,
						display_name: name,
						registered: !regErr,
						...(regErr
							? {
									warning:
										`合规登记失败（${regErr}）：该 profile_id 未入台账，请勿对外交付用此音色生成的成品；请联系管理员补登（重克隆同名会被引擎拒绝）。`,
								}
							: {}),
						note: "把该 profile_id 作为 run_audio_generation 的 voice 参数即可用此音色出声；同角色全剧复用同一 id。",
					});
				} catch {
					return unavailable();
				}
			},
		},
		{
			tier: "gen",
			name: "design_voice",
			label: "设计音色",
			summary: "按文字描述设计一个全新音色（返回音色 id）",
			description:
				"Design a brand-new voice profile from a free-text description (gender / age / pitch / style / accents, " +
				"Chinese dialects supported: e.g. sichuan, dongbei). Params: name = display name; description = trait words. " +
				"Returns profile_id for run_audio_generation's voice param. Descriptions that map to no supported trait are " +
				"refused with the unmatched words — relay them and ask the user to rephrase instead of guessing.",
			parameters: Type.Object({
				name: Type.String({ description: '音色显示名（如「毒舌老板娘」）。落库名自动加 lnk-<用户>- 前缀。' }),
				description: Type.String({
					description:
						"音色描述（性别/年龄/音高/风格/口音，中文方言可用：sichuan、dongbei 等）。映射不到任何属性的词会原样返回 unmatched。",
				}),
				language: Type.Optional(Type.String({ description: "音色语言（ISO 代码或 Auto，默认 Auto）" })),
			}),
			promptGuidelines: [
				"描述映射不到任何设计属性（unmatched 非空且报错）时，把 unmatched 词如实转达并请用户改描述，不要编造音色。",
				"设计成功后把音色 id 登记进角色 bible，同角色全剧复用。",
			],
			execute: async (_id, p: { name: string; description: string; language?: string }, _u, tc: LnkpiToolContext) => {
				const name = (p?.name ?? "").trim();
				const description = (p?.description ?? "").trim();
				if (!name || !description) {
					return textResult({ ok: false, error: "缺少参数：name（音色名）与 description（音色描述）必填" });
				}
				// P3 合规收口：designed 与 cloned 统一走 lnk-<userId8>-<name> 审计命名（§6#3
				// 不区分来源；P2 遗漏，生产 env 未启用零存量，无迁移负担）。
				const profileName = buildVoiceProfileName(name, tc?.userId);
				try {
					const out = extractMcpJson(
						await callTool("design_voice", {
							name: profileName,
							description,
							language: p.language?.trim() || "Auto",
						}),
					);
					if (!out.ok) return textResult({ ok: false, error: out.error });
					const regErr = await registerVoiceProfileToNest(client, {
						userId: tc?.userId,
						profileId: String(out.data.profile_id ?? ""),
						profileName,
						displayName: name,
						source: "designed",
					});
					return textResult({
						ok: true,
						profile_id: out.data.profile_id,
						name: out.data.name,
						attrs: out.data.attrs,
						unmatched: out.data.unmatched,
						registered: !regErr,
						...(regErr
							? {
									warning:
										`合规登记失败（${regErr}）：该 profile_id 未入台账，请勿对外交付用此音色生成的成品；请联系管理员补登。`,
								}
							: {}),
						note: "把该 profile_id 作为 run_audio_generation 的 voice 参数即可用此音色出声。",
					});
				} catch {
					return unavailable();
				}
			},
		},
		{
			tier: "read",
			name: "transcribe",
			label: "音频转写",
			summary: "把画布/上传的音频转成文字（QC 回读、字幕、听写）",
			description:
				"Transcribe an audio file to text (QC read-back, subtitles, dictation). Params: node_id (canvas audio node) " +
				"OR url (uploads audio reference), exactly one; language optional (omit for auto-detect). " +
				"Returns { text, language, duration }. Use it to QC generated audio against the script (逐字保真核对).",
			parameters: Type.Object({
				node_id: Type.Optional(
					Type.String({ description: "画布音频节点 id（与本工具的 url 二选一）" }),
				),
				url: Type.Optional(
					Type.String({ description: "uploads 音频引用（与本工具的 node_id 二选一）" }),
				),
				language: Type.Optional(Type.String({ description: "语言提示（ISO 代码，缺省自动检测）" })),
			}),
			promptGuidelines: [
				"生成配音后可转写回读做 QC（台词逐字保真核对），长音频转写耗时较长属正常。",
				"node_id 与 url 必须二选一；节点须是 audio 节点（有产物 url）。",
			],
			execute: async (
				_id,
				p: { node_id?: string; url?: string; language?: string },
				_u,
				tc: LnkpiToolContext,
			) => {
				const nodeId = (p?.node_id ?? "").trim();
				const url = (p?.url ?? "").trim();
				if (!nodeId && !url) {
					return textResult({ ok: false, error: "缺少参数：node_id 与 url 二选一" });
				}
				if (nodeId && url) {
					return textResult({ ok: false, error: "node_id 与 url 只能传一个" });
				}
				const source = nodeId ? { sessionId: tc?.sessionId, nodeId } : { url };
				const audio = await resolveAudioBase64(client, source);
				if (!audio.ok) return textResult({ ok: false, error: audio.error });
				try {
					const out = extractMcpJson(
						await callTool("transcribe", {
							audio_base64: audio.base64,
							...(p.language?.trim() ? { language: p.language.trim() } : {}),
						}),
					);
					if (!out.ok) return textResult({ ok: false, error: out.error });
					return textResult({
						ok: true,
						text: out.data.text,
						language: out.data.language,
						duration: out.data.duration,
					});
				} catch {
					return unavailable();
				}
			},
		},
		{
			tier: "read",
			name: "list_voices",
			label: "音色列表",
			summary: "枚举本地声纹引擎已保存的音色（克隆/设计/内置）",
			description:
				"List saved voice profiles on the local voice engine (cloned / designed / built-in), with id, name, kind and " +
				"personality. Use to pick or verify a voice id before run_audio_generation; large lists are truncated with a count note.",
			parameters: Type.Object({}),
			execute: async () => {
				try {
					const out = extractMcpJson(await callTool("list_voices", {}));
					if (!out.ok) return textResult({ ok: false, error: out.error });
					const data: unknown = out.data;
					const arr = Array.isArray(data) ? data : null;
					if (!arr) return textResult({ ok: false, error: "VoiceStudio 音色列表返回了非数组结构" });
					const TOTAL_SHOWN = 50;
					const shown = arr.slice(0, TOTAL_SHOWN);
					return textResult({
						ok: true,
						total: arr.length,
						shown: shown.length,
						truncated: arr.length > shown.length,
						voices: shown,
						...(arr.length > shown.length
							? { note: `仅展示前 ${shown.length} 条；需要更多时按名称过滤后重试。` }
							: {}),
					});
				} catch {
					return unavailable();
				}
			},
		},
	];
	return tools;
}
