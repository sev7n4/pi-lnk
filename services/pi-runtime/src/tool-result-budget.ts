/**
 * 工具结果统一预算（接在 vendor `after_tool` hook 上，审计「缺统一上限」）。
 *
 * 为什么需要这一层：审计报告「做对的」一节把现状判得很准——
 * 「工具结果已有分层瘦身……问题不在有没有截断，而在没有统一上限」。
 * 现有的截断全是**按工具各自语义**写的（web 20k/8k、memory 2000、canvas-read 50 项…），
 * 于是：① 没有一个全局数能回答「一条工具结果最多能占多少上下文」；
 * ② 体积观测只接了一半（`observeToolResult` 仅 Nest 客户端回调在打点，本地工具没有）。
 *
 * 本层的定位是**兜底**，不是替代：
 * - 默认上限 24_000 字符 **高于**现存所有自带截断（最大 20_000），正常链路永不触发；
 * - 只对**越界的异常值**出手（例如 canvas-read 命中 50 项大 content、文档抽取整篇）；
 * - 图片块原样放行——它由 `before_payload` 图片治理负责，字符预算管不了也管不对。
 *
 * 边界（务必记住）：
 * - `after_tool` 的 patch 只能改 content/details/isError，**不能**改工具已经产生的副作用；
 * - 截断是**保头弃尾**：模型看到的是结果的前半段 + 明确的省略标记，不会误以为拿到了全量。
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

/** 默认单条工具结果字符上限（兜底值，高于现存各工具自带截断）。 */
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 24_000;

/** 省略标记中数字位数的预留（"已省略 1234567 字符" 这类最多 7 位 + 修饰）。 */
const MARKER_RESERVE = 48;

type ContentBlock = AgentToolResult<unknown>["content"][number];
type TextBlock = { type: "text"; text: string };

function isTextBlock(b: unknown): b is TextBlock {
	return (
		typeof b === "object" &&
		b !== null &&
		(b as { type?: unknown }).type === "text" &&
		typeof (b as { text?: unknown }).text === "string"
	);
}

function marker(droppedChars: number): string {
	return `\n…（已截断：省略 ${droppedChars} 字符；需要完整内容请缩小查询范围或分页读取）`;
}

/** 文本块总字符数 + UTF-8 字节数。非数组 / 图片块计 0，不做猜测。 */
export function measureToolResult(content: unknown): { chars: number; bytes: number } {
	if (!Array.isArray(content)) return { chars: 0, bytes: 0 };
	let chars = 0;
	for (const b of content) {
		if (isTextBlock(b)) chars += b.text.length;
	}
	return { chars, bytes: Buffer.byteLength(collectText(content), "utf8") };
}

function collectText(content: unknown[]): string {
	let s = "";
	for (const b of content) if (isTextBlock(b)) s += b.text;
	return s;
}

export type ToolResultCap = {
	content: AgentToolResult<unknown>["content"];
	chars: number;
	bytes: number;
	trimmed: boolean;
	droppedChars: number;
};

/**
 * 把工具结果压到 `maxChars` 以内。
 *
 * 契约外形态（非数组）原样返回且 `trimmed=false` —— 宁可不治理，也不改写看不懂的结构。
 */
export function capToolResult(
	content: AgentToolResult<unknown>["content"],
	maxChars: number = DEFAULT_TOOL_RESULT_MAX_CHARS,
): ToolResultCap {
	if (!Array.isArray(content)) {
		return { content, chars: 0, bytes: 0, trimmed: false, droppedChars: 0 };
	}
	const totalChars = content.reduce((n, b) => (isTextBlock(b) ? n + b.text.length : n), 0);
	if (totalChars <= maxChars) {
		const m = measureToolResult(content);
		return { content, chars: m.chars, bytes: m.bytes, trimmed: false, droppedChars: 0 };
	}

	// 预留标记长度后再切，保证「正文 + 标记」整体不超上限。
	const budget = Math.max(0, maxChars - MARKER_RESERVE);
	const kept: ContentBlock[] = [];
	let used = 0;
	// ⚠️ 不能用 break：跨界块之后的**图片块必须照常保留**（图片不占字符预算，
	// 由 before_payload 治理）。break 会把它们连同后继文本块一起丢掉。
	let exhausted = false;
	for (const b of content) {
		if (!isTextBlock(b)) {
			kept.push(b); // 图片等非文本块原样保留
			continue;
		}
		if (exhausted) continue; // 预算耗尽：后继文本块整体丢弃
		const remaining = budget - used;
		if (remaining <= 0) {
			exhausted = true;
			continue;
		}
		if (b.text.length <= remaining) {
			kept.push(b);
			used += b.text.length;
			continue;
		}
		kept.push({ type: "text", text: b.text.slice(0, remaining) } as ContentBlock);
		used += remaining;
		exhausted = true;
	}

	const droppedChars = totalChars - used;
	const tail = marker(droppedChars);
	const lastText = [...kept].reverse().find((b) => isTextBlock(b)) as TextBlock | undefined;
	if (lastText) {
		lastText.text = `${lastText.text}${tail}`;
	} else {
		kept.push({ type: "text", text: tail.slice(0, Math.max(0, maxChars)) } as ContentBlock);
	}

	const outChars = kept.reduce((n, b) => (isTextBlock(b) ? n + b.text.length : n), 0);
	return {
		content: kept,
		chars: outChars,
		bytes: Buffer.byteLength(collectText(kept), "utf8"),
		trimmed: true,
		droppedChars,
	};
}
