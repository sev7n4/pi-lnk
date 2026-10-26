<script setup lang="ts">
import { ref, watch } from 'vue'
import MobileSheet from './MobileSheet.vue'

/**
 * 移动端标注浮层（规格 §4.3 L1 / §4.5 M1 · 拍板项 L1 + M1）。
 *
 * ⭐ **只有一支笔**：用户用手指在查看器里自由圈选 ⇒ 产出「**一张带标记的整图**」
 *   + 一句意见 ⇒ 经 **锚（`anchor-locate.png`）** 带回对话页 composer。
 *   ⛔ 不做多工具栏 / 不做区域裁切 / 不引入坐标契约。
 *
 * ⭐ **容器**：走 `MobileSheet` 基座（scrim + 拖拽把手 + 圆角 + 安全区 + Teleport）
 *   —— ⛔ 禁新写第二套 sheet 皮肤（§4.11.8 / G-15 / V-3）。
 */
const props = withDefaults(
  defineProps<{
    /** 节点标题（作为引用标签） */
    nodeTitle?: string
    /** 上传中（合成图要上传后才能进引用 ⇒ 契约拒 blob URL） */
    uploading?: boolean
    /** 降级（无 CORS / 取不到帧 ⇒ 只带文字） */
    degraded?: boolean
    /** 失败文案（上传失败等） */
    error?: string
  }>(),
  { nodeTitle: '', uploading: false, degraded: false, error: '' },
)

const emit = defineEmits<{
  /**
   * 提交给 agent：意见 +（可选）带标记整图 blob。
   * ⭐ `imageBlob` 缺省 = 降级（只带文字）。
   */
  (e: 'send', payload: { opinion: string; imageBlob?: Blob; degraded: boolean }): void
  (e: 'close'): void
}>()

const opinion = ref('')

watch(
  () => props.uploading,
  (v) => {
    if (!v) return
  },
)

function submit() {
  if (props.uploading) return
  emit('send', { opinion: opinion.value.trim(), degraded: props.degraded })
}
</script>

<template>
  <MobileSheet title="标注" @close="emit('close')">
    <div class="mobile-annotate">
      <!-- 降级说明（诚实告知，不静默丢图） -->
      <p v-if="degraded" class="mobile-annotate-degraded" data-testid="mobile-annotate-degraded">
        本条只带文字，未附截图
      </p>

      <label class="mobile-annotate-field">
        <span class="mobile-annotate-label">我的意见</span>
        <textarea
          v-model="opinion"
          class="mobile-annotate-textarea"
          rows="4"
          placeholder="想让 agent 怎么改？"
          data-testid="mobile-annotate-opinion"
        />
      </label>

      <p v-if="error" class="mobile-annotate-error" data-testid="mobile-annotate-error">{{ error }}</p>
    </div>

    <template #actions>
      <button
        type="button"
        class="mobile-annotate-send"
        :disabled="uploading"
        data-testid="mobile-annotate-send"
        @click="submit"
      >
        <!-- ⭐ 锚 = 品牌资产（anchor-locate.png），⛔ 不用字符/自造图标（G-7 / §4.5） -->
        <span class="mobile-annotate-anchor" aria-hidden="true" />
        <span>{{ uploading ? '上传中…' : '带回对话' }}</span>
      </button>
    </template>
  </MobileSheet>
</template>

<style scoped>
.mobile-annotate {
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-3);
  padding: var(--lnk-space-3);
}

.mobile-annotate-degraded {
  margin: 0;
  font-size: var(--lnk-text-sm);
  color: var(--lnk-text-secondary);
}

.mobile-annotate-field {
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-2);
}

.mobile-annotate-label {
  font-size: var(--lnk-text-sm);
  font-weight: var(--lnk-weight-medium);
  color: var(--lnk-text-secondary);
}

.mobile-annotate-textarea {
  width: 100%;
  min-height: 88px;
  box-sizing: border-box;
  padding: var(--lnk-space-3);
  border: 1px solid var(--lnk-border-strong);
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-surface-base);
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-md);
  line-height: var(--lnk-lh-md);
  resize: vertical;
}

.mobile-annotate-textarea:focus {
  outline: none;
  border-color: var(--lnk-accent);
}

.mobile-annotate-error {
  margin: 0;
  font-size: var(--lnk-text-sm);
  color: var(--lnk-error);
}

/* 主按钮：锚 + 文案（⛔ 无本地提交语义，这里是「传送」） */
.mobile-annotate-send {
  display: inline-flex;
  width: 100%;
  min-height: var(--lnk-touch-target);
  align-items: center;
  justify-content: center;
  gap: var(--lnk-space-2);
  border: none;
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-accent);
  color: var(--lnk-accent-on-signature);
  font-size: var(--lnk-text-md);
  font-weight: var(--lnk-weight-semibold);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.mobile-annotate-send:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 锚图标：品牌位图资产（anchor-locate.png），用 mask 吃 currentColor */
.mobile-annotate-anchor {
  width: 18px;
  height: 18px;
  background-color: currentColor;
  -webkit-mask-image: url('@/assets/icons/anchor-locate.png');
  mask-image: url('@/assets/icons/anchor-locate.png');
  -webkit-mask-size: contain;
  mask-size: contain;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
}
</style>
