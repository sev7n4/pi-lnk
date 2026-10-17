import { Module } from '@nestjs/common'
import { AssetsModule } from './assets/assets.module'
import { AdminModule } from './admin/admin.module'
import { AuthModule } from './auth/auth.module'
import { AutomationModule } from './automation/automation.module'
import { SessionsModule } from './sessions/sessions.module'
import { WorksModule } from './works/works.module'
import { AgentModule } from './agent/agent.module'
import { CanvasModule } from './canvas/canvas.module'
import { MembershipModule } from './membership/membership.module'
import { PaymentModule } from './payment/payment.module'
import { PrismaModule } from './prisma/prisma.module'
import { StoriesModule } from './stories/stories.module'
import { StudioModule } from './studio/studio.module'
import { UploadModule } from './upload/upload.module'
import { UsersModule } from './users/users.module'
import { HealthModule } from './health/health.module'
import { ProviderModule } from './provider/provider.module'
import { MediaModule } from './media/media.module'
import { StorageModule } from './storage/storage.module'

@Module({
  imports: [
    PrismaModule,
    StorageModule,
    AssetsModule,
    AuthModule,
    SessionsModule,
    WorksModule,
    AgentModule,
    CanvasModule,
    UsersModule,
    MembershipModule,
    PaymentModule,
    StudioModule,
    StoriesModule,
    UploadModule,
    HealthModule,
    ProviderModule,
    // C5 Automations：统一调度器（probe/reaper handler 注册方，AdminModule 端点依赖）
    AutomationModule,
    AdminModule,
    MediaModule,
  ],
})
export class AppModule {}
