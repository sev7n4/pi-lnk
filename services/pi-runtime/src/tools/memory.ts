/**
 * P1 记忆层：save_memory / recall_memory。
 * spec: docs/superpowers/specs/2026-09-29-agent-tool-p1-read-document-memory-design.md
 * 作用域隔离: docs/superpowers/specs/2026-10-03-agent-memory-scope-isolation-design.md
 *
 * 跨会话记忆全落 Nest/DB（pi-runtime 无状态）；userId 只取 toolContext，fail-closed。
 * 画布归属 sessionId 也只取 toolContext（画布会话 id，不是 pi 会话键），模型无法伪造。
 */
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import type { NestClient } from "./nest-client.js";

export const MEMORY_CONTENT_MAX = 2000;
export const MEMORY_RECALL_DEFAULT = 10;
export const MEMORY_RECALL_MAX = 50;
const NOTE_PREVIEW = 50;

/** 召回条目：归属三字段由 Nest 侧算好后随行返回（scope/sessionId/crossCanvas）。 */
interface MemoryItem {
	id: string;
	content: string;
	createdAt: string;
	scope?: string;
	sessionId?: string | null;
	crossCanvas?: boolean;
}

/**
 * 跨画布条目的固定警示，落在 **tool result 数据**里而不是只写进提示词。
 * 依据：2026-10-03 生产事故里，模型违反过 `SIDEBAR_VISION_FAIL_HINT`
 * 「用文字说明失败并询问用户」这类明确提示词规则；工具返回值是更难忽略的通道。
 */
const CROSS_CANVAS_NOTICE =
	"以上部分内容来自**另一个画布的记忆**，只可作为背景参考；" +
	"**不能**把它当作当前图片、当前截图或当前对话内容的观察结果。" +
	"若用户正在问「这张图/这个画面是什么」，请明确说明你无法直接查看图像内容并请用户描述，而不是用记忆去推断画面。";

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
			label: "记住偏好/项目知识",
			description:
				"Save a durable fact so it can be recalled later. Default scope is the CURRENT canvas only " +
				"(project knowledge, characters, decisions made in this canvas) — pass scope:'user' ONLY for " +
				"cross-canvas facts (brand rules, account credentials, delivery specs). " +
				"Keep it to one self-contained sentence; max 2000 characters, longer input is truncated.",
			parameters: Type.Object({
				content: Type.String({ description: "The fact to remember" }),
				scope: Type.Optional(
					Type.Union([Type.Literal("canvas"), Type.Literal("user")], {
						description: "canvas (default, this canvas only) | user (cross-canvas preferences/credentials)",
					}),
				),
			}),
			execute: async (_id, p: { content: string; scope?: "canvas" | "user" }, _u, tc: LnkpiToolContext) => {
				if (!tc?.userId) throw new Error("save_memory requires userId in toolContext");
				const raw = (p?.content ?? "").trim();
				if (!raw) throw new Error("save_memory requires non-empty content");
				const content = raw.slice(0, MEMORY_CONTENT_MAX);
				const scope = p.scope === "user" ? "user" : "canvas";
				// 画布 id 取自 toolContext（types.ts:39 注释：这是画布会话 id，不是 pi 会话键）。
				// scope='user' 时**不带** sessionId：跨会话记忆不该挂任何画布。
				const sessionId = scope === "user" ? undefined : tc.sessionId;
				const data = (await client.post("/agent/internal/memory-save", {
					userId: tc.userId,
					content,
					scope,
					...(sessionId ? { sessionId } : {}),
				})) as
					| { id?: string; createdAt?: string; scope?: string; sessionId?: string | null }
					| null
					| undefined;
				// note 必须描述**实际落库**的作用域：Nest 在拿不到画布归属时会降级成 user，
				// 此时若仍写「仅本画布」就是在对模型撒谎（与本次事故同类的误导）。
				const landed = data?.scope ?? scope;
				const note =
					landed === "user"
						? "已记住：" +
						  content.slice(0, NOTE_PREVIEW) +
						  (scope === "user" ? "（跨会话生效，用户可要求你随时回顾）" : "（未确定归属，按跨会话保存）")
						: "已记住：" + content.slice(0, NOTE_PREVIEW) + "（仅本画布）";
				return memoryResult({
					ok: true,
					id: data?.id ?? null,
					createdAt: data?.createdAt ?? null,
					scope: landed,
					truncated: raw.length > MEMORY_CONTENT_MAX,
					note,
				});
			},
		},
		{
			tier: "read" as const,
			name: "recall_memory",
			label: "回顾记忆",
			description:
				"Recall durable facts. Items carry scope/sessionId/crossCanvas: 'canvas' items belong to one " +
				"canvas, 'user' items are cross-canvas facts the user asked you to keep. crossCanvas:true means " +
				"the memory came from ANOTHER canvas — treat it as background only, NEVER as an observation of the " +
				"current screen, image or canvas. Pass scope:'canvas' to search only this canvas, scope:'user' for " +
				"cross-canvas facts only. Omit query to list the most recent memories; pass a query to match as a " +
				"case-insensitive substring (only your most recent 200 memories are scanned).",
			parameters: Type.Object({
				query: Type.Optional(Type.String({ description: "Keyword filter; omit for most recent memories" })),
				limit: Type.Optional(Type.Number({ description: "Max items (1-50, default 10)" })),
				scope: Type.Optional(
					Type.Union([Type.Literal("canvas"), Type.Literal("user"), Type.Literal("any")], {
						description: "any (default) | canvas (this canvas only) | user (cross-canvas facts only)",
					}),
				),
			}),
			execute: async (
				_id,
				p: { query?: string; limit?: number; scope?: "canvas" | "user" | "any" },
				_u,
				tc: LnkpiToolContext,
			) => {
				if (!tc?.userId) throw new Error("recall_memory requires userId in toolContext");
				const query = typeof p?.query === "string" && p.query.trim() ? p.query.trim() : undefined;
				const limit = clampLimit(p?.limit);
				const data = (await client.post("/agent/internal/memory-search", {
					userId: tc.userId,
					...(query ? { query } : {}),
					limit,
					// 画布 id 让 Nest 侧算 crossCanvas；scope 缺省 'any'：
					// 跨画布条目**不静默丢弃**（模型有时确实需要知道用户另有项目），
					// 但必须带 crossCanvas 标记自曝归属。
					...(tc.sessionId ? { sessionId: tc.sessionId } : {}),
					scope: p.scope ?? "any",
				})) as { items?: MemoryItem[] } | null | undefined;
				const items = Array.isArray(data?.items) ? data.items : [];
				const crossCanvas = items.filter((i) => i?.crossCanvas === true);
				const note = items.length
					? undefined
					: query
						? "没有相关记忆；可尝试其他关键词，或去掉 query 拉取最近记忆"
						: "没有相关记忆";
				return memoryResult({
					ok: true,
					count: items.length,
					items,
					...(crossCanvas.length ? { crossCanvasCount: crossCanvas.length, notice: CROSS_CANVAS_NOTICE } : {}),
					...(note ? { note } : {}),
				});
			},
		},
	];
}
