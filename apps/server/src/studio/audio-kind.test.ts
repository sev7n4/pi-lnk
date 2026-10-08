import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BadRequestException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import {
  assertStepFunAudioModel,
  assertAudioKindMatchesModel,
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

// 目录里的三个代表模型：voice / design / music 各取一个（studioModelCatalog.ts 的 audio 段）。
const TTS_MODEL = 'minimax-speech-2.8-hd' // audioKind: 'voice'
const DESIGN_MODEL = 'stepaudio-3-gen-preview' // audioKind: 'design'
const MUSIC_MODEL = 'stepaudio-3-music-preview' // audioKind: 'music'

describe('assertAudioKindMatchesModel（声明的 kind 必须与模型分类一致）', () => {
  it('music ↔ TTS 模型 ⇒ 显式拒绝，文案同时带 kind 与模型名', () => {
    let msg = ''
    try {
      assertAudioKindMatchesModel('music', TTS_MODEL)
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException)
      msg = (err as Error).message
    }
    // 报错必须让人一眼看出「要什么」和「手上是什么」，否则调用方无法自纠。
    expect(msg).toContain('music')
    expect(msg).toContain(TTS_MODEL)
    expect(msg).toContain('voice')
  })

  it('design ↔ TTS 模型 ⇒ 显式拒绝', () => {
    expect(() => assertAudioKindMatchesModel('design', TTS_MODEL)).toThrow(BadRequestException)
    expect(() => assertAudioKindMatchesModel('design', TTS_MODEL)).toThrow(/design/)
  })

  it('🔴 voice ↔ design 模型同样拒绝（voice 也参与校验，不能只对 design/music 生效）', () => {
    expect(() => assertAudioKindMatchesModel('voice', DESIGN_MODEL)).toThrow(BadRequestException)
    expect(() => assertAudioKindMatchesModel('voice', DESIGN_MODEL)).toThrow(/voice/)
    expect(() => assertAudioKindMatchesModel('voice', MUSIC_MODEL)).toThrow(BadRequestException)
  })

  it('一致 ⇒ 放行（三类各自）', () => {
    expect(() => assertAudioKindMatchesModel('voice', TTS_MODEL)).not.toThrow()
    expect(() => assertAudioKindMatchesModel('design', DESIGN_MODEL)).not.toThrow()
    expect(() => assertAudioKindMatchesModel('music', MUSIC_MODEL)).not.toThrow()
  })

  it('未声明 kind ⇒ 放行（存量调用逐字节不变，缺省仍按模型走）', () => {
    expect(() => assertAudioKindMatchesModel(undefined, TTS_MODEL)).not.toThrow()
    expect(() => assertAudioKindMatchesModel(undefined, MUSIC_MODEL)).not.toThrow()
  })

  it('非法 kind（大小写错/空串/非三分类）⇒ 显式拒绝，不静默当 voice', () => {
    expect(() => assertAudioKindMatchesModel('MUSIC', MUSIC_MODEL)).toThrow(BadRequestException)
    expect(() => assertAudioKindMatchesModel('', MUSIC_MODEL)).toThrow(BadRequestException)
    expect(() => assertAudioKindMatchesModel('tts', TTS_MODEL)).toThrow(BadRequestException)
  })

  it('目录外模型按缺省 voice 判（audioKindOf 是缺省唯一判据处）⇒ 请求 music 仍被拒', () => {
    expect(() => assertAudioKindMatchesModel('voice', 'some-unknown-audio-model')).not.toThrow()
    expect(() => assertAudioKindMatchesModel('music', 'some-unknown-audio-model')).toThrow(
      BadRequestException,
    )
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
    // Hermetic: `readPlatformCredentialEnv({})` 会回落到 process.env（见 platformCredentials.ts），
    // 故必须显式清空并恢复，否则调用环境存在 OPENAI_API_KEY 时本用例会假失败。
    const original = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      const r = resolvePlatformAudioFallback('minimax-speech-2.8-hd', {})
      expect(r.ok).toBe(false)
      expect(r.ok ? '' : r.reason).toMatch(/OPENAI_API_KEY/)
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = original
    }
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
