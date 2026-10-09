import { Module } from '@nestjs/common'
import { AdminTokenGuard } from './admin-token.guard'
import { ModelHealthAdminController } from './model-health.controller'
import { UpstreamProbeAdminController } from './upstream-probe-admin.controller'

/**
 * S1-1 admin 模块：共享密钥（Bearer LNKPI_ADMIN_TOKEN）鉴权的运维端点。
 * PrismaModule 是 @Global，直接注入 PrismaService。
 */
@Module({
  controllers: [UpstreamProbeAdminController, ModelHealthAdminController],
  providers: [AdminTokenGuard],
})
export class AdminModule {}
