import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { PrismaService } from '../prisma/prisma.service'
import { StoriesService } from './stories.service'

function makeModule() {
  const sessionCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 's1',
    userId: data.userId as string,
    canvasData: data.canvasData as string,
  }))
  const storyCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'st1', ...data }))
  const moduleRef = Test.createTestingModule({
    providers: [
      StoriesService,
      { provide: PrismaService, useValue: { session: { create: sessionCreate }, story: { create: storyCreate } } },
    ],
  })
  return { sessionCreate, storyCreate, moduleRef }
}

describe('StoriesService.create —— 剧集画布仍种提示词节点（spec 场景 C，回归锁）', () => {
  it('把 synopsis 种成 prompt-1（本包不允许被「统一成空画布」误伤）', async () => {
    const { sessionCreate, moduleRef } = makeModule()
    const svc = (await moduleRef.compile()).get(StoriesService)

    await svc.create('u1', { title: '测试剧', synopsis: '三集悬疑剧', episodeCount: 3 })

    const canvasData = sessionCreate.mock.calls[0][0].data.canvasData as string
    const parsed = JSON.parse(canvasData) as { nodes: Array<{ id: string; type: string; data: { prompt: string } }> }
    expect(parsed.nodes).toHaveLength(1)
    expect(parsed.nodes[0].id).toBe('prompt-1')
    expect(parsed.nodes[0].type).toBe('prompt')
    expect(parsed.nodes[0].data.prompt).toBe('三集悬疑剧')
  })

  it('未填 synopsis 时回落 title', async () => {
    const { sessionCreate, moduleRef } = makeModule()

    await (await moduleRef.compile()).get(StoriesService).create('u1', { title: '仅标题' })

    const parsed = JSON.parse(sessionCreate.mock.calls[0][0].data.canvasData as string) as {
      nodes: Array<{ data: { prompt: string } }>
    }
    expect(parsed.nodes[0].data.prompt).toBe('仅标题')
  })
})
