/**
 * S1-1 定时探活对账的**纯逻辑**部分
 * （spec: docs/superpowers/specs/2026-10-09-mph-s11-liveness-reconciliation-design.md §3）。
 *
 * IO（fetch /v1/models、GenerationRecord 24h 成功计数、DB 读写）全部落在
 * upstream-probe.service.ts（Task 2）——本文件零 IO、零依赖、零 import，
 * 与 upstreamReconciliation.ts 同款纪律，可被 service 与测试直接消费。
 *
 * Ruling A（2026-10-09，绑定）：把模型灰显为 unavailable 需要同时满足
 *   ① 连续探活失败 ≥ 3 次（该模型连续被判 ghost）且
 *   ② 该模型近 24h 零成功生成记录（recentSuccesses = 0）。
 * 任一不满足 ⇒ 只记日志、绝不灰显。依据：B0 探针实证 /models 清单 ≠ 全量可用
 * （minimax-speech-2.8-hd 不在清单但生产成功 5 次），防「清单缺失但实际可用」假阳性。
 */

/** `ProviderChannel.models` JSON 条目的 availability 三态。旧数据缺字段读为 unknown。 */
export type ModelAvailability = 'available' | 'unavailable' | 'unknown'

/** 探活器消费的 models 条目最小结构（ChannelModelEntry 结构同构；capability 值不做校验）。 */
export interface ModelEntryLike {
  name: string
  capability: string
  /** 旧格式条目无此字段 ⇒ 按 unknown 处理；写出时一律升级为显式值。 */
  availability?: string
}

/**
 * 单个模型的探活健康快照（Ruling A 双条件的两半）：
 * - consecutiveFailures：该模型连续被判 ghost 的次数（内存计数，重启归零）；
 * - recentSuccesses：该模型近 24h 真实成功生成次数（GenerationRecord SQL 计数）。
 */
export interface ModelProbeHealth {
  consecutiveFailures: number
  recentSuccesses: number
}

/** 按模型名（= models 条目的 name，即 modelKey）索引的健康快照。缺省条目按 {0, 0} 处理。 */
export type ProbeHealthByModel = Record<string, ModelProbeHealth>

/**
 * diffCatalogAgainstUpstream（packages/shared/src/upstreamReconciliation.ts）的
 * 结构同构 —— 不直接 import 它以保持本文件零依赖；shared 的返回值天然满足本接口。
 * ghosts/matched 均为 modelKey（面向目录），与 models 条目的 name 同空间。
 */
export interface UpstreamDiffLike {
  ghosts: readonly string[]
  missing?: readonly string[]
  matched: readonly string[]
}

/** 灰显连败阈值（含）：连败 ≥ 3 且近 24h 零成功才灰显（Ruling A）。 */
export const UNAVAILABLE_FAILURE_THRESHOLD = 3

/** 写入计划的单个条目：availability 恒为显式三态值；logged 仅在「灰显被压制」时出现。 */
export interface AvailabilityWriteEntry {
  name: string
  capability: string
  availability: ModelAvailability
  /**
   * 该模型本轮被判 ghost 但灰显被健康背书压制（连败不足或近 24h 有成功）⇒ true。
   * 调用方据此打 `[MPH][probe]` 结构化日志；availability 保持原值不变。
   */
  logged?: boolean
}

/**
 * 由本轮探活 diff + 各模型健康快照，产出平台渠道 models 的完整写入计划。
 *
 * 三态转换（A1 矩阵）：
 * - ghost ∧ 连败≥3 ∧ 零成功 ⇒ `unavailable`（灰显，双条件缺一不可）；
 * - ghost ∧（连败<3 ∨ 有成功）⇒ 原值不变 + `logged: true`（只记日志，绝不灰显）；
 * - matched ∧ 当前 `unavailable` ⇒ `available`（A4 恢复：探活通过即平反）；
 * - 其余（归属其他上游 / 非 ghost 非 matched）⇒ 原样保留，绝不触碰。
 *
 * 输出与 prevModels 等长同序；旧格式条目（无 availability 字段）读为 unknown，
 * 计划里升级为显式值（A5：探活器可对旧数据正常升级写入）。纯函数：零 IO。
 */
export function planAvailabilityWrites(
  prevModels: readonly ModelEntryLike[],
  diffByUpstream: UpstreamDiffLike,
  healthByModel: ProbeHealthByModel,
): AvailabilityWriteEntry[] {
  const ghostSet = new Set(diffByUpstream.ghosts)
  const matchedSet = new Set(diffByUpstream.matched)

  return prevModels.map((entry) => {
    const prevAvailability = normalizeAvailability(entry.availability)

    if (ghostSet.has(entry.name)) {
      const strikes = healthByModel[entry.name]?.consecutiveFailures ?? 0
      const successes = healthByModel[entry.name]?.recentSuccesses ?? 0
      if (strikes >= UNAVAILABLE_FAILURE_THRESHOLD && successes === 0) {
        return { name: entry.name, capability: entry.capability, availability: 'unavailable' }
      }
      // Ruling A：双条件任一不满足 ⇒ 只记日志，绝不灰显（已灰显的也不因健康背书解除，
      // 恢复唯一通路是探活通过）。availability 保持原值。
      return {
        name: entry.name,
        capability: entry.capability,
        availability: prevAvailability,
        logged: true,
      }
    }

    if (matchedSet.has(entry.name) && prevAvailability === 'unavailable') {
      // A4 恢复：上游清单重新包含该模型 ⇒ 置回 available。
      return { name: entry.name, capability: entry.capability, availability: 'available' }
    }

    // 与本轮 diff 无关的条目原样保留；旧格式在此升级为显式 unknown。
    return { name: entry.name, capability: entry.capability, availability: prevAvailability }
  })
}

/**
 * 连败计数器（纯函数）：本轮该模型探活通过（出现在上游清单）⇒ 归零；否则 +1。
 * 探活 run 整体失败（上游不可达）时调用方不得把任何模型判为 ghost ⇒ 不调本函数。
 */
export function bumpConsecutiveFailures(prev: number, ok: boolean): number {
  return ok ? 0 : prev + 1
}

/** 非法/缺失的存量值一律读为 unknown（保守：unknown 不触发恢复、也绝不灰显）。 */
function normalizeAvailability(value: string | undefined): ModelAvailability {
  return value === 'available' || value === 'unavailable' ? value : 'unknown'
}
