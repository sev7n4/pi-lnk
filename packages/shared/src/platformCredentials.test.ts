import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_APIMART_BASE_URL,
  DEFAULT_FAL_BASE_URL,
  DEFAULT_MINIMAX_BASE_URL,
  DEFAULT_STEPFUN_BASE_URL,
  isFalH3MaxPlatformModel,
  isMiniMaxH3PlatformModel,
  isStepFunPlatformModel,
  resolveApimartPlatformCredentials,
  resolveFalH3MaxPlatformCredentials,
  resolveMiniMaxH3PlatformCredentials,
  resolvePlatformImageProviderOpts,
  resolveStepFunPlatformCredentials,
  usesApimartImageGateway,
  type PlatformCredentialEnv,
} from './platformCredentials'

const testEnv: PlatformCredentialEnv = {
  openaiApiKey: 'agnes-key',
  openaiBaseUrl: 'https://apihub.agnes-ai.cn/v1',
  apimartApiKey: 'apimart-key',
  apimartBaseUrl: 'https://api.apimart.ai/v1',
}

describe('platformCredentials', () => {
  const original = {
    openaiKey: process.env.OPENAI_API_KEY,
    openaiBase: process.env.OPENAI_BASE_URL,
    apimartKey: process.env.APIMART_API_KEY,
    apimartBase: process.env.APIMART_BASE_URL,
    falKey: process.env.FAL_KEY,
    falBase: process.env.FAL_BASE_URL,
    minimaxKey: process.env.MINIMAX_API_KEY,
    minimaxBase: process.env.MINIMAX_BASE_URL,
  }

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENAI_BASE_URL
    delete process.env.APIMART_API_KEY
    delete process.env.APIMART_BASE_URL
    delete process.env.FAL_KEY
    delete process.env.FAL_BASE_URL
    delete process.env.MINIMAX_API_KEY
    delete process.env.MINIMAX_BASE_URL
  })

  afterEach(() => {
    const envMap = {
      openaiKey: 'OPENAI_API_KEY',
      openaiBase: 'OPENAI_BASE_URL',
      apimartKey: 'APIMART_API_KEY',
      apimartBase: 'APIMART_BASE_URL',
      falKey: 'FAL_KEY',
      falBase: 'FAL_BASE_URL',
      minimaxKey: 'MINIMAX_API_KEY',
      minimaxBase: 'MINIMAX_BASE_URL',
    } as const
    for (const [k, envKey] of Object.entries(envMap)) {
      const v = original[k as keyof typeof original]
      if (v === undefined) delete process.env[envKey]
      else process.env[envKey] = v
    }
  })

  it('detects catalog APIMart image models', () => {
    expect(usesApimartImageGateway('seedream-5.0-pro')).toBe(true)
    expect(usesApimartImageGateway('image2')).toBe(true)
    expect(usesApimartImageGateway('agnes-image-2.1-flash')).toBe(false)
  })

  it('detects upstream gateway ids', () => {
    expect(usesApimartImageGateway('doubao-seedream-5-0-pro')).toBe(true)
    expect(usesApimartImageGateway('gpt-image-2-official')).toBe(true)
  })

  it('returns APIMart credentials for seedream/image2', () => {
    expect(resolveApimartPlatformCredentials('seedream-5.0-pro', testEnv)).toEqual({
      apiKey: 'apimart-key',
      baseUrl: 'https://api.apimart.ai/v1',
    })
    expect(resolveApimartPlatformCredentials('agnes-image-2.1-flash', testEnv)).toBeNull()
  })

  it('falls back to OPENAI_API_KEY when APIMART_API_KEY is unset', () => {
    expect(
      resolveApimartPlatformCredentials('image2', {
        ...testEnv,
        apimartApiKey: '',
      }),
    ).toEqual({
      apiKey: 'agnes-key',
      baseUrl: DEFAULT_APIMART_BASE_URL,
    })
  })

  it('resolvePlatformImageProviderOpts routes APIMart vs Agnes', () => {
    expect(resolvePlatformImageProviderOpts('image2', testEnv)).toEqual({
      apiKey: 'apimart-key',
      baseUrl: 'https://api.apimart.ai/v1',
    })
    expect(resolvePlatformImageProviderOpts('agnes-image-2.1-flash', testEnv)).toEqual({
      apiKey: 'agnes-key',
      baseUrl: 'https://apihub.agnes-ai.cn/v1',
    })
  })

  it('detects H3 Max family model names', () => {
    expect(isFalH3MaxPlatformModel('h3-max-turbo')).toBe(true)
    expect(isFalH3MaxPlatformModel('h3-max')).toBe(true)
    expect(isFalH3MaxPlatformModel('H3-MAX')).toBe(true)
    expect(isFalH3MaxPlatformModel('agnes-2.0-flash')).toBe(false)
    expect(isFalH3MaxPlatformModel('seedance-2.0')).toBe(false)
  })

  it('returns FAL credentials for H3 Max and never falls back to OPENAI_API_KEY', () => {
    expect(resolveFalH3MaxPlatformCredentials('agnes-2.0-flash', testEnv)).toBeNull()
    expect(
      resolveFalH3MaxPlatformCredentials('h3-max-turbo', {
        ...testEnv,
        falApiKey: 'fal-key',
      }),
    ).toEqual({
      apiKey: 'fal-key',
      baseUrl: DEFAULT_FAL_BASE_URL,
    })
    expect(
      resolveFalH3MaxPlatformCredentials('h3-max', {
        ...testEnv,
        falApiKey: '',
        falBaseUrl: 'https://fal.custom.example',
      }),
    ).toEqual({
      apiKey: '',
      baseUrl: 'https://fal.custom.example',
    })
  })

  it('reads runtime env when explicit env is omitted', () => {
    process.env.APIMART_API_KEY = 'runtime-apimart'
    process.env.APIMART_BASE_URL = 'https://api.apimart.ai/v1'
    expect(resolveApimartPlatformCredentials('image2')).toEqual({
      apiKey: 'runtime-apimart',
      baseUrl: 'https://api.apimart.ai/v1',
    })
  })

  it('detects official MiniMax H3 catalog and gateway names only', () => {
    expect(isMiniMaxH3PlatformModel('minimax-h3')).toBe(true)
    expect(isMiniMaxH3PlatformModel('MiniMax-H3')).toBe(true)
    expect(isMiniMaxH3PlatformModel('MINIMAX-H3')).toBe(true)
    expect(isMiniMaxH3PlatformModel('h3-max')).toBe(false)
    expect(isMiniMaxH3PlatformModel('h3-max-turbo')).toBe(false)
    expect(isMiniMaxH3PlatformModel('minimax/h3-max-turbo')).toBe(false)
    expect(isMiniMaxH3PlatformModel('MiniMax-H3-Max')).toBe(false)
    expect(isMiniMaxH3PlatformModel('agnes-2.0-flash')).toBe(false)
    expect(isMiniMaxH3PlatformModel('seedance-2.0')).toBe(false)
  })

  it('returns MiniMax credentials for official H3 and never falls back to OPENAI_API_KEY', () => {
    expect(resolveMiniMaxH3PlatformCredentials('h3-max-turbo', testEnv)).toBeNull()
    expect(resolveMiniMaxH3PlatformCredentials('MiniMax-H3-Max', testEnv)).toBeNull()
    expect(
      resolveMiniMaxH3PlatformCredentials('minimax-h3', {
        ...testEnv,
        minimaxApiKey: 'minimax-key',
      }),
    ).toEqual({
      apiKey: 'minimax-key',
      baseUrl: DEFAULT_MINIMAX_BASE_URL,
    })
    expect(
      resolveMiniMaxH3PlatformCredentials('MiniMax-H3', {
        ...testEnv,
        minimaxApiKey: '',
        minimaxBaseUrl: 'https://minimax.custom.example',
      }),
    ).toEqual({
      apiKey: '',
      baseUrl: 'https://minimax.custom.example',
    })
  })
})

describe('resolveStepFunPlatformCredentials', () => {
  it('匹配阶跃全家族模型名（step-tts-* / stepaudio-*）', () => {
    for (const name of [
      'step-tts-mini',
      'stepaudio-3-tts',
      'stepaudio-3-gen-preview',
      'stepaudio-3-music-preview',
    ]) {
      expect(isStepFunPlatformModel(name)).toBe(true)
    }
  })

  it('不误伤其它平台模型', () => {
    for (const name of ['agnes-2.0-flash', 'h3-max-turbo', 'minimax-h3', 'speech-2.8-hd']) {
      expect(isStepFunPlatformModel(name)).toBe(false)
      expect(resolveStepFunPlatformCredentials(name, { stepfunApiKey: 'k' })).toBeNull()
    }
  })

  it('缺省 baseUrl 指向阶跃官方网关', () => {
    expect(
      resolveStepFunPlatformCredentials('stepaudio-3-gen-preview', { stepfunApiKey: 'k' }),
    ).toEqual({ apiKey: 'k', baseUrl: DEFAULT_STEPFUN_BASE_URL })
  })

  it('⚠️ 回归锁：匹配到阶跃模型时，即使 key 为空也返回非 null', () => {
    // 返回 null 会让 resolver 落回 OpenAI 默认端点，把 step 模型名静默发到 OpenAI。
    // 缺 key 的显式失败由调用方负责（apps/server 的音频路径），不在这里静默兜底。
    const r = resolveStepFunPlatformCredentials('stepaudio-3-music-preview', {})
    expect(r).not.toBeNull()
    expect(r!.apiKey).toBe('')
    expect(r!.baseUrl).toBe(DEFAULT_STEPFUN_BASE_URL)
  })

  it('显式 env 覆盖 process.env', () => {
    const saved = process.env.STEPFUN_API_KEY
    process.env.STEPFUN_API_KEY = 'from-process'
    try {
      expect(
        resolveStepFunPlatformCredentials('stepaudio-3-tts', { stepfunApiKey: 'from-arg' })!.apiKey,
      ).toBe('from-arg')
      expect(resolveStepFunPlatformCredentials('stepaudio-3-tts')!.apiKey).toBe('from-process')
    } finally {
      if (saved === undefined) delete process.env.STEPFUN_API_KEY
      else process.env.STEPFUN_API_KEY = saved
    }
  })

  it('STEPFUN_BASE_URL 可覆盖', () => {
    expect(
      resolveStepFunPlatformCredentials('stepaudio-3-tts', {
        stepfunApiKey: 'k',
        stepfunBaseUrl: 'https://stepfun.internal/v1',
      })!.baseUrl,
    ).toBe('https://stepfun.internal/v1')
  })
})
