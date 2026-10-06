import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BadRequestException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import {
  assertStepFunAudioModel,
  audioFailureMessage,
  resolvePlatformAudioFallback,
} from './audio-kind'

describe('assertStepFunAudioModel', () => {
  it('design / music 只接受阶跃模型', () => {
    expect(() => assertStepFunAudioModel('design', 'stepaudio-3-gen-preview')).not.toThrow()
    expect(() => assertStepFunAudioModel('music', 'stepaudio-3-music-preview')).not.toThrow()
    expect(() => assertStepFunAudioModel('music', 'minimax-speech-2.8-hd')).toThrow(
      BadRequestException,
    )
  })

  it('voice 不受限（现网模型照旧可用）', () => {
    expect(() => assertStepFunAudioModel('voice', 'seed-audio-1.0')).not.toThrow()
  })
})

describe('audioFailureMessage', () => {
  it('402 且平台渠道 ⇒ 平台音频额度不足', () => {
    const msg = audioFailureMessage('voice', new Error('TTS API 402: insufficient balance'), 'platform')
    expect(msg).toContain('平台音频额度不足')
  })

  it('缺密钥 ⇒ 显式说明未配置，而非泛化失败', () => {
    const msg = audioFailureMessage('design', new Error('missing api key'), 'platform')
    expect(msg).toContain('未配置')
    expect(msg).toContain('STEPFUN_API_KEY')
  })

  it('音乐异步任务的终态失败带任务原因', () => {
    const msg = audioFailureMessage('music', new Error('music task FAILED: content policy'), 'platform')
    expect(msg).toContain('音乐生成失败')
    expect(msg).toContain('content policy')
  })

  it('用户自有渠道失败不改写为平台口径', () => {
    const msg = audioFailureMessage('voice', new Error('TTS API 401: bad key'), 'ch_abc')
    expect(msg).not.toContain('平台音频额度不足')
    expect(msg).toContain('401')
  })
})

describe('resolvePlatformAudioFallback（降级重放该用哪套凭证）', () => {
  it('阶跃模型 ⇒ 阶跃凭证（不再吃 OPENAI_* 兜底）', () => {
    const r = resolvePlatformAudioFallback('stepaudio-3-music-preview', {
      stepfunApiKey: 'sf',
      stepfunBaseUrl: 'https://api.stepfun.com/v1',
      openaiApiKey: 'oai',
      openaiBaseUrl: 'https://platform.example.com/v1',
    })
    expect(r).toEqual({
      ok: true,
      credentials: { apiKey: 'sf', baseUrl: 'https://api.stepfun.com/v1' },
    })
  })

  it('🔴 阶跃模型但缺 STEPFUN_API_KEY ⇒ 显式拒绝（不得退回 OPENAI_API_KEY）', () => {
    const r = resolvePlatformAudioFallback('stepaudio-3-music-preview', {
      openaiApiKey: 'oai',
      openaiBaseUrl: 'https://platform.example.com/v1',
    })
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.reason).toContain('STEPFUN_API_KEY')
  })

  it('非阶跃模型 ⇒ 沿用 OPENAI_*（存量行为逐字节不变）', () => {
    const r = resolvePlatformAudioFallback('minimax-speech-2.8-hd', {
      openaiApiKey: 'oai',
      openaiBaseUrl: 'https://platform.example.com/v1',
    })
    expect(r).toEqual({
      ok: true,
      credentials: { apiKey: 'oai', baseUrl: 'https://platform.example.com/v1' },
    })
  })

  it('两套都没有 ⇒ 显式拒绝并列出两个变量名', () => {
    const r = resolvePlatformAudioFallback('minimax-speech-2.8-hd', {})
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.reason).toMatch(/OPENAI_API_KEY/)
  })
})

function assertNoMatch(src: string, re: RegExp, hint: string) {
  const hit = src.split('\n').findIndex((l) => re.test(l))
  if (hit >= 0) throw new Error(`${hint}（第 ${hit + 1} 行）`)
}

describe('降级重放的调用点锁', () => {
  it('studio.service 的音频降级不再直接 createAudioProvider(undefined)', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'studio.service.ts'),
      'utf8',
    )
    assertNoMatch(src, /createAudioProvider\(\s*undefined\s*\)/, '降级重放仍用 undefined 凭证')
  })
})
