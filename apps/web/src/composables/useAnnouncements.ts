// apps/web/src/composables/useAnnouncements.ts
// 调价公告全局状态：单例 state + 60s 轮询（设计稿 §4）。未登录/401 静默——公告
// 永不影响页面可用性（判据 4）。两处消费（铃铛/横幅）共享同一份轮询，不双拉。
import { ref } from 'vue'
import { announcementApi, type AnnouncementListItem } from '@/services/announcement-api'
import { useAuthStore } from '@/stores/auth'

const POLL_INTERVAL_MS = 60_000

const items = ref<AnnouncementListItem[]>([])
const unreadCount = ref(0)
const loading = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null
let started = false

async function refresh(): Promise<void> {
  const auth = useAuthStore()
  if (!auth.isLoggedIn) {
    items.value = []
    unreadCount.value = 0
    return
  }
  loading.value = true
  try {
    const res = await announcementApi.list(false)
    items.value = res.data.data.items
    unreadCount.value = res.data.data.unreadCount
  } catch {
    // 401/网络异常静默：公告是增强信息，绝不阻塞页面
  } finally {
    loading.value = false
  }
}

function ensurePolling(): void {
  if (started) return
  started = true
  void refresh()
  pollTimer = setInterval(() => void refresh(), POLL_INTERVAL_MS)
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
    started = false
  }
}

export function useAnnouncements() {
  ensurePolling()
  return { items, unreadCount, loading, refresh, markRead: announcementApi.markRead, stopPolling }
}
