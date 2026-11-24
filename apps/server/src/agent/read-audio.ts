/**
 * VoiceStudio P2：clone_voice / transcribe 的 Nest 侧取音频（spec
 * 2026-11-24-voicestudio-p1p2-implementation-spec.md §5.2）。
 *
 * 与 read-media.ts 同款机制（uploads 引用形态匹配 → 本地盘直读 → base64），
 * 差异仅在 mime 白名单（音频）与无缩图。两处刻意平行、不抽公共：
 * read-media 有缩图/2MB 特有逻辑，共享面只有形态校验三行，抽公共反增耦合。
 *
 * 无状态：不查库、不做任何网络 fetch（pod 对宿主 IP hairpin 不可达，
 * 与 read-media 同一教训）；外部 URL / 非 uploads 形态一律拒绝——
 * 合规三件套 #1「限自有参考音频」的机器 enforcement 点（spec §6）。
 */
import { readFile } from 'fs/promises'
import { join } from 'path'
import { parseUploadRefPath } from '@lnkpi/shared'

/** 参考音频/转写输入的原始字节上限。VS MCP 侧单工具限 200MB，但本仓走
 * JSON base64（×1.33）经 NestClient→pi-runtime→MCP Streamable HTTP 三跳，
 * 20MB 原始（~27MB base64）已远超克隆建议时长（5-30s 干净人声 ≈ 1MB 级）。 */
export const READ_AUDIO_MAX_BYTES = 20 * 1024 * 1024

const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.webm': 'audio/webm',
  '.aac': 'audio/aac',
}

export interface ReadAudioDeps {
  uploadsRoot?: string
  readBuffer?: (path: string) => Promise<Buffer>
}

export type ReadAudioResult =
  | { ok: true; base64: string; mimeType: string; fileName: string }
  | { ok: false; error: string }

export async function loadReadAudio(
  input: { url?: string },
  deps: ReadAudioDeps = {},
): Promise<ReadAudioResult> {
  const url = (input?.url ?? '').trim()
  if (!url) return { ok: false, error: '缺少 url（uploads 引用）' }

  // 与 read-media.ts 同语义（绝对/相对 /api/uploads/，兜旧 /uploads/ 相对形态）
  const upload = parseUploadRefPath(url)
  let rel: { userId: string; fileName: string } | null = upload
  if (!rel) {
    const m = /^\/uploads\/([^/]+)\/([^/?#]+)/.exec(url)
    if (m) rel = { userId: m[1], fileName: m[2] }
  }
  if (!rel) {
    // 合规 #1：非 uploads 引用一律拒绝（含外部公网 URL），绝不发起网络 fetch
    return { ok: false, error: `仅支持 uploads 引用（/api/uploads/…），收到: ${url.slice(0, 120)}` }
  }

  // 与 read-media.ts 同款：decodeURIComponent 畸形 % 防御 + 路径穿越在读盘前拒绝
  let fileName: string
  try {
    fileName = decodeURIComponent(rel.fileName)
  } catch {
    return { ok: false, error: '文件名编码非法，无法解析（含畸形 % 转义）' }
  }
  if (rel.userId.includes('..') || rel.fileName.includes('..') || rel.userId.startsWith('.')) {
    return { ok: false, error: '非法 uploads 引用（路径穿越）' }
  }

  const localPath = join(deps.uploadsRoot ?? join(process.cwd(), 'uploads'), rel.userId, rel.fileName)
  const dot = fileName.lastIndexOf('.')
  const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : ''
  const resolvedMime = MIME_BY_EXT[ext]
  if (!resolvedMime) {
    return {
      ok: false,
      error: `不支持的音频格式（${ext || '无扩展名'}），仅 mp3/wav/m4a/mp4/flac/ogg/opus/webm/aac`,
    }
  }

  const readBuffer = deps.readBuffer ?? (async (p: string) => readFile(p))
  let buf: Buffer
  try {
    buf = await readBuffer(localPath)
  } catch (err) {
    return { ok: false, error: `读取失败: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (buf.length > READ_AUDIO_MAX_BYTES) {
    return {
      ok: false,
      error: `音频超过 ${Math.floor(READ_AUDIO_MAX_BYTES / (1024 * 1024))}MB 上限（${(buf.length / (1024 * 1024)).toFixed(1)}MB）；克隆参考音频建议 5-30 秒干净人声`,
    }
  }

  return { ok: true, base64: buf.toString('base64'), mimeType: resolvedMime, fileName }
}
