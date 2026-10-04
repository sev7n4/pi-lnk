import 'reflect-metadata'
import { NotFoundException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import type { CanonicalVideoGenerationRequest } from '@lnkpi/shared'
import { StudioService } from './studio.service'
import { VideoGenerationOrchestrator, VIDEO_POLL_TIMEOUT_MS } from './video-generation.orchestrator'

const canonicalRequest = (): CanonicalVideoGenerationRequest => ({
  prompt: '产品展示视频',
  refs: [{ refKey: 'I1', mediaType: 'image', url: 'https://cdn.example/ref.png', label: '图' }],
  videoSettings: {
    duration: 15,
    aspectRatio: '16:9',
    resolution: '720p',
    crop: 'none',
  },
  videoMode: 'image_to_video',
  model: 'platform::video',
  scope: { sessionId: 's1', nodeId: 'v1' },
})

describe('VideoGenerationOrchestrator', () => {
  let orchestrator: VideoGenerationOrchestrator
  const generateVideo = vi.fn()
  const getGeneration = vi.fn()

  beforeEach(async () => {
    vi.clearAllMocks()
    generateVideo.mockResolvedValue({ id: 'rec-1', status: 'generating' })
    getGeneration.mockResolvedValue({
      id: 'rec-1',
      status: 'completed',
      url: 'https://cdn.example/out.mp4',
    })

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoGenerationOrchestrator,
        {
          provide: StudioService,
          useValue: { generateVideo, getGeneration },
        },
      ],
    }).compile()

    orchestrator = moduleRef.get(VideoGenerationOrchestrator)
  })

  it('start persists generating + startedAt then returns recordId', async () => {
    const persist = vi.fn()
    const result = await orchestrator.start('u1', canonicalRequest(), persist)

    expect(result.generationRecordId).toBe('rec-1')
    expect(result.status).toBe('generating')
    expect(result.generationStartedAt).toMatch(/^\d{4}-/)
    expect(persist).toHaveBeenCalledTimes(2)
    expect(persist.mock.calls[0][0][0]).toMatchObject({
      type: 'update_node',
      payload: {
        id: 'v1',
        data: expect.objectContaining({ status: 'generating', generationStartedAt: result.generationStartedAt }),
      },
    })
    expect(generateVideo).toHaveBeenCalledWith(
      'u1',
      '产品展示视频',
      'platform::video',
      15,
      '16:9',
      expect.any(Array),
      undefined,
      '720p',
      'none',
      undefined,
      { sessionId: 's1', nodeId: 'v1' },
      'image_to_video',
      undefined,
      undefined,
      undefined,
    )
  })

  it('start rejects empty prompt', async () => {
    await expect(
      orchestrator.start(
        'u1',
        { ...canonicalRequest(), prompt: '  ' },
        vi.fn(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  it('wait returns completed url', async () => {
    const persist = vi.fn()
    const result = await orchestrator.wait(
      'u1',
      { sessionId: 's1', nodeId: 'v1', generationRecordId: 'rec-1' },
      persist,
    )
    expect(result.status).toBe('completed')
    expect(result.url).toBe('https://cdn.example/out.mp4')
    expect(persist).toHaveBeenCalledTimes(1)
  })
})

// 回归锁：orchestrator 的 VIDEO_POLL_TIMEOUT_MS 原为 660_000，而
// `videoModelProfiles.ts` 里 minimax H3 的 `maxPollMs = 1_200_000`
// ⇒ **该模型必然先被 orchestrator 判timeout，而后台任务仍在跑**，
// 状态自相矛盾（生产有 3 条 `Agnes video timed out after 120 polls`）。
// 见 docs/superpowers/specs/2026-10-04-media-generation-audit.md §2.4
describe('VIDEO_POLL_TIMEOUT_MS 与模型 profile 对齐', () => {
  it('exceeds the largest maxPollMs in the model profiles', async () => {
    const { listModels } = await import('@lnkpi/shared')
    const { resolveVideoModelProfile } = await import('@lnkpi/shared')
    const maxProfile = Math.max(
      ...listModels('video').map((m) => {
        const p = resolveVideoModelProfile(m.modelKey, m.gatewayModelId, {})
        return p?.maxPollMs ?? 0
      }),
    )
    expect(maxProfile).toBeGreaterThan(0)
    expect(VIDEO_POLL_TIMEOUT_MS).toBeGreaterThanOrEqual(maxProfile)
  })

  it('leaves headroom over the largest profile so transport latency is not misjudged', async () => {
    const { listModels, resolveVideoModelProfile } = await import('@lnkpi/shared')
    const maxProfile = Math.max(
      ...listModels('video').map((m) => {
        const p = resolveVideoModelProfile(m.modelKey, m.gatewayModelId, {})
        return p?.maxPollMs ?? 0
      }),
    )
    // 至少 60s 余量：poll 还要走 HTTP 往返 + 序列化，抖动是必然的
    expect(VIDEO_POLL_TIMEOUT_MS - maxProfile).toBeGreaterThanOrEqual(60_000)
  })
})
