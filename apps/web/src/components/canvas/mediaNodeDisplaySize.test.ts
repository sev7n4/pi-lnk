import { describe, expect, it } from 'vitest'
import {
  parseRatioString,
  resolveImageNodeDisplaySize,
  resolveVideoNodeDisplaySize,
} from './mediaNodeDisplaySize'

describe('parseRatioString', () => {
  it('解析合法 W:H 串', () => {
    expect(parseRatioString('16:9')).toEqual({ w: 16, h: 9 })
    expect(parseRatioString(' 9 : 16 ')).toEqual({ w: 9, h: 16 })
    expect(parseRatioString('1:1')).toEqual({ w: 1, h: 1 })
  })

  it('非法值返回 null', () => {
    expect(parseRatioString('auto')).toBeNull()
    expect(parseRatioString('adaptive')).toBeNull()
    expect(parseRatioString('16/9')).toBeNull()
    expect(parseRatioString('')).toBeNull()
    expect(parseRatioString(16)).toBeNull()
    expect(parseRatioString(undefined)).toBeNull()
    expect(parseRatioString('0:9')).toBeNull()
  })
})

describe('resolveVideoNodeDisplaySize', () => {
  it('按请求比例 contain 进 320 包络', () => {
    expect(resolveVideoNodeDisplaySize({ videoSettings: { aspectRatio: '16:9' } })).toEqual({
      width: 320,
      height: 180,
    })
    expect(resolveVideoNodeDisplaySize({ videoSettings: { aspectRatio: '9:16' } })).toEqual({
      width: 180,
      height: 320,
    })
    expect(resolveVideoNodeDisplaySize({ videoSettings: { aspectRatio: '1:1' } })).toEqual({
      width: 320,
      height: 320,
    })
    expect(resolveVideoNodeDisplaySize({ videoSettings: { aspectRatio: '4:3' } })).toEqual({
      width: 320,
      height: 240,
    })
    expect(resolveVideoNodeDisplaySize({ videoSettings: { aspectRatio: '21:9' } })).toEqual({
      width: 320,
      height: 137,
    })
  })

  it('adaptive / 缺失 settings 走 1:1 兜底', () => {
    expect(resolveVideoNodeDisplaySize({ videoSettings: { aspectRatio: 'adaptive' } })).toEqual({
      width: 320,
      height: 320,
    })
    expect(resolveVideoNodeDisplaySize({})).toEqual({ width: 320, height: 320 })
  })

  it('probe 到的真实比例优先于请求比例（生成完成后校正）', () => {
    expect(
      resolveVideoNodeDisplaySize({
        videoSettings: { aspectRatio: '16:9' },
        mediaInfo: { kind: 'video', aspectRatio: '9:16' },
      }),
    ).toEqual({ width: 180, height: 320 })
  })
})

describe('resolveImageNodeDisplaySize', () => {
  it('按 imageAspect contain 进 280 包络，auto 走 1:1 兜底', () => {
    expect(resolveImageNodeDisplaySize({ imageAspect: '3:4' })).toEqual({ width: 210, height: 280 })
    expect(resolveImageNodeDisplaySize({ imageAspect: '16:9' })).toEqual({ width: 280, height: 158 })
    expect(resolveImageNodeDisplaySize({ imageAspect: 'auto' })).toEqual({ width: 280, height: 280 })
    expect(resolveImageNodeDisplaySize({})).toEqual({ width: 280, height: 280 })
  })

  it('probe 到的像素宽高优先于声明比例', () => {
    expect(
      resolveImageNodeDisplaySize({
        imageAspect: '1:1',
        mediaInfo: { kind: 'image', width: 1080, height: 1920, aspectRatio: '9:16' },
      }),
    ).toEqual({ width: 158, height: 280 })
  })

  it('probe 比例串（无像素宽高，视频式 summary）也能驱动尺寸', () => {
    expect(
      resolveImageNodeDisplaySize({
        mediaInfo: { kind: 'image', aspectRatio: '2:3' },
      }),
    ).toEqual({ width: 187, height: 280 })
  })

  it('显式 nodeSize（扩图应用链路）优先级最高，原样返回', () => {
    expect(
      resolveImageNodeDisplaySize({
        nodeSize: { width: 300, height: 150 },
        imageAspect: '16:9',
      }),
    ).toEqual({ width: 300, height: 150 })
  })

  it('非法 nodeSize 被忽略，回落到比例推导', () => {
    expect(
      resolveImageNodeDisplaySize({ nodeSize: { width: -1, height: 100 }, imageAspect: '1:1' }),
    ).toEqual({ width: 280, height: 280 })
  })
})
