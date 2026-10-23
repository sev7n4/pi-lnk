import { describe, expect, it, beforeEach } from 'vitest'
import { mergeFocusNodeRef, nodeToSidebarAttachment, useSidebarAttachments } from './useSidebarAttachments'

// 单例化后所有调用共享同一份 pendingAttachments，跨 it 必须清干净
beforeEach(() => {
  useSidebarAttachments().clear()
})

describe('useSidebarAttachments (singleton)', () => {
  it('two callers share the same pendingAttachments', () => {
    const a = useSidebarAttachments()
    a.addFromPayload({ id: '1', mediaType: 'image', sourceKind: 'upload', label: 'a', url: 'https://x/1.jpg' })
    const b = useSidebarAttachments()
    expect(b.pendingAttachments.value).toHaveLength(1)
  })

  it('addFromCanvasNodesDetailed returns added/duplicate counts and dedups', () => {
    const { addFromCanvasNodesDetailed, pendingAttachments } = useSidebarAttachments()
    const nodes = [
      { id: 'n1', type: 'image', data: { url: 'https://x/1.jpg' } },
      { id: 'n1', type: 'image', data: { url: 'https://x/1.jpg' } },
      { id: 'n2', type: 'image', data: { url: 'https://x/2.jpg' } },
    ]
    const r = addFromCanvasNodesDetailed(nodes)
    expect(r.added).toBe(2)
    expect(r.duplicate).toBe(1)
    expect(pendingAttachments.value).toHaveLength(2)
  })
})

describe('useSidebarAttachments', () => {
  it('dedupes by url', () => {
    const { addFromPayload, pendingAttachments } = useSidebarAttachments()
    addFromPayload({ id: '1', mediaType: 'image', sourceKind: 'upload', label: 'a', url: 'https://x/1.jpg' })
    addFromPayload({ id: '2', mediaType: 'image', sourceKind: 'upload', label: 'b', url: 'https://x/1.jpg' })
    expect(pendingAttachments.value).toHaveLength(1)
  })

  it('assigns ref keys I1 T1', () => {
    const { addFromPayload, assignRefKeys } = useSidebarAttachments()
    addFromPayload({ id: '1', mediaType: 'image', sourceKind: 'upload', label: 'a', url: 'https://x/1.jpg' })
    addFromPayload({ id: '2', mediaType: 'text', sourceKind: 'upload', label: 'b', text: '卖点' })
    const keys = assignRefKeys()
    expect(keys).toEqual(['I1', 'T1'])
  })
})

describe('mergeFocusNodeRef', () => {
  const imageNode = {
    id: 'node-a',
    type: 'image',
    data: { url: 'https://cdn/a.jpg', title: '主图' },
  }

  it('adds canvasNode attachment from focus node', () => {
    const merged = mergeFocusNodeRef([], imageNode)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 'focus-node-a',
      mediaType: 'image',
      sourceKind: 'canvasNode',
      url: 'https://cdn/a.jpg',
      sourceNodeId: 'node-a',
    })
  })

  it('dedupes by sourceNodeId', () => {
    const existing = [{
      id: '1',
      mediaType: 'image' as const,
      sourceKind: 'canvasNode' as const,
      label: 'dup',
      url: 'https://cdn/other.jpg',
      sourceNodeId: 'node-a',
    }]
    expect(mergeFocusNodeRef(existing, imageNode)).toHaveLength(1)
  })

  it('dedupes by url', () => {
    const existing = [{
      id: '1',
      mediaType: 'image' as const,
      sourceKind: 'upload' as const,
      label: 'dup',
      url: 'https://cdn/a.jpg',
    }]
    expect(mergeFocusNodeRef(existing, imageNode)).toHaveLength(1)
  })

  it('returns unchanged when node has no url or text', () => {
    const existing = [{
      id: '1',
      mediaType: 'text' as const,
      sourceKind: 'upload' as const,
      label: 't',
      text: 'hello',
    }]
    expect(mergeFocusNodeRef(existing, { id: 'empty', type: 'image', data: {} })).toBe(existing)
  })
})

describe('nodeToSidebarAttachment', () => {
  it('maps video node to V* mediaType', () => {
    const item = nodeToSidebarAttachment({
      id: 'v1',
      type: 'video',
      data: { url: 'https://cdn/x.mp4', title: 'demo' },
    })
    expect(item?.mediaType).toBe('video')
    expect(item?.sourceKind).toBe('canvasNode')
  })

  it('returns null when no url or text', () => {
    expect(nodeToSidebarAttachment({ id: 'e', type: 'image', data: {} })).toBeNull()
  })
})

describe('addFromCanvasNodes', () => {
  it('adds up to max and skips dup sourceNodeId', () => {
    const { addFromCanvasNodes, pendingAttachments } = useSidebarAttachments()
    const nodes = Array.from({ length: 6 }, (_, i) => ({
      id: `n${i}`,
      type: 'image' as const,
      data: { url: `https://cdn/${i}.jpg` },
    }))
    const added = addFromCanvasNodes(nodes)
    expect(added).toBe(5)
    expect(pendingAttachments.value).toHaveLength(5)
  })
})
