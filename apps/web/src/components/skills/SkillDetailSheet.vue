<script setup lang="ts">
/**
 * 技能只读详情壳（UI 美化 §4.5）：复用 MobileSheet 基座，消费调用点**已加载**的数据，
 * 零 fetch / 零新字段 / 零正文伪造。完整 SKILL.md 正文由 P4 上游补数据后再接（规格 §8）。
 */
import BrandPatternAvatar from '@/components/account/BrandPatternAvatar.vue'
import MobileSheet from '@/components/mobile/MobileSheet.vue'

withDefaults(
  defineProps<{
    name: string
    desc?: string
    kind: 'builtin' | 'custom' | 'market'
    source?: string
    version?: string
    trustLevel?: string
    enabled?: boolean
  }>(),
  { desc: '', enabled: false },
)

const emit = defineEmits<{ close: [] }>()

const KIND_LABEL: Record<'builtin' | 'custom' | 'market', string> = {
  builtin: '内置 · 平台提供 · 常开',
  custom: '用户自定义',
  market: '来自市场',
}
</script>

<template>
  <MobileSheet title="技能详情" :subtitle="KIND_LABEL[kind]" max-height="70vh" @close="emit('close')">
    <div class="detail-sheet" data-testid="skill-detail-sheet">
      <div class="detail-head">
        <BrandPatternAvatar :seed="name" :name="name" size="md" />
        <div class="min-w-0 flex-1">
          <h3 class="detail-name">{{ name }}</h3>
          <p class="detail-state">
            <template v-if="kind === 'builtin'">平台提供 · 常开 · 不可停用</template>
            <template v-else>{{ enabled ? '已启用 · 自动可用' : '已停用' }}</template>
          </p>
        </div>
      </div>

      <p class="detail-desc">{{ desc || '该技能暂无描述' }}</p>

      <dl v-if="kind !== 'builtin'" class="detail-meta">
        <div v-if="source" class="detail-meta-row"><dt>来源</dt><dd>{{ source }}</dd></div>
        <div v-if="version" class="detail-meta-row"><dt>版本</dt><dd>{{ version }}</dd></div>
        <div v-if="trustLevel" class="detail-meta-row"><dt>信任级别</dt><dd>{{ trustLevel }}</dd></div>
      </dl>

      <p class="detail-footnote">仅展示已登记信息；完整技能文档暂未提供。</p>
    </div>
  </MobileSheet>
</template>

<style scoped>
.detail-sheet { display: flex; flex-direction: column; gap: var(--lnk-space-3); padding-bottom: var(--lnk-space-3); }
.detail-head { display: flex; align-items: center; gap: var(--lnk-space-3); }
.detail-name { margin: 0; font-size: var(--lnk-text-md); font-weight: var(--lnk-weight-semibold); color: var(--lnk-text-primary); overflow-wrap: anywhere; }
.detail-state { margin: 2px 0 0; font-size: var(--lnk-text-2xs); color: var(--lnk-text-muted); }
.detail-desc { margin: 0; font-size: var(--lnk-text-sm); line-height: var(--lnk-lh-md); color: var(--lnk-text-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
.detail-meta { margin: 0; display: flex; flex-direction: column; gap: var(--lnk-space-2); }
.detail-meta-row { display: flex; gap: var(--lnk-space-3); font-size: var(--lnk-text-xs); }
.detail-meta-row dt { flex: none; width: 4em; color: var(--lnk-text-muted); }
.detail-meta-row dd { margin: 0; color: var(--lnk-text-primary); overflow-wrap: anywhere; }
.detail-footnote { margin: 0; padding-top: var(--lnk-space-2); border-top: 1px solid var(--lnk-border-subtle); font-size: var(--lnk-text-2xs); color: var(--lnk-text-muted); }
</style>
