import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common'
import { IsArray, IsObject, IsOptional, IsString } from 'class-validator'
import type { ShareTurn } from '@lnkpi/shared'
import { AuthGuard } from '../auth/auth.guard'
import { ShareRateLimitGuard } from './share-rate-limit.guard'
import { ShareService } from './share.service'

/**
 * 分享创建入参。
 *
 * ⚠️ `turns` 刻意**不做嵌套校验**（不用 `@ValidateNested` + `@Type(() => Object)`）：
 * 全局管道是 `new ValidationPipe({ transform: true, whitelist: true })`
 * （apps/server/src/main.ts），whitelist 会剥掉「嵌套对象上无校验装饰器」的属性
 * ⇒ 每个 turn 的 id/role/createdAt/parts/contentText 全被清空
 * ⇒ 服务端渲染出的托管分享页只有空气泡 + 兜底时间（线上自 #723 起一直是空的，
 * 早期症状是 createdAt 丢失导致的「Invalid Date」）。
 *
 * 改用 `@IsObject({ each: true })`：不做嵌套校验 ⇒ 回合对象原样透传；
 * 结构合法性由 share.service 的 `assertShareTurns()` 兜底（非法即 400，绝不静默渲染空气泡）。
 */
export class CreateShareDto {
  @IsString()
  sessionId!: string

  @IsArray()
  @IsObject({ each: true })
  turns!: ShareTurn[]

  /** 分享页可见标题（对话·项目名称），前端拼好传入；缺省回退到 OG 推导标题。 */
  @IsOptional()
  @IsString()
  title?: string
}

@Controller('share')
export class ShareController {
  constructor(private readonly shareService: ShareService) {}

  @Post('conversation')
  @UseGuards(AuthGuard, ShareRateLimitGuard)
  async createConversation(
    @Req() req: { user: { sub: string } },
    @Body() dto: CreateShareDto,
  ) {
    const result = await this.shareService.createShare(dto.sessionId, dto.turns, dto.title)
    return { code: 0, message: 'ok', data: result }
  }

  @Get('conversation/:id')
  @UseGuards(AuthGuard)
  async getMeta(@Param('id') id: string) {
    const meta = await this.shareService.getShareMeta(id)
    if (!meta) return { code: 404, message: 'not found', data: null }
    return { code: 0, message: 'ok', data: meta }
  }
}
