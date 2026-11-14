// apps/server/src/pricing/pricing-metrics.ts
/**
 * S1 定价链路计数器（YAGNI：不引入 prom-client，进程内 Map + 结构化 log）。
 * 告警阈值与上报口径见 spec §9；本模块只负责计数与可观测输出。
 *
 * 计数器：
 * - resolution level：quote() 六级解析每级命中次数（level = 'gray_subject' | 'global_subject' |
 *   'model_default' | 'exact' | 'capability_default' | 'legacy' | 'fallback'）。
 * - materialize outcome：added / changed / unchanged / missingCost / floorViolation。
 * - costSource：成本来源分布（official_list / channel_actual / negotiated / provisional 回落）。
 * - unitMismatch：四层单位无法对齐的能力 + 原因。
 * - subject：PricingSubject 状态分布（draft / cost_missing / priced / published / offboarded）。
 */

type ResolutionLevel =
  | 'gray_subject'
  | 'global_subject'
  | 'model_default'
  | 'exact'
  | 'capability_default'
  | 'legacy'
  | 'fallback'

type MaterializeOutcome =
  | 'added'
  | 'changed'
  | 'unchanged'
  | 'missingCost'
  | 'floorViolation'

const resolution = new Map<ResolutionLevel, number>()
const materializeOutcomes = new Map<MaterializeOutcome, number>()
const costSources = new Map<string, number>()
const unitMismatches = new Map<string, number>()
const subjects = new Map<string, number>()

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

export function incResolution(level: ResolutionLevel): void {
  bump(resolution as Map<string, number>, level)
  // 结构化日志便于 ops-console 采集（不引入外部 agent）。
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ metric: 'pricing_resolution_total', level, count: resolution.get(level) }))
}

export function incMaterialize(outcome: MaterializeOutcome): void {
  bump(materializeOutcomes as Map<string, number>, outcome)
}

export function incCostSource(source: string): void {
  bump(costSources, source)
}

export function incUnitMismatch(capability: string, reason: string): void {
  bump(unitMismatches, `${capability}:${reason}`)
}

export function incSubject(status: string): void {
  bump(subjects, status)
}

/** 调试/运维自测用：返回当前各计数器快照（不暴露到生产端点，YAGNI）。 */
export function snapshotMetrics(): {
  resolution: Record<string, number>
  materialize: Record<string, number>
  costSource: Record<string, number>
  unitMismatch: Record<string, number>
  subject: Record<string, number>
} {
  return {
    resolution: Object.fromEntries(resolution),
    materialize: Object.fromEntries(materializeOutcomes),
    costSource: Object.fromEntries(costSources),
    unitMismatch: Object.fromEntries(unitMismatches),
    subject: Object.fromEntries(subjects),
  }
}
