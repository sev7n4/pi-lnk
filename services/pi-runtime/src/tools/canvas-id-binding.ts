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

/** 重写目标工具（spec P1b 范围锁定；set_node_text 等不扩——YAGNI，spec §2.2）。 */
const BINDING_TARGETS = new Set(["set_node_generation_params", "propose_generation"]);
const UPSERT_TOOL = "upsert_media_node";

/**
 * 同批窗口：runId → 本窗口内成功 upsert 返回的 nodeId 列表（length>1 = 无法消歧）。
 * 已知泄漏路径（终审 I1，容忍不建清理）：run 在 upsert after_tool 之后、下一次
 * before_request 之前被 abort ⇒ 该 runId 条目残留至进程退出；runId 为 uuidv7 全程唯一，
 * 残留条目永不命中后续裁决，惰性无害。
 */
const windows = new Map<string, string[]>();

/** 测试隔离：清空全部窗口。 */
export function resetIdBindingForTest(): void {
	windows.clear();
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
}

/** before_request 关窗（上一条 assistant 消息批次已完整落定）。 */
export function closeBindingWindow(runId: string): void {
	windows.delete(runId);
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
		if (rw && BINDING_TARGETS.has(event.toolName)) {
			rewrites.delete(event.toolCallId);
			const trace = `📎 节点定位已由平台自动纠偏：你传入的 node_id「${rw.original}」并非本批新建节点，实际已作用于「${rw.corrected}」。后续引用该节点请一律使用「${rw.corrected}」，不要对它重复提议。`;
			return { content: [...event.content, { type: "text", text: trace }] };
		}
		return undefined; // 其余只捕获不改写：content patch（截断/纠偏）归 index.ts 既有 listener
	});
	harness.hooks.on("before_tool", async (event) => {
		const d = decideBinding(event.toolName, event.args, event.runId);
		if (d.kind === "rewrite") {
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
