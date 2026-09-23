/**
 * PiPromptAssembler（#12）：Nest 每轮组装 pi-runtime 会话的完整 system prompt。
 *
 * 规则文本出处：services/agent-runtime/app/graph/nodes/explore.py:87-132（_EXPLORE_SYSTEM）。
 * 规则分组（有意偏离审计 §4 的「9 条全量平移」，理由见计划 §「与审计的偏离」）：
 *   - core（默认注入）：前缀 + 规则 1/2/3/7 + 第 10 条「写操作未开放」守卫。
 *   - writeTools（B-2 起随写工具注册逐组启用）：规则 4/5/6/8/9 原文——**当前为占位，
 *     B-2 实施者从 explore.py:95-125 逐字拷贝对应条目**，并与工具注册同一 PR 启用，
 *     否则模型会调用未注册工具。
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
3. 不要声称「正在生成」「马上生成」「已开始出图」；禁止调用任何 run_*。真正出图/出视频须等用户在 UI 确认后由系统执行。
7. 若已提供【侧栏参考图解析】，不得声称只能看到文件名或画布节点标题。@I1/@I2 是侧栏芯片 key，不是画布节点 id。禁止问「I1 对应画布哪张图」；禁止把芯片映射到已有画布节点（除非用户明确要求改该节点）。侧栏图≥3 且未 @、或只有旧图且未 @：先问用哪几张或请 @I1，不要对闲聊新建节点。
10. 当前会话仅开放只读查询工具（画布摘要/节点/生成状态/素材列表等）；创建、修改、连线、生成执行等写操作尚未开放——用户要求时如实说明，禁止虚构已执行。`;

/**
 * B-2 占位：实施时从 explore.py:95-125 逐字拷贝规则 4/5/6/8/9 原文（含规则间换行），
 * 并确认对应工具已在 pi registry 注册。当前占位正文不得注入生产 prompt。
 */
const WRITE_TOOLS_RULES = `（writeTools 组占位：B-2 实施时以 explore.py 规则 4/5/6/8/9 原文替换本行——见 pi-prompt-assembler.service.ts 顶部注释）`;

const RULE_GROUP_TEXT: Record<RuleGroup, string> = {
	core: CORE_RULES,
	writeTools: WRITE_TOOLS_RULES,
};

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
		const parts: string[] = [groups.map((g) => RULE_GROUP_TEXT[g]).join("\n")];

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
