/**
 * read_media（VISP S-7 恢复路径，spec 2026-11-05-agent-canvas-visual-perception-design.md §2.1）：
 * 直注失败/事后回看时把用户附件像素以 image block 回流 tool result。
 * ref（侧栏 I{n} 标记）在工具侧用 tc.attachments 本地解析为 url；取图走 Nest
 * /agent/internal/read-media（唯一取图点，本地盘直读）——pod 对宿主 IP hairpin
 * 不可达，禁止在 pod 侧 fetch。分工（R-V9）：画布节点走 view_canvas_media。
 */
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import type { NestClient } from "./nest-client.js";

/**
 * ⚠️ 契约镜像（同 `canvas-write.contract-mirror.test.ts` 先例）：与 packages/shared 的
 * `resolveSidebarRef` 逐语义一致（pi-runtime tsconfig=NodeNext 无法直引 shared 源码）。
 * shared 侧 `sidebarAttachments.test.ts` 与本侧 `read-media.contract-mirror.test.ts`
 * 用同一组 fixture 锁双向同源；改任一侧必须同步另一侧。
 */
export function resolveSidebarRefLocal(
	attachments: Array<{ url?: string; mediaType?: string }>,
	ref: string,
): string | null {
	const normalized = (ref ?? "").trim().toUpperCase();
	const keys: string[] = [];
	let n = 0;
	const images: Array<{ url?: string }> = [];
	for (const item of attachments) {
		if ((item?.mediaType ?? "").trim().toLowerCase() !== "image") continue;
		n += 1;
		keys.push(`I${n}`);
		images.push(item);
	}
	const idx = keys.indexOf(normalized);
	if (idx < 0) return null;
	const url = (images[idx]?.url ?? "").trim();
	return url || null;
}

type ReadMediaResult =
	| { ok: true; base64: string; mimeType: string; fileName: string; downscaled: boolean }
	| { ok: false; error: string };

type ReadResult = {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	details: undefined;
};

function readResult(payload: Record<string, unknown>): ReadResult {
	return { content: [{ type: "text", text: JSON.stringify(payload) }], details: undefined };
}

export function createReadMediaTools(client: NestClient): LnkpiTool[] {
	return [
		{
			tier: "read" as const,
			name: "read_media",
			label: "读取参考原图",
			description:
				"Fetch the actual pixels of a user-uploaded attachment (sidebar reference) as an image. Use when a placeholder says the original image was not injected into context (recovery path), or when you need to re-examine an uploaded image. Params: ref (sidebar marker like I1, resolved from this turn's attachments) or url (direct /api/uploads/ url). For canvas nodes use view_canvas_media instead.",
			parameters: Type.Object({
				ref: Type.Optional(
					Type.String({
						description:
							"Sidebar image marker from 侧栏参考素材 block, e.g. I1. Resolved locally from this turn's attachments.",
					}),
				),
				url: Type.Optional(
					Type.String({
						description: "Direct /api/uploads/… url (e.g. from the sidebar block's url= field).",
					}),
				),
			}),
			execute: async (
				_id,
				p: { ref?: string; url?: string },
				_u,
				tc: LnkpiToolContext,
			): Promise<ReadResult> => {
				const explicitUrl = (p?.url ?? "").trim();
				let url = explicitUrl;
				if (!url) {
					const ref = (p?.ref ?? "").trim();
					if (!ref) {
						return readResult({ ok: false, error: "缺少参数：ref（如 I1）或 url 二选一" });
					}
					url = resolveSidebarRefLocal(tc?.attachments ?? [], ref) ?? "";
					if (!url) {
						return readResult({
							ok: false,
							error: `ref ${ref} 无法解析为本轮图片附件（仅图片标记可解析、需在侧栏素材列表中）。文本/视频素材不适用本工具；画布节点请用 view_canvas_media。`,
						});
					}
				}
				let data: ReadMediaResult;
				try {
					data = (await client.post("/agent/internal/read-media", { url })) as ReadMediaResult;
				} catch (err) {
					return readResult({
						ok: false,
						error: `取图服务不可达: ${err instanceof Error ? err.message : String(err)}`,
					});
				}
				if (!data?.ok) {
					return readResult({ ok: false, error: data?.error ?? "取图失败" });
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								ok: true,
								fileName: data.fileName,
								mimeType: data.mimeType,
								downscaled: data.downscaled,
								note: "以下为原图像素（超 2MB 已自动缩图）",
							}),
						},
						{ type: "image", data: data.base64, mimeType: data.mimeType },
					],
					details: undefined,
				};
			},
		},
	];
}
