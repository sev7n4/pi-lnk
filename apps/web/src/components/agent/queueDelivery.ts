/**
 * 插话（steer）/ 尾随指令（followUp）的投递判定。
 *
 * 为什么单独抽一个小模块：这三条判定各自对应过一次「用户打了字、UI 上什么都没发生、翻遍日志也没有」
 * 的真事故，且都是**静默**的 —— 前端看到的只有一次 fetch 返回，既没有异常也没有提示。
 * 从组件里抽出来单测，是为了让这类回归在 CI 上就炸，而不是等到有人发现「消息不知道去哪了」。
 *
 * 三个坑（本文件的全部存在理由）：
 *   1. **只看 `res.ok` 会误判**：pi-runtime 未接管时返回 HTTP **200 `{queued:false}`**
 *      （`agent.service.ts:463` 的维护态分支）。只看状态码 → 判定成功 → 消息既不入队也不回输入框，
 *      直接从用户眼皮底下蒸发。所以 `queued === false` 必须按失败处理。
 *   2. **`code !== 0` 与 HTTP 状态码是两套**：Nest 端点统一包 `{ code, message, data }`，
 *      健康检查类的 `code` 非 0 也要算失败。
 *   3. **`data` 缺失时按成功**：这是「拿不到 body 但连接正常」的保守选择 —— 宁可偶尔放行一条
 *      已经重试过的插话，也不要因为一个解析抖动就把用户打的字判丢（判丢必须可解释、可回灌）。
 */

export interface QueueDeliveryInput {
  /** HTTP 状态码层面是否成功 */
  ok: boolean
  /** HTTP 状态码，仅用于失败文案 */
  status?: number
  /** 解析出来的响应体；解析失败传 null */
  body: unknown
}

export interface QueueDeliveryResult {
  delivered: boolean
  /** 失败原因，直接显示在气泡上（不做 toast —— 流式中弹窗会打断阅读） */
  reason: string
}

/** 抽出 data 里可能嵌套的 `queued` 标记（Nest 统一包一层 `{ code, data }`）。 */
function extractQueued(body: unknown): unknown {
  const outer = body as { data?: { queued?: unknown } } | null
  if (outer && typeof outer === 'object' && 'data' in outer) return outer.data?.queued
  const flat = body as { queued?: unknown } | null
  if (flat && typeof flat === 'object') return flat.queued
  return undefined
}

/**
 * 入队成功后的气泡文案（2026-10-02 组合漏洞修复）。
 *
 * ⚠️ `blockedByAsk = true` 时**禁止**出现「已并入当前回答」：agent 此刻正卡在
 * `registry.waitForUser` 里等用户选一个答案，pi-runtime 的 `prompting` 恒为 true，
 * 端点一律 202 + `queued:true`，消息只能排在这份答案之后。旧文案会让用户以为
 * 「我刚要选的那项已经改成新说的了」，实际排在他已经提交的那份答案之后。
 *
 * 抽成纯函数是为了让这句话有单测兜底 —— 文案回归看不出来，但它是当时唯一的诚实性保证。
 */
export function acceptedHint(intent: "steer" | "followup", blockedByAsk: boolean): string {
  if (blockedByAsk) {
    return '已入队 · 会排在你答完这张卡之后才接上（本轮还在等你的选择）'
  }
  return intent === 'steer'
    ? '已并入当前回答，紧接着往下写（当前这轮不会中断）'
    : '会在本轮收尾时接住，你现在可以先走开'
}

export function parseQueueDelivery(input: QueueDeliveryInput): QueueDeliveryResult {
  const { ok, status, body } = input
  if (!ok) {
    return { delivered: false, reason: `投递失败：HTTP ${status ?? '未知'}` }
  }
  const outer = body as { code?: number } | null
  if (outer && typeof outer === 'object' && outer.code !== undefined && outer.code !== 0) {
    return { delivered: false, reason: `投递失败：code=${outer.code}` }
  }
  const queued = extractQueued(body)
  if (queued === false) {
    // 维护态 / runtime 未接管：宁可说清楚「没进去」，也不能让用户以为已经说了
    return { delivered: false, reason: '投递失败：生成服务未接管，消息未入队' }
  }
  return { delivered: true, reason: '' }
}
