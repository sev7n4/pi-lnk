/**
 * P1 感知层：read_document（tier=read）。
 * spec: docs/superpowers/specs/2026-09-29-agent-tool-p1-read-document-memory-design.md
 * 读 toolContext.attachments（Nest 每轮注入，session-manager.ts:193），零 Nest/DB 改动。
 * refKey 复刻 Nest sidebar-block.assignSidebarRefKeys（T/I/V/A 按 mediaType 计数）；
 * miss 返回附件清单让模型重查——不猜（spec §4 不猜判据）。
 */
import { Type } from "typebox";
import { truncateMarkdown } from "./web.js";
import type { LnkpiTool, LnkpiToolContext, SidebarAttachment } from "./types.js";

const REF_PREFIX: Record<string, string> = { text: "T", image: "I", video: "V", audio: "A" };
const PREVIEW_MAX = 80;

export interface ResolvedRef {
	index: number;
	key: string;
	item: SidebarAttachment;
}

/** refKey（T1/I1/V1/A1）或素材 id 精确匹配；未命中返回 null（调用方负责给清单，不猜）。 */
export function resolveRef(attachments: SidebarAttachment[], ref: string): ResolvedRef | null {
	const target = (ref ?? "").trim();
	if (!target) return null;
	const counters: Record<string, number> = {};
	let index = -1;
	for (const item of attachments ?? []) {
		const mediaType = (item?.mediaType ?? "").trim();
		const prefix = REF_PREFIX[mediaType];
		if (!prefix) continue;
		counters[mediaType] = (counters[mediaType] ?? 0) + 1;
		index += 1;
		const key = prefix + counters[mediaType];
		const id = (item as { id?: string }).id;
		if (key.toLowerCase() === target.toLowerCase() || (!!id && id === target)) {
			return { index, key, item };
		}
	}
	return null;
}

/** 附件清单（供 miss 时模型自纠）：ref + mediaType + 预览 80 字。 */
function describe(attachments: SidebarAttachment[]): Array<{ ref: string; mediaType: string; preview: string }> {
	const counters: Record<string, number> = {};
	const out: Array<{ ref: string; mediaType: string; preview: string }> = [];
	for (const item of attachments ?? []) {
		const mediaType = (item?.mediaType ?? "").trim();
		const prefix = REF_PREFIX[mediaType];
		if (!prefix) continue;
		counters[mediaType] = (counters[mediaType] ?? 0) + 1;
		const body = (item.text ?? item.url ?? "").trim();
		out.push({ ref: prefix + counters[mediaType], mediaType, preview: body.slice(0, PREVIEW_MAX) });
	}
	return out;
}

function readResult(payload: Record<string, unknown>): { content: [{ type: "text"; text: string }]; details: undefined } {
	return { content: [{ type: "text", text: JSON.stringify(payload) }], details: undefined };
}

export function buildReadDocumentTools(): LnkpiTool[] {
	return [
		{
			tier: "read" as const,
			name: "read_document",
			label: "读取参考素材全文",
			description:
				"Read the full text of a sidebar reference attachment (text media only). Pass the ref key shown in the sidebar block (T1/I1/V1/A1) or the attachment id. Long documents return a 20000-char window plus next_start_index for continuation. On a miss the tool returns the attachment list instead of guessing.",
			parameters: Type.Object({
				ref: Type.String({ description: "Attachment ref key (e.g. T1) or attachment id" }),
				start_index: Type.Optional(Type.Number({ description: "Continuation offset (default 0)" })),
			}),
			execute: async (_id, p: { ref: string; start_index?: number }, _u, tc: LnkpiToolContext) => {
				// harness 不做 schema 校验，约束在此兜底
				if (!p || typeof p.ref !== "string" || !p.ref.trim()) {
					throw new Error("read_document requires ref (attachment ref key like T1, or attachment id)");
				}
				const attachments = tc?.attachments ?? [];
				if (!attachments.length) {
					return readResult({ ok: false, error: "本会话没有侧栏参考素材", attachments: [] });
				}
				const hit = resolveRef(attachments, p.ref);
				if (!hit) {
					return readResult({ ok: false, error: "ref " + p.ref + " 不存在", attachments: describe(attachments) });
				}
				if (hit.item.mediaType !== "text") {
					return readResult({
						ok: false,
						error: hit.key + " 是 " + hit.item.mediaType + " 素材，read_document 仅支持文本素材；图片素材已随对话注入视觉解析",
					});
				}
				const body = (hit.item.text ?? "").trim();
				if (!body) {
					return readResult({ ok: false, error: hit.key + " 文本为空", ref: hit.key });
				}
				const rawStart = typeof p.start_index === "number" && Number.isFinite(p.start_index) ? Math.floor(p.start_index) : 0;
				const start = Math.max(0, Math.min(rawStart, body.length));
				const win = truncateMarkdown(body, start);
				return readResult({
					ok: true,
					ref: hit.key,
					text: win.text,
					start_index: start,
					next_start_index: win.next,
					total_length: win.total,
				});
			},
		},
	];
}
