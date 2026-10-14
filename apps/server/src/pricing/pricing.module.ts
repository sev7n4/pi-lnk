import { Module } from '@nestjs/common'
import { PricingService } from './pricing.service'
import { PricingPublishingService } from './pricing-publishing.service'

@Module({
  providers: [PricingService, PricingPublishingService],
  exports: [PricingService, PricingPublishingService],
})
export class PricingModule {}
