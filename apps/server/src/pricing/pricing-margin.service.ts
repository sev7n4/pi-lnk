// apps/server/src/pricing/pricing-margin.service.ts
/**
 * 利润率六档解析（Task 4）。
 *
 * 六档优先级（高→低）：model_spec > model > upstream > provider > modality > global。
 * 每档命中规则：`scope` 匹配且 `status==='active'` 且 `scopeKey`（缺省 '*'）匹配该档派生键。
 * 多档命中取最高优先级那一档；无命中取 global 缺省（profitBp 1000 / priceFloorBp 500）。
 *
 * 与 CostRate 不同，MarginPolicy 的 `phase` 是唯一键、由 `phaseOf()` 生成；同 scope 只允一条
 * active（应用层 CAS，见 plan Task 4）。本模块只做「给定多行，按六档解析出生效利润率」，不碰 DB。
 */

export interface MarginRow {
  id: string
  scope: string
  scopeKey: string | null
  profitBp: number
  priceFloorBp: number
  effectiveFrom: Date | null
  effectiveTo: Date | null
  status: string
}

export interface ResolvedMargin {
  profitBp: number
  priceFloorBp: number
  marginPolicyId: string
}

export const MARGIN_ORDER = ['model_spec', 'model', 'upstream', 'provider', 'modality', 'global'] as const

/** phase 唯一键：global 恒 'launch'；其余 `scope:${scope}:${scopeKey ?? '*'}`。 */
export function phaseOf(scope: string, scopeKey?: string | null): string {
  return scope === 'global' ? 'launch' : `scope:${scope}:${scopeKey ?? '*'}`
}

/**
 * 六档解析。subject 提供 capability/modelKey/spec/provider/upstream；rows 为候选 MarginPolicy。
 * 每档按派生键匹配；命中多条同档取 effectiveFrom 更晚者；无命中返回 global 缺省。
 */
export function resolveMargin(
  subject: {
    capability: string
    modelKey: string
    spec: string
    provider: string
    upstream: string
  },
  rows: MarginRow[],
  at: Date,
): ResolvedMargin {
  const keyOf = (scope: string): string => {
    switch (scope) {
      case 'model_spec':
        return `${subject.modelKey}|${subject.spec}`
      case 'model':
        return subject.modelKey
      case 'upstream':
        return subject.upstream
      case 'provider':
        return subject.provider
      case 'modality':
        return subject.capability
      default:
        return '*'
    }
  }
  for (const scope of MARGIN_ORDER) {
    const wanted = keyOf(scope)
    const hit = rows
      .filter((r) => r.scope === scope && r.status === 'active' && (r.scopeKey ?? '*') === wanted)
      .filter((r) => (!r.effectiveFrom || r.effectiveFrom <= at) && (!r.effectiveTo || r.effectiveTo > at))
      .sort((a, b) => (b.effectiveFrom?.getTime() ?? 0) - (a.effectiveFrom?.getTime() ?? 0))[0]
    if (hit) return { profitBp: hit.profitBp, priceFloorBp: hit.priceFloorBp, marginPolicyId: hit.id }
  }
  return { profitBp: 1000, priceFloorBp: 500, marginPolicyId: '' }
}
