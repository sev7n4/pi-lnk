/**
 * C4 子代理三件套/白名单/并发闸/Coordinator
 * （spec docs/superpowers/specs/2026-10-10-c4-subagent-design.md §3.3/§3.4；
 *  D2 + non-block：2026-11-14-subagent-contract-d2-nonblock-design.md §6.2）。
 *
 * 三件套硬编码不可禁用（§3.4）：无 env、无 kill switch——它们是安全边界不是功能开关。
 * 白名单按「副作用面」三类划分（§3.3）：本地只读 + 网络出口（net-egress，裁决 8）进；
 * 状态写入 / 用户交互（ask_user）/ 自身（spawn_subagent，禁嵌套）排除。
 */
import { randomUUID } from "node:crypto";
import type { SubtaskLedger } from "./subtask-ledger.js";

export const SUBAGENT_TURN_BUDGET = 30;
export const SUBAGENT_TIMEOUT_MS = 5 * 60_000;
export const SUBAGENT_MAX_CONCURRENT = 2;
export const SUBAGENT_REPORT_MAX_CHARS = 20_000;

/**
 * 子代理工具白名单（spec §3.3）。名单每个名字由 gate/subagent.test.ts 的
 * 「幽灵工具」用例钉在真实注册面上——名单与注册面漂移时该测试先红。
 */
export const SUBAGENT_TOOL_WHITELIST: ReadonlySet<string> = new Set([
	"todo_write",
	// 本地只读（画布 / 生成 / 资产 / 模型 / 记忆读）
	"get_canvas_summary",
	"get_canvas_layout",
	"get_node",
	"list_generation_tasks",
	"get_generation_status",
	"get_generation_diagnostic",
	"list_generation_scenes",
	"list_user_assets",
	"list_model_options",
	"read_document",
	"recall_memory",
	// 网络出口（net-egress，裁决 8：宽派进白名单，护栏三层已成熟零新增）
	"web_search",
	"web_fetch",
]);

export function isSubagentTool(name: string): boolean {
	return SUBAGENT_TOOL_WHITELIST.has(name);
}

/** 全局并发信号量（跨会话共享；spec §3.4「第 3 个 spawn fail-soft 报错，不排队不挂起」）。 */
export class SubagentSlots {
	#active = 0;
	acquire(): boolean {
		if (this.#active >= SUBAGENT_MAX_CONCURRENT) return false;
		this.#active += 1;
		return true;
	}
	release(): void {
		this.#active = Math.max(0, this.#active - 1);
	}
	get active(): number {
		return this.#active;
	}
}

export type SubagentStatus = "completed" | "failed" | "timeout" | "budget_exceeded";

export interface SubagentOutcome {
	report: string;
	turns: number;
	durationMs: number;
	status: SubagentStatus;
	/** 刀B（spec 2026-11-14 §4.3）：报告原文超 SUBAGENT_REPORT_MAX_CHARS 被截尾时置 true；恰等长/未截不写字段。 */
	truncated?: boolean;
}

/** 刀B（§4.3）：截断唯一实现点——runSubagent 与测试共用；恰等长不置 truncated（JSON.stringify 丢 undefined = additive）。 */
export function applyReportTruncation(raw: string): { report: string; truncated?: boolean } {
	if (raw.length <= SUBAGENT_REPORT_MAX_CHARS) return { report: raw };
	return { report: raw.slice(0, SUBAGENT_REPORT_MAX_CHARS), truncated: true };
}

/** runSubagent 运行期可选项（评审 I2：主 run「停止」要能传播到子 run）。 */
export interface SubagentRunOpts {
	/** 外部取消信号（spawn 工具透传 chordCtx.abortSignal）。abort → cancel 子 run → status=failed。 */
	signal?: AbortSignal;
	/** 刀A（spec 2026-11-14 §6.2）：block（默认，同步等报告）/ background（立即返回 callId，后台跑，collect 取结果）。 */
	mode?: "block" | "background";
}

/** collect_subagent_result 的返回形状（spec §6.2/§6.5）。 */
export type SubagentCollectResult =
	| { status: "running" }
	| { status: "interrupted" }
	| { status: "unknown" }
	| ({ status: SubagentStatus; callId: string } & SubagentOutcome);

export interface SubagentRunner {
	runSubagent(piSessionKey: string, task: string, opts?: SubagentRunOpts): Promise<SubagentOutcome>;
}

/**
 * spawn 工具与 SessionManager 的解耦中转（PendingToolRegistry 同款装配顺序：
 * coordinator 先于 SessionManager 构造，工具经 deps 拿到它；SessionManager
 * 实例化后 attach 自身，运行期单向引用，无循环依赖）。
 *
 * D2（spec §6.2）：ledger 可选注入（未注入 = 全链 no-op，纯文本/旧测试路径零影响）；
 * block/background 都产 callId 并落账——block 的 tool_result 也带 callId，取证/collect 通用。
 */
export class SubagentCoordinator {
	private slots = new SubagentSlots();
	private runner?: SubagentRunner;
	/** background 在途：callId → promise（settle 后迁入 #settled） */
	#inFlight = new Map<string, Promise<SubagentOutcome>>();
	/** 已结算（本进程 + 磁盘 replay 回填）：callId → outcome */
	#settled = new Map<string, SubagentOutcome>();
	/** 磁盘懒 replay 一次性闸 */
	#replayed = false;
	#ledgerSpawnedIds?: Set<string>;

	constructor(private ledger?: SubtaskLedger) {}

	attach(runner: SubagentRunner): void {
		this.runner = runner;
	}

	tryRun(
		piSessionKey: string,
		task: string,
		opts?: SubagentRunOpts,
	): { ok: true; promise: Promise<SubagentOutcome>; callId: string } | { ok: false; reason: "not_attached" | "concurrency_full" } {
		if (!this.runner) return { ok: false, reason: "not_attached" };
		if (!this.slots.acquire()) return { ok: false, reason: "concurrency_full" };
		const callId = randomUUID();
		const mode: "block" | "background" = opts?.mode === "background" ? "background" : "block";
		this.ledger?.append({
			type: "spawned", callId, sessionKey: piSessionKey,
			taskPreview: task.slice(0, 200), mode, ts: Date.now(),
		});
		// 契约：返回的 promise 永不 reject——runner 内部兜底 + 此处第二道安全网，
		// 调用方（spawn 工具）免 try/catch，也根除 unhandledRejection 窗口。
		// settle 时先落 terminal 账本（含全文 report，重启后 collect 仍可取回），再登记/清理。
		const promise = this.runner
			.runSubagent(piSessionKey, task, opts)
			.catch(
				(err: unknown): SubagentOutcome => ({
					report: `子代理运行失败: ${err instanceof Error ? err.message : String(err)}`,
					turns: 0,
					durationMs: 0,
					status: "failed",
				}),
			)
			.then((outcome): SubagentOutcome => {
				this.ledger?.append({
					type: "terminal", callId, status: outcome.status,
					turns: outcome.turns, durationMs: outcome.durationMs,
					truncated: outcome.truncated === true ? true : undefined,
					reportChars: outcome.report.length, report: outcome.report, ts: Date.now(),
				});
				this.#settled.set(callId, outcome);
				return outcome;
			})
			.finally(() => {
				this.#inFlight.delete(callId);
				this.slots.release();
			});
		this.#inFlight.set(callId, promise);
		return { ok: true, promise, callId };
	}

	/** 刀A（spec §6.2/§6.5）：in-flight → running；settled → 终态；磁盘懒 replay（一次）→ 终态；
	 *  spawned 无 terminal（pod 重启蒸发）→ interrupted；全无 → unknown。 */
	collect(callId: string): SubagentCollectResult {
		if (this.#inFlight.has(callId)) return { status: "running" };
		const settled = this.#settled.get(callId);
		if (settled) return { callId, ...settled };
		if (this.ledger && !this.#replayed) {
			this.#replayed = true;
			for (const [id, st] of this.ledger.replay()) {
				if (!this.#settled.has(id)) {
					this.#settled.set(id, {
						report: st.report, turns: st.turns, durationMs: st.durationMs,
						status: st.status, truncated: st.truncated,
					});
				}
			}
			this.#ledgerSpawnedIds = this.ledger.spawnedCallIds();
			return this.collect(callId);
		}
		if (this.#ledgerSpawnedIds?.has(callId)) return { status: "interrupted" };
		return { status: "unknown" };
	}
}
