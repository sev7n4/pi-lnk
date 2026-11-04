<script setup lang="ts">
withDefaults(defineProps<{
  generating?: boolean
  disabled?: boolean
  title?: string
  /** 尺寸档位：sm 28（默认，横向底栏）/ md 32（panel 落点）/ lg 36（floating 落点）——§4.3 */
  size?: 'sm' | 'md' | 'lg'
  /** 主 CTA 文案（动词 + 对象，§4.2 不变量 5）；缺省沿用生成/取消生成 */
  label?: string
  /** glyph 档位：anchor 生成锚（默认，生成类 CTA）/ send 发送箭头（composer 发送键，2026-10-18 用户裁决） */
  glyph?: 'anchor' | 'send'
}>(), { size: 'sm', glyph: 'anchor' })

const emit = defineEmits<{
  generate: []
}>()
</script>

<template>
  <button
    type="button"
    class="dock-generate-btn agent-hit-expand"
    data-hit="l"
    :class="[`dock-generate-btn--${size}`, { 'is-generating': generating }]"
    :disabled="disabled"
    :title="title ?? (generating ? '停止生成' : '生成')"
    :aria-label="label ?? (generating ? '停止生成' : '生成')"
    @click.stop="emit('generate')"
  >
    <!-- Stop square while generating — clearer cancel affordance than a spinner-only control.
         2026-11-04 移动端复测②：方块 12px rx1.5 → 14px rx3（视觉更稳，正圆钮内占比更合理）。 -->
    <svg
      v-if="generating"
      width="14"
      height="14"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="0" y="0" width="14" height="14" rx="3" />
    </svg>
    <!-- 2026-10-18：生成锚品牌 glyph（用户供图抠像素材）。
         mask + currentColor ⇒ 深浅主题 / hover / disabled 全部自动跟随文字色 -->
    <span
      v-else
      class="dock-generate-btn__glyph"
      :class="{ 'dock-generate-btn__glyph--send': glyph === 'send' }"
      aria-hidden="true"
    />
  </button>
</template>

<style scoped>
.dock-generate-btn {
  display: inline-flex;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 999px;
  background: var(--lnk-hi-bg);
  color: var(--lnk-hi-text);
  cursor: pointer;
  pointer-events: auto;
  box-shadow: var(--lnk-hi-shadow);
  transition:
    transform 0.15s ease,
    opacity 0.15s ease,
    filter 0.15s ease,
    box-shadow 0.15s ease;
}

/* 生成锚 glyph（源 94×106）：currentColor 上色 + mask 成形。
   20×22：28/32/36 按钮里占 ~62%，纯线条锚需要足够 box 才不显单薄（旧 15×17 偏小）。 */
.dock-generate-btn__glyph {
  display: block;
  width: 20px;
  height: 22px;
  background: currentColor;
  -webkit-mask: url('@/assets/icons/anchor-generate.png') center / contain no-repeat;
  mask: url('@/assets/icons/anchor-generate.png') center / contain no-repeat;
}

/* 发送箭头 glyph（源 33×31，用户截图抠图）：composer 发送键专用档 */
.dock-generate-btn__glyph--send {
  width: 16px;
  height: 15px;
  -webkit-mask-image: url('@/assets/icons/send-arrow.png');
  mask-image: url('@/assets/icons/send-arrow.png');
}

.dock-generate-btn:hover:not(:disabled) {
  filter: brightness(1.06);
  transform: scale(1.05);
}

.dock-generate-btn:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.dock-generate-btn.is-generating {
  /* 2026-11-04 移动端复测②用户裁决：停止态保持黑白，且**圆盘必须与发送态同底可见**——
     旧实现把盘底换成 surface-raised（深色主题下与输入条几乎同色）⇒ 圆盘隐形、
     只剩一个浮块，「整个视觉效果只看到块了」。现盘底/投影与空闲态同源（hi 家族，
     随主题黑白翻转），仅 glyph 由发送箭头换为停止方块。 */
  background: var(--lnk-hi-bg);
  color: var(--lnk-hi-text);
  opacity: 1 !important;
  pointer-events: auto !important;
  cursor: pointer;
}

.dock-generate-btn.is-generating:hover:not(:disabled) {
  filter: brightness(1.15);
}

.dock-generate-btn--sm { width: 28px; height: 28px; }
.dock-generate-btn--md { width: 32px; height: 32px; }
.dock-generate-btn--lg { width: 36px; height: 36px; }
</style>
