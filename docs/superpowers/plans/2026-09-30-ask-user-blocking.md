# ask_user / propose_generation 阻塞式改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ask_user 与 propose_generation 改为阻塞式（agent 在工具内等待用户回答/画布确认，同 turn 续行），带 30min 超时降级、env 回退开关、多问题卡片点选与提交分离交互。

**Architecture:** pi-runtime 新增内存 PendingToolRegistry（工具 execute 内 await pending promise，agent loop 天然挂起）；新端点 `/sessions/:id/answers`（幂等 resolve）与 `/sessions/:id/pending`（状态查询）；propose_generation 阻塞等待 = 轮询画布 SSOT 节点状态；Nest 纯透传（sessionKey 推导复用 `threadId?.trim() || sessionId`）；前端 AskUserCard 点选与提交分离，提交走 /answers。vendored pi 零改动。

**Tech Stack:** pi-runtime（fastify + node:test + tsx）、NestJS（vitest）、Vue 3（vitest + @vue/test-utils）。

**Spec:** `docs/superpowers/specs/2026-09-30-ask-user-blocking-design.md`（B-1~B-6 已全部确认按推荐默认）

## Global Constraints

- vendored pi（`vendor/earendil-works/pi/`）零改动（VENDORED.md 纪律）
- 测试运行器：pi-runtime 用 node:test（`pnpm test`，脚本 `node --import tsx --test`）；apps/server、apps/web 用 vitest
- 本地测试纪律：单文件串行（双文件 vitest 必被 SIGTERM 137）；`pnpm test > log 2>&1` 再 grep（禁管道 head）；pi-runtime 单测可 `node --import tsx --test src/<file>.test.ts` 定点跑
- 裸 `tsc --noEmit` 在 apps/web 不可用（.vue 伪错误）；web 类型门 = `vue-tsc -b`（CI Build monorepo 兜底）
- Edit/Write 后落盘复核：判据只有 `git status` 的 ` M`/`??`；Bash grep 有假阴性史，用 Grep 工具 + git status
- 数字 env（`ASK_USER_TIMEOUT_MS`）helm 部署必须 `--set-string`（rev 30-32 科学计数法事故）
- `AskUserQuestion` 类型在 `pi-events.ts`（server）与 `AskUserCard.vue`（web）各有一份内联同构副本，改动必须三处同步（pi-runtime ask-user.ts / server pi-events.ts / web AskUserCard.vue）
- 回退开关语义：`ASK_USER_BLOCKING` 解析用 runtime-config.ts 既有 `parseBool`（true/1/yes/on），缺省 **true**（阻塞为新默认行为）

## Review Focus

spec 隐含但无任务测试直接覆盖、最易咬到使用者的输入/条件（每行已挂到所属任务的测试步骤）：

1. **超时后迟到的 /answers**：必须 200 `{ok:true, deduped:true}`，绝不 404/500（前端重试安全）→ Task 3 Step 1 用例「幂等：未知 callId」
2. **部分作答 + 超时**：已答问题交还模型、未答标 `skipped:true`，模型能看到「答了风格没答张数」→ Task 2 Step 1 用例「部分作答超时」
3. **阻塞确认后同 turn run_***：确认过的提议不得再被「同轮自批」拦截 → Task 4 Step 1 用例「confirmed 提议放行」
4. **30min 阻塞等待中会话被 sweeper 回收**：`entry.prompting` 豁免必须覆盖阻塞等待 → Task 3 Step 5 回归用例
5. **`ASK_USER_BLOCKING=off` 时逐字节等同现行为**：卡片立即返回、details 无 `confirmed` 字段、gate 语义不变 → Task 2 Step 3 用例「开关 off」+ Task 4 Step 3 用例「off 无 confirmed」
6. **刷新后卡片恢复且可答**：callId 随 metadata.executionEvents 落盘恢复 → Task 6 Step 1 用例「恢复含 callId」

---

### Task 1: PendingToolRegistry + env 配置（pi-runtime）

**Files:**
- Create: `services/pi-runtime/src/pending-registry.ts`
- Create: `services/pi-runtime/src/pending-registry.test.ts`
- Modify: `services/pi-runtime/src/runtime-config.ts`（追加 2 个配置项）

**Interfaces:**
- Consumes: 无（纯新组件）
- Produces（后续任务依赖的精确签名）:
  ```ts
  export type PendingResolution =
    | { status: "answered"; answers: Record<string, string[]> }
    | { status: "timeout"; answers: Record<string, string[]>; partial: boolean }
    | { status: "aborted" };
  export interface PendingInfo { callId: string; toolName: string; }
  export class PendingToolRegistry {
    waitForUser(sessionId: string, callId: string, toolName: string, timeoutMs: number): Promise<PendingResolution>
    answer(sessionId: string, callId: string, answers: Record<string, string[]>): { ok: true; deduped: boolean }
    cancel(sessionId: string, callId: string): void          // propose 确认后清理 pending 条目
    abortAll(sessionId: string): number                       // 返回清掉的条目数
    hasPending(sessionId: string): boolean
    pendingInfo(sessionId: string): PendingInfo | null
  }
  ```
  runtime-config 新增：`askUserBlocking(env): boolean`（parseBool(env.ASK_USER_BLOCKING, true)）、`askUserTimeoutMs(env): number`（parsePositiveInt(env.ASK_USER_TIMEOUT_MS, 1_800_000)）

- [x] **Step 1: 写失败测试（node:test 风格，对齐 gate 测试惯例）**

```ts
// services/pi-runtime/src/pending-registry.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PendingToolRegistry } from "./pending-registry.js";

describe("PendingToolRegistry", () => {
	it("answer resolves waitForUser with answers", async () => {
		const reg = new PendingToolRegistry();
		const p = reg.waitForUser("s1", "c1", "ask_user", 60_000);
		const r = reg.answer("s1", "c1", { style: ["watercolor"] });
		assert.deepEqual(r, { ok: true, deduped: false });
		assert.deepEqual(await p, { status: "answered", answers: { style: ["watercolor"] } });
	});

	it("timeout resolves with partial answers (not reject)", async () => {
		const reg = new PendingToolRegistry();
		const p = reg.waitForUser("s1", "c1", "ask_user", 10);
		reg.answer("s1", "c1", { style: ["ink"] }).ok; // 答了一题但 callId 仍 pending？否——answer 即 resolve。
		// 部分作答的正确模拟：waitForUser 期间不 answer，timer 到点 → 已答为空。
		// 部分作答路径由 ask_user 工具层组装（Task 2），registry 只保证 timeout 携带 answered-so-far。
		const partialReg = new PendingToolRegistry();
		const pp = partialReg.waitForUser("s2", "c2", "ask_user", 10);
		const res = await pp;
		assert.equal(res.status, "timeout");
		assert.deepEqual((res as { answers: Record<string, string[]> }).answers, {});
		assert.equal((res as { partial: boolean }).partial, false);
		await p; // 上面已 resolve，防 unhandled
	});

	it("部分作答后超时：timeout 携带已答内容且 partial=true", async () => {
		const reg = new PendingToolRegistry();
		const p = reg.waitForUser("s3", "c3", "ask_user", 30);
		// 模拟「记下第一题答案但不提交」：registry 暴露 recordPartial（见实现）供工具层暂存
		reg.recordPartial("s3", "c3", { style: ["ink"] });
		const res = await p;
		assert.equal(res.status, "timeout");
		assert.deepEqual((res as { answers: Record<string, string[]> }).answers, { style: ["ink"] });
		assert.equal((res as { partial: boolean }).partial, true);
	});

	it("幂等：未知 callId / 重复 answer 返回 deduped=true，不抛错", () => {
		const reg = new PendingToolRegistry();
		assert.deepEqual(reg.answer("sx", "ghost", { a: ["b"] }), { ok: true, deduped: true });
		const reg2 = new PendingToolRegistry();
		void reg2.waitForUser("s", "c", "ask_user", 60_000);
		assert.deepEqual(reg2.answer("s", "c", { a: ["1"] }), { ok: true, deduped: false });
		assert.deepEqual(reg2.answer("s", "c", { a: ["2"] }), { ok: true, deduped: true }); // 已 resolve → deduped
	});

	it("abortAll resolves 所有 pending 为 aborted", async () => {
		const reg = new PendingToolRegistry();
		const p1 = reg.waitForUser("s", "c1", "ask_user", 60_000);
		const p2 = reg.waitForUser("s", "c2", "propose_generation", 60_000);
		assert.equal(reg.abortAll("s"), 2);
		assert.deepEqual(await p1, { status: "aborted" });
		assert.deepEqual(await p2, { status: "aborted" });
		assert.equal(reg.hasPending("s"), false);
	});

	it("cancel 清理条目不 resolve 值语义（供 propose 确认后收尾）", async () => {
		const reg = new PendingToolRegistry();
		const p = reg.waitForUser("s", "c", "propose_generation", 60_000);
		reg.cancel("s", "c");
		assert.equal(reg.hasPending("s"), false);
		assert.deepEqual(await p, { status: "aborted" }); // cancel 以 aborted resolve（等待方用 race 不会消费它）
		assert.equal(reg.abortAll("s"), 0); // timer 已清，不再二次触发
	});

	it("pendingInfo 返回当前 pending（多入口防御性取首个）", () => {
		const reg = new PendingToolRegistry();
		assert.equal(reg.pendingInfo("s"), null);
		void reg.waitForUser("s", "c9", "ask_user", 60_000);
		assert.deepEqual(reg.pendingInfo("s"), { callId: "c9", toolName: "ask_user" });
	});

	it("同 callId 重复 waitForUser 抛错（串行 loop 下不该发生，fail loud）", () => {
		const reg = new PendingToolRegistry();
		void reg.waitForUser("s", "c", "ask_user", 60_000);
		assert.throws(() => reg.waitForUser("s", "c", "ask_user", 60_000), /duplicate pending/i);
	});
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd services/pi-runtime && node --import tsx --test src/pending-registry.test.ts 2>&1 | tail -5`
Expected: FAIL（Cannot find module './pending-registry.js'）

- [x] **Step 3: 实现 PendingToolRegistry**

```ts
// services/pi-runtime/src/pending-registry.ts
/**
 * PendingToolRegistry（spec 2026-09-30 §4.1/§4.4）：阻塞式确认类工具的等待注册表。
 *
 * 键 = 画布会话 id（tc.sessionId，工具域一致）：工具只有 toolContext.sessionId（画布 id），
 * abort 联动（session-manager）与 /answers 端点（index 侧）经 entry.canvasSessionId /
 * getCanvasSessionId 换算到本键，pi-runtime 内不做二次解析。
 * 语义铁律（B-4）：**resolve 不 reject** —— 超时/中止一律以带 status 的正常值交还，
 * 模型看到的是工具结果而非异常；超时携带 answered-so-far（partial 语义）。
 */
export type PendingResolution =
	| { status: "answered"; answers: Record<string, string[]> }
	| { status: "timeout"; answers: Record<string, string[]>; partial: boolean }
	| { status: "aborted" };

export interface PendingInfo {
	callId: string;
	toolName: string;
}

interface PendingEntry {
	toolName: string;
	resolve: (r: PendingResolution) => void;
	timer: NodeJS.Timeout;
	/** 工具层在用户逐题作答（未提交）期间暂存的答案；超时时作为 partial 交还。 */
	partial: Record<string, string[]>;
	settled: boolean;
}

export class PendingToolRegistry {
	private readonly entries = new Map<string, Map<string, PendingEntry>>();

	waitForUser(sessionId: string, callId: string, toolName: string, timeoutMs: number): Promise<PendingResolution> {
		const byCall = this.entries.get(sessionId);
		if (byCall?.has(callId)) {
			throw new Error(`duplicate pending callId: ${callId} (session ${sessionId})`);
		}
		return new Promise<PendingResolution>((resolve) => {
			const entry: PendingEntry = {
				toolName,
				resolve: (r) => {
					if (entry.settled) return;
					entry.settled = true;
					clearTimeout(entry.timer);
					this.entries.get(sessionId)?.delete(callId);
					resolve(r);
				},
				timer: undefined as never,
				partial: {},
				settled: false,
			};
			entry.timer = setTimeout(() => {
				entry.resolve({ status: "timeout", answers: { ...entry.partial }, partial: Object.keys(entry.partial).length > 0 });
			}, timeoutMs);
			entry.timer.unref?.();
			if (!byCall) this.entries.set(sessionId, new Map([[callId, entry]]));
			else byCall.set(callId, entry);
		});
	}

	/** 幂等：未知 callId / 已 settle 一律 {ok:true, deduped:true}（回答端点重试安全，spec §6.2）。 */
	answer(sessionId: string, callId: string, answers: Record<string, string[]>): { ok: true; deduped: boolean } {
		const entry = this.entries.get(sessionId)?.get(callId);
		if (!entry) return { ok: true, deduped: true };
		entry.resolve({ status: "answered", answers });
		return { ok: true, deduped: false };
	}

	/** 工具层逐题暂存（未提交）；超时时随 timeout resolution 交还（Review Focus 2）。 */
	recordPartial(sessionId: string, callId: string, answers: Record<string, string[]>): void {
		const entry = this.entries.get(sessionId)?.get(callId);
		if (!entry) return;
		entry.partial = { ...entry.partial, ...answers };
	}

	/** propose 确认轮询收尾：清条目清 timer，等待方（Promise.race 另一臂）不消费此 resolve。 */
	cancel(sessionId: string, callId: string): void {
		this.entries.get(sessionId)?.get(callId)?.resolve({ status: "aborted" });
	}

	abortAll(sessionId: string): number {
		const byCall = this.entries.get(sessionId);
		if (!byCall) return 0;
		const n = byCall.size;
		for (const entry of [...byCall.values()]) entry.resolve({ status: "aborted" });
		this.entries.delete(sessionId);
		return n;
	}

	hasPending(sessionId: string): boolean {
		return (this.entries.get(sessionId)?.size ?? 0) > 0;
	}

	pendingInfo(sessionId: string): PendingInfo | null {
		const first = this.entries.get(sessionId)?.entries().next();
		if (!first || first.done) return null;
		return { callId: first.value[0], toolName: first.value[1].toolName };
	}
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `cd services/pi-runtime && node --import tsx --test src/pending-registry.test.ts 2>&1 | tail -5`
Expected: 全部 pass

- [x] **Step 5: runtime-config.ts 追加配置（含测试）**

在 `runtime-config.ts` 末尾追加（不进 RuntimeConfig 接口——这两个配置由工具层消费，不归 SessionManager）：

```ts
/** B-1/B-5：阻塞式确认类工具开关（ask_user / propose_generation）。off = 退回非阻塞 v1 行为。 */
export function askUserBlocking(env: Record<string, string | undefined> = process.env): boolean {
	return parseBool(env.ASK_USER_BLOCKING, true);
}

/** B-1：阻塞等待上限，缺省 30min。⚠️ helm 部署必须 --set-string（科学计数法事故）。 */
export function askUserTimeoutMs(env: Record<string, string | undefined> = process.env): number {
	return parsePositiveInt(env.ASK_USER_TIMEOUT_MS, 1_800_000);
}
```

在 `runtime-config.test.ts` 追加用例：

```ts
it("askUserBlocking: 缺省 true，off/false/0 关闭", () => {
	assert.equal(askUserBlocking({}), true);
	assert.equal(askUserBlocking({ ASK_USER_BLOCKING: "off" }), false);
	assert.equal(askUserBlocking({ ASK_USER_BLOCKING: "1" }), true);
});
it("askUserTimeoutMs: 缺省 30min，非法回退，小数截断", () => {
	assert.equal(askUserTimeoutMs({}), 1_800_000);
	assert.equal(askUserTimeoutMs({ ASK_USER_TIMEOUT_MS: "60000" }), 60_000);
	assert.equal(askUserTimeoutMs({ ASK_USER_TIMEOUT_MS: "abc" }), 1_800_000);
	assert.equal(askUserTimeoutMs({ ASK_USER_TIMEOUT_MS: "1500.7" }), 1500);
});
```

- [x] **Step 6: 跑测试 + 提交**

Run: `cd services/pi-runtime && node --import tsx --test src/pending-registry.test.ts src/runtime-config.test.ts 2>&1 | tail -4`
Expected: 全部 pass（node --test 多文件无 137 问题）

```bash
git add services/pi-runtime/src/pending-registry.ts services/pi-runtime/src/pending-registry.test.ts services/pi-runtime/src/runtime-config.ts services/pi-runtime/src/runtime-config.test.ts
git commit -m "feat(pi-runtime): PendingToolRegistry + ASK_USER_BLOCKING/TIMEOUT 配置（阻塞确认基建）"
```

---

### Task 2: ask_user 阻塞分支 + 回退开关（pi-runtime）

**Files:**
- Modify: `services/pi-runtime/src/tools/ask-user.ts`（execute 重写）
- Modify: `services/pi-runtime/src/tools/ask-user.test.ts`（如无则创建；现有 `tools/ui-command.test.ts` 模式可参照）
- Modify: `services/pi-runtime/src/tools/config.ts:51`（buildAskUserTools 注入 registry）

**Interfaces:**
- Consumes: Task 1 的 `PendingToolRegistry.waitForUser/recordPartial`、`askUserBlocking()/askUserTimeoutMs()`
- Produces:
  - `buildAskUserTools(metrics: Metrics, registry?: PendingToolRegistry): LnkpiTool[]`（第二参可选，缺省 = 非阻塞旧行为）
  - ask_user 卡片 payload 升级：canvas_command `[{type:"ask_user", callId: <toolCallId>, questions}]`（**新增 callId 字段**，前端 Task 6 依赖）
  - config.ts：`resolveToolsWithClient(metrics, deps?: { registry?: PendingToolRegistry })` 返回值追加 `registry: PendingToolRegistry | null`

- [x] **Step 1: 写失败测试**

```ts
// services/pi-runtime/src/tools/ask-user.test.ts（文件已存在则追加 describe；node:test 风格）
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAskUserTools } from "./ask-user.js";
import { PendingToolRegistry } from "../pending-registry.js";
import type { Metrics } from "../metrics.js";

const metrics = { observeToolCall: () => {} } as unknown as Metrics;

function lastText(result: { content: Array<{ type: string; text?: string }> }): string {
	const block = result.content[0];
	assert.ok(block && block.type === "text" && typeof block.text === "string");
	return block.text;
}

describe("ask_user 阻塞分支（B-1/B-5）", () => {
	it("开关缺省开 + registry 注入 → 等待 answer 后同 promise 返回答案", async () => {
		const reg = new PendingToolRegistry();
		const [tool] = createAskUserTools(metrics, reg);
		const questions = [{ id: "style", question: "风格？", options: [{ label: "水墨", value: "ink" }] }];
		const pending = tool.execute!("call-1", { questions }, undefined, { sessionId: "canvas-1" } as never, undefined as never, undefined as never);
		// 卡片 payload 带 callId（前端提交依据）
		const card = (await Promise.race([pending.then(() => null), Promise.resolve(true)]));
		assert.ok(card); // execute 未提前返回（还在等待）
		const answered = reg.answer("canvas-1", "call-1", { style: ["ink"] });
		assert.equal(answered.deduped, false);
		const result = (await pending) as { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };
		assert.match(lastText(result), /answered/);
		assert.match(lastText(result), /ink/);
	});

	it("registry.cancel（abort 联动）→ 返回「用户已中止」文本，不抛错", async () => {
		const reg = new PendingToolRegistry();
		const [tool] = createAskUserTools(metrics, reg);
		const questions = [{ id: "q", question: "Q", options: [{ label: "A", value: "a" }] }];
		const pending = tool.execute!("c", { questions }, undefined, { sessionId: "s" } as never, undefined as never, undefined as never);
		reg.abortAll("s");
		const result = (await pending) as { content: Array<{ type: string; text: string }> };
		assert.match(lastText(result), /中止/);
	});

	it("部分作答 + 超时 → 已答交还 + 未答标 skipped（Review Focus 2）", async () => {
		const reg = new PendingToolRegistry();
		const [tool] = createAskUserTools(metrics, reg, { timeoutMs: 20 });
		const questions = [
			{ id: "style", question: "风格？", options: [{ label: "水墨", value: "ink" }] },
			{ id: "count", question: "张数？", options: [{ label: "1", value: "1" }] },
		];
		const pending = tool.execute!("c", { questions }, undefined, { sessionId: "s" } as never, undefined as never, undefined as never);
		// 用户答了 style 但没提交（模拟逐题暂存）：工具层在 answer 前把已答写入 registry
		// —— 通过 recordPartial 的公开路径；这里直接调（工具内部同样如此）
		reg.recordPartial("s", "c", { style: ["ink"] });
		const result = (await pending) as { content: Array<{ type: string; text: string }> };
		const text = lastText(result);
		assert.match(text, /未响应/);
		assert.match(text, /ink/);
		assert.match(text, /skipped/);
	});

	it("开关 off（env ASK_USER_BLOCKING=off）→ 逐字节旧行为：立即返回无 callId 等待", async () => {
		const prev = process.env.ASK_USER_BLOCKING;
		process.env.ASK_USER_BLOCKING = "off";
		try {
			const reg = new PendingToolRegistry();
			const [tool] = createAskUserTools(metrics, reg);
			const questions = [{ id: "q", question: "Q", options: [{ label: "A", value: "a" }] }];
			const result = (await tool.execute!("c", { questions }, undefined, { sessionId: "s" } as never, undefined as never, undefined as never)) as { details: { canvasCommands: Array<Record<string, unknown>> } };
			const cmd = result.details.canvasCommands[0];
			assert.equal(cmd.type, "ask_user");
			assert.equal(reg.hasPending("s"), false); // 未注册 pending
		} finally {
			if (prev === undefined) delete process.env.ASK_USER_BLOCKING;
			else process.env.ASK_USER_BLOCKING = prev;
		}
	});
});
```

实现说明（写测试时同步确认）：`createAskUserTools` 第三参 `{ timeoutMs?: number }` 供测试注入短超时；生产路径读 `askUserTimeoutMs()`。

- [x] **Step 2: 跑测试确认失败**

Run: `cd services/pi-runtime && node --import tsx --test src/tools/ask-user.test.ts 2>&1 | tail -5`
Expected: FAIL（createAskUserTools 不接受第二参 / 无 callId 字段）

- [x] **Step 3: 重写 ask-user.ts**

```ts
// services/pi-runtime/src/tools/ask-user.ts —— execute 替换为：
import { askUserBlocking, askUserTimeoutMs } from "../runtime-config.js";
import type { PendingToolRegistry } from "../pending-registry.js";

export function createAskUserTools(
	metrics: Metrics,
	registry?: PendingToolRegistry,
	opts: { timeoutMs?: number } = {},
): LnkpiTool[] {
	return [{
		tier: "ui_command" as const,
		name: "ask_user",
		label: "向用户提问",
		// description 更新：阻塞语义（B-1）
		description: "Present clickable option chips plus free-text other to the user and WAIT for the answer within this turn (bounded, auto-degrades on timeout). Multi-question cards: the user answers all questions before submitting.",
		parameters: Type.Object({
			questions: Type.Array(Type.Object({
				id: Type.String({ description: "stable question id, e.g. scene" }),
				question: Type.String({ description: "question text shown to user" }),
				options: Type.Array(Type.Object({
					label: Type.String(),
					value: Type.String({ description: "text sent back as user message when chip clicked" }),
				}), { min: 1 }),
				multiSelect: Type.Optional(Type.Boolean()),
				allowOther: Type.Optional(Type.Boolean({ description: "show free-text other input, default true" })),
			}), { min: 1, max: 4 }),
		}),
		execute: async (id, p: { questions: AskUserQuestion[] }) => {
			metrics.observeToolCall("ask_user", "ok");
			// B-5 off（或无 registry，如纯文本模式）→ 旧行为逐字节保留：立即返回，无 callId
			if (!registry || !askUserBlocking()) {
				return uiResult([{ type: "ask_user", questions: p.questions }]);
			}
			// 阻塞分支：卡片 payload 带 callId（前端 POST /answers 的依据，Task 6）
			const timeoutMs = opts.timeoutMs ?? askUserTimeoutMs();
			const wait = registry.waitForUser(id, id, "ask_user", timeoutMs);
			// ⚠️ waitForUser 首参是 registry 键（= tc.sessionId 画布 id）；此处 tc 未进作用域时
			// 用 callId 侧的 session 不可行 —— execute 第 4 参 tc 必须透传（签名见 types.ts LnkpiTool），
			// 实际实现用 tc.sessionId 作键：registry.waitForUser(tc.sessionId, id, "ask_user", timeoutMs)
			// （上方 wait 行以伪码示意；落地时补 tc 参数 —— execute 签名第 4 参 LnkpiToolContext）
			// ── 超时兜底由 registry timer 驱动（resolve 不 reject，B-4）
			const resolution = await wait;
			if (resolution.status === "aborted") {
				return {
					content: [{ type: "text", text: JSON.stringify({ ok: false, aborted: true, message: "用户已中止本轮对话。" }) }],
					details: { ok: false, aborted: true },
				};
			}
			if (resolution.status === "timeout") {
				const answered = resolution.answers;
				const skipped = p.questions.filter((q) => !answered[q.id]).map((q) => ({ id: q.id, skipped: true }));
				return {
					content: [{
						type: "text",
						text: JSON.stringify({
							ok: true, answered: true, partial: resolution.partial,
							answers: answered, skipped,
							message: "用户未响应，请基于现有信息自主决策继续；用户之后补充回答时会作为新消息到达。",
						}),
					}],
					details: { ok: true, answered: true, partial: resolution.partial },
				};
			}
			return {
				content: [{ type: "text", text: JSON.stringify({ ok: true, answered: true, answers: resolution.answers }) }],
				details: { ok: true, answered: true },
			};
		},
	}];
}
```

⚠️ 落地注意（实现者必读）：execute 真实签名是 `async (id, p, _u, tc: LnkpiToolContext, _invocation, context) => {...}`（参照 generation.ts:67-74）——registry 键必须用 **`tc.sessionId`**（画布 id），不是 id。上面代码块的 `waitForUser(id, id, ...)` 是占位示意，落地时改为 `waitForUser(tc.sessionId, id, "ask_user", timeoutMs)`，测试中相应以 `{ sessionId: "canvas-1" }` 作 tc。同时 canvas_command payload 改为 `[{ type: "ask_user", callId: id, questions: p.questions }]`。

- [x] **Step 4: 跑测试确认通过 + config.ts 接线**

`config.ts` 改动：

```ts
// resolveToolsWithClient 签名与返回：
export function resolveToolsWithClient(
	metrics: Metrics,
	deps: { registry?: PendingToolRegistry } = {},
): { tools: LnkpiTool[]; client: NestClient | null; registry: PendingToolRegistry | null } {
	// 纯文本模式分支：return { tools: [], client: null, registry: deps.registry ?? null };
	// tools 数组中：...buildAskUserTools(metrics, deps.registry),
	// 末尾：return { tools, client, registry: deps.registry ?? null };
}
```

（`resolveTools(metrics)` 包装同步透传 registry 不需要——它只取 tools。）

Run: `cd services/pi-runtime && node --import tsx --test src/tools/ask-user.test.ts src/tools/config.test.ts 2>&1 | tail -5`
Expected: 全部 pass（config.test.ts 的工具计数断言若因 registry 参数受影响，按「无 TAVILY=33/有=35」基线核对——本任务不增删工具数量，计数应不变）

- [x] **Step 5: 提交**

```bash
git add services/pi-runtime/src/tools/ask-user.ts services/pi-runtime/src/tools/ask-user.test.ts services/pi-runtime/src/tools/config.ts
git commit -m "feat(pi-runtime): ask_user 阻塞分支——等待用户作答同 turn 续行，ASK_USER_BLOCKING=off 回退"
```

---

### Task 3: /answers + /pending 端点 + abort 联动 + sweeper 回归（pi-runtime）

**Files:**
- Modify: `services/pi-runtime/src/app.ts`（2 个新端点；AppDeps 加 registry）
- Modify: `services/pi-runtime/src/session-manager.ts:751`（abort 联动 abortAll）
- Modify: `services/pi-runtime/src/app.test.ts`（端点用例）
- Modify: `services/pi-runtime/src/session-sweeper.test.ts`（回归用例）
- Modify: `services/pi-runtime/src/index.ts`（装配 registry：创建实例 → resolveToolsWithClient 传入 → buildApp deps 传入 → manager.setPendingRegistry）

**Interfaces:**
- Consumes: Task 1 registry 全部方法；`manager.getCanvasSessionId(threadKey)`（session-manager.ts:639）
- Produces:
  - `POST /sessions/:sessionId/answers` body `{callId, answers: Record<string,string[]>, answerId?}` → 200 `{ok:true, deduped:boolean}`（**永不 404/500 于业务路径**，Review Focus 1）
  - `GET /sessions/:sessionId/pending` → 200 `{pending: {callId, toolName} | null}`（会话不存在也 200 `{pending:null}`，不给探测面）
  - `SessionManager.setPendingRegistry(registry: PendingToolRegistry): void`（index.ts 装配用，避免改长构造签名）
  - AppDeps 增 `registry?: PendingToolRegistry`

- [x] **Step 1: 写失败测试（app.test.ts 追加，fastify inject 风格对齐既有用例）**

```ts
// 追加到 app.test.ts（node:test + app.inject；mock manager 模式对齐既有用例——
// 若既有用例用真 SessionManager，则沿用；以下按 mock manager 写，落地时对齐现有 fixture）：
describe("POST /sessions/:id/answers（幂等，Review Focus 1）", () => {
	it("正常 resolve → 200 {ok:true,deduped:false}", async () => {
		const reg = new PendingToolRegistry();
		void reg.waitForUser("canvas-1", "c1", "ask_user", 60_000);
		const app = buildApp(mockManagerWithCanvasId("canvas-1"), { metrics, version: "t", registry: reg });
		const res = await app.inject({ method: "POST", url: "/sessions/thread-1/answers", payload: { callId: "c1", answers: { q: ["a"] } } });
		assert.equal(res.statusCode, 200);
		assert.deepEqual(res.json(), { ok: true, deduped: false });
	});
	it("未知 callId / 已超时清理 → 仍 200 {ok:true,deduped:true}（不 404/500）", async () => {
		const reg = new PendingToolRegistry();
		const app = buildApp(mockManagerWithCanvasId("canvas-1"), { metrics, version: "t", registry: reg });
		const res = await app.inject({ method: "POST", url: "/sessions/thread-1/answers", payload: { callId: "ghost", answers: {} } });
		assert.equal(res.statusCode, 200);
		assert.deepEqual(res.json(), { ok: true, deduped: true });
	});
	it("sessionKey→canvasId 换算：registry 以画布 id 为键，端点按 pi 会话键路由", async () => {
		// mockManagerWithCanvasId 的 getCanvasSessionId("thread-1") 返回 "canvas-1"
		// 上面第一个用例已隐式覆盖（waitForUser 注册键 = canvas-1，请求 URL 是 thread-1）
	});
});
describe("GET /sessions/:id/pending", () => {
	it("有 pending → {pending:{callId,toolName}}；无 → {pending:null}；会话不存在 → {pending:null}", async () => {
		const reg = new PendingToolRegistry();
		void reg.waitForUser("canvas-1", "c1", "ask_user", 60_000);
		const app = buildApp(mockManagerWithCanvasId("canvas-1"), { metrics, version: "t", registry: reg });
		assert.deepEqual((await app.inject({ method: "GET", url: "/sessions/thread-1/pending" })).json(), { pending: { callId: "c1", toolName: "ask_user" } });
		assert.deepEqual((await app.inject({ method: "GET", url: "/sessions/thread-1/pending" })).json(), { pending: { callId: "c1", toolName: "ask_user" } });
		const app2 = buildApp(mockManagerWithCanvasId("other"), { metrics, version: "t", registry: reg });
		assert.deepEqual((await app2.inject({ method: "GET", url: "/sessions/thread-x/pending" })).json(), { pending: null });
	});
});
```

（`mockManagerWithCanvasId` 若无现成 fixture 则在测试文件顶部新建：`{ getCanvasSessionId: (k: string) => k === "thread-1" ? "canvas-1" : k, count: () => 0, listSkills: () => [] } as unknown as SessionManager`。）

- [x] **Step 2: 跑测试确认失败**

Run: `cd services/pi-runtime && node --import tsx --test src/app.test.ts 2>&1 | tail -5`
Expected: FAIL（404 路由不存在）

- [x] **Step 3: 实现端点**

```ts
// app.ts —— AppDeps 增 registry?: PendingToolRegistry；在 /abort 路由后追加：
app.post<{
	Params: { sessionId: string };
	Body: { callId?: string; answers?: Record<string, string[]>; answerId?: string };
}>("/sessions/:sessionId/answers", async (request, reply) => {
	const { registry } = deps;
	if (!registry) return reply.code(503).send({ error: "pending registry not configured" });
	const callId = request.body?.callId;
	if (!callId || typeof request.body?.answers !== "object" || request.body.answers === null) {
		return reply.code(400).send({ error: "callId and answers are required" });
	}
	// registry 键 = 画布会话 id（工具域），路由参数 = pi 会话键 → getCanvasSessionId 换算
	// （#74/#76 解耦语义的镜像：会话不存在时回落键本身，registry 查不到 → 幂等 deduped，无副作用）
	const canvasId = manager.getCanvasSessionId(request.params.sessionId);
	const r = registry.answer(canvasId, callId, request.body.answers);
	return reply.send(r);
});

app.get<{ Params: { sessionId: string } }>("/sessions/:sessionId/pending", async (request, reply) => {
	const { registry } = deps;
	if (!registry) return reply.send({ pending: null });
	const canvasId = manager.getCanvasSessionId(request.params.sessionId);
	return reply.send({ pending: registry.pendingInfo(canvasId) });
});
```

- [x] **Step 4: 跑端点测试确认通过**

Run: `cd services/pi-runtime && node --import tsx --test src/app.test.ts 2>&1 | tail -4`
Expected: 全部 pass

- [x] **Step 5: abort 联动 + sweeper 回归**

session-manager.ts 类内追加公开方法 + abort() 改造：

```ts
// SessionManager 字段区
private pendingRegistry?: PendingToolRegistry;

/** index.ts 装配用（构造签名长，避免位置参数漂移）。 */
setPendingRegistry(registry: PendingToolRegistry): void {
	this.pendingRegistry = registry;
}

// abort()（:751）改造——entry 找到即联动（防御性：无 cancelRun 也尝试 abortAll）：
abort(threadKey: string): boolean {
	const entry = this.sessions.get(toSessionKey(threadKey));
	if (entry) this.pendingRegistry?.abortAll(entry.canvasSessionId ?? entry.id);
	if (!entry?.cancelRun) return false;
	entry.userAborted = true;
	entry.cancelRun("user_cancel");
	entry.cancelRun = undefined;
	return true;
}
```

sweeper 回归用例（session-sweeper.test.ts 追加，Review Focus 4——**验证既有 `entry.prompting` 豁免覆盖阻塞等待**，不新增生产代码）：

```ts
it("阻塞等待中的会话（prompting=true + registry pending）不被 TTL 回收", async () => {
	// 复用文件内既有「构建 manager + 触发 prompt」fixture；prompt 用 mock harness 使
	// execute 内 await 一个永不 resolve 的 promise 模拟 registry 阻塞。
	// prompt 后 entry.prompting === true → sweepOnce(now + ttl + 1) 不回收该会话。
	// 若文件内已有「prompting 豁免」用例，则在其上补 registry pending 组合断言即可。
});
```

（落地时以 fixture 实况为准：若既有用例已断言 `prompting=true 不回收`，追加一行注释说明阻塞等待亦走此路径 + 保持用例名提及阻塞场景即可，避免为组合而复制 fixture。）

Run: `cd services/pi-runtime && node --import tsx --test src/app.test.ts src/session-sweeper.test.ts 2>&1 | tail -4`
Expected: 全部 pass

- [x] **Step 6: index.ts 装配 + 提交**

```ts
// index.ts：
import { PendingToolRegistry } from "./pending-registry.js";
const registry = new PendingToolRegistry();
const { tools, client: nestClient } = resolveToolsWithClient(metrics, { registry });
// manager 构建后：
manager.setPendingRegistry(registry);
const app = buildApp(manager, { metrics, version: VERSION, logger: true, registry });
```

```bash
git add services/pi-runtime/src/app.ts services/pi-runtime/src/app.test.ts services/pi-runtime/src/session-manager.ts services/pi-runtime/src/session-sweeper.test.ts services/pi-runtime/src/index.ts
git commit -m "feat(pi-runtime): /answers（幂等）+/pending 端点 + abort 联动 abortAll + sweeper 阻塞豁免回归"
```

---

### Task 4: propose_generation 阻塞确认 + gate confirmed 联动（pi-runtime）

**Files:**
- Modify: `services/pi-runtime/src/tools/canvas-write.ts:219-236`（propose_generation execute）
- Modify: `services/pi-runtime/src/tools/canvas-write.test.ts`（阻塞用例）
- Modify: `services/pi-runtime/src/gate/generation-gate.ts`（confirmed 提议放行）
- Modify: `services/pi-runtime/src/gate/generation-gate.test.ts`
- Modify: `services/pi-runtime/src/index.ts:42-47`（after_tool 读 confirmed）
- Modify: `services/pi-runtime/src/tools/config.ts`（buildCanvasWriteTools 注入 registry）

**Interfaces:**
- Consumes: Task 1 registry（waitForUser/cancel/abortAll + recordPartial 不需要）；`askUserBlocking()/askUserTimeoutMs()`
- Produces:
  - propose_generation 阻塞 resolve 值：`{confirmed: boolean, reason?: "rejected"|"gone"|"timeout"|"aborted"}`（写入工具返回文本与 `details.confirmed`）
  - `GenerationGateStore.markProposed(sessionId, nodeId, opts?: {confirmed?: boolean})`；`wasProposedThisTurn` 对 confirmed 记录返回 **false**（放行同 turn run_*，SSOT pending_confirm 校验兜底）
  - `buildCanvasWriteTools(client: NestClient, registry?: PendingToolRegistry)`

- [x] **Step 1: 写 gate 失败测试（generation-gate.test.ts 追加）**

```ts
test("confirmed 提议放行同 turn run_*（阻塞确认 = 视同跨轮，Review Focus 3）", async () => {
	const store = new GenerationGateStore();
	store.bumpUserTurn("s1"); // turn=1
	store.markProposed("s1", "n1", { confirmed: true }); // 阻塞确认后的 after_tool 记录
	// runs===0：wasProposedThisTurn 必须返回 false（不再拦「同轮自批」），落到 SSOT 检查
	const r = await checkGenerationGate(store, fakeClient({ id: "n_1", data: { status: "pending_confirm" } }), "s1", "run_image_generation", { node_id: "n1" });
	assert.deepEqual(r, { allowed: true });
});

test("未 confirmed 提议（B-5 off 路径）仍拦同轮自批（现行为不变）", async () => {
	const store = new GenerationGateStore();
	store.bumpUserTurn("s1");
	store.markProposed("s1", "n1"); // 无 confirmed
	const r = await checkGenerationGate(store, fakeClient({ id: "n_1", data: { status: "pending_confirm" } }), "s1", "run_image_generation", { node_id: "n1" });
	assert.equal(r.allowed, false);
	assert.match(r.reason ?? "", /propose_generation/);
});
```

- [x] **Step 2: 跑 gate 测试确认失败 → 实现**

Run: `cd services/pi-runtime && node --import tsx --test src/gate/generation-gate.test.ts 2>&1 | tail -4`（第一条 FAIL）

generation-gate.ts 改动：

```ts
// proposals Map 值类型：Map<string, { turn: number; confirmed: boolean }>
markProposed(sessionId: string, nodeId: string, opts: { confirmed?: boolean } = {}): void {
	const turn = this.turns.get(sessionId) ?? 0;
	const map = this.proposals.get(sessionId) ?? new Map<string, { turn: number; confirmed: boolean }>();
	map.set(nodeId, { turn, confirmed: opts.confirmed === true });
	this.proposals.set(sessionId, map);
}

/** 仅当该节点的 propose 发生在「当前用户轮」**且未确认**时返回 true；
 *  confirmed（阻塞确认）视同跨轮，交由 SSOT pending_confirm 校验兜底（spec §4.3）。 */
wasProposedThisTurn(sessionId: string, nodeId: string): boolean {
	const turn = this.turns.get(sessionId) ?? 0;
	const rec = this.proposals.get(sessionId)?.get(nodeId);
	return !!rec && rec.turn === turn && !rec.confirmed;
}
```

Run: `cd services/pi-runtime && node --import tsx --test src/gate/generation-gate.test.ts 2>&1 | tail -4`（全 pass）

- [x] **Step 3: 写 propose 阻塞失败测试（canvas-write.test.ts 追加）**

```ts
describe("propose_generation 阻塞确认（B-2）", () => {
	it("画布确认（status 离开 pending_confirm）→ details.confirmed=true 返回", async () => {
		// nest client mock：propose-generation 成功；get-node 首次 pending_confirm、第二次 completed
		// registry 注入；AS K_USER_BLOCKING 缺省 on
		const reg = new PendingToolRegistry();
		const client = fakeNestClient([
			{ id: "n1", data: { status: "pending_confirm" } }, // get-node #1
			{ id: "n1", data: { status: "completed" } },       // get-node #2 → confirmed
		]);
		const [propose] = createCanvasWriteTools(client, reg).filter((t) => t.name === "propose_generation");
		const result = await run(propose, { node_id: "n1" });
		assert.equal((result.details as { confirmed?: boolean }).confirmed, true);
		assert.equal(reg.hasPending("canvas-1"), false); // cancel 收尾
	});
	it("画布取消（节点消失/404）→ confirmed=false，同轮 run_* 仍被 gate 拦", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClientRejectingGetNode(); // get-node 抛 404
		const [propose] = createCanvasWriteTools(client, reg).filter((t) => t.name === "propose_generation");
		const result = await run(propose, { node_id: "n1" });
		assert.equal((result.details as { confirmed?: boolean }).confirmed, false);
	});
	it("B-5 off → 立即返回、details 无 confirmed（Review Focus 5）", async () => {
		const prev = process.env.ASK_USER_BLOCKING;
		process.env.ASK_USER_BLOCKING = "off";
		try {
			const client = fakeNestClient([{ id: "n1", data: { status: "pending_confirm" } }]);
			const [propose] = createCanvasWriteTools(client).filter((t) => t.name === "propose_generation");
			const result = await run(propose, { node_id: "n1" });
			assert.equal((result.details as { confirmed?: boolean }).confirmed, undefined);
		} finally {
			if (prev === undefined) delete process.env.ASK_USER_BLOCKING;
			else process.env.ASK_USER_BLOCKING = prev;
		}
	});
});
```

（`fakeNestClient` / `run` 对齐文件内既有 helper；`createCanvasWriteTools(client, reg?)` 第二参新增可选。）

Run: `cd services/pi-runtime && node --import tsx --test src/tools/canvas-write.test.ts 2>&1 | tail -4`（新用例 FAIL）

- [x] **Step 4: 实现 propose 阻塞确认**

canvas-write.ts 改动：

```ts
// 文件头追加：
import { askUserBlocking, askUserTimeoutMs } from "../runtime-config.js";
import type { PendingToolRegistry } from "../pending-registry.js";

// createCanvasWriteTools(client: NestClient, registry?: PendingToolRegistry)

// propose_generation execute 替换：
execute: async (id, p: { node_id: string }, _u, tc: LnkpiToolContext, _invocation, context: Context) => {
	if (!tc.userId) throw new Error("propose_generation requires userId in toolContext");
	const base = await client.post("/agent/internal/propose-generation", {
		sessionId: tc.sessionId,
		userId: tc.userId,
		nodeId: p.node_id,
	});
	// B-5 off（或无 registry）→ 旧行为逐字节保留（spec §8 回退纪律）
	if (!registry || !askUserBlocking()) return resultWithActions(base);

	// 阻塞确认：registry 挂 pending（供 /pending 查询与 abort 联动），双臂 race——
	// ① 轮询画布 SSOT（2s 间隔，spec §4.2）；② registry resolution（abort→aborted / 30min timer→timeout）
	const wait = registry.waitForUser(tc.sessionId, id, "propose_generation", askUserTimeoutMs());
	const POLL_MS = 2_000;
	const confirmResult = (async (): Promise<{ confirmed: boolean; reason?: string }> => {
		for (;;) {
			context?.abortSignal?.throwIfAborted();
			await new Promise((r) => setTimeout(r, POLL_MS));
			try {
				const node = await client.post("/agent/internal/get-node", { sessionId: tc.sessionId, nodeId: p.node_id });
				const status = (node as { data?: { status?: unknown } } | null)?.data?.status;
				if (status === "pending_confirm") continue; // 仍在待确认（用户已确认/未动，语义见 spec §4.2）
				return { confirmed: true, reason: String(status ?? "unknown") };
			} catch {
				return { confirmed: false, reason: "gone" }; // 节点消失/查询失败 → 视为用户拒绝（fail-closed 不出图）
			}
		}
	})();
	const outcome = await Promise.race([
		confirmResult,
		wait.then((r) => r.status === "aborted" ? { confirmed: false, reason: "aborted" } : { confirmed: false, reason: "timeout" }),
	]);
	registry.cancel(tc.sessionId, id); // 收尾清理（另一臂未 settle 也无妨：cancel 即清）
	if (!outcome.confirmed) {
		return {
			content: [{ type: "text", text: JSON.stringify({ ok: false, confirmed: false, reason: outcome.reason, message: outcome.reason === "timeout" ? "用户未在时限内确认，请等待用户后续指示，不要自行执行 run_*。" : outcome.reason === "aborted" ? "用户已中止。" : "用户取消了该节点的生成确认，不要执行 run_*；可先了解原因。" }) }],
			details: { ok: false, confirmed: false },
		};
	}
	const withActions = resultWithActions(base);
	return {
		...withActions,
		details: { ...withActions.details, confirmed: true },
		content: [{ type: "text", text: JSON.stringify({ ok: true, confirmed: true, message: "用户已在画布确认，可直接对该节点执行 run_* 生成。" }) }],
	};
},
```

index.ts after_tool hook 改动（:42-47）：

```ts
harness.hooks.on("after_tool", async (event) => {
	if (event.toolName !== "propose_generation" || event.isError) return undefined;
	const nodeId = (event.args as { node_id?: unknown } | undefined)?.node_id;
	if (typeof nodeId !== "string" || !nodeId) return undefined;
	// B-2：阻塞确认后 details.confirmed=true → gate 视同跨轮放行（spec §4.3）
	const confirmed = (event.details as { confirmed?: unknown } | null | undefined)?.confirmed === true;
	gateStore.markProposed(sessionId, nodeId, { confirmed });
	return undefined;
});
```

config.ts：`buildCanvasWriteTools(client)` → `buildCanvasWriteTools(client, deps.registry)`。

Run: `cd services/pi-runtime && node --import tsx --test src/tools/canvas-write.test.ts src/gate/generation-gate.test.ts 2>&1 | tail -4`（全 pass）

- [x] **Step 5: 提交**

```bash
git add services/pi-runtime/src/tools/canvas-write.ts services/pi-runtime/src/tools/canvas-write.test.ts services/pi-runtime/src/gate/generation-gate.ts services/pi-runtime/src/gate/generation-gate.test.ts services/pi-runtime/src/index.ts services/pi-runtime/src/tools/config.ts
git commit -m "feat(pi-runtime): propose_generation 阻塞确认（轮询画布 SSOT）+ gate confirmed 放行同 turn run_*"
```

---

### Task 5: Nest 透传端点 + client 方法

**Files:**
- Modify: `apps/server/src/agent/pi-runtime/pi-runtime.client.ts`（answer/getPending 两方法，放 abortRun 后）
- Modify: `apps/server/src/agent/pi-runtime/pi-runtime.client.test.ts`
- Modify: `apps/server/src/agent/agent.controller.ts`（`@Post('sessions/:sessionId/answers')`）
- Modify: `apps/server/src/agent/agent.service.ts`（answerPiPending 方法）
- Modify: `apps/server/src/agent/agent.service.pi-runtime.test.ts`

**Interfaces:**
- Consumes: Task 3 的 pi-runtime 端点契约
- Produces:
  - `PiRuntimeClient.answer(sessionId, body: {callId, answers, answerId?}): Promise<{ok: boolean; deduped: boolean}>`
  - `PiRuntimeClient.getPending(sessionId): Promise<{callId: string; toolName: string} | null>`
  - `AgentService.answerPiPending(input: {sessionId: string; threadId?: string | null; callId: string; answers: Record<string, string[]>; answerId?: string})`
  - HTTP：`POST /agent/sessions/:sessionId/answers`（Nest 全局前缀按既有部署形态，body 同上 + `threadId`）

- [x] **Step 1: client 失败测试（pi-runtime.client.test.ts 追加，模式对齐 abortRun 用例）**

```ts
it("answer POST /sessions/:id/answers，200 返回 {ok,deduped}", async () => { /* fetch mock：POST body 断言含 callId/answers；响应 {ok:true,deduped:false} */ });
it("answer 幂等响应（deduped:true）不抛错", async () => { /* 响应 {ok:true,deduped:true} */ });
it("getPending GET /sessions/:id/pending → {pending} | null", async () => { /* 两种响应形态各一断言 */ });
```

（fetch mock 写法对齐文件内 abortRun 的既有 mock；测试断言 URL 含 encodeURIComponent(sessionId)。）

- [x] **Step 2: 实现 client 方法**

```ts
// pi-runtime.client.ts —— abortRun 后追加：
/** B-2：向阻塞中的确认类工具提交用户回答（幂等；未知/已清理 callId 返回 deduped=true）。 */
async answer(
	sessionId: string,
	body: { callId: string; answers: Record<string, string[]>; answerId?: string },
): Promise<{ ok: boolean; deduped: boolean }> {
	const { status, body: resp } = await this.request<{ ok?: boolean; deduped?: boolean; error?: string }>(
		`/sessions/${encodeURIComponent(sessionId)}/answers`,
		{ method: "POST", body: JSON.stringify(body) },
	);
	if (status >= 400 || resp?.error) {
		throw new PiRuntimeError(resp?.error ?? `answer failed: HTTP ${status}`, status);
	}
	return { ok: resp?.ok === true, deduped: resp?.deduped === true };
}

/** B-2：查询会话是否有阻塞中的确认类工具（前端 409 降级恢复用）。 */
async getPending(sessionId: string): Promise<{ callId: string; toolName: string } | null> {
	const { status, body } = await this.request<{ pending?: { callId: string; toolName: string } | null }>(
		`/sessions/${encodeURIComponent(sessionId)}/pending`,
		{ method: "GET" },
	);
	if (status >= 400) return null; // 查询失败按无 pending（降级路径，不抛错阻断对话）
	return body?.pending ?? null;
}
```

Run: `cd apps/server && pnpm exec vitest run src/agent/pi-runtime/pi-runtime.client.test.ts 2>&1 | tail -3`（RED→GREEN 全程）

- [x] **Step 3: controller + service**

agent.controller.ts（runs/cancel 之后）：

```ts
/** B-2：向阻塞中的 ask_user/propose_generation 提交回答（透传 pi-runtime /answers）。 */
@Post('sessions/:sessionId/answers')
answerPending(
	@Param('sessionId') sessionId: string,
	@Body() body: { threadId?: string; callId: string; answers: Record<string, string[]>; answerId?: string },
) {
	return this.agentService.answerPiPending({
		sessionId,
		threadId: body.threadId,
		callId: body.callId,
		answers: body.answers,
		answerId: body.answerId,
	});
}
```

agent.service.ts（abortRun 所在方法 ：391 附近，同一 sessionKey 推导纪律）：

```ts
/** B-2：透传用户回答到 pi-runtime pending registry。sessionKey 推导与 ：625/:391 完全一致。 */
async answerPiPending(input: {
	sessionId: string;
	threadId?: string | null;
	callId: string;
	answers: Record<string, string[]>;
	answerId?: string;
}) {
	const piUrl = this.piRuntimeUrl(); // 对齐 ：392 处取 URL 的既有写法（实现时以实际方法名为准）
	const sessionKey = input.threadId?.trim() || input.sessionId;
	return this.createPiRuntimeClient(piUrl).answer(sessionKey, {
		callId: input.callId,
		answers: input.answers,
		...(input.answerId ? { answerId: input.answerId } : {}),
	});
}
```

⚠️ 实现者注意：`piRuntimeUrl()` / `createPiRuntimeClient` 的真实名称以 ：391-392 abort 方法现有写法为准，不要发明新依赖注入形态。

- [x] **Step 4: service 测试（agent.service.pi-runtime.test.ts 追加）**

```ts
it("answerPiPending：threadId 优先推导 sessionKey 并透传 callId/answers", async () => {
	// mock pi client.answer 断言首参 = 'tid-1'、body 含 callId/answers/answerId
});
it("answerPiPending：无 threadId 回落 sessionId", async () => { /* 首参 = sessionId */ });
```

Run: `cd apps/server && pnpm exec vitest run src/agent/agent.service.pi-runtime.test.ts src/agent/pi-runtime/pi-runtime.client.test.ts 2>&1 | tail -3`（单文件串行亦可）
Expected: 全部 pass

- [x] **Step 5: 提交**

```bash
git add apps/server/src/agent/pi-runtime/pi-runtime.client.ts apps/server/src/agent/pi-runtime/pi-runtime.client.test.ts apps/server/src/agent/agent.controller.ts apps/server/src/agent/agent.service.ts apps/server/src/agent/agent.service.pi-runtime.test.ts
git commit -m "feat(server): /agent/sessions/:id/answers 透传端点（sessionKey 推导与 abort 同纪律）"
```

---

### Task 6: 前端 AskUserCard B-6 交互 + answers 提交

**Files:**
- Modify: `apps/web/src/components/agent/AskUserCard.vue`（点选与提交分离重构）
- Modify: `apps/web/src/components/agent/AskUserCard.test.ts`（如无则创建）
- Modify: `apps/web/src/components/agent/AgentSideRail.vue:743-759`（pendingAskUser 生命周期 + onAskSubmit）
- Modify: `apps/web/src/stores/agent.ts` 或 api 层（新增 submitAnswers；以 store 现有 sendMessage 的请求层为准挂同处）
- Modify: pi-runtime → server 侧 callId 透传链（**本任务一并完成**：ask-user.ts payload 已带 callId（Task 2）；核对 `apps/server/src/agent/pi-runtime/pi-events.ts` canvas_command 派生对该字段透传——若 EVENT_MAP 派生是全量透传 data 则零改动，用测试钉住）

**Interfaces:**
- Consumes: Task 5 `POST /agent/sessions/:sessionId/answers`；Task 2 卡片 payload 的 `callId`
- Produces:
  - `AskUserCard` emits：`submit: [payload: { answers: Record<string, string[]> }]`（替代原 `select: [value: string]` 为提交语义；多问题卡内部自行组装）
  - `agent.submitAnswers(threadId, sessionId, callId, answers, answerId?): Promise<{ok, deduped}>`
  - `AgentSideRail` 状态：`pendingAskUser` 元素升级为 `{ callId: string; id: string; question: string; options: ...; multiSelect?; allowOther? }[]`；`onAskSubmit(answers)`；输入框拦截（pending 时自由文本 → 首个未答问题）

- [x] **Step 1: 写 AskUserCard 失败测试（AskUserCard.test.ts）**

```ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AskUserCard from './AskUserCard.vue'

const Q2 = [
	{ id: 'style', question: '风格？', options: [{ label: '水墨', value: 'ink' }, { label: '水彩', value: 'water' }] },
	{ id: 'count', question: '张数？', options: [{ label: '1 张', value: '1' }, { label: '2 张', value: '2' }] },
]

describe('AskUserCard（B-6 点选与提交分离）', () => {
	it('单问题单选：点 chip 即 emit submit（低摩擦主路径）', async () => {
		const w = mount(AskUserCard, { props: { questions: [Q2[0]] } })
		await w.findAll('.ask-chip')[0].trigger('click')
		expect(w.emitted('submit')![0][0]).toEqual({ answers: { style: ['ink'] } })
	})
	it('多问题：点选只高亮不提交；答满自动 submit 全部答案', async () => {
		const w = mount(AskUserCard, { props: { questions: Q2 } })
		const chips = w.findAll('.ask-chip')
		await chips[0].trigger('click') // style=ink
		expect(w.emitted('submit')).toBeUndefined()   // 未答满不提交
		expect(w.find('.ask-progress').text()).toContain('1/2')
		await w.findAll('.ask-chip')[2].trigger('click') // count=1
		expect(w.emitted('submit')![0][0]).toEqual({ answers: { style: ['ink'], count: ['1'] } })
	})
	it('跳过钮：未答问题标 skipped 后可提交（部分作答合法）', async () => {
		const w = mount(AskUserCard, { props: { questions: Q2 } })
		await w.findAll('.ask-skip')[0].trigger('click') // 跳过 style
		await w.findAll('.ask-chip')[2].trigger('click') // count=1
		expect(w.emitted('submit')![0][0]).toEqual({ answers: { count: ['1'] }, skipped: ['style'] })
	})
	it('multiSelect：点选后需显式确认钮（既有 D2 语义保留）', async () => {
		const q = { id: 'm', question: '多选？', multiSelect: true, options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] }
		const w = mount(AskUserCard, { props: { questions: [q] } })
		await w.findAll('.ask-chip')[0].trigger('click')
		expect(w.emitted('submit')).toBeUndefined()
		await w.find('.ask-multi-confirm').trigger('click')
		expect(w.emitted('submit')![0][0]).toEqual({ answers: { m: ['a'] } })
	})
})
```

- [x] **Step 2: 跑测试确认失败 → 重构 AskUserCard.vue**

Run: `cd apps/web && pnpm exec vitest run src/components/agent/AskUserCard.test.ts 2>&1 | tail -5`（FAIL）

script 重构要点（完整 template 样式沿用既有 --neo-* 体系，新增 `.ask-progress`/`.ask-skip` 两元素）：

```ts
const emit = defineEmits<{
	submit: [payload: { answers: Record<string, string[]>; skipped?: string[] }]
}>()
const otherText = ref<Record<string, string>>({})
const multiSelected = ref<Record<string, string[]>>({})
/** 单选暂存：多问题卡点选不即发；单问题卡点选即发（B-6 主路径低摩擦） */
const singleSelected = ref<Record<string, string>>({})
const skipped = ref<Set<string>>(new Set())

const answeredCount = computed(() =>
	props.questions.filter((q) => skipped.value.has(q.id) || singleSelected.value[q.id] || (multiSelected.value[q.id]?.length ?? 0) > 0).length)

function tryAutoSubmit() {
	if (props.questions.length <= 1) return // 单问题卡由点击直接提交
	if (answeredCount.value === props.questions.length) doSubmit()
}
function doSubmit() {
	const answers: Record<string, string[]> = {}
	for (const q of props.questions) {
		if (skipped.value.has(q.id)) continue
		const v = multiSelected.value[q.id] ?? (singleSelected.value[q.id] ? [singleSelected.value[q.id]] : [])
		if (v.length) answers[q.id] = v
	}
	emit('submit', { answers, ...(skipped.value.size ? { skipped: [...skipped.value] } : {}) })
}
function pick(q: AskUserQuestion, value: string) {
	if (q.multiSelect) { toggleMulti(q, value); return }
	if (props.questions.length === 1) { emit('submit', { answers: { [q.id]: [value] } }); return }
	singleSelected.value[q.id] = value
	tryAutoSubmit()
}
function skip(q: AskUserQuestion) { skipped.value.add(q.id); tryAutoSubmit() }
function confirmMulti(q: AskUserQuestion) { // 多问题卡内 multiSelect 确认后也走 tryAutoSubmit
	if (props.questions.length === 1) { doSubmit(); return }
	tryAutoSubmit()
}
```

（`allowOther` 自由文本：单问题卡回车/提交即 emit submit；多问题卡写入 `singleSelected[q.id]` 后 `tryAutoSubmit()`。取消按钮 emit 改名 `cancel` 保留。）

Run: `cd apps/web && pnpm exec vitest run src/components/agent/AskUserCard.test.ts 2>&1 | tail -3`（GREEN）

- [x] **Step 3: AgentSideRail 接线 + agent store submitAnswers**

stores/agent.ts（或请求层模块，以 sendMessage 的 fetch 封装所在为准）：

```ts
async function submitAnswers(input: {
	threadId: string; sessionId: string; callId: string;
	answers: Record<string, string[]>; skipped?: string[]; answerId?: string;
}): Promise<{ ok: boolean; deduped: boolean }> {
	const res = await fetch('/api/agent/sessions/' + encodeURIComponent(input.sessionId) + '/answers', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			threadId: input.threadId, callId: input.callId, answers: input.answers,
			...(input.skipped?.length ? { answersExtra: undefined } : {}), // skipped 由前端映射进 answers 语义之外——见下
			...(input.answerId ? { answerId: input.answerId } : {}),
		}),
	})
	if (!res.ok) throw new Error('submitAnswers failed: ' + res.status)
	return res.json()
}
```

⚠️ 契约澄清（实现时二选一，PR 描述里写明）：`skipped` 不进 /answers payload——skipped 只影响**工具返回给模型的文本**（由前端把 skipped 问题从 answers 里省略即达成「未答」语义）。上例 `answersExtra` 行是占位提醒：**实际 payload 只含 threadId/callId/answers/answerId**，删除占位行。

AgentSideRail.vue（:743-759 替换）：

```ts
/** ask_user 阻塞卡（B-6）：生命周期绑定 pending 状态，不再随新 user message 清空。 */
const pendingAskUser = ref<Array<{ callId: string; id: string; question: string; options: { label: string; value: string }[]; multiSelect?: boolean; allowOther?: boolean }>>([])

async function onAskSubmit(payload: { answers: Record<string, string[]>; skipped?: string[] }) {
	const callId = pendingAskUser.value[0]?.callId
	pendingAskUser.value = [] // 先清卡防双击双发（幂等端点兜底，但 UI 及时收敛）
	if (!callId) return
	await agent.submitAnswers({
		threadId: agent.threadId, sessionId: agent.canvasSessionId,
		callId, answers: payload.answers, answerId: crypto.randomUUID(),
	})
}
function onAskCancel() { pendingAskUser.value = [] } // 阻塞卡取消 = 仅收起；「自行描述」语义由输入框自由文本承接（§5.3 路由：填充首个未答问题）
```

输入框拦截（sendMessage 入口最前）：

```ts
// §5.3（③ 已确认）：pending 期间对话输入一律按 answer，自由文本填充首个未答问题
if (pendingAskUser.value.length > 0) {
	const unanswered = pendingAskUser.value.find((q) => !hasLocalAnswer(q.id))
	if (unanswered) {
		const callId = pendingAskUser.value[0].callId
		pendingAskUser.value = []
		await agent.submitAnswers({ threadId: agent.threadId, sessionId: agent.canvasSessionId, callId, answers: { [unanswered.id]: [text] }, answerId: crypto.randomUUID() })
		return
	}
}
```

（`hasLocalAnswer` 依赖 AskUserCard 内部态——跨组件不可达；简化：pending 卡存在时首个问题即目标（B-6 卡片在答满后已自动提交消失，pending 存在 = 至少一题未答），用 `pendingAskUser.value[0].id`。实现时以此简化为准并加注释。）

callId 链路核对（canvas_command 透传）：`agent.canvas_command` SSE 的 data 来自 pi-events.ts 派生——检查 `apps/server/src/agent/pi-runtime/pi-events.ts` 中 canvas_command/ask_user 分支是否逐字段透传（若白名单字段则补 `callId`），并在 `pi-events.test.ts` 加一条断言：

```ts
it("ask_user canvas_command 透传 callId（B-6 前端提交依据）", () => { /* 构造 tool_result 事件含 [{type:'ask_user', callId:'c1', questions:[...]}] → 断言派生 SSE data 含 callId:'c1' */ });
```

**刷新恢复**：P1-7 已把 questions 落 metadata.executionEvents——确认落盘点把 `callId` 一并写入（`agent.service.ts` ask_user 元数据组装处），恢复路径读出 callId 填回 `pendingAskUser`（测试：`agent.service.messages.test.ts` 或 pi-events.test.ts 按现有 P1-7 用例模式追加 callId 断言）。

- [x] **Step 4: 跑 web + server 相关测试**

Run: `cd apps/web && pnpm exec vitest run src/components/agent/AskUserCard.test.ts 2>&1 | tail -3 && cd ../../apps/server && pnpm exec vitest run src/agent/pi-runtime/pi-events.test.ts 2>&1 | tail -3`
Expected: 全部 pass

- [x] **Step 5: vue-tsc 类型门 + 提交**

Run: `cd apps/web && pnpm exec vue-tsc -b > /tmp/vue-tsc-blocking.log 2>&1; grep -c "error TS" /tmp/vue-tsc-blocking.log; grep "apps/web" /tmp/vue-tsc-blocking.log | head -5`
Expected: apps/web 范围 0 错误（packages/agent 的 TS2307 是 worktree 环境噪声，与本任务无关）

```bash
git add apps/web/src/components/agent/AskUserCard.vue apps/web/src/components/agent/AskUserCard.test.ts apps/web/src/components/agent/AgentSideRail.vue apps/web/src/stores/agent.ts apps/server/src/agent/pi-runtime/pi-events.ts apps/server/src/agent/pi-runtime/pi-events.test.ts
git commit -m "feat(web+server): ask_user 卡片 B-6 点选与提交分离 + /answers 提交链路 + callId 透传"
```

---

### Task 7: 全量回归 + 收尾

**Files:**
- 无新代码；回归 + 文档状态收尾

- [x] **Step 1: pi-runtime 全量单测**

Run: `cd services/pi-runtime && pnpm test > /tmp/pi-runtime-test.log 2>&1; grep -E "^# (pass|fail)" /tmp/pi-runtime-test.log`
Expected: fail 0

- [x] **Step 2: server + web 相关文件回归（单文件串行）**

```bash
cd apps/server && for f in src/agent/agent.service.pi-runtime.test.ts src/agent/pi-runtime/pi-events.test.ts src/agent/pi-runtime/pi-runtime.client.test.ts; do pnpm exec vitest run "$f" 2>&1 | grep -E "Tests +[0-9]+ (passed|failed)" | tail -1; done
cd ../../apps/web && for f in src/components/agent/AskUserCard.test.ts src/composables/useAgentStream.test.ts; do pnpm exec vitest run "$f" 2>&1 | grep -E "Tests +[0-9]+ (passed|failed)" | tail -1; done
```
Expected: 全部 passed

- [x] **Step 3: spec figures 校验 + plan checkbox 回填 + 提交**

```bash
cd /path/to/worktree && pnpm verify-spec-figures --file docs/superpowers/specs/2026-09-30-ask-user-blocking-design.md
# 回填本 plan 全部 checkbox（Edit replace_all "- [ ]" → "- [x]"，git status 复核落盘）
git add docs/superpowers/plans/2026-09-30-ask-user-blocking.md && git commit -m "docs(plan): 回填阻塞式改造实现计划 checkbox"
```

## 已知偏离（相对 spec）

1. **§5.3 路由规则位置**：spec 写「Nest prompt 入口查 /pending 再路由」；plan 改为**前端路由**（卡片 pending 时输入框文本直接进 /answers）+ **409 降级**（prompt 撞 busy → 前端走既有 P1-7 恢复路径重新拉卡片）。理由：Nest 不知道 question id，无法构造 answers payload；前端持有完整问题态，路由天然在前端；409+恢复覆盖前端状态失同步（刷新/多端）场景。语义与 spec ③ 确认项一致（一律按 answer）。
2. **gate 放行机制细化**：spec §4.3 说「gate 判定 confirmed=true 放行」；plan 落地为 `wasProposedThisTurn` 对 confirmed 记录返回 false（不新增 gate 分支），确认后 SSOT 仍为 pending_confirm（画布确认不改状态，跨轮先例 gate 测试 ：123 注释实证）→ 既有 SSOT 校验自然放行。V-γ 预算行为不变。
3. **sweeper 防线**：spec §4.4 要求新增跳过逻辑；实证 `sweepOnce:604` 已有 `if (entry.prompting) continue` 且阻塞等待期 prompting=true（run 活跃）→ **不新增生产代码**，以回归测试钉住（Task 3 Step 5）。

## Self-Review 记录

- **Spec 覆盖**：B-1（Task 1 配置 + Task 2 超时分支）✓；B-2（Task 2/4）✓；B-3（Task 1 registry）✓；B-4（Task 1 resolve 不 reject + Task 2 哨兵翻译）✓；B-5（Task 2/4 off 分支）✓；B-6（Task 6）✓；§4.2 轮询（Task 4）✓；§4.3 gate（Task 4）✓；§5.2 超时流（Task 2/3）✓；§5.3 路由（Task 6，偏离 1）✓；§6 边界（Task 3/6）✓；§8 回退（off 分支 + 数字 env 约束）✓；§9 steer/P3（无任务，正确）✓
- **占位符扫描**：Task 3 Step 1 的 mock fixture 与 Task 4 的 fakeNestClient 标注「对齐既有 helper」——均为既有测试文件的现存模式引用（非 TBD）；Task 5 Step 3 的 `piRuntimeUrl()` 标注以 ：392 实名为准——实现者第一步即读该处，不存在无出处引用
- **类型一致性**：`PendingResolution`/`answer()` 返回 `{ok,deduped}` / `markProposed(sessionId,nodeId,{confirmed})` / `buildAskUserTools(metrics, registry?, opts?)` / `buildCanvasWriteTools(client, registry?)` 各任务间一致；canvas_command `callId` 字段在 Task 2 产出、Task 6 消费，pi-events 钉住 ✓
