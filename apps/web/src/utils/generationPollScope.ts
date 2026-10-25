/**
 * 「哪些生成记录需要进入持续轮询」的判据。
 *
 * ⭐⭐⭐ 2026-10-26 生产取证：**画布空白的真正放大器**。
 *
 *   旧实现（`CanvasPage.startPollingForGeneratingRecords`）把**所有**带
 *   `generationRecordId` 的节点都塞进轮询队列（源码注释明说「不管状态」），
 *   而轮询是**串行**的（`useGenerationPolling.pollOnce` 里 `for` + `await`）。
 *   ⇒ 77 个节点的画布 ⇒ **每轮 77 条串行请求**（一轮约 2 秒）；
 *   ⇒ 且每次 `loadSession()` 都无条件重入（回合后还有 15 次轮询重载）
 *     ⇒ 请求量再乘 15。
 *   ⇒ 长期占死同源连接槽位（Chrome 每源 6 条）⇒ **画布载荷请求排队饿死
 *     ⇒ 画布显示为空**（实测同一画布 55 秒内打出 336 条请求）。
 *
 *   终态记录（completed / failed / error）**不需要持续轮询**：
 *   它们的产物**一次性取回**即可 —— 由 `reconcileMissingGenerationRecords()`
 *   的**一条 list 接口**覆盖（1 个请求 vs N 个），功能不丢、请求量骤降。
 *
 * ⚠️ 本模块只回答「要不要轮询」，不回答「怎么补数据」——
 *   补数据走 list 一次性回填（见 CanvasPage）。
 */

/**
 * 记录是否仍在服务端跑着（只有这两种需要持续轮询）。
 *
 * ⚠️ 口径与 `useGenerationPolling` 内部的 `isInflightRecordStatus` **必须一致**：
 *   两边口径漂移 ⇒ 一边认为在跑、另一边认为已结算 ⇒ 任务永不出队或被提前踢出。
 */
export function isRecordInflight(status: unknown): boolean {
  const s = String(status ?? '')
  return s === 'generating' || s === 'pending'
}

/**
 * 从一批记录里挑出「还需要持续轮询」的那些。
 *
 * @param records 服务端 list 接口返回的全部记录
 */
export function pickInflightRecords<T extends { id: string; status?: string | null }>(
  records: T[],
): T[] {
  return records.filter((r) => isRecordInflight(r.status))
}

/**
 * 某个**本地节点**是否需要进入持续轮询。
 *
 * @param nodeStatus 节点 data.status（本地视角，可能陈旧）
 * @param hasRecordId 节点是否带 generationRecordId（没有 ⇒ 没什么可轮询）
 *
 * ⭐ 与 `pickInflightRecords` 的分工：
 *   - 本地状态**缺省/终态** ⇒ 不轮询（产物由 list 一次性回填）；
 *   - 服务端记录状态是**权威** ⇒ 另一端发起的生成，本地状态还没同步时，
 *     由 `pickInflightRecords` 兜底把它拉回轮询队列。
 */
export function shouldPollNode(nodeStatus: unknown, hasRecordId: boolean): boolean {
  if (!hasRecordId) return false
  const s = String(nodeStatus ?? '')
  if (!s) return false
  return isRecordInflight(s)
}

/**
 * 节点数据与「记录回填补丁」是否真的有差异。
 *
 * ⭐ 用途：终态记录不再进轮询队列（见本文件头），因此「把记录重新贴回节点」
 *   这件事改由 list 一次性回填承担。回填必须**只在真的有差异时**才写，
 *   否则每次 loadSession 都会给几十个节点各写一次 ⇒ 触发无谓的渲染与保存。
 *
 * @param nodeData 节点当前的 data
 * @param patch 由记录算出的补丁
 */
export function patchDiffers(
  nodeData: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): boolean {
  const d = nodeData ?? {}
  for (const [key, value] of Object.entries(patch)) {
    const cur = d[key]
    // 用宽松比较：`null` 与 `undefined` 视为同值（补丁里大量 null 是"清空语义"，
    // 节点上通常压根没这个键 ⇒ 不该被判成"有差异"）。
    const norm = (v: unknown) => (v === null || v === undefined ? '' : String(v))
    if (norm(cur) !== norm(value)) return true
  }
  return false
}
