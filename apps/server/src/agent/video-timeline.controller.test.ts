import 'reflect-metadata'
import { BadRequestException, ValidationPipe } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { VideoTimelineBrowserController, VideoTimelineEditDto } from './video-timeline.controller'

describe('VideoTimelineBrowserController.edit（P1.2 双通道浏览器端点）', () => {
  it('userId 来自登录态 req.user.sub，不信任 body 注入的 userId', async () => {
    const edit = vi.fn(async () => ({ ok: true }))
    const controller = new VideoTimelineBrowserController({ edit } as never)
    const req = { user: { sub: 'real-user', phone: '18823164402' } } as never
    const dto = { sessionId: 's1', nodeId: 'vt_1', ops: [{ op: 'remove', node_id: 'v1' }] }
    await controller.edit(req, dto as never)
    expect(edit).toHaveBeenCalledTimes(1)
    const arg = edit.mock.calls[0]![0] as Record<string, unknown>
    expect(arg.userId).toBe('real-user')
    expect(arg.sessionId).toBe('s1')
    expect(arg.nodeId).toBe('vt_1')
    expect(arg.ops).toEqual(dto.ops)
    expect(JSON.stringify(arg)).not.toContain('hacker')
  })

  it('DTO 经 ValidationPipe：缺字段被拒、注入的 userId 被 whitelist 剥离、ops 原样透传', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true })
    const meta = { type: 'body' as const, metatype: VideoTimelineEditDto }
    const ops = [
      { op: 'split', node_id: 'v1', at_sec: 2 },
      { op: 'remove', node_id: 'v2' },
    ]
    const ok = await pipe.transform(
      { sessionId: 's1', nodeId: 'vt_1', ops, userId: 'hacker' },
      meta,
    ) as unknown as Record<string, unknown>
    expect(ok.sessionId).toBe('s1')
    expect(ok.nodeId).toBe('vt_1')
    expect(ok.ops).toEqual(ops) // 数组内容不被 whitelist 剥掉
    expect(ok.userId).toBeUndefined() // 注入字段被剥离

    await expect(pipe.transform({ nodeId: 'vt_1', ops }, meta)).rejects.toBeInstanceOf(BadRequestException)
    await expect(pipe.transform({ sessionId: 's1', ops }, meta)).rejects.toBeInstanceOf(BadRequestException)
    await expect(pipe.transform({ sessionId: 's1', nodeId: 'vt_1', ops: 'nope' }, meta)).rejects.toBeInstanceOf(BadRequestException)
  })
})
