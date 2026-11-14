import { Module } from '@nestjs/common'
import { PricingService } from './pricing.service'
import { PricingPublishingService } from './pricing-publishing.service'
import { PricingGrayReleaseService } from './pricing-gray-release.service'
import { PricingMaterializerService } from './pricing-materializer.service'
import { PricingController } from './pricing.controller'
import { PricingSubjectService } from './pricing-subject.service'

@Module({
  controllers: [PricingController], // P2 T8：公开活动价目端点（无 guard，公开只读）
  providers: [PricingService, PricingPublishingService, PricingGrayReleaseService, PricingMaterializerService, PricingSubjectService],
  exports: [PricingService, PricingPublishingService, PricingGrayReleaseService, PricingMaterializerService, PricingSubjectService],
})
export class PricingModule {}
