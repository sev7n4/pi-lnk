<script setup lang="ts">
import { computed, ref } from 'vue'

/**
 * SEL-REF 指代回执（R-S8）。
 *
 * 为什么是确定性 UI 而不是让模型自述：回执是**担保**，只能由客观事实源（本轮请求确实
 * 携带了哪些 node id）渲染；让模型说等于让生成方兼任被验证方。本仓已实测「模型能逐字
 * 复述指令但不会照做」（docs/2026-10-02-prompt-engineering-audit.html:141）。
 * 判据见 AgentSideRail.vue:223-225 ——「一个事件就够，比赌模型自觉可靠得多」。
 *
 * `nodeIds` 必须是**发送瞬间冻结**的快照（见 AgentSideRail 的 `lastBinding`），
 * 不可用发送后的实时选中态 —— 否则用户改选后回执会与实际发出的内容不符。
 */
const props = defineProps<{
  nodeIds: string[]
  nodes: Array<{ id: string; type: string; title?: string }>
}>()

const open = ref(false)

const rows = computed(() =>
  props.nodeIds.map((id) => {
    const n = props.nodes.find((x) => x.id === id)
    return { id, type: n?.type ?? '未知', title: n?.title ?? '' }
  }),
)
</script>

<template>
  <div v-if="nodeIds.length" class="sel-ref-chip" data-testid="selection-binding-chip">
    <button
      data-testid="binding-toggle"
      class="sel-ref-chip__toggle"
      type="button"
      @click="open = !open"
    >
      已绑定 {{ nodeIds.length }} 个选中节点
    </button>
    <ul v-if="open" class="sel-ref-chip__list">
      <li v-for="r in rows" :key="r.id" class="sel-ref-chip__row">
        {{ r.id }} · {{ r.type }}<template v-if="r.title"> · {{ r.title }}</template>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.sel-ref-chip {
  font-size: 12px;
  line-height: 1.6;
  margin: 4px 0 2px;
}
.sel-ref-chip__toggle {
  background: var(--neo-hover-bg);
  color: var(--neo-text-secondary);
  border: 1px solid var(--neo-border-strong);
  border-radius: 8px;
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
}
.sel-ref-chip__toggle:hover {
  border-color: color-mix(in srgb, var(--neo-text-primary) 22%, var(--neo-border));
  color: var(--neo-text-primary);
}
.sel-ref-chip__list {
  margin: 4px 0 0;
  padding-left: 18px;
  color: var(--neo-text-secondary);
}
.sel-ref-chip__row {
  word-break: break-all;
}
</style>
