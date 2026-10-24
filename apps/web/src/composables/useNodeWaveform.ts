import { computed, ref, watch, type Ref } from 'vue'
import {
  WAVEFORM_PEAK_COUNT,
  buildPlaceholderPeaks,
  peaksFromChannelData,
} from './waveformPeaks'

/**
 * 节点波形的来源。UI 用它决定「是否显示正在 loading」以及 aria 文案——
 * 用户有权知道自己看到的是装饰占位还是真实音量。
 */
export type NodeWaveformSource = 'placeholder' | 'real'

/** 解码器：url → PCM 声道数据；拿不到就返回 null（保持占位，不假造）。 */
export type WaveformDecoder = (url: string) => Promise<Float32Array | null>

/** 超过该体积就不再拉全文件解码（移动端流量/内存保护） */
const MAX_DECODE_BYTES = 20 * 1024 * 1024

/** 同一 url 只解一次（画布里同一素材可能被多个节点引用） */
const realPeaksCache = new Map<string, number[]>()

/**
 * 浏览器内取真实峰值：Web Audio 的 `decodeAudioData` 走原生解码器，
 * mp3/wav 都能解，零额外依赖。
 *
 * 失败（跨域没有 CORS 头 / 408 / 无 AudioContext / 文件过大）一律返回 null——
 * 由调用方保持占位波形，绝不编造峰值。
 */
export const decodeChannelWithWebAudio: WaveformDecoder = async (url) => {
  if (typeof window === 'undefined' || typeof fetch === 'undefined') return null
  const Ctor =
    (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null

  const res = await fetch(url, { mode: 'cors', credentials: 'omit' })
  if (!res.ok) return null
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_DECODE_BYTES) return null

  const buf = await res.arrayBuffer()
  if (buf.byteLength > MAX_DECODE_BYTES) return null

  const ctx = new Ctor()
  try {
    const decoded = await ctx.decodeAudioData(buf)
    return decoded.getChannelData(0)
  } finally {
    void ctx.close?.()
  }
}

export interface UseNodeWaveformOptions {
  /** 节点 id —— 占位波形的确定性种子 */
  nodeId: () => string | undefined
  /** 音频地址 —— 有值才尝试取真实峰值 */
  url: () => string | undefined
  count?: number
  /** 测试可注入的解码真源（默认走 Web Audio） */
  decoder?: WaveformDecoder
}

export interface NodeWaveform {
  peaks: Ref<number[]>
  source: Ref<NodeWaveformSource>
  loading: Ref<boolean>
}

export function useNodeWaveform(opts: UseNodeWaveformOptions): NodeWaveform {
  const count = opts.count ?? WAVEFORM_PEAK_COUNT
  const decoder = opts.decoder ?? decodeChannelWithWebAudio

  const realPeaks = ref<number[] | null>(null)
  const loading = ref(false)

  const placeholder = computed(() => buildPlaceholderPeaks(opts.nodeId() ?? 'anonymous-node', count))
  const peaks = computed(() => realPeaks.value ?? placeholder.value)
  const source = computed<NodeWaveformSource>(() => (realPeaks.value ? 'real' : 'placeholder'))

  async function attempt(url: string) {
    const cached = realPeaksCache.get(url)
    if (cached) {
      realPeaks.value = cached
      return
    }
    loading.value = true
    try {
      const channel = await decoder(url)
      // url 可能已在 await 期间变化（切换素材）⇒ 只认最后一次请求的结果
      if (opts.url() !== url) return
      if (channel && channel.length) {
        const computedPeaks = peaksFromChannelData(channel, count)
        realPeaksCache.set(url, computedPeaks)
        realPeaks.value = computedPeaks
      }
    } catch {
      /* 解码失败保持占位波形：宁可显示占位，也不假造音量 */
    } finally {
      if (opts.url() === url) loading.value = false
    }
  }

  watch(
    () => opts.url(),
    (url) => {
      realPeaks.value = null
      if (!url) {
        loading.value = false
        return
      }
      void attempt(url)
    },
    { immediate: true },
  )

  return { peaks, source, loading }
}
