/**
 * 选中节点快捷工具的纯函数模型，web 本地、无框架依赖。
 * 2026-10-18 信息架构收敛（方案 A）：工具行从节点上沿浮层（SelectionActionBar，已退役）
 * 迁入 studio dock 顶部（DockStudioToolbar），随选中上下文唯一呈现。
 */

export interface SelectionToolDef {
  id: string
  /** 图标键名，由渲染层映射为 SVG */
  icon: string
  /** 完整名称：title / aria-label / tooltip 用 */
  title: string
  /** 按钮短文案（2026-09-24 用户要求图标+文字，尽量两字） */
  label: string
  disabled: boolean
  disabledReason?: string
  group: 'ai' | 'file'
}

/**
 * 快捷工具编排（config 驱动）：后续能力包把对应项的 disabled 翻为 false 即点亮。
 */
export function buildSelectionTools(opts: { hasUrl: boolean }): SelectionToolDef[] {
  return [
    { id: 'refine', icon: 'refine', title: '精修', label: '精修', disabled: false, group: 'ai' },
    // 一键抠图点击即执行（无二次确认），按钮自证免费（2026-09-25 积分标注原则）
    { id: 'matting', icon: 'matting', title: '抠图（免费）', label: '抠图', disabled: false, group: 'ai' },
    { id: 'outpaint', icon: 'outpaint', title: '扩图', label: '扩图', disabled: false, group: 'ai' },
    { id: 'crop', icon: 'crop', title: '裁剪', label: '裁剪', disabled: false, group: 'ai' },
    { id: 'inpaint', icon: 'inpaint', title: '局部重绘', label: '重绘', disabled: false, group: 'ai' },
    { id: 'element-edit', icon: 'element', title: '元素编辑', label: '元素编辑', disabled: false, group: 'ai' },
    { id: 'annotate', icon: 'annotate', title: '标注', label: '标注', disabled: false, group: 'ai' },
    { id: 'rotate', icon: 'rotate', title: '旋转/翻转', label: '旋转', disabled: true, disabledReason: '旋转/翻转将在后续能力包点亮', group: 'ai' },
    { id: 'download', icon: 'download', title: '下载图片', label: '下载', disabled: !opts.hasUrl, group: 'file' },
    { id: 'save-asset', icon: 'save-asset', title: '存入资产库', label: '存图', disabled: !opts.hasUrl, group: 'file' },
  ]
}
