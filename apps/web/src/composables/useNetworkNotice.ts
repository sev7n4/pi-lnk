import { onMounted, onUnmounted } from 'vue'
import { useDockNoticeStore, type DockNoticeInput } from '@/stores/dockNotice'
import { checkRuntimeHealthViaNest } from '@/components/agent/streamRecovery'

/** 断网常驻卡 id（同 id 直接替换，避免重复堆叠） */
export const NETWORK_OFFLINE_ID = 'network-offline'
/** 恢复提示卡 id */
export const NETWORK_RECOVERED_ID = 'network-recovered'

/** 断网：黄色常驻卡（ttl 0 = 不自动消失，等恢复时显式 dismiss） */
const OFFLINE_NOTICE: DockNoticeInput = {
  id: NETWORK_OFFLINE_ID,
  tone: 'warning',
  title: '网络连接已断开',
  message: '生成进度已自动保存，网络恢复后将自动继续。',
  ttl: 0,
}

/** 恢复 + 服务健康：绿色卡，5s 自动消失（播报式，不增加操作负担） */
const RECOVERED_OK_NOTICE: DockNoticeInput = {
  id: NETWORK_RECOVERED_ID,
  tone: 'success',
  title: '网络已恢复',
  message: '正在继续未完成的任务。',
  ttl: 5000,
}

/** 恢复 + 服务仍不可达：黄色卡（常驻，等用户手动重试） */
const RECOVERED_DEGRADED_NOTICE: DockNoticeInput = {
  id: NETWORK_RECOVERED_ID,
  tone: 'warning',
  title: '网络已恢复',
  message: '但生成服务暂不可达，请稍后重试。',
  ttl: 0,
}

/**
 * 纯决策（无副作用，可单测）：给定连接状态从 `fromOnline` 变为 `toOnline`，
 * 以及恢复探测到的服务健康度，返回应推送到 dock 的通知列表。
 *
 * 规则：
 * - 离线（toOnline=false）：仅在「先前在线」时推常驻黄色卡
 * - 恢复在线（toOnline=true 且先前离线）：健康 → 绿色成功卡；不健康/未探明 → 黄色降级卡
 * - 始终在线或无变化：空（不刷屏）
 */
export function planNetworkNotice(
  fromOnline: boolean,
  toOnline: boolean,
  healthOk: boolean | null,
): DockNoticeInput[] {
  const out: DockNoticeInput[] = []
  if (!toOnline) {
    if (fromOnline) out.push(OFFLINE_NOTICE)
    return out
  }
  if (!fromOnline) {
    out.push(healthOk === true ? RECOVERED_OK_NOTICE : RECOVERED_DEGRADED_NOTICE)
  }
  return out
}

/**
 * 连接级故障的主动通知（针对 ②/③ 的「恢复提示」诉求，2026-10-21）。
 *
 * - 监听 `window` 的 `online` / `offline` 事件 + 初始 `navigator.onLine`
 * - 断网 → 常驻黄色卡（明确「进度已保存」，降低焦虑）
 * - 恢复 → 真实健康探测（`checkRuntimeHealthViaNest`）→ 通过弹绿色卡并回调 `onRecovered`
 *   （由调用方决定续跑/重试，做到「续跑而非重发」）
 *
 * 仅在组件挂载一次（AgentSideRail 单例），卸载时移除监听。
 */
export function useNetworkNotice(opts: { onRecovered?: () => void } = {}) {
  const dock = useDockNoticeStore()
  let lastOnline = typeof navigator !== 'undefined' ? navigator.onLine : true

  function emitFor(fromOnline: boolean, toOnline: boolean, healthOk: boolean | null) {
    for (const n of planNetworkNotice(fromOnline, toOnline, healthOk)) {
      dock.pushNotice(n)
    }
  }

  function handleOffline() {
    if (!lastOnline) return
    lastOnline = false
    emitFor(true, false, null)
  }

  async function handleOnline() {
    if (lastOnline) return
    lastOnline = true
    const health = await checkRuntimeHealthViaNest()
    const healthOk = health?.ok ?? null
    // 恢复时先清掉常驻的断网卡，再弹恢复卡
    dock.dismiss(NETWORK_OFFLINE_ID)
    emitFor(false, true, healthOk)
    if (healthOk === true) opts.onRecovered?.()
  }

  onMounted(() => {
    lastOnline = typeof navigator !== 'undefined' ? navigator.onLine : true
    if (!lastOnline) handleOffline()
    if (typeof window !== 'undefined') {
      window.addEventListener('offline', handleOffline)
      window.addEventListener('online', handleOnline)
    }
  })

  onUnmounted(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
    }
  })

  return { handleOffline, handleOnline }
}
