import { resolveMobileNodeState } from '@/composables/mobileNodeState'

export type MobileNodeActionKey =
  | 'edit'
  | 'rename'
  | 'reference'
  | 'duplicate'
  | 'duplicate-upstream'
  | 'save-asset'
  | 'save-local'
  | 'multi-select'
  | 'delete'

/**
 * 二级（「更多」）承载的低频操作（规格 §4.11.3）。
 *
 * ⭐ 为什么分层：Apple HIG 明文「避免可滚动的 Action Sheet」且要求菜单
 *   「短而可扫读」⇒ 一级只放 ≤5 项高频项，低频项进二级「更多」。
 *   `rename` 也在二级 —— 它是**中频但低价值**的操作（用户极少主动改名），
 *   放一级会挤占高频项的位置。
 */
export const MOBILE_NODE_SECONDARY_ACTION_KEYS: readonly MobileNodeActionKey[] = [
  'rename',
  'duplicate-upstream',
  'save-asset',
  'save-local',
]

/**
 * Menu 上下文（规格 v1.5 §4.12.2 拍板项 O）：
 * `canvas` = 画布长按（全集）；`viewer` = 查看器内长按（剔除多选 / 重命名）。
 */
export type MobileNodeMenuContext = 'canvas' | 'viewer'

/**
 * 移动端长按 **Menu** 的可用操作集（规格 §5.1 总门控表 + §4.4 频率分层）。
 *
 * ⭐ 单一真源：Menu 的渲染与页面层的分发都消费这一个函数，不各写一遍
 *   （否则门控会漂移 —— 审阅焦点 #2）。
 *
 * 顺序即 UI 顺序：`edit` 置顶（高频主操作）→ 中频平铺 → `delete` 置底（破坏性）。
 */
export function resolveMobileNodeActions(
  node: {
    /** 仅作透传用（本函数不消费 id）⇒ 可选，与 `resolveMobileNodeState` 同风格 */
    id?: string
    type: string
    data?: Record<string, unknown> | null
  },
  context: MobileNodeMenuContext = 'canvas',
): MobileNodeActionKey[] {
  const state = resolveMobileNodeState({ type: node.type, data: node.data })
  // 有产物才允许「产物类」操作（副本 / 存库 / 本地）
  const hasContent = state === 'confirmed' || state === 'pending' || state === 'error'

  const keys: MobileNodeActionKey[] = ['edit']
  keys.push('rename')
  // ⭐ 「引用」按**状态分别**门控（规格 §6.4 两张裁剪集对「引用」的处置不同）：
  //   · empty：**保留**（§6.4「empty 裁剪集」明确含「引用」）
  //       —— 引用 = `handleAddToAgentRefs([nodeId])` ⇒ 把**提示词**带给 agent；
  //       模式① 的撰写本就发生在对话页（§4.2）⇒ 引用「只有提示词、无产物」的
  //       空节点，是把这段提示词交给 agent 的**正规路径**，裁掉会断掉协作闭环。
  //   · generating：**禁止**（§6.4「generating 受限集」明文「产物未定」）
  //   · pending / confirmed / error：**有**（全集）
  if (state !== 'generating') keys.push('reference')
  if (hasContent) {
    keys.push('duplicate', 'duplicate-upstream', 'save-asset', 'save-local')
  }
  keys.push('multi-select')
  // 生成中不删（中断一个已消耗积分的任务）—— 规格 §6.4 / 拍板项 B1
  if (state !== 'generating') keys.push('delete')
  // 规格 v1.5 §4.12.2（拍板项 O）：查看器是单节点全屏，无批量 / 画布态语义
  // ⇒ 剔除「多选」与「重命名」。同一套操作定义按上下文过滤，不新建第二套（G-19）。
  if (context === 'viewer') {
    return keys.filter((k) => k !== 'multi-select' && k !== 'rename')
  }
  return keys
}

/**
 * 一级 / 二级分层（规格 §4.11.3）：一级 ≤5 项，低频项进二级「更多」。
 *
 * ⭐ 两级并集恒等于全集（不丢操作）—— 门控与分层是**两个正交维度**：
 *   门控决定「能不能做」，分层决定「放第几层」。
 */
export function resolveMobileNodeMenuTiers(
  node: {
    id?: string
    type: string
    data?: Record<string, unknown> | null
  },
  context: MobileNodeMenuContext = 'canvas',
): { primary: MobileNodeActionKey[]; more: MobileNodeActionKey[] } {
  const all = resolveMobileNodeActions(node, context)
  const secondary = new Set<MobileNodeActionKey>(MOBILE_NODE_SECONDARY_ACTION_KEYS)
  let primary = all.filter((k) => !secondary.has(k))
  let more = all.filter((k) => secondary.has(k))

  // ⭐ 一级不足 5 项 ⇒ 把二级项**回填**到一级（iOS 原则：菜单按上下文裁剪，
  //   不为 1 个低频项单开一个二级）。回填项插在 `delete` **之前** ——
  //   破坏性必须保持末位（§4.11.4）。
  if (primary.length < 5 && more.length) {
    const backfill = more.slice(0, 5 - primary.length)
    more = more.slice(backfill.length)
    const insertAt = primary.indexOf('delete')
    if (insertAt >= 0) {
      primary = [...primary.slice(0, insertAt), ...backfill, ...primary.slice(insertAt)]
    } else {
      primary = [...primary, ...backfill]
    }
  }

  return { primary, more }
}

/**
 * 操作 key → 中文标签（规格 §4.11.7：动词短语，⛔ 不用「Yes / OK」）。
 *
 * ⚠️ `multi-select` **不**在此表 —— 它的文案随多选态变化（三态），
 *   由组件侧 `multiSelectLabel` 计算（既有行为，多选三态判据不可丢）。
 */
export const MOBILE_NODE_ACTION_LABELS: Record<Exclude<MobileNodeActionKey, 'multi-select'>, string> = {
  edit: '编辑提示词',
  rename: '重命名',
  reference: '引用到对话',
  duplicate: '创建副本',
  'duplicate-upstream': '创建副本（含上游）',
  'save-asset': '存入资产库',
  'save-local': '保存到本地',
  delete: '删除节点',
}

/** 破坏性操作（红色 + 置底 + 前置分隔线，§4.11.4） */
export const MOBILE_NODE_DESTRUCTIVE_ACTION_KEYS: readonly MobileNodeActionKey[] = ['delete']
