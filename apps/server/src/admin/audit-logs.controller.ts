import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { AdminTokenGuard } from './admin-token.guard'

/**
 * Ops Console §5.1 审计日志只读端点：`GET /api/admin/audit-logs`。
 *
 * - AdminTokenGuard（fail-closed，与 S1-1/S2-1b 同一 guard）。
 * - `AdminAuditLog` 此前只写不读（生产代码无查询面）——本端点补位，供运营台审计页消费。
 * - `action`/`resource` 精确匹配（可选）；`createdAt desc`；page 从 1 起；
 *   pageSize 上限 100（数据量 = 运营写操作频次，极低，`resource` 不建索引）。
 * - 只读：无任何写路径，不 bump 任何版本。
 */
const MAX_PAGE_SIZE = 100
const MAX_PAGE = 1000
const DEFAULT_PAGE = 1
const DEFAULT_PAGE_SIZE = 20

function parseBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isInteger(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

@Controller('admin/audit-logs')
export class AuditLogsAdminController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  @UseGuards(AdminTokenGuard)
  async list(@Query() query: Record<string, unknown>) {
    // Follow-up ④：page 上限收口到 1000（此前 Number.MAX_SAFE_INTEGER，天文 page 产生巨大 skip）
    const page = parseBoundedInt(query['page'], DEFAULT_PAGE, 1, MAX_PAGE)
    const pageSize = parseBoundedInt(query['pageSize'], DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)
    const action = typeof query['action'] === 'string' && query['action'] !== '' ? query['action'] : undefined
    const resource =
      typeof query['resource'] === 'string' && query['resource'] !== '' ? query['resource'] : undefined
    const where =
      action === undefined && resource === undefined
        ? undefined
        : { ...(action !== undefined ? { action } : {}), ...(resource !== undefined ? { resource } : {}) }
    const [rows, total] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.adminAuditLog.count({ where }),
    ])
    return { code: 0, message: 'ok', data: { rows, total, page, pageSize } }
  }
}
