<template>
  <!--
    英雄资产位：品牌渐变（--lnk-accent-gradient）在此承载「创造发生」的大面情绪
    （墨鱼锚 IP：显色时刻只给创造动作）。文字压 bg-dim/25 恒黑层，
    白字双主题对全渐变 ≥ AA 4.5（守卫见 design-token.test.ts 品牌锚点段）。
  -->
  <div class="relative overflow-hidden rounded-2xl border border-overlay/[0.08] bg-brand-gradient">
    <div aria-hidden="true" class="absolute inset-0 bg-dim/25"></div>
    <div class="relative flex min-h-[200px] items-center justify-center p-8">
      <div class="text-center text-fg-on">
        <p class="text-sm uppercase tracking-widest opacity-90">沉浸式创作</p>
        <p class="mt-2 font-display text-2xl font-semibold">AI 无限画布 · 图像 · 视频 · 漫剧</p>
      </div>
    </div>
  </div>
</template>
