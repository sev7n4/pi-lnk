import {
  STUDIO_MODEL_CATALOG,
  defaultModelKey,
  decodeChannelModel,
  encodeChannelModel,
  getModelEntryFromRows,
  listModelsByAudioKindFromRows,
  listModelsFromRows,
  modelOptionName,
  normalizeModelRefFromRows,
  resolveModelKeyFromRows,
  supportsThinkingLevel,
  type StudioModality,
  type StudioModelEntry,
  type StudioVoiceOption,
} from '@lnkpi/shared'

/**
 * web 目录归一层（S2-1b，spec: docs/superpowers/specs/2026-10-09-mph-s21-catalog-as-data-design.md §3.2）。
 *
 * 目录来源切换：条目由服务端**随既有 bootstrap 响应下发**（`ProviderBootstrap.catalog`
 * ——payload 两案裁决：方案 A「扩既有响应体加 catalog 数组」，理由：
 * 平台渠道镜像 `platformChannel.models` 是 `{name, capability, availability}[]` 的
 * 探活/灰显专用形状（S1-1 语义），方案 B 往镜像条目上塞 displayName/params/voices
 * 会把「渠道镜像状态」与「目录条目数据」两种概念压进一个数组，且用户渠道的镜像
 * 条目没有目录对应物，形状只能靠「缺字段」区分；方案 A 语义清晰、与 admin 端点
 * 的条目形状同构）。`useProviderBootstrap.load()` 成功后调
 * {@link setStudioCatalogEntries} 注入，**不新增轮询通道**。
 *
 * 未注入/注入失败时回落种子常量 `STUDIO_MODEL_CATALOG`（与服务端播种后的 DB 内容
 * 逐字节一致），冷启动窗口渲染零漂移。判定内核仍是 shared 的 `*FromRows` 纯函数
 * （SSOT），本层只做「rows 来源切换」，不重写任何语义。
 */
let catalogRows: StudioModelEntry[] = STUDIO_MODEL_CATALOG

/**
 * 目录注入监听（B3 dockAudio 惰性求值）：派生量（音色表/默认音色）在注入成功后
 * 需要重算并重绑。registry 是通用回调表，归一层**不感知**订阅方是谁（studioModels
 * 不 import dockAudio ⇒ 无 dockAudio ↔ studioModels 循环依赖）。
 */
type CatalogRowsListener = () => void
const catalogRowsListeners = new Set<CatalogRowsListener>()

/** 订阅目录注入/重置变化；返回退订函数。 */
export function onStudioCatalogRowsChanged(listener: CatalogRowsListener): () => void {
  catalogRowsListeners.add(listener)
  return () => {
    catalogRowsListeners.delete(listener)
  }
}

function notifyCatalogRowsListeners(): void {
  for (const listener of catalogRowsListeners) listener()
}

/** 注入服务端下发的目录条目（bootstrap 响应到达时调用）。空数组/非数组忽略（保底常量）。 */
export function setStudioCatalogEntries(entries: StudioModelEntry[]): void {
  if (!Array.isArray(entries) || entries.length === 0) return
  catalogRows = entries
  notifyCatalogRowsListeners()
}

/** 观察当前生效 rows（测试/调试用）。 */
export function getStudioCatalogEntries(): StudioModelEntry[] {
  return catalogRows
}

/** 测试专用：回到常量初态（vitest per-file isolate，无需跨文件协调）。 */
export function __resetStudioCatalogForTests(): void {
  catalogRows = STUDIO_MODEL_CATALOG
  // 通知派生量订阅方重算（dockAudio），否则测试注入后派生值会滞留在注入态
  notifyCatalogRowsListeners()
}

export {
  defaultModelKey,
  decodeChannelModel,
  encodeChannelModel,
  modelOptionName,
  supportsThinkingLevel,
  type StudioModality,
  type StudioModelEntry,
  type StudioVoiceOption,
}

export function listModels(modality: StudioModality): StudioModelEntry[] {
  return listModelsFromRows(catalogRows, modality)
}

export function listModelsByAudioKind(kind: StudioModelEntry['audioKind']): StudioModelEntry[] {
  return listModelsByAudioKindFromRows(catalogRows, kind as NonNullable<StudioModelEntry['audioKind']>)
}

/** 按 id（modelKey 或 gatewayModelId）查条目——读注入 rows，不再直读常量。 */
export function getModelEntry(id: string): StudioModelEntry | undefined {
  return getModelEntryFromRows(catalogRows, id)
}

export function resolveModelKey(
  modality: StudioModality,
  requested?: string | null,
): { modelKey: string; entry: StudioModelEntry; fallback: boolean } {
  return resolveModelKeyFromRows(catalogRows, modality, requested)
}

export function modelsAsSelectorOptions(modality: StudioModality) {
  return listModels(modality).map((m) => ({
    id: m.modelKey,
    name: m.displayName,
    provider: 'catalog',
  }))
}

/**
 * 节点级生成模型解析：有值时归一（rows 注入形态，语义与 shared normalizeModelRef 同源），
 * 无值时回落到平台默认。
 * ⚠️ 与 agent 侧 update_node 共用 shared 的判定内核（normalizeModelRefFromRows），
 * 勿在组件里重写判定。
 */
export function resolveGenerationModel(
  modality: StudioModality,
  requested?: string | null,
): string {
  const normalized = normalizeModelRefFromRows(catalogRows, modality, requested)
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
