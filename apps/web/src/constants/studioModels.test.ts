import { describe, expect, it } from 'vitest'
import {
  STUDIO_MODEL_CATALOG,
  defaultModelKey,
  encodeChannelModel,
  getModelEntry as getModelEntryShared,
  listModels as listModelsShared,
  resolveModelKey as resolveModelKeyShared,
  type StudioModelEntry,
} from '@lnkpi/shared'
import {
  __resetStudioCatalogForTests,
  catalogModelKeyFromValue,
  getStudioCatalogEntries,
  getModelEntry,
  listModels,
  listModelsByAudioKind,
  resolveGenerationModel,
  resolveModelKey,
  setStudioCatalogEntries,
} from './studioModels'

// 本文件是「resolveGenerationModel 改为委托 shared 的 normalizeModelRef」的行为回归锁。
// 改动前它无测试，而消费方有 9 处（useNodeGeneration / sceneComposer / 6 个 DockPanel），
// 一旦归一语义漂移就会表现为「节点芯片显示错模型」，故必须锁住。
describe('resolveGenerationModel', () => {
  it('已编码 ref（BYOK 渠道）原样返回，不被改写成 platform', () => {
    expect(resolveGenerationModel('image', 'ch_byok_1::my-model')).toBe('ch_byok_1::my-model')
  })

  it('平台已编码 ref 原样返回', () => {
    expect(resolveGenerationModel('image', 'platform::image2')).toBe('platform::image2')
  })

  it('裸名（目录内）→ platform::<modelKey>', () => {
    expect(resolveGenerationModel('image', 'image2')).toBe(encodeChannelModel('platform', 'image2'))
  })

  it('无值 / 空串 / 纯空白 → 平台默认模型', () => {
    const fallback = encodeChannelModel('platform', 'agnes-image-2.1-flash')
    expect(resolveGenerationModel('image', undefined)).toBe(fallback)
    expect(resolveGenerationModel('image', null)).toBe(fallback)
    expect(resolveGenerationModel('image', '')).toBe(fallback)
    expect(resolveGenerationModel('image', '   ')).toBe(fallback)
  })

  it('裸名不在目录中 → 回落平台默认（与改动前一致）', () => {
    // 从 defaultModelKey 派生而非硬编码字面量：默认模型切换（2026-10-10 v2.0→2.5-flash）不再碰测试
    expect(resolveGenerationModel('video', '完全不存在的模型-xyz')).toBe(
      encodeChannelModel('platform', defaultModelKey('video')),
    )
  })
})

/**
 * S2-1b 目录来源切换（A4 + 注入语义）：
 * - 初态（未注入）与常量目录逐条一致；注入种子常量后仍逐条一致；
 * - 注入自定义 rows（后台新增/下架）后 listModels / getModelEntry / resolveModelKey /
 *   resolveGenerationModel 反映新目录 ——「来源真的切了」；
 * - 空数组 / 非数组注入被忽略（bootstrap 失败保底常量，不掏空目录）。
 */
describe('studioModels 归一层目录注入（S2-1b）', () => {
  it('初态：未注入时与常量目录逐条一致（A4 对拍基线）', () => {
    for (const modality of ['text', 'image', 'video', 'audio'] as const) {
      expect(listModels(modality)).toEqual(listModelsShared(modality))
    }
    for (const entry of STUDIO_MODEL_CATALOG) {
      expect(getModelEntry(entry.modelKey)).toEqual(getModelEntryShared(entry.modelKey))
      expect(getModelEntry(entry.gatewayModelId)).toEqual(getModelEntryShared(entry.gatewayModelId))
      expect(resolveModelKey(entry.modality, entry.modelKey)).toEqual(
        resolveModelKeyShared(entry.modality, entry.modelKey),
      )
    }
  })

  it('注入种子常量后仍逐条一致（下发 payload 形状对拍）', () => {
    setStudioCatalogEntries(STUDIO_MODEL_CATALOG)
    expect(getStudioCatalogEntries()).toBe(STUDIO_MODEL_CATALOG)
    for (const modality of ['text', 'image', 'video', 'audio'] as const) {
      expect(listModels(modality)).toEqual(listModelsShared(modality))
    }
    expect(listModelsByAudioKind('voice').map((m) => m.modelKey)).toEqual(
      STUDIO_MODEL_CATALOG.filter((e) => e.modality === 'audio' && (e.audioKind ?? 'voice') === 'voice').map(
        (m) => m.modelKey,
      ),
    )
  })

  it('注入自定义 rows：后台新增条目可解析、下架条目回落', () => {
    const injected: StudioModelEntry[] = [
      ...STUDIO_MODEL_CATALOG.filter((e) => e.modelKey !== 'navo-pro'),
      {
        modelKey: 'admin-model-x',
        displayName: '后台新增模型 X',
        gatewayModelId: 'admin-gateway-x',
        modality: 'image',
        providerBinding: 'gateway-openai-compat',
        params: { model: 'native' },
      },
    ]
    setStudioCatalogEntries(injected)
    expect(listModels('image').map((m) => m.modelKey)).toContain('admin-model-x')
    expect(getModelEntry('admin-gateway-x')?.displayName).toBe('后台新增模型 X')
    expect(resolveModelKey('image', 'admin-gateway-x')).toMatchObject({
      modelKey: 'admin-model-x',
      fallback: false,
    })
    expect(resolveGenerationModel('image', 'admin-model-x')).toBe(
      encodeChannelModel('platform', 'admin-model-x'),
    )
    expect(listModels('image').map((m) => m.modelKey)).not.toContain('navo-pro')
    expect(resolveModelKey('image', 'navo-pro').fallback).toBe(true)
    // 未知模型 → 平台默认
    expect(resolveGenerationModel('video', 'no-such-model')).toBe(
      encodeChannelModel('platform', defaultModelKey('video')),
    )
  })

  it('空数组 / 非数组注入被忽略（bootstrap 失败保底常量）', () => {
    __resetStudioCatalogForTests()
    setStudioCatalogEntries([])
    expect(getStudioCatalogEntries()).toHaveLength(STUDIO_MODEL_CATALOG.length)
    // TS 类型收窄为 StudioModelEntry[]，运行时防线仍要在（服务端异常返回 null 等形态）
    ;(setStudioCatalogEntries as (v: unknown) => void)(null)
    ;(setStudioCatalogEntries as (v: unknown) => void)('nope')
    expect(listModels('text')).toEqual(listModelsShared('text'))
  })

  it('catalogModelKeyFromValue：编码 ref 解出 modelKey，裸值原样', () => {
    expect(catalogModelKeyFromValue(encodeChannelModel('platform', 'seed-audio-1.0'))).toBe(
      'seed-audio-1.0',
    )
    expect(catalogModelKeyFromValue('bare-key')).toBe('bare-key')
  })
})
