import { defineStore } from 'pinia'
import { ref } from 'vue'
import { randomId } from '@lnkpi/shared'

/**
 * dock 上沿窄卡片通知中心（可复用）。
 *
 * 设计目标：一个统一入口承载「异常 / 提醒 / 通知 / 广告 / 新功能发布」等所有
 * 需要从 dock 上沿弹出的轻量卡片。单条 notice 形态：
 *  - tone：决定配色与默认 ttl（error/warning/info/success 自动消失；ad 常驻需手动关）
 *  - action：可选主操作按钮（onClick 或外链 href）
 *  - image：可选配图（广告 / 新功能主视觉）
 *
 * 卡片自底（dock 上沿）向上堆叠，最新一条贴着 dock 弹出。
 */
export type DockNoticeTone = 'error' | 'warning' | 'info' | 'success' | 'ad'

export interface DockNoticeAction {
  label: string
  href?: string
  onClick?: () => void
}

export interface DockNotice {
  id: string
  tone: DockNoticeTone
  title: string
  message: string
  action?: DockNoticeAction
  image?: string
  /** 自动消失毫秒数；0 = 常驻（如广告） */
  ttl: number
  createdAt: number
}

export interface DockNoticeInput {
  /** 指定稳定 id：同 id 直接替换（用于更新内容 / 重置 ttl，如常驻的「重连」卡） */
  id?: string
  tone?: DockNoticeTone
  title: string
  message: string
  action?: DockNoticeAction
  image?: string
  /** 覆盖该 tone 的默认 ttl */
  ttl?: number
}

/** 各 tone 的默认自动消失时长（ms） */
export const DEFAULT_TTL: Record<DockNoticeTone, number> = {
  error: 9000,
  warning: 9000,
  info: 6000,
  success: 5000,
  ad: 0,
}

export const useDockNoticeStore = defineStore('dockNotice', () => {
  const notices = ref<DockNotice[]>([])

  function pushNotice(input: DockNoticeInput): string {
    const tone = input.tone ?? 'info'
    const id = input.id ?? randomId()
    const ttl = input.ttl ?? DEFAULT_TTL[tone]
    const notice: DockNotice = {
      id,
      tone,
      title: input.title,
      message: input.message,
      action: input.action,
      image: input.image,
      ttl,
      createdAt: Date.now(),
    }
    // 指定 id：同 id 直接替换（用于更新内容 / 重置 ttl，如常驻的「重连」卡）
    const byId = notices.value.findIndex((n) => n.id === id)
    if (byId >= 0) {
      notices.value.splice(byId, 1)
    } else if (!input.id) {
      // 无 id 时按 tone+title+message 去重，避免刷屏（如连续多个同类失败）
      const dupIdx = notices.value.findIndex(
        (n) => n.tone === tone && n.title === notice.title && n.message === notice.message,
      )
      if (dupIdx >= 0) notices.value.splice(dupIdx, 1)
    }
    notices.value.push(notice)
    if (ttl > 0) {
      setTimeout(() => dismiss(id), ttl)
    }
    return id
  }

  function dismiss(id: string) {
    const idx = notices.value.findIndex((n) => n.id === id)
    if (idx >= 0) notices.value.splice(idx, 1)
  }

  function clear() {
    notices.value = []
  }

  return { notices, pushNotice, dismiss, clear }
})
