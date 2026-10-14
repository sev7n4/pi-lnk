import { Module } from '@nestjs/common'
import { PricingService } from './pricing.service'
import { PricingPublishingService } from './pricing-publishing.service'
import { PricingGrayReleaseService } from './pricing-gray-release.service'

@Module({
  providers: [PricingService, PricingPublishingService, PricingGrayReleaseService],
  exports: [PricingService, PricingPublishingService, PricingGrayReleaseService],
})
export class PricingModule {}
