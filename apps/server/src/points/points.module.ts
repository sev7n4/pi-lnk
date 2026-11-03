import { Module } from '@nestjs/common'
import { PointsService } from './points.service'
import { SessionEventBus } from './session-event-bus.service'

@Module({
  providers: [PointsService, SessionEventBus],
  exports: [PointsService, SessionEventBus],
})
export class PointsModule {}
