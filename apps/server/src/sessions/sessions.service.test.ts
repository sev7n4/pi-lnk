import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { PrismaService } from '../prisma/prisma.service'
import { SessionsService } from './sessions.service'

function makeService() {
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 's1',
    title: (data.title as string) ?? '未命名画布',
    userId: data.userId as string,
    canvasData: (data.canvasData as string | null) ?? null,
    createdAt: new Date('2026-09-29T00:00:00Z'),
    updatedAt: new Date('2026-09-29T00:00:00Z'),
  }))
  return {
    create,
    moduleRef: Test.createTestingModule({
      providers: [SessionsService, { provide: PrismaService, useValue: { session: { create } } }],
    }),
  }
}

describe('SessionsService.create —— 新建画布不种提示词节点（spec 场景 A/B）', () => {
  it('canvasData 恒为 null（不再种 prompt-1）', async () => {
    const { create, moduleRef } = makeService()
    const svc = (await moduleRef.compile()).get(SessionsService)
    const out = await svc.create('u1', '未命名画布')
    expect(create).toHaveBeenCalledOnce()
    const data = create.mock.calls[0][0].data as Record<string, unknown>
    expect(data.canvasData).toBeUndefined()
    expect(JSON.stringify(data)).not.toContain('prompt-1')
    expect(JSON.stringify(data)).not.toContain('描述你的创意场景')
    expect(out.title).toBe('未命名画布')
  })

  it('即使调用方仍传第三参（旧签名 prompt），也不再种节点', async () => {
    const { create, moduleRef } = makeService()
    const svc = (await moduleRef.compile()).get(SessionsService)
    // 旧调用方传 prompt 的兼容性：字段被忽略，不再影响 canvasData
    await (svc.create as unknown as (u: string, t: string, p: string) => Promise<unknown>)(
      'u1',
      '一个赛博朋克茶馆',
      '一个赛博朋克茶馆',
    )
    const data = create.mock.calls[0][0].data as Record<string, unknown>
    expect(data.canvasData).toBeUndefined()
    expect(JSON.stringify(data)).not.toContain('prompt-1')
  })
})
