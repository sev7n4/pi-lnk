/**
 * PiPromptAssembler（#12）：Nest 每轮组装 pi-runtime 会话的完整 system prompt。
 *
 * 规则文本出处：services/agent-runtime/app/graph/nodes/explore.py:87-132（_EXPLORE_SYSTEM）。
 * 规则分组（B-2 起）：
 *   - core（默认注入）：前缀 + 规则 1/2/3/7（原文）；第 10 条「写操作未开放」守卫
 *     仅在 writeTools 未启用时附加（写工具上线后守卫退出）。
 *   - writeTools（B-2 随写工具注册启用）：规则 4/5 原文（explore.py:95-112 逐字）；
 *     规则 6/8/9 不拷贝（声明偏离，理由见 B-2 计划 §1.2）。
 *
 * 拼装顺序对齐 explore.py:393-408：规则 → 画布摘要 → 侧栏块 → 近期对话摘要。
 * 摘要获取失败时省略该块并继续（ Review Focus：prompt 必须始终成立）；
 * 摘要 JSON 不截断（有意对齐老链路）。
 */
import { Injectable, Logger } from "@nestjs/common";
import { compressRecentTurns, type TurnMessage } from "./compress-recent-turns";
import { buildSidebarBlock, type SidebarBlockInput } from "./sidebar-block";

export type RuleGroup = "core" | "writeTools";

/** 与老链路 1:1 的最小结构（getCanvasSummary.data）。 */
export interface CanvasSummaryData {
	nodes: Array<{ id: string; type: string; title: string; status: string }>;
}

export interface CanvasSummaryProvider {
	getCanvasSummary(input: { sessionId: string }): Promise<CanvasSummaryData>;
}

const CORE_RULES = `你是 lnkpi 无限画布助手。用简洁中文回答。
规则：
1. 必须通过工具完成读写操作，禁止假装已执行。
2. 平台支持在画布上生成图片/视频等媒体；不得否认平台的图片生成能力，也不要引导用户使用第三方作图工具。
3. 不要声称「正在生成」「马上生成」「已开始出图」；不要调用 run_*_generation（禁止调用任何 run_*）。真正出图/出视频须等用户在 UI 确认后由系统执行。
7. 若已提供【侧栏参考图解析】，不得声称只能看到文件名或画布节点标题。@I1/@I2 是侧栏芯片 key，不是画布节点 id。禁止问「I1 对应画布哪张图」；禁止把芯片映射到已有画布节点（除非用户明确要求改该节点）。侧栏图≥3 且未 @、或只有旧图且未 @：先问用哪几张或请 @I1，不要对闲聊新建节点。`;

/** 第 10 条守卫：仅在 writeTools 组未启用时注入（写工具上线后模型已可写，守卫退出）。 */
const RULE_10_WRITE_GUARD = `10. 当前会话仅开放只读查询工具（画布摘要/节点/生成状态/素材列表等）；创建、修改、连线、生成执行等写操作尚未开放——用户要求时如实说明，禁止虚构已执行。`;

/**
 * writeTools 组（B-2 启用）：explore.py:95-112 规则 4/5 逐字拷贝（含无空格拼接点）。
 * 声明偏离（计划 §1.2）：规则 6（tool_search）/8（B-4/B-6 工具）/9（upscale_image 断头）
 * 不拷贝——pi 侧对应工具/功能未上线，随所在批次补。
 */
const WRITE_TOOLS_RULES = `4. 用户要创建图片/视频/文本/音频节点或明确「生成一张…」时：用 upsert_media_node创建或更新节点（可带 prompt），按需再用 set_node_prompt 填参、用 connect_nodes 连线，然后调用 propose_generation，并等待用户确认；不要假装已出图。有侧栏参考图要出结果图时：用 upsert_media_node 新建一张图节点（用户明确要求改某个image-* 除外），再 apply_sidebar_attachments（mode=localRefs，mentioned_keys 用 I1/I2芯片序），必要时 set_node_prompt，然后 propose_generation。此路径不要 connect_nodes、不要 attach_refs。挂参分工：侧栏 @I* / I1 只用 apply_sidebar_attachments（mode=localRefs）；画布已有 image-* / video-* 才用 attach_refs 或 connect_nodes。禁止 attach_refs 吃芯片 key；禁止 connect_nodes 连芯片。闲聊、谢谢、纯识图问句、「重新生成一张」即使工具可见也不得 upsert_media_node / propose_generation。无「确认落到画布」不得 instantiate_workflow_template。一致性写在提示词和 ref 顺序（先身份后衣服/产品），不要再搭工作流。
5. 口语搭骨架（含「生图生视频」、多节点+连线+填 dock）：至少 upsert_media_node 两个媒体节点（一张 image 与一条 video，或 image→video 链），每个可生成节点 prompt 非空（创建时带 prompt 或 set_node_prompt），用 connect_nodes 连 canvas 节点 id，再对每个可生成节点 propose_generation。不要压成单个 atomic 式节点；不要 import_workflow / instantiate_workflow_template 顶替本句；不要把 @I* 芯片连成边。确认前不要 run_*、不要声称已出图。`;

/**
 * 规则组拼装：writeTools 启用 → core（无第 10 条）+ 规则 4/5；否则 core + 第 10 条守卫。
 * 声明偏离（M-2）：注入顺序为 1,2,3,7,4,5（explore.py 为 1..9 顺序）——规则带编号，
 * 顺序差异对模型语义无影响，不追求顺序对齐。
 */
function composeRuleText(groups: RuleGroup[]): string {
	if (groups.includes("writeTools")) {
		return `${CORE_RULES}\n${WRITE_TOOLS_RULES}`;
	}
	return `${CORE_RULES}\n${RULE_10_WRITE_GUARD}`;
}

@Injectable()
export class PiPromptAssembler {
	private readonly logger = new Logger(PiPromptAssembler.name);

	constructor(private readonly canvasTools: CanvasSummaryProvider) {}

	async assemble(input: {
		sessionId: string;
		attachments?: SidebarBlockInput[];
		mentionedKeys?: string[];
		priorMessages?: TurnMessage[];
		ruleGroups?: RuleGroup[];
		maxTurns?: number;
	}): Promise<string> {
		const groups = input.ruleGroups ?? ["core"];
		const parts: string[] = [composeRuleText(groups)];

		try {
			const summary = await this.canvasTools.getCanvasSummary({ sessionId: input.sessionId });
			if (summary?.nodes) {
				parts.push(`当前画布摘要：\n${JSON.stringify(summary)}`);
			}
		} catch (err) {
			this.logger.warn(
				`canvas summary unavailable for ${input.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		if (input.attachments?.length) {
			const block = buildSidebarBlock(input.attachments);
			if (block) parts.push(block);
		}

		const recent = compressRecentTurns(input.priorMessages ?? [], input.maxTurns ?? 4);
		if (recent) parts.push(`近期对话摘要：\n${recent}`);

		return parts.filter(Boolean).join("\n");
	}
}
