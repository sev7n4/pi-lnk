import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common'
import { PricingPublishingService, PublishEntryInput } from '../pricing/pricing-publishing.service'
import { AdminTokenGuard } from './admin-token.guard'

/**
 * P1-a T4：发布流 admin 端点（ops-console 消费，Task 8 前端接）。
 *
 * - 前缀 /api/admin/pricing/versions，逐路由挂 AdminTokenGuard（照 platform-channel 模式）。
 * - draft → diff → publish → rollback 单向流，业务语义全在 PricingPublishingService（Task 2）：
 *   publish/rollback 单事务原子切换，audit（pricing-version.publish / .rollback）由 service 落库。
 * - DTO 手校（照 platform-channel 既有模式）：version/note 非空字符串；entries 每项
 *   matchKey/capability 非空 + credits 正整数。
 */

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(`${field} 必须是非空字符串`)
  }
  return value
}

function parseDraftBody(body: Record<string, unknown>): { version: string; note: string } {
  return {
    version: requireNonEmptyString(body['version'], 'version'),
    note: requireNonEmptyString(body['note'], 'note'),
  }
}

function parseEntriesBody(body: Record<string, unknown>): PublishEntryInput[] {
  const raw = body['entries']
  if (!Array.isArray(raw)) {
    throw new BadRequestException('entries 必须是数组')
  }
  return raw.map((item, i) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new BadRequestException(`entries[${i}] 必须是对象`)
    }
    const e = item as Record<string, unknown>
    const matchKey = requireNonEmptyString(e['matchKey'], `entries[${i}].matchKey`)
    const capability = requireNonEmptyString(e['capability'], `entries[${i}].capability`)
    const credits = e['credits']
    if (typeof credits !== 'number' || !Number.isInteger(credits) || credits <= 0) {
      throw new BadRequestException(`entries[${i}].credits 必须是正整数，收到: ${String(credits)}`)
    }
    const entry: PublishEntryInput = { matchKey, capability, credits }
    if (e['basis'] !== undefined) {
      if (typeof e['basis'] !== 'string') throw new BadRequestException(`entries[${i}].basis 必须是字符串`)
      entry.basis = e['basis']
    }
    if (e['costRateId'] !== undefined) {
      if (e['costRateId'] !== null && typeof e['costRateId'] !== 'string') {
        throw new BadRequestException(`entries[${i}].costRateId 必须是字符串或 null`)
      }
      entry.costRateId = e['costRateId']
    }
    return entry
  })
}

@Controller('admin/pricing/versions')
export class PricingPublishingController {
  constructor(private readonly publishing: PricingPublishingService) {}

  @Get()
  @UseGuards(AdminTokenGuard)
  async list() {
    return { code: 0, message: 'ok', data: await this.publishing.listVersions() }
  }

  @Post('draft')
  @UseGuards(AdminTokenGuard)
  async createDraft(@Body() body: Record<string, unknown>) {
    const { version, note } = parseDraftBody(body)
    return { code: 0, message: 'ok', data: await this.publishing.createDraftFromActive(version, note) }
  }

  @Get(':id')
  @UseGuards(AdminTokenGuard)
  async show(@Param('id') id: string) {
    const draft = await this.publishing.getDraft(id)
    if (!draft) {
      throw new NotFoundException(`价目表版本不存在: ${id}`)
    }
    return { code: 0, message: 'ok', data: draft }
  }

  @Put(':id/entries')
  @UseGuards(AdminTokenGuard)
  async updateEntries(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    const entries = parseEntriesBody(body)
    const written = await this.publishing.upsertEntries(id, entries)
    return { code: 0, message: 'ok', data: { written } }
  }

  @Get(':id/diff')
  @UseGuards(AdminTokenGuard)
  async diff(@Param('id') id: string) {
    return { code: 0, message: 'ok', data: await this.publishing.diffSummary(id) }
  }

  @Post(':id/publish')
  @UseGuards(AdminTokenGuard)
  async publish(@Param('id') id: string) {
    return { code: 0, message: 'ok', data: await this.publishing.publish(id) }
  }

  @Post('rollback')
  @UseGuards(AdminTokenGuard)
  async rollback() {
    return { code: 0, message: 'ok', data: await this.publishing.rollback() }
  }
}
