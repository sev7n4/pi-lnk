/**
 * SSE / 会话 replay buffer 副本瘦身：tool result（最多 2MB → base64 ≈2.7MB）里的
 * image block 只服务模型上下文，前端/SSE 不需要。除 `tool_end.result` 外，同一条
 * tool-result message 还随 `message_start`/`message_end`（`message.content[]`）与
 * `turn_end`（`toolResults[].content[]`）流入 SSE 帧与缓冲，故一并剥离。
 * 替换为 `{type:"image", mimeType, bytes, omitted:true}`——保留语义、去掉 data。
 * 任何一处无图时返回**原对象**（避免无谓重建，保证开关 off 下事件逐字节一致）；
 * 永不改动输入对象及其嵌套结构。
 */

/** 单个 content block：image → 轻量描述符；其余（含非对象）原样返回（可判引用是否变化）。 */
function stripImageBlock(block: unknown): unknown {
	const b = block as { type?: unknown; data?: unknown; mimeType?: unknown } | null | undefined;
	if (!b || typeof b !== "object" || b.type !== "image") return block;
	return {
		type: "image",
		mimeType: typeof b.mimeType === "string" ? b.mimeType : "image/*",
		bytes: typeof b.data === "string" ? Math.floor((b.data.length * 3) / 4) : 0,
		omitted: true,
	};
}

/** 剥离一个 content[]；无变更（或非数组）返回 undefined，调用方据此保持原引用。 */
function stripContent(content: unknown): unknown[] | undefined {
	if (!Array.isArray(content)) return undefined;
	let changed = false;
	const out = content.map((block) => {
		const next = stripImageBlock(block);
		if (next !== block) changed = true;
		return next;
	});
	return changed ? out : undefined;
}

export function stripImageBlocks<T extends object>(evt: T): T {
	const e = evt as { result?: unknown; message?: unknown; toolResults?: unknown };
	const patch: { result?: unknown; message?: unknown; toolResults?: unknown } = {};

	if (e.result && typeof e.result === "object") {
		const content = stripContent((e.result as { content?: unknown }).content);
		if (content) patch.result = { ...(e.result as object), content };
	}
	if (e.message && typeof e.message === "object") {
		const content = stripContent((e.message as { content?: unknown }).content);
		if (content) patch.message = { ...(e.message as object), content };
	}
	if (Array.isArray(e.toolResults)) {
		let changed = false;
		const toolResults = e.toolResults.map((tr) => {
			if (!tr || typeof tr !== "object") return tr;
			const content = stripContent((tr as { content?: unknown }).content);
			if (!content) return tr;
			changed = true;
			return { ...(tr as object), content };
		});
		if (changed) patch.toolResults = toolResults;
	}

	if (Object.keys(patch).length === 0) return evt;
	return { ...evt, ...patch };
}
