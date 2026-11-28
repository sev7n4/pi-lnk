/**
 * 2026-11-28 cmx05m9d2：上游 400 invalid_request 必须归类 invalid_input，
 * 而不是落 unknown 让前端拿过期卡片文案冒充失败原因。
 * 规则复用 packages/shared/generationDiagnostics 的 `invalid_request` 字面族。
 */
import { describe, expect, it } from 'vitest'
import { classifyPiRunError } from './pi-events'

const asEvent = (message: string) =>
  ({ type: 'error', data: { message } }) as never

describe('classifyPiRunError：invalid_input 分类', () => {
  it('400 invalid_request + missing tool_call_id → invalid_input', () => {
    const msg =
      '400: {"message":"BadRequestError: OpenAIException - {\\"error\\":{\\"message\\":\\"Invalid JSON data: Failed to deserialize the JSON body into the target type: messages[55]: missing field `tool_call_id`\\",\\"type\\":\\"invalid_request_error\\",\\"code\\":\\"json_parse_error\\"}}"}'
    const info = classifyPiRunError(asEvent(msg))
    expect(info?.kind).toBe('invalid_input')
    expect(info?.retry_hint).toBeTruthy()
  })

  it('普通 invalid_request 字面量也归类 invalid_input', () => {
    expect(classifyPiRunError(asEvent('400 invalid_request: bad parameter'))?.kind).toBe('invalid_input')
  })

  it('普通 400 / 未知错误仍保持 unknown（不误伤）', () => {
    expect(classifyPiRunError(asEvent('400 bad request'))?.kind).toBe('unknown')
  })

  it('限流仍优先归类 rate_limit', () => {
    expect(
      classifyPiRunError(asEvent('429 rate limit invalid_request'))?.kind,
    ).toBe('rate_limit')
  })
})
