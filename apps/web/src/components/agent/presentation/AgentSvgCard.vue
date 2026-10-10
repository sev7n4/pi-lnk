<script setup lang="ts">
/**
 * 只读 SVG 卡片（spec §4.5 / §4.7）。
 *
 * 输入是 agent 产出的不可信 SVG ⇒ 必须经 {@link sanitizeSvg} 白名单净化后才注入。
 * 前端无 CSP、iframe 无 sandbox 兜底，净化是唯一防线，不做「渲染失败就显示原文」——
 * 降级只走 `<pre>` 文本通道（Vue 插值转义，不产生 DOM 节点）。
 *
 * ⚠️ 本组件**不含 stepper**：svg_card 走 executionEvents 落库恢复（无 stepper 字段），
 * 不能塞进 AgentPresentationHost 的 stepper 布局。
 */
import { computed } from 'vue'
import { sanitizeSvg } from './svg-sanitize'

const props = defineProps<{
  svg: string
  title?: string
  annotations?: Array<{ nodeId: string; text: string; severity: 'info' | 'warn' }>
}>()

const clean = computed(() => sanitizeSvg(props.svg))

/**
 * 空串 = 服务端 `presentResult` 因超 SVG_MAX_CHARS 把载荷整块丢弃（不切片，切片会产出
 * 不可解析 XML）。这与「解析失败」是两回事，必须给出**可见**的降级内容：否则用户看到
 * 一张空卡片，无法与渲染失败区分。
 */
const isDiscarded = computed(() => props.svg.trim() === '')
</script>

<template>
  <figure
    class="agent-svg-card rounded-lg border border-[var(--neo-border)] bg-[var(--neo-panel-bg-rgba)] p-3"
    data-testid="svg-card-figure"
  >
    <figcaption v-if="title" class="mb-2 text-xs font-medium text-[var(--neo-text)]">
      {{ title }}
    </figcaption>

    <div
      v-if="clean.ok"
      class="agent-svg-card__canvas text-[var(--neo-text)]"
      data-testid="svg-card"
      v-html="clean.svg"
    />
    <p
      v-else-if="isDiscarded"
      class="text-[10px] leading-relaxed text-[var(--neo-text-muted)]"
      data-testid="svg-card-discarded"
    >
      画布视图卡片过大已被丢弃（超出可渲染体积上限），请缩小节点范围后重试。
    </p>
    <pre
      v-else
      class="whitespace-pre-wrap text-[10px] leading-relaxed text-[var(--neo-text-muted)]"
      data-testid="svg-card-fallback"
    >{{ svg }}</pre>

    <ul v-if="annotations?.length" class="mt-2 space-y-0.5 text-[10px]">
      <li
        v-for="a in annotations"
        :key="a.nodeId"
        :data-severity="a.severity"
        :class="
          a.severity === 'warn'
            ? 'font-medium text-danger'
            : 'text-[var(--neo-text-muted)]'
        "
      >
        {{ a.text }}
      </li>
    </ul>
  </figure>
</template>
