/**
 * VoiceStudio 运行时音色同步（P1 §4.1「音色同步」，2026-11-24）。
 *
 * 职责：`GET {OMNIVOICE_BASE_URL}/v1/audio/voices` → 进程内缓存 → 经
 * `mergeVoiceStudioVoices()` 并入目录条目，让 dock 下拉与生成侧 voice 校验
 * （generation-adapter `resolveVoice`，吃 `currentCatalogEntries()`）看到**同一份**
 * 运行时音色 —— 只在下发层合并、生成侧不合并会音色 id 校验不过被静默换默认
 * （droppedFields），违反「禁静默换道」。
 *
 * 拉取模式：**复用 model-catalog-store 的「TTL 惰性刷新 + 失败保旧值」家族模式**
 * （非独立定时器）：`voiceStudioRuntimeVoices()` 读缓存；TTL 过期由
 * `refreshVoiceStudioVoices()` 异步 fire-and-forget 拉取；失败吞掉保旧值（与
 * upstream-probe 非阻塞惯例一致）。VS 停机 ⇒ 下拉回退到条目静态保底表（OpenAI
 * 标准别名，VOICESTUDIO_MODEL_ENTRY.voices），**不阻塞、不报错**。
 *
 * 响应形状（VS v0.5.8 `openai_compat.py list_voices` 实证）：
 * `{"voices": [{"id"/"voice_id", "name", "type": "openai_alias"|"profile", ...}], "engines": [...]}`
 * —— 归一为 StudioVoiceOption `{id, label}`；畸形响应防御式返回 null（保旧值）。
 */
import { upstreamFetch } from '@lnkpi/agent'
import {
  isVoiceStudioEnvConfigured,
  readPlatformCredentialEnv,
  VOICESTUDIO_MODEL_ENTRY,
  type StudioModelEntry,
  type StudioVoiceOption,
} from '@lnkpi/shared'

/** 音色缓存 TTL（毫秒）。目录 5s TTL 是「后台改动生效」预算；音色是部署期缓慢
 *  变化的资产（装引擎/建 profile），60s 足够且显著减少对本地实例的探测频率。 */
export const VOICESTUDIO_VOICES_TTL_MS = 60_000

/** 音色拉取超时（与探活同款 5s：本地实例内网往返，慢即视作不可用）。 */
export const VOICESTUDIO_VOICES_TIMEOUT_MS = 5_000

interface VoiceStudioVoicesCache {
  voices: StudioVoiceOption[]
  at: number
}

let voicesCache: VoiceStudioVoicesCache | null = null
let refreshInFlight: Promise<void> | null = null

/** 测试专用：重置模块级缓存/在途刷新（vitest isolate per file）。 */
export function __resetVoiceStudioRuntimeForTests(): void {
  voicesCache = null
  refreshInFlight = null
}

/** 测试专用：观察在途刷新（同步触发后 await 它再断言新值）。 */
export function __voiceStudioVoicesRefreshInFlightForTests(): Promise<void> | null {
  return refreshInFlight
}

function vsBaseUrl(): string {
  return (readPlatformCredentialEnv().omnivoiceBaseUrl || '').replace(/\/+$/, '')
}

function vsApiKey(): string {
  return readPlatformCredentialEnv().omnivoiceApiKey || ''
}

/** VS /v1/audio/voices 响应的最小形状（防御式解析，缺字段不炸）。 */
interface VsVoicesResponse {
  voices?: Array<{ id?: unknown; voice_id?: unknown; name?: unknown }>
}

export function parseVoiceStudioVoicesResponse(raw: unknown): StudioVoiceOption[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const list = (raw as VsVoicesResponse).voices
  if (!Array.isArray(list)) return null
  const out: StudioVoiceOption[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' && item.id ? item.id : typeof item.voice_id === 'string' ? item.voice_id : ''
    if (!id) continue
    const label = typeof item.name === 'string' && item.name ? item.name : id
    out.push({ id, label })
  }
  // 空清单视作畸形（VS 恒返回 OpenAI 标准别名 + default，见 VOICESTUDIO_MODEL_ENTRY 注）
  return out.length > 0 ? out : null
}

/**
 * 拉取并刷新音色缓存（失败吞掉保旧值，向上不抛）。
 * 供 TTL 惰性触发；也可由部署 runbook / 冒烟探针显式 await。
 * 测试注入：upstreamFetch 走全局 fetch，用 vi.stubGlobal 替换（audio-provider.test.ts 同款）。
 */
export async function refreshVoiceStudioVoices(): Promise<void> {
  if (!isVoiceStudioEnvConfigured()) return
  try {
    const res = await upstreamFetch(`${vsBaseUrl()}/v1/audio/voices`, {
      headers: { Authorization: `Bearer ${vsApiKey()}` },
      timeoutMs: VOICESTUDIO_VOICES_TIMEOUT_MS,
    })
    if (!res.ok) return // 非法状态码：保旧值，不缓存失败（音色缺失只影响下拉丰富度，不当故障）
    const parsed = parseVoiceStudioVoicesResponse(await res.json())
    if (parsed) voicesCache = { voices: parsed, at: Date.now() }
  } catch {
    // VS 停机/超时：保旧值。不缓存「失败态」——下次 TTL 到期再试（音色拉取廉价）。
  }
}

/** 当前运行时音色（缓存优先）；TTL 过期时异步触发刷新（fire-and-forget）。 */
export function voiceStudioRuntimeVoices(): StudioVoiceOption[] | null {
  if (isVoiceStudioEnvConfigured() && !refreshInFlight && (!voicesCache || Date.now() - voicesCache.at > VOICESTUDIO_VOICES_TTL_MS)) {
    refreshInFlight = refreshVoiceStudioVoices()
      .catch(() => {}) // 双保险：实现内已吞，防御未来重构重新引入抛错
      .finally(() => {
        refreshInFlight = null
      })
  }
  return voicesCache?.voices ?? null
}

/**
 * 目录行音色合并：仅 `voicestudio-http` 条目用运行时缓存覆盖静态保底表；
 * 其余条目原样返回（引用不变，零开销）。VS 条目在 env 未配置时不注册
 * （model-catalog-store 注入判据），本函数不重复判 env。
 */
export function mergeVoiceStudioVoices(rows: StudioModelEntry[]): StudioModelEntry[] {
  const runtime = voiceStudioRuntimeVoices()
  if (!runtime) return rows
  return rows.map((entry) => {
    if (entry.providerBinding !== 'voicestudio-http') return entry
    // 运行时清单在则覆盖；保底表 = VOICESTUDIO_MODEL_ENTRY.voices（VS 条目缺省同源，
    // admin 自建行也可能缺 voices —— 统一按保底表兜底，保 dock 下拉非空）
    return { ...entry, voices: runtime }
  })
}

/** 供 runbook/冒烟探针断言：静态保底表与 VS 条目 SSOT 一致（防双源漂移）。 */
export function voiceStudioFallbackVoices(): StudioVoiceOption[] {
  return VOICESTUDIO_MODEL_ENTRY.voices ?? []
}
