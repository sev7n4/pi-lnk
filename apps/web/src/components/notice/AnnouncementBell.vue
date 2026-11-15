<script setup lang="ts">
// 调价公告：铃铛（未读 badge）+ 公告中心抽屉（设计稿 §4 常驻入口）。
// 明细表列：模型 / 档位 / 旧积分 / 新积分 / 变化%（涨红↑ 降绿↓，A 股口径）。
// ⛔ 颜色一律 Tailwind 语义类（theme-usage 棘轮：品牌色与 rgba 字面量基线 0 不得增加）。
import { ref, watch } from 'vue'
import { ElDrawer, ElTable, ElTableColumn, ElTag } from 'element-plus'
import { announcementApi, type AnnouncementDetail, type AnnouncementListItem } from '@/services/announcement-api'
import { useAnnouncements } from '@/composables/useAnnouncements'

const { items, unreadCount, refresh, markRead } = useAnnouncements()

const drawerOpen = ref(false)
const detail = ref<AnnouncementDetail | null>(null)
const detailLoading = ref(false)

watch(drawerOpen, (open) => {
  if (open) void refresh()
})

async function openDetail(a: AnnouncementListItem): Promise<void> {
  detailLoading.value = true
  detail.value = null
  try {
    const res = await announcementApi.detail(a.id)
    detail.value = res.data.data
    if (!a.read) {
      await markRead(a.id)
      a.read = true
      void refresh()
    }
  } finally {
    detailLoading.value = false
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

function pctArrow(row: unknown): string {
  const i = row as { kind: string }
  return i.kind === 'decrease' ? '↓' : i.kind === 'increase' ? '↑' : ''
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div class="relative">
    <button
      type="button"
      class="inline-flex h-8 w-8 items-center justify-center rounded-lg text-fg-2 transition hover:bg-surface-elevated hover:text-fg"
      data-testid="announcement-bell"
      aria-label="公告"
      @click="drawerOpen = true"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true" class="h-[1.15rem] w-[1.15rem]">
        <path stroke-linecap="round" stroke-linejoin="round" d="M14.857 17.082a23.85 23.85 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.26 24.26 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
      </svg>
      <span
        v-if="unreadCount > 0"
        class="absolute -top-0.5 -right-1 rounded-full bg-danger-bg px-1.5 py-0.5 text-[10px] leading-none font-bold text-danger"
        data-testid="announcement-badge"
      >{{ unreadCount > 99 ? '99+' : unreadCount }}</span>
    </button>

    <ElDrawer v-model="drawerOpen" title="公告中心" size="460px" data-testid="announcement-drawer">
      <div v-if="items.length === 0" class="py-10 text-center text-sm text-fg-2">暂无公告</div>
      <div class="flex flex-col gap-3">
        <button
          v-for="a in items"
          :key="a.id"
          type="button"
          class="w-full rounded-lg border p-3 text-left transition"
          :class="a.read ? 'border-line-subtle bg-surface-card hover:bg-surface-elevated' : 'border-accent bg-surface-card hover:bg-surface-elevated'"
          @click="openDetail(a)"
        >
          <div class="flex items-center gap-2">
            <ElTag v-if="!a.read" size="small" type="danger" effect="light">未读</ElTag>
            <span class="text-sm font-medium text-fg">{{ a.title }}</span>
          </div>
          <p v-if="a.summary" class="mt-1 text-xs text-fg-2">{{ a.summary }}</p>
          <p class="mt-1 text-xs text-fg-3">{{ fmtTime(a.publishedAt) }}</p>
        </button>
      </div>

      <div v-if="detail" class="mt-4 border-t border-line-subtle pt-4">
        <h4 class="text-sm font-semibold text-fg">{{ detail.title }}</h4>
        <p class="mb-2 text-xs text-fg-2">{{ detail.summary }}</p>
        <ElTable :data="detail.payload" size="small" data-testid="announcement-detail-table">
          <ElTableColumn prop="displayName" label="模型" min-width="120" />
          <ElTableColumn prop="specLabel" label="档位" min-width="120" />
          <ElTableColumn label="旧积分" width="70">
            <template #default="{ row }">{{ row.from }}</template>
          </ElTableColumn>
          <ElTableColumn label="新积分" width="70">
            <template #default="{ row }">{{ row.to }}</template>
          </ElTableColumn>
          <ElTableColumn label="变化" width="80">
            <template #default="{ row }">
              <span :class="pctClass(row)">{{ pctArrow(row) }}{{ pctText(row) }}</span>
            </template>
          </ElTableColumn>
        </ElTable>
      </div>
      <div v-else-if="detailLoading" class="mt-4 text-center text-xs text-fg-2">加载明细…</div>
    </ElDrawer>
  </div>
</template>
