/**
 * useNodeMediaUpload 的音频权利确认拦截（P3 合规 #1）：
 * kind='audio' 时上传前必须过 confirmVoiceRightsIfNeeded；取消 ⇒ 零 patch。
 * image kind 不弹窗（含拖拽 onDrop 同路径）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('element-plus', () => ({
  ElMessageBox: { confirm: vi.fn() },
}))

const patchNode = vi.fn()
vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue')>()
  return { ...actual, inject: vi.fn(() => patchNode) }
})

const confirmVoiceRights = vi.fn()
vi.mock('./voiceRightsConsent', () => ({
  confirmVoiceRightsIfNeeded: (...args: unknown[]) => confirmVoiceRights(...args),
  isAudioFile: (f: File) => f.type.startsWith('audio/'),
}))

const fileToPersistedPayload = vi.fn()
vi.mock('./useMediaUpload', () => ({
  fileToPersistedPayload: (...args: unknown[]) => fileToPersistedPayload(...args),
}))

const { useNodeMediaUpload } = await import('./useNodeMediaUpload')

function audioFile(): File {
  return new File(['x'], 'ref.mp3', { type: 'audio/mpeg' })
}
function imageFile(): File {
  return new File(['x'], 'a.png', { type: 'image/png' })
}

function mount(kind: 'audio' | 'image') {
  const composable = useNodeMediaUpload('n1', kind)
  return { composable }
}

describe('useNodeMediaUpload × 权利确认（audio）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('确认后走上传流（status: uploading → idle patch）', async () => {
    confirmVoiceRights.mockResolvedValue(true)
    fileToPersistedPayload.mockResolvedValue({ url: '/api/uploads/u1/ref.mp3', fileName: 'ref.mp3', mimeType: 'audio/mpeg' })
    const { composable } = mount('audio')
    await composable.onDrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [audioFile()] } } as unknown as DragEvent)
    expect(confirmVoiceRights).toHaveBeenCalledWith(expect.anything())
    // onDrop 内部 void applyFile（fire-and-forget）⇒ 轮询等上传流跑完
    await vi.waitFor(() =>
      expect(patchNode).toHaveBeenLastCalledWith('n1', expect.objectContaining({ status: 'idle', url: '/api/uploads/u1/ref.mp3' })),
    )
  })

  it('取消 ⇒ 零 patch（上传完全中止，连 uploading 态都不进）', async () => {
    confirmVoiceRights.mockResolvedValue(false)
    const { composable } = mount('audio')
    await composable.onDrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [audioFile()] } } as unknown as DragEvent)
    expect(confirmVoiceRights).toHaveBeenCalled()
    expect(fileToPersistedPayload).not.toHaveBeenCalled()
    expect(patchNode).not.toHaveBeenCalled()
  })

  it('image kind 不弹确认（不含音频面）', async () => {
    confirmVoiceRights.mockResolvedValue(true)
    fileToPersistedPayload.mockResolvedValue({ url: '/u/a.png', fileName: 'a.png', mimeType: 'image/png' })
    const { composable } = mount('image')
    await composable.onDrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [imageFile()] } } as unknown as DragEvent)
    expect(confirmVoiceRights).not.toHaveBeenCalled()
  })

  it('onFileChange 同路径生效（input 上传入口）', async () => {
    confirmVoiceRights.mockResolvedValue(false)
    const { composable } = mount('audio')
    const input = { files: [audioFile()], value: '' } as unknown as HTMLInputElement
    await composable.onFileChange({ target: input } as unknown as Event)
    expect(fileToPersistedPayload).not.toHaveBeenCalled()
    expect(patchNode).not.toHaveBeenCalled()
    expect(input.value).toBe('')
  })
})
