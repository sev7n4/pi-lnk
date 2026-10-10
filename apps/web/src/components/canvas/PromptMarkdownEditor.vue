<script setup lang="ts">
import { watch, onMounted, onBeforeUnmount, shallowRef } from 'vue'
import { EditorContent, Editor } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Typography from '@tiptap/extension-typography'
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import { Markdown } from 'tiptap-markdown'
import type { MarkdownStorage } from 'tiptap-markdown'
import { useSpeechRecognition } from '@/composables/useSpeechRecognition'
import './PromptMarkdownEditor.css'

const props = defineProps<{ visible: boolean; modelValue: string; title?: string }>()
const emit = defineEmits<{
  'update:visible': [boolean]
  'update:modelValue': [string]
  save: [string]
}>()

const speech = useSpeechRecognition()
const editor = shallowRef<Editor>()
let saveTimer: ReturnType<typeof setTimeout> | null = null

function getMarkdown(): string {
  const storage = editor.value?.storage as { markdown?: MarkdownStorage } | undefined
  return storage?.markdown?.getMarkdown?.() ?? ''
}

function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const md = getMarkdown()
  emit('update:modelValue', md)
  emit('save', md)
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushSave, 400)
}

function ensureEditor() {
  if (editor.value) return
  editor.value = new Editor({
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
    content: props.modelValue || '',
    onUpdate: () => scheduleSave(),
  })
}

watch(
  () => props.visible,
  (v, wasVisible) => {
    if (v) {
      ensureEditor()
      editor.value?.commands.setContent(props.modelValue || '')
      setTimeout(() => editor.value?.commands.focus('end'), 50)
    } else {
      speech.stop()
      if (wasVisible) flushSave()
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

function close() {
  speech.stop()
  emit('update:visible', false)
}

function copyAll() {
  void navigator.clipboard.writeText(getMarkdown())
}

function toggleVoice() {
  if (speech.listening.value) {
    speech.stop()
    return
  }
  speech.start((text, isFinal) => {
    if (!isFinal || !editor.value) return
    editor.value.chain().focus().insertContent(text).run()
    scheduleSave()
  })
}

function isActive(name: string, attrs?: Record<string, unknown>) {
  return editor.value?.isActive(name, attrs) ?? false
}

onMounted(() => window.addEventListener('keydown', onKeydown, true))

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  speech.stop()
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
              <EditorContent :editor="editor" class="prompt-md-editor" />
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

            <button
              type="button"
              class="prompt-md-format-btn"
              title="语音输入"
              :class="speech.listening.value ? 'animate-pulse text-danger' : ''"
              @click="toggleVoice"
            >
              🎤
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
