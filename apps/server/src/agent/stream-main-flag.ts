/**
 * P1 统一传输灰度开关（多端一致性 · 计划 2026-11-04 Task 4）。
 *
 * `STREAM_MAIN_FROM_PIRUNTIME`：
 *  - **默认 off**（未设置 / 任何非命中值）——off 路径 POST /chat/conversation
 *    仍走响应体流 + `[DONE]`，行为逐字节不变（回滚 = 改 env，无代码回退）；
 *  - `on` / `true` / `1` ⇒ on：POST 仅回 JSON ack（threadId + sinceSeq），
 *    run 在服务端后台 drain，前端经 GET /runs/events 消费同一权威通道。
 *
 * 刻意用 env 而非库表：canary（Task 8）按容器 env 白名单灰度，回滚是
 * 重启级操作而非发布级。判定收敛在本函数（唯一 SSOT），勿在调用点散写。
 */
export function isStreamMainFromPiRuntimeEnabled(): boolean {
  const v = process.env.STREAM_MAIN_FROM_PIRUNTIME
  return v === 'on' || v === 'true' || v === '1'
}
