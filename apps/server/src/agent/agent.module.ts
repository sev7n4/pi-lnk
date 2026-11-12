import { Module } from '@nestjs/common'
import { AssetsModule } from '../assets/assets.module'
import { CanvasModule } from '../canvas/canvas.module'
import { ProviderModule } from '../provider/provider.module'
import { SessionsModule } from '../sessions/sessions.module'
import { StudioModule } from '../studio/studio.module'
import { PointsModule } from '../points/points.module'
import { PricingModule } from '../pricing/pricing.module'
import { AgentCanvasToolsController } from './agent-canvas-tools.controller'
import { AgentCanvasToolsService } from './agent-canvas-tools.service'
import { CanvasDigestService } from './canvas-digest.service'
import { PrismaService } from '../prisma/prisma.service'
import { CANVAS_ACTION_APPLIER, defaultCanvasActionApplier } from './canvas-action-applier'
import { DeliveryMetricsController } from './delivery-metrics.controller'
import { AgentController } from './agent.controller'
import { AgentInternalGuard } from './agent-internal.guard'
import { AgentService } from './agent.service'
import { CompositionService } from './composition.service'
import { WorkflowRecipeService } from './workflow-recipe.service'
import { AgentMemoryService } from './agent-memory.service'
import {
  GenerationRecoveryService,
  RECOVERY_AGENT_PORT,
} from './generation-recovery/generation-recovery.service'
import {
  AUTO_RESUME_AGENT_PORT,
  TurnAutoResumeService,
} from './turn-auto-resume/turn-auto-resume.service'
import { TurnStateService } from './turn-state.service'
import { PendingInterruptionService } from './pending-interruption.service'
import { SubagentTaskService } from './subagent-task.service'
import { AutomationModule } from '../automation/automation.module'

@Module({
  imports: [
    CanvasModule,
    ProviderModule,
    SessionsModule,
    StudioModule,
    AssetsModule,
    // P2 T6（token 精确计费）：回合预扣/结算依赖（AgentService 构造 @Optional 注入）
    PointsModule,
    PricingModule,
    // P2 待确认门 durable：过期扫描挂既有统一调度器（不新起 timer，G1 纪律）。
    AutomationModule,
  ],
  controllers: [AgentController, AgentCanvasToolsController, DeliveryMetricsController],
  providers: [
    AgentService,
    // P2：gate 表权威层 + 1min 过期扫描 handler（onModuleInit 注册到 AutomationScheduler）
    PendingInterruptionService,
    // D2：子代理一等任务单据 + 1min 租约扫描 handler（onModuleInit 注册到 AutomationScheduler）
    SubagentTaskService,
    AgentCanvasToolsService,
    AgentInternalGuard,
    WorkflowRecipeService,
    CompositionService,
    AgentMemoryService,
    // 回合连续性（2026-10-21 修正）：「上一轮任务进行到哪」的权威副本存储
    // （AgentThread.turnState）。@Optional 注入 ⇒ 未装配时降级为「不记录」，对话照常。
    TurnStateService,
    // 生成失败回注（spec §6，PR3）：默认 flag off（GENERATION_RECOVERY_ENABLED），
    // off 时零派发；发射点在 AgentCanvasToolsService.waitVideoGeneration（两处
    // orchestrator 失败终态在此汇出，且本模块已 imports StudioModule，反向注入会成环）。
    GenerationRecoveryService,
    // ⚠️ 必须经 Symbol 端口绑定 AgentService：GenerationRecoveryService 直接 import
    // AgentService 类会与 agent.service → agent-canvas-tools → 本文件形成循环 import，
    // 编译产物 DI 拿到 undefined token（#398 部署事故，见 generation-recovery.service.ts 顶部注）。
    { provide: RECOVERY_AGENT_PORT, useExisting: AgentService },
    // 批次 3.2（对话轮次自动续跑）：默认 flag off（TURN_AUTO_RESUME_ENABLED），
    // off 时零派发（行为与今天逐字节一致，回滚 = 环境变量一行）。
    TurnAutoResumeService,
    // ⚠️ 同样必须经 Symbol 端口绑定 AgentService：直接注入会成 Nest 实例化环
    // （AgentService → TurnAutoResumeService → port → AgentService）⇒ 进程静默 exit 0。
    { provide: AUTO_RESUME_AGENT_PORT, useExisting: AgentService },
    // 画布动作落地实现（归属待定的 seam）：换实现只改这一行，调用点零改动
    { provide: CANVAS_ACTION_APPLIER, useValue: defaultCanvasActionApplier },
    // Canvas Digest（spec 2026-11-05-canvas-digest-design）：回合末「画布总览」管道。
    // 构造器参数是结构化端口（便于轻量单测），DI 走 useFactory 绑定真依赖；
    // AgentService 侧 @Optional 注入（缺省 = flag off 等价，既有测试零破坏）。
    {
      provide: CanvasDigestService,
      useFactory: (prisma: PrismaService, tools: AgentCanvasToolsService) =>
        new CanvasDigestService(prisma, tools),
      inject: [PrismaService, AgentCanvasToolsService],
    },
  ],
  exports: [AgentService, AgentCanvasToolsService, AgentMemoryService],
})
export class AgentModule {}
