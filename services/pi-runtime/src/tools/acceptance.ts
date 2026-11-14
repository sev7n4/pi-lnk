/** C-2a/C-2b · acceptance 声明式判据（spec 2026-11-14-c2a-*-design.md / 2026-11-14-c2b-*-design.md）。
 *
 * 一套 DSL、两个消费方：C-1 eval（离线）与 todo_write.execute（生产实时）共用
 * `canvas-judge.ts` 的 `judgeCanvasCounts`。本模块只做读取、判读与判定，不写任何状态
 * ——「拒绝」的零副作用由 todo.ts 保证。
 * ⚠️ NestClient.post 返回的已是 payload.data；`status` 是自由字符串（nodeStatus 非枚举）。
 */
import { Type } from "typebox";
import { readRecord } from "../hook-contract.js";
import { judgeCanvasCounts, type CanvasSnapshot, type CanvasCountsExpect } from "../canvas-judge.js";

/** 挂载在 todo item 上的验收声明。只注册已实现校验的枚举值（防「写了不校验」的伪验收）。
 *  `noOverlap` / `generationSucceeded` / `user_confirm` 代码零实现 ⇒ 本刀不注册。 */
const rangeSchema = Type.Object(
	{
		min: Type.Optional(Type.Number({ description: "下界（闭区间）" })),
		max: Type.Optional(Type.Number({ description: "上界（闭区间）；必须 >= min" })),
	},
	{ description: "节点数区间" },
);

export const acceptanceSchema = Type.Object(
	{
		kind: Type.Union(
			[
				Type.Literal("generation", { description: "生成类收尾验收：本会话最近一次生成有证据（C-2a）" }),
				Type.Literal("canvas_state", { description: "画布终态验收：节点数/按类型计数（C-2b）" }),
			],
			{ description: "只允许两类可机检 oracle" },
		),
		generation: Type.Optional(
			Type.Object(
				{
					requireSucceeded: Type.Optional(
						Type.Boolean({
							description: "true=要求最近生成 status=succeeded；缺省=仅要求已提交生成记录（弱判据）",
						}),
					),
				},
				{ description: "生成判据（缺省=submitted 级）；仅 kind=generation 时可给" },
			),
		),
		canvasState: Type.Optional(
			Type.Object(
				{
					nodeCount: Type.Optional(rangeSchema),
					nodeTypeCounts: Type.Optional(
						Type.Object(
							{
								image: Type.Optional(rangeSchema),
								text: Type.Optional(rangeSchema),
								video: Type.Optional(rangeSchema),
							},
							{ description: "按节点类型计数（与 C-1 §8.3 同款枚举）" },
						),
					),
				},
				{ description: "画布判据（至少一谓词）；仅 kind=canvas_state 时可给" },
			),
		),
	},
	{ description: "可选。仅当本项标 completed 时生效；不接受自由文本/主观描述" },
);

export interface TodoAcceptance {
	kind: "generation" | "canvas_state";
	generation?: { requireSucceeded?: boolean };
	canvasState?: CanvasCountsExpect;
}

export interface GenerationLatest {
	id: string;
	status: string;
	createdAt?: string;
}

/** 归一化后的验收需求。C-2a 的 generation 需求是 `{}` / `{requireSucceeded:true}`
 *  —— ⚠️ **DSL 里 kind 始终必填**（C-2a 原版即要求 `kind:"generation"`，缺失/未知一律拒绝；
 *  见 acceptance.test.ts 的「kind 缺失/未知 ⇒ 非法」守卫）。这里说的是**归一化结果**不带
 *  kind 字段，由调用方 `requirement.kind ?? "generation"` 兜底，保持 C-2a 契约逐字节兼容；
 *  不要据此推断「模型可以省略 kind」。C-2b 的 canvas_state 显式带 kind + canvasState
 *  （§14.4 防游戏化：至少一谓词）。 */
export type AcceptanceRequirement = {
	kind?: "generation" | "canvas_state";
	requireSucceeded?: boolean;
	canvasState?: CanvasCountsExpect;
};
export type AcceptanceOutcome = "declared" | "pass" | "fail_closed" | "fail_open";

export type AcceptanceParse =
	| { ok: true; requirement: AcceptanceRequirement }
	| { ok: false; reason: string };

export type OracleResult =
	| { ok: true; latest?: GenerationLatest }
	| { ok: false; reason: string };

export type CanvasOracleResult =
	| { ok: true; canvas: CanvasSnapshot }
	| { ok: false; reason: string };

export interface GenerationOracle {
	inspect(input: { sessionId: string; userId: string }): Promise<OracleResult>;
}

export interface CanvasOracle {
	inspect(input: { sessionId: string }): Promise<CanvasOracleResult>;
}

/** kill switch：与 isTodoToolEnabled 同款（§14.5 写入率趋零止损，一行 env 回滚）。 */
export function isAcceptanceEnabled(): boolean {
	return process.env.PI_RUNTIME_ACCEPTANCE !== "off";
}

const CANVAS_TYPES = new Set(["image", "text", "video"]);

/** 守卫式读取区间对象（min/max 白名单、必须是有限数、min<=max、至少一边界）。
 *  返回重建后的干净对象，避免把模型给的多余字段带进判据。 */
function parseRange(
	value: unknown,
	path: string,
): { ok: true; range: { min?: number; max?: number } } | { ok: false; reason: string } {
	const rec = readRecord(value, path);
	if (!rec.ok) return rec;
	for (const key of Object.keys(rec.value)) {
		if (key !== "min" && key !== "max") {
			return { ok: false, reason: `${path}.${key}: 不允许的字段` };
		}
	}
	const range: { min?: number; max?: number } = {};
	for (const key of ["min", "max"] as const) {
		const raw = rec.value[key];
		if (raw === undefined) continue;
		if (typeof raw !== "number" || !Number.isFinite(raw)) {
			return { ok: false, reason: `${path}.${key}: 必须是有限数` };
		}
		range[key] = raw;
	}
	if (range.min === undefined && range.max === undefined) {
		return { ok: false, reason: `${path}: 必须至少给 min 或 max` };
	}
	if (range.min !== undefined && range.max !== undefined && range.min > range.max) {
		return { ok: false, reason: `${path}: min(${range.min}) 不得大于 max(${range.max})` };
	}
	return { ok: true, range };
}

/** 守卫式解析：kind 缺失/未知、载荷与 kind 不匹配、自由文本字段、canvas_state 无谓词
 *  一律判非法。schema 层（TypeBox）由 harness 拦一层，本函数是模型不遵守 schema 时的第二层。 */
export function parseAcceptance(value: unknown): AcceptanceParse {
	const rec = readRecord(value, "acceptance");
	if (!rec.ok) return rec;
	const allowed = new Set(["kind", "generation", "canvasState"]);
	for (const key of Object.keys(rec.value)) {
		if (!allowed.has(key)) {
			return { ok: false, reason: `acceptance.${key}: 不允许的字段（自由文本禁入）` };
		}
	}
	const kind = rec.value.kind;
	if (kind === "generation") {
		if (rec.value.canvasState !== undefined) {
			return { ok: false, reason: "acceptance.canvasState 只能用于 kind=canvas_state" };
		}
		const gen = rec.value.generation;
		if (gen === undefined) return { ok: true, requirement: {} };
		const genRec = readRecord(gen, "acceptance.generation");
		if (!genRec.ok) return genRec;
		for (const key of Object.keys(genRec.value)) {
			if (key !== "requireSucceeded") {
				return { ok: false, reason: `acceptance.generation.${key}: 不允许的字段` };
			}
		}
		const raw = genRec.value.requireSucceeded;
		if (raw !== undefined && typeof raw !== "boolean") {
			return { ok: false, reason: "acceptance.generation.requireSucceeded: 必须是 boolean" };
		}
		return { ok: true, requirement: raw === true ? { requireSucceeded: true } : {} };
	}
	if (kind === "canvas_state") {
		if (rec.value.generation !== undefined) {
			return { ok: false, reason: "acceptance.generation 只能用于 kind=generation" };
		}
		const raw = rec.value.canvasState;
		if (raw === undefined) {
			return { ok: false, reason: "acceptance.canvasState: kind=canvas_state 时必须给画布判据" };
		}
		const csRec = readRecord(raw, "acceptance.canvasState");
		if (!csRec.ok) return csRec;
		for (const key of Object.keys(csRec.value)) {
			if (key !== "nodeCount" && key !== "nodeTypeCounts") {
				return { ok: false, reason: `acceptance.canvasState.${key}: 不允许的字段` };
			}
		}
		const canvasState: CanvasCountsExpect = {};
		if (csRec.value.nodeCount !== undefined) {
			const r = parseRange(csRec.value.nodeCount, "acceptance.canvasState.nodeCount");
			if (!r.ok) return r;
			canvasState.nodeCount = r.range;
		}
		if (csRec.value.nodeTypeCounts !== undefined) {
			const typesRec = readRecord(csRec.value.nodeTypeCounts, "acceptance.canvasState.nodeTypeCounts");
			if (!typesRec.ok) return typesRec;
			const counts: NonNullable<CanvasCountsExpect["nodeTypeCounts"]> = {};
			for (const [type, rangeRaw] of Object.entries(typesRec.value)) {
				if (!CANVAS_TYPES.has(type)) {
					return { ok: false, reason: `acceptance.canvasState.nodeTypeCounts.${type}: 未注册的节点类型` };
				}
				const r = parseRange(rangeRaw, `acceptance.canvasState.nodeTypeCounts.${type}`);
				if (!r.ok) return r;
				counts[type as keyof typeof counts] = r.range;
			}
			canvasState.nodeTypeCounts = counts;
		}
		// §14.4 防游戏化：canvas_state 至少一谓词（空对象等于「写了不校验」）
		if (canvasState.nodeCount === undefined && Object.keys(canvasState.nodeTypeCounts ?? {}).length === 0) {
			return { ok: false, reason: "acceptance.canvasState: 至少给一个谓词（nodeCount 或 nodeTypeCounts）" };
		}
		return { ok: true, requirement: { kind: "canvas_state", canvasState } };
	}
	return {
		ok: false,
		reason: `acceptance.kind 必须是 "generation" 或 "canvas_state"（实际：${String(kind)}）`,
	};
}

/** 会话级最新生成任务判据（§3 D2）：succeeded 级查 status，submitted 级查记录存在。 */
export function judgeGenerationAcceptance(
	latest: GenerationLatest | undefined,
	requirement: AcceptanceRequirement,
): { ok: true } | { ok: false; evidence: string } {
	const evidence = latest
		? `本会话最近生成任务 status=${latest.status}（id=${latest.id}）`
		: "本会话无生成记录";
	if (latest === undefined) return { ok: false, evidence };
	if (requirement.requireSucceeded === true && latest.status !== "succeeded") {
		return { ok: false, evidence };
	}
	return { ok: true };
}

/** C-2b：画布终态判据。复用与 C-1 eval 完全相同的 `judgeCanvasCounts`（§14.2 单一真相源）。 */
export function judgeCanvasAcceptance(
	canvas: CanvasSnapshot,
	expect: CanvasCountsExpect,
): { ok: true } | { ok: false; evidence: string } {
	const failures = judgeCanvasCounts(canvas, expect);
	if (failures.length === 0) return { ok: true };
	return {
		ok: false,
		evidence: `画布节点数=${canvas.nodeCount}、按类型=${JSON.stringify(canvas.typeCounts)}；${failures.join("；")}`,
	};
}

/** 窄面：只依赖 NestClient.post，测试可直接给对象字面量（无需类型强转）。 */
export interface OracleNestClient {
	post(path: string, body: unknown, opts?: { signal?: AbortSignal }): Promise<unknown>;
}

/** 生产 oracle：复用既有 list_generation_tasks 端点（sessionId + userId）。
 *  Nest 侧 studio.listGenerations 已按 createdAt desc 排序 ⇒ tasks[0] 即本会话最新。
 *  查询异常/形态不符统一转 ok:false，由调用方按 §14.3 fail-open 放行。 */
export function createNestGenerationOracle(client: OracleNestClient): GenerationOracle {
	return {
		async inspect(input: { sessionId: string; userId: string }): Promise<OracleResult> {
			try {
				const data: unknown = await client.post("/agent/internal/list-generation-tasks", {
					sessionId: input.sessionId,
					userId: input.userId,
				});
				const rec = readRecord(data, "list-generation-tasks.data");
				if (!rec.ok) return { ok: false, reason: rec.reason };
				const tasks = rec.value.tasks;
				if (!Array.isArray(tasks)) {
					return { ok: false, reason: "list-generation-tasks.data.tasks: 非数组" };
				}
				const first: unknown = tasks[0];
				if (first === undefined) return { ok: true };
				const frec = readRecord(first, "list-generation-tasks.data.tasks[0]");
				if (!frec.ok) return { ok: false, reason: frec.reason };
				const status = frec.value.status;
				if (typeof status !== "string" || status.length === 0) {
					return { ok: false, reason: "tasks[0].status: 缺失或非字符串" };
				}
				return {
					ok: true,
					latest: {
						id: typeof frec.value.id === "string" ? frec.value.id : "(unknown)",
						status,
						...(typeof frec.value.createdAt === "string"
							? { createdAt: frec.value.createdAt }
							: {}),
					},
				};
			} catch (error) {
				return { ok: false, reason: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

/** C-2b 生产画布 oracle：复用 `get-canvas-summary` 端点。
 *  ⭐ **不传 focusNodeId** —— Nest service 在「无焦点 / 画布 ≤30 / 焦点不存在」时全量返回，
 *  传了焦点会在大画布上按邻域过滤 ⇒ 节点计数失真（RUNBOOK §3.2 之外的第二个陷阱）。
 *  查询异常/形态不符统一转 ok:false ⇒ fail-open（§14.3）。 */
export function createNestCanvasOracle(client: OracleNestClient): CanvasOracle {
	return {
		async inspect(input: { sessionId: string }): Promise<CanvasOracleResult> {
			try {
				const data: unknown = await client.post("/agent/internal/get-canvas-summary", {
					sessionId: input.sessionId,
				});
				const rec = readRecord(data, "get-canvas-summary.data");
				if (!rec.ok) return { ok: false, reason: rec.reason };
				const nodes = rec.value.nodes;
				if (!Array.isArray(nodes)) {
					return { ok: false, reason: "get-canvas-summary.data.nodes: 非数组" };
				}
				const typeCounts: Record<string, number> = {};
				for (const node of nodes) {
					const nrec = readRecord(node, "get-canvas-summary.data.nodes[]");
					if (!nrec.ok) return { ok: false, reason: nrec.reason };
					const type = nrec.value.type;
					if (typeof type !== "string" || type.length === 0) {
						return { ok: false, reason: "nodes[].type: 缺失或非字符串" };
					}
					typeCounts[type] = (typeCounts[type] ?? 0) + 1;
				}
				return { ok: true, canvas: { nodeCount: nodes.length, typeCounts } };
			} catch (error) {
				return { ok: false, reason: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}
