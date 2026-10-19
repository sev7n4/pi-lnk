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

/** PR1：诊断抽屉「让 Agent 诊断」——预填 composer（不自动发送，等用户显式点发送表达意图）。 */
export type CanvasNodeAgentDiagnoseFn = (info: {
  nodeId: string
  title: string
  userMessage: string
  errorCode?: string
}) => void
export const CANVAS_AGENT_DIAGNOSE_KEY: InjectionKey<CanvasNodeAgentDiagnoseFn> = Symbol('canvasAgentDiagnose')

export type CanvasNodeAddAgentFn = (nodeId: string) => void
export const CANVAS_NODE_ADD_AGENT_KEY: InjectionKey<CanvasNodeAddAgentFn> = Symbol('canvasNodeAddAgent')

/** 长按节点 → 打开上下文菜单（2026-10-19 D-6）：移动端长按手势与 PC 右键共用一个入口。 */
export type CanvasNodeOpenContextMenuFn = (nodeId: string) => void
export const CANVAS_NODE_OPEN_CONTEXT_MENU_KEY: InjectionKey<CanvasNodeOpenContextMenuFn> = Symbol(
  'canvasNodeOpenContextMenu',
)

/**
 * 长按后抑制紧随的合成 click（2026-10-19 D-6）：touchend preventDefault 在个别
 * WebKit 版本不总抑制 click，节点组件与页面级 @node-click 经此对象双保险。
 * markSuppressed 记一个 350ms 短窗；窗口外的 click 一律放行。
 */
export interface CanvasNodeClickGuard {
  markSuppressed: () => void
  shouldSuppress: () => boolean
}
export const CANVAS_NODE_CLICK_GUARD_KEY: InjectionKey<CanvasNodeClickGuard> = Symbol(
  'canvasNodeClickGuard',
)

/** 移动端多选模式激活态（D-4）：节点组件据此渲染勾选徽标。 */
export const CANVAS_MULTI_SELECT_ACTIVE_KEY: InjectionKey<Ref<boolean>> = Symbol(
  'canvasMultiSelectActive',
)

/**
 * 重命名请求（D-6）：页面级（长按 sheet「重命名」）置 nodeId，节点组件监听并
 * 打开行内重命名输入（与 PC dblclick 同一个输入框）；节点消费后自行清 null。
 * 不直接调 renameNode —— 那是「提交」，这里要的是「打开输入态」。
 */
export const CANVAS_NODE_RENAME_REQUEST_KEY: InjectionKey<Ref<string | null>> = Symbol(
  'canvasNodeRenameRequest',
)

export const CANVAS_REF_PICK_ACTIVE_KEY: InjectionKey<Ref<boolean>> = Symbol('canvasRefPickActive')
export const CANVAS_REF_PICK_NODE_IDS_KEY: InjectionKey<Ref<Set<string>>> = Symbol('canvasRefPickNodeIds')
export const CANVAS_REF_PICK_REJECT_KEY: InjectionKey<Ref<string | null>> = Symbol('canvasRefPickReject')
