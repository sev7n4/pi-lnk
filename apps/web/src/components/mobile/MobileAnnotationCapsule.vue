<script setup lang="ts">
import { ref, watch } from 'vue'

/**
 * 批注态胶囊意见框（规格 §17-③ / §9 #46，2026-10-27）。
 *
 * ⭐ **首笔即弹**：批注态下首笔落定由 Viewer 置 `visible=true` —— 无「完成」步骤、
 *   无缩略图确认条（v1 两段式已废弃）。用户可继续补画，填/不填文字都可点 ⚓。
 * ⚡ 带回语义（拍板③④）：文字作为 composer **正文预填**（截图只含圈选标记，
 *   不烧字）；⚓ 落下即标提议拒绝（decline 结算在壳层）。
 * 容器：viewer 内联浮条（⛔ 非 MobileSheet —— 不遮批注画布，可继续画）。
 */
const props = withDefaults(
  defineProps<{
    visible: boolean
    /** 截图上传中（⯈ 合成图要先上传才能进引用，契约拒 blob） */
    uploading?: boolean
  }>(),
  { uploading: false },
)

const emit = defineEmits<{
  (e: 'anchor', payload: { text: string }): void
  (e: 'dismiss'): void
}>()

const text = ref('')

watch(
  () => props.visible,
  (v) => {
    if (v) text.value = ''
  },
)

function anchor() {
  if (props.uploading) return
  emit('anchor', { text: text.value.trim() })
}
</script>

<template>
  <div v-if="visible" class="mobile-annotation-capsule" data-testid="mobile-annotation-capsule">
    <textarea
      v-model="text"
      class="mobile-annotation-capsule-input"
      rows="2"
      placeholder="补充意见（可不填，直接点 ⚓）"
      data-testid="mobile-annotation-capsule-input"
    />
    <div class="mobile-annotation-capsule-row">
      <button
        type="button"
        class="mobile-annotation-capsule-anchor"
        :disabled="uploading"
        data-testid="mobile-annotation-capsule-anchor"
        @click="anchor"
      >
        <span class="mobile-annotation-capsule-anchor-icon" aria-hidden="true" />
        <span>{{ uploading ? '上传中…' : '带回对话' }}</span>
      </button>
      <p class="mobile-annotation-capsule-note">当前屏截为图（含圈选标记）· 意见也可稍后在对话补充</p>
    </div>
  </div>
</template>

<style scoped>
.mobile-annotation-capsule {
  position: absolute;
  left: var(--lnk-space-2);
  right: var(--lnk-space-2);
  bottom: calc(var(--lnk-space-2) + env(safe-area-inset-bottom));
  z-index: 6;
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-2);
  padding: var(--lnk-space-3);
  border: 1px solid var(--lnk-border-strong);
  border-radius: var(--lnk-radius-lg);
  background: var(--lnk-surface-base);
  box-shadow: var(--lnk-shadow-md);
}

.mobile-annotation-capsule-input {
  width: 100%;
  box-sizing: border-box;
  padding: var(--lnk-space-2);
  border: 1px solid var(--lnk-border-strong);
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-md);
  line-height: var(--lnk-lh-md);
  resize: none;
}

.mobile-annotation-capsule-row {
  display: flex;
  align-items: center;
  gap: var(--lnk-space-2);
}

.mobile-annotation-capsule-anchor {
  display: inline-flex;
  align-items: center;
  gap: var(--lnk-space-2);
  min-height: var(--lnk-touch-target);
  padding: 0 var(--lnk-space-3);
  border: none;
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-accent);
  color: var(--lnk-accent-on-signature);
  font-size: var(--lnk-text-md);
  font-weight: var(--lnk-weight-semibold);
}

.mobile-annotation-capsule-anchor:disabled {
  opacity: 0.6;
}

/* ⭐ 锚 = 品牌资产（同 MobileNodeAnnotateSheet），⛔ 不用字符/自造图标（G-7） */
.mobile-annotation-capsule-anchor-icon {
  width: var(--lnk-space-4);
  height: var(--lnk-space-4);
  background: var(--lnk-accent-on-signature);
  mask-image: url('@/assets/icons/anchor-locate.png');
  mask-size: contain;
  mask-repeat: no-repeat;
  mask-position: center;
}

.mobile-annotation-capsule-note {
  margin: 0;
  font-size: var(--lnk-text-xs);
  color: var(--lnk-text-secondary);
}
</style>
