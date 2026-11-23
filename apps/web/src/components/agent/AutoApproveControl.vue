<script setup lang="ts">
/**
 * 授权自动生成 · composer 入口（规格 §11「状态胶囊 + 锚定浮层」）。
 *
 * ⭐ 形态决策（2026-11-23 用户拍板，参考 WorkBuddy 权限胶囊的交互骨架）：
 * 1. **状态胶囊**（PC）：图标 + 文字「自动生成」+ 箭头，排在 composer 工具行模型 chip 之后、发送键之前。
 *    不占输入区上方、不做通栏卡片（那是被投诉的旧形态）；关闭态弱化（无底色无边框），
 *    开启态琥珀高亮 ⇒ 一眼可读出「agent 正在替你行动」。
 * 2. **说明与开关收进锚定浮层**：文案不常驻屏幕，点开才解释「开了会怎样」，
 *    里面直接给开关 ⇒ 双向操作（开 / 收回）都在同一处，不必再找「撤回」入口。
 * 3. **移动端不抄文字胶囊**：裸条只有 ＋ / 模型 / 发送 三件套，加文字胶囊会挤成四件套
 *    （历史上踩过散架）⇒ 移动端 icon-only 触发器 + 底部 Sheet（沿用模型选择卡
 *    「PC 锚定 popover / 移动 Sheet」既有规范）。
 *
 * ⭐ 单一数据源：授权态读写全部走 `useAutoApproveGeneration`（服务端 SSOT），
 * 本组件不缓存 localStorage、不做本地判定。开关文案与开关本体在 `AutoApprovePanel`（单源）。
 */
import { computed, ref } from 'vue'
import AutoApproveGlyph from './AutoApproveGlyph.vue'
import AutoApprovePanel from './AutoApprovePanel.vue'
import MobileSheet from '@/components/mobile/MobileSheet.vue'
import { useAutoApproveGeneration } from '@/composables/useAutoApproveGeneration'
import { useClickOutside } from '@/composables/useClickOutside'

const props = withDefaults(defineProps<{ desktop?: boolean; readOnly?: boolean }>(), {
  desktop: true,
  readOnly: false,
})

const { authorized, setAuthorized } = useAutoApproveGeneration()

const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)
/** 移动端 Sheet 内容（Teleport 到 body）不是 root 的后代 ⇒ 纳入「内部」判定，
 *  否则点开关会被 click-outside 判成外部而顺手关掉 Sheet。 */
const sheetRef = ref<HTMLElement | null>(null)
useClickOutside(rootRef, () => { open.value = false }, [sheetRef])

const triggerLabel = computed(() =>
  authorized.value
    ? '自动生成 · 已开启，agent 生成图片与音频时不再逐次确认'
    : '自动生成 · 当前每次生成都先问你',
)

async function onToggle() {
  // 极简撤销口径：toast 带单动作「撤销」（误点可反悔），不弹模态确认框。
  await setAuthorized(!authorized.value, { undoable: true })
}
</script>

<template>
  <div ref="rootRef" class="auto-approve-control" data-testid="auto-approve-control">
    <!-- PC：状态胶囊（图标 + 文字 + 箭头） -->
    <button
      v-if="props.desktop"
      type="button"
      class="auto-approve-chip"
      :class="{ 'is-on': authorized, 'is-open': open }"
      :disabled="props.readOnly"
      :title="triggerLabel"
      :aria-label="triggerLabel"
      :aria-expanded="open"
      aria-haspopup="dialog"
      data-testid="auto-approve-chip"
      @click="open = !open"
    >
      <AutoApproveGlyph :on="authorized" :size="14" />
      <span class="auto-approve-chip-label">自动生成</span>
      <svg
        class="auto-approve-chip-caret"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path :d="open ? 'M19 15l-7-7-7 7' : 'M5 9l7 7 7-7'" />
      </svg>
    </button>

    <!-- 移动：icon-only 触发器（裸条三件套纪律） -->
    <button
      v-else
      type="button"
      class="auto-approve-trigger"
      :disabled="props.readOnly"
      :title="triggerLabel"
      :aria-label="triggerLabel"
      data-testid="auto-approve-trigger"
      @click="open = true"
    >
      <AutoApproveGlyph :on="authorized" :size="15" />
    </button>

    <!-- PC：锚定浮层（复用既有 `.neo-popover` 表面语言；click-outside 收起） -->
    <div
      v-if="props.desktop && open"
      class="neo-popover auto-approve-popover"
      role="dialog"
      aria-label="自动生成授权"
      data-testid="auto-approve-popover"
    >
      <AutoApprovePanel :authorized="authorized" @toggle="onToggle" />
    </div>

    <!-- 移动：底部 Sheet（与模型选择卡同规范：PC 锚定 popover / 移动 Sheet） -->
    <MobileSheet
      v-if="!props.desktop && open"
      title="自动生成"
      subtitle="授权 agent 自动执行图片与音频生成"
      @close="open = false"
    >
      <div ref="sheetRef">
        <AutoApprovePanel :authorized="authorized" @toggle="onToggle" />
      </div>
    </MobileSheet>
  </div>
</template>

<style scoped>
.auto-approve-control {
  position: relative;
  display: inline-flex;
  flex: none;
}

/* ---- PC 状态胶囊 ---- */
.auto-approve-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 8px;
  border: 0.5px solid transparent;
  border-radius: var(--lnk-radius-sm);
  background: transparent;
  color: var(--lnk-text-muted);
  font-size: var(--lnk-text-xs);
  line-height: var(--lnk-lh-xs);
  cursor: pointer;
  touch-action: manipulation;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}

.auto-approve-chip:hover {
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-secondary);
}

.auto-approve-chip:focus-visible {
  outline: 2px solid var(--lnk-border-focus);
  outline-offset: 2px;
}

/* 已开启：琥珀高亮（柔底 + 琥珀边 + 琥珀字）——与实心图形一起把状态说清楚 */
.auto-approve-chip.is-on {
  color: var(--lnk-warning);
  background: var(--lnk-warning-bg);
  border-color: var(--lnk-warning-border);
}

.auto-approve-chip.is-on:hover {
  background: var(--lnk-warning-bg-hover);
  border-color: var(--lnk-warning-border-hover);
}

.auto-approve-chip-label {
  white-space: nowrap;
}

.auto-approve-chip-caret {
  width: 10px;
  height: 10px;
  opacity: 0.6;
}

/* ---- PC 锚定浮层 ---- */
.auto-approve-popover {
  position: absolute;
  right: 0;
  bottom: 100%;
  z-index: 40;
  margin-bottom: 6px;
  width: 272px;
  padding: 12px 14px;
  border-radius: var(--lnk-radius-md);
}

/* ---- 移动触发器（icon-only） ---- */
.auto-approve-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0.5px solid transparent;
  border-radius: var(--lnk-radius-sm);
  background: transparent;
  color: var(--lnk-warning);
  cursor: pointer;
  touch-action: manipulation;
  transition: background-color 120ms ease, border-color 120ms ease;
}

.auto-approve-trigger:hover {
  background: var(--lnk-warning-bg);
  border-color: var(--lnk-warning-border);
}

.auto-approve-trigger:focus-visible {
  outline: 2px solid var(--lnk-border-focus);
  outline-offset: 2px;
}
</style>
