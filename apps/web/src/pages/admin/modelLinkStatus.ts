/**
 * 模型目录页【链路状态】灯色判定（2026-10-12 运营增强）——纯函数，零依赖。
 *
 * 输入 = 服务端 GET /admin/model-catalog 的 `ops[modelKey]`（apps/server/src/admin/
 * model-catalog-link.ts 组装）；灯色语义与探活对账口径一致（upstreamReconciliation.ts）：
 * - 🔴 不可用：availability='unavailable'（探活唯一写入方按 Ruling A 双条件判定：
 *   连败 ≥3 且近 24h 零真实成功）→ 建议下架；
 * - 🟡 欠费：近 24h 有 402 余额不足记录（真实流量文案族）→ 需给上游账户充值；
 * - 🟢 正常：探活 available，或近 24h 有真实成功流量背书；
 * - ⚪ 未知：探活尚未判定且无近期流量（新上架/冷模型/上游 /models 未覆盖）。
 *
 * 优先级：红 > 黄 > 绿 > 灰（同一模型同时命中多信号时按最严重展示，tooltip 补全量）。
 */

export type AdminCatalogLinkOps = {
  upstream: string | null
  baseUrl: string | null
  availability: 'available' | 'unavailable' | 'unknown' | null
  completed24h: number
  balance40224h: number
}

export type LinkLevel = 'red' | 'yellow' | 'green' | 'gray'

export interface LinkStatus {
  level: LinkLevel
  label: string
  tooltip: string
}

/** ops 缺失（服务端 fail-soft 降级 / 旧响应）→ 灰色「未知」。 */
export function linkStatusOf(ops: AdminCatalogLinkOps | null | undefined, deleted: boolean): LinkStatus {
  if (deleted) return { level: 'gray', label: '已下架', tooltip: '软删行，不参与路由与探活' }
  if (!ops) return { level: 'gray', label: '未知', tooltip: '链路数据不可用（服务端降级或旧版本响应）' }
  if (ops.availability === 'unavailable') {
    const extra = ops.balance40224h > 0 ? '；近 24h 另有欠费(402)记录' : ''
    return {
      level: 'red',
      label: '不可用',
      tooltip: `探活判定不可用（连续 3 轮 ghost 且近 24h 零真实成功），建议下架${extra}`,
    }
  }
  if (ops.balance40224h > 0) {
    return { level: 'yellow', label: '欠费', tooltip: `近 24h 有 ${ops.balance40224h} 条 402 余额不足记录，请给上游账户充值` }
  }
  if (ops.availability === 'available' || ops.completed24h > 0) {
    const why = ops.availability === 'available' ? '探活正常' : `近 24h 有 ${ops.completed24h} 次真实成功流量`
    return { level: 'green', label: '正常', tooltip: why }
  }
  return { level: 'gray', label: '未知', tooltip: '探活尚未判定（新上架/冷模型/上游 /models 未覆盖该模型）' }
}

/** 灯色 → 展示色类（design token 既有语义类，禁新增 hex）。 */
export const LINK_LEVEL_TEXT_CLASS: Record<LinkLevel, string> = {
  red: 'text-danger',
  yellow: 'text-warning',
  green: 'text-success',
  gray: 'text-fg-3',
}
