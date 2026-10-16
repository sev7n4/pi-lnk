# Canvas 写链 id 结构性绑定（Phase 1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 pi-agent-core 原生钩子（`executionMode:"sequential"` + `after_tool` 捕获 + `before_tool` args 重写 + `before_request` 关窗）零新工具、零重试地消除「同批 create+propose 用旧 node id」类事故（生产事故 `cmv95a7sd000fqh01k1za6w1g`）。

**Architecture:** 新增纯逻辑模块 `canvas-id-binding.ts`（同批窗口 store + 裁决纯函数 + 钩子注册），在 `index.ts` 的 `onSessionCreated` 顶部接线（注册序必须先于既有 after_tool 截断器与 plan/generation gate）。upsert_media_node 成功后捕获返回 nodeId 开「同批窗口」（runId 为键，下次 `before_request` 关闭 = 精确对齐同一条 assistant 消息批次）；窗口内 set/propose 的 `node_id` 不一致时由 `before_tool` 直接重写 args（harness `applyBeforeToolDecision` 按工具 schema 重校验后执行）。kill switch `PI_RUNTIME_CANVAS_ID_BINDING=off` 时三钩子不注册、逐字节旧行为。

**Tech Stack:** pi-runtime（TypeScript ESM、`@earendil-works/pi-agent-core` 0.85.1、node:test + tsx）；apps/server（NestJS，仅错误文案字符串改动）；skills/*.md（纯文档）。

**Spec:** [docs/superpowers/specs/2026-10-16-canvas-write-tool-chain-design.md](../specs/2026-10-16-canvas-write-tool-chain-design.md)（已批准 v3；本计划实现其 Phase 1 = P1a/P1b/P1c，验收硬表 P1-A~F。Phase 2 chain 工具暂缓，不在本计划内。）

## Global Constraints

- 分支：从最新 master 拉 `fix/canvas-id-binding`；每 Task 独立 commit（conventional commits，见各任务）；**禁 `git add -A`**，只 add 本任务点名的文件；push 前 `git status --short` 必须为空。
- 测试命令（**targeted，本机不跑全量套件**——全量是 CI 的活）：
  `cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && node --import tsx --test src/<路径>/<文件>.test.ts`
- 类型检查：`cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && pnpm typecheck`（= `tsc --noEmit`）。
- zsh 纪律：变量紧跟冒号必加花括号（`${R}:path`）；诊断命令禁 `2>/dev/null` 吞 fatal。
- 原子工具契约不变（spec H1）：不新增/改名/删除 `upsert_media_node` / `set_node_generation_params` / `propose_generation` 的任何模型面参数与返回；本计划只加 `executionMode` 字段与钩子层行为。
- kill switch 默认 **on**（`parseBool(env.PI_RUNTIME_CANVAS_ID_BINDING, true)`）；off ⇒ 三钩子不注册 ⇒ 逐字节旧行为（spec 回滚纪律，仿 plan-gate 终审 Critical #1）。
- **钩子注册顺序（关键）**：HookMap 多 listener 链式 replace，**后注册者看到前者的 patch**（`pi-runtime/src/index.ts:130-134` 注释实证）。因此：本模块 `after_tool` 必须**先于** index.ts 既有 after_tool（截断/纠偏）注册（捕获要看未截断全文）；本模块 `before_tool` 必须**先于** plan-gate / generation-gate 注册（gate 的 Nest 存在性校验要验重写后的正确 id）。
- 注释纪律：写「为什么」，正面记录被删历史/既有约束；禁止占位 TODO。
- `skills/**` 改动合入后需**手工 dispatch `runtime-deploy`**（tag = master 短 SHA）才到生产（AGENTS.md 纪律）——记入 Task 6。

## Review Focus

规格隐含但单测之外的五类输入/失败模式（每条已在 owning Task 里钉了测试或验证步骤）：

1. **run 跨多条消息**：同一 run 中，消息1 创建节点、消息2 合法提名**旧**节点 → 窗口已在两次消息间的 `before_request` 关闭，**不得误重写**（spec H5「窗口外放行」）。→ Task 2 测试 `before_request 关窗后放行`。
2. **同批多节点创建**：一条消息 >1 个 `upsert_media_node` → 无法消歧，必须 fail-closed block 并**列出全部候选 id**，绝不猜测性重写。→ Task 2 测试 `多 upsert → block`。
3. **upsert 结果畸形/截断**：content 非 JSON、缺 `data.nodeId`、isError=true → 捕获 fail-soft 不记录、不抛错、行为回退为旧路径（passthrough）。→ Task 2 测试 `畸形 content`；注册顺序约束（先于截断器）由 Task 4 代码位置 + 注释钉住。
4. **kill switch 误开/忘关**：`PI_RUNTIME_CANVAS_ID_BINDING=off` ⇒ 零钩子注册、逐字节旧行为（回滚出口）。→ Task 3 测试。
5. **guideSceneId 编造值**（事故次生缺陷）：模型拿 skill 名/自造串当 scene id → Nest 报错文案必须教「`list_generation_scenes` 取合法 id；无匹配则省略」。→ Task 5 grep 验证。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `services/pi-runtime/src/tools/canvas-write.ts` | Modify（3 处各 1 行） | 三写工具加 `executionMode:"sequential"`（P1a） |
| `services/pi-runtime/src/tools/canvas-write.test.ts` | Modify（追加 1 个 describe） | P1-A 验收断言 |
| `services/pi-runtime/src/tools/canvas-id-binding.ts` | Create | 同批窗口 store + 裁决纯函数 + 三钩子注册（P1b 全部逻辑） |
| `services/pi-runtime/src/tools/canvas-id-binding.test.ts` | Create | P1-C/P1-D 验收断言 + kill switch + 窗口关闭 |
| `services/pi-runtime/src/runtime-config.ts` | Modify（+4 行） | `canvasIdBindingEnabled()` kill switch |
| `services/pi-runtime/src/index.ts` | Modify（+6 行 + 1 import） | `onSessionCreated` 顶部接线（注册序约束） |
| `apps/server/src/agent/agent-canvas-tools.service.ts` | Modify（1 处字符串） | `unknown guideSceneId` 文案引导（P1c/P1-E） |
| `skills/drama-character-design/SKILL.md` | Modify（+1 bullet + 版本/changelog） | guide_scene_id 使用纪律（P1c） |

---

### Task 1: P1a — 三写工具 `executionMode:"sequential"`

**Files:**
- Modify: `services/pi-runtime/src/tools/canvas-write.ts`（`upsert_media_node` ~147、`set_node_generation_params` ~279、`propose_generation` ~389 的 label 行后各加 1 行）
- Test: `services/pi-runtime/src/tools/canvas-write.test.ts`（文件末尾追加）

**Interfaces:**
- Consumes: 既有 `LnkpiTool`（= `AgentHarnessTool<LnkpiToolContext> & {...}`，已含 `executionMode?: ToolExecutionMode`，范式见 `tools/todo.ts:97`）。
- Produces: 三工具 `tool.executionMode === "sequential"`。harness 语义（上游保证，不需我们实现）：sequential = 每个调用 prepared → executed → **finalized**（含 after_tool）后才轮到下一个 ⇒ Task 3 的捕获时序成立。

- [ ] **Step 1: 写失败测试**（`canvas-write.test.ts` 末尾追加）

```ts
describe("canvas-write: 写工具串行化（spec 2026-10-16 P1-A）", () => {
	it("upsert_media_node / set_node_generation_params / propose_generation 声明 executionMode=sequential", () => {
		const { client } = makeClient();
		const tools = createCanvasWriteTools(client);
		for (const name of ["upsert_media_node", "set_node_generation_params", "propose_generation"]) {
			const tool = findTool(tools, name);
			assert.equal(tool.executionMode, "sequential", `${name} 必须串行（同批写调用 create 先 finalize，P1b 捕获时序的前提）`);
		}
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && node --import tsx --test src/tools/canvas-write.test.ts`
Expected: FAIL（`undefined` ≠ `"sequential"`，三个工具各报一条）

- [ ] **Step 3: 最小实现**（canvas-write.ts 三处，各在 label 行后插入同一行）

① `upsert_media_node`（`label: "新建/更新媒体节点",` 之后）：

```ts
			executionMode: "sequential", // P1a（spec 2026-10-16）：同批写调用串行，create 先 finalize 落 id
```

② `set_node_generation_params`（`label: "配生成参数",` 之后）：

```ts
			executionMode: "sequential", // P1a（spec 2026-10-16）：与 upsert/propose 同批时按序执行
```

③ `propose_generation`（`label: "提议生成",` 之后）：

```ts
			executionMode: "sequential", // P1a（spec 2026-10-16）：同批写调用串行，见 P1b 捕获时序
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && node --import tsx --test src/tools/canvas-write.test.ts`
Expected: PASS（全部用例，含既有用例——executionMode 不影响 execute 行为）

- [ ] **Step 5: 提交**

```bash
git add services/pi-runtime/src/tools/canvas-write.ts services/pi-runtime/src/tools/canvas-write.test.ts
git commit -m "fix(pi-runtime): 画布三写工具 executionMode=sequential（spec 2026-10-16 P1-A）"
```

---

### Task 2: P1b 纯逻辑 — 同批窗口 store + 裁决函数

**Files:**
- Create: `services/pi-runtime/src/tools/canvas-id-binding.ts`（本任务只写 store + `decideBinding` + `recordUpsertedNode` + `closeBindingWindow`；register 函数在 Task 3 追加进同一文件）
- Test: `services/pi-runtime/src/tools/canvas-id-binding.test.ts`

**Interfaces:**
- Consumes: `readRecord` / `readStringField`（`src/hook-contract.ts`，既有读取守卫）；Nest upsert-media-node 返回经 `resultWithActions` 包装后 content[0].text = `JSON.stringify({ok:true, data:{nodeId, actions}})`（`tools/result-with-actions.ts:15-23` + `apps/server` controller `{code,message,data}` 解包实证）。
- Produces（Task 3 依赖，签名逐字）:
  - `recordUpsertedNode(runId: string, content: unknown): void`
  - `closeBindingWindow(runId: string): void`
  - `decideBinding(toolName: string, args: unknown, runId: string): BindingDecision`
  - `type BindingDecision = { kind: "passthrough" } | { kind: "rewrite"; nodeId: string } | { kind: "block"; reason: string }`
  - `resetIdBindingForTest(): void`

- [ ] **Step 1: 写失败测试**（新建 `canvas-id-binding.test.ts`）

```ts
/** canvas-id-binding 单测（spec 2026-10-16 P1-C/P1-D）：纯逻辑直调，stub harness 见 Task 3。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	closeBindingWindow,
	decideBinding,
	recordUpsertedNode,
	resetIdBindingForTest,
} from "./canvas-id-binding.js";

function upsertContent(nodeId: string) {
	return [{ type: "text", text: JSON.stringify({ ok: true, data: { nodeId, actions: [] } }) }];
}

describe("canvas-id-binding: 同批窗口捕获与裁决（spec P1b）", () => {
	it("窗口未开（无 pending upsert）→ 放行旧节点引用（合法用户点名，spec P1-D）", () => {
		resetIdBindingForTest();
		assert.deepEqual(decideBinding("propose_generation", { node_id: "image-old" }, "r1"), {
			kind: "passthrough",
		});
	});

	it("窗口内单 upsert + node_id 不一致 → rewrite 为记录 id（spec P1-C，零重试主路径）", () => {
		resetIdBindingForTest();
		recordUpsertedNode("r1", upsertContent("image-new"));
		const original = { node_id: "image-old", guide_scene_id: "s1" };
		const d = decideBinding("propose_generation", original, "r1");
		assert.deepEqual(d, { kind: "rewrite", nodeId: "image-new" });
		// 不突变调用方 args（重写由 register 层展开新对象）
		assert.equal(original.node_id, "image-old");
	});

	it("node_id 已等于记录 id → passthrough（含 update 路径 upsert 返回 existing.id）", () => {
		resetIdBindingForTest();
		recordUpsertedNode("r1", upsertContent("image-new"));
		assert.deepEqual(decideBinding("set_node_generation_params", { node_id: "image-new" }, "r1"), {
			kind: "passthrough",
		});
	});

	it("同批多 upsert（无法消歧）→ fail-closed block 且 reason 列出全部候选 id（Review Focus #2）", () => {
		resetIdBindingForTest();
		recordUpsertedNode("r1", upsertContent("image-a"));
		recordUpsertedNode("r1", upsertContent("image-b"));
		const d = decideBinding("propose_generation", { node_id: "image-a" }, "r1");
		assert.equal(d.kind, "block");
		assert.ok(d.kind === "block" && d.reason.includes("image-a") && d.reason.includes("image-b"));
	});

	it("非 set/propose 工具（如同批 set_node_text）→ 永不介入（spec P1b 范围锁定）", () => {
		resetIdBindingForTest();
		recordUpsertedNode("r1", upsertContent("image-new"));
		assert.deepEqual(decideBinding("set_node_text", { node_id: "image-old" }, "r1"), {
			kind: "passthrough",
		});
	});

	it("畸形 content（非 JSON / 缺 data.nodeId / 非 text 块）→ fail-soft 不记录、不抛（Review Focus #3）", () => {
		resetIdBindingForTest();
		recordUpsertedNode("r1", [{ type: "text", text: "not json" }]);
		recordUpsertedNode("r1", [{ type: "text", text: JSON.stringify({ ok: true }) }]);
		recordUpsertedNode("r1", "string-content");
		assert.deepEqual(decideBinding("propose_generation", { node_id: "image-old" }, "r1"), {
			kind: "passthrough",
		});
	});

	it("before_request 关窗：同 run 后续消息合法提名旧节点 → 不误重写（Review Focus #1）", () => {
		resetIdBindingForTest();
		recordUpsertedNode("r1", upsertContent("image-new"));
		closeBindingWindow("r1");
		assert.deepEqual(decideBinding("propose_generation", { node_id: "image-old" }, "r1"), {
			kind: "passthrough",
		});
	});

	it("窗口按 runId 隔离：r2 的窗口不影响 r1，反之亦然", () => {
		resetIdBindingForTest();
		recordUpsertedNode("r1", upsertContent("image-r1"));
		assert.deepEqual(decideBinding("propose_generation", { node_id: "x" }, "r2"), { kind: "passthrough" });
		assert.deepEqual(decideBinding("propose_generation", { node_id: "x" }, "r1").kind, "rewrite");
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && node --import tsx --test src/tools/canvas-id-binding.test.ts`
Expected: FAIL（模块不存在，import 报错）

- [ ] **Step 3: 最小实现**（新建 `canvas-id-binding.ts`）

```ts
/**
 * Canvas 写链 id 结构性绑定（spec docs/superpowers/specs/2026-10-16-canvas-write-tool-chain-design.md §4.1 P1b）。
 *
 * 事故 cmv95a7sd000fqh01k1za6w1g：模型同批并行发射 upsert_media_node + set/propose，
 * 后两者用上下文里的旧节点 id，Nest 只校验「节点存在」→ 放行错绑（propose 卡指向旧机器人）。
 * 修复 = 原生钩子三件套（零新工具，底层原子工具契约不变）：
 * - after_tool 捕获 upsert 返回 nodeId（content[0].text = `{"ok":true,"data":{"nodeId":...}}`，
 *   形态出处 result-with-actions.ts + Nest controller {code,message,data} 解包）；
 * - before_tool 对 set/propose 以正确 id 重写 args —— harness `applyBeforeToolDecision`
 *   （execution/tools.js:37-54）会把替换参按工具 schema 重校验后执行 ⇒ 零重试；
 * - before_request 关「同批窗口」。
 *
 * 作用域 = 「同批窗口」：runId 为键、下次 before_request 关闭，精确对齐同一条 assistant
 * 消息的批次（sequential 模式下批次内 before_tool 全部触发完才到下一次 before_request）。
 * ⚠️ 不能只按 runId 作用域：一个 run 可跨多条消息，后续消息合法提名旧节点会被误重写。
 *
 * 注册顺序约束（index.ts 接线处遵守，此处只是记录）：本模块 after_tool 必须先于 index.ts
 * 既有 after_tool（截断/纠偏）注册——HookMap 多 listener 链式 replace（hooks.ts:305-324），
 * 后注册者看到前者的 patch，捕获必须看到未截断全文；before_tool 必须先于 plan-gate /
 * generation-gate，让 gate 的 Nest 存在性校验验的是重写后的正确 id。
 */
import type { AgentHarness } from "@earendil-works/pi-agent-core";
import type { LnkpiToolContext } from "./types.js";
import { readRecord, readStringField } from "../hook-contract.js";

/** 重写目标工具（spec P1b 范围锁定；set_node_text 等不扩——YAGNI，spec §2.2）。 */
const BINDING_TARGETS = new Set(["set_node_generation_params", "propose_generation"]);
const UPSERT_TOOL = "upsert_media_node";

/** 同批窗口：runId → 本窗口内成功 upsert 返回的 nodeId 列表（length>1 = 无法消歧）。 */
const windows = new Map<string, string[]>();

/** 测试隔离：清空全部窗口。 */
export function resetIdBindingForTest(): void {
	windows.clear();
}

function safeParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * after_tool 捕获：成功 upsert 开窗并记录 nodeId；content 形态不符 → fail-soft 不记
 * （行为回退旧路径，绝不抛——钩子抛错会污染工具结算链）。
 */
export function recordUpsertedNode(runId: string, content: unknown): void {
	const items = Array.isArray(content) ? content : [];
	const first = items.find(
		(c): c is { type: "text"; text: string } =>
			!!c && typeof c === "object" && (c as { type?: unknown }).type === "text",
	);
	if (!first || typeof first.text !== "string") return;
	const parsed = readRecord(safeParse(first.text), "canvas-id-binding.content");
	if (!parsed.ok) return;
	const data = readRecord(parsed.value.data, "canvas-id-binding.content.data");
	if (!data.ok) return;
	const nodeId = readStringField(data.value, "nodeId", "canvas-id-binding.data.nodeId");
	if (!nodeId.ok) return;
	const list = windows.get(runId) ?? [];
	list.push(nodeId.value);
	windows.set(runId, list);
}

/** before_request 关窗（上一条 assistant 消息批次已完整落定）。 */
export function closeBindingWindow(runId: string): void {
	windows.delete(runId);
}

export type BindingDecision =
	| { kind: "passthrough" }
	| { kind: "rewrite"; nodeId: string }
	| { kind: "block"; reason: string };

/**
 * before_tool 裁决（纯函数，便于单测）：
 * - 窗口未开 → 放行（合法「用户点名旧节点」，沿用 Nest 存在性校验）；
 * - 窗口内 >1 个 upsert（多节点创建无法消歧）→ fail-closed block 列出候选，绝不猜测性重写；
 * - args.node_id 缺失/非字符串 → fail-closed block 指名正确 id（防御：正常已被工具 schema 拦下）；
 * - args.node_id ≠ 记录 id → rewrite（携带正确 id，由 register 层构造替换 args）。
 */
export function decideBinding(toolName: string, args: unknown, runId: string): BindingDecision {
	if (!BINDING_TARGETS.has(toolName)) return { kind: "passthrough" };
	const list = windows.get(runId);
	if (!list || list.length === 0) return { kind: "passthrough" };
	if (list.length > 1) {
		return {
			kind: "block",
			reason: `本条消息创建了多个节点（${list.join(", ")}），无法确定 ${toolName} 的目标。请明确指名要操作的 node_id（需要多个节点时逐条消息操作），不要让我猜测。`,
		};
	}
	const created = list[0];
	const current = readStringField(args, "node_id", "before_tool.args");
	if (!current.ok) {
		return {
			kind: "block",
			reason: `本条消息刚创建了节点 ${created}，${toolName} 必须对该 node_id 操作（当前 args 缺 node_id）。`,
		};
	}
	if (current.value === created) return { kind: "passthrough" };
	return { kind: "rewrite", nodeId: created };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && node --import tsx --test src/tools/canvas-id-binding.test.ts`
Expected: PASS（8 个用例全绿）

- [ ] **Step 5: 提交**

```bash
git add services/pi-runtime/src/tools/canvas-id-binding.ts services/pi-runtime/src/tools/canvas-id-binding.test.ts
git commit -m "feat(pi-runtime): canvas id 同批窗口捕获/裁决纯逻辑（spec 2026-10-16 P1b）"
```

---

### Task 3: P1b 接线 — 三钩子注册 + kill switch

**Files:**
- Modify: `services/pi-runtime/src/tools/canvas-id-binding.ts`（文件末尾追加 register 函数与常量）
- Modify: `services/pi-runtime/src/runtime-config.ts`（`planGateEnabled` ~291 旁加 4 行）
- Test: `services/pi-runtime/src/tools/canvas-id-binding.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 的 `recordUpsertedNode` / `closeBindingWindow` / `decideBinding` / `resetIdBindingForTest`；runtime-config 既有 `parseBool`（`planGateEnabled` 同款，runtime-config.ts:291-293）。
- Produces: `registerCanvasIdBindingHooks(harness: AgentHarness<LnkpiToolContext>): void`（Task 4 接线唯一入口）；`canvasIdBindingEnabled(env?): boolean`。注册三钩子：`after_tool`（捕获，返回 undefined 不 patch）、`before_tool`（rewrite/block/passthrough）、`before_request`（关窗，返回 undefined）。

- [ ] **Step 1: 写失败测试**（`canvas-id-binding.test.ts` 追加；顶部补两行 import：`registerCanvasIdBindingHooks` 加入既有 import、`import type { AgentHarness } from "@earendil-works/pi-agent-core";`、`import type { LnkpiToolContext } from "./types.js";`）

```ts
describe("canvas-id-binding: 钩子注册与 kill switch（spec P1b）", () => {
	/** 捕获式 stub harness（同 plan-gate-wiring.test.ts 范式）。 */
	function stubHarness() {
		const handlers = new Map<string, (event: never) => Promise<unknown>>();
		const harness = {
			hooks: {
				on: (name: string, fn: never) => {
					handlers.set(name, fn as never);
				},
			},
		} as unknown as AgentHarness<LnkpiToolContext>;
		return { harness, handlers };
	}

	it("默认 on：注册 after_tool / before_tool / before_request 三钩子", () => {
		resetIdBindingForTest();
		const { harness, handlers } = stubHarness();
		registerCanvasIdBindingHooks(harness);
		assert.ok(handlers.has("after_tool"));
		assert.ok(handlers.has("before_tool"));
		assert.ok(handlers.has("before_request"));
	});

	it("kill switch off（PI_RUNTIME_CANVAS_ID_BINDING=off）→ 零钩子注册，逐字节旧行为（Review Focus #4）", () => {
		resetIdBindingForTest();
		process.env.PI_RUNTIME_CANVAS_ID_BINDING = "off";
		try {
			const { harness, handlers } = stubHarness();
			registerCanvasIdBindingHooks(harness);
			assert.equal(handlers.size, 0, "off 时不得注册任何钩子");
		} finally {
			delete process.env.PI_RUNTIME_CANVAS_ID_BINDING;
		}
	});

	it("after_tool：成功 upsert 记录 → before_tool 重写返回 {args}；isError upsert 不记录", async () => {
		resetIdBindingForTest();
		const { harness, handlers } = stubHarness();
		registerCanvasIdBindingHooks(harness);
		const afterTool = handlers.get("after_tool")!;
		const beforeTool = handlers.get("before_tool")!;

		// 成功 upsert：捕获
		await afterTool({
			runId: "r9",
			toolName: "upsert_media_node",
			isError: false,
			content: upsertContent("image-9"),
		} as never);
		const rewritten = (await beforeTool({
			runId: "r9",
			toolName: "propose_generation",
			args: { node_id: "image-old" },
		} as never)) as { args?: Record<string, unknown> };
		assert.deepEqual(rewritten, { args: { node_id: "image-9" } });

		// 失败 upsert：不捕获（新 run r10 保持窗口未开）
		await afterTool({
			runId: "r10",
			toolName: "upsert_media_node",
			isError: true,
			content: upsertContent("image-x"),
		} as never);
		assert.deepEqual(await beforeTool({ runId: "r10", toolName: "propose_generation", args: { node_id: "old" } } as never), undefined);
	});

	it("before_request 关窗：同 runId 下一批消息恢复旧路径", async () => {
		resetIdBindingForTest();
		const { harness, handlers } = stubHarness();
		registerCanvasIdBindingHooks(harness);
		const afterTool = handlers.get("after_tool")!;
		const beforeTool = handlers.get("before_tool")!;
		const beforeRequest = handlers.get("before_request")!;

		await afterTool({ runId: "r11", toolName: "upsert_media_node", isError: false, content: upsertContent("image-11") } as never);
		await beforeRequest({ runId: "r11" } as never);
		assert.deepEqual(
			await beforeTool({ runId: "r11", toolName: "propose_generation", args: { node_id: "image-old" } } as never),
			undefined,
			"关窗后必须放行（合法用户点名旧节点）",
		);
	});

	it("捕获钩子返回 undefined（不 patch content，不干扰既有截断链）", async () => {
		resetIdBindingForTest();
		const { harness, handlers } = stubHarness();
		registerCanvasIdBindingHooks(harness);
		const out = await handlers.get("after_tool")!({
			runId: "r12",
			toolName: "upsert_media_node",
			isError: false,
			content: upsertContent("image-12"),
		} as never);
		assert.equal(out, undefined);
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && node --import tsx --test src/tools/canvas-id-binding.test.ts`
Expected: FAIL（`registerCanvasIdBindingHooks` 未定义）

- [ ] **Step 3: 最小实现**

① `runtime-config.ts`：在 `planGateEnabled`（~291-293）之后追加：

```ts
/** Canvas 写链 id 绑定开关（spec 2026-10-16 §4.1 P1b）：off = 三钩子不注册，逐字节旧行为。
 * 已知降级：回到「模型文本搬运 id」旧风险，仅紧急止血用（回滚出口，仿 plan-gate 终审 Critical #1）。 */
export function canvasIdBindingEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return parseBool(env.PI_RUNTIME_CANVAS_ID_BINDING, true);
}
```

② `canvas-id-binding.ts`：文件头部 import 区补 `import { canvasIdBindingEnabled } from "../runtime-config.js";`，文件末尾追加：

```ts
/**
 * 三钩子注册（index.ts onSessionCreated 顶部唯一接线点；kill switch off ⇒ 不注册）。
 * 注册顺序约束见文件头注释：调用方必须把本函数放在既有 after_tool（截断/纠偏）与
 * plan-gate / generation-gate 注册之前。
 */
export function registerCanvasIdBindingHooks(harness: AgentHarness<LnkpiToolContext>): void {
	if (!canvasIdBindingEnabled()) return;
	harness.hooks.on("after_tool", async (event) => {
		if (event.toolName === UPSERT_TOOL && !event.isError) {
			recordUpsertedNode(event.runId, event.content);
		}
		return undefined; // 只捕获不改写：content patch（截断/纠偏）归 index.ts 既有 listener
	});
	harness.hooks.on("before_tool", async (event) => {
		const d = decideBinding(event.toolName, event.args, event.runId);
		if (d.kind === "rewrite") {
			// event.args 是 Record<string, JsonValue>；仅替换 node_id，其余字段原样保留
			// （applyBeforeToolDecision 会按工具 schema 重校验整个替换参，非法即 fail-closed）。
			return { args: { ...event.args, node_id: d.nodeId } };
		}
		if (d.kind === "block") return { block: { reason: d.reason } };
		return undefined;
	});
	harness.hooks.on("before_request", async (event) => {
		closeBindingWindow(event.runId);
		return undefined;
	});
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && node --import tsx --test src/tools/canvas-id-binding.test.ts`
Expected: PASS（Task 2 的 8 个 + 本任务 5 个全绿）

- [ ] **Step 5: 类型检查**

Run: `cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && pnpm typecheck`
Expected: 无错误（`{args: {...event.args, node_id}}` 对 `Record<string, JsonValue>` 类型相容）

- [ ] **Step 6: 提交**

```bash
git add services/pi-runtime/src/tools/canvas-id-binding.ts services/pi-runtime/src/tools/canvas-id-binding.test.ts services/pi-runtime/src/runtime-config.ts
git commit -m "feat(pi-runtime): canvas id binding 三钩子注册 + kill switch（spec 2026-10-16 P1b）"
```

---

### Task 4: index.ts 接线（注册序 = 正确性的一部分）

**Files:**
- Modify: `services/pi-runtime/src/index.ts`（import 区 +1 行；`onSessionCreated` 内 `const hookCfg = loadRuntimeConfig(process.env);`（~90 行）之后 +6 行）

**Interfaces:**
- Consumes: Task 3 的 `registerCanvasIdBindingHooks(harness)`。
- Produces: 生产会话生效的绑定行为；无新导出。index.ts 是模块级单例 + env 装配，无法单测驱动（同 plan-gate-wiring 抽离时的既有结论）——本任务验证 = typecheck + 代码位置评审；行为由 Task 2/3 单测 + Task 6 生产复测覆盖。

- [ ] **Step 1: 加 import**（紧邻既有 `registerPlanGateHooks` 的 import 行，同款相对路径风格）

```ts
import { registerCanvasIdBindingHooks } from "./tools/canvas-id-binding.js";
```

- [ ] **Step 2: onSessionCreated 顶部接线**（`const hookCfg = loadRuntimeConfig(process.env);` 之后、既有 `harness.hooks.on("after_tool", ...)` 之前插入）

```ts
			// Canvas 写链 id 结构性绑定（spec 2026-10-16 §4.1 P1b，事故 cmv95a7sd000fqh01k1za6w1g）。
			// ⭐ 注册序即正确性（HookMap 多 listener 链式 replace，后注册者看到前者的 patch）：
			// ① after_tool 先于下方既有 after_tool —— 捕获要看到未截断全文；
			// ② before_tool 先于下方 plan-gate / generation-gate —— gate 的 Nest 存在性校验
			//    验的才是重写后的正确 id（旧 id 可能 404 造成误导性拦截）。
			registerCanvasIdBindingHooks(harness);
```

- [ ] **Step 3: 类型检查 + 既有 gate 测试不回归**

Run: `cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && pnpm typecheck && node --import tsx --test src/gate/plan-gate-wiring.test.ts src/session-manager.plan-gate.test.ts`
Expected: typecheck 无错误；两个既有测试文件 PASS（接线不得影响 plan-gate 行为）

- [ ] **Step 4: 提交**

```bash
git add services/pi-runtime/src/index.ts
git commit -m "feat(pi-runtime): index 接线 canvas id binding（注册序先于截断/gate，spec 2026-10-16 P1b）"
```

---

### Task 5: P1c — guideSceneId 文案引导 + skill 纪律

**Files:**
- Modify: `apps/server/src/agent/agent-canvas-tools.service.ts:280`（错误文案字符串）
- Modify: `skills/drama-character-design/SKILL.md`（「规则与边界」+1 bullet；版本 0.2.2→0.2.3 + changelog）

**Interfaces:**
- Consumes: 既有 `getGenerationScene` 校验分支（service.ts:277-285，reason 经 Nest 400 → NestToolError message 到达模型——事故已实证该文案可达模型）。
- Produces: 文案含 `list_generation_scenes` 指引与「无匹配则省略」；skill 正文含同款纪律。无代码接口变更。

- [ ] **Step 1: 改 Nest 错误文案**（service.ts:280，整行替换）

旧：

```ts
        return { ok: false, reason: `unknown guideSceneId "${String(value)}"`, allowed }
```

新：

```ts
        return {
          ok: false,
          reason: `unknown guideSceneId "${String(value)}" — call list_generation_scenes to get a valid scene id; if no scene matches, omit guide_scene_id`,
          allowed,
        }
```

- [ ] **Step 2: skill 补纪律**（`skills/drama-character-design/SKILL.md` 「## 规则与边界」小节，`- 芯片 key（@I1/I2）不是画布节点 id；禁止 connect_nodes 连芯片` 之后加一行）

```markdown
- `guide_scene_id` 只能取 `list_generation_scenes` 返回的真实场景 id；角色设计类若无匹配场景就**省略**该字段，不要拿 skill 名或自造串充数
```

- [ ] **Step 3: 版本与 changelog**（SKILL.md frontmatter `version: "0.2.2"` → `version: "0.2.3"`；「## 变更记录」列表顶部加）

```markdown
- **0.2.3** (2026-10-16)：规则与边界补 `guide_scene_id` 使用纪律（只取 `list_generation_scenes` 真实 id，无匹配则省略）——事故 cmv95a7sd000fqh01k1za6w1g 次生缺陷（skill 名被当 scene id）的文案级纠正。
```

- [ ] **Step 4: 验证（P1-E 验收）**

Run: `grep -n "list_generation_scenes to get a valid scene id" apps/server/src/agent/agent-canvas-tools.service.ts && grep -n "guide_scene_id.*list_generation_scenes" skills/drama-character-design/SKILL.md`
Expected: 两条各 1 命中（文案与纪律均在位）

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/agent/agent-canvas-tools.service.ts skills/drama-character-design/SKILL.md
git commit -m "fix(server,skills): guideSceneId 错误文案引导 + skill 纪律补充（spec 2026-10-16 P1-E）"
```

---

### Task 6: 汇总验证 + 交付（P1-F 为合入后人工项）

**Files:** 无新改动；验证 + 交付清单。

- [ ] **Step 1: 全部 targeted 测试**

Run: `cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && node --import tsx --test src/tools/canvas-write.test.ts src/tools/canvas-id-binding.test.ts src/gate/plan-gate-wiring.test.ts src/session-manager.plan-gate.test.ts`
Expected: 全 PASS

- [ ] **Step 2: 类型检查**

Run: `cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && pnpm typecheck`
Expected: 无错误

- [ ] **Step 3: 工作区干净**

Run: `git status --short`
Expected: 空（全部已提交）

- [ ] **Step 4: 推送分支并开 PR**

```bash
git push -u origin fix/canvas-id-binding
```

按 `docs/agent/delivery.md` PR 规范开 PR（squash 合并偏好）。⚠️ 活跃部署窗口内 push 的 run 可能被静默 cancel——审批后核对返回体 sha。

- [ ] **Step 5: 合入后 P1-F 生产复测**（人工，按 delivery.md 部署纪律）

1. 部署后（`skills/**` 改动需手工 dispatch `runtime-deploy`，tag = master 短 SHA）。
2. 生产画布新会话，让 agent「新建一个图片节点并提议生成」→ **propose 卡 `nodeId` 与 `upsert_media_node` 返回 id 恒等**；无错绑卡死（P1-F）。
3. 同一条消息让 agent 连建两个节点并提议 → 应 fail-closed block，文案列出两个候选 id、不猜测。
4. 创建后下一条消息提名旧节点生成 → 应正常放行（窗口关闭，不误重写）。
5. 观测：`tool_result` 中 propose 目标 id 抽查 ≥3 次会话；kill switch 演练一次（env off → 行为回旧）。

---

## Self-Review（已执行）

- **Spec coverage**：P1-A→Task 1；P1-B→Task 1（串行声明，上游语义保证）+ Task 3（捕获/重写时序测试）+ Task 6 Step 5（生产复测）；P1-C→Task 2/3 重写用例；P1-D→Task 2 兜底/放行用例 + Task 5；P1-E→Task 5；P1-F→Task 6 Step 5。H1-H7 全部落在 Global Constraints 与任务实现里。Phase 2/3 不在本计划（spec 暂缓/另开 plan）✓。
- **Placeholder scan**：无 TBD/TODO；所有代码步骤含完整代码；验证步骤含精确命令与期望输出 ✓。
- **Type consistency**：`BindingDecision` 三态、`registerCanvasIdBindingHooks(harness)` 签名在 Task 2/3/4 间逐字一致；`recordUpsertedNode(runId, content)` 参数序一致 ✓。
- **Review Focus 落钉**：#1→Task 2 关窗用例；#2→Task 2 多 upsert 用例；#3→Task 2 畸形 content 用例 + Task 4 注册序注释；#4→Task 3 kill switch 用例；#5→Task 5 grep 验证 ✓。
