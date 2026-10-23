<script setup lang="ts">
/**
 * tone: 'signature' 用于深海墨底签名画面——placeholder 必须换 on-signature 令牌，
 * 否则浅色主题下 text-fg-3（深色）压深底会静默不可见（P0 计划 Review Focus #1）。
 * signature 模式下不再渲染「开始创作」按钮：2026-10-21 用户裁定「入口是锚」，
 * 主 CTA 收敛为 SignatureHero 的 ink-anchor（品牌生成锚 glyph），此处只承担输入，
 * Enter 仍可提交。避免「输入框一个入口 + 锚一个入口」的双 CTA 稀释锚的指引性。
 */
withDefaults(defineProps<{ modelValue: string; tone?: 'default' | 'signature' }>(), {
  tone: 'default',
})
const emit = defineEmits<{ 'update:modelValue': [v: string]; create: [] }>()
</script>

<template>
  <div
    class="flex items-center gap-2 border p-2"
    :class="
      tone === 'signature'
        ? 'lnk-launcher-signature rounded-2xl p-3'
        : 'rounded-xl border-overlay/12 bg-surface-sunken'
    "
  >
    <input
      :value="modelValue"
      type="text"
      class="min-w-0 flex-1 bg-transparent outline-none"
      :class="
        tone === 'signature'
          ? 'px-3 py-3 text-lg text-[color:var(--lnk-text-on-signature)] placeholder:text-[color:var(--lnk-text-on-signature-muted)]'
          : 'px-2 py-2 text-base text-fg placeholder:text-fg-3 focus-visible:ring-2 focus-visible:ring-[var(--lnk-border-focus)]'
      "
      placeholder="描述你的创意…"
      aria-label="描述你的创意，按下 Enter 开始创作"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter="emit('create')"
    />
    <button
      v-if="tone !== 'signature'"
      type="button"
      class="btn-primary"
      @click="emit('create')"
    >
      开始创作
    </button>
  </div>
</template>

<style scoped>
/* 签名面（深海墨底，主题不变式）上的输入容器：容器面与描边都必须主题不变。
   2026-10-22 修复前用 bg-surface-sunken + border-overlay/12——两者都随主题翻转，
   浅色主题下容器翻成浅面 #e6e9f0，而输入文字/placeholder 是不变的 on-signature
   浅色 ⇒ 白字压浅面（1.05:1）静默不可见。现改走 --lnk-surface-on-signature
   （恒深井）+ on-signature 混色描边；深色主题下与旧观感一致（ink-1050 同值）。 */
.lnk-launcher-signature {
  background: var(--lnk-surface-on-signature);
  border-color: color-mix(in srgb, var(--lnk-text-on-signature) 14%, transparent);
  /* 「井」不是框：内阴影给出墨池的深度，靠凹进去读出来，而不是靠描边加粗读出来。
     圆角同步放大到 rounded-2xl——签名面上的唯一输入位要有被斟满的分量。 */
  box-shadow:
    inset 0 1px 2px color-mix(in srgb, var(--lnk-ink-1000) 55%, transparent),
    inset 0 0 0 1px color-mix(in srgb, var(--lnk-ink-1000) 30%, transparent);
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}

.lnk-launcher-signature:hover {
  border-color: color-mix(in srgb, var(--lnk-text-on-signature) 26%, transparent);
}

/* 聚焦（2026-10-22 用户反馈 ②「点击时出现的紫色内框不好看」）：
   描边升到 44% + 一圈 on-signature 中性柔雾（10%）。
   ⛔ signature 分支**不接** --lnk-border-focus 的紫色 ring——紫是锚的专属强调色
   （accent 单区域纪律），输入框抢紫会让「落款」失去唯一性；紫环也和恒深墨底打架。
   紫 ring 只留在 default（浅底）分支当键盘可达性提示。 */
.lnk-launcher-signature:focus-within {
  border-color: color-mix(in srgb, var(--lnk-text-on-signature) 44%, transparent);
  box-shadow:
    inset 0 1px 2px color-mix(in srgb, var(--lnk-ink-1000) 55%, transparent),
    0 0 0 3px color-mix(in srgb, var(--lnk-text-on-signature) 10%, transparent);
}
</style>
