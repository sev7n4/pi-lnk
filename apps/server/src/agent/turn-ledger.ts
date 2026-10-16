/**
 * 回合账本（turn ledger）纯函数（回合身份与单一写者 · PR2）。
 *
 * 「账本」= 落进 `AgentMessage.metadata.executionEvents` 的那串执行事件。
 * 它在本项目里长期有一个**未被承认的缺陷**：数组下标即顺序 ⇒ 一条流从半路接入
 * （订阅切片 / 断线重连）时，它记下的「顺序」只是**它自己看到的顺序**，
 * 首事件可能是孤儿 `tool_result`。生产实证：画布 cmv9hmpph001qoa017y9rv312
 * 一次 run 落 4 条正文相同的助手消息，后 3 条的事件集是完整回合的**子序列**
 * （起点滞后、终点同刻）⇒ 前端 `parts.push` 把孤儿工具行顶到思考之前。
 *
 * 本文件只放**纯函数**（无 IO、无 Nest 依赖）：判定与归并的判据必须与生产链路
 * 共用同一份实现，否则「测试绿了、线上判错」这对经典漂移必然重演。
 */

import type { PersistedExecutionEvent } from '@lnkpi/shared'

/**
 * 一条流对某回合账本的**捕获状态**。
 *
 * 字段都是「这条流看到了什么」，而非「这个回合发生了什么」——后者只有上游权威
 * 知道。区分这二者是本文件的全部意义：**不知道的事不许冒充知道**（N4）。
 */
export interface LedgerCapture {
  /** 是否捕获到 run 起点（pi-runtime 归一事件 `agent_start`）。 */
  sawRunStart: boolean
  /** 本流捕获到的首个**全局**序号（runtime 会话内单调 seq，与 `afterSeq` 同编号空间）。 */
  firstSeq?: number
  /** 已收集的执行事件条数。 */
  eventCount: number
}

/**
 * 账本是否完整 —— 即有没有「前半段没捕获」的缺口。
 *
 * 判据刻意**只取因果围栏**（是否看到 run 起点），不用内容指纹、不用事件条数：
 * 同一句话 5 分钟后重发是合法新回合（N5），用指纹判会把合法回合误判成重复。
 *
 * 空账本判「完整」：没有可缺的东西，也不存在「半路接入」的证据
 * （此时标 partial 会让前端对一条空消息显示「前半段未捕获」，纯噪音）。
 */
export function isLedgerComplete(capture: LedgerCapture): boolean {
  if (capture.eventCount === 0) return true
  return capture.sawRunStart
}

/**
 * 缺口起点：本流捕获到的首个全局序号。
 *
 * `undefined` = 无缺口（或无从判定，见 `isLedgerComplete` 的空账本分支）。
 * 语义是「此序号**之前**的事件本流没看到」——不是「从这条开始补齐」。
 */
export function ledgerGapFrom(capture: LedgerCapture): number | undefined {
  return isLedgerComplete(capture) ? undefined : capture.firstSeq
}

/**
 * 按**全局序号**归并两段账本并去重（同 gSeq 视为同一事件，保留先到者）。
 *
 * 为什么必须归并：PR4 的历史修复要把影子行捕获到的事件并进 owner 行
 * （软标记不删数据，但「产出」必须去重合并，否则前端挂件重复）。归并而非替换，
 * 是因为两条切片各自**只看到一部分**——谁都不是全集，丢任何一边都是丢数据。
 *
 * ⚠️ 无 `gSeq` 的事件（老数据 / runtime 未透传）**不去重**，且整体排在带序号的
 * 事件之前：它们早于 gSeq 时代是事实，而按内容去重会把「两条内容相同的合法事件」
 * 误删一条。宁可顺序不完美，也不丢事件（N4：不冒充全量）。
 */
export function mergeExecutionEvents(
  a: readonly PersistedExecutionEvent[],
  b: readonly PersistedExecutionEvent[],
): PersistedExecutionEvent[] {
  const head: PersistedExecutionEvent[] = [] // 无 gSeq，保留原相对序
  const tail: PersistedExecutionEvent[] = [] // 有 gSeq，按序号排序
  const seen = new Set<number>()
  for (const event of [...a, ...b]) {
    if (typeof event.gSeq !== 'number') {
      head.push(event)
      continue
    }
    if (seen.has(event.gSeq)) continue // 去重：同序号只留先到者
    seen.add(event.gSeq)
    tail.push(event)
  }
  tail.sort((x, y) => (x.gSeq ?? 0) - (y.gSeq ?? 0))
  return [...head, ...tail]
}
