import type { InjectionKey, Ref } from 'vue'
import type { GroupDragDelta, GroupHandleDir } from './useCanvasGrouping'

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

/** 移动端长按节点 → 请求打开本端动作 sheet（2026-10-22 R1-T5）：与 PC 右键上下文菜单解耦。 */
export type MobileNodeActionRequestFn = (node: { id: string; type: string; data?: any }) => void
export const MOBILE_NODE_ACTION_REQUEST_KEY: InjectionKey<MobileNodeActionRequestFn> = Symbol(
  'mobileNodeActionRequest',
)

/**
 * 移动端 tap 节点 → 请求打开全屏查看器（图灯箱/视频播放/文本阅读器，R1-T4）：
 * 与长按动作 sheet 解耦。
 *
 * ⚠️ **D2 契约变更（2026-10-25 规格 §9 第 4 项）**：`type` **收窄为不含 `audio`** ——
 *   音频**永不进查看器**（磁贴内联播放，规格 §6.2 音频例外）；留着 `audio` 就是
 *   一个死分支（未来有人按契约调它必得空白屏）。
 *   ⇒ 配套运行时守卫 `isViewableNodeType`（见下）—— 类型收窄后，
 *   `NodeRenderer` 传来的 `props.type: string` 必须**先守卫再传**，否则 TS 不通过。
 */
export type MobileNodeViewableType = 'image' | 'video' | 'text'

/** 运行时守卫：只有这三种类型可进查看器（audio 被显式排除）。 */
export function isViewableNodeType(type: string): type is MobileNodeViewableType {
  return type === 'image' || type === 'video' || type === 'text'
}

export type MobileNodeOpenViewerFn = (node: {
  id?: string
  type: MobileNodeViewableType
  data?: any
}) => void
export const MOBILE_NODE_OPEN_VIEWER_KEY: InjectionKey<MobileNodeOpenViewerFn> = Symbol(
  'mobileNodeOpenViewer',
)

/**
 * 移动端 tap **空节点** → 请求打开编辑 sheet（R2-T2，2026-10-23 真机走查）。
 *
 * ⭐ 为什么需要它：真机走查发现「点空白节点会进入空白全屏」——
 *   `NodeRenderer.onTileOpen` 无条件开 viewer，而 viewer 的 img/video 均 `v-if="url"`
 *   ⇒ 空节点 tap 得到一片空白。
 *   修法：tap 意图由纯函数 `resolveMobileNodeTapIntent` 单一判定（viewer / editor / inline），
 *   空节点 → editor（编辑 sheet = 「点击生成/撰写」主动作，D-C 状态机的 empty 行）。
 */
export type MobileNodeOpenEditorFn = (node: {
  id?: string
  type: 'image' | 'video' | 'audio' | 'text'
  data?: any
}) => void
export const MOBILE_NODE_OPEN_EDITOR_KEY: InjectionKey<MobileNodeOpenEditorFn> = Symbol(
  'mobileNodeOpenEditor',
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

/**
 * 分组框 8 方向缩放（2026-10-21，与裁剪/扩图同源交互）。
 *
 * 组件侧只做两件事：把指针位移按 zoom 换算成画布坐标、调本回调把
 * (groupId, dir, delta) 交回页面。**delta 为 null = 本次拖拽已结束**，
 * 页面据此落库（拖拽过程中逐帧写库会把 undo 栈和 IO 冲垮）。
 *
 * ⛔ 组件不得直写 nodes —— nodes 是受控模式的唯一真值，只有页面能改。
 *
 * 之所以包一层 `Ref`：视口在运行时会变（窗口 resize / 移动端↔PC），
 * 「移动端不给缩放手柄」必须跟着变；provide 一个值就锁死在 setup 那一刻了。
 * 同 `CANVAS_NODE_LOCATE_FLASH_KEY` 的 Ref 注入形状。
 */
export type CanvasGroupResizeFn = (
  groupId: string,
  dir: GroupHandleDir,
  delta: GroupDragDelta | null,
) => void
export const CANVAS_GROUP_RESIZE_KEY: InjectionKey<Ref<CanvasGroupResizeFn | null>> =
  Symbol('canvasGroupResize')
