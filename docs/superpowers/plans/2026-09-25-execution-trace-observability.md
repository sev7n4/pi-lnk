# 执行过程可观测性专项 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## §0 图形声明

本文档无任何示意图（无 SVG/Mermaid/图片），为纯文字实现计划。

**Goal:** 修复画布 agent 执行过程的四个可观测性缺陷：①工具步骤重复渲染、②工具入参不可见（load_skill 看不到 skill 名）、③模型思考流被丢弃、④skill 只能隐性触发无显性入口；并顺带补齐 pi 路径的执行事件持久化（刷新后执行过程消失）。

**Architecture:** 数据链路为 pi-runtime（harness 事件归一 SSE）→ Nest 桥接（pi-events.ts 映射 + agent.service.ts 流处理）→ 前端（4 处消费方 + executionTraceReducer + agent store）。本计划不碰 pi-agent-core vendor、不碰 before_tool Gate，只改事件映射与前端渲染。Nest 侧改动走 pi-lnk master 发布门自动部署；pi-runtime 侧改动走 runbook helm 部署。

**Tech Stack:** NestJS（apps/server）、Vue 3 + Pinia（apps/web）、fastify（services/pi-runtime）、vitest。

**Spec:** 对话结论（2026-09-25 侧栏实测复盘七问）+ `docs/superpowers/plans/2026-09-24-p1-roadmap-revision.md`；无独立 spec 文档，本计划即唯一设计依据。

## Global Constraints

- `vendor/earendil-works/pi/` 只读，禁止业务 patch；pi-agent-core tool execute 是 6 参签名，不得改动。
- `before_tool` HITL Gate（fail-closed）与 toolContext 安全模型（sessionId/userId 仅来自 Nest 注入）不得绕过。
- 前端 tool 事件消费方共 4 处：`AgentSideRail.vue`、`AgentPanel.vue`、`AgentFloatingWindow.vue`、`executionTraceReducer.ts`——凡改 tool_call/tool_result 事件处理必须 4 处同步，防止「调用 undefined」类回归。
- 老 LangGraph 路径（streamFromRuntime）行为不得回归：其 tool 事件可能无 toolCallId，所有新逻辑必须有降级分支。
- 本机执行环境：vitest/tsc 用 `./node_modules/.bin/vitest` 直启（npx 会卡代理）；长命令（>2min）必须 run_in_background；git push/gh 失败需多次重试。
- 提交信息用 conventional commits（feat/fix/test/chore），每 Task 独立提交；分支按 `using-git-worktrees` 创建。
- UI 文案用简体中文；中文字符串不得出现在代码引号转义有风险的场景。
- 测试框架统一 vitest；每个 Task 的测试命令必须在对应包目录下运行。

## Review Focus

1. **同名工具交错并发**（两个 upsert_media_node 同时 running）：必须按 toolCallId 闭合各自步骤，不得按 name 串步——Task 1 测试 A1 钉死。
2. **tool_result 先于 tool_call 到达**（SSE buffer 重放/乱序）：endToolCall 找不到对应条目时降级为追加完成态步骤，不崩不丢——Task 1 测试 A2 钉死。
3. **老链路事件无 toolCallId**（LangGraph tool_call/tool_result）：降级 name 匹配，行为与现状完全一致——Task 1 测试 A3 钉死。
4. **无思考流模型**（agnes-2.5-flash 可能不产 thinking 事件）：零 thinking 事件时 UI 不出现悬挂的「思考中…」步骤——Task 3 测试 A4 钉死。
5. **/skill 未知名或 skills 目录为空**：Nest 侧校验失败降级为普通消息发送，不 500、不空回复——Task 5 测试 A5 钉死；pi-runtime 侧未知名 fail-soft 兜底——Task 4 测试钉死。
6. **刷新后历史恢复**：pi 路径 executionEvents 持久化后，前端 replay 不崩溃、不产生重复步骤——Task 3（持久化）+ Task 1（reducer 幂等）共同覆盖。

---

### Task 1: 前端 toolCallId 贯穿去重（修「每个工具显示两遍」）

**Files:**
- Modify: `apps/web/src/stores/agent.ts:112-121`（addToolCall 区域）
- Modify: `apps/web/src/components/agent/executionTraceReducer.ts:29-46`（ExecutionStep.meta）、`:384-409`（applyToolCall）
- Modify: `apps/web/src/components/agent/AgentSideRail.vue:1932-1940`
- Modify: `apps/web/src/components/agent/AgentPanel.vue:110-118`
- Modify: `apps/web/src/components/agent/AgentFloatingWindow.vue:128-136`
- Test: `apps/web/src/components/agent/executionTraceReducer.test.ts`

**Interfaces:**
- Consumes: Nest 下发的 `tool_call`/`tool_result` 事件 data（pi-events.ts 已含 `toolCallId`、`name`、`args`/`result` 字段；老链路可能只有 `name`）。
- Produces: store 新方法 `beginToolCall(call: { toolCallId?: string; name: string; args?: unknown })`、`endToolCall(toolCallId: string | undefined, name: string, result?: unknown)`；`ExecutionStep.meta` 新增 `toolCallId?: string`；`applyToolCall(trace, name, result?, meta?: { toolCallId?: string; args?: string })` 第 4 参（可选，老调用点不变）。Task 2 依赖 beginToolCall 的 args 透传。

- [ ] **Step 1: 写失败测试（reducer 按 toolCallId 合并）**

在 `executionTraceReducer.test.ts` 追加：

```ts
describe('applyToolCall toolCallId 合并（可观测性专项）', () => {
  it('A1: 同名工具交错调用按 toolCallId 各自闭合', () => {
    const trace = createExecutionTrace()
    applyToolCall(trace, 'upsert_media_node', undefined, { toolCallId: 'c1' })
    applyToolCall(trace, 'upsert_media_node', undefined, { toolCallId: 'c2' })
    applyToolCall(trace, 'upsert_media_node', { message: 'ok' }, { toolCallId: 'c1' })
    applyToolCall(trace, 'upsert_media_node', { message: 'ok' }, { toolCallId: 'c2' })
    const toolSteps = trace.steps.filter((s) => s.kind === 'tool')
    expect(toolSteps).toHaveLength(2)
    expect(toolSteps.every((s) => s.status === 'done')).toBe(true)
    expect(toolSteps.map((s) => s.meta?.toolCallId).sort()).toEqual(['c1', 'c2'])
  })

  it('A2: tool_result 先到（乱序）降级为新建完成态步骤，不崩', () => {
    const trace = createExecutionTrace()
    expect(() =>
      applyToolCall(trace, 'load_skill', { message: 'ok' }, { toolCallId: 'c9' }),
    ).not.toThrow()
    expect(trace.steps.filter((s) => s.kind === 'tool')).toHaveLength(1)
  })

  it('A3: 无 toolCallId（老链路）保持 name+running 匹配语义', () => {
    const trace = createExecutionTrace()
    applyToolCall(trace, 'explore_canvas')
    applyToolCall(trace, 'explore_canvas', { status: 'ok' })
    const toolSteps = trace.steps.filter((s) => s.kind === 'tool')
    expect(toolSteps).toHaveLength(1)
    expect(toolSteps[0].status).toBe('done')
  })

  it('A6: 已闭合的 toolCallId 重复收到 result（重放）不产生新步骤', () => {
    const trace = createExecutionTrace()
    applyToolCall(trace, 'load_skill', undefined, { toolCallId: 'c1' })
    applyToolCall(trace, 'load_skill', { message: 'a' }, { toolCallId: 'c1' })
    applyToolCall(trace, 'load_skill', { message: 'a' }, { toolCallId: 'c1' })
    expect(trace.steps.filter((s) => s.kind === 'tool')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/web && ./node_modules/.bin/vitest run src/components/agent/executionTraceReducer.test.ts
```

Expected: FAIL（applyToolCall 第 4 参不存在 / meta.toolCallId 未定义）。

- [ ] **Step 3: 改 reducer —— ExecutionStep.meta 加 toolCallId，applyToolCall 加第 4 参**

`executionTraceReducer.ts` meta 类型：

```ts
  meta?: {
    nodeId?: string
    taskId?: string
    toolName?: string
    toolCallId?: string
    errorCode?: string
  }
```

`applyToolCall` 整体替换为：

```ts
export function applyToolCall(
  trace: ExecutionTraceState,
  name: string,
  result?: unknown,
  meta?: { toolCallId?: string; args?: string },
) {
  // toolCallId 优先精确匹配（支持同名并发）；无 id 时回退老语义：同 name 的 running 步
  const existing = meta?.toolCallId
    ? trace.steps.find((s) => s.kind === 'tool' && s.meta?.toolCallId === meta.toolCallId)
    : trace.steps.find(
        (s) => s.kind === 'tool' && s.meta?.toolName === name && s.status === 'running',
      )
  if (existing) {
    if (result === undefined) return // 重放/重复 start：幂等
    existing.detail = summarizeToolResult(result)
    completeStep(existing)
    return
  }
  const now = Date.now()
  trace.steps.push({
    id: nextStepId('tool'),
    kind: 'tool',
    label: `调用 ${name}`,
    status: result !== undefined ? 'done' : 'running',
    startedAt: now,
    endedAt: result !== undefined ? now : undefined,
    ms: result !== undefined ? 0 : undefined,
    meta: { toolName: name, toolCallId: meta?.toolCallId, ...(meta?.args ? { detail: meta.args } : {}) } as ExecutionStep['meta'],
    detail: result !== undefined ? summarizeToolResult(result) : undefined,
  })
}
```

注意：meta 里不要放 detail 字段（ExecutionStep.meta 无此属性）——`args` 摘要在 Task 2 才加；本步 meta 就写成 `{ toolName: name, toolCallId: meta?.toolCallId }`，上面代码中的 args 展开删掉（留给 Task 2）。Task 2 落地时再改本函数。

- [ ] **Step 4: 运行测试确认通过**

同 Step 2 命令。Expected: PASS（4 个新用例 + 存量用例全绿）。

- [ ] **Step 5: 改 store —— begin/end 两段式 + 降级**

`stores/agent.ts` 的 `AgentStreamMessage.toolCalls` 类型扩为：

```ts
  toolCalls?: Array<{ name: string; result?: unknown; toolCallId?: string; argsSummary?: string }>
```

在 `addToolCall` 旁新增（保留 addToolCall 兼容历史回放与老路径）：

```ts
  function beginToolCall(call: { toolCallId?: string; name: string; args?: unknown }) {
    const last = lastAssistant()
    if (!last) return
    last.toolCalls?.push({ name: call.name, toolCallId: call.toolCallId })
    ensureExecutionTrace()
    if (last.executionTrace) {
      applyToolCall(last.executionTrace, call.name, undefined, { toolCallId: call.toolCallId })
    }
  }

  function endToolCall(toolCallId: string | undefined, name: string, result?: unknown) {
    const last = lastAssistant()
    if (!last) return
    if (toolCallId) {
      const entry = last.toolCalls?.find(
        (tc) => tc.toolCallId === toolCallId && tc.result === undefined,
      )
      if (entry) entry.result = result
    }
    ensureExecutionTrace()
    if (last.executionTrace) {
      applyToolCall(last.executionTrace, name, result, { toolCallId })
    }
  }
```

return 列表追加 `beginToolCall, endToolCall`。注意 A2 场景（end 先到）：entry 找不到则只在 toolCalls 里追加一条完成态——在上面 `if (toolCallId)` 块末尾补：

```ts
      if (!entry) last.toolCalls?.push({ name, result, toolCallId })
```

- [ ] **Step 6: 4 处消费方同步改造（防 undefined 回归）**

三个组件的 `case 'tool_call'` / `case 'tool_result'` 统一改为：

```ts
    case 'tool_call': {
      const d = event.data as { name: string; toolCallId?: string; args?: unknown }
      agent.beginToolCall({ toolCallId: d.toolCallId, name: d.name, args: d.args })
      break
    }
    case 'tool_result': {
      const d = event.data as { name: string; toolCallId?: string; result: unknown }
      agent.endToolCall(d.toolCallId, d.name, d.result)
      break
    }
```

（AgentSideRail.vue:1932、AgentPanel.vue:110、AgentFloatingWindow.vue:128；executionTraceReducer 由 store 内部调用，无组件级 case。）

- [ ] **Step 7: 全量跑前端测试**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/web && ./node_modules/.bin/vitest run
```

Expected: 全绿（存量用例不回归）。

- [ ] **Step 8: 提交**

```bash
git add apps/web/src/stores/agent.ts apps/web/src/components/agent/executionTraceReducer.ts apps/web/src/components/agent/executionTraceReducer.test.ts apps/web/src/components/agent/AgentSideRail.vue apps/web/src/components/agent/AgentPanel.vue apps/web/src/components/agent/AgentFloatingWindow.vue
git commit -m "fix(web): 工具执行步骤按 toolCallId 去重，修复执行过程列表重复渲染"
```

---

### Task 2: 工具入参摘要展示（load_skill 显示 skill 名）

**Files:**
- Create: `apps/web/src/components/agent/toolArgSummary.ts`
- Modify: `apps/web/src/stores/agent.ts`（beginToolCall 透传 args → argsSummary）
- Modify: `apps/web/src/components/agent/executionTraceReducer.ts`（步骤 label/detail 带 args 摘要）
- Modify: `apps/web/src/components/agent/AgentSideRail.vue:2477`、`AgentFloatingWindow.vue:214`（⚙ 列表渲染）
- Test: `apps/web/src/components/agent/toolArgSummary.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `beginToolCall(call)`（args 已透传到组件层）；Nest tool_call 事件的 `args`（pi 工具入参为 TypeBox 定义的 camelCase/snake_case 原始对象）。
- Produces: `summarizeToolArgs(name: string, args: unknown): string | undefined`——供 store（toolCalls 条目 `argsSummary`）与 reducer（步骤 label 后缀）共用。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { summarizeToolArgs } from '@/components/agent/toolArgSummary'

describe('summarizeToolArgs（可观测性专项）', () => {
  it('load_skill 显示 skill 名', () => {
    expect(summarizeToolArgs('load_skill', { name: 'ecommerce-product-photo' })).toBe(
      'ecommerce-product-photo',
    )
  })

  it('upsert_media_node 优先 title，缺省截 prompt', () => {
    expect(summarizeToolArgs('upsert_media_node', { target_type: 'image', title: '白底主图' })).toBe(
      '白底主图',
    )
    const s = summarizeToolArgs('upsert_media_node', {
      target_type: 'image',
      prompt: '一张蓝牙耳机白色背景商品图，柔光棚拍',
    })
    expect(s).toBe('一张蓝牙耳机白色背景商品图，柔光棚拍'.slice(0, 24))
  })

  it('propose_generation 显示节点数', () => {
    expect(summarizeToolArgs('propose_generation', { node_ids: ['a', 'b'] })).toBe('2 个节点')
    expect(summarizeToolArgs('propose_generation', { node_id: 'a' })).toBe('1 个节点')
  })

  it('未知工具/无 args 返回 undefined，不抛错', () => {
    expect(summarizeToolArgs('run_image', undefined)).toBeUndefined()
    expect(summarizeToolArgs('unknown_tool', { foo: 1 })).toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/web && ./node_modules/.bin/vitest run src/components/agent/toolArgSummary.test.ts
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 toolArgSummary.ts**

```ts
/**
 * 工具入参摘要（可观测性专项 ②）：执行过程里展示「调用了什么」之外的关键「对什么操作」。
 * 只挑人可读的关键字段；未覆盖的工具返回 undefined（列表只显示工具名）。
 */
const ARGS_SUMMARY_MAX = 24

export function summarizeToolArgs(name: string, args: unknown): string | undefined {
  if (args == null || typeof args !== 'object') return undefined
  const a = args as Record<string, unknown>
  switch (name) {
    case 'load_skill':
      return typeof a.name === 'string' && a.name ? a.name : undefined
    case 'upsert_media_node': {
      if (typeof a.title === 'string' && a.title) return a.title.slice(0, ARGS_SUMMARY_MAX)
      if (typeof a.prompt === 'string' && a.prompt) return a.prompt.slice(0, ARGS_SUMMARY_MAX)
      return undefined
    }
    case 'propose_generation': {
      if (Array.isArray(a.node_ids) && a.node_ids.length > 0) return `${a.node_ids.length} 个节点`
      if (typeof a.node_id === 'string' && a.node_id) return '1 个节点'
      return undefined
    }
    case 'cancel_generation':
      return typeof a.node_id === 'string' && a.node_id ? a.node_id.slice(0, ARGS_SUMMARY_MAX) : undefined
    default:
      return undefined
  }
}
```

- [ ] **Step 4: 测试通过**

同 Step 2 命令。Expected: PASS。

- [ ] **Step 5: 接入 store 与渲染**

`stores/agent.ts` import `summarizeToolArgs`；`beginToolCall` push 改为：

```ts
    last.toolCalls?.push({
      name: call.name,
      toolCallId: call.toolCallId,
      argsSummary: summarizeToolArgs(call.name, call.args),
    })
```

reducer `applyToolCall`（Task 1 改后版本）在 push 分支加 args 摘要：

```ts
import { summarizeToolArgs } from '@/components/agent/toolArgSummary'
// push 分支：
    meta: { toolName: name, toolCallId: meta?.toolCallId },
    detail: result !== undefined ? summarizeToolResult(result) : undefined,
```

并在 label 生成处改为：

```ts
    label: meta?.args ? `调用 ${name} · ${meta.args}` : `调用 ${name}`,
```

对应 store 的 `beginToolCall` 调 reducer 时把摘要传进 meta：

```ts
      applyToolCall(last.executionTrace, call.name, undefined, {
        toolCallId: call.toolCallId,
        args: summarizeToolArgs(call.name, call.args),
      })
```

（Task 1 预留的 meta.args 字段此处生效；`ExecutionStep.meta` 增补 `args?: string`。）

`AgentSideRail.vue:2477` 与 `AgentFloatingWindow.vue:214` 的 ⚙ 行改为：

```html
<div v-for="(tc, i) in msg.toolCalls" :key="i" class="text-[10px] text-[var(--neo-text-secondary)]">⚙ {{ tc.name }}<template v-if="tc.argsSummary"> · {{ tc.argsSummary }}</template></div>
```

（FloatingWindow 原有 `text-[#818cf8]` 类名保留不动，只加 argsSummary 模板段。）

- [ ] **Step 6: 全量测试 + 提交**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/web && ./node_modules/.bin/vitest run
```

Expected: 全绿。

```bash
git add apps/web/src/components/agent/toolArgSummary.ts apps/web/src/components/agent/toolArgSummary.test.ts apps/web/src/stores/agent.ts apps/web/src/components/agent/executionTraceReducer.ts apps/web/src/components/agent/AgentSideRail.vue apps/web/src/components/agent/AgentFloatingWindow.vue
git commit -m "feat(web): 执行过程展示工具入参摘要（load_skill 显示技能名等）"
```

---

### Task 3: Nest thinking 透传 + pi 路径执行事件持久化

**Files:**
- Modify: `apps/server/src/agent/pi-runtime/pi-events.ts`（新增 extractThinking + createThinkingAccumulator）
- Modify: `apps/server/src/agent/pi-runtime/pi-events.test.ts`
- Modify: `apps/server/src/agent/agent.service.ts`（streamFromPiRuntime：thinking 收集 + executionEvents 持久化；`TRACE_PERSIST_EVENT_TYPES` 增 `thinking`）
- Modify: `apps/web/src/components/agent/AgentPanel.vue`、`AgentFloatingWindow.vue`（补 `case 'thinking'`）
- Test: `apps/server/src/agent/pi-runtime/pi-events.test.ts`

**Interfaces:**
- Consumes: pi-runtime `message_update` 事件 data 内嵌 `{ event: { type: 'thinking_start'|'thinking_delta'|'thinking_end', delta?: string } }`（实测校准见 pi-events.ts 现有注释）。
- Produces: UI 事件 `{ type: 'thinking', data: { status: 'running' } | { status: 'done', summary?: string } }`（前端 `trackThinking`/`applyThinking` 现成通道，SideRail 已有 case，无需新事件类型）；`createThinkingAccumulator(limit?)` 返回 `{ feed(event: PiRuntimeEvent): UiEvent | null }`。Task 6 验收依赖本任务的 thinking 事件与持久化。

- [ ] **Step 1: 写失败测试（pi-events.test.ts 追加）**

```ts
describe("thinking 透传（可观测性专项 ③）", () => {
  const thinkEvent = (type: string, delta?: string) =>
    ({
      type: "message_update",
      ts: 1,
      data: { event: { type, ...(delta !== undefined ? { delta } : {}) } },
    }) as never;

  it("start → running 事件，delta → 累积返回 null，end → done + 截断摘要", () => {
    const acc = createThinkingAccumulator(10);
    expect(acc.feed(thinkEvent("thinking_start"))).toEqual({
      type: "thinking",
      data: { status: "running" },
    });
    expect(acc.feed(thinkEvent("thinking_delta", "一二三四五"))).toBeNull();
    expect(acc.feed(thinkEvent("thinking_delta", "六七八九十〇一二三四"))).toBeNull();
    const end = acc.feed(thinkEvent("thinking_end"));
    expect(end).toEqual({ type: "thinking", data: { status: "done", summary: "一二三四五六七八九十〇" } });
  });

  it("A4: 纯文本流（无 thinking）feed 全程返回 null", () => {
    const acc = createThinkingAccumulator();
    expect(acc.feed({ type: "message_update", ts: 1, data: { event: { type: "text_delta", delta: "hi" } } } as never)).toBeNull();
    expect(acc.feed({ type: "tool_execution_start", ts: 1, data: {} } as never)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/server && ./node_modules/.bin/vitest run src/agent/pi-runtime/pi-events.test.ts
```

Expected: FAIL（createThinkingAccumulator 未导出）。

- [ ] **Step 3: 实现 pi-events.ts 新增**

文件尾部追加：

```ts
/** message_update 内嵌的 thinking 子事件（thinking_start/delta/end，实测见文件头注释）。 */
export interface ThinkingPhase {
	phase: "start" | "delta" | "end";
	text?: string;
}

export function extractThinking(event: PiRuntimeEvent): ThinkingPhase | null {
	if (event.type !== "message_update") return null;
	const data = event.data as {
		event?: { type?: string; delta?: string };
		assistantMessageEvent?: { type?: string; delta?: string };
	};
	const ame = data.event ?? data.assistantMessageEvent;
	if (!ame) return null;
	if (ame.type === "thinking_start") return { phase: "start" };
	if (ame.type === "thinking_delta" && typeof ame.delta === "string") {
		return { phase: "delta", text: ame.delta };
	}
	if (ame.type === "thinking_end") return { phase: "end" };
	return null;
}

/**
 * thinking 累积器（可观测性专项 ③）：把 pi 的流式 thinking 子事件折叠为
 * 老 UI 契约的 `thinking` 事件（start→running，end→done+截断摘要）。
 * delta 只累积不透传（v1 不做逐字思考流），摘要取前 limit 字符。
 */
export function createThinkingAccumulator(limit = 200): {
	feed(event: PiRuntimeEvent): UiEvent | null;
} {
	let buffer = "";
	return {
		feed(event: PiRuntimeEvent): UiEvent | null {
			const t = extractThinking(event);
			if (!t) return null;
			if (t.phase === "start") return { type: "thinking", data: { status: "running" } };
			if (t.phase === "delta" && t.text) {
				buffer += t.text;
				return null;
			}
			const summary = buffer.slice(0, limit);
			return { type: "thinking", data: { status: "done", summary: summary || undefined } };
		},
	};
}
```

- [ ] **Step 4: 测试通过**

同 Step 2 命令。Expected: PASS。

- [ ] **Step 5: agent.service.ts 接入**

`TRACE_PERSIST_EVENT_TYPES`（agent.service.ts:55）集合追加 `'thinking'`。

`streamFromPiRuntime`（agent.service.ts:668）改造：函数开头加

```ts
    const thinkingAccumulator = createThinkingAccumulator()
    const executionEvents: Array<{ type: string; data: unknown }> = []
```

主循环内、`const ui = mapPiEventToUiEvent(event)` 之前加：

```ts
        const thinkingUi = thinkingAccumulator.feed(event)
        if (thinkingUi) {
          yield thinkingUi as AgentStreamEvent
        }
```

`ui` 非空后追加持久化收集（在 `yield ui as AgentStreamEvent` 之前）：

```ts
        if (ui.type === 'text_delta') {
          assistantText += (ui.data as { text: string }).text
        } else if (ui.type === 'canvas_action') {
          canvasActions.push(ui.data as CanvasAction)
        }
        if (
          ui.type === 'tool_call' ||
          ui.type === 'tool_result' ||
          ui.type === 'canvas_action'
        ) {
          executionEvents.push({ type: ui.type, data: ui.data })
        }
```

thinking 事件也收集（放在 thinkingUi yield 块内）：

```ts
        if (thinkingUi) {
          executionEvents.push({ type: 'thinking', data: thinkingUi.data })
          yield thinkingUi as AgentStreamEvent
        }
```

`finalizeTurn` 调用（agent.service.ts:736）加 metadata：

```ts
    await this.finalizeTurn(sessionId, effectiveThreadId, userId, assistantText, canvasActions, {
      rewriteCanvasData: false,
      metadata: buildTurnMetadata({ executionEvents }),
    })
```

import 处补 `createThinkingAccumulator`（来自 `./pi-runtime/pi-events`）。

- [ ] **Step 6: 前端 Panel/FloatingWindow 补 thinking case**

`AgentPanel.vue` 与 `AgentFloatingWindow.vue` 的事件 switch 各追加（SideRail.vue:1955 已有，勿重复加）：

```ts
    case 'thinking':
      agent.trackThinking(event.data as { status: string; summary?: string })
      break
```

- [ ] **Step 7: 全量测试 + 提交**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/server && ./node_modules/.bin/vitest run
cd /Users/4seven/workspace/pi-lnk/apps/web && ./node_modules/.bin/vitest run
```

Expected: 两包全绿。

```bash
git add apps/server/src/agent/pi-runtime/pi-events.ts apps/server/src/agent/pi-runtime/pi-events.test.ts apps/server/src/agent/agent.service.ts apps/web/src/components/agent/AgentPanel.vue apps/web/src/components/agent/AgentFloatingWindow.vue
git commit -m "feat(agent): pi 链路 thinking 透传为前端思考步骤 + 执行事件持久化（刷新可恢复）"
```

---

### Task 4: pi-runtime 显性 skill 通道（forceSkills + GET /skills）

**Files:**
- Modify: `services/pi-runtime/src/index.ts:123-137`（prompt 路由 Body）+ 新增 `GET /skills` 路由
- Modify: `services/pi-runtime/src/session-manager.ts`（prompt 第 4 参 + withForcedSkills 纯函数）
- Modify: `services/pi-runtime/src/skills/registry.ts`（新增 loadBody）
- Test: `services/pi-runtime/src/session-manager.forced-skills.test.ts`（新建，纯函数测试）

**Interfaces:**
- Consumes: `SkillRegistry.entries`（SkillIndexEntry：`{ name, description }`）与 `loader.loadSkill(entry).body`；`SessionManager.prompt(id, text, laneName?)` 现签名。
- Produces: `SessionManager.prompt(id, text, laneName?, opts?: { forceSkills?: string[] })`；`SessionManager.listSkills(): Array<{ name: string; description: string }>`；`GET /skills` → `{ skills: [{ name, description }] }`；prompt Body 可选 `forceSkills?: string[]`。Task 5 依赖这三个接口。

- [ ] **Step 1: 写失败测试（纯函数，无需 harness）**

新建 `services/pi-runtime/src/session-manager.forced-skills.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { withForcedSkills } from "./session-manager.js";

describe("withForcedSkills（可观测性专项 ④）", () => {
  it("已知 skill：正文注入 + 显式调用前缀", () => {
    const out = withForcedSkills("帮我做白底图", ["ecommerce-product-photo"], (name) =>
      name === "ecommerce-product-photo" ? "# 电商商品图生成\n步骤…" : undefined,
    );
    expect(out).toContain("[用户显式调用 skill: ecommerce-product-photo]");
    expect(out).toContain("# 电商商品图生成");
    expect(out.endsWith("用户请求：帮我做白底图")).toBe(true);
  });

  it("A5: 未知名 fail-soft：注入不存在提示，不抛错", () => {
    const out = withForcedSkills("做图", ["no-such-skill"], () => undefined);
    expect(out).toContain("no-such-skill");
    expect(out).toContain("用户请求：做图");
  });

  it("forceSkills 为空时原文返回", () => {
    expect(withForcedSkills("原文", undefined, () => "# body")).toBe("原文");
    expect(withForcedSkills("原文", [], () => "# body")).toBe("原文");
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && ./node_modules/.bin/vitest run src/session-manager.forced-skills.test.ts
```

Expected: FAIL（withForcedSkills 未导出）。

- [ ] **Step 3: 实现**

`session-manager.ts` 顶层导出纯函数：

```ts
/** 可观测性专项 ④：显性 skill 调用——把 skill 正文作为指令前缀注入 prompt 文本。 */
export function withForcedSkills(
	text: string,
	forceSkills: string[] | undefined,
	resolveBody: (name: string) => string | undefined,
): string {
	if (!forceSkills || forceSkills.length === 0) return text;
	const parts: string[] = [];
	for (const name of forceSkills) {
		const body = resolveBody(name);
		parts.push(
			body
				? `[用户显式调用 skill: ${name}]\n请严格按以下指导执行：\n\n${body}`
				: `[用户显式调用了未安装的 skill: ${name}；先告知用户该技能不存在，再按其原意尽力完成]`,
		);
	}
	return `${parts.join("\n\n")}\n\n---\n用户请求：${text}`;
}
```

`SessionManager.prompt` 改签名并使用：

```ts
	async prompt(
		id: string,
		text: string,
		laneName = "main",
		opts?: { forceSkills?: string[] },
	): Promise<{ accepted: boolean }> {
		const entry = this.require(id);
		const effectiveText = withForcedSkills(
			text,
			opts?.forceSkills,
			(name) => this.skills?.loadBody(name),
		);
		this.hooks?.onPrompt?.(id);
		const lane = await entry.harness.lane(laneName, this.context);
		entry.prompting = true;
		void lane
			.prompt(effectiveText, undefined, this.context)
			// …后续 .then/.catch/.finally 与现实现完全一致，仅 prompt 入参换 effectiveText
```

新增 `listSkills` 方法（放在 `count()` 后）：

```ts
	listSkills(): Array<{ name: string; description: string }> {
		return (this.skills?.entries ?? []).map((e) => ({ name: e.name, description: e.description }));
	}
```

`skills/registry.ts` 新增：

```ts
	import { loadSkill } from "./loader.js"; // 顶部追加

	loadBody(name: string): string | undefined {
		const entry = this.entries.find((e) => e.name === name);
		if (!entry) return undefined;
		return loadSkill(entry).body;
	}
```

`index.ts` prompt 路由 Body 类型加 `forceSkills?: string[]`，调用改：

```ts
		return await manager.prompt(sessionId, request.body.text, request.body.lane ?? "main", {
			forceSkills: request.body.forceSkills,
		});
```

新增路由（放在 /metrics 之后）：

```ts
app.get("/skills", async () => ({ skills: manager.listSkills() }));
```

- [ ] **Step 4: 测试通过 + 提交**

```bash
cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && ./node_modules/.bin/vitest run
```

Expected: 全绿（含存量 session-manager/tools 测试）。

```bash
git add services/pi-runtime/src/index.ts services/pi-runtime/src/session-manager.ts services/pi-runtime/src/session-manager.forced-skills.test.ts services/pi-runtime/src/skills/registry.ts
git commit -m "feat(pi-runtime): 显性 skill 调用通道（prompt forceSkills + GET /skills）"
```

---

### Task 5: Nest 侧 /skill 指令解析与转发

**Files:**
- Create: `apps/server/src/agent/pi-runtime/skill-command.ts`
- Modify: `apps/server/src/agent/pi-runtime/pi-runtime.client.ts:136-141`（prompt 加 opts）、新增 `listSkills()`
- Modify: `apps/server/src/agent/agent.service.ts`（streamFromPiRuntime 解析 /skill 前缀）
- Test: `apps/server/src/agent/pi-runtime/skill-command.test.ts`、`pi-runtime.client.test.ts` 追加

**Interfaces:**
- Consumes: Task 4 的 `POST /sessions/:id/prompt` Body `forceSkills`、`GET /skills`。
- Produces: `parseSkillCommand(text: string): { name: string; rest: string } | null`；`PiRuntimeClient.prompt(sessionId, text, lane?, opts?: { forceSkills?: string[] })`；`PiRuntimeClient.listSkills(): Promise<{ skills: Array<{ name: string; description: string }> }>`。

- [ ] **Step 1: 写失败测试**

`skill-command.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { parseSkillCommand } from "./skill-command.js";

describe("parseSkillCommand（可观测性专项 ④）", () => {
  it("命中 /skill <name> <rest>", () => {
    expect(parseSkillCommand("/skill ecommerce-product-photo 帮我做白底图")).toEqual({
      name: "ecommerce-product-photo",
      rest: "帮我做白底图",
    });
  });

  it("A5b: rest 为空时回退默认请求语", () => {
    expect(parseSkillCommand("/skill ecommerce-product-photo")).toEqual({
      name: "ecommerce-product-photo",
      rest: "",
    });
  });

  it("非 /skill 开头返回 null", () => {
    expect(parseSkillCommand("帮我做一张白底图")).toBeNull();
    expect(parseSkillCommand("/skills")).toBeNull();
    expect(parseSkillCommand("/skill   ")).toBeNull();
  });
});
```

`pi-runtime.client.test.ts` 追加：

```ts
  it("prompt 携带 forceSkills；listSkills 走 GET /skills", async () => {
    // 仿照本文件既有 fetch mock 模式：断言 prompt 请求体含 { text, lane, forceSkills: ["x"] }，
    // listSkills 请求 method=GET url 以 /skills 结尾且返回 { skills: [...] }
  });
```

（实现时按该文件现成 mock 写法展开为完整用例：prompt 断言 `JSON.stringify(body)` 含 forceSkills；listSkills 断言解析结果。）

- [ ] **Step 2: 运行确认失败**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/server && ./node_modules/.bin/vitest run src/agent/pi-runtime/
```

Expected: FAIL（skill-command.ts 不存在 / client 无 listSkills）。

- [ ] **Step 3: 实现**

`skill-command.ts`：

```ts
/** /skill 显性指令解析（可观测性专项 ④）：仅精确匹配 "/skill <name>[ <rest>]"。 */
const SKILL_COMMAND_RE = /^\/skill\s+([^\s]+)(?:\s+([\s\S]*))?$/;

export function parseSkillCommand(text: string): { name: string; rest: string } | null {
	const m = text.match(SKILL_COMMAND_RE);
	if (!m) return null;
	return { name: m[1], rest: (m[2] ?? "").trim() };
}
```

`pi-runtime.client.ts`：

```ts
	async prompt(
		sessionId: string,
		text: string,
		lane = "main",
		opts?: { forceSkills?: string[] },
	): Promise<void> {
		// 原 request 调用不变，body 换为：
		//   { text, lane, ...(opts?.forceSkills?.length ? { forceSkills: opts.forceSkills } : {}) }
```

新增：

```ts
	async listSkills(): Promise<{ skills: Array<{ name: string; description: string }> }> {
		const { status, body } = await this.request<{ skills?: Array<{ name: string; description: string }> }>(
			"/skills",
			{ method: "GET" },
		);
		if (status >= 400) {
			throw new PiRuntimeError(`listSkills failed: HTTP ${status}`, status);
		}
		return { skills: body?.skills ?? [] };
	}
```

（`this.request` 的具体签名/选项以该文件既有方法为准对齐，不改其传输层。）

`agent.service.ts` `streamFromPiRuntime` 中 prompt 调用处（原 `void client.prompt(sessionId, userMessage)`）改为：

```ts
    let promptText = userMessage
    let forceSkills: string[] | undefined
    const skillCmd = parseSkillCommand(userMessage)
    if (skillCmd) {
      const known = await client.listSkills().catch(() => null)
      if (known?.skills.some((s) => s.name === skillCmd.name)) {
        forceSkills = [skillCmd.name]
        promptText = skillCmd.rest || `请使用 skill ${skillCmd.name} 完成我的需求`
      }
      // 未知名：保持原文原样发送（降级为普通消息），由模型隐性匹配兜底
    }
    void client.prompt(sessionId, promptText, "main", { forceSkills }).catch(() => {
      // prompt 失败会以 error 事件形式出现在事件流中，此处静默
    })
```

import 处补 `parseSkillCommand`。

- [ ] **Step 4: 测试通过 + 提交**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/server && ./node_modules/.bin/vitest run
```

Expected: 全绿。

```bash
git add apps/server/src/agent/pi-runtime/skill-command.ts apps/server/src/agent/pi-runtime/skill-command.test.ts apps/server/src/agent/pi-runtime/pi-runtime.client.ts apps/server/src/agent/pi-runtime/pi-runtime.client.test.ts apps/server/src/agent/agent.service.ts
git commit -m "feat(agent): /skill 显性调用指令解析并转发 pi-runtime forceSkills"
```

---

### Task 6: 端到端验收与部署

**Files:**
- 只读核对：`docs/ops/RUNBOOK-pi-runtime-deploy.md`
- 无代码改动（如验收不过，回对应 Task 修复后重跑本任务）

**Interfaces:**
- Consumes: Task 1-5 全部产物；CVM `root@119.29.173.89`（`ssh -i ~/.ssh/tencent_cloud_deploy`）；发布门 deploy.yml（dispatch `{ref:master, branch:master}`）。

- [ ] **Step 1: 三包测试全绿确认**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/web && ./node_modules/.bin/vitest run
cd /Users/4seven/workspace/pi-lnk/apps/server && ./node_modules/.bin/vitest run
cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && ./node_modules/.bin/vitest run
```

Expected: 全绿。

- [ ] **Step 2: 计划文档图形校验**

```bash
cd /Users/4seven/workspace/pi-lnk && pnpm verify-spec-figures --file docs/superpowers/plans/2026-09-25-execution-trace-observability.md
```

Expected: PASS（§0 已声明无图）。

- [ ] **Step 3: pi-runtime 先部署（版本 0.0.6）**

按 `docs/ops/RUNBOOK-pi-runtime-deploy.md`：rsync 最小集 → CVM `docker build -t 127.0.0.1:5000/pi-runtime:0.0.6` → `helm upgrade pi-lnk-runtime-dev ... --set image.tag=0.0.6` → `curl :30100/metrics` 确认 healthy。forceSkills/GET /skills 对旧 Nest 向后兼容（旧 Nest 不发 forceSkills，行为不变）。

- [ ] **Step 4: Nest + 前端过发布门**

merge 到 pi-lnk master → dispatch deploy.yml `{ref:master, branch:master}` → 验收三件套：镜像 tag=sha+healthy、PI_RUNTIME_MODE=active、thread-verify PASS=16 FAIL=0。

- [ ] **Step 5: SSE 直探**

用既有 python 探针模式（login → send-code → 建 session → POST /agent/chat/conversation 收 SSE），发送 `/skill ecommerce-product-photo 帮我做一张蓝牙耳机白底图`，验证：
1. SSE 中 `tool_call` 事件 data 含 `toolCallId` 与 `args`；
2. 显性调用时无未知名降级（/skills 校验命中）；
3. 若模型产思考流，SSE 出现 `thinking` 事件（`status: running` 与 `status: done` 各至少一次；无思考流则记录「模型未产思考」不判失败）。

- [ ] **Step 6: 浏览器侧栏实测清单（逐项对照本次七问）**

1. 执行过程「N 步」与展开后 ⚙ 条目数一致（无重复）；
2. `⚙ load_skill · ecommerce-product-photo` 显示技能名；`⚙ upsert_media_node · <节点标题>`；
3. 思考步出现在执行过程（模型有思考流时）；
4. `/skill` 显性调用生效（回复体现 skill 指导）；
5. 刷新页面后历史消息的执行过程可恢复。

全部通过 → 在 PR/提交记录中注明验收结果；任一不过 → 回对应 Task 修复。

---

## Self-Review 记录

- 规格覆盖：七问结论映射——①重复渲染→Task 1；②入参不可见→Task 2；③思考丢弃→Task 3；④显性触发→Task 4/5；刷新丢失（复盘发现）→Task 3；「摘要/总结」WorkBuddy 式结构化输出属 Round 5 更大范围（journey/presentation），本专项明确不含，后续按使用率数据另立项。
- 占位符扫描：Task 5 Step 1 的 client 测试给出了断言要点与落点（按既有 mock 模式展开），非 TBD。
- 类型一致性：`withForcedSkills(text, forceSkills, resolveBody)` 在 Task 4 定义、Task 4 测试引用；`parseSkillCommand` Task 5 定义即用；`beginToolCall/endToolCall` Task 1 定义、Task 2 复用；`applyToolCall` 第 4 参 `meta.args` Task 1 预留、Task 2 生效（Task 1 落地时 meta 不含 args，已在 Step 3 注明）。
- Review Focus：六条均有对应用例（A1/A2/A3/A6 → Task 1；A4 → Task 3；A5 → Task 4、A5b → Task 5；刷新恢复 → Task 3 持久化 + Task 6 实测清单第 5 项）。

---

## 后继章节：P1/P2 回合呈现层（本计划不含，另立执行计划）

> 设计定稿见 `docs/discussion/2026-09-25-turn-presentation-design.md`（四层呈现模型 + 决策记录 D1-D5 + 体验验收标尺）。本计划（P0）是其第 4 层地基；P1/P2 待 P0 上线验证后另立实现计划，范围如下。

**P1 状态行 + 收口**：实时秒数（前端计时）、`waiting_user` 收口（footer 显示「等待你确认」并停止计时——现状转圈不止是体验错误）、`turn_usage` UI 事件（Nest 从 pi usage 汇总 inputTokens/outputTokens，前端显示 token 实耗，换算接口 `usageToCredits` 留纯函数）、失败态人话、回合摘要行（前端由 trace + turn_usage 汇总，零后端）。

**P1 时间线**：认知负荷控制（默认折叠、头行「N 步 · 最新：🖼️ 提议生成 3 张图」，优先于注册表）、步骤动效节拍（纯 CSS）、工具展示注册表（前端纯映射表，读工具人话化，D2：不进事件契约）、thinking 开关经 ensurePiSession 透传 pi-runtime（老链路已有 thinking/thinkingEffort，pi 路径缺失）。

**P2 结果层**：linkedOutputs 接线（近零成本拿产物缩略卡）、生成占位→完成替换（node_status 通道已有）、预计消耗（粗估）、侧栏技能选择器（D4：正式项，显性调用主要形态）。

**P2 后独立立项**：presentation envelope 输出契约设计（模型按 schema 输出 or Nest 派生，工作量周级，D3）。
