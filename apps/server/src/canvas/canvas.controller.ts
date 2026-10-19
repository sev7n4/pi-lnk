import { Body, Controller, Get, Inject, Param, Post, Put, Req, UseGuards } from '@nestjs/common'
import { IsOptional, IsString } from 'class-validator'
import { AuthGuard } from '../auth/auth.guard'
import { createCancelFlag } from '../points/charge-session'
import { CanvasService } from './canvas.service'
import { MaterialService } from './material.service'

class CreateCanvasDto {
  @IsOptional()
  @IsString()
  title?: string
}

class UpdateCanvasDto {
  @IsString()
  id!: string

  @IsOptional()
  @IsString()
  title?: string

  @IsOptional()
  canvasData?: unknown
}

@Controller('agent/canvas')
export class CanvasController {
  constructor(
    @Inject(CanvasService) private readonly canvasService: CanvasService,
    @Inject(MaterialService) private readonly materialService: MaterialService,
  ) {}

  @Get('list')
  @UseGuards(AuthGuard)
  async list(@Req() req: { user: { sub: string } }) {
    const data = await this.canvasService.list(req.user.sub)
    return { code: 0, message: 'ok', data }
  }

  @Post('create')
  @UseGuards(AuthGuard)
  async create(@Req() req: { user: { sub: string } }, @Body() dto: CreateCanvasDto) {
    const data = await this.canvasService.create(req.user.sub, dto.title)
    return { code: 0, message: 'ok', data }
  }

  @Put('update')
  @UseGuards(AuthGuard)
  async update(@Req() req: { user: { sub: string } }, @Body() dto: UpdateCanvasDto) {
    const canvasData = dto.canvasData !== undefined
      ? JSON.stringify(dto.canvasData)
      : undefined
    const data = await this.canvasService.update(dto.id, req.user.sub, {
      title: dto.title,
      canvasData,
    })
    return { code: 0, message: 'ok', data }
  }

  @Post('material/:id/confirm-platform-fallback')
  @UseGuards(AuthGuard)
  async confirmMaterialPlatformFallback(
    @Req() req: { user: { sub: string }; on(event: string, cb: () => void): void; aborted?: boolean },
    @Param('id') id: string,
  ) {
    const cancel = createCancelFlag(req)
    const data = await this.materialService.confirmPlatformFallback(req.user.sub, id, cancel)
    return { code: 0, message: 'ok', data }
  }

  @Post('material/:id/cancel-platform-fallback')
  @UseGuards(AuthGuard)
  async cancelMaterialPlatformFallback(
    @Req() req: { user: { sub: string } },
    @Param('id') id: string,
  ) {
    const data = await this.materialService.cancelPlatformFallback(req.user.sub, id)
    return { code: 0, message: 'ok', data }
  }

  @Post('material/:id/cancel')
  @UseGuards(AuthGuard)
  async cancelMaterialGeneration(
    @Req() req: { user: { sub: string } },
    @Param('id') id: string,
  ) {
    const data = await this.materialService.cancelGeneration(req.user.sub, id)
    return { code: 0, message: 'ok', data }
  }

  @Get('material/:id/diagnostic')
  @UseGuards(AuthGuard)
  async materialDiagnostic(@Req() req: { user: { sub: string } }, @Param('id') id: string) {
    const data = await this.materialService.getMaterialDiagnostic(req.user.sub, id)
    return { data }
  }
}
