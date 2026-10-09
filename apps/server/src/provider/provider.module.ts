import { Module } from '@nestjs/common'
import { CryptoService } from './crypto.service'
import { ModelHealthSummaryController } from './model-health-summary.controller'
import { ProviderController } from './provider.controller'
import { ProviderResolverService } from './provider-resolver.service'
import { ProviderService } from './provider.service'
import { UpstreamProbeService } from './upstream-probe.service'
import { WebdavService } from './webdav.service'

@Module({
  controllers: [ProviderController, ModelHealthSummaryController],
  providers: [
    CryptoService,
    ProviderService,
    ProviderResolverService,
    WebdavService,
    // S1-1 定时探活对账器（onModuleInit 注册 interval；env=0 禁用）
    UpstreamProbeService,
  ],
  exports: [CryptoService, ProviderService, ProviderResolverService],
})
export class ProviderModule {}
