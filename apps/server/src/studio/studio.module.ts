import { Module } from '@nestjs/common'
import { AutomationModule } from '../automation/automation.module'
import { MediaProbeModule } from '../media/media-probe.module'
import { PointsModule } from '../points/points.module'
import { PricingModule } from '../pricing/pricing.module'
import { PrismaModule } from '../prisma/prisma.module'
import { ProviderModule } from '../provider/provider.module'
import { SessionsModule } from '../sessions/sessions.module'
import { UploadModule } from '../upload/upload.module'
import { ImageSliceService } from './image-slice.service'
import { GenerationReaperService } from './generation-reaper.service'
import { StudioController } from './studio.controller'
import { StudioService } from './studio.service'
import { VideoGenerationOrchestrator } from './video-generation.orchestrator'

@Module({
  imports: [
    AutomationModule,
    MediaProbeModule,
    PointsModule,
    PricingModule,
    ProviderModule,
    PrismaModule,
    SessionsModule,
    UploadModule,
  ],
  controllers: [StudioController],
  providers: [StudioService, VideoGenerationOrchestrator, ImageSliceService, GenerationReaperService],
  // GenerationReaperService 导出（2026-11-02 P0-A）：AgentService 经 @Optional 构造器
  // 注入并注册回合外投影钩子（AgentModule imports 本模块 ⇒ 无环）。
  exports: [StudioService, VideoGenerationOrchestrator, ImageSliceService, GenerationReaperService],
})
export class StudioModule {}
