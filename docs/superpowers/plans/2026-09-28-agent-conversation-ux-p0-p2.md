# Agent 对话体验 P0-P2 优化实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 按差距分析报告补齐 agent 对话过程体验——P0 错误链路/思考面板、P1 工具卡/阶段徽章/todo/缩略图/ask_user 恢复/重连改造、P2 mermaid 渲染/死代码清理。

**Architecture:** 全部改造落在「Nest 现有产出 → 前端消费」链路，不新增 SSE 事件类型、不动 pi-runtime。阶段叙事用纯函数从 trace 步骤派生（刷新可恢复）；todo 用服务端 prompt 标记 + 复用既有 `task_list`/`task_update` 事件类型（零生产者 → 接通生产者，非新契约）。

**Tech Stack:** Vue 3 + Pinia（web）、NestJS（server）、vitest。纯函数一律 TDD。

**Spec:** `docs/superpowers/specs/2026-09-28-agent-conversation-ux-p0-p2-design.md`

## Global Constraints

- **不动 `services/pi-runtime/**`**（决策 ②）；所有 server 改动只在 `apps/server/src/agent/**`
- **不新增 SSE 事件类型**：复用 `error / task_list / task_update / thinking / tool_result` 既有契约
- `AgentSideRail.vue`（2600+ 行）最小 diff：新 UI 一律独立 .vue 文件，不做顺手重构
- 中文 UI 文案；图标/文案模式沿用 `toolPresentation.ts` 注册表现状
- 测试命令：web `cd apps/web && pnpm exec vitest run <file>`；server `cd apps/server && pnpm exec vitest run <file>`（`upstream-ref-inline.test.ts` 需 `--hookTimeout=120000`，与本计划无关但勿误判 flake 为回归）
- 提交前：改动相关测试 + `pnpm exec tsc --noEmit`（根目录）；落盘复核用 `git status` 判据
- 工作分支从最新 master 拉（先 `git fetch origin`）；单分支 3 批 commit，单 PR

## Review Focus

1. **text_delta 无标记时字节级等价**（Task 7）：不含 `⟦plan⟧`/`⟦task-done⟧` 的文本经过 strip 必须原样返回——否则落库内容被污染。测试：Task 7 Step 1。
2. **旧 metadata replay 不崩**（Task 2/10）：历史消息 executionEvents 无 `isError`、无 ask_user `canvas_command` 时 replay/loadHistory 静默降级。测试：Task 2 Step 1、Task 10 Step 1。
3. **未知工具名不抛错**（Task 4/6）：新工具上线未注册表时兜底展示 + 归入 exploring。测试：Task 4 Step 1、Task 6 Step 1。
4. **畸形 plan 标记**（Task 7）：JSON 解析失败 → 标记仍从文本剥离、不派生任何事件、不崩。测试：Task 7 Step 1。
5. **mermaid 渲染失败降级**（Task 12）：非法 mermaid 源码 → 显示 `<pre>` 原文，卡片其余内容不受影响。测试：Task 12 Step 1。

---

## Batch P0

### Task 1: Nest 侧 pi error → UI error 事件映射（P0#1 服务端半边）

**Files:**
- Modify: `apps/server/src/agent/pi-runtime/pi-events.ts`（`mapPiEventToUiEvent` switch，约 :77-103）
- Test: `apps/server/src/agent/pi-runtime/pi-events.test.ts`（已存在则追加用例）

**Interfaces:**
- Produces: SSE `error` 事件 `{ type: 'error', data: { message?, error_type?, retry_hint?, tool_name? } }`——前端 `AgentSideRail.vue:2135` 已有完整 error 分支（markTurnError + trackStructuredError + appendText），本任务后自动点亮。
- **错误呈现落点（spec §3.1 三段式由既有三处承载，无需新组件）**：发生了什么 = 时间线 failed 步（`applyStructuredError`，Task 2 后含工具失败）；可能原因 = `formatStructuredError`/`failureReason`（turnStatusBar.ts:41-49 人话映射表，兜底「生成失败，请重试」）；下一步 = 对话输入即重试入口（幂等链路已保证）+ `turnStatusBar` failed 行。

- [x] **Step 1: 写失败测试**

```ts
it('maps pi error event to UI error event with human-consumable fields', () => {
  const ui = mapPiEventToUiEvent({
    type: 'error',
    ts: 1,
    data: { message: '上游 429', error_type: 'rate_limit' },
  });
  expect(ui).not.toBeNull();
  expect(ui!.type).toBe('error');
  expect((ui!.data as { message?: string }).message).toBe('上游 429');
  expect((ui!.data as { error_type?: string }).error_type).toBe('rate_limit');
});
```

- [x] **Step 2: 运行确认失败**

Run: `cd apps/server && pnpm exec vitest run src/agent/pi-runtime/pi-events.test.ts`
Expected: FAIL（现值 `pi_error` 透传，type 断言不匹配）

- [x] **Step 3: 实现——在 `mapPiEventToUiEvent` switch 中 `default:` 之前加 case**

```ts
		case "error": {
			// P0 错误链路修复：error 原先落 default → pi_error 透传 → 前端静默丢弃，
			// 运行中报错用户只见「空回复兜底」。映射为前端已有完整分支的 error 事件。
			const d = event.data as {
				message?: string;
				error_type?: string;
				retry_hint?: string;
				tool_name?: string;
			};
			return {
				type: "error",
				data: {
					message: d.message,
					error_type: d.error_type,
					retry_hint: d.retry_hint,
					tool_name: d.tool_name,
				},
			};
		}
```

- [x] **Step 4: 运行确认通过**

Run: `cd apps/server && pnpm exec vitest run src/agent/pi-runtime/pi-events.test.ts`
Expected: PASS（含既有用例全绿）

- [x] **Step 5: 提交**

```bash
git add apps/server/src/agent/pi-runtime/pi-events.ts apps/server/src/agent/pi-runtime/pi-events.test.ts
git commit -m "fix(agent): pi error 事件映射为 UI error（修复错误静默丢弃）"
```

### Task 2: tool_result.isError 前端全链路（P0#1 工具失败标红）

**Files:**
- Modify: `apps/web/src/components/agent/AgentSideRail.vue:1939-1943`（tool_result case）
- Modify: `apps/web/src/stores/agent.ts:152-173`（`endToolCall`）
- Modify: `apps/web/src/components/agent/executionTraceReducer.ts:298-328`（`applyToolCall`）、`:457-463`（replay `tool_result` case）
- Test: `apps/web/src/components/agent/executionTraceReducer.test.ts`（追加用例）

**Interfaces:**
- Consumes: SSE `tool_result` data 已含 `isError: boolean`（pi-events.ts:88 已透传，无需改）
- Produces: `applyToolCall(trace, name, result, meta?: { toolCallId?, args?, isError? })`——第四个 meta 字段扩展；失败步 `status: 'failed'`，`AgentExecutionTrace.vue:120` 已有 `text-red-400/90` 样式自动生效

- [x] **Step 1: 写失败测试**

```ts
describe('applyToolCall isError', () => {
  it('marks the tool step failed when result carries isError', () => {
    const trace = createExecutionTrace();
    applyToolCall(trace, 'run_image', undefined, { toolCallId: 't1' });
    applyToolCall(trace, 'run_image', { message: '生成超时' }, { toolCallId: 't1', isError: true });
    const step = trace.steps.find((s) => s.meta?.toolCallId === 't1');
    expect(step?.status).toBe('failed');
    expect(step?.detail).toContain('生成超时');
  });

  it('replays legacy tool_result events without isError as done', () => {
    const trace = replayExecutionTraceEvents([
      { type: 'tool_call', data: { name: 'get_canvas_summary' } },
      { type: 'tool_result', data: { name: 'get_canvas_summary', result: { status: 'ok' } } },
    ]);
    const step = trace.steps.find((s) => s.kind === 'tool');
    expect(step?.status).toBe('done');
  });
});
```

- [x] **Step 2: 运行确认失败**

Run: `cd apps/web && pnpm exec vitest run src/components/agent/executionTraceReducer.test.ts`
Expected: 第一条 FAIL（现状 status 'done'）

- [x] **Step 3: 实现 reducer**

`applyToolCall` 签名 meta 扩为 `{ toolCallId?: string; args?: string; isError?: boolean }`；两处状态落点：

```ts
  if (existing) {
    if (result === undefined) return // 重放/重复 start：幂等
    existing.detail = summarizeToolResult(result)
    completeStep(existing, meta?.isError ? 'failed' : 'done')
    return
  }
  // 新建分支 status 行替换为：
    status: result !== undefined ? (meta?.isError ? 'failed' : 'done') : 'running',
```

replay `tool_result` case 传 meta：

```ts
      case 'tool_result': {
        const d = event.data as { name?: string; result?: unknown; isError?: boolean }
        applyToolCall(
          trace,
          String(d.name ?? 'tool'),
          d.result,
          { isError: d.isError === true },
        )
        break
      }
```

- [x] **Step 4: 接通 store 与 SideRail**

`stores/agent.ts` `endToolCall` 增第四参 `isError?: boolean`，两处 `applyToolCall` 调用传 `{ toolCallId, isError }`（begin 处不传）；`AgentSideRail.vue:1939-1943`：

```ts
    case 'tool_result': {
      const d = event.data as { name: string; toolCallId?: string; result: unknown; isError?: boolean }
      agent.endToolCall(d.toolCallId, d.name, d.result, d.isError === true)
      break
    }
```

- [x] **Step 5: 运行确认通过 + 提交**

Run: `cd apps/web && pnpm exec vitest run src/components/agent/executionTraceReducer.test.ts && pnpm exec tsc --noEmit`

```bash
git add apps/web/src/components/agent/executionTraceReducer.ts apps/web/src/components/agent/executionTraceReducer.test.ts apps/web/src/stores/agent.ts apps/web/src/components/agent/AgentSideRail.vue
git commit -m "fix(agent-web): 工具失败态标红——tool_result.isError 全链路贯通"
```

### Task 3: thinking 全文折叠面板（P0#2）

**Files:**
- Modify: `apps/server/src/agent/pi-runtime/pi-events.ts:214-231`（accumulator limit）
- Modify: `apps/web/src/components/agent/AgentExecutionTrace.vue`（thinking 步 detail 展示）
- Test: `apps/server/src/agent/pi-runtime/pi-events.test.ts`（追加用例）

**Interfaces:**
- Produces: `thinking` 事件 `{ status: 'done', summary: <全文，clamp 2000 字> }`——前端 `applyThinking` 已把 summary 写进 step.detail，无需前端 reducer 改动

- [x] **Step 1: 写失败测试**

```ts
it('emits full thinking text up to 2000 chars on end', () => {
  const acc = createThinkingAccumulator();
  const longText = 'a'.repeat(2500);
  acc.feed({ type: 'message_update', ts: 1, data: { event: { type: 'thinking_start' } } });
  acc.feed({ type: 'message_update', ts: 2, data: { event: { type: 'thinking_delta', delta: longText } } });
  const out = acc.feed({ type: 'message_update', ts: 3, data: { event: { type: 'thinking_end' } } });
  expect(out?.type).toBe('thinking');
  const summary = (out!.data as { summary?: string }).summary ?? '';
  expect(summary.length).toBe(2000);
});
```

- [x] **Step 2: 运行确认失败**（现状 limit=200，长度 200）

Run: `cd apps/server && pnpm exec vitest run src/agent/pi-runtime/pi-events.test.ts`

- [x] **Step 3: 实现**

`createThinkingAccumulator(limit = 200)` → `createThinkingAccumulator(limit = 2000)`，注释更新：「P0 思考面板：全文透传（clamp 2000 字防超大 payload），前端折叠展示」。

- [x] **Step 4: 前端 thinking 步 detail 支持换行**（`AgentExecutionTrace.vue` detail `<p>` 行加 class）

```html
<p v-if="step.detail" class="mt-0.5 pl-3 opacity-75" :class="step.kind === 'thinking' ? 'whitespace-pre-wrap' : ''">{{ step.detail }}</p>
```

- [x] **Step 5: 运行确认通过 + 提交**

Run: `cd apps/server && pnpm exec vitest run src/agent/pi-runtime/pi-events.test.ts && cd ../../ && pnpm exec tsc --noEmit`

```bash
git add apps/server/src/agent/pi-runtime/pi-events.ts apps/server/src/agent/pi-runtime/pi-events.test.ts apps/web/src/components/agent/AgentExecutionTrace.vue
git commit -m "feat(agent): 思考全文折叠面板——thinking 载荷升级为 2000 字全文"
```

---

## Batch P1

### Task 4: 工具注册表 + 参数摘要全量（P1#3 数据层）

**Files:**
- Modify: `apps/web/src/components/agent/toolPresentation.ts`（TOOL_PRESENTATION 扩全）
- Modify: `apps/web/src/components/agent/toolArgSummary.ts`（switch 扩全）
- Test: 各自 `.test.ts`（已存在则追加）

**Interfaces:**
- Produces: `TOOL_PRESENTATION` 覆盖全部 28 个本地工具 + `run_` 前缀；`summarizeToolArgs` 覆盖全部有 args 的工具。Task 5 的 ToolCallCard 消费

- [x] **Step 1: 写失败测试**（toolPresentation.test.ts 追加）

```ts
const ALL_LOCAL_TOOLS = [
  'get_canvas_summary', 'get_node', 'get_generation_status', 'get_generation_diagnostic',
  'get_canvas_layout', 'list_generation_tasks', 'list_user_assets',
  'upsert_prompt_node', 'upsert_media_node', 'set_node_text', 'attach_refs', 'propose_generation',
  'apply_sidebar_attachments', 'apply_asset_to_node', 'save_node_to_asset_library', 'duplicate_node',
  'upload_media_to_canvas', 'grid_slice_image', 'connect_nodes', 'introduce_nodes_to_agent',
  'cancel_generation', 'load_skill', 'ask_user', 'arrange_nodes',
  'focus_node', 'focus_nodes', 'undo', 'redo', 'open_image_editor',
] as const;

it('has a presentation entry for every local runtime tool', () => {
  for (const name of ALL_LOCAL_TOOLS) {
    expect(TOOL_PRESENTATION[name], `missing presentation for ${name}`).toBeDefined();
  }
});
```

toolArgSummary.test.ts 追加：

```ts
it('summarizes key write tools', () => {
  expect(summarizeToolArgs('set_node_text', { node_id: 'n1', text: '标题文案' })).toContain('标题文案');
  expect(summarizeToolArgs('connect_nodes', { edges: [{ source: 'a', target: 'b' }] })).toBe('2 条连线');
  expect(summarizeToolArgs('upsert_prompt_node', { title: '方案' })).toBe('方案');
});
```

- [x] **Step 2: 运行确认失败**

Run: `cd apps/web && pnpm exec vitest run src/components/agent/toolPresentation.test.ts src/components/agent/toolArgSummary.test.ts`

- [x] **Step 3: 实现注册表**（`TOOL_PRESENTATION` 全量替换；图标用现有 emoji 风格，动词人话）

```ts
export const TOOL_PRESENTATION: Record<string, ToolPresentation> = {
  // read（感知/检查）
  get_canvas_summary: { icon: '🔍', verb: '感知画布' },
  get_node: { icon: '🔍', verb: '查看节点' },
  get_generation_status: { icon: '⏱', verb: '查看生成状态' },
  get_generation_diagnostic: { icon: '🩺', verb: '诊断生成问题' },
  get_canvas_layout: { icon: '🗺', verb: '查看画布布局' },
  list_generation_tasks: { icon: '📋', verb: '查看生成任务' },
  list_user_assets: { icon: '📁', verb: '查看素材库' },
  // write（创作/编辑）
  upsert_prompt_node: { icon: '📝', verb: '写入节点' },
  upsert_media_node: { icon: '✏️', verb: '创建节点' },
  set_node_text: { icon: '✏️', verb: '编辑文案' },
  attach_refs: { icon: '📎', verb: '挂参考素材' },
  propose_generation: { icon: '🖼️', verb: '提议生成' },
  apply_sidebar_attachments: { icon: '📥', verb: '应用引用素材' },
  apply_asset_to_node: { icon: '🖼️', verb: '应用素材' },
  save_node_to_asset_library: { icon: '💾', verb: '存入素材库' },
  duplicate_node: { icon: '⧉', verb: '复制节点' },
  upload_media_to_canvas: { icon: '📤', verb: '上传素材' },
  grid_slice_image: { icon: '🔲', verb: '九宫格切图' },
  connect_nodes: { icon: '🔗', verb: '连接节点' },
  introduce_nodes_to_agent: { icon: '🧲', verb: '引入画布节点' },
  cancel_generation: { icon: '⏹', verb: '取消生成' },
  // ui_command / skill
  load_skill: { icon: '⚡', verb: '加载技能' },
  ask_user: { icon: '❓', verb: '向你确认' },
  arrange_nodes: { icon: '🪟', verb: '整理布局' },
  focus_node: { icon: '🎯', verb: '定位节点' },
  focus_nodes: { icon: '🎯', verb: '定位多个节点' },
  undo: { icon: '↩', verb: '撤销' },
  redo: { icon: '↪', verb: '重做' },
  open_image_editor: { icon: '🎨', verb: '打开图片编辑' },
}
```

`summarizeToolArgs` switch 追加（保持 24 字截断）：

```ts
    case 'upsert_prompt_node':
    case 'get_node':
    case 'duplicate_node':
      return typeof a.title === 'string' && a.title ? a.title.slice(0, ARGS_SUMMARY_MAX)
        : typeof a.node_id === 'string' && a.node_id ? a.node_id.slice(0, ARGS_SUMMARY_MAX) : undefined
    case 'set_node_text':
      return typeof a.text === 'string' && a.text ? a.text.slice(0, ARGS_SUMMARY_MAX) : undefined
    case 'connect_nodes':
      return Array.isArray(a.edges) && a.edges.length > 0 ? `${a.edges.length} 条连线` : undefined
    case 'attach_refs':
    case 'apply_sidebar_attachments':
      return Array.isArray(a.attachments ?? a.ref_keys) ? `${(a.attachments ?? a.ref_keys).length} 个素材` : undefined
    case 'grid_slice_image':
      return typeof a.node_id === 'string' ? a.node_id.slice(0, ARGS_SUMMARY_MAX) : undefined
    case 'load_skill':
    case 'ask_user':
    case 'focus_node':
      // load_skill 已有；ask_user/focus_node 取 question/node_id
      return typeof a.question === 'string' && a.question ? a.question.slice(0, ARGS_SUMMARY_MAX)
        : typeof a.node_id === 'string' && a.node_id ? a.node_id.slice(0, ARGS_SUMMARY_MAX) : undefined
    case 'focus_nodes':
    case 'arrange_nodes':
      return Array.isArray(a.node_ids) && a.node_ids.length > 0 ? `${a.node_ids.length} 个节点` : undefined
```

（其余 read 类 `get_*` / `list_*` 无关键人读字段，保持返回 undefined——卡上只显示动词。）

- [x] **Step 4: 运行确认通过 + 提交**

Run: `cd apps/web && pnpm exec vitest run src/components/agent/toolPresentation.test.ts src/components/agent/toolArgSummary.test.ts`

```bash
git add apps/web/src/components/agent/toolPresentation.ts apps/web/src/components/agent/toolPresentation.test.ts apps/web/src/components/agent/toolArgSummary.ts apps/web/src/components/agent/toolArgSummary.test.ts
git commit -m "feat(agent-web): 工具展示注册表与参数摘要全量覆盖"
```

### Task 5: ToolCallCard 工具调用卡（P1#3 展示层）

**Files:**
- Create: `apps/web/src/components/agent/ToolCallCard.vue`
- Create: `apps/web/src/components/agent/collapseToolCalls.ts`（纯函数）
- Modify: `apps/web/src/components/agent/AgentSideRail.vue:2487-2489`（灰字行替换为卡片）
- Test: `apps/web/src/components/agent/collapseToolCalls.test.ts`

**Interfaces:**
- Consumes: `AgentStreamMessage.toolCalls`（name/toolCallId/argsSummary/result）
- Produces: `collapseToolCalls(calls, minRun = 3): CollapsedToolCall[]`，`CollapsedToolCall = { name, argsSummary?, result?, count }`；ToolCallCard props `{ call: CollapsedToolCall }`

- [x] **Step 1: 写失败测试**

```ts
import { collapseToolCalls } from './collapseToolCalls';

it('merges >=3 consecutive same-name calls with a count', () => {
  const calls = [
    { name: 'get_node', argsSummary: 'A' },
    { name: 'get_node', argsSummary: 'B' },
    { name: 'get_node', argsSummary: 'C' },
    { name: 'upsert_media_node', argsSummary: 'D' },
  ];
  const out = collapseToolCalls(calls);
  expect(out).toHaveLength(2);
  expect(out[0]).toMatchObject({ name: 'get_node', count: 3 });
  expect(out[1]).toMatchObject({ name: 'upsert_media_node', count: 1 });
});

it('keeps 2 consecutive calls unmerged', () => {
  const out = collapseToolCalls([{ name: 'undo' }, { name: 'undo' }]);
  expect(out).toHaveLength(2);
});
```

- [x] **Step 2: 运行确认失败**

Run: `cd apps/web && pnpm exec vitest run src/components/agent/collapseToolCalls.test.ts`

- [x] **Step 3: 实现纯函数**

```ts
export interface CollapsedToolCall {
  name: string
  argsSummary?: string
  result?: unknown
  count: number
}

/** ≥minRun 次连续同名调用合并为一张计数卡；低频调用保持独立（避免低频操作被藏）。 */
export function collapseToolCalls(
  calls: Array<{ name: string; argsSummary?: string; result?: unknown }>,
  minRun = 3,
): CollapsedToolCall[] {
  const out: CollapsedToolCall[] = []
  let i = 0
  while (i < calls.length) {
    let j = i
    while (j + 1 < calls.length && calls[j + 1].name === calls[i].name) j++
    const runLen = j - i + 1
    if (runLen >= minRun) {
      out.push({ name: calls[i].name, count: runLen, result: calls[j].result })
      i = j + 1
    } else {
      for (let k = i; k <= j; k++) {
        out.push({ name: calls[k].name, argsSummary: calls[k].argsSummary, result: calls[k].result, count: 1 })
      }
      i = j + 1
    }
  }
  return out
}
```

- [x] **Step 4: 实现 ToolCallCard.vue**

```vue
<script setup lang="ts">
import { computed, ref } from 'vue'
import { presentToolStep } from '@/components/agent/toolPresentation'

const props = defineProps<{ call: { name: string; argsSummary?: string; result?: unknown; count: number } }>()
const expanded = ref(false)

const head = computed(() => {
  const hit = presentToolStep({ kind: 'tool', label: `调用 ${props.call.name} · ${props.call.argsSummary ?? ''}`, meta: { toolName: props.call.name, args: props.call.argsSummary } })
  return hit
})

const resultSummary = computed(() => {
  const r = props.call.result
  if (r == null) return undefined
  if (typeof r === 'string') return r.slice(0, 200)
  const m = (r as { message?: string }).message
  if (typeof m === 'string') return m.slice(0, 200)
  return JSON.stringify(r).slice(0, 200)
})

const hasDetail = computed(() => props.call.result != null)
</script>

<template>
  <div class="agent-tool-card text-[10px] text-[var(--neo-text-secondary)]">
    <button
      type="button"
      class="flex w-full items-center gap-1 text-left"
      :disabled="!hasDetail"
      @click="expanded = !expanded"
    >
      <span class="shrink-0">{{ head.icon }} {{ head.label }}</span>
      <span v-if="call.count > 1" class="shrink-0 opacity-70">× {{ call.count }}</span>
      <span v-if="hasDetail" class="shrink-0 opacity-60">{{ expanded ? '▾' : '▸' }}</span>
    </button>
    <pre v-if="expanded && hasDetail" class="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-black/20 px-1.5 py-1 text-[10px]">{{ resultSummary }}</pre>
  </div>
</template>
```

- [x] **Step 5: 替换 SideRail 灰字行**（`:2487-2489` 原 `<div v-if="msg.toolCalls?.length">…⚙ {{ tc.name }}…</div>` 整块替换）

```html
<div v-if="msg.toolCalls?.length" class="agent-tools mt-1 space-y-0.5 pt-1">
  <ToolCallCard
    v-for="(cc, i) in collapseToolCalls(msg.toolCalls)"
    :key="i"
    :call="cc"
  />
</div>
```

script 区 import：`import ToolCallCard from '@/components/agent/ToolCallCard.vue'`、`import { collapseToolCalls } from '@/components/agent/collapseToolCalls'`。

- [x] **Step 6: 测试 + 快照更新 + 提交**

Run: `cd apps/web && pnpm exec vitest run src/components/agent/ && pnpm exec tsc --noEmit`（快照测试若因灰字行→卡片 diff，逐条确认为新形态后 `-u` 更新）

```bash
git add apps/web/src/components/agent/ToolCallCard.vue apps/web/src/components/agent/collapseToolCalls.ts apps/web/src/components/agent/collapseToolCalls.test.ts apps/web/src/components/agent/AgentSideRail.vue apps/web/src/components/agent/__snapshots__/ 2>/dev/null; git add -u apps/web
git commit -m "feat(agent-web): 工具调用卡——可展开结果、计数合并、全量图标动词"
```

### Task 6: 阶段徽章（P1#4 前端聚合）

**Files:**
- Create: `apps/web/src/components/agent/phaseAggregator.ts`（纯函数）
- Modify: `apps/web/src/components/agent/AgentExecutionTrace.vue`（顶部徽章）
- Test: `apps/web/src/components/agent/phaseAggregator.test.ts`

**Interfaces:**
- Consumes: `ExecutionStep[]`（tool 步 meta.toolName）
- Produces: `derivePhase(steps): AgentPhase | null`，`AgentPhase = 'exploring' | 'creating' | 'wrapping'`；`PHASE_BADGE: Record<AgentPhase, {icon,label,cls}>`

- [x] **Step 1: 写失败测试**

```ts
import { derivePhase } from './phaseAggregator';
import { createExecutionTrace, applyToolCall } from './executionTraceReducer';

it('returns null for a trace with no tool steps', () => {
  expect(derivePhase(createExecutionTrace().steps)).toBeNull();
});

it('exploring for read tools, creating for write tools, wrapping after cancel', () => {
  const t = createExecutionTrace();
  applyToolCall(t, 'get_canvas_summary', { ok: 1 });
  expect(derivePhase(t.steps)).toBe('exploring');
  applyToolCall(t, 'upsert_media_node', { ok: 1 }, { toolCallId: 'w1' });
  applyToolCall(t, 'upsert_media_node', { ok: 1 }, { toolCallId: 'w1' });
  expect(derivePhase(t.steps)).toBe('creating');
  applyToolCall(t, 'cancel_generation', { ok: 1 });
  expect(derivePhase(t.steps)).toBe('wrapping');
});

it('unknown tool falls back to exploring without throwing', () => {
  const t = createExecutionTrace();
  applyToolCall(t, 'brand_new_tool', { ok: 1 });
  expect(derivePhase(t.steps)).toBe('exploring');
});
```

- [x] **Step 2: 运行确认失败**

Run: `cd apps/web && pnpm exec vitest run src/components/agent/phaseAggregator.test.ts`

- [x] **Step 3: 实现**

```ts
/** P1 阶段徽章：从 trace 步骤纯派生（不新增事件/状态；刷新后可从持久化 trace 恢复）。 */
import type { ExecutionStep } from '@/components/agent/executionTraceReducer'

export type AgentPhase = 'exploring' | 'creating' | 'wrapping'

const READ_TOOLS = new Set([
  'get_canvas_summary', 'get_node', 'get_generation_status', 'get_generation_diagnostic',
  'get_canvas_layout', 'list_generation_tasks', 'list_user_assets', 'load_skill',
  'ask_user', 'arrange_nodes', 'focus_node', 'focus_nodes', 'undo', 'redo', 'open_image_editor',
])
const WRITE_TOOLS = new Set([
  'upsert_prompt_node', 'upsert_media_node', 'set_node_text', 'attach_refs', 'propose_generation',
  'apply_sidebar_attachments', 'apply_asset_to_node', 'save_node_to_asset_library', 'duplicate_node',
  'upload_media_to_canvas', 'grid_slice_image', 'connect_nodes', 'introduce_nodes_to_agent',
])

export function derivePhase(steps: ExecutionStep[]): AgentPhase | null {
  const toolSteps = steps.filter((s) => s.kind === 'tool')
  if (toolSteps.length === 0) return null
  let phase: AgentPhase = 'exploring'
  for (const s of toolSteps) {
    const name = s.meta?.toolName ?? ''
    if (name === 'cancel_generation') { phase = 'wrapping'; continue }
    if (WRITE_TOOLS.has(name) || name.startsWith('run_')) phase = 'creating'
    else if (!READ_TOOLS.has(name)) { if (phase === 'exploring') phase = 'exploring' /* 未知工具不推进 */ }
  }
  return phase
}

export const PHASE_BADGE: Record<AgentPhase, { icon: string; label: string }> = {
  exploring: { icon: '🔍', label: '探索中' },
  creating: { icon: '🎨', label: '创作中' },
  wrapping: { icon: '📦', label: '收尾中' },
}
```

- [x] **Step 4: 徽章 UI**（AgentExecutionTrace.vue：headerLabel 按钮行内、`{{ headerLabel }}` 前插入）

```html
<span
  v-if="phaseBadge && streaming"
  class="mr-1 inline-flex items-center gap-0.5 rounded-full bg-[var(--neo-panel)] px-1.5 py-0.5 text-[10px]"
  data-testid="phase-badge"
>{{ phaseBadge.icon }} {{ phaseBadge.label }}</span>
```

script 追加：

```ts
import { derivePhase, PHASE_BADGE } from '@/components/agent/phaseAggregator'
const phaseBadge = computed(() => {
  const p = derivePhase(props.trace.steps)
  return p ? PHASE_BADGE[p] : null
})
```

- [x] **Step 5: 运行确认通过 + 提交**

Run: `cd apps/web && pnpm exec vitest run src/components/agent/phaseAggregator.test.ts src/components/agent/ && pnpm exec tsc --noEmit`

```bash
git add apps/web/src/components/agent/phaseAggregator.ts apps/web/src/components/agent/phaseAggregator.test.ts apps/web/src/components/agent/AgentExecutionTrace.vue
git commit -m "feat(agent-web): 阶段徽章——trace 纯派生三态（探索/创作/收尾）"
```

### Task 7: plan 标记解析 + Nest 派生 task 事件（P1#5 服务端半边）

**Files:**
- Create: `apps/server/src/agent/planMarkers.ts`（纯函数）
- Modify: `apps/server/src/agent/agent.service.ts:737-739`（text_delta 落点：strip + 派生）
- Test: `apps/server/src/agent/planMarkers.test.ts`

**Interfaces:**
- Consumes: text_delta 流
- Produces: `stripPlanMarkers(text): { text, plan?, doneN? }`；Nest 在 strip 出 plan 时 yield 既有类型 `{ type: 'task_list', data: { items: [{ id: 'plan-<n>', title, status: 'running' }] } }`、doneN 时 yield `{ type: 'task_update', data: { id: 'plan-<n>', status: 'done' } }`——前端 `AgentSideRail.vue:2012-2047` 既有 case 自动消费并持久化进 executionEvents（恢复链路免费获得）。**deviation 说明**：spec §2.2 写「派生 metadata 字段」，实现改为复用既有 task_list/task_update 事件类型（零生产者 → 接通），metadata 经 executionEvents 持久化自动达成，且 live 流式同步获得——比 spec 方案少一条独立通道，行为超集。

- [x] **Step 1: 写失败测试**

```ts
import { stripPlanMarkers } from './planMarkers';

it('strips plan marker and returns parsed items', () => {
  const r = stripPlanMarkers('开工\n⟦plan⟧[{"n":1,"title":"起稿"},{"n":2,"title":"配图"}]\n开始');
  expect(r.text).toBe('开工\n\n开始');
  expect(r.plan).toEqual([{ n: 1, title: '起稿' }, { n: 2, title: '配图' }]);
  expect(r.doneN).toBeUndefined();
});

it('strips task-done marker', () => {
  const r = stripPlanMarkers('完成\n⟦task-done⟧1\n继续');
  expect(r.text).toBe('完成\n\n继续');
  expect(r.doneN).toBe(1);
});

it('returns text byte-identical when no markers present', () => {
  const src = '普通回复，没有任何标记 ✓';
  expect(stripPlanMarkers(src).text).toBe(src);
});

it('malformed plan JSON: marker stripped, plan undefined, no throw', () => {
  const r = stripPlanMarkers('a\n⟦plan⟧{oops\nb');
  expect(r.text).toBe('a\n\nb');
  expect(r.plan).toBeUndefined();
});
```

- [x] **Step 2: 运行确认失败**

Run: `cd apps/server && pnpm exec vitest run src/agent/planMarkers.test.ts`

- [x] **Step 3: 实现**

```ts
/** P1#5 todo 面板：agent 文本内联计划标记（prompt 约定）解析。
 * 标记必须独占一行；strip 后标记行替换为空行，其余内容字节级不动。 */
const PLAN_RE = /^⟦plan⟧(.+)$/gm;
const DONE_RE = /^⟦task-done⟧(\d+)$/gm;

export interface PlanItem { n: number; title: string }

export function stripPlanMarkers(text: string): {
  text: string;
  plan?: PlanItem[];
  doneN?: number;
} {
  let plan: PlanItem[] | undefined;
  let doneN: number | undefined;
  let out = text.replace(PLAN_RE, (_m, body: string) => {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (Array.isArray(parsed) && parsed.every((it) => typeof it?.n === 'number' && typeof it?.title === 'string')) {
        plan = parsed as PlanItem[];
        return '';
      }
    } catch { /* malformed → 仍剥离 */ }
    return '';
  });
  out = out.replace(DONE_RE, (_m, n: string) => {
    doneN = Number(n);
    return '';
  });
  return { text: out, plan, doneN };
}
```

- [x] **Step 4: 接入 agent.service.ts**（text_delta 落点 `:737-739` 替换）

```ts
        if (ui.type === 'text_delta') {
          const rawText = (ui.data as { text: string }).text
          const stripped = stripPlanMarkers(rawText)
          assistantText += stripped.text
          ;(ui.data as { text: string }).text = stripped.text
          if (stripped.plan?.length) {
            const ev = {
              type: 'task_list',
              data: { items: stripped.plan.map((it) => ({ id: `plan-${it.n}`, title: it.title, status: 'running' })) },
            }
            executionEvents.push(ev)
            yield ev as AgentStreamEvent
          }
          if (stripped.doneN != null) {
            const ev = { type: 'task_update', data: { id: `plan-${stripped.doneN}`, status: 'done' } }
            executionEvents.push(ev)
            yield ev as AgentStreamEvent
          }
        }
```

import：`import { stripPlanMarkers } from './planMarkers'`。

- [x] **Step 5: system prompt 约定**（pi 路径 systemPrompt 组装处，`agent.service.ts` pi 分支的 prompt 文案尾部追加一段）

```
## 任务计划汇报（多步任务时启用）
多步出图/改造任务开工前，先单独一行输出计划标记（会被界面渲染为任务清单，用户可见）：
⟦plan⟧[{"n":1,"title":"起稿"},{"n":2,"title":"配图"}]
每完成一项，单独一行输出：⟦task-done⟧<n>
标记行之外不要解释标记本身；单步简单任务不要输出标记。
```

- [x] **Step 6: 运行确认通过 + 提交**

Run: `cd apps/server && pnpm exec vitest run src/agent/planMarkers.test.ts src/agent/pi-runtime/ && pnpm exec tsc --noEmit`

```bash
git add apps/server/src/agent/planMarkers.ts apps/server/src/agent/planMarkers.test.ts apps/server/src/agent/agent.service.ts
git commit -m "feat(agent): plan 内联标记→既有 task_list/task_update 事件（todo 面板数据源）"
```

### Task 8: TaskProgressCard 历史恢复接线（P1#5 前端半边）

**Files:**
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（`loadHistory` :1414-1435，从 metadata.executionEvents 播放 task 事件进 taskProgress）
- Test: `apps/web/src/components/agent/agentTaskProgress.test.ts`（已有 helper 测试文件则追加；无则新建设放 SideRail 抽出的纯函数）

**Interfaces:**
- Consumes: assistant message metadata.executionEvents 中的 `task_list` / `task_update`
- Produces: `seedTaskProgressFromEvents(events): TaskProgress | null`（SideRail script 抽出的纯函数，放 `agentTaskProgress.ts` 现有文件或新建）

- [x] **Step 1: 写失败测试**

```ts
import { seedTaskProgressFromEvents } from './agentTaskProgress';

it('seeds progress from persisted task events', () => {
  const p = seedTaskProgressFromEvents([
    { type: 'task_list', data: { items: [{ id: 'plan-1', title: '起稿', status: 'running' }] } },
    { type: 'task_update', data: { id: 'plan-1', status: 'done' } },
  ]);
  expect(p?.items).toHaveLength(1);
  expect(p?.items[0]).toMatchObject({ id: 'plan-1', status: 'done' });
  expect(p?.finished).toBe(true);
});

it('returns null when no task events present', () => {
  expect(seedTaskProgressFromEvents([{ type: 'text_delta', data: { text: 'x' } }])).toBeNull();
});
```

- [x] **Step 2: 运行确认失败**

Run: `cd apps/web && pnpm exec vitest run src/components/agent/agentTaskProgress.test.ts`

- [x] **Step 3: 实现**（`agentTaskProgress.ts` 追加；内部复用该文件既有 `applyTaskEvent` / `shouldFinishTaskCard`）

```ts
/** P1#5：从 assistant message metadata.executionEvents 播放 task 事件，恢复历史回合的任务卡。 */
export function seedTaskProgressFromEvents(
  events: Array<{ type: string; data: unknown }>,
): TaskProgress | null {
  const taskEvents = events.filter((e) => e.type === 'task_list' || e.type === 'task_update');
  if (taskEvents.length === 0) return null;
  let progress = emptyTaskProgress();
  for (const e of taskEvents) {
    progress = applyTaskEvent(progress, e as Parameters<typeof applyTaskEvent>[1]);
  }
  return shouldFinishTaskCard(progress, []) ? { ...progress, finished: true, summary: progress.summary ?? synthesizeSummary(progress) } : progress;
}
```

（若 `emptyTaskProgress` 等在 SideRail 内联定义，先原样搬进 `agentTaskProgress.ts` 并在 SideRail 改 import——本任务唯一的搬移，不顺手改其它。）

- [x] **Step 4: SideRail loadHistory 接线**（`:1428-1430` 之后追加）

```ts
    if (json.data?.length) {
      agent.loadHistory(json.data)
      const lastAssistant = [...json.data].reverse().find((m) => m.role === 'assistant')
      const meta = parseMessageMetadataSafe(lastAssistant?.metadata)
      if (meta?.executionEvents?.length) {
        const seeded = seedTaskProgressFromEvents(meta.executionEvents)
        if (seeded) taskProgress.value = seeded
      }
    }
```

（`parseMessageMetadataSafe` = store 现有 `parseMessageMetadata` 逻辑的本地轻量复刻：`try { JSON.parse } catch { undefined }`；不导出 store 内部函数，避免改 store 公共面。）

- [x] **Step 5: 运行确认通过 + 提交**

Run: `cd apps/web && pnpm exec vitest run src/components/agent/agentTaskProgress.test.ts && pnpm exec tsc --noEmit`

```bash
git add apps/web/src/components/agent/agentTaskProgress.ts apps/web/src/components/agent/agentTaskProgress.test.ts apps/web/src/components/agent/AgentSideRail.vue
git commit -m "feat(agent-web): 任务卡历史恢复——从 metadata.executionEvents 播放"
```

### Task 9: 产物缩略图（P1#6）

**Files:**
- Modify: `apps/web/src/components/agent/AgentCanvasOutputs.vue`（产出行加缩略图）
- Modify: `apps/web/src/components/agent/AgentSideRail.vue:2467-2472`（传入 node url 解析）

**Interfaces:**
- Consumes: `LinkedCanvasOutput { nodeId, title, nodeType, status }`（**契约不动**）+ SideRail `props.canvasNodes`（`CanvasNodeLike`，`n.data?.url`）作 url 源
- Produces: `AgentCanvasOutputs` 新 prop `resolveNodeUrl?: (nodeId: string) => string | undefined`

- [x] **Step 1: 实现 AgentCanvasOutputs 缩略图**（`<li>` 内 `DockTypeIcon` 前插入；script 增 prop 与 helper）

script 增：

```ts
const props = defineProps<{
  outputs: LinkedCanvasOutput[]
  resolveNodeUrl?: (nodeId: string) => string | undefined
}>()

const isVideoUrl = (url: string) => /\.(mp4|webm|mov)(\?|$)/i.test(url)
function nodeUrl(nodeId: string): string | undefined {
  return props.resolveNodeUrl?.(nodeId)
}
```

template：`<DockTypeIcon …>` 之前加：

```html
<span
  v-if="nodeUrl(item.nodeId) && item.status === 'done'"
  class="relative block h-7 w-7 shrink-0 overflow-hidden rounded border border-[var(--neo-border)]"
  data-testid="output-thumb"
>
  <video
    v-if="isVideoUrl(nodeUrl(item.nodeId)!)"
    :src="`${nodeUrl(item.nodeId)}#t=0.1`"
    muted
    preload="metadata"
    class="h-full w-full object-cover"
  />
  <img
    v-else
    :src="nodeUrl(item.nodeId)"
    :alt="item.title"
    loading="lazy"
    class="h-full w-full object-cover"
    @error="($event.target as HTMLImageElement).style.display = 'none'"
  />
  <span
    v-if="isVideoUrl(nodeUrl(item.nodeId)!)"
    class="absolute inset-0 flex items-center justify-center text-[9px] text-white/90"
  >▶</span>
</span>
```

- [x] **Step 2: SideRail 传入 resolver**（`:2467-2472`）

```html
<AgentCanvasOutputs
  v-if="msg.role === 'assistant' && (assistantOutputsById.get(msg.id)?.length ?? 0) > 0"
  :outputs="assistantOutputsById.get(msg.id) ?? []"
  :resolve-node-url="resolveCanvasNodeUrl"
  @focus-node="onFocusNode($event)"
  @focus-all="onFocusAll($event)"
/>
```

script 追加：

```ts
function resolveCanvasNodeUrl(nodeId: string): string | undefined {
  const node = props.canvasNodes?.find((n) => n.id === nodeId)
  const url = (node?.data as { url?: string } | undefined)?.url
  return typeof url === 'string' && url ? url : undefined
}
```

- [x] **Step 3: 组件测试 + 提交**

`AgentCanvasOutputs` 相关快照/组件测试更新（thumb 仅在 `resolveNodeUrl` 提供且 status=done 时渲染——无 url 历史消息自动降级现状）。Run: `cd apps/web && pnpm exec vitest run src/components/agent/ && pnpm exec tsc --noEmit`

```bash
git add apps/web/src/components/agent/AgentCanvasOutputs.vue apps/web/src/components/agent/AgentSideRail.vue apps/web/src/components/agent/__snapshots__/
git commit -m "feat(agent-web): 画布产出缩略图——图片/视频首帧，点击定位链路不变"
```

### Task 10: ask_user 刷新恢复（P1#7）

**Files:**
- Modify: `apps/server/src/agent/agent.service.ts`（tool_execution_end 派生 canvas_command 处 `:711-714`，ask_user 命令追加进 executionEvents）
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（`loadHistory` 恢复 pendingAskUser；已答判定）
- Test: `apps/server/src/agent/pi-runtime/pi-events.test.ts`（extractCanvasCommands 既有用例旁追加 service 级行为由 Task 7 同文件回归覆盖；前端以快照确认）

**Interfaces:**
- Consumes: `canvas_command { type: 'ask_user', questions }`（pi-events.ts:127 questions 已透传）
- Produces: metadata.executionEvents 含 ask_user 的 canvas_command → loadHistory 重建 `pendingAskUser`

- [x] **Step 1: Nest 持久化**（agent.service.ts `:711-714` 替换）

```ts
        if (event.type === 'tool_execution_end') {
          for (const cmd of extractCanvasCommands(event)) {
            // P1#7：ask_user 进 executionEvents → metadata 落库，刷新/重连后可恢复待答卡
            if (cmd.type === 'ask_user') {
              executionEvents.push({ type: 'canvas_command', data: cmd })
            }
            yield { type: 'canvas_command', data: cmd }
          }
```

- [x] **Step 2: SideRail loadHistory 恢复**（Task 8 Step 4 的同一段落内追加；直白实现）

```ts
      // P1#7：最后一回合若有未答 ask_user，恢复待答卡。
      // 仅当「最后一条 assistant 之后没有任何 user 消息」才恢复——有后续 user
      // 消息即视为已回答过，不恢复（避免旧问题卡复活）。
      const msgs = json.data as Array<{ role: string; metadata?: string }>
      const lastAssistantIdx = msgs.map((m) => m.role).lastIndexOf('assistant')
      const hasUserAfter = msgs.slice(lastAssistantIdx + 1).some((m) => m.role === 'user')
      const lastAssistantMsg = lastAssistantIdx >= 0 ? msgs[lastAssistantIdx] : undefined
      const meta2 = parseMessageMetadataSafe(lastAssistantMsg?.metadata)
      const askCmd = (meta2?.executionEvents ?? [])
        .filter((e) => e.type === 'canvas_command')
        .map((e) => e.data as { type?: string; questions?: typeof pendingAskUser.value })
        .find((c) => c.type === 'ask_user' && c.questions?.length)
      if (askCmd && !hasUserAfter) {
        pendingAskUser.value = askCmd.questions!
      }
```

恢复后 `AskUserCard` 既有渲染条件 `pendingAskUser.length && lastMessageIsAssistant`（:2538）自动成立。

- [x] **Step 3: 回归验证**（ask_user 正常流不受影响：发送后 `sendMessage:1601` 清空逻辑不变）

Run: `cd apps/server && pnpm exec vitest run src/agent/ && cd ../../apps/web && pnpm exec vitest run src/components/agent/ && pnpm exec tsc --noEmit`

- [x] **Step 4: 提交**

```bash
git add apps/server/src/agent/agent.service.ts apps/web/src/components/agent/AgentSideRail.vue
git commit -m "feat(agent): ask_user 刷新/重连恢复——questions 落 metadata.executionEvents"
```

### Task 11: 重连 reconcile 去 snippet 化（P1#11）

**Files:**
- Modify: `apps/web/src/components/agent/AgentSideRail.vue:1842-1922`（`reconcileLatestAssistant` 重写）
- Test: 抽出判定纯函数到 `apps/web/src/components/agent/streamRecovery.ts`（既有文件）并测

**Interfaces:**
- Consumes: `GET /api/agent/thread-state` 的 `data.finished` / `data.phase`（reconnectStream :1761-1781 已消费同形状）
- Produces: `shouldKeepReconciling(threadState, polls): boolean` 纯函数

- [x] **Step 1: 写失败测试**（streamRecovery.test.ts 追加）

```ts
import { shouldKeepReconciling } from './streamRecovery';

it('stops immediately when thread-state reports finished', () => {
  expect(shouldKeepReconciling({ finished: true }, 0)).toBe(false);
});

it('keeps polling while unfinished and under the cap', () => {
  expect(shouldKeepReconciling({ finished: false }, 3)).toBe(true);
  expect(shouldKeepReconciling({ finished: false }, 36)).toBe(false);
});

it('treats missing thread-state as keep-polling until cap', () => {
  expect(shouldKeepReconciling(null, 10)).toBe(true);
});
```

- [x] **Step 2: 运行确认失败**

Run: `cd apps/web && pnpm exec vitest run src/components/agent/streamRecovery.test.ts`

- [x] **Step 3: 实现纯函数**（streamRecovery.ts 追加）

```ts
/** P1#11：reconcile 轮询续停判定——thread-state 终态优先，缺失时按上限兜底。 */
export function shouldKeepReconciling(
  threadState: { finished?: boolean | null } | null,
  polls: number,
): boolean {
  if (threadState?.finished) return false
  return polls < 36
}
```

- [x] **Step 4: 重写 reconcileLatestAssistant**（保留 `pull()` 原样；轮询循环改为）

```ts
  try {
    await pull()
    // P1#11：以 thread-state 回合终态替代文本 snippet 匹配（BUSY_TIP/EXEC_PROGRESS/COPY_WRITTEN 删除）
    for (let i = 0; i < 36; i++) {
      const st = await fetchThreadStateSafe()
      if (!shouldKeepReconciling(st, i)) break
      await new Promise((r) => setTimeout(r, 5_000))
      await pull()
      scrollToBottom()
    }
  } catch {
    // ignore
  }
```

新增 helper（复用 reconnectStream 的 fetch 形状）：

```ts
async function fetchThreadStateSafe(): Promise<{ finished?: boolean | null } | null> {
  try {
    const token = localStorage.getItem('token')
    const res = await fetch(
      apiUrl(`/api/agent/thread-state?threadId=${encodeURIComponent(agentThreadId.value)}`),
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const json = await res.json()
    return (json?.data ?? null) as { finished?: boolean | null } | null
  } catch {
    return null
  }
}
```

删除常量 `BUSY_TIP_SNIPPET` / `EXEC_PROGRESS_SNIPPET` / `COPY_WRITTEN_SNIPPET` 及 `shouldPollRuntimeHealth` 轮询内使用（`RUNTIME_UNREACHABLE_SNIPPET` 在 sendMessage finally 仍用，**保留**）。

- [x] **Step 5: 回归 + 提交**

Run: `cd apps/web && pnpm exec vitest run src/components/agent/streamRecovery.test.ts && pnpm exec tsc --noEmit`

```bash
git add apps/web/src/components/agent/AgentSideRail.vue apps/web/src/components/agent/streamRecovery.ts apps/web/src/components/agent/streamRecovery.test.ts
git commit -m "refactor(agent-web): 重连 reconcile 改 thread-state 终态判定，去 snippet 文本匹配"
```

---

## Batch P2

### Task 12: mermaid 真渲染（P2#8）

**Files:**
- Create: `apps/web/src/components/agent/AgentMermaidBlock.vue`
- Modify: `apps/web/src/components/agent/AgentTopoCardList.vue`（mermaid `<details><pre>` 处替换，渲染失败降级回 `<pre>`）
- Modify: `apps/web/package.json`（`"mermaid": "^11"`）
- Test: `apps/web/src/components/agent/AgentMermaidBlock.test.ts`

**Interfaces:**
- Produces: `AgentMermaidBlock` props `{ source: string }`；渲染成功 → SVG；失败/加载失败 → `<pre>` 原文（现状降级形态）

- [x] **Step 1: 写失败测试**

```ts
import { mount } from '@vue/test-utils';
import AgentMermaidBlock from './AgentMermaidBlock.vue';

it('renders fallback pre immediately before mermaid resolves', () => {
  const w = mount(AgentMermaidBlock, { props: { source: 'graph TD; A-->B' } });
  expect(w.find('pre').exists()).toBe(true);
});
```

- [x] **Step 2: 运行确认失败**

Run: `cd apps/web && pnpm exec vitest run src/components/agent/AgentMermaidBlock.test.ts`

- [x] **Step 3: 安装依赖 + 实现组件**

```bash
cd apps/web && pnpm add mermaid@^11
```

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'

const props = defineProps<{ source: string }>()
const failed = ref(false)
const el = ref<HTMLDivElement | null>(null)
let renderId = 0

onMounted(async () => {
  try {
    const mermaid = (await import('mermaid')).default
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
    const id = `agent-mermaid-${++renderId}`
    const { svg } = await mermaid.render(id, props.source)
    if (el.value) el.value.innerHTML = svg
  } catch {
    failed.value = true // 降级：保持 <pre> 原文
  }
})
</script>

<template>
  <div v-if="failed" class="agent-mermaid-fallback"><pre class="whitespace-pre-wrap text-[10px] opacity-70">{{ source }}</pre></div>
  <div v-show="!failed" ref="el" class="agent-mermaid text-[var(--neo-fg)]" data-testid="mermaid-svg" />
  <pre v-show="failed" class="whitespace-pre-wrap text-[10px] opacity-70">{{ source }}</pre>
</template>
```

（注：失败时两个降级 pre 二选一保留一个即可，实施时删冗余——保留 `v-if="failed"` 分支。）

- [x] **Step 4: 接入 AgentTopoCardList**（mermaid `<details>` 块替换为）

```html
<AgentMermaidBlock v-if="item.mermaid" :source="item.mermaid" />
```

（`details/pre` 原样保留在组件降级分支内，外层直接换用新组件；字段名以 `AgentTopoCardList.vue` 实际 mermaid 字段为准，实施时 grep `mermaid` 定位。）

- [x] **Step 5: 测试 + 提交**

Run: `cd apps/web && pnpm exec vitest run src/components/agent/AgentMermaidBlock.test.ts && pnpm exec tsc --noEmit`

```bash
git add apps/web/src/components/agent/AgentMermaidBlock.vue apps/web/src/components/agent/AgentMermaidBlock.test.ts apps/web/src/components/agent/AgentTopoCardList.vue apps/web/package.json pnpm-lock.yaml
git commit -m "feat(agent-web): mermaid 真渲染——懒加载 + 失败降级 pre 源码"
```

### Task 13: 死代码清理（P2#10）

**Files:**
- Delete: `apps/web/src/components/agent/AgentPanel.vue`、`apps/web/src/components/agent/AgentFloatingWindow.vue`
- Modify: `apps/server/src/agent/agent-canvas-tools.controller.ts`（getGenProgress 端点 + DTO 删）、`apps/server/src/agent/agent-canvas-tools.service.ts`（getGenProgress 方法删）
- Modify: `packages/shared/src/agentContract.ts`（gen_progress 契约删）
- Modify: `apps/web/src/composables/useAgentStream.ts`（PHASE_LABELS 瘦身：仅保留重连恢复实际产出 phase 值的键）
- Modify: `packages/shared/src/agentTrace.ts`（journeyTrace 死契约删）

- [x] **Step 1: 删前 grep 复核（铁律）**

```bash
grep -rn "AgentPanel\|AgentFloatingWindow" apps/web/src --include="*.vue" --include="*.ts" | grep -v "canOpenAgentPanel\|agent-panel\b" || echo "CLEAN"
grep -rn "genProgress\|gen_progress\|GetGenProgress" apps packages --include="*.ts" | grep -v node_modules
grep -rn "journeyTrace" apps packages --include="*.ts" | grep -v node_modules
```

Expected: AgentPanel/FloatingWindow 仅组件自身文件命中（CLEAN）；genProgress 命中限于 controller/service/contract/prisma schema（schema 保留）；journeyTrace 仅 agentTrace.ts 定义处。有额外消费方 → 停止该子项并在 PR 描述登记。

- [x] **Step 2: 执行删除**

```bash
git rm apps/web/src/components/agent/AgentPanel.vue apps/web/src/components/agent/AgentFloatingWindow.vue
```

controller/service/contract：删除 getGenProgress 端点、`GetGenProgressDto`、service 方法、contract schema/type export；`useAgentStream.ts` PHASE_LABELS 删除 pi 路径永不产出的键（`intake/plan/write_plan_node/split/draft_copy/await_copy_confirm/write_copy_node/await_topo/await_atomic_confirm/atomic_parse/atomic_create`——保留 `await_confirm/orchestrate_gen/done/error/await_*` 中 thread-state 实际回读的键；实施时以 `grep -rn "formatPhaseLabel\|PHASE_LABELS" apps/web/src` 的消费方反推白名单）；`agentTrace.ts` 删 journeyTrace 类型与导出。

- [x] **Step 3: 全量回归**

Run: `pnpm exec tsc --noEmit && cd apps/server && pnpm exec vitest run src/agent/ && cd ../../apps/web && pnpm exec vitest run src/`

Expected: 全绿；若快照/测试引用被删导出，属预期失败，随删随修（不改行为）。

- [x] **Step 4: spec 登记核对 + 提交**

核对 spec §9 表格与实际删除一致；更新 `docs/superpowers/specs/2026-09-28-agent-conversation-ux-p0-p2-design.md` §9 加「已执行」标记列。

```bash
git add -A
git commit -m "chore(agent): 死代码清理——AgentPanel/FloatingWindow、gen_progress、journeyTrace、PHASE_LABELS 瘦身"
```

---

## 收尾（分支级）

- [x] **全量验证**：`pnpm exec tsc --noEmit` + `cd apps/web && pnpm exec vitest run src/` + `cd apps/server && pnpm exec vitest run src/agent/`
- [x] **落盘复核**：`git status` 确认全部改动已入库（` M`/`A`/`D`）
- [x] **PR**：单 PR，描述按 P0/P1/P2 三段列改动与测试证据；合并遵守部署串行纪律（deploy 队列未清空不合并）
