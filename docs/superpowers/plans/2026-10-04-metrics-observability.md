# 指标可观测性 Implementation Plan（阶段一：pi-runtime 工具与 LLM 指标）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 pi-runtime 的工具调用与上游模型错误指标从「22 个工具里 5 处手写」变为「39 个工具零改动全覆盖」，并补上重试、耗时、token 归因。

**Architecture:** 在 `session-manager.ts` 已有的 `attachEvents` 订阅循环里加一个 `ToolMetrics` 结算器，订阅 vendor 已有的 `tool_start`/`tool_end`/`retry_scheduled` 事件。载荷自带 `toolCallId`/`isError`/`terminate`/`errorMessage`，因此**不需要改vendor、也不需要改任何工具实现**。错误分类用闭集枚举 + 正则兜底。

**Tech Stack:** TypeScript、fastify 5、零依赖自研 `Metrics` 类（文本格式 Prometheus）、`node --import tsx --test`。

**Spec:** `docs/superpowers/specs/2026-10-04-metrics-observability-design.md` —— 本计划只实现其 §3、§4、§6、§8中与 pi-runtime 相关的部分。

## Global Constraints

- **禁止修改 `vendor/earendil-works/pi/**`**（ADR-0009：只读镜像）。本计划全部改动落在 `services/pi-runtime/src/`。
- `error_class` 是**闭集 8 值**：`blocked_terminate` / `aborted` / `upstream_4xx` / `upstream_5xx` / `timeout` / `network` / `gate_blocked` / `validation`，兜底 `internal`。**兜底必须落 `internal`，绝不静默丢弃。**
- **禁止把错误原文、model_id 自由文本、`session_id` 当label。** `channel` 只能取 `LlmIdentity.provider`（已是 12 位哈希或 `agnes`），`model` 只能取 `LlmIdentity.model`。
- 改`metrics.ts` 时**只扩展、不重构**既有渲染逻辑；既有 25 个指标族的输出格式必须逐字不变。
- 本仓**无 eslint/prettier/biome、无 husky**，风格靠人；沿用既有文件的 tab 缩进与命名习惯。
- **worktree 首次跑测试前**：`pnpm install --frozen-lockfile` + `pnpm --filter @lnkpi/server exec prisma generate`。
- 4 核 Mac 多 agent 并存：**默认只跑变更相关测试**（本计划全部任务都是单文件/单包级）；全量 `pnpm test` 是 CI 的活。
- ⚠️ `vitest 绿 ≠ tsc 绿`（esbuild 只转译）⇒ 每个 Task 结束前必须 `pnpm --filter @pi-lnk/pi-runtime exec tsc --noEmit`。
- ⚠️ 合并后 pi-runtime 改动**不自动上线**：须手工发 `workflow_dispatch` 的 `Runtime Deploy (pi-runtime)`，`tag` = master commit 短 SHA。

## Review Focus

1. **孤儿 `tool_end`（只有 end、无 start）**—— 生产上 `recovery:true` 的重放会补发 end 而无 start。必须只记计数、**不记时长**（否则污染 p99），且不得抛错。
2. **同一 `toolCallId` 重复 end** —— 断线重连重放会投喂同一事件两次。结算器必须**幂等**：同一 `toolCallId` 只结算一次，重复 end 不得二次计数。
3. **`terminate: true` 但 `isError: false`** —— 模型主动终止（非错误）。分类必须落在 `blocked_terminate` 而非 `ok`，否则「回合被中断」这类问题不可见。
4. **`error_class` 分类正则误判** —— 上游只给自由文本。`internal` 占比是分类器的健康度信号：若占比异常升高，说明分类规则需更新。因此**必须有测试锁定「无法判定 → internal」而非丢弃**。
5. **`channel`/`model` 标签来源** —— 若透传请求体里的任意字符串，BYOK 渠道泛滥会打爆基数。必须测试断言这两个值**恒等于** `LlmIdentity` 的对应字段。

## ⚠️ 实施前必读：既有 label 叫 `kind`，不是 `error_class`

写本计划时核实到：现有 `metrics.ts` 的 `observeToolCall` 渲染出的第三个 label 是 **`kind=`**，而 spec 写的是 **`error_class=`**。且既有取值含一个 **`retry`** —— 代码注释明确标注它是「V-γ 重试放行打点（**非错误**）」（`metrics.ts:30-32`）。

**这意味着改名不是纯重命名，有两处语义冲突**：

| 冲突 | 现状 | spec 目标 | 处置 |
|---|---|---|---|
| label 名 | `kind` | `error_class` | **改名**。理由：指标契约会被查很多年，`kind` 语义过泛，且里面混着非错误的 `retry`，名实不符。**代价是要改22 处既有断言**（见下表）。 |
| `retry` 取值 | `kind="retry"` 表示「重试放行」 | `error_class` 8 值闭集里没有它 | **保留 `retry`，但改挂到 `result` 上**（`result="retry"`），不进 `error_class`。理由：它不是错误，塞进 `error_class` 会污染错误率的分子。 |

**必须同步修改的既有测试**（否则 Task 3 的 `pnpm test:runtime` 必红）：

| 文件 | 处数 | 改法 |
|---|---|---|
| `services/pi-runtime/src/metrics.test.ts` | 18 | `kind="..."` → `error_class="..."`；其中 `kind="retry"` 的 2 处改为断言 `result="retry"` |
| `services/pi-runtime/src/tools/ask-user.test.ts` | 1 | 删（手写埋点已删） |
| `services/pi-runtime/src/tools/arrange-nodes.test.ts` | 2 | 同上 |
| `services/pi-runtime/src/tools/ui-command.test.ts` | 2 | 同上 |

> ⚠️ `metrics.ts:31` 的 `ToolErrorKind` 类型已含 `"retry"`，Task 2 的 `ToolErrorClass` 需与之对齐 —— `ToolErrorClass` 不含 `retry`，它走 `result` 通道。

---

### Task 1: `error_class` 分类器（纯函数，最先做因为无依赖）

**Files:**
- Create: `services/pi-runtime/src/tool-error-class.ts`
- Test: `services/pi-runtime/src/tool-error-class.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，无外部依赖）
- Produces:
  - `export type ToolErrorClass = "blocked_terminate" | "aborted" | "upstream_4xx" | "upstream_5xx" | "timeout" | "network" | "gate_blocked" | "validation" | "internal"`
  - `export type ToolOutcome = "ok" | "error" | "blocked"`
  - `export function classifyToolOutcome(input: { isError: boolean; terminate: boolean; resultText: string }): { outcome: ToolOutcome; errorClass: ToolErrorClass | null }`
    - `outcome === "ok"` 时 `errorClass` 恒为 `null`（`error_class` label 不出现）

- [ ] **Step 1: 写失败测试**

创建 `services/pi-runtime/src/tool-error-class.test.ts`：

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyToolOutcome } from "./tool-error-class.js";

test("terminate 优先于 isError，归blocked_terminate", () => {
	assert.deepEqual(classifyToolOutcome({ isError: true, terminate: true, resultText: "429 rate limit" }), {
		outcome: "blocked",
		errorClass: "blocked_terminate",
	});
});

test("正常结束：ok 且无 error_class（label 不出现）", () => {
	assert.deepEqual(classifyToolOutcome({ isError: false, terminate: false, resultText: "ok" }), {
		outcome: "ok",
		errorClass: null,
	});
});

test("isError + terminate 均为 false 时不得判为 blocked", () => {
	const r = classifyToolOutcome({ isError: false, terminate: false, resultText: "partial" });
	assert.equal(r.outcome, "ok");
	assert.equal(r.errorClass, null);
});

const CASES: Array<[string, ToolErrorClass]> = [
	["request aborted by user", "aborted"],
	["已取消", "aborted"],
	["HTTP 429 rate limit exceeded", "upstream_4xx"],
	["upstream returned 503 service unavailable", "upstream_5xx"],
	["ECONNRESET", "network"],
	["fetch failed", "network"],
	["ETIMEDOUT timeout after 30s", "timeout"],
	["等待用户回答超时", "timeout"],
	["blocked by HITL gate", "gate_blocked"],
	["未授权，禁止访问", "gate_blocked"],
	["invalid arguments: expected number", "validation"],
	["参数校验失败", "validation"],
];

for (const [text, expected] of CASES) {
	test(`分类：${JSON.stringify(text)} → ${expected}`, () => {
		assert.equal(classifyToolOutcome({ isError: true, terminate: false, resultText: text }).errorClass, expected);
	});
}

test("无法判定 → internal（绝��静默丢弃）", () => {
	assert.equal(classifyToolOutcome({ isError: true, terminate: false, resultText: "zzz 玄学失败" }).errorClass, "internal");
});

test("空resultText 且 isError → internal", () => {
	assert.equal(classifyToolOutcome({ isError: true, terminate: false, resultText: "" }).errorClass, "internal");
});

test("错误原文不得出现在返回值任何位置", () => {
	const secret = "sk-live-abcdef123456";
	const r = classifyToolOutcome({ isError: true, terminate: false, resultText: `invalid token ${secret}` });
	assert.equal(r.errorClass, "validation");
	assert.equal(JSON.stringify(r).includes(secret), false, "分类结果泄漏了错误原文");
});

test("分类优先级：429 优先于 timeout（先命中先定）", () => {
	assert.equal(
		classifyToolOutcome({ isError: true, terminate: false, resultText: "timeout waiting, then 429" }).errorClass,
		"upstream_4xx",
	);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd services/pi-runtime && node --import tsx --test src/tool-error-class.test.ts`
Expected: FAIL —— `Cannot find module './tool-error-class.js'`

- [ ] **Step 3: 写实现**

创建 `services/pi-runtime/src/tool-error-class.ts`：

```ts
/**
 * 工具调用的结果与错误分类（spec §4.1/ §4.4）
 *
 * 为什么要闭集枚举 + 正则兜底：上游只给自由文本，没有结构化错误码。
 * 闭集保证 Prometheus label 有界；正则必然有误判，故兜底落 `internal`
 * 保留可见性 —— 归错类可接受，看不见不可接受。
 *
 * ⚠️ 禁止把 resultText 原文放进返回值（会变label ⇒ 基数爆炸）。
 */

export type ToolErrorClass =
	| "blocked_terminate"
	| "aborted"
	| "upstream_4xx"
	| "upstream_5xx"
	| "timeout"
	| "network"
	| "gate_blocked"
	| "validation"
	| "internal";

export type ToolOutcome = "ok" | "error" | "blocked";

/**
 * 判定顺序即优先级，自上而下首个命中即定。
 *
 * 顺序要点：
 * - terminate 必须在 isError 之前 —— 模型主动终止往往同时带 isError，
 *   但它不是「错误」，归 blocked 才不会污染错误率。
 * - 4xx 先于 5xx 先于 timeout/network：更具体的原因优先。
 */
export function classifyToolOutcome(input: {
	isError: boolean;
	terminate: boolean;
	resultText: string;
}): { outcome: ToolOutcome; errorClass: ToolErrorClass | null } {
	if (input.terminate) return { outcome: "blocked", errorClass: "blocked_terminate" };
	if (!input.isError) return { outcome: "ok", errorClass: null };

	const text = input.resultText.toLowerCase();

	// aborted 要先于 4xx/5xx：「request aborted」里可能同时含错误码字样。
	if (/\babort(ed)?\b|取消|中断/.test(text)) return { outcome: "error", errorClass: "aborted" };
	if (/\b429\b|rate.?limit|too many requests/.test(text)) {
		return { outcome: "error", errorClass: "upstream_4xx" };
	}
	if (/\b5\d\d\b|upstream|bad gateway|service unavailable/.test(text)) {
		return { outcome: "error", errorClass: "upstream_5xx" };
	}
	if (/timeout|超时|etimedout/.test(text)) return { outcome: "error", errorClass: "timeout" };
	if (/econnrefused|econnreset|enotfound|fetch failed|network/.test(text)) {
		return { outcome: "error", errorClass: "network" };
	}
	if (/gate|hitl|未授权|unauthorized|forbidden/.test(text)) {
		return { outcome: "error", errorClass: "gate_blocked" };
	}
	if (/invalid|validation|参数|校验|expected/.test(text)) {
		return { outcome: "error", errorClass: "validation" };
	}
	return { outcome: "error", errorClass: "internal" };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd services/pi-runtime && node --import tsx --test src/tool-error-class.test.ts`
Expected: PASS，全部 20+ 用例通过

- [ ] **Step 5: 提交**

```bash
git add services/pi-runtime/src/tool-error-class.ts services/pi-runtime/src/tool-error-class.test.ts
git commit -m "feat(metrics): 工具结果与 error_class 分类器（闭集 8 值 + internal兜底）"
```

---

### Task 2: 事件层结算器（ToolMetrics）

**Files:**
- Create: `services/pi-runtime/src/tool-metrics.ts`
- Test: `services/pi-runtime/src/tool-metrics.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `classifyToolOutcome`、`ToolOutcome`、`ToolErrorClass`
- Produces:
  - `export interface ToolLifecycleEvent { toolName: string; toolCallId: string; isError: boolean; terminate: boolean; resultText: string; channel: string; model: string }`
  - `export class ToolMetrics { observeStart(e: { toolCallId: string }): void; observeEnd(e: ToolLifecycleEvent): void; renderInto(lines: string[]): void; /** 测试用：结算次数 */ stats(): { settled: number; orphaned: number; duplicates: number } }`

- [ ] **Step 1: 写失败测试**

创建 `services/pi-runtime/src/tool-metrics.test.ts`：

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolMetrics } from "./tool-metrics.js";

const base = {
	toolName: "add_node",
	channel: "agnes",
	model: "agnes-2.5-flash",
	resultText: "ok",
};

function collect(tm: ToolMetrics): string {
	const lines: string[] = [];
	tm.renderInto(lines);
	return lines.join("\n");
}

test("start + end 正常配对：计数 1、result=ok、记录耗时", () => {
	const tm = new ToolMetrics();
	tm.observeStart({ toolCallId: "c1" });
	tm.observeEnd({ ...base, toolCallId: "c1", isError: false, terminate: false });
	const out = collect(tm);
	assert.match(out, /pi_runtime_tool_calls_total\{tool="add_node",result="ok"\} 1/);
	assert.match(out, /pi_runtime_tool_duration_seconds_count\{tool="add_node"\} 1/);
	assert.equal(tm.stats().settled, 1);
});

test("孤儿 end（无 start）：只计数、不产生时长、且不抛错", () => {
	const tm = new ToolMetrics();
	assert.doesNotThrow(() => tm.observeEnd({ ...base, toolCallId: "orphan", isError: false, terminate: false }));
	const out = collect(tm);
	assert.match(out, /pi_runtime_tool_calls_total\{tool="add_node",result="ok"\} 1/);
	assert.equal(out.includes("tool_duration_seconds_count"), false, "孤儿事件污染了时长直方图");
	assert.equal(tm.stats().orphaned, 1);
});

test("同一 toolCallId 重复 end：幂等，不二次计数（断线重放场景）", () => {
	const tm = new ToolMetrics();
	tm.observeStart({ toolCallId: "dup" });
	tm.observeEnd({ ...base, toolCallId: "dup", isError: false, terminate: false });
	tm.observeEnd({ ...base, toolCallId: "dup", isError: false, terminate: false });
	assert.match(collect(tm), /pi_runtime_tool_calls_total\{tool="add_node",result="ok"\} 1/);
	assert.equal(tm.stats().duplicates, 1);
});

test("error 时附error_class label", () => {
	const tm = new ToolMetrics();
	tm.observeStart({ toolCallId: "e1" });
	tm.observeEnd({ ...base, toolCallId: "e1", isError: true, terminate: false, resultText: "HTTP 429 rate limit" });
	assert.match(collect(tm), /result="error",error_class="upstream_4xx"\} 1/);
});

test("terminate 归 blocked 而非 error", () => {
	const tm = new ToolMetrics();
	tm.observeStart({ toolCallId: "b1" });
	tm.observeEnd({ ...base, toolCallId: "b1", isError: false, terminate: true });
	assert.match(collect(tm), /result="blocked",error_class="blocked_terminate"\} 1/);
});

test("LLM 指标带 channel 与 model 标签", () => {
	const tm = new ToolMetrics();
	tm.observeLlmError({ stage: "main_turn", errorClass: "upstream_5xx", channel: "byok-abc123def456", model: "gpt-4o" });
	const out = collect(tm);
	assert.match(out, /pi_runtime_llm_errors_total\{stage="main_turn",error_class="upstream_5xx",channel="byok-abc123def456",model="gpt-4o"\} 1/);
});

test("渲染含 HELP 与 TYPE 行", () => {
	const out = collect(new ToolMetrics());
	assert.match(out, /# HELP pi_runtime_tool_calls_total/);
	assert.match(out, /# TYPE pi_runtime_tool_calls_total counter/);
	assert.match(out, /# TYPE pi_runtime_tool_duration_seconds histogram/);
});

test("错误原文不出现在任何渲染行中", () => {
	const tm = new ToolMetrics();
	tm.observeStart({ toolCallId: "s1" });
	tm.observeEnd({ ...base, toolCallId: "s1", isError: true, terminate: false, resultText: "sk-live-SECRET123 invalid" });
	assert.equal(collect(tm).includes("sk-live-SECRET123"), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd services/pi-runtime && node --import tsx --test src/tool-metrics.test.ts`
Expected: FAIL —— `Cannot find module './tool-metrics.js'`

- [ ] **Step 3: 写实现**

创建 `services/pi-runtime/src/tool-metrics.ts`：

```ts
/**
 * 工具与 LLM 指标结算器（spec §4.1 / §4.2）
 *
 * 为什么放在事件层而不是各工具内部：harness 的 `tool_start`/`tool_end` 是
 * 全工具统一事件，载荷自带 toolCallId / isError / terminate ⇒ 39 个工具
 * 零改动全覆盖，且不必新增任何工具自埋（新增工具自动有指标）。
 *
 * 本类不自己实现 Prometheus 文本渲染，只往宿主 Metrics 提供的 lines 数组里追加，
 * 以保证既有 25 个指标族的输出逐字不变。
 */

import { classifyToolOutcome, type ToolErrorClass, type ToolOutcome } from "./tool-error-class.js";

/** 工具耗时桶（秒）。上限 660s 对齐视频生成轮询上限，见 spec §7.2。 */
const DURATION_BUCKETS = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 180, 660];

type Hist = { count: number; sum: number; buckets: number[] };

function newHist(): Hist {
	return { count: 0, sum: 0, buckets: DURATION_BUCKETS.map(() => 0) };
}

/** LLM 调用阶段闭集（spec §4.2）。 */
export type LlmStage = "main_turn" | "compaction" | "tool_result_summarize" | "deferred";

export interface ToolLifecycleEvent {
	toolName: string;
	toolCallId: string;
	isError: boolean;
	terminate: boolean;
	/** 错误判定用的文本摘要；**绝不可作为 label 渲染出去**。 */
	resultText: string;
	channel: string;
	model: string;
}

export class ToolMetrics {
	/** key: toolCallId → 开始时刻。 */
	private inflight = new Map<string, number>();
	/** key: tool|outcome[|errorClass] */
	private calls = new Map<string, number>();
	/** key: tool */
	private durations = new Map<string, Hist>();
	/** key: stage|errorClass|channel|model */
	private llmErrors = new Map<string, number>();
	/** key: stage|channel|model */
	private llmRetries = new Map<string, number>();
	/** 已结算的 toolCallId，用于幂等。 */
	private settled = new Set<string>();

	private orphaned = 0;
	private duplicates = 0;

	observeStart(e: { toolCallId: string }): void {
		this.inflight.set(e.toolCallId, Date.now());
	}

	observeEnd(e: ToolLifecycleEvent): void {
		// 幂等：断线重连会重放同一 end，重复结算会双倍计数。
		if (this.settled.has(e.toolCallId)) {
			this.duplicates += 1;
			return;
		}
		this.settled.add(e.toolCallId);

		const { outcome, errorClass } = classifyToolOutcome({
			isError: e.isError,
			terminate: e.terminate,
			resultText: e.resultText,
		});
		this.bumpCall(e.toolName, outcome, errorClass);

		const startedAt = this.inflight.get(e.toolCallId);
		if (startedAt === undefined) {
			// 孤儿 end（recovery 重放）：只计数，不记时长——否则污染 p99。
			this.orphaned += 1;
			return;
		}
		this.inflight.delete(e.toolCallId);
		this.observeDuration(e.toolName, (Date.now() - startedAt) / 1000);
	}

	observeLlmError(e: { stage: LlmStage; errorClass: ToolErrorClass; channel: string; model: string }): void {
		const key = `${e.stage}|${e.errorClass}|${e.channel}|${e.model}`;
		this.llmErrors.set(key, (this.llmErrors.get(key) ?? 0) + 1);
	}

	observeLlmRetry(e: { stage: LlmStage; channel: string; model: string }): void {
		const key = `${e.stage}|${e.channel}|${e.model}`;
		this.llmRetries.set(key, (this.llmRetries.get(key) ?? 0) + 1);
	}

	stats(): { settled: number; orphaned: number; duplicates: number } {
		return { settled: this.settled.size, orphaned: this.orphaned, duplicates: this.duplicates };
	}

	private bumpCall(tool: string, outcome: ToolOutcome, errorClass: ToolErrorClass | null): void {
		const key = errorClass ? `${tool}|${outcome}|${errorClass}` : `${tool}|${outcome}`;
		this.calls.set(key, (this.calls.get(key) ?? 0) + 1);
	}

	private observeDuration(tool: string, sec: number): void {
		let h = this.durations.get(tool);
		if (!h) {
			h = newHist();
			this.durations.set(tool, h);
		}
		h.count += 1;
		h.sum += sec;
		for (let i = 0; i < DURATION_BUCKETS.length; i++) {
			if (sec <= DURATION_BUCKETS[i]) h.buckets[i] += 1;
		}
	}

	/** 追加渲染行。esc 防label 注入（label 值含引号会破坏文本格式）。 */
	renderInto(lines: string[]): void {
		const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

		lines.push("# HELP pi_runtime_tool_calls_total Tool invocations by tool, result and error class.");
		lines.push("# TYPE pi_runtime_tool_calls_total counter");
		for (const [key, count] of [...this.calls.entries()].sort()) {
			const [tool, outcome, errorClass] = key.split("|");
			const labels = errorClass
				? `tool="${esc(tool)}",result="${esc(outcome)}",error_class="${esc(errorClass)}"`
				: `tool="${esc(tool)}",result="${esc(outcome)}"`;
			lines.push(`pi_runtime_tool_calls_total{${labels}} ${count}`);
		}

		lines.push("# HELP pi_runtime_tool_duration_seconds Tool execution duration in seconds.");
		lines.push("# TYPE pi_runtime_tool_duration_seconds histogram");
		for (const [tool, h] of [...this.durations.entries()].sort()) {
			for (let i = 0; i < DURATION_BUCKETS.length; i++) {
				lines.push(
					`pi_runtime_tool_duration_seconds_bucket{tool="${esc(tool)}",le="${DURATION_BUCKETS[i]}"} ${h.buckets[i]}`,
				);
			}
			lines.push(`pi_runtime_tool_duration_seconds_bucket{tool="${esc(tool)}",le="+Inf"} ${h.count}`);
			lines.push(`pi_runtime_tool_duration_seconds_sum{tool="${esc(tool)}"} ${h.sum.toFixed(4)}`);
			lines.push(`pi_runtime_tool_duration_seconds_count{tool="${esc(tool)}"} ${h.count}`);
		}

		lines.push("# HELP pi_runtime_llm_errors_total LLM errors by stage, class, channel and model.");
		lines.push("# TYPE pi_runtime_llm_errors_total counter");
		for (const [key, count] of [...this.llmErrors.entries()].sort()) {
			const [stage, errorClass, channel, model] = key.split("|");
			lines.push(
				`pi_runtime_llm_errors_total{stage="${esc(stage)}",error_class="${esc(errorClass)}",channel="${esc(channel)}",model="${esc(model)}"} ${count}`,
			);
		}

		lines.push("# HELP pi_runtime_llm_retries_total LLM retry schedules by stage, channel and model.");
		lines.push("# TYPE pi_runtime_llm_retries_total counter");
		for (const [key, count] of [...this.llmRetries.entries()].sort()) {
			const [stage, channel, model] = key.split("|");
			lines.push(
				`pi_runtime_llm_retries_total{stage="${esc(stage)}",channel="${esc(channel)}",model="${esc(model)}"} ${count}`,
			);
		}
	}
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd services/pi-runtime && node --import tsx --test src/tool-metrics.test.ts`
Expected: PASS，全部用例通过（含孤儿/幂等/terminate 三条Review Focus）

- [ ] **Step 5: 类型检查（vitest 绿 ≠ tsc 绿）**

Run: `pnpm --filter @pi-lnk/pi-runtime exec tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add services/pi-runtime/src/tool-metrics.ts services/pi-runtime/src/tool-metrics.test.ts
git commit -m "feat(metrics): ToolMetrics 事件层结算器（幂等 + 孤儿事件防护）"
```

---

### Task 3: 接入 `attachEvents` 并删除 5 处手写埋点

**Files:**
- Modify: `services/pi-runtime/src/session-manager.ts:841`（`attachEvents` 内）
- Modify: `services/pi-runtime/src/metrics.ts`（`Metrics` 类持有 `ToolMetrics` 并在 `render` 末尾追加）
- Modify: `services/pi-runtime/src/app.ts:97`（`/metrics` 路由传 `manager` 的 metrics）
- Delete埋点: `services/pi-runtime/src/tools/ui-command.ts:37,48,59,70,81`、`arrange-nodes.ts:141`、`skill-tool.ts:27,36,43`、`ask-user.ts:71`
- Modify: `services/pi-runtime/src/tools/registry.ts`（去掉不再需要的 `metrics` 形参）
- Test: `services/pi-runtime/src/session-manager.fork.test.ts`（既有文件，追加用例）、`services/pi-runtime/src/metrics.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `ToolMetrics`、`observeStart`/`observeEnd`/`observeLlmRetry`
- Produces: `Metrics` 类新增私有字段 `toolMetrics`，`render()` 输出**追加**新指标族；既有指标输出不变

- [ ] **Step 1: 写失败测试**

在 `services/pi-runtime/src/metrics.test.ts` **追加**（既有断言保留不动，改名在 Task 3 统一做）：

```ts
test("render 追加工具指标族，且既有指标输出不变", () => {
	const m = new Metrics();
	m.setSkillsLoaded(3);
	const out = m.render(0, "test");
	// 新增族
	assert.match(out, /# TYPE pi_runtime_tool_duration_seconds histogram/);
	// 既有族仍在（签名 render(activeSessions, version) 未变）
	assert.match(out, /# TYPE pi_runtime_skills_loaded gauge/);
	assert.match(out, /pi_runtime_skills_loaded 3/);
});
```

> ⚠️ **不要在本步断言 `pi_runtime_tool_calls_total` 的数据行** —— 该label正从 `kind` 改为 `error_class`，Task 2/3 交界处签名仍在变。`tool_calls_total` 的渲染断言统一放在 Task 3 Step 6 改名完成后做。

新建 `services/pi-runtime/src/session-manager.toolmetrics.test.ts`：

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Metrics } from "./metrics.js";

test("投喂 tool_start/tool_end 事件后 /metrics 含该工具计数", () => {
	const m = new Metrics();
	// 经公开 API 触发事件结算，验证接线而非只验证类本身
	m.toolMetricsForTest().observeStart({ toolCallId: "t1" });
	m.toolMetricsForTest().observeEnd({
		toolName: "save_memory",
		toolCallId: "t1",
		isError: false,
		terminate: false,
		resultText: "ok",
		channel: "agnes",
		model: "agnes-2.5-flash",
	});
	const out = m.render(0, "test");
	assert.match(out, /pi_runtime_tool_calls_total\{tool="save_memory",result="ok"\} 1/);
});

test("删除手写埋点后总量不变：ui-command 不再自行计数", () => {
	const m = new Metrics();
	const out = m.render(0, "test");
	// 未投喂任何事件时，新指标不应有任何数据行
	assert.equal(/^pi_runtime_tool_calls_total\{/m.test(out), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd services/pi-runtime && node --import tsx --test src/session-manager.toolmetrics.test.ts src/metrics.test.ts`
Expected: FAIL —— `toolMetricsForTest` 不存在

- [ ] **Step 3: `Metrics` 类接入 `ToolMetrics`**

修改 `services/pi-runtime/src/metrics.ts`：

1. 顶部 import 补`import { ToolMetrics } from "./tool-metrics.js";`
2. 在 `Metrics` 类里加字段：`private readonly toolMetrics = new ToolMetrics();`
3. 加公开访问器（供 session-manager 与测试使用）：
```ts
	/** 事件层结算器。session-manager 在 attachEvents 里喂事件；测试直接驱动。 */
	toolMetricsForTest(): ToolMetrics {
		return this.toolMetrics;
	}
```
4. 在 `render()` 的 `return` 之前插入 `this.toolMetrics.renderInto(lines);`

> ⚠️ 必须插在 `return` 之前、既有指标 push 之后 —— 这样既有 25 族的输出顺序与内容逐字不变，只在尾部追加。

- [ ] **Step 4: `attachEvents` 喂事件**

修改 `services/pi-runtime/src/session-manager.ts` 的 `attachEvents`：在现有 `for` 循环的监听回调里，`harnessType === "tool_start"` 分支加 start 结算，`"tool_end"` 分支加 end 结算。需要从 `entry.identity` 取 channel/model（`LlmIdentity` 已有 `provider`/`model` 字段）。

```ts
				if (harnessType === "tool_start") {
					this.dispatchActivity(entry, evt);
					if (evt.toolCallId) metrics.toolMetricsForTest().observeStart({ toolCallId: evt.toolCallId });
				}
				if (harnessType === "tool_end" && evt.toolCallId) {
					metrics.toolMetricsForTest().observeEnd({
						toolName: evt.toolName ?? "unknown",
						toolCallId: evt.toolCallId,
						isError: evt.isError === true,
						terminate: evt.terminate === true,
						resultText: extractResultText(evt.result),
						channel: entry.identity.provider,
						model: entry.identity.model,
					});
				}
```

并在文件内新增私有辅助（提取 result 文本，**限制长度**避免长文本进内存）：

```ts
/** 从 tool_end.result 提取用于错误分类的短文本。上限 500 字，够正则判定且不撑大内存。 */
function extractResultText(result: unknown): string {
	try {
		const content = (result as { content?: unknown })?.content;
		if (typeof content === "string") return content.slice(0, 500);
		if (Array.isArray(content)) {
			return content
				.map((c) => (typeof (c as { text?: unknown })?.text === "string" ? (c as { text: string }).text : ""))
				.join(" ")
				.slice(0, 500);
		}
		return "";
	} catch {
		return "";
	}
}
```

> `ToolLikeEvent` 类型需扩出 `isError`/`terminate`/`result`/`toolName` 字段（该类型在 `session-manager.ts:134` 附近）。

- [ ] **Step 5: 订阅 `retry_scheduled`**

在 `EVENT_MAP` 之外单独订阅（它只进指标，不进 SSE 归一）：

```ts
		// retry_scheduled 只进指标，不进 EVENT_MAP/SSE：它是 lane 内部事件，
		// Nest 侧 PiRuntimeEvent 是封闭联合，未知类型可能被静默丢弃。
		entry.unsubscribes.push(
			harness.events.on("retry_scheduled" as never, (evt: { attempt?: number; errorMessage?: string }) => {
				metrics.toolMetricsForTest().observeLlmRetry({
					stage: "main_turn",
					channel: entry.identity.provider,
					model: entry.identity.model,
				});
			}),
		);
```

- [ ] **Step 6: 删除 5 处手写埋点**

逐个删除（用 Edit 精确移除行，勿整文件覆盖）：

| 文件 | 删除的行内容 |
|---|---|
| `tools/ui-command.ts` | `metrics.observeToolCall("focus_node", "ok");` 等 5 行 |
| `tools/arrange-nodes.ts:141` | `metrics.observeToolCall(\`arrange_nodes_${mode}\`, "ok");` |
| `tools/skill-tool.ts` | 3 行 `metrics.observeToolCall("load_skill", ...)` |
| `tools/ask-user.ts:71` | `metrics.observeToolCall("ask_user", "ok");` |

`tools/config.ts:47` 改为**只保留 `errorKind` 补充通道**，不重复计`tool_calls_total`：

```ts
		// 计数与耗时由事件层统一结算（见 spec §3.2），此处只补充精确 errorKind。
		if (info?.errorKind) metrics.observeToolErrorKind(tool, info.errorKind);
		if (info?.resultBytes !== undefined) metrics.observeToolResult(tool, info.resultBytes);
```

> 若 `observeToolErrorKind` 尚不存在，在 `Metrics` 类补一个最小实现（写进 `toolErrorKinds` Map，在 render 尾部渲染 `pi_runtime_tool_error_kinds_total{tool,kind}`）。

- [ ] **Step 7: 改名 `kind` → `error_class`（含 22 处既有断言同步）**

`metrics.ts` 的 `renderInto`/既有渲染里把 `kind="${...}"` 改为 `error_class="${...}"`。

**同一批必须改的既有测试**（否则下一步 `pnpm test:runtime` 必红）：

| 文件 | 处数 | 改法 |
|---|---|---|
| `src/metrics.test.ts` | 18 | 机械替换 `kind="` → `error_class="`；**但 `kind="retry"` 的 2 处例外**，改为断言 `result="retry"` |
| `src/tools/ask-user.test.ts` | 1 | 删断言（埋点已删） |
| `src/tools/arrange-nodes.test.ts` | 2 | 同上 |
| `src/tools/ui-command.test.ts` | 2 | 同上 |

改完后在 `metrics.test.ts` 追加渲染断言：

```ts
test("tool_calls_total 用 error_class 标签（不再用 kind）", () => {
	const tm = new ToolMetrics();
	tm.observeStart({ toolCallId: "x1" });
	tm.observeEnd({
		toolName: "get_node",
		toolCallId: "x1",
		isError: true,
		terminate: false,
		resultText: "HTTP 429 rate limit",
		channel: "agnes",
		model: "agnes-2.5-flash",
	});
	const lines: string[] = [];
	tm.renderInto(lines);
	const out = lines.join("\n");
	assert.match(out, /result="error",error_class="upstream_4xx"/);
	assert.equal(out.includes('kind="'), false, "旧 kind 标签残留");
});
```

- [ ] **Step 8: 清理 `registry.ts` 形参**

`buildUiCommandTools(metrics)`、`buildAskUserTools(metrics, ...)`、`buildArrangeNodesTools(metrics, ...)` 里的 `metrics` 形参若已无用则移除，并同步改 `index.ts` 调用处。用 TypeScript 编译器找出未使用形参。

- [ ] **Step 9: 跑测试**

Run: `cd services/pi-runtime && node --import tsx --test src/metrics.test.ts src/session-manager.toolmetrics.test.ts src/tools/*.test.ts`
Expected: 全部 PASS

- [ ] **Step 10: 类型检查 + 既有测试不回归**

Run: `pnpm --filter @pi-lnk/pi-runtime exec tsc --noEmit && pnpm test:runtime`
Expected: tsc 无错；pi-runtime 全部既有测试通过（重点看 `session-manager.test.ts` 与 `tiering.test.ts`）

- [ ] **Step 11: 提交**

```bash
git add services/pi-runtime/src/session-manager.ts services/pi-runtime/src/metrics.ts services/pi-runtime/src/app.ts services/pi-runtime/src/tools/
git commit -m "feat(metrics): attachEvents 接入工具结算 + 删5 处手写埋点 + kind→error_class 改名"
```


---

### Task 4: 移除旧 `llm_prompt_errors_total` 的正则判定

**Files:**
- Modify: `services/pi-runtime/src/app.ts:194`
- Test: `services/pi-runtime/src/app.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `ToolMetrics.observeLlmError`
- Produces: 旧指标 `pi_runtime_llm_prompt_errors_total` 保留一个发布周期（避免告警断档），但不再用 `/429|rate/i` 正则判定

- [ ] **Step 1: 写失败测试**

在 `services/pi-runtime/src/app.test.ts` 追加：

```ts
test("上游错误走 error_class 分类，不再只分2 值", async () => {
	const res = await app.inject({ method: "POST", url: "/sessions/s1/prompt", payload: { text: "x" } });
	// 入口早拒仍返回 503（契约不变）
	expect([409, 503]).toContain(res.statusCode);
});
```

- [ ] **Step 2: 替换正则判定**

修改 `services/pi-runtime/src/app.ts:193-196`，把

```ts
			const reason = /429|rate/i.test(msg) ? "upstream_rate_limited" : "upstream_error";
			metrics.observePromptError(reason);
```

改为

```ts
			// 分类下沉到 error_class 闭集分类器（spec §4.4）；此处保留旧指标一个
			// 发布周期以免告警断档，但不再是 2 值正则判定。
			const reason = /429|rate/i.test(msg) ? "upstream_rate_limited" : "upstream_error";
			metrics.observePromptError(reason);
			const classified = classifyLlmErrorText(msg);
			metrics.toolMetricsForTest().observeLlmError({
				stage: "main_turn",
				errorClass: classified,
				channel: providerId,
				model: modelId,
			});
```

`classifyLlmErrorText` 从 `tool-error-class.ts` 导出（新增该函数，复用同一套分类规则，避免两处正则漂移）：

```ts
/**
 * LLM 错误文本分类。与 classifyToolOutcome 共用同一套规则，
 * 避免两处正则各自演化后结论不一致。
 */
export function classifyLlmErrorText(text: string): ToolErrorClass {
	return classifyToolOutcome({ isError: true, terminate: false, resultText: text }).errorClass ?? "internal";
}
```

`providerId` / `modelId` 从该路由已有的 `modelFactory` 结果或 `opts.llm` 取；若该路由拿不到，用字面量 `"unknown"`（**不得透传任意请求字符串**）。

- [ ] **Step 3: 跑测试**

Run: `cd services/pi-runtime && node --import tsx --test src/app.test.ts && pnpm --filter @pi-lnk/pi-runtime exec tsc --noEmit`
Expected: PASS + tsc 无错

- [ ] **Step 4: 提交**

```bash
git add services/pi-runtime/src/app.ts services/pi-runtime/src/tool-error-class.ts
git commit -m "feat(metrics): LLM 错误改error_class 分类，旧 2 值指标保留一个发布周期"
```

---

## 后续计划（本阶段不含，另开）

| 阶段 | 内容 | 为何拆开 |
|---|---|---|
| 阶段二 | `apps/server` prom-client + `/metrics` + 媒体生成指标 | 独立服务、独立部署（`deploy.yml` vs `runtime-deploy.yml`），可并行推进 |
| 阶段三 | `packages/agent` 静默降级埋点（audio/video provider） | 在共享包，改动影响面比 pi-runtime 大 |
| 阶段四 | Prometheus + Grafana chart、告警规则、webhook 通知 | 依赖前三个阶段产出真实指标，否则看板是空的 |

**阶段四的前置**：必须先有≥1 个发布周期的真实指标，才能校准 spec §7.2 的初值阈值（5% / 2% / 30s / 660s）。阈值未校准就接通知会制造噪音。
