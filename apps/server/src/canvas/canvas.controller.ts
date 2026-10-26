import { Body, Controller, Get, Inject, Optional, Param, Post, Put, Req, UseGuards } from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'
import { ArrayMaxSize, IsArray, IsOptional, IsString, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'
import { AuthGuard } from '../auth/auth.guard'
import { createCancelFlag } from '../points/charge-session'
import { AgentCanvasToolsService } from '../agent/agent-canvas-tools.service'
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

class ConnectEdgeDto {
  @IsString()
  source!: string

  @IsString()
  target!: string
}

class ConnectNodesDto {
  @IsString()
  sessionId!: string

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ConnectEdgeDto)
  edges!: ConnectEdgeDto[]
}

@Controller('agent/canvas')
export class CanvasController {
  constructor(
    @Inject(CanvasService) private readonly canvasService: CanvasService,
    @Inject(MaterialService) private readonly materialService: MaterialService,
    @Optional() @Inject(ModuleRef) private readonly moduleRef?: ModuleRef,
  ) {}

  /**
   * SP-D（ADR-0014）：浏览器侧连线走与 agent 同一 connectNodes 校验通道。
   * AgentModule 反向依赖 CanvasModule（agent.module imports CanvasModule），
   * 构造器直接注入会成模块环 ⇒ 按本仓先例用 ModuleRef 惰性 get（strict:false 全局解析）。
   */
  private agentCanvasTools(): AgentCanvasToolsService {
    if (!this.moduleRef) throw new Error('ModuleRef unavailable for AgentCanvasToolsService')
    return this.moduleRef.get(AgentCanvasToolsService, { strict: false })
  }

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

  /** SP-D（ADR-0014）：用户手拉边统一收口到服务端校验通道（与 agent connect_nodes 同一服务方法）。 */
  @Post('connect-nodes')
  @UseGuards(AuthGuard)
  async connectNodes(@Req() req: { user: { sub: string } }, @Body() dto: ConnectNodesDto) {
    // 属主校验（与 update 同口径）：防跨用户写他人画布
    await this.canvasService.assertSessionOwned(dto.sessionId, req.user.sub)
    const data = await this.agentCanvasTools().connectNodes({
      sessionId: dto.sessionId,
      edges: dto.edges,
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
