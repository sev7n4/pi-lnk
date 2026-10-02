/**
 * 多模态直通（T1，宿主侧）：把 prompt 载荷顶层的 `images` 转成 vendor `lane.prompt`
 * 第二参需要的 ImageContent 形态。
 *
 * 设计要点（spec §3.1）：
 * - 空载荷（undefined / [] / 全空 data）→ undefined，调用方按「纯文本」发送，
 *   绝不发空 images 数组（Review Focus 1）。
 * - `name` 不进 ImageContent：文件名语义由 Nest 并入发送文本尾部的 `[I1=文件名]`
 *   标记承载（与 dynamicBlocks 的 I 编号同源，T4 摘要占位也从该标记恢复编号）。
 * - 纯函数、零 I/O、无随机/时间源。
 */

export interface DirectImage {
	name: string;
	mimeType: string;
	/** base64 编码的图片数据（不带 data: 前缀）。 */
	data: string;
}

export interface OutImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

/** 空白 data 视为无效图（Nest 侧读盘失败占位等异常形态的兜底）。 */
function isValid(img: DirectImage): boolean {
	return typeof img?.data === "string" && img.data.trim().length > 0;
}

export function toImageContents(images: readonly DirectImage[] | undefined): OutImageContent[] | undefined {
	if (!images || images.length === 0) return undefined;
	const out: OutImageContent[] = [];
	for (const img of images) {
		if (!isValid(img)) continue;
		out.push({ type: "image", data: img.data, mimeType: img.mimeType || "image/png" });
	}
	return out.length === 0 ? undefined : out;
}

/**
 * 图片 token 成本估算（成本闸门观测用）。无宽高信息，按 base64 长度兜底：
 * base64 解码字节数 ≈ len*3/4；千字节 × 565 tokens/KB（Claude 视觉经验值量级）。
 * 结果只用于 metrics 趋势观测，不参与任何预算决策。
 */
export function estimateImageTokens(data: string): number {
	const kb = Math.ceil((data.length * 3) / 4 / 1000);
	return kb * 565;
}
