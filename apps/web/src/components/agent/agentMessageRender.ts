/**
 * AgentSideRail 消息渲染判据（纯函数模块）。
 *
 * Phase 3（AgentSideRail God Component 拆解）第二刀：把「消息是否可渲染 / 应不应该放行气泡 /
 * 内容可见性过滤 / svg_card 与 node_graph 载荷收窄」这一簇**与组件状态无关的纯函数**从
 * AgentSideRail.vue 抽到本模块。
 *
 * 行为保持（逐字迁移，非重写）；组件侧 `import { ... } from './agentMessageRender'`
 * 后，模板与脚本的所有调用点（含 `useTimeline` 在模板的多处 `v-if`）名字不变。
 */

import type { AgentStreamMessage } from '@/stores/agent'
import { filterAssistantVisibleText, filterUserVisibleText } from '@/components/agent/agentInterruptGate'
import { isSystemEventText } from '@/components/agent/systemEventRender'
import { hasSchemeDraftSections, splitAssistantDraftMessage } from '@/components/agent/presentation/schemeDraftProse'
import type { AgentPresentationEnvelope } from '@/components/agent/presentation/types'
import { hasActionableWait, hasBubbleContent, hasBubbleText } from '@/components/agent/bubbleVisibility'
import { turnSummaryLine } from '@/components/agent/executionTraceReducer'

/** 宿主回注的系统事件消息（spec §6.4，PR3）：前缀判据唯一实现在 systemEventRender.ts。 */
export function isUserSystemEvent(msg: AgentStreamMessage): boolean {
  return msg.role === 'user' && isSystemEventText(msg.content ?? '')
}

export function visibleAssistantContent(msg: AgentStreamMessage): string {
  if (msg.role !== 'assistant') return msg.content ?? ''
  return filterAssistantVisibleText(msg.content ?? '')
}

export function visibleUserContent(msg: AgentStreamMessage): string {
  if (msg.role !== 'user') return msg.content ?? ''
  return filterUserVisibleText(msg.content ?? '')
}

/** 带着可渲染 svg_card 的消息：`body.svg` 收窄为 `string`（非 `string | undefined`）。 */
export type SvgCardMessage = AgentStreamMessage & {
  presentation: AgentPresentationEnvelope & { body: { svg: string } }
}

/**
 * 该轮是否带着一张可渲染的 svg_card（spec §4.6）。
 *
 * **门禁与挂载点共用的唯一判据**：气泡放行（`shouldShowMessageBubbleText`）与模板
 * `v-if` 都调它，两处因此不可能漂移。改条件只改这一处。
 *
 * 写成类型谓词（`msg is SvgCardMessage`）而非 `boolean`：挂载点的 `:svg` 绑定需要
 * `body.svg` 已收窄为 `string`，判据一旦抽成函数，模板内的自动收窄就不会再生效。
 *
 * ⚠️ 判据用 `!== undefined` 而非真值，与 switch 分支同因：服务端超 SVG_MAX_CHARS 时
 * 下发 `svg: ""`（字段在、值为空），那张卡有专属的「已丢弃」可见文案，必须照样上屏。
 */
export function hasRenderableSvgCard(msg: AgentStreamMessage): msg is SvgCardMessage {
  return msg.role === 'assistant'
    && msg.presentation?.kind === 'svg_card'
    && msg.presentation.body?.svg !== undefined
}

/** 带着可渲染 `node_graph` 的消息（结构化载荷，Vue Flow 渲染）。 */
export type NodeGraphMessage = AgentStreamMessage & {
  presentation: AgentPresentationEnvelope & { kind: 'node_graph' }
}

/**
 * 有 node_graph 的助手轮次（2026-07）。
 *
 * ⚠️ **A 方案：node_graph 优先、svg_card 降级**（重放侧见 `stores/agent.ts` 的 `??` 左偏）。
 * 这里只判"有没有"，两条都在时由模板 `v-if` / `v-else-if` 的顺序决定优先级。
 */
export function hasRenderableNodeGraph(msg: AgentStreamMessage): msg is NodeGraphMessage {
  return msg.role === 'assistant'
    && msg.presentation?.kind === 'node_graph'
    && Array.isArray((msg.presentation.body as { graph_nodes?: unknown } | undefined)?.graph_nodes)
}

export type NodeGraphPayload = import('@/components/agent/presentation/AgentNodeGraph.vue').GraphPayload

/**
 * 把消息里的 node_graph 载荷取出来，供 expand / import 两个 emit 用。
 *
 * ⚠️ `graph_nodes` 在共享 body 类型里是 `NodeGraphBodyPayload['nodes']`
 *   （不是 `unknown[]`）—— 这里只需把可能为 `undefined` 的字段兜成空数组。
 */
export function nodeGraphPayload(msg: AgentStreamMessage): NodeGraphPayload {
  const body = msg.presentation?.body
  return {
    nodes: body?.graph_nodes ?? [],
    edges: body?.graph_edges ?? [],
    title: body?.nodeGraphTitle ?? msg.presentation?.title,
  }
}

/**
 * P0 决策 2：零内容不渲染气泡（判定在 bubbleVisibility.ts，纯函数可单测）。
 * 阻塞等待期不产生 token，旧实现「流式恒 true」会留下一个空白气泡 + 闪烁光标 = 白块。
 *
 * ⚠️ 例外仅一处：带着可渲染 svg_card 的助手轮次。卡片区（含 AgentSvgCard）整体位于本
 * 门禁的 `v-if` 内，而 svg_card 可能是那一轮的**全部**产出（agent 只调 render_canvas_view
 * 而不说话）——不放行就等于卡片静默不可见（PR #65 同类失效）。
 * 例外只认「有卡片」，无卡片仍走 hasBubbleContent ⇒ P0 白块修复不受影响。
 */
export function shouldShowMessageBubbleText(msg: AgentStreamMessage): boolean {
  // ⚠️ node_graph 与 svg_card 同为「卡片即全部产出」的情形（agent 只调 render_canvas_view 不说话）
  //   ⇒ 两者都要放行，否则卡片静默不可见（PR #65 同类失效）。
  // ⚠️ B3（2026-10-31 蝌蚪回合实证）：阻塞等待回合零 token，proposal/question part 是
  //   那一轮的全部用户产出（内联确认卡/题卡）——不放行 = 确认卡在对话流静默不可见。
  // ⚠️ 流式归一（2026-11-03）：live 消息不再有钉底/镜像块兜底，timeline/trace 内容卡
  //   （纯工具轮的执行过程、机器载荷轮的产物卡）只能活在气泡壳内——确有可渲染
  //   part/step 时必须放行，否则整轮静默不可见。空 timeline/trace 仍不放行
  //   ⇒ P0 白块修复不受影响（B3 覆盖 actionable wait，此条覆盖其余非空内容卡）。
  // ⚠️ 流式归一补位（2026-11-03 移动端复测）：live 流式消息恒放行气泡壳——钉底块退役后
  //   「正在准备…」兜底文案随 dense 头（AgentExecutionTrace denseHeadline）一起消失，
  //   发消息后到首个 timeline part（【思考】）之间的空窗期什么都不渲染。
  //   P0 语义同步演进：反对的是「空白气泡+闪烁光标」，不是「有反馈的占位」——
  //   壳内有「正在准备…」文案（见 isPreparingPlaceholder），不再是白块；
  //   回合结束 streaming 翻 false（finishStreaming），占位随之消失。
  return (
    hasBubbleContent(msg) ||
    hasRenderableSvgCard(msg) ||
    hasRenderableNodeGraph(msg) ||
    hasActionableWait(msg) ||
    Boolean(msg.timeline?.parts?.length) ||
    Boolean(msg.executionTrace?.steps?.length) ||
    Boolean(msg.streaming)
  )
}

/**
 * 流式归一补位（2026-11-03 移动端复测）：live 且零可渲染内容时的「正在准备…」占位判定。
 * 与门控放行（msg.streaming）成对：壳被放行但正文/内容卡都还没到时显示占位文案，
 * 首个 part（【思考】）或正文到达后自然被取代——同一壳内换内容，无布局跳变。
 * 排除项 = 一切「已有可见产出」的形态：正文、时间线 part、旧 trace 步骤、svg/node 卡。
 */
export function isPreparingPlaceholder(msg: AgentStreamMessage): boolean {
  return (
    msg.role === 'assistant' &&
    Boolean(msg.streaming) &&
    !hasBubbleText(msg) &&
    !useTimeline(msg) &&
    !(msg.executionTrace?.steps?.length) &&
    !hasRenderableSvgCard(msg) &&
    !hasRenderableNodeGraph(msg)
  )
}

/**
 * P1（agent-turn-timeline-design §5-P1）：时间线渲染判定。根治规格 2026-10-28 起时间线
 * 成为唯一渲染路径（flag 已移除），不再有旧 trace / 独立正文 / 独立产物的并行拼装。
 * 该条 assistant 消息是否用时间线渲染（确有 timeline）。
 */
export function useTimeline(msg: AgentStreamMessage): boolean {
  return msg.role === 'assistant' && Boolean(msg.timeline)
}

/**
 * 方案草稿散文（有结构化小节时改用 AgentProseBlock 排版）。
 * 2026-10-06：原「产品视觉 V2 开关 + 草稿小节」双条件随门控一起下线，
 * 现在只按结构化小节判定 —— 与方案卡片无关，是纯排版选择。
 */
export function shouldRenderSchemeDraftProse(msg: AgentStreamMessage): boolean {
  if (msg.role !== 'assistant' || msg.streaming) return false
  const { prose } = splitAssistantDraftMessage(msg.content ?? '')
  return hasSchemeDraftSections(prose)
}

export function canReuseTurn(msg: AgentStreamMessage): boolean {
  if (msg.role !== 'user') return false
  return Boolean(msg.content?.trim()) || (msg.attachments?.length ?? 0) > 0
}


/**
 * 历史消息 presentation 派生（纯函数，与组件状态无关）。
 * Phase 3 第三刀：从 AgentSideRail.vue 抽到本模块，与消息渲染判据同库。
 */

/** 历史 assistant 消息的 presentation 是否进入 Host stepper 布局；svg_card 走独立挂载（AgentSvgCard），不进 stepper（spec §4.6）。 */
export function historyPresentation(msg: AgentStreamMessage): AgentPresentationEnvelope | null {
  if (msg.role !== 'assistant' || msg.streaming || !msg.presentation) return null
  // svg_card 走独立挂载（紧邻本函数调用点的 AgentSvgCard），不进 Host 的 stepper 布局：
  // 落库重放路径不恢复 stepper，进了只会渲染一条空进度条。spec §4.6。
  if (msg.presentation.kind === 'svg_card') return null
  return msg.presentation
}

export function historyMacroSelectedIds(presentation: AgentPresentationEnvelope): string[] {
  const schemes = presentation.body?.schemes ?? []
  const recommended = schemes.filter((s) => s.recommended).map((s) => String(s.id))
  if (recommended.length) return recommended
  const maxSelect = presentation.body?.max_select ?? 2
  return schemes.slice(0, maxSelect).map((s) => String(s.id))
}

/**
 * P0（agent-turn-timeline-design §5 P0-4）：回合摘要行（节点/张数/耗时/tokens）。
 * 仅在本回合**已结束**（非 streaming）且确有 trace 时给出，供模板在产物之后渲染。
 */
export function bubbleSummaryLine(msg: AgentStreamMessage): string | null {
  if (msg.role !== 'assistant' || msg.streaming || !msg.executionTrace) return null
  return turnSummaryLine(msg.executionTrace)
}
