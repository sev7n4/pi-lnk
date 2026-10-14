/**
 * view_canvas_media（P0 感知闭环，spec 2026-10-14-view-canvas-media-design.md §2）：
 * 按需把画布/侧栏图片的像素以 ImageContent 回流 tool result。
 * 来源优先级：node_id > url > tc.focusNodeId。复用 image-refine 的 fetchImageAsBlock
 * （2MB 上限、mime 白名单、fail-soft）；全部失败路径 ok:false 文本，不抛错。
 * 文本 JSON 携带 canvasNode 锚：T2 降级占位（payload-images.labelFor）据此生成可恢复提示。
 */
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import type { NestClient } from "./nest-client.js";
import { fetchImageAsBlock } from "./image-refine.js";

type ViewResult = {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	details: undefined;
};

function viewResult(payload: Record<string, unknown>): ViewResult {
	return { content: [{ type: "text", text: JSON.stringify(payload) }], details: undefined };
}

const NON_IMAGE_TYPES = new Set(["video", "audio", "text", "prompt"]);

export function createViewCanvasMediaTools(
	client: NestClient,
	deps: { fetchImpl?: typeof fetch } = {},
): LnkpiTool[] {
	return [
		{
			tier: "read" as const,
			name: "view_canvas_media",
			label: "查看图片内容",
			description:
				"View the actual pixels of an image (canvas node or media url). Use whenever the user asks about an image's visual content, references an image node, or a context placeholder says an image was removed from context. Params: node_id (canvas node, falls back to the current focus node) or url (direct media url, e.g. from a sidebar attachment). Returns the image itself in the result.",
			parameters: Type.Object({
				node_id: Type.Optional(
					Type.String({
						description:
							"Canvas image node id (e.g. n_abc123). Omit both params to use the current focus node.",
					}),
				),
				url: Type.Optional(
					Type.String({
						description:
							"Direct image url (e.g. from a sidebar attachment). Use when no node id is known.",
					}),
				),
			}),
			execute: async (
				_id,
				p: { node_id?: string; url?: string },
				_u,
				tc: LnkpiToolContext,
			): Promise<ViewResult> => {
				// 来源优先级（M-1，spec §2 权威口径）：node_id > url > focusNodeId——
				// 显式给了 url 时不再回落焦点节点，避免焦点为非图片节点误报。
				const explicitNodeId = (p?.node_id ?? "").trim();
				const explicitUrl = (p?.url ?? "").trim();
				const nodeId = explicitNodeId || (explicitUrl ? "" : (tc?.focusNodeId ?? "").trim());
				let url = explicitUrl;
				let canvasNode: string | undefined;
				if (nodeId) {
					let node: { type?: unknown; data?: { url?: unknown } } | null;
					try {
						node = (await client.post("/agent/internal/get-node", {
							sessionId: tc.sessionId,
							nodeId,
						})) as { type?: unknown; data?: { url?: unknown } } | null;
					} catch (err) {
						return viewResult({
							ok: false,
							error: `节点 ${nodeId} 不存在或不可读: ${err instanceof Error ? err.message : String(err)}`,
						});
					}
					const t = String(node?.type ?? "");
					if (NON_IMAGE_TYPES.has(t)) {
						return viewResult({
							ok: false,
							error: `节点 ${nodeId} 是 ${t} 节点，本工具仅支持图片（image/mediaInput）`,
						});
					}
					url = String(node?.data?.url ?? "").trim();
					if (!url) {
						return viewResult({ ok: false, error: `节点 ${nodeId} 没有图片 url（可能尚未生成完成）` });
					}
					canvasNode = nodeId;
				}
				if (!url) {
					return viewResult({
						ok: false,
						error: "缺少图片来源：请传 node_id 或 url；可先 get_canvas_summary / get_node 找到目标节点 id",
					});
				}
				const fetched = await fetchImageAsBlock(url, { fetchImpl: deps.fetchImpl });
				if (!fetched.ok) {
					const reasonText: Record<string, string> = {
						"empty-url": "图片 url 为空",
						timeout: "图片下载超时",
						network: "图片下载网络失败",
						http: "图片 url 返回非 200（可能已过期）",
						mime: "该 url 不是 png/jpeg/webp 图片",
						"too-large": "图片超过 2MB 上限",
					};
					return viewResult({
						ok: false,
						error: `取图失败（${reasonText[fetched.reason] ?? fetched.reason}）: ${url}`,
					});
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								ok: true,
								data: { ...(canvasNode ? { canvasNode } : {}), url },
							}),
						},
						fetched.block satisfies { type: "image"; data: string; mimeType: string },
					],
					details: undefined,
				};
			},
		},
	];
}
