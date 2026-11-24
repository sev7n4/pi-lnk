/**
 * VoiceStudio P3：克隆/设计音色合规台账（spec 2026-11-24-voicestudio-p1p2 §6#3）。
 *
 * pi-runtime clone_voice / design_voice 成功后 POST /agent/internal/voice-profiles
 * upsert 登记（userId+profileId 唯一键，重克隆刷新不堆行）。审计 = 按 profileId /
 * userId 查表（生产 DB 直查；admin UI 需求出现时再起读端点，YAGNI）。
 *
 * 合规链路三点的最后一块：
 *   #1 限自有参考音频 → read-audio.ts uploads 形态 enforcement（PR2）
 *   #2 AI 标识声明   → web 上传权利声明文案（PR3，voiceRightsConsent.ts）
 *   #3 来源标记      → 本表（source/refUrl/时间）+ VS 侧 lnk-<userId8>-<name> 命名
 *
 * refUrl 校验：source=cloned 必填且必须是 uploads 引用形态（与 read-audio 同判定）——
 * 台账只留合规取材痕迹，外部 URL 参考在 enforcement 已被拒，若出现即链路被绕行，
 * 登记也必须拒绝（防御纵深，不靠上游自觉）。
 */
import { parseUploadRefPath } from '@lnkpi/shared'

export type VoiceProfileSource = 'cloned' | 'designed'

export interface VoiceProfileRecordDeps {
  /** PrismaService 形状最小化：只依赖 voiceProfileRecord.upsert（测试免起服务）。 */
  voiceProfileRecord: {
    upsert(args: {
      where: { userId_profileId: { userId: string; profileId: string } }
      create: { userId: string; profileId: string; profileName: string; displayName: string; source: string; refUrl: string | null }
      update: { profileName: string; displayName: string; source: string; refUrl: string | null }
    }): Promise<unknown>
  }
}

export interface RegisterVoiceProfileInput {
  userId?: string
  profileId?: string
  profileName?: string
  displayName?: string
  source?: string
  refUrl?: string
}

export type RegisterVoiceProfileResult =
  | { ok: true; profileId: string }
  | { ok: false; error: string }

export async function registerVoiceProfile(
  deps: VoiceProfileRecordDeps,
  input: RegisterVoiceProfileInput,
): Promise<RegisterVoiceProfileResult> {
  const userId = (input?.userId ?? '').trim()
  const profileId = (input?.profileId ?? '').trim()
  const profileName = (input?.profileName ?? '').trim()
  const displayName = (input?.displayName ?? '').trim()
  const source = (input?.source ?? '').trim()
  const refUrl = (input?.refUrl ?? '').trim()

  if (!userId) return { ok: false, error: '缺少 userId' }
  if (!profileId) return { ok: false, error: '缺少 profileId' }
  if (!profileName) return { ok: false, error: '缺少 profileName（lnk-<userId8>-<name> 规范名）' }
  if (source !== 'cloned' && source !== 'designed') {
    return { ok: false, error: `source 仅支持 cloned|designed，收到: ${source.slice(0, 40)}` }
  }

  let refUrlNorm: string | null = null
  if (source === 'cloned') {
    if (!refUrl) return { ok: false, error: 'source=cloned 必须提供 refUrl（参考音频 uploads 引用）' }
    // 与 read-audio.ts 同判定：台账只留合规取材痕迹（uploads 引用），外部 URL 拒登
    const rel = parseUploadRefPath(refUrl) ?? /^\/uploads\/([^/]+)\/([^/?#]+)/.exec(refUrl)
    if (!rel) {
      return {
        ok: false,
        error: `refUrl 仅支持 uploads 引用（/api/uploads/…），收到: ${refUrl.slice(0, 120)}`,
      }
    }
    refUrlNorm = refUrl
  } else if (refUrl) {
    // designed 声称带参考音频 = 入参自相矛盾，拒登（防脏数据混入台账）
    return { ok: false, error: 'source=designed 不应携带 refUrl' }
  }

  await deps.voiceProfileRecord.upsert({
    where: { userId_profileId: { userId, profileId } },
    create: { userId, profileId, profileName, displayName, source, refUrl: refUrlNorm },
    update: { profileName, displayName, source, refUrl: refUrlNorm },
  })
  return { ok: true, profileId }
}
