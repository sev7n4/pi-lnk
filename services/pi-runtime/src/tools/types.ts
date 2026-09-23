/**
 * 工具注册表类型（P1-④）
 *
 * tier 与老 runtime `app/tools/tool_registry.py: TOOL_TIERS` 一一对应，
 * 供 before_tool 审批（B-3）与 metrics 分组使用；harness 不感知 tier。
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
	| "destructive";

/** 每会话注入 toolContext 的值；SessionManager.create 时构造。 */
export interface LnkpiToolContext {
	sessionId: string;
	userId?: string;
}

export type LnkpiTool = AgentHarnessTool<LnkpiToolContext> & { tier: ToolTier };
