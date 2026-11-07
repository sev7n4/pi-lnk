import { describe, expect, it } from 'vitest'
import type { CanvasAction, CanvasData } from '@lnkpi/shared'
import { findUnfilledDraftTextNodes } from './turn-text-node-guard'

function canvas(nodes: { id: string; data?: Record<string, unknown> }[]): CanvasData {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: 'text',
      position: { x: 0, y: 0 },
      data: n.data ?? {},
    })),
    edges: [],
  } as CanvasData
}

const addText = (id: string): CanvasAction => ({
  type: 'add_node',
  payload: { id, nodeType: 'text', position: { x: 0, y: 0 }, data: { status: 'draft' } },
}) as CanvasAction

const writeContent = (id: string): CanvasAction => ({
  type: 'update_node',
  payload: { id, data: { content: '<html>…</html>', status: 'completed', format: 'html' } },
}) as CanvasAction

describe('findUnfilledDraftTextNodes — 回合终态一致性守卫', () => {
  it('事故形态：本轮新建文本节点停在 draft + 空正文 ⇒ 精确列出该 id', () => {
    const c = canvas([
      { id: 'text-old', data: { status: 'completed', content: '<html>…</html>' } },
      { id: 'text-new', data: { status: 'draft', title: '画布内容总结' } },
    ])
    expect(findUnfilledDraftTextNodes(c, [addText('text-new'), writeContent('text-old')])).toEqual([
      'text-new',
    ])
  })

  it('修复后形态：正文写进本轮新建节点且 completed ⇒ 零告警', () => {
    const c = canvas([
      { id: 'text-new', data: { status: 'completed', content: '<html>…</html>' } },
    ])
    expect(findUnfilledDraftTextNodes(c, [addText('text-new'), writeContent('text-new')])).toEqual([])
  })

  it('status 缺省 + 空正文也视为未落地；有正文则不算', () => {
    expect(findUnfilledDraftTextNodes(canvas([{ id: 'text-a' }]), [addText('text-a')])).toEqual([
      'text-a',
    ])
    expect(
      findUnfilledDraftTextNodes(
        canvas([{ id: 'text-a', data: { content: 'ok' } }]),
        [addText('text-a')],
      ),
    ).toEqual([])
  })

  it('只查本轮 add_node 的文本节点：媒体节点、历史节点、无 add_node 一律零告警', () => {
    const imageAction = {
      type: 'add_node',
      payload: { id: 'image-1', nodeType: 'image', position: { x: 0, y: 0 }, data: { status: 'draft' } },
    } as CanvasAction
    const c = canvas([
      { id: 'image-1', data: { status: 'draft' } },
      { id: 'text-history', data: { status: 'draft' } },
    ])
    expect(findUnfilledDraftTextNodes(c, [imageAction])).toEqual([])
    expect(findUnfilledDraftTextNodes(c, [])).toEqual([])
    expect(findUnfilledDraftTextNodes(c, [writeContent('text-history')])).toEqual([])
  })

  it('多个未落地节点按 id 排序，结果确定（同输入两次同输出）', () => {
    const c = canvas([
      { id: 'text-b', data: { status: 'draft' } },
      { id: 'text-a', data: { status: 'draft' } },
    ])
    const actions = [addText('text-b'), addText('text-a')]
    const first = findUnfilledDraftTextNodes(c, actions)
    expect(first).toEqual(['text-a', 'text-b'])
    expect(findUnfilledDraftTextNodes(c, actions)).toEqual(first)
  })
})
