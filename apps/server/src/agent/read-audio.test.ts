import { mkdir, mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadReadAudio, READ_AUDIO_MAX_BYTES } from './read-audio'

// 一段合法 MP3 头帧（内容不重要，只验证字节透传）
const MP3_BYTES = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x1f, 0x7b])

describe('loadReadAudio（VoiceStudio P2 Nest 取音频）', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'read-audio-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const seed = async (rel: string, buf: Buffer) => {
    const p = join(dir, rel)
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, buf)
  }
  const deps = () => ({ uploadsRoot: dir })

  it('a1: 相对 /api/uploads/ 引用 → 读盘成功返回 base64+mime', async () => {
    await seed('u1/ref.mp3', MP3_BYTES)
    const out = await loadReadAudio({ url: '/api/uploads/u1/ref.mp3' }, deps())
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.mimeType).toBe('audio/mpeg')
      expect(out.fileName).toBe('ref.mp3')
      expect(Buffer.from(out.base64, 'base64')).toEqual(MP3_BYTES)
    }
  })

  it('a2: 绝对形态 /uploads/（兜旧）同样受理', async () => {
    await seed('u1/v.wav', MP3_BYTES)
    const out = await loadReadAudio({ url: `/uploads/u1/v.wav` }, deps())
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.mimeType).toBe('audio/wav')
  })

  it('a3: 外部公网 URL 一律拒绝（合规 #1 限自有参考音频）', async () => {
    const out = await loadReadAudio({ url: 'https://evil.example.com/voice.mp3' }, deps())
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('仅支持 uploads 引用')
  })

  it('a4: 白名单外扩展名拒绝', async () => {
    await seed('u1/x.tiff', MP3_BYTES)
    const out = await loadReadAudio({ url: '/api/uploads/u1/x.tiff' }, deps())
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('不支持的音频格式')
  })

  it('a5: 无扩展名拒绝', async () => {
    await seed('u1/rawbin', MP3_BYTES)
    const out = await loadReadAudio({ url: '/api/uploads/u1/rawbin' }, deps())
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('无扩展名')
  })

  it('a6: 超上限拒绝并带指引', async () => {
    await seed('u1/big.mp3', Buffer.alloc(READ_AUDIO_MAX_BYTES + 1, 7))
    const out = await loadReadAudio({ url: '/api/uploads/u1/big.mp3' }, deps())
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('超过 20MB')
  })

  it('a7: userId=..（路径穿越）→ ok:false 且绝不读盘', async () => {
    let called = 0
    const out = await loadReadAudio(
      { url: '/api/uploads/../secret.mp3' },
      { uploadsRoot: dir, readBuffer: async () => (called += 1, Buffer.alloc(1)) },
    )
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('路径穿越')
    expect(called).toBe(0)
  })

  it('a8: 畸形 % 编码拒绝（不抛 URIError）', async () => {
    const out = await loadReadAudio({ url: '/api/uploads/u1/bad%zz.mp3' }, deps())
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('编码非法')
  })

  it('a9: 文件不存在 → 读取失败显式报错', async () => {
    const out = await loadReadAudio({ url: '/api/uploads/u1/missing.mp3' }, deps())
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('读取失败')
  })
})
