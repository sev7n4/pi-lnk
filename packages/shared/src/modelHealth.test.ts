import { describe, expect, it } from 'vitest'
import {
  MODEL_HEALTH_WINDOW_HOURS,
  buildHealthSql,
  flagHealthAnomalies,
  rowsToHealth,
  splitByokModel,
  toUserHealthRows,
  healthDotKind,
  healthDotTitle,
  type ModelHealthRow,
  type RawHealthRow,
} from './modelHealth'

/** 便捷构造一条 SQL 原始行。 */
function raw(overrides: Partial<RawHealthRow> & { model: string; status: string }): RawHealthRow {
  return { errorCode: null, balance402: 0, cnt: 1, refunded: 0, ...overrides }
}

/** 便捷构造聚合后的健康行（绕过 SQL 层直接测告警纯函数）。 */
function health(overrides: Partial<ModelHealthRow> & { model: string }): ModelHealthRow {
  const total = overrides.total ?? 0
  const completed = overrides.completed ?? 0
  return {
    channelId: 'platform',
    windowHours: 24,
    total,
    completed,
    failed: overrides.failed ?? 0,
    fallbackPending: 0,
    refunded: 0,
    successRate: total === 0 ? null : completed / total,
    errorCodeCounts: overrides.errorCodeCounts ?? {},
    balance402Count: overrides.balance402Count ?? 0,
    ...overrides,
  }
}

describe('buildHealthSql', () => {
  it('白名单内窗口返回 SQL + 整数毫秒 cutoff 参数（时间过滤先行）', () => {
    const nowMs = 1_770_000_000_000
    const { sql, params } = buildHealthSql(24, nowMs)
    expect(params).toEqual([nowMs - 24 * 3_600_000])
    expect(Number.isInteger(params[0])).toBe(true)
    // 时间过滤先行：WHERE 紧跟 FROM，且在 GROUP BY 之前
    const whereIdx = sql.indexOf('WHERE createdAt >= CAST(? AS INTEGER)')
    const fromIdx = sql.indexOf('FROM GenerationRecord')
    const groupIdx = sql.indexOf('GROUP BY')
    expect(whereIdx).toBeGreaterThan(fromIdx)
    expect(whereIdx).toBeLessThan(groupIdx)
    // errorCode 用 REPLACE 写法（JSON 双引号坑）
    expect(sql).toContain("REPLACE(COALESCE(JSON_EXTRACT(metadata, '$.errorCode'), ''), '\"', '')")
    // SQL 字符串不携带任何可变拼接（cutoff 走参数绑定）
    expect(sql).not.toContain(String(nowMs))
  })

  it('白名单 {1,6,24,168} 全部通过', () => {
    for (const h of MODEL_HEALTH_WINDOW_HOURS) {
      expect(() => buildHealthSql(h, 0)).not.toThrow()
    }
  })

  it('越界窗口抛错（999 / 0 / -24 / 1.5 / 非数字）', () => {
    for (const bad of [999, 0, -24, 1.5, Number.NaN]) {
      expect(() => buildHealthSql(bad, 0)).toThrow()
    }
  })
})

describe('rowsToHealth（BYOK 前缀归一）', () => {
  it('A2：BYOK cmrrxageh::deepseek-v4-pro 与平台 deepseek-v4 不合并（channelId 不同即分行）', () => {
    const rows = rowsToHealth(
      [
        raw({ model: 'cmrrxageh::deepseek-v4-pro', status: 'completed' }),
        raw({ model: 'deepseek-v4', status: 'completed' }),
      ],
      24,
    )
    expect(rows).toHaveLength(2)
    const byok = rows.find((r) => r.model === 'deepseek-v4-pro')!
    const platform = rows.find((r) => r.model === 'deepseek-v4')!
    expect(byok.channelId).toBe('cmrrxageh')
    expect(platform.channelId).toBe('platform')
    expect(byok.total).toBe(1)
    expect(platform.total).toBe(1)
  })

  it('A2 补充：两个 BYOK 用户同名模型也分行（channelId=各自 userId）', () => {
    const rows = rowsToHealth(
      [
        raw({ model: 'user-a::deepseek-v4-pro', status: 'completed' }),
        raw({ model: 'user-b::deepseek-v4-pro', status: 'failed', errorCode: 'upstream_error' }),
      ],
      24,
    )
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.channelId).sort()).toEqual(['user-a', 'user-b'])
  })

  it('分组聚合 status/refunded/errorCode/balance402（bigint cnt 兼容）', () => {
    const rows = rowsToHealth(
      [
        raw({ model: 'deepseek-v4', status: 'completed', cnt: 2n }),
        raw({ model: 'deepseek-v4', status: 'failed', errorCode: 'model_unavailable', cnt: 3n, refunded: 3n }),
        raw({ model: 'deepseek-v4', status: 'failed', errorCode: 'model_unavailable', balance402: 1, cnt: 1n, refunded: 1n }),
        raw({ model: 'deepseek-v4', status: 'fallback_pending', cnt: 1n }),
      ],
      24,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      model: 'deepseek-v4',
      channelId: 'platform',
      total: 7,
      completed: 2,
      failed: 4,
      fallbackPending: 1,
      refunded: 4,
      balance402Count: 1,
      successRate: 2 / 7,
    })
    expect(rows[0]!.errorCodeCounts).toEqual({ model_unavailable: 4 })
  })

  it('A3/零除保护：total=0 时 successRate=null', () => {
    const rows = rowsToHealth([raw({ model: 'ghost-model', status: 'failed', cnt: 0 })], 24)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.total).toBe(0)
    expect(rows[0]!.successRate).toBeNull()
  })

  it('model 为空的行丢弃；失败 errorCode 缺失归 unknown', () => {
    const rows = rowsToHealth(
      [
        raw({ model: '', status: 'failed', errorCode: 'upstream_error' }),
        raw({ model: 'm1', status: 'failed', errorCode: null }),
      ],
      24,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.errorCodeCounts).toEqual({ unknown: 1 })
  })

  it('splitByokModel：正常前缀 / 平台裸名 / 畸形形态', () => {
    expect(splitByokModel('cmrrxageh::deepseek-v4-pro')).toEqual(['cmrrxageh', 'deepseek-v4-pro'])
    expect(splitByokModel('deepseek-v4')).toBeNull()
    expect(splitByokModel('::no-user')).toBeNull()
    expect(splitByokModel('no-model::')).toBeNull()
  })
})

describe('flagHealthAnomalies（R1-R3，阈值两侧边界）', () => {
  it('A3：gemini-3.1-flash 失败6/成0 → R1 degraded（B0 事故同构 fixture）', () => {
    const alerts = flagHealthAnomalies([
      health({ model: 'gemini-3.1-flash', total: 6, completed: 0, failed: 6, errorCodeCounts: { upstream_error: 6 } }),
    ])
    expect(alerts.map((a) => a.rule)).toEqual(['degraded'])
    expect(alerts[0]).toMatchObject({ model: 'gemini-3.1-flash', channelId: 'platform' })
  })

  it('A3：deepseek-v4 503 model_not_found 原文记录 → R2 ghost_suspect（同时命中 R1 属规则重叠，允许）', () => {
    const alerts = flagHealthAnomalies([
      health({
        model: 'deepseek-v4',
        total: 6,
        completed: 0,
        failed: 6,
        errorCodeCounts: { model_unavailable: 6 },
      }),
    ])
    expect(alerts.map((a) => a.rule)).toContain('ghost_suspect')
  })

  it('R1 边界：successRate 恰好 0.5 不告警；低一侧 0.4 告警', () => {
    const at = flagHealthAnomalies([health({ model: 'm', total: 10, completed: 5, failed: 5 })])
    expect(at.map((a) => a.rule)).not.toContain('degraded')
    const below = flagHealthAnomalies([health({ model: 'm', total: 10, completed: 4, failed: 6 })])
    expect(below.map((a) => a.rule)).toContain('degraded')
  })

  it('R1 边界：total=5 成0 告警；total=4 成0（阈值下）不告警', () => {
    expect(flagHealthAnomalies([health({ model: 'm', total: 5, failed: 5, errorCodeCounts: { upstream_error: 5 } })]).map((a) => a.rule)).toContain('degraded')
    expect(flagHealthAnomalies([health({ model: 'm', total: 4, failed: 4, errorCodeCounts: { upstream_error: 4 } })]).map((a) => a.rule)).toEqual([])
  })

  it('R2 边界：恰好全败 model_unavailable 命中；混入一个其他 errorCode 不命中', () => {
    const all = flagHealthAnomalies([
      health({ model: 'm', total: 5, failed: 5, errorCodeCounts: { model_unavailable: 5 } }),
    ])
    expect(all.map((a) => a.rule)).toContain('ghost_suspect')
    const mixed = flagHealthAnomalies([
      health({ model: 'm', total: 5, failed: 5, errorCodeCounts: { model_unavailable: 4, upstream_error: 1 } }),
    ])
    expect(mixed.map((a) => a.rule)).not.toContain('ghost_suspect')
  })

  it('R2 边界：failed=0（全成功 total≥5）不得因空集全称量化误报幽灵', () => {
    const alerts = flagHealthAnomalies([health({ model: 'm', total: 5, completed: 5 })])
    expect(alerts).toEqual([])
  })

  it('R3：balance402Count=1 命中 upstream_balance；=0 不命中', () => {
    const hit = flagHealthAnomalies([
      health({ model: 'agnes-image-2.0-flash', total: 1, failed: 1, balance402Count: 1 }),
    ])
    expect(hit.map((a) => a.rule)).toEqual(['upstream_balance'])
    const miss = flagHealthAnomalies([
      health({ model: 'agnes-image-2.0-flash', total: 1, failed: 1, balance402Count: 0 }),
    ])
    expect(miss).toEqual([])
  })

  it('空输入返回空告警', () => {
    expect(flagHealthAnomalies([])).toEqual([])
  })
})

// ── S1-3 用户投影（brief 4.1/4.3）───────────────────────────────────────────

describe('toUserHealthRows（A2：平台全量 + 本人 BYOK，admin 语义剥除）', () => {
  it('平台行全量保留；本人 BYOK 行保留；他人 BYOK 行绝不返回', () => {
    const rows: ModelHealthRow[] = [
      health({ model: 'agnes-image-2.0-flash' }),
      { ...health({ model: 'deepseek-v4-pro' }), channelId: 'u-me' },
      { ...health({ model: 'kling-v3' }), channelId: 'u-other' },
    ]
    const out = toUserHealthRows(rows, 'u-me')
    expect(out.map((r) => `${r.model}@${r.channelId}`).sort()).toEqual([
      'agnes-image-2.0-flash@platform',
      'deepseek-v4-pro@u-me',
    ])
  })

  it('剥掉 admin 诊断字段（errorCodeCounts / balance402Count 不下发）', () => {
    const rows: ModelHealthRow[] = [
      health({ model: 'm', total: 6, failed: 6, errorCodeCounts: { model_unavailable: 6 }, balance402Count: 2 }),
    ]
    const out = toUserHealthRows(rows, 'u-me')
    expect(out).toHaveLength(1)
    expect(out[0]).not.toHaveProperty('errorCodeCounts')
    expect(out[0]).not.toHaveProperty('balance402Count')
    expect(out[0]).toMatchObject({ model: 'm', total: 6, failed: 6, successRate: 0 })
  })
})

describe('healthDotKind（A4 阈值矩阵：0.4→红、0.7→黄、0.95→无、null/total=0→无）', () => {
  it('0.4 → red', () => expect(healthDotKind(0.4, 10)).toBe('red'))
  it('恰好 0.5 → yellow（< 严格小于）', () => expect(healthDotKind(0.5, 10)).toBe('yellow'))
  it('0.7 → yellow', () => expect(healthDotKind(0.7, 10)).toBe('yellow'))
  it('恰好 0.9 → null（≥0.9 无角标）', () => expect(healthDotKind(0.9, 10)).toBeNull())
  it('0.95 → null', () => expect(healthDotKind(0.95, 10)).toBeNull())
  it('null（total=0 归一产物）→ null', () => expect(healthDotKind(null, 0)).toBeNull())
  it('total=0 兜底 → null', () => expect(healthDotKind(0.4, 0)).toBeNull())
})

describe('healthDotTitle', () => {
  it('「近24h 成功率 x/x」', () => {
    expect(healthDotTitle(24, 3, 4)).toBe('近24h 成功率 3/4')
  })
})
