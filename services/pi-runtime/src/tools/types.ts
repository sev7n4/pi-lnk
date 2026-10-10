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
	| "gen"
	| "graph_batch"
	| "destructive"
	| "ui_command"
	| "skill"
	/**
	 * 只读可视投影：产出**给用户看**的卡片，不写库、不改节点、不参与编排。
	 * 与 `ui_command` 的区别：ui_command 是"命令前端做事"（focus/undo），
	 * 本值是"agent 产出一份只读投影数据"。
	 */
	| "present";

/** 侧栏参考素材（Nest validateSidebarAttachments 之后的形态，此处不再清洗）。 */
export interface SidebarAttachment {
	url?: string;
	text?: string;
	mediaType?: string;
}

/** 每会话注入 toolContext 的值；SessionManager.create 时构造。 */
export interface LnkpiToolContext {
	/**
	 * **pi 会话键**（C4）：`spawn_subagent` 用它定位来源会话做 fork。
	 * 与 `sessionId`（画布会话 id，#70 语义）刻意分离——见该字段警示。
	 * 可选：仅 spawn 消费（缺失时 fail-soft 拒绝派发），生产 toolContext 恒填。
	 */
	piSessionKey?: string;
	/**
	 * **画布会话 id**（Nest `/agent/internal/*` 用它 `findUnique({id})` 查 `Session`）。
	 *
	 * ⚠️ 这**不是** pi 会话键（`toSessionKey(threadKey)`）。二者曾于 #70 被合并进本字段，
	 * 导致全部画布工具 404「会话不存在」（2026-09-29 hotfix 复盘，见
	 * `docs/superpowers/specs/2026-09-29-agent-tool-canvas-sessionid-hotfix-design.md`）。
	 * 取值由 SessionManager 决定：`canvasSessionId ?? pi 会话键`。**不要**在本字段上做
	 * 「会话键」语义的假设（例如与 `activeKeys()` 比对）。
	 */
	sessionId: string;
	/**
	 * **可信的画布会话 id**：`canvasSessionId` 存在时才有值，pi 会话键回落时为 undefined。
	 *
	 * 与 `sessionId` 的区别（终审 I-3）：`sessionId` 在 `canvasSessionId` 缺失时会**回落成
	 * pi 会话键**（`entry.canvasSessionId ?? key`），而 pi 会话键不是 `Session.id`。
	 * 画布工具用它查库是对的（#70 语义），但**记忆作用域**用它会把记忆挂到一个不存在的
	 * Session 上——召回时 `where:{sessionId:'<pi键>'}` 永远匹配不到，记忆静默丢。
	 * 所以需要「必须落画布」的写入方（记忆）只认本字段，缺失就不传 sessionId。
	 */
	trustedCanvasSessionId?: string;
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
