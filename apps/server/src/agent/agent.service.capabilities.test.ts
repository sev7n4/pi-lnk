import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getModelEntry, listModels } from '@lnkpi/shared'
import { AgentService } from './agent.service'

const OBJECT_STORAGE_ENV_KEYS = [
  'OBJECT_STORAGE_DRIVER',
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_BUCKET',
  'OBJECT_STORAGE_ACCESS_KEY',
  'OBJECT_STORAGE_SECRET_KEY',
] as const

const CAPABILITY_ENV_KEYS = [...OBJECT_STORAGE_ENV_KEYS] as const

function createAgentService() {
  return new AgentService(
    {} as never,
    { create: vi.fn() } as never,
    { createFromAgent: vi.fn() } as never,
    { resolveForGeneration: vi.fn() } as never,
  )
}

describe('AgentService getCapabilities', () => {
  const savedEnv: Partial<Record<(typeof CAPABILITY_ENV_KEYS)[number], string | undefined>> = {}

  beforeEach(() => {
    for (const key of CAPABILITY_ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of CAPABILITY_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedEnv[key]
      }
    }
  })

  it('exposes stsDirectUpload from object storage env', () => {
    const svc = createAgentService()
    expect(svc.getCapabilities()).toEqual(
      expect.objectContaining({ stsDirectUpload: expect.any(Boolean) }),
    )
  })

  it('returns stsDirectUpload false when object storage is not configured', () => {
    const svc = createAgentService()
    expect(svc.getCapabilities().stsDirectUpload).toBe(false)
  })

  it('returns stsDirectUpload true when object storage env is complete', () => {
    process.env.OBJECT_STORAGE_ENDPOINT = 'https://s3.example.com'
    process.env.OBJECT_STORAGE_BUCKET = 'uploads'
    process.env.OBJECT_STORAGE_ACCESS_KEY = 'ak'
    process.env.OBJECT_STORAGE_SECRET_KEY = 'sk'

    const svc = createAgentService()
    expect(svc.getCapabilities().stsDirectUpload).toBe(true)
  })

  it('returns stsDirectUpload false when driver is none', () => {
    process.env.OBJECT_STORAGE_DRIVER = 'none'
    process.env.OBJECT_STORAGE_ENDPOINT = 'https://s3.example.com'
    process.env.OBJECT_STORAGE_BUCKET = 'uploads'
    process.env.OBJECT_STORAGE_ACCESS_KEY = 'ak'
    process.env.OBJECT_STORAGE_SECRET_KEY = 'sk'

    const svc = createAgentService()
    expect(svc.getCapabilities().stsDirectUpload).toBe(false)
  })

  // ─────────────────────────────────────────────────────────────
  // 模型清单回归锁（2026-10-08）
  //
  // ⚠️ 本文件此前 4 条用例**全部只断言 stsDirectUpload**，对模型清单零断言 ——
  // 所以把getCapabilities 从「手写幽灵清单」改成 catalog 派生时，它是**假绿**通过。
  //
  //⛔ 事故背景：旧实现返回 `TEXT_MODELS`/`IMAGE_MODELS`/`VIDEO_MODELS`
  //（gpt-4o / dall-e-3 / sora…），与 catalog **零重叠** ⇒ 前端能选到后端
  // `resolveModelKey` 查不到的id ⇒ 静默回落默认模型（`fallback:true` 只写 metadata）
  // ⇒ 选了 A 生成 B，且照扣费、页面不报错。
  //
  // 下面的断言把「接口暴露的模型 id 必须能被 catalog 解析」锁死。
  // ─────────────────────────────────────────────────────────────
  describe('模型清单同源（幽灵清单回归锁）', () => {
    it('返回的每个模型 id 都能在 catalog 里查到，且 modality 对得上', () => {
      const svc = createAgentService()
      const caps = svc.getCapabilities()

      for (const modality of ['text', 'image', 'video'] as const) {
        const expected = listModels(modality).map((e) => e.modelKey)
        expect(caps[modality].map((m) => m.id), `${modality} 维度`).toEqual(expected)
      }
    })

    it('不暴露任何 catalog 之外的幽灵 id', () => {
      const svc = createAgentService()
      const caps = svc.getCapabilities()
      const allIds = [
        ...caps.text.map((m) => m.id),
        ...caps.image.map((m) => m.id),
        ...caps.video.map((m) => m.id),
        ...caps.audio.map((m) => m.id),
      ]
      expect(allIds.length).toBeGreaterThan(0)
      for (const id of allIds) {
        expect(getModelEntry(id), `接口暴露了 catalog 外的模型：${id}`).toBeDefined()
      }
    })

    it('补上 audio 维度（catalog 有 4 modality，旧实现只有 3 个）', () => {
      const svc = createAgentService()
      const caps = svc.getCapabilities()
      expect(caps.audio.map((m) => m.id)).toEqual(listModels('audio').map((e) => e.modelKey))
    })
  })
})
