/**
 * 近期对话压缩器（#12，语义 1:1 平移 services/agent-runtime/app/graph/recent_turns.py:58-106）。 （注：老 LangGraph runtime 已于 2026-09-27 退役删除，该路径为历史语义出处）
 *
 * 已知差异（计划 §「与审计的偏离」2）：pi 路径 Nest 侧暂无工具调用持久化，
 * 「助手工具」行由调用方传入 toolNames（canvas_action 落库后由 B-2 批次接上）。
 */

export interface TurnMessage {
	role: "user" | "assistant" | "tool";
	content: string;
	toolNames?: string[];
}

const snippet = (s: string, limit: number) => (s.length > limit ? s.slice(0, limit - 1) + "…" : s);

export function compressRecentTurns(messages: TurnMessage[], maxTurns = 4): string {
	if (!messages.length || maxTurns <= 0) return "";

	const turns: TurnMessage[][] = [];
	let current: TurnMessage[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			if (current.length) turns.push(current);
			current = [msg];
		} else {
			if (!current.length) current = [msg];
			else current.push(msg);
		}
	}
	if (current.length) turns.push(current);

	const lines: string[] = [];
	for (const turn of turns.slice(-maxTurns)) {
		for (const msg of turn) {
			const content = (msg.content ?? "").trim();
			if (msg.role === "user") {
				if (content) lines.push(`用户: ${content}`);
				continue;
			}
			if (msg.role === "assistant") {
				const names = (msg.toolNames ?? []).filter(Boolean);
				if (names.length) lines.push(`助手工具: ${names.join(", ")}`);
				if (content) lines.push(`助手: ${snippet(content, 160)}`);
				continue;
			}
			if (content) lines.push(`工具结果: ${snippet(content, 120)}`);
		}
	}
	return lines.join("\n");
}
