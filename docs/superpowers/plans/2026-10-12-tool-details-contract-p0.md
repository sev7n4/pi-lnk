# 工具结果质量信号层实施计划（P0 契约 + P1 listener）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** P0：为 8 文件 / 15+ 工具建立显式 `details` 契约（`_signal` + 族字段），使 429/timeout/截断/覆盖面可判读。P1：`after_tool` 信号 listener，异常结果尾部追加自解释短告警 + 请求数/生效数对账。

**Architecture:** 新增 `tools/result-signal.ts`（契约类型 + 族 TDetails/守卫 + 薄适配 vendor 分类器 + `withSignal`），工具 return 包装；P1 新增 `tools/result-signal-listener.ts`（纯函数，窄输入可测），注册在既有合并 after_tool listener 之后。类型层 tsc 即机检 + `scripts/verify-tool-details-contract.ts` 防回退。

**Tech Stack:** TypeScript 5.6 / typebox 1.3.7 / node:test（`node --import tsx --test`）/ 依赖增量：0（vendor 分类器是既有声明依赖 `@earendil-works/pi-ai`）。

**Spec（权威，冲突以规格为准）:** `docs/superpowers/specs/2026-10-12-tool-details-contract-design.md`（PR #366 · `a1133ffe`）。缺口报告 `docs/agent/tool-result-quality-signal-gap.md` 仅作输入。实施分两批两个 PR：P0 = Task 1–6，P1 = Task 7–9。

## Global Constraints

- **retryable 判据唯一来源 = vendor `isRetryableAssistantError`**（§5）；禁止拷贝 pattern / 自建 retryable Set。本地域事实（empty_result / invalid_params / fallback_pending / coverage）在 `result-signal.ts` 单点判定——两者不重叠，禁止第三处分类逻辑。
- **注入键一律 `details._signal`**（下划线前缀 = 框架注入键约定，对齐 vendor `_tag` 判别子惯例）；grep 断言 8 文件零 `details.signal`（无下划线）。
- **`affectedCount` 必须工具直报**（client 响应的实际生效数），⭐ **禁止从 `actions` 反推**——actions 与受影响对象非 1:1（§2.1 护栏）。
- **listener patch 只改 content + details**；显式禁碰 `usage` / `terminate` / `isError`（§4 patch 面纪律——改 isError 干扰 gate、改 terminate 终止 agent loop）。
- **details patch 必须 `{...event.details, _signal}` 展开合并**——vendor 聚合是整字段替换非深合并（`hooks.ts:315`），不展开 = 抹掉前序 listener patch。
- 读非类型化 event 字段一律用 `readStringField` / `readBooleanField`（`hook-contract.ts`）fail-soft 助手，禁 `as` 强转（`index.ts:90` 惯例）。
- 不改任何工具的执行逻辑与 Nest 端点调用；只包装 return 值。`withImageRefine` 视觉自评回流行为逐字节保留。
- 命名对齐 vendor：守卫 `isXxx` 前缀；metrics `observe*` 方法惯例（`metrics.ts`）。
- prompt 预算 3197/3200：**不碰 prompt-registry**；`pnpm prompt:lint` 保持零错。
- commit 惯例：`feat(pi-runtime): ...` / `ci(pi-runtime): ...`；每任务一提交。

## Review Focus

1. **`run_image_generation` 双 block content**：包信号后 content 原样（含 image block）——回归测试锁 `content.length === 2`。
2. **`confirmed` 被 gate 消费**（canvas-write propose_generation / gate/generation-gate）：details 展开不能丢 `confirmed`——丢了 = 跨轮放行静默失效。
3. **`details.actions` 被 Nest `extractCanvasActions` 消费**：withSignal 必须**展开**原 details 而非替换——丢 `actions` = 画布实时 SSE 失效（PR #65 同型事故）。
4. **fail-soft**：信号构造遇非 object 数据必须返回原结果，绝不 throw。
5. **范围锁**：read 大类仅 `get_canvas_summary` 动（§2.2 read 族单行）；其余 8 个 read 工具不动。
6. **⭐ vendor-false 语义收敛**：vendor 只导出 boolean、patterns 未导出 ⇒ 「配额/计费耗尽」与「pattern 未识别」同返 false，**实现上无法区分**——按三态语义一律「未判明」不写 retryable（hedge 文本兜底，`换模型`建议覆盖配额场景）。此为对规格 §5 表第 2 行的实现性收敛，PR body 须声明并提议规格微调（一行注记）。

---

## 批次一（P0 契约，独立 PR）

### Task 1: `result-signal.ts` 契约模块（TDD 核心）

**Files:**
- Create: `services/pi-runtime/src/tools/result-signal.ts`
- Test: `services/pi-runtime/src/tools/result-signal.test.ts`

**Interfaces:**
- Produces:
  - `interface ToolResultSignal { status: "ok"|"partial"|"failed"; retryable?: boolean; truncated?: boolean; coverage?: "full"|"partial"|"empty"; errorCode?: string }`（§2.1 原文——无 tier、无 affectedCount）
  - 族契约：`GenDetails`（`modelUsed: string`、`generationParams: Record<string, unknown>`）、`WriteDetails`（`affectedCount: number`）、`ReadSummaryDetails`（`coverage` + `scope: string`）及守卫 `isGenDetails` / `isWriteDetails` / `isReadSummaryDetails` / `isToolResultSignal`（守卫校验必填字段存在性与类型，不校验 `_signal`）
  - `signalFromUpstream(data: unknown): ToolResultSignal`（薄适配 vendor 分类器 + 本地域单点）
  - `withSignal<A extends { details: object }>(base: A, signal: ToolResultSignal): A`（返回 `{...base, details: {...base.details, _signal: signal}}`）
- Consumes: `isRetryableAssistantError` from `@earendil-works/pi-ai`（已声明依赖；签名 `(message: AssistantMessage) => boolean`，只读 `stopReason`+`errorMessage`，要求 `stopReason === "error"`）。

- [ ] **Step 1: 写失败测试**（§5 表 + §8 P1 适配层单测要求）

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	isToolResultSignal, isGenDetails, isWriteDetails, isReadSummaryDetails,
	signalFromUpstream, withSignal,
} from "./result-signal.js";

describe("signalFromUpstream（vendor 薄适配 + 本地域单点，禁 LLM）", () => {
	it("限流文本 → failed + retryable=true（agnes 病例：vendor 瞬时 pattern）", () => {
		const s = signalFromUpstream({ ok: false, message: "429 Too Many Requests, rate limit exceeded" });
		assert.equal(s.status, "failed");
		assert.equal(s.retryable, true);
	});
	it("timeout 状态（生成未完成）→ partial + retryable=true", () => {
		const s = signalFromUpstream({ ok: true, status: "timeout" });
		assert.equal(s.status, "partial");
		assert.equal(s.retryable, true);
	});
	it("配额/计费文本 → failed + retryable 缺省（未判明；Review Focus 6）", () => {
		const s = signalFromUpstream({ ok: false, message: "insufficient_quota: out of budget" });
		assert.equal(s.status, "failed");
		assert.equal("retryable" in s, false); // vendor-false 无法区分配额 vs 未识别 ⇒ 三态收敛
	});
	it("errorCode unknown / 无文本 → failed + retryable 缺省（未判明）", () => {
		const s = signalFromUpstream({ ok: false, errorCode: "unknown" });
		assert.equal(s.status, "failed");
		assert.equal("retryable" in s, false);
	});
	it("empty_result（本地域事实）→ partial + retryable=false", () => {
		const s = signalFromUpstream({ ok: true, status: "empty_result" });
		assert.equal(s.status, "partial");
		assert.equal(s.retryable, false);
	});
	it("fallback_pending（本地域事实）→ partial + retryable=false", () => {
		const s = signalFromUpstream({ ok: true, status: "fallback_pending" });
		assert.equal(s.status, "partial");
		assert.equal(s.retryable, false);
	});
	it("invalid_params（本地域事实）→ failed + retryable=false", () => {
		const s = signalFromUpstream({ ok: false, status: "invalid_params" });
		assert.equal(s.status, "failed");
		assert.equal(s.retryable, false);
	});
	it("ok:true 且无异常字段 → 恰为 {status:'ok'}（三态：ok 不写 retryable）", () => {
		assert.deepEqual(signalFromUpstream({ ok: true, url: "https://x" }), { status: "ok" });
	});
	it("error_code 下划线归一 + 非 object fail-soft（绝不 throw）", () => {
		assert.equal(signalFromUpstream({ ok: false, error_code: "rate limit" }).errorCode, "rate limit");
		assert.equal(signalFromUpstream(null).status, "ok");
		assert.equal(signalFromUpstream("str").status, "ok");
	});
});

describe("守卫族", () => {
	it("isToolResultSignal / isGenDetails / isWriteDetails / isReadSummaryDetails", () => {
		assert.ok(isToolResultSignal({ status: "ok" }));
		assert.ok(!isToolResultSignal({ status: "yes" }));
		assert.ok(!isToolResultSignal(null));
		assert.ok(isGenDetails({ modelUsed: "agnes-2.5-flash", generationParams: { w: 1 } }));
		assert.ok(!isGenDetails({ modelUsed: "x" })); // 缺 generationParams
		assert.ok(isWriteDetails({ affectedCount: 3 }));
		assert.ok(!isWriteDetails({ affectedCount: "3" }));
		assert.ok(isReadSummaryDetails({ coverage: "partial", scope: "nodes[0..20]" }));
		assert.ok(!isReadSummaryDetails({ coverage: "partial" })); // 缺 scope
	});
});

describe("withSignal", () => {
	it("写入 details._signal 键（下划线前缀）且展开保留 actions/confirmed", () => {
		const base = { content: [], details: { actions: [{ type: "add_node" }], confirmed: true } };
		const out = withSignal(base as never, { status: "ok" });
		assert.equal(out.details.actions.length, 1);
		assert.equal(out.details.confirmed, true);
		assert.equal(out.details._signal.status, "ok");
		assert.equal("signal" in out.details, false); // 不得出现无下划线键
	});
	it("content 引用不变（run_image 双 block 场景安全）", () => {
		const content = [{ type: "text", text: "a" }, { type: "image", url: "x" }];
		const out = withSignal({ content, details: {} } as never, { status: "ok" });
		assert.equal(out.content.length, 2);
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd services/pi-runtime && node --import tsx --test src/tools/result-signal.test.ts`
Expected: FAIL（ERR_MODULE_NOT_FOUND = 功能缺失）

- [ ] **Step 3: 最小实现**

```ts
/** 工具结果信号契约（spec docs/superpowers/specs/2026-10-12-tool-details-contract-design.md §2/§3/§5）。 */
import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";

export interface ToolResultSignal {
	status: "ok" | "partial" | "failed";
	/** 三态语义（§5）：true 仅确知可重试写；false 仅确知不可重试写；缺省 = 未判明。 */
	retryable?: boolean;
	truncated?: boolean;
	/** read 类工具：防「局部当全量」静默答错（get_canvas_summary 病例）。 */
	coverage?: "full" | "partial" | "empty";
	errorCode?: string;
}

/** §2.2 族契约（TDetails 必填字段；_signal 由 isToolResultSignal 独立守卫，不在此重复）。 */
export interface GenDetails {
	modelUsed: string;
	generationParams: Record<string, unknown>;
}
export interface WriteDetails {
	/** 工具直报的实际生效数；⭐ 禁止从 actions 反推（§2.1 护栏）。 */
	affectedCount: number;
}
export interface ReadSummaryDetails {
	coverage: "full" | "partial" | "empty";
	scope: string;
}

/** 本地域事实分类（§5 职责边界）：工具自己知道、vendor 分类器管不着。 */
const LOCAL_NON_RETRYABLE_STATUS = new Set(["empty_result", "invalid_params", "validation", "fallback_pending"]);
const PARTIAL_STATUS = new Set(["timeout", "upstream_timeout", "fallback_pending", "empty_result"]);

export function isToolResultSignal(v: unknown): v is ToolResultSignal {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		(o.status === "ok" || o.status === "partial" || o.status === "failed") &&
		(o.retryable === undefined || typeof o.retryable === "boolean") &&
		(o.truncated === undefined || typeof o.truncated === "boolean") &&
		(o.errorCode === undefined || typeof o.errorCode === "string") &&
		(o.coverage === undefined || o.coverage === "full" || o.coverage === "partial" || o.coverage === "empty")
	);
}
export function isGenDetails(v: unknown): v is GenDetails {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o.modelUsed === "string" && typeof o.generationParams === "object" && o.generationParams !== null;
}
export function isWriteDetails(v: unknown): v is WriteDetails {
	if (typeof v !== "object" || v === null) return false;
	return typeof (v as Record<string, unknown>).affectedCount === "number";
}
export function isReadSummaryDetails(v: unknown): v is ReadSummaryDetails {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		(o.coverage === "full" || o.coverage === "partial" || o.coverage === "empty") &&
		typeof o.scope === "string"
	);
}

/**
 * 信号分类单点（§5）：上游可重试性复用 vendor 分类器（唯一接触点）；
 * 本地域事实在此判定。vendor 返回 false 时无法区分「配额耗尽」与「pattern 未识别」
 * （patterns 未导出）⇒ 按三态语义一律「未判明」不写 retryable（Review Focus 6）。
 */
export function signalFromUpstream(data: unknown): ToolResultSignal {
	if (typeof data !== "object" || data === null) return { status: "ok" };
	const o = data as Record<string, unknown>;
	const statusField = typeof o.status === "string" ? o.status : "";
	const errorCode =
		typeof o.errorCode === "string" ? o.errorCode : typeof o.error_code === "string" ? o.error_code : undefined;
	const base: ToolResultSignal = { status: "ok", ...(errorCode !== undefined ? { errorCode } : {}) };

	// 本地域事实优先：不依赖文本匹配，工具自己知道的事实自己断言。
	if (LOCAL_NON_RETRYABLE_STATUS.has(statusField)) {
		return { ...base, status: PARTIAL_STATUS.has(statusField) ? "partial" : "failed", retryable: false };
	}

	const isFailure = o.ok === false || PARTIAL_STATUS.has(statusField) || o.error !== undefined;
	if (!isFailure) return base;

	const rawText = [typeof o.message === "string" ? o.message : "", typeof o.error === "string" ? o.error : "", errorCode ?? "", statusField]
		.filter(Boolean)
		.join("; ");
	// vendor 只读 stopReason + errorMessage 两字段 → 合成形状调用（§5 薄适配层）。
	const vendorRetryable = isRetryableAssistantError({ stopReason: "error", errorMessage: rawText || "unknown" } as AssistantMessage);
	return {
		...base,
		status: PARTIAL_STATUS.has(statusField) ? "partial" : "failed",
		...(vendorRetryable ? { retryable: true } : {}),
	};
}

/** 展开 details 保留全部既有键（actions/confirmed 是消费方契约，绝不能丢）；注入键 = _signal。 */
export function withSignal<A extends { details: object }>(base: A, signal: ToolResultSignal): A {
	return { ...base, details: { ...base.details, _signal: signal } };
}
```

- [ ] **Step 4: 跑测试确认通过**（同 Step 2 命令，Expected: 全部 PASS）

- [ ] **Step 5: 提交**

```bash
git add services/pi-runtime/src/tools/result-signal.ts services/pi-runtime/src/tools/result-signal.test.ts
git commit -m "feat(pi-runtime): ToolResultSignal 契约 + vendor 分类器薄适配 + 族 TDetails 守卫 + withSignal"
```

### Task 2: gen 族接线（generation.ts 7 工具）

> **2026-10-12 拍板补充（用户选定方案 A）**：GenDetails 数据源 = Nest 侧 `used` 回读透传——`startImageGeneration` 补 `used:{model,aspectRatio,resolution,count}`（实际值局部变量已在作用域）、`runImageGeneration` 透传、`runAudioGeneration` 补 `used:{model,kind,voice}`（提取 `usedAudio` 局部量，两 return 点都带）；service 测试 +2（used 回读，113/113）。`used` 缺失（Nest 版本偏斜）→ `modelUsed:"unspecified"` / `generationParams:{}`，fail-soft 不造值。dock 语义不变：dock=用户意图 SSOT，details.used=执行事实。

**Files:**
- Modify: `services/pi-runtime/src/tools/generation.ts`（runTool.execute return 点 + run_audio return；propose_generation 保留 `confirmed`）
- Test: `services/pi-runtime/src/tools/generation.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 `withSignal` / `signalFromUpstream` / `GenDetails`。
- Produces: gen 工具 `details: { actions, _signal, modelUsed, generationParams }`；propose_generation 另有 `confirmed`。

- [ ] **Step 1: 追加失败测试**（用例体按 `generation.test.ts` 既有 client 替身模式填充，视觉自评用例可直接复制其替身构造）

```ts
it("run_* 返回 details._signal：ok/timeout 分类正确且 actions/modelUsed 保留", async () => { /* 替身返回 {ok:true,url,model} → _signal.status==="ok" && Array.isArray(details.actions) && details.modelUsed==="..." */ });
it("upstream 超时 { ok:true, status:'timeout' } → _signal.partial + retryable", async () => { /* 断言 _signal.status==="partial" && _signal.retryable===true */ });
it("run_image content 双 block 不受影响（视觉自评回流回归锁）", async () => { /* imageRefine attached：content.length===2 且 [1].type==="image" */ });
```

- [ ] **Step 2: 跑测试确认失败**（`_signal` 键缺失）

- [ ] **Step 3: 实现**——`runTool.execute` 内：

```ts
const base = withSignal(
	{ ...resultWithActions(data), details: { ...resultWithActions(data).details, modelUsed: usedModel, generationParams: params } },
	signalFromUpstream(data),
);
```

（实现时按文件真实变量名取 `modelUsed` / `generationParams`——模型名与实际参数在 execute 作用域已有；`withImageRefine` 透传 details 无需改；`run_audio_generation` 同样包装。）

- [ ] **Step 4: 跑测试确认通过**（含既有视觉自评用例全绿）

- [ ] **Step 5: 提交**

```bash
git add services/pi-runtime/src/tools/generation.ts services/pi-runtime/src/tools/generation.test.ts
git commit -m "feat(pi-runtime): gen 族 details 接线 _signal + GenDetails"
```

### Task 3: 写类/destructive 族接线（canvas-write 15 工具 + delete-nodes + remove-edges + arrange-nodes）

**Files:**
- Modify: `services/pi-runtime/src/tools/canvas-write.ts`（全部 `resultWithActions(` 调用点，约 14 处；`textRaw` 路径现 `details: undefined` 须补齐）
- Modify: `services/pi-runtime/src/tools/delete-nodes.ts`、`remove-edges.ts`、`arrange-nodes.ts`
- Test: `canvas-write.test.ts` + delete-nodes/remove-edges 既有测试追加断言

**Interfaces:**
- Consumes: Task 1 `withSignal` / `WriteDetails`。
- Produces: 写类 `details: { actions, _signal, affectedCount }`；canvas-write 错误路径保留 `{ok, confirmed}`。

- [ ] **Step 1: 追加失败测试**（confirmed / actions 双锁 + affectedCount 直报锁）

```ts
it("写工具 details._signal 存在且 confirmed/actions/affectedCount 保留", async () => { /* 断言 _signal.status==="ok" && Array.isArray(details.actions) && typeof details.affectedCount==="number" */ });
it("propose_generation 阻塞确认后 confirmed 仍在 details 顶层（gate 消费回归锁）", async () => { /* 断言 details.confirmed === true */ });
it("⭐ affectedCount 与 actions.length 解耦（批量 action 不等于对象数）", async () => { /* 替身让单条 action 覆盖批量：断言 affectedCount 为响应实际数，而非 actions.length */ });
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**——canvas-write.ts 单点 import 后统一包装；`affectedCount` 从 **client 响应的实际生效数**直报（执行时按 delete-nodes.ts / remove-edges.ts / 各写工具真实响应形态取对应字段——打开文件确认，**禁止 `actions.length`**）；写类 data 无异常字段 → `signalFromUpstream` 返回 `{status:"ok"}` 即正确（失败走 throw → isError，无 details，符合 §1 边界）。

- [ ] **Step 4: 跑测试确认通过**（四个测试文件全绿）

- [ ] **Step 5: 提交**

```bash
git add services/pi-runtime/src/tools/canvas-write.ts services/pi-runtime/src/tools/canvas-write.test.ts services/pi-runtime/src/tools/delete-nodes.ts services/pi-runtime/src/tools/remove-edges.ts services/pi-runtime/src/tools/arrange-nodes.ts
git commit -m "feat(pi-runtime): 写类/destructive 接线 _signal + affectedCount 直报（confirmed/actions 回归锁）"
```

### Task 4: get_canvas_summary coverage/scope + present 类型对齐

**Files:**
- Modify: `services/pi-runtime/src/tools/canvas-read.ts`（仅 `get_canvas_summary`）
- Modify: `services/pi-runtime/src/tools/present-result.ts`（TDetails 显式化，沿用 `{ok, canvasCommands, truncated?}`）
- Test: `services/pi-runtime/src/tools/canvas-read.test.ts`（若无则新建，最小 client 替身）

**Interfaces:**
- Produces: get_canvas_summary `details: { _signal: {status, coverage}, scope: string }`。

- [ ] **Step 1: 失败测试**

```ts
it("get_canvas_summary：空画布 → coverage:'empty'；有节点 → 'full'；截断 → 'partial' + scope 描述采样范围", async () => { /* trimData 截断判定复用其返回形态 */ });
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**——canvas-read.ts 内：

```ts
import { withSignal, type ToolResultSignal } from "./result-signal.js";

function summarySignal(data: unknown): { signal: ToolResultSignal; scope: string } {
	const nodes = (data as { nodes?: unknown[] } | null)?.nodes;
	if (!Array.isArray(nodes) || nodes.length === 0) return { signal: { status: "ok", coverage: "empty" }, scope: "none" };
	return { signal: { status: "ok", coverage: "full" }, scope: `nodes[0..${nodes.length}]` };
}
// get_canvas_summary execute:
const data = trimData(await client.post(...));
const { signal, scope } = summarySignal(data.data ?? data);
return withSignal(textResult(data) as never, signal); // scope 经 details 扩展字段携带（执行时按真实返回结构落位）
```

- [ ] **Step 4: 跑测试确认通过**（canvas-read 测试 + 其余 8 个 read 工具回归——它们的 return 未动）

- [ ] **Step 5: 提交**

```bash
git add services/pi-runtime/src/tools/canvas-read.ts services/pi-runtime/src/tools/present-result.ts services/pi-runtime/src/tools/canvas-read.test.ts
git commit -m "feat(pi-runtime): get_canvas_summary coverage/scope 信号（防局部当全量）+ present 类型对齐"
```

### Task 5: 机检脚本 + CI 挂接

**Files:**
- Create: `scripts/verify-tool-details-contract.ts`
- Modify: `package.json`（根 scripts 加 `"verify:details": "tsx scripts/verify-tool-details-contract.ts"`）与 `.github/workflows/ci.yml`（对齐 `verify-tool-contract` step 形态）

- [ ] **Step 1: 写脚本**（grep 级断言，规则见规格 §2.3）：

```ts
// 规则 1：P0 的 8 文件清单内，resultWithActions( 裸调用（不经 withSignal 包装）必须为 0。
// 规则 2：_signal 键名规范——8 文件 grep 断言 details.signal（无下划线）零命中。
// 规则 3：注册序前瞻（P1 批次启用前占位）：index.ts 中 result-signal listener 注册行号
//         > 合并 after_tool listener 注册行号（P1 落地后生效，P0 阶段 skip 并打印 SKIP 原因）。
// 任一违例 → 打印 文件:行号 + exit 1。
```

- [ ] **Step 2: 本机双向判别**（故意去掉一处包装验证 exit 1 → 还原 → PASS）

Run: `pnpm verify:details`

- [ ] **Step 3: 挂接 CI**（ci.yml 紧随 `Verify tool contract` step 之后加 `pnpm verify:details`）

- [ ] **Step 4: 提交**

```bash
git add scripts/verify-tool-details-contract.ts package.json .github/workflows/ci.yml
git commit -m "ci(pi-runtime): details 契约机检 verify:details 接入 CI（_signal 键名 + 包装完备性）"
```

### Task 6: P0 全量验收 + PR（批次一终点）

- [ ] **Step 1: 全量校验**（顺序，不并行）：

```bash
cd services/pi-runtime && node --import tsx --test src/tools/result-signal.test.ts src/tools/generation.test.ts src/tools/canvas-write.test.ts
pnpm prompt:lint        # 预算 3197/3200 必须零错
pnpm --filter @pi-lnk/pi-runtime exec tsc --noEmit
pnpm verify:details
```

- [ ] **Step 2: push + 开 PR**（body 引用 spec 路径 + Review Focus 六项逐条自检结论 + **声明 Review Focus 6 的 vendor-false 语义收敛**）
- [ ] **Step 3: 盯 CI 全绿 → squash 合并**（branch-first 七步 5/6；P0 无部署面变化——pi-runtime 镜像属 Runtime Deploy 手动 dispatch，P1 上线时一并走 prod-deploy-verify）

---

## 批次二（P1 信号 listener，独立 PR，基于 P0 合并后的 master）

### Task 7: `result-signal-listener.ts` 纯函数（TDD）

**Files:**
- Create: `services/pi-runtime/src/tools/result-signal-listener.ts`
- Test: `services/pi-runtime/src/tools/result-signal-listener.test.ts`

**Interfaces:**
- Produces（窄输入纯函数，不 import vendor 类型——接线层传字段）:
  - `appendSignalLine(toolName: string, tier: string, isError: boolean, content: Array<{type: string; text?: string}>, details: unknown): { content: typeof content; details: Record<string, unknown> } | undefined`——ok 且无告警 → undefined（零注入）；异常 → 尾部追加信号行 + `{...details, _signal}` 展开合并
  - `reconcileAffected(requestedCount: number | undefined, affectedCount: number | undefined): string | undefined`——请求数 vs 生效数对账（§4）：请求 5 生效 3 → 告警行；两者均 undefined → undefined
- Consumes: Task 1 `isToolResultSignal` / `readStringField` 形态的窄化由接线层完成。

- [ ] **Step 1: 失败测试**（§8 P1：details 展开护栏单测锁定）

```ts
describe("appendSignalLine", () => {
	it("ok 且无告警 → undefined（成功静默，零注入）", () => { /* status ok → undefined */ });
	it("retryable:true → 尾部追加 ⚠️ 行（15-30 token 预算）", () => { /* content 最后一个 text 块末尾出现 '⚠️[gen] rate_limited 可退避重试'，且其前是截断 marker（叠加序：正文→截断 marker→信号行） */ });
	it("未判明（无 retryable 字段）→ hedge 文本（不断言不禁止）", () => { /* 含 '未判明' 与 '换模型' */ });
	it("⭐ details 展开合并护栏：前序 listener 的 details patch 不被抹掉", () => { /* details 含 {actions:[...], _signal:{...}} → 返回 details 仍含 actions 且 _signal 为展开合并结果 */ });
});
describe("reconcileAffected", () => {
	it("请求 5 生效 3 → 部分生效告警；请求 5 生效 5 → undefined；缺任一侧 → undefined", () => { /* 三分支 */ });
});
```

- [ ] **Step 2: RED 确认 → Step 3: 最小实现 → Step 4: GREEN**（同 TDD 循环）

- [ ] **Step 5: 提交**

```bash
git add services/pi-runtime/src/tools/result-signal-listener.ts services/pi-runtime/src/tools/result-signal-listener.test.ts
git commit -m "feat(pi-runtime): 信号 listener 纯函数（尾部追加 + args 对账 + details 展开护栏）"
```

### Task 8: 接线（注册序 + kill switch + metrics）

**Files:**
- Modify: `services/pi-runtime/src/runtime-config.ts`（加 `resultSignals?: boolean;` 配置项 + env 解析，镜像 `toolResultBudget` 字段形态；kill switch = `PI_RUNTIME_RESULT_SIGNALS=off`）
- Modify: `services/pi-runtime/src/index.ts`（`onSessionCreated` 内，既有合并 `after_tool` listener（`index.ts:85` 起）**之后**注册信号 handler；`hookCfg.resultSignals === false` 不注册——一次解析，handler 内不读 `process.env`）
- Modify: `services/pi-runtime/src/metrics.ts`（private Map `resultSignals` key `${tier}|${status}` + `resultSignalUnknown` 计数 + `observeResultSignal(...)` 方法 + 渲染块 `pi_runtime_result_signal_total`——对齐既有 observe* / 渲染惯例）

- [ ] **Step 1: 失败测试**（runtime-config off/on 解析 + registration-order 机检数据）
- [ ] **Step 2: RED → Step 3: 实现 → Step 4: GREEN**（handler 内读 event 字段用 `readStringField`/`readBooleanField`；tier 从 `tiering.ts` 真实导出查表；只改 content/details）
- [ ] **Step 5: 提交**

```bash
git add services/pi-runtime/src/runtime-config.ts services/pi-runtime/src/runtime-config.test.ts services/pi-runtime/src/index.ts services/pi-runtime/src/metrics.ts
git commit -m "feat(pi-runtime): 信号 listener 接线（注册序在合并 listener 后 + PI_RUNTIME_RESULT_SIGNALS kill switch + observe* metrics）"
```

### Task 9: P1 验收 + PR（批次二终点）

- [ ] **Step 1: 4 条 golden case 全绿**（§6）：①agnes 429 文本 → retryable 信号 + 退避提示；②canvas-write 缺 confirmed → partial + 重试提示；③get_canvas_summary 局部 → coverage 告警；④details 展开护栏（Task 7 单测）
- [ ] **Step 2: kill switch 逐字节回退**：`PI_RUNTIME_RESULT_SIGNALS=off` 起服 → diff 一个会话的 content 无信号文本
- [ ] **Step 3: 注册序断言**（Task 5 规则 3 生效）+ metrics 活性探针（`/metrics` 含 `pi_runtime_result_signal_total`）
- [ ] **Step 4: push + PR（引用 spec §4/§5/§6）→ 盯 CI → squash 合并 → prod-deploy-verify（Runtime Deploy 手动 dispatch + 生产探针）**
