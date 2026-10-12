# P0 工具结果 details 契约类型化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 8 个文件的 15+ 个 P0 工具建立显式 `details` 契约（`ToolResultSignal`），使 429/timeout/截断等结果状态可被模型与 hook 判读。

**Architecture:** 新增 `tools/result-signal.ts`（契约类型 + 规则启发式分类器 + `withSignal` 包装器），既有工具的 return 语句从 `resultWithActions(data)` / `textResult(data)` 切换到带信号的变体；类型层用 TS 泛型强制（tsc 即机检），外加一个 grep 级脚本 `scripts/verify-tool-details-contract.ts` 防回退（对齐 `verify-tool-contract.ts` 模式）。不新增 hook、不注入 content——P1 的事。

**Tech Stack:** TypeScript 5.6 / typebox 1.3.7 / node:test（pi-runtime 测试跑 `node --import tsx --test`）/ 无新依赖。

**Spec:** `docs/agent/tool-result-quality-signal-gap.md` §3.6（工具勾选表）+ §十 P0（范围/验收）+ §8.4（约束）。

## Global Constraints

- 不改任何工具的执行逻辑与 Nest 端点调用；只包装 return 值。
- `run_image_generation` 的视觉自评回流（`withImageRefine`）行为逐字节保留——信号只进 `details`，不动 `content`。
- 新增依赖：0（禁引 npm 包）。
- 命名对齐 vendor：守卫用 `isXxx` 前缀；类型进 `tools/types.ts` 或新文件不污染 `AgentToolResult`。
- prompt 预算 3197/3200：本计划**不碰 prompt-registry**；`pnpm prompt:lint` 必须保持 0 错误。
- 本机 4 核：vitest 顺序跑，不并行两个包。
- commit 惯例：`feat(pi-runtime): ...`；每任务一提交。

## Review Focus

1. **`run_image_generation` 双 block content（text+image）**：包信号后 content 数组必须原样（含 image block），只允许 details 变——期待回归测试锁 `content.length === 2`。
2. **`confirmed` 布尔被 gate 消费（canvas-write propose_generation / gate/generation-gate）**：details 展开时不能丢 `confirmed` 键——gate 读 `readBooleanField(event.details,"confirmed")`，丢了 = 跨轮放行静默失效（历史事故同型）。
3. **`details.actions` 被 Nest `extractCanvasActions` 消费**：withSignal 必须**展开**原 details（`{...details, signal}`）而不是替换——丢 `actions` = 画布实时 SSE 失效（PR #65 同型事故）。
4. **off/失败路径逐字节回退**：信号构造失败（data 非 object）必须 fail-soft 返回原结果，绝不 throw——工具 execute 抛错会被 vendor 转成 isError。
5. **`textResult` 的 read 大类**：`get_canvas_summary` 加 coverage 后，其余 8 个 read 工具 P0 不动（§3.6 勾选）——防止范围蔓延改到未勾选工具。

---

### Task 1: `result-signal.ts` 契约 + 分类器（TDD 核心）

**Files:**
- Create: `services/pi-runtime/src/tools/result-signal.ts`
- Test: `services/pi-runtime/src/tools/result-signal.test.ts`

**Interfaces:**
- Produces: `interface ToolResultSignal { status: "ok"|"partial"|"failed"; retryable?: boolean; truncated?: boolean; coverage?: "full"|"partial"|"empty"; errorCode?: string }`；`isToolResultSignal(v: unknown): v is ToolResultSignal`；`signalFromUpstream(data: unknown): ToolResultSignal`；`withSignal<A extends { details: object }>(base: A, signal: ToolResultSignal): A`（返回 `{...base, details: {...base.details, signal}}`）。
- Consumes: 无（纯函数模块，零 import）。

- [ ] **Step 1: 写失败测试**（golden cases 对齐报告 8.4-4）

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isToolResultSignal, signalFromUpstream, withSignal } from "./result-signal.js";

describe("signalFromUpstream（规则启发式，禁 LLM）", () => {
  it("429/限流 → failed + retryable=true（agnes 病例）", () => {
    const s = signalFromUpstream({ ok: false, errorCode: "rate_limited" });
    assert.equal(s.status, "failed");
    assert.equal(s.retryable, true);
  });
  it("upstream_timeout → partial + retryable=true（cogvideox 病例）", () => {
    const s = signalFromUpstream({ ok: false, status: "upstream_timeout" });
    assert.equal(s.status, "partial");
    assert.equal(s.retryable, true);
  });
  it("status=timeout（生成未完成）→ partial + retryable=true", () => {
    const s = signalFromUpstream({ ok: true, status: "timeout" });
    assert.equal(s.status, "partial");
    assert.equal(s.retryable, true);
  });
  it("status=fallback_pending → partial + retryable=false（需用户确认，不可盲重试）", () => {
    const s = signalFromUpstream({ ok: true, status: "fallback_pending" });
    assert.equal(s.status, "partial");
    assert.equal(s.retryable, false);
  });
  it("ok:true 且无异常字段 → ok", () => {
    assert.deepEqual(signalFromUpstream({ ok: true, url: "https://x" }), {
      status: "ok",
      retryable: false,
    });
  });
  it("非 object 输入 fail-soft → ok（绝不 throw）", () => {
    assert.equal(signalFromUpstream(null).status, "ok");
    assert.equal(signalFromUpstream("str").status, "ok");
  });
});

describe("isToolResultSignal", () => {
  it("合法/非法判定", () => {
    assert.ok(isToolResultSignal({ status: "ok" }));
    assert.ok(!isToolResultSignal({ status: "yes" }));
    assert.ok(!isToolResultSignal(null));
  });
});

describe("withSignal", () => {
  it("展开原 details 保留全部键（actions/confirmed 不丢）", () => {
    const base = { content: [], details: { actions: [{ type: "add_node" }], confirmed: true } };
    const out = withSignal(base as never, { status: "ok" });
    assert.equal(out.details.actions.length, 1);
    assert.equal(out.details.confirmed, true);
    assert.equal(out.details.signal.status, "ok");
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
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

```ts
/** P0 工具结果信号契约（spec docs/agent/tool-result-quality-signal-gap.md §四/§十 P0）。 */

export interface ToolResultSignal {
	status: "ok" | "partial" | "failed";
	/** 规则启发式判定：429/timeout 类 → true（模型可退避重试而非改 prompt）。 */
	retryable?: boolean;
	truncated?: boolean;
	/** read 类工具：防「局部当全量」静默答错（get_canvas_summary 病例）。 */
	coverage?: "full" | "partial" | "empty";
	errorCode?: string;
}

const RETRYABLE_CODES = new Set([
	"rate_limited",
	"upstream_timeout",
	"timeout",
	"too_many_requests",
	"429",
	"503",
	"service_unavailable",
]);

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

export function signalFromUpstream(data: unknown): ToolResultSignal {
	if (typeof data !== "object" || data === null) return { status: "ok", retryable: false };
	const o = data as Record<string, unknown>;
	const statusField = typeof o.status === "string" ? o.status : "";
	const errorCode = typeof o.errorCode === "string" ? o.errorCode : typeof o.error_code === "string" ? o.error_code : undefined;
	const code = `${statusField} ${errorCode ?? ""}`.trim();
	if (o.ok === false) {
		return {
			status: statusField === "upstream_timeout" ? "partial" : "failed",
			retryable: RETRYABLE_CODES.has(statusField) || (errorCode !== undefined && RETRYABLE_CODES.has(errorCode)),
			...(errorCode !== undefined ? { errorCode } : {}),
		};
	}
	if (RETRYABLE_CODES.has(statusField)) return { status: "partial", retryable: true, ...(errorCode !== undefined ? { errorCode } : {}) };
	if (statusField === "fallback_pending") return { status: "partial", retryable: false };
	return { status: "ok", retryable: false };
}

/** 展开 details 保留全部既有键（actions/confirmed 是消费方契约，绝不能丢）。 */
export function withSignal<A extends { details: object }>(base: A, signal: ToolResultSignal): A {
	return { ...base, details: { ...base.details, signal } };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd services/pi-runtime && node --import tsx --test src/tools/result-signal.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add services/pi-runtime/src/tools/result-signal.ts services/pi-runtime/src/tools/result-signal.test.ts
git commit -m "feat(pi-runtime): ToolResultSignal 契约 + 规则分类器 + withSignal 包装器"
```

### Task 2: gen 5 工具接线（generation.ts）

**Files:**
- Modify: `services/pi-runtime/src/tools/generation.ts`（runTool.execute 三个 return 点 + run_audio 的 return）
- Test: `services/pi-runtime/src/tools/generation.test.ts`（既有文件追加用例）

**Interfaces:**
- Consumes: Task 1 的 `withSignal` / `signalFromUpstream`。
- Produces: gen 工具 execute 返回 `details: { actions, signal }`；`run_image_generation` 的 `withImageRefine` 路径保持 content 不变。

- [ ] **Step 1: 追加失败测试**（对齐 Review Focus 1/3/4）

```ts
it("run_* 返回 details.signal：ok/timeout 分类正确且 actions 保留", async () => {
	// 用既有测试的 client 替身模式：让 /run-image-generation 返回 { ok: true, url: "https://x" }
	// 断言 details.signal.status === "ok" 且 details.actions 为数组
});
it("upstream 超时形态 { ok:true, status:'timeout' } → signal.partial + retryable", async () => {
	// 同上，断言 signal.status === "partial"、signal.retryable === true
});
it("run_image content 双 block 不受影响（视觉自评回流回归锁）", async () => {
	// imageRefine attached 场景：content.length === 2 且 [1].type === "image"
});
```

（用例体按 `generation.test.ts` 既有的 client 替身/fetch 替身模式填充——该文件已有 `run_image_generation` 视觉自评用例可直接复制其替身构造。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd services/pi-runtime && node --import tsx --test src/tools/generation.test.ts`
Expected: 新增 3 用例 FAIL（details 无 signal 键）

- [ ] **Step 3: 实现**——`runTool.execute` 内：

```ts
const base = withSignal(resultWithActions(data), signalFromUpstream(data));
```

（`withImageRefine` 无需改：它透传 details 原样；`n/a`/`skipped` 路径的 signal 已在 base 里。）`run_audio_generation` 的 `resultWithActions(data)` 同样包 `withSignal(..., signalFromUpstream(data))`。

- [ ] **Step 4: 跑测试确认通过**（同 Step 2 命令，Expected: PASS，且既有用例全绿——尤其视觉自评 3 用例）

- [ ] **Step 5: 提交**

```bash
git add services/pi-runtime/src/tools/generation.ts services/pi-runtime/src/tools/generation.test.ts
git commit -m "feat(pi-runtime): gen 5 工具 details 接线 ToolResultSignal"
```

### Task 3: 写类工具接线（canvas-write.ts 15 工具 + delete-nodes + remove-edges + arrange-nodes）

**Files:**
- Modify: `services/pi-runtime/src/tools/canvas-write.ts`（全部 `resultWithActions(` 调用点，约 14 处）
- Modify: `services/pi-runtime/src/tools/delete-nodes.ts:44`、`remove-edges.ts:36`、`arrange-nodes.ts:44`
- Test: `services/pi-runtime/src/tools/canvas-write.test.ts`（追加 1 用例）+ `delete-nodes` 既有测试文件追加断言

**Interfaces:**
- Consumes: Task 1 `withSignal`（写类工具 data 自 Nest，ok:false 形态由 client throw 或 ok 字段表达——分类器兼容两路）。
- Produces: 写类工具 `details: { actions, signal }`。

- [ ] **Step 1: 追加失败测试**（Review Focus 2/3：confirmed 与 actions 双锁）

```ts
it("写工具 details.signal 存在且 confirmed/actions 保留", async () => {
	// 复用 canvas-write.test.ts 既有 client 替身：断言 set_node_text 返回
	// details.signal.status === "ok" && Array.isArray(details.actions)
});
it("propose_generation 阻塞确认后 confirmed 仍在 details 顶层（gate 消费回归锁）", async () => {
	// 复用既有 propose_generation confirmed 用例的替身，补断言 details.confirmed === true
});
```

- [ ] **Step 2: 跑测试确认失败**（同 Task 2 方式）

- [ ] **Step 3: 实现**——canvas-write.ts 内一次性 import `withSignal` 后，对 14 处 `resultWithActions(` 调用点统一包一层；写类 data 无 status/errorCode 字段，分类器返回 `{status:"ok"}` 即正确（失败走 throw → isError，无 details，符合 8.2-1 边界）。delete-nodes/remove-edges/arrange-nodes 同样单点包装。

- [ ] **Step 4: 跑测试确认通过**（canvas-write + delete-nodes + remove-edges + arrange-nodes 四个测试文件全绿）

- [ ] **Step 5: 提交**

```bash
git add services/pi-runtime/src/tools/canvas-write.ts services/pi-runtime/src/tools/canvas-write.test.ts services/pi-runtime/src/tools/delete-nodes.ts services/pi-runtime/src/tools/remove-edges.ts services/pi-runtime/src/tools/arrange-nodes.ts
git commit -m "feat(pi-runtime): 写类/destructive 工具 details 接线 ToolResultSignal（confirmed/actions 回归锁）"
```

### Task 4: get_canvas_summary coverage 信号 + present/todo 类型对齐

**Files:**
- Modify: `services/pi-runtime/src/tools/canvas-read.ts`（仅 `get_canvas_summary` 一个工具：textResult → 局部 `textResultWithSignal`）
- Modify: `services/pi-runtime/src/tools/present-result.ts`（details 类型注记补 `signal?: ToolResultSignal`，返回值追加 signal）
- Test: `services/pi-runtime/src/tools/canvas-read.test.ts`（若无则新建，最小 client 替身）

**Interfaces:**
- Consumes: Task 1 `signalFromUpstream` 扩展——本任务新增 `coverageFromSummary(data): ToolResultSignal`（局部函数，不入公共模块）。
- Produces: get_canvas_summary `details: { signal: { status, coverage } }`。

- [ ] **Step 1: 失败测试**

```ts
it("get_canvas_summary：空画布 → coverage:'empty'；有节点 → 'full'；被 trim 截断 → 'partial'", async () => {
	// trimData 截断判定复用其返回形态：data 中 nodes 数组空/非空 + 文本是否含截断标记
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**——canvas-read.ts 内：

```ts
function summarySignal(data: unknown): ToolResultSignal {
	const nodes = (data as { nodes?: unknown[] } | null)?.nodes;
	if (!Array.isArray(nodes) || nodes.length === 0) return { status: "ok", retryable: false, coverage: "empty" };
	return { status: "ok", retryable: false, coverage: "full" };
}
// get_canvas_summary execute:
const data = trimData(await client.post(...));
return withSignal(textResult(data) as never, summarySignal(data.data ?? data));
```

（`textResult` 返回 `{content, details: undefined}`，withSignal 展开时 details 从 undefined 变 `{signal}`——Step 1 测试锁定该形态；若 withSignal 类型不接受 undefined details，在调用点给 `details: {}` 先归一。）

- [ ] **Step 4: 跑测试确认通过**（canvas-read 测试 + 既有 8 个 read 工具不受影响的回归——它们的 return 未动）

- [ ] **Step 5: 提交**

```bash
git add services/pi-runtime/src/tools/canvas-read.ts services/pi-runtime/src/tools/present-result.ts services/pi-runtime/src/tools/canvas-read.test.ts
git commit -m "feat(pi-runtime): get_canvas_summary coverage 信号（防局部当全量）+ present 类型对齐"
```

### Task 5: 机检脚本 + CI 挂接

**Files:**
- Create: `scripts/verify-tool-details-contract.ts`
- Modify: `package.json`（根 scripts 加 `"verify:details": "tsx scripts/verify-tool-details-contract.ts"`）与 `.github/workflows/ci.yml`（对齐 `verify-tool-contract` 的挂接方式，加一个 step）

**Interfaces:**
- Consumes: Task 2/3/4 落盘后的源码形态。
- Produces: exit 0/1 的机检（防回退：有人新写 resultWithActions 不包信号即红）。

- [ ] **Step 1: 写脚本**（grep 级断言，模式对齐 prompt-lint/verify-tool-contract）

```ts
// 规则：P0 覆盖文件里，resultWithActions( 裸调用（不经过 withSignal）的行数必须为 0。
// 实现：逐文件读取，剥掉 import 行与注释行后，断言每个 `resultWithActions(` 出现都被
// `withSignal(` 前缀包裹（同一表达式内）；文件清单硬编码为 P0 的 8 个（generation/canvas-write/
// delete-nodes/remove-edges/arrange-nodes/present-result/canvas-read/image-refine）。
// 任一违例 → 打印 文件:行号 + exit 1。
```

- [ ] **Step 2: 本机跑通**（先故意在某文件去掉一处包装验证 exit 1，再还原 → 确认双向判别力）

Run: `pnpm verify:details`
Expected: 对当前树 PASS；人为破坏后 FAIL 并指认行号

- [ ] **Step 3: 挂接 CI**（ci.yml 中紧随 `Verify tool contract` step 之后加同型 step：`pnpm verify:details`）

- [ ] **Step 4: 提交**

```bash
git add scripts/verify-tool-details-contract.ts package.json .github/workflows/ci.yml
git commit -m "ci(pi-runtime): details 契约机检脚本 verify:details 接入 CI"
```

### Task 6: 全量验收 + PR

- [ ] **Step 1: 全量校验**（顺序，不并行）：

```bash
cd services/pi-runtime && node --import tsx --test src/tools/result-signal.test.ts src/tools/generation.test.ts src/tools/canvas-write.test.ts
pnpm prompt:lint        # 预算 3197/3200 必须零错
pnpm --filter @pi-lnk/pi-runtime exec tsc --noEmit
```

- [ ] **Step 2: push + 开 PR**（body 引用 spec 路径 + Review Focus 五项逐条自检结论）
- [ ] **Step 3: 盯 CI 全绿 → squash 合并**（branch-first 七步 5/6；本批无部署面变化——pi-runtime 镜像发布属 Runtime Deploy 手动 dispatch，P1 信号层上线时一并走 prod-deploy-verify）
