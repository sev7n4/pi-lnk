/**
 * B-6：POST /api/agent/sessions/:sessionId/answers —— 阻塞式 ask_user /
 * propose_generation 的回答回传（Nest 统一包装按 data 取值）。
 *
 * 401/403/网络异常一律 throw——调用方必须 try/catch，失败时恢复 pendingAskUser
 * （端点幂等，重试安全）。payload 只含 threadId/callId/answers；
 * skipped 不进 payload——skipped 问题已从 answers 省略，「未答」语义由模型侧
 * sawtooth（answers 缺键）表达。
 *
 * ⚠️ 刻意**不**带 `answerId`（2026-10-02 删除）：它从头到尾穿过前端 → Nest DTO →
 * pi-runtime 三层，而 `registry.answer` 从来不读它 —— 一个零语义字段。去重靠
 * callId（端点幂等，deduped 即重试安全），不需要第二层 id。
 *
 * post 可注入（测试用；生产由组件传入带 apiUrl + 鉴权头的实现，风格同 cancelAgentRun）。
 */

export interface SubmitAnswersInput {
  threadId: string
  sessionId: string
  callId: string
  answers: Record<string, string[]>
  /**
   * 2026-10-06：`decline` = 用户**显式拒绝**（propose 卡「取消」）⇒ runtime 以 `aborted`
   * 交还，工具回 `reason:"aborted"` —— 取消成为确定性事实，不再靠 SSOT 轮询推断。
   * 缺省（undefined）不发送该键 = 作答语义，老调用方零改动。
   */
  decision?: 'answer' | 'decline'
}

export interface SubmitAnswersResult {
  ok: boolean
  deduped: boolean
}

export interface AnswersPostInit {
  method: string
  headers: Record<string, string>
  body: string
}

export type AnswersPost = (
  url: string,
  init: AnswersPostInit,
) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>

export function answersPath(sessionId: string): string {
  return `/api/agent/sessions/${encodeURIComponent(sessionId)}/answers`
}

export async function submitAnswers(
  input: SubmitAnswersInput,
  post: AnswersPost,
): Promise<SubmitAnswersResult> {
  const res = await post(answersPath(input.sessionId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      threadId: input.threadId,
      callId: input.callId,
      answers: input.answers,
      ...(input.decision ? { decision: input.decision } : {}),
    }),
  })
  // status 进错误信息：出问题时能一眼区分 401（未登录）/ 409（会话忙）/ 5xx，省掉抓包
  if (!res.ok) throw new Error(`submitAnswers failed: ${res.status ?? 'unknown'}`)
  const json = (await res.json()) as { data?: { ok?: boolean; deduped?: boolean } }
  return { ok: json.data?.ok === true, deduped: json.data?.deduped === true }
}
