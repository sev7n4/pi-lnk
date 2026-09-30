<script setup lang="ts">
import { onMounted, ref } from 'vue'

const props = defineProps<{ source: string }>()
const rendered = ref(false)
const el = ref<HTMLDivElement | null>(null)
let renderId = 0

/** P2#8：mermaid 懒加载渲染。渲染成功前显示源码（衔接旧行为、无空白期）；
 * 非法源码/加载失败保持源码形态（降级即现状）。 */
onMounted(async () => {
  try {
    const mermaid = (await import('mermaid')).default
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
    const id = `agent-mermaid-${++renderId}`
    const { svg } = await mermaid.render(id, props.source)
    if (el.value) {
      el.value.innerHTML = svg
      rendered.value = true
    }
  } catch {
    // 渲染失败：保持 pre 源码（现状形态），不阻塞卡片其余内容
  }
})
</script>

<template>
  <div v-show="rendered" ref="el" class="agent-mermaid text-[var(--neo-fg)]" data-testid="mermaid-svg" />
  <pre
    v-if="!rendered"
    class="whitespace-pre-wrap text-[10px] leading-relaxed text-[var(--neo-muted)]"
    data-testid="mermaid-fallback"
  >{{ source }}</pre>
</template>
