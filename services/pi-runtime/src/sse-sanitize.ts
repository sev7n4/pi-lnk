/**
 * SSE / 会话 replay buffer 副本瘦身：`tool_end.result` 是完整 AgentToolResult，
 * image block（最多 2MB → base64 ≈2.7MB）只服务模型上下文，前端/SSE 不需要。
 * 替换为 `{type:"image", mimeType, bytes, omitted:true}`——保留语义、去掉 data。
 * 无图时返回**原对象**（避免无谓重建，保证开关 off 下事件逐字节一致）。
 */
export function stripImageBlocks<T extends object>(evt: T): T {
	const result = (evt as { result?: unknown }).result as
		| { content?: unknown }
		| undefined
		| null;
	if (!result || !Array.isArray(result.content)) return evt;
	let changed = false;
	const content = result.content.map((block) => {
		const b = block as { type?: unknown; data?: unknown; mimeType?: unknown } | null | undefined;
		if (!b || typeof b !== "object" || b.type !== "image") return block;
		changed = true;
		return {
			type: "image",
			mimeType: typeof b.mimeType === "string" ? b.mimeType : "image/*",
			bytes: typeof b.data === "string" ? Math.floor((b.data.length * 3) / 4) : 0,
			omitted: true,
		};
	});
	if (!changed) return evt;
	return { ...evt, result: { ...(result as object), content } };
}
