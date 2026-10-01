/**
 * 工具渐进加载（审计 P0-④）——0.0.31 起对齐 pi 官方 Dynamic Tool Loading 模式
 * （vendor coding-agent docs/extensions.md:2365-2402）。
 *
 * 0.0.29/0.0.30 的教训（生产 E2E 实证）：把「延迟工具名单 + 索引块」塞进 system prompt，
 * 弱模型会无视引导直调延迟工具（名字就摆在面前），吃 vendor 硬编码的
 * "Tool X is unavailable"（无恢复路径，host 无法拦截：drive/tools.ts:686 只把 active
 * 工具传 prepareToolCall，before_tool hook 在其后）后放弃。
 *
 * 官方模式的两个关键差异：
 *   1) **全部工具注册进 config.tools**——延迟工具存在但不在 activeToolNames。
 *      vendor generation.ts:90 仍只下发 active 工具的 schema（省上下文的目标不变），
 *      同时 packages/ai 的 provider 级 deferred loading（tool_reference / tool_search_call）
 *      从此有了生效前提；「配置里存在但未激活」也是官方文档定义的合法形态。
 *   2) **不给模型名单，给搜索**——loader 语义从「按精确名字加载」改为「按关键词搜索并加载」。
 *      模型看不到延迟工具的名字 → 没有直调的诱因；需要某能力时先搜再调，
 *      命中即经 AgentToolResult.addedToolNames 激活（tool-placement.ts:204 原生合并，
 *      与官方 wrapper 的 setActiveTools 差集通道等价）。
 *
 * kill switch：PI_RUNTIME_TOOL_TIERING=off → 全部工具注册且全量激活、无 tool_search，
 * 行为与本模块引入前逐字节一致（Review Focus #4）。
 *
 * 常驻名单的硬约束：prompt 规则 4/5 逐字引用的写链路工具（upsert_media_node /
 * set_node_text / connect_nodes / apply_sidebar_attachments / propose_generation）
 * 不可延迟；run_* / cancel_generation 保留常驻（用户确认后当轮即用，双保险）。
 */
import { Type } from "typebox";
import { toolSummary, type LnkpiTool } from "./types.js";

export const ALWAYS_ON_TOOL_NAMES: ReadonlySet<string> = new Set([
	// read（画布 / 生成 / 资产 / 模型 / web / 文档 / 记忆读）
	"get_canvas_summary",
	"get_canvas_layout",
	"get_node",
	"get_generation_status",
	"get_generation_diagnostic",
	"list_generation_tasks",
	"list_user_assets",
	"list_model_options",
	"web_search",
	"web_fetch",
	"read_document",
	"recall_memory",
	// write 核心链路（prompt 规则 4/5 逐字引用，不可延迟）
	"upsert_media_node",
	"upsert_prompt_node",
	"set_node_text",
	"update_node",
	"connect_nodes",
	"attach_refs",
	"apply_sidebar_attachments",
	"propose_generation",
	// gen（用户确认后当轮即用）
	"run_image_generation",
	"run_video_generation",
	"run_text_generation",
	"run_prompt_generation",
	"run_audio_generation",
	"cancel_generation",
	// 交互与元
	"ask_user",
	"load_skill",
	"tool_search",
]);

/** 工具装配结果（对齐 vendor 官方 Dynamic Tool Loading 的两件套）。 */
export interface ToolEnsemble {
	/** 注册进 harness config.tools 的全集。enabled 时 = 原工具 + tool_search（延迟工具在内）。 */
	registered: LnkpiTool[];
	/** 初始 activeToolNames。enabled 时 = 常驻集 + tool_search；off 时 = 全量（现状语义）。 */
	activeToolNames: string[];
}

/**
 * 装配工具分层。注意与 0.0.30 前的 splitTools 的本质区别：
 * 延迟工具**留在 registered 里**（generation.ts 只发 active 的 schema，
 * 注册不等于下发；而 vendor ai 层的 deferred 机制要求工具在 config.tools 里才可能生效）。
 */
export function buildToolEnsemble(tools: LnkpiTool[], enabled: boolean): ToolEnsemble {
	if (!enabled) {
		return { registered: tools, activeToolNames: tools.map((t) => t.name) };
	}
	const deferred = tools.filter((t) => !ALWAYS_ON_TOOL_NAMES.has(t.name));
	const alwaysNames = tools.filter((t) => ALWAYS_ON_TOOL_NAMES.has(t.name)).map((t) => t.name);
	if (deferred.length === 0) {
		return { registered: tools, activeToolNames: alwaysNames };
	}
	const loader = createLoadToolsTool(deferred);
	return {
		registered: [...tools, loader],
		activeToolNames: [...alwaysNames, loader.name],
	};
}

/**
 * tool_search 元工具（官方 search_tools 语义，对齐 Anthropic tool_search_tool / Claude Code ToolSearch）：关键词搜索延迟目录 → 命中即激活。
 * 激活 100% 走 vendor 原生：结果携带 addedToolNames，tool-placement 自动并入
 * activeToolNames 并广播 config_update，自该转录点起持续可用（host 不碰运行态）。
 */
export function createLoadToolsTool(deferred: LnkpiTool[]): LnkpiTool {
	const catalog = deferred.map((t) => `- ${t.name}：${toolSummary(t)}`).join("\n");
	return {
		tier: "skill",
		name: "tool_search",
		label: "搜索并加载工具",
		description:
			"按关键词搜索当前未加载（schema 不可见）的工具，并把命中的工具加载为可直接调用。" +
			"当用户需要的能力不在你现有工具列表里时，先用本工具搜索再行动；" +
			"query 支持工具名片段或用途关键词（中英文均可，如 memory、grid、整理、undo）。",
		parameters: Type.Object({
			query: Type.String({ minLength: 1, description: "关键词（工具名片段或用途描述）" }),
		}),
		execute: async (_id, p: { query: string }) => {
			const q = (p?.query ?? "").trim().toLowerCase();
			// 空查询：不给激活，只给目录——模型据此换关键词或点名加载。
			if (!q) {
				return {
					content: [{ type: "text", text: `query 不能为空。可选工具目录：\n${catalog}` }],
					details: { loaded: [] as string[] },
				};
			}
			const keywords = q.split(/\s+/).filter(Boolean);
			const matches = deferred.filter((t) => {
				const hay = `${t.name} ${t.label ?? ""} ${toolSummary(t)} ${t.description ?? ""}`.toLowerCase();
				return keywords.some((kw) => hay.includes(kw));
			});
			// 未命中：返回完整目录（名字+摘要）但不激活——模型下一步可以点名再搜或换词。
			if (matches.length === 0) {
				return {
					content: [{ type: "text", text: `没有匹配「${p.query.trim()}」的工具。完整目录：\n${catalog}` }],
					details: { loaded: [] as string[] },
				};
			}
			const loaded = matches.map((t) => t.name);
			return {
				content: [
					{
						type: "text",
						text:
							`已加载 ${loaded.length} 个工具，本轮起可直接调用：` +
							matches.map((t) => `${t.name}（${toolSummary(t)}）`).join("；"),
					},
				],
				details: { loaded, unknown: [] },
				addedToolNames: loaded,
			};
		},
	} as LnkpiTool;
}
