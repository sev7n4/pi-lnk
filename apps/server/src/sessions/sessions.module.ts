import { Module } from '@nestjs/common'
import { SessionsController } from './sessions.controller'
import { SessionsService } from './sessions.service'
import { CanvasNodeStatusService } from './sessions-canvas-node-status.service'

@Module({
  controllers: [SessionsController],
  providers: [SessionsService, CanvasNodeStatusService],
  exports: [SessionsService, CanvasNodeStatusService],
})
export class SessionsModule {}
