import { describe, it, expect, vi } from 'vitest'
import { ValidationPipe } from '@nestjs/common'
import { SessionsController, PatchCanvasDto } from './sessions.controller'
import type { SessionsService } from './sessions.service'

describe('PATCH canvas header + 真实管道', () => {
  it('真实 ValidationPipe 下 { ops } 不被剥离（DTO 形状未变）', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true })
    const dto = await pipe.transform({ ops: [{ type: 'set_viewport' }] },
      { type: 'body', metatype: PatchCanvasDto })
    expect(dto).toEqual({ ops: [{ type: 'set_viewport' }] })
  })

  it('header 值下传给 service，缺失时降级 unknown', async () => {
    const svc = { patchCanvas: vi.fn().mockResolvedValue({ applied: 1 }) }
    const ctrl = new SessionsController(svc as unknown as SessionsService)
    await ctrl.patchCanvas('s1', { user: { sub: 'u1' } }, { ops: [] }, 'c-abc')
    expect(svc.patchCanvas).toHaveBeenCalledWith('s1', 'u1', [], 'c-abc')
    await ctrl.patchCanvas('s1', { user: { sub: 'u1' } }, { ops: [] }, undefined)
    expect(svc.patchCanvas).toHaveBeenLastCalledWith('s1', 'u1', [], 'unknown')
  })
})
