import { describe, expect, it } from 'vitest'
import { encodeChannelModel } from '@lnkpi/shared'
import { resolveGenerationModel } from './studioModels'

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
    expect(resolveGenerationModel('video', '完全不存在的模型-xyz')).toBe(
      encodeChannelModel('platform', 'agnes-video-v2.0'),
    )
  })
})
