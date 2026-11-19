import { describe, expect, it, vi } from 'vitest'
import { computeNewNodePosition } from './useCanvasNodePlacement'

const canvasEl = {
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
} as unknown as HTMLElement

describe('computeNewNodePosition：异常落位坐标 guard', () => {
  it('screenToFlowCoordinate 返回千万级坐标 ⇒ 不采用，回落到非离群节点右侧', () => {
    const flowApi = { screenToFlowCoordinate: () => ({ x: -24294840, y: 260 }) }
    const nodes = [
      { id: 'n1', type: 'image', position: { x: 80, y: 80 }, data: {} },
      { id: 'bad', type: 'image', position: { x: -24294840, y: 260 }, data: {} },
    ] as never
    const pos = computeNewNodePosition('image', nodes, flowApi, canvasEl, {
      grid: 20,
      snapToGrid: false,
    })
    expect(pos.x).toBe(400)
    expect(pos.y).toBe(80)
  })

  it('正常坐标仍走 screenToFlowCoordinate（guard 不误伤）', () => {
    const flowApi = { screenToFlowCoordinate: vi.fn(() => ({ x: 500, y: 300 })) }
    const pos = computeNewNodePosition('image', [] as never, flowApi, canvasEl, {
      grid: 20,
      snapToGrid: false,
    })
    expect(flowApi.screenToFlowCoordinate).toHaveBeenCalledOnce()
    expect(Number.isFinite(pos.x) && Math.abs(pos.x) < 100000).toBe(true)
  })
})
