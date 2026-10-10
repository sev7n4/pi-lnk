import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { mapMessageToErrorCode, UPSTREAM_ROUTE_SEEDS } from '@lnkpi/shared'
import { CryptoService } from './crypto.service'
import { PLATFORM_CHANNEL_ID } from './provider.service'
import { ProviderResolverService } from './provider-resolver.service'
import {
  __resetUpstreamRouteStoreForTests,
  __setCachedUpstreamRoutesForTests,
} from './upstream-route-store'
import { resolvePlatformAudioFallback } from '../studio/audio-kind'
import { PrismaService } from '../prisma/prisma.service'

type ChannelRow = {
  id: string
  userId: string | null
  name: string
  apiFormat: string
  baseUrl: string
  encryptedApiKey: string | null
  iv: string | null
  authTag: string | null
  keyVersion: number
  models: string
  createdAt: Date
  updatedAt: Date
}

function createMemoryPrisma(seed: ChannelRow[] = []) {
  const channels = new Map<string, ChannelRow>(seed.map((row) => [row.id, row]))
  return {
    providerChannel: {
      findUnique: async ({ where }: { where: { id?: string } }) => {
        if (where.id) return channels.get(where.id) ?? null
        return null
      },
    },
    _channels: channels,
  }
}

describe('ProviderResolverService', () => {
  const originalKey = process.env.BYOK_ENCRYPTION_KEY_V1
  const originalOpenAiKey = process.env.OPENAI_API_KEY
  const originalOpenAiBase = process.env.OPENAI_BASE_URL
  const originalApimartKey = process.env.APIMART_API_KEY
  const originalApimartBase = process.env.APIMART_BASE_URL
  const originalFalKey = process.env.FAL_KEY
  const originalFalBase = process.env.FAL_BASE_URL
  const originalMinimaxKey = process.env.MINIMAX_API_KEY
  const originalMinimaxBase = process.env.MINIMAX_BASE_URL
  const originalStepfunKey = process.env.STEPFUN_API_KEY
  const originalStepfunBase = process.env.STEPFUN_BASE_URL
  let resolver: ProviderResolverService
  let crypto: CryptoService
  let prisma: ReturnType<typeof createMemoryPrisma>

  beforeEach(async () => {
    process.env.BYOK_ENCRYPTION_KEY_V1 = Buffer.alloc(32, 7).toString('base64')
    process.env.OPENAI_API_KEY = 'platform-env-key'
    process.env.OPENAI_BASE_URL = 'https://platform.example.com/v1'
    process.env.APIMART_API_KEY = 'apimart-env-key'
    process.env.APIMART_BASE_URL = 'https://api.apimart.ai/v1'
    delete process.env.FAL_KEY
    delete process.env.FAL_BASE_URL
    delete process.env.MINIMAX_API_KEY
    delete process.env.MINIMAX_BASE_URL
    delete process.env.STEPFUN_API_KEY
    delete process.env.STEPFUN_BASE_URL
    // S2-2b 查表化：内存 prisma 无 UpstreamRoute 表 —— 直接注入种子路由行到 store 缓存
    // （registeredPrisma 不注册 ⇒ TTL 刷新不会触发，缓存即测试注入值）。
    __resetUpstreamRouteStoreForTests()
    __setCachedUpstreamRoutesForTests([...UPSTREAM_ROUTE_SEEDS])
    prisma = createMemoryPrisma([
      {
        id: PLATFORM_CHANNEL_ID,
        userId: null,
        name: '平台服务',
        apiFormat: 'openai',
        baseUrl: 'https://platform.example.com/v1',
        encryptedApiKey: null,
        iv: null,
        authTag: null,
        keyVersion: 1,
        models: '[]',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])
    const moduleRef = await Test.createTestingModule({
      providers: [
        ProviderResolverService,
        CryptoService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile()
    resolver = moduleRef.get(ProviderResolverService)
    crypto = moduleRef.get(CryptoService)
  })

  afterEach(() => {
    if (originalKey === undefined) delete process.env.BYOK_ENCRYPTION_KEY_V1
    else process.env.BYOK_ENCRYPTION_KEY_V1 = originalKey
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalOpenAiKey
    if (originalOpenAiBase === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = originalOpenAiBase
    if (originalApimartKey === undefined) delete process.env.APIMART_API_KEY
    else process.env.APIMART_API_KEY = originalApimartKey
    if (originalApimartBase === undefined) delete process.env.APIMART_BASE_URL
    else process.env.APIMART_BASE_URL = originalApimartBase
    if (originalFalKey === undefined) delete process.env.FAL_KEY
    else process.env.FAL_KEY = originalFalKey
    if (originalFalBase === undefined) delete process.env.FAL_BASE_URL
    else process.env.FAL_BASE_URL = originalFalBase
    if (originalMinimaxKey === undefined) delete process.env.MINIMAX_API_KEY
    else process.env.MINIMAX_API_KEY = originalMinimaxKey
    if (originalMinimaxBase === undefined) delete process.env.MINIMAX_BASE_URL
    else process.env.MINIMAX_BASE_URL = originalMinimaxBase
    if (originalStepfunKey === undefined) delete process.env.STEPFUN_API_KEY
    else process.env.STEPFUN_API_KEY = originalStepfunKey
    if (originalStepfunBase === undefined) delete process.env.STEPFUN_BASE_URL
    else process.env.STEPFUN_BASE_URL = originalStepfunBase
  })

  it('decrypts user channel credentials', async () => {
    const enc = crypto.encrypt('sk-user-secret')
    prisma._channels.set('ch_user', {
      id: 'ch_user',
      userId: 'u1',
      name: 'mine',
      apiFormat: 'openai',
      baseUrl: 'https://user.example.com/v1',
      encryptedApiKey: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      keyVersion: enc.keyVersion,
      models: '[]',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const result = await resolver.resolveForGeneration('u1', 'ch_user::gpt-custom', 'text')
    expect(result).toEqual({
      channelId: 'ch_user',
      modelName: 'gpt-custom',
      apiFormat: 'openai',
      credentials: { apiKey: 'sk-user-secret', baseUrl: 'https://user.example.com/v1' },
      source: 'user',
      channelModelsJson: '[]',
    })
  })

  it('resolves platform channel from env credentials', async () => {
    const result = await resolver.resolveForGeneration('u1', 'platform::agnes-image-2.1-flash', 'image')
    expect(result).toEqual({
      channelId: 'platform',
      modelName: 'agnes-image-2.1-flash',
      apiFormat: 'openai',
      credentials: {
        apiKey: 'platform-env-key',
        baseUrl: 'https://platform.example.com/v1',
      },
      source: 'platform',
      channelModelsJson: '[]',
    })
  })

  it('routes platform seedream/image2 to APIMart credentials', async () => {
    const seedream = await resolver.resolveForGeneration('u1', 'platform::seedream-5.0-pro', 'image')
    expect(seedream.credentials).toEqual({
      apiKey: 'apimart-env-key',
      baseUrl: 'https://api.apimart.ai/v1',
    })

    const image2 = await resolver.resolveForGeneration('u1', 'image2', 'image')
    expect(image2.credentials).toEqual({
      apiKey: 'apimart-env-key',
      baseUrl: 'https://api.apimart.ai/v1',
    })
  })

  it('keeps Agnes credentials for platform text models', async () => {
    const result = await resolver.resolveForGeneration('u1', 'platform::agnes-2.0-flash', 'text')
    expect(result.credentials).toEqual({
      apiKey: 'platform-env-key',
      baseUrl: 'https://platform.example.com/v1',
    })
  })

  it('prefers OPENAI_BASE_URL over stale platform channel baseUrl', async () => {
    const row = prisma._channels.get(PLATFORM_CHANNEL_ID)!
    row.baseUrl = 'https://stale.example.com/v1'
    process.env.OPENAI_BASE_URL = 'https://fresh.example.com/v1'

    const result = await resolver.resolveForGeneration('u1', 'platform::agnes-2.0-flash', 'text')
    expect(result.credentials.baseUrl).toBe('https://fresh.example.com/v1')
  })

  it('defaults empty platform text modelName to OPENAI_CHAT_MODEL', async () => {
    const saved = process.env.OPENAI_CHAT_MODEL
    process.env.OPENAI_CHAT_MODEL = 'agnes-2.0-flash'
    try {
      const result = await resolver.resolveForGeneration('u1', undefined, 'text')
      expect(result.channelId).toBe('platform')
      expect(result.modelName).toBe('agnes-2.0-flash')
    } finally {
      if (saved === undefined) delete process.env.OPENAI_CHAT_MODEL
      else process.env.OPENAI_CHAT_MODEL = saved
    }
  })

  it('keeps empty platform image modelName as-is (no chat default)', async () => {
    const result = await resolver.resolveForGeneration('u1', undefined, 'image')
    expect(result.modelName).toBe('')
  })

  it('treats legacy bare model keys as platform', async () => {
    const result = await resolver.resolveForGeneration('u1', 'agnes-image-2.1-flash', 'image')
    expect(result.channelId).toBe('platform')
    expect(result.modelName).toBe('agnes-image-2.1-flash')
    expect(result.source).toBe('platform')
  })

  it('returns user source without apiKey when channel has no secret', async () => {
    prisma._channels.set('ch_nokey', {
      id: 'ch_nokey',
      userId: 'u1',
      name: 'empty',
      apiFormat: 'openai',
      baseUrl: 'https://user.example.com/v1',
      encryptedApiKey: null,
      iv: null,
      authTag: null,
      keyVersion: 1,
      models: '[]',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const result = await resolver.resolveForGeneration('u1', 'ch_nokey::m1', 'text')
    expect(result.source).toBe('user')
    expect(result.credentials.apiKey).toBeUndefined()
    expect(result.credentials.baseUrl).toBe('https://user.example.com/v1')
  })

  it('routes platform h3-max-turbo to FAL credentials', async () => {
    process.env.FAL_KEY = 'fal-env-key'

    const result = await resolver.resolveForGeneration('u1', 'platform::h3-max-turbo', 'video')
    expect(result).toEqual({
      channelId: 'platform',
      modelName: 'h3-max-turbo',
      apiFormat: 'openai',
      credentials: {
        apiKey: 'fal-env-key',
        baseUrl: 'https://fal.run',
      },
      source: 'platform',
      channelModelsJson: '[]',
    })
  })

  it('honors FAL_BASE_URL override for platform H3 Max', async () => {
    process.env.FAL_KEY = 'fal-env-key'
    process.env.FAL_BASE_URL = 'https://fal.custom.example'

    const result = await resolver.resolveForGeneration('u1', 'platform::h3-max', 'video')
    expect(result.credentials).toEqual({
      apiKey: 'fal-env-key',
      baseUrl: 'https://fal.custom.example',
    })
  })

  it('does not fall back to OPENAI_API_KEY when FAL_KEY is missing', async () => {
    const result = await resolver.resolveForGeneration('u1', 'platform::h3-max-turbo', 'video')
    expect(result.credentials.apiKey).not.toBe('platform-env-key')
    expect(result.credentials.apiKey).toBeFalsy()
    expect(result.credentials.baseUrl).toBe('https://fal.run')
  })

  it('keeps user BYOK credentials for h3-max-turbo', async () => {
    const enc = crypto.encrypt('sk-user-fal')
    prisma._channels.set('ch_user', {
      id: 'ch_user',
      userId: 'u1',
      name: 'mine',
      apiFormat: 'openai',
      baseUrl: 'https://user-fal.example.com',
      encryptedApiKey: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      keyVersion: enc.keyVersion,
      models: '[]',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const result = await resolver.resolveForGeneration('u1', 'ch_user::h3-max-turbo', 'video')
    expect(result).toEqual({
      channelId: 'ch_user',
      modelName: 'h3-max-turbo',
      apiFormat: 'openai',
      credentials: { apiKey: 'sk-user-fal', baseUrl: 'https://user-fal.example.com' },
      source: 'user',
      channelModelsJson: '[]',
    })
  })

  it('routes platform minimax-h3 to MiniMax credentials', async () => {
    process.env.MINIMAX_API_KEY = 'minimax-env-key'

    const result = await resolver.resolveForGeneration('u1', 'platform::minimax-h3', 'video')
    expect(result).toEqual({
      channelId: 'platform',
      modelName: 'minimax-h3',
      apiFormat: 'openai',
      credentials: {
        apiKey: 'minimax-env-key',
        baseUrl: 'https://api.minimax.io',
      },
      source: 'platform',
      channelModelsJson: '[]',
    })
  })

  it('does not fall back to OPENAI_API_KEY when MINIMAX_API_KEY is missing', async () => {
    const result = await resolver.resolveForGeneration('u1', 'platform::minimax-h3', 'video')
    expect(result.credentials.apiKey).not.toBe('platform-env-key')
    expect(result.credentials.apiKey).toBeFalsy()
    expect(result.credentials.baseUrl).toBe('https://api.minimax.io')
  })

  it('keeps platform h3-max-turbo on FAL_KEY instead of MiniMax', async () => {
    process.env.FAL_KEY = 'fal-env-key'
    process.env.MINIMAX_API_KEY = 'minimax-env-key'

    const result = await resolver.resolveForGeneration('u1', 'platform::h3-max-turbo', 'video')
    expect(result.credentials).toEqual({
      apiKey: 'fal-env-key',
      baseUrl: 'https://fal.run',
    })
  })

  it('keeps user BYOK credentials for minimax-h3', async () => {
    const enc = crypto.encrypt('sk-user-minimax')
    prisma._channels.set('ch_user', {
      id: 'ch_user',
      userId: 'u1',
      name: 'mine',
      apiFormat: 'openai',
      baseUrl: 'https://user-minimax.example.com',
      encryptedApiKey: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      keyVersion: enc.keyVersion,
      models: '[]',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const result = await resolver.resolveForGeneration('u1', 'ch_user::minimax-h3', 'video')
    expect(result).toEqual({
      channelId: 'ch_user',
      modelName: 'minimax-h3',
      apiFormat: 'openai',
      credentials: { apiKey: 'sk-user-minimax', baseUrl: 'https://user-minimax.example.com' },
      source: 'user',
      channelModelsJson: '[]',
    })
  })

  it('returns 404 for cross-user channel access', async () => {
    prisma._channels.set('ch_other', {
      id: 'ch_other',
      userId: 'u2',
      name: 'other',
      apiFormat: 'openai',
      baseUrl: 'https://other.example.com/v1',
      encryptedApiKey: null,
      iv: null,
      authTag: null,
      keyVersion: 1,
      models: '[]',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    await expect(
      resolver.resolveForGeneration('u1', 'ch_other::m1', 'text'),
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  it('routes platform stepfun models to StepFun credentials', async () => {
    process.env.STEPFUN_API_KEY = 'stepfun-env-key'

    const result = await resolver.resolveForGeneration(
      'u1',
      'platform::stepaudio-3-gen-preview',
      'audio',
    )
    expect(result).toEqual({
      channelId: 'platform',
      modelName: 'stepaudio-3-gen-preview',
      apiFormat: 'openai',
      credentials: { apiKey: 'stepfun-env-key', baseUrl: 'https://api.stepfun.com/v1' },
      source: 'platform',
      channelModelsJson: '[]',
    })
  })

  it('honors STEPFUN_BASE_URL override', async () => {
    process.env.STEPFUN_API_KEY = 'stepfun-env-key'
    process.env.STEPFUN_BASE_URL = 'https://stepfun.custom/v1'

    const result = await resolver.resolveForGeneration('u1', 'platform::stepaudio-3-tts', 'audio')
    expect(result.credentials.baseUrl).toBe('https://stepfun.custom/v1')
  })

  it('🔴 缺 STEPFUN_API_KEY 时 baseUrl 仍指向阶跃（不得回落到 OpenAI 端点）', async () => {
    const result = await resolver.resolveForGeneration(
      'u1',
      'platform::stepaudio-3-music-preview',
      'audio',
    )
    expect(result.credentials.apiKey).not.toBe('platform-env-key')
    expect(result.credentials.apiKey).toBeFalsy()
    expect(result.credentials.baseUrl).toBe('https://api.stepfun.com/v1')
  })

  it('不干扰既有 fal / minimax 分支', async () => {
    process.env.FAL_KEY = 'fal-env-key'
    process.env.MINIMAX_API_KEY = 'minimax-env-key'
    process.env.STEPFUN_API_KEY = 'stepfun-env-key'

    expect(
      (await resolver.resolveForGeneration('u1', 'platform::h3-max-turbo', 'video')).credentials,
    ).toEqual({ apiKey: 'fal-env-key', baseUrl: 'https://fal.run' })
    expect(
      (await resolver.resolveForGeneration('u1', 'platform::minimax-h3', 'video')).credentials,
    ).toEqual({ apiKey: 'minimax-env-key', baseUrl: 'https://api.minimax.io' })
  })

  it('A6：路由命中但缺 key —— baseUrl 仍指向阶跃 + 下游回退通路显式报错（文案含「未配置」，绝不静默回落）', async () => {
    const result = await resolver.resolveForGeneration(
      'u1',
      'platform::stepaudio-3-music-preview',
      'audio',
    )
    // resolver 层：绝不静默错路由到 OpenAI 端点/密钥
    expect(result.credentials.apiKey).not.toBe('platform-env-key')
    expect(result.credentials.apiKey).toBeFalsy()
    expect(result.credentials.baseUrl).toBe('https://api.stepfun.com/v1')
    // 下游回退通路（audio fallback）：既有显式失败语义，错误文案含「未配置」
    const fallback = resolvePlatformAudioFallback('stepaudio-3-music-preview')
    expect(fallback.ok).toBe(false)
    if (!fallback.ok) expect(fallback.reason).toContain('未配置')
  })

  it('A6：apimart 主 key 缺失时按命中行 fallbackApiKeyEnvName 回落 OPENAI_API_KEY', async () => {
    delete process.env.APIMART_API_KEY
    const result = await resolver.resolveForGeneration('u1', 'platform::seedream-5.0-pro', 'image')
    expect(result.credentials).toEqual({
      apiKey: 'platform-env-key',
      baseUrl: 'https://api.apimart.ai/v1',
    })
  })

  it('查表化：路由行是数据真源 —— 禁用 stepfun 行后 stepaudio-* 落 default（agnes hub）', async () => {
    __setCachedUpstreamRoutesForTests(
      UPSTREAM_ROUTE_SEEDS.map((row) =>
        row.upstream === 'stepfun' ? { ...row, enabled: false } : { ...row },
      ),
    )
    const result = await resolver.resolveForGeneration('u1', 'platform::stepaudio-3-tts', 'audio')
    expect(result.credentials).toEqual({
      apiKey: 'platform-env-key',
      baseUrl: 'https://platform.example.com/v1',
    })
  })

  it('查表化：缓存为空且无 default 行 → 确定性抛错（A3，绝不静默回落 OpenAI 链）', async () => {
    __setCachedUpstreamRoutesForTests([])
    await expect(
      resolver.resolveForGeneration('u1', 'platform::agnes-2.0-flash', 'text'),
    ).rejects.toThrow(/禁止回落 OpenAI 链/)
  })

  // ── S2-3 生成入口 availability 校验 ────────────────────────────────

  it('S2-3：探活 unavailable 的平台模型 → 400 拒绝，body 携带 errorCode=model_unavailable', async () => {
    prisma._channels.set(PLATFORM_CHANNEL_ID, {
      ...prisma._channels.get(PLATFORM_CHANNEL_ID)!,
      models: JSON.stringify([
        { name: 'agnes-image-2.1-flash', capability: 'image', availability: 'unavailable' },
      ]),
    })
    const err = await resolver
      .resolveForGeneration('u1', 'platform::agnes-image-2.1-flash', 'image')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BadRequestException)
    const body = (err as BadRequestException).getResponse() as Record<string, unknown>
    expect(body.errorCode).toBe('model_unavailable')
    expect(String(body.message)).toContain('停用')
  })

  it('S2-3：拒绝 message 命中 S0-2 字面量族（模型+停用 → model_unavailable）', () => {
    expect(mapMessageToErrorCode('模型「agnes-image-2.1-flash」已停用，请更换可用模型后重试')).toBe(
      'model_unavailable',
    )
  })

  it('S2-3：available / unknown / 缺条目 / 镜像畸形 JSON → 放行', async () => {
    prisma._channels.set(PLATFORM_CHANNEL_ID, {
      ...prisma._channels.get(PLATFORM_CHANNEL_ID)!,
      models: JSON.stringify([
        { name: 'agnes-video-v2.0', capability: 'video', availability: 'available' },
        { name: 'seedance-2.0-mini', capability: 'video' },
      ]),
    })
    await expect(
      resolver.resolveForGeneration('u1', 'platform::agnes-video-v2.0', 'video'),
    ).resolves.toMatchObject({ source: 'platform' })
    await expect(
      resolver.resolveForGeneration('u1', 'platform::seedance-2.0-mini', 'video'),
    ).resolves.toMatchObject({ source: 'platform' })
    await expect(
      resolver.resolveForGeneration('u1', 'platform::not-in-mirror', 'image'),
    ).resolves.toMatchObject({ source: 'platform' })
    prisma._channels.set(PLATFORM_CHANNEL_ID, {
      ...prisma._channels.get(PLATFORM_CHANNEL_ID)!,
      models: 'not-json',
    })
    await expect(
      resolver.resolveForGeneration('u1', 'platform::agnes-video-v2.0', 'video'),
    ).resolves.toMatchObject({ source: 'platform' })
  })

  it('S2-3：BYOK 渠道不参与 availability 校验（镜像语义只覆盖平台渠道）', async () => {
    const enc = crypto.encrypt('sk-user-key')
    prisma._channels.set('ch_user', {
      id: 'ch_user',
      userId: 'u1',
      name: '自定义',
      apiFormat: 'openai',
      baseUrl: 'https://user.example.com/v1',
      encryptedApiKey: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      keyVersion: enc.keyVersion,
      models: JSON.stringify([
        { name: 'my-model', capability: 'image', availability: 'unavailable' },
      ]),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const resolved = await resolver.resolveForGeneration(
      'u1',
      'ch_user::my-model',
      'image',
    )
    expect(resolved.source).toBe('user')
    expect(resolved.modelName).toBe('my-model')
  })
})
