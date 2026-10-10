import { beforeEach, describe, expect, it } from 'vitest'
import type { ModelHealthSummaryRow } from '@lnkpi/shared/modelHealth'
import { __resetStudioCatalogForTests, setStudioCatalogEntries } from '@/constants/studioModels'
import type { ProviderChannelPublic } from '@/services/provider-api'
import { buildRetryRecommendation, successRateOfModel } from './retryRecommendation'

function mkChannel(
  id: string,
  models: Array<{ name: string; capability: string; availability?: string }>,
): ProviderChannelPublic {
  return {
    id,
    name: id,
    apiFormat: 'openai',
    baseUrl: 'https://x.example.com/v1',
    models: models as ProviderChannelPublic['models'],
    hasApiKey: true,
    readOnly: false,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
  }
}

function mkRow(
  partial: Partial<ModelHealthSummaryRow> & Pick<ModelHealthSummaryRow, 'model' | 'channelId'>,
): ModelHealthSummaryRow {
  return {
    windowHours: 24,
    total: 10,
    completed: 9,
    failed: 1,
    fallbackPending: 0,
    refunded: 0,
    successRate: 0.9,
    ...partial,
  } as ModelHealthSummaryRow
}

const catalog = [
  {
    modelKey: 'agnes-image-2.1-flash',
    displayName: 'Agnes 图像 2.1 Flash',
    gatewayModelId: 'agnes-image-2.1-flash',
    modality: 'image',
    providerBinding: 'gateway-openai-compat',
    params: { model: 'native' },
  },
  {
    modelKey: 'seedream-5.0-pro',
    displayName: 'Seedream 5.0 Pro',
    gatewayModelId: 'doubao-seedream-5-0-pro',
    modality: 'image',
    providerBinding: 'gateway-openai-compat',
    params: { model: 'native' },
  },
  {
    modelKey: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    gatewayModelId: 'deepseek-v4-flash',
    modality: 'text',
    providerBinding: 'gateway-openai-compat',
    params: { model: 'native' },
  },
] as unknown as Parameters<typeof setStudioCatalogEntries>[0]

beforeEach(() => {
  __resetStudioCatalogForTests()
  setStudioCatalogEntries(catalog)
})

describe('successRateOfModel', () => {
  it('平台模型匹配平台行，BYOK 只匹配非平台行', () => {
    const rows = [
      mkRow({ model: 'seedream-5.0-pro', channelId: 'platform', successRate: 0.8 }),
      mkRow({ model: 'custom-model', channelId: 'u1', successRate: 0.5 }),
    ]
    expect(successRateOfModel(rows, 'platform::seedream-5.0-pro')).toBe(0.8)
    expect(successRateOfModel(rows, 'u1::custom-model')).toBe(0.5)
    // 平台模型不误配 BYOK 行
    expect(successRateOfModel(rows, 'platform::custom-model')).toBeNull()
  })
})

describe('buildRetryRecommendation', () => {
  const platformChannel = mkChannel('platform', [
    { name: 'agnes-image-2.1-flash', capability: 'image', availability: 'available' },
    { name: 'seedream-5.0-pro', capability: 'image', availability: 'unavailable' },
  ])

  it('平台失败 → 只推荐平台候选，displayName 取归一层；unavailable 被排除', () => {
    const rec = buildRetryRecommendation({
      failedModel: 'platform::seedream-5.0-pro',
      modality: 'image',
      channels: [platformChannel],
      healthRows: [
        mkRow({ model: 'seedream-5.0-pro', channelId: 'platform', successRate: 0.9 }),
        mkRow({ model: 'agnes-image-2.1-flash', channelId: 'platform', successRate: 0.7 }),
      ],
    })
    // seedream 自身被排除 + unavailable 排除 → agnes 胜出（尽管成功率更低）
    expect(rec).toEqual({
      modelKey: 'platform::agnes-image-2.1-flash',
      displayName: 'Agnes 图像 2.1 Flash',
      reason: '同渠道成功率 70%',
    })
  })

  it('失败模型存 gatewayModelId（record.model 形态）→ 经归一层翻译后不再推荐自身', () => {
    const rec = buildRetryRecommendation({
      failedModel: 'doubao-seedream-5-0-pro',
      modality: 'image',
      channels: [platformChannel],
    })
    expect(rec?.modelKey).toBe('platform::agnes-image-2.1-flash')
  })

  it('全候选 successRate=null（冷启动）→ 仍给出推荐（字典序首个可用）', () => {
    const rec = buildRetryRecommendation({
      failedModel: 'platform::seedream-5.0-pro',
      modality: 'image',
      channels: [mkChannel('platform', [{ name: 'agnes-image-2.1-flash', capability: 'image' }])],
    })
    expect(rec).toEqual({
      modelKey: 'platform::agnes-image-2.1-flash',
      displayName: 'Agnes 图像 2.1 Flash',
      reason: '同渠道可用（暂无成功率数据）',
    })
  })

  it('BYOK 失败 → 只推荐该渠道自己的模型；渠道不存在 → null', () => {
    const channels = [
      platformChannel,
      mkChannel('ch_user', [
        { name: 'flux-pro', capability: 'image', availability: 'available' },
        { name: 'flux-dev', capability: 'image', availability: 'unavailable' },
      ]),
    ]
    const rec = buildRetryRecommendation({
      failedModel: 'ch_user::flux-dev',
      modality: 'image',
      channels,
      healthRows: [mkRow({ model: 'flux-pro', channelId: 'u1', successRate: 0.4 })],
    })
    expect(rec).toEqual({
      modelKey: 'ch_user::flux-pro',
      displayName: 'flux-pro',
      reason: '同渠道成功率 40%',
    })
    expect(
      buildRetryRecommendation({
        failedModel: 'ch_missing::flux-dev',
        modality: 'image',
        channels,
      }),
    ).toBeNull()
  })

  it('无失败模型 / 唯一候选=失败模型自身 → null（不渲染重试按钮）', () => {
    expect(
      buildRetryRecommendation({ failedModel: null, modality: 'image', channels: [platformChannel] }),
    ).toBeNull()
    // 单条目目录：唯一 image 候选就是失败模型自身
    setStudioCatalogEntries([
      {
        modelKey: 'agnes-image-2.1-flash',
        displayName: 'Agnes 图像 2.1 Flash',
        gatewayModelId: 'agnes-image-2.1-flash',
        modality: 'image',
        providerBinding: 'gateway-openai-compat',
        params: { model: 'native' },
      },
    ] as unknown as Parameters<typeof setStudioCatalogEntries>[0])
    expect(
      buildRetryRecommendation({
        failedModel: 'platform::agnes-image-2.1-flash',
        modality: 'image',
        channels: [
          mkChannel('platform', [{ name: 'agnes-image-2.1-flash', capability: 'image' }]),
        ],
      }),
    ).toBeNull()
  })
})
