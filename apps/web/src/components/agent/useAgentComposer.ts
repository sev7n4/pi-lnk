import { computed, nextTick } from 'vue'
import type { Ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { SidebarAttachment } from '@lnkpi/shared'
import { randomId } from '@/utils/randomId'
import type MentionInput from '@/components/canvas/MentionInput.vue'
import type { MentionOption } from '@/components/canvas/MentionInput.vue'

/** 组件注入的 sidebar 最小契约（useSidebarAttachments 返回集的子集，composable 仅消费这四项）。 */
export interface ComposerSidebarApi {
  pendingAttachments: Ref<SidebarAttachment[]>
  addFromPayload: (item: SidebarAttachment) => void
  addFromFile: (file: File) => Promise<void>
  assignRefKeys: () => string[]
}

export interface AgentComposerDeps {
  /** 输入框 v-model 文本（组件持有所有权）。 */
  input: Ref<string>
  /** 待发送引用素材 API（组件持有单例，composable 仅消费）。 */
  sidebar: ComposerSidebarApi
  /** MentionInput 实例 ref：用于插入 @引用 文本与聚焦。 */
  composerRef: Ref<InstanceType<typeof MentionInput> | null>
  /** 图片/文件选择 input ref。 */
  fileInputRef: Ref<HTMLInputElement | null>
  /** 拍照 input ref（capture 直调相机）。 */
  cameraInputRef: Ref<HTMLInputElement | null>
  /** 上传中状态（与其他处理函数共享，组件持有所有权）。 */
  isUploading: Ref<boolean>
  /** 拖拽悬停态（组件持有所有权，模板驱动样式）。 */
  isDragOver: Ref<boolean>
  /** 资产库选择器开关（组件持有所有权）。 */
  assetPickerOpen: Ref<boolean>
  /** 附件菜单开关（组件持有所有权，useClickOutside 也消费）。 */
  attachMenuOpen: Ref<boolean>
  /** props.readOnly 的 getter（避免在 setup 顶层闭包里捕获 props 导致响应性陷阱）。 */
  readOnly: () => boolean
  /** 组件本地纯函数：把 attachments + refKeys 拼成渲染项。 */
  makeAttachmentItems: (
    attachments: SidebarAttachment[] | undefined,
    refKeys: string[] | undefined,
  ) => { attachment: SidebarAttachment; refKey: string }[]
}

/**
 * Phase 3 strangler-fig 第七刀：把 AgentSideRail 中「Composer & Attachments」簇
 * （@引用插入 / 资产选择 / 文件上传 / 草稿态判定 / 拖拽落料）收敛到独立 composable。
 *
 * 不变量（与抽取前逐字等价）：
 * - 真实状态所有权仍在组件：input / sidebar / composerRef / fileInputRef / cameraInputRef /
 *   isUploading / isDragOver / assetPickerOpen / attachMenuOpen 全部由组件声明并注入，
 *   composable 只做消费壳 + 显式依赖注入。isUploading 同时被 send/stop 等外部处理函数读写，
 *   attachMenuOpen 同时被组件内 useClickOutside 收口，故二者留在组件而非迁入。
 * - 派生 computed（pendingAttachmentItems / mentionOptions / canSubmitComposer /
 *   composerDraftText）迁到 composable，但 barShape / hasAttachments / send 等外部消费者
 *   仍通过 `composer.*` 读取，语义不变。
 * - 全部函数无 emit、无副作用外溢：addAssetReference / addAttachment 走 sidebar，
 *   addFiles 走 sidebar.addFromFile，失败仅 ElMessage 提示。
 */
export function useAgentComposer(deps: AgentComposerDeps) {
  const {
    input,
    sidebar,
    composerRef,
    fileInputRef,
    cameraInputRef,
    isUploading,
    isDragOver,
    assetPickerOpen,
    attachMenuOpen,
    readOnly,
    makeAttachmentItems,
  } = deps

  const pendingAttachmentItems = computed(() =>
    makeAttachmentItems(sidebar.pendingAttachments.value, sidebar.assignRefKeys()),
  )

  const mentionOptions = computed((): MentionOption[] =>
    pendingAttachmentItems.value.map(({ refKey, attachment }) => ({
      id: attachment.id,
      label: refKey,
      type: attachment.mediaType,
    })),
  )

  function insertRefMention(refKey: string) {
    const token = `@${refKey} `
    composerRef.value?.insertText(input.value ? ` ${token}` : token)
    nextTick(() => composerRef.value?.focus())
  }

  const canSubmitComposer = computed(() =>
    Boolean(input.value.trim() || sidebar.pendingAttachments.value.length),
  )

  // 流式中是否存在可插话的草稿文本：决定底部按钮临时切回发送态（而非停止态）。
  const composerDraftText = computed(() => Boolean(input.value.trim()))

  function addAssetReference(attachment: SidebarAttachment) {
    if (readOnly()) return
    sidebar.addFromPayload(attachment)
  }

  function addAttachment(attachment: SidebarAttachment) {
    if (readOnly()) return
    sidebar.addFromPayload({ ...attachment, id: randomId() })
  }

  function setComposerInput(text: string) {
    input.value = text
    nextTick(() => composerRef.value?.focus())
  }

  function toggleAttachMenu() {
    if (readOnly() || isUploading.value) return
    attachMenuOpen.value = !attachMenuOpen.value
  }

  /** 「＋」附件卡（2026-10-18 照竞品重构：三瓦片 拍照/图片/添加文件 + 行 专家/技能/连接器）。
   *  单一 file input 复用：图片走 accept=image/*，文件走不限类型；拍照走带 capture 的独立 input。 */
  function pickImage() {
    attachMenuOpen.value = false
    if (readOnly() || isUploading.value || !fileInputRef.value) return
    fileInputRef.value.accept = 'image/*'
    fileInputRef.value.click()
  }

  function pickFile() {
    attachMenuOpen.value = false
    if (readOnly() || isUploading.value || !fileInputRef.value) return
    fileInputRef.value.accept = ''
    fileInputRef.value.click()
  }

  function pickCamera() {
    attachMenuOpen.value = false
    if (readOnly() || isUploading.value) return
    cameraInputRef.value?.click()
  }

  function pickAssetLibrary() {
    attachMenuOpen.value = false
    assetPickerOpen.value = true
  }

  async function addFiles(files: FileList | File[]) {
    if (readOnly() || !files.length) return

    isUploading.value = true
    try {
      for (const file of Array.from(files)) {
        await sidebar.addFromFile(file)
      }
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '上传参考素材失败')
    } finally {
      isUploading.value = false
    }
  }

  function onFileChange(event: Event) {
    const target = event.target as HTMLInputElement
    void addFiles(target.files ?? []).finally(() => {
      target.value = ''
    })
  }

  function onDragOver() {
    if (!readOnly()) isDragOver.value = true
  }

  function onDragLeave() {
    isDragOver.value = false
  }

  function onDrop(event: DragEvent) {
    isDragOver.value = false
    void addFiles(event.dataTransfer?.files ?? [])
  }

  return {
    pendingAttachmentItems,
    mentionOptions,
    canSubmitComposer,
    composerDraftText,
    insertRefMention,
    addAssetReference,
    addAttachment,
    setComposerInput,
    toggleAttachMenu,
    pickImage,
    pickFile,
    pickCamera,
    pickAssetLibrary,
    addFiles,
    onFileChange,
    onDragOver,
    onDragLeave,
    onDrop,
  }
}
