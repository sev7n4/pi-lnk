<script setup lang="ts">
import { ref } from 'vue'

/**
 * 批注态胶囊意见框（规格 §17-③ / §9 #46；2026-10-28 真机反馈③ 重设计）。
 *
 * ⭐ **首笔即弹**：批注态下首笔落定由 Viewer 置 `visible=true` —— 无「完成」步骤、
 *   无缩略图确认条（v1 两段式已废弃）。用户可继续补画，填/不填文字都可点 ⚓。
 * ⚡ 带回语义（拍板③④）：文字作为 composer **正文预填**（截图只含圈选标记，
 *   不烧字）；⚓ 落下即标提议拒绝（decline 结算在壳层）。
 * 容器：viewer 内联浮条（⛔ 非 MobileSheet —— 不遮批注画布，可继续画）。
 *
 * ⭐ v2 视觉（HIG 极简）：单行**毛玻璃小胶囊**（surface-glass + glass-blur）——
 *   [输入框 flex][⚓ 圆形主色钮]，总高 ≈ 1 个触控目标；说明文案并入 placeholder。
 *   此前大卡片（textarea×2 行 + 大按钮 + 说明段）遮挡圈选/取消且与工具栏抢视觉。
 */
const props = withDefaults(
  defineProps<{
    visible: boolean
    /** 截图上传中（⯈ 合成图要先上传才能进引用，契约拒 blob） */
    uploading?: boolean
    /** 草稿前缀（v1.5 Q / G-23：视频 =「第 m:ss 帧：」；可删改） */
    draftPrefix?: string
  }>(),
  { uploading: false, draftPrefix: '' },
)

const emit = defineEmits<{
  (e: 'anchor', payload: { text: string }): void
  (e: 'dismiss'): void
}>()

const text = ref(props.draftPrefix)

function anchor() {
  if (props.uploading) return
  emit('anchor', { text: text.value.trim() })
}

function onInputKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    anchor()
  }
}
</script>

<template>
  <div v-if="visible" class="mobile-annotation-capsule" data-testid="mobile-annotation-capsule">
    <input
      v-model="text"
      class="mobile-annotation-capsule-input"
      type="text"
      :placeholder="uploading ? '截图上传中…' : '补充意见，可不填'"
      :disabled="uploading"
      data-testid="mobile-annotation-capsule-input"
      @keydown.enter="onInputKeydown"
    />
    <button
      type="button"
      class="mobile-annotation-capsule-anchor"
      :disabled="uploading"
      :aria-label="uploading ? '上传中' : '带回对话'"
      data-testid="mobile-annotation-capsule-anchor"
      @click="anchor"
    >
      <span class="mobile-annotation-capsule-anchor-icon" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
.mobile-annotation-capsule {
  position: absolute;
  left: var(--lnk-space-2);
  right: var(--lnk-space-2);
  bottom: var(--lnk-space-2);
  z-index: 6;
  display: flex;
  align-items: center;
  gap: var(--lnk-space-2);
  padding: var(--lnk-space-1) var(--lnk-space-1) var(--lnk-space-1) var(--lnk-space-3);
  border: 0.5px solid var(--lnk-glass-topline);
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-surface-glass);
  -webkit-backdrop-filter: blur(var(--lnk-glass-blur)) saturate(160%);
  backdrop-filter: blur(var(--lnk-glass-blur)) saturate(160%);
  box-shadow: var(--lnk-shadow-sm);
}

.mobile-annotation-capsule-input {
  flex: 1;
  min-width: 0;
  height: var(--lnk-touch-target);
  border: none;
  background: transparent;
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-md);
  line-height: var(--lnk-lh-md);
  outline: none;
}

.mobile-annotation-capsule-input::placeholder {
  color: var(--lnk-text-muted);
}

.mobile-annotation-capsule-anchor {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--lnk-touch-target);
  height: var(--lnk-touch-target);
  border: none;
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-accent);
  color: var(--lnk-accent-on-signature);
  cursor: pointer;
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
</style>
