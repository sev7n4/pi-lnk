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

/**
 * 反哺抑制的**可观测钩子**（spec §9：污染记忆数此前完全不可观测）。
 *
 * 刻意在此声明**结构接口**而不是 `import type { Metrics } from "../metrics.js"`：
 * 具体指标（`pi_runtime_memory_suppressed_total`）定义在
 * `services/pi-runtime/src/metrics.ts`，那条线归指标治理窗口——本模块只声明
 * 「标记一条记忆时要通知谁」。`Metrics` 实例结构性满足它：metrics 侧补一个
 * `observeMemorySuppressed(): void` 即可，**本模块不需要为接通它改一行**。
 */
export interface SuppressionObserver {
	observeMemorySuppressed(): void;
}

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
	/** Phase3 D：同主题存在更新版本时为 true（旧版本仍返回，数据级自曝）。 */
	superseded?: boolean;
}

/**
 * 反哺抑制表（spec 2026-10-04-prompt-engineering §13.3 第3 条，M6a）：记忆 id → 抑制原因。
 *
 * 为什么需要它：记忆层是**每轮自动注入**（`agent.service.ts` 拼 memoryBlock，scope:'any'，
 * 不经模型调用），且**没有 TTL、没有去重、没有删除**——即记忆池只增不减。
 * 一条反复把模型带偏的记忆（最典型：别的项目的角色设定被当成本画布的当前观察结果）
 * 会**每轮**重新污染 system prompt，而模型看不见「这条已经被证明有害」。
 * 抑制是当前唯一能在不删库的前提下止血的手段：污染仍在池里，但不再进上下文。
 *
 * 为什么是**进程内态**而不是落DB：
 *   - 抑制是**临时止血**不是永久删除。落库意味着「判过一次就永远判死」，
 *     而抑制判据（模型是否又被带偏）会随提示词/模型升级而变化，落库的旧判据会变成陈年误伤。
 *   - 重启后重新观察再决定要不要再抑制，符合「反复致错才算污染」的判据——
 *     一次性失误不该被永久记账。
 * 代价是重启后抑制失效（首轮会重新注入一次）。这个代价比「误删一条好记忆」小得多，故刻意接受。
 *
 * 刻意**不做**的：不给recall_memory 加「删除记忆」能力。删除是持久化操作、
 * 不可逆，且需要用户确认语义；抑制是进程内、可自动失效的，两者的风险量级不同。
 * 晋升（把反复出现的记忆升级成全局规则）是 M6b，排在本次之后——见规格 §13.3 的顺序论证。
 *
 * ⚠️ 上段「不做删除」已被 Phase 3 F **部分解禁**（spec
 * docs/superpowers/specs/2026-10-08-pilnk-memory-product-adoption-scope.md §5 F）：
 * 独立的 `delete_memory` 工具（tier=destructive，挂 before_tool 审批补回「用户确认语义」）
 * 现已存在——但它与 recall_memory **解耦**（不挂在 recall 上），且定位是「用户明确要求
 * 忘记某事实」；「事实只是变了」仍应优先 save_memory 改写。抑制（进程内、可自动失效）
 * 与删除（持久、不可逆）的风险分界不变。
 */
const SUPPRESSED_MEMORY_IDS = new Map<string, string>();

/** 该记忆是否已被反哺抑制。`id` 缺失时**调用方必须 fail-open 保留条目**，不要传空串进来。 */
export function isSuppressed(memoryId: string): boolean {
	return SUPPRESSED_MEMORY_IDS.has(memoryId);
}

/**
 * 标记一条记忆为「反复致错」，后续召回/注入时剔除。
 *
 * @param observer 可选。传了就顺带打点，让「污染记忆数」可观测（spec §9 指出该指标此前完全不可观测）。
 *   刻意做成可选而非必填：本函数是纯进程内记账，不该因为「拿不到指标实例」而无法调用。
 *   重复标记**幂等**（不重复计数）——指标语义是「被抑制的记忆条数」，不是「标记调用次数」，
 *   否则一次误重试就会把污染数刷大，排障时反而看不出真实条数。
 *
 * ⚠️ **当前状态：有代码、无效果。** 本函数**没有任何生产调用方**（已全仓 python os.walk 复核，
 *   非 git grep——本仓 git grep 会静默失败）。所以：
 *   - `SUPPRESSED_MEMORY_IDS` 在生产里恒为空 ⇒ `recall_memory` 的剔除**永不生效**；
 *   - 指标 `pi_runtime_memory_suppressed_total` 在生产里**恒为 0**，**这是预期状态**，不是故障。
 *   过滤逻辑本身经测试验证正确（见 memory.test.ts），缺的只是「谁来标记」。
 *   标记入口归M6b：它要决定抑制决策归谁持有、以及怎么广播到本进程
 *   （本表是进程内态，与 Nest 侧那份**不自动同步**）。
 *   ⚠️ 因此看到指标恒 0 时**不要**误判为「没有污染」——它只说明标记链路尚未接通。
 *   本仓不为此加临时标记入口（挂个测试专用 API 到运行时路径上），
 *   那是给生产加一个没人用的开关，比留空更糟。
 */
export function markSuppressed(memoryId: string, reason: string, observer?: SuppressionObserver): void {
	if (SUPPRESSED_MEMORY_IDS.has(memoryId)) return;
	SUPPRESSED_MEMORY_IDS.set(memoryId, reason);
	observer?.observeMemorySuppressed();
}

/**
 * 剔除被抑制的记忆。**id 缺失时保留条目**（fail-open）。
 *
 * 为什么 id 缺失就不删：抑制判据是「这条记忆的 id 被证明有害」，没有 id 就无法证明
 * 「这条」就是那条。此时删它等于凭内容猜——而记忆内容恰恰是不可信输入（可能来自跨画布污染）。
 * 误删一条好记忆的代价（用户丢失真实偏好/项目事实，且**无自愈**：无 TTL、无删除、无提示）
 * 明显高于漏删一条坏记忆的代价（多污染一轮，下次抑制判据仍会命中它）。
 * 代价不对称，所以方向必须倒向保留。
 */
function dropSuppressed(items: MemoryItem[]): MemoryItem[] {
	return items.filter((it) => !it.id || !isSuppressed(it.id));
}

/**
 * 仅供测试：把剔除判据单独暴露出来，使「fail-open」这条不变量能被**真正证伪**。
 *
 * 为什么需要它（一次假绿的教训）：经recall_memory 的端到端断言无法区分
 * 「`!it.id ||`短路生效」与「短路被写掉」——无 id 条目在任何 id 键的 Map 里都匹配不上，
 * 两种实现都会保留它，测试恒绿。直接对判据函数做断言，才能让「按内容误剔除」这类
 * 真实退化转红。生产代码**不调用**它，保留导出仅供 tools/memory.test.ts。
 */
export function dropSuppressedForTest(items: MemoryItem[]): MemoryItem[] {
	return dropSuppressed(items);
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

/**
 * Phase3 D（spec 2026-10-08-pilnk-memory-product-adoption-scope.md §5 D）：
 * 同主题冲突的数据级自曝。与 CROSS_CANVAS_NOTICE **分键**（supersededNotice），
 * 两者可同时出现互不覆盖。
 */
const SUPERSEDED_NOTICE =
	"标 superseded:true 的条目是同主题的**旧版本**，已被更新的记忆取代；" +
	"请以未标记 superseded 的最新条目为准，不要把旧版本当作当前事实。";

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
				// 画布 id **只认 trustedCanvasSessionId**（终审 I-3）：
				// `tc.sessionId` 在 canvasSessionId 缺失时会回落成 pi 会话键（`entry.canvasSessionId ?? key`），
				// 拿它写入会把记忆挂到一个不存在的 Session 上——召回时 where永远匹配不到，
				// 记忆静默消失（比写成跨会话更难发现）。宁可降级成 user（可见）也不挂空归属。
				// scope='user' 时同样不带 sessionId：跨会话记忆不该挂任何画布。
				const sessionId = scope === "user" ? undefined : tc.trustedCanvasSessionId;
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
				"current screen, image or canvas. superseded:true means a NEWER memory about the same topic " +
				"exists in the results — trust the un-flagged one, not the superseded one. Pass scope:'canvas' to " +
				"search only this canvas, scope:'user' for cross-canvas facts only. Omit query to list the most " +
				"recent memories; pass a query to match as a case-insensitive substring (only your most recent " +
				"200 memories are scanned).",
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
					// 同save：只用可信画布 id，否则 Nest 算出来的 crossCanvas 是拿pi 键比出来的假值。
					// scope 缺省 'any'：跨画布条目**不静默丢弃**（模型有时确实需要知道用户另有项目），
					// 但必须带 crossCanvas 标记自曝归属。
					...(tc.trustedCanvasSessionId ? { sessionId: tc.trustedCanvasSessionId } : {}),
					scope: p.scope ?? "any",
				})) as { items?: MemoryItem[]; truncated?: boolean } | null | undefined;
				const items = Array.isArray(data?.items) ? data.items : [];
				// 剔除**必须**发生在下面 crossCanvas / note 计算之前：
				// 这两个都基于 items 派生。若先算crossCanvas 再剔，payload 会出现
				// 「items 里没有那条了，但 crossCanvasCount 仍算它、notice 仍在替它警示」的错位——
				// 模型收到一条指向不存在条目的警示，且这种错位在数据上完全看不出来。
				const kept = dropSuppressed(items);
				const crossCanvas = kept.filter((i) => i?.crossCanvas === true);
				// Phase3 D：同主题旧版本计数与提示（分键，不与 crossCanvas notice 互斥覆盖）
				const supersededCount = kept.filter((i) => i?.superseded === true).length;
				const note = kept.length
					? undefined
					: query
						? "没有相关记忆；可尝试其他关键词，或去掉 query 拉取最近记忆"
						: "没有相关记忆";
				return memoryResult({
					ok: true,
					// count 与 items 同源（kept），不是剔除前的原始条数：
					// 否则模型会看到 count=3 但 items 只有 2 条，自己都解释不清。
					count: kept.length,
					items: kept,
					...(data?.truncated ? { truncated: true } : {}),
					...(crossCanvas.length ? { crossCanvasCount: crossCanvas.length, notice: CROSS_CANVAS_NOTICE } : {}),
					...(supersededCount ? { supersededCount, supersededNotice: SUPERSEDED_NOTICE } : {}),
					...(note ? { note } : {}),
				});
			},
		},
		{
			tier: "destructive" as const,
			name: "delete_memory",
			label: "删除记忆",
			description:
				"Permanently DELETE one memory by its id (get ids from recall_memory results). " +
				"Irreversible. Use ONLY when the user explicitly asks to forget/delete that fact — " +
				"if the fact merely changed, prefer save_memory with the corrected content instead.",
			parameters: Type.Object({
				memoryId: Type.String({ description: "Memory id from recall_memory results" }),
			}),
			execute: async (_id, p: { memoryId: string }, _u, tc: LnkpiToolContext) => {
				if (!tc?.userId) throw new Error("delete_memory requires userId in toolContext");
				const memoryId = (p?.memoryId ?? "").trim();
				if (!memoryId) throw new Error("delete_memory requires a non-empty memoryId");
				try {
					const data = (await client.post("/agent/internal/memory-delete", {
						userId: tc.userId,
						memoryId,
					})) as { id?: string; scope?: string } | null | undefined;
					return memoryResult({
						ok: true,
						id: data?.id ?? memoryId,
						scope: data?.scope ?? null,
						note: "已永久删除该记忆",
					});
				} catch {
					// 不存在/不属于当前用户/服务暂不可用——统一降级为 ok:false，不向模型泄露细节
					return memoryResult({
						ok: false,
						id: memoryId,
						note: "删除失败：记忆不存在、不属于当前用户，或服务暂不可用",
					});
				}
			},
		},
	];
}
