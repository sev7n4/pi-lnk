import type { InjectionKey, Ref } from 'vue'

export type CanvasNodeRenameFn = (nodeId: string, title: string) => void
export type CanvasNodePatchFn = (nodeId: string, patch: Record<string, unknown>) => void

export const CANVAS_NODE_RENAME_KEY: InjectionKey<CanvasNodeRenameFn> = Symbol('canvasNodeRename')
export const CANVAS_NODE_PATCH_KEY: InjectionKey<CanvasNodePatchFn> = Symbol('canvasNodePatch')

export type CanvasNodeCancelFn = (nodeId: string) => void
/**
 * S2-3 一键换模型重试：`overrides.modelKey` 可选（向后兼容——既有调用点零改动）。
 * ⛔ overrides 由提供方走页面级 patch（CANVAS_NODE_PATCH_KEY 同一落库通路），
 * 组件侧不得自行直写内部 store。
 */
export type CanvasNodeRetryOverrides = { modelKey?: string }
export type CanvasNodeRetryFn = (
  nodeId: string,
  overrides?: CanvasNodeRetryOverrides,
) => void | Promise<void>
export const CANVAS_NODE_CANCEL_KEY: InjectionKey<CanvasNodeCancelFn> = Symbol('canvasNodeCancel')
export const CANVAS_NODE_RETRY_KEY: InjectionKey<CanvasNodeRetryFn> = Symbol('canvasNodeRetry')

export const CANVAS_NODE_LOCATE_FLASH_KEY: InjectionKey<Ref<Set<string>>> = Symbol('canvasNodeLocateFlash')

export type CanvasNodeAddAgentFn = (nodeId: string) => void
export const CANVAS_NODE_ADD_AGENT_KEY: InjectionKey<CanvasNodeAddAgentFn> = Symbol('canvasNodeAddAgent')

export const CANVAS_REF_PICK_ACTIVE_KEY: InjectionKey<Ref<boolean>> = Symbol('canvasRefPickActive')
export const CANVAS_REF_PICK_NODE_IDS_KEY: InjectionKey<Ref<Set<string>>> = Symbol('canvasRefPickNodeIds')
export const CANVAS_REF_PICK_REJECT_KEY: InjectionKey<Ref<string | null>> = Symbol('canvasRefPickReject')
