import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import {
  assertRoutePatternSafe,
  type UpstreamRouteCapability,
  type UpstreamRouteMatchType,
} from '@lnkpi/shared'
import { PrismaService } from '../prisma/prisma.service'
import {
  bumpUpstreamRoutesVersion,
  readUpstreamRoutesVersion,
  refreshUpstreamRouteCache,
} from '../provider/upstream-route-store'
import { AdminTokenGuard } from './admin-token.guard'

/**
 * S2-2b 上游路由运营端点（spec: docs/superpowers/specs/2026-10-09-mph-s22-routing-table-design.md §3.5）：
 *
 * - `GET /api/admin/upstream-routes`       全量路由行（priority 降序）+ 当前 routesVersion；
 * - `PUT /api/admin/upstream-routes/:id`   更新路由行（部分字段；行由种子播种，本端点不新增/删除）。
 *
 * - AdminTokenGuard（fail-closed，与 S1-1/S2-1b 同一 guard）。
 * - 写操作在**同一事务**内：行落库 + 审计行（who/when/before/after）+ `routesVersion`
 *   原子 +1（单调递增、last-write-win，与 catalogVersion 同表分域 id='routes'）；
 *   事务提交后显式刷新路由缓存 —— 本进程下一次 resolve/探活立即生效；跨实例 5s TTL
 *   兜底（探活周期分钟级 ⇒ 「改路由下个探活周期生效、不热重启」确定性成立）。
 * - 校验（T3 concern 落地）：regex 行 pattern 过 `assertRoutePatternSafe`（ReDoS 防线）；
 *   **至多一条 default 行**（重复 → 409）；default 行 pattern 必须为空、普通行 pattern 必填。
 * - 审计 `actor` 恒为 'admin'：共享密钥鉴权无更细身份，密钥本身绝不落库/落日志。
 */

const VALID_MATCH_TYPES: readonly UpstreamRouteMatchType[] = ['prefix', 'exact', 'regex', 'default']
const VALID_UPSTREAMS = ['agnes_hub', 'apimart', 'stepfun', 'minimax', 'fal'] as const
const VALID_CAPABILITIES: readonly UpstreamRouteCapability[] = ['*', 'text', 'image', 'video', 'audio']

const ACTOR = 'admin'
const RESOURCE_PREFIX = 'upstream-routes'

/** admin API 的路由行形状（时间戳 ISO 字符串）。 */
export type AdminUpstreamRoute = {
  id: string
  matchType: string
  pattern: string | null
  capability: string
  upstream: string
  priority: number
  enabled: boolean
  fallbackApiKeyEnvName: string | null
  createdAt: string
  updatedAt: string
}

type UpstreamRouteRow = {
  id: string
  matchType: string
  pattern: string | null
  capability: string
  upstream: string
  priority: number
  enabled: boolean
  fallbackApiKeyEnvName: string | null
  createdAt: Date
  updatedAt: Date
}

function rowToAdminRoute(row: UpstreamRouteRow): AdminUpstreamRoute {
  return {
    id: row.id,
    matchType: row.matchType,
    pattern: row.pattern,
    capability: row.capability,
    upstream: row.upstream,
    priority: row.priority,
    enabled: row.enabled,
    fallbackApiKeyEnvName: row.fallbackApiKeyEnvName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** 审计快照（before/after）：行级 JSON，Date → ISO。 */
function auditSnapshot(row: UpstreamRouteRow): Record<string, unknown> {
  return { ...rowToAdminRoute(row) }
}

type ParsedRouteInput = {
  matchType?: UpstreamRouteMatchType
  pattern?: string | null
  capability?: UpstreamRouteCapability
  upstream?: (typeof VALID_UPSTREAMS)[number]
  priority?: number
  enabled?: boolean
  fallbackApiKeyEnvName?: string | null
}

/** 字段白名单校验（partial：只校验出现的字段）；跨字段规则（default/pattern 互斥等）由调用方对合并后终态判定。 */
function parseRouteInput(body: Record<string, unknown>): ParsedRouteInput {
  const out: Record<string, unknown> = {}

  if ('matchType' in body) {
    const v = body['matchType']
    if (typeof v !== 'string' || !(VALID_MATCH_TYPES as readonly string[]).includes(v)) {
      throw new BadRequestException(
        `matchType 必须是 ${VALID_MATCH_TYPES.join('/')}，收到: ${String(v)}`,
      )
    }
    out['matchType'] = v
  }

  if ('pattern' in body) {
    const v = body['pattern']
    if (v === null) {
      out['pattern'] = null
    } else if (typeof v === 'string' && v.trim()) {
      out['pattern'] = v.trim()
    } else {
      throw new BadRequestException('pattern 必须是非空字符串或 null（default 行）')
    }
  }

  if ('capability' in body) {
    const v = body['capability']
    if (typeof v !== 'string' || !(VALID_CAPABILITIES as readonly string[]).includes(v)) {
      throw new BadRequestException(
        `capability 必须是 ${VALID_CAPABILITIES.join('/')}，收到: ${String(v)}`,
      )
    }
    out['capability'] = v
  }

  if ('upstream' in body) {
    const v = body['upstream']
    if (typeof v !== 'string' || !(VALID_UPSTREAMS as readonly string[]).includes(v)) {
      throw new BadRequestException(
        `upstream 必须是 ${VALID_UPSTREAMS.join('/')}，收到: ${String(v)}`,
      )
    }
    out['upstream'] = v
  }

  if ('priority' in body) {
    const v = body['priority']
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new BadRequestException(`priority 必须是整数，收到: ${String(v)}`)
    }
    out['priority'] = v
  }

  if ('enabled' in body) {
    const v = body['enabled']
    if (typeof v !== 'boolean') {
      throw new BadRequestException(`enabled 必须是布尔值，收到: ${String(v)}`)
    }
    out['enabled'] = v
  }

  if ('fallbackApiKeyEnvName' in body) {
    const v = body['fallbackApiKeyEnvName']
    if (v === null) {
      out['fallbackApiKeyEnvName'] = null
    } else if (typeof v === 'string' && v.trim()) {
      out['fallbackApiKeyEnvName'] = v.trim()
    } else {
      throw new BadRequestException('fallbackApiKeyEnvName 必须是非空字符串或 null')
    }
  }

  return out as ParsedRouteInput
}

@Controller('admin/upstream-routes')
export class UpstreamRoutesAdminController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  @UseGuards(AdminTokenGuard)
  async list() {
    const [version, rows] = await Promise.all([
      readUpstreamRoutesVersion(this.prisma),
      this.prisma.upstreamRoute.findMany({ orderBy: [{ priority: 'desc' }, { id: 'asc' }] }),
    ])
    return { code: 0, message: 'ok', data: { version, routes: rows.map(rowToAdminRoute) } }
  }

  @Put(':id')
  @UseGuards(AdminTokenGuard)
  async update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    const existing = await this.prisma.upstreamRoute.findUnique({ where: { id } })
    if (!existing) {
      throw new NotFoundException('路由行不存在（路由行由种子播种，本端点只改不增删）')
    }
    const input = parseRouteInput(body)

    // 跨字段规则对「合并后终态」判定：
    const finalMatchType = input.matchType ?? (existing.matchType as UpstreamRouteMatchType)
    const finalPattern = input.pattern !== undefined ? input.pattern : existing.pattern
    if (finalMatchType === 'default') {
      if (finalPattern != null) {
        throw new BadRequestException('default 行 pattern 必须为空（兜底行不按 pattern 匹配）')
      }
    } else {
      if (finalPattern == null || !finalPattern.trim()) {
        throw new BadRequestException(`${finalMatchType} 行 pattern 必填（default 行才允许为空）`)
      }
      if (finalMatchType === 'regex') {
        // ReDoS 防线（T3 concern）：pattern 长度上限 + 禁嵌套量词 + 可编译。
        // UpstreamRoutePatternError → 400（运营端点显式拒绝，不裸抛 500）。
        try {
          assertRoutePatternSafe(finalPattern)
        } catch (err) {
          throw new BadRequestException(err instanceof Error ? err.message : String(err))
        }
      }
    }

    const data: Prisma.UpstreamRouteUpdateInput = {}
    if (input.matchType !== undefined) data.matchType = input.matchType
    if (input.pattern !== undefined) data.pattern = input.pattern
    if (input.capability !== undefined) data.capability = input.capability
    if (input.upstream !== undefined) data.upstream = input.upstream
    if (input.priority !== undefined) data.priority = input.priority
    if (input.enabled !== undefined) data.enabled = input.enabled
    if (input.fallbackApiKeyEnvName !== undefined) {
      data.fallbackApiKeyEnvName = input.fallbackApiKeyEnvName
    }

    const { row, version } = await this.prisma.$transaction(async (tx) => {
      // 至多一条 default 行（T3 concern）：把行改成 default 时，库里不得已有别的 default 行。
      if (finalMatchType === 'default' && existing.matchType !== 'default') {
        const other = await tx.upstreamRoute.findFirst({
          where: { matchType: 'default', id: { not: id } },
        })
        if (other) {
          throw new ConflictException(
            `已存在 default 路由行（id=${other.id}）——至多一条 default 行，请先改掉它`,
          )
        }
      }
      const row = await tx.upstreamRoute.update({ where: { id }, data })
      await tx.adminAuditLog.create({
        data: {
          actor: ACTOR,
          action: `${RESOURCE_PREFIX}.update`,
          resource: `${RESOURCE_PREFIX}:${row.id}`,
          before: JSON.stringify(auditSnapshot(existing)),
          after: JSON.stringify(auditSnapshot(row)),
        },
      })
      const version = await bumpUpstreamRoutesVersion(tx)
      return { row, version }
    })
    // 本进程立即生效（下一次 resolve/探活见新路由）；跨实例 5s TTL 兜底。
    await refreshUpstreamRouteCache(this.prisma)
    return { code: 0, message: 'ok', data: { version, route: rowToAdminRoute(row) } }
  }
}
