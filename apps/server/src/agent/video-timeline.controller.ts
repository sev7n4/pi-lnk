import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { AgentInternalGuard } from './agent-internal.guard'
import { AuthGuard } from '../auth/auth.guard'
import { VideoTimelineService } from './video-timeline.service'
import type { TimelineOp } from '@lnkpi/shared'

type AuthedRequest = Request & { user: { sub: string; phone: string } }

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
