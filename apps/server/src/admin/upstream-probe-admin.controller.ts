import { Controller, Get, Inject, UseGuards } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { PROBE_UPSTREAM_IDS } from '../provider/upstream-probe.service'
import { AdminTokenGuard } from './admin-token.guard'

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * S1-1 对账端点（spec §3.4）：`GET /api/admin/upstream-probe/latest`。
 *
 * 返回每个上游最近一帧 `UpstreamProbeRun`（无 run 的上游不出现在 runs 里）。
 * openapi 语义（brief 2.4 二选一）：**尚无任何 run 时返回 200 + `{runs: []}`**，不用 404 ——
 * 「还没有对账数据」是部署后的正常初态（探活间隔默认 6h），404 会被运维误读为路径错误。
 */
@Controller('admin/upstream-probe')
export class UpstreamProbeAdminController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get('latest')
  @UseGuards(AdminTokenGuard)
  async latest() {
    const rows = await Promise.all(
      PROBE_UPSTREAM_IDS.map((upstream) =>
        this.prisma.upstreamProbeRun.findFirst({
          where: { upstream },
          orderBy: { ranAt: 'desc' },
        }),
      ),
    )
    const runs = rows
      .filter((row): row is NonNullable<(typeof rows)[number]> => row !== null)
      .map((row) => ({
        id: row.id,
        ranAt: row.ranAt,
        upstream: row.upstream,
        httpStatus: row.httpStatus,
        modelCount: row.modelCount,
        ghosts: parseStringArray(row.ghosts),
        missing: parseStringArray(row.missing),
        error: row.error,
        // B3：触发来源（旧行为 null，不破坏既有消费）。
        reason: row.reason,
      }))
    return { code: 0, message: 'ok', data: { runs } }
  }
}
