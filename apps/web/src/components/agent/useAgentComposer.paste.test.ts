import { describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useAgentComposer } from './useAgentComposer'
import { useSidebarAttachments } from '@/composables/useSidebarAttachments'
import type MentionInput from '@/components/canvas/MentionInput.vue'

vi.mock('element-plus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('element-plus')>()),
  ElMessage: { success: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

function makeComposer() {
  const sidebar = useSidebarAttachments()
  sidebar.clear()
  const input = ref('')
  const stub = { insertText: vi.fn(), focus: vi.fn(), showMenu: ref(false) }
  const composerRef = ref<InstanceType<typeof MentionInput> | null>(null)
  composerRef.value = stub as unknown as InstanceType<typeof MentionInput>
  const insertText = stub.insertText
  const c = useAgentComposer({
    input,
    sidebar,
    composerRef,
    fileInputRef: ref(null),
    cameraInputRef: ref(null),
    isUploading: ref(false),
    isDragOver: ref(false),
    assetPickerOpen: ref(false),
    attachMenuOpen: ref(false),
    readOnly: () => false,
    makeAttachmentItems: (a) => (a ?? []).map((attachment, i) => ({ attachment, refKey: `T${i + 1}` })),
  })
  return { c, sidebar, input, insertText }
}

const longText = '长'.repeat(1200)

describe('useAgentComposer paste promotion', () => {
  it('提升后芯片携带完整原文、text/upload、可撤销', () => {
    const { c, sidebar } = makeComposer()
    c.promotePasteToTextChip(longText)
    const item = sidebar.pendingAttachments.value[0]
    expect(item.mediaType).toBe('text')
    expect(item.sourceKind).toBe('upload')
    expect(item.text).toBe(longText)
    expect(item.text?.length).toBe(1200)
    expect(c.canUndoPaste.value).toBe(true)
    expect(ElMessage.success).toHaveBeenCalled()
  })

  it('容量满时 policy 拒绝，原文不进芯片（不静默丢）', () => {
    const { c, sidebar } = makeComposer()
    for (let i = 0; i < 5; i++) {
      sidebar.addFromPayload({
        id: `p${i}`, mediaType: 'image', sourceKind: 'upload',
        label: `a${i}`, url: `https://x/${i}.png`,
      })
    }
    const probe = {
      text: longText, itemTypes: ['text/plain'], hasFiles: false,
      selectionStart: 0, selectionEnd: 0, isComposing: false,
    }
    expect(c.pasteTextPolicy(probe)).toBe(false)
    expect(sidebar.pendingAttachments.value).toHaveLength(5)
  })

  it('短文本 policy 拒绝；带图片 item 也拒绝', () => {
    const { c } = makeComposer()
    const probe = {
      text: '短句', itemTypes: ['text/plain'], hasFiles: false,
      selectionStart: 0, selectionEnd: 0, isComposing: false,
    }
    expect(c.pasteTextPolicy(probe)).toBe(false)
    expect(c.pasteTextPolicy({ ...probe, text: longText, itemTypes: ['text/plain', 'image/png'] })).toBe(false)
  })

  it('⌘Z 还原：芯片移除 + 原文插回输入框', async () => {
    const { c, sidebar, insertText } = makeComposer()
    c.promotePasteToTextChip(longText)
    c.undoPromotedPaste()
    await nextTick()
    expect(sidebar.pendingAttachments.value).toHaveLength(0)
    expect(insertText).toHaveBeenCalledWith(longText)
    expect(c.canUndoPaste.value).toBe(false)
  })

  it('用户继续输入后撤销机会自动失效', () => {
    const { c, input } = makeComposer()
    c.promotePasteToTextChip(longText)
    input.value = '用户又输入了内容'
    expect(c.canUndoPaste.value).toBe(false)
  })
})
