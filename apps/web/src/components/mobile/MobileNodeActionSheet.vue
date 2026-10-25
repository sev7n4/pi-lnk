<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import MobileSheet from './MobileSheet.vue'
import {
  MOBILE_NODE_ACTION_LABELS,
  MOBILE_NODE_DESTRUCTIVE_ACTION_KEYS,
  resolveMobileNodeMenuTiers,
  type MobileNodeActionKey,
} from '@/composables/mobileNodeActionPolicy'

export interface MobileNodeActionNode {
  id: string
  type: string
  data?: any
  /** 是否已处于多选态（决定「多选」项文案，2026-10-24 走查①恢复） */
  multiSelectActive?: boolean
  /** 该节点当前是否已在多选选区内（「加入」还是「移出」） */
  multiSelectSelected?: boolean
}

/**
 * 移动端长按 **Menu**（2026-10-22 R1-T5 起；2026-10-25 按 §4.11 Menu 化）。
 *
 * ⭐ **容器语义**（Apple HIG 原文）：*"Use an action sheet — **not a menu** — to
 *   provide choices related to an action… people expect a **menu** to appear when
 *   they **choose to reveal it**"* —— 长按是「主动揭示一组选项」⇒ 承载的是
 *   **Menu**，不是 Action Sheet（后者只用于「为一次动作做澄清」＝破坏性确认）。
 *
 * ⭐ **基座唯一**（§4.11.8）：走 `MobileSheet`（scrim + 拖拽把手 + 圆角 + 阴影 +
 *   安全区 + Teleport body）—— ⛔ 禁新写第二套 sheet 皮肤（旧的裸
 *   `position:fixed` div 无遮罩 ⇒ 点浮层外画布不会关）。
 *
 * ⭐ **一级 ≤5 项**（§4.11.3，HIG 数量上限）：低频项进二级「更多」；
 *   一级不足 5 项时二级项**回填**到一级（菜单按上下文裁剪）。
 *
 * ⭐ **破坏性置底 + 分隔线 + 红色**（§4.11.4）：Menu 内 destructive 在末位；
 *   （确认弹层内的 destructive 则置顶 —— 两种载体不同，勿混）。
 *
 * 走查①（2026-10-24）：本 Menu 是移动端长按的**唯一**入口 —— CanvasContextMenu 的
 * 旧 D-6 移动端 sheet 分支已删（双入口会同时弹出两张相同的卡）。
 */
const props = defineProps<{ node: MobileNodeActionNode }>()
const emit = defineEmits<{
  action: [key: string]
  close: []
  /** R4-T3：重命名提交（标题），页面层复用既有 renameNodeById 落库 */
  rename: [title: string]
}>()

/**
 * 「多选」项文案随态变化（判据源自 2026-10-21 走查，随 CanvasContextMenu 移动端
 * 分支一并迁移到此）：
 * 未进多选态 = 「多选」（进入多选态）；已在多选态 = 「加入多选」/「移出多选」
 * （长按第二张图时**加入**选区，而不是重置整份选区）。
 */
const multiSelectLabel = computed(() => {
  if (!props.node.multiSelectActive) return '多选'
  return props.node.multiSelectSelected ? '移出多选' : '加入多选'
})

/** 一级 / 二级分层（单一真源：`mobileNodeActionPolicy`） */
const tiers = computed(() => resolveMobileNodeMenuTiers(props.node))

/** 是否已展开二级「更多」 */
const showMore = ref(false)

interface ActionItem {
  key: MobileNodeActionKey
  label: string
  danger?: boolean
}

function toItem(key: MobileNodeActionKey): ActionItem {
  // `multi-select` 的文案随多选态变化（三态），不在静态标签表里
  const label =
    key === 'multi-select'
      ? multiSelectLabel.value
      : MOBILE_NODE_ACTION_LABELS[key as Exclude<MobileNodeActionKey, 'multi-select'>]
  return {
    key,
    label,
    danger: MOBILE_NODE_DESTRUCTIVE_ACTION_KEYS.includes(key),
  }
}

const primaryItems = computed<ActionItem[]>(() => tiers.value.primary.map(toItem))
const moreItems = computed<ActionItem[]>(() => tiers.value.more.map(toItem))

/**
 * R4-T3：重命名内联态。
 *
 * ⭐ 为什么在 Menu 内做，而不是复用 PC 的行内重命名：PC 的重命名由 `NeoBaseNode`
 *   消费 `CANVAS_NODE_RENAME_REQUEST_KEY` 驱动（行内 input），而**移动端不渲染
 *   `NeoBaseNode`**（`NodeRenderer.vue:35` 移动端走 `MobileNodeTile`）⇒
 *   原接线在移动端**完全静默失效**（点了零反馈）。长按已是二级入口，
 *   在此直接给输入框符合移动端手势，且不动 PC。
 */
const renaming = ref(false)
const renameValue = ref('')
const renameInput = ref<HTMLInputElement | null>(null)

/** 节点当前标题（用于初值；与 PC `resolveNeoContextTitle` 同源的兜底） */
const currentTitle = computed(() => {
  const data = (props.node.data ?? {}) as Record<string, unknown>
  const t = typeof data.title === 'string' ? data.title.trim() : ''
  if (t) return t
  const label = typeof data.label === 'string' ? data.label.trim() : ''
  return label
})

async function startRename() {
  renameValue.value = currentTitle.value
  renaming.value = true
  await nextTick()
  renameInput.value?.focus()
  renameInput.value?.select()
}

function cancelRename() {
  renaming.value = false
  renameValue.value = ''
}

function submitRename() {
  const title = renameValue.value.trim()
  renaming.value = false
  renameValue.value = ''
  if (!title) return
  emit('rename', title)
}

function onSelect(key: string) {
  if (key === 'rename') {
    void startRename()
    return
  }
  emit('action', key)
}

function openMore() {
  showMore.value = true
}

function backToPrimary() {
  showMore.value = false
}
</script>

<template>
  <MobileSheet title="节点操作" @close="emit('close')">
    <!-- R4-T3：重命名内联输入（替代失效的 PC 行内重命名通道） -->
    <div v-if="renaming" class="mobile-action-rename">
      <input
        ref="renameInput"
        v-model="renameValue"
        class="mobile-action-rename-input"
        type="text"
        placeholder="节点名称"
        aria-label="节点名称"
        data-testid="mobile-action-rename-input"
        @keyup.enter="submitRename"
        @keyup.esc="cancelRename"
      />
      <div class="mobile-action-rename-row">
        <button
          type="button"
          class="action-item action-cancel"
          data-action="rename-cancel"
          @click="cancelRename"
        >
          取消
        </button>
        <button
          type="button"
          class="action-item action-confirm"
          data-action="rename-confirm"
          @click="submitRename"
        >
          确定
        </button>
      </div>
    </div>

    <!-- 二级「更多」视图 -->
    <template v-else-if="showMore">
      <button
        type="button"
        class="action-item action-back"
        data-action="back"
        @click="backToPrimary"
      >
        返回
      </button>
      <button
        v-for="a in moreItems"
        :key="a.key"
        :data-action="a.key"
        type="button"
        class="action-item"
        :class="{ 'action-item--danger': a.danger }"
        @click="onSelect(a.key)"
      >
        {{ a.label }}
      </button>
    </template>

    <!-- 一级动作（≤5 项，§4.11.3） -->
    <template v-else>
      <button
        v-for="a in primaryItems"
        :key="a.key"
        :data-action="a.key"
        type="button"
        class="action-item"
        :class="{ 'action-item--danger': a.danger }"
        @click="onSelect(a.key)"
      >
        {{ a.label }}
      </button>
      <button
        v-if="moreItems.length"
        type="button"
        class="action-item action-more"
        data-action="more"
        @click="openMore"
      >
        更多
      </button>
    </template>

    <button
      v-if="!renaming"
      class="action-item action-cancel"
      type="button"
      data-action="cancel"
      @click="emit('close')"
    >
      取消
    </button>
  </MobileSheet>
</template>

<style scoped>
/* Menu 项：整行可点（iOS 菜单范式：文字左对齐、整行热区），非居中按钮 */
.action-item {
  min-height: var(--lnk-touch-target);
  display: flex;
  align-items: center;
  width: 100%;
  border: none;
  border-radius: var(--lnk-radius-md);
  background: transparent;
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-md);
  text-align: left;
  padding: 0 var(--lnk-space-3);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.action-item:active {
  background: var(--lnk-pressed-overlay);
}

/* 破坏性：红色 + 末位 + 前置分隔线（§4.11.4）
   ⚠️ 用 `--lnk-error`（L2 语义层，两主题成对）—— **不是** `--lnk-status-error`：
   后者全仓未定义（既有两处引用都是错引用，红色其实没生效） */
.action-item--danger {
  color: var(--lnk-error);
  margin-top: var(--lnk-space-2);
  border-top: 1px solid var(--lnk-border-subtle);
  border-radius: 0 0 var(--lnk-radius-md) var(--lnk-radius-md);
}

.action-cancel {
  margin-top: var(--lnk-space-2);
  color: var(--lnk-text-secondary);
  justify-content: center;
}

.action-back {
  color: var(--lnk-accent);
}

.action-more {
  color: var(--lnk-accent);
}

/* R4-T3：重命名内联输入 */
.mobile-action-rename {
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-2);
}

.mobile-action-rename-input {
  width: 100%;
  min-height: var(--lnk-touch-target);
  box-sizing: border-box;
  padding: 0 var(--lnk-space-3);
  border: 1px solid var(--lnk-border-strong);
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-surface-base);
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-md);
}

.mobile-action-rename-input:focus {
  outline: none;
  border-color: var(--lnk-accent);
}

.mobile-action-rename-row {
  display: flex;
  gap: var(--lnk-space-2);
}

.action-confirm {
  color: var(--lnk-accent-text);
  justify-content: center;
}
</style>
