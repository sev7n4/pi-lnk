# 子代理 pending-work barrier + 上下文隔离 + 结果交付根治 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 根治生产会话 `cmwhln39d006yqp01d56ryc0q` 暴露的三层缺陷：父 run 在后台子任务存活时提前结束（P1）、子代理继承编排上下文撞 unavailable 工具（P2）、断流时开场白被当报告落账（P3）。

**Architecture:**
- P1 在 `before_run_end` 单点做 pending-work barrier：Coordinator 增加按会话聚合的未收口集合，hook 检测本会话有未收口 background 时 async await 到终态，把结果作为 `followUp` 回注父会话续跑。为避开上游 last-write-wins，plan-gate 与 barrier 收敛到**单一** handler 合成 followUp。
- P2 把子会话从"fork 全量历史"改为"build 全新空 session + 结构化 task 注入"，编排工具在白名单层面缺席（fail-closed）。
- P3 报告提取改取末条 synthesis + partial 标记 + `stream_interrupted` 状态 + 可观测指标。

**Tech Stack:** TypeScript / Node `node:test` + `node:assert/strict` + `@earendil-works/pi-ai` faux provider / pi-agent-core AgentHarness / nvm node24。

**Spec:** `docs/superpowers/specs/2026-11-15-subagent-pending-work-barrier-design.md`（已批准，决策 D1-D4 按推荐方案落地）

## Global Constraints

- 测试命令：`node --import tsx --test <file>`（pi-runtime 用 node:test 非 vitest）。tsc：`vue-tsc -b`（**勿加 `--noEmit`**，composite TS6310），PATH 用 `/Users/4seven/.nvm/versions/node/v24.13.0/bin:$PATH`。
- 断言禁 `as never`；hook event 自由形态字段用 `hook-contract.ts` 的 `readRecord/readStringField` 守卫读取。
- 不 patch vendor；不改 `SUBAGENT_MAX_CONCURRENT=2` / `SUBAGENT_TURN_BUDGET=30` / `SUBAGENT_TIMEOUT_MS=300_000` / `SUBAGENT_REPORT_MAX_CHARS=20_000` 的值。
- 白名单红线不动：`spawn_subagent` / `collect_subagent_result` 永不在 `SUBAGENT_TOOL_WHITELIST`。
- 清理铁律：子会话结束只 `sessions.delete` + `harness.close`，绝不 `releaseHandles`（env/repo 与来源共享）。
- Coordinator 契约：promise 永不 reject；fail-soft 是铁律，主 run 不因子任务任何形态失败中断。
- barrier deadline = `SUBAGENT_TIMEOUT_MS + 30_000`（决策 D4）。
- 判变异 RED 用完整 stdout 的失败标记（`AssertionError` / `failing tests`），不用 `| tail`。

## Review Focus

- **父 run 先于子任务收尾**（本次事故本身）：spawn background 后父模型直接停 → 期望框架挂住收尾直到子任务终态、结果回注。→ Task 2 的 B1/B2 覆盖。
- **deadline 永不 settle 的子任务**：runner 挂死 → 期望 deadline 后标 interrupted 且父 run 不被永久挂住。→ Task 2 的 B3。
- **主 run「停止」传播**：abort 发生时 → 期望子 run 收 failed、barrier 不悬挂。→ Task 2 的 B4。
- **plan-gate 与 barrier 同时命中**（last-write-wins 陷阱）：两处都要注 followUp → 期望两条都不丢。→ Task 3 的 B6。
- **断流子进程无最终 synthesis**：transcript 尾部只有 toolCall + 开场白 → 期望 report 不是开场白、带 partial / stream_interrupted。→ Task 5 的 B8。
- **子代理上下文污染**：子会话请求上下文含主 run 的 skill/编排文本 → 期望干净会话只见结构化 task。→ Task 4 的 B7。

---

### Task 1: Coordinator 增加 per-session pending 索引与 awaitSettled

**Files:**
- Modify: `services/pi-runtime/src/gate/subagent.ts`（`SubagentCoordinator` 类，106-188 行）

**Interfaces:**
- Consumes: `tryRun` 现有的 `mode`、`#inFlight`、`#settled`、ledger。
- Produces:
  - `pendingFor(sessionKey: string): string[]` — 返回该会话仍在途的 background callId 快照。
  - `awaitSettled(callIds: string[], opts: { deadlineMs: number }): Promise<SettledSubagentResult[]>` — 等到终态；每个结果 `{ callId, status, report, partial }`。
  - `type SettledSubagentResult = { callId: string; status: SubagentStatus | "interrupted"; report: string; partial: boolean }`
  - `SubagentStatus` 新增 `"stream_interrupted"`（Task 5 用，本任务先扩类型）。

- [ ] **Step 1: 写失败测试——pendingFor 只登记 background，settle 后清空**

在 `services/pi-runtime/src/gate/subagent.test.ts` 末尾追加：

```ts
describe("P1 pending-work：per-session 未收口索引", () => {
	it("background 登记 pending，settle 后清空；block 不登记", async () => {
		const { runner, releaseAll } = (() => {
			const releases: Array<() => void> = [];
			return {
				runner: {
					runSubagent: (): Promise<SubagentOutcome> =>
						new Promise((resolve) => {
							releases.push(() => resolve({ report: "R", turns: 1, durationMs: 1, status: "completed" }));
						}),
				},
				releaseAll: () => releases.forEach((r) => r()),
			};
		})();
		const c = new SubagentCoordinator();
		c.attach(runner);
		const bg = c.tryRun("s1", "bg-task", { mode: "background" });
		assert.ok(bg.ok);
		assert.deepEqual(c.pendingFor("s1"), [bg.callId], "background 应登记 pending");
		assert.deepEqual(c.pendingFor("s2"), [], "别的会话无 pending");
		// block 模式同步跑一个立即完成的
		c.attach({ runSubagent: async () => ({ report: "B", turns: 1, durationMs: 1, status: "completed" }) });
		const blk = c.tryRun("s1", "block-task");
		assert.ok(blk.ok);
		await blk.promise;
		assert.deepEqual(c.pendingFor("s1"), [bg.callId], "block 不应登记 pending");
		releaseAll();
		await bg.ok && bg.promise;
		assert.deepEqual(c.pendingFor("s1"), [], "settle 后 pending 清空");
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --import tsx --test services/pi-runtime/src/gate/subagent.test.ts`
Expected: FAIL，`c.pendingFor is not a function`。

- [ ] **Step 3: 实现 pendingFor + 扩 SubagentStatus + 登记/清理**

在 `subagent.ts`：
1. `export type SubagentStatus = "completed" | "failed" | "timeout" | "budget_exceeded" | "stream_interrupted";`
2. 增加 `export type SettledSubagentResult = { callId: string; status: SubagentStatus | "interrupted"; report: string; partial: boolean };`
3. `SubagentCoordinator` 加字段：
```ts
	/** P1：按会话聚合的未收口 background callId（barrier 用；block 模式不登记）。 */
	#pendingBySession = new Map<string, Set<string>>();
```
4. 在 `tryRun` 里，`mode === "background"` 时登记；在 `.finally()` 里移出：
```ts
		const mode: "block" | "background" = opts?.mode === "background" ? "background" : "block";
		if (mode === "background") {
			let set = this.#pendingBySession.get(piSessionKey);
			if (!set) { set = new Set(); this.#pendingBySession.set(piSessionKey, set); }
			set.add(callId);
		}
		// ...promise chain 的 .finally() 内追加：
		.finally(() => {
			this.#inFlight.delete(callId);
			this.slots.release();
			const set = this.#pendingBySession.get(piSessionKey);
			if (set) { set.delete(callId); if (set.size === 0) this.#pendingBySession.delete(piSessionKey); }
		});
```
5. 加方法：
```ts
	pendingFor(sessionKey: string): string[] {
		return [...(this.#pendingBySession.get(sessionKey) ?? [])];
	}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --import tsx --test services/pi-runtime/src/gate/subagent.test.ts`
Expected: PASS（全部用例）。

- [ ] **Step 5: 写失败测试——awaitSettled 等到终态 + deadline 标 interrupted**

追加到同 describe：

```ts
	it("awaitSettled：等到终态返回值；deadline 到仍未 settle 则 interrupted", async () => {
		const { runner, releaseAll } = (() => {
			const releases: Array<(s: SubagentStatus) => void> = [];
			return {
				runner: {
					runSubagent: (): Promise<SubagentOutcome> =>
						new Promise((resolve) => {
							releases.push((s) => resolve({ report: "DONE", turns: 1, durationMs: 1, status: s as SubagentStatus }));
						}),
				},
				releaseAll: (s: SubagentStatus) => releases.forEach((r) => r(s)),
			};
		})();
		const c = new SubagentCoordinator();
		c.attach(runner);
		const a = c.tryRun("s", "a", { mode: "background" });
		const b = c.tryRun("s", "b", { mode: "background" });
		assert.ok(a.ok && b.ok);
		// 先只放行 a，b 留到 deadline
		releases[0]!("completed");
		const results = await c.awaitSettled([a.callId, b.callId], { deadlineMs: 60 });
		const byId = new Map(results.map((r) => [r.callId, r]));
		assert.equal(byId.get(a.callId)?.status, "completed");
		assert.equal(byId.get(a.callId)?.report, "DONE");
		assert.equal(byId.get(b.callId)?.status, "interrupted", "deadline 未 settle → interrupted");
		releaseAll("completed"); // 清理挂起的 b，避免测试进程悬挂
		await b.ok && b.promise;
	});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `node --import tsx --test services/pi-runtime/src/gate/subagent.test.ts`
Expected: FAIL，`c.awaitSettled is not a function`。

- [ ] **Step 7: 实现 awaitSettled**

在 `SubagentCoordinator` 加：

```ts
	/** P1：等到给定 callId 全部 settle（或 deadline）。永不 reject。
	 *  已 settled 的立返；在途的 race 其 promise 与 deadline；deadline 未决标 interrupted。 */
	async awaitSettled(callIds: string[], opts: { deadlineMs: number }): Promise<SettledSubagentResult[]> {
		const results = await Promise.all(
			callIds.map(async (callId): Promise<SettledSubagentResult> => {
				const settled = this.#settled.get(callId);
				if (settled) {
					return {
						callId, status: settled.status, report: settled.report,
						partial: settled.status === "stream_interrupted" || settled.status === "timeout",
					};
				}
				const inFlight = this.#inFlight.get(callId);
				if (!inFlight) {
					return { callId, status: "interrupted", report: "", partial: true };
				}
				let timer: ReturnType<typeof setTimeout> | undefined;
				const deadline = new Promise<"__deadline__">((resolve) => {
					timer = setTimeout(() => resolve("__deadline__"), opts.deadlineMs);
				});
				try {
					const winner = await Promise.race([
						inFlight.then((): "__done__" => "__done__"),
						deadline,
					]);
					if (winner === "__deadline__") {
						return { callId, status: "interrupted", report: "", partial: true };
					}
					const done = this.#settled.get(callId);
					return done
						? { callId, status: done.status, report: done.report, partial: done.status === "stream_interrupted" || done.status === "timeout" }
						: { callId, status: "interrupted", report: "", partial: true };
				} finally {
					if (timer) clearTimeout(timer);
				}
			}),
		);
		return results;
	}
```

- [ ] **Step 8: 运行测试确认通过**

Run: `node --import tsx --test services/pi-runtime/src/gate/subagent.test.ts`
Expected: PASS。

- [ ] **Step 9: 变异自检——确认判据能 RED**

临时把 `pendingFor` 改为 `return []`，跑测试，确认 Step 1 用例 RED（完整 stdout 出现 `AssertionError` / `failing tests`）；恢复。再把 `.finally()` 里的 pending 删除行注释掉，确认 Step 1 「settle 后清空」断言 RED；恢复。

- [ ] **Step 10: Commit**

```bash
git add services/pi-runtime/src/gate/subagent.ts services/pi-runtime/src/gate/subagent.test.ts
git commit -m "feat(subagent): P1 Coordinator per-session pending 索引 + awaitSettled

- pendingFor(sessionKey) 聚合未收口 background callId
- awaitSettled(callIds, deadlineMs) 等到终态，超时标 interrupted
- SubagentStatus 扩 stream_interrupted"
```

---

### Task 2: barrier 核心——单一 before_run_end handler 合成 followUp

**Files:**
- Create: `services/pi-runtime/src/gate/subagent-barrier.ts`
- Create: `services/pi-runtime/src/gate/subagent-barrier.test.ts`
- Modify: `services/pi-runtime/src/gate/plan-gate-wiring.ts`（暴露纯函数 `planGateFollowUp`）

**Interfaces:**
- Consumes: `SubagentCoordinator.pendingFor / awaitSettled`（Task 1）、`consumePlanExecutionSignal / getTodoState`（plan-gate.ts 现有）。
- Produces:
  - `registerRunEndHooks(harness, opts): void` — 唯一注册 `before_run_end` 的接线函数，内部合成 plan-gate + barrier 两路 followUp。
  - `composeBarrierFollowUp(results: SettledSubagentResult[]): string | undefined` — 纯函数，导出供测试。
  - `planGateFollowUp(planKey: string): string | undefined` — 从 plan-gate-wiring 抽出的纯函数（只算不注册）。

- [ ] **Step 1: 先重构 plan-gate-wiring，抽出纯函数 planGateFollowUp**

把 `gate/plan-gate-wiring.ts` 的 `before_run_end` 内联逻辑抽成导出纯函数，原 hook 保留但改为调用它（保持既有测试不破）：

```ts
/** 纯函数：plan 执行信号命中且 todo 有未完成项 → followUp 文案；否则 undefined。供 run-end 合成器调用。 */
export function planGateFollowUp(planKey: string): string | undefined {
	if (!consumePlanExecutionSignal(planKey)) return undefined;
	const next = getTodoState(planKey).find((i) => i.status !== "completed");
	if (!next) return undefined;
	return `用户已确认方案，继续执行任务清单的下一步：「${next.content}」。完成或受挫后用 todo_write 更新状态；全部完成后提交空数组清空清单。`;
}
```

并把 `registerPlanGateHooks` 内的 `before_run_end` 注册块（:48-57）改为调用纯函数（注意 `consumePlanExecutionSignal` 一次性消费，**只调用一次** `planGateFollowUp`）：
```ts
	harness.hooks.on("before_run_end", async () => {
		const text = planGateFollowUp(resolveKey());
		return text === undefined ? undefined : { followUp: text };
	});
```
> 说明：Task 3 会把这条注册从 index.ts 移除、改由 `registerRunEndHooks` 统一挂；本步先保证纯函数可用且旧测试仍绿。

- [ ] **Step 2: 运行 plan-gate 测试确认无回归**

Run: `node --import tsx --test services/pi-runtime/src/gate/plan-gate-wiring.test.ts services/pi-runtime/src/session-manager.plan-gate.test.ts`
Expected: PASS。

- [ ] **Step 3: 写失败测试——composeBarrierFollowUp 文案**

Create `gate/subagent-barrier.test.ts`：

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { composeBarrierFollowUp } from "./subagent-barrier.js";
import type { SettledSubagentResult } from "./subagent.js";

describe("P1 barrier followUp 文案", () => {
	it("无结果 → undefined（不注入）", () => {
		assert.equal(composeBarrierFollowUp([]), undefined);
	});
	it("completed + failed + interrupted 三条都进文案，状态与 partial 明确", () => {
		const results: SettledSubagentResult[] = [
			{ callId: "c1", status: "completed", report: "调研结论：X", partial: false },
			{ callId: "c2", status: "failed", report: "失败原因", partial: true },
			{ callId: "c3", status: "interrupted", report: "", partial: true },
		];
		const text = composeBarrierFollowUp(results)!;
		assert.match(text, /后台子任务/);
		assert.match(text, /c1/);
		assert.match(text, /调研结论：X/);
		assert.match(text, /completed/);
		assert.match(text, /c2/);
		assert.match(text, /failed/);
		assert.match(text, /c3/);
		assert.match(text, /interrupted/);
		assert.match(text, /结果不完整|不可恢复/);
	});
	it("stream_interrupted 标 partial", () => {
		const text = composeBarrierFollowUp([
			{ callId: "c9", status: "stream_interrupted", report: "半截", partial: true },
		])!;
		assert.match(text, /stream_interrupted/);
		assert.match(text, /结果不完整|不完整|partial/);
	});
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `node --import tsx --test services/pi-runtime/src/gate/subagent-barrier.test.ts`
Expected: FAIL，模块/函数不存在。

- [ ] **Step 5: 实现 subagent-barrier.ts（composeBarrierFollowUp + registerRunEndHooks）**

Create `services/pi-runtime/src/gate/subagent-barrier.ts`：

```ts
/**
 * P1 pending-work barrier（spec 2026-11-15-subagent-pending-work-barrier-design.md §5）。
 * 单一 before_run_end handler：合成 plan-gate 续跑 + 后台子任务结果回注，
 * 避开上游 hooks.js last-write-wins（多个 handler 的 followUp 后者覆盖前者）。
 */
import type { AgentHarness } from "@earendil-works/pi-agent-core";
import type { SubagentCoordinator, SettledSubagentResult } from "./subagent.js";
import { SUBAGENT_TIMEOUT_MS } from "./subagent.js";
import { isSubagentSessionKey } from "../session-manager.js";
import { planGateFollowUp } from "./plan-gate-wiring.js";

export const BARRIER_DEADLINE_MS = SUBAGENT_TIMEOUT_MS + 30_000; // 决策 D4

export function composeBarrierFollowUp(results: SettledSubagentResult[]): string | undefined {
	if (results.length === 0) return undefined;
	const lines = results.map((r) => {
		const flag = r.partial ? "（结果不完整）" : "";
		return `- ${r.callId} [${r.status}] ${r.report || "（无报告）"}${flag}`;
	});
	const hasPartial = results.some((r) => r.partial);
	const tail = hasPartial ? "\n注意：部分后台任务结果不完整或在本进程未收口、不可恢复，请据此谨慎合成结论。" : "";
	return `【后台子任务已完成，以下为结果，请据此合成最终答复】\n${lines.join("\n")}${tail}`;
}

/** 局部接口：barrier 只依赖这一个 observeBarrier 方法，不前置依赖 Task 3 才加到 Metrics 上的实现。 */
export interface BarrierMetrics {
	observeBarrier(outcome: "waited" | "deadline" | "cancelled" | "none"): void;
}

export function registerRunEndHooks(
	harness: AgentHarness<Record<string, unknown>>,
	opts: {
		sessionId: string;
		coordinator: SubagentCoordinator;
		resolvePlanKey: () => string;
		metrics: BarrierMetrics;
	},
): void {
	// 子会话不挂 barrier（与 plan-gate 的 !isSubagentSessionKey 守卫一致，防回灌）。
	if (isSubagentSessionKey(opts.sessionId)) return;
	harness.hooks.on("before_run_end", async () => {
		const pending = opts.coordinator.pendingFor(opts.sessionId);
		let barrierText: string | undefined;
		if (pending.length > 0) {
			const results = await opts.coordinator.awaitSettled(pending, { deadlineMs: BARRIER_DEADLINE_MS });
			opts.metrics.observeBarrier(results.some((r) => r.status === "interrupted") ? "deadline" : "waited");
			barrierText = composeBarrierFollowUp(results);
		} else {
			opts.metrics.observeBarrier("none");
		}
		const planText = planGateFollowUp(opts.resolvePlanKey()); // 一次性消费信号：只调用一次
		const parts = [barrierText, planText].filter((x): x is string => !!x);
		return parts.length === 0 ? undefined : { followUp: parts.join("\n\n") };
	});
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node --import tsx --test services/pi-runtime/src/gate/subagent-barrier.test.ts`
Expected: PASS。

- [ ] **Step 7: 写失败测试——barrier 行为级（B1/B2/B3/B4/B5/B6）**

追加到 `gate/subagent-barrier.test.ts`。用最小 harness stub 捕获 hook handler 直接驱动（比 e2e provider 更精确可控）：

```ts
import type { AgentHarness } from "@earendil-works/pi-agent-core";
import { registerRunEndHooks, composeBarrierFollowUp, type BarrierMetrics } from "./subagent-barrier.js";
import { SubagentCoordinator } from "./subagent.js";
import { markPlanDecision } from "./plan-gate.js";
import { overwriteTodos, resetTodoStoreForTest } from "../tools/todo.js";

type RunEndHandler = (event: { runId: string; messages: unknown[] }) => Promise<{ followUp?: string } | undefined>;

function hookCaptureHarness(): { harness: AgentHarness<Record<string, unknown>>; getRunEnd: () => RunEndHandler | undefined } {
	let runEnd: RunEndHandler | undefined;
	const harness = {
		hooks: {
			on: (name: string, fn: RunEndHandler) => {
				if (name === "before_run_end") runEnd = fn;
			},
		},
	} as unknown as AgentHarness<Record<string, unknown>>;
	return { harness, getRunEnd: () => runEnd };
}

const metricsStub = (): BarrierMetrics => ({ observeBarrier: () => {} });

describe("P1 barrier 行为级", () => {
	const config = (coordinator: SubagentCoordinator) => ({ sessionId: "s-main", coordinator, resolvePlanKey: () => "s-main", metrics: metricsStub() });

	it("B1：pending 未 settle 时 before_run_end 挂住，settle 后 followUp 含报告", async () => {
		let release!: () => void;
		const coordinator = new SubagentCoordinator();
		coordinator.attach({ runSubagent: () => new Promise((res) => { release = () => res({ report: "RESULT-X", turns: 1, durationMs: 1, status: "completed" }); }) });
		const bg = coordinator.tryRun("s-main", "t", { mode: "background" });
		assert.ok(bg.ok);
		const { harness, getRunEnd } = hookCaptureHarness();
		const c = config(coordinator);
		registerRunEndHooks(harness, c);
		const handler = getRunEnd()!;
		let settled = false;
		const endP = handler({ runId: "r", messages: [] }).then((v) => { settled = true; return v; });
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(settled, false, "子任务未 settle 时收尾必须挂住");
		release();
		const out = await endP;
		assert.match(out?.followUp ?? "", /RESULT-X/);
		assert.match(out?.followUp ?? "", /completed/);
	});

	it("B3：deadline 到仍未 settle → interrupted，收尾不永久挂住", async () => {
		const coordinator = new SubagentCoordinator();
		coordinator.attach({ runSubagent: () => new Promise(() => {}) }); // 永挂
		const bg = coordinator.tryRun("s-main", "t", { mode: "background" });
		assert.ok(bg.ok);
		const { harness, getRunEnd } = hookCaptureHarness();
		const c = config(coordinator);
		registerRunEndHooks(harness, c);
		// 用极小 deadline 覆盖常量：直接调 awaitSettled 语义由 Task 1 覆盖；这里驱动 handler 会等 330s，
		// 故本用例验证「compose 对 interrupted 的文案」（B3 的时长部分由 Task 1 Step 5 的 deadline 用例承担）。
		const text = composeBarrierFollowUp([{ callId: bg.callId, status: "interrupted", report: "", partial: true }])!;
		assert.match(text, /interrupted/);
		assert.match(text, /不可恢复/);
	});

	it("B6：plan-gate 与 barrier 同时命中时两条 followUp 都不丢（last-write-wins 防线）", async () => {
		resetTodoStoreForTest();
		// barrier 只对「仍在途」pending 注入：挂起一个 background 子任务占位。
		const coordinator = new SubagentCoordinator();
		let release!: () => void;
		coordinator.attach({ runSubagent: () => new Promise((res) => { release = () => res({ report: "BG-REPORT", turns: 1, durationMs: 1, status: "completed" }); }) });
		const bg = coordinator.tryRun("s-main", "t", { mode: "background" });
		assert.ok(bg.ok);
		// plan-gate 信号 + todo 种子（键域均为 s-main，与 resolvePlanKey 一致）
		markPlanDecision("s-main", "execute");
		overwriteTodos("s-main", [{ content: "下一步", status: "pending" }]);
		const { harness, getRunEnd } = hookCaptureHarness();
		const c = config(coordinator);
		registerRunEndHooks(harness, c);
		const endP = getRunEnd()!({ runId: "r", messages: [] });
		release(); // 放行子任务，让 barrier 的 awaitSettled 收敛
		const out = await endP;
		assert.match(out?.followUp ?? "", /BG-REPORT/, "barrier followUp 丢失");
		assert.match(out?.followUp ?? "", /下一步/, "plan-gate followUp 丢失");
	});
});
```

> 说明：B2（两条终态都进文案）已由 Step 3 的 compose 单测覆盖；B4（abort 传播）由 Task 4 的 e2e 与既有 `session-manager.subagent.integration.test.ts` 超时/取消用例覆盖；B5（幂等收敛）由 Step 8 的 pending 清空断言覆盖。B3 的 deadline 时长由 Task 1 Step 5 覆盖，此处只验文案。

- [ ] **Step 8: 运行测试确认失败→实现缺口**

Run: `node --import tsx --test services/pi-runtime/src/gate/subagent-barrier.test.ts`
Expected: 若 `observeBarrier` 尚未在 Metrics 上，tsc/运行报缺方法 → Task 3 Step 1 会补。先确认 B1/B6 断言逻辑本身正确（可临时用 stub metrics 通过）。

- [ ] **Step 9: 变异自检**

临时把 `registerRunEndHooks` 里的 `barrierText` 恒置 `undefined`，确认 B1 / B6 RED；恢复。临时把 `parts.join("\n\n")` 改成只取 `barrierText`，确认 B6 的 `下一步` 断言 RED；恢复。

- [ ] **Step 10: Commit**

```bash
git add services/pi-runtime/src/gate/subagent-barrier.ts services/pi-runtime/src/gate/subagent-barrier.test.ts services/pi-runtime/src/gate/plan-gate-wiring.ts
git commit -m "feat(barrier): P1 单一 before_run_end handler 合成 plan-gate + 子任务结果 followUp"
```

---

### Task 3: 接线替换——index.ts 用 registerRunEndHooks + metrics 埋点

**Files:**
- Modify: `services/pi-runtime/src/index.ts`（:207-220 附近）
- Modify: `services/pi-runtime/src/metrics.ts`（字段 :117-120、方法 :424-439、render :748-767）

**Interfaces:**
- Consumes: `registerRunEndHooks`（Task 2）、`SubtaskLedger` coordinator（已存在于 index.ts:69）。
- Produces: `Metrics.observeBarrier(outcome: "waited" | "deadline" | "cancelled" | "none")`、`pi_runtime_subagent_barrier_total{outcome}`。

- [ ] **Step 1: 写失败测试——metrics barrier 指标**

在 `services/pi-runtime/src/gate/subagent-barrier.test.ts` 顶部 import `Metrics`，追加：

```ts
it("metrics：barrier 指标按 outcome 累加并 render", () => {
	const m = new Metrics();
	m.observeBarrier("waited");
	m.observeBarrier("deadline");
	m.observeBarrier("waited");
	const text = m.render(1, "test");
	assert.match(text, /pi_runtime_subagent_barrier_total\{outcome="waited"\} 2/);
	assert.match(text, /pi_runtime_subagent_barrier_total\{outcome="deadline"\} 1/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --import tsx --test services/pi-runtime/src/gate/subagent-barrier.test.ts`
Expected: FAIL，`observeBarrier is not a function`。

- [ ] **Step 3: 实现 metrics 字段 + 方法 + render**

在 `metrics.ts`：
1. 字段（:120 后）：
```ts
	private subagentBarrier = new Map<string, number>(); // P1 key: outcome (waited|deadline|cancelled|none)
```
2. 方法（:439 后）：
```ts
	/** P1（spec 2026-11-15 §7.3）：barrier 收尾结果分布。 */
	observeBarrier(outcome: "waited" | "deadline" | "cancelled" | "none"): void {
		this.subagentBarrier.set(outcome, (this.subagentBarrier.get(outcome) ?? 0) + 1);
	}
```
3. render（:767 后，subagent collect 块之后）：
```ts
	lines.push("# HELP pi_runtime_subagent_barrier_total before_run_end pending barrier outcomes (2026-11-15).");
	lines.push("# TYPE pi_runtime_subagent_barrier_total counter");
	for (const [outcome, count] of [...this.subagentBarrier.entries()].sort()) {
		lines.push(`pi_runtime_subagent_barrier_total{outcome="${outcome}"} ${count}`);
	}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --import tsx --test services/pi-runtime/src/gate/subagent-barrier.test.ts`
Expected: PASS。

- [ ] **Step 5: 接线新增 index.ts（保留 plan-gate 的 before_tool，只挪走 before_run_end）**

⚠️ 关键：`registerPlanGateHooks` 提供**两个** hook——`before_tool`（拦写，必须保留）+ `before_run_end`（续跑，要挪走）。**不能整体删除 registerPlanGateHooks 调用**，否则拦写门禁丢失。

在 `index.ts` 顶部 import 增加：
```ts
import { registerRunEndHooks } from "./gate/subagent-barrier.js";
```
保留 :214-220 的 `if (!isSubagentSessionKey(sessionId)) { registerPlanGateHooks(...) }` 块**原样不动**（它继续提供 before_tool 拦写）；紧随其后**新增** registerRunEndHooks 调用：
```ts
		if (!isSubagentSessionKey(sessionId)) {
			registerPlanGateHooks(harness, {
				planKey: () => manager.getCanvasSessionId(sessionId) ?? sessionId,
				tiers: toolTiers,
				metrics,
			});
		}
		// P1（spec 2026-11-15）：唯一 before_run_end handler——合成 plan-gate 续跑 + 后台子任务结果回注。
		// registerPlanGateHooks 内部的 before_run_end 已在 Task 2 Step 1 删除，只留 before_tool 拦写；
		// followUp 注入统一由 registerRunEndHooks 承担，避开上游 last-write-wins。
		registerRunEndHooks(harness, {
			sessionId,
			coordinator: subagentCoordinator,
			resolvePlanKey: () => manager.getCanvasSessionId(sessionId) ?? sessionId,
			metrics,
		});
```

在 `plan-gate-wiring.ts` 里**删除** `registerPlanGateHooks` 内的 before_run_end 注册块（Task 2 Step 1 那条），只留 before_tool。纯函数 `planGateFollowUp` 保留（registerRunEndHooks 会 import 它）。⚠️ 注意：`plan-gate-wiring.ts` 里的 `consumePlanExecutionSignal` import 现在只被纯函数用，仍需要；`getTodoState` 同理——都保留。

- [ ] **Step 6: 静态门禁 + plan-gate 回归**

Run:
```bash
node --import tsx --test services/pi-runtime/src/gate/plan-gate.wiring.test.ts
```
Expected: ⚠️ 现有 `gate/plan-gate.wiring.test.ts` 有两个断言需同步更新：
1. `handlers.has("before_run_end")` 断言（plan-gate-wiring.test.ts:47）——现在 registerPlanGateHooks 不再注册 before_run_end，改为断言"只有 before_tool"。
2. wiring 守卫 `plan-gate.wiring.test.ts` 断言 index.ts 调用 registerPlanGateHooks——仍成立（保留了），**不用改**；但新增一条断言 index.ts 也调用 registerRunEndHooks。
更新后 PASS。同时保证 `session-manager.plan-gate.test.ts` 与 `session-manager.turn-budget.integration.test.ts` 里直接调 `registerPlanGateHooks` 的测试——它们的 before_run_end 续跑断言现在会失效（因为纯函数挪走了）→ 这两个测试需改为**同时调用 registerRunEndHooks**（在 onSessionCreated 里两个都注册），才能保留 followUp 续跑语义。更新后 PASS。

- [ ] **Step 7: 跑 plan-gate 全量集成确认续跑语义不回归**

Run: `node --import tsx --test services/pi-runtime/src/session-manager.plan-gate.test.ts services/pi-runtime/src/session-manager.turn-budget.integration.test.ts`
Expected: PASS（followUp 续轮完成清单、预算共享窗口语义不变）。

- [ ] **Step 8: 变异自检**

临时删除 index.ts 的 `registerRunEndHooks(...)` 调用，确认 plan-gate.wiring.test.ts 的接线守卫 RED；恢复。

- [ ] **Step 9: Commit**

```bash
git add services/pi-runtime/src/index.ts services/pi-runtime/src/metrics.ts services/pi-runtime/src/gate/plan-gate-wiring.ts services/pi-runtime/src/gate/plan-gate.wiring.test.ts services/pi-runtime/src/session-manager.plan-gate.test.ts services/pi-runtime/src/session-manager.turn-budget.integration.test.ts
git commit -m "feat(barrier): 接线 registerRunEndHooks + barrier 可观测 + plan-gate 去双重注册"
```

---

### Task 4: P2 子会话上下文隔离——干净 session + 结构化 task 注入

**Files:**
- Modify: `services/pi-runtime/src/session-manager.ts`（runSubagent :3204-3260、extractSubagentReport :3337-3362）
- Modify: `services/pi-runtime/src/session-manager.subagent.integration.test.ts`（:155-190 白名单测试的 fork 断言）

**Interfaces:**
- Consumes: `build()` 的 `repo.create` 分支（:1314）、`subagentTools` 选项、`composeSubagentPrompt`（spawn-subagent.ts:34）。
- Produces: runSubagent 的会话来源从 fork 改为 create；子 systemPrompt 不含编排纪律。

- [ ] **Step 1: 写失败测试——B7 子会话请求上下文不含主 run 历史**

改写 `session-manager.subagent.integration.test.ts` 的 `端到端白名单硬边界` 用例（:155-190）：把
```ts
	assert.ok(
		JSON.stringify(subRequestMessages).includes("主对话第一轮"),
		"子 run 请求上下文未包含主对话历史（fork 失效）",
	);
```
改为反向断言：
```ts
	assert.ok(
		!JSON.stringify(subRequestMessages).includes("主对话第一轮"),
		"P2：子 run 请求上下文不应包含主对话历史（干净会话隔离）",
	);
	assert.ok(
		JSON.stringify(subRequestMessages).includes("调研任务"),
		"子 run 请求上下文应包含结构化 task",
	);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --import tsx --test services/pi-runtime/src/session-manager.subagent.integration.test.ts`
Expected: FAIL，`P2：子 run 请求上下文不应包含主对话历史`。

- [ ] **Step 3: 实现干净 session——runSubagent 用 repo.create 替代 fork**

在 `session-manager.ts` 的 `runSubagent` 里，把 :3237-3260 的 fork + build 段改为（保留 `subKey` 生成与超时/取消包裹）：

把 :3234-3260 的 fork + build 段（含 `let forkedSession` 与 `let subKey` 声明）**整体替换**为以下干净会话版本：

```ts
			try {
				// P2（spec 2026-11-15 §6）：干净子会话——不 fork 全量历史，build() 不传 session 走 repo.create。
				// 保留 canvasSessionId / models / model / identity 沿用来源身份与画布指针；
				// storeScopeKey 用子键（build 内 opts.subagentTools 分支已实现，:1347）。
				subKey = toSessionKey(`${source.id}__sub_${randomUUID()}`);
				await this.build(
					subKey,
					{
						systemPrompt: SUBAGENT_SYSTEM_PROMPT,
						workingDir: source.sessionMeta.cwd,
						canvasSessionId: source.canvasSessionId,
						userId: source.userId,
						thinkingLevel: source.thinkingLevel,
						subagentTools: true,
						turnBudgetLimit: SUBAGENT_TURN_BUDGET,
					},
					source.models,
					source.model,
					source.identity,
					{ env: source.env, repo: source.repo }, // 关键：不传 session ⇒ repo.create 全新空会话
				);
			} catch (err) {
				if (timedOut) return { report: "", turns: 0, durationMs: Date.now() - t0, status: "timeout" };
				throw err;
			}
```

⚠️ `subKey` 变量沿用原 :3234 的 `let subKey: string | undefined;` 声明（不要重复声明）；`forkedSession` 声明随整段删除（P2 后不再 fork，无未使用变量）。
⚠️ `randomUUID` 需从 `node:crypto` import：原 :17 是 `import { createHash } from "node:crypto";`，改为 `import { createHash, randomUUID } from "node:crypto";`。

在文件顶部（import 之后）加常量：
```ts
/** P2：子代理专用 systemPrompt——不含主 run 的 skill index / spawn hint / collect 纪律（spec §6.3）。 */
const SUBAGENT_SYSTEM_PROMPT =
	"你是只读调研子代理。用白名单工具（画布只读/文档/记忆/联网）完成交给你的调研，禁止写画布或生成内容。" +
	"调研结束时给出结论先行的报告，末尾附「来源」清单，无法核实的说法标注「未核实」。";
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --import tsx --test services/pi-runtime/src/session-manager.subagent.integration.test.ts`
Expected: PASS（干净会话断言 + 白名单断言 + 并发/超时/异常隔离全绿）。

- [ ] **Step 5: 行为测试确认子代理首调不再有 collect 纪律诱导**

在 `session-manager.subagent.integration.test.ts` 追加：

```ts
test("P2：子会话 systemPrompt 不含 collect/spawn 编排纪律（fail-closed 非提示词级）", async () => {
	resetTodoStoreForTest();
	const metrics = new Metrics();
	const { sm, captured } = makeE2e(metrics, [
		fauxAssistantMessage("主对话含 research-delegate 纪律", { stopReason: "stop" }),
		fauxAssistantMessage("调研结论", { stopReason: "stop" }),
	]);
	const threadKey = "s-e2e-cleanprompt";
	await sm.create(threadKey, { userId: "u1" });
	await sm.prompt(threadKey, "开始");
	await waitAgentEnd(sm, threadKey);
	await waitSourceIdle(sm, threadKey);
	const outcome = await sm.runSubagent(threadKey, "调研任务");
	assert.equal(outcome.status, "completed");
	const sub = captured[captured.length - 1]!;
	const cfgText = JSON.stringify(sub);
	assert.ok(!cfgText.includes("collect_subagent_result"), "子会话配置不应含 collect 纪律文本");
	assert.ok(!cfgText.includes("research-delegate"), "子会话不应继承主 run skill");
});
```

Run: `node --import tsx --test services/pi-runtime/src/session-manager.subagent.integration.test.ts`
Expected: PASS。

- [ ] **Step 6: 变异自检**

把 runSubagent 改回 `source.repo.fork(...)` + `existingFs.session: forkedSession`，确认 Step 1 的反向断言 RED；恢复。把 SUBAGENT_SYSTEM_PROMPT 改回 `source.basePrompt`，确认 Step 5 断言 RED；恢复。

- [ ] **Step 7: Commit**

```bash
git add services/pi-runtime/src/session-manager.ts services/pi-runtime/src/session-manager.subagent.integration.test.ts
git commit -m "feat(subagent): P2 干净子会话——repo.create 替代 fork + 结构化 task 注入 + 编排纪律隔离"
```

---

### Task 5: P3 报告提取 + stream_interrupted 状态 + 可观测

**Files:**
- Modify: `services/pi-runtime/src/session-manager.ts`（extractSubagentReport :3337-3362、runSubagent 状态判定 :3311-3322）
- Modify: `services/pi-runtime/src/gate/subtask-ledger.ts`（SubtaskTerminalRecord 加 partial 字段）
- Modify: `services/pi-runtime/src/gate/subagent.ts`（SubagentOutcome 加 partial 字段，applyReportTruncation 透传点）
- Modify: `services/pi-runtime/src/metrics.ts`（report kind 指标）

**Interfaces:**
- Consumes: `SubagentStatus` 已含 `stream_interrupted`（Task 1）。
- Produces:
  - `extractSubagentReport` 返回 `{ report: string; partial: boolean }`（内部方法，改签名）。
  - `SubagentOutcome.partial?: boolean`（additive）。
  - `Metrics.observeSubagentReport(kind: "synthesis" | "partial" | "empty")`。

- [ ] **Step 1: 写失败测试——B8 断流报告提取不返回开场白**

在 `session-manager.subagent.integration.test.ts` 追加（通过反射调用私有方法，注入构造的 lane stub）：

```ts
test("P3：断流 transcript（开场白 + toolCall 无 synthesis）→ 报告不取开场白、partial=true", async () => {
	const { sm } = makeE2e(new Metrics(), []);
	const lane = {
		findEntries: async () => [
			{ role: "assistant", content: "我来先检查已派发的子代理状态，再决定后续路径。" },
			{ role: "assistant", content: [{ type: "toolCall", name: "web_search" }] },
			{ role: "toolResult", content: "tool result" },
		],
	};
	const extract = (sm as unknown as { extractSubagentReport: (l: typeof lane) => Promise<{ report: string; partial: boolean }> }).extractSubagentReport.bind(sm);
	const out = await extract(lane);
	assert.equal(out.partial, true, "断流应标 partial");
	assert.ok(!out.report.includes("我来先检查"), "开场白不应被当最终报告");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --import tsx --test services/pi-runtime/src/session-manager.subagent.integration.test.ts`
Expected: FAIL（当前返回 string 而非 `{report,partial}`，`out.partial` undefined）。

- [ ] **Step 3: 实现 extractSubagentReport 末条 synthesis + partial 判定**

改写 `extractSubagentReport`（:3337-3362）：

```ts
	/** P3：报告提取——取末条有实质内容的 assistant 文本；断流（尾部 toolCall 无 synthesis）标 partial。
	 *  开场白/过渡话术（短、无结构）不作为最终 report。 */
	private async extractSubagentReport(lane: AgentLane): Promise<{ report: string; partial: boolean }> {
		const entries = await lane
			.findEntries({ order: "newestFirst" }, this.context)
			.then((v) => (Array.isArray(v) ? v : []), () => []);
		const assistantTexts: string[] = [];
		let sawToolTail = false;
		for (const e of entries) {
			const entry = e as { role?: string; content?: unknown; message?: { role?: string; content?: unknown } } | null;
			if (!entry) continue;
			const role = entry.message?.role ?? entry.role;
			if (role === "toolResult" && !sawToolTail && assistantTexts.length === 0) sawToolTail = true;
			if (role !== "assistant") continue;
			const content = entry.message?.content ?? entry.content;
			const text = Array.isArray(content)
				? content.filter((p) => (p as { type?: string })?.type === "text").map((p) => (p as { text?: string })?.text ?? "").join("\n")
				: typeof content === "string" ? content : "";
			// 过滤纯 toolCall 块（无 text）
			if (text.trim()) assistantTexts.push(text.trim());
		}
		if (assistantTexts.length === 0) return { report: "", partial: true };
		// 取末条（newestFirst ⇒ 数组末尾是最早；首条是最新）。synthesis 应是最新的一条。
		const newest = assistantTexts[0]!;
		const looksLikeTransition = newest.length < 40 && /^(我来|我先|好的|收到|让我|后台)/.test(newest);
		if (looksLikeTransition && (assistantTexts.length === 1 || sawToolTail)) {
			// 只有开场白或过渡话术 + 尾部工具流 ⇒ 断流，无 synthesis
			return { report: "", partial: true };
		}
		return { report: newest, partial: false };
	}
```

同步修改 `runSubagent` 的调用点（:3310）：
```ts
			const { report: rawReport, partial } = await this.extractSubagentReport(lane);
			const { report, truncated } = applyReportTruncation(rawReport);
```
并把四个 return 分支都带上 `partial`（additive 字段）：
```ts
			if (sub.turnBudget.settled) return { report, turns, durationMs, status: "budget_exceeded", truncated, partial };
			if (timedOut) return { report, turns, durationMs, status: "timeout", truncated, partial };
			if (outcome.status === "completed") return { report, turns, durationMs, status: "completed", truncated, partial };
			return { report, turns, durationMs, status: "failed", truncated, partial };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --import tsx --test services/pi-runtime/src/session-manager.subagent.integration.test.ts`
Expected: PASS（B8 + 既有 e2e 全绿）。

- [ ] **Step 5: 透传 partial 到账本与 collect**

在 `subagent.ts` 的 `SubagentOutcome` 加 `partial?: boolean;`；在 `tryRun` 的 terminal 账本 append 加 `partial: outcome.partial === true ? true : undefined`；`collect()` 终态返回加 `partial`。在 `subtask-ledger.ts` 的 `SubtaskTerminalRecord` 与 `LedgerTerminalState` 加 `partial?: boolean`，`replay()` 写入 `partial: rec.partial`。在 `spawn-subagent.ts` 的 collect/spawn 返回加 `partial: r.partial === true ? true : undefined`（additive）。

- [ ] **Step 6: 写测试确认账本保留 partial**

在 `gate/subagent.test.ts` 追加：

```ts
it("P3：partial 透传进账本与 collect", async () => {
	const dir = mkdtempSync(join(tmpdir(), "coord-partial-"));
	const ledger = new SubtaskLedger(dir);
	const c = new SubagentCoordinator(ledger);
	c.attach({ runSubagent: async () => ({ report: "半截", turns: 1, durationMs: 1, status: "stream_interrupted", partial: true }) });
	const r = c.tryRun("k", "t");
	assert.ok(r.ok);
	await r.promise;
	const text = readFileSync(ledger.filePath, "utf8");
	assert.match(text, /"status":"stream_interrupted"/);
	assert.match(text, /"partial":true/);
	const got = c.collect(r.callId);
	assert.equal(got.status, "stream_interrupted");
	assert.ok("partial" in got && got.partial === true);
});
```

Run: `node --import tsx --test services/pi-runtime/src/gate/subagent.test.ts`
Expected: PASS。

- [ ] **Step 7: metrics report kind 指标**

在 `metrics.ts` 加字段 `private subagentReport = new Map<string, number>();`、方法 `observeSubagentReport(kind: "synthesis" | "partial" | "empty")`、render 输出 `pi_runtime_subagent_report_total{kind=...}`。在 `runSubagent` 计算完 `partial` 后调用 `this.metrics.observeSubagentReport(...)`（SessionManager 已有 metrics 引用——确认构造注入；若无则用可选链保护）。写 metrics 单测断言三种 kind 累加。

- [ ] **Step 8: 变异自检**

把 `extractSubagentReport` 改回原倒序取首条逻辑，确认 B8 RED；恢复。把账本 append 的 `partial` 删掉，确认 Step 6 的 `"partial":true` 断言 RED；恢复。

- [ ] **Step 9: Commit**

```bash
git add services/pi-runtime/src/session-manager.ts services/pi-runtime/src/gate/subagent.ts services/pi-runtime/src/gate/subagent.test.ts services/pi-runtime/src/gate/subtask-ledger.ts services/pi-runtime/src/tools/spawn-subagent.ts services/pi-runtime/src/metrics.ts
git commit -m "feat(subagent): P3 报告提取修复 + stream_interrupted + partial 透传 + 可观测"
```

---

### Task 6: 全量验证 + 静态门禁 + 类型检查

**Files:** 无新增（验证任务）。

- [ ] **Step 1: 跑全部相关测试**

Run:
```bash
export PATH="/Users/4seven/.nvm/versions/node/v24.13.0/bin:$PATH"
cd /Users/4seven/workspace/pi-lnk/.worktrees/fix-subagent-pending-barrier/services/pi-runtime
node --import tsx --test src/gate/subagent.test.ts src/gate/subagent-barrier.test.ts src/gate/plan-gate-wiring.test.ts src/gate/plan-gate.wiring.test.ts src/gate/subtask-ledger.test.ts src/tools/spawn-subagent.test.ts src/session-manager.subagent.integration.test.ts src/session-manager.plan-gate.test.ts src/session-manager.turn-budget.integration.test.ts
```
Expected: PASS，0 failing。

- [ ] **Step 2: 类型检查**

Run:
```bash
export PATH="/Users/4seven/.nvm/versions/node/v24.13.0/bin:$PATH"
cd /Users/4seven/workspace/pi-lnk/.worktrees/fix-subagent-pending-barrier
vue-tsc -b
```
Expected: 无新增类型错误（基线错误仅限陈旧 pi-agent-core 0.85.1 的 `isError`/`details` 缺失；CI 0.99.2 为类型权威）。

- [ ] **Step 3: 静态工具契约门禁**

Run: `node --import tsx scripts/verify-tool-contract.ts`（从 worktree 根）
Expected: PASS（新增 hook 用法符合 vendor 契约）。

- [ ] **Step 4: 全量变异汇总复核**

确认 Task 1/2/3/4/5 的所有变异点均验证过 RED 且已恢复，无遗留临时改动：`git diff --stat` 应为空（全部已 commit）。

- [ ] **Step 5: Commit（若门禁脚本需修正）**

仅在门禁暴露真实问题时提交修正，否则无 commit。

- [ ] **Step 6: 停在合并前**

CI 全绿后，按项目纪律**停在合并前**，等用户单独授权合并-部署-生产取证-复测。本 plan 交付到"实现完成 + 本地全绿"为止。
