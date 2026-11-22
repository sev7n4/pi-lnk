<script setup lang="ts">
/**
 * 授权自动生成图标（盾牌 + 闪电）——对话页 composer 工具行与提议卡**共用同一枚图形**。
 *
 * ⭐ 设计口径（2026-11-23 UI 迭代，规格 §3.4 修订）：
 * 1. **一套图形贯穿两处**：提议卡里 = 开启入口；composer 工具行里 = 状态 + 刹车。
 *    用户跨位置也能认出同一个能力。
 * 2. **形状避让**：闪电已被积分 chip 占用（`data-test="credit-chip"`）、推子已被
 *    参数微调占用 ⇒ 用「盾牌（权限护栏）+ 闪电（自动执行）」组合。
 * 3. **颜色语义**：恒用琥珀 `--lnk-warning`（注意，agent 正在替你行动）；
 *    不用红色 —— 红色在 iOS/macOS 语义里 = 错误/破坏性，而授权是用户自己的选择。
 *    未开启也用琥珀描边 ⇒ 入口自带「警示色动作」的可发现性，不会被中性灰淹没。
 * 4. **状态可辨**：未开启 = 线框（shield 描边 + bolt 描边）；已开启 = 实心
 *    （shield 琥珀柔底 + bolt 实心琥珀）⇒ 同一图形一眼可读出开关状态。
 * 5. **零新令牌**：全部走既有 `--lnk-warning` / `--lnk-warning-bg`（双主题已存在）。
 *
 * 纯展示组件：不持状态、不发事件（状态由调用方传入）。
 */
withDefaults(defineProps<{ on?: boolean; size?: number }>(), { on: false, size: 15 })
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    class="auto-approve-glyph"
    :class="{ 'is-on': on }"
  >
    <path
      class="auto-approve-glyph-shield"
      d="M12 3l7 3v5.5c0 4.3-2.9 7.6-7 8.5-4.1-.9-7-4.2-7-8.5V6l7-3z"
    />
    <path
      class="auto-approve-glyph-bolt"
      d="M12.6 8.4l-2.3 3.6h2.7l-1.4 3.4 3-4h-2.6l1-3z"
    />
  </svg>
</template>

<style scoped>
.auto-approve-glyph {
  display: block;
  flex: none;
  color: var(--lnk-warning);
}

/* 未开启：线框（盾牌描边 + 闪电描边）——琥珀色动作入口，可发现但不喧宾夺主 */
.auto-approve-glyph-shield {
  fill: none;
  stroke: var(--lnk-warning);
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.auto-approve-glyph-bolt {
  fill: none;
  stroke: var(--lnk-warning);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 已开启：实心（盾牌琥珀柔底 + 闪电实心）——状态徽标 */
.auto-approve-glyph.is-on .auto-approve-glyph-shield {
  fill: var(--lnk-warning-bg);
}

.auto-approve-glyph.is-on .auto-approve-glyph-bolt {
  fill: var(--lnk-warning);
  stroke: none;
}
</style>
