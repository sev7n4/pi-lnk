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
import { PrismaService } from '../prisma/prisma.service'
import { AdminTokenGuard } from './admin-token.guard'

/**
 * Ops Console §5.2 平台渠道定价端点（pricing 数据面 = PR #350 的 `models[].pricing`）。
 *
 * - 硬编码只操作 `id='platform'` 单行（与 provider.service.ts 的 PLATFORM_CHANNEL_ID
 *   同值；不 import provider 模块）——BYOK 用户渠道结构性不可达。
 * - GET：models 解析失败 fail-soft（`models:[] + parseError:true`），绝不 500。
 * - PUT：条目级 pricing 替换（set / clear=null），**其余条目与字段一律不动**
 *   （防 pull-models 式整块覆盖重演）；models 畸形 → 409 拒盲写。
 * - 渠道行由 provider-resolver 每请求直读 DB（非 5s TTL 缓存），PUT 即时生效；
 *   渠道不在 catalogVersion/routesVersion 域内，不 bump。
 * - 审计：条目级 diff（旧/新 pricing 对象），actor 恒 'admin'。
 */

const PLATFORM_CHANNEL_ID = 'platform'
const ACTOR = 'admin'
const RESOURCE_PREFIX = 'platform-channel'

type ChannelModelEntry = { name: string; capability: string; pricing?: Record<string, number> } & Record<string, unknown>

const PRICING_KEYS = ['inputPerM', 'outputPerM', 'cacheReadPerM', 'cacheWritePerM'] as const

function parseModels(raw: string | null): { models: ChannelModelEntry[]; parseError: boolean } {
  if (raw == null) return { models: [], parseError: false }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return { models: [], parseError: true }
    return { models: parsed as ChannelModelEntry[], parseError: false }
  } catch {
    return { models: [], parseError: true }
  }
}

function parsePricingInput(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('pricing 必须是非数组对象或 null（null=清除）')
  }
  const out: Record<string, number> = {}
  let provided = 0
  for (const key of PRICING_KEYS) {
    const v = (value as Record<string, unknown>)[key]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new BadRequestException(`pricing.${key} 必须是非负有限数，收到: ${String(v)}`)
    }
    out[key] = v
    provided += 1
  }
  if (provided === 0) {
    throw new BadRequestException(`pricing 至少包含一个费率字段：${PRICING_KEYS.join('/')}`)
  }
  return out
}

@Controller('admin/platform-channel')
export class PlatformChannelAdminController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  @UseGuards(AdminTokenGuard)
  async show() {
    const channel = await this.prisma.providerChannel.findUnique({ where: { id: PLATFORM_CHANNEL_ID } })
    if (!channel) {
      throw new NotFoundException('平台渠道行不存在（应由 ensurePlatformChannel 播种）')
    }
    const { models, parseError } = parseModels(channel.models)
    return {
      code: 0,
      message: 'ok',
      data: { id: channel.id, name: channel.name, apiFormat: channel.apiFormat, models, parseError },
    }
  }

  @Put('models/:name/pricing')
  @UseGuards(AdminTokenGuard)
  async setPricing(@Param('name') name: string, @Body() body: Record<string, unknown>) {
    if (!('pricing' in body)) {
      throw new BadRequestException('body 必须包含 pricing 键（对象=设置，null=清除）')
    }
    const pricingIn = body['pricing']
    const pricing = pricingIn === null ? null : parsePricingInput(pricingIn)

    const channel = await this.prisma.providerChannel.findUnique({ where: { id: PLATFORM_CHANNEL_ID } })
    if (!channel) {
      throw new NotFoundException('平台渠道行不存在（应由 ensurePlatformChannel 播种）')
    }
    const { models, parseError } = parseModels(channel.models)
    if (parseError) {
      throw new ConflictException('平台渠道 models JSON 畸形，拒绝盲写（请先修复渠道行）')
    }
    const index = models.findIndex((m) => m !== null && typeof m === 'object' && m.name === name)
    if (index === -1) {
      throw new NotFoundException(`平台渠道模型不存在: ${name}`)
    }
    const before = models[index]!.pricing ?? null
    const entry: ChannelModelEntry = { ...models[index] }
    if (pricing === null) delete entry.pricing
    else entry.pricing = pricing
    const nextModels = models.slice()
    nextModels[index] = entry

    await this.prisma.$transaction(async (tx) => {
      await tx.providerChannel.update({
        where: { id: PLATFORM_CHANNEL_ID },
        data: { models: JSON.stringify(nextModels) },
      })
      await tx.adminAuditLog.create({
        data: {
          actor: ACTOR,
          action: pricing === null ? `${RESOURCE_PREFIX}.pricing.clear` : `${RESOURCE_PREFIX}.pricing.set`,
          resource: `${RESOURCE_PREFIX}:${name}`,
          before: before === null ? null : JSON.stringify(before),
          after: pricing === null ? null : JSON.stringify(pricing),
        },
      })
    })
    return { code: 0, message: 'ok', data: { entry, previousPricing: before } }
  }
}
