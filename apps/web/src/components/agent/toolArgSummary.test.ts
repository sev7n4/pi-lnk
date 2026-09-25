import { describe, expect, it } from 'vitest'
import { summarizeToolArgs } from '@/components/agent/toolArgSummary'

describe('summarizeToolArgs（可观测性专项）', () => {
  it('load_skill 显示 skill 名', () => {
    expect(summarizeToolArgs('load_skill', { name: 'ecommerce-product-photo' })).toBe(
      'ecommerce-product-photo',
    )
  })

  it('upsert_media_node 优先 title，缺省截 prompt', () => {
    expect(summarizeToolArgs('upsert_media_node', { target_type: 'image', title: '白底主图' })).toBe(
      '白底主图',
    )
    const s = summarizeToolArgs('upsert_media_node', {
      target_type: 'image',
      prompt: '一张蓝牙耳机白色背景商品图，柔光棚拍',
    })
    expect(s).toBe('一张蓝牙耳机白色背景商品图，柔光棚拍'.slice(0, 24))
  })

  it('propose_generation 显示节点数', () => {
    expect(summarizeToolArgs('propose_generation', { node_ids: ['a', 'b'] })).toBe('2 个节点')
    expect(summarizeToolArgs('propose_generation', { node_id: 'a' })).toBe('1 个节点')
  })

  it('未知工具/无 args 返回 undefined，不抛错', () => {
    expect(summarizeToolArgs('run_image', undefined)).toBeUndefined()
    expect(summarizeToolArgs('unknown_tool', { foo: 1 })).toBeUndefined()
  })
})
