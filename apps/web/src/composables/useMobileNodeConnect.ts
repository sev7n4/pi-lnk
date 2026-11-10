import { ref, type Ref } from 'vue'
import type { Connection } from '@vue-flow/core'

export function buildConnection(source: string, target: string): Connection {
  return { source, target, sourceHandle: 'source', targetHandle: 'target' }
}

/**
 * 移动端连线模式状态机（Idle ↔ Linking，见规格 图 2）。
 *
 * 采用**模块级单例**（与 `usePreferences` 同款范式），而非 InjectionKey 跨 VueFlow
 * 节点树下发——理由：
 *   - 手柄 / 瓦片是 VueFlow 自定义节点，深层渲染，provide/inject 跨库子树在测试与部分
 *     运行路径下不可靠；模块单例让三处消费者（手柄 / 瓦片 / overlay）直接 import 同一
 *     实例，零注入不确定性。
 *   - 同一时刻整画布只有一条连线会话，`pendingSource` 全局唯一，单例语义天然贴合。
 *
 * - `enter(source)`：点源节点 `+` 进入模式（R-C1）
 * - `cancel()`：取消三选一之一（点空白 / 再点源 / 顶栏取消，R-C4）
 * - `complete(target)`：点目标节点瓦片任意处 ⇒ 构造 `Connection` 并复用落库通道（R-C2/R-C7）
 * - 自环拦截：`pendingSource === target` ⇒ 不建边（R-C3）
 *
 * 落库回调经 `registerConnectHandler` 注入（CanvasPage 启动时注册 `connectNodesFlow`
 * + 成功触感），保持本模块 UI/类型无关、可独立单测。
 */

export interface MobileConnectMode {
  pendingSource: Ref<string | null>
  enter: (source: string) => void
  cancel: () => void
  complete: (target: string) => void
}

let connectHandler: ((c: Connection) => void) | null = null

/** 由 CanvasPage 在启动时注册真正的落库通道（connectNodesFlow + 成功触感）。 */
export function registerConnectHandler(fn: (c: Connection) => void): void {
  connectHandler = fn
}

const pendingSource = ref<string | null>(null)

function enter(source: string) {
  pendingSource.value = source
}

function cancel() {
  pendingSource.value = null
}

function complete(target: string) {
  const src = pendingSource.value
  if (!src) return
  if (src === target) {
    cancel() // R-C3 禁自环：不建边，离开模式
    return
  }
  const conn = buildConnection(src, target)
  pendingSource.value = null
  connectHandler?.(conn)
}

/** 模块级单例：全画布共享同一连线会话。 */
export const mobileConnectMode: MobileConnectMode = { pendingSource, enter, cancel, complete }

export function useMobileNodeConnect(): MobileConnectMode {
  return mobileConnectMode
}

/** 测试用重置（避免单例跨用例串味）。 */
export function __resetMobileConnectForTest(): void {
  pendingSource.value = null
  connectHandler = null
}
