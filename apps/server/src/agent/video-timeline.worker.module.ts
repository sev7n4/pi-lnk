import { Module } from '@nestjs/common'
import { MediaModule } from '../media/media.module'
import { AssetsModule } from '../assets/assets.module'
import { VideoTimelineWorkerService } from './video-timeline.worker'

@Module({
  imports: [MediaModule, AssetsModule],
  providers: [VideoTimelineWorkerService],
})
export class VideoTimelineWorkerModule {}
