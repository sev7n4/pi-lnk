import { Module } from '@nestjs/common'
import { ShareController } from './share.controller'
import { ShareRateLimitGuard } from './share-rate-limit.guard'
import { ShareService } from './share.service'

// PrismaModule 是 @Global，PrismaService 可直接注入，无需在此 imports。
// 不引入 @nestjs/schedule / @nestjs/throttler：TTL 用 setInterval、限频用自研内存守卫。
@Module({
  controllers: [ShareController],
  providers: [ShareService, ShareRateLimitGuard],
})
export class ShareModule {}
