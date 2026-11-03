/** Pure helpers for post-stream assistant message reconcile. */

export const CONFIRM_GATE_SNIPPET = '请确认是否按此方案拆解画布并出图'
export const EXEC_TIP_SNIPPET = '正在按方案拆解'
export const BUSY_TIP_SNIPPET = '上一轮仍在处理中'
export const COPY_DRAFT_SNIPPET = '【主文案草稿】'
export const COPY_WRITTEN_SNIPPET = '已将确认的主文案'

/**
 * Whether DB assistant text should replace the local streaming bubble.
 * Avoids a race: confirm-turn stream dies early while Nest still runs;
 * last DB row may still be the previous confirm-gate message (longer),
 * which would wipe the in-progress tip and re-show confirm chips.
 */
export function shouldApplyReconciledAssistant(localContent: string, dbContent: string): boolean {
  const local = localContent.trim()
  const db = dbContent.trim()
  if (!db) return false
  if (!local) return true

  // Prefer a successful write from DB even if shorter than a stale draft bubble
  if (db.includes(COPY_WRITTEN_SNIPPET) && !local.includes(COPY_WRITTEN_SNIPPET)) {
    return true
  }
  // Never let a previous-turn draft/progress overwrite busy tip or write success
  if (local.includes(BUSY_TIP_SNIPPET)) {
    if (db.includes(COPY_DRAFT_SNIPPET) || db.includes(EXEC_TIP_SNIPPET) || db.includes(BUSY_TIP_SNIPPET)) {
      return false
    }
  }
  if (local.includes(COPY_WRITTEN_SNIPPET) && db.includes(COPY_DRAFT_SNIPPET)) {
    return false
  }

  if (db.length <= local.length) return false
  const localIsExec = local.includes(EXEC_TIP_SNIPPET) || local.includes('已按方案拆解')
  const dbIsStaleGate = db.includes(CONFIRM_GATE_SNIPPET) && !db.includes(EXEC_TIP_SNIPPET)
  if (localIsExec && dbIsStaleGate) return false
  return true
}

export function looksLikeCopyWriteTurn(userText: string): boolean {
  const t = userText.trim()
  if (!t) return false
  return /写入主文案|确认写入|可以写入/.test(t)
}

/** Assistant reply for the latest user turn only — avoids resurrecting stale busy tips. */
export function pickAssistantForLatestUserTurn(
  rows: Array<{ role: string; content: string }>,
): { role: string; content: string } | null {  let lastUserIdx = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === 'user') {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0) {
    return [...rows].reverse().find((m) => m.role === 'assistant') ?? null
  }
  for (let j = lastUserIdx + 1; j < rows.length; j++) {
    if (rows[j].role === 'assistant') return rows[j]
  }
  return null
}

export function looksLikeConfirmTurn(userText: string): boolean {
  const t = userText.trim()
  if (!t) return false
  if (looksLikeCopyWriteTurn(t)) return true
  if (/^(确认|同意|可以|没问题|开始拆|出图|ok|okay|yes|confirm)\s*$/i.test(t)) return true
  // Long briefs that merely mention「确认」are planning turns, not confirm chips
  if (/请为|写一份|帮我设计|帮我做|帮我写/.test(t)) return false
  return t.length <= 16 && t.includes('确认')
}

export interface ReconcileRow {
  id: string
  role: string
  content: string
  metadata?: string | null
}

function isOutOfTurnMetadata(metadata: string | null | undefined): boolean {
  if (!metadata) return false
  try {
    const parsed: unknown = JSON.parse(metadata)
    return (
      typeof parsed === 'object' && parsed !== null && (parsed as { outOfTurn?: unknown }).outOfTurn === true
    )
  } catch {
    return false // 坏 JSON ≠ 回合外（与 historySanitize 的降级语义一致）
  }
}

/**
 * 回合外来信行（2026-11-03 黄小龙虾复测）：历史页**最后一条**若为 outOfTurn assistant
 * ⇒ 即回合外简报（简报轮不属于任何用户 turn，服务端投影记账者打 `metadata.outOfTurn`
 * —— 分类 SSOT 在服务端，web 不复判）。
 *
 * 为什么只认「最后一条」：对账期把该行**追加到本地尾部**，若它后面还有更新的消息
 * （用户在简报轮运行期间又发了消息）追加就会错序——那种场景交给刷新后的
 * loadHistory 全量重建（天然按 createdAt 有序），对账不做越位插入。
 */
export function pickTrailingOutOfTurnRow<T extends ReconcileRow>(rows: T[]): T | null {
  const last = rows[rows.length - 1]
  if (!last || last.role !== 'assistant' || !last.content?.trim()) return null
  return isOutOfTurnMetadata(last.metadata) ? last : null
}
