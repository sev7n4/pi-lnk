/**
 * VoiceStudio P3 合规 #1 上传入口权利声明（spec §6）。
 * ElMessageBox mock：确认 resolve / 取消 reject 两路 + isAudioFile 判定。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('element-plus', () => ({
  ElMessageBox: {
    confirm: vi.fn(),
  },
}))

const { ElMessageBox } = await import('element-plus')
const { isAudioFile, confirmVoiceRightsIfNeeded } = await import('./voiceRightsConsent')

function audioFile(name = 'ref.mp3'): File {
  return new File(['x'], name, { type: 'audio/mpeg' })
}
function imageFile(): File {
  return new File(['x'], 'a.png', { type: 'image/png' })
}

describe('isAudioFile', () => {
  it('audio/* → true；image/* → false', () => {
    expect(isAudioFile(audioFile())).toBe(true)
    expect(isAudioFile(imageFile())).toBe(false)
  })
})

describe('confirmVoiceRightsIfNeeded（每次弹，不记忆跳过——合规最强形态）', () => {
  beforeEach(() => {
    vi.mocked(ElMessageBox.confirm).mockReset()
  })

  it('非音频文件直接放行（不弹窗）', async () => {
    await expect(confirmVoiceRightsIfNeeded(imageFile())).resolves.toBe(true)
    expect(ElMessageBox.confirm).not.toHaveBeenCalled()
  })

  it('音频 + 用户确认（resolve）→ true，弹窗带 AI 标识声明文案', async () => {
    vi.mocked(ElMessageBox.confirm).mockResolvedValue({ value: 'confirm' } as never)
    await expect(confirmVoiceRightsIfNeeded(audioFile())).resolves.toBe(true)
    expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1)
    const [message, title] = vi.mocked(ElMessageBox.confirm).mock.calls[0]
    expect(title).toContain('声音素材权利确认')
    expect(String(message)).toContain('授权')
    expect(String(message)).toContain('AI 合成标识')
  })

  it('音频 + 用户取消（reject）→ false（调用方须中止上传）', async () => {
    vi.mocked(ElMessageBox.confirm).mockRejectedValue('cancel')
    await expect(confirmVoiceRightsIfNeeded(audioFile())).resolves.toBe(false)
  })
})
