import { Injectable, NotFoundException } from '@nestjs/common'
import type { CanvasAction, CanonicalVideoGenerationRequest } from '@lnkpi/shared'
import { StudioService, type StudioRefInput } from './studio.service'
import type {
  VideoGenerationStartResult,
  VideoGenerationWaitResult,
} from '@lnkpi/shared'

/**
 * 轮询墙钟上限。
 *
 * ⚠️ 2026-10-04 从 `660_000` 上调到 `1_260_000`。原值只对齐了 Agnes 的
 * `maxPollMs = 600_000`，而 `videoModelProfiles.ts` 里 **minimax H3 的
 * `maxPollMs = 1_200_000`**⇒ 该模型必然先被本 orchestrator 判timeout，
 * **而后台任务仍在跑**，状态自相矛盾（生产有 3 条
 * `Agnes video timed out after 120 polls` 就是这个错配）。
 *
 * 取`max(all profiles) + 60s 余量`：poll还要走 HTTP 往返 + 序列化，
 * 抖动是必然的，不能让传输延迟被误判成上游超时。
 * 有回归锁（`video-generation.orchestrator.test.ts`）断言本值 ≥ 全部 profile 且留足余量。
 * 见 docs/superpowers/specs/2026-10-04-media-generation-audit.md §2.4
 */
export const VIDEO_POLL_TIMEOUT_MS = 1_260_000
const POLL_INTERVAL_MS = 1500

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toStudioRefs(refs: CanonicalVideoGenerationRequest['refs']): StudioRefInput[] {
  return refs.map((r) => ({
    refKey: r.refKey,
    mediaType: r.mediaType,
    label: r.label,
    text: r.text,
    url: r.url,
  }))
}

@Injectable()
export class VideoGenerationOrchestrator {
  constructor(private readonly studio: StudioService) {}

  async start(
    userId: string,
    request: CanonicalVideoGenerationRequest,
    persist: (actions: CanvasAction[]) => Promise<unknown>,
    legacyReferenceImageUrl?: string,
  ): Promise<VideoGenerationStartResult> {
    const { nodeId, sessionId } = request.scope
    const prompt = request.prompt.trim()
    if (!prompt) throw new NotFoundException('节点缺少 prompt')

    const generationStartedAt = new Date().toISOString()
    const started: CanvasAction[] = [
      {
        type: 'update_node',
        payload: {
          id: nodeId,
          data: {
            status: 'generating',
            generationStartedAt,
            prompt,
          },
        },
      },
    ]
    await persist(started)
    const allActions: CanvasAction[] = [...started]

    const { videoSettings } = request
    const record = await this.studio.generateVideo(
      userId,
      prompt,
      request.model,
      videoSettings.duration,
      videoSettings.aspectRatio,
      toStudioRefs(request.refs),
      request.mentionedKeys,
      videoSettings.resolution,
      videoSettings.crop,
      legacyReferenceImageUrl,
      { sessionId, nodeId },
      request.videoMode,
      videoSettings.generateAudio,
      request.seed,
      request.negativePrompt,
    )

    const recordId = record.id
    const recordPatch: CanvasAction = {
      type: 'update_node',
      payload: { id: nodeId, data: { generationRecordId: recordId } },
    }
    allActions.push(recordPatch)
    await persist([recordPatch])

    return {
      generationRecordId: recordId,
      status: 'generating',
      generationStartedAt,
      actions: allActions,
    }
  }

  async wait(
    userId: string,
    input: { sessionId: string; nodeId: string; generationRecordId: string },
    persist: (actions: CanvasAction[]) => Promise<unknown>,
  ): Promise<VideoGenerationWaitResult> {
    const recordId = input.generationRecordId
    const allActions: CanvasAction[] = []

    try {
      const initial = await this.studio.getGeneration(userId, recordId)
      const terminal = await this.pollGeneration(userId, recordId, initial)
      const status = String(terminal.status)
      const url = typeof terminal.url === 'string' && terminal.url ? terminal.url : undefined

      const finishData: Record<string, unknown> = {
        status:
          status === 'completed'
            ? 'completed'
            : status === 'failed' || status === 'error'
              ? 'error'
              : status,
        generationRecordId: recordId,
      }
      if (url) finishData.url = url
      if (status !== 'completed') {
        finishData.errorMessage = '视频生成未完成或超时'
      }

      const finishActions: CanvasAction[] = [
        { type: 'update_node', payload: { id: input.nodeId, data: finishData } },
      ]
      await persist(finishActions)
      allActions.push(...finishActions)

      return {
        url,
        status: String(finishData.status),
        generationRecordId: recordId,
        actions: allActions,
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '视频生成失败'
      const errorActions: CanvasAction[] = [
        {
          type: 'update_node',
          payload: {
            id: input.nodeId,
            data: { status: 'error', errorMessage, generationRecordId: recordId },
          },
        },
      ]
      await persist(errorActions)
      allActions.push(...errorActions)
      return { status: 'error', generationRecordId: recordId, actions: allActions }
    }
  }

  private async pollGeneration(
    userId: string,
    recordId: string,
    initial: { id: string; status: string; url?: string | null },
    timeoutMs = VIDEO_POLL_TIMEOUT_MS,
  ): Promise<{ id: string; status: string; url?: string | null }> {
    const terminal = new Set(['completed', 'failed', 'error', 'fallback_pending'])
    if (terminal.has(initial.status)) return initial

    const deadline = Date.now() + timeoutMs
    let latest = initial
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS)
      latest = await this.studio.getGeneration(userId, recordId)
      if (terminal.has(latest.status)) return latest
    }
    return { ...latest, status: latest.status === 'generating' ? 'timeout' : latest.status }
  }
}
