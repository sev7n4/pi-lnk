import { estimateImageCredits } from '@/constants/credits'

export interface ProposalNodeData {
  nodeId: string
  title: string
  prompt: string
  modelId: string
  aspectRatio: string
  imageResolution: string
  imageCount: number
  style: string
  creditCost: number
  creditFromServer: boolean
  thumbnail?: string
  nodeType: string
  /** 视频只读参数（videoSettings 内面，2026-11-02 模态感知分派：Sheet 只读展示真值，不提供编辑） */
  videoDuration?: number
  videoAspectRatio?: string
  videoResolution?: string
  /** 音频分类（tts/singing/…，只读展示；voice/kind 编辑强耦合画布 dock，C-later） */
  audioKind?: string
}

/** 画布节点（结构化形状，与 `CanvasNodeLike` 兼容；节点数据经 props 传入，不读 store）。 */
export interface ProposalCanvasNode {
  id: string
  type?: string
  data?: Record<string, unknown> | null
}

/**
 * 从画布节点数组解析「提议生成卡片」所需数据。
 *
 * 纯函数、零 store 依赖：节点数据由 `AgentSideRail` 的 `canvasNodes` prop
 * （vue-flow 节点）经组件 props 传入，不读 `canvasEditor` store（那是精修编辑器
 * store，不含画布节点）。
 *
 * 字段映射（实证自 `useNodeGeneration.ts` / `MobileNodeEditorSheet.vue`）：
 * `label→title`、`prompt`、`imageModel→modelId`、`imageAspect→aspectRatio`、
 * `imageResolution`、`imageCount`、`style`、`url→thumbnail`。
 *
 * 积分 A-now：本地 `estimateImageCredits(count, resolution)` 估算（忽略 model）；
 * C-later：服务端权威 `creditCost` 优先（`creditFromServer=true`）。
 */
export function resolveProposalNodeData(
  nodeId: string,
  nodes: ProposalCanvasNode[] | null | undefined,
): ProposalNodeData | null {
  const node = nodes?.find((n) => n.id === nodeId)
  if (!node) return null
  const d = (node.data ?? {}) as Record<string, unknown>
  const type = node.type ?? 'image'

  const imageCount = Number(d.imageCount ?? 1)
  const imageResolution = String(d.imageResolution ?? '')
  const modelId = String(
    d.imageModel ?? d.videoModel ?? d.audioModel ?? d.model ?? '',
  )
  const aspectRatio = String(d.imageAspect ?? d.aspectRatio ?? '')
  const style = String(d.style ?? '')

  const serverCredit = typeof d.creditCost === 'number' ? d.creditCost : undefined
  const creditCost =
    serverCredit ?? estimateImageCredits(imageCount, imageResolution || undefined)

  // 视频/音频只读参数（实证 VideoDockPanel：videoSettings 对象内面；AudioDockPanel：audioKind）
  const vs =
    d.videoSettings && typeof d.videoSettings === 'object'
      ? (d.videoSettings as Record<string, unknown>)
      : null
  const videoDuration = vs && Number(vs.duration) > 0 ? Number(vs.duration) : undefined
  const videoAspectRatio = vs && typeof vs.aspectRatio === 'string' ? vs.aspectRatio : undefined
  const videoResolution = vs && typeof vs.resolution === 'string' ? vs.resolution : undefined
  const audioKind = typeof d.audioKind === 'string' ? d.audioKind : undefined

  return {
    nodeId,
    title: String(d.label ?? d.title ?? '提议生成'),
    prompt: String(d.prompt ?? ''),
    modelId,
    aspectRatio,
    imageResolution,
    imageCount,
    style,
    creditCost,
    creditFromServer: serverCredit !== undefined,
    thumbnail: typeof d.url === 'string' ? d.url : undefined,
    nodeType: type,
    videoDuration,
    videoAspectRatio,
    videoResolution,
    audioKind,
  }
}
