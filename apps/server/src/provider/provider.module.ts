import { Module } from '@nestjs/common'
import { CryptoService } from './crypto.service'
import { ModelCatalogSeedService } from './model-catalog-store'
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
    // S2-1a 模型目录播种接线（onModuleInit 非阻塞播种 ModelCatalogEntry + 装载缓存）
    ModelCatalogSeedService,
  ],
  exports: [CryptoService, ProviderService, ProviderResolverService],
})
export class ProviderModule {}
