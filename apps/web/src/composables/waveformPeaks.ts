/**
 * 波形峰值（D-D：移动端音频瓦片）。
 *
 * 两条数据来源，最终都归一成同一形状——`number[]`，长度固定、取值 0~1：
 *
 * 1. **确定性占位波形**：nodeId 哈希驱动，同一个节点每次渲染出同一条波形。
 *    用途是「后端/浏览器还没解出真数据时也不丑」——它**不是数据**，只是装饰，
 *    所以 UI 上必须伴随「波形加载中」微标（见 `MobileNodeWaveform`），
 *    不允许被当成真实音量。
 * 2. **真实峰值**：对解码后的 PCM 样本按桶取绝对值最大值（经典 waveform peaks 算法）。
 *
 * ⭐ 纪律：全仓没有任何「音频峰值」字段（2026-10-24 取证 `waveform|peaks` 前后端均 0 命中）。
 *    ⇒ 这里只提供**算法**，不假造「这是这段音频的实际音量」。
 */

/** 波形点数。规格 §10.2 D-D 约定 64~256，移动端瓦片窄 ⇒ 取下限 64。 */
export const WAVEFORM_PEAK_COUNT = 64

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

/** xmur3：字符串 → 32 位种子（同一 nodeId 恒同一结果，与运行环境无关）。 */
function xmur3(str: string): number {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^= h >>> 16) >>> 0
}

/** mulberry32：同一种子恒同一序列（比 Math.random 多的正是「确定性」）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 确定性占位波形。
 *
 * ⭐ 「确定性」是需求本身：真数据到达前，波形必须在每次滚动重绘时**不跳变**
 *   （同一 nodeId ⇒ 同一条），否则瓦片会像坏了一样闪烁。
 * 包络取「中间高、两头低」，视觉上像一段真实音频而不是一面噪声墙。
 */
export function buildPlaceholderPeaks(
  nodeId: string,
  count: number = WAVEFORM_PEAK_COUNT,
): number[] {
  const rnd = mulberry32(xmur3(nodeId))
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0
    const envelope = 0.35 + 0.65 * Math.pow(Math.sin(Math.PI * t), 0.6)
    out.push(round3(clamp01((0.2 + 0.8 * rnd()) * envelope)))
  }
  return out
}

/**
 * PCM 声道 → 定长峰值数组（每桶取绝对值最大值）。
 *
 * @returns 长度恒为 `count` 的数组；空声道返回 count 个 0（静音段也保持定长，
 *          下游渲染才能每条都画出来）。
 */
export function peaksFromChannelData(
  channel: Float32Array | ArrayLike<number>,
  count: number = WAVEFORM_PEAK_COUNT,
): number[] {
  const n = channel.length
  const out: number[] = []
  const step = n / count
  for (let i = 0; i < count; i++) {
    if (!n || !Number.isFinite(step)) {
      out.push(0)
      continue
    }
    const start = Math.floor(i * step)
    const end = Math.min(n, Math.max(start + 1, Math.floor((i + 1) * step)))
    let peak = 0
    for (let j = start; j < end; j++) {
      const abs = Math.abs(channel[j] ?? 0)
      if (abs > peak) peak = abs
    }
    out.push(round3(clamp01(peak)))
  }
  return out
}
