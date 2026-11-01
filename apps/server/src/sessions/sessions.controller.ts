import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common'
import { ArrayMaxSize, IsArray, IsOptional, IsString } from 'class-validator'
import { AuthGuard } from '../auth/auth.guard'
import { SessionsService } from './sessions.service'

class CreateSessionDto {
  @IsOptional()
  @IsString()
  title?: string
}

class UpdateSessionDto {
  @IsOptional()
  @IsString()
  title?: string

  @IsOptional()
  canvasData?: unknown
}

/** P1-C C1a（规格 §3.1）：PATCH /sessions/:id/canvas 载荷——ops 数组，服务端白名单收敛。 */
class PatchCanvasDto {
  @IsArray()
  @ArrayMaxSize(200)
  ops!: unknown[]
}

class BatchDeleteSessionsDto {
  @IsArray()
  @IsString({ each: true })
  ids!: string[]
}

@Controller('sessions')
export class SessionsController {
  constructor(@Inject(SessionsService) private readonly sessionsService: SessionsService) {}

  @Post()
  @UseGuards(AuthGuard)
  async create(@Req() req: { user: { sub: string } }, @Body() dto: CreateSessionDto) {
    const data = await this.sessionsService.create(req.user.sub, dto.title)
    return { code: 0, message: 'ok', data }
  }

  @Get()
  @UseGuards(AuthGuard)
  async findAll(@Req() req: { user: { sub: string } }) {
    const data = await this.sessionsService.findAll(req.user.sub)
    return { code: 0, message: 'ok', data }
  }

  @Post('batch-delete')
  @UseGuards(AuthGuard)
  async removeMany(@Req() req: { user: { sub: string } }, @Body() dto: BatchDeleteSessionsDto) {
    const data = await this.sessionsService.removeMany(req.user.sub, dto.ids)
    return { code: 0, message: 'ok', data }
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const data = await this.sessionsService.findOne(id)
    return { code: 0, message: 'ok', data }
  }

  @Put(':id')
  @UseGuards(AuthGuard)
  async update(
    @Param('id') id: string,
    @Req() req: { user: { sub: string } },
    @Body() dto: UpdateSessionDto,
  ) {
    const data = await this.sessionsService.update(id, req.user.sub, dto)
    return { code: 0, message: 'ok', data }
  }

  /** P1-C C1a：ops 级画布写主通道（整份 PUT 进入弃用期打点观测）。 */
  @Patch(':id/canvas')
  @UseGuards(AuthGuard)
  async patchCanvas(
    @Param('id') id: string,
    @Req() req: { user: { sub: string } },
    @Body() dto: PatchCanvasDto,
  ) {
    const data = await this.sessionsService.patchCanvas(id, req.user.sub, dto.ops)
    return { code: 0, message: 'ok', data }
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  async remove(@Param('id') id: string, @Req() req: { user: { sub: string } }) {
    const data = await this.sessionsService.remove(id, req.user.sub)
    return { code: 0, message: 'ok', data }
  }

  @Post(':id/duplicate')
  @UseGuards(AuthGuard)
  async duplicate(@Param('id') id: string, @Req() req: { user: { sub: string } }) {
    const data = await this.sessionsService.duplicate(req.user.sub, id)
    return { code: 0, message: 'ok', data }
  }
}
