import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { StudioService } from './studio.service'

/**
 * 回归锁：`platformGatewayModelId` 曾把 `resolveModelKey` 的 `fallback` 标记
 * 直接丢掉（只返回 `.entry.gatewayModelId`）⇒ BYOK 失败后回退平台时，
 * 即便实际换成了另一个模型，用户与后续读metadata 的人都无法判别。
 *
 * 四条链路都走它：image(2659) / text(2723) / audio(2792) / video(2846)。
 */
describe('platformGatewayModelId 的模型替换信号', () => {
  const svc = new StudioService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never)

  const resolve = (modality: 'text' | 'image' | 'video' | 'audio', meta: Record<string, unknown>) =>
    (
      svc as unknown as {
        platformGatewayModelId: (
          m: 'text' | 'image' | 'video' | 'audio',
          meta: Record<string, unknown>,
        ) => { gatewayModelId: string; modelFallback?: true; originalModel?: string; modelKey: string }
      }
    ).platformGatewayModelId(modality, meta)

  it('keeps the requested catalog model unmarked', () => {
    const r = resolve('video', { modelKey: 'agnes-video-v2.0' })
    expect(r.gatewayModelId).toBe('agnes-video-v2.0')
    expect(r.modelFallback).toBeUndefined()
  })

  it('marks the swap and records both models when the request is not in catalog', () => {
    const r = resolve('video', { modelKey: 'sora' })
    expect(r.modelFallback).toBe(true)
    // 降级必须可回答「要的是什么/用了什么」，否则前端无法提示
    expect(r.originalModel).toBe('sora')
    expect(r.modelKey).not.toBe('sora')
    expect(r.gatewayModelId).toBeTruthy()
  })

  it('marks image modality too', () => {
    const r = resolve('image', { modelKey: 'dall-e-3' })
    expect(r.modelFallback).toBe(true)
    expect(r.originalModel).toBe('dall-e-3')
  })

  it('treats a missing modelKey as the default, NOT as a swap', () => {
    // 空 modelKey 走默认是正常路径，不是「用户选了别的被换掉」
    const r = resolve('video', {})
    expect(r.modelFallback).toBeUndefined()
    expect(r.gatewayModelId).toBe('agnes-video-v2.0')
  })
})