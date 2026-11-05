/**
 * read_media 的 Nest 侧取图（VISP S-7）：uploads 引用 → 本地盘直读（唯一取图点）
 * → mime 判定 → 超 2MB 缩图 → base64。无状态：不接受 sessionId、不查库；
 * 只接受 uploads 引用形态（R-V9：画布节点走 view_canvas_media）。凡非该形态的
 * 输入（含外部公网 URL）一律按"格式不支持"拒绝——机制是形态匹配，不做 host
 * 校验、不做任何网络 fetch——
 * pod 对宿主 IP hairpin 不可达，任何网络 fetch 都不做）。
 */
import { readFile } from 'fs/promises'
import { join } from 'path'
import { parseUploadRefPath } from '@lnkpi/shared'
import { downscaleImageBuffer } from '../media/upstream-ref-downscale'

export const READ_MEDIA_MAX_BYTES = 2 * 1024 * 1024

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

export interface ReadMediaDeps {
  uploadsRoot?: string
  readBuffer?: (path: string) => Promise<Buffer>
  downscale?: (buf: Buffer) => Promise<{ buffer: Buffer; changed: boolean }>
}

export type ReadMediaResult =
  | { ok: true; base64: string; mimeType: string; fileName: string; downscaled: boolean }
  | { ok: false; error: string }

export async function loadReadMediaImage(
  input: { url?: string },
  deps: ReadMediaDeps = {},
): Promise<ReadMediaResult> {
  const url = (input?.url ?? '').trim()
  if (!url) return { ok: false, error: '缺少 url（uploads 引用）' }

  // 与 direct-image-payload.resolveUploadsFilePath 同语义（绝对/相对 /api/uploads/，
  // 兜旧 /uploads/ 相对形态），但 uploadsRoot 可注入：
  const upload = parseUploadRefPath(url)
  let rel: { userId: string; fileName: string } | null = upload
  if (!rel) {
    const m = /^\/uploads\/([^/]+)\/([^/?#]+)/.exec(url)
    if (m) rel = { userId: m[1], fileName: m[2] }
  }
  if (!rel) {
    // R-V9 / Review Focus 2d：非 uploads 引用一律拒绝，绝不发起网络 fetch
    return { ok: false, error: `仅支持 uploads 引用（/api/uploads/…），收到: ${url.slice(0, 120)}` }
  }

  // Review #1/#2：decodeURIComponent 对畸形 % 抛 URIError（会污染 NestClient 熔断）；
  // userId/fileName 含 `..` 或以 `.` 开头 = 路径穿越，必须在读盘前拒绝。
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
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
  const resolvedMime = MIME_BY_EXT[ext]
  if (!resolvedMime) {
    // 白名单外格式（tiff/bmp/无扩展名…）直接拒绝——上游 provider 只收 png/jpeg/gif/webp
    return { ok: false, error: `不支持的图片格式（${ext || '无扩展名'}），仅 png/jpeg/gif/webp` }
  }
  const readBuffer = deps.readBuffer ?? (async (p: string) => readFile(p))
  const downscale =
    deps.downscale ??
    (async (buf: Buffer) => {
      const r = await downscaleImageBuffer(buf)
      return { buffer: r.buffer, changed: r.changed }
    })

  let buf: Buffer
  try {
    buf = await readBuffer(localPath)
  } catch (err) {
    return { ok: false, error: `读取失败: ${err instanceof Error ? err.message : String(err)}` }
  }

  let mimeType: string = resolvedMime
  let downscaled = false
  if (buf.length > READ_MEDIA_MAX_BYTES) {
    try {
      const r = await downscale(buf)
      // Review #3：changed:false（尺寸本就 ≤2048，未重编码）时不得谎报
      // downscaled=true / mime=jpeg（违反 R-V8 不撒谎契约）——原字节原 mime 返回
      buf = r.buffer
      downscaled = r.changed
      if (r.changed) mimeType = 'image/jpeg' // downscaleImageBuffer 缩放时输出 mozjpeg
    } catch (err) {
      return { ok: false, error: `缩图失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  return { ok: true, base64: buf.toString('base64'), mimeType, fileName, downscaled }
}
