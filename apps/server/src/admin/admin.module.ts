import { Module } from '@nestjs/common'
import { AdminTokenGuard } from './admin-token.guard'
import { AuditLogsAdminController } from './audit-logs.controller'
import { ModelCatalogAdminController } from './model-catalog.controller'
import { ModelHealthAdminController } from './model-health.controller'
import { PlatformChannelAdminController } from './platform-channel.controller'
import { UpstreamProbeAdminController } from './upstream-probe-admin.controller'
import { UpstreamRoutesAdminController } from './upstream-routes.controller'

/**
 * S1-1 admin 模块：共享密钥（Bearer LNKPI_ADMIN_TOKEN）鉴权的运维端点。
 * PrismaModule 是 @Global，直接注入 PrismaService。
 * S2-1b：model-catalog 目录运营端点（GET/POST/PUT/DELETE，写操作审计 + bump catalogVersion）。
 * S2-2b：upstream-routes 路由运营端点（GET/PUT，写操作审计 + bump routesVersion）。
 * Ops Console：audit-logs 只读 + platform-channel 定价读/写（spec docs/superpowers/specs/2026-10-11-ops-console-design.md）。
 */
@Module({
  controllers: [
    AuditLogsAdminController,
    UpstreamProbeAdminController,
    ModelHealthAdminController,
    ModelCatalogAdminController,
    UpstreamRoutesAdminController,
    PlatformChannelAdminController,
  ],
  providers: [AdminTokenGuard],
})
export class AdminModule {}
