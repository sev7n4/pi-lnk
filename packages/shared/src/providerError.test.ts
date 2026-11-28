import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { classifyProviderErrorText, matchesProviderPattern } from './providerError'

describe('classifyProviderErrorText（三套分类器共享的字面识别 SSOT）', () => {
  it('生产 400 missing tool_call_id → invalid_input（词边界不被下划线吃掉）', () => {
    expect(classifyProviderErrorText('400 invalid_request_error: messages[55]: missing field tool_call_id')).toBe('invalid_input')
  })

  it('各家族字面归一', () => {
    expect(classifyProviderErrorText('402 Insufficient Balance')).toBe('insufficient_balance')
    expect(classifyProviderErrorText('429 Too Many Requests')).toBe('rate_limit')
    expect(classifyProviderErrorText('video queue is full, please retry later')).toBe('rate_limit')
    expect(classifyProviderErrorText('401 unauthorized')).toBe('auth')
    expect(classifyProviderErrorText('ETIMEDOUT timeout after 30s')).toBe('timeout')
    expect(classifyProviderErrorText('fetch failed')).toBe('network')
    expect(classifyProviderErrorText('model_not_found')).toBe('model_unavailable')
    expect(classifyProviderErrorText('参数校验失败')).toBe('validation')
  })

  it('固定优先级：aborted 先于 4xx；rate_limit 先于 invalid_input', () => {
    expect(classifyProviderErrorText('aborted after 400 invalid_request')).toBe('aborted')
    expect(classifyProviderErrorText('429 rate limit, invalid_request')).toBe('rate_limit')
  })

  it('未命中返回 null，绝不造分类', () => {
    expect(classifyProviderErrorText('玄学失败')).toBeNull()
    expect(classifyProviderErrorText('')).toBeNull()
  })

  it('谓词入口给各分类器按自身优先级挑用，字面仍同源', () => {
    expect(matchesProviderPattern('invalid_input', 'invalid_request_error')).toBe(true)
    expect(matchesProviderPattern('invalid_input', 'bad gateway')).toBe(false)
  })
})

describe('跨包契约：pi-runtime 独立分类器字面不得漂移', () => {
  it('runtime 仍独立保留 429/timeout/network/invalid_request 字面，且与 canonical 同源语义', () => {
    // pi-runtime 有 CI 守卫禁止依赖 workspace 包（物理拆仓边界），因此不 import shared；
    // 这里用源码契约锁住两边字面一致，防「三套分类器各自漂移」。
    const runtimeSrc = readFileSync(
      fileURLToPath(new URL('../../../services/pi-runtime/src/tool-error-class.ts', import.meta.url)),
      'utf8',
    )
    for (const literal of ['429', 'timeout', 'fetch failed', 'invalid', 'http 4']) {
      expect(runtimeSrc, `runtime 分类器缺少字面 ${literal}`).toContain(literal)
    }
    expect(classifyProviderErrorText('HTTP 429 rate limit')).toBe('rate_limit')
    expect(classifyProviderErrorText('fetch failed')).toBe('network')
    expect(classifyProviderErrorText('400 invalid_request_error')).toBe('invalid_input')
  })
})
