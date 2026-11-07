import type { CanvasAction, CanvasData } from '@lnkpi/shared'
import {
  applyCanvasActions as applyCanvasActionsCore,
  type ApplyCanvasActionsOpts,
} from '@lnkpi/shared'

export type { ApplyCanvasActionsOpts }

/**
 * Apply agent canvas mutations to an in-memory canvas snapshot.
 *
 * Phase 5 收敛：委托 `@lnkpi/shared` 的 `applyCanvasActions`（唯一 SSOT），
 * 与 web `applyActionsToFlow` 共用同一实现，杜绝「两套 switch 手动同步」漂移。
 * 历史 agent 专属的 `isTerminalRegen` 守卫、`set_groups` / `set_composition_run_group`
 * 侧车 op 现已内聚进共享 SSOT。签名/行为保持不变（服务端 DI seam 依赖）。
 */
export function applyCanvasActions(
  data: CanvasData,
  actions: CanvasAction[],
  opts?: ApplyCanvasActionsOpts,
): CanvasData {
  return applyCanvasActionsCore(data, actions, opts)
}
