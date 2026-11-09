import { describe, it, expect } from 'vitest'
import { getCanvasClientId } from './canvasClientId'

function fakeStorage() {
  const m = new Map<string, string>()
  return {
    m,
    storage: {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { m.set(k, v) },
    },
  }
}

describe('getCanvasClientId', () => {
  it('① 同一 storage 内稳定', () => {
    const { storage } = fakeStorage()
    expect(getCanvasClientId({ storage, random: () => 'c-fixed' })).toBe('c-fixed')
    expect(getCanvasClientId({ storage, random: () => 'c-other' })).toBe('c-fixed')
  })
  it('② 不同 storage（新标签页）不同', () => {
    expect(getCanvasClientId({ storage: fakeStorage().storage, random: () => 'a' })).toBe('a')
    expect(getCanvasClientId({ storage: fakeStorage().storage, random: () => 'b' })).toBe('b')
  })
  it('③ R1：storage 缺失 / 抛异常 ⇒ unknown，不抛错', () => {
    expect(getCanvasClientId({ storage: undefined, random: () => 'x' })).toBe('unknown')
    const boom = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    expect(getCanvasClientId({ storage: boom, random: () => 'x' })).toBe('unknown')
  })
})
