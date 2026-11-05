import { mkdir, mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadReadMediaImage, READ_MEDIA_MAX_BYTES } from './read-media'

// 1×1 PNG（67 字节）
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

describe('loadReadMediaImage（VISP S-7 Nest 取图）', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'read-media-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const seed = async (rel: string, buf: Buffer) => {
    const p = join(dir, rel)
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, buf)
  }
  const deps = (overrides: Partial<Parameters<typeof loadReadMediaImage>[1]> = {}) => ({
    uploadsRoot: dir,
    ...overrides,
  })

  it('2a: 相对 /api/uploads/ 引用 → 读盘成功返回 base64+mime', async () => {
    await seed('u1/a.png', PNG_1PX)
    const out = await loadReadMediaImage({ url: `/api/uploads/u1/a.png` }, deps())
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.mimeType).toBe('image/png')
      expect(out.fileName).toBe('a.png')
      expect(out.downscaled).toBe(false)
      expect(Buffer.from(out.base64, 'base64')).toEqual(PNG_1PX)
    }
  })

  it('2b: 绝对公网 URL（事故形态）→ 同样读盘成功', async () => {
    await seed('u1/b.jpg', PNG_1PX)
    const out = await loadReadMediaImage(
      { url: 'http://119.29.173.89:8888/api/uploads/u1/b.jpg' },
      deps(),
    )
    expect(out.ok).toBe(true)
  })

  it('2c: 超 2MB → 缩图后成功且 downscaled=true、mime 转 jpeg', async () => {
    await seed('u1/big.png', Buffer.alloc(READ_MEDIA_MAX_BYTES + 1, 1))
    const big = { buffer: Buffer.from('jpeg-bytes'), width: 1024, height: 768, changed: true }
    const out = await loadReadMediaImage(
      { url: '/api/uploads/u1/big.png' },
      deps({ downscale: async () => big }),
    )
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.downscaled).toBe(true)
      expect(out.mimeType).toBe('image/jpeg')
      expect(out.base64).toBe(big.buffer.toString('base64'))
    }
  })

  it('2d: 外部 URL（非 uploads 引用）→ 拒绝且绝不 fetch', async () => {
    let called = 0
    const out = await loadReadMediaImage(
      { url: 'https://cdn.example.com/img/a.png' },
      deps({
        readBuffer: async () => {
          called += 1
          return Buffer.alloc(0)
        },
      }),
    )
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('uploads')
    expect(called).toBe(0)
  })

  it('2e: 文件不存在 / 扩展名不支持 → 明确错误', async () => {
    expect((await loadReadMediaImage({ url: '/api/uploads/u1/missing.png' }, deps())).ok).toBe(false)
    await seed('u1/x.tiff', Buffer.alloc(4))
    const out = await loadReadMediaImage({ url: '/api/uploads/u1/x.tiff' }, deps())
    expect(out.ok).toBe(false)
  })
})

describe('loadReadMediaImage（评审修复：#1 URIError / #2 路径穿越 / #3 changed:false）', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'read-media-fix-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const deps = (overrides: Partial<Parameters<typeof loadReadMediaImage>[1]> = {}) => ({
    uploadsRoot: dir,
    ...overrides,
  })

  it('2f: 文件名含裸 %（合法本地文件名）→ ok:false 明确错误，不抛 URIError', async () => {
    const out = await loadReadMediaImage({ url: '/api/uploads/u1/100%.png' }, deps())
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('编码')
  })

  it('2g: userId=..（路径穿越）→ ok:false 且绝不读盘', async () => {
    let called = 0
    const out = await loadReadMediaImage(
      { url: '/api/uploads/../secret.png' },
      deps({
        readBuffer: async () => {
          called += 1
          return PNG_1PX
        },
      }),
    )
    expect(out.ok).toBe(false)
    expect(called).toBe(0)
  })

  it('2c2: >2MB 但尺寸 ≤2048（downscale changed:false）→ 原字节原 mime 返回，不谎报', async () => {
    const p = join(dir, 'u1', 'dense.png')
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, Buffer.concat(Array.from({ length: 40000 }, () => PNG_1PX)))
    const out = await loadReadMediaImage(
      { url: '/api/uploads/u1/dense.png' },
      deps({ downscale: async (buf) => ({ buffer: buf, changed: false }) }),
    )
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.downscaled).toBe(false)
      expect(out.mimeType).toBe('image/png')
    }
  })
})
