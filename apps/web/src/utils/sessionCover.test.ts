import { describe, expect, it } from 'vitest'
import type { Session } from '@lnkpi/shared'
import { extractSessionCover } from './sessionCover'

const pos = { x: 0, y: 0 }

describe('extractSessionCover', () => {
  it('returns first image node cover', () => {
    const session = {
      id: '1',
      title: 't',
      userId: 'u',
      updatedAt: '',
      createdAt: '',
      canvasData: {
        nodes: [
          { id: 'a', type: 'text', position: pos, data: { content: 'hello' } },
          { id: 'b', type: 'image', position: pos, data: { url: 'https://cdn/x.jpg' } },
        ],
        edges: [],
      },
    } satisfies Session
    expect(extractSessionCover(session)).toEqual({ url: 'https://cdn/x.jpg', kind: 'image' })
  })

  it('prefers coverUrl over url', () => {
    const session = {
      id: '1',
      title: 't',
      userId: 'u',
      updatedAt: '',
      createdAt: '',
      canvasData: {
        nodes: [{ id: 'b', type: 'image', position: pos, data: { url: 'a.jpg', coverUrl: 'cover.jpg' } }],
        edges: [],
      },
    } satisfies Session
    expect(extractSessionCover(session)?.url).toBe('cover.jpg')
  })
})

// ── 2026-10-25：列表不再下发 canvasData，封面由服务端算好（coverUrl）──────────
// 成因：165 个项目的整份画布 JSON 一起下发实测 589KB，传输中途卡死会占满 Chrome 单 host
// 的 6 条连接 ⇒ 前台请求排队饿死（项目抽屉「项目加载中」转不完）。列表场景因此只剩
// `coverUrl`，这里锁住「拿得到封面」这条不变量，避免瘦身把项目卡封面打成空白。
describe('extractSessionCover —— 服务端 coverUrl（列表瘦身后的唯一来源）', () => {
  const base = { id: '1', title: 't', userId: 'u', updatedAt: '', createdAt: '' } satisfies Session

  it('只有 coverUrl、无 canvasData 时仍出封面（列表瘦身后就是这个形态）', () => {
    expect(extractSessionCover({ ...base, coverUrl: 'https://cdn/a.png' })).toEqual({
      url: 'https://cdn/a.png',
      kind: 'image',
    })
  })

  it('coverUrl 指视频（.mp4）⇒ kind 判为 video（卡片要能播）', () => {
    expect(extractSessionCover({ ...base, coverUrl: 'https://cdn/a.mp4' })?.kind).toBe('video')
  })

  it('扩展名判定不了（无后缀 URL）⇒ 退回 image，不丢封面', () => {
    expect(extractSessionCover({ ...base, coverUrl: 'https://cdn/artifact' })).toEqual({
      url: 'https://cdn/artifact',
      kind: 'image',
    })
  })

  it('coverUrl 优先于 canvasData（两者都在时以服务端口径为准，避免两侧漂移）', () => {
    const session = {
      ...base,
      coverUrl: 'https://cdn/server.png',
      canvasData: {
        nodes: [{ id: 'b', type: 'image', position: pos, data: { url: 'https://cdn/local.jpg' } }],
        edges: [],
      },
    } satisfies Session
    expect(extractSessionCover(session)?.url).toBe('https://cdn/server.png')
  })

  it('coverUrl 为 null / 空串 ⇒ 退回 canvasData 兜底（单条拉取仍带全量）', () => {
    const session = {
      ...base,
      coverUrl: null,
      canvasData: {
        nodes: [{ id: 'b', type: 'image', position: pos, data: { url: 'https://cdn/local.jpg' } }],
        edges: [],
      },
    } satisfies Session
    expect(extractSessionCover(session)?.url).toBe('https://cdn/local.jpg')
  })

  it('两者皆无 ⇒ null（前端回落默认墨鱼封面）', () => {
    expect(extractSessionCover(base)).toBeNull()
  })
})
