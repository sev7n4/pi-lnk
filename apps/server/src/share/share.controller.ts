import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common'
import { Type } from 'class-transformer'
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator'
import type { ShareTurn } from '@lnkpi/shared'
import { AuthGuard } from '../auth/auth.guard'
import { ShareRateLimitGuard } from './share-rate-limit.guard'
import { ShareService } from './share.service'

class CreateShareDto {
  @IsString()
  sessionId!: string

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => Object)
  turns!: ShareTurn[]

  /** 分享页可见标题（对话·项目名称），前端拼好传入；缺省回退到 OG 推导标题。 */
  // ⚠️ 必须挂 @IsOptional：class-validator 对无 @IsOptional 的 undefined 字段直接判失败
  //（回归教训：#732 加 title 漏挂导致老前端（无 title）POST 全量 400）。
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
