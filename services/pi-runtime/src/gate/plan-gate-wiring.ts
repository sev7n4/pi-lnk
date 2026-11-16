/**
 * C3 Plan 确认门接线（spec docs/superpowers/specs/2026-10-10-plan-gate-design.md §3.3/§3.4）。
 *
 * 从 index.ts 抽成独立模块的原因：index.ts 是模块级单例 + env 依赖装配，测试无法 import
 * 驱动；本函数是唯一接线源，index.ts 与真实 harness 集成测试共调，杜绝「测试复制接线」漂移。
 *
 * 三只钩子（hooks 契约见 agent-harness.d.ts）：
 * - before_tool：planPending 且 tier ∈ gated 且未豁免 → block（fail-closed，唯一解锁 = 确认卡）。
 *   与 generation-gate 并存不合并（节点级 SSOT vs transcript 快照两套语义）。
 * - after_tool（B-1）：propose_plan 终态即时切换声明集——execute 同点还原、其余同点收缩。
 * - before_run（B-1）：跨 run 收敛 pending 收缩态（resume 播种 / keep 持续），幂等。
 *   before_tool 拦截保留不动（二线防线）；声明集收缩是优化不是正确性（fail-open）。
 * - before_run_end 已迁移到 registerRunEndHooks（subagent-barrier.ts）——统一合成
 *   plan-gate 续跑 + barrier 结果回注，避开上游 hooks.js 多 handler last-write-wins。
 */
import type { AgentHarness, Context, JsonValue } from "@earendil-works/pi-agent-core";
import type { LnkpiToolContext } from "../tools/types.js";
import type { Metrics } from "../metrics.js";
import { getTodoState } from "../tools/todo.js";
import { planGateEnabled } from "../runtime-config.js";
import {
	consumePlanExecutionSignal,
	shouldBlockForPlan,
	isPlanPending,
	setToolsetNarrow,
	getToolsetNarrow,
} from "./plan-gate.js";
import { computeNarrow, computeRestore } from "./toolset-overlay.js";

/** 与 session-manager.ts 的 MAIN_LANE 同值。刻意本地声明：wiring 不 import session-manager
 * （避免巨模块依赖面 + 潜在循环）；两处语义锚定 vendor lane 名 "main"，漂移会被行为级
 * 测试抓（收缩写错 lane ⇒ getActiveTools 断言红）。 */
const MAIN_LANE = "main";

const PLAN_DECISIONS: ReadonlySet<string> = new Set([
	"execute",
	"refine",
	"keep",
	"timeout",
	"aborted",
]);

// ⭐ B-2 任务契约一等化（plan 2026-11-16-b2-task-contract-custom-entry-plan.md §3-D1/D2）。
const TASK_ENTRY_CUSTOM_TYPE = "lnkpi.task";
const TASK_ENTRY_MAX_BYTES = 32 * 1024;

/** B-2 payload 32KB 上限截断（plan §3-D2）：依次丢 snapshot 尾部条目 → diff → snapshot 全量，
 *  仍超则整条放弃；截断打点 truncated（观测层可见），**从不静默膨胀**。 */
function truncateTaskPayload(
	payload: { v: 1; kind: "todo" | "plan"; snapshot?: unknown[]; diff?: unknown; decision?: string },
	metrics: Pick<Metrics, "observeTaskEntryTruncated">,
): { v: 1; kind: "todo" | "plan"; snapshot?: unknown[]; diff?: unknown; decision?: string } | undefined {
	const fits = (p: unknown) => Buffer.byteLength(JSON.stringify(p), "utf8") <= TASK_ENTRY_MAX_BYTES;
	if (fits(payload)) return payload;
	metrics.observeTaskEntryTruncated(payload.kind);
	if (Array.isArray(payload.snapshot)) {
		let snap = [...payload.snapshot];
		while (snap.length > 0 && !fits({ ...payload, snapshot: snap })) snap = snap.slice(0, -1);
		if (fits({ ...payload, snapshot: snap })) return { ...payload, snapshot: snap };
	}
	const { diff: _diff, ...noDiff } = payload; // diff 体积次之，先弃
	if (fits(noDiff)) return noDiff;
	const { snapshot: _snap, ...decisionOnly } = noDiff;
	if (fits(decisionOnly)) return decisionOnly;
	return undefined; // 极端（decision 文案本身就超限）：整条放弃，宁缺不炸
}

/** B-2 一等写入（plan §3-D1）：todo_write / propose_plan 成功终态 → appendCustomEntry("lnkpi.task")。
 *  挂 after_tool wiring 而非工具层：details 已在 event、context 可达 harness，工具层零触碰。
 *  fail-open：账本写入是增强不是正确性依赖（读取侧 fallback 反扫仍在，观察期双轨）。 */
async function appendTaskEntry(
	harness: AgentHarness<LnkpiToolContext>,
	context: Context | undefined,
	event: { toolName: string; details?: unknown },
	metrics: Pick<Metrics, "observeTaskEntry" | "observeTaskEntryTruncated">,
): Promise<void> {
	try {
		if (!context) return;
		const details = event.details as
			| {
					todo?: { snapshot?: unknown; diff?: unknown; rejected?: unknown };
					plan?: { decision?: unknown; steps?: unknown };
			  }
			| undefined;
		if (!details || typeof details !== "object") return;
		let kind: "todo" | "plan";
		let snapshot: unknown[] | undefined;
		let diff: unknown;
		let decision: string | undefined;
		if (event.toolName === "todo_write") {
			const t = details.todo;
			// rejected=true 是 isError 语义补正（硬拒绝回执）：不是真实清单变更，不落账本
			if (!t || t.rejected === true || !Array.isArray(t.snapshot)) return;
			kind = "todo";
			snapshot = t.snapshot;
			diff = t.diff;
		} else if (event.toolName === "propose_plan") {
			const d = details.plan?.decision;
			if (typeof d !== "string" || !PLAN_DECISIONS.has(d)) return;
			kind = "plan";
			decision = d;
			if (Array.isArray(details.plan?.steps)) snapshot = details.plan.steps as unknown[];
		} else {
			return;
		}
		const payload = truncateTaskPayload({ v: 1, kind, snapshot, diff, decision }, metrics);
		if (!payload) return;
		// details 来源是 unknown ⇒ JSON 往返归一为 JsonValue（截断判定本就基于同一条序列化，
		// 往返不引入第二次形态漂移）。
		const jsonPayload = JSON.parse(JSON.stringify(payload)) as JsonValue;
		// appendCustomEntry 在 AgentLane（非 harness 根面）——main lane 与 B-1 声明集同域。
		const lane = await harness.lane(MAIN_LANE, context);
		await lane.appendCustomEntry(TASK_ENTRY_CUSTOM_TYPE, jsonPayload, context);
		metrics.observeTaskEntry(kind);
	} catch (err) {
		process.stderr.write(
			`[task-entry] appendCustomEntry 失败（fail-open，fallback 反扫仍在）：` +
				`${err instanceof Error ? err.message : String(err)}\n`,
		);
	}
}

/** B-1 声明集收缩/还原的单次应用（plan §2-D1/D2）。fail-open：声明集是优化不是正确性
 *  （before_tool 拦截仍在），任何 lane 访问失败只 warning，不阻塞 run。 */
async function applyToolsetOverlay(
	harness: AgentHarness<LnkpiToolContext>,
	context: Context | undefined,
	planKey: string,
	narrow: boolean,
	tiers: ReadonlyMap<string, string | undefined>,
	metrics: Pick<Metrics, "observePlanGateBlocked" | "observeToolsetGateNarrow">,
): Promise<void> {
	try {
		if (!context) return;
		const lane = await harness.lane(MAIN_LANE, context);
		const current = await lane.getActiveTools(context);
		if (narrow) {
			const removed = computeNarrow(current, tiers);
			if (removed.length === 0) {
				// 无 gated 写工具（纯读会话）：仍记账，防 before_run 每轮重试差分。
				setToolsetNarrow(planKey, true, []);
				return;
			}
			const removedSet = new Set(removed);
			await lane.setActiveTools(
				current.filter((n) => !removedSet.has(n)),
				context,
			);
			setToolsetNarrow(planKey, true, removed);
			metrics.observeToolsetGateNarrow?.("narrow");
		} else {
			const { narrowed, removed } = getToolsetNarrow(planKey);
			if (!narrowed) return;
			await lane.setActiveTools(computeRestore(current, removed), context);
			setToolsetNarrow(planKey, false, []);
			metrics.observeToolsetGateNarrow?.("restore");
		}
	} catch (err) {
		process.stderr.write(
			`[plan-gate] toolset overlay ${narrow ? "narrow" : "restore"} 失败（fail-open，before_tool 拦截仍在）：` +
				`${err instanceof Error ? err.message : String(err)}\n`,
		);
	}
}

/** 纯函数：plan 执行信号命中且 todo 有未完成项 → followUp 文案；否则 undefined。
 *  供 run-end 合成器（subagent-barrier.ts）调用，只算不注册；信号一次性消费，只调用一次。 */
export function planGateFollowUp(planKey: string): string | undefined {
	if (!consumePlanExecutionSignal(planKey)) return undefined;
	const next = getTodoState(planKey).find((i) => i.status !== "completed");
	if (!next) return undefined;
	return `用户已确认方案，继续执行任务清单的下一步：「${next.content}」。完成或受挫后用 todo_write 更新状态；全部完成后提交空数组清空清单。`;
}

export function registerPlanGateHooks(
	harness: AgentHarness<LnkpiToolContext>,
	opts: {
		/** 键域解析器：canvasSessionId 每轮可能自愈（doCreate），钩子内必须**现算**——
		 * 急切捕获会让「晚绑定画布会话」的门禁静默 fail-open（终审 Important #2）。 */
		planKey: string | (() => string);
		tiers: ReadonlyMap<string, string | undefined>;
		metrics: Pick<
			Metrics,
			| "observePlanGateBlocked"
			| "observeToolsetGateNarrow"
			| "observeTaskEntry"
			| "observeTaskEntryTruncated"
		>;
	},
): void {
	// kill switch 三面全关（终审 Critical #1）：off ⇒ 不注册（拦/注入自然不存在）。
	// 回滚止血场景：存量 planPending 会话不播种（session-manager 同门控）+ 工具不注册
	// （config.ts 同门控）⇒ 逐字节旧行为，无锁死出口。B-1 声明集收缩同门控（plan §2-D5）。
	if (!planGateEnabled()) return;
	const { tiers, metrics } = opts;
	const resolveKey = () => (typeof opts.planKey === "function" ? opts.planKey() : opts.planKey);
	harness.hooks.on("before_tool", async (event) => {
		const planKey = resolveKey();
		if (!shouldBlockForPlan(event.toolName, tiers.get(event.toolName), planKey)) return undefined;
		metrics.observePlanGateBlocked(event.toolName);
		return {
			block: {
				reason:
					"方案待用户确认：请先用 propose_plan 征得用户确认（或与用户澄清下一步），确认前不写画布、不调生成。",
			},
		};
	});
	// ⭐ B-1 双挂点（plan §2-D1）+ B-2 一等写入（plan §3-D1）：
	// - after_tool（run 内即时双向）：propose_plan 终态即切——execute 同点还原（确认当轮就
	//   要写画布，收缩态带到 run 剩余部分 = 「确认了却写不了」严重回归）；refine/keep/
	//   timeout/aborted 同点收缩（fail-closed 的声明集化，run 内后续步立即看不到写工具）。
	//   B-2 同点一等写入：todo_write/propose_plan 成功终态落 lnkpi.task 账本（fail-open）。
	harness.hooks.on("after_tool", async (event, context) => {
		if (event.toolName === "todo_write" || event.toolName === "propose_plan") {
			await appendTaskEntry(harness, context, event, metrics);
		}
		if (event.toolName !== "propose_plan") return undefined;
		const decision = (event.details as { plan?: { decision?: unknown } } | undefined)?.plan
			?.decision;
		if (typeof decision !== "string" || !PLAN_DECISIONS.has(decision)) return undefined;
		await applyToolsetOverlay(
			harness,
			context,
			resolveKey(),
			decision !== "execute",
			tiers,
			metrics,
		);
		return undefined;
	});
	// - before_run（跨 run 态收敛）：覆盖 seedPlanState resume 播种、keep/timeout 跨 run
	//   持续。幂等：pending 与收缩态一致时跳过（防重复差分/重复打点）。
	harness.hooks.on("before_run", async (_event, context) => {
		const planKey = resolveKey();
		const pending = isPlanPending(planKey);
		const { narrowed } = getToolsetNarrow(planKey);
		if (pending === narrowed) return undefined;
		await applyToolsetOverlay(harness, context, planKey, pending, tiers, metrics);
		return undefined;
	});
	// before_run_end 已迁移到 registerRunEndHooks（subagent-barrier.ts）——统一合成
	// plan-gate 续跑 + barrier 结果回注，避开上游 hooks.js 多 handler last-write-wins。
}
