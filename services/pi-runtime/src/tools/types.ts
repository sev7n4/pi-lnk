/**
 * 工具注册表类型（P1-④）
 *
 * tier 与老 runtime `app/tools/tool_registry.py: TOOL_TIERS` 一一对应，
 * 供 before_tool 审批（B-3）与 metrics 分组使用；harness 不感知 tier。
 * ui_command = 本地 UI 命令（canvas_command 通道），不走 Nest。
 * skill = SKILL.md 按需加载（D-η'）。
 */
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";

export type ToolTier =
	| "read"
	| "write_light"
	| "lifecycle"
	| "workflow_io"
	| "export"
	| "gen"
	| "graph_batch"
	| "destructive"
	| "ui_command"
	| "skill";

/** 侧栏参考素材（Nest validateSidebarAttachments 之后的形态，此处不再清洗）。 */
export interface SidebarAttachment {
	url?: string;
	text?: string;
	mediaType?: string;
}

/** 每会话注入 toolContext 的值；SessionManager.create 时构造。 */
export interface LnkpiToolContext {
	sessionId: string;
	userId?: string;
	/** 画布上下文（#12，B-2 写工具依赖）：由 /sessions body 原样透传。 */
	attachments?: SidebarAttachment[];
	mentionedKeys?: string[];
	refOrder?: string[];
	focusNodeId?: string;
}

/**
 * 工具定义（`tier` 之外的字段全部来自 harness 的 AgentTool）。
 *
 * ⚠️ `summary` / `deferred` 是**渐进加载的占位 seam**（WorkBuddy 对齐 §4 #3）：
 * 现在只落地字段，不实现任何加载/筛选逻辑——等注入观测数据到位后再定策略。
 * 字段先存在 = 将来工具渐进加载改造注册表时零迁移。
 */
export type LnkpiTool = AgentHarnessTool<LnkpiToolContext> & {
	tier: ToolTier;
	/**
	 * 工具的一句话摘要，供「先名后详情」的索引展示（渐进加载第一阶段的唯一可见内容）。
	 * 未填时消费方经 {@link toolSummary} 回退 `description`。
	 */
	summary?: string;
	/**
	 * 标记为延迟加载工具：完整 schema 在意图命中后才注入。
	 * ⚠️ 与 vendor `AgentHarnessStreamOptions.deferred` 同名但语义无关
	 * （后者是 provider 异步续生成），勿混淆。
	 */
	deferred?: boolean;
};

/**
 * 渐进加载 accessor：摘要缺省回退 `description`。
 * 让消费方现在就统一走这个函数，将来 summary 逐个补齐时无需改调用点。
 */
export function toolSummary(tool: LnkpiTool): string {
	return tool.summary ?? tool.description;
}
