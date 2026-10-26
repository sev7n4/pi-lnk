import { describe, it, expect } from 'vitest'
import { toSessionLike } from './projectCardAdapter'

describe('projectCardAdapter', () => {
  it('映射 id/title/updatedAt 与 cover 字段，null cover 保留 null', () => {
    const p = { id: 'x', title: 'T', updatedAt: '2026-10-26T00:00:00Z', coverUrl: 'u', coverNodeId: null }
    expect(toSessionLike(p)).toEqual(p)
  })

  it('显式字段白名单：输入多余字段不夹带', () => {
    const p = {
      id: 'x',
      title: 'T',
      updatedAt: '2026-10-26T00:00:00Z',
      coverUrl: '',
      coverNodeId: 'n',
      // 故意多给一个非白名单字段（如未来 ProjectCard 扩展）——adapter 不得透传
      canvasData: { nodes: [] },
    } as never
    expect(Object.keys(toSessionLike(p)).sort()).toEqual(
      ['coverNodeId', 'coverUrl', 'id', 'title', 'updatedAt'],
    )
  })
})
