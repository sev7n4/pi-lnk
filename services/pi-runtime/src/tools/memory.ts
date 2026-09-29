/**
 * P1 记忆层：save_memory / recall_memory。
 * spec: docs/superpowers/specs/2026-09-29-agent-tool-p1-read-document-memory-design.md
 * 跨会话记忆全落 Nest/DB（pi-runtime 无状态）；userId 只取 toolContext，fail-closed。
 */
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import type { NestClient } from "./nest-client.js";

export const MEMORY_CONTENT_MAX = 2000;
export const MEMORY_RECALL_DEFAULT = 10;
export const MEMORY_RECALL_MAX = 50;
const NOTE_PREVIEW = 50;

interface MemoryItem {
	id: string;
	content: string;
	createdAt: string;
}

function memoryResult(payload: Record<string, unknown>): { content: [{ type: "text"; text: string }]; details: undefined } {
	return { content: [{ type: "text", text: JSON.stringify(payload) }], details: undefined };
}

function clampLimit(raw: unknown): number {
	const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : MEMORY_RECALL_DEFAULT;
	return Math.min(Math.max(n, 1), MEMORY_RECALL_MAX);
}

export function buildMemoryTools(client: NestClient): LnkpiTool[] {
	return [
		{
			tier: "write_light" as const,
			name: "save_memory",
			label: "记住用户偏好",
			description:
				"Save a durable fact about the user (preferences, brand rules, recurring instructions) so it can be recalled in later sessions. Keep it to one self-contained sentence; max 2000 characters, longer input is truncated.",
			parameters: Type.Object({ content: Type.String({ description: "The fact to remember" }) }),
			execute: async (_id, p: { content: string }, _u, tc: LnkpiToolContext) => {
				if (!tc?.userId) throw new Error("save_memory requires userId in toolContext");
				const raw = (p?.content ?? "").trim();
				if (!raw) throw new Error("save_memory requires non-empty content");
				const content = raw.slice(0, MEMORY_CONTENT_MAX);
				const data = (await client.post("/agent/internal/memory-save", { userId: tc.userId, content })) as
					| { id?: string; createdAt?: string }
					| null
					| undefined;
				return memoryResult({
					ok: true,
					id: data?.id ?? null,
					createdAt: data?.createdAt ?? null,
					truncated: raw.length > MEMORY_CONTENT_MAX,
					note: "已记住：" + content.slice(0, NOTE_PREVIEW) + "（跨会话生效，用户可要求你随时回顾）",
				});
			},
		},
		{
			tier: "read" as const,
			name: "recall_memory",
			label: "回顾用户记忆",
			description:
				"Recall durable facts saved about the user. Omit query to list the most recent memories; pass a query to match as a case-insensitive substring (only your most recent 200 memories are scanned).",
			parameters: Type.Object({
				query: Type.Optional(Type.String({ description: "Keyword filter; omit for most recent memories" })),
				limit: Type.Optional(Type.Number({ description: "Max items (1-50, default 10)" })),
			}),
			execute: async (_id, p: { query?: string; limit?: number }, _u, tc: LnkpiToolContext) => {
				if (!tc?.userId) throw new Error("recall_memory requires userId in toolContext");
				const query = typeof p?.query === "string" && p.query.trim() ? p.query.trim() : undefined;
				const limit = clampLimit(p?.limit);
				const data = (await client.post("/agent/internal/memory-search", {
					userId: tc.userId,
					...(query ? { query } : {}),
					limit,
				})) as { items?: MemoryItem[] } | null | undefined;
				const items = Array.isArray(data?.items) ? data.items : [];
				const note = items.length
					? undefined
					: query
						? "没有相关记忆；可尝试其他关键词，或去掉 query 拉取最近记忆"
						: "没有相关记忆";
				return memoryResult({ ok: true, count: items.length, items, ...(note ? { note } : {}) });
			},
		},
	];
}
