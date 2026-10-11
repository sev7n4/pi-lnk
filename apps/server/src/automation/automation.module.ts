import { Module } from '@nestjs/common'
import { AutomationSchedulerService } from './automation-scheduler.service'

/**
 * C5 Automations：调度器单例。handler 由业务模块（Provider/Studio）在各自 onModuleInit 注册；
 * 配置（开关/间隔/参数）与运行史在 DB（AutomationJob/AutomationRun）。
 */
@Module({
  providers: [AutomationSchedulerService],
  exports: [AutomationSchedulerService],
})
export class AutomationModule {}
