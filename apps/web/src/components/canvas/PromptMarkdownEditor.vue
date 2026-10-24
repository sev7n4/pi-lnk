<script setup lang="ts">
import { watch, onMounted, onBeforeUnmount, shallowRef, ref, defineAsyncComponent, type Component } from 'vue'
import type { Editor, MarkdownStorage } from '@/components/canvas/tiptapSetup'
import './PromptMarkdownEditor.css'

const props = defineProps<{ visible: boolean; modelValue: string; title?: string }>()
const emit = defineEmits<{
  'update:visible': [boolean]
  'update:modelValue': [string]
  save: [string]
}>()

/**
 * tiptap 全家改为**按需加载**（2026-10-24 性能修复）。
 *
 * 之前在顶层静态 import ⇒ tiptap + prosemirror 进画布页主分包的同步依赖
 * （生产实测 295.6KB gzip，占全部依赖 77%），而编辑器只在双击节点时才打开。
 * 现在只有用户真的打开编辑器时才下载这段代码（之后走浏览器缓存）。
 *
 * ⚠️ `defineAsyncComponent` 保留 `<EditorContent>` 的模板用法不变 ——
 *    它就是一个渲染组件，异步挂载不影响 Editor 实例的读写时机。
 *
 * ⚠️ 加载中时 `editor.value` 为 undefined ⇒ 模板里的 `editor?.chain()` 全部
 *    走可选链（原有写法），不会抛错；`isActive()` 也已有 `?? false` 兜底。
 */
const EditorContent = defineAsyncComponent(async () => {
  const mod = await import('@/components/canvas/tiptapSetup')
  return mod.EditorContent as Component
})

const editor = shallowRef<Editor>()
/** tiptap 模块是否已加载（用于加载态提示，避免用户以为没反应）。 */
const tiptapLoading = ref(false)
/** tiptap 模块加载 Promise（并发调用只加载一次）。 */
let tiptapPromise: Promise<typeof import('@/components/canvas/tiptapSetup')> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 关闭意图的缓冲：模块未加载时用户就关了弹层 ⇒ 记下来，chunk 到位后补传。
 *
 * ⚠️ 这是「不丢用户内容」的关键：内层若从未见过 `visible: true → false`，
 *    就不会执行 flushSave ⇒ 编辑内容丢失。
 *
 * ⚠️ 声明必须在 ensureEditor **之前**：ensureEditor 里会读它，
 *    而 `let` 是块级作用域（提升但有 TDZ）—— 声明在后面会抛
 *    "Cannot access 'pendingSaveOnLoad' before initialization"。
 */
let pendingSaveOnLoad = false

function getMarkdown(): string {
  const storage = editor.value?.storage as { markdown?: MarkdownStorage } | undefined
  return storage?.markdown?.getMarkdown?.() ?? ''
}

function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  // ⛔ 编辑器实例还没建起来（tiptap 仍在加载）⇒ **绝不能把空串写回**：
  //    父组件的 v-model 会被置空 ⇒ 用户原有内容被清空（数据丢失）。
  //    异步化引入的新窗口：用户「刚打开就立刻关闭」，模块还没到。
  //    此时的正确行为是「什么都不做」—— 内容还没被编辑过，无需保存。
  if (!editor.value) return
  const md = getMarkdown()
  emit('update:modelValue', md)
  emit('save', md)
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushSave, 400)
}

/**
 * 确保 tiptap 已加载且编辑器实例已建立。
 *
 * ⛔ 关键不变式：**编辑器实例创建后，`visible` 的下降沿仍会触发 flushSave**。
 *    异步化只挪动了「模块何时到位」，没有改变「关闭时保存」这条语义 ——
 *    否则用户编辑的内容会静默丢失（绝不能接受的回归）。
 *
 * 实现：`ensureEditor()` 是 async，但 watch 回调里用 `.then()` 串起后续动作，
 * 保证「创建实例 → setContent → 聚焦」的顺序与同步版一致。
 */
async function ensureEditor(): Promise<void> {
  if (editor.value) return
  if (!tiptapPromise) {
    tiptapPromise = import('@/components/canvas/tiptapSetup')
  }
  tiptapLoading.value = true
  try {
    const mod = await tiptapPromise
    if (editor.value) return
    editor.value = mod.createPromptEditor({
      content: props.modelValue || '',
      onUpdate: () => scheduleSave(),
    })
    // 用户在模块加载期间就关闭了弹层 ⇒ 此刻补一次保存，
    // 否则「刚打开就输入再关闭」的内容会丢（异步化引入的新窗口）。
    if (pendingSaveOnLoad) {
      pendingSaveOnLoad = false
      flushSave()
    }
  } finally {
    tiptapLoading.value = false
  }
}

watch(
  () => props.visible,
  (v, wasVisible) => {
    if (v) {
      void ensureEditor().then(() => {
        if (!editor.value) return
        editor.value?.commands.setContent(props.modelValue || '')
        setTimeout(() => editor.value?.commands.focus('end'), 50)
      })
    } else {
      if (wasVisible) {
        // ⛔ 模块仍在加载 ⇒ 此时 flushSave 会因「空实例守卫」直接返回，
        //    而模块到位后没人再触发保存 ⇒ 用户内容丢失。
        //    ⇒ 先记下关闭意图，等模块到位后由 ensureEditor 补一次 flushSave。
        if (!editor.value && tiptapLoading.value) {
          pendingSaveOnLoad = true
        }
        flushSave()
      }
    }
  },
)

/**
 * 沉浸层内 Esc 只关编辑器，且必须阻止冒泡：
 * 画布 dock 也监听 window keydown 的 Esc（DockStudioToolbar.handleDockEscape），
 * 不 stopPropagation 会「关编辑器的同时把 dock 一起收掉」。
 * 用 capture 阶段抢在 dock 之前处理。
 */
function onKeydown(event: KeyboardEvent) {
  if (!props.visible) return
  if (event.key !== 'Escape') return
  event.stopPropagation()
  event.preventDefault()
  close()
}

/**
 * 关闭弹层。
 *
 * ⚠️ 若 tiptap 仍在加载（用户「刚打开就立刻关」），此时编辑器实例还不存在，
 *    但**模块加载完成后会继续创建实例并 setContent** ⇒ 必须在关闭前把
 *    「等模块到位后补一次保存」这件事记下来，否则用户刚输入的内容会丢。
 *
 * 这与 flushSave 的空实例守卫是一对：守卫防「没内容时清空」，
 * 这里防「有内容时没保存」。
 */
function close() {
  if (!editor.value && tiptapLoading.value) {
    // 模块还在路上 ⇒ 记住「到位后要保存一次」
    pendingSaveOnLoad = true
  }
  emit('update:visible', false)
}

function copyAll() {
  void navigator.clipboard.writeText(getMarkdown())
}


function isActive(name: string, attrs?: Record<string, unknown>) {
  return editor.value?.isActive(name, attrs) ?? false
}

onMounted(() => window.addEventListener('keydown', onKeydown, true))

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  if (saveTimer) clearTimeout(saveTimer)
  editor.value?.destroy()
  editor.value = undefined
})
</script>

<template>
  <Teleport to="body">
    <Transition name="prompt-md-fade">
      <div
        v-if="visible"
        class="prompt-md-overlay"
        role="dialog"
        aria-modal="true"
        :aria-label="title || '编辑内容'"
      >
        <div class="prompt-md-shell">
          <header class="prompt-md-topbar">
            <button type="button" class="prompt-md-back" title="返回画布 (Esc)" @click="close">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
              <span>返回</span>
            </button>

            <div class="prompt-md-heading">
              <span class="prompt-md-title">{{ title || '编辑内容' }}</span>
            </div>

            <div class="prompt-md-actions">
              <button type="button" class="btn-primary text-xs" @click="copyAll">复制</button>
              <button type="button" class="prompt-md-btn-secondary" @click="close">关闭</button>
            </div>
          </header>

          <div class="prompt-md-scroll">
            <div class="prompt-md-column">
              <!-- tiptap 按需加载中（2026-10-24 性能修复）：给一句提示，
                   否则用户双击后看到空白会以为没反应。
                   ⚠️ 用 Tailwind 语义类（text-fg-3）而不是新增 CSS：
                   本组件样式全在独立 PromptMarkdownEditor.css 里，
                   而 Tailwind 工具类是全局的，不会被该文件的作用域规则覆盖。 -->
              <p v-if="tiptapLoading" class="prompt-md-loading text-fg-3">编辑器加载中…</p>
              <EditorContent v-else :editor="editor" class="prompt-md-editor" />
            </div>
          </div>

          <div class="prompt-md-capsule">
            <div class="prompt-md-format-group">
              <button
                type="button"
                class="prompt-md-format-btn"
                :class="{ 'is-active': isActive('heading', { level: 1 }) }"
                title="标题 1"
                @click="editor?.chain().focus().toggleHeading({ level: 1 }).run()"
              >
                H1
              </button>
              <button
                type="button"
                class="prompt-md-format-btn"
                :class="{ 'is-active': isActive('heading', { level: 2 }) }"
                title="标题 2"
                @click="editor?.chain().focus().toggleHeading({ level: 2 }).run()"
              >
                H2
              </button>
              <button
                type="button"
                class="prompt-md-format-btn"
                :class="{ 'is-active': isActive('heading', { level: 3 }) }"
                title="标题 3"
                @click="editor?.chain().focus().toggleHeading({ level: 3 }).run()"
              >
                H3
              </button>
              <button
                type="button"
                class="prompt-md-format-btn"
                :class="{ 'is-active': isActive('bold') }"
                title="粗体"
                @click="editor?.chain().focus().toggleBold().run()"
              >
                B
              </button>
              <button
                type="button"
                class="prompt-md-format-btn"
                :class="{ 'is-active': isActive('italic') }"
                title="斜体"
                @click="editor?.chain().focus().toggleItalic().run()"
              >
                I
              </button>
              <button
                type="button"
                class="prompt-md-format-btn"
                :class="{ 'is-active': isActive('bulletList') }"
                title="无序列表"
                @click="editor?.chain().focus().toggleBulletList().run()"
              >
                •
              </button>
              <button
                type="button"
                class="prompt-md-format-btn"
                title="分隔线"
                @click="editor?.chain().focus().setHorizontalRule().run()"
              >
                —
              </button>
            </div>

            <span class="prompt-md-capsule-divider" aria-hidden="true" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
