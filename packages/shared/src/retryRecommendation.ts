/**
 * S2-3 换模型重试推荐（spec: docs/superpowers/specs/2026-10-09-mph-s23-failure-self-heal-design.md §3.2）。
 *
 * 纯函数、零 IO（与 modelHealth.ts 同纪律）：候选池、探活 availability、成功率由调用方
 * 注入（web 侧 `apps/web/src/utils/retryRecommendation.ts` 负责从目录归一层 / bootstrap
 * 渠道镜像 / 健康投影三个来源组装）。本文件只做规则判定：
 *
 * - 排除失败模型自身（裸名与 `channel::model` ref 两种形态归一后比较，再兜底原文比对）；
 * - 排除探活 `unavailable`（A4：绝不把用户推向又一个必挂模型）；
 * - **只推荐同渠道**：候选 ref 的 channelId 必须与失败模型一致（平台渠道候选 =
 *   `platform::<modelKey>`；BYOK 候选 = `<channelId>::<model>`；裸名按平台归一）。
 *   跨渠道计费语义不同，首版不做跨渠道推荐（spec §3.2 YAGNI）；
 * - successRate 降序、null（零流量）排可用组末位；同值按 modelKey 字典序保证确定性；
 * - 无候选 → null（前端不渲染重试按钮）。
 *
 * ⛔ 本函数不写 availability（探活器是唯一写入方，B1 裁定），只读过滤。
 */
import { decodeChannelModel, PLATFORM_CHANNEL_ID, type ModelCapability } from './providerChannels'

export type RetryCandidateAvailability = 'available' | 'unavailable' | 'unknown'

export interface RetryModelCandidate {
  /** 渠道 ref（`platform::<modelKey>` / `<channelId>::<model>`）或裸名（按平台归一）。 */
  modelKey: string
  /** 探活三态；缺省按 unknown（正常参选，与 web availabilityOfModel 同口径）。 */
  availability?: RetryCandidateAvailability
  /** completed/total；total=0 或无数据 → null（排可用组末位，不淘汰）。 */
  successRate: number | null
  /** 目录模态（text/image/video/audio，与 StudioModality 同 union）；缺省视为调用方已过滤。 */
  capability?: ModelCapability
}

export interface RetryRecommendation {
  modelKey: string
  reason: string
}

/** 裸名 → 平台渠道归一（与 web resolveGenerationModel 的 encodeChannelModel 回落同语义）。 */
function channelRefOf(value: string): { channelId: string; modelName: string } {
  const decoded = decodeChannelModel(value)
  if (decoded) return decoded
  return { channelId: PLATFORM_CHANNEL_ID, modelName: value }
}

export function recommendRetryModel(input: {
  failedModelKey: string
  capability: ModelCapability
  candidates: readonly RetryModelCandidate[]
}): RetryRecommendation | null {
  const failed = input.failedModelKey?.trim()
  if (!failed) return null
  const failedRef = channelRefOf(failed)

  const eligible = input.candidates.filter((candidate) => {
    const key = candidate.modelKey?.trim()
    if (!key) return false
    // 排除失败模型自身：ref 归一后同渠道同名，或原文完全一致（gatewayModelId 别名
    // 由调用方在组装候选池时排除，纯函数只做可判定的归一比较）。
    const ref = channelRefOf(key)
    if (ref.channelId === failedRef.channelId && ref.modelName === failedRef.modelName) return false
    if (key === failed) return false
    // 只推荐同渠道（同 channelId＝同 provider 绑定语义）
    if (ref.channelId !== failedRef.channelId) return false
    // 排除探活 unavailable（A4）；available/unknown 都可参选
    if (candidate.availability === 'unavailable') return false
    // 候选自带模态标签时按 capability 过滤（缺省视为调用方已按目录模态过滤）
    if (candidate.capability !== undefined && candidate.capability !== input.capability) return false
    return true
  })
  if (eligible.length === 0) return null

  const sorted = [...eligible].sort((a, b) => {
    const ar = a.successRate
    const br = b.successRate
    if (ar == null && br == null) return a.modelKey.localeCompare(b.modelKey)
    if (ar == null) return 1
    if (br == null) return -1
    if (br !== ar) return br - ar
    return a.modelKey.localeCompare(b.modelKey)
  })
  const top = sorted[0]!
  const reason =
    top.successRate == null
      ? '同渠道可用（暂无成功率数据）'
      : `同渠道成功率 ${(top.successRate * 100).toFixed(0)}%`
  return { modelKey: top.modelKey, reason }
}
