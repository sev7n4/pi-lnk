/**
 * 压缩摘要图片占位（T4，spec §3.3）。
 *
 * B1 取证结论：vendor `before_compaction` hook 不能仅改写 messages（只能 decline 或整体
 * 替代压缩结果），宿主也没有 compaction 触发路径 → 宿主在 hook 内对 preparation 的消息
 * 副本做本模块的占位变换后，调用 vendor 导出的 `compact()` 自产摘要（见 session-manager
 * 注册处）。本模块只负责「含图消息 → 文本侧注」这一层纯变换。
 *
 * 侧注格式：`[图片 I{n}: {文件名} | {mimeType} | 来源见 dynamicBlocks，全文可用 read_document 取回]`
 * —— I 编号与文件名从同消息 text 尾部 `[I{n}=文件名]` 标记恢复（T1 Nest 侧埋点）；
 * 无标记 → `I?` 与「图片」。只变换喂给摘要模型的副本，不落 lane 历史。
 */

export interface SummaryMessage {
	role: string;
	content: string | Array<Record<string, unknown>>;
}

const readNote = "来源见 dynamicBlocks，全文可用 read_document 取回";

function annotateText(text: string, mimeType: string): string {
	const m = /\[I(\d+)=([^\]\s]+)\]/.exec(text);
	const id = m ? `I${m[1]}` : "I?";
	const name = m ? m[2] : "图片";
	return `[图片 ${id}: ${name} | ${mimeType} | ${readNote}]`;
}

/**
 * 对含 image part 的消息追加文本侧注（副本，不 mutate）。
 * - 无任何 image part → 返回 undefined（调用方零成本直通原 preparation）。
 * - content 为 string 或纯文本数组 → 原样保留（保持原引用）。
 */
export function annotateImagesForSummary(
	messages: readonly SummaryMessage[],
): SummaryMessage[] | undefined {
	let changed = false;
	const out = messages.map((msg) => {
		if (!Array.isArray(msg.content)) return msg;
		const hasImage = msg.content.some((p) => p?.type === "image");
		if (!hasImage) return msg;
		changed = true;
		const sideNotes = msg.content
			.filter((p) => p?.type === "image")
			.map((p) => annotateText(textOf(msg.content), typeof p.mimeType === "string" ? p.mimeType : "image/png"));
		const nextContent = [...msg.content];
		for (const note of sideNotes) nextContent.push({ type: "text", text: note });
		return { ...msg, content: nextContent };
	});
	return changed ? out : undefined;
}

/** 消息文本主体（多个 text part 拼接），用于恢复 [I{n}=文件名] 标记。 */
function textOf(content: Array<Record<string, unknown>>): string {
	return content
		.filter((p) => p?.type === "text" && typeof p.text === "string")
		.map((p) => p.text as string)
		.join("\n");
}
