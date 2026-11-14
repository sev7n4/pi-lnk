// apps/server/src/admin/pricing-cost-shared.ts
/**
 * AC10（单一人民币 D9）：成本登记永不接受这些字段——折算已移到录入侧，绑 sourceRef 结算凭据。
 * 由 pricing-cost.controller 与 pricing-cost-record.controller（定价中心）共享。
 */
export const FORBIDDEN_COST_FIELDS = ['currency', 'currencySrc', 'fxRate', 'fxUsdCny', 'costUsd', 'usdPerM'] as const
