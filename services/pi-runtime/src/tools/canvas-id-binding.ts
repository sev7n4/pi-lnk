/**
 * Canvas 写链 id 结构性绑定（spec docs/superpowers/specs/2026-10-16-canvas-write-tool-chain-design.md §4.1 P1b）。
 *
 * 事故 cmv95a7sd000fqh01k1za6w1g：模型同批并行发射 upsert_media_node + set/propose，
 * 后两者用上下文里的旧节点 id，Nest 只校验「节点存在」→ 放行错绑（propose 卡指向旧机器人）。
 * 修复 = 原生钩子三件套（零新工具，底层原子工具契约不变）：
 * - after_tool 捕获 upsert 返回 nodeId（content[0].text = `{"ok":true,"data":{"nodeId":...}}`，
 *   形态出处 result-with-actions.ts + Nest controller {code,message,data} 解包）；
 * - before_tool 对 set/propose 以正确 id 重写 args —— harness `applyBeforeToolDecision`
 *   （execution/tools.js:37-54）会把替换参按工具 schema 重校验后执行 ⇒ 零重试；
 * - before_request 关「同批窗口」。
 *
 * 作用域 = 「同批窗口」：runId 为键、下次 before_request 关闭，精确对齐同一条 assistant
 * 消息的批次（sequential 模式下批次内 before_tool 全部触发完才到下一次 before_request）。
 * ⚠️ 不能只按 runId 作用域：一个 run 可跨多条消息，后续消息合法提名旧节点会被误重写。
 *
 * 注册顺序约束（index.ts 接线处遵守，此处只是记录）：本模块 after_tool 必须先于 index.ts
 * 既有 after_tool（截断/纠偏）注册——HookMap 多 listener 链式 replace（hooks.ts:305-324），
 * 后注册者看到前者的 patch，捕获必须看到未截断全文；before_tool 必须先于 plan-gate /
 * generation-gate，让 gate 的 Nest 存在性校验验的是重写后的正确 id。
 */
import type { AgentHarness } from "@earendil-works/pi-agent-core";
import type { LnkpiToolContext } from "./types.js";
import { readRecord, readStringField } from "../hook-contract.js";
import { canvasIdBindingEnabled } from "../runtime-config.js";

/** 重写目标工具（spec P1b 同批范围；set_node_text 走下方独立的跨轮窗口）。 */
const BINDING_TARGETS = new Set(["set_node_generation_params", "propose_generation"]);
const UPSERT_TOOL = "upsert_media_node";

/**
 * 跨轮文本写入纠偏窗口（2026-11-07 生产事故取证，见 docs/superpowers/specs/
 * 2026-10-16-canvas-write-tool-chain-design.md §2.2 v1.1 修订）。
 *
 * 事故形态：`upsert_media_node(target_type=text)` 与 `set_node_text(content)` **不在
 * 同一条 assistant 消息**（生产 executionEvents messageIndex 6 → 7），故同批窗口
 * 已被 before_request 关掉，模型从画布摘要里抄了旧节点 id 把 6563 字节 HTML 写进
 * 上一轮节点，新建节点留 `draft` + 空内容，回复却声称「已完成」。
 *
 * ⇒ 另开一个「一次请求」粘滞窗口，**仅对新建文本节点 + 带 content 的 set_node_text**：
 * - 开窗条件从 upsert 返回的 actions 判定（新 add_node 的 manifestKey =
 *   'upsert_media_text'）⇒ 媒体节点 upsert 不开窗，不误伤合法挂参；
 * - TTL=1：允许多跨一次模型请求（覆盖事故形态），再下一次 before_request 即关窗，
 *   不重蹈 spec「按 runId 作用域 ⇒ 后续合法提名旧节点被误重写」的覆辙；
 * - 一次成功 rewrite 后立刻删窗，不多轮连续纠偏；
 * - prompt-only 调用永不介入（既有测试「如同批 set_node_text 永不介入」语义保留）。
 */
const CONTENT_TOOL = "set_node_text";
const STICKY_TTL = 1;
interface ContentBindingWindow {
	created: string[];
	ttl: number;
}
const contentWindows = new Map<string, ContentBindingWindow>();

/** A3 留痕须覆盖两条绑定路径（同批 set/propose + 跨轮 set_node_text）。 */
function isBindingTarget(toolName: string): boolean {
	return BINDING_TARGETS.has(toolName) || toolName === CONTENT_TOOL;
}

/**
 * 同批窗口：runId → 本窗口内成功 upsert 返回的 nodeId 列表（length>1 = 无法消歧）。
 * 已知泄漏路径（终审 I1，容忍不建清理）：run 在 upsert after_tool 之后、下一次
 * before_request 之前被 abort ⇒ 该 runId 条目残留至进程退出；runId 为 uuidv7 全程唯一，
 * 残留条目永不命中后续裁决，惰性无害。
 */
const windows = new Map<string, string[]>();

/** 测试隔离：清空全部窗口（含跨轮文本写入窗口）。 */
export function resetIdBindingForTest(): void {
	windows.clear();
	contentWindows.clear();
}

/**
 * A3 改写留痕（2026-11-02 老黄牛死循环护栏，RCA v2 §4-A3，根因 R1）：
 * rewrite 是模型不可见的静默纠偏——事故中模型以为首次 propose 提的是乌龟，2 秒后
 * 「纠正性」再次 propose 老黄牛，触发 5min 超时死循环。修法：before_tool 记录改写
 * （键=toolCallId，before_tool/after_tool 事件都携带），after_tool 结算时把改写事实
 * 追加进模型可见的 content 尾部——保留「零重试」优点的同时消除认知分叉。
 * 泄漏面：改写后被后序 gate block 的 callId 不会有 after_tool → 记录残留。有界化：
 * 超过 256 条整表清空（键是 callId，跨 run 不可能复现同名，残留只影响不可达的追溯）。
 */
const rewrites = new Map<string, { original: string; corrected: string }>();
const REWRITES_CAP = 256;

/** 测试隔离：清空改写留痕记录。 */
export function resetIdBindingRewritesForTest(): void {
	rewrites.clear();
}

function safeParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * after_tool 捕获：成功 upsert 开窗并记录 nodeId；content 形态不符 → fail-soft 不记
 * （行为回退旧路径，绝不抛——钩子抛错会污染工具结算链）。
 */
export function recordUpsertedNode(runId: string, content: unknown): void {
	const items = Array.isArray(content) ? content : [];
	const first = items.find(
		(c): c is { type: "text"; text: string } =>
			!!c && typeof c === "object" && (c as { type?: unknown }).type === "text",
	);
	if (!first || typeof first.text !== "string") return;
	const parsed = readRecord(safeParse(first.text), "canvas-id-binding.content");
	if (!parsed.ok) return;
	const data = readRecord(parsed.value.data, "canvas-id-binding.content.data");
	if (!data.ok) return;
	const nodeId = readStringField(data.value, "nodeId", "canvas-id-binding.data.nodeId");
	if (!nodeId.ok) return;
	const list = windows.get(runId) ?? [];
	list.push(nodeId.value);
	windows.set(runId, list);

	// 跨轮文本写入窗口：只认「本批新建了文本节点」的 upsert 结果。
	// 形态出处 = Nest upsert-media-node 返回的 data.actions（add_node.payload.data）。
	const rawActions = (data.value as Record<string, unknown>).actions;
	const isTextCreate =
		Array.isArray(rawActions) &&
		rawActions.some((a) => {
			if (!a || typeof a !== "object") return false;
			const rec = a as Record<string, unknown>;
			if (rec.type !== "add_node") return false;
			const payload = rec.payload;
			if (!payload || typeof payload !== "object") return false;
			const nodeData = (payload as Record<string, unknown>).data;
			if (!nodeData || typeof nodeData !== "object") return false;
			return (nodeData as Record<string, unknown>).manifestKey === "upsert_media_text";
		});
	if (isTextCreate) {
		const cw = contentWindows.get(runId) ?? { created: [], ttl: STICKY_TTL };
		cw.created.push(nodeId.value);
		cw.ttl = STICKY_TTL;
		contentWindows.set(runId, cw);
	}
}

/**
 * before_request 关窗：同批窗口立即关闭（spec P1b 原语义不变）；
 * 跨轮文本窗口按 TTL 递减——首次请求保留（覆盖「upsert 之后的下一条消息」），
 * 第二次才真正删除（合法提名旧节点不再被误重写）。
 */
export function closeBindingWindow(runId: string): void {
	windows.delete(runId);
	const cw = contentWindows.get(runId);
	if (!cw) return;
	if (cw.ttl > 0) {
		cw.ttl -= 1;
		return;
	}
	contentWindows.delete(runId);
}

export type BindingDecision =
	| { kind: "passthrough" }
	| { kind: "rewrite"; nodeId: string }
	| { kind: "block"; reason: string };

/**
 * before_tool 裁决（纯函数，便于单测）：
 * - 窗口未开 → 放行（合法「用户点名旧节点」，沿用 Nest 存在性校验）；
 * - 窗口内 >1 个 upsert（多节点创建无法消歧）→ fail-closed block 列出候选，绝不猜测性重写；
 * - args.node_id 缺失/非字符串 → fail-closed block 指名正确 id（防御：正常已被工具 schema 拦下）；
 * - args.node_id ≠ 记录 id → rewrite（携带正确 id，由 register 层构造替换 args）。
 */
export function decideBinding(toolName: string, args: unknown, runId: string): BindingDecision {
	// 跨轮文本写入纠偏：仅「带 content 的 set_node_text」+ 本 run 刚新建文本节点。
	// prompt-only / 无窗口 / 非文本 upsert 一律放行，既有语义零变化。
	if (toolName === CONTENT_TOOL) {
		const rec = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
		if (typeof rec.content !== "string" || rec.content.length === 0) {
			return { kind: "passthrough" };
		}
		const cw = contentWindows.get(runId);
		if (!cw || cw.created.length === 0) return { kind: "passthrough" };
		if (cw.created.length > 1) {
			return {
				kind: "block",
				reason: `本条消息创建了多个文本节点（${cw.created.join(", ")}），无法确定 ${toolName} 的目标。请明确指名要操作的 node_id（需要多个节点时逐条消息操作），不要让我猜测。`,
			};
		}
		const created = cw.created[0];
		const current = readStringField(args, "node_id", "before_tool.args");
		if (!current.ok) {
			return {
				kind: "block",
				reason: `本条消息刚创建了文本节点 ${created}，${toolName} 必须对该 node_id 写入内容（当前 args 缺 node_id）。`,
			};
		}
		if (current.value === created) return { kind: "passthrough" };
		return { kind: "rewrite", nodeId: created };
	}
	if (!BINDING_TARGETS.has(toolName)) return { kind: "passthrough" };
	const list = windows.get(runId);
	if (!list || list.length === 0) return { kind: "passthrough" };
	if (list.length > 1) {
		return {
			kind: "block",
			reason: `本条消息创建了多个节点（${list.join(", ")}），无法确定 ${toolName} 的目标。请明确指名要操作的 node_id（需要多个节点时逐条消息操作），不要让我猜测。`,
		};
	}
	const created = list[0];
	const current = readStringField(args, "node_id", "before_tool.args");
	if (!current.ok) {
		return {
			kind: "block",
			reason: `本条消息刚创建了节点 ${created}，${toolName} 必须对该 node_id 操作（当前 args 缺 node_id）。`,
		};
	}
	if (current.value === created) return { kind: "passthrough" };
	return { kind: "rewrite", nodeId: created };
}

/**
 * 三钩子注册（index.ts onSessionCreated 顶部唯一接线点；kill switch off ⇒ 不注册）。
 * 注册顺序约束见文件头注释：调用方必须把本函数放在既有 after_tool（截断/纠偏）与
 * plan-gate / generation-gate 注册之前。
 */
export function registerCanvasIdBindingHooks(harness: AgentHarness<LnkpiToolContext>): void {
	if (!canvasIdBindingEnabled()) return;
	harness.hooks.on("after_tool", async (event) => {
		if (event.toolName === UPSERT_TOOL && !event.isError) {
			recordUpsertedNode(event.runId, event.content);
		}
		// A3 改写留痕：目标工具结算时把改写事实追加进模型可见 content（一次性，取后即删）。
		const rw = rewrites.get(event.toolCallId);
		if (rw && isBindingTarget(event.toolName)) {
			rewrites.delete(event.toolCallId);
			const trace = `📎 节点定位已由平台自动纠偏：你传入的 node_id「${rw.original}」并非本批新建节点，实际已作用于「${rw.corrected}」。后续引用该节点请一律使用「${rw.corrected}」，不要对它重复提议。`;
			return { content: [...event.content, { type: "text", text: trace }] };
		}
		return undefined; // 其余只捕获不改写：content patch（截断/纠偏）归 index.ts 既有 listener
	});
	harness.hooks.on("before_tool", async (event) => {
		const d = decideBinding(event.toolName, event.args, event.runId);
		if (d.kind === "rewrite") {
			// 跨轮窗口一次性：纠偏成功后立即关窗，不对后续 content 写入连续改写。
			if (event.toolName === CONTENT_TOOL) contentWindows.delete(event.runId);
			// event.args 是 Record<string, JsonValue>；仅替换 node_id，其余字段原样保留
			// （applyBeforeToolDecision 会按工具 schema 重校验整个替换参，非法即 fail-closed）。
			// 终审 I1 观测：重写是模型不可见的静默纠偏，留灰度回滚判定的唯一痕迹（fail-soft，不影响返回值）。
			console.warn(
				`[pi-runtime] canvas-id-binding rewrite: runId=${event.runId} toolName=${event.toolName} node_id ${event.args?.["node_id"]} → ${d.nodeId}`,
			);
			// A3：记录改写（键=toolCallId），结算后由 after_tool 追加模型可见留痕（RCA v2 R1 治本）。
			if (rewrites.size >= REWRITES_CAP) rewrites.clear();
			rewrites.set(event.toolCallId, {
				original: String(event.args?.["node_id"] ?? ""),
				corrected: d.nodeId,
			});
			return { args: { ...event.args, node_id: d.nodeId } };
		}
		if (d.kind === "block") {
			console.warn(
				`[pi-runtime] canvas-id-binding block: runId=${event.runId} toolName=${event.toolName} reason=${d.reason}`,
			);
			return { block: { reason: d.reason } };
		}
		return undefined;
	});
	harness.hooks.on("before_request", async (event) => {
		closeBindingWindow(event.runId);
		return undefined;
	});
}
