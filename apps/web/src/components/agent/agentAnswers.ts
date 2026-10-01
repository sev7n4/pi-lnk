/**
 * B-6：POST /api/agent/sessions/:sessionId/answers —— 阻塞式 ask_user /
 * propose_generation 的回答回传（Nest 统一包装按 data 取值）。
 *
 * 401/403/网络异常一律 throw——调用方必须 try/catch，失败时恢复 pendingAskUser
 * （端点幂等，重试安全）。payload 只含 threadId/callId/answers/answerId；
 * skipped 不进 payload——skipped 问题已从 answers 省略，「未答」语义由模型侧
 * sawtooth（answers 缺键）表达。
 *
 * ⚠️ answerId 必须用 `randomId()`，**不得**直接调 `crypto.randomUUID`：后者只在安全
 * 上下文（HTTPS/localhost）存在，生产 CVM 是明文 `http://ip:port` → 同步抛 TypeError，
 * 请求根本发不出去（表现为「提交失败，请重试」，而 nginx 侧无任何 /answers 记录）。
 * randomId 内置降级，同仓库 canvasEditor / useSelectionGenerate 早已统一走它。
 *
 * post 可注入（测试用；生产由组件传入带 apiUrl + 鉴权头的实现，风格同 cancelAgentRun）。
 */
import { randomId } from '@/utils/randomId'

export interface SubmitAnswersInput {
  threadId: string
  sessionId: string
  callId: string
  answers: Record<string, string[]>
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
      answerId: randomId(),
    }),
  })
  // status 进错误信息：出问题时能一眼区分 401（未登录）/ 409（会话忙）/ 5xx，省掉抓包
  if (!res.ok) throw new Error(`submitAnswers failed: ${res.status ?? 'unknown'}`)
  const json = (await res.json()) as { data?: { ok?: boolean; deduped?: boolean } }
  return { ok: json.data?.ok === true, deduped: json.data?.deduped === true }
}
