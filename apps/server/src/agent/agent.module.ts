import { Module } from '@nestjs/common'
import { AssetsModule } from '../assets/assets.module'
import { CanvasModule } from '../canvas/canvas.module'
import { ProviderModule } from '../provider/provider.module'
import { SessionsModule } from '../sessions/sessions.module'
import { StudioModule } from '../studio/studio.module'
import { AgentCanvasToolsController } from './agent-canvas-tools.controller'
import { AgentCanvasToolsService } from './agent-canvas-tools.service'
import { CANVAS_ACTION_APPLIER, defaultCanvasActionApplier } from './canvas-action-applier'
import { AgentController } from './agent.controller'
import { AgentInternalGuard } from './agent-internal.guard'
import { AgentService } from './agent.service'
import { CompositionService } from './composition.service'
import { WorkflowRecipeService } from './workflow-recipe.service'

@Module({
  imports: [CanvasModule, ProviderModule, SessionsModule, StudioModule, AssetsModule],
  controllers: [AgentController, AgentCanvasToolsController],
  providers: [
    AgentService,
    AgentCanvasToolsService,
    AgentInternalGuard,
    WorkflowRecipeService,
    CompositionService,
    // 画布动作落地实现（归属待定的 seam）：换实现只改这一行，调用点零改动
    { provide: CANVAS_ACTION_APPLIER, useValue: defaultCanvasActionApplier },
  ],
  exports: [AgentService, AgentCanvasToolsService],
})
export class AgentModule {}
