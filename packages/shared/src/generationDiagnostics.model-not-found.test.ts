import { describe, expect, it } from 'vitest'
import { mapMessageToErrorCode, translateUpstreamFailure } from './generationDiagnostics'

// 生产 fixture（总体规格 §2.4 逐字，禁止臆造）——2026-10-09 分发渠道 503 model_not_found 事故
const PROD_503_TEXT =
  'Text API 503: {"error":{"code":"model_not_found","message":"No available channel for model deepseek-v4 under group default (distributor) (request id: 20261009043413943840776XprVkXAP)","type":"AgnesAI_error"}}'
// 生产欠费原文（总体规格 §2.4 逐字）
const PROD_402_TEXT =
  'Image edit API 402: ... insufficient balance (current: 0.013570 USD, required: 0.050000 USD)'

const MODEL_NOT_FOUND_COPY = '平台暂未开通该模型（上游无可用渠道），请换个模型或联系管理员'
const INSUFFICIENT_BALANCE_COPY = '上游生成服务余额不足，请联系管理员充值后重试'

describe('model_not_found → model_unavailable (S0-2)', () => {
  it('A1: maps the production 503 fixture to model_unavailable', () => {
    expect(mapMessageToErrorCode(PROD_503_TEXT)).toBe('model_unavailable')
  })

  it('A2: translates the production 503 fixture to the new copy; 402 fixture keeps the balance copy', () => {
    expect(translateUpstreamFailure(PROD_503_TEXT)).toBe(MODEL_NOT_FOUND_COPY)
    expect(translateUpstreamFailure(PROD_402_TEXT)).toBe(INSUFFICIENT_BALANCE_COPY)
  })

  it('A3: near-miss strings must NOT hit the new rule', () => {
    expect(mapMessageToErrorCode('Text API 503: Internal Error')).toBe('unknown')
    expect(translateUpstreamFailure('Text API 503: Internal Error')).toBeUndefined()
    expect(mapMessageToErrorCode('model_not_found_x')).toBe('unknown')
    expect(translateUpstreamFailure('model_not_found_x')).toBeUndefined()
  })

  it('A3: the No available channel literal still matches', () => {
    expect(mapMessageToErrorCode('No available channel for model deepseek-v4')).toBe(
      'model_unavailable',
    )
    expect(translateUpstreamFailure('No available channel for model deepseek-v4')).toBe(
      MODEL_NOT_FOUND_COPY,
    )
  })
})
