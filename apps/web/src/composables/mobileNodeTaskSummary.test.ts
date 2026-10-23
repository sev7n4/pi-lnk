import { describe, it, expect } from 'vitest'
import { summarizeMobileNodeTasks } from './mobileNodeTaskSummary'

/**
 * 移动端壳层任务聚合（R3-T4）。
 *
 * D-C 状态机的「壳层聚合进度条」：把散落在各节点上的生成中 / 待确认
 * **收敛成一条**——用户不必逐个节点去看就知道整体在干什么。
 *
 * ⭐ 纯函数、零依赖：判据复用 `resolveMobileNodeState`（R3-T1），
 * 与磁贴 / 徽标消费同一答案。
 */
describe('summarizeMobileNodeTasks（壳层任务聚合）', () => {
  it('空节点列表 → 全零', () => {
    const s = summarizeMobileNodeTasks([])
    expect(s.generatingCount).toBe(0)
    expect(s.pendingNodes).toEqual([])
    expect(s.earliestStartedAt).toBeUndefined()
  })

  it('统计 generating 节点数', () => {
    const s = summarizeMobileNodeTasks([
      { id: 'a', type: 'image', data: { status: 'generating' } },
      { id: 'b', type: 'video', data: { status: 'generating' } },
      { id: 'c', type: 'image', data: { status: 'completed', url: 'x' } },
    ])
    expect(s.generatingCount).toBe(2)
  })

  it('fallback_pending 也算「在跑」', () => {
    const s = summarizeMobileNodeTasks([
      { id: 'a', type: 'image', data: { status: 'fallback_pending' } },
    ])
    expect(s.generatingCount).toBe(1)
  })

  it('收集待确认节点（id + 标题）', () => {
    const s = summarizeMobileNodeTasks([
      { id: 'a', type: 'image', data: { status: 'pending_confirm' }, title: '我的图' },
      { id: 'b', type: 'image', data: { status: 'pending_confirm' } },
      { id: 'c', type: 'image', data: { status: 'generating' } },
    ])
    expect(s.pendingNodes).toHaveLength(2)
    expect(s.pendingNodes[0]!.id).toBe('a')
    expect(s.pendingNodes[0]!.title).toBe('我的图')
    expect(s.pendingNodes[1]!.id).toBe('b')
  })

  it('取最早的生成起始时间（聚合进度条的计时基准）', () => {
    const s = summarizeMobileNodeTasks([
      { id: 'a', type: 'image', data: { status: 'generating', generationStartedAt: '2026-10-23T04:00:10.000Z' } },
      { id: 'b', type: 'image', data: { status: 'generating', generationStartedAt: '2026-10-23T04:00:00.000Z' } },
    ])
    expect(s.earliestStartedAt).toBe('2026-10-23T04:00:00.000Z')
  })

  it('无起始时间时不返回基准（不假造时间）', () => {
    const s = summarizeMobileNodeTasks([
      { id: 'a', type: 'image', data: { status: 'generating' } },
    ])
    expect(s.earliestStartedAt).toBeUndefined()
  })

  it('error / empty / confirmed 都不计入任何聚合项', () => {
    const s = summarizeMobileNodeTasks([
      { id: 'a', type: 'image', data: { status: 'error' } },
      { id: 'b', type: 'image', data: {} },
      { id: 'c', type: 'image', data: { url: 'x' } },
    ])
    expect(s.generatingCount).toBe(0)
    expect(s.pendingNodes).toEqual([])
  })
})
