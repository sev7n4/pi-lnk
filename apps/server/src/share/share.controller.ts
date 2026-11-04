import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common'
import { Type } from 'class-transformer'
import { IsArray, IsString, ValidateNested } from 'class-validator'
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
    const result = await this.shareService.createShare(dto.sessionId, dto.turns)
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
