/**
 * 生产库 → 图形化表达观测报告（spec §6 D1-4「一个只读查询入口」）。
 *
 * ⚠️⚠️ **数据源判据（与实施计划不同，这是取证后的修正）**：
 *   计划原设计扫 `metadata.executionEvents` 里的 `text_delta` 判「信号是否命中」，
 *   但**实测 `text_delta` 从不落库** —— `agent.service.ts` 只在
 *   `ui.type === 'tool_call' || 'tool_result'`（外加 canvas_command / canvas_action /
 *   thinking / turn_usage / task_*）时 push 进 `executionEvents`，`text_delta` 只走 SSE。
 *   ⇒ 按原设计跑，signaled 恒为 0 ⇒ 触发率的分母恒为 0 ⇒ 报告看起来「没有数据」，
 *   而实际上只是**取错了地方**。这是本文件存在的首要理由。
 *
 * ⭐ 正确的数据源：
 *   - 信号（分母）← **用户消息** `AgentMessage.role='user'` 的 `content`
 *     （spec 原话「该画图的**问句**里有多少真画了」，问句在 user 行）
 *   - 是否画了（分子）← 紧随其后的 assistant 行 `metadata.executionEvents` 里的 `tool_call`
 *     （`tool_call` 确实落库，且带 `args` ⇒ view / 参数使用率一并可得）
 *
 * 纯函数：不碰 IO，便于单测。薄壳见 `scripts/query-graph-observation.ts`。
 */
import { GRAPH_SIGNAL_WORDS, GRAPH_SIGNAL_WORDS_ASSIST, isKnownViewName, isLegacyViewName, normalizeViewName } from "./graph-metrics.js";

const DRAW_TOOL = "render_canvas_view";
/** 「该画没画」样本留取上限（人工判 L3 用，不必全量）。 */
const MISSED_SAMPLE_MAX = 10;

export interface MessageRow {
	role: string;
	content: string;
	/** 库里是 JSON 字符串；已解析好的对象也接受。 */
	metadata?: string | Record<string, unknown> | null;
}

export interface ExecEvent {
	type?: string;
	data?: unknown;
}

export interface GraphObservationReport {
	/** 成对的轮次数（user → assistant）。 */
	turns: number;
	signaled: number;
	drew: number;
	/** drew / signaled；分母为 0 时返回 **0**（不是 NaN / Infinity）。 */
	triggerRate: number;
	views: Record<string, number>;
	legacy: number;
	paramUsage: Record<string, number>;
	detours: Record<string, number>;
	/** 命中信号却没画图的问句样本（前 80 字）—— 人工判「规则问题 vs 模型能力问题」用。 */
	missedSamples: string[];
}

function containsSignal(text: string, words: readonly string[]): boolean {
	return words.some((w) => text.includes(w));
}

function parseMetadata(meta: MessageRow["metadata"]): Record<string, unknown> {
	if (!meta) return {};
	if (typeof meta === "object") return meta;
	try {
		const parsed: unknown = JSON.parse(meta);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function execEvents(meta: MessageRow["metadata"]): ExecEvent[] {
	const raw = parseMetadata(meta).executionEvents;
	if (!Array.isArray(raw)) return [];
	return raw.filter((e): e is ExecEvent => !!e && typeof e === "object");
}

function toolNameOf(data: unknown): string {
	if (!data || typeof data !== "object") return "";
	const d = data as Record<string, unknown>;
	const n = d.toolName ?? d.name;
	return typeof n === "string" ? n : "";
}

function argsOf(data: unknown): Record<string, unknown> {
	if (!data || typeof data !== "object") return {};
	const a = (data as Record<string, unknown>).args;
	return a && typeof a === "object" && !Array.isArray(a) ? (a as Record<string, unknown>) : {};
}

function bump(m: Record<string, number>, k: string): void {
	if (!k) return;
	m[k] = (m[k] ?? 0) + 1;
}

/**
 * 从成对的 user→assistant 行里出报告。
 *
 * ⚠️ 只有**用户行后面紧跟的助手行**才算一轮：孤立助手行（系统/工具回填）
 * 不产生信号，强行配对会把「没有问句」也算进分母。
 */
export function buildReport(rows: readonly MessageRow[]): GraphObservationReport {
	const report: GraphObservationReport = {
		turns: 0,
		signaled: 0,
		drew: 0,
		triggerRate: 0,
		views: {},
		legacy: 0,
		paramUsage: {},
		detours: {},
		missedSamples: [],
	};
	let pendingUser: string | null = null;

	for (const row of rows) {
		if (row.role === "user") {
			pendingUser = row.content ?? "";
			continue;
		}
		if (row.role !== "assistant" || pendingUser === null) continue;
		const userText = pendingUser;
		pendingUser = null;
		report.turns += 1;

		const assistantText = row.content ?? "";
		const signaled =
			containsSignal(userText, GRAPH_SIGNAL_WORDS) ||
			containsSignal(assistantText, GRAPH_SIGNAL_WORDS_ASSIST);

		const events = execEvents(row.metadata);
		let drew = false;
		let detour: string | null = null;
		for (const ev of events) {
			// ⚠️ 只认 tool_call：tool_result 不带 args，重复计入会把参数使用率翻倍。
			if (ev.type !== "tool_call") continue;
			const name = toolNameOf(ev.data);
			if (name === DRAW_TOOL) {
				drew = true;
				const args = argsOf(ev.data);
				for (const key of Object.keys(args)) bump(report.paramUsage, key);
				const view = args.view;
				if (typeof view === "string" && isKnownViewName(view)) {
					bump(report.views, normalizeViewName(view));
					if (isLegacyViewName(view)) report.legacy += 1;
				}
			} else if (!drew && detour === null) {
				detour = name;
			}
		}

		if (!signaled) continue;
		report.signaled += 1;
		if (drew) {
			report.drew += 1;
			if (detour !== null) bump(report.detours, detour);
		} else if (report.missedSamples.length < MISSED_SAMPLE_MAX) {
			report.missedSamples.push(userText.slice(0, 80));
		}
	}

	report.triggerRate = report.signaled === 0 ? 0 : report.drew / report.signaled;
	return report;
}
