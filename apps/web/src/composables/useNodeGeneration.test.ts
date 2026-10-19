import type { AxiosResponse } from 'axios'
import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeChannelModel } from '@lnkpi/shared'
import type { EditableFlowNode } from '@/composables/useSelectedNodeEditor'
import type { CanvasEdgeLike } from '@/composables/useUpstreamNodeContext'
import { NODE_GENERATION_STATUS } from '@/constants/dockStudio'
import { useNodeGeneration } from '@/composables/useNodeGeneration'
import { defaultModelKey } from '@/constants/studioModels'
import { canvasApi } from '@/services/canvas-api'
import { studioApi } from '@/services/studio-api'

const mockRefreshPoints = vi.fn(async () => 100)

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    refreshPoints: mockRefreshPoints,
  }),
}))

vi.mock('@/services/studio-api', () => ({
  studioApi: {
    generateImage: vi.fn(),
    generateVideo: vi.fn(),
    startVideoGeneration: vi.fn(),
    generateAudio: vi.fn(),
    generateText: vi.fn(),
    confirmPlatformFallback: vi.fn(),
    cancelPlatformFallback: vi.fn(),
    cancelGeneration: vi.fn(),
    getGeneration: vi.fn(),
  },
}))

vi.mock('@/services/canvas-api', () => ({
  canvasApi: {
    confirmMaterialPlatformFallback: vi.fn(),
    cancelMaterialPlatformFallback: vi.fn(),
    cancelMaterial: vi.fn(),
  },
}))
function mockAxiosResponse<T>(data: T): AxiosResponse<T> {
  return { data, status: 200, statusText: 'OK', headers: {}, config: {} as AxiosResponse<T>['config'] }
}

const completedRecord = {
  id: 'rec-1',
  type: 'image',
  prompt: 'test',
  status: NODE_GENERATION_STATUS.completed,
  url: 'https://example.com/out.png',
  createdAt: '2026-01-01T00:00:00.000Z',
}

function createNode(
  type: string,
  data: Record<string, unknown>,
  id = `${type}-1`,
): EditableFlowNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data,
  }
}

function createDeps(nodes: EditableFlowNode[], overrides: Record<string, unknown> = {}) {
  const nodesRef = ref(nodes)
  const patchNodeData = vi.fn((id: string, patch: Record<string, unknown>) => {
    const node = nodesRef.value.find((n) => n.id === id)
    if (node) node.data = { ...(node.data ?? {}), ...patch }
  })
  const saveCanvas = vi.fn(async () => {})
  const requireLogin = vi.fn(() => true)
  const startGenerationPolling = vi.fn()
  const resolveProviderModels = vi.fn(() => ({
    image: encodeChannelModel('platform', 'default-image-model'),
    video: encodeChannelModel('platform', 'default-video-model'),
    text: encodeChannelModel('platform', 'default-text-model'),
  }))
  const requestFallbackConfirm = vi.fn(async () => 'confirm' as const)
  const isModelSelectable = vi.fn(() => true)

  const deps = {
    nodes: nodesRef,
    edges: ref<CanvasEdgeLike[]>([]),
    sessionId: ref('session-1'),
    patchNodeData,
    addNode: vi.fn(() => 'new-node'),
    addEdge: vi.fn(),
    saveCanvas,
    requireLogin,
    startGenerationPolling,
    resolveProviderModels,
    requestFallbackConfirm,
    isModelSelectable,
    ...overrides,
  }

  const api = useNodeGeneration(deps)
  return { api, deps }
}

function canvasScope(nodeId: string) {
  return { sessionId: 'session-1', nodeId }
}

describe('useNodeGeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRefreshPoints.mockResolvedValue(100)
    vi.mocked(studioApi.generateAudio).mockResolvedValue(
      mockAxiosResponse({ data: { ...completedRecord, type: 'audio', url: 'https://example.com/out.mp3' } }),
    )
    vi.mocked(studioApi.generateImage).mockResolvedValue(
      mockAxiosResponse({ data: completedRecord }),
    )
    vi.mocked(studioApi.getGeneration).mockImplementation(async (id) =>
      mockAxiosResponse({
        data: {
          ...completedRecord,
          id,
          status: NODE_GENERATION_STATUS.completed,
          url: 'https://example.com/out.png',
        },
      }),
    )
  })

  it('maps 积分不足 to recharge message and calls onInsufficientPoints', async () => {
    const node = createNode('image', { prompt: 'a cat' })
    const onInsufficientPoints = vi.fn()
    vi.mocked(studioApi.generateImage).mockRejectedValue({
      response: { data: { message: '积分不足' } },
    })
    const { api, deps } = createDeps([node], { onInsufficientPoints })

    await api.generateForNode(node)

    expect(deps.patchNodeData).toHaveBeenCalledWith('image-1', {
      status: NODE_GENERATION_STATUS.error,
      errorMessage: '积分不足，请充值后再试',
    })
    expect(onInsufficientPoints).toHaveBeenCalled()
    expect(mockRefreshPoints).toHaveBeenCalled()
  })

  it('maps generation failure with refundedPoints in response', async () => {
    const node = createNode('image', { prompt: 'a cat' })
    vi.mocked(studioApi.generateImage).mockRejectedValue({
      response: { data: { message: 'upstream failed', refundedPoints: 10 } },
    })
    const { api, deps } = createDeps([node])

    await api.generateForNode(node)

    expect(deps.patchNodeData).toHaveBeenCalledWith('image-1', {
      status: NODE_GENERATION_STATUS.error,
      errorMessage: '生成失败，10 积分已返回',
    })
    expect(mockRefreshPoints).toHaveBeenCalled()
  })

  it('persists short failure errorCode and generationRecordId from structured axios error', async () => {
    const node = createNode('image', {
      prompt: 'a cat',
      generationRecordId: 'rec-existing',
    })
    vi.mocked(studioApi.generateImage).mockRejectedValue({
      response: {
        data: {
          message: '上游超时',
          errorCode: 'upstream_timeout',
          taskKind: 'generation',
          taskId: 'rec-timeout-1',
        },
      },
    })
    const { api, deps } = createDeps([node])

    await api.generateForNode(node)

    expect(deps.patchNodeData).toHaveBeenCalledWith(
      'image-1',
      expect.objectContaining({
        status: NODE_GENERATION_STATUS.error,
        errorMessage: '上游超时',
        errorCode: 'upstream_timeout',
        generationRecordId: 'rec-timeout-1',
      }),
    )
  })

  it('keeps existing generationRecordId when structured error omits taskId', async () => {
    const node = createNode('image', {
      prompt: 'a cat',
      generationRecordId: 'rec-keep-me',
    })
    vi.mocked(studioApi.generateImage).mockRejectedValue({
      response: {
        data: {
          message: '上游错误',
          errorCode: 'upstream_error',
        },
      },
    })
    const { api, deps } = createDeps([node])

    await api.generateForNode(node)

    expect(deps.patchNodeData).toHaveBeenCalledWith(
      'image-1',
      expect.objectContaining({
        status: NODE_GENERATION_STATUS.error,
        errorMessage: '上游错误',
        errorCode: 'upstream_error',
      }),
    )
    const errorPatch = deps.patchNodeData.mock.calls.find(
      (call) => call[1]?.status === NODE_GENERATION_STATUS.error,
    )?.[1] as Record<string, unknown>
    expect(errorPatch).not.toHaveProperty('generationRecordId')
    expect(node.data?.generationRecordId).toBe('rec-keep-me')
  })

  it('refreshes points after successful generation', async () => {
    const node = createNode('image', { prompt: 'a cat' })
    const { api } = createDeps([node])

    await api.generateForNode(node)

    expect(mockRefreshPoints).toHaveBeenCalled()
  })

  it('passes audio options to studioApi.generateAudio', async () => {
    const node = createNode('audio', {
      prompt: 'hello world',
      audioVoice: 'male-1',
      audioEmotion: 'happy',
      audioLanguage: 'en',
      audioSpeed: 1.5,
    })
    const { api } = createDeps([node])

    await api.generateForNode(node)

    expect(studioApi.generateAudio).toHaveBeenCalledWith(
      'hello world',
      {
        model: encodeChannelModel('platform', defaultModelKey('audio')),
        // 存量节点无 `audioKind` ⇒ 缺省视作 voice，且带 voice 参数（原有 7 个字段逐个不变）
        kind: 'voice',
        voice: 'male-1',
        emotion: 'happy',
        language: 'en',
        speed: 1.5,
        volume: 1,
        pitch: 0,
      },
      [],
      [],
      expect.any(AbortSignal),
      canvasScope('audio-1'),
    )
  })

  // 🔴 kind 与模型错配会被服务端 `assertAudioKindMatchesModel` 显式 400，
  // 所以前端必须把节点上的 kind 与对应参数一起发出去。
  it('passes kind=design with roles/scripts/instruction instead of voice params', async () => {
    const node = createNode('audio', {
      prompt: 'scene 1',
      audioKind: 'design',
      audioModel: encodeChannelModel('platform', 'stepaudio-3-gen-preview'),
      audioRoles: [{ role: '旁白', voice: 'wenrounvsheng' }],
      audioScripts: [{ role: '旁白', text: '（轻声）下雨了' }],
      audioInstruction: '克制一点',
      // 残留的 voice 参数不得混进 design 请求
      audioVoice: 'male-1',
    })
    const { api } = createDeps([node])

    await api.generateForNode(node)

    expect(studioApi.generateAudio).toHaveBeenCalledWith(
      'scene 1',
      {
        model: encodeChannelModel('platform', 'stepaudio-3-gen-preview'),
        kind: 'design',
        roles: [{ role: '旁白', voice: 'wenrounvsheng' }],
        scripts: [{ role: '旁白', text: '（轻声）下雨了' }],
        instruction: '克制一点',
      },
      [],
      [],
      expect.any(AbortSignal),
      canvasScope('audio-1'),
    )
  })

  it('passes kind=music with caption/lyrics/instrumental instead of voice params', async () => {
    const node = createNode('audio', {
      prompt: '轻快的电子乐',
      audioKind: 'music',
      audioModel: encodeChannelModel('platform', 'stepaudio-3-music-preview'),
      audioLyrics: '啦啦啦',
      audioInstrumental: true,
    })
    const { api } = createDeps([node])

    await api.generateForNode(node)

    expect(studioApi.generateAudio).toHaveBeenCalledWith(
      '轻快的电子乐',
      {
        model: encodeChannelModel('platform', 'stepaudio-3-music-preview'),
        kind: 'music',
        // caption 取正文（music 的 caption 就是「想生成什么曲子」）
        caption: '轻快的电子乐',
        lyrics: '啦啦啦',
        instrumental: true,
      },
      [],
      [],
      expect.any(AbortSignal),
      canvasScope('audio-1'),
    )
  })

  it('passes model, resolution, and count to studioApi.generateImage', async () => {
    const node = createNode('image', {
      prompt: 'a cat',
      imageModel: encodeChannelModel('platform', 'seedream-5.0-pro'),
      imageAspect: '16:9',
      imageResolution: '2K',
      imageCount: 3,
    })
    const { api } = createDeps([node])

    await api.generateForNode(node)

    expect(studioApi.generateImage).toHaveBeenCalledWith(
      'a cat',
      encodeChannelModel('platform', 'seedream-5.0-pro'),
      '16:9',
      [],
      [],
      '2K',
      3,
      expect.any(AbortSignal),
      canvasScope('image-1'),
    )
  })

  it('normalizes bare catalog model keys to channel:: payload format', async () => {
    const node = createNode('image', {
      prompt: 'a cat',
      imageModel: 'seedream-5.0-pro',
      imageAspect: '16:9',
      imageResolution: '1K',
      imageCount: 1,
    })
    const { api } = createDeps([node])

    await api.generateForNode(node)

    expect(studioApi.generateImage).toHaveBeenCalledWith(
      'a cat',
      encodeChannelModel('platform', 'seedream-5.0-pro'),
      '16:9',
      [],
      [],
      '1K',
      1,
      expect.any(AbortSignal),
      canvasScope('image-1'),
    )
  })

  it('preserves user-channel model channelId::modelName in studio payload', async () => {
    const model = encodeChannelModel('ch-user-1', 'my-custom-model')
    const node = createNode('image', {
      prompt: 'a dog',
      imageModel: model,
      imageAspect: '1:1',
      imageResolution: '2K',
      imageCount: 1,
    })
    const { api } = createDeps([node])

    await api.generateForNode(node)

    expect(studioApi.generateImage).toHaveBeenCalledWith(
      'a dog',
      model,
      '1:1',
      [],
      [],
      '2K',
      1,
      expect.any(AbortSignal),
      canvasScope('image-1'),
    )
  })

  it('invokes requestFallbackConfirm and confirm API on studio fallback_pending', async () => {
    const model = encodeChannelModel('ch-user-1', 'my-custom-model')
    const node = createNode('image', {
      prompt: 'fallback me',
      imageModel: model,
      imageAspect: '16:9',
      imageResolution: '1K',
      imageCount: 1,
    })
    const pendingRecord = {
      id: 'rec-pending-1',
      type: 'image',
      prompt: 'fallback me',
      status: NODE_GENERATION_STATUS.fallback_pending,
      url: null,
      metadata: JSON.stringify({ confirmMessage: '自定义渠道失败，已切换平台服务，可能会有额外费用，是否继续？' }),
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    vi.mocked(studioApi.generateImage).mockResolvedValue(mockAxiosResponse({ data: pendingRecord }))
    vi.mocked(studioApi.confirmPlatformFallback).mockResolvedValue(
      mockAxiosResponse({
        data: {
          ...pendingRecord,
          status: NODE_GENERATION_STATUS.completed,
          url: 'https://example.com/fallback.png',
        },
      }),
    )
    const requestFallbackConfirm = vi.fn(async () => 'confirm' as const)
    const { api, deps } = createDeps([node], { requestFallbackConfirm })

    await api.generateForNode(node)

    expect(requestFallbackConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'studio',
        id: 'rec-pending-1',
        nodeId: 'image-1',
      }),
    )
    expect(studioApi.confirmPlatformFallback).toHaveBeenCalledWith('rec-pending-1')
    expect(deps.patchNodeData).toHaveBeenCalledWith(
      'image-1',
      expect.objectContaining({
        status: NODE_GENERATION_STATUS.completed,
        url: 'https://example.com/fallback.png',
      }),
    )
  })

  it('routes studio image generating status through resolveStudioRecord (starts poll)', async () => {
    const node = createNode('image', {
      prompt: 'async image',
      imageAspect: '16:9',
      imageResolution: '1K',
      imageCount: 1,
    })
    vi.mocked(studioApi.generateImage).mockResolvedValue(
      mockAxiosResponse({
        data: {
          id: 'rec-async-img',
          type: 'image',
          prompt: 'async image',
          status: NODE_GENERATION_STATUS.generating,
          url: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    )
    const { api, deps } = createDeps([node])

    await api.generateForNode(node)

    expect(deps.startGenerationPolling).toHaveBeenCalledWith([
      { recordId: 'rec-async-img', nodeId: 'image-1' },
    ])
    expect(deps.patchNodeData).toHaveBeenCalledWith(
      'image-1',
      expect.objectContaining({ status: NODE_GENERATION_STATUS.generating }),
    )
    expect(deps.patchNodeData).not.toHaveBeenCalledWith(
      'image-1',
      expect.objectContaining({ status: NODE_GENERATION_STATUS.completed }),
    )
  })

  it('applyStudioRecord failed with metadata.refundedPoints shows refund message', async () => {
    const node = createNode('image', {
      prompt: 'failed image',
      imageAspect: '16:9',
      imageResolution: '1K',
      imageCount: 1,
    })
    vi.mocked(studioApi.generateImage).mockResolvedValue(
      mockAxiosResponse({
        data: {
          id: 'rec-failed-refund',
          type: 'image',
          prompt: 'failed image',
          status: NODE_GENERATION_STATUS.failed,
          url: null,
          metadata: JSON.stringify({ refundedPoints: 10 }),
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    )
    const { api, deps } = createDeps([node])

    await api.generateForNode(node)

    expect(deps.patchNodeData).toHaveBeenCalledWith(
      'image-1',
      expect.objectContaining({
        status: NODE_GENERATION_STATUS.error,
        errorMessage: '生成失败，10 积分已返回',
        generationRecordId: 'rec-failed-refund',
      }),
    )
  })

  it('applyStudioRecord failed persists errorCode from metadata', async () => {
    const node = createNode('image', {
      prompt: 'failed image',
      imageAspect: '16:9',
      imageResolution: '1K',
      imageCount: 1,
    })
    vi.mocked(studioApi.generateImage).mockResolvedValue(
      mockAxiosResponse({
        data: {
          id: 'rec-failed-code',
          type: 'image',
          prompt: 'failed image',
          status: NODE_GENERATION_STATUS.failed,
          url: null,
          metadata: JSON.stringify({ errorCode: 'upstream_timeout', refundedPoints: 5 }),
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    )
    const { api, deps } = createDeps([node])

    await api.generateForNode(node)

    expect(deps.patchNodeData).toHaveBeenCalledWith(
      'image-1',
      expect.objectContaining({
        status: NODE_GENERATION_STATUS.error,
        errorMessage: '生成失败，5 积分已返回',
        errorCode: 'upstream_timeout',
        generationRecordId: 'rec-failed-code',
      }),
    )
  })

  it('sets node error when onFallbackPending confirm API fails', async () => {
    const requestFallbackConfirm = vi.fn(async () => 'confirm' as const)
    vi.mocked(studioApi.confirmPlatformFallback).mockRejectedValue(new Error('confirm failed'))
    const { api, deps } = createDeps([], { requestFallbackConfirm })

    await api.onFallbackPending('studio', 'rec-fail-1', 'node-fail-1', '请确认')

    expect(deps.patchNodeData).toHaveBeenCalledWith(
      'node-fail-1',
      expect.objectContaining({
        status: NODE_GENERATION_STATUS.error,
        errorMessage: 'confirm failed',
      }),
    )
    expect(deps.saveCanvas).toHaveBeenCalled()
  })

  it('calls cancel API when fallback confirm is declined', async () => {
    const model = encodeChannelModel('ch-user-1', 'my-custom-model')
    const node = createNode('text', {
      prompt: 'hello',
      content: 'hello',
      textModel: model,
    })
    const pendingRecord = {
      id: 'rec-pending-2',
      type: 'text',
      prompt: 'hello',
      status: NODE_GENERATION_STATUS.fallback_pending,
      url: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    vi.mocked(studioApi.generateText).mockResolvedValue(mockAxiosResponse({ data: pendingRecord }))
    vi.mocked(studioApi.cancelPlatformFallback).mockResolvedValue(
      mockAxiosResponse({ data: { ...pendingRecord, status: NODE_GENERATION_STATUS.failed } }),
    )
    const requestFallbackConfirm = vi.fn(async () => 'cancel' as const)
    const { api, deps } = createDeps([node], { requestFallbackConfirm })

    await api.generateForNode(node)

    expect(studioApi.cancelPlatformFallback).toHaveBeenCalledWith('rec-pending-2')
    expect(studioApi.confirmPlatformFallback).not.toHaveBeenCalled()
    expect(deps.patchNodeData).toHaveBeenCalledWith(
      'text-1',
      expect.objectContaining({ status: NODE_GENERATION_STATUS.error }),
    )
  })

  it('blocks generate when model is not selectable', async () => {
    const model = encodeChannelModel('ch-user-1', 'disabled-model')
    const node = createNode('image', {
      prompt: 'blocked',
      imageModel: model,
    })
    const isModelSelectable = vi.fn(() => false)
    const { api, deps } = createDeps([node], { isModelSelectable })

    await api.generateForNode(node)

    expect(studioApi.generateImage).not.toHaveBeenCalled()
    expect(deps.patchNodeData).toHaveBeenCalledWith('image-1', {
      status: NODE_GENERATION_STATUS.error,
      errorMessage: '当前模型已停用，请重新选择模型后再生成',
    })
  })

  it('blocks image generation when referenceImageUrl is a blob url', async () => {
    const node = createNode('image', {
      prompt: 'a cat',
      referenceImageUrl: 'blob:http://localhost/abc-123',
    })
    const { api, deps } = createDeps([node])

    await api.generateForNode(node)

    expect(studioApi.generateImage).not.toHaveBeenCalled()
    expect(deps.patchNodeData).toHaveBeenCalledWith('image-1', {
      status: NODE_GENERATION_STATUS.error,
      errorMessage: '参考图尚未上传，请先上传后再生成',
      errorCode: 'upload_required',
    })
  })

  it('blocks image generation when a ref url is a blob url', async () => {
    const refNode = createNode('image', { url: 'blob:http://localhost/ref-456' }, 'ref-1')
    const node = createNode('image', {
      prompt: 'a cat',
      localRefs: [{ refKey: 'r1', sourceNodeId: 'ref-1', mediaType: 'image' }],
      refOrder: ['r1'],
    })
    const { api, deps } = createDeps([node, refNode])
    deps.edges.value = [{ id: 'e1', source: 'ref-1', target: 'image-1' }]

    await api.generateForNode(node)

    expect(studioApi.generateImage).not.toHaveBeenCalled()
    expect(deps.patchNodeData).toHaveBeenCalledWith('image-1', expect.objectContaining({
      status: NODE_GENERATION_STATUS.error,
      errorMessage: expect.stringContaining('未上传成功'),
      errorCode: 'upload_required',
    }))
  })

  it('applyStudioRecord persists lastFrameUrl from completed video record metadata', async () => {
    const node = createNode('video', {
      prompt: 'motion scene',
      videoSettings: { duration: 5, aspectRatio: '16:9', resolution: '720p', crop: 'none' },
    })
    vi.mocked(studioApi.startVideoGeneration).mockResolvedValue(
      mockAxiosResponse({
        data: {
          id: 'rec-video-lf',
          type: 'video',
          prompt: 'motion scene',
          status: NODE_GENERATION_STATUS.completed,
          url: 'https://example.com/video.mp4',
          metadata: JSON.stringify({ lastFrameUrl: 'https://example.com/last-frame.png' }),
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    )
    const { api, deps } = createDeps([node])

    await api.generateForNode(node)

    expect(deps.patchNodeData).toHaveBeenCalledWith(
      'video-1',
      expect.objectContaining({
        status: NODE_GENERATION_STATUS.completed,
        url: 'https://example.com/video.mp4',
        lastFrameUrl: 'https://example.com/last-frame.png',
        generationRecordId: 'rec-video-lf',
      }),
    )
  })

  it('blocks audio-only video refs before startVideoGeneration', async () => {
    const node = createNode('video', {
      prompt: 'motion with audio ref',
      videoSettings: { duration: 15, aspectRatio: '16:9', resolution: '720p', crop: 'none' },
      localRefs: [
        { id: 'r1', mediaType: 'audio', sourceKind: 'upload', label: 'bgm', url: 'https://example.com/ref.mp3' },
      ],
    })
    const { api, deps } = createDeps([node])

    await api.generateForNode(node)

    expect(studioApi.startVideoGeneration).not.toHaveBeenCalled()
    expect(deps.patchNodeData).toHaveBeenCalledWith('video-1', expect.objectContaining({
      status: NODE_GENERATION_STATUS.error,
      errorMessage: '需要 Seedance 且至少一张参考图',
    }))
  })

  it('canvas video start does not patch referenceImageUrl', async () => {
    const node = createNode('video', {
      prompt: 'motion',
      videoSettings: { duration: 15, aspectRatio: '16:9', resolution: '720p', crop: 'none' },
      localRefs: [
        { id: 'r1', mediaType: 'image', sourceKind: 'upload', label: 'ref', url: 'https://example.com/ref.png' },
      ],
    })
    const { api, deps } = createDeps([node])
    vi.mocked(studioApi.startVideoGeneration).mockResolvedValue(
      mockAxiosResponse({
        data: {
          ...completedRecord,
          type: 'video',
          id: 'rec-video-1',
          status: 'generating',
          generationStartedAt: '2026-08-14T12:00:00.000Z',
        },
      }),
    )

    await api.generateForNode(node)

    expect(studioApi.startVideoGeneration).toHaveBeenCalled()
    const patchCalls = vi.mocked(deps.patchNodeData).mock.calls
    const finalPatch = patchCalls[patchCalls.length - 1]?.[1] as Record<string, unknown> | undefined
    expect(finalPatch?.referenceImageUrl).toBeUndefined()
    expect(finalPatch?.generationRecordId).toBe('rec-video-1')
  })

  it('text generate writes result to content without overwriting prompt', async () => {
    const node = createNode('text', {
      prompt: '写一句广告语',
      content: '',
    })
    const { api, deps } = createDeps([node])
    vi.mocked(studioApi.generateText).mockResolvedValue(
      mockAxiosResponse({
        data: {
          ...completedRecord,
          type: 'text',
          prompt: '写一句广告语',
          metadata: JSON.stringify({ text: '买它！限时优惠。' }),
        },
      }),
    )

    await api.generateForNode(node)

    expect(studioApi.generateText).toHaveBeenCalledWith(
      '写一句广告语',
      expect.any(String),
      [],
      [],
      expect.any(AbortSignal),
      false,
      undefined,
      canvasScope('text-1'),
    )
    expect(deps.patchNodeData).toHaveBeenCalledWith(
      'text-1',
      expect.objectContaining({
        status: NODE_GENERATION_STATUS.generating,
        prompt: '写一句广告语',
      }),
    )
    const generatingPatch = deps.patchNodeData.mock.calls.find(
      (call) => call[1]?.status === NODE_GENERATION_STATUS.generating,
    )?.[1] as Record<string, unknown>
    expect(generatingPatch).not.toHaveProperty('content')

    expect(deps.patchNodeData).toHaveBeenCalledWith(
      'text-1',
      expect.objectContaining({
        status: NODE_GENERATION_STATUS.completed,
        content: '买它！限时优惠。',
      }),
    )
    const completedPatch = deps.patchNodeData.mock.calls.find(
      (call) => call[1]?.status === NODE_GENERATION_STATUS.completed,
    )?.[1] as Record<string, unknown>
    expect(completedPatch).not.toHaveProperty('prompt')
  })

  it('allows parallel generation on two nodes', async () => {
    let resolveA!: (v: unknown) => void
    let resolveB!: (v: unknown) => void
    const hangA = new Promise((r) => {
      resolveA = r
    })
    const hangB = new Promise((r) => {
      resolveB = r
    })
    vi.mocked(studioApi.generateImage)
      .mockImplementationOnce(() => hangA as never)
      .mockImplementationOnce(() => hangB as never)

    const nodeA = createNode('image', { prompt: 'a' }, 'img-a')
    const nodeB = createNode('image', { prompt: 'b' }, 'img-b')
    const { api, deps } = createDeps([nodeA, nodeB])

    const pA = api.generateForNode(nodeA)
    const pB = api.generateForNode(nodeB)

    await Promise.resolve()
    expect(api.isNodeBusy('img-a')).toBe(true)
    expect(api.isNodeBusy('img-b')).toBe(true)
    expect(deps.patchNodeData).toHaveBeenCalledWith(
      'img-a',
      expect.objectContaining({ status: NODE_GENERATION_STATUS.generating }),
    )
    expect(deps.patchNodeData).toHaveBeenCalledWith(
      'img-b',
      expect.objectContaining({ status: NODE_GENERATION_STATUS.generating }),
    )

    resolveA(mockAxiosResponse({ data: { ...completedRecord, id: 'rec-a' } }))
    resolveB(mockAxiosResponse({ data: { ...completedRecord, id: 'rec-b' } }))
    await Promise.all([pA, pB])
    expect(api.isNodeBusy('img-a')).toBe(false)
    expect(api.isNodeBusy('img-b')).toBe(false)
  })

  it('writes generationStartedAt when generation begins', async () => {
    const node = createNode('image', { prompt: 'cat' }, 'img-1')
    let resolveHang!: (v: unknown) => void
    const hang = new Promise((r) => { resolveHang = r })
    vi.mocked(studioApi.generateImage).mockImplementationOnce(() => hang as never)
    const { api, deps } = createDeps([node])
    const pending = api.generateForNode(node)
    await Promise.resolve()
    expect(deps.patchNodeData).toHaveBeenCalledWith(
      'img-1',
      expect.objectContaining({
        status: NODE_GENERATION_STATUS.generating,
        generationStartedAt: expect.stringMatching(/^\d{4}-/),
      }),
    )
    resolveHang(mockAxiosResponse({ data: completedRecord }))
    await pending
  })

  it('cancelGeneration stops generation polling', async () => {
    const stopGenerationPolling = vi.fn()
    const node = createNode('image', {
      prompt: 'x',
      status: NODE_GENERATION_STATUS.generating,
      generationRecordId: 'rec-cancel-1',
    }, 'img-1')
    const { api } = createDeps([node], { stopGenerationPolling })
    vi.mocked(studioApi.cancelGeneration).mockResolvedValue(
      mockAxiosResponse({
        data: {
          id: 'rec-cancel-1',
          type: 'image',
          prompt: 'x',
          status: 'failed',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    )

    api.cancelGeneration('img-1')
    await vi.waitFor(() => expect(studioApi.cancelGeneration).toHaveBeenCalledWith('rec-cancel-1'))

    expect(stopGenerationPolling).toHaveBeenCalledWith('img-1')
  })

  it('cancelGeneration on fallback_pending calls cancelPlatformFallback and sets error', async () => {
    vi.mocked(studioApi.cancelPlatformFallback).mockResolvedValue(
      mockAxiosResponse({
        data: {
          id: 'rec-fb-cancel',
          type: 'video',
          prompt: 'x',
          status: 'failed',
          metadata: JSON.stringify({ userMessage: '已取消平台回退', cancelled: true }),
          createdAt: new Date().toISOString(),
        },
      }),
    )

    const node = createNode(
      'video',
      {
        status: NODE_GENERATION_STATUS.fallback_pending,
        generationRecordId: 'rec-fb-cancel',
        prompt: 'x',
      },
      'video-fb',
    )
    const { api, deps } = createDeps([node])

    api.cancelGeneration('video-fb')
    await vi.waitFor(() =>
      expect(studioApi.cancelPlatformFallback).toHaveBeenCalledWith('rec-fb-cancel'),
    )
    expect(studioApi.cancelGeneration).not.toHaveBeenCalled()
    expect(deps.patchNodeData).toHaveBeenCalledWith(
      'video-fb',
      expect.objectContaining({
        status: NODE_GENERATION_STATUS.error,
        errorMessage: expect.stringMatching(/已取消/),
      }),
    )
  })

  it('uses structured cancelPlatformFallback error when pending cancel fails', async () => {
    vi.mocked(studioApi.cancelPlatformFallback).mockRejectedValue({
      response: {
        data: {
          message: '取消回退失败，请稍后重试',
          errorCode: 'upstream_error',
        },
      },
    })
    const node = createNode('video', {
      status: NODE_GENERATION_STATUS.fallback_pending,
      generationRecordId: 'rec-fb-fail',
      prompt: 'x',
    }, 'video-fb-fail')
    const { api } = createDeps([node])

    api.cancelGeneration('video-fb-fail')

    await vi.waitFor(() => {
      expect(node.data).toEqual(expect.objectContaining({
        status: NODE_GENERATION_STATUS.error,
        errorMessage: '取消回退失败，请稍后重试',
        errorCode: 'upstream_error',
      }))
    })
  })

  it('does not let a late pending cancel reply overwrite a newer generation', async () => {
    let resolveCancel!: (value: AxiosResponse<unknown>) => void
    vi.mocked(studioApi.cancelPlatformFallback).mockImplementation(
      () => new Promise((resolve) => { resolveCancel = resolve }) as never,
    )
    const node = createNode('video', {
      status: NODE_GENERATION_STATUS.fallback_pending,
      generationRecordId: 'rec-old',
      prompt: 'x',
    }, 'video-race')
    const { api, deps } = createDeps([node])

    api.cancelGeneration('video-race')
    await vi.waitFor(() =>
      expect(studioApi.cancelPlatformFallback).toHaveBeenCalledWith('rec-old'),
    )
    deps.patchNodeData('video-race', {
      status: NODE_GENERATION_STATUS.generating,
      generationRecordId: 'rec-new',
    })
    vi.mocked(deps.patchNodeData).mockClear()

    resolveCancel(mockAxiosResponse({ data: { id: 'rec-old', status: 'failed' } }))
    await vi.waitFor(() => expect(deps.saveCanvas).toHaveBeenCalled())

    expect(deps.patchNodeData).not.toHaveBeenCalledWith(
      'video-race',
      expect.objectContaining({ status: NODE_GENERATION_STATUS.error }),
    )
    expect(node.data).toEqual(expect.objectContaining({
      status: NODE_GENERATION_STATUS.generating,
      generationRecordId: 'rec-new',
    }))
  })

  it('cancels prior studio fallback before starting a new generation', async () => {
    const order: string[] = []
    vi.mocked(studioApi.cancelPlatformFallback).mockImplementation(async () => {
      order.push('cancel')
      return mockAxiosResponse({ data: { id: 'rec-old', status: 'failed' } }) as never
    })
    vi.mocked(studioApi.generateImage).mockImplementation(async () => {
      order.push('generate')
      return mockAxiosResponse({ data: completedRecord })
    })
    const node = createNode('image', {
      status: NODE_GENERATION_STATUS.fallback_pending,
      generationRecordId: 'rec-old',
      prompt: 'regenerate',
    }, 'image-regenerate')
    const { api } = createDeps([node])

    await api.generateForNode(node)

    expect(order).toEqual(['cancel', 'generate'])
    expect(node.data?.status).toBe(NODE_GENERATION_STATUS.completed)
  })

  it('cancels both prior fallback ids before regenerating a dual-id node', async () => {
    vi.mocked(studioApi.cancelPlatformFallback).mockRejectedValue(new Error('studio cancel failed'))
    vi.mocked(canvasApi.cancelMaterialPlatformFallback).mockResolvedValue(
      mockAxiosResponse({ data: { id: 'mat-old', status: 'failed' } }),
    )
    const node = createNode('image', {
      status: NODE_GENERATION_STATUS.fallback_pending,
      generationRecordId: 'rec-old',
      materialId: 'mat-old',
      prompt: 'regenerate',
    }, 'image-dual-id-regenerate')
    const { api } = createDeps([node])

    await api.generateForNode(node)

    expect(studioApi.cancelPlatformFallback).toHaveBeenCalledWith('rec-old')
    expect(canvasApi.cancelMaterialPlatformFallback).toHaveBeenCalledWith('mat-old')
    expect(studioApi.generateImage).toHaveBeenCalledOnce()
  })

  it('keeps a pending regenerate busy while pre-cancel is awaiting', async () => {
    let resolveCancel!: (value: AxiosResponse<unknown>) => void
    const cancelPending = new Promise<AxiosResponse<unknown>>((resolve) => {
      resolveCancel = resolve
    })
    vi.mocked(studioApi.cancelPlatformFallback).mockImplementation(() => cancelPending as never)
    const node = createNode('image', {
      status: NODE_GENERATION_STATUS.fallback_pending,
      generationRecordId: 'rec-old',
      prompt: 'regenerate',
    }, 'image-pre-cancel-race')
    const { api } = createDeps([node])

    const first = api.generateForNode(node)
    await vi.waitFor(() =>
      expect(studioApi.cancelPlatformFallback).toHaveBeenCalledWith('rec-old'),
    )

    expect(api.isNodeBusy(node.id)).toBe(true)
    const second = api.generateForNode(node)
    expect(studioApi.generateImage).not.toHaveBeenCalled()

    resolveCancel(mockAxiosResponse({ data: { id: 'rec-old', status: 'failed' } }))
    await Promise.all([first, second])

    expect(studioApi.generateImage).not.toHaveBeenCalled()
    expect(api.isNodeBusy(node.id)).toBe(false)
  })

  it('cancelGeneration on material fallback_pending calls cancelMaterialPlatformFallback and sets error', async () => {
    vi.mocked(canvasApi.cancelMaterialPlatformFallback).mockResolvedValue(
      mockAxiosResponse({ data: { id: 'mat-fb-cancel', status: 'failed' } }),
    )
    const node = createNode(
      'image',
      {
        status: NODE_GENERATION_STATUS.fallback_pending,
        materialId: 'mat-fb-cancel',
        prompt: 'x',
      },
      'image-fb',
    )
    const { api, deps } = createDeps([node])

    api.cancelGeneration('image-fb')
    await vi.waitFor(() =>
      expect(canvasApi.cancelMaterialPlatformFallback).toHaveBeenCalledWith('mat-fb-cancel'),
    )
    expect(canvasApi.cancelMaterial).not.toHaveBeenCalled()
    expect(deps.patchNodeData).toHaveBeenCalledWith(
      'image-fb',
      expect.objectContaining({
        status: NODE_GENERATION_STATUS.error,
        errorMessage: expect.stringMatching(/已取消/),
      }),
    )
  })

  it('does not write fallback error after cancel during confirm dialog', async () => {
    let resolveConfirm!: (decision: 'confirm' | 'cancel') => void
    const confirmHang = new Promise<'confirm' | 'cancel'>((r) => { resolveConfirm = r })
    const requestFallbackConfirm = vi.fn(() => confirmHang)

    const pendingRecord = {
      id: 'rec-fb-cancel',
      type: 'image',
      prompt: 'fallback me',
      status: NODE_GENERATION_STATUS.fallback_pending,
      url: null,
      metadata: JSON.stringify({ confirmMessage: '是否继续？' }),
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    vi.mocked(studioApi.generateImage).mockResolvedValue(mockAxiosResponse({ data: pendingRecord }))
    vi.mocked(studioApi.confirmPlatformFallback).mockResolvedValue(
      mockAxiosResponse({
        data: {
          ...pendingRecord,
          status: NODE_GENERATION_STATUS.completed,
          url: 'https://example.com/fallback.png',
        },
      }),
    )

    const node = createNode('image', {
      prompt: 'fallback me',
      imageAspect: '16:9',
      imageResolution: '1K',
      imageCount: 1,
    }, 'img-fb')
    const { api, deps } = createDeps([node], { requestFallbackConfirm })

    const pending = api.generateForNode(node)
    await vi.waitFor(() => expect(requestFallbackConfirm).toHaveBeenCalled())

    api.cancelGeneration('img-fb')
    expect(node.data?.status).toBe(NODE_GENERATION_STATUS.draft)

    resolveConfirm('confirm')
    await pending

    expect(deps.patchNodeData).not.toHaveBeenCalledWith(
      'img-fb',
      expect.objectContaining({
        status: NODE_GENERATION_STATUS.error,
        errorMessage: '平台回退仍待确认',
      }),
    )
    expect(deps.patchNodeData).not.toHaveBeenCalledWith(
      'img-fb',
      expect.objectContaining({
        status: NODE_GENERATION_STATUS.completed,
        url: 'https://example.com/fallback.png',
      }),
    )
    expect(node.data?.status).toBe(NODE_GENERATION_STATUS.draft)
  })

  it('ignores late studio completed write after cancel to draft', async () => {
    const requestFallbackConfirm = vi.fn(async () => 'confirm' as const)
    vi.mocked(studioApi.confirmPlatformFallback).mockResolvedValue(
      mockAxiosResponse({
        data: {
          ...completedRecord,
          id: 'rec-late',
          url: 'https://example.com/late.png',
        },
      }),
    )
    const node = createNode('image', {
      prompt: 'x',
      status: NODE_GENERATION_STATUS.draft,
    }, 'img-1')
    const { api, deps } = createDeps([node], { requestFallbackConfirm })

    await api.onFallbackPending('studio', 'rec-late', 'img-1')

    expect(deps.patchNodeData).not.toHaveBeenCalledWith(
      'img-1',
      expect.objectContaining({
        status: NODE_GENERATION_STATUS.completed,
        url: 'https://example.com/late.png',
      }),
    )
  })

  it('applies new text result after prior failed recordId (model switch)', async () => {
    const model = encodeChannelModel('ch-user-1', 'deepseek-v4-pro')
    const node = createNode(
      'text',
      {
        prompt: 'rewrite after fail',
        content: '',
        textModel: model,
        status: NODE_GENERATION_STATUS.error,
        errorMessage: '生成失败',
        generationRecordId: 'cmrxhe8sk005kny01qbl02zky',
      },
      'text-9',
    )
    const completed = {
      id: 'cmrxhfe7m005ony013k0s8mxm',
      type: 'text' as const,
      prompt: 'rewrite after fail',
      status: NODE_GENERATION_STATUS.completed,
      metadata: JSON.stringify({ text: '新模型生成成功内容' }),
      url: null,
      createdAt: '2026-07-23T12:23:08.722Z',
    }
    vi.mocked(studioApi.generateText).mockResolvedValue(mockAxiosResponse({ data: completed }))
    const { api, deps } = createDeps([node])

    await api.generateForNode(node)

    expect(deps.patchNodeData).toHaveBeenCalledWith(
      'text-9',
      expect.objectContaining({ generationRecordId: completed.id }),
    )
    expect(deps.patchNodeData).toHaveBeenCalledWith(
      'text-9',
      expect.objectContaining({
        status: NODE_GENERATION_STATUS.completed,
        content: '新模型生成成功内容',
        generationRecordId: completed.id,
      }),
    )
    expect(node.data?.status).toBe(NODE_GENERATION_STATUS.completed)
    expect(node.data?.content).toBe('新模型生成成功内容')
  })

  it('applies terminal studio resolve when node already error with same generationRecordId', async () => {
    const requestFallbackConfirm = vi.fn(async () => 'confirm' as const)
    vi.mocked(studioApi.confirmPlatformFallback).mockResolvedValue(
      mockAxiosResponse({
        data: {
          ...completedRecord,
          id: 'rec-1',
          url: 'https://example.com/recovered.png',
        },
      }),
    )
    const node = createNode(
      'image',
      {
        prompt: 'x',
        status: NODE_GENERATION_STATUS.error,
        errorMessage: 'stale local error',
        generationRecordId: 'rec-1',
      },
      'img-recover',
    )
    const { api, deps } = createDeps([node], { requestFallbackConfirm })

    await api.onFallbackPending('studio', 'rec-1', 'img-recover')

    expect(deps.patchNodeData).toHaveBeenCalledWith(
      'img-recover',
      expect.objectContaining({
        status: NODE_GENERATION_STATUS.completed,
        url: 'https://example.com/recovered.png',
        generationRecordId: 'rec-1',
      }),
    )
  })

  it('cancel keeps existing content and url', async () => {
    const node = createNode('image', {
      prompt: 'x',
      url: 'https://example.com/keep.png',
      content: 'keep-me',
    }, 'img-keep')
    let rejectHang!: (e: unknown) => void
    const hang = new Promise((_r, j) => { rejectHang = j })
    vi.mocked(studioApi.generateImage).mockImplementation((_a, _b, _c, _d, _e, _f, _g, signal?: AbortSignal) => {
      signal?.addEventListener('abort', () => {
        const err = new Error('canceled')
        ;(err as { code?: string }).code = 'ERR_CANCELED'
        rejectHang(err)
      })
      return hang as never
    })
    const { api, deps } = createDeps([node])
    const pending = api.generateForNode(node)
    await Promise.resolve()
    expect(api.isNodeBusy('img-keep')).toBe(true)
    await api.generateForNode(node) // cancel via second click
    await pending
    const draftPatch = deps.patchNodeData.mock.calls.find(
      (c) => c[1]?.status === NODE_GENERATION_STATUS.draft,
    )?.[1] as Record<string, unknown>
    expect(draftPatch).toBeTruthy()
    expect(draftPatch).not.toHaveProperty('url')
    expect(draftPatch).not.toHaveProperty('content')
  })

  it('second generate click cancels in-flight generation', async () => {
    let rejectHang!: (err: unknown) => void
    const hang = new Promise((_resolve, reject) => {
      rejectHang = reject
    })
    vi.mocked(studioApi.generateImage).mockImplementation(
      (_prompt, _model, _aspect, _refs, _keys, _res, _count, signal?: AbortSignal) => {
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('canceled')
            ;(err as { code?: string }).code = 'ERR_CANCELED'
            rejectHang(err)
          })
        }
        return hang as never
      },
    )

    const node = createNode('image', { prompt: 'cancel-me' }, 'img-1')
    const { api, deps } = createDeps([node])

    const pending = api.generateForNode(node)
    await Promise.resolve()
    expect(api.isNodeBusy('img-1')).toBe(true)

    await api.generateForNode(node)
    await pending

    expect(api.isNodeBusy('img-1')).toBe(false)
    expect(deps.patchNodeData).toHaveBeenCalledWith(
      'img-1',
      expect.objectContaining({
        status: NODE_GENERATION_STATUS.draft,
        errorMessage: '已取消',
      }),
    )
  })

  it('overwrites cancel message when abort response includes refundedPoints', async () => {
    let rejectHang!: (e: unknown) => void
    const hang = new Promise((_r, j) => { rejectHang = j })
    vi.mocked(studioApi.generateImage).mockImplementation((_a, _b, _c, _d, _e, _f, _g, signal?: AbortSignal) => {
      signal?.addEventListener('abort', () => {
        rejectHang({
          response: { data: { message: '已取消', refundedPoints: 10 } },
        })
      })
      return hang as never
    })

    const node = createNode('image', { prompt: 'cancel-refund' }, 'img-refund')
    const { api, deps } = createDeps([node])
    const pending = api.generateForNode(node)
    await Promise.resolve()
    await api.generateForNode(node)
    await pending

    expect(deps.patchNodeData).toHaveBeenCalledWith('img-refund', {
      errorMessage: '已取消，10 积分已返回',
    })
    expect(mockRefreshPoints).toHaveBeenCalled()
  })

  it('keeps independent studio image path on studioApi', async () => {
    const node = createNode('image', {
      prompt: 'standalone cat',
      imageModel: encodeChannelModel('platform', 'seedream-5.0-pro'),
      imageAspect: '16:9',
      imageResolution: '2K',
      imageCount: 2,
    })
    const { api } = createDeps([node])

    await api.generateForNode(node)

    expect(studioApi.generateImage).toHaveBeenCalledWith(
      'standalone cat',
      encodeChannelModel('platform', 'seedream-5.0-pro'),
      '16:9',
      [],
      [],
      '2K',
      2,
      expect.any(AbortSignal),
      canvasScope('image-1'),
    )
  })

  it('2e.1: pending_confirm image without imageModel still starts studio generate', async () => {
    const node = createNode('image', {
      prompt: '帮我生成一张蓝色天空产品主图',
      status: 'pending_confirm',
    })
    const isModelSelectable = vi.fn(() => true)
    const { api } = createDeps([node], { isModelSelectable })

    await api.generateForNode(node)

    expect(studioApi.generateImage).toHaveBeenCalled()
    expect(isModelSelectable).toHaveBeenCalled()
    expect(node.data?.status).not.toBe('pending_confirm')
    expect(node.data?.generationRecordId).toBe('rec-1')
  })
})

// 回归锁：U6 接线点①②。审计 §2.6 记「三处 while(true) 轮询无墙钟上限」，
// 实测只有 1 处 `for (;;)`（waitForRunGroupMemberSettled）—— 但它**不是死代码**：
// `CanvasPage.vue:1122` 以 `waitForNodeSettled` 真实消费。
// 见 docs/superpowers/specs/2026-10-04-media-generation-audit.md §2.6
describe('waitForRunGroupMemberSettled 墙钟上限', () => {
  it('getGeneration 持续失败 + 节点永远 generating ⇒ 墙钟到点返回 failed（不再死循环）', async () => {
    const node = createNode('video', { prompt: 'x' })
    node.data = { ...(node.data ?? {}), status: NODE_GENERATION_STATUS.generating, generationRecordId: 'rec-stuck' }
    const { api } = createDeps([node])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // 永远返回 generating（节点状态不变）⇒ 循环只能靠墙钟退出
    vi.mocked(studioApi.getGeneration).mockImplementation(async () => {
      return {
        data: { code: 0, message: 'ok', data: { id: 'rec-stuck', status: 'generating' } },
      } as never
    })

    // 注入 600ms 短墙钟：生产的 1_320_000 无法在单测里等
    const t0 = Date.now()
    const settled = await api.waitForRunGroupMemberSettled('video-1', 600)
    const elapsed = Date.now() - t0

    expect(settled).toBe('failed')
    // 必须真的等到了墙钟，而不是「碰巧」因为别的分支返回
    expect(elapsed).toBeGreaterThanOrEqual(550)
    warn.mockRestore()
  }, 60_000)

  it('节点在墙钟内落定 ⇒ 返回 ok（墙钟不误杀正常路径）', async () => {
    const node = createNode('video', { prompt: 'x' })
    node.data = { ...(node.data ?? {}), status: NODE_GENERATION_STATUS.generating, generationRecordId: 'rec-ok' }
    const { api, deps } = createDeps([node])

    // 第一次轮询就落定 completed + 有 url
    vi.mocked(studioApi.getGeneration).mockImplementation(async () => {
      deps.patchNodeData('video-1', {
        status: NODE_GENERATION_STATUS.completed,
        url: 'https://cdn/out.mp4',
      })
      return {
        data: { code: 0, message: 'ok', data: { id: 'rec-ok', status: 'completed', type: 'video', url: 'https://cdn/out.mp4' } },
      } as never
    })

    await expect(api.waitForRunGroupMemberSettled('video-1', 30_000)).resolves.toBe('ok')
  }, 30_000)
})

// 回归锁：U6 接线点②。`applyStudioRecord` 对 `completed` **无条件**写
// `status: completed`，而 `parseRecordUrl` 在音频存 COS / metadata 无 url 时返回 `''`
// ⇒ 节点永远停在「生成中」却无产物、无提示。
// 见 docs/superpowers/specs/2026-10-04-media-generation-audit.md §2.6
describe('applyStudioRecord 对「completed 但无产物」的处理', () => {
  it('音频 completed 且 url 为空 ⇒ 判error并给出可读原因（不是永久生成中）', async () => {
    const node = createNode('audio', { prompt: '台词' })
    node.data = { ...(node.data ?? {}), status: NODE_GENERATION_STATUS.generating }
    const { api, deps } = createDeps([node])

    vi.mocked(studioApi.getGeneration).mockImplementation(async () => {
      return {
        data: {
          code: 0,
          message: 'ok',
          data: { id: 'rec-a', type: 'audio', status: 'completed', url: '', metadata: JSON.stringify({ url: '' }) },
        },
      } as never
    })

    await api.applyStudioRecordForTest('audio-1', {
      id: 'rec-a',
      type: 'audio',
      prompt: '台词',
      status: 'completed',
      url: '',
      metadata: JSON.stringify({ url: '' }),
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    const last = deps.patchNodeData.mock.calls.at(-1)?.[1] as Record<string, unknown>
    expect(last.status).not.toBe(NODE_GENERATION_STATUS.completed)
    expect(last.status).toBe(NODE_GENERATION_STATUS.error)
    expect(String(last.errorMessage)).toMatch(/音频/)
  })

  it('音频 completed 且有 url ⇒ 仍正常 completed（不误报）', async () => {
    const node = createNode('audio', { prompt: '台词' })
    node.data = { ...(node.data ?? {}), status: NODE_GENERATION_STATUS.generating }
    const { api, deps } = createDeps([node])

    await api.applyStudioRecordForTest('audio-1', {
      id: 'rec-a',
      type: 'audio',
      prompt: '台词',
      status: 'completed',
      url: 'https://cdn/a.mp3',
      metadata: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    const last = deps.patchNodeData.mock.calls.at(-1)?.[1] as Record<string, unknown>
    expect(last.status).toBe(NODE_GENERATION_STATUS.completed)
    expect(last.url).toBe('https://cdn/a.mp3')
  })
})
