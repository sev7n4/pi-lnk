<script setup lang="ts">
/**
 * 移动端三联叙事行（IA v4，2026-10-23 用户裁定「窄屏也要讲三联」）。
 *
 * 桌面签名面（SignatureHero）的叙事骨架是「左对话 → 中锚 → 右画布」，但窄屏的
 * stage 竖排后「对话 / 画布」两个标签随 `hidden lg:block` 整体消失 ⇒ 叙事断档，
 * 只剩锚一个意象。本组件把同一读序压成一行紧凑图标 legend，补回窄屏叙事。
 *
 * 设计纪律（从 AgentSideRail 旧版 triptych 迁入时的固化）：
 * ⛔ 横向一行：竖排会丢掉「左→中→右」的读序，而那正是这条动线唯一要传达的东西；
 * ⛔ 中锚是**装饰叙事**（span 不是 button）：真创作入口由宿主自己提供
 *    （hero 的 168px 落款印章）——同一屏出现两个「开始创作」会打架；
 * ⛔ 令牌分 tone：`panel` 走随主题翻转的常规令牌（text-muted / accent），
 *    `signature` 走恒深签名面专用的 on-signature 家族。两族混用会重演
 *    「颜色放反」事故（面板令牌压恒深底 / 签名令牌压翻转面）；
 * ⛔ 禁裸字号：一律 --lnk-text-* 令牌（AgentSideRail 全域禁 10/11/12/13px）；
 * ⛔ 零动画：hero 的动效预算只有三处（粒子/墨滴/锚脉冲），本组件不外扩——
 *    叙事靠结构不靠动效；也因此无需 reduced-motion 守卫（没有可停的东西）。
 */
withDefaults(defineProps<{ tone?: 'panel' | 'signature' }>(), { tone: 'panel' })
</script>

<template>
  <div
    class="lnk-triptych-row"
    :class="`lnk-triptych-row--${tone}`"
    data-testid="triptych-row"
    aria-hidden="true"
  >
    <!-- aria-hidden：三个标签是视觉读序的压缩复述，语义由宿主的 h1 / 输入框 /
         创作按钮 / 文案承担；对读屏用户重复一遍「对话 锚定 画布」只是噪音。
         ⚠️ 注释必须待在根元素**内部**：顶层注释会让 Vue 把根判成 fragment，
         VTU 的 element 解析（classes/attributes）随之坏掉。 -->
    <span class="lnk-triptych-row__node">
      <svg class="lnk-triptych-row__icon" viewBox="0 0 16 14" aria-hidden="true">
        <path d="M2.7 2h10.6v6.4H7.2l-2.9 2.6V8.4H2.7z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
      </svg>
      对话
    </span>
    <span class="lnk-triptych-row__anchor">
      <span class="lnk-triptych-row__glyph" />
      锚定
    </span>
    <span class="lnk-triptych-row__node">
      <svg class="lnk-triptych-row__icon" viewBox="0 0 16 14" aria-hidden="true">
        <rect x="2.4" y="2.2" width="5" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
        <rect x="8.6" y="2.2" width="5" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
        <rect x="2.4" y="7.8" width="5" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
        <rect x="8.6" y="7.8" width="5" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
      </svg>
      画布
    </span>
  </div>
</template>

<style scoped>
/* 横向一行是三联的命门：三节点等距排开，「左→中→右」的读序才成立 */
.lnk-triptych-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
}

.lnk-triptych-row__node {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
}

.lnk-triptych-row__icon {
  width: 18px;
  height: 16px;
}

/* 中锚作视觉重心：accent 上色 + 500 字重，压过左右两个 muted 节点 */
.lnk-triptych-row__anchor {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  font-weight: 500;
}

/* 品牌生成锚 glyph（源 94×106）：currentColor 上色 + mask 成形，
   与 hero 落款印章、AgentSideRail 历史实现同源同形 */
.lnk-triptych-row__glyph {
  display: block;
  width: 24px;
  height: 28px;
  background: currentColor;
  -webkit-mask: url('@/assets/icons/anchor-generate.png') center / contain no-repeat;
  mask: url('@/assets/icons/anchor-generate.png') center / contain no-repeat;
}

/* ===== tone：面板态（默认）=====
   挂在随主题翻转的普通面板上 ⇒ 只用常规令牌。
   ⛔ 禁 on-signature 家族：那是恒深签名面专用，压在翻转面上会「颜色放反」。 */
.lnk-triptych-row--panel .lnk-triptych-row__node {
  color: var(--lnk-text-muted);
}

.lnk-triptych-row--panel .lnk-triptych-row__anchor {
  color: var(--lnk-accent);
}

/* ===== tone：签名面态 =====
   恒深签名底（--lnk-surface-signature 两主题同值）专用 ⇒ on-signature 家族。
   ⛔ 禁 --lnk-text-muted / --lnk-accent：它们随主题翻转，浅色主题下压恒深底
   会静默降对比度（text-muted 浅色是 Ink 系深灰，on #131318 约 1.9:1）。 */
.lnk-triptych-row--signature .lnk-triptych-row__node {
  color: var(--lnk-text-on-signature-muted);
}

.lnk-triptych-row--signature .lnk-triptych-row__anchor {
  color: var(--lnk-accent-on-signature);
}
</style>
