<script setup lang="ts">
import { computed, ref } from 'vue'
import { splitRefMentions } from '@/composables/useRefMentions'
import { acceptPrediction, buildGhostPrediction } from '@/components/agent/composer/prediction'

export interface MentionOption {
  id: string
  label: string
  type?: string
}

const props = defineProps<{
  modelValue: string
  mentions: MentionOption[]
  placeholder?: string
  disabled?: boolean
  /** 左侧预留内边距（与外部 prefix 控件并排时使用） */
  leadingInset?: number
  /** Enter 发送；Shift+Enter 换行（Agent 侧栏等对话场景） */
  submitOnEnter?: boolean
  /** 移动端：Enter 仅换行，永不提交（桌面行为不受影响） */
  mobileEnterNewline?: boolean
  /** P2-1.1 输入预测上下文：近期 user/assistant 文本（AgentSideRail 传入，cap ~20） */
  predictionHistory?: string[]
}>()

const emit = defineEmits<{ 'update:modelValue': [v: string]; submit: [] }>()

const textareaRef = ref<HTMLTextAreaElement>()
const backdropRef = ref<HTMLDivElement>()
const showMenu = ref(false)
const filterText = ref('')
const selectedIndex = ref(0)
const mentionStart = ref(-1)

/** P2-4.1 listbox 语义：选项 id 与 aria-activedescendant 跟随高亮项 */
const MENTION_LISTBOX_ID = 'mention-candidate-listbox'
function optionId(idx: number): string {
  return `${MENTION_LISTBOX_ID}-opt-${idx}`
}

const highlightSegments = computed(() => splitRefMentions(props.modelValue))

// P2-1.1 ghost 预测：纯函数计算建议；Esc 关闭后随再次输入重置
const ghostDismissed = ref(false)
const ghostRef = ref<HTMLDivElement>()

const ghostPrediction = computed(() => {
  const refs = splitRefMentions(props.modelValue)
    .filter((s) => s.kind === 'mention')
    .map((s) => s.value)
  return buildGhostPrediction({
    draft: props.modelValue,
    history: props.predictionHistory ?? [],
    refs,
  })
})

const ghostVisible = computed(() =>
  Boolean(ghostPrediction.value) && !ghostDismissed.value && !showMenu.value && !props.disabled,
)

const fieldInsetStyle = computed(() =>
  props.leadingInset && props.leadingInset > 0
    ? { paddingLeft: `${props.leadingInset}px` }
    : undefined,
)

const filteredMentions = computed(() => {
  const q = filterText.value.toLowerCase()
  return props.mentions.filter((m) =>
    m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
  ).slice(0, 8)
})

function updateValue(value: string) {
  emit('update:modelValue', value)
}

function syncBackdropScroll() {
  const el = textareaRef.value
  const backdrop = backdropRef.value
  const ghost = ghostRef.value
  if (ghost) {
    ghost.scrollTop = el?.scrollTop ?? 0
    ghost.scrollLeft = el?.scrollLeft ?? 0
  }
  if (!el || !backdrop) return
  backdrop.scrollTop = el.scrollTop
  backdrop.scrollLeft = el.scrollLeft
}

function detectMention(el: HTMLTextAreaElement) {
  const cursor = el.selectionStart ?? 0
  const before = el.value.slice(0, cursor)
  const match = before.match(/@([^\s@]*)$/)
  if (match) {
    showMenu.value = true
    filterText.value = match[1]
    mentionStart.value = cursor - match[0].length
    selectedIndex.value = 0
  } else {
    showMenu.value = false
    mentionStart.value = -1
  }
}

function onInput(e: Event) {
  const el = e.target as HTMLTextAreaElement
  updateValue(el.value)
  ghostDismissed.value = false
  detectMention(el)
  syncBackdropScroll()
}

function insertMention(option: MentionOption) {
  const el = textareaRef.value
  if (!el || mentionStart.value < 0) return
  const cursor = el.selectionStart ?? el.value.length
  const before = el.value.slice(0, mentionStart.value)
  const after = el.value.slice(cursor)
  const token = `@${option.label}`
  const next = `${before}${token} ${after}`
  updateValue(next)
  showMenu.value = false
  requestAnimationFrame(() => {
    const pos = before.length + token.length + 1
    el.focus()
    el.setSelectionRange(pos, pos)
    syncBackdropScroll()
  })
}

function insertText(text: string) {
  const el = textareaRef.value
  if (!el) {
    updateValue(`${props.modelValue}${text}`)
    return
  }
  const start = el.selectionStart ?? el.value.length
  const end = el.selectionEnd ?? start
  const before = el.value.slice(0, start)
  const after = el.value.slice(end)
  const next = `${before}${text}${after}`
  updateValue(next)
  requestAnimationFrame(() => {
    const pos = before.length + text.length
    el.focus()
    el.setSelectionRange(pos, pos)
    syncBackdropScroll()
  })
}

function focus() {
  textareaRef.value?.focus()
}

// P1-2.3：expose 真实菜单开态（ref 经 defineExpose 自动解包且保持响应式），
// 供 AgentSideRail 的 canvasRefEntryVisible 在「空态键入 @」时立即显示入口
defineExpose({ focus, insertText, showMenu })

/** P2-1.1：Tab 接受 ghost —— 拼接后即可继续编辑（就是普通 draft 文本） */
function acceptGhost() {
  const ghost = ghostPrediction.value
  if (!ghost) return
  const next = acceptPrediction(props.modelValue, ghost)
  ghostDismissed.value = false
  updateValue(next)
  requestAnimationFrame(() => {
    const el = textareaRef.value
    if (!el) return
    el.focus()
    el.setSelectionRange(next.length, next.length)
    syncBackdropScroll()
  })
}

/** P2-1.1：Esc 关闭当前 ghost（不插入），不冒泡以免关闭父级 dock */
function dismissGhost() {
  if (!ghostVisible.value) return
  ghostDismissed.value = true
}

function onKeydown(e: KeyboardEvent) {
  if (showMenu.value && filteredMentions.value.length) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectedIndex.value = (selectedIndex.value + 1) % filteredMentions.value.length
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectedIndex.value = (selectedIndex.value - 1 + filteredMentions.value.length) % filteredMentions.value.length
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      insertMention(filteredMentions.value[selectedIndex.value])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      showMenu.value = false
    }
    return
  }

  // P2-1.1 ghost 预测分支（仅菜单未开时；菜单分支的 Tab 仍选中 mention）
  if (e.key === 'Tab' && ghostVisible.value) {
    e.preventDefault()
    acceptGhost()
    return
  }
  if (e.key === 'Escape' && ghostVisible.value) {
    e.preventDefault()
    e.stopPropagation()
    dismissGhost()
    return
  }

  if (e.key !== 'Enter') return

  const cmdEnter = e.metaKey || e.ctrlKey
  if (props.submitOnEnter && !props.mobileEnterNewline) {
    if (e.shiftKey) return
    e.preventDefault()
    emit('submit')
    return
  }

  if (cmdEnter) {
    e.preventDefault()
    emit('submit')
  }
}
</script>

<template>
  <div class="relative flex-1">
    <div class="mention-input-shell">
      <div
        ref="backdropRef"
        class="mention-input-backdrop input-field min-h-[96px] w-full whitespace-pre-wrap break-words text-sm leading-[1.5]"
        :style="fieldInsetStyle"
        aria-hidden="true"
      >
        <template v-for="(segment, idx) in highlightSegments" :key="idx">
          <span v-if="segment.kind === 'mention'" class="font-medium text-[var(--lnk-accent-text)]">{{ segment.value }}</span>
          <span v-else>{{ segment.value }}</span>
        </template>
        <span v-if="!modelValue">&nbsp;</span>
      </div>

      <!-- P2-1.1 ghost 预测层：绝对定位不参与布局；草稿部分透明仅显示灰色接续 -->
      <div
        v-if="ghostVisible && ghostPrediction"
        ref="ghostRef"
        class="mention-input-ghost input-field min-h-[96px] w-full whitespace-pre-wrap break-words text-sm leading-[1.5]"
        :style="fieldInsetStyle"
        aria-hidden="true"
      ><span class="mention-input-ghost__draft">{{ modelValue }}</span><span class="mention-input-ghost__text">{{ ghostPrediction }}</span></div>

      <textarea
        ref="textareaRef"
        :value="modelValue"
        class="mention-input-field input-field min-h-[96px] w-full resize-none text-sm leading-[1.5] !text-transparent caret-[var(--lnk-text-primary)]"
        :style="fieldInsetStyle"
        rows="4"
        :placeholder="placeholder ?? '描述你想要生成的内容，@ 引用节点...'"
        :aria-label="placeholder ?? '内容输入'"
        :disabled="disabled"
        @input="onInput"
        @keydown="onKeydown"
        @scroll="syncBackdropScroll"
        @click="textareaRef && detectMention(textareaRef)"
      />
    </div>

    <ul
      v-if="showMenu && filteredMentions.length"
      role="listbox"
      :aria-activedescendant="optionId(selectedIndex)"
      class="neo-popover absolute bottom-full left-0 z-20 mb-1 max-h-48 w-full overflow-y-auto rounded-xl py-1"
    >
      <li
        v-for="(item, idx) in filteredMentions"
        :id="optionId(idx)"
        :key="item.id"
        role="option"
        :aria-selected="idx === selectedIndex"
        class="neo-popover-item cursor-pointer px-3 py-2 text-sm"
        :class="idx === selectedIndex ? '!bg-[var(--lnk-hi-bg)] !text-[var(--lnk-hi-text)]' : ''"
        @mousedown.prevent="insertMention(item)"
      >
        <span class="opacity-50">@</span>{{ item.label }}
        <span v-if="item.type" class="ml-2 text-[10px] opacity-45">{{ item.type }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.mention-input-shell {
  position: relative;
  max-height: 200px;
}

.mention-input-backdrop,
.mention-input-field,
.mention-input-ghost {
  min-height: 96px;
  max-height: 200px;
  padding: 0.375rem 0.25rem;
  border: none;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  scrollbar-color: var(--lnk-border-default) transparent;
}

.mention-input-backdrop::-webkit-scrollbar,
.mention-input-field::-webkit-scrollbar {
  width: 4px;
}

.mention-input-backdrop::-webkit-scrollbar-thumb,
.mention-input-field::-webkit-scrollbar-thumb {
  border-radius: 4px;
  background: rgb(var(--lnk-overlay-rgb) / 0.2);
}

.mention-input-backdrop {
  pointer-events: none;
}

.mention-input-field {
  position: absolute;
  inset: 0;
  background: transparent !important;
  box-shadow: none !important;
}

/* P2-1.1 ghost 预测层：绝对定位于输入壳内，不占布局（不破坏移动端 bare-bar 行高） */
.mention-input-ghost {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  border: none;
  background: transparent;
  color: var(--lnk-text-muted);
}

.mention-input-ghost__draft {
  visibility: hidden;
}
</style>
