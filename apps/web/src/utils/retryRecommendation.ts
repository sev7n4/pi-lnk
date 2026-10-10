import {
  decodeChannelModel,
  encodeChannelModel,
  PLATFORM_CHANNEL_ID,
  recommendRetryModel,
  type ModelCapability,
} from '@lnkpi/shared'
import type { ModelHealthSummaryRow } from '@lnkpi/shared/modelHealth'
import { getModelEntry, listModels } from '@/constants/studioModels'
import type { ProviderChannelPublic } from '@/services/provider-api'

/**
 * S2-3 换模型重试——web 侧候选池组装层。
 *
 * 判定内核是 shared 的 `recommendRetryModel` 纯函数（SSOT，勿在此重写规则）；
 * 本层只做数据源拼装：
 * - 平台渠道候选：web 目录归一层 `listModels(modality)`（S2-1b 服务端下发条目，
 *   displayName 从归一层取，⛔ 不直 import shared 常量目录）；
 * - BYOK 渠道候选：bootstrap 渠道镜像条目（BYOK 无目录条目，displayName=模型名）；
 * - availability：bootstrap 渠道镜像三态（只读，探活器唯一写入方）；
 * - successRate：用户健康投影行（/api/model-health/summary）按 (model, channelId) 匹配。
 *
 * 同渠道语义：失败模型 ref 的 channelId（裸名归一为平台）——BYOK 失败只推荐该
 * 渠道自己的模型，平台失败只推荐平台目录条目（跨渠道计费语义不同，首版不做）。
 */

export interface RetryRecommendationView {
  /** 渠道 ref（`platform::<modelKey>` / `<channelId>::<model>`），供重试 patch 使用。 */
  modelKey: string
  /** 按钮文案里的模型名（平台=目录 displayName；BYOK=模型名）。 */
  displayName: string
  /** 推荐理由（来自 shared 纯函数）。 */
  reason: string
}

/** GenerationRecord.type → 生成模态（无法识别返回 null，调用方不渲染重试区）。 */
export function recordTypeToModality(type: string | null | undefined): ModelCapability | null {
  if (type === 'image' || type === 'video' || type === 'audio' || type === 'text') return type
  return null
}

/** 健康投影行按 (model, channelId) 匹配：平台模型用平台行，BYOK 用本人非平台行。 */
export function successRateOfModel(
  rows: readonly ModelHealthSummaryRow[] | null | undefined,
  modelValue: string,
): number | null {
  if (!rows?.length) return null
  const decoded = decodeChannelModel(modelValue)
  if (!decoded) return null
  const row = rows.find(
    (r) =>
      r.model === decoded.modelName &&
      (decoded.channelId === PLATFORM_CHANNEL_ID
        ? r.channelId === PLATFORM_CHANNEL_ID
        : r.channelId !== PLATFORM_CHANNEL_ID),
  )
  return row ? row.successRate : null
}

export function buildRetryRecommendation(input: {
  /** 失败模型（record.model / metadata.modelKey；裸名或 `channel::model`）。 */
  failedModel: string | null | undefined
  modality: ModelCapability
  channels: readonly ProviderChannelPublic[]
  healthRows?: readonly ModelHealthSummaryRow[]
}): RetryRecommendationView | null {
  const failed = input.failedModel?.trim()
  if (!failed) return null
  const decoded = decodeChannelModel(failed)
  const failedChannel = decoded?.channelId ?? PLATFORM_CHANNEL_ID
  // 平台记录可能存 gatewayModelId（如 doubao-seedream-5-0-pro），候选池却是
  // modelKey 空间——先经归一层目录把失败模型翻译回规范 modelKey，避免推荐循环
  // 把失败模型自己再推一次。
  let failedRef = failed
  if (failedChannel === PLATFORM_CHANNEL_ID) {
    const failedName = decoded?.modelName ?? failed
    const entry = getModelEntry(failedName)
    if (entry) failedRef = encodeChannelModel(PLATFORM_CHANNEL_ID, entry.modelKey)
  }

  const candidates: Array<{
    modelKey: string
    displayName: string
    availability: 'available' | 'unavailable' | 'unknown'
    successRate: number | null
    capability?: ModelCapability
  }> = []

  if (failedChannel === PLATFORM_CHANNEL_ID) {
    for (const entry of listModels(input.modality)) {
      const modelKey = encodeChannelModel(PLATFORM_CHANNEL_ID, entry.modelKey)
      const mirror = input.channels
        .find((c) => c.id === PLATFORM_CHANNEL_ID)
        ?.models?.find((m) => m.name === entry.modelKey)
      candidates.push({
        modelKey,
        displayName: entry.displayName,
        availability: mirror?.availability === 'unavailable' ? 'unavailable' : 'unknown',
        successRate: successRateOfModel(input.healthRows, modelKey),
        capability: entry.modality,
      })
    }
  } else {
    const channel = input.channels.find((c) => c.id === failedChannel)
    if (!channel) return null
    for (const m of channel.models ?? []) {
      if (m.capability !== input.modality) continue
      const modelKey = encodeChannelModel(channel.id, m.name)
      candidates.push({
        modelKey,
        displayName: m.name,
        availability: m.availability === 'unavailable' ? 'unavailable' : 'unknown',
        successRate: successRateOfModel(input.healthRows, modelKey),
      })
    }
  }

  const rec = recommendRetryModel({
    failedModelKey: failedRef,
    capability: input.modality,
    candidates,
  })
  if (!rec) return null
  const picked = candidates.find((c) => c.modelKey === rec.modelKey)
  return {
    modelKey: rec.modelKey,
    displayName: picked?.displayName ?? (decodeChannelModel(rec.modelKey)?.modelName ?? rec.modelKey),
    reason: rec.reason,
  }
}
