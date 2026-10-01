import { describe, expect, it } from 'vitest'
import { presentToolStep, timelineHeadline, collapsedDefault, TOOL_PRESENTATION } from '@/components/agent/toolPresentation'
import { createExecutionTrace, applyToolCall } from '@/components/agent/executionTraceReducer'
import type { ExecutionStep } from '@/components/agent/executionTraceReducer'

const step = (partial: Partial<ExecutionStep> & { meta?: ExecutionStep['meta'] }): ExecutionStep => ({
  id: 's1',
  kind: 'tool',
  label: '',
  status: 'done',
  startedAt: 0,
  ...partial,
}) as ExecutionStep

describe('toolPresentation（P1 注册表）', () => {
  it('注册表命中：读工具人话化', () => {
    expect(presentToolStep(step({ label: '调用 get_canvas_summary', status: 'done', meta: { toolName: 'get_canvas_summary', args: '3 个节点' } })))
      .toEqual({ icon: '🔍', label: '感知画布 · 3 个节点' })
    expect(presentToolStep(step({ label: '', status: 'running', meta: { toolName: 'propose_generation', args: '2 个节点' } })))
      .toEqual({ icon: '🖼️', label: '提议生成 · 2 个节点' })
  })
  it('run_ 前缀与未知工具兜底（P0 决策 5：未知一律降级「处理中」，不吐内部名）', () => {
    expect(presentToolStep(step({ status: 'done', meta: { toolName: 'run_image_generation' } })).icon).toBe('🎨')
    expect(presentToolStep(step({ status: 'done', meta: { toolName: 'run_image_generation' } })).label)
      .toBe('生成 · image_generation')
    expect(presentToolStep(step({ status: 'done', meta: { toolName: 'mystery_tool' } })))
      .toEqual({ icon: '⚙', label: '处理中' })
  })
  it('meta.args 缺失时从 label 后缀解析（reducer 只把 args 写进 label）', () => {
    expect(presentToolStep(step({ label: '调用 get_canvas_summary · 3 个节点', meta: { toolName: 'get_canvas_summary' } })))
      .toEqual({ icon: '🔍', label: '感知画布 · 3 个节点' })
  })
  it('timelineHeadline：N 步 · 最新一步人话', () => {
    const trace = createExecutionTrace()
    applyToolCall(trace, 'get_canvas_summary', { status: 'ok' }, { args: '3 个节点' })
    applyToolCall(trace, 'propose_generation', { status: 'pending_confirm' }, { args: '3 个节点' })
    expect(timelineHeadline(trace)).toBe('2 步 · 最新：🖼️ 提议生成 · 3 个节点')
  })
  it('thinking 步：图标 🧠（非工具调用，不落 ⚙ 兜底）', () => {
    expect(presentToolStep(step({ kind: 'thinking', label: '思考中…', status: 'running' }))).toEqual({
      icon: '🧠',
      label: '思考中…',
    })
  })
  it('timelineHeadline：thinking 为最新一步时头行用 🧠', () => {
    const trace = createExecutionTrace()
    applyToolCall(trace, 'get_canvas_summary', { status: 'ok' }, { args: '3 个节点' })
    // 头行取「最新」= 可见步骤的最后一个；thinking 在其后即为最新
    trace.steps.push({
      id: 'thinking:parse',
      kind: 'thinking',
      label: '思考中…',
      status: 'running',
      startedAt: 0,
    })
    expect(timelineHeadline(trace)).toBe('2 步 · 最新：🧠 思考中…')
    // 仅一步（回合开头只有思考）时同样用 🧠——此前会落成 ⚙「思考中…」兜底
    const only = createExecutionTrace()
    only.steps.push({
      id: 'thinking:parse',
      kind: 'thinking',
      label: '思考中…',
      status: 'running',
      startedAt: 0,
    })
    expect(timelineHeadline(only)).toBe('1 步 · 最新：🧠 思考中…')
  })
  it('collapsedDefault：v1 固定默认折叠', () => {
    expect(collapsedDefault).toBe(true)
  })
})

describe('TOOL_PRESENTATION 全量覆盖（P1#3）', () => {
  const ALL_LOCAL_TOOLS = [
    'get_canvas_summary', 'get_node', 'get_generation_status', 'get_generation_diagnostic',
    'get_canvas_layout', 'list_generation_tasks', 'list_user_assets',
    'upsert_prompt_node', 'upsert_media_node', 'set_node_text', 'attach_refs', 'propose_generation',
    'apply_sidebar_attachments', 'apply_asset_to_node', 'save_node_to_asset_library', 'duplicate_node',
    'upload_media_to_canvas', 'grid_slice_image', 'connect_nodes', 'introduce_nodes_to_agent',
    'cancel_generation', 'load_skill', 'ask_user', 'arrange_nodes',
    'focus_node', 'focus_nodes', 'undo', 'redo', 'open_image_editor',
    // P0 决策 5 补齐：B-N 批次后注册的运行时工具（权威清单见 services/pi-runtime/src/tools/*.ts）
    'delete_nodes', 'remove_edges', 'read_document', 'save_memory', 'recall_memory',
    'update_node', 'list_model_options', 'web_search', 'web_fetch',
  ] as const

  it('每个本地 runtime 工具都有展示条目', () => {
    for (const name of ALL_LOCAL_TOOLS) {
      expect(TOOL_PRESENTATION[name], `missing presentation for ${name}`).toBeDefined()
    }
  })

  it('运行时探针 t_probe 不进展示注册表（内部探针，禁止吐给用户）', () => {
    expect(TOOL_PRESENTATION.t_probe).toBeUndefined()
  })
})
