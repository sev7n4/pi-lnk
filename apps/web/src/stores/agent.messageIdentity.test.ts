// 本地消息 id 唯一性（multi-device Task 3 · R6）。
//
// 背景（生产取证，evidence.md §2 R6）：
//   本地消息 id 用 `msg-${Date.now()}` ⇒ **同一毫秒内的两条消息 id 相同**
//   （user 气泡 + assistant 气泡在同 tick 创建，插话气泡与正常发送更是高频同刻）。
//   撞 id ⇒ `AgentSideRail.vue` 的 `v-for :key="msg.id"` 出现重复 key
//   ⇒ Vue 复用错 DOM ⇒ 肉眼表现为「消息顺序乱 / 记录错乱」。
//
// 本文件钉住的是**行为**（id 互不相同 + 同一 tick 内也不相同），不是实现细节。
//
// ⚠️ 生产是 `http://119.29.173.89:8888`（**非安全上下文**）⇒ `crypto.randomUUID`
// 在那里**不可用**（[SecureContext] 限定）⇒ 兜底分支必须存在且必须被测到，
// 否则「本地开发（https/localhost）不撞、生产（http）撞」的坑会被漏掉。
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextLocalMessageId, useAgentStore } from './agent'

describe('本地消息 id 生成（multi-device Task 3 · R6）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('连续两次调用必须得到不同 id（同毫秒内也必须不同）', () => {
    const a = nextLocalMessageId()
    const b = nextLocalMessageId()
    expect(a).not.toBe(b)
  })

  it('同一 tick 内批量生成 1000 个 id 必须全部唯一（Date.now() 方案在这里必撞）', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i += 1) ids.add(nextLocalMessageId())
    expect(ids.size, '1000 次生成必须得到 1000 个不同 id').toBe(1000)
  })

  it('非安全上下文（crypto.randomUUID 不可用）时仍必须唯一 —— 生产就是这种环境', () => {
    // 模拟 http://（非安全上下文）：crypto.randomUUID 不存在。
    const original = globalThis.crypto
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { ...original, randomUUID: undefined },
    })
    try {
      const ids = new Set<string>()
      for (let i = 0; i < 1000; i += 1) ids.add(nextLocalMessageId())
      expect(ids.size, '兜底分支也必须唯一（生产跑的就是这条分支）').toBe(1000)
    } finally {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: original })
    }
  })

  it('同一回合的 user 与 assistant 气泡 id 必须不同（AgentSideRail 的 :key 不能重复）', () => {
    const store = useAgentStore()
    store.addUserMessage('你好')
    store.startAssistantMessage()

    const ids = store.messages.map((m) => m.id)
    expect(ids.length).toBe(2)
    expect(new Set(ids).size, `user/assistant 气泡 id 撞了：${ids.join(' / ')}`).toBe(2)
  })

  it('插话气泡（insertUserMessageBeforeAssistant）与正常发送的 id 也不能撞', () => {
    // 生产形态：插话与正常发送**同刻**发生 ⇒ 旧的 `msg-${Date.now()}` 方案
    // 靠 localMsgSeq 后缀才没撞上；这条锁住「任何组合都不撞」。
    const store = useAgentStore()
    store.addUserMessage('正常发送')
    store.startAssistantMessage()
    store.insertUserMessageBeforeAssistant('插话补充')

    const ids = store.messages.map((m) => m.id)
    expect(new Set(ids).size, `消息 id 撞了：${ids.join(' / ')}`).toBe(ids.length)
  })

  it('id 必须带 msg- 前缀（可读性 + 与服务端 persisted id 形态区分）', () => {
    expect(nextLocalMessageId().startsWith('msg-')).toBe(true)
  })
})
