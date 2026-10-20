import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import { IsArray, IsString } from 'class-validator'
import { UsersService } from './users.service'
import { AuthGuard } from '../auth/auth.guard'

/**
 * 置顶作品请求体。⚠️ 本仓教训：全局 ValidationPipe 下 DTO 对象字段传字符串会
 * 直通（假阴性），所以数组必须写 `each: true` 逐项校验，不能省。
 */
export class PinnedWorksDto {
  @IsArray()
  @IsString({ each: true })
  workIds!: string[]
}

@Controller('users')
export class UsersController {
  constructor(@Inject(UsersService) private readonly usersService: UsersService) {}

  // 注意：`me/pinned-works` 必须声明在 `@Get(':id')` **之前** ——
  // 否则 'me' 会被 ':id' 吃掉（不同 method 也一样，Nest 按声明序匹配）。
  @Patch('me/pinned-works')
  @UseGuards(AuthGuard)
  async setPinnedWorks(@Req() req: { user: { sub: string } }, @Body() dto: PinnedWorksDto) {
    const data = await this.usersService.setPinnedWorks(req.user.sub, dto.workIds ?? [])
    return { code: 0, message: 'ok', data }
  }

  @Post(':id/follow')
  @UseGuards(AuthGuard)
  async follow(@Param('id') id: string, @Req() req: { user: { sub: string } }) {
    const data = await this.usersService.follow(req.user.sub, id)
    return { code: 0, message: 'ok', data }
  }

  @Delete(':id/follow')
  @UseGuards(AuthGuard)
  async unfollow(@Param('id') id: string, @Req() req: { user: { sub: string } }) {
    const data = await this.usersService.unfollow(req.user.sub, id)
    return { code: 0, message: 'ok', data }
  }

  @Get(':id/relation')
  @UseGuards(AuthGuard)
  async relation(@Param('id') id: string, @Req() req: { user: { sub: string } }) {
    const data = await this.usersService.relation(req.user.sub, id)
    return { code: 0, message: 'ok', data }
  }

  @Get(':id')
  async findCreator(@Param('id') id: string) {
    const data = await this.usersService.findCreator(id)
    return { code: 0, message: 'ok', data }
  }
}
