import {
  listModels,
  defaultModelKey,
  resolveModelKey,
  getModelEntry,
  decodeChannelModel,
  encodeChannelModel,
  modelOptionName,
  normalizeModelRef,
  supportsThinkingLevel,
  type StudioModality,
  type StudioModelEntry,
  type StudioVoiceOption,
} from '@lnkpi/shared'

export {
  listModels,
  defaultModelKey,
  resolveModelKey,
  getModelEntry,
  decodeChannelModel,
  encodeChannelModel,
  modelOptionName,
  supportsThinkingLevel,
  type StudioModality,
  type StudioModelEntry,
  type StudioVoiceOption,
}

export function modelsAsSelectorOptions(modality: StudioModality) {
  return listModels(modality).map((m) => ({
    id: m.modelKey,
    name: m.displayName,
    provider: 'catalog',
  }))
}

/**
 * 节点级生成模型解析：有值时归一（委托 shared 的 SSOT），无值时回落到平台默认。
 * ⚠️ 与 agent 侧 update_node 共用 normalizeModelRef，勿在组件里重写判定。
 */
export function resolveGenerationModel(
  modality: StudioModality,
  requested?: string | null,
): string {
  const normalized = normalizeModelRef(modality, requested)
  if (normalized) return normalized.ref
  return encodeChannelModel('platform', defaultModelKey(modality))
}

export function catalogModelKeyFromValue(value: string): string {
  return decodeChannelModel(value)?.modelName ?? value
}

/** DeepSeek V4 family (pro/flash) plus official V4.1 Flash id — Dock thinking UI. */
export function isDeepSeekV4Model(model?: string | null): boolean {
  if (!model) return false
  return /deepseek-v4/i.test(model) || /(?:^|[/:])deepseek-flash(?:[-./]|$)/i.test(model)
}
