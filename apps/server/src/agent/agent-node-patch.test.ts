import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import type { CanvasData } from '@lnkpi/shared'
import { relationsForNode, validateNodePatch } from './agent-canvas-tools.service'

const selectable = {
  image: ['platform::seedream-5.0-pro'],
  video: ['platform::agnes-video-v2.0'],
  text: ['platform::agnes-2.0-flash'],
  audio: ['platform::minimax-speech-2.8-hd'],
}

const imageNode = { type: 'image', data: { title: '旧名' } }

describe('validateNodePatch —— 图 1 的 5 条拒绝分支（spec §4.2）', () => {
  it('拒绝分支 1：非白名单字段（status 不得被模型涂改）', () => {
    const out = validateNodePatch({ patch: { status: 'completed' }, node: imageNode, selectable })
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.allowed).toEqual(['title', 'imageModel'])
  })

  it('拒绝分支 2：空 patch', () => {
    const out = validateNodePatch({ patch: {}, node: imageNode, selectable })
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toMatch(/at least one/i)
  })

  it('拒绝分支 3：模型字段与节点类型不匹配（image 节点传 videoModel）', () => {
    const out = validateNodePatch({ patch: { videoModel: 'platform::agnes-video-v2.0' }, node: imageNode, selectable })
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toMatch(/imageModel/)
  })

  it('拒绝分支 4：ref 不在 selectable 清单内 → 附合法清单', () => {
    const out = validateNodePatch({ patch: { imageModel: 'platform::不存在' }, node: imageNode, selectable })
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.allowed).toEqual(selectable.image)
  })

  it('拒绝分支 5：裸名不在目录中（normalizeModelRef.fallback）→ 不得静默采用默认模型', () => {
    const out = validateNodePatch({ patch: { imageModel: '完全不存在的模型-xyz' }, node: imageNode, selectable })
    expect(out.ok).toBe(false)
  })

  it('放行：title + 合法模型 ref，且只回白名单字段', () => {
    const out = validateNodePatch({
      patch: { title: '茶馆主视觉', imageModel: 'platform::seedream-5.0-pro' },
      node: imageNode,
      selectable,
    })
    expect(out).toEqual({ ok: true, data: { title: '茶馆主视觉', imageModel: 'platform::seedream-5.0-pro' } })
  })

  it('Review Focus 4：纯空白 title 被拒绝（不得把标题清成空串）', () => {
    expect(validateNodePatch({ patch: { title: '   ' }, node: imageNode, selectable }).ok).toBe(false)
    expect(validateNodePatch({ patch: { title: '' }, node: imageNode, selectable }).ok).toBe(false)
    expect(validateNodePatch({ patch: { title: null }, node: imageNode, selectable }).ok).toBe(false)
  })

  it('prompt/text 节点用 textModel；group 节点不允许任何模型字段', () => {
    expect(
      validateNodePatch({
        patch: { textModel: 'platform::agnes-2.0-flash' },
        node: { type: 'prompt', data: {} },
        selectable,
      }).ok,
    ).toBe(true)
    expect(
      validateNodePatch({ patch: { textModel: 'platform::agnes-2.0-flash' }, node: { type: 'group', data: {} }, selectable }).ok,
    ).toBe(false)
  })

  it('R-1：一次传两个模型字段被拒绝', () => {
    const out = validateNodePatch({
      patch: { imageModel: 'platform::seedream-5.0-pro', videoModel: 'platform::agnes-video-v2.0' },
      node: imageNode,
      selectable,
    })
    expect(out.ok).toBe(false)
  })

  it('禁止写 prompt / content / position（归 set_node_text 与 arrange_nodes）', () => {
    for (const field of ['prompt', 'content', 'status', 'position', 'generationRecordId', 'manifestKey']) {
      expect(validateNodePatch({ patch: { [field]: 'x' }, node: imageNode, selectable }).ok).toBe(false)
    }
  })
})

describe('relationsForNode', () => {
  const canvas = (): CanvasData => ({
    nodes: [
      { id: 'p1', type: 'prompt', position: { x: 0, y: 0 }, data: { title: '文案' } },
      { id: 'i1', type: 'image', position: { x: 1, y: 0 }, data: { title: '主图' } },
      { id: 'v1', type: 'video', position: { x: 2, y: 0 }, data: { title: '成片' } },
    ],
    edges: [
      { id: 'e1', source: 'p1', target: 'i1' },
      { id: 'e2', source: 'i1', target: 'v1' },
      { id: 'e3', source: 'missing', target: 'i1' },
    ],
  })

  it('上游/下游各回 id+type+title 三元组', () => {
    const out = relationsForNode(canvas(), 'i1')
    expect(out.upstream).toEqual([{ id: 'p1', type: 'prompt', title: '文案' }])
    expect(out.downstream).toEqual([{ id: 'v1', type: 'video', title: '成片' }])
  })

  it('悬空边（source 不存在）被跳过而不是崩', () => {
    expect(relationsForNode(canvas(), 'i1').upstream.map((n) => n.id)).not.toContain('missing')
  })

  it('无关系 → 两个空数组；空画布不抛', () => {
    const out = relationsForNode(canvas(), 'p1')
    expect(out.upstream).toEqual([])
    expect(out.downstream).toEqual([{ id: 'i1', type: 'image', title: '主图' }])
    expect(relationsForNode({ nodes: [], edges: [] }, 'nope')).toEqual({ upstream: [], downstream: [] })
  })

  it('自环不崩、不重复计数', () => {
    const selfLoop: CanvasData = {
      nodes: [{ id: 'a', type: 'image', position: { x: 0, y: 0 }, data: {} }],
      edges: [{ id: 'e1', source: 'a', target: 'a' }],
    }
    expect(relationsForNode(selfLoop, 'a')).toEqual({
      upstream: [{ id: 'a', type: 'image', title: '' }],
      downstream: [{ id: 'a', type: 'image', title: '' }],
    })
  })
})
