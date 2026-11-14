/** C-2a · acceptance 生成 oracle 子域（spec 2026-11-14-c2a-acceptance-generation-oracle-design.md）。
 *
 * 一套声明式判据、两个消费方：C-1 eval（离线）与 todo_write.execute（生产实时）。
 * 本模块只做读取、判读与判定，不写任何状态——「拒绝」的零副作用由 todo.ts 保证。
 * ⚠️ NestClient.post 返回的已是 payload.data；`status` 是自由字符串（nodeStatus 非枚举）。
 */
import { Type } from "typebox";
import { readRecord } from "../hook-contract.js";

/** 挂载在 todo item 上的验收声明。C-2a 只注册已实现校验的枚举值（防「写了不校验」）。 */
export const acceptanceSchema = Type.Object(
	{
		kind: Type.Literal("generation", {
			description: "生成类收尾验收：要求本会话最近一次生成有证据（C-2a 唯一合法值）",
		}),
		generation: Type.Optional(
			Type.Object(
				{
					requireSucceeded: Type.Optional(
						Type.Boolean({
							description: "true=要求最近生成 status=succeeded；缺省=仅要求已提交生成记录（弱判据）",
						}),
					),
				},
				{ description: "生成判据（缺省=submitted 级）" },
			),
		),
	},
	{ description: "可选。仅当本项标 completed 时生效；不接受自由文本/主观描述" },
);

export interface TodoAcceptance {
	kind: "generation";
	generation?: { requireSucceeded?: boolean };
}

export interface GenerationLatest {
	id: string;
	status: string;
	createdAt?: string;
}

export type AcceptanceRequirement = { requireSucceeded?: boolean };
export type AcceptanceOutcome = "declared" | "pass" | "fail_closed" | "fail_open";

export type AcceptanceParse =
	| { ok: true; requirement: AcceptanceRequirement }
	| { ok: false; reason: string };

export type OracleResult =
	| { ok: true; latest?: GenerationLatest }
	| { ok: false; reason: string };

export interface GenerationOracle {
	inspect(input: { sessionId: string; userId: string }): Promise<OracleResult>;
}

/** kill switch：与 isTodoToolEnabled 同款（§14.5 写入率趋零止损，一行 env 回滚）。 */
export function isAcceptanceEnabled(): boolean {
	return process.env.PI_RUNTIME_ACCEPTANCE !== "off";
}

/** 守卫式解析：kind 缺失/未知、generation 形态不符、自由文本字段一律判非法。
 *  schema 层（TypeBox）由 harness 拦一层，本函数是模型不遵守 schema 时的第二层。 */
export function parseAcceptance(value: unknown): AcceptanceParse {
	const rec = readRecord(value, "acceptance");
	if (!rec.ok) return rec;
	const allowed = new Set(["kind", "generation"]);
	for (const key of Object.keys(rec.value)) {
		if (!allowed.has(key)) {
			return { ok: false, reason: `acceptance.${key}: 不允许的字段（自由文本禁入）` };
		}
	}
	if (rec.value.kind !== "generation") {
		return {
			ok: false,
			reason: `acceptance.kind 必须是 "generation"（实际：${String(rec.value.kind)}）`,
		};
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

/** 生产 oracle：复用既有 list_generation_tasks 端点（sessionId + userId）。
 *  Nest 侧 studio.listGenerations 已按 createdAt desc 排序 ⇒ tasks[0] 即本会话最新。
 *  查询异常/形态不符统一转 ok:false，由调用方按 §14.3 fail-open 放行。 */
/** 窄面：只依赖 NestClient.post，测试可直接给对象字面量（无需类型强转）。 */
export interface OracleNestClient {
	post(path: string, body: unknown, opts?: { signal?: AbortSignal }): Promise<unknown>;
}

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
