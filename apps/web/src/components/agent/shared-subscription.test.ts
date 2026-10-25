/**
 * 会话级订阅跨标签页共享的行为测试（2026-10-26 规格 §8 / §10）。
 *
 * 判据纪律（本仓既有教训）：
 * - 断言落在**可观测出口**（onEvent / onLeadership / onDegrade 的调用与**顺序**），不锁实现细节；
 * - 频道与时钟**全部注入** ⇒ 不碰真 BroadcastChannel、不依赖真实时间；
 * - 用例能因实现变更而转红（提交前跑变异检验）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createSharedSubscription,
  type SharedChannel,
  type SharedEvent,
} from './shared-subscription'
import {
  electLeader,
  mergeCursor,
  planFrames,
  shouldOpenConnection,
  shouldTakeOver,
} from './shared-subscription-core'

/** 内存频道总线：同名频道之间投递（同步 ⇒ 顺序确定）；可模拟丢帧与崩溃。 */
class FakeBus {
  private chans = new Map<string, Set<FakeChannel>>()
  /** 置 true 时下一条消息**不投递**（模拟 BroadcastChannel 丢帧） */
  dropNext = false
  create = (name: string): SharedChannel => {
    const ch = new FakeChannel(this, name)
    const set = this.chans.get(name) ?? new Set<FakeChannel>()
    set.add(ch)
    this.chans.set(name, set)
    return ch
  }
  deliver(from: FakeChannel, msg: unknown): void {
    if (this.dropNext) {
      this.dropNext = false
      return
    }
    const set = this.chans.get(from.name)
    if (!set) return
    for (const ch of [...set]) {
      if (ch === from) continue
      ch.emit(msg)
    }
  }
  remove(ch: FakeChannel): void {
    this.chans.get(ch.name)?.delete(ch)
  }
  /** 模拟「标签页被强杀」：停止投递 + 从总线摘掉，且**不发 bye**。 */
  crash(ch: FakeChannel): void {
    ch.crashed = true
    this.remove(ch)
  }
  all(): FakeChannel[] {
    const out: FakeChannel[] = []
    for (const set of this.chans.values()) out.push(...set)
    return out
  }
}

class FakeChannel implements SharedChannel {
  private handlers = new Set<(ev: { data: unknown }) => void>()
  /** 模拟「标签页被强杀」：不再投递任何消息 */
  crashed = false
  constructor(
    private bus: FakeBus,
    readonly name: string,
  ) {}
  postMessage(msg: unknown): void {
    if (this.crashed) return
    this.bus.deliver(this, msg)
  }
  close(): void {
    this.bus.remove(this)
  }
  addEventListener(_type: 'message', cb: (ev: { data: unknown }) => void): void {
    this.handlers.add(cb)
  }
  removeEventListener(_type: 'message', cb: (ev: { data: unknown }) => void): void {
    this.handlers.delete(cb)
  }
  /** 投递给本频道的所有监听者 */
  emit(data: unknown): void {
    for (const cb of [...this.handlers]) cb({ data })
  }
}

const text = (t: string): SharedEvent => ({ kind: 'text_delta', text: t })

describe('共享订阅 · 纯函数层', () => {
  it('electLeader：字典序最小者当选；空数组返回 null', () => {
    expect(electLeader(['b', 'a', 'c'])).toBe('a')
    expect(electLeader([])).toBe(null)
    expect(electLeader(['only'])).toBe('only')
  })

  it('shouldTakeOver：严格大于阈值才算失联（等于阈值仍算活着）', () => {
    expect(shouldTakeOver({ lastPongAt: 1000, now: 4000, timeoutMs: 3000 })).toBe(false)
    expect(shouldTakeOver({ lastPongAt: 1000, now: 4001, timeoutMs: 3000 })).toBe(true)
  })

  it('mergeCursor：取大；null 视为未知', () => {
    expect(mergeCursor(5, 9)).toBe(9)
    expect(mergeCursor(9, 5)).toBe(9)
    expect(mergeCursor(null, 3)).toBe(3)
    expect(mergeCursor(7, null)).toBe(7)
    expect(mergeCursor(null, null)).toBe(null)
  })

  it('planFrames：丢弃已消费帧', () => {
    const f = (seq: number) => ({ seq, ev: `e${seq}` })
    expect(planFrames([f(1), f(2), f(3)], 2)).toEqual([f(3)])
    expect(planFrames([f(1)], 1)).toEqual([])
  })

  it('shouldOpenConnection：只有「可见的 leader」才开连接；降级时各自订阅', () => {
    // ⛔ follower 绝不能自己开连接（否则回到 N 标签页 N 条长连接的病态）
    expect(shouldOpenConnection({ degraded: false, isLeader: false, visible: true })).toBe(false)
    // 隐藏页也不该占连接（#587：看不见就不该占着连接）
    expect(shouldOpenConnection({ degraded: false, isLeader: true, visible: false })).toBe(false)
    // 可见的 leader 才开
    expect(shouldOpenConnection({ degraded: false, isLeader: true, visible: true })).toBe(true)
    // 降级（无 BroadcastChannel）⇒ 各自订阅（= 改动前行为）
    expect(shouldOpenConnection({ degraded: true, isLeader: false, visible: false })).toBe(true)
  })
})

describe('共享订阅 · 选举与转发', () => {
  let bus: FakeBus
  let clock: number
  const now = () => clock

  beforeEach(() => {
    bus = new FakeBus()
    clock = 1_000_000
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function make(tabId: string) {
    const events: SharedEvent[] = []
    const leadership: boolean[] = []
    const degrade = vi.fn()
    const created: FakeChannel[] = []
    const sub = createSharedSubscription({
      channelName: 'lnkpi:agent-sub:session-1',
      tabId,
      createChannel: (n) => {
        const ch = bus.create(n)
        created.push(ch as FakeChannel)
        return ch
      },
      now,
      onEvent: (e) => events.push(e),
      onLeadership: (isLeader) => leadership.push(isLeader),
      onDegrade: degrade,
    })
    return { sub, events, leadership, degrade, created }
  }

  it('同会话两个标签页：只有字典序小的自认 leader', () => {
    const a = make('a')
    const b = make('b')
    a.sub.start()
    b.sub.start()
    expect(a.sub.isLeader()).toBe(true)
    expect(b.sub.isLeader()).toBe(false)
    a.sub.stop()
    b.sub.stop()
  })

  it('leader 广播的事件：follower 收到；follower 广播是 no-op（不产生第二事实源）', () => {
    const a = make('a')
    const b = make('b')
    a.sub.start()
    b.sub.start()
    a.sub.broadcast(text('hello'))
    expect(b.events).toEqual([text('hello')])
    // ⚠️ 模块**不**本地应用 leader 广播的事件（leader 自己的文本由宿主订阅回调应用）
    //   ⇒ 若这里也应用 ⇒ 文本双份。
    expect(a.events).toEqual([])
    b.sub.broadcast(text('from-follower'))
    // follower 的广播是 no-op ⇒ 不应出现第二个事实源
    expect(a.events).toEqual([])
    expect(b.events).toEqual([text('hello')])
    a.sub.stop()
    b.sub.stop()
  })

  it('缺帧：先补齐再应用 ⇒ 文本顺序不乱（1→2→3）', () => {
    const a = make('a')
    const b = make('b')
    a.sub.start()
    b.sub.start()
    a.sub.broadcast(text('1'))
    // 丢掉下一条（n=2），follower 只收到 n=3 ⇒ 应触发补帧
    bus.dropNext = true
    a.sub.broadcast(text('2'))
    a.sub.broadcast(text('3'))
    expect(b.events.map((e) => (e as { text: string }).text)).toEqual(['1', '2', '3'])
    a.sub.stop()
    b.sub.stop()
  })

  it('leader 崩溃（不发 bye）：超时后 follower 接管', () => {
    const a = make('a')
    const b = make('b')
    a.sub.start()
    b.sub.start()
    expect(a.sub.isLeader()).toBe(true)
    expect(b.sub.isLeader()).toBe(false)
    // 强杀 a：从总线摘掉（不广播 bye ⇒ 对端只能靠心跳超时判定）
    bus.crash(a.created[0]!)
    for (let i = 0; i < 6; i++) {
      clock += 1000
      vi.advanceTimersByTime(1000)
    }
    expect(b.sub.isLeader()).toBe(true)
    expect(b.leadership).toContain(true)
    a.sub.stop()
    b.sub.stop()
  })

  it('无 BroadcastChannel：降级为「各自订阅」，且不抛错', () => {
    const degrade = vi.fn()
    const sub = createSharedSubscription({
      channelName: 'x',
      tabId: 'a',
      createChannel: () => null,
      now,
      onEvent: vi.fn(),
      onDegrade: degrade,
    })
    expect(() => sub.start()).not.toThrow()
    expect(degrade).toHaveBeenCalledWith('no-channel')
    expect(sub.status().degraded).toBe(true)
    sub.stop()
  })

  it('隐藏页让出 leader：可见的同伴接管（#587 语义）', () => {
    const a = make('a')
    const b = make('b')
    a.sub.start()
    b.sub.start()
    expect(a.sub.isLeader()).toBe(true)
    // a 隐藏 ⇒ 放弃 leader（宿主据此掐掉连接），b 接管
    a.sub.setVisible(false)
    expect(a.sub.isLeader()).toBe(false)
    // a 的可见性要广播出去（下一轮 ping 即可）
    clock += 1000
    vi.advanceTimersByTime(1000)
    expect(b.sub.isLeader()).toBe(true)
    a.sub.stop()
    b.sub.stop()
  })

  it('状态可观测：leader / peers / 广播计数 / 游标', () => {
    const a = make('a')
    const b = make('b')
    a.sub.start()
    b.sub.start()
    a.sub.broadcast(text('one'))
    const st = a.sub.status()
    expect(st.leader).toBe(true)
    expect(st.broadcastCount).toBe(1)
    expect(st.peers).toBeGreaterThanOrEqual(1)
    expect(st.lastEventSeq).toBe(1)
    a.sub.stop()
    b.sub.stop()
  })
})
