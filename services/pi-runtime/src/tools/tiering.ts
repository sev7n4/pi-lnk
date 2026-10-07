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
 *
 * 2026-10-06 减点名下沉（R1，roadmap P1「常驻 ≤28」）：读类诊断 9 工具
 * （get_canvas_summary / get_canvas_layout / get_node / list_generation_tasks /
 * get_generation_status / get_generation_diagnostic / list_user_assets /
 * read_document / list_model_options）下沉 —— 前提是**点名已同步撤掉**：
 * prompt 规则 20/21/12 改写为能力描述 + tool_search 指引（canvas_daily_ops、
 * gen_tool_policy），4 个 skill 中的点名改为「先 tool_search 搜读工具」
 * （drama-qc-review / drama-storyboard / ecommerce-product-photo / drama-audio-design）。
 * ⚠️ web_search / web_fetch / recall_memory / list_generation_scenes 虽在候选之列但保留常驻：
 * 前两者是闲聊问答的通用能力（模型自发调用），recall_memory 被 5 个 skill 写成编号步骤，
 * list_generation_scenes 被规则 15 直接约束「建节点后先查场景」。
 *
 * ⭐⭐ **2026-10-06 分级下发实验已做完，本批全量下沉（28）获实证支持**（R5 窗口提议 →
 * 先只下沉 5 个做最小实验 → 结果支持扩到全量；PR #222 → 本 PR）：
 *   - 实验形态：生产 runtime 先发「常驻 32 + 探针 5 个」，用真实模型（agnes-3.0-flash，
 *     用户 BYOK）对每个探针各打 2 轮真实话术，control 组验链路没坏。
 *   - **结果：`pi_runtime_tool_search_calls_total{outcome="hit"}` = 6，`miss`/`empty` = 0**
 *     （此前两窗口恒 0 —— 那是**没有动机**：能力全常驻，模型不需要搜）。分项：
 *     · 无「常驻替代品」的探针（list_model_options / read_document）→ **4/4 主动搜索且命中**；
 *     · 有替代品的探针（list_generation_tasks / get_generation_diagnostic）→ 2/6 搜索，
 *       其余用 get_canvas_summary「凑答」。
 *   - ⇒ **结论 1**：`tool_search` 对本模型**可达且有效**，「模型不会搜」的先验被推翻；
 *     旧取证（全常驻时 0 触发）不能用来推断「延迟即不可达」。
 *   - ⇒ **结论 2（本文件的设计铁律，比上面那条准绳更硬）**：**不要让某个常驻工具能给
 *     延迟工具的领域「凑一个部分答案」**——实测有替代品的场景里出现过一次**静默答错**：
 *     问「素材库里有什么」，模型调 get_canvas_summary 看到本画布为空就答「素材库还没有
 *     任何节点」（实际素材库有 18 张图，搜索后的样本答对了）。部分替代 ⇒ 幻觉，
 *     比「没有能力」更糟。故核心画布读能力（get_canvas_summary 等）**必须与整套读工具
 *     同进退**：要么一起常驻，要么一起延迟，不能留半个。
 */
import { Type } from "typebox";
import { toolSummary, type LnkpiTool } from "./types.js";

export const ALWAYS_ON_TOOL_NAMES: ReadonlySet<string> = new Set([
	// read（画布 / 生成 / 资产 / 模型 / web / 文档 / 记忆读）
	// —— 2026-10-06 起 9 个读类诊断工具下沉（见文件头「减点名下沉」；已由分级下发实验
	// 实证支持：无替代品时模型 4/4 主动搜索命中），此处只留「有资产点名或通用自发调用」的读工具：
	"list_generation_scenes", // 规则 15「建节点后、propose 前先查场景」逐字约束
	// ⭐ 2026-10-07 提回常驻：工具描述自己写着「Call this first to understand the canvas」，
	//   但它在下沉集里 ⇒ 模型拿不到 schema ⇒ 退化成**逐个 get_node**（生产实测一次会话 10+ 次
	//   「查看节点」，244k tokens + 侧栏被流水淹没）。
	//   它是「省 schema token」的**主力反面案例**：单个 2104 token 的大头是 render_canvas_view，
	//   而 get_canvas_summary 只值几百 token ⇒ 提它的代价极小、收益是整条读链路。
	//   判据复核：**零规则/skill 点名**（减点名下沉的遗留），符合 catalog §2 一致性判据。
	"get_canvas_summary",
	"web_search",
	"web_fetch",
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
	// ⚠️ 与 focus_nodes（复数，批量定位）是两个不同工具，别顺手合并。
	"focus_node",
	// 2026-10-06 修正（原判据漏了一侧）：本模块此前按「未被 skill 点名」把复数版留在延迟集，
	// 但**漏了 prompt 规则这一侧** —— `canvas_daily_ops` 第 19 条（在 COMPOSED_IDS 内、每轮下发）
	// 写死「排完用 focus_nodes 带入视口」。按本文件自己的准绳（**被点名 ⇒ 必须常驻**），
	// 它必须常驻：否则「整理/排版」场景模型读完规则直调，吃 vendor 硬编码的
	// "Tool focus_nodes is unavailable" 且无恢复路径（drive/tools.ts:686）。
	// 依据：docs/agent/tool-capability-catalog.md 发现 A。
	"focus_nodes",
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
/**
 * 命中阈值：**只有 name/label/summary 级命中才算数**（权重 ≥ 2）。
 * 目的：防止「英文 description 里恰好有这个词」造成的误激活——实测 query "undo" 会撞上
 * redo 描述里的 "undo stack"（`tool-capability-catalog.md` 发现 C）。
 * description 只作弱信号：权重 1，单独命中不足以激活。
 */
const MATCH_MIN_SCORE = 2;

/**
 * **相对阈值**：查询越长，要求的证据量越高（`max(2, ceil(gram数 × 0.3))`）。
 *
 * 起因（2026-10-06 生产取证，非单测）：用镜像里的真实 dist 跑断言，`query="把刚才的编辑撤销掉"`
 * 返回 `[undo, redo]` —— 通用词「编辑」命中了 `redo` 的**中文 label**「重做画布编辑」。
 * 单测没抓到是因为替身 `label = name`（英文），**这是假绿**。
 *
 * 为什么按长度缩放：绝对阈值下，查询越长、2-gram 偶然命中的工具越多（每个命中都够 2 分）。
 * 相对阈值让「长查询必须命中更多片段」，把只靠一个通用词命中的工具排除。
 * 阈值抬高只会退化为 miss（返回完整目录、不激活），不会造成新的误激活 ⇒ 方向安全。
 */
const MATCH_RELATIVE_RATIO = 0.3;

/** 字段权重（英文 token）：工具名最可信，label/summary 次之，description 最弱。 */
const FIELD_WEIGHTS = { name: 3, label: 2, summary: 2, description: 1 };

/**
 * **中文 gram 命中任意字段都记 2 分**（不看字段权重）。
 * 理由：中文本往往只写在 label 或 summary 里，但老工具/替身可能只有 description 带中文 ——
 * 按 description 的英文权重（1）算会低于阈值 2，把原本能搜到的中文查询打回 miss。
 * 而误激活风险只来自**英文**短词撞 description（"undo" vs redo 描述里的 "undo stack"），
 * 那条由 FIELD_WEIGHTS.description=1 + 阈值兜住。
 */
const CJK_GRAM_SCORE = 2;

/**
 * query → 匹配单元（grams）。
 * ① 空格分词保留（"duplicate undo" 的多关键词 OR 语义）；
 * ② **中文 token 再切 2-gram** —— 中文查询通常没有空格，整句直接 `includes` 必然 miss。
 *    实测（2026-10-06）：「撤销」hit，而「撤销操作」「把刚才的编辑撤销掉」全 miss ⇒
 *    用户话术稍长就搜不到，miss 后虽返回完整目录但已白白消耗一轮。
 */
function toSearchGrams(q: string): string[] {
	const grams = new Set<string>();
	for (const token of q.split(/\s+/).filter(Boolean)) {
		grams.add(token);
		for (const seg of token.match(/[\u4e00-\u9fff]+/g) ?? []) {
			if (seg.length === 1) {
				grams.add(seg);
				continue;
			}
			for (let i = 0; i + 2 <= seg.length; i++) grams.add(seg.slice(i, i + 2));
		}
	}
	return [...grams];
}

/** 加权打分：命中的 gram 数 × 所在字段权重，累加（同一 gram 在同一字段只算一次）。 */
function scoreTool(tool: LnkpiTool, grams: string[]): number {
	const fields: Array<[string, number]> = [
		[tool.name, FIELD_WEIGHTS.name],
		[tool.label ?? "", FIELD_WEIGHTS.label],
		[tool.summary ?? "", FIELD_WEIGHTS.summary],
		[tool.description ?? "", FIELD_WEIGHTS.description],
	];
	let score = 0;
	for (const [text, weight] of fields) {
		const hay = text.toLowerCase();
		for (const g of grams) {
			if (!hay.includes(g)) continue;
			score += /[\u4e00-\u9fff]/.test(g) ? CJK_GRAM_SCORE : weight;
		}
	}
	return score;
}

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
			"query 支持工具名片段或用途关键词（中英文均可，如 memory、grid、整理、undo）；" +
			"可以直接写中文整句（如「把刚才的操作撤销掉」），不必拆成单词。",
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
			const grams = toSearchGrams(q);
			const threshold = Math.max(
				MATCH_MIN_SCORE,
				Math.ceil(grams.length * MATCH_RELATIVE_RATIO),
			);
			const matches = deferred
				.map((t) => ({ tool: t, score: scoreTool(t, grams) }))
				.filter((r) => r.score >= threshold)
				.sort((a, b) => b.score - a.score)
				.map((r) => r.tool);
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
