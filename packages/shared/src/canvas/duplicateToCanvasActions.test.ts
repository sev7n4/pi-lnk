import { describe, expect, it } from 'vitest'
import type { DuplicateSubgraphResult } from './duplicateSubgraph'
import { duplicateResultToCanvasActions } from './duplicateToCanvasActions'

describe('duplicateResultToCanvasActions', () => {
  it('maps 2 nodes and 1 edge to 3 canvas actions', () => {
    const result: DuplicateSubgraphResult = {
      nodes: [
        { id: 'p-dup-1', type: 'prompt', position: { x: 48, y: 48 }, data: { text: 'hello' } },
        { id: 'i-dup-1', type: 'image', position: { x: 348, y: 48 }, data: { url: 'u' } },
      ],
      edges: [{ id: 'e-dup', source: 'p-dup-1', target: 'i-dup-1' }],
      idMap: new Map([
        ['p1', 'p-dup-1'],
        ['i1', 'i-dup-1'],
      ]),
      newRootIds: ['p-dup-1'],
    }

    const actions = duplicateResultToCanvasActions(result)

    expect(actions).toHaveLength(3)

    expect(actions[0]).toEqual({
      type: 'add_node',
      payload: {
        id: 'p-dup-1',
        nodeType: 'prompt',
        position: { x: 48, y: 48 },
        data: { text: 'hello' },
      },
    })
    expect(actions[1]).toEqual({
      type: 'add_node',
      payload: {
        id: 'i-dup-1',
        nodeType: 'image',
        position: { x: 348, y: 48 },
        data: { url: 'u' },
      },
    })
    expect(actions[2]).toEqual({
      type: 'add_edge',
      payload: {
        id: 'e-dup',
        source: 'p-dup-1',
        target: 'i-dup-1',
      },
    })
  })

  it('passes node data through intact so textNode format survives duplication (spec §4.11)', () => {
    const result: DuplicateSubgraphResult = {
      nodes: [
        {
          id: 't-dup-1',
          type: 'text',
          position: { x: 48, y: 48 },
          data: { content: '<p>x</p>', format: 'html' },
        },
      ],
      edges: [],
      idMap: new Map([['t1', 't-dup-1']]),
      newRootIds: ['t-dup-1'],
    }

    const actions = duplicateResultToCanvasActions(result)

    expect(actions[0].type).toBe('add_node')
    expect((actions[0].payload as { data: Record<string, unknown> }).data).toEqual({
      content: '<p>x</p>',
      format: 'html',
    })
  })
})
