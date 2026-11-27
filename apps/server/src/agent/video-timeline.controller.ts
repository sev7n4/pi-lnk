import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common'
import { ArrayMaxSize, IsArray, IsIn, IsNumber, IsObject, IsOptional, IsString } from 'class-validator'
import type { Request } from 'express'
import { AgentInternalGuard } from './agent-internal.guard'
import { AuthGuard } from '../auth/auth.guard'
import { VideoTimelineService } from './video-timeline.service'
import type { TimelineOp } from '@lnkpi/shared'

type AuthedRequest = Request & { user: { sub: string; phone: string } }

/**
 * P1.2 浏览器编辑端点 DTO。ops 用 @IsArray + @IsObject 保留数组内容不被 whitelist 剥掉；
 * 每个 op 的具体语义由共享 reducer（@lnkpi/shared applyTimelineOps）校验，不在 DTO 层深校验。
 * 不声明 userId 字段——全局 ValidationPipe whitelist 会剥离任何 body 注入的 userId。
 */
export class VideoTimelineEditDto {
  @IsString()
  sessionId!: string

  @IsString()
  nodeId!: string

  @IsArray()
  @ArrayMaxSize(200)
  @IsObject({ each: true })
  ops!: TimelineOp[]

  @IsOptional()
  @IsNumber()
  proposalEpoch?: number

  @IsOptional()
  @IsIn(['manual', 'agent'])
  source?: 'manual' | 'agent'
}

@Controller('agent/internal')
@UseGuards(AgentInternalGuard)
export class VideoTimelineController {
  constructor(private readonly service: VideoTimelineService) {}

  @Post('video-timeline/create')
  create(@Body() dto: { sessionId: string; userId: string; title: string; sourceNodeIds: string[] }) {
    return this.service.create(dto)
  }

  @Post('video-timeline/edit')
  edit(@Body() dto: { sessionId: string; userId: string; nodeId: string; ops: TimelineOp[]; save?: boolean }) {
    return this.service.edit(dto)
  }

  @Post('video-timeline/propose-render')
  proposeRender(@Body() dto: { sessionId: string; userId: string; nodeId: string }) {
    return this.service.edit({ ...dto, ops: [{ op: 'request_render' }] })
  }

  @Post('video-timeline/render')
  render(@Body() dto: { sessionId: string; userId: string; nodeId: string }) {
    return this.service.render(dto)
  }
}

@Controller('video-timeline')
export class VideoTimelineBrowserController {
  constructor(private readonly service: VideoTimelineService) {}

  /** P1.2：手工浮层编辑写回，与 agent 通道共用 service.edit()/共享 reducer/事务写治理。 */
  @Post('edit')
  @UseGuards(AuthGuard)
  edit(@Req() req: AuthedRequest, @Body() dto: VideoTimelineEditDto) {
    return this.service.edit({
      sessionId: dto.sessionId,
      userId: req.user.sub,
      nodeId: dto.nodeId,
      ops: dto.ops,
    })
  }

  @Post('propose-render')
  @UseGuards(AuthGuard)
  proposeRender(@Req() req: AuthedRequest, @Body() dto: { sessionId: string; nodeId: string }) {
    return this.service.edit({
      sessionId: dto.sessionId,
      userId: req.user.sub,
      nodeId: dto.nodeId,
      ops: [{ op: 'request_render' }],
    })
  }

  @Post('render')
  @UseGuards(AuthGuard)
  render(@Req() req: AuthedRequest, @Body() dto: { sessionId: string; nodeId: string }) {
    return this.service.render({ sessionId: dto.sessionId, userId: req.user.sub, nodeId: dto.nodeId })
  }
}
