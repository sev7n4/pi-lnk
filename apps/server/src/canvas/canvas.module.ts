import { Module } from '@nestjs/common'
import { PointsModule } from '../points/points.module'
import { PricingModule } from '../pricing/pricing.module'
import { ProviderModule } from '../provider/provider.module'
import { StudioModule } from '../studio/studio.module'
import { UploadModule } from '../upload/upload.module'
import { MediaProbeModule } from '../media/media-probe.module'
import { CanvasController } from './canvas.controller'
import { CanvasService } from './canvas.service'
import { MaterialService } from './material.service'

@Module({
  imports: [UploadModule, PointsModule, PricingModule, ProviderModule, MediaProbeModule, StudioModule],
  controllers: [CanvasController],
  providers: [CanvasService, MaterialService],
  exports: [CanvasService, MaterialService],
})
export class CanvasModule {}
