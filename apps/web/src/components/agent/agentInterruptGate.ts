/** @vitest-environment node */

/**
 * 侧栏可见文本过滤 + 「运行已停止」判定。
 *
 * 2026-10-06 大清理：本文件原先叫「interrupt gate」，其中承载确认卡片
 * （gate 相位 → chipSet → 确认 / 取消按钮）与产品视觉门控（方案 / 镜头 / 交付选型）
 * 的大半代码已整体删除 —— 那些 UI 的触发源（`interrupt` 事件、`done` 事件、
 * `GET /agent/thread-state` 回灌）在 pi 链路上都没有生产者
 * （thread-state 恒返 null，见 `AgentSideRail.refreshThreadCheckpoint`），属不可达死代码。
 *
 * 保留下来的只有三件事：
 *   1. `isRunCancelledState` —— `run_cancelled` 的终态判定，仍在用；
 *   2. 可见文本过滤 —— 历史消息里 LangGraph 时代的机器载荷仍会被渲染，必须继续过滤；
 *   3. `ProductVisualMacroScheme` 类型 —— 消息 presentation 的宏观方案卡仍在用
 *      （`presentation/AgentMacroSchemeCards.vue`，经 `AgentPresentationHost` 渲染）。
 */

export interface RunCancelledStateInput {
  phase?: string | null
  runCancelled?: boolean | null
}

export function isRunCancelledState(
  state: RunCancelledStateInput | null | undefined,
): boolean {
  if (!state) return false
  return state.runCancelled === true || state.phase === 'cancelled'
}

/** 消息 presentation 的宏观方案卡条目（AgentMacroSchemeCards.vue）。 */
export interface ProductVisualMacroScheme {
  id: string
  label?: string | null
  summary?: string | null
  tags?: string[] | null
  recommended?: boolean
  recommend_reason?: string | null
}

/**
 * 旧门控流程的机器载荷前缀：**只用于过滤历史消息**，已无产出方。
 *
 * 历史对话里用户气泡可能整段是这些 JSON（点击旧版方案/交付确认按钮时发出的载荷），
 * 不滤掉就会裸露给用户看，因此字符串常量必须保留。
 */
const MACHINE_PAYLOAD_PREFIXES = [
  '__scheme_decision__',
  '__macro_scheme_decision__',
  '__delivery_decision__',
  '__new_task__',
] as const

const INTERNAL_QA_ERROR_SNIPPETS = [
  '识图模型返回格式异常',
  'vision_format_error',
  'format_error',
] as const

function lineHasMachinePayload(line: string): boolean {
  const trimmed = line.trimStart().replace(/^["']+|["']+$/g, '')
  return MACHINE_PAYLOAD_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

function filterMachinePayloadLines(content: string): string {
  return content
    .split('\n')
    .filter((line) => !lineHasMachinePayload(line))
    .join('\n')
    .trim()
}

/** Strip machine-only resume payloads from visible text (spec §2.3). */
export function filterUserVisibleText(content: string): string {
  return filterMachinePayloadLines(content)
}

/** True when bubble content is only machine resume JSON (hide user/assistant bubble). */
export function isMachineOnlyVisibleText(content: string): boolean {
  return !filterMachinePayloadLines(content).trim()
}

const INTERNAL_ASSISTANT_SNIPPETS = [
  ...INTERNAL_QA_ERROR_SNIPPETS,
  'dialog_draft_parse_failed',
  'shot_manifest_missing',
  'decompose_shots_parse_failed',
  'macro_schemes_missing',
  'vision_format_error',
  '"toolCalls"',
  '"toolName"',
  'has 11 shots',
  "macro '",
] as const

function stripBareFlowEndCode(line: string): string {
  const m = line.match(/^流程结束[。.]\s*([a-z_][a-z0-9_.]*)\s*$/i)
  if (m) return '流程未能完成，请补充说明后重试。'
  return line.replace(/^流程结束[。.]\s*/, '').trim() || line
}

/** Strip machine payloads and internal QA error strings from assistant visible text. */
export function filterAssistantVisibleText(content: string): string {
  return filterMachinePayloadLines(content)
    .split('\n')
    .map(stripBareFlowEndCode)
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed) return false
      return !INTERNAL_ASSISTANT_SNIPPETS.some((snippet) => trimmed.includes(snippet))
    })
    .join('\n')
    .trim()
}
