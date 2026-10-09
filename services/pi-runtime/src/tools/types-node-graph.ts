/**
 * `node_graph` 载荷：把画布**原样**交给前端节点图渲染（2026-10-07）。
 *
 * ## 为什么要有它（与 `svg_card` 并存，不是替换）
 *
 * `svg_card` 让 pi-runtime **自己画 SVG**（717 行 `render-canvas-view.ts` + `expressive.ts`），
 * 代价是：
 * - 工具的 `description` + `parameters` 占**2104 token**（占全量 schema 9092 的 23%）；
 * - 输出是**静态 SVG 字符串** ⇒ 前端只能整块贴图，无法拖拽 / 缩放 / 点开大图；
 * - 画布是**视觉资产生产**场景（全是图片节点），而 SVG 卡片只能给文件名列表 ⇒ 信息量≈0。
 *
 * `node_graph` 只做一件事：**把 `get-canvas-layout` 的结果原样透传**。
 * 位置、连线、分组都来自画布 SSOT，**零翻译** ⇒ 前端用 Vue Flow 之类节点图库直接渲染。
 *
 * ## 协议为什么不用改
 *
 * `present-result.ts` 的 `presentResult()` 把载荷放进 `details.canvasCommands[]`，
 * 而 Nest 侧 `extractCanvasCommands`（`apps/server/src/agent/pi-runtime/pi-events.ts:318`）
 * 的 filter 只有 `typeof c.type === "string"`
 * ⇒ **新增 `type` 直接通过**，不动 `pi-events.ts`、不动 SSE、不动事件协议。
 *
 * ## 双写期约定
 *
 * 本阶段（后端）**同时**产出 `svg_card` 与 `node_graph`：
 * - 前端尚未接`node_graph` ⇒ 多出来的 command 会被 `AgentSideRail` 忽略（无害）；
 * - 等前端 PR 上线并灰度验证后，再删 `svg_card` 产出路径与717 行 SVG 代码。
 */
import type { SvgCardPayload } from "./types-payload.js";

/** 画布节点类型（与前端 `canvasNodes` 的 `type` 对齐，取值来自 `get-canvas-layout`）。 */
export type NodeGraphNodeType = "image" | "text" | "video" | "audio" | "group" | "table" | (string & {});

/** 单个节点。字段名沿用 `get-canvas-layout` 的原样，**不做重命名**（少一层翻译=少一处错）。 */
export interface NodeGraphNode {
	id: string;
	type: NodeGraphNodeType;
	title: string;
	/** 画布坐标（CSS px）。缺失时前端按 `layout` 兜底排布。 */
	position?: { x: number; y: number };
	/** 尺寸（若有，来自 layout 的 width/height）。 */
	size?: { width: number; height: number };
	/** 所属分组 `group-*` 节点的 id（前端用它画 group 框）。 */
	groupId?: string;
	/** 状态提示（如"重生中"）。前端渲染为节点上的角标，不参与布局。 */
	status?: "idle" | "running" | "failed";
}

/** 有向边。`source`/`target` 均为节点 id。 */
export interface NodeGraphEdge {
	source: string;
	target: string;
	label?: string;
}

/**
 * `node_graph` 命令载荷。
 *
 * ⚠️ **不遵守 `SVG_MAX_CHARS` 上限**：那个上限针对 SVG 字符串（截断会产生不合法 XML）。
 * 本载荷是结构化数据，可安全裁剪；超限时按 `truncated` + `droppedNodeIds` 表达，
 * **不静默丢节点**（对齐 spec「数据源缺失则报错，不编造」的精神）。
 */
export interface NodeGraphPayload {
	type: "node_graph";
	title?: string;
	/** 节点数上限（防御性，正常画布远小于此）。 */
	nodes: NodeGraphNode[];
	edges: NodeGraphEdge[];
	/** 因超限被丢弃的节点 id（非空⇒ 前端应提示"部分节点未显示"）。 */
	droppedNodeIds?: string[];
	/** 画布上共有多少节点（即便 `nodes` 被裁剪，这个数仍是真实值）。 */
	totalNodeCount?: number;
	/**
	 * D4 §4.5：本轮该呈现哪一种（与 `SvgCardPayload.preferredKind` 同一个值）。
	 * 语义、通道约束与「为什么两条同值」的理由全见该字段处的注释。
	 *
	 * ⛔ 本载荷**没有 severity / mark 字段**（`toNodeGraphNode` 逐字段确认过）
	 * ⇒ 一旦它赢下呈现，静态图里那套 `data-sev` / ERROR·WARN 配色 / 图例就全丢了。
	 * 这正是判据把 winner 指向别处的唯一风险面，也是规格 §4.5 第一行拦它的原因。
	 */
	preferredKind?: "svg_card" | "node_graph";
}

/** 与 `SvgCardPayload` 并列的 present 载荷联合。 */
export type PresentPayload = SvgCardPayload | NodeGraphPayload;

/** 载荷 `type` 的字面量集合（供测试与前端分派用）。 */
export type PresentPayloadType = PresentPayload["type"];