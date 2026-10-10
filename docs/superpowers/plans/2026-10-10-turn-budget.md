# C2 turnBudget 轮次硬边界 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 pi-runtime 每个 run（一次用户 prompt 触发的 agentic loop）加轮次硬边界：软着陆 steer 提醒 + 超限硬停结算，env 可调（默认 120）+ off 整体关闭。

**Architecture:** 纯状态机放 `gate/turn-budget.ts`（per-run 内存态，挂 SessionEntry）；session-manager 的 `attachEvents` 在 `run_start`/`turn_start`/`run_end` 三点接线；硬停完全复用 `stallWatchdogTick` 的结算路径（userAborted + cancelRun + forceSettleLaneOperation）；软着陆走 vendor 原生 `lane.steer` 插话通道。零前端改动、零 SSE 改动、零 vendor patch。

**Tech Stack:** TypeScript (ESM, node:test + tsx)，vendored `@earendil-works/pi-agent-core` 0.85.1（faux provider 集成测试）。

**Spec:** `docs/superpowers/specs/2026-10-10-turn-budget-design.md`（v1.0.0，已合入 master `a3745f75`）

## Global Constraints

- **工作目录**：worktree `/Users/4seven/workspace/pi-lnk-wt-turn-budget`，分支 `feat/turn-budget`。主工作区 `feat/web-design-system-p0` 归前端窗口，**不得触碰**。
- **测试命令**：单文件 `cd services/pi-runtime && node --import tsx --test src/<file>.test.ts`；全量 `cd services/pi-runtime && pnpm test`；类型 `pnpm typecheck`。
- **git 纪律**：每条命令绝对路径 `cd`；**禁 `git add -A`**，只 add 显式路径。
- `vendor/` 目录禁止业务 patch（本次为纯自有层改动，无 vendor 触点）。
- kill switch 只有整体开关：`PI_RUNTIME_TURN_BUDGET=off` ⇒ 不计数、不 warn、不硬停（无半开语义）。
- env 值经 helm `--set-string` 管理（科学计数法事故先例）；`parsePositiveInt` 已用 `Number` 而非 `parseInt` 处理。
- ⭐ env 覆盖类测试必须取**低于默认**的值（预算测试用 3 / 8，不用 120 附近的值）。
- 不变面（spec §4，承诺不动）：SSE 协议 / 前端 / details 快照 / C1 注入 / C3 plan-gate / generation-gate / `stallWatchdogTick` 与 `forceSettleLaneOperation` 本体（C2 只是新增第三个调用方）。不新增表、端点、依赖。
- 软着陆文案固定：`轮次预算将尽（剩余约 10 轮），请尽快收尾并总结当前进展。`

## Review Focus

1. **compaction 误计数**：vendor `turn_start.runId = drive.operationId`（generation.ts:163），auto-compaction 是独立 operation ⇒ 异 runId 必须不计入。期望：压缩轮再多也不触发 warn/硬停。→ Task 3 单测「异 runId ignore」+ Task 4 wiring 测试 A（5 个 compaction 轮零 abort）。
2. **C3 followUp 共享窗口**：plan 确认后的 followUp 续轮属同一 run（同 operationId）⇒ 共享预算窗口，续轮继续计数而非清零。期望：followUp 把计数推向超限时照常硬停。→ Task 5 集成测试 4（plan-gate 骨架 + budget=3，`exceeded=1` 钉住续轮计入）。
3. **硬停时 steer 滞留 inbox**：warn 与超限之间 run 被中止，steer 由既有 drainAfterRun 排空（spec §5-3 不加新逻辑）。→ Task 5 集成测试 1 天然覆盖（warn 在 T1 消费、超限在 T4，run 以 aborted 收敛、无 error SSE）。
4. **结算期漂移**：硬停是 fire-and-forget，结算期间后续 turn_start 仍可能到达 ⇒ `settled` 闸后不得重复硬停，计数漂移无害。→ Task 3 单测「settled 后重复 turn_start 返回 count」。
5. **off 全旁路**：off 时 §3.1-3.3 全部旁路，零行为差异、零 metrics。→ Task 4 wiring 测试 B（20 轮超限零 abort 零 metrics）+ Task 5 集成测试 2（真实 run 正常完成）。

---

### Task 1: `turnBudget` 配置解析（runtime-config.ts）

**Files:**
- Modify: `services/pi-runtime/src/runtime-config.ts`
- Test: `services/pi-runtime/src/runtime-config.test.ts`

**Interfaces:**
- Produces: `DEFAULT_TURN_BUDGET = 120`；`turnBudget(raw: string | undefined): number | "off"`；`RuntimeConfig.turnBudget?: number | "off"`（可选字段，不打断既有测试的 config 字面量）。

- [ ] **Step 1: Write the failing test**

在 `runtime-config.test.ts` 末尾追加（import 行补 `turnBudget, DEFAULT_TURN_BUDGET`）：

```ts
test("turnBudget: 缺省 120", () => {
	assert.equal(turnBudget(undefined), DEFAULT_TURN_BUDGET);
});

test("turnBudget: 正整数直通", () => {
	assert.equal(turnBudget("8"), 8);
	assert.equal(turnBudget(" 120 "), 120);
});

test('turnBudget: "off" 大小写不敏感整体关闭', () => {
	for (const v of ["off", "OFF", "Off", " off "]) assert.equal(turnBudget(v), "off");
});

test("turnBudget: 非法值回落 120（0/负数/非数字/空串）", () => {
	for (const v of ["abc", "12abc", "0", "-5", ""]) {
		assert.equal(turnBudget(v), DEFAULT_TURN_BUDGET);
	}
});

test("loadRuntimeConfig 接线 PI_RUNTIME_TURN_BUDGET", () => {
	assert.equal(loadRuntimeConfig({}).turnBudget, 120);
	assert.equal(loadRuntimeConfig({ PI_RUNTIME_TURN_BUDGET: "8" }).turnBudget, 8);
	assert.equal(loadRuntimeConfig({ PI_RUNTIME_TURN_BUDGET: "off" }).turnBudget, "off");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/4seven/workspace/pi-lnk-wt-turn-budget/services/pi-runtime && node --import tsx --test src/runtime-config.test.ts`
Expected: FAIL（`turnBudget` 未导出）

- [ ] **Step 3: Write minimal implementation**

`runtime-config.ts`：`askUserTimeoutMs` 之后、`planGateEnabled` 之前加：

```ts
/** C2 turnBudget（spec docs/superpowers/specs/2026-10-10-turn-budget-design.md §3.4）。
 * 正整数 = per-run 轮次预算；字面量 off（大小写不敏感）= 整体关闭（不计数/warn/硬停）。
 * 延续 C1/C3 kill switch 惯例：只做整体开关，无半开语义。非法值回落默认。 */
export const DEFAULT_TURN_BUDGET = 120;

export function turnBudget(raw: string | undefined): number | "off" {
	if (raw !== undefined && raw.trim().toLowerCase() === "off") return "off";
	return parsePositiveInt(raw, DEFAULT_TURN_BUDGET);
}
```

`RuntimeConfig` 接口加可选字段（`stallWatchdogMs` 之后）：

```ts
	/**
	 * C2 turnBudget：per-run 轮次预算（硬边界）。正整数；"off" 整体关闭。
	 * 缺省 120（「不误伤正常复杂 run」约束下的偏紧值，上线后按 metrics 分布再收紧）。
	 */
	turnBudget?: number | "off";
```

`loadRuntimeConfig` 返回对象加（`stallWatchdogMs` 行后）：

```ts
		turnBudget: turnBudget(env.PI_RUNTIME_TURN_BUDGET),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/4seven/workspace/pi-lnk-wt-turn-budget/services/pi-runtime && node --import tsx --test src/runtime-config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/4seven/workspace/pi-lnk-wt-turn-budget && git add services/pi-runtime/src/runtime-config.ts services/pi-runtime/src/runtime-config.test.ts && git commit -m "feat(c2): turnBudget env 解析（默认 120 / off 关闭）"
```

---

### Task 2: metrics 两个 counter

**Files:**
- Modify: `services/pi-runtime/src/metrics.ts`
- Test: `services/pi-runtime/src/metrics.test.ts`

**Interfaces:**
- Produces: `Metrics.observeTurnBudgetWarned(): void`、`Metrics.observeTurnBudgetExceeded(): void`；render 输出 `pi_runtime_turn_budget_warned_total` / `pi_runtime_turn_budget_exceeded_total`（标量 counter，零样本也输出 `0`，同 `plan_proposed` 风格）。

- [ ] **Step 1: Write the failing test**

`metrics.test.ts` 追加：

```ts
test("C2 turnBudget 计数器：warn/exceeded 渲染", () => {
	const m = new Metrics();
	m.observeTurnBudgetWarned();
	m.observeTurnBudgetWarned();
	m.observeTurnBudgetExceeded();
	const text = m.render(0, "0.0.15");
	assert.match(text, /pi_runtime_turn_budget_warned_total 2/);
	assert.match(text, /pi_runtime_turn_budget_exceeded_total 1/);
});

test("C2 turnBudget 计数器：零样本渲染 0（标量 counter 语义）", () => {
	const m = new Metrics();
	const text = m.render(0, "0.0.15");
	assert.match(text, /pi_runtime_turn_budget_warned_total 0/);
	assert.match(text, /pi_runtime_turn_budget_exceeded_total 0/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/4seven/workspace/pi-lnk-wt-turn-budget/services/pi-runtime && node --import tsx --test src/metrics.test.ts`
Expected: FAIL（observe 方法不存在 → TypeError）

- [ ] **Step 3: Write minimal implementation**

`metrics.ts`：

字段区（`planGateBlocked` 声明后，:92 附近）：

```ts
	private turnBudgetWarned = 0; // C2 预算将尽 steer 提醒次数
	private turnBudgetExceeded = 0; // C2 超限硬停次数
```

方法区（`observePlanProposed` 附近，:269）：

```ts
	observeTurnBudgetWarned(): void {
		this.turnBudgetWarned += 1;
	}

	observeTurnBudgetExceeded(): void {
		this.turnBudgetExceeded += 1;
	}
```

render 块（`plan_gate_blocked` 输出块之后，:490 附近）：

```ts
	lines.push("# HELP pi_runtime_turn_budget_warned_total Turn-budget nearing-exhaustion steer warnings (C2).");
	lines.push("# TYPE pi_runtime_turn_budget_warned_total counter");
	lines.push(`pi_runtime_turn_budget_warned_total ${this.turnBudgetWarned}`);

	lines.push("# HELP pi_runtime_turn_budget_exceeded_total Runs hard-stopped by the turn budget (C2).");
	lines.push("# TYPE pi_runtime_turn_budget_exceeded_total counter");
	lines.push(`pi_runtime_turn_budget_exceeded_total ${this.turnBudgetExceeded}`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/4seven/workspace/pi-lnk-wt-turn-budget/services/pi-runtime && node --import tsx --test src/metrics.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/4seven/workspace/pi-lnk-wt-turn-budget && git add services/pi-runtime/src/metrics.ts services/pi-runtime/src/metrics.test.ts && git commit -m "feat(c2): turnBudget warned/exceeded 观测计数器"
```

---

### Task 3: `gate/turn-budget.ts` 纯状态机 + 单测

**Files:**
- Create: `services/pi-runtime/src/gate/turn-budget.ts`
- Test: `services/pi-runtime/src/gate/turn-budget.test.ts`

**Interfaces:**
- Produces（Task 4 消费）:
  - `createTurnBudgetState(): TurnBudgetState`
  - `turnBudgetRunStart(s: TurnBudgetState, runId: string): void`（重置窗口）
  - `turnBudgetRunEnd(s: TurnBudgetState): void`（清窗口标记）
  - `turnBudgetOnTurnStart(s: TurnBudgetState, runId: string | undefined, budget: number): "ignore" | "warn" | "exceed" | "count"`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * C2 turnBudget 状态机单测（spec §3.1-3.3 + §5 Review Focus 1/4）。
 * 计数铁律：只计 runId 与当前 run 一致的 turn_start（vendor turn_start.runId =
 * drive.operationId，generation.ts:163 —— compaction 独立 operation 自动排除）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	createTurnBudgetState,
	turnBudgetOnTurnStart,
	turnBudgetRunEnd,
	turnBudgetRunStart,
} from "./turn-budget.js";

test("异 runId（compaction/navigation）不计入", () => {
	const s = createTurnBudgetState();
	turnBudgetRunStart(s, "op-1");
	for (let i = 0; i < 10; i++) {
		assert.equal(turnBudgetOnTurnStart(s, "op-compaction", 3), "ignore");
	}
	assert.equal(s.count, 0, "压缩轮再多也不得推进计数");
});

test("无窗口（未 run_start / 已 run_end）不计入", () => {
	const s = createTurnBudgetState();
	assert.equal(turnBudgetOnTurnStart(s, "op-1", 3), "ignore");
	turnBudgetRunStart(s, "op-1");
	turnBudgetRunEnd(s);
	assert.equal(turnBudgetOnTurnStart(s, "op-1", 3), "ignore");
});

test("budget=3：首轮 warn（阈值预算-10 的字面语义）、第 4 轮 exceed", () => {
	const s = createTurnBudgetState();
	turnBudgetRunStart(s, "op-1");
	assert.equal(turnBudgetOnTurnStart(s, "op-1", 3), "warn");
	assert.equal(turnBudgetOnTurnStart(s, "op-1", 3), "count");
	assert.equal(turnBudgetOnTurnStart(s, "op-1", 3), "count");
	assert.equal(turnBudgetOnTurnStart(s, "op-1", 3), "exceed");
	assert.equal(s.count, 4);
});

test("budget=15：warn 恰好在第 5 轮（=budget-10）触发且仅一次", () => {
	const s = createTurnBudgetState();
	turnBudgetRunStart(s, "op-1");
	const actions = Array.from({ length: 16 }, () => turnBudgetOnTurnStart(s, "op-1", 15));
	assert.deepEqual(actions.filter((a) => a === "warn").length, 1);
	assert.equal(actions[4], "warn", "第 5 轮 = budget-10");
	assert.equal(actions[15], "exceed", "第 16 轮 > budget");
});

test("settled 闸：exceed 后重复 turn_start 返回 count（结算期漂移无害，Review Focus 4）", () => {
	const s = createTurnBudgetState();
	turnBudgetRunStart(s, "op-1");
	for (let i = 0; i < 5; i++) turnBudgetOnTurnStart(s, "op-1", 3);
	assert.equal(s.settled, true);
	assert.equal(turnBudgetOnTurnStart(s, "op-1", 3), "count", "不得重复 exceed");
	assert.equal(turnBudgetOnTurnStart(s, "op-1", 3), "count");
});

test("run 重启复位：warned/settled/count 全清（下一 run 从 0 起）", () => {
	const s = createTurnBudgetState();
	turnBudgetRunStart(s, "op-1");
	for (let i = 0; i < 5; i++) turnBudgetOnTurnStart(s, "op-1", 3);
	turnBudgetRunEnd(s);
	turnBudgetRunStart(s, "op-2");
	assert.equal(s.count, 0);
	assert.equal(s.warned, false);
	assert.equal(s.settled, false);
	assert.equal(turnBudgetOnTurnStart(s, "op-2", 3), "warn", "新 run 的 warn 独立判定");
});

test("防御：budget<=0 一律 ignore（配置层已保证正数，此处兜底）", () => {
	const s = createTurnBudgetState();
	turnBudgetRunStart(s, "op-1");
	assert.equal(turnBudgetOnTurnStart(s, "op-1", 0), "ignore");
	assert.equal(turnBudgetOnTurnStart(s, "op-1", -3), "ignore");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/4seven/workspace/pi-lnk-wt-turn-budget/services/pi-runtime && node --import tsx --test src/gate/turn-budget.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * C2 turnBudget 状态机（spec docs/superpowers/specs/2026-10-10-turn-budget-design.md §3.1-3.3）。
 * per-run 纯内存状态：挂在 SessionEntry 上，进程重启即失（§5-5：无播种需求）。
 *
 * 计数铁律（§3.1，本设计最重要的一条正确性判据）：只计 runId 与当前 run 一致的
 * turn_start。vendor turn_start.runId = drive.operationId（generation.ts:163），
 * auto-compaction/navigation 是独立 operation ⇒ runId 不同 ⇒ 自动排除。
 * 重试不计数由 vendor 保证：turn_start 仅 nextAttempt === 1 时发射（generation.ts:158）。
 */
export interface TurnBudgetState {
	/** 当前 run 的 runId（run_start 写入、run_end 清空）；undefined = 无活跃窗口。 */
	runId?: string;
	/** 当前 run 已计入的 turn 数。 */
	count: number;
	/** 软着陆提醒是否已发（每 run 至多一次，§3.2）。 */
	warned: boolean;
	/** 硬停是否已执行（每 run 至多一次，§3.3；结算期漂移闸）。 */
	settled: boolean;
}

export function createTurnBudgetState(): TurnBudgetState {
	return { count: 0, warned: false, settled: false };
}

export function turnBudgetRunStart(s: TurnBudgetState, runId: string): void {
	s.runId = runId;
	s.count = 0;
	s.warned = false;
	s.settled = false;
}

export function turnBudgetRunEnd(s: TurnBudgetState): void {
	s.runId = undefined;
}

export type TurnBudgetAction = "ignore" | "warn" | "exceed" | "count";

/**
 * turn_start 计数判定。返回值驱动 session-manager 接线的副作用：
 *   ignore → 异 runId（compaction 等）或无活跃窗口，不计入；
 *   warn   → 首次达到 budget-10，调用方发软着陆 steer（至多一次）；
 *   exceed → 超过 budget 且未结算过，调用方执行硬停；
 *   count  → 普通计数（含 settled 闸后的漂移轮——无害）。
 * exceed 判定优先于 warn：budget<10 时 warn 已在首轮触发过，防双触发。
 */
export function turnBudgetOnTurnStart(
	s: TurnBudgetState,
	runId: string | undefined,
	budget: number,
): TurnBudgetAction {
	if (budget <= 0) return "ignore";
	if (s.runId === undefined || runId === undefined || runId !== s.runId) return "ignore";
	s.count += 1;
	if (s.count > budget && !s.settled) {
		s.settled = true;
		return "exceed";
	}
	if (!s.warned && s.count >= budget - 10) {
		s.warned = true;
		return "warn";
	}
	return "count";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/4seven/workspace/pi-lnk-wt-turn-budget/services/pi-runtime && node --import tsx --test src/gate/turn-budget.test.ts`
Expected: PASS（7/7）

- [ ] **Step 5: Commit**

```bash
cd /Users/4seven/workspace/pi-lnk-wt-turn-budget && git add services/pi-runtime/src/gate/turn-budget.ts services/pi-runtime/src/gate/turn-budget.test.ts && git commit -m "feat(c2): turnBudget per-run 状态机（runId 排除 / warn 一次 / settled 闸）"
```

---

### Task 4: session-manager 接线（entry 字段 + 事件挂钩 + 硬停）+ wiring 测试

**Files:**
- Modify: `services/pi-runtime/src/session-manager.ts`（entry 接口 :181 区、entry 字面量 :859、attachEvents :1101-1157、新方法区放在 `stallWatchdogTick` :1367 之后）
- Test: `services/pi-runtime/src/session-manager.turn-budget.test.ts`（Create）

**Interfaces:**
- Consumes: Task 1 `DEFAULT_TURN_BUDGET`、Task 2 `observeTurnBudgetWarned/Exceeded`、Task 3 全部导出；既有 `forceSettleLaneOperation`（:2042，**本体不改**）、`describeQueueError`、`MAIN_LANE`。
- Produces: 无新导出（接线内聚于 SessionManager）。

- [ ] **Step 1: Write the failing test**

Create `services/pi-runtime/src/session-manager.turn-budget.test.ts`：

```ts
/**
 * C2 turnBudget 接线测试（spec §3.1-3.4 + §5 Review Focus 1/5）。
 * 手动派发 harness 事件（session-manager.test.ts makeEmittableHarnessFactory 同款），
 * 验证 attachEvents 三点接线与硬停副作用；端到端语义由
 * session-manager.turn-budget.integration.test.ts（faux provider 真实 run）钉住。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "./session-manager.js";
import { Metrics } from "./metrics.js";
import type { RuntimeConfig } from "./runtime-config.js";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-turn-budget-wiring-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

function baseConfig(): RuntimeConfig {
	return {
		dataRoot: TEST_ROOT,
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
		sessionsMaxBytes: 10 ** 12,
		sessionsMaxCount: 1000,
		compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
	};
}

/** 可手动派发 harness 事件 + prompt 挂起可取消的 fake harness（abort 计数可观测）。 */
function makeEmittable(opts: { turnBudget?: number | "off"; metrics?: Metrics }) {
	const handlers = new Map<string, (evt: { lane?: string; runId?: string }) => void>();
	let aborted = 0;
	const fakeHarnessFactory = async () => ({
		harness: {
			events: {
				on: (type: string, handler: (evt: { lane?: string; runId?: string }) => void) => {
					handlers.set(String(type), handler);
					return () => {};
				},
			},
			lane: async () => ({
				prompt: async (_t: unknown, _i: unknown, ctx: { abortSignal?: AbortSignal }) =>
					new Promise((_res, rej) => {
						ctx?.abortSignal?.addEventListener(
							"abort",
							() => {
								aborted += 1;
								rej(new Error("aborted"));
							},
							{ once: true },
						);
					}),
				// steer / inspectExecution / requestAbort / drive 缺省 undefined：
				// warn steer 与 forceSettle 走各自 fail-soft 分支（生产里它们必然成功）。
			}),
			close: async () => {},
		},
	}) as never;
	const sm = new SessionManager(
		[],
		"",
		undefined,
		fakeHarnessFactory,
		undefined,
		undefined,
		{ ...baseConfig(), turnBudget: opts.turnBudget },
		undefined,
		opts.metrics,
	);
	return { handlers, sm, getAborted: () => aborted };
}

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

test("wiring: 异 runId（compaction）不计数；同 runId 超限硬停且无 error 事件", async () => {
	const metrics = new Metrics();
	const { handlers, sm, getAborted } = makeEmittable({ turnBudget: 2, metrics });
	await sm.create("s-tb-wiring", {});
	const seen: string[] = [];
	sm.subscribe("s-tb-wiring", (e) => seen.push(e.type));
	void sm.prompt("s-tb-wiring", "hi");
	await tick();

	handlers.get("run_start")?.({ lane: "main", runId: "op-1" });
	// 5 个 compaction 轮（异 runId）：若被误计，第 3 个就会触发硬停
	for (let i = 0; i < 5; i++) handlers.get("turn_start")?.({ lane: "main", runId: "op-compaction" });
	await tick();
	assert.equal(getAborted(), 0, "compaction 轮不得触发硬停（Review Focus 1）");

	// 同 runId：第 1 轮 warn（budget=2 的阈值是负数 ⇒ 首轮即 warn），第 3 轮 exceed
	handlers.get("turn_start")?.({ lane: "main", runId: "op-1" });
	handlers.get("turn_start")?.({ lane: "main", runId: "op-1" });
	handlers.get("turn_start")?.({ lane: "main", runId: "op-1" });
	await tick(30);
	assert.equal(getAborted(), 1, "第 3 轮（>budget=2）应触发硬停 cancelRun");
	assert.deepEqual(seen.filter((t) => t === "error"), [], "硬停走 userAborted 语义，不得派发 error");
	const text = metrics.render(1, "test");
	assert.match(text, /pi_runtime_turn_budget_exceeded_total 1/);
	assert.match(text, /pi_runtime_turn_budget_warned_total 1/);
});

test("wiring: turnBudget=off 全旁路（20 轮超限也不硬停、零 metrics，Review Focus 5）", async () => {
	const metrics = new Metrics();
	const { handlers, sm, getAborted } = makeEmittable({ turnBudget: "off", metrics });
	await sm.create("s-tb-off", {});
	void sm.prompt("s-tb-off", "hi");
	await tick();
	handlers.get("run_start")?.({ lane: "main", runId: "op-1" });
	for (let i = 0; i < 20; i++) handlers.get("turn_start")?.({ lane: "main", runId: "op-1" });
	await tick();
	assert.equal(getAborted(), 0, "off 不得硬停");
	const text = metrics.render(1, "test");
	assert.match(text, /pi_runtime_turn_budget_exceeded_total 0/);
	assert.match(text, /pi_runtime_turn_budget_warned_total 0/);
});

test("wiring: run_end 后计数复位（下一 run 从 0 起，不得跨 run 累计）", async () => {
	const metrics = new Metrics();
	const { handlers, sm, getAborted } = makeEmittable({ turnBudget: 3, metrics });
	await sm.create("s-tb-reset", {});
	void sm.prompt("s-tb-reset", "hi");
	await tick();
	handlers.get("run_start")?.({ lane: "main", runId: "op-1" });
	handlers.get("turn_start")?.({ lane: "main", runId: "op-1" });
	handlers.get("turn_start")?.({ lane: "main", runId: "op-1" });
	handlers.get("run_end")?.({ lane: "main", runId: "op-1" });
	handlers.get("run_start")?.({ lane: "main", runId: "op-2" });
	handlers.get("turn_start")?.({ lane: "main", runId: "op-2" });
	handlers.get("turn_start")?.({ lane: "main", runId: "op-2" });
	await tick();
	assert.equal(getAborted(), 0, "第二个 run 独立计数（2 ≤ 3），不得硬停");
	assert.match(metrics.render(1, "test"), /pi_runtime_turn_budget_exceeded_total 0/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/4seven/workspace/pi-lnk-wt-turn-budget/services/pi-runtime && node --import tsx --test src/session-manager.turn-budget.test.ts`
Expected: FAIL（3 个用例全挂：`turnBudget` 配置无人读、事件无人接线）

- [ ] **Step 3: Write minimal implementation**

`session-manager.ts` 四处改动：

① import 区（runtime-config import 行补 `DEFAULT_TURN_BUDGET`，新增 gate/turn-budget import）：

```ts
import {
	createTurnBudgetState,
	turnBudgetOnTurnStart,
	turnBudgetRunEnd,
	turnBudgetRunStart,
	type TurnBudgetState,
} from "./gate/turn-budget.js";
```

② `SessionEntry` 接口加字段（`stallSettled?: boolean` 声明附近）：

```ts
	/** C2 turnBudget per-run 状态（run_start/turn_start/run_end 事件维护；纯内存，重启即失）。 */
	turnBudget: TurnBudgetState;
```

entry 字面量（:859 区，`activityStep: 0,` 之后）加：

```ts
			turnBudget: createTurnBudgetState(),
```

③ `attachEvents` 三点接线——在 `if (harnessType === "run_end")` 分支内补一行；`turn_start` 分支扩一行；新增 `run_start` 分支：

```ts
				if (harnessType === "run_start") {
					turnBudgetRunStart(entry.turnBudget, evt.runId ?? "");
				}
				if (harnessType === "run_end") {
					// …既有 observeLlmRunOutcome 保持不动…
					turnBudgetRunEnd(entry.turnBudget);
				}
				if (harnessType === "turn_start") {
					entry.activityStep = 0;
					this.turnBudgetTick(entry, evt.runId);
				}
```

④ 新方法区（`stallWatchdogTick` 方法之后）：

```ts
	// ── C2 turnBudget（spec 2026-10-10-turn-budget-design.md §3.1-3.3）──────────

	/** 预算解析：config 未配走默认 120；"off" 全旁路（不计数 / 不 warn / 不硬停）。 */
	private turnBudgetLimit(): number | "off" {
		return this.config.turnBudget ?? DEFAULT_TURN_BUDGET;
	}

	/** turn_start 计数入口。warn/exceed 的副作用全部 fail-soft，绝不影响事件分发主链路。 */
	private turnBudgetTick(entry: SessionEntry, runId: string | undefined): void {
		const budget = this.turnBudgetLimit();
		if (budget === "off") return;
		const action = turnBudgetOnTurnStart(entry.turnBudget, runId, budget);
		if (action === "warn") {
			this.metrics?.observeTurnBudgetWarned();
			void this.turnBudgetSteer(entry);
		} else if (action === "exceed") {
			this.turnBudgetHardStop(entry);
		}
	}

	/**
	 * §3.2 软着陆：vendor 原生插话通道（steer() 同款 lane 调用）。前端展示复用
	 * 既有「用户补充 · 插在本轮进行中」链路，零前端改动。每 run 至多一次由状态机保证。
	 */
	private async turnBudgetSteer(entry: SessionEntry): Promise<void> {
		try {
			const lane = await entry.harness.lane(MAIN_LANE, this.context);
			const res = await lane.steer(
				"轮次预算将尽（剩余约 10 轮），请尽快收尾并总结当前进展。",
				undefined,
				this.context,
			);
			if (!res.ok) {
				console.warn(
					`[pi-runtime] turn budget steer rejected: session=${entry.id}: ${describeQueueError(res.error)}`,
				);
			}
		} catch (err) {
			console.warn(
				`[pi-runtime] turn budget steer failed (fail-soft): session=${entry.id}: ` +
					`${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/**
	 * §3.3 硬停：与 stallWatchdogTick 完全同路径（userAborted + cancelRun + forceSettle），
	 * reason="turn_budget"。userAborted 语义 = 中止不是崩溃：不派发 error、不进错误率。
	 * 只结算一次由状态机 settled 闸保证（结算期后续 turn_start 漂移无害，§5-4）。
	 */
	private turnBudgetHardStop(entry: SessionEntry): void {
		entry.turnBudget.settled = true;
		const cancelRun = entry.cancelRun;
		entry.cancelRun = undefined;
		if (cancelRun) {
			entry.userAborted = true;
			try {
				cancelRun("turn_budget");
			} catch {
				/* 解不开也要继续走 force-settle */
			}
		}
		console.warn(
			`[pi-runtime] turn budget exceeded (${entry.turnBudget.count} turns), settling session=${entry.id}`,
		);
		this.metrics?.observeTurnBudgetExceeded();
		void this.forceSettleLaneOperation(entry)
			.then((settled) => {
				if (settled) entry.prompting = false;
			})
			.catch(() => {});
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/4seven/workspace/pi-lnk-wt-turn-budget/services/pi-runtime && node --import tsx --test src/session-manager.turn-budget.test.ts`
Expected: PASS（3/3）

- [ ] **Step 5: Run typecheck（SessionEntry 新必填字段会暴露所有构造点）**

Run: `cd /Users/4seven/workspace/pi-lnk-wt-turn-budget/services/pi-runtime && pnpm typecheck`
Expected: PASS（entry 字面量只有 :859 一处；若测试里有手搓 SessionEntry 会在此暴露，逐处补 `turnBudget: createTurnBudgetState()`）

- [ ] **Step 6: Commit**

```bash
cd /Users/4seven/workspace/pi-lnk-wt-turn-budget && git add services/pi-runtime/src/session-manager.ts services/pi-runtime/src/session-manager.turn-budget.test.ts && git commit -m "feat(c2): turnBudget 接线——run_start/turn_start/run_end 三点挂钩 + 超限硬停复用 watchdog 结算"
```

---

### Task 5: 集成测试（faux provider 真实 run）

**Files:**
- Test: `services/pi-runtime/src/session-manager.turn-budget.integration.test.ts`（Create）

**Interfaces:**
- Consumes: 真实 `AgentHarness` + faux provider（session-manager.plan-gate.test.ts 同骨架）；Task 4 接线经真实事件流生效。
- 说明：`nop` 工具是执行计数器；`sharedConfig()` 关 compaction/sweeper；预算取 3（⭐低于默认）。

- [ ] **Step 1: Write the failing test（预期直接 PASS——本任务验证端到端语义而非新代码；若红则 Task 4 接线有缺陷，修 Task 4）**

```ts
/**
 * C2 turnBudget 端到端集成测试（真 harness + faux 模型，骨架同 session-manager.plan-gate.test.ts）。
 * 覆盖 spec §6：预算=3 第 4 轮硬停 / warn 恰好一次 / off 全旁路 / run 间复位 / C3 followUp 共享窗口。
 * ⚠️ warn 的 steer 会注入下一轮上下文（vendor 边界消费）——脚本响应是顺序消费的，
 * 两种 vendor 消费形态（合并 vs 额外一代）下计数与断言均一致（计划里已推演）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { SessionManager, toSessionKey, type EventListener } from "./session-manager.js";
import { buildTodoTools, getTodoState, resetTodoStoreForTest } from "./tools/todo.js";
import { createProposePlanTool } from "./tools/propose-plan.js";
import { registerPlanGateHooks } from "./gate/plan-gate-wiring.js";
import { resetPlanState } from "./gate/plan-gate.js";
import { Metrics } from "./metrics.js";
import type { LnkpiTool } from "./tools/types.js";
import type { PendingToolRegistry } from "./pending-registry.js";
import type { RuntimeConfig } from "./runtime-config.js";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-turn-budget-int-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

function sharedConfig(turnBudget: number | "off"): RuntimeConfig {
	return {
		dataRoot: TEST_ROOT,
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
		sessionsMaxBytes: 10 ** 12,
		sessionsMaxCount: 1000,
		toolTiering: false,
		compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		turnBudget,
	};
}

let nopExecuted = 0;
const nopTool: LnkpiTool = {
	name: "fake_nop",
	label: "空操作（测试）",
	tier: "write_light",
	description: "test-only no-op tool",
	parameters: Type.Object({}),
	async execute() {
		nopExecuted += 1;
		return { content: [{ type: "text", text: "ok" }], details: undefined };
	},
};

/** 等 agent_end 到达（prompt fire-and-forget；硬停 run 经 forceSettle 也以 agent_end 收敛）。 */
function waitAgentEnd(sm: SessionManager, threadKey: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			sm.unsubscribe(threadKey, listener);
			reject(new Error("agent_end 等待超时"));
		}, 15_000);
		const listener: EventListener = (e) => {
			if (e.type === "agent_end") {
				clearTimeout(timer);
				sm.unsubscribe(threadKey, listener);
				resolve();
			}
		};
		sm.subscribe(threadKey, listener);
	});
}

function makeManager(turnBudget: number | "off", metrics: Metrics, responses: unknown[]) {
	const faux = fauxProvider();
	faux.setResponses(responses as never);
	const models = createModels();
	models.setProvider(faux.provider);
	const modelFactory = () => ({ models, model: faux.getModel(), providerId: faux.provider.id });
	const tools: LnkpiTool[] = [nopTool];
	return new SessionManager(tools, "", modelFactory, undefined, {}, undefined, sharedConfig(turnBudget), undefined, metrics);
}

test("集成: 预算=3 的 run 在第 4 轮硬停（exceeded=1、warn=1、无 error、agent_end 到达）", async () => {
	resetTodoStoreForTest();
	nopExecuted = 0;
	const metrics = new Metrics();
	const sm = makeManager(3, metrics, [
		fauxAssistantMessage([fauxToolCall("fake_nop", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("fake_nop", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("fake_nop", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("不应到达（T4 turn_start 处已硬停）", { stopReason: "stop" }),
	]);
	const threadKey = "s-tb-int-exceed";
	await sm.create(threadKey, { userId: "u1" });
	const seen: string[] = [];
	sm.subscribe(threadKey, (e) => seen.push(e.type));
	await sm.prompt(threadKey, "跑起来");
	await waitAgentEnd(sm, threadKey);

	assert.equal(nopExecuted, 3, "3 个工具轮执行；第 4 轮 turn_start 即硬停，模型不再被调用");
	assert.match(metrics.render(1, "test"), /pi_runtime_turn_budget_exceeded_total 1/);
	assert.match(metrics.render(1, "test"), /pi_runtime_turn_budget_warned_total 1/);
	assert.deepEqual(seen.filter((t) => t === "error"), [], "userAborted 语义：硬停不派发 error（Review Focus 3 一并覆盖）");
});

test("集成: turnBudget=off 全旁路——同样的 4 轮 run 正常完成", async () => {
	resetTodoStoreForTest();
	nopExecuted = 0;
	const metrics = new Metrics();
	const sm = makeManager("off", metrics, [
		fauxAssistantMessage([fauxToolCall("fake_nop", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("fake_nop", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("fake_nop", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done", { stopReason: "stop" }),
	]);
	const threadKey = "s-tb-int-off";
	await sm.create(threadKey, { userId: "u1" });
	await sm.prompt(threadKey, "跑起来");
	await waitAgentEnd(sm, threadKey);

	assert.equal(nopExecuted, 3);
	const text = metrics.render(1, "test");
	assert.match(text, /pi_runtime_turn_budget_exceeded_total 0/);
	assert.match(text, /pi_runtime_turn_budget_warned_total 0/);
});

test("集成: run 正常结束后下一 run 从 0 计数（且 warn 每 run 独立判定）", async () => {
	resetTodoStoreForTest();
	nopExecuted = 0;
	const metrics = new Metrics();
	const sm = makeManager(3, metrics, [
		// run1：2 轮（T1 工具 + T2 收尾），count=2，warn 在 T1
		fauxAssistantMessage([fauxToolCall("fake_nop", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("第一轮完成", { stopReason: "stop" }),
		// run2：再 2 轮——若跨 run 未复位，累计 4 > 3 会在 run2 第 2 轮硬停
		fauxAssistantMessage([fauxToolCall("fake_nop", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("第二轮完成", { stopReason: "stop" }),
	]);
	const threadKey = "s-tb-int-reset";
	await sm.create(threadKey, { userId: "u1" });
	await sm.prompt(threadKey, "第一个问题");
	await waitAgentEnd(sm, threadKey);
	await sm.prompt(threadKey, "第二个问题");
	await waitAgentEnd(sm, threadKey);

	assert.equal(nopExecuted, 2, "两个 run 各执行一次工具");
	assert.match(metrics.render(1, "test"), /pi_runtime_turn_budget_exceeded_total 0/, "run 间必须复位");
	assert.match(metrics.render(1, "test"), /pi_runtime_turn_budget_warned_total 2/, "warn 每 run 独立一次");
});

test("集成: C3 followUp 续轮共享同一预算窗口（Review Focus 2）", async () => {
	resetTodoStoreForTest();
	const key = toSessionKey("s-tb-int-followup");
	resetPlanState(key);
	const metrics = new Metrics();
	const registryStub = {
		waitForUser: async () => ({ status: "answered", answers: { plan_confirm: ["execute"] } }),
	} as unknown as PendingToolRegistry;

	const faux = fauxProvider();
	faux.setResponses([
		// T1：提方案（registry 立即 execute）→ count=1，warn（budget=3 阈值为负 ⇒ 首轮即 warn）
		fauxAssistantMessage(
			[fauxToolCall("propose_plan", { summary: "两步", steps: [{ content: "第一步" }, { content: "第二步" }] })],
			{ stopReason: "toolUse" },
		),
		// T2：收尾 → before_run_end 注入 followUp（两步 pending）
		fauxAssistantMessage("收到，开始执行", { stopReason: "stop" }),
		// T3：续轮完成清单（同 run、同 operationId ⇒ 继续计数 → count=3）
		fauxAssistantMessage(
			[fauxToolCall("todo_write", { todos: [{ content: "第一步", status: "completed" }, { content: "第二步", status: "completed" }] })],
			{ stopReason: "toolUse" },
		),
		// T4：再收尾 → turn_start 处 count=4 > 3 ⇒ 硬停（若窗口被错误清零则不会 exceed）
		fauxAssistantMessage("不应到达", { stopReason: "stop" }),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const modelFactory = () => ({ models, model: faux.getModel(), providerId: faux.provider.id });
	const tiers = new Map(
		[...buildTodoTools(), createProposePlanTool(registryStub, metrics)].map((t) => [t.name, t.tier]),
	);
	const sm = new SessionManager(
		[...buildTodoTools(), createProposePlanTool(registryStub, metrics)],
		"",
		modelFactory,
		undefined,
		{
			onSessionCreated(_sessionId, harness) {
				registerPlanGateHooks(harness, { planKey: _sessionId, tiers, metrics });
			},
		},
		undefined,
		sharedConfig(3),
		undefined,
		metrics,
	);
	const threadKey = "s-tb-int-followup";
	await sm.create(threadKey, { userId: "u1" });
	const seen: string[] = [];
	sm.subscribe(threadKey, (e) => seen.push(e.type));
	await sm.prompt(threadKey, "先出方案再干活");
	await waitAgentEnd(sm, threadKey);

	// followUp 轮确实发生（清单被续轮完成）
	const todos = getTodoState(key);
	assert.ok(todos.length === 2 && todos.every((i) => i.status === "completed"), "followUp 续轮应完成清单");
	// 续轮计入同一窗口：T4 超限硬停。若实现错误地把窗口清零/排除续轮，exceeded 会是 0
	assert.match(metrics.render(1, "test"), /pi_runtime_turn_budget_exceeded_total 1/, "followUp 续轮必须共享预算窗口");
	assert.match(metrics.render(1, "test"), /pi_runtime_turn_budget_warned_total 1/);
	assert.deepEqual(seen.filter((t) => t === "error"), []);
});
```

- [ ] **Step 2: Run to verify**

Run: `cd /Users/4seven/workspace/pi-lnk-wt-turn-budget/services/pi-runtime && node --import tsx --test src/session-manager.turn-budget.integration.test.ts`
Expected: PASS（4/4）。本任务无新产码；任何 RED 都指向 Task 4 接线缺陷（或 vendor 事件序列与推演不符——先打印事件序列定位，再回改 Task 4，不在本任务里加补丁逻辑）。

- [ ] **Step 3: Commit**

```bash
cd /Users/4seven/workspace/pi-lnk-wt-turn-budget && git add services/pi-runtime/src/session-manager.turn-budget.integration.test.ts && git commit -m "test(c2): turnBudget 端到端集成——硬停/off 旁路/run 复位/followUp 共享窗口"
```

---

### Task 6: spec 状态收口 + 全量回归

**Files:**
- Modify: `docs/superpowers/specs/2026-10-10-turn-budget-design.md`（状态行）

- [ ] **Step 1: spec 状态更新**

表头 `| 状态 | 已立项，未实现 |` → `| 状态 | 已实现（feat/turn-budget，PR 见合并记录） |`，版本行 `v1.0.0（draft-review）` → `v1.1.0（implemented）`。

- [ ] **Step 2: 全量回归（spec §6：stall watchdog、C1 todo-resume、C3 plan-gate、generation-gate 全量不回归）**

Run: `cd /Users/4seven/workspace/pi-lnk-wt-turn-budget/services/pi-runtime && pnpm typecheck && pnpm test`
Expected: typecheck 零错；全量测试通过（C3 基线 1258+ 新增）。特别留意：`session-manager.plan-gate.test.ts`、`session-manager.todo-resume.test.ts`、`gate/generation-gate.test.ts`、`metrics.*.test.ts`。

- [ ] **Step 3: Commit**

```bash
cd /Users/4seven/workspace/pi-lnk-wt-turn-budget && git add docs/superpowers/specs/2026-10-10-turn-budget-design.md && git commit -m "docs(c2): turnBudget spec 状态收口为已实现"
```

- [ ] **Step 4: 推分支开 PR**

```bash
cd /Users/4seven/workspace/pi-lnk-wt-turn-budget && https_proxy=socks5h://127.0.0.1:17890 HTTPS_PROXY=socks5h://127.0.0.1:17890 gh pr create --base master --head feat/turn-budget --title "feat(c2): turnBudget 轮次硬边界——软着陆 steer + 超限硬停" --body-file /tmp/c2-pr-body.md
```

（PR body 要点：spec 链接、四机制一段话、测试面清单、Review Focus 5 条各自的钉子、kill switch 用法 `PI_RUNTIME_TURN_BUDGET=off`。）
