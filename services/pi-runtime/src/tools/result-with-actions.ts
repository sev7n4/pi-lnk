/**
 * Nest 写工具的统一返回形态。
 *
 * ⚠️ `actions` **必须**走 `details.actions`：Nest 侧 `extractCanvasActions` 只认
 * `tool_execution_end.result.details.actions`，据此派生 canvas_action SSE → 前端实时改画布。
 * 用 textResult（details:undefined）会把 actions 埋在文本里丢掉，导致
 * 「Nest 已改、画布不变，要等回合末全量回拉」——PR #65 已经踩过一次（delete_nodes）。
 */
export function extractActions(data: unknown): Record<string, unknown>[] {
	const actions = (data as { actions?: unknown } | null | undefined)?.actions;
	if (!Array.isArray(actions)) return [];
	return actions.filter((a): a is Record<string, unknown> => !!a && typeof a === "object");
}

export function resultWithActions(data: unknown): {
	content: [{ type: "text"; text: string }];
	details: { actions: Record<string, unknown>[] };
} {
	return {
		content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }],
		details: { actions: extractActions(data) },
	};
}
