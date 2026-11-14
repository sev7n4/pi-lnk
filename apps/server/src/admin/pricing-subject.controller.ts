// apps/server/src/admin/pricing-subject.controller.ts
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common'
import { PricingSubjectService } from '../pricing/pricing-subject.service'
import { PrismaService } from '../prisma/prisma.service'
import { AdminTokenGuard } from './admin-token.guard'

/**
 * S1 T2：PricingSubject 重建 admin 端点（ops-console 消费）。
 *
 * - 前缀 /api/admin/pricing/subjects，挂 AdminTokenGuard（照 pricing-publishing 模式，fail-closed）。
 * - 业务语义在 PricingSubjectService.rebuild()（以 ModelCatalogEntry 为真源、幂等重建主体、
 *   内部落 AdminAuditLog('pricing-subject.rebuild')）。
 * - 入参可选 `{ dryRun?: boolean }`；本任务 dryRun 暂等价于实跑（rebuild 幂等、不删主体），
 *   保留字段供前端未来接预览态。DTO 手校（照 platform-channel 既有模式）。
 */
interface RebuildBody {
  dryRun?: boolean
}

function parseRebuildBody(body: Record<string, unknown>): RebuildBody {
  const out: RebuildBody = {}
  if (body['dryRun'] !== undefined) {
    if (typeof body['dryRun'] !== 'boolean') {
      throw new Error('dryRun 必须是布尔')
    }
    out.dryRun = body['dryRun']
  }
  return out
}

@Controller('admin/pricing/subjects')
export class PricingSubjectController {
  constructor(
    private readonly subjects: PricingSubjectService,
    private readonly prisma: PrismaService,
  ) {}

  /** 供运维页展示：返回全部定价主体行（含成本覆盖状态，前端据此标注缺成本主体）。 */
  @Get()
  @UseGuards(AdminTokenGuard)
  async list() {
    const rows = await this.prisma.pricingSubject.findMany({ orderBy: { subjectKey: 'asc' } })
    return {
      code: 0,
      message: 'ok',
      data: rows.map((r) => ({
        id: r.id,
        subjectKey: r.subjectKey,
        capability: r.capability,
        modelKey: r.modelKey,
        spec: r.spec,
        provider: r.provider,
        upstream: r.upstream,
        channelId: r.channelId,
        status: r.status,
        billableUnit: r.billableUnit,
        unitsPerRequest: r.unitsPerRequest,
        defaultSubjectKey: r.defaultSubjectKey,
        source: r.source,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    }
  }

  @Post('rebuild')
  @UseGuards(AdminTokenGuard)
  async rebuild(@Body() body: Record<string, unknown>) {
    parseRebuildBody(body) // 手校入参；dryRun 当前不短路（rebuild 幂等）
    return { code: 0, message: 'ok', data: await this.subjects.rebuild() }
  }
}
