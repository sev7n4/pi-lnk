import { it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('./api', () => ({ api: { patch: vi.fn().mockResolvedValue({ data: { data: { applied: 1 } } }) } }))
vi.mock('@/utils/canvasClientId', () => ({ getCanvasClientId: () => 'c-test' }))

import { api } from './api'
import { canvasApi } from './canvas-api'

it('patchCanvas 注入 x-lnkpi-canvas-client，URL 与 body 形状不变', async () => {
  await canvasApi.patchCanvas('s1', [{ type: 'set_viewport' }])
  expect(api.patch).toHaveBeenCalledWith('/sessions/s1/canvas',
    { ops: [{ type: 'set_viewport' }] },
    { headers: { 'x-lnkpi-canvas-client': 'c-test' } })
})

it('I6：CanvasPage.vue 的调用字面量仍存在（两处静态契约锚点）', () => {
  const src = readFileSync('src/pages/CanvasPage.vue', 'utf8')
  expect(src).toContain('await canvasApi.patchCanvas(')
})
