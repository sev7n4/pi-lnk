/**
 * 工具渐进加载（审计 P0-④，docs/2026-10-01-context-engineering-audit.html）。
 *
 * 38 个工具 schema 全量每轮进 system prompt 尾部，压缩砍不掉、随工具数单调增长。
 * 本模块把工具拆「常驻 / 延迟」两档，激活机制 100% 用 vendor 原生能力：
 *   1) AgentHarnessOptions.activeToolNames —— 建会话时只激活常驻集，
 *      vendor drive/generation.ts:90 只把 active 工具的 schema 发给 provider；
 *   2) AgentToolResult.addedToolNames —— load_tools 的结果携带名单，
 *      vendor tool-placement.ts:204 自动并入 activeToolNames 并广播 config_update，
 *      自该转录点起持续可用（host 不碰运行态）。
 *
 * kill switch：PI_RUNTIME_TOOL_TIERING=off → 全量常驻、无 load_tools、无索引块，
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
	"load_tools",
]);

export function splitTools(
	tools: LnkpiTool[],
	enabled: boolean,
): {
	alwaysActive: LnkpiTool[];
	deferred: LnkpiTool[];
	loadToolsTool?: LnkpiTool;
	deferredIndexBlock: string;
} {
	if (!enabled) {
		return { alwaysActive: tools, deferred: [], deferredIndexBlock: "" };
	}
	const deferred = tools.filter((t) => !ALWAYS_ON_TOOL_NAMES.has(t.name));
	const alwaysActive = tools.filter((t) => ALWAYS_ON_TOOL_NAMES.has(t.name));
	const loadToolsTool = deferred.length > 0 ? createLoadToolsTool(deferred) : undefined;
	return { alwaysActive, deferred, loadToolsTool, deferredIndexBlock: buildDeferredIndexBlock(deferred) };
}

/** 延迟工具索引块（追加到静态 system prompt）：只有名字 + 一句话摘要，schema 不占位。 */
export function buildDeferredIndexBlock(deferred: LnkpiTool[]): string {
	if (deferred.length === 0) return "";
	const lines = deferred.map((t) => `- ${t.name}：${toolSummary(t)}`);
		// 强指令（0.0.29 生产实证）：弱引导「需要时调用」会被模型无视、直接硬调延迟工具并吃
	// unavailable 错误后放弃。明示后果 + 先加载，才能把 load_tools 触发率拉起来。
	return `\n以下工具未加载完整定义（省上下文）。使用其中任何工具前，必须先调用 load_tools（可一次传多个名字）；跳过 load_tools 直接调用会返回 "unavailable" 错误，届时也请先 load_tools 再重试：\n${lines.join("\n")}`;
}

/** load_tools 元工具：校验名单 → 结果携带 addedToolNames，vendor 自动激活。 */
export function createLoadToolsTool(deferred: LnkpiTool[]): LnkpiTool {
	const byName = new Map(deferred.map((t) => [t.name, t] as const));
	const catalog = deferred.map((t) => t.name).join("、");
	return {
		tier: "skill",
		name: "load_tools",
		label: "加载延迟工具",
		description:
			"按名单加载未激活工具的完整定义。仅接受「未加载工具清单」中列出的名字；加载成功后即可直接调用。传入未知名会整体失败并返回可加载清单。",
		parameters: Type.Object({
			tools: Type.Array(Type.String(), { min: 1, description: "要加载的工具名数组" }),
		}),
		execute: async (_id, p: { tools: string[] }) => {
			const requested = Array.isArray(p?.tools) ? p.tools : [];
			const valid = requested.filter((n) => byName.has(n));
			const unknown = requested.filter((n) => !byName.has(n));
			// 保守策略：名单里混入未知名时整体不激活——模型读报错里的清单重试一次即可，
			// 避免「部分激活」让调用方误以为全部可用（Review Focus #3）。
			if (unknown.length > 0 || valid.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `未知的工具名：${unknown.join("、") || "（空名单）"}。可加载：${catalog}。`,
						},
					],
					details: { loaded: [], unknown },
				};
			}
			const loaded = [...new Set(valid)];
			return {
				content: [
					{ type: "text", text: `已加载 ${loaded.length} 个工具，现在可直接调用：${loaded.join("、")}。` },
				],
				details: { loaded, unknown: [] },
				addedToolNames: loaded,
			};
		},
	} as LnkpiTool;
}
