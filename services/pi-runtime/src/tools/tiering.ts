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
 *
 * ⭐ 判定「某工具能否进延迟集」的唯一准绳 = **有没有资产（prompt 规则 / skills）按名字点名它**。
 * 点名 ⇒ 模型会直调 ⇒ 必须常驻；未点名 ⇒ 可延迟（靠 tool_search 发现）。
 * 依据 2026-10-03 生产取证（uptime 6.87h 窗口）：40 次工具调用全部落在常驻集，
 * `pi_runtime_tool_search_calls_total` **零个 outcome 标签**（即一次都没被调用）、
 * `tool_search_activated_total 0`。官方模式上线后 foldSearch2search 的**触发率仍为 0**，
 * 所以「进延迟集」对被子资产点名的工具等同于「不可达」——这是 arrange_nodes /
 * set_node_generation_params / save_memory / focus_node / remove_edges 留在常驻集的理由。
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
	"list_generation_scenes",
	"web_search",
	"web_fetch",
	"read_document",
	"recall_memory",
	// 记忆写（2026-10-03 生产取证）：save_memory 是 prompt-registry 规则
	// memory_scope.tail.md 直接约束行为的工具（「默认仅本画布，只有偏好/品牌/暗号才用
	// scope:'user'」），并被 6 个 drama-* skill 写成编号步骤（「QA 通过后用 save_memory
	// 存角色 bible」等）。模型读完规则直接按名字调用 ⇒ 进延迟集会吃 immediateError。
	"save_memory",
	// write 核心链路（prompt 规则 4/5 逐字引用，不可延迟）
	"upsert_media_node",
	"upsert_prompt_node",
	"set_node_text",
	"update_node",
	"connect_nodes",
	"attach_refs",
	"apply_sidebar_attachments",
	"propose_generation",
	// 画布编排（2026-10-02 L1）：arrange_nodes 是 skill 链路里被点名的一步
	// （drama-* / ecommerce-product-photo 都写死 arrange_nodes(along_edges)），
	// 放进延迟集 = 要靠 tool_search 才能拿到 schema，而工具搜索触发率实测为 0 ⇒ 延迟即不可达。
	"arrange_nodes",
	// present（2026-10-03 spec §5.2）：解释/澄清类高频场景要出图，
	// 放进延迟集 = 依赖 load_tools 激活，而 load_tools 触发率实测为 0 ⇒ 延迟即不可达。
	"render_canvas_view",
	// 生成参数预填（2026-10-03）：与 arrange_nodes 同理 —— prompt 规则要求
	// 「建节点后落参数才叫完成」，若进延迟集，模型在需要它时看不见 schema，
	// 而 tool_search 触发率实测 0 ⇒ 延迟即不可达。
	"set_node_generation_params",
	// 出图后定位（2026-10-03 生产取证）：focus_node 是 8 个 drama-* / ecommerce-* skill
	// 共用的「出图后 QA 闸门」第一步（「出图后先 focus_node 定位到刚生成的节点」），
	// 与 arrange_nodes 同性质 ⇒ 延迟即不可达。
	// ⚠️ 与 focus_nodes（复数，批量定位）是两个不同工具；后者未被 skill 点名，保持延迟。
	"focus_node",
	// 错连修正（2026-10-03 生产取证）：drama-qc-review 的引用关系审计步骤点名
	// （「错连还能用 edge id 走 remove_edges」），同 arrange_nodes 性质。
	"remove_edges",
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
 *
 * `onSearch`：搜索语义观测回调（hit/miss/empty + 激活数），host 用来喂 metrics；
 * 不传则不打点（纯函数行为不变）。
 */
export function buildToolEnsemble(
	tools: LnkpiTool[],
	enabled: boolean,
	onSearch?: (outcome: "hit" | "miss" | "empty", activated: number) => void,
): ToolEnsemble {
	if (!enabled) {
		return { registered: tools, activeToolNames: tools.map((t) => t.name) };
	}
	const deferred = tools.filter((t) => !ALWAYS_ON_TOOL_NAMES.has(t.name));
	const alwaysNames = tools.filter((t) => ALWAYS_ON_TOOL_NAMES.has(t.name)).map((t) => t.name);
	if (deferred.length === 0) {
		return { registered: tools, activeToolNames: alwaysNames };
	}
	const loader = createLoadToolsTool(deferred, onSearch);
	return {
		registered: [...tools, loader],
		activeToolNames: [...alwaysNames, loader.name],
	};
}

/**
 * tool_search 元工具（官方 search_tools 语义，对齐 Anthropic tool_search_tool / Claude Code ToolSearch）：关键词搜索延迟目录 → 命中即激活。
 * 激活 100% 走 vendor 原生：结果携带 addedToolNames，tool-placement 自动并入
 * activeToolNames 并广播 config_update，自该转录点起持续可用（host 不碰运行态）。
 * `onSearch`：可选观测回调（hit/miss/empty + 激活数），host 喂 metrics 用。
 */
export function createLoadToolsTool(
	deferred: LnkpiTool[],
	onSearch?: (outcome: "hit" | "miss" | "empty", activated: number) => void,
): LnkpiTool {
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
				onSearch?.("empty", 0);
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
				onSearch?.("miss", 0);
				return {
					content: [{ type: "text", text: `没有匹配「${p.query.trim()}」的工具。完整目录：\n${catalog}` }],
					details: { loaded: [] as string[] },
				};
			}
			const loaded = matches.map((t) => t.name);
			onSearch?.("hit", loaded.length);
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
		// ⚠️ 工具对象构造点上的类型逃逸口共 **2** 处：本行 + `session-manager.ts:1533`
		// （后者把 AgentHarnessTool[] 收敛成 LnkpiTool[]，是有意 coerce，见该处既有注释）。
		// scripts/verify-tool-contract.ts 的 A3 断言以 **2** 为基线计数，新增即红。
		// 清理属存量整改，spec §2 明确不做。
		// ⚠️ 本注释刻意不写出 cast 的类型字面量：按该字面量grep 会把注释一起命中，
		// 写出来会让 Task 9 的机检数出第 3 处。
	} as LnkpiTool;
}
