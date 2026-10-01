/**
 * PiPromptAssembler（#12）：组装 pi-runtime 会话的 system prompt。
 *
 * P0-① 起按 spec §5.3 拆两段（此前是「每轮重建会话」的单次 assemble）：
 *   - assembleStatic：规则组文本（S 层）。会话期内不变 → 会话创建时作为 systemPrompt 注入一次。
 *   - assembleDynamic：每轮变化的世界状态（G 层：画布快照 + 侧栏素材）。返回**数组**交给
 *     pi-runtime 追加到 systemPrompt 尾部求值，不写入对话历史（spec §4 动态上下文判据；
 *     写进历史会让每个旧轮的快照被反复计费并互相矛盾）。
 *
 * 规则文本出处：services/agent-runtime/app/graph/nodes/explore.py:87-132（_EXPLORE_SYSTEM）。 （注：老 LangGraph runtime 已于 2026-09-27 退役删除，该路径为历史语义出处）
 * 规则分组（B-2 起）：
 *   - core（默认注入）：前缀 + 规则 1/2/3/7（原文）；第 10 条「写操作未开放」守卫
 *     仅在 writeTools 未启用时附加（写工具上线后守卫退出）。
 *   - writeTools（B-2 随写工具注册启用）：规则 4/5 原文（explore.py:95-112 逐字）；
 *     规则 6/8/9 不拷贝（声明偏离，理由见 B-2 计划 §1.2）。
 *
 * 拼装顺序对齐 explore.py:393-408：规则 → 画布摘要 → 侧栏块。
 * 摘要获取失败时省略该块并继续（ Review Focus：prompt 必须始终成立）；
 * 摘要 JSON 不截断（有意对齐老链路）。
 * 早期「近期对话摘要」层随 compress-recent-turns 一起退役——历史现在进原生 context。
 */
import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { buildSidebarBlock, type SidebarBlockInput } from "./sidebar-block";

export type RuleGroup = "core" | "writeTools" | "genTools";

/**
 * 分层 kind：rules 属静态段（S 层），canvas/sidebar 属动态段（G 层）；
 * `skill` / `memory` 为 D-η' 与阶段二预留（Seam first —— 先留注入点，策略后定）。
 */
export type PromptLayerKind = "rules" | "canvas" | "sidebar" | "skill" | "memory";

export interface PromptLayer {
	id: string;
	kind: PromptLayerKind;
	content: string;
	/** 该层 token 估算，随层携带（manifest/观测直接消费，无需二次计算）。 */
	approxTokens: number;
}

/**
 * 分段注入 manifest（结构化，供 log/metrics 消费）。
 * 静态段没有归属会话（一次装配多会话共用），其 manifest 的 sessionId 为空串。
 */
export interface PromptManifest {
	sessionId: string;
	layers: Array<{ id: string; kind: PromptLayerKind; tokens: number }>;
	totalTokens: number;
	/** 最终 prompt 的稳定哈希，用于跨轮 diff / 回归比对。 */
	promptHash: string;
}

/** CJK ≈1 token/字 + 其余 ≈1/4 token/字符（审计 P0-②：len/4 对中文低估 3~4 倍）。
 *  与 services/pi-runtime/src/skills/registry.ts 同口径，改必须同步。 */
const CJK_CHAR_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/;

export function approxTokens(s: string): number {
	let cjk = 0;
	let other = 0;
	for (const ch of s) {
		if (CJK_CHAR_RE.test(ch)) cjk += 1;
		else other += 1;
	}
	return Math.ceil(cjk + other / 4);
}

/** 构造层并顺带算出 token 估算（避免调用点漏算）。 */
function layer(id: string, kind: PromptLayerKind, content: string): PromptLayer {
	return { id, kind, content, approxTokens: approxTokens(content) };
}

/** 最终 prompt 的稳定哈希（12 位 hex，够做跨轮 diff，不用于安全）。 */
export function promptHash(prompt: string): string {
	return createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 12);
}

/** 与老链路 1:1 的最小结构（getCanvasSummary.data）；焦点过滤命中时附 omittedCount/focusNodeId。 */
export interface CanvasSummaryData {
	nodes: Array<{ id: string; type: string; title: string; status: string }>;
	omittedCount?: number;
	focusNodeId?: string;
}

export interface CanvasSummaryProvider {
	getCanvasSummary(input: { sessionId: string; focusNodeId?: string }): Promise<CanvasSummaryData>;
}

const CORE_RULES_PREFIX = `你是 lnkpi 无限画布助手。用简洁中文回答。
规则：
1. 必须通过工具完成读写操作，禁止假装已执行。
2. 平台支持在画布上生成图片/视频等媒体；不得否认平台的图片生成能力，也不要引导用户使用第三方作图工具。`;

/** 规则 3（genTools 未启用，B-5 前默认）：explore.py:93-94 原文。 */
const RULE_3_NO_GEN = `3. 不要声称「正在生成」「马上生成」「已开始出图」；不要调用 run_*_generation（禁止调用任何 run_*）。真正出图/出视频须等用户在 UI 确认后由系统执行。`;

/** 规则 3'（genTools 启用，B-5）：run_* 经 Gate 强制校验，确认前仍然禁止。 */
const RULE_3_GEN = `3. 不要声称「正在生成」「马上生成」「已开始出图」；用户明确同意前禁止调用 run_*_generation（生成执行由系统强制校验，见规则 11），确认后可调用，也不要假装已出图。`;

const CORE_RULES_TAIL = `7. 若已提供【侧栏参考图解析】，不得声称只能看到文件名或画布节点标题。@I1/@I2 是侧栏芯片 key，不是画布节点 id。禁止问「I1 对应画布哪张图」；禁止把芯片映射到已有画布节点（除非用户明确要求改该节点）。侧栏图≥3 且未 @、或只有旧图且未 @：先问用哪几张或请 @I1，不要对闲聊新建节点。
14. 本会话没有工作流模板能力（无模板库/模板匹配/实例化/存为模板/推广模板）：用户要模板或要套用流程时，如实说明没有该能力，并直接用节点 + 连线搭骨架来替代；禁止虚构模板名、禁止声称已套用模板、禁止把节点拼装说成「模板」。`;

const CORE_RULES = `${CORE_RULES_PREFIX}\n${RULE_3_NO_GEN}\n${CORE_RULES_TAIL}`;

/** 第 10 条守卫：仅在 writeTools 组未启用时注入（写工具上线后模型已可写，守卫退出）。 */
const RULE_10_WRITE_GUARD = `10. 当前会话仅开放只读查询工具（画布摘要/节点/生成状态/素材列表等）；创建、修改、连线、生成执行等写操作尚未开放——用户要求时如实说明，禁止虚构已执行。`;

/**
 * writeTools 组（B-2 启用）：explore.py:95-112 规则 4/5 逐字拷贝（含无空格拼接点）。
 * 声明偏离（计划 §1.2）：规则 6（tool_search）/8（B-4/B-6 工具）/9（upscale_image 断头）
 * 不拷贝——pi 侧对应工具/功能未上线，随所在批次补。
 */
const WRITE_TOOLS_RULES = `4. 用户要创建图片/视频/文本/音频节点或明确「生成一张…」时：用 upsert_media_node创建或更新节点（可带 prompt），按需再用 set_node_text 填参、用 connect_nodes 连线，然后调用 propose_generation，并等待用户确认；不要假装已出图。有侧栏参考图要出结果图时：用 upsert_media_node 新建一张图节点（用户明确要求改某个image-* 除外），再 apply_sidebar_attachments（mode=localRefs，mentioned_keys 用 I1/I2芯片序），必要时 set_node_text，然后 propose_generation。此路径不要 connect_nodes、不要 attach_refs。挂参分工：侧栏 @I* / I1 只用 apply_sidebar_attachments（mode=localRefs）；画布已有 image-* / video-* 才用 attach_refs 或 connect_nodes。禁止 attach_refs 吃芯片 key；禁止 connect_nodes 连芯片。闲聊、谢谢、纯识图问句、「重新生成一张」即使工具可见也不得 upsert_media_node / propose_generation。一致性写在提示词和 ref 顺序（先身份后衣服/产品），不要再搭工作流。
5. 口语搭骨架（含「生图生视频」、多节点+连线+填 dock）：至少 upsert_media_node 两个媒体节点（一张 image 与一条 video，或 image→video 链），每个可生成节点 prompt 非空（创建时带 prompt 或 set_node_text），用 connect_nodes 连 canvas 节点 id，再对每个可生成节点 propose_generation。不要压成单个 atomic 式节点；不得声称用工作流/模板生成（本会话无该能力，见规则 14）；不要把 @I* 芯片连成边。确认前不要 run_*、不要声称已出图。`;

/**
 * genTools 组（B-5 启用）：生成闭环规则。编号 11/12/13 有意不占用老链路 6/8/9
 * （tool_search / B-4 工具 / upscale_image——三者已被路线修订 D4/关闭决策废弃，
 * 复用编号会误导维护者）。规则 9 不拷贝 = roadmap D4（upscale_image 不迁）。
 */
const GEN_TOOLS_RULES = `11. run_image/video/text/prompt/audio_generation 只能对「已 propose_generation 且用户在后续消息中明确同意」的节点调用（系统强制校验 pending_confirm；同轮提议后直接调用会被拦截）。禁止用 run_* 或文生图提示词冒充放大/超分。
12. run_* 返回 status=timeout：如实告知生成未完成，可用 get_generation_status 稍后再查；status=fallback_pending：说明该节点需用户在画布上确认平台兜底，不要声称成功或失败，不要自行重试，也不要调用不存在的确认工具；status=failed/error：简要说明并给下一步建议，禁止虚构 url。
13. 用户要求取消进行中的生成：调用 cancel_generation（有 generation_record_id 用之，否则用 node_id，从画布摘要解析而非标题文本），结果如实转述；仅 generating 状态可取消，其余状态如实说明。`;

/**
 * 规则组拼装：genTools 启用 → 规则 3' 替换规则 3 并追加 11/12/13；
 * writeTools 启用 → 规则 4/5，否则第 10 条写守卫。
 * 声明偏离（M-2）：注入顺序为 1,2,3,7,4,5,11,12,13（explore.py 为 1..9 顺序）——规则带编号，
 * 顺序差异对模型语义无影响，不追求顺序对齐。
 */
function composeRuleText(groups: RuleGroup[]): string {
	const core = groups.includes("genTools")
		? `${CORE_RULES_PREFIX}\n${RULE_3_GEN}\n${CORE_RULES_TAIL}`
		: `${CORE_RULES_PREFIX}\n${RULE_3_NO_GEN}\n${CORE_RULES_TAIL}`;
	const parts: string[] = [core];
	if (groups.includes("writeTools")) parts.push(WRITE_TOOLS_RULES);
	if (groups.includes("genTools")) parts.push(GEN_TOOLS_RULES);
	if (!groups.includes("writeTools")) parts.push(RULE_10_WRITE_GUARD);
	return parts.filter(Boolean).join("\n");
}

@Injectable()
export class PiPromptAssembler {
	private readonly logger = new Logger(PiPromptAssembler.name);

	/** 测试观测口：最近一次分段装配的 layers 与 manifest 行（non-production API）。 */
	lastLayers?: PromptLayer[];
	/** 测试观测口（non-production API）：人类可读的一行 manifest（含 hash）。 */
	lastManifest?: string;
	/** 测试观测口（non-production API）：结构化 manifest，供 metrics 消费。 */
	lastManifestDetail?: PromptManifest;

	constructor(private readonly canvasTools: CanvasSummaryProvider) {}

	/**
	 * 静态段（S 层）：规则组文本。会话期内不变，创建会话时注入一次。
	 * 不触碰 canvasTools —— 静态段不依赖任何 world state。
	 */
	async assembleStatic(input: { ruleGroups?: RuleGroup[] }): Promise<string> {
		const text = composeRuleText(input.ruleGroups ?? ["core"]);
		this.recordLayers([layer("rules", "rules", text)], "");
		return text;
	}

	/**
	 * 动态段（G 层）：每轮变化的世界状态（画布快照 + 侧栏素材）。
	 * 返回数组 —— 由 pi-runtime 追加到 systemPrompt 尾部求值，不写入对话历史（spec §4 动态上下文判据）。
	 * 画布摘要获取失败时省略该块并继续；两者都不可用时返回空数组（调用方 handle 空数组为「无动态块」）。
	 * focusNodeId（审计 P0-①）：传给 getCanvasSummary 做焦点过滤（>30 节点时只回
	 * 焦点 + 1 跳邻居，fail-open）；被裁剪时附提示行，模型可调 get_canvas_layout 取全量。
	 */
	async assembleDynamic(input: {
		sessionId: string;
		attachments?: SidebarBlockInput[];
		focusNodeId?: string;
		/** 审计 #7：长期记忆块（调用方拼好文本；assembler 只透传 + manifest 观测，不碰 prisma）。 */
		memoryBlock?: string;
	}): Promise<string[]> {
		const layers: PromptLayer[] = [];

		try {
			const summary = await this.canvasTools.getCanvasSummary({
				sessionId: input.sessionId,
				focusNodeId: input.focusNodeId,
			});
			if (summary?.nodes) {
				const note =
					summary.omittedCount && summary.focusNodeId
						? `\n（画布共 ${summary.omittedCount + summary.nodes.length} 个节点，当前聚焦 ${summary.focusNodeId}，其余 ${summary.omittedCount} 个未列出；需要全量时调用 get_canvas_layout）`
						: "";
				layers.push(
					layer("canvas-summary", "canvas", `当前画布摘要：\n${JSON.stringify(summary)}${note}`),
				);
			}
		} catch (err) {
			this.logger.warn(
				`canvas summary unavailable for ${input.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		if (input.attachments?.length) {
			const block = buildSidebarBlock(input.attachments);
			if (block) layers.push(layer("sidebar", "sidebar", block));
		}

		// 审计 #7：memory 层放最后（世界状态之后、模型近期关注），fail-soft 语义由调用方保证。
		if (input.memoryBlock?.trim()) {
			layers.push(layer("memory", "memory", input.memoryBlock));
		}

		this.recordLayers(layers, input.sessionId);
		return layers.map((l) => l.content);
	}

	/** 记录 layers 与 manifest 行（既有观测口语义不变；sessionId 为空串表示静态段）。 */
	private recordLayers(layers: PromptLayer[], sessionId: string): void {
		const totalTokens = layers.reduce((sum, l) => sum + l.approxTokens, 0);
		const hash = promptHash(layers.map((l) => l.content).join("\n"));

		this.lastLayers = layers;
		this.lastManifestDetail = {
			sessionId,
			layers: layers.map((l) => ({ id: l.id, kind: l.kind, tokens: l.approxTokens })),
			totalTokens,
			promptHash: hash,
		};
		this.lastManifest = `prompt manifest ${sessionId || "(static)"}: ${layers
			.map((l) => `${l.id}:${l.kind}:${l.approxTokens}tok`)
			.join(" ")} total=${totalTokens}tok hash=${hash}`;
		this.logger.log(this.lastManifest);
	}
}
