/**
 * P1 · cost 费率解析（渠道 models[].pricing → pi 会话 override.cost）。
 *
 * 背景：SessionLlmOverride.cost 的 seam 早已留在 pi-runtime（model-assembly 把它
 * 填进 Model.cost，vendor calculateCost 响应时自动算 usage.cost），但 Nest 侧
 * 全平台没有任何费率来源，override.cost 从未下发 → 全链 cost=0，BYOK 用量无法
 * 按价归因。本模块补上「读」的一侧：
 *   写入面 = 渠道 models[].pricing（provider.controller 的 ModelPricingDto，
 *   随 ProviderChannel.models JSON 列落库，零迁移）；
 *   读取面 = 本文件，命中渠道 + 模型名 → 四元组费率。
 *
 * 解析纪律（对齐 provider-resolver 的「校验绝不比探活更激进」）：
 *   - JSON 畸形 / 非数组 / 模型未命中 / pricing 缺省或畸形 → undefined（不计费），
 *     绝不让坏数据阻断会话创建；
 *   - 单键非法（负数/非有限数）→ 整个 pricing 视为未声明（宁可少算不错算）；
 *   - 命中但某键缺省 → 该键补 0（vendor 消费完整四元组）。
 * 本文件不得打印 models 原文（渠道元数据不出 provider 模块边界）。
 */

export type OverrideModelCost = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const COST_KEYS = ['inputPerM', 'outputPerM', 'cacheReadPerM', 'cacheWritePerM'] as const

function isNonNegativeFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

export function resolveChannelModelCost(
  modelsJson: string | null | undefined,
  modelName: string,
): OverrideModelCost | undefined {
  const name = modelName?.trim().toLowerCase() ?? ''
  if (!name || !modelsJson) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(modelsJson)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  const entry = parsed.find(
    (m) =>
      typeof m === 'object' &&
      m !== null &&
      (m as { name?: unknown }).name === name &&
      typeof (m as { pricing?: unknown }).pricing === 'object' &&
      (m as { pricing?: unknown }).pricing !== null,
  )
  if (!entry) return undefined
  const pricing = (entry as { pricing: Record<string, unknown> }).pricing
  const out: OverrideModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let seen = false
  for (const key of COST_KEYS) {
    const raw = pricing[key]
    if (raw === undefined) continue
    if (!isNonNegativeFinite(raw)) return undefined
    out[key.replace(/PerM$/, '') as keyof OverrideModelCost] = raw
    seen = true
  }
  return seen ? out : undefined
}
