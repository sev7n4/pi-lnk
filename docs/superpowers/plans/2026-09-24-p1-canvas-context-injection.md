# P1-#12 · 画布上下文注入 + system prompt 动态化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

状态：待执行（2026-09-24 定稿）
前置：`2026-09-23-p1-prompt-context-audit.md`（§4 最小注入集）、`2026-09-23-p1-tool-registry-skeleton.md`（#11，已上线 `pi-runtime:0.0.4`）、`docs/ops/RUNBOOK-pi-runtime-deploy.md`（部署命令流）
分支约定：worktree 分支 `p1/canvas-context`（using-git-worktrees），PR → master；TDD，RED 门用 `tsc --noEmit`（#11 Ruling：`import type` 运行时擦除导致 node:test 空过）。

## 0. 配图索引

本文档不含图（理由：链路是「Nest 每轮组装一条 systemPrompt 字符串 → createSession 传入」的线性流水，一张表即可表达，不满足 SPEC-CONVENTIONS §1 画图判据）。

**Goal:** pi-runtime 会话获得与老链路语义 1:1 的动态 system prompt（静态规则 + 画布摘要 + 侧栏块 + 近期对话摘要），并把 userId/画布上下文字段从 Nest 透传到 pi 工具上下文，为 B-2 写工具铺路。

**Architecture:** Nest 每轮在 `streamAgent` 内组装完整 systemPrompt（`PiPromptAssembler`），经 `PiRuntimeClient.createSession` 传入。利用 B4 现有的「每轮 prompt → deleteSession → 下轮重建」节奏（`agent.service.ts` `streamFromPiRuntime` finally 块），createSession 每轮携带新鲜摘要，语义对齐老链路 explore 节点「每轮重新拉取」。画布上下文字段（attachments/mentionedKeys/refOrder/focusNodeId）同时进 pi 会话 `toolContext`，供 B-2 工具读取。

**Tech Stack:** NestJS 10 + vitest（apps/server）；pi-runtime（fastify + @earendil-works/pi-agent-core 0.85.1 + node:test）。

**Spec:** `2026-09-23-p1-prompt-context-audit.md` §2/§4；本计划 §「与审计的偏离」记录两处有意偏离及理由。

## Global Constraints

- 不得改动老链路（LangGraph /v1/runs 路径）任何行为；B4 分流代码不动。
- pi-runtime 改动全部在 `services/pi-runtime/**`，Nest 改动全部在 `apps/server/src/agent/**`（新文件放 `apps/server/src/agent/pi-runtime/`）。
- 静态规则文本**逐字平移** `explore.py`（§1 表），仅允许本计划明示的两处偏离（规则分组、新增第 10 条守卫）。
- 每轮 createSession 必须带全量 systemPrompt（不是增量 patch）——pi 会话按轮重建，无增量通道。
- NEST_BASE_URL 带 `/api` 前缀的约定不变（已固化到 chart values 注释）。
- 提交前：pi-runtime 侧 `node --import tsx --test` + `tsc --noEmit`；Nest 侧 `pnpm --filter @lnkpi/server test`；文档改动跑 `pnpm verify-spec-figures --file <doc>`。

## 与审计 §4 的偏离（有意，写明理由）

1. **静态规则分组而非 9 条全量平移**：审计写作「静态 9 条从 explore.py 平移」，但当时未考虑工具分批迁移的现实——pi 当前只注册 7 个 read 工具（#11），规则 4/5/6/8/9 指引模型调用 `upsert_media_node`/`propose_generation`/`tool_search`/`connect_nodes` 等未注册工具，harness 将报 unknown tool，体验劣于纯文本。处理：规则拆为 `core`（1/2/3/7 + 新增第 10 条「写操作未开放」守卫）与 `writeTools`（4/5/6/8/9 原文保留），#12 只注入 core；B-2 起随工具注册逐组启用（assembler 按 `ruleGroups` 参数拼装，启用=加一个组名）。规则 3（禁 run_*）与新增第 10 条合计保证「不出图承诺」语义仍完整。
2. **近期摘要暂无工具名行**：老链路 `compress_recent_turns` 的「助手工具: …」行来自 LangGraph checkpoint 的 tool_calls；pi 路径 Nest 侧暂无工具调用持久化（canvas_action 持久化是 Round 5）。#12 平移 user/assistant 行为 + 120 字截断语义，工具行留待 canvas_action 落库后补（B-2 批次一起）。

## Review Focus

- **空画布/画布获取失败**：getCanvasSummary 抛错或 nodes 为空时，systemPrompt 必须仍然成立（摘要块省略而非整条 prompt 失败）——Task 6 测试。
- **attachments 为空/超限**：无侧栏素材时不产出「侧栏参考素材：」空块；>5 条由 Nest 现有 `validateSidebarAttachments` 拦截，assembler 不再校验——Task 5/7 测试。
- **prompt 超长**：画布节点很多时 summary JSON 可能巨大，assembler 必须按「节点列表 JSON 原样」注入（与老链路一致），但 recent turns 与侧栏块受 160/120 截断——Task 4/6 测试（明确不截断 summary 是有意行为）。
- **shadow 镜像语义**：mirrorToPiRuntime 也必须带组装后的 prompt + userId，否则 shadow diff 全部失真——Task 7 测试。
- **每轮重建竞态**：createSession 409（复用）时 systemPrompt 不会更新——Task 7 保证 409 分支仅发生在「同轮重试」，跨轮必有 delete；如出现 409 且 prompt 不同，记 warn 日志——Task 7 测试。

---

### Task 1: pi-runtime deferred minors（version 统一 / metrics 标签 / SessionManager 注入缝）

**Files:**
- Modify: `services/pi-runtime/src/index.ts:35-43`（healthz）
- Modify: `services/pi-runtime/src/tools/nest-client.ts`（onCall 标签）
- Modify: `services/pi-runtime/src/session-manager.ts`（harnessFactory 注入缝）
- Test: `services/pi-runtime/src/session-manager.test.ts`（新建）

**Interfaces:**
- Consumes: `metrics.VERSION`（已有导出）
- Produces: `SessionManager` 构造第 4 参 `harnessFactory?: HarnessFactory`；`export type HarnessFactory = typeof AgentHarness.create`；onCall 标签统一 snake_case（`get-canvas-summary` → `get_canvas_summary`）

- [ ] **Step 1: 写失败测试**（`session-manager.test.ts`）

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "./session-manager.js";

describe("SessionManager harnessFactory 注入缝", () => {
	it("create() 把 tools/toolContext/systemPrompt 原样传给 harnessFactory", async () => {
		let captured: any = null;
		const fakeHarnessFactory = async (_cfg: any, _ctx: any) => {
			captured = _cfg;
			return { harness: { events: { on: () => () => {} }, lane: async () => ({ prompt: async () => ({ ok: true }) }), close: async () => {} } } as any;
		};
		const sm = new SessionManager(
			[{ name: "t_probe" } as any],
			"",
			undefined,
			fakeHarnessFactory,
		);
		await sm.create("s1", { userId: "u1", systemPrompt: "SYS" });
		assert.equal(captured.systemPrompt, "SYS");
		assert.equal((captured.toolContext as any).userId, "u1");
		assert.equal((captured.toolContext as any).sessionId, "s1");
	});
});
```

- [ ] **Step 2: RED 确认**：`cd services/pi-runtime && node --import tsx --test src/session-manager.test.ts`（期望 FAIL：SessionManager 只有 3 参）+ `tsc --noEmit`（期望 FAIL）
- [ ] **Step 3: 实现**——`session-manager.ts` 构造器加第 4 参：

```ts
export type HarnessFactory = typeof AgentHarness.create;
constructor(
	private readonly tools: AgentHarnessTool<LnkpiToolContext>[] = [],
	private readonly systemPromptDefault = process.env.PI_RUNTIME_SYSTEM_PROMPT ?? "",
	private readonly modelFactory: typeof assembleModel = assembleModel,
	private readonly harnessFactory: HarnessFactory = AgentHarness.create,
) {}
```

`create()` 内 `AgentHarness.create<LnkpiToolContext>(…)` 改为 `this.harnessFactory(…)`（泛型收窄：工厂调用处 `as unknown as Promise<{harness}>` 由 HarnessFactory 类型承担）。同 commit 顺手把 `assembleModel` 也做成第 3 参注入（测试已不需要真实凭据）。`index.ts:39` `version: "0.0.1"` 改 `version: VERSION`（import 自 `./metrics.js`）。`nest-client.ts` `onCall` 调用处（`this.opts.onCall?.(pathTail(path), …)`）标签改为 `pathTail(path).replace(/-/g, "_")`。
- [ ] **Step 4: GREEN**：`node --import tsx --test src/**/*.test.ts` 19+ 全绿，`tsc --noEmit` 过
- [ ] **Step 5: Commit** `refactor(pi-runtime): version unify + snake metrics label + harnessFactory seam`

### Task 2: pi-runtime 画布上下文字段 → toolContext

**Files:**
- Modify: `services/pi-runtime/src/tools/types.ts`（LnkpiToolContext 扩展）
- Modify: `services/pi-runtime/src/session-manager.ts:100-123`（create opts）
- Modify: `services/pi-runtime/src/index.ts:54-72`（/sessions body）
- Test: `services/pi-runtime/src/tools/types.test.ts`、`session-manager.test.ts`

**Interfaces:**
- Produces: `LnkpiToolContext` 新增可选字段 `attachments?: SidebarAttachment[]; mentionedKeys?: string[]; refOrder?: string[]; focusNodeId?: string`，其中

```ts
export interface SidebarAttachment { url?: string; text?: string; mediaType?: string }
```

`/sessions` body 新增同名可选字段，原样透传 create → toolContext（无清洗：Nest 侧已 validate）。

- [ ] **Step 1: 失败测试**——types.test.ts 加：

```ts
it("LnkpiToolContext 接受画布上下文字段", () => {
	const ctx: LnkpiToolContext = {
		sessionId: "s",
		attachments: [{ url: "https://x/a.png", mediaType: "image" }],
		mentionedKeys: ["I1"],
		refOrder: ["I1"],
		focusNodeId: "node-1",
	};
	assert.equal(ctx.mentionedKeys?.[0], "I1");
});
```

session-manager.test.ts 的 captured.toolContext 断言追加 `attachments/mentionedKeys/refOrder/focusNodeId` 透传。index.ts 的 /sessions 透传属路由层，由 Task 8 生产冒烟覆盖（node:test 不起 fastify 实例——已有测试同口径）。
- [ ] **Step 2: RED**：`tsc --noEmit` FAIL（字段不存在）
- [ ] **Step 3: 实现**：types.ts 加字段与 `SidebarAttachment`；`create()` opts 与 toolContext 透传；index.ts body 类型加 4 字段并传入 `manager.create`。
- [ ] **Step 4: GREEN**：全测绿 + tsc 过
- [ ] **Step 5: Commit** `feat(pi-runtime): canvas context fields plumbed into per-session toolContext`

### Task 3: Nest PiRuntimeClient.createSession 参数对象化

**Files:**
- Modify: `apps/server/src/agent/pi-runtime/pi-runtime.client.ts`（createSession）
- Test: `apps/server/src/agent/pi-runtime/pi-runtime.client.test.ts`

**Interfaces:**
- Produces:

```ts
export interface CreateSessionOptions {
	systemPrompt?: string;
	userId?: string;
	attachments?: Array<{ url?: string; text?: string; mediaType?: string }>;
	mentionedKeys?: string[];
	refOrder?: string[];
	focusNodeId?: string;
}
async createSession(sessionId: string, opts: CreateSessionOptions = {}): Promise<CreateSessionResult>
```

- [ ] **Step 1: 失败测试**（仿现有 fetch mock 风格）：

```ts
it("createSession 以 opts 对象透传 systemPrompt/userId/画布上下文", async () => {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const client = new PiRuntimeClient({
		baseUrl: "http://x",
		fetchImpl: (async (url: string, init?: RequestInit) => {
			calls.push({ url, init: init as RequestInit });
			return new Response(JSON.stringify({ sessionId: "s1", provider: "agnes", model: "m" }), { status: 201 });
		}) as typeof fetch,
	});
	await client.createSession("s1", { systemPrompt: "SYS", userId: "u1", mentionedKeys: ["I1"] });
	const body = JSON.parse(String(calls[0].init.body));
	assert.equal(body.systemPrompt, "SYS");
	assert.equal(body.userId, "u1");
	assert.deepEqual(body.mentionedKeys, ["I1"]);
});
```

- [ ] **Step 2: RED**：`pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/pi-runtime.client.test.ts` FAIL（签名不匹配）
- [ ] **Step 3: 实现**：按 Produces 签名改写 createSession，body JSON 展开全部字段。全局搜旧签名调用点（`ensurePiSession`、测试文件）同步改（ensurePiSession 的改造在 Task 7，此处只保证编译：调用点临时传 `undefined` 不行——直接把 ensurePiSession 调用改为 `createSession(sessionId)`，opts 省略合法）。
- [ ] **Step 4: GREEN**：client 测试绿 + `pnpm --filter @lnkpi/server test` 无回归
- [ ] **Step 5: Commit** `feat(server): PiRuntimeClient.createSession accepts full session options`

### Task 4: Nest 近期对话压缩器 compressRecentTurns

**Files:**
- Create: `apps/server/src/agent/pi-runtime/compress-recent-turns.ts`
- Test: `apps/server/src/agent/pi-runtime/compress-recent-turns.test.ts`

**Interfaces:**
- Produces:

```ts
export interface TurnMessage { role: "user" | "assistant" | "tool"; content: string; toolNames?: string[] }
export function compressRecentTurns(messages: TurnMessage[], maxTurns = 4): string
```

语义 1:1 平移 `app/graph/recent_turns.py:58-106`：按 user 消息切轮（无前导 user 的首组也成轮）、取末 maxTurns 轮、`用户: 全文`、`助手工具: name1, name2`（有 toolNames 时）、`助手: ≤160 字（159+…）`、`工具结果: ≤120 字（119+…）`、空行跳过、`\n` join。

- [ ] **Step 1: 失败测试**：

```ts
it("按 user 切轮取末 4 轮，助手 160 / 工具结果 120 截断", () => {
	const long = "x".repeat(200);
	const out = compressRecentTurns([
		{ role: "user", content: "u1" },
		{ role: "assistant", content: long, toolNames: ["get_canvas_summary"] },
		{ role: "tool", content: long },
		{ role: "user", content: "u2" },
		{ role: "assistant", content: "a2" },
	]);
	const lines = out.split("\n");
	assert.equal(lines[0], "用户: u1");
	assert.equal(lines[1], "助手工具: get_canvas_summary");
	assert.equal(lines[2], "助手: " + "x".repeat(159) + "…");
	assert.equal(lines[3], "工具结果: " + "x".repeat(119) + "…");
	assert.equal(lines[4], "用户: u2");
	assert.equal(lines[5], "助手: a2");
});
it("空输入返回空串；maxTurns=0 返回空串", () => {
	assert.equal(compressRecentTurns([], 4), "");
	assert.equal(compressRecentTurns([{ role: "user", content: "u" }], 0), "");
});
it("前导 assistant 消息自成首轮（对齐 py 语义）", () => {
	const out = compressRecentTurns([
		{ role: "assistant", content: "hi" },
		{ role: "user", content: "u" },
	]);
	assert.equal(out.split("\n")[0], "助手: hi");
});
```

- [ ] **Step 2: RED**：vitest run 该文件 FAIL（模块不存在）
- [ ] **Step 3: 实现**（纯函数，逐条对照 py 源）：

```ts
const snippet = (s: string, limit: number) => (s.length > limit ? s.slice(0, limit - 1) + "…" : s);

export function compressRecentTurns(messages: TurnMessage[], maxTurns = 4): string {
	if (!messages.length || maxTurns <= 0) return "";
	const turns: TurnMessage[][] = [];
	let current: TurnMessage[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			if (current.length) turns.push(current);
			current = [msg];
		} else {
			if (!current.length) current = [msg];
			else current.push(msg);
		}
	}
	if (current.length) turns.push(current);
	const lines: string[] = [];
	for (const turn of turns.slice(-maxTurns)) {
		for (const msg of turn) {
			const content = (msg.content ?? "").trim();
			if (msg.role === "user") { if (content) lines.push(`用户: ${content}`); continue; }
			if (msg.role === "assistant") {
				const names = (msg.toolNames ?? []).filter(Boolean);
				if (names.length) lines.push(`助手工具: ${names.join(", ")}`);
				if (content) lines.push(`助手: ${snippet(content, 160)}`);
				continue;
			}
			if (content) lines.push(`工具结果: ${snippet(content, 120)}`);
		}
	}
	return lines.join("\n");
}
```

- [ ] **Step 4: GREEN** → **Step 5: Commit** `feat(server): compressRecentTurns port (recent_turns.py semantics)`

### Task 5: Nest 侧栏 key 分配与参考素材块

**Files:**
- Create: `apps/server/src/agent/pi-runtime/sidebar-block.ts`
- Test: `apps/server/src/agent/pi-runtime/sidebar-block.test.ts`

**Interfaces:**
- Produces:

```ts
export function assignSidebarRefKeys(attachments: Array<{ mediaType?: string }>): string[]
export function buildSidebarBlock(attachments: Array<{ url?: string; text?: string; mediaType?: string }>): string
```

`assignSidebarRefKeys` 平移 `sidebar_attachments.py:29-43`（按 mediaType 计数 T1/I1/V1/A1，未知 mediaType 跳过）。`buildSidebarBlock`：无 attachments 返回 `""`；有则返回

```
侧栏参考素材：
I1=<text 或 URL 末段>
```

（label 取 `text` 非空用 text，否则取 url 去掉 query 后的最后一段路径；blob: URL 由上游校验拦截，此处不处理。）

- [ ] **Step 1: 失败测试**：

```ts
it("key 按 mediaType 分类计数，未知类型跳过", () => {
	assert.deepEqual(
		assignSidebarRefKeys([{ mediaType: "image" }, { mediaType: "text" }, { mediaType: "image" }, { mediaType: "" }]),
		["I1", "T1", "I2"],
	);
});
it("buildSidebarBlock：无素材返回空串；有素材逐行列出", () => {
	assert.equal(buildSidebarBlock([]), "");
	const block = buildSidebarBlock([
		{ url: "https://cdn.x/a/b.png?sign=1", mediaType: "image" },
		{ text: "产品文案草稿", mediaType: "text" },
	]);
	assert.equal(block, "侧栏参考素材：\nI1=b.png\nT1=产品文案草稿");
});
```

- [ ] **Step 2: RED** → **Step 3: 实现** → **Step 4: GREEN** → **Step 5: Commit** `feat(server): sidebar ref keys + sidebar prompt block`

### Task 6: Nest PiPromptAssembler（规则分组 + 画布摘要 + 块拼装）

**Files:**
- Create: `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.ts`
- Test: `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.test.ts`

**Interfaces:**
- Consumes: Task 4/5 两个 util；`AgentCanvasToolsService.getCanvasSummary({ sessionId })`（`agent-canvas-tools.service.ts:444`，返回 `{ nodes: Array<{id,type,title,status}> }`）
- Produces:

```ts
export type RuleGroup = "core" | "writeTools";
@Injectable()
export class PiPromptAssembler {
	constructor(private readonly canvasTools: AgentCanvasToolsService) {}
	async assemble(input: {
		sessionId: string;
		attachments?: Array<{ url?: string; text?: string; mediaType?: string }>;
		mentionedKeys?: string[];
		priorMessages?: TurnMessage[];
		ruleGroups?: RuleGroup[];   // 默认 ["core"]
		maxTurns?: number;          // 默认 4
	}): Promise<string>
}
```

拼装顺序（块间 `\n` 分隔）：`CORE_RULES` → `"\n当前画布摘要：\n" + JSON.stringify(summary)` → `buildSidebarBlock` → `"近期对话摘要：\n" + compressRecentTurns(priorMessages)`。

- [ ] **Step 1: 失败测试**（canvasTools 用 `{ getCanvasSummary: async () => ({ nodes: [...] }) }` as any 注入）：

```ts
const CORE_PREFIX = "你是 lnkpi 无限画布助手。用简洁中文回答。";

it("默认注入 core 组 + 摘要 JSON + 近期摘要", async () => {
	const asm = makeAssembler({ nodes: [{ id: "n1", type: "image", title: "T", status: "ready" }] });
	const prompt = await asm.assemble({
		sessionId: "s1",
		priorMessages: [{ role: "user", content: "u1" }],
	});
	assert.ok(prompt.startsWith(CORE_PREFIX));
	assert.ok(prompt.includes("当前画布摘要："));
	assert.ok(prompt.includes('"id":"n1"'));
	assert.ok(prompt.includes("近期对话摘要：\n用户: u1"));
	assert.ok(!prompt.includes("instantiate_workflow_template")); // writeTools 组未启用
});
it("getCanvasSummary 抛错：摘要块省略、prompt 仍完整返回", async () => {
	const asm = makeAssemblerThrows(new Error("session missing"));
	const prompt = await asm.assemble({ sessionId: "s1" });
	assert.ok(prompt.startsWith(CORE_PREFIX));
	assert.ok(!prompt.includes("当前画布摘要："));
});
it("ruleGroups 含 writeTools 时 4/5 条规则原文出现", async () => {
	const asm = makeAssembler({ nodes: [] });
	const prompt = await asm.assemble({ sessionId: "s1", ruleGroups: ["core", "writeTools"] });
	assert.ok(prompt.includes("upsert_media_node"));
	assert.ok(prompt.includes("instantiate_workflow_template"));
});
it("侧栏块 + 第 10 条守卫始终存在", async () => {
	const asm = makeAssembler({ nodes: [] });
	const prompt = await asm.assemble({
		sessionId: "s1",
		attachments: [{ url: "https://x/a.png", mediaType: "image" }],
	});
	assert.ok(prompt.includes("侧栏参考素材：\nI1=a.png"));
	assert.ok(prompt.includes("写操作尚未开放"));
});
```

- [ ] **Step 2: RED** → **Step 3: 实现**——规则文本逐字取自 `explore.py:87-132`（本计划的偏离 §「与审计的偏离」已声明）：

```ts
const CORE_RULES = `你是 lnkpi 无限画布助手。用简洁中文回答。
规则：
1. 必须通过工具完成读写操作，禁止假装已执行。
2. 平台支持在画布上生成图片/视频等媒体；不得否认平台的图片生成能力，也不要引导用户使用第三方作图工具。
3. 不要声称「正在生成」「马上生成」「已开始出图」；禁止调用任何 run_*。真正出图/出视频须等用户在 UI 确认后由系统执行。
7. 若已提供【侧栏参考图解析】，不得声称只能看到文件名或画布节点标题。@I1/@I2 是侧栏芯片 key，不是画布节点 id。禁止问「I1 对应画布哪张图」；禁止把芯片映射到已有画布节点（除非用户明确要求改该节点）。侧栏图≥3 且未 @、或只有旧图且未 @：先问用哪几张或请 @I1，不要对闲聊新建节点。
10. 当前会话仅开放只读查询工具（画布摘要/节点/生成状态/素材列表等）；创建、修改、连线、生成执行等写操作尚未开放——用户要求时如实说明，禁止虚构已执行。`;

const WRITE_TOOLS_RULES = `4. （B-2 启用时由 writeTools 组注入——内容为 explore.py 规则 4 原文，见 app/graph/nodes/explore.py:95-104）
…（5/6/8/9 同理，实施 B-2 时逐字拷贝）`;
```

⚠️ writeTools 组在 B-2 实施时才填正文，本 Task 只落 `WRITE_TOOLS_RULES` 占位常量并保证 `ruleGroups:["core","writeTools"]` 的拼装分支有测试——**占位常量必须含 `explore.py` 原文出处注释**，B-2 执行者按出处拷贝（本计划的占位是有意的，不是未完成事项）。摘要获取失败 catch 后 `Logger.warn` 并省略块。`assemble` 内 summary 永不截断（对齐老链路）。
- [ ] **Step 4: GREEN** → **Step 5: Commit** `feat(server): PiPromptAssembler with grouped explore rules + canvas blocks`

### Task 7: agent.service 接线（streamAgent → assembler → createSession）

**Files:**
- Modify: `apps/server/src/agent/agent.service.ts`（B4 区块：~160-260 的 streamAgent pi 分支、~426 ensurePiSession、~574 streamFromPiRuntime、~629 mirrorToPiRuntime）
- Test: `apps/server/src/agent/agent.service.pi-runtime.test.ts`

**Interfaces:**
- Consumes: Task 3 client、Task 6 assembler
- Produces:

```ts
interface PiCanvasContext {
	attachments?: Array<{ url?: string; text?: string; mediaType?: string }>;
	mentionedKeys?: string[];
	refOrder?: string[];
	focusNodeId?: string;
	priorMessages: Array<{ role: "user" | "assistant" | "tool"; content: string; toolNames?: string[] }>;
}
private async ensurePiSession(client: PiRuntimeClient, sessionId: string, opts?: { systemPrompt?: string; userId?: string } & PiCanvasContext): Promise<void>
```

- [ ] **Step 1: 失败测试**（沿用 agent.service.pi-runtime.test.ts 的 fake PiRuntimeClient 模式）：

```ts
it("active 路径：createSession 收到组装后的 systemPrompt + userId + 画布上下文", async () => {
	// fake assembler 返回 "PROMPT-<sessionId>"；fake client 记录 createSession 参数
	// 断言 createCreateArgs.systemPrompt === "PROMPT-s1"，userId === "u1"，mentionedKeys 透传
});
it("priorMessages 取自 AgentMessage 且排除本轮 user 消息", async () => {
	// prisma fake：thread 已有 3 条历史 + 本轮 user 消息在 create 之后写入
	// 断言 assembler.assemble 收到的 priorMessages 不含本轮内容
});
it("shadow 镜像同样携带 systemPrompt + userId", async () => {
	// mirrorToPiRuntime 路径：fake client 断言同上
});
it("createSession 409（复用）时 warn 日志但不失败", async () => {
	// fake client.createSession 抛 PiRuntimeError(409)；断言 ensurePiSession 吞掉且 prompt 继续
});
```

- [ ] **Step 2: RED** → **Step 3: 实现**：
  - `streamAgent`：在「persistedUserContent create」**之前**取 `priorMessages`（`this.prisma.agentMessage.findMany({ where: { threadId: effectiveThreadId }, orderBy: { createdAt: 'asc' }, take: 24, select: { role: true, content: true } })` 映射为 `TurnMessage[]`，role 只有 user/assistant）——保证本轮 user 消息不混入。
  - pi 分支构造 `piContext: PiCanvasContext = { attachments: validatedAttachments, mentionedKeys: validatedMentionedKeys, refOrder, focusNodeId, priorMessages }`，传给 `streamFromPiRuntime(piClient, sessionId, userMessage, userId, threadId, piContext)` 与 `mirrorToPiRuntime(piClient, `shadow-${sessionId}`, userMessage, userId, piContext)`。
  - `streamFromPiRuntime` / `mirrorToPiRuntime`：prompt 订阅前 `const systemPrompt = await this.createPiPromptAssembler().assemble({ sessionId, attachments, mentionedKeys, priorMessages })`（新增 overridable `createPiPromptAssembler(): PiPromptAssembler`，仿 `createPiRuntimeClient`）；`ensurePiSession(client, sessionId, { systemPrompt, userId, ...piContext })`。
  - `ensurePiSession`：409 分支加 `this.piLogger.warn(`pi session ${sessionId} reused (409) — systemPrompt not updated`)`。
- [ ] **Step 4: GREEN**：全量 `pnpm --filter @lnkpi/server test` + `pnpm build` 过
- [ ] **Step 5: Commit** `feat(server): assemble per-turn system prompt for pi-runtime sessions`

### Task 8: 部署 + 生产复测

**Files:** 无代码；按 `docs/ops/RUNBOOK-pi-runtime-deploy.md` 执行。

- [ ] **Step 1: PR**：分支 `p1/canvas-context` → master，CI 4/4 绿后 merge（同 #11 流程）。
- [ ] **Step 2: pi-runtime 部署**：镜像 `0.0.5`（runbook 命令流，**必须显式 `--set image.tag=0.0.5 --set env.PI_RUNTIME_VERSION=0.0.5`**）。
- [ ] **Step 3: API 部署**：apps/server 改动触发发布门——`POST /repos/sev7n4/pi-lnk/actions/workflows/deploy.yml/dispatches {ref:"master", inputs:{branch:"master"}}`（job 级 changes filter 命中 api 侧 → deploy-api 构建；lnkpi 禁直发约束检查 allow_api_deploy 输入口径，若 job 需要 manual dispatch + `allow_api_deploy:true` 则按 RUNBOOK-single-release-gate 执行），约 7-13 min。
- [ ] **Step 4: 验收**：
  - 验收四件套（runbook §验收四件套）：healthz / build_info=0.0.5 / `PI_RUNTIME_MODE=active` / thread-verify PASS=16 FAIL=0
  - **prompt 注入 e2e**：从 api 容器 prisma 取一个真实 `sessionId`（`docker exec lnkpi-api node -e "…prisma.session.findFirst…"` 或经 `canvasData` SQL），对 pi-runtime `POST /sessions {sessionId, userId}` → `prompt`「当前画布上有什么内容？」→ 验证回答引用了画布节点标题（不依赖工具调用）；同时 `/metrics` 出现 `tool_calls_total{tool="get_canvas_summary",result="ok"}`（摘要由 assembler 进程内拉取，不经 NestClient——此指标来自模型自主调用工具路径，若模型未调用工具则以文本回答为准，指标项为加分项）
  - **shadow diff**：`PI_RUNTIME_MODE` 切 shadow 10 分钟观察 `shadow-*` 日志 textLen>0 后切回 active（可选，若时间允许）
- [ ] **Step 5: 收尾**：worktree 清理、分支删除、memory/台账更新（progress.md Ruling 补记）。

## Self-Review 记录

- 覆盖检查：审计 §2 四字段（attachments/mentionedKeys/refOrder/focusNodeId）→ Task 2/7；§4 四件注入（规则/摘要/侧栏/近期）→ Task 6；userId 透传 → Task 3/7；deferred minors 三项 → Task 1；shadow 保真 → Task 7。✅
- 占位扫描：Task 6 `WRITE_TOOLS_RULES` 占位为**有意设计**（B-2 填充），已注明出处与理由，非计划缺陷。✅
- 类型一致性：`TurnMessage`（Task 4 定义，Task 6/7 引用）、`CreateSessionOptions`（Task 3 定义，Task 7 引用）、`PiCanvasContext`（Task 7 定义）签名已互相对齐。✅
- Review Focus 五项均有对应测试（Task 4/5/6/7）。✅
