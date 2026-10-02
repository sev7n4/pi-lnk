/**
 * 多模态直通组装（T1 Nest 侧）测试：视觉模型 + 侧栏图片附件 → base64 images + [In=] 标记。
 * IO（读盘/缩图）全 DI，测试不碰真实 uploads。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { buildDirectImagePayload } from './direct-image-payload'

const PNG_1PX = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d,
])

describe('buildDirectImagePayload（T1）', () => {
  afterEach(() => {
    delete process.env.SIDEBAR_VISION_MODELS
  })

  it('非视觉模型 → undefined（识图兜底路径）', async () => {
    const out = await buildDirectImagePayload({
      model: 'deepseek-v4-pro',
      attachments: [{ url: '/uploads/u1/a.png', mediaType: 'image' }],
      readBuffer: async () => PNG_1PX,
    })
    expect(out).toBeUndefined()
  })

  it('视觉模型 + 图片附件 → images（base64 无前缀）+ [I1=文件名] 标记', async () => {
    const out = await buildDirectImagePayload({
      model: 'gemini-2.5-flash',
      attachments: [{ url: '/uploads/u1/a.png', mediaType: 'image' }],
      readBuffer: async () => PNG_1PX,
    })
    expect(out?.images).toHaveLength(1)
    expect(out?.images[0]).toMatchObject({ name: 'a.png', mimeType: 'image/png' })
    expect(out?.images[0].data).not.toContain('data:')
    expect(out?.markers).toEqual(['[I1=a.png]'])
  })

  it('无图片附件 → undefined', async () => {
    const out = await buildDirectImagePayload({
      model: 'gemini-2.5-flash',
      attachments: [{ text: '纯文本素材' }],
      readBuffer: async () => PNG_1PX,
    })
    expect(out).toBeUndefined()
  })

  it('原始 >5MB → 缩图一次后收进 payload', async () => {
    const big = Buffer.concat([PNG_1PX, Buffer.alloc(6 * 1024 * 1024, 1)])
    const small = Buffer.alloc(1024, 2)
    const out = await buildDirectImagePayload({
      model: 'gemini-2.5-flash',
      attachments: [{ url: '/uploads/u1/big.jpg', mediaType: 'image' }],
      readBuffer: async () => big,
      downscale: async (buf) => ({ buffer: buf === big ? small : buf, changed: true }),
    })
    expect(out?.images).toHaveLength(1)
    expect(out?.images[0].data.length).toBeLessThan(2048)
  })

  it('单张读盘失败 → 跳过该图不阻断；全失败 → undefined', async () => {
    const out = await buildDirectImagePayload({
      model: 'gemini-2.5-flash',
      attachments: [
        { url: '/uploads/u1/broken.png', mediaType: 'image' },
        { url: '/uploads/u1/ok.png', mediaType: 'image' },
      ],
      readBuffer: async (url) => {
        if (url.includes('broken')) throw new Error('ENOENT')
        return PNG_1PX
      },
    })
    expect(out?.images).toHaveLength(1)
    expect(out?.markers).toEqual(['[I1=ok.png]'])

    const none = await buildDirectImagePayload({
      model: 'gemini-2.5-flash',
      attachments: [{ url: '/uploads/u1/broken.png', mediaType: 'image' }],
      readBuffer: async () => {
        throw new Error('ENOENT')
      },
    })
    expect(none).toBeUndefined()
  })

  it('超过 4 张 → 只取前 4（Nest 侧上限，与识图同款）', async () => {
    const out = await buildDirectImagePayload({
      model: 'gemini-2.5-flash',
      attachments: [1, 2, 3, 4, 5].map((i) => ({ url: `/uploads/u1/f${i}.png`, mediaType: 'image' })),
      readBuffer: async () => PNG_1PX,
    })
    expect(out?.images).toHaveLength(4)
    expect(out?.markers).toEqual(['[I1=f1.png]', '[I2=f2.png]', '[I3=f3.png]', '[I4=f4.png]'])
  })
})
