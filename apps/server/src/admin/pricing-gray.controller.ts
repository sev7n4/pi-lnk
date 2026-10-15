import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common'
import { PricingGrayReleaseService } from '../pricing/pricing-gray-release.service'
import { AdminTokenGuard } from './admin-token.guard'

/**
 * P1-a T5：白名单灰度发布 admin 端点（ops-console 消费，Task 8 前端接）。
 *
 * - 前缀 /api/admin/pricing/gray，逐路由挂 AdminTokenGuard（照 pricing-publishing 模式）。
 * - /preview 静态路由先于 /:id 参数路由注册；业务语义全在 PricingGrayReleaseService：
 *   createRelease $transaction（release+whitelist+audit）、空集假绿防线、惰性过期、
 *   promote（publishing.publish + promoted）、rollback（rolled_back）均由 service 落库。
 * - DTO 手校（照 platform-channel 既有模式）：versionId 非空；名单二选一
 *   （rawInput 粘贴文本或 phones 数组）；startsAt/endsAt 可选 ISO 时间串。
 */

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(`${field} 必须是非空字符串`)
  }
  return value
}

function optionalDate(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} 必须是 ISO 时间字符串`)
  }
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`${field} 不是合法时间: ${value}`)
  }
  return d
}

/** 名单二选一：rawInput（粘贴文本，任意分隔符）或 phones（字符串数组），token 切分/去重在 service。 */
function parsePhones(body: Record<string, unknown>): string[] {
  const rawInput = body['rawInput']
  const phones = body['phones']
  if (rawInput !== undefined) {
    if (typeof rawInput !== 'string' || rawInput.trim() === '') {
      throw new BadRequestException('rawInput 必须是非空字符串')
    }
    return [rawInput]
  }
  if (phones !== undefined) {
    if (!Array.isArray(phones) || phones.length === 0 || phones.some((p) => typeof p !== 'string')) {
      throw new BadRequestException('phones 必须是非空字符串数组')
    }
    return phones as string[]
  }
  throw new BadRequestException('缺少名单：需要 rawInput（粘贴文本）或 phones（字符串数组）')
}

function optionalNote(body: Record<string, unknown>): string | undefined {
  const note = body['note']
  if (note === undefined || note === null) return undefined
  if (typeof note !== 'string') {
    throw new BadRequestException('note 必须是字符串')
  }
  return note
}

@Controller('admin/pricing/gray')
export class PricingGrayController {
  constructor(private readonly gray: PricingGrayReleaseService) {}

  @Post('preview')
  @UseGuards(AdminTokenGuard)
  async preview(@Body() body: Record<string, unknown>) {
    const rawInput = requireNonEmptyString(body['rawInput'], 'rawInput')
    return { code: 0, message: 'ok', data: await this.gray.previewWhitelist(rawInput) }
  }

  @Post()
  @UseGuards(AdminTokenGuard)
  async create(@Body() body: Record<string, unknown>) {
    const versionId = requireNonEmptyString(body['versionId'], 'versionId')
    const phones = parsePhones(body)
    const note = optionalNote(body)
    const startsAt = optionalDate(body['startsAt'], 'startsAt')
    const endsAt = optionalDate(body['endsAt'], 'endsAt')
    return {
      code: 0,
      message: 'ok',
      data: await this.gray.createRelease({ versionId, phones, startsAt, endsAt, note }),
    }
  }

  @Get()
  @UseGuards(AdminTokenGuard)
  async list() {
    return { code: 0, message: 'ok', data: await this.gray.listReleases() }
  }

  @Get(':id/report')
  @UseGuards(AdminTokenGuard)
  async report(@Param('id') id: string) {
    return { code: 0, message: 'ok', data: await this.gray.getReport(id) }
  }

  @Post(':id/promote')
  @UseGuards(AdminTokenGuard)
  async promote(@Param('id') id: string) {
    return { code: 0, message: 'ok', data: await this.gray.promote(id) }
  }

  @Post(':id/rollback')
  @UseGuards(AdminTokenGuard)
  async rollback(@Param('id') id: string) {
    return { code: 0, message: 'ok', data: await this.gray.rollback(id) }
  }
}
