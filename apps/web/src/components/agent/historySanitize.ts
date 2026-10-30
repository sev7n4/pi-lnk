import { isMachineOnlyVisibleText } from '@/components/agent/agentInterruptGate'

/**
 * H1-d（规格 §2/§8，Claude Code「加载期 sanitize 防崩溃」实践）：
 * 历史消息进入渲染前的统一净化边界。畸形输入在此被消化成显式降级信号，
 * 而不是静默丢行或把渲染层炸成白屏（D15/D16/D17）。
 *
 * 只净化渲染视图：DB 原文不动（__new_task__ 是服务端回合分类输入，规格 §2 明确不做写路径清洗）。
 */
export interface HistoryRow {
  id: string
  role: string
  content: string
  metadata?: string | null
}

export interface SanitizeResult<T extends HistoryRow> {
  rows: T[]
  /** metadata 损坏但正文保留的行（渲染层据此标注「过程数据缺失」） */
  degradedIds: Set<string>
  /** 被剔除的空 assistant 行数（无正文且无任何 metadata） */
  droppedEmptyAssistant: number
  /** 输入序列（原始下标）里最后一条非空 assistant 的下标（任务卡/恢复定位用），无则 -1 */
  lastRenderableAssistantIndex: number
}

function isParsableJson(s: string): boolean {
  try {
    JSON.parse(s)
    return true
  } catch {
    return false
  }
}

export function sanitizeHistoryMessages<T extends HistoryRow>(input: readonly T[]): SanitizeResult<T> {
  const rows: T[] = []
  const degradedIds = new Set<string>()
  let droppedEmptyAssistant = 0
  for (const r of input) {
    const contentEmpty = !r.content?.trim()
    if (r.role === 'user' && !contentEmpty && isMachineOnlyVisibleText(r.content)) {
      continue // K4：纯机器载荷 user 行不进渲染序列
    }
    if (r.role === 'assistant' && contentEmpty) {
      // D16：空 assistant 行剔除——无正文则 metadata 无从渲染，恢复定位不受干扰
      //（含 metadata 畸形的空行，「全畸形输入得空结果」Review Focus #4）
      droppedEmptyAssistant++
      continue
    }
    if (r.role === 'assistant' && r.metadata != null && !isParsableJson(r.metadata)) {
      degradedIds.add(r.id) // D15：行保留（正文可能有效），降级显式化
    }
    rows.push(r)
  }
  // D16/D17：恢复定位 = 输入序列原始下标下最后一条非空 assistant——与组件内对
  // 原始 msgs 的倒序扫描等价（两者必须一致，见 AgentSideRail.loadHistory 消费点）。
  let lastRenderableAssistantIndex = -1
  for (let i = 0; i < input.length; i++) {
    if (input[i]!.role === 'assistant' && input[i]!.content?.trim()) lastRenderableAssistantIndex = i
  }
  return { rows, degradedIds, droppedEmptyAssistant, lastRenderableAssistantIndex }
}
