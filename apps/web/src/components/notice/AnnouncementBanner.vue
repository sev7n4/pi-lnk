<script setup lang="ts">
// 调价公告横幅（设计稿 §4 首次呈现）：登录后顶部显性卡片——涨价类公告必须显性，
// 不能只藏铃铛。只展示最新一条未读；「我知道了」标记已读，✕ 仅收起（误关可从铃铛找回）。
import { computed, ref } from 'vue'
import { ElButton, ElTable, ElTableColumn } from 'element-plus'
import { announcementApi, type AnnouncementDetail } from '@/services/announcement-api'
import { useAnnouncements } from '@/composables/useAnnouncements'

const { items, refresh, markRead } = useAnnouncements()

const dismissed = ref(false)
const expanded = ref(false)
const marking = ref(false)
const detail = ref<AnnouncementDetail | null>(null)
const detailLoading = ref(false)

const banner = computed(() => items.value.find((a) => !a.read) ?? null)

async function toggleExpanded(): Promise<void> {
  expanded.value = !expanded.value
  if (expanded.value && banner.value && !detail.value) {
    detailLoading.value = true
    try {
      const res = await announcementApi.detail(banner.value.id)
      detail.value = res.data.data
    } finally {
      detailLoading.value = false
    }
  }
}

async function acknowledge(): Promise<void> {
  if (!banner.value || marking.value) return
  marking.value = true
  try {
    await markRead(banner.value.id)
    banner.value.read = true
    expanded.value = false
    void refresh()
  } finally {
    marking.value = false
  }
}

// ElTable scope slot row 是 DefaultRow（Record<string, unknown> 形态），入口先窄化
function pctText(row: unknown): string {
  const i = row as { pct: number | null; kind: string }
  if (i.pct == null) return '新增'
  const p = Math.round(i.pct * 100)
  return `${p > 0 ? '+' : ''}${p}%`
}

function pctClass(row: unknown): string {
  const i = row as { kind: string }
  if (i.kind === 'increase') return 'text-danger' // 涨红（A 股口径）
  if (i.kind === 'decrease') return 'text-success' // 降绿
  return 'text-fg-2'
}
</script>

<template>
  <div
    v-if="banner && !dismissed"
    data-testid="announcement-banner"
    class="mx-auto my-2 w-[min(880px,94vw)] rounded-xl border px-4 py-3 shadow-sm"
    style="border-color: var(--primary, rgba(99, 102, 241, 0.4)); background: var(--surface, #fff);"
  >
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-sm font-semibold text-fg">
          <span class="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style="background: var(--primary, #6366f1);" />
          {{ banner.title }}
        </p>
        <p v-if="banner.summary" class="mt-1 text-xs text-fg-2">{{ banner.summary }}</p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <ElButton size="small" text type="primary" data-testid="announcement-expand" @click="toggleExpanded">
          {{ expanded ? '收起明细' : '查看明细' }}
        </ElButton>
        <ElButton size="small" type="primary" :loading="marking" data-testid="announcement-ack" @click="acknowledge">
          我知道了
        </ElButton>
        <button type="button" class="banner-close" aria-label="收起" @click="dismissed = true">✕</button>
      </div>
    </div>
    <div v-if="expanded" class="mt-3">
      <p v-if="detailLoading" class="text-xs text-fg-2">加载明细…</p>
      <ElTable v-else-if="detail" :data="detail.payload" size="small" data-testid="announcement-detail-table">
        <ElTableColumn prop="displayName" label="模型" min-width="120" />
        <ElTableColumn prop="specLabel" label="档位" min-width="130" />
        <ElTableColumn label="旧积分" width="70">
          <template #default="{ row }">{{ row.from }}</template>
        </ElTableColumn>
        <ElTableColumn label="新积分" width="70">
          <template #default="{ row }">{{ row.to }}</template>
        </ElTableColumn>
        <ElTableColumn label="变化" width="80">
          <template #default="{ row }">
            <span :class="pctClass(row)">{{ row.kind === 'decrease' ? '↓' : row.kind === 'increase' ? '↑' : '' }}{{ pctText(row) }}</span>
          </template>
        </ElTableColumn>
      </ElTable>
    </div>
  </div>
</template>

<style scoped>
.banner-close {
  color: var(--fg-3, rgba(0, 0, 0, 0.4));
  font-size: 12px;
  padding: 2px 4px;
}
.banner-close:hover {
  color: var(--fg, rgba(0, 0, 0, 0.8));
}
.text-danger {
  color: var(--danger, #ef4444);
}
.text-success {
  color: var(--success, #16a34a);
}
.text-fg-2 {
  color: var(--fg-2, rgba(0, 0, 0, 0.6));
}
</style>
