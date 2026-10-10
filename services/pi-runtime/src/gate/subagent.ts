/**
 * C4 子代理三件套/白名单/并发闸/Coordinator
 * （spec docs/superpowers/specs/2026-10-10-c4-subagent-design.md §3.3/§3.4）。
 *
 * 三件套硬编码不可禁用（§3.4）：无 env、无 kill switch——它们是安全边界不是功能开关。
 * 白名单按「副作用面」三类划分（§3.3）：本地只读 + 网络出口（net-egress，裁决 8）进；
 * 状态写入 / 用户交互（ask_user）/ 自身（spawn_subagent，禁嵌套）排除。
 */
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
}

/** runSubagent 运行期可选项（评审 I2：主 run「停止」要能传播到子 run）。 */
export interface SubagentRunOpts {
	/** 外部取消信号（spawn 工具透传 chordCtx.abortSignal）。abort → cancel 子 run → status=failed。 */
	signal?: AbortSignal;
}

export interface SubagentRunner {
	runSubagent(piSessionKey: string, task: string, opts?: SubagentRunOpts): Promise<SubagentOutcome>;
}

/**
 * spawn 工具与 SessionManager 的解耦中转（PendingToolRegistry 同款装配顺序：
 * coordinator 先于 SessionManager 构造，工具经 deps 拿到它；SessionManager
 * 实例化后 attach 自身，运行期单向引用，无循环依赖）。
 */
export class SubagentCoordinator {
	private slots = new SubagentSlots();
	private runner?: SubagentRunner;

	attach(runner: SubagentRunner): void {
		this.runner = runner;
	}

	tryRun(
		piSessionKey: string,
		task: string,
		opts?: SubagentRunOpts,
	): { ok: true; promise: Promise<SubagentOutcome> } | { ok: false; reason: "not_attached" | "concurrency_full" } {
		if (!this.runner) return { ok: false, reason: "not_attached" };
		if (!this.slots.acquire()) return { ok: false, reason: "concurrency_full" };
		// 契约：返回的 promise 永不 reject——runner 内部兜底 + 此处第二道安全网，
		// 调用方（spawn 工具）免 try/catch，也根除 unhandledRejection 窗口。
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
			.finally(() => this.slots.release());
		return { ok: true, promise };
	}
}
