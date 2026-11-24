import { describe, it, expect, vi } from 'vitest'
import { registerVoiceProfile, type VoiceProfileRecordDeps } from './voice-profile-registry'

function deps(upsertSpy?: ReturnType<typeof vi.fn>): VoiceProfileRecordDeps {
  return {
    voiceProfileRecord: {
      upsert: upsertSpy ?? vi.fn(async () => ({})),
    },
  }
}

const CLONED = {
  userId: 'u1',
  profileId: 'vp_abc',
  profileName: 'lnk-u1abcd-hero',
  displayName: '男主',
  source: 'cloned',
  refUrl: '/api/uploads/u1/ref.mp3',
}

describe('registerVoiceProfile（合规台账，spec §6#3）', () => {
  it('a1: cloned 全量入参 → upsert 落库（refUrl 原样保留）', async () => {
    const spy = vi.fn(async () => ({}))
    const out = await registerVoiceProfile(deps(spy), CLONED)
    expect(out).toEqual({ ok: true, profileId: 'vp_abc' })
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_profileId: { userId: 'u1', profileId: 'vp_abc' } },
        create: expect.objectContaining({ source: 'cloned', refUrl: '/api/uploads/u1/ref.mp3' }),
      }),
    )
  })

  it('a2: designed 无 refUrl → 合法登记（refUrl=null）', async () => {
    const spy = vi.fn(async () => ({}))
    const out = await registerVoiceProfile(deps(spy), {
      userId: 'u1',
      profileId: 'vp_d1',
      profileName: 'lnk-u1abcd-narrator',
      source: 'designed',
    })
    expect(out.ok).toBe(true)
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ source: 'designed', refUrl: null }),
      }),
    )
  })

  it('a3: cloned 缺 refUrl → 拒绝（台账完整性）', async () => {
    const out = await registerVoiceProfile(deps(), { ...CLONED, refUrl: undefined })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('必须提供 refUrl')
  })

  it('a4: refUrl 外部 URL → 拒登（防御纵深：链路绕行也进不了台账）', async () => {
    const out = await registerVoiceProfile(deps(), { ...CLONED, refUrl: 'https://evil.example/steal.mp3' })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('仅支持 uploads 引用')
  })

  it('a5: refUrl 旧 /uploads/ 相对形态 → 放行（与 read-audio 同判定）', async () => {
    const spy = vi.fn(async () => ({}))
    const out = await registerVoiceProfile(deps(spy), { ...CLONED, refUrl: '/uploads/u1/ref.mp3' })
    expect(out.ok).toBe(true)
  })

  it('a6: designed 带 refUrl → 拒绝（入参自相矛盾防脏数据）', async () => {
    const out = await registerVoiceProfile(deps(), { ...CLONED, source: 'designed' })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('不应携带 refUrl')
  })

  it('a7: source 非法 → 拒绝', async () => {
    const out = await registerVoiceProfile(deps(), { ...CLONED, source: 'stolen' })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('cloned|designed')
  })

  it('a8: 缺 userId / profileId / profileName → 各自拒绝', async () => {
    for (const key of ['userId', 'profileId', 'profileName'] as const) {
      const out = await registerVoiceProfile(deps(), { ...CLONED, [key]: undefined })
      expect(out.ok).toBe(false)
    }
  })

  it('a9: upsert where 走 userId_profileId（重克隆幂等不堆行）', async () => {
    const spy = vi.fn(async () => ({}))
    await registerVoiceProfile(deps(spy), { ...CLONED, displayName: '男主v2' })
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ displayName: '男主v2' }),
      }),
    )
  })
})
