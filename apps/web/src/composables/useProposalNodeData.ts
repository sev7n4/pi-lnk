import { reactive } from 'vue'
import { estimateImageCredits } from '@/constants/credits'
import { fetchPriceQuote, type PriceQuoteQuery } from '@/services/pricing-api'

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
  /** 生成记录 id（节点 data.generationRecordId）——credit_tx 实耗对账的匹配键（§14.4 卡片翻转）。 */
  generationRecordId: string
  thumbnail?: string
  nodeType: string
  /** 视频只读参数（videoSettings 内面，2026-11-02 模态感知分派：Sheet 只读展示真值，不提供编辑） */
  videoDuration?: number
  videoAspectRatio?: string
  videoResolution?: string
  /** 音频分类（tts/singing/…，只读展示；voice/kind 编辑强耦合画布 dock，C-later） */
  audioKind?: string
  /** 音频内联参数回执（2026-11-03 propose_inline_params：propose 落节点 data，确认卡只读展示） */
  audioScriptsSegments?: number
  audioLyricsChars?: number
  audioCaption?: string
  audioInstrumental?: boolean
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
  // 音频内联参数回执（2026-11-03）：propose_generation 落到节点 data 的
  // audioScripts/audioLyrics/...，与 web 音频 dock 同名字段——确认卡据此展示
  // 「台词 N 段 / 歌词 N 字」chip，用户确认前可见将生成的内容载体。
  const audioScriptsSegments = Array.isArray(d.audioScripts) ? d.audioScripts.length : undefined
  const audioLyricsChars = typeof d.audioLyrics === 'string' && d.audioLyrics ? d.audioLyrics.length : undefined
  const audioCaption = typeof d.audioCaption === 'string' && d.audioCaption ? d.audioCaption : undefined
  const audioInstrumental =
    typeof d.audioInstrumental === 'boolean' ? d.audioInstrumental : undefined

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
    generationRecordId: typeof d.generationRecordId === 'string' ? d.generationRecordId : '',
    thumbnail: typeof d.url === 'string' ? d.url : undefined,
    nodeType: type,
    videoDuration,
    videoAspectRatio,
    videoResolution,
    audioKind,
    audioScriptsSegments,
    audioLyricsChars,
    audioCaption,
    audioInstrumental,
  }
}

/* ---------------------------------------------------------------------------
 * 积分展示权威取数（续 2026-11-02-points-display-single-source，v2）。
 *
 * 事故：#674 提议生成卡 / artifact 卡的积分 pill 兜底走 `estimateImageCredits`
 * （launch-reprice 前的旧常量 10），而计费读价目表（image:1K:1=33）⇒ 展示 10 / 实扣 33。
 *
 * 单一真相源不变式：`node.data.creditCost`（服务端权威，#674 C-later 接管位）>
 * `GET /api/pricing/quote`（与计费同源同表，改价只改管理后台价目表）> 本地常量估算
 * （仅 quote 端点不可达时的瞬时兜底，与 dock 面板同策略）。
 *
 * 实现约束：`resolveProposalNodeData` 是渲染期纯函数（模板每帧调用），不能起 composable；
 * 故用模块级响应式 quoteMap + 去重拉取：同步返回已缓存值或本地兜底，端点返回后经
 * reactive Map 写回触发重渲。fetchPriceQuote 失败静默保留兜底（展示层永不抛错）。
 * ------------------------------------------------------------------------ */

const quoteMap = reactive(new Map<string, number>())
const inflight = new Set<string>()

/** 由节点数据推导报价 query（image / video / audio 三类生成节点；未知类型不报价）。 */
function quoteQueryOf(d: ProposalNodeData): PriceQuoteQuery | null {
  if (d.nodeType === 'video') {
    return { capability: 'video', duration: d.videoDuration ?? 5 }
  }
  if (d.nodeType === 'audio') {
    return d.audioKind ? { capability: 'audio', audioKind: d.audioKind } : null
  }
  return {
    capability: 'image',
    count: Math.max(1, d.imageCount || 1),
    resolution: d.imageResolution || '1K',
  }
}

function requestQuote(q: PriceQuoteQuery): void {
  const key = JSON.stringify(q)
  if (quoteMap.has(key) || inflight.has(key)) return
  inflight.add(key)
  fetchPriceQuote(q)
    .then((r) => {
      quoteMap.set(key, r.credits)
    })
    .catch(() => {
      /* 展示层 fail-soft：保留本地兜底值，不抛错不打断渲染 */
    })
    .finally(() => {
      inflight.delete(key)
    })
}

/**
 * 提议生成卡 / artifact 卡积分 pill 的权威取值（渲染期可调用，响应式）。
 *
 * 优先级：服务端 `creditCost`（`creditFromServer`）> 价目表 quote > 本地估算。
 * image 本地兜底 = `estimateImageCredits`（与 dock 同策略）；video/audio 无本地估算，
 * quote 未返回前返回 undefined（pill 缺省不渲染，绝不显示假数字）。
 */
export function proposalCreditCost(d: ProposalNodeData | null | undefined): number | undefined {
  if (!d) return undefined
  if (d.creditFromServer) return d.creditCost
  const q = quoteQueryOf(d)
  if (!q) return undefined
  const key = JSON.stringify(q)
  const hit = quoteMap.get(key)
  if (hit !== undefined) return hit
  requestQuote(q)
  // 同步兜底：仅 image 有旧常量口径；video/audio 宁可不显示也不显示错的
  if (q.capability === 'image') {
    return estimateImageCredits(q.count, q.resolution)
  }
  return undefined
}

/* ---------------------------------------------------------------------------
 * quote→实耗 对账（规格 2026-11-03 §14.4 提议卡翻转）。
 *
 * 背景（生产实例）：提议卡 quote「消耗 33 积分」生成后不更新，而回合摘要只结算
 * 文本费（7 积分）⇒ 用户看到两个打架的数字。credit_tx（CREDIT_TX=on）的生成类
 * consume 携带 `generationId = record.id`，与节点 `generationRecordId` 同键 ⇒
 * 卡片可原位翻转为「已结算 · 实耗 N 积分」。
 *
 * 模式沿用上方 quoteMap 先例：模块级响应式 Map + 渲染期纯读——组件保持零 store
 * 依赖（ledger R1/R2），写入方是 `stores/agent.ts trackCreditTx`（SSE credit_tx 帧
 * 与历史回放同路径）。
 * ------------------------------------------------------------------------ */

const settledGenerationCredits = reactive(new Map<string, number>())

/** trackCreditTx 写入：generationId 有符号净额（consume 负 / refund 正，退款后净额归零不显示）。 */
export function recordGenerationSettledCredit(generationId: string | null | undefined, amount: number): void {
  if (!generationId) return
  const prev = settledGenerationCredits.get(generationId) ?? 0
  settledGenerationCredits.set(generationId, prev + amount)
}

/** 渲染期读：净额 < 0（已扣未退）→ 实耗绝对值；否则 undefined（quote pill 照常/不显示）。 */
export function generationSettledCredit(generationId: string | null | undefined): number | undefined {
  if (!generationId) return undefined
  const net = settledGenerationCredits.get(generationId)
  return typeof net === 'number' && net < 0 ? -net : undefined
}
