import type { CanvasAction } from '@lnkpi/shared'
import type { GenerationRecoveryService } from './generation-recovery.service'

/**
 * waitVideoGeneration 失败终态发射辅助（PR3 Task4）。
 *
 * 为什么发射点在这里而不是 orchestrator 构造注入（对计划的两处实质偏差）：
 * 1. AgentModule 已 imports StudioModule，StudioModule 反向 import AgentModule 会成环；
 *    GenerationRecoveryService 需要 AgentService（AgentModule 本地），只能住 AgentModule。
 * 2. `AgentCanvasToolsService.waitVideoGeneration` 是 orchestrator.wait 的生产唯一调用漏斗，
 *    两处失败终态（poll terminal failed/error、catch persist 抛错）都以 `status === 'error'`
 *    汇出 ⇒ 在此判定与在 orchestrator 两分支内逐一发射**等价覆盖**，且天然幂等单点。
 *
 * 范围外（与计划一致，显式排除而非静默遗漏）：
 * - `status === 'timeout'`（poll 墙钟超时）与 `fallback_pending` 不发射；
 * - reaper 标记的 failed（GenerationReaperService，无 canvas session scope）不经过本漏斗。
 *
 * fail-open：任何路径都不得向调用方抛错（回注是旁路观察者，节点 error 态已先落成）。
 */
export function emitGenerationFailure(
  recovery: GenerationRecoveryService | undefined | null,
  input: { sessionId: string; userId: string; nodeId: string; generationRecordId: string },
  result: { status: string; actions?: CanvasAction[] },
): void {
  if (!recovery || result.status !== 'error') return
  const errorMessage = result.actions
    ?.map((a) => (a.type === 'update_node' ? (a.payload as { data?: { errorMessage?: unknown } }).data : undefined))
    .map((data) => (typeof data?.errorMessage === 'string' ? data.errorMessage : undefined))
    .find((m) => m)
  void recovery
    .handleGenerationFailed({
      sessionId: input.sessionId,
      userId: input.userId,
      nodeId: input.nodeId,
      generationRecordId: input.generationRecordId,
      // poll 终态与 catch 都不带结构化 errorCode：detail 用人类可读 errorMessage
      userMessage: errorMessage || '视频生成失败',
    })
    .catch(() => undefined)
}
