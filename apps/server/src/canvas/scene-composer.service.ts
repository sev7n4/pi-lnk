import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { buildVideoReferenceBundle } from '@lnkpi/agent'
import type {
  SceneComposerBatchGenerateRequest,
  SceneComposerBatchItem,
  SceneComposerSaveRequest,
  SceneComposerScene,
} from '@lnkpi/shared'
import { MaterialService } from './material.service'
import { ShotService } from './shot.service'
import { PrismaService } from '../prisma/prisma.service'
import { PricingService } from '../pricing/pricing.service'
import type { PricingQuote } from '../pricing/pricing.core'
import { PointsService } from '../points/points.service'
import { consumeMeta } from '../points/point-tx.types'

@Injectable()
export class SceneComposerService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ShotService) private readonly shotService: ShotService,
    @Inject(MaterialService) private readonly materialService: MaterialService,
    @Inject(PointsService) private readonly points: PointsService,
    @Inject(PricingService) private readonly pricing: PricingService,
  ) {}

  private async assertOwnedSession(sessionId: string, userId: string) {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, userId },
    })
    if (!session) throw new NotFoundException('画布不存在')
    return session
  }

  private async itemQuote(item: SceneComposerBatchItem, userId: string): Promise<PricingQuote> {
    if (item.mediaType === 'video') {
      const bundle = buildVideoReferenceBundle(item.refs ?? [])
      return this.pricing.quote(
        {
          capability: 'video',
          modelKey: item.model,
          duration: item.duration ?? 5,
          resolution: item.resolution,
          referenceImageCount: bundle.images.length,
          referenceVideoCount: bundle.videos.length,
        },
        userId,
      )
    }
    // 图像平铺 10 分：quote 只传 capability + count，不传 resolution/modelKey
    // （legacyPriceOf({capability:'image',count:1}) → 1K 因子 = 10，与原 return 10 等价）
    return this.pricing.quote({ capability: 'image', count: 1 }, userId)
  }

  private async assertShotInSession(shotId: string, sessionId: string) {
    const shot = await this.prisma.shot.findUnique({ where: { id: shotId } })
    if (shot && shot.sessionId !== sessionId) {
      throw new NotFoundException('画布不存在')
    }
    return shot
  }

  private assertNoBlobRefsInBatch(items: SceneComposerBatchItem[]) {
    for (const item of items) {
      for (const ref of item.refs ?? []) {
        if (ref.url?.trim().startsWith('blob:')) {
          throw new BadRequestException('参考图尚未上传')
        }
      }
    }
  }

  async save(userId: string, dto: SceneComposerSaveRequest) {
    await this.assertOwnedSession(dto.sessionId, userId)
    const syncedShots: string[] = []

    for (const scene of dto.scenes) {
      await this.syncSceneShots(dto.sessionId, scene, syncedShots)
    }

    if (syncedShots.length) {
      await this.shotService.reorder(dto.sessionId, syncedShots)
    }

    return {
      composerNodeId: dto.composerNodeId,
      sceneCount: dto.scenes.length,
      shotCount: dto.scenes.reduce((sum, scene) => sum + scene.shots.length, 0),
      syncedShotIds: syncedShots,
    }
  }

  private async syncSceneShots(
    sessionId: string,
    scene: SceneComposerScene,
    syncedShots: string[],
  ) {
    for (const [index, shot] of scene.shots.entries()) {
      if (!shot.shotNodeId) continue
      syncedShots.push(shot.shotNodeId)
      const existing = await this.assertShotInSession(shot.shotNodeId, sessionId)
      if (existing) {
        await this.shotService.update(shot.shotNodeId, {
          title: shot.title || scene.title || `镜头 ${index + 1}`,
          prompt: shot.prompt,
          status: 'draft',
        })
      } else {
        await this.shotService.create(sessionId, {
          id: shot.shotNodeId,
          title: shot.title || scene.title || `镜头 ${index + 1}`,
          prompt: shot.prompt,
          order: syncedShots.length - 1,
          status: 'draft',
        })
      }
    }
  }

  async batchGenerate(userId: string, dto: SceneComposerBatchGenerateRequest) {
    await this.assertOwnedSession(dto.sessionId, userId)

    for (const item of dto.items) {
      await this.assertShotInSession(item.shotNodeId, dto.sessionId)
    }

    this.assertNoBlobRefsInBatch(dto.items)

    const quotes = await Promise.all(dto.items.map((item) => this.itemQuote(item, userId)))
    const total = quotes.reduce((sum, q) => sum + q.credits, 0)
    // 同一 batch 内 ruleVersion 不一致（表命中与常量兜底混排）时保守记 null，不谎报版本来源
    const ruleVersion =
      quotes.length > 0 && quotes.every((q) => q.ruleVersion === quotes[0].ruleVersion)
        ? quotes[0].ruleVersion
        : null
    // 灰度混排裁定 T6-b：批内全部 item 命中同一 grayReleaseId 才落账；
    // 任一不同/未命中/空批 → 不带键（走 global 口径），与 ruleVersion 混排保守 null 同构
    const grayReleaseId =
      quotes.length > 0 &&
      quotes.every((q) => q.grayReleaseId && q.grayReleaseId === quotes[0].grayReleaseId)
        ? quotes[0].grayReleaseId
        : undefined
    if (total > 0) {
      await this.points.consume(
        userId,
        total,
        `导演台批量生成 ×${dto.items.length}`,
        consumeMeta('other', {
          generationId: null,
          ruleVersion,
          ...(grayReleaseId ? { grayReleaseId } : {}),
        }),
      )
    }

    const results: Array<{ shotNodeId: string; materialId?: string; mediaType: string }> = []

    for (const item of dto.items) {
      const result = await this.generateItem(dto.sessionId, userId, item)
      results.push(result)
    }

    return {
      composerNodeId: dto.composerNodeId,
      items: results,
    }
  }

  private async generateItem(
    sessionId: string,
    userId: string,
    item: SceneComposerBatchItem,
  ) {
    const existing = await this.prisma.shot.findUnique({ where: { id: item.shotNodeId } })
    if (existing) {
      await this.shotService.update(item.shotNodeId, {
        title: item.title,
        prompt: item.prompt,
        status: 'generating',
      })
    } else {
      await this.shotService.create(sessionId, {
        id: item.shotNodeId,
        title: item.title ?? '分镜',
        prompt: item.prompt,
        status: 'generating',
      })
    }

    if (item.mediaType === 'video') {
      const material = await this.materialService.generateVideo({
        userId,
        shotId: item.shotNodeId,
        prompt: item.prompt,
        model: item.model,
        duration: item.duration,
        aspectRatio: item.aspectRatio,
        resolution: item.resolution,
        crop: item.crop,
        refs: item.refs,
        mentionedKeys: item.mentionedKeys,
        skipCharge: true,
      })
      return { shotNodeId: item.shotNodeId, materialId: material.id, mediaType: 'video' }
    }

    const material = await this.materialService.generateImage({
      userId,
      shotId: item.shotNodeId,
      prompt: item.prompt,
      model: item.model,
      aspectRatio: item.aspectRatio,
      resolution: item.resolution,
      count: item.count,
      refs: item.refs,
      mentionedKeys: item.mentionedKeys,
      skipCharge: true,
    })
    return { shotNodeId: item.shotNodeId, materialId: material.id, mediaType: 'image' }
  }
}
