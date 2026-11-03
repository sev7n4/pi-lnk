import { EventEmitter } from 'node:events'

export const TERMINATION_EVENT = 'generation-record:terminalized'

/**
 * leaf 事件总线：仅承载「generationRecord 落终态」单一事件。
 * 用模块级单例而非 Nest provider，规避 PrismaService→reaper 初始化环（D-6）。
 */
export class TerminalEventBus {
  private readonly emitter = new EventEmitter()
  constructor() {
    this.emitter.setMaxListeners(32) // reaper 单一订阅者，留余量防告警
  }
  emitTerminalized(): void {
    this.emitter.emit(TERMINATION_EVENT)
  }
  onTerminalized(cb: () => void): void {
    this.emitter.on(TERMINATION_EVENT, cb)
  }
  offTerminalized(cb: () => void): void {
    this.emitter.off(TERMINATION_EVENT, cb)
  }
}

export const terminalEventBus = new TerminalEventBus()
