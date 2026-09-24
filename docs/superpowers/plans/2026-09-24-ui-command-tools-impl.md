# UI_COMMAND×5 → canvas_command 通道实现计划（P1 批次）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 pi-runtime 注册 5 个本地 UI 命令工具（focus_node / focus_nodes / undo / redo / open_image_editor），工具结果经 Nest 派生 `canvas_command` SSE 事件驱动前端画布视口/撤销/编辑器，前端零改动。

**Architecture:** 工具在 pi-runtime 本地执行（不走 Nest HTTP），返回 `{content, details:{canvasCommands}}`；Nest `pi-events.ts` 新增纯函数从 `tool_execution_end.result.details` 提取命令，`agent.service.ts` streamFromPiRuntime 逐条 yield `canvas_command` 事件。前端 `AgentSideRail.vue:1968` 已有完整消费分支。

**Tech Stack:** TypeScript / TypeBox（pi-runtime，node:test）/ vitest（apps/server）/ Fastify SSE。

**Spec:** `docs/superpowers/plans/2026-09-24-ui-command-canvas-action-design.md`（含本计划的 3 处勘误，见下）。

## 对设计文档的勘误（代码核对 2026-09-24 04:30，已核对原文）

1. **事件名是 `canvas_command` 不是 `canvas_action`**。老链路 `runs.py:1220` 发 `{"type":"canvas_command","data":cmd}`；消费方在 `AgentSideRail.vue:1968`（case 'canvas_command'：onFocusNode / emit('undo'/'redo') / emit('openImageEditor')）。`canvas_action` 走 `CanvasActionSchema`（packages/shared/src/agentContract.ts:16）只认 add_node/update_node/remove_node/add_edge/remove_edge/set_viewport 六种——focus_node 等会被静默丢弃。本计划按 `canvas_command` 实现。
2. **`canvas_command` 不进 canvasActions**：它是 UI 命令而非画布数据动作，不参与 finalizeTurn 的 canvasActions 累积（agent.service.ts:686-688 的 canvas_action 分支不得复用）。
3. **undo/redo 行为对齐已验证，可随批上线**：老链路 agent 写入同样不进前端 undo 栈（CanvasPage.vue:1454 注释「勿 persistUserEdit」；handleAgentActions 不调 commitAfterChange）——pi 链路上线后行为与老链路一致，无新增回归。已知边缘情况（undo 快照回滚可能连带抹掉 agent 写入并 saveCanvas 持久化）两侧相同，记账不阻塞。

## Global Constraints

- 工具输出契约与老链路逐字一致（`definitions.py:472-489`）：camelCase `{ok:true, canvasCommands:[{type,nodeId?,nodeIds?}]}`。
- pi-runtime 部署纪律：**先 pi-runtime 后 API**（B-2 定案）。
- 部署门：pi-runtime helm 显式 `--set image.tag` + `env.PI_RUNTIME_VERSION`；API 走 pi-lnk master 发布门。
- 不改动前端任何文件；不改动 packages/shared。
- pi-runtime 版本递增：本次 0.0.6 → **0.0.7**。
- 分支 `p1/ui-command-tools`，用 using-git-worktrees 隔离。

## Review Focus

- 非 UI_COMMAND 工具（走 Nest 的 25 个）绝不能派生出 canvas_command——extractCanvasCommands 必须只认 `result.details.canvasCommands` 数组（Nest 转发工具的 details 形态是 `{ok,data}`，天然不含该键）。测试：Task 3。
- `isError:true` 的工具失败事件不得派生命令。测试：Task 3。
- canvas_command 不得进入 canvasActions 累积（否则 finalizeTurn 语义被污染）。测试：Task 4 的代码审查 + e2e 无重复落库。
- undo/redo 工具无必填参数，模型可能空转调用——与老链路一致，不设防（schema 无参数即文档化行为）。

---

### Task 1: pi-runtime — ui_command tier + 5 个本地工具

**Files:**
- Modify: `services/pi-runtime/src/tools/types.ts:9-17`
- Create: `services/pi-runtime/src/tools/ui-command.ts`
- Create: `services/pi-runtime/src/tools/ui-command.test.ts`
- Modify: `services/pi-runtime/src/tools/registry.ts`
- Modify: `services/pi-runtime/src/tools/config.ts:31`

**Interfaces:**
- Consumes: `LnkpiTool`（types.ts）、`Metrics.observeToolCall(tool, outcome)`（metrics.ts:51，签名 `("ok"|"error"|"circuit_open")`）
- Produces: `createUiCommandTools(metrics: Metrics): LnkpiTool[]`；ToolTier 联合类型新增 `"ui_command"`；`resolveTools()` 返回数组末尾追加 5 个工具

- [ ] **Step 1: 写失败测试** `services/pi-runtime/src/tools/ui-command.test.ts`

```ts
/** UI_COMMAND×5 契约测试：本地无 IO、输出 camelCase canvasCommands、tier=ui_command、metrics 计数。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createUiCommandTools } from "./ui-command.js";
import { Metrics } from "../metrics.js";

function setup() {
	const metrics = new Metrics();
	const tools = createUiCommandTools(metrics);
	const find = (name: string) => {
		const tool = tools.find((t) => t.name === name);
		assert.ok(tool, `tool ${name} not registered`);
		return tool;
	};
	return { metrics, tools, find };
}

describe("UI_COMMAND 本地工具", () => {
	it("5 个工具全部注册且 tier=ui_command", () => {
		const { tools } = setup();
		assert.deepEqual(
			tools.map((t) => t.name).sort(),
			["focus_node", "focus_nodes", "open_image_editor", "redo", "undo"],
		);
		for (const t of tools) assert.equal(t.tier, "ui_command");
	});

	it("focus_node 返回 camelCase canvasCommands（content 与 details 同构）", async () => {
		const { find } = setup();
		const r = await find("focus_node")!.execute!("_c1", { node_id: "n1" }, undefined, {
			sessionId: "s1",
		} as never);
		const expected = { ok: true, canvasCommands: [{ type: "focus_node", nodeId: "n1" }] };
		assert.deepEqual(JSON.parse(r.content[0].text), expected);
		assert.deepEqual(r.details, { ok: true, canvasCommands: [{ type: "focus_node", nodeId: "n1" }] });
	});

	it("focus_nodes 的 node_ids 映射为 nodeIds", async () => {
		const { find } = setup();
		const r = await find("focus_nodes")!.execute!("_c2", { node_ids: ["a", "b"] }, undefined, {
			sessionId: "s1",
		} as never);
		assert.deepEqual(r.details, { ok: true, canvasCommands: [{ type: "focus_nodes", nodeIds: ["a", "b"] }] });
	});

	it("undo / redo 无参数，返回裸命令", async () => {
		const { find } = setup();
		assert.deepEqual((await find("undo")!.execute!("_c3", {}, undefined, {} as never)).details, {
			ok: true,
			canvasCommands: [{ type: "undo" }],
		});
		assert.deepEqual((await find("redo")!.execute!("_c4", {}, undefined, {} as never)).details, {
			ok: true,
			canvasCommands: [{ type: "redo" }],
		});
	});

	it("open_image_editor 返回 nodeId", async () => {
		const { find } = setup();
		const r = await find("open_image_editor")!.execute!("_c5", { node_id: "img-9" }, undefined, {
			sessionId: "s1",
		} as never);
		assert.deepEqual(r.details, { ok: true, canvasCommands: [{ type: "open_image_editor", nodeId: "img-9" }] });
	});

	it("每次调用计 pi_runtime_tool_calls_total（本地工具不走 NestClient，须自计）", async () => {
		const { find, metrics } = setup();
		await find("focus_node")!.execute!("_c6", { node_id: "n1" }, undefined, { sessionId: "s1" } as never);
		const rendered = metrics.render(0, "test");
		assert.match(rendered, /pi_runtime_tool_calls_total\{tool="focus_node",result="ok"\} 1/);
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd services/pi-runtime && npm test 2>&1 | grep -A2 "ui-command"`
Expected: FAIL（Cannot find module './ui-command.js'）

- [ ] **Step 3: 实现** — `types.ts` 的 ToolTier 联合加一行 `"ui_command"`（放在 `"destructive"` 之后），并在类型注释补一句「ui_command = 本地 UI 命令（canvas_command 通道），不走 Nest」。新建 `ui-command.ts`：

```ts
/**
 * UI_COMMAND×5 本地工具（P1 批次）：不落数据、不走 Nest，返回 canvasCommands，
 * 由 Nest pi-events.extractCanvasCommands 派生 canvas_command SSE 事件，
 * 前端 AgentSideRail.vue canvas_command 分支消费。
 * 输出契约对齐老链路 definitions.py:472-489（camelCase，前端免转换）。
 */
import { Type } from "typebox";
import type { LnkpiTool } from "./types.js";
import type { Metrics } from "../metrics.js";

export interface CanvasCommand {
	type: string;
	nodeId?: string;
	nodeIds?: string[];
}

function uiResult(commands: CanvasCommand[]): {
	content: [{ type: "text"; text: string }];
	details: { ok: true; canvasCommands: CanvasCommand[] };
} {
	return {
		content: [{ type: "text", text: JSON.stringify({ ok: true, canvasCommands: commands }) }],
		details: { ok: true, canvasCommands: commands },
	};
}

export function createUiCommandTools(metrics: Metrics): LnkpiTool[] {
	const tier = { tier: "ui_command" as const };
	const tools: LnkpiTool[] = [
		{
			...tier,
			name: "focus_node",
			label: "定位到节点",
			description: "Pan/zoom the canvas viewport to a node (UI command)",
			parameters: Type.Object({ node_id: Type.String({ description: "Canvas node id" }) }),
			execute: async (_id, p: { node_id: string }) => {
				metrics.observeToolCall("focus_node", "ok");
				return uiResult([{ type: "focus_node", nodeId: p.node_id }]);
			},
		},
		{
			...tier,
			name: "focus_nodes",
			label: "定位到多个节点",
			description: "Pan/zoom the canvas viewport to multiple nodes (UI command)",
			parameters: Type.Object({ node_ids: Type.Array(Type.String(), { description: "Canvas node ids" }) }),
			execute: async (_id, p: { node_ids: string[] }) => {
				metrics.observeToolCall("focus_nodes", "ok");
				return uiResult([{ type: "focus_nodes", nodeIds: p.node_ids }]);
			},
		},
		{
			...tier,
			name: "undo",
			label: "撤销上次画布编辑",
			description: "Undo the last local canvas edit (client undo stack)",
			parameters: Type.Object({}),
			execute: async () => {
				metrics.observeToolCall("undo", "ok");
				return uiResult([{ type: "undo" }]);
			},
		},
		{
			...tier,
			name: "redo",
			label: "重做画布编辑",
			description: "Redo the last undone canvas edit (client undo stack)",
			parameters: Type.Object({}),
			execute: async () => {
				metrics.observeToolCall("redo", "ok");
				return uiResult([{ type: "redo" }]);
			},
		},
		{
			...tier,
			name: "open_image_editor",
			label: "打开图片精修",
			description: "Open the image refine editor for a node (UI command)",
			parameters: Type.Object({ node_id: Type.String({ description: "Image node id" }) }),
			execute: async (_id, p: { node_id: string }) => {
				metrics.observeToolCall("open_image_editor", "ok");
				return uiResult([{ type: "open_image_editor", nodeId: p.node_id }]);
			},
		},
	];
	return tools;
}
```

`registry.ts` 追加：

```ts
import { createUiCommandTools } from "./ui-command.js";
import type { Metrics } from "../metrics.js";

/** UI_COMMAND 批次：5 个本地 UI 命令工具（不依赖 NestClient）。 */
export function buildUiCommandTools(metrics: Metrics): LnkpiTool[] {
	return createUiCommandTools(metrics);
}
```

`config.ts:31` 的 return 改为：

```ts
	return [...buildCanvasReadTools(client), ...buildCanvasWriteTools(client), ...buildUiCommandTools(metrics)];
```

（import 行同步加 `buildUiCommandTools`。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd services/pi-runtime && npm test`
Expected: 全部 PASS（含既有 33 个）

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/tools/ui-command.ts services/pi-runtime/src/tools/ui-command.test.ts services/pi-runtime/src/tools/types.ts services/pi-runtime/src/tools/registry.ts services/pi-runtime/src/tools/config.ts
git commit -m "feat(pi-runtime): register 5 local UI command tools (ui_command tier)"
```

### Task 2: packages/agent — AgentStreamEvent 联合类型加 canvas_command

**Files:**
- Modify: `packages/agent/src/types.ts:45-68`

**Interfaces:**
- Produces: `AgentStreamEvent.type` 联合新增 `'canvas_command'`（packages/agent 对外导出，agent.service 直接用）

- [ ] **Step 1: 修改类型** — types.ts 联合中 `'canvas_action'` 之后加一行 `| 'canvas_command'`，注释：`// UI 命令（focus/undo/redo/open_image_editor），AgentSideRail canvas_command 分支消费`

- [ ] **Step 2: 构建确认** — Run: `cd packages/agent && pnpm build`（或仓库统一的 build 命令），Expected: 无类型错误

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/types.ts
git commit -m "feat(agent): add canvas_command to AgentStreamEvent union"
```

### Task 3: Nest pi-events — extractCanvasCommands 纯函数 + 测试

**Files:**
- Modify: `apps/server/src/agent/pi-runtime/pi-events.ts`（文件末尾追加）
- Create: `apps/server/src/agent/pi-runtime/pi-events.test.ts`（当前不存在）

**Interfaces:**
- Produces: `extractCanvasCommands(event: PiRuntimeEvent): PiCanvasCommand[]`；`interface PiCanvasCommand { type: string; nodeId?: string; nodeIds?: string[] }`

- [ ] **Step 1: 写失败测试**（vitest，对齐同目录 sidebar-block.test.ts 风格）

```ts
import { describe, expect, it } from "vitest";
import { extractCanvasCommands, mapPiEventToUiEvent, type PiRuntimeEvent } from "./pi-events";

const toolEnd = (result: unknown, isError = false): PiRuntimeEvent =>
	({
		type: "tool_execution_end",
		ts: Date.now(),
		data: { toolCallId: "c1", toolName: "focus_node", result, isError },
	}) as never;

describe("extractCanvasCommands（UI_COMMAND → canvas_command 派生）", () => {
	it("从 result.details.canvasCommands 提取命令", () => {
		const cmds = extractCanvasCommands(
			toolEnd({ content: [{ type: "text", text: "{}" }], details: { ok: true, canvasCommands: [{ type: "focus_node", nodeId: "n1" }] } }),
		);
		expect(cmds).toEqual([{ type: "focus_node", nodeId: "n1" }]);
	});

	it("isError 事件不派生", () => {
		expect(extractCanvasCommands(toolEnd({ details: { ok: false, canvasCommands: [{ type: "undo" }] } }, true))).toEqual([]);
	});

	it("非 UI_COMMAND 工具（details 无 canvasCommands）返回空", () => {
		expect(extractCanvasCommands(toolEnd({ content: [], details: { ok: true, data: { nodeId: "x" } } }))).toEqual([]);
	});

	it("canvasCommands 非数组或缺 type 字段的条目被过滤", () => {
		const cmds = extractCanvasCommands(
			toolEnd({ details: { ok: true, canvasCommands: [{ type: "undo" }, "junk", { nope: 1 }, null] } }),
		);
		expect(cmds).toEqual([{ type: "undo" }]);
	});

	it("非 tool_execution_end 事件返回空", () => {
		expect(extractCanvasCommands({ type: "agent_end", ts: 1, data: {} } as never)).toEqual([]);
	});

	it("既有映射不受影响：tool_execution_end 仍产出 tool_result", () => {
		const ui = mapPiEventToUiEvent(toolEnd({ content: [], details: { ok: true, canvasCommands: [{ type: "undo" }] } }));
		expect(ui?.type).toBe("tool_result");
	});
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `cd apps/server && npx vitest run src/agent/pi-runtime/pi-events.test.ts`，Expected: FAIL（extractCanvasCommands 未导出）

- [ ] **Step 3: 实现** — pi-events.ts 末尾追加：

```ts
/** UI_COMMAND 工具 details 中的画布命令（形态对齐前端 AgentSideRail canvas_command 分支）。 */
export interface PiCanvasCommand {
	type: string;
	nodeId?: string;
	nodeIds?: string[];
}

/**
 * UI_COMMAND 批次：从 tool_execution_end 的 result.details.canvasCommands
 * 提取 UI 命令（派生 canvas_command 事件，同名同形态于老链路 runs.py:1220）。
 * ⚠️ 事件名是 canvas_command 不是 canvas_action——后者走 CanvasActionSchema，
 * 只认 add_node 等 6 种画布数据动作，focus/undo 会被前端静默丢弃。
 * 仅本地 UI_COMMAND 工具的 details 含 canvasCommands 键；Nest 转发工具的
 * details 是 {ok,data} 形态，天然不命中，无需按工具名白名单。
 */
export function extractCanvasCommands(event: PiRuntimeEvent): PiCanvasCommand[] {
	if (event.type !== "tool_execution_end") return [];
	const d = event.data as {
		isError?: boolean;
		result?: { details?: { canvasCommands?: unknown } };
	};
	if (d.isError) return [];
	const cmds = d.result?.details?.canvasCommands;
	if (!Array.isArray(cmds)) return [];
	return cmds.filter(
		(c): c is PiCanvasCommand =>
			!!c && typeof c === "object" && typeof (c as { type?: unknown }).type === "string",
	);
}
```

- [ ] **Step 4: 跑测试确认通过** — 同 Step 2 命令，Expected: 6 个用例全 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/pi-runtime/pi-events.ts apps/server/src/agent/pi-runtime/pi-events.test.ts
git commit -m "feat(server): extract canvasCommands from pi tool results (canvas_command channel)"
```

### Task 4: agent.service — streamFromPiRuntime 派生并 yield canvas_command

**Files:**
- Modify: `apps/server/src/agent/agent.service.ts:682-689`（streamFromPiRuntime 主循环）

**Interfaces:**
- Consumes: `extractCanvasCommands`（Task 3）
- Produces: SSE 事件流中出现 `{type:'canvas_command', data:{type,nodeId?,nodeIds?}}`；canvasActions 累积不受影响

- [ ] **Step 1: 修改主循环** — import 行加 `extractCanvasCommands`（来自 `./pi-runtime/pi-events`），`const ui = mapPiEventToUiEvent(event)` 之前插入：

```ts
        if (event.type === 'tool_execution_end') {
          for (const cmd of extractCanvasCommands(event)) {
            yield { type: 'canvas_command', data: cmd }
          }
        }
```

（`yield` 后再走原有 `if (!ui) continue` / text_delta / canvas_action 逻辑；**不得**把 cmd push 进 canvasActions。）

- [ ] **Step 2: 类型检查** — Run: `cd apps/server && npx tsc --noEmit`，Expected: 0 error
- [ ] **Step 3: 全量测试** — Run: `cd apps/server && npx vitest run`，Expected: 全 PASS（253+）
- [ ] **Step 4: Commit**

```bash
git add apps/server/src/agent/agent.service.ts
git commit -m "feat(server): derive canvas_command SSE events from pi UI command tools"
```

### Task 5: 设计文档勘误 + PR

**Files:**
- Modify: `docs/superpowers/plans/2026-09-24-ui-command-canvas-action-design.md`

- [ ] **Step 1: 勘误** — 文档 §2.3 与 §3 中所有 `canvas_action`（指 UI 命令事件处）改为 `canvas_command`，并在文档头部加一行：`> ⚠️ 勘误（2026-09-24 实现前代码核对）：事件名应为 canvas_command（AgentSideRail.vue:1968 消费），原稿误写 canvas_action（该通道只认 CanvasActionSchema 6 种画布数据动作）；undo/redo 前端行为与老链路对齐已验证（handleAgentActions 不进 undo 栈，两侧一致）。`
- [ ] **Step 2: 双侧全量测试** — `cd services/pi-runtime && npm test && cd ../../apps/server && npx vitest run && npx tsc --noEmit`
- [ ] **Step 3: 推分支开 PR**（worktree 流程）— `p1/ui-command-tools` → master，PR 描述含本计划链接与 3 处勘误；CI 过后合并（github 代理间歇故障：push 失败重试并用 ls-remote 确认）

### Task 6: 部署 + 生产 e2e 验收

- [ ] **Step 1: 构建部署 pi-runtime 0.0.7**（RUNBOOK-pi-runtime-deploy.md 命令流）：显式 `--set image.tag=0.0.7` + `env.PI_RUNTIME_VERSION=0.0.7`；healthz.version=0.0.7 双确认
- [ ] **Step 2: API 发布门** — merge 后 master 触发 deploy.yml（或 dispatch），等 7-13 min；验收三件套：镜像 tag=merge sha 且 healthy / `PI_RUNTIME_MODE=active` / thread-verify PASS=16 FAIL=0
- [ ] **Step 3: 公网 e2e** — 复用 B-2 e2e 脚本模式：登录 → 建会话 → 先 upsert_prompt_node 造一个节点 → 再发「定位/聚焦到该节点」类 prompt → 断言 SSE 事件流含 `canvas_command`（type=focus_node 且 nodeId=该节点）且 trace 有对应条目
- [ ] **Step 4: metrics 验收** — CVM 上 `curl -s localhost:30100/metrics | grep focus_node`，Expected: `pi_runtime_tool_calls_total{tool="focus_node",result="ok"} ≥ 1`
- [ ] **Step 5: 记忆收尾** — daily log 追加批次结果；MEMORY.md P1 状态更新（UI_COMMAND 完成）
