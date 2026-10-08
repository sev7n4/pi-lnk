/**
 * 多模态直通组装（T1 Nest 侧，spec §3.1）：视觉模型 + 侧栏图片附件 →
 * base64 `images` 载荷 + `[I{n}=文件名]` 文本标记（与 dynamicBlocks 的 I 编号同源，
 * pi-runtime 侧 T4 压缩占位与 T2 治理占位都从该标记恢复编号）。
 *
 * 语义：
 * - 非视觉模型 / 无图片附件 → undefined（识图兜底路径原样，缺省行为不变）。
 * - 上限 4 张（与识图 MAX_PARSE_IMAGE_URLS 同款），保序去重。
 * - 单张原始 >5MB → 缩图一次（sharp，2048 长边）后收进 payload。
 * - 单张读盘/缩图失败 → 跳过该图不阻断；全部失败 → undefined。
 * - IO 全部可注入（readBuffer/downscale），纯编排逻辑可单测。
 */
import { readFile } from 'fs/promises'
import { join } from 'path'
import { upstreamFetch } from '@lnkpi/agent'
import { downscaleImageBuffer } from '../media/upstream-ref-downscale'
import { supportsVisionModel } from './sidebar-vision'

export interface DirectImageOut {
  /** 文件名（取 url 末段，decodeURIComponent），用于 [In=] 标记与占位恢复。 */
  name: string
  mimeType: string
  /** base64，无 data: 前缀。 */
  data: string
}

export interface DirectImageBuild {
  images: DirectImageOut[]
  /** `[I1=a.png] [I2=b.jpg]`——由调用方并入发送文本尾部。 */
  markers: string[]
}

export interface DirectImageAttachmentLike {
  url?: string
  text?: string
  mediaType?: string
}

export interface BuildDirectImageInput {
  model?: string | null
  attachments?: DirectImageAttachmentLike[]
  maxImages?: number
  rawLimitBytes?: number
  readBuffer?: (url: string) => Promise<Buffer>
  downscale?: (buf: Buffer) => Promise<{ buffer: Buffer; changed: boolean }>
}

const UPLOADS_ROOT = join(process.cwd(), 'uploads')
const RAW_LIMIT_BYTES = 5 * 1024 * 1024

function sniffMime(buf: Buffer): string {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  return 'image/jpeg'
}

function fileNameFromUrl(url: string): string {
  const path = url.split('?')[0] ?? url
  const last = path.split('/').pop() ?? ''
  try {
    return decodeURIComponent(last) || '图片'
  } catch {
    return last || '图片'
  }
}

/** 本地 uploads ref 读取（与 media/upstream-ref-downscale.readImageBuffer 同语义，独立实现便于 DI 缺省）。 */
async function readUploadsBuffer(url: string): Promise<Buffer> {
  const m = /^\/uploads\/([^/]+)\/([^/?#]+)/.exec(url)
  if (m) return readFile(join(UPLOADS_ROOT, m[1], m[2]))
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 300 * attempt))
    try {
      const res = await upstreamFetch(url)
      if (!res.ok) throw new Error(`参考图下载失败 (${res.status}): ${url}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

export async function buildDirectImagePayload(input: BuildDirectImageInput): Promise<DirectImageBuild | undefined> {
  if (!supportsVisionModel(input.model)) return undefined
  const maxImages = input.maxImages ?? 4
  const rawLimitBytes = input.rawLimitBytes ?? RAW_LIMIT_BYTES
  const readBuffer = input.readBuffer ?? readUploadsBuffer
  const downscale = input.downscale ?? (async (buf: Buffer) => downscaleImageBuffer(buf))

  const urls: string[] = []
  for (const att of input.attachments ?? []) {
    if (!att || typeof att !== 'object') continue
    if ((att.mediaType ?? '').trim().toLowerCase() !== 'image') continue
    const url = (att.url ?? '').trim()
    if (url && !urls.includes(url)) urls.push(url)
    if (urls.length >= maxImages) break
  }
  if (!urls.length) return undefined

  const images: DirectImageOut[] = []
  for (const url of urls) {
    try {
      let buf = await readBuffer(url)
      if (buf.length > rawLimitBytes) {
        const r = await downscale(buf)
        buf = r.buffer
      }
      images.push({ name: fileNameFromUrl(url), mimeType: sniffMime(buf), data: buf.toString('base64') })
    } catch {
      // 单张失败跳过（该图仍可被识图兜底覆盖或直接缺席），不阻断整轮对话
    }
  }
  if (!images.length) return undefined
  return { images, markers: images.map((im, i) => `[I${i + 1}=${im.name}]`) }
}
