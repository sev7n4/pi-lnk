<script setup lang="ts">
/**
 * 授权自动生成 · composer 入口（规格 §12「胶囊去描边 · 文案收敛为 [auto] · 移动端统一」· §13「去柔底 + Auto + 移动端仅输入态」）。
 *
 * ⭐ 形态决策（2026-11-23 用户拍板，规格 §12 + §13）：
 * 1. **胶囊上彻底不出现「自动生成」中文长文案** —— 关闭态那四个字是低对比度的**功能名**，
 *    扫过去读不出「现在是关的」，反而会被读成「已开启自动生成」⇒ 误导。
 *    开启态只留 **`Auto`** 短标记（mono 等宽 = 技术标记感），关闭态不显示任何文字。
 * 2. **「自动生成」与「每次先问」下沉到浮层卡片**（`AutoApprovePanel`）：那里才是解释行为的地方。
 * 3. **开启态既无描边也无柔底**（§12 去掉描边、§13 去掉柔底）：§13 用户指出
 *    「背景边框仍未去掉」—— 生产实测证实描边已是透明，**剩下的是琥珀柔底圆角块**
 *    （`bg=rgba(138,82,0,0.1)`）⇒ 一并去掉。开启态 = 实心盾 + 琥珀「Auto」字，
 *    差异全靠**图形填充 + 文字**，不再靠色块。
 * 4. **PC 与移动端共用同一枚胶囊**（同一组件 / 同一文案 / 同一图形 / 同一 `Auto`）：
 *    §11 的「移动端 icon-only」是当年凭感觉怕挤成四件套，本刀实测证伪
 *    （430/390/360/320px 均放得下，裸条高恒 48px）。
 *    唯一差异：移动端**不带箭头**（移动端开底部 Sheet，箭头语义与 PC 锚定浮层相反）。
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
    <!-- 胶囊（PC + 移动**同一枚**，规格 §12.2 / §13）：
         · 图形 = 盾牌+闪电（线框=关 / 实心=开），零文字「自动生成」；
         · 开启态追加 `Auto` 短标记（mono 等宽技术标记，非中文长文案）；
         · **无描边、无柔底**（§12 去描边 / §13 去柔底）⇒ 开启态纯「实心盾 + 琥珀字」；
         · 箭头仅 PC（PC 开锚定浮层↑ / 移动开底部 Sheet↓，箭头语义相反 ⇒ 移动端不带箭头）。 -->
    <button
      type="button"
      class="auto-approve-chip"
      :class="{ 'is-on': authorized, 'is-open': open, 'is-mobile': !props.desktop }"
      :disabled="props.readOnly"
      :title="triggerLabel"
      :aria-label="triggerLabel"
      :aria-expanded="open"
      aria-haspopup="dialog"
      data-testid="auto-approve-chip"
      @click="open = !open"
    >
      <AutoApproveGlyph :on="authorized" :size="14" />
      <span v-if="authorized" class="auto-approve-chip-auto" data-testid="auto-approve-chip-auto">Auto</span>
      <svg
        v-if="props.desktop"
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

/* ---- PC + 移动共用的状态胶囊（规格 §12） ---- */
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

/* 已开启：琥珀高亮（琥珀字 + 实心图形）。
   ⚠️ **既不描边也不铺底**（§12 Q1 去描边、§13 Q1 去柔底）：
      0.5px 琥珀边框是「按钮」语义，琥珀柔底圆角块是「色块」语义 ——
      用户在生产截图上指认的正是那个深色圆角块（实测 `bg=rgba(138,82,0,0.1)`）。
      ⇒ 开启态与关闭态的差异全靠**图形填充（实心 vs 线框）+ 文字（Auto vs 无）**，
      工具行里不再出现任何色块。 */
.auto-approve-chip.is-on {
  color: var(--lnk-warning);
  background: transparent;
}

.auto-approve-chip.is-on:hover {
  background: var(--lnk-surface-raised);
}

/* `Auto` 标记：mono 等宽 = 「开关已置 auto」的技术标记，非中文长文案。
   令牌纪律：--lnk-font-mono（既有）+ --lnk-warning；零新令牌。 */
.auto-approve-chip-auto {
  font-family: var(--lnk-font-mono);
  font-size: 11px;
  line-height: var(--lnk-lh-2xs);
  letter-spacing: 0.01em;
  white-space: nowrap;
}

.auto-approve-chip-caret {
  width: 10px;
  height: 10px;
  opacity: 0.6;
}

/* 移动端：同一枚胶囊，但**不带箭头**（移动端开底部 Sheet，箭头语义与 PC 锚定浮层相反）；
   高度略降一档给裸条留呼吸。 */
.auto-approve-chip.is-mobile {
  height: 26px;
  padding: 0 6px;
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
</style>
