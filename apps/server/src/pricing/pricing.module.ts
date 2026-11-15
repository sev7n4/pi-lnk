import { Module } from '@nestjs/common'
import { PricingService } from './pricing.service'
import { PricingPublishingService } from './pricing-publishing.service'
import { PricingGrayReleaseService } from './pricing-gray-release.service'
import { PricingMaterializerService } from './pricing-materializer.service'
import { PricingController } from './pricing.controller'
import { PricingSubjectService } from './pricing-subject.service'
import { PricingAnnouncementService } from './pricing-announcement.service'
import { AnnouncementsController } from './announcements.controller'

@Module({
  controllers: [PricingController, AnnouncementsController], // P2 T8：公开活动价目端点（无 guard，公开只读）；announcements 用户端点（AuthGuard 逐路由）
  providers: [PricingService, PricingPublishingService, PricingGrayReleaseService, PricingMaterializerService, PricingSubjectService, PricingAnnouncementService],
  exports: [PricingService, PricingPublishingService, PricingGrayReleaseService, PricingMaterializerService, PricingSubjectService],
})
export class PricingModule {}
