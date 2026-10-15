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
import { CANVAS_ACTION_APPLIER, defaultCanvasActionApplier } from './canvas-action-applier'
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
  ],
  controllers: [AgentController, AgentCanvasToolsController],
  providers: [
    AgentService,
    AgentCanvasToolsService,
    AgentInternalGuard,
    WorkflowRecipeService,
    CompositionService,
    AgentMemoryService,
    // 生成失败回注（spec §6，PR3）：默认 flag off（GENERATION_RECOVERY_ENABLED），
    // off 时零派发；发射点在 AgentCanvasToolsService.waitVideoGeneration（两处
    // orchestrator 失败终态在此汇出，且本模块已 imports StudioModule，反向注入会成环）。
    GenerationRecoveryService,
    // ⚠️ 必须经 Symbol 端口绑定 AgentService：GenerationRecoveryService 直接 import
    // AgentService 类会与 agent.service → agent-canvas-tools → 本文件形成循环 import，
    // 编译产物 DI 拿到 undefined token（#398 部署事故，见 generation-recovery.service.ts 顶部注）。
    { provide: RECOVERY_AGENT_PORT, useExisting: AgentService },
    // 画布动作落地实现（归属待定的 seam）：换实现只改这一行，调用点零改动
    { provide: CANVAS_ACTION_APPLIER, useValue: defaultCanvasActionApplier },
  ],
  exports: [AgentService, AgentCanvasToolsService, AgentMemoryService],
})
export class AgentModule {}
