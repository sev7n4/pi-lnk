/**
 * tiptap 富文本编辑器的**动态装载口**（2026-10-24 性能修复）。
 *
 * ## 为什么单独成文件
 *
 * tiptap 全家（`@tiptap/vue-3` + starter-kit + 5 个扩展 + `tiptap-markdown`）
 * 连同 prosemirror 内核，是本仓最重的第三方依赖之一。生产实测：
 * 画布页的 18 个同步依赖里，`CanvasNodeText.*.js` 单独占 **295.6KB(gzip)**，
 * 占全部依赖的 77% —— 而它承载的编辑器**只在用户双击节点时才打开**。
 *
 * 之前这些 import 写在 `PromptMarkdownEditor.vue` 顶层 ⇒ tiptap 必然进
 * 画布页主分包的同步依赖 ⇒ 每个进画布的用户都要为它付一次下载，
 * 在 ~300KB/s 出网带宽上 ≈ 白等 1 秒。
 *
 * ## 本文件的机制
 *
 * Vite 只在**动态 import**（`import()`）时把模块切到独立 chunk。
 * 把 tiptap 的 import 全部搬到这里，再由 `PromptMarkdownEditor.vue`
 * 用 `await import('./tiptapSetup')` 加载 ⇒
 *
 * - tiptap 家族不再出现在画布页主分包的静态依赖里；
 * - 只在编辑器**首次打开**时下载并缓存（之后走浏览器 HTTP 缓存）。
 *
 * ⚠️ 必须在**函数体内**动态 import（不能提到模块顶层）——
 *    顶层 import 会被 Vite 当作静态依赖拉回主分包。
 *
 * ## 类型导出
 *
 * `Editor` / `MarkdownStorage` 是**纯类型**，用 `export type` 导出 ——
 * 类型在编译期被擦除，不产生任何运行时代码，也不影响 chunk 切分。
 */

import { Editor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Typography from '@tiptap/extension-typography'
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import { Markdown } from 'tiptap-markdown'
import type { MarkdownStorage } from 'tiptap-markdown'

/** tiptap 编辑器实例类型（类型导出，编译期擦除）。 */
export type { Editor, MarkdownStorage }

/** tiptap 的渲染组件（EditorContent）——由调用方以 `<component :is>` 挂载。 */
export { EditorContent }

/**
 * 创建提示词编辑器实例。
 *
 * 抽出成函数是为了让 `ensureEditor()` 保持同步签名：
 * 调用方 await 完模块加载后再调它，不需要在业务代码里处理「模块还没到」的分支。
 */
export function createPromptEditor(options: {
  content: string
  onUpdate: () => void
}): Editor {
  return new Editor({
    extensions: [
      StarterKit,
      Typography,
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({ placeholder: '输入或生成提示词内容...' }),
      Markdown.configure({ html: false, transformPastedText: true, transformCopiedText: true }),
    ],
    content: options.content,
    onUpdate: options.onUpdate,
  })
}
