/**
 * 畸形 toolCall 上下文卫生（2026-11-28，会话 cmx05m9d2 根因修复）。
 *
 * 上游 `pi-ai@0.99.2 transformMessages` 会为孤儿 toolCall 补 synthetic result、
 * 跳过 errored/aborted assistant，但**不校验 toolCall 的 id/name 是否非空**。
 * 一次模型畸形输出（id="" / name=""）会在 transcript 里留下 toolResult{toolCallId:""}，
 * 之后每一轮请求都被上游 400 `missing field tool_call_id` 打回，且压缩也清不掉。
 *
 * 本模块只做一件事：在 `transform_context` 阶段（早于上游 `toProviderMessages`）
 * 把这种结构性坏消息从**发给 LLM 的上下文快照**里剔除。磁盘 transcript 不动。
 * 纯函数：不改输入数组/消息对象；零命中返回 undefined（零拷贝直通）。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface ToolCallSanitizationResult {
	messages: AgentMessage[];
	removedCalls: number;
	removedResults: number;
}

type LooseMessage = { role?: unknown; content?: unknown; toolCallId?: unknown };

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isToolCallBlock(block: unknown): boolean {
	return (
		block !== null &&
		typeof block === "object" &&
		(block as { type?: unknown }).type === "toolCall"
	);
}

/**
 * 剔除空 id / 空 name 的 toolCall，以及空 toolCallId 或指向被剔除调用的 toolResult。
 * 返回值含计数供日志与 metrics 使用；无命中返回 undefined。
 */
export function sanitizeMalformedToolCalls(messages: AgentMessage[]): ToolCallSanitizationResult | undefined {
	if (!Array.isArray(messages) || messages.length === 0) return undefined;

	// 第一遍：找出所有畸形调用。id 非空但 name 为空的调用，其 toolResult 带合法 id，
	// 必须按 id 关联删除，否则会在上游被当成孤儿调用重新补出一条 synthetic result。
	const droppedIds = new Set<string>();
	let removedCalls = 0;
	for (const message of messages) {
		const m = message as unknown as LooseMessage;
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const block of m.content as unknown[]) {
			if (!isToolCallBlock(block)) continue;
			const b = block as { id?: unknown; name?: unknown };
			if (nonEmptyString(b.id) && nonEmptyString(b.name)) continue;
			removedCalls += 1;
			if (nonEmptyString(b.id)) droppedIds.add(b.id);
		}
	}

	// 第二遍：产出清洗后的新数组。无变更的消息复用原对象引用（prompt caching 稳定前缀）。
	let removedResults = 0;
	const out: AgentMessage[] = [];
	for (const message of messages) {
		const m = message as unknown as LooseMessage;
		if (m.role === "toolResult") {
			if (!nonEmptyString(m.toolCallId) || droppedIds.has(m.toolCallId)) {
				removedResults += 1;
				continue;
			}
			out.push(message);
			continue;
		}
		if (m.role === "assistant" && Array.isArray(m.content)) {
			const blocks = (m.content as unknown[]).filter(
				(block) => !isToolCallBlock(block) || (nonEmptyString((block as { id?: unknown }).id) && nonEmptyString((block as { name?: unknown }).name)),
			);
			if (blocks.length !== (m.content as unknown[]).length) {
				// 整条消息只有坏调用 → 不发送空 assistant；否则保留 text/thinking 等正常块。
				if (blocks.length === 0) continue;
				out.push({ ...message, content: blocks } as unknown as AgentMessage);
				continue;
			}
		}
		out.push(message);
	}

	if (removedCalls === 0 && removedResults === 0) return undefined;
	return { messages: out, removedCalls, removedResults };
}
