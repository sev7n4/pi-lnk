/**
 * 2026-11-22 Turn 内「阶段性状态 + 阶段小结」纯派生视图（spec
 * docs/superpowers/specs/2026-11-22-turn-phase-progress-design.md §5）。
 *
 * 设计要点（第一原则：吃满上游）：
 * - 渲染期 `parts (+taskProgress) → view` 纯函数投影，**不写 parts、不落库、不发事件**；
 *   刷新后历史轮自然无视图 =「临时进度 + 完成时收口」的 structural 保证。
 * - 阶段分类只读 phaseAggregator.phaseForToolName（与 derivePhase 同源，零新枚举）；
 *   阶段名只取 PHASE_BADGE；等待态只取 turnStatusBar.resolveWaitingFromTimeline；
 *   小结/耗时只来自真实字段（tool.ms / thinking.startedAt,endedAt / artifact.status /
 *   plan.steps / taskProgress.items），缺字段整段省略 —— 禁 Date.now / setInterval /
 *   秒表 ticker / 0 占位（守卫见 AgentSideRail.mobileLivePin.test.ts）。
 */
import type { TimelinePart } from './turnTimeline'
import type { AgentTaskProgressState } from './agentTaskProgress'
import { formatTaskProgressLine } from './agentTaskProgress'
import { formatDuration } from './executionStepLabels'
import { phaseForToolName, PHASE_BADGE, type AgentPhase } from './phaseAggregator'
import { presentToolStep } from './toolPresentation'
import { resolveWaitingFromTimeline } from './turnStatusBar'

const PHASE_ORDER: AgentPhase[] = ['exploring', 'creating', 'wrapping']

export type TurnPhaseStageStatus = 'done' | 'running' | 'pending'

export interface TurnPhaseStage {
  id: AgentPhase
  label: string
  status: TurnPhaseStageStatus
  /** 已完成阶段的小结；无可信数据即 undefined，禁止占位符 */
  summary?: string
  /** 仅当该阶段所有耗时字段均为真实值时给出 */
  durationLabel?: string
  /** 仅活跃阶段给出，来自 taskProgress / plan step / 运行中工具人话 */
  detail?: string
}

export interface TurnPhaseView {
  stages: TurnPhaseStage[]
  activeIndex: number
}

/** 收口判定：稳定 id `notice:turn-summary`（turnTimeline.finalizeTurnTimeline 产出）。 */
export function isTurnFinalized(parts: TimelinePart[]): boolean {
  return parts.some((p) => p.kind === 'notice' && p.id === 'notice:turn-summary')
}

type ToolPart = Extract<TimelinePart, { kind: 'tool' }>

/** 与 AgentTurnTimeline.toolLabel 同源（presentToolStep 注册表人话，未知工具自曝兜底）。 */
function toolLabel(p: ToolPart): string {
  return presentToolStep({
    label: p.toolName,
    kind: 'tool',
    status: p.status,
    meta: { toolName: p.toolName, args: p.args },
  }).label
}

/** 已完成阶段小结（spec R5）：工具人话前 2 + 等量；artifact 计数；plan 步数；thinking-only 思考完成。 */
function summarizeStage(group: TimelinePart[]): string | undefined {
  const segments: string[] = []
  const labels = [...new Set(group.filter((p): p is ToolPart => p.kind === 'tool').map(toolLabel))]
  if (labels.length) {
    const head = labels.slice(0, 2).join('、')
    segments.push(labels.length > 2 ? `${head} 等 ${labels.length} 步` : head)
  }
  const artifacts = group.filter((p) => p.kind === 'artifact' && p.status === 'done').length
  if (artifacts) segments.push(`生成 ${artifacts} 张`)
  const plan = group.find((p) => p.kind === 'plan')
  if (plan?.kind === 'plan') segments.push(`方案已提出（${plan.steps.length} 步）`)
  if (!segments.length && group.some((p) => p.kind === 'thinking')) segments.push('思考完成')
  return segments.length ? segments.join('、') : undefined
}

/** 已完成阶段耗时（spec R6）：全部 tool 有 ms 且 thinking 有 endedAt 才出，否则 undefined。 */
function stageDuration(group: TimelinePart[]): string | undefined {
  if (!group.length) return undefined
  let ms = 0
  for (const p of group) {
    if (p.kind === 'tool') {
      if (typeof p.ms !== 'number') return undefined
      ms += p.ms
    } else if (p.kind === 'thinking') {
      if (p.endedAt == null) return undefined
      ms += p.endedAt - p.startedAt
    }
  }
  return formatDuration(ms)
}

/** 活跃阶段 detail（spec R4 优先级）：等待 > taskProgress > plan activeForm > running 工具。 */
function activeDetail(
  parts: TimelinePart[],
  taskProgress: AgentTaskProgressState | null | undefined,
  group: TimelinePart[],
): string | undefined {
  if (resolveWaitingFromTimeline(parts)) return '等待你确认（阶段暂不推进）'
  if (taskProgress && !taskProgress.finished && taskProgress.items.length) {
    return formatTaskProgressLine(taskProgress.items) ?? undefined
  }
  const plan = [...group].reverse().find((p) => p.kind === 'plan')
  if (plan?.kind === 'plan') {
    const activeForm = plan.steps.find((s) => s.activeForm)?.activeForm
    if (activeForm) return `正在：${activeForm}`
  }
  const running = [...group].reverse().find(
    (p): p is ToolPart => p.kind === 'tool' && p.status === 'running',
  )
  return running ? `正在：${toolLabel(running)}` : undefined
}

/**
 * 派生主入口（spec R1-R3）：逐 part 顺序扫，tool 分类推进当前阶段（单调不回退）；
 * parts 为空 ⇒ null（此时 composer 灰字负责「等待模型响应」，不造阶段）。
 */
export function deriveTurnPhaseView(
  parts: TimelinePart[],
  taskProgress?: AgentTaskProgressState | null,
): TurnPhaseView | null {
  if (!parts.length) return null
  let active: AgentPhase = 'exploring'
  const buckets: Record<AgentPhase, TimelinePart[]> = {
    exploring: [], creating: [], wrapping: [],
  }
  for (const p of parts) {
    const next = p.kind === 'tool' ? phaseForToolName(p.toolName) : null
    if (next) active = next
    buckets[active].push(p)
  }
  const activeIndex = PHASE_ORDER.indexOf(active)
  const stages: TurnPhaseStage[] = PHASE_ORDER.map((id, index) => {
    const group = buckets[id]
    const status: TurnPhaseStageStatus =
      index < activeIndex ? 'done' : index === activeIndex ? 'running' : 'pending'
    return {
      id,
      label: PHASE_BADGE[id].label,
      status,
      ...(status === 'done'
        ? { summary: summarizeStage(group), durationLabel: stageDuration(group) }
        : {}),
      ...(status === 'running' ? { detail: activeDetail(parts, taskProgress, group) } : {}),
    }
  })
  return { stages, activeIndex }
}
