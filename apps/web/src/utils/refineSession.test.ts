import { describe, expect, it } from 'vitest'
import {
  CX_IMAGE_EDIT_ENABLED,
  STAIN_PRESET_PROMPT,
  canOpenNodeImageEdit,
  canOpenRefineForNode,
  decideRefineDismiss,
} from './refineSession'

describe('refine session constants', () => {
  it('exports stain preset prompt and feature flag', () => {
    expect(STAIN_PRESET_PROMPT).toBe(
      '去除选区内的污渍、瑕疵、多余物体，其余像素保持不变',
    )
    expect(CX_IMAGE_EDIT_ENABLED).toBe(true)
  })
})

describe('decideRefineDismiss', () => {
  it('blocks switching nodes while a refine request is busy', () => {
    expect(
      decideRefineDismiss({
        busy: true,
        targetNodeId: 'node-a',
        selectedNodeId: 'node-b',
      }),
    ).toBe('block')
  })

  it('blocks when busy even if selection is cleared', () => {
    expect(
      decideRefineDismiss({
        busy: true,
        targetNodeId: 'node-a',
        selectedNodeId: null,
      }),
    ).toBe('block')
  })

  it('dismisses when idle and the selected node is not the target', () => {
    expect(
      decideRefineDismiss({
        busy: false,
        targetNodeId: 'node-a',
        selectedNodeId: 'node-b',
      }),
    ).toBe('dismiss')
  })

  it('dismisses when idle and selection is cleared', () => {
    expect(
      decideRefineDismiss({
        busy: false,
        targetNodeId: 'node-a',
        selectedNodeId: null,
      }),
    ).toBe('dismiss')
  })

  it('keeps the session when the same node stays selected', () => {
    expect(
      decideRefineDismiss({
        busy: false,
        targetNodeId: 'node-a',
        selectedNodeId: 'node-a',
      }),
    ).toBe('keep')
  })

  it('keeps the session when busy on the same node', () => {
    expect(
      decideRefineDismiss({
        busy: true,
        targetNodeId: 'node-a',
        selectedNodeId: 'node-a',
      }),
    ).toBe('keep')
  })
})

describe('canOpenRefineForNode', () => {
  it('allows image nodes', () => {
    expect(canOpenRefineForNode({ type: 'image' })).toBe(true)
  })

  it('rejects decommissioned mediaInput even with image mediaKind', () => {
    // 2026-10-19 mediaInput 节点下线：仅 image 节点可打开精修。
    expect(canOpenRefineForNode({ type: 'mediaInput', mediaKind: 'image' })).toBe(false)
    expect(canOpenRefineForNode({ type: 'mediaInput', mimeType: 'image/png' })).toBe(false)
  })

  it('rejects other node types', () => {
    expect(canOpenRefineForNode({ type: 'video' })).toBe(false)
    expect(canOpenRefineForNode({ type: 'text' })).toBe(false)
    expect(canOpenRefineForNode({ type: 'audio' })).toBe(false)
  })
})

describe('canOpenNodeImageEdit', () => {
  it('blocks the node edit entry while generating or uploading', () => {
    expect(canOpenNodeImageEdit('generating')).toBe(false)
    expect(canOpenNodeImageEdit('fallback_pending')).toBe(false)
    expect(canOpenNodeImageEdit('uploading')).toBe(false)
  })

  it('allows the node edit entry when idle', () => {
    expect(canOpenNodeImageEdit('completed')).toBe(true)
    expect(canOpenNodeImageEdit('draft')).toBe(true)
  })
})
