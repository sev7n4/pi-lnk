import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpException,
  Inject,
  NotFoundException,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { resolveUpstreamRoute, UPSTREAM_REGISTRY, type UpstreamId } from '@lnkpi/shared'
import { PrismaService } from '../prisma/prisma.service'
import { currentUpstreamRoutes } from '../provider/upstream-route-store'
import { bumpModelCatalogVersion, refreshModelCatalogCache } from '../provider/model-catalog-store'
import { AdminTokenGuard } from './admin-token.guard'
import { assertXConfirm } from './model-catalog.controller'
import {
  listDefaultAlternatives,
  routeImpact,
  runOnboardSmoke,
  summarizeRecentTraffic,
  type SmokeResult,
} from './model-ops-shared'

/**
 * model-ops Task 2 原子编排（spec: docs/superpowers/specs/2026-10-10-model-ops-simplify-design.md；
 * plan: docs/superpowers/plans/2026-10-11-model-ops-backend.md §3）——**纯编排，无新存储**：
 *
 * - `POST /api/admin/model-ops/onboard`：凭据存在性 → 路由可达 →（可选）真实冒烟 →
 *   目录事务（复用 catalog create 语义含软删复活）+ 审计 + 版本 bump；任一步硬失败即中止，
 *   响应 `{steps}` 全量披露。
 * - `POST /api/admin/model-ops/offboard`：dryRun 缺省 **true**（默认判定 DB isDefault /
 *   alternatives / 近 24h 流量摘要 / 路由影响面）；执行态（dryRun=false）要求
 *   `X-Confirm: <modelKey>`，软删 + 审计 + bump；默认模型 → 409（同 DELETE 防呆）。
 * - 路由与目录解耦：onboard 不隐式创建路由行（未命中 → 409 提示加路由）；offboard
 *   不自动改路由行（响应提示建议 PUT enabled=false）。
 * - 单写原则：availability/isDefault 本控制器不写；审计 actor 恒 'admin'。
 */

const ACTOR = 'admin'
const VALID_MODALITIES = ['text', 'image', 'video', 'audio'] as const
const VALID_ONBOARD_UPSTREAMS = Object.keys(UPSTREAM_REGISTRY) as UpstreamId[]

type OnboardSteps = {
  credential: { status: 'ok' | 'failed'; detail: string }
  route: { status: 'ok' | 'failed'; detail: string }
  smoke: SmokeResult
  catalog: { status: 'ok' | 'failed' | 'skipped'; detail: string; version?: number }
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`${field} 必须是非空字符串`)
  }
  return value.trim()
}

@Controller('admin/model-ops')
export class ModelOpsAdminController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Post('onboard')
  @UseGuards(AdminTokenGuard)
  async onboard(
    @Headers() headers: Record<string, unknown>,
    @Body() body: Record<string, unknown>,
  ) {
    const modelKey = assertNonEmptyString(body['modelKey'], 'modelKey')
    const gatewayModelId = assertNonEmptyString(body['gatewayModelId'], 'gatewayModelId')
    const modality = assertNonEmptyString(body['modality'], 'modality')
    if (!(VALID_MODALITIES as readonly string[]).includes(modality)) {
      throw new BadRequestException(`modality 必须是 ${VALID_MODALITIES.join('/')}，收到: ${modality}`)
    }
    const providerBinding = assertNonEmptyString(body['providerBinding'], 'providerBinding')
    const upstreamRaw = assertNonEmptyString(body['upstream'], 'upstream')
    if (!(VALID_ONBOARD_UPSTREAMS as string[]).includes(upstreamRaw)) {
      throw new BadRequestException(`upstream 必须是 ${VALID_ONBOARD_UPSTREAMS.join('/')}，收到: ${upstreamRaw}`)
    }
    const upstream = upstreamRaw as UpstreamId
    const displayName = typeof body['displayName'] === 'string' && body['displayName'].trim() ? body['displayName'].trim() : modelKey
    const params = body['params'] && typeof body['params'] === 'object' && !Array.isArray(body['params']) ? body['params'] : {}
    const defaults = body['defaults'] && typeof body['defaults'] === 'object' && !Array.isArray(body['defaults']) ? body['defaults'] : null
    const smokeTest = body['smokeTest'] === true

    const steps: OnboardSteps = {
      credential: { status: 'ok', detail: '' },
      route: { status: 'ok', detail: '' },
      smoke: { status: 'skipped', detail: 'smokeTest 未启用' },
      catalog: { status: 'skipped', detail: '前置步骤未通过' },
    }

    // step1 凭据存在性（registry env 名 + fallback 同链，与运行时取值同源）
    const registry = UPSTREAM_REGISTRY[upstream]
    const keyEnvNames = [registry.apiKeyEnvName, registry.fallbackApiKeyEnvName].filter((x): x is string => !!x)
    const presentEnv = keyEnvNames.find((name) => !!process.env[name]?.trim())
    if (!presentEnv) {
      steps.credential = { status: 'failed', detail: `上游凭据未配置：${keyEnvNames.join(' / ')}（进程 env 均为空）` }
      throw new UnprocessableEntityException({ message: 'onboard 前置校验失败', steps })
    }
    steps.credential = { status: 'ok', detail: presentEnv }

    // step2 路由可达：resolve 与运行时同一张表（currentUpstreamRoutes 缓存）
    let routedUpstream: string
    try {
      routedUpstream = resolveUpstreamRoute([...currentUpstreamRoutes()], modelKey, modality as never).upstream
    } catch {
      steps.route = {
        status: 'failed',
        detail: `modelKey=${modelKey} 未命中任何路由行且无可用 default 行（capability=${modality}）。请先在 upstream-routes 增加路由行（本端点不隐式创建路由）`,
      }
      throw new ConflictException({ message: 'onboard 前置校验失败', steps })
    }
    if (routedUpstream !== upstream) {
      steps.route = {
        status: 'failed',
        detail: `路由指向 ${routedUpstream}，与请求 upstream=${upstream} 不一致。请修正路由行（本端点不隐式创建/改路由）`,
      }
      throw new ConflictException({ message: 'onboard 前置校验失败', steps })
    }
    steps.route = { status: 'ok', detail: `路由命中 → ${routedUpstream}` }

    // step3 冒烟（smokeTest 显式传才发真实请求；skipped/failed 均披露不阻断硬失败项）
    if (smokeTest) {
      steps.smoke = await runOnboardSmoke(upstream, modality, gatewayModelId, process.env)
    }

    // step4 目录事务（复用 catalog create 语义：软删同 key 视为恢复上架）
    const existing = await this.prisma.modelCatalogEntry.findUnique({ where: { modelKey } })
    if (existing && existing.deletedAt == null) {
      steps.catalog = { status: 'failed', detail: `modelKey 已存在: ${existing.modelKey}` }
      throw new ConflictException({ message: 'onboard 前置校验失败', steps })
    }
    const data = {
      modelKey,
      displayName,
      gatewayModelId,
      modality,
      providerBinding,
      audioKind: null as string | null,
      voices: null as string | null,
      params: JSON.stringify(params),
      defaults: defaults ? JSON.stringify(defaults) : null,
      // 软删恢复不复活 isDefault（安全侧，Task 1 语义）
      deletedAt: null,
    }
    const { row, version } = await this.prisma.$transaction(async (tx) => {
      const row = await (existing
        ? tx.modelCatalogEntry.update({ where: { id: existing.id }, data })
        : tx.modelCatalogEntry.create({ data }))
      await tx.adminAuditLog.create({
        data: {
          actor: ACTOR,
          action: 'model-ops.onboard',
          resource: `model-catalog:${row.modelKey}`,
          before: existing
            ? JSON.stringify({ modelKey: existing.modelKey, deletedAt: existing.deletedAt?.toISOString() ?? null })
            : null,
          after: JSON.stringify({ modelKey: row.modelKey, modality: row.modality, gatewayModelId: row.gatewayModelId }),
        },
      })
      const version = await bumpModelCatalogVersion(tx)
      return { row, version }
    })
    await refreshModelCatalogCache(this.prisma)
    steps.catalog = { status: 'ok', detail: existing ? '软删条目已恢复上架' : '条目已创建', version }

    return {
      code: 0,
      message: 'ok',
      data: {
        version,
        entry: { id: row.id, modelKey: row.modelKey, modality: row.modality, gatewayModelId: row.gatewayModelId },
        steps,
        hints: [
          `镜像/用户快照由下一次 provider 调用（或 bootstrap）按版本对齐，通常 ≤5 分钟内生效`,
          ...(steps.smoke.status !== 'ok' ? [`冒烟未通过（${steps.smoke.status}）：${steps.smoke.detail}`] : []),
        ],
      },
    }
  }

  @Post('offboard')
  @UseGuards(AdminTokenGuard)
  async offboard(
    @Headers() headers: Record<string, unknown>,
    @Body() body: Record<string, unknown>,
  ) {
    const modelKey = assertNonEmptyString(body['modelKey'], 'modelKey')
    const dryRun = body['dryRun'] === undefined ? true : body['dryRun'] === true

    const existing = await this.prisma.modelCatalogEntry.findUnique({ where: { modelKey } })
    if (!existing || existing.deletedAt != null) {
      throw new NotFoundException(`目录条目不存在（或已下架）: ${modelKey}`)
    }

    // 判定材料（dryRun 与执行态都披露）
    const isDefault = existing.isDefault === true
    const [alternatives, traffic] = await Promise.all([
      listDefaultAlternatives(this.prisma, existing.modality, existing.modelKey),
      summarizeRecentTraffic(this.prisma, [existing.modelKey, existing.gatewayModelId]),
    ])
    const routes = routeImpact(existing.modelKey)

    if (dryRun) {
      return {
        code: 0,
        message: 'ok',
        data: {
          dryRun: true,
          modelKey: existing.modelKey,
          isDefault,
          alternatives,
          traffic,
          routeImpact: routes,
          hints: [
            ...(isDefault ? ['该条目是当前默认模型：先 PUT /api/admin/model-defaults 切换默认，否则执行态返回 409'] : []),
            ...(routes.length > 0
              ? [`仍有 ${routes.length} 条 enabled 路由行命中该 modelKey——路由与目录解耦，建议另行 PUT enabled=false`]
              : []),
            '确认执行请重发：dryRun=false + X-Confirm: <modelKey>',
          ],
        },
      }
    }

    // 执行态：高危写，X-Confirm 确认
    assertXConfirm(headers, modelKey)
    if (isDefault) {
      const alternatives409 = await listDefaultAlternatives(this.prisma, existing.modality, existing.modelKey)
      throw new ConflictException({
        message: `${modelKey} 是 ${existing.modality} 模态的当前默认模型，禁止下架。请先 PUT /api/admin/model-defaults 切换默认。`,
        alternatives: alternatives409,
      })
    }

    const deletedAt = new Date()
    const { row, version } = await this.prisma.$transaction(async (tx) => {
      const row = await tx.modelCatalogEntry.update({
        where: { id: existing.id },
        data: { deletedAt },
      })
      await tx.adminAuditLog.create({
        data: {
          actor: ACTOR,
          action: 'model-ops.offboard',
          resource: `model-catalog:${row.modelKey}`,
          before: JSON.stringify({ modelKey: row.modelKey, deletedAt: null }),
          after: JSON.stringify({ modelKey: row.modelKey, deletedAt: deletedAt.toISOString(), reason: typeof body['reason'] === 'string' ? body['reason'] : null }),
        },
      })
      const version = await bumpModelCatalogVersion(tx)
      return { row, version }
    })
    await refreshModelCatalogCache(this.prisma)
    return {
      code: 0,
      message: 'ok',
      data: {
        version,
        modelKey: row.modelKey,
        offboarded: true,
        routeImpact: routes,
        hints:
          routes.length > 0
            ? [`仍有 ${routes.length} 条 enabled 路由行命中该 modelKey——路由与目录解耦，建议另行 PUT enabled=false（X-Confirm: <routeId>）`]
            : [],
      },
    }
  }
}
