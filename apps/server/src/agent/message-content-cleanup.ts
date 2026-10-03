import { normalizeAssistantText } from './text-normalize'

/**
 * 存量助手消息 content 清洗的纯逻辑（不碰 IO，可单测）。
 *
 * 背景：Q2 修复只挡住**新写入**的消息（finalizeTurn 落库前归一化），
 * 生产库里已存在的脏行不会被追溯清理。生产取证（2026-10-03，修复上线前）：
 *   assistant 消息 10199 条 → 首部空白 283（2.77%）、尾部空白 89、纯空白 69。
 *
 * 设计决策（都是「宁可少改，不可误伤」）：
 *   1. **复用 text-normalize 的规则**，不另写一套正则——两套实现必然漂移，
 *      漂移后清洗会把正文改坏而没人发现。
 *   2. **剥完为空的行置空 content，绝不删行**。生产实测纯空白行 100% 带
 *      `metadata.executionEvents`（模型只吐 thinking/toolCalls 而没吐正文），
 *      删行= 丢思考链与工具轨迹，且会改变对话轮次编号。
 *   3. **无 payload 也不删**（`dropped` 恒为 0）：留作防御性口径与未来显式开关，
 *      当前口径下删除的收益（省几 KB）远低于风险（破坏历史消息序列）。
 *   4. **幂等**：对已清洗结果再跑一次产出 0 变更，脚本可安全重跑。
 */

/** 清洗判据所需的一行（IO 壳负责从数据库取，逻辑层只认这个形状） */
export interface CleanupCandidateRow {
  id: string
  content: string
  /** metadata.executionEvents 非空（模型有 thinking/工具轨迹但无正文） */
  hasExecutionEvents: boolean
  /** metadata.presentation 非空（有结构化展示块） */
  hasPresentation: boolean
  /** toolCalls 非空（有画布操作） */
  hasToolCalls: boolean
}

export interface CleanupPlan {
  /** 输入总行数 */
  total: number
  /** 需要变更的行数 */
  changed: number
  /** 变更后 content 为空串的行数（toEmpty） */
  toEmpty: number
  /** 变更后 content 为清洗后正文的行数（toText） */
  toText: number
  /** 会被删除的行数——当前恒为 0（决策 3） */
  dropped: number
  /** 变更行的 id 列表（脚本据此逐行 update） */
  ids: string[]
}

const EMPTY_PLAN: CleanupPlan = { total: 0, changed: 0, toEmpty: 0, toText: 0, dropped: 0, ids: [] }

/**
 * 计算清洗计划：只返回「哪些行要改」，不返回新内容——
 * 新内容由脚本用同一个 normalizeAssistantText 现算，避免计划与执行不一致。
 */
export function planContentCleanup(rows: CleanupCandidateRow[]): CleanupPlan {
  if (!rows.length) return { ...EMPTY_PLAN }

  let changed = 0
  let toEmpty = 0
  let toText = 0
  const ids: string[] = []

  for (const row of rows) {
    const next = normalizeAssistantText(row.content ?? '')
    // 字节级比较：normalize 幂等，等价即视为无需变更
    if (next === row.content) continue
    changed++
    ids.push(row.id)
    if (next.length === 0) toEmpty++
    else toText++
  }

  // changed 与 toEmpty + toText 必须恒等——不一致说明分类漏了一种形态
  if (changed !== toEmpty + toText) {
    throw new Error(
      `planContentCleanup 内部不一致：changed=${changed} != toEmpty+toText=${toEmpty + toText}`,
    )
  }

  return { total: rows.length, changed, toEmpty, toText, dropped: 0, ids }
}
