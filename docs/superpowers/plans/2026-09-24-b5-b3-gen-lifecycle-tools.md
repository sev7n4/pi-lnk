# B-5 生成闭环 + B-3 生命周期合并批次 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

- **状态**：已定稿（2026-09-24，用户「继续下一批次」启动；路线依据 `2026-09-24-p1-roadmap-revision.md` D2/D3/D4）
- **前置**：B-1/B-2（PR #3）、#12 systemPrompt、UI_COMMAND（PR #4）、会话竞态三连修（PR #5/#6/#7）均已上生产；master 基线 `d6745e6`
- **关系**：实现 roadmap D2（B-5 生成闭环）+ D3（B-3 HITL 走 Gate 重构）；工具清单 SSOT 仍是 `2026-09-23-p1-canvas-tool-inventory.md` §2
- **分支约定**：worktree 分支 `feat/b5-b3-gen-lifecycle`；先 pi-runtime 后 API 发布门；`docs/**` 不触发部署

## 0. 配图索引

本文档不含图（纯工具迁移与 Gate 策略，无状态机/拓扑需要图示；生成状态机 generating→completed|failed|fallback_pending 已在正文文字描述）。

## Goal

pi 链路补齐核心循环第 3 环「生成资产」：LLM 可在用户确认后执行 run_* 生成、取消进行中生成，节点状态实时回传前端；HITL 确认权收归 harness（before_tool Gate），不让模型自批自审。

## Architecture

- **迁移面（6 工具）**：`run_image/video/text/prompt/audio_generation`（tier=gen）+ `cancel_generation`（tier=lifecycle），全部走既有 Nest `/agent/internal/*` 端点（service 层零改动——start/wait/积分/BYOK/退款/轮询都在 Nest 完成）。
- **不迁（声明偏离）**：`start/wait_*` 变体（graph 专用 task_update 进度发射，pi 无 graph）；`upscale_image`（roadmap D4 断头工具）；`run_icon_refine`（老 registry 纯 stub）；`confirm/cancel_platform_fallback`（roadmap D3：fallback_pending 的确认入口 = 前端 `ByokFallbackConfirmDialog` 直连 studio HTTP，不走模型）。
- **HITL Gate**：per-session 注册 harness `before_tool` hook（session-manager 每会话创建 harness，闭包捕获 sessionId）。run_* 放行需同时满足：① 本轮内未发生过 propose（防模型同轮自批）；② 画布 SSOT 节点 `data.status === 'pending_confirm'`（Nest get-node 实时校验，跨轮/跨会话重建均成立）。任一不满足 → block（fail-closed），模型收到 block reason。
- **事件通道**：gen 工具把 Nest 返回的 `actions` 放进 `details.actions` → Nest 新增 `extractCanvasActions` 派生 `canvas_action` SSE（对齐老链路 NestEventProxy 语义），前端零改动。
- **运行形态**：run_* 同步阻塞（对齐老链路：Nest 内部 1.5s 间隔轮询 180s；工具超时 image/text/prompt/audio 210s、video 690s）。无自动重试（偏离：老 graph 有 max 2 自动重试；pi 侧由模型依据 error tool result 决定重试，记录为已知偏离）。

## Tech Stack

pi-runtime：TypeScript + `@earendil-works/pi-agent-core@0.85.1`（vendored 只读）+ TypeBox + node:test/tsx + Fastify。Nest：`@lnkpi/shared`（zod CanvasActionSchema）。部署：helm（pi-runtime）+ GitHub Actions 发布门（API）。

**Spec:** `docs/superpowers/plans/2026-09-24-p1-roadmap-revision.md`（D2/D3/D4）+ `docs/superpowers/plans/2026-09-24-p1-canvas-tool-inventory.md` §2（B-5/B-3 行）

## Global Constraints

- 老 runtime 事实锚点：`services/agent-runtime/app/tools/nest_client.py`（超时档 `_LONG_GEN_PATHS` 210s / `_VIDEO_GEN_PATHS` 690s）、`definitions.py:74-88`（`NodeIdInput` / `GenerationRecordInput`）、`tool_registry.py:109-162`（tier）。
- Nest 端点 body 契约（`agent-canvas-tools.service.ts` 逐字核对）：run_* = `{sessionId, userId, nodeId}`；cancel = `{sessionId, userId, generationRecordId?, nodeId?}`（至少一个标识）。
- harness `before_tool` hook 契约（`vendor/earendil-works/pi/packages/agent/src/harness/agent-harness.ts:464-467,502-514`）：event `{toolCallId, toolName, args}` + `{lane, runId}` + `context`；返回 `{ block: { reason } }` 即拦截，loop 给模型发 error tool result；handler 可 async。`after_tool` event 含 `isError`。
- `client.post` 返回解包后的 `data`（`nest-client.ts:115`）；`get-node` data = `CanvasNode { id, type, position, data: Record<string, unknown> }`（`packages/shared/src/agentContract.ts:73-80`），`pending_confirm` 在 `node.data.status`。
- 纪律：pi-runtime 不依赖 vendor 目录改动；TypeBox default 不被 harness 应用（execute 内运行时兜底）；需 userId 的工具 fail-closed；metrics 经 NestClient `onCall` 自动计数；部署必须显式 `--set image.tag`；`docs/**`、`*.md` 不触发 CI。
- 前端零改动（`canvas_action`/节点状态轮询/ByokFallbackConfirmDialog 均为既有通道）。

## Review Focus

1. **模型同轮自批**：模型同轮 propose 后立即 run_* —— Gate 内存 turn 校验必须拦截（测试：Task 3）。
2. **B4 每轮重建会话后 Gate 失效**：门禁若依赖跨轮内存态会漏放行/误拦截 —— 校验 ② 用画布 SSOT 实时查询而非内存（测试：Task 3 fake client 场景）。
3. **fallback_pending 被模型当作失败/成功复述**：run_* 返回 `status:'fallback_pending'` 时规则文本必须约束「如实说明需在画布确认平台兜底，不要虚构结果、不要自行重试」（测试：Task 7 规则文本断言）。
4. **超时档错配**：video 用 210s 档会在 690s 长任务中途 abort —— `TOOL_TIMEOUT_OVERRIDES` 精确到路径前缀，run-video 必须命中 690_000（测试：Task 1）。
5. **canvas_action 脏数据**：details.actions 含非 CanvasAction 形状对象时 Nest 派生必须 safeParse 跳过而非整批丢弃/500（测试：Task 6）。

---

### Task 1: NestClient 长 gen 超时档

**Files:**
- Modify: `services/pi-runtime/src/tools/config.ts:10-12`
- Test: `services/pi-runtime/src/tools/config.test.ts`

**Interfaces:**
- Consumes: 既有 `NestClientOptions.timeoutOverrides`（前缀匹配，`nest-client.ts:52-57`）
- Produces: `TOOL_TIMEOUT_OVERRIDES` 含 7 个 gen 路径档位（后续所有任务共用该 client 实例）

- [ ] **Step 1: 写失败测试**（config.test.ts 追加）

```ts
it("B-5: gen 工具超时档位对齐老链路（image/text/prompt/audio 210s、video 690s）", () => {
	assert.equal(TOOL_TIMEOUT_OVERRIDES["/agent/internal/run-image-generation"], 210_000);
	assert.equal(TOOL_TIMEOUT_OVERRIDES["/agent/internal/wait-image-generation"], 210_000);
	assert.equal(TOOL_TIMEOUT_OVERRIDES["/agent/internal/run-text-generation"], 210_000);
	assert.equal(TOOL_TIMEOUT_OVERRIDES["/agent/internal/run-prompt-generation"], 210_000);
	assert.equal(TOOL_TIMEOUT_OVERRIDES["/agent/internal/run-audio-generation"], 210_000);
	assert.equal(TOOL_TIMEOUT_OVERRIDES["/agent/internal/run-video-generation"], 690_000);
	assert.equal(TOOL_TIMEOUT_OVERRIDES["/agent/internal/wait-video-generation"], 690_000);
});
```

（`import { TOOL_TIMEOUT_OVERRIDES } from "./config.js"` 若未导入则补。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd services/pi-runtime && npm test 2>&1 | grep -A2 "gen 工具超时"` → Expected: FAIL

- [ ] **Step 3: 实现**（config.ts:10-12 改为）

```ts
/** 超时覆盖表（对齐老链路档位）：10s 默认 / 120s grid / 210s image 系 / 690s video 系。 */
export const TOOL_TIMEOUT_OVERRIDES: Record<string, number> = {
	"/agent/internal/grid-slice-image": 120_000,
	"/agent/internal/run-image-generation": 210_000,
	"/agent/internal/wait-image-generation": 210_000,
	"/agent/internal/run-text-generation": 210_000,
	"/agent/internal/run-prompt-generation": 210_000,
	"/agent/internal/run-audio-generation": 210_000,
	"/agent/internal/run-video-generation": 690_000,
	"/agent/internal/wait-video-generation": 690_000,
};
```

- [ ] **Step 4: 跑测试确认通过** → `npm test` 全绿
- [ ] **Step 5: Commit** — `git commit -m "feat(pi-runtime): gen tool timeout tiers aligned with legacy nest_client"`

### Task 2: GenerationGateStore（turn 语义）

**Files:**
- Create: `services/pi-runtime/src/gate/generation-gate.ts`（store 部分）
- Test: `services/pi-runtime/src/gate/generation-gate.test.ts`

**Interfaces:**
- Produces: `GenerationGateStore`（Task 3 的 checkGenerationGate 与 index.ts 接线共用）

```ts
export class GenerationGateStore {
	/** propose_generation 成功后由 after_tool hook 调用，记录 {turn}。 */
	markProposed(sessionId: string, nodeId: string): void;
	/** 仅当该节点的 propose 发生在「当前用户轮」内返回 true（跨轮后放行 → 交给画布 SSOT 校验）。 */
	wasProposedThisTurn(sessionId: string, nodeId: string): boolean;
	/** 每次用户 prompt 进入时 turn +1（SessionManager.prompt 调用）。 */
	bumpUserTurn(sessionId: string): void;
	/** 会话重建（create）/删除（remove）时清空该会话状态。 */
	resetSession(sessionId: string): void;
}
```

语义：`markProposed` 记录 `proposals[sessionId][nodeId] = userTurns[sessionId]`（bump 前的当前值）；`wasProposedThisTurn` = 存在记录且 `记录值 === 当前 turn`。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerationGateStore } from "./generation-gate.js";

test("same-turn propose is detected", () => {
	const s = new GenerationGateStore();
	s.markProposed("sess1", "n_1");
	assert.equal(s.wasProposedThisTurn("sess1", "n_1"), true);
});

test("user turn bump releases same-turn proposal", () => {
	const s = new GenerationGateStore();
	s.markProposed("sess1", "n_1");
	s.bumpUserTurn("sess1");
	assert.equal(s.wasProposedThisTurn("sess1", "n_1"), false);
});

test("sessions are isolated", () => {
	const s = new GenerationGateStore();
	s.markProposed("sess1", "n_1");
	assert.equal(s.wasProposedThisTurn("sess2", "n_1"), false);
});

test("resetSession clears state", () => {
	const s = new GenerationGateStore();
	s.markProposed("sess1", "n_1");
	s.resetSession("sess1");
	assert.equal(s.wasProposedThisTurn("sess1", "n_1"), false);
});

test("propose after bump is gated again in the new turn", () => {
	const s = new GenerationGateStore();
	s.markProposed("sess1", "n_1");
	s.bumpUserTurn("sess1");
	s.markProposed("sess1", "n_1"); // 用户确认后的新一轮里模型再次 propose
	assert.equal(s.wasProposedThisTurn("sess1", "n_1"), true);
});
```

- [ ] **Step 2: 跑失败**（模块不存在）
- [ ] **Step 3: 实现**

```ts
/**
 * B-5 HITL Gate 状态（roadmap D3：确认权收归 harness）。
 * 语义：propose 与 run 必须隔着至少一次真实用户轮次；同轮 propose→run 一律拦截。
 * 跨轮校验交给画布 SSOT（checkGenerationGate 的 get-node 分支），本 store 只管「同轮自批」。
 * B4 每轮 deleteSession 重建 → resetSession 清态，不影响跨轮放行逻辑。
 */
export class GenerationGateStore {
	private readonly proposals = new Map<string, Map<string, number>>();
	private readonly turns = new Map<string, number>();

	markProposed(sessionId: string, nodeId: string): void {
		const turn = this.turns.get(sessionId) ?? 0;
		const map = this.proposals.get(sessionId) ?? new Map<string, number>();
		map.set(nodeId, turn);
		this.proposals.set(sessionId, map);
	}

	wasProposedThisTurn(sessionId: string, nodeId: string): boolean {
		const turn = this.turns.get(sessionId) ?? 0;
		return this.proposals.get(sessionId)?.get(nodeId) === turn;
	}

	bumpUserTurn(sessionId: string): void {
		this.turns.set(sessionId, (this.turns.get(sessionId) ?? 0) + 1);
	}

	resetSession(sessionId: string): void {
		this.proposals.delete(sessionId);
		this.turns.delete(sessionId);
	}
}
```

- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: Commit** — `git commit -m "feat(pi-runtime): generation gate store with user-turn semantics"`

### Task 3: checkGenerationGate 策略 + session hooks 接线

**Files:**
- Modify: `services/pi-runtime/src/gate/generation-gate.ts`（追加策略函数）
- Modify: `services/pi-runtime/src/session-manager.ts`（SessionHooks）
- Modify: `services/pi-runtime/src/index.ts`（接线）
- Test: `services/pi-runtime/src/gate/generation-gate.test.ts`（追加）、`services/pi-runtime/src/session-manager.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 store；NestClient（duck-typed `{ post }`）；`get-node` 返回 `CanvasNode`
- Produces:

```ts
export const GATED_TOOLS: ReadonlySet<string>; // run_image/video/text/prompt/audio_generation
export interface GateCheckResult { allowed: boolean; reason?: string }
export async function checkGenerationGate(
	store: GenerationGateStore,
	client: { post(path: string, body: unknown): Promise<unknown> },
	sessionId: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<GateCheckResult>;

// session-manager.ts 新增：
export interface SessionHooks {
	onSessionCreated?(sessionId: string, harness: AgentHarness<LnkpiToolContext>): void;
	onPrompt?(sessionId: string): void;
}
// SessionManager 构造器第 5 参 hooks?: SessionHooks；create() 在 harness 创建后调用 onSessionCreated；prompt() 入口调用 onPrompt
```

- [ ] **Step 1: 写失败测试**（generation-gate.test.ts 追加；fake client）

```ts
const GATED = "run_image_generation";

function fakeClient(response: unknown, opts: { throwOnPost?: boolean } = {}) {
	return {
		post: async () => {
			if (opts.throwOnPost) throw new Error("boom");
			return response;
		},
	};
}

test("non-gated tools pass without any check", async () => {
	const r = await checkGenerationGate(new GenerationGateStore(), fakeClient(null), "s", "upsert_prompt_node", {});
	assert.deepEqual(r, { allowed: true });
});

test("missing node_id blocks", async () => {
	const r = await checkGenerationGate(new GenerationGateStore(), fakeClient(null), "s", GATED, {});
	assert.equal(r.allowed, false);
	assert.match(r.reason ?? "", /node_id/);
});

test("same-turn propose blocks (self-approval guard)", async () => {
	const s = new GenerationGateStore();
	s.markProposed("s", "n_1");
	const r = await checkGenerationGate(s, fakeClient({ id: "n_1", data: { status: "pending_confirm" } }), "s", GATED, { node_id: "n_1" });
	assert.equal(r.allowed, false);
	assert.match(r.reason ?? "", /propose/);
});

test("pending_confirm node passes after canvas SSOT check", async () => {
	const r = await checkGenerationGate(new GenerationGateStore(), fakeClient({ id: "n_1", type: "image", position: { x: 0, y: 0 }, data: { status: "pending_confirm" } }), "s", GATED, { node_id: "n_1" });
	assert.deepEqual(r, { allowed: true });
});

test("node not in pending_confirm blocks with current status", async () => {
	const r = await checkGenerationGate(new GenerationGateStore(), fakeClient({ id: "n_1", type: "image", position: { x: 0, y: 0 }, data: { status: "generating" } }), "s", GATED, { node_id: "n_1" });
	assert.equal(r.allowed, false);
	assert.match(r.reason ?? "", /generating/);
});

test("get-node failure fails closed", async () => {
	const r = await checkGenerationGate(new GenerationGateStore(), fakeClient(null, { throwOnPost: true }), "s", GATED, { node_id: "n_1" });
	assert.equal(r.allowed, false);
	assert.match(r.reason ?? "", /fail-closed|校验/);
});

test("tolerates node shape without data object", async () => {
	const r = await checkGenerationGate(new GenerationGateStore(), fakeClient({ id: "n_1" }), "s", GATED, { node_id: "n_1" });
	assert.equal(r.allowed, false); // status 未知 → 拦截（fail-closed）
});
```

（session-manager.test.ts 追加：构造 SessionManager 时注入 `hooks: { onSessionCreated, onPrompt }`，create 后断言 onSessionCalled 带 sessionId；prompt 后断言 onPrompt 调用。参照该文件既有 fake harnessFactory 写法。）

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现 checkGenerationGate**（追加到 generation-gate.ts）

```ts
export const GATED_TOOLS: ReadonlySet<string> = new Set([
	"run_image_generation",
	"run_video_generation",
	"run_text_generation",
	"run_prompt_generation",
	"run_audio_generation",
]);

export interface GateCheckResult {
	allowed: boolean;
	reason?: string;
}

interface GateNode {
	data?: { status?: unknown } | undefined;
}

function extractNodeStatus(node: unknown): string | undefined {
	const d = (node as GateNode | null | undefined)?.data;
	return d && typeof d === "object" && typeof d.status === "string" ? d.status : undefined;
}

/**
 * B-5 HITL Gate（roadmap D3）：run_* 生成必须「画布节点处于 pending_confirm 且非本轮自批」。
 * 双重校验：① 同轮 propose→run 内存拦截；② 画布 SSOT（get-node → data.status）。
 * 任一校验失败/异常 → fail-closed（block），绝不放行。
 */
export async function checkGenerationGate(
	store: GenerationGateStore,
	client: { post(path: string, body: unknown): Promise<unknown> },
	sessionId: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<GateCheckResult> {
	if (!GATED_TOOLS.has(toolName)) return { allowed: true };
	const nodeId = typeof args.node_id === "string" ? args.node_id : "";
	if (!nodeId) {
		return { allowed: false, reason: "run_* 需要 node_id（从画布摘要解析，不要用标题文本猜 id）" };
	}
	if (store.wasProposedThisTurn(sessionId, nodeId)) {
		return {
			allowed: false,
			reason: "本轮刚调用过 propose_generation，必须等待用户明确确认（下一条用户消息）后才能执行生成；请先向用户说明将生成什么并等待确认",
		};
	}
	try {
		const node = await client.post("/agent/internal/get-node", { sessionId, nodeId });
		const status = extractNodeStatus(node);
		if (status !== "pending_confirm") {
			return {
				allowed: false,
				reason: `节点 ${nodeId} 不在待确认状态（当前 ${status ?? "unknown"}）；须先用 propose_generation 提议并等用户确认，禁止未经确认直接生成`,
			};
		}
		return { allowed: true };
	} catch {
		return { allowed: false, reason: "生成前置校验暂时不可用（fail-closed），请稍后重试" };
	}
}
```

- [ ] **Step 4: session-manager.ts 接线**

构造器签名（现 4 参）追加第 5 参：

```ts
export interface SessionHooks {
	onSessionCreated?(sessionId: string, harness: AgentHarness<LnkpiToolContext>): void;
	onPrompt?(sessionId: string): void;
}

constructor(
	private readonly tools: AgentHarnessTool<LnkpiToolContext>[] = [],
	private readonly systemPromptDefault = process.env.PI_RUNTIME_SYSTEM_PROMPT ?? "",
	private readonly modelFactory: typeof assembleModel = assembleModel,
	private readonly harnessFactory: HarnessFactory = AgentHarness.create,
	private readonly hooks?: SessionHooks,
) {}
```

`create()`：`this.sessions.set(id, entry)` 之前调用 `this.hooks?.onSessionCreated?.(id, harness);`。
`prompt()`：`const lane = ...` 之前调用 `this.hooks?.onPrompt?.(id);`。

- [ ] **Step 5: index.ts 接线**（`createApp`/启动处，按现有结构插入）

```ts
import { GenerationGateStore, checkGenerationGate } from "./gate/generation-gate.js";

const gateStore = new GenerationGateStore();
const manager = new SessionManager(tools, undefined, undefined, undefined, {
	onSessionCreated(sessionId, harness) {
		gateStore.resetSession(sessionId); // B4 重建语义：新会话新轮
		// after_tool：propose_generation 成功 → 记录本轮提议（before_tool 自批拦截的数据源）
		harness.hooks.on("after_tool", async (event) => {
			if (event.toolName !== "propose_generation" || event.isError) return undefined;
			const nodeId = (event.args as { node_id?: unknown } | undefined)?.node_id;
			if (typeof nodeId === "string" && nodeId) gateStore.markProposed(sessionId, nodeId);
			return undefined;
		});
		// before_tool：run_* 双重校验（同轮自批 + 画布 SSOT pending_confirm）
		harness.hooks.on("before_tool", async (event) => {
			const check = await checkGenerationGate(gateStore, client, sessionId, event.toolName, event.args);
			return check.allowed ? undefined : { block: { reason: check.reason ?? "generation gated" } };
		});
	},
	onPrompt(sessionId) {
		gateStore.bumpUserTurn(sessionId);
	},
});
```

（`client` 为 index.ts 既有 NestClient 实例；`tools`/`manager` 变量名按 index.ts 实际命名对齐；remove 路径若可获取 sessionId 也调 `gateStore.resetSession`。）

- [ ] **Step 6: 全部测试通过** → `npm test`
- [ ] **Step 7: Commit** — `git commit -m "feat(pi-runtime): before_tool generation gate (self-approval guard + canvas SSOT)"`

### Task 4: gen/lifecycle 六工具

**Files:**
- Create: `services/pi-runtime/src/tools/generation.ts`
- Test: `services/pi-runtime/src/tools/generation.test.ts`

**Interfaces:**
- Consumes: NestClient（Task 1 超时档）、`LnkpiToolContext`
- Produces: `createGenerationTools(client: NestClient): LnkpiTool[]` —— 6 个工具；run_* 结果 `details: { actions: unknown[] }`（Task 6 消费）；cancel 结果同构

工具定义（Tier 注释对照 `tool_registry.py:145-159`；端点/body 对照 `nest_client.py:335-499` 与 `agent-canvas-tools.controller.ts:1037-1127`）：

```ts
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import type { NestClient } from "./nest-client.js";

function extractActions(data: unknown): Record<string, unknown>[] {
	const actions = (data as { actions?: unknown } | null | undefined)?.actions;
	if (!Array.isArray(actions)) return [];
	return actions.filter((a): a is Record<string, unknown> => !!a && typeof a === "object");
}

function resultWithActions(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ ok: true, data }) }],
		// B-5：Nest 返回的 CanvasAction[] 进 details.actions，由 Nest pi-events 派生 canvas_action SSE
		details: { actions: extractActions(data) },
	};
}

export function createGenerationTools(client: NestClient): LnkpiTool[] {
	const gen = { tier: "gen" as const };
	const runTool = (
		name: string,
		label: string,
		description: string,
		path: string,
	): LnkpiTool => ({
		...gen,
		name,
		label,
		description,
		parameters: Type.Object({
			node_id: Type.String({ description: "Media node id to generate for (from canvas summary, not title text)" }),
		}),
		execute: async (_id, p: { node_id: string }, _u, tc: LnkpiToolContext) => {
			if (!tc.userId) throw new Error(`${name} requires userId in toolContext`);
			return resultWithActions(
				await client.post(path, { sessionId: tc.sessionId, userId: tc.userId, nodeId: p.node_id }),
			);
		},
	});

	return [
		runTool(
			"run_image_generation",
			"执行图片生成",
			"Run image generation for a canvas media node and wait for completion (up to ~3 min). Requires the node to be pending user confirmation. Returns url on success; status=timeout means unfinished (use get_generation_status later); status=fallback_pending means user must confirm platform fallback on the canvas node.",
			"/agent/internal/run-image-generation",
		),
		runTool(
			"run_video_generation",
			"执行视频生成",
			"Run video generation for a canvas media node and wait for completion (up to ~11 min). Same confirmation and status semantics as run_image_generation.",
			"/agent/internal/run-video-generation",
		),
		runTool(
			"run_text_generation",
			"执行文案生成",
			"Run text generation for a canvas media node (writes generated copy into node content). Requires pending confirmation.",
			"/agent/internal/run-text-generation",
		),
		runTool(
			"run_prompt_generation",
			"执行提示词生成",
			"Run prompt generation for a canvas media node (writes generation prompt into node). Requires pending confirmation.",
			"/agent/internal/run-prompt-generation",
		),
		runTool(
			"run_audio_generation",
			"执行音频生成",
			"Run audio (TTS) generation for a canvas media node using node audio params. Requires pending confirmation.",
			"/agent/internal/run-audio-generation",
		),
		{
			tier: "lifecycle" as const,
			name: "cancel_generation",
			label: "取消生成",
			description:
				"Cancel an in-progress generation by generation_record_id or node_id (at least one; resolve node_id from canvas summary, not title text). Only generating records can be cancelled.",
			parameters: Type.Object({
				generation_record_id: Type.Optional(Type.String({ description: "GenerationRecord id" })),
				node_id: Type.Optional(Type.String({ description: "Canvas node id" })),
			}),
			execute: async (
				_id,
				p: { generation_record_id?: string; node_id?: string },
				_u,
				tc: LnkpiToolContext,
			) => {
				if (!tc.userId) throw new Error("cancel_generation requires userId in toolContext");
				if (!p.generation_record_id && !p.node_id) {
					throw new Error("cancel_generation requires generation_record_id or node_id (at least one)");
				}
				const body: Record<string, unknown> = { sessionId: tc.sessionId, userId: tc.userId };
				if (p.generation_record_id) body.generationRecordId = p.generation_record_id;
				if (p.node_id) body.nodeId = p.node_id;
				return resultWithActions(await client.post("/agent/internal/cancel-generation", body));
			},
		},
	];
}
```

- [ ] **Step 1: 写失败测试**（generation.test.ts，fake client 记录 path/body）

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGenerationTools } from "./generation.js";
import type { LnkpiToolContext } from "./types.js";

const tc: LnkpiToolContext = { sessionId: "s1", userId: "u1" };

function fakeClient() {
	const calls: Array<{ path: string; body: unknown }> = [];
	return {
		calls,
		post: async (path: string, body: unknown) => {
			calls.push({ path, body });
			return { status: "completed", url: "https://x/y.png", generationRecordId: "g1", actions: [{ type: "update_node", payload: { id: "n_1", data: { status: "completed" } } }] };
		},
	};
}

test("six gen/lifecycle tools registered with tiers", () => {
	const tools = createGenerationTools(fakeClient() as never);
	assert.deepEqual(tools.map((t) => t.name), [
		"run_image_generation", "run_video_generation", "run_text_generation",
		"run_prompt_generation", "run_audio_generation", "cancel_generation",
	]);
	assert.deepEqual(tools.map((t) => t.tier), ["gen", "gen", "gen", "gen", "gen", "lifecycle"]);
});

test("run_image_generation posts correct body and surfaces actions in details", async () => {
	const client = fakeClient();
	const tool = createGenerationTools(client as never).find((t) => t.name === "run_image_generation")!;
	const res = await tool.execute!("id", { node_id: "n_1" }, undefined, tc);
	assert.deepEqual(client.calls, [{ path: "/agent/internal/run-image-generation", body: { sessionId: "s1", userId: "u1", nodeId: "n_1" } }]);
	assert.equal((res.details as { actions: unknown[] }).actions.length, 1);
});

test("run_* fails closed without userId", async () => {
	const tool = createGenerationTools(fakeClient() as never).find((t) => t.name === "run_image_generation")!;
	await assert.rejects(() => tool.execute!("id", { node_id: "n_1" }, undefined, { sessionId: "s1" }), /userId/);
});

test("cancel_generation requires at least one identifier", async () => {
	const client = fakeClient();
	const tool = createGenerationTools(client as never).find((t) => t.name === "cancel_generation")!;
	await assert.rejects(() => tool.execute!("id", {}, undefined, tc), /generation_record_id or node_id/);
	await tool.execute!("id", { node_id: "n_1" }, undefined, tc);
	assert.deepEqual(client.calls[0], { path: "/agent/internal/cancel-generation", body: { sessionId: "s1", userId: "u1", nodeId: "n_1" } });
});

test("cancel_generation forwards generationRecordId", async () => {
	const client = fakeClient();
	const tool = createGenerationTools(client as never).find((t) => t.name === "cancel_generation")!;
	await tool.execute!("id", { generation_record_id: "g9" }, undefined, tc);
	assert.deepEqual(client.calls[0].body, { sessionId: "s1", userId: "u1", generationRecordId: "g9" });
});

test("non-array actions degrade to empty details.actions", async () => {
	const client = { post: async () => ({ status: "completed" }) };
	const tool = createGenerationTools(client as never).find((t) => t.name === "run_text_generation")!;
	const res = await tool.execute!("id", { node_id: "n_1" }, undefined, tc);
	assert.deepEqual((res.details as { actions: unknown[] }).actions, []);
});
```

- [ ] **Step 2: 跑失败** → **Step 3: 实现**（上方代码）→ **Step 4: 跑通过**
- [ ] **Step 5: Commit** — `git commit -m "feat(pi-runtime): 5 run_* gen tools + cancel_generation (B-5/B-3)"`

### Task 5: resolveTools 装配 25→31

**Files:**
- Modify: `services/pi-runtime/src/tools/config.ts`（import + 装配行）
- Test: `services/pi-runtime/src/tools/config.test.ts`

**Interfaces:**
- Consumes: Task 4 `createGenerationTools`
- Produces: `resolveTools(metrics)` 返回 31 个工具（顺序：read → write → ui → gen）

- [ ] **Step 1: 更新失败测试**（config.test.ts 既有「25 个工具」断言改为 31，并追加名称断言）

```ts
it("B-5: gen/lifecycle tools are registered (31 total)", () => {
	const names = tools.map((t) => t.name);
	for (const n of ["run_image_generation", "run_video_generation", "run_text_generation", "run_prompt_generation", "run_audio_generation", "cancel_generation"]) {
		assert.ok(names.includes(n), `missing ${n}`);
	}
	assert.equal(tools.length, 31);
});
```

- [ ] **Step 2: 跑失败** → **Step 3: 实现**：config.ts 追加 `...createGenerationTools(client),`（registry.ts 若为聚合导出处，按现有模式补 re-export）
- [ ] **Step 4: 全测试通过** → **Step 5: Commit** — `git commit -m "feat(pi-runtime): resolveTools 25 -> 31 with gen/lifecycle batch"`

### Task 6: Nest 侧 canvas_action 派生通道

**Files:**
- Modify: `apps/server/src/agent/pi-runtime/pi-events.ts`（追加 `extractCanvasActions` + 类型）
- Modify: `apps/server/src/agent/agent.service.ts:712-717` 附近（streamFromPiRuntime 派生循环）
- Test: `apps/server/src/agent/pi-runtime/pi-events.test.ts`（若无则新建）、`apps/server/src/agent/agent.service.test.ts`（追加）

**Interfaces:**
- Consumes: pi 工具 `details.actions`（Task 4）；`CanvasActionSchema`（`@lnkpi/shared`，zod safeParse）
- Produces: `extractCanvasActions(event: PiRuntimeEvent): CanvasAction[]`；streamFromPiRuntime 对每个 action `yield { type: 'canvas_action', data: action }`（既有 `canvasActions` 收集与 finalizeTurn 持久化分支随之生效）

- [ ] **Step 1: 写失败测试**（pi-events.test.ts）

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCanvasActions, type PiRuntimeEvent } from "./pi-events";

function toolEndEvent(result: unknown, isError = false): PiRuntimeEvent {
	return { type: "tool_execution_end", ts: 0, data: { toolCallId: "c1", toolName: "run_image_generation", result, isError } } as never;
}

test("extracts valid canvas actions from details.actions", () => {
	const actions = extractCanvasActions(toolEndEvent({
		details: { actions: [{ type: "update_node", payload: { id: "n_1", data: { status: "completed" } } }] },
	}));
	assert.equal(actions.length, 1);
	assert.equal(actions[0].type, "update_node");
});

test("skips invalid action shapes but keeps valid ones", () => {
	const actions = extractCanvasActions(toolEndEvent({
		details: { actions: [{ type: "nonsense_type", payload: {} }, { type: "update_node", payload: { id: "n_2" } }, "junk", 42] },
	}));
	assert.equal(actions.length, 1);
	assert.equal(actions[0].payload.id, "n_2");
});

test("ignores error results, missing details, and non-tool events", () => {
	assert.deepEqual(extractCanvasActions(toolEndEvent({ details: { actions: [{ type: "update_node", payload: { id: "n" } }] } }, true)), []);
	assert.deepEqual(extractCanvasActions(toolEndEvent({})), []);
	assert.deepEqual(extractCanvasActions({ type: "message_update", ts: 0, data: {} } as never), []);
});
```

- [ ] **Step 2: 跑失败** → **Step 3: 实现**（pi-events.ts 追加）

```ts
import { CanvasActionSchema, type CanvasAction } from "@lnkpi/shared";

/**
 * B-5：从 tool_execution_end 的 result.details.actions 提取画布数据动作
 * （派生 canvas_action 事件，语义对齐老链路 NestEventProxy 转发工具 actions）。
 * safeParse 逐条校验：脏数据跳过（Review Focus #5），isError 结果不派生。
 * 仅 gen/lifecycle 工具的 details 含 actions 键；其余工具 details 为 undefined，天然不命中。
 */
export function extractCanvasActions(event: PiRuntimeEvent): CanvasAction[] {
	if (event.type !== "tool_execution_end") return [];
	const d = event.data as {
		isError?: boolean;
		result?: { details?: { actions?: unknown } };
	};
	if (d.isError) return [];
	const actions = d.result?.details?.actions;
	if (!Array.isArray(actions)) return [];
	const out: CanvasAction[] = [];
	for (const a of actions) {
		const parsed = CanvasActionSchema.safeParse(a);
		if (parsed.success) out.push(parsed.data);
	}
	return out;
}
```

- [ ] **Step 4: streamFromPiRuntime 派生**（agent.service.ts，紧随 extractCanvasCommands 块之后）

```ts
// B-5：gen/lifecycle 工具 details.actions → canvas_action（画布数据动作通道；canvas_command 不得混入）
for (const action of extractCanvasActions(event)) {
  yield { type: 'canvas_action', data: action }
}
```

（import 行补 `extractCanvasActions`。）

- [ ] **Step 5: agent.service.test.ts 追加 fake pi 事件流测试**（照既有 canvas_command 测试的 fake client 模式构造 tool_execution_end 事件，断言 SSE 序列出现 `canvas_action` 且 `finalizeTurn` 收到该 action）
- [ ] **Step 6: 相关测试通过**（apps/server：`npx vitest run src/agent/pi-runtime src/agent/agent.service.test.ts`，按仓库实际测试命令）→ **Step 7: Commit** — `git commit -m "feat(server): derive canvas_action SSE from pi gen tool details.actions"`

### Task 7: genTools 规则组（PiPromptAssembler）

**Files:**
- Modify: `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.ts`
- Test: `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.test.ts`（若无则新建）

**Interfaces:**
- Produces: `RuleGroup = "core" | "writeTools" | "genTools"`；`assemble({ruleGroups})` 支持 `['core','writeTools','genTools']`

规则文本定稿（core 规则 3 在 genTools 启用时替换为 3'；新增 11/12/13；规则 9 维持不拷贝 = roadmap D4）：

- [ ] **Step 1: 写失败测试**

```ts
it("genTools off: rule 3 forbids run_*", () => {
	const text = composeRuleText(["core", "writeTools"]);
	assert.match(text, /禁止调用任何 run_\*/);
	assert.doesNotMatch(text, /11\./);
});

it("genTools on: rule 3' + rules 11/12/13 injected", () => {
	const text = composeRuleText(["core", "writeTools", "genTools"]);
	assert.doesNotMatch(text, /禁止调用任何 run_\*/);
	assert.match(text, /用户明确同意/);
	assert.match(text, /fallback_pending/);
	assert.match(text, /cancel_generation/);
	assert.match(text, /禁止用 run_\* 或文生图提示词冒充放大/); // D4：upscale 断头约束保留在规则 11
});
```

- [ ] **Step 2: 跑失败** → **Step 3: 实现**

`CORE_RULES` 拆分：`CORE_RULES_HEAD`（前缀+规则 1/2）、`RULE_3_NO_GEN`（现规则 3 原文）、`RULE_3_GEN`（下文）、`CORE_RULES_TAIL`（规则 7 原文）。`GEN_TOOLS_RULES`：

```ts
export const RULE_3_GEN = `3. 不要声称「正在生成」「马上生成」「已开始出图」；用户明确同意前禁止调用 run_*_generation（生成执行由系统强制校验，见规则 11），确认后可调用，也不要假装已出图。`;

export const GEN_TOOLS_RULES = `11. run_image/video/text/prompt/audio_generation 只能对「已 propose_generation 且用户在后续消息中明确同意」的节点调用（系统强制校验 pending_confirm；同轮提议后直接调用会被拦截）。禁止用 run_* 或文生图提示词冒充放大/超分。
12. run_* 返回 status=timeout：如实告知生成未完成，可用 get_generation_status 稍后再查；status=fallback_pending：说明该节点需用户在画布上确认平台兜底，不要声称成功或失败，不要自行重试，也不要调用不存在的确认工具；status=failed/error：简要说明并给下一步建议，禁止虚构 url。
13. 用户要求取消进行中的生成：调用 cancel_generation（有 generation_record_id 用之，否则用 node_id，从画布摘要解析而非标题文本），结果如实转述；仅 generating 状态可取消，其余状态如实说明。`;
```

`composeRuleText`：

```ts
function composeRuleText(groups: RuleGroup[]): string {
	const core = groups.includes("genTools")
		? `${CORE_RULES_HEAD}\n${RULE_3_GEN}\n${CORE_RULES_TAIL}`
		: `${CORE_RULES_HEAD}\n${RULE_3_NO_GEN}\n${CORE_RULES_TAIL}`;
	const parts = [core];
	if (groups.includes("writeTools")) parts.push(WRITE_TOOLS_RULES);
	if (groups.includes("genTools")) parts.push(GEN_TOOLS_RULES);
	if (!groups.includes("writeTools")) parts.push(RULE_10_WRITE_GUARD);
	return parts.filter(Boolean).join("\n");
}
```

（注意保持既有行为：无 writeTools 时第 10 条守卫仍在。）

- [ ] **Step 4: streamFromPiRuntime / mirrorToPiRuntime 的 `ruleGroups` 改为 `['core', 'writeTools', 'genTools']`**（agent.service.ts:682 与 mirror 处对应行）
- [ ] **Step 5: 测试通过** → **Step 6: Commit** — `git commit -m "feat(server): genTools rule group (rule 3' + 11/12/13) enabled in pi link"`

### Task 8: 回归 + 部署 + 验收

**Files:** 无新代码；部署与验证

- [ ] **Step 1: pi-runtime 全量回归**：`cd services/pi-runtime && npm test`（31 工具 + gate + 超时全绿）
- [ ] **Step 2: Nest 侧回归**：apps/server 相关测试（pi-events / pi-prompt-assembler / agent.service）；已知既有失败 `upstream-ref-inline.test.ts`（master 既有，与本批无关）
- [ ] **Step 3: 构建**：pi-runtime tsc 通过；`packages/shared` 未改则跳过重建（本批 Nest 用既有 CanvasActionSchema，无需动 shared）
- [ ] **Step 4: 提交 PR → merge master**（pi-lnk 仓库；确认不触碰 `deploy/**`，docs 不触发 CI）
- [ ] **Step 5: 部署 pi-runtime**（runbook `docs/ops/RUNBOOK-pi-runtime-deploy.md`）：rsync 构建树 → docker build → push 本地 registry → `helm upgrade --set image.tag=0.0.8 --set env.PI_RUNTIME_VERSION=0.0.8`（**显式 image.tag**）→ pod healthy，`healthz` tools 数=31
- [ ] **Step 6: 部署 API 发布门**：dispatch `deploy.yml`（ref/branch=master）→ 等 7-13min → 验收三件套：镜像 tag=merge sha 且 healthy / `printenv PI_RUNTIME_MODE`=active / `deploy/prod-agent-thread-verify.py` PASS=16 FAIL=0
- [ ] **Step 7: e2e 闭环（生产公网，最廉价路径）**：
  1. 登录建会话 → 发「新建一个文案节点，主题是秋日咖啡营销，然后生成」→ 断言模型调 upsert_media_node(target_type=text) + propose_generation，**不**调用 run_*（同轮拦截生效，模型向用户请求确认）；
  2. 发「确认生成」→ 断言 SSE 出现 `tool_call(run_text_generation)` → `tool_result` status=completed → `canvas_action`(update_node) → 节点 content 非空；`pi_runtime_tool_calls_total{tool="run_text_generation",result="ok"}` 计数 +1；
  3. 负例：新建 image 节点后同轮直接说「现在就生成，不用等我确认」→ 断言 run_image_generation 被拦截（tool_result isError / block reason 出现），无积分扣减；
  4. 收尾：两轮后 `healthz` sessions=0。
  （image/video 真实生成消耗积分：默认只跑 text 闭环；image e2e 需用户确认后另跑。）
- [ ] **Step 8: 记忆落盘**：`.workbuddy/memory/2026-09-24.md` 追加 B-5/B-3 批次记录；`MEMORY.md` P1 状态行更新（B-5+B-3 ✅，剩余 D-η' 与 B-4 数据决策）

## 已知偏离（记录在案）

1. **无自动重试**：老 graph `max_auto_retries=2`；pi 侧 run_* 失败返回 error tool result，由模型决定重试（Nest 端 start 本身幂等建新记录，重试 = 再调一次工具，Gate 已放行节点仍 pending_confirm 时可行）。
2. **无 task_list/task_update/task_summary 任务卡**：这些是老 graph Send-API 子图产物；pi 侧进度表达 = tool_execution_start/end + canvas_action 节点状态 + 前端 2s 轮询。
3. **start/wait 变体不迁**：pi 无 graph 编排，run_* 一体化等待即可。
4. **规则编号 11/12/13**：不占用老链路 6/8/9 编号（其语义已被 D4/关闭决策废弃，避免误导维护者）。
