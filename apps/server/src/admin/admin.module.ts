import { Module } from '@nestjs/common'
import { AdminTokenGuard } from './admin-token.guard'
import { ModelCatalogAdminController, ModelDefaultsAdminController } from './model-catalog.controller'
import { ModelHealthAdminController } from './model-health.controller'
import { ModelOpsAdminController } from './model-ops.controller'
import { UpstreamProbeAdminController } from './upstream-probe-admin.controller'
import { UpstreamRoutesAdminController } from './upstream-routes.controller'
import { AutomationAdminController } from './automation-admin.controller'
import { AutomationModule } from '../automation/automation.module'

/**
 * S1-1 admin 模块：共享密钥（Bearer LNKPI_ADMIN_TOKEN）鉴权的运维端点。
 * PrismaModule 是 @Global，直接注入 PrismaService。
 * S2-1b：model-catalog 目录运营端点（GET/POST/PUT/DELETE，写操作审计 + bump catalogVersion）。
 * S2-2b：upstream-routes 路由运营端点（GET/PUT，写操作审计 + bump routesVersion）。
 * C5 P0：automation 只读 + trigger 端点（scheduler 由 AutomationModule 提供）。
 * model-ops Task 1：model-defaults 切默认端点（PUT，X-Confirm 428 + 审计 + bump）。
 * model-ops Task 2：model-ops onboard/offboard 原子编排（dryRun 披露 + X-Confirm 执行态）。
 */
@Module({
  imports: [AutomationModule],
  controllers: [
    UpstreamProbeAdminController,
    ModelHealthAdminController,
    ModelCatalogAdminController,
    ModelDefaultsAdminController,
    ModelOpsAdminController,
    UpstreamRoutesAdminController,
    AutomationAdminController,
  ],
  providers: [AdminTokenGuard],
})
export class AdminModule {}
