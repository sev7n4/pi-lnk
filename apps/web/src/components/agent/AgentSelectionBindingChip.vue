<script setup lang="ts">
import { computed, ref } from 'vue'

/**
 * SEL-REF 指代回执（R-S8）。
 *
 * 为什么是确定性 UI 而不是让模型自述：回执是**担保**，只能由客观事实源渲染；
 * 让模型说等于让生成方兼任被验证方。本仓已实测「模型能逐字复述指令但不会照做」
 * （docs/2026-10-02-prompt-engineering-audit.html:141）。
 * 判据见 AgentSideRail.vue:223-225 ——「一个事件就够，比赌模型自觉可靠得多」。
 *
 * ⚠️ `confirmed` 是**唯一数据源**（评审 C1）：服务端 `selection_binding` 事件带来的
 * 「实际注入了哪些节点（含 type/title）」。前端读不到 Nest 的 `SEL_REF_ENABLED`，
 * 若按本地冻结的 id 自行推断，则 V1 默认态（off）下用户照样看到「已绑定 N 个」，
 * 而提示词里 0 字节注入 —— 担保说谎比没有担保更糟。
 * `nodeIds` / `nodes` 只作**发送瞬间的本地留档**（审计与降级文案），不参与计数与渲染。
 */
const props = defineProps<{
  nodeIds: string[]
  nodes: Array<{ id: string; type: string; title?: string }>
  /** 服务端确认：[{ id, type, title }]。空数组 = 未注入 ⇒ 整块不渲染。 */
  confirmed: Array<{ id: string; type: string; title: string }>
}>()

const open = ref(false)

const rows = computed(() => props.confirmed)
</script>

<template>
  <div v-if="confirmed.length" class="sel-ref-chip" data-testid="selection-binding-chip">
    <button
      data-testid="binding-toggle"
      class="sel-ref-chip__toggle"
      type="button"
      @click="open = !open"
    >
      已绑定 {{ confirmed.length }} 个选中节点
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
