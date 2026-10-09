/**
 * S1-2 模型健康统计纯函数（spec:
 * docs/superpowers/specs/2026-10-09-mph-s12-model-health-stats-design.md §3）。
 *
 * 三个纯函数，全部 ⛔ 零 IO、零内部 import（ops 可直接 strip-types 动态 import，
 * 与 upstreamReconciliation.ts 同纪律）：
 * - buildHealthSql(windowHours)：GenerationRecord 聚合 SQL。**时间过滤先行**、
 *   errorCode 提取用 REPLACE 写法（SQLite JSON_EXTRACT 返回带双引号的已知坑，
 *   不剥引号则 LIKE/等值恒不匹配）；唯一可变参（窗口 cutoff）由调用方以参数绑定，
 *   SQL 字符串本身不含任何外部输入。
 * - rowsToHealth(rawRows)：把 SQL 原始行归一成 ModelHealthRow —— BYOK 前缀
 *   `<userId>::<model>` 剥离（channelId=前缀段；平台行 channelId='platform'），
 *   按 (model, channelId) 分组。
 * - flagHealthAnomalies(rows)：告警规则 R1-R3（spec §3.3，字面实现）。
 *
 * 「成功」状态集与 upstream-probe.service.ts 的 GENERATION_SUCCESS_STATUSES 同口径：
 * studio 全链路只写 `completed` 表示成功。
 */

export const MODEL_HEALTH_SUCCESS_STATUSES = ['completed'] as const

/** windowHours 白名单（spec §3.2）：唯一免注入防线，越界值在纯函数层直接抛错。 */
export const MODEL_HEALTH_WINDOW_HOURS = [1, 6, 24, 168] as const

export type ModelHealthWindowHours = (typeof MODEL_HEALTH_WINDOW_HOURS)[number]

export function isModelHealthWindowHours(value: unknown): value is ModelHealthWindowHours {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    (MODEL_HEALTH_WINDOW_HOURS as readonly number[]).includes(value)
  )
}

/**
 * buildHealthSql 的原始行（Prisma $queryRawUnsafe 返回形态）。
 * SQLite 聚合（COUNT/SUM）经 Prisma 返回 bigint，故 cnt/refunded 放宽到 number | bigint。
 */
export interface RawHealthRow {
  model: string | null
  status: string
  /** REPLACE 剥引号后的 $.errorCode（失败行才有语义；缺失/空归 'unknown'） */
  errorCode: string | null
  /** 该组内命中 402 文案族（S0-2 字面量族）的记录数标志 0/1（GROUP BY 维度） */
  balance402: number
  cnt: number | bigint
  refunded: number | bigint | null
}

export interface ModelHealthRow {
  model: string
  channelId: string
  windowHours: number
  total: number
  completed: number
  failed: number
  fallbackPending: number
  refunded: number
  /** completed / total；total=0 时 null（零除保护，A3） */
  successRate: number | null
  /** 失败记录的 errorCode 分布（cnt 求和）；供 R2 判定与运维归因 */
  errorCodeCounts: Record<string, number>
  /** 命中 402 文案族的记录数；供 R3 判定 */
  balance402Count: number
}

export type HealthAlertRule = 'degraded' | 'ghost_suspect' | 'upstream_balance'

export interface HealthAlert {
  rule: HealthAlertRule
  model: string
  channelId: string
  windowHours: number
  total: number
  successRate: number | null
}

/**
 * 聚合 SQL。⛔ windowHours 只接受白名单值（越界抛错——即使控制器已 400，这里
 * 仍兜底，保证 sql 永不携带白名单之外的任何自由拼接）。
 *
 * 写法要点（MEMORY 备忘写死进测试）：
 * - `WHERE createdAt >= CAST(? AS INTEGER)` 时间过滤先行（整数毫秒比较，⛔ 不用
 *   strftime 混算——恒假）；参数由调用方 $queryRawUnsafe(sql, ...params) 绑定。
 * - errorCode/userMessage 经 `REPLACE(...,'"','')` 剥 JSON_EXTRACT 双引号，否则
 *   后续匹配恒不命中。
 * - 退款计数：`$.refundedPoints > 0`（production 由 applyRefundMeta 写入数字）。
 * - 402 文案族与 S0-2 translateUpstreamFailure 同字面量（402 / insufficient
 *   balance / 余额不足 / 欠费）；LIKE 只做包含匹配（首版告警启发式，可接受
 *   子串级近似，不做 \b 词边界）。
 */
export function buildHealthSql(
  windowHours: number,
  nowMs: number = Date.now(),
): { sql: string; params: readonly [number] } {
  if (!isModelHealthWindowHours(windowHours)) {
    throw new Error(`windowHours 必须是白名单值 ${MODEL_HEALTH_WINDOW_HOURS.join('/')}，收到: ${String(windowHours)}`)
  }
  // 整数毫秒算术（与 upstream-probe countRecentSuccesses 同模式），⛔ 无 strftime
  const cutoffMs = Math.floor(nowMs - windowHours * 3_600_000)
  const sql = [
    'SELECT',
    '  model AS model,',
    '  status AS status,',
    "  REPLACE(COALESCE(JSON_EXTRACT(metadata, '$.errorCode'), ''), '\"', '') AS errorCode,",
    '  CASE WHEN',
    "    REPLACE(COALESCE(JSON_EXTRACT(metadata, '$.userMessage'), ''), '\"', '') LIKE '%402%'",
    "    OR REPLACE(COALESCE(JSON_EXTRACT(metadata, '$.userMessage'), ''), '\"', '') LIKE '%insufficient balance%'",
    "    OR REPLACE(COALESCE(JSON_EXTRACT(metadata, '$.userMessage'), ''), '\"', '') LIKE '%余额不足%'",
    "    OR REPLACE(COALESCE(JSON_EXTRACT(metadata, '$.userMessage'), ''), '\"', '') LIKE '%欠费%'",
    '  THEN 1 ELSE 0 END AS balance402,',
    '  COUNT(*) AS cnt,',
    "  SUM(CASE WHEN CAST(JSON_EXTRACT(metadata, '$.refundedPoints') AS REAL) > 0 THEN 1 ELSE 0 END) AS refunded",
    'FROM GenerationRecord',
    'WHERE createdAt >= CAST(? AS INTEGER)',
    'GROUP BY model, status, errorCode, balance402',
  ].join('\n')
  return { sql, params: [cutoffMs] }
}

/** BYOK model 形态 `<userId>::<modelKey>`：返回 [userId, modelKey]；平台裸名返回 null。 */
export function splitByokModel(model: string): [string, string] | null {
  const idx = model.indexOf('::')
  if (idx <= 0 || idx === model.length - 2) return null
  return [model.slice(0, idx), model.slice(idx + 2)]
}

function toNum(value: number | bigint | null | undefined): number {
  return typeof value === 'bigint' ? Number(value) : value ?? 0
}

/**
 * SQL 原始行 → ModelHealthRow[]：按 (剥前缀 model, channelId) 分组，输出按
 * (model, channelId) 排序。model 为空/NULL 的行无法归属模型，丢弃。
 * ⛔ 零 IO：仅消费入参，可对畸形行（cnt=0）健壮。
 */
export function rowsToHealth(
  rawRows: readonly RawHealthRow[],
  windowHours: number,
): ModelHealthRow[] {
  const groups = new Map<
    string,
    { model: string; channelId: string; row: Omit<ModelHealthRow, 'windowHours' | 'successRate'> }
  >()
  for (const raw of rawRows) {
    const rawModel = typeof raw.model === 'string' ? raw.model : ''
    if (rawModel === '') continue
    const byok = splitByokModel(rawModel)
    const model = byok ? byok[1] : rawModel
    const channelId = byok ? byok[0] : 'platform'
    const key = `${model}\u0000${channelId}`
    let group = groups.get(key)
    if (!group) {
      group = {
        model,
        channelId,
        row: {
          model,
          channelId,
          total: 0,
          completed: 0,
          failed: 0,
          fallbackPending: 0,
          refunded: 0,
          errorCodeCounts: {},
          balance402Count: 0,
        },
      }
      groups.set(key, group)
    }
    const cnt = toNum(raw.cnt)
    group.row.total += cnt
    if (raw.status === 'completed') group.row.completed += cnt
    if (raw.status === 'failed') {
      group.row.failed += cnt
      const code = typeof raw.errorCode === 'string' && raw.errorCode !== '' ? raw.errorCode : 'unknown'
      group.row.errorCodeCounts[code] = (group.row.errorCodeCounts[code] ?? 0) + cnt
    }
    if (raw.status === 'fallback_pending') group.row.fallbackPending += cnt
    group.row.refunded += toNum(raw.refunded)
    // Prisma 对 SQLite INTEGER（含 CASE 输出）一律返回 bigint，必须归一后再比较
    group.row.balance402Count += cnt * (toNum(raw.balance402) === 1 ? 1 : 0)
  }
  return [...groups.values()]
    .map(({ model, channelId, row }) => ({
      ...row,
      windowHours,
      successRate: row.total === 0 ? null : row.completed / row.total,
    }))
    .sort((a, b) => (a.model === b.model ? a.channelId.localeCompare(b.channelId) : a.model.localeCompare(b.model)))
}

// ── S1-3 用户投影（spec 2026-10-09-mph-s13 §3.1）────────────────────────────

/**
 * 用户端健康行：admin 诊断语义（errorCodeCounts / balance402Count / alerts）不下发，
 * 只保留用户可理解的成功率聚合。
 */
export interface ModelHealthSummaryRow {
  model: string
  channelId: string
  windowHours: number
  total: number
  completed: number
  failed: number
  fallbackPending: number
  refunded: number
  successRate: number | null
}

/**
 * 用户投影过滤（A2）：平台行全量保留；BYOK 行只保留当前用户自己的
 * （rowsToHealth 已把 BYOK 行的 channelId 归一为 userId 前缀段）。同时剥掉
 * admin 诊断字段。⛔ 绝不回其他用户的 BYOK 行。纯函数：零 IO。
 */
export function toUserHealthRows(
  rows: readonly ModelHealthRow[],
  userId: string,
): ModelHealthSummaryRow[] {
  const out: ModelHealthSummaryRow[] = []
  for (const row of rows) {
    if (row.channelId !== 'platform' && row.channelId !== userId) continue
    const { errorCodeCounts: _ec, balance402Count: _b, ...rest } = row
    out.push(rest)
  }
  return out
}

export type HealthDotKind = 'red' | 'yellow'

/**
 * 角标阈值（A4 矩阵，brief 4.3 字面）：<0.5 红 / <0.9 黄 /
 * ≥0.9 或 null 或 total=0 → null（避免新模型零流量被标红）。
 */
export function healthDotKind(successRate: number | null, total: number): HealthDotKind | null {
  if (successRate === null || total <= 0) return null
  if (successRate < 0.5) return 'red'
  if (successRate < 0.9) return 'yellow'
  return null
}

/** 角标 hover 文案：「近24h 成功率 x/x」。 */
export function healthDotTitle(windowHours: number, completed: number, total: number): string {
  return `近${windowHours}h 成功率 ${completed}/${total}`
}

/** R2 允许的 errorCode 集合：全部失败都归「模型不可用」才疑幽灵（spec §3.3）。 */
const GHOST_ERROR_CODES = new Set(['model_unavailable'])

/**
 * 告警规则 R1-R3（spec §3.3 字面实现，阈值两侧边界都有测试锁死）：
 * - R1 degraded：total ≥ 5 且 successRate < 0.5（gemini-3.1-flash 失败6/成0 即命中）；
 *   successRate 恰好 0.5 不命中。
 * - R2 ghost_suspect：total ≥ 5 且 failed > 0 且失败全部 errorCode ∈ {model_unavailable}。
 * - R3 upstream_balance：任一记录命中 402 文案族（balance402Count ≥ 1）。
 */
export function flagHealthAnomalies(rows: readonly ModelHealthRow[]): HealthAlert[] {
  const alerts: HealthAlert[] = []
  for (const row of rows) {
    const base = {
      model: row.model,
      channelId: row.channelId,
      windowHours: row.windowHours,
      total: row.total,
      successRate: row.successRate,
    }
    // R1：total ≥ 5 且 successRate < 0.5（< 严格小于，恰好 0.5 不告警）
    if (row.total >= 5 && row.successRate !== null && row.successRate < 0.5) {
      alerts.push({ rule: 'degraded', ...base })
    }
    // R2：total ≥ 5 且 failed > 0 且失败 errorCode 全部 ∈ {model_unavailable}
    // （failed=0 时空集全称量化为真，必须排除——健康模型不得误报幽灵）
    const codes = Object.keys(row.errorCodeCounts)
    if (row.total >= 5 && row.failed > 0 && codes.length > 0 && codes.every((c) => GHOST_ERROR_CODES.has(c))) {
      alerts.push({ rule: 'ghost_suspect', ...base })
    }
    // R3：任一记录命中 402 文案族
    if (row.balance402Count >= 1) {
      alerts.push({ rule: 'upstream_balance', ...base })
    }
  }
  return alerts
}
