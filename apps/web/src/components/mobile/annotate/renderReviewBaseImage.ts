/**
 * 审阅层整屏底图渲染器（规格 §17-⑤ / §9 #49，2026-10-27）。
 *
 * 批注态的底图 =「屏幕」而非媒体帧（§17.3：不依赖产物 CORS / 视频取帧，
 * 视频/音频提议同样成立）。本函数把**提示词全文 + 参数摘要**分层重绘为
 * 一张白底黑字图 —— 即 §4.7.1 预见的「文本 → canvas 渲染器」。
 *
 * ⭐ **纯函数边界**：canvas 工厂可注入（同 `composeAnnotatedImage` 模式）⇒
 *   node 环境可单测（stub ctx 记录调用，不碰真 canvas）。
 *
 * R-17（整屏语义）：只渲染**当前可视区**所需内容——长 prompt 超出画布高度时
 * 截断（所见即所得），不做全文长图拼接；胶囊 note 会标注「当前屏」语义。
 */
import type { CanvasFactory } from './composeAnnotatedImage'

const defaultCanvasFactory: CanvasFactory = (width, height) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

export interface ReviewBaseInput {
  prompt: string
  /** 参数只读摘要一行（如「参数：尺寸 1:1 · 数量 1」），空串则不画 */
  paramsLine: string
  width: number
  height: number
  /**
   * 跳过的行数（R-17 当前视口语义，2026-10-27 S1）：全文层长文滚动到中部时，
   * 底图应反映**当前视口**内容——调用方按 scrollTop / LINE_HEIGHT 折算传入。
   * 缺省 0 = 从头渲染（M5 pending 审核层短文场景不受影响）。
   */
  skipLines?: number
}

const FONT_PROMPT = '14px -apple-system, "PingFang SC", sans-serif'
const FONT_LABEL = '12px -apple-system, "PingFang SC", sans-serif'
const FONT_PARAMS = '11px -apple-system, "PingFang SC", sans-serif'
const LINE_HEIGHT = 24
const PADDING = 16

/** 与令牌对应的实色常量（截图为独立位图，不消费 CSS 变量；色值映射自 --lnk-ink-* 家族） */
const COLOR_BG = '#ffffff' // ≈ --lnk-surface
const COLOR_TEXT = '#1c1c1e' // ≈ --lnk-ink
const COLOR_SUB = '#8a8a8e' // ≈ --lnk-ink-muted

export function renderReviewBaseImage(
  input: ReviewBaseInput,
  createCanvas: CanvasFactory = defaultCanvasFactory,
): HTMLCanvasElement {
  if (!(input.width > 0) || !(input.height > 0)) throw new Error('画布尺寸非法')
  const canvas = createCanvas(input.width, input.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d 不可用')

  // 底色
  ctx.fillStyle = COLOR_BG
  ctx.fillRect(0, 0, input.width, input.height)

  // 标题行
  ctx.fillStyle = COLOR_SUB
  ctx.font = FONT_LABEL
  ctx.fillText('提示词（agent 提议）', PADDING, 28)

  // 提示词逐行（CJK 贪心逐字折行；超出可视区截断——R-17 当前屏语义）
  ctx.fillStyle = COLOR_TEXT
  ctx.font = FONT_PROMPT
  const maxWidth = input.width - PADDING * 2
  const bottomLimit = input.height - 44
  const skip = Math.max(0, Math.floor(input.skipLines ?? 0))
  let y = 56
  let lineNo = 0
  for (const paragraph of input.prompt.split('\n')) {
    if (!paragraph) continue // 空行跳过
    for (const line of wrapCjk(paragraph, ctx, maxWidth)) {
      lineNo += 1
      if (lineNo <= skip) continue // R-17：滚动位之前的行不入底图（所见即所得）
      if (y > bottomLimit) return canvas
      ctx.fillText(line, PADDING, y)
      y += LINE_HEIGHT
    }
  }

  // 参数摘要行（只读，置底）
  if (input.paramsLine) {
    ctx.fillStyle = COLOR_SUB
    ctx.font = FONT_PARAMS
    ctx.fillText(input.paramsLine, PADDING, input.height - 20)
  }
  return canvas
}

/** CJK 贪心折行：逐字累计，超宽即成行（无空格分词语义） */
function wrapCjk(text: string, ctx: CanvasRenderingContext2D, maxWidth: number): string[] {
  const lines: string[] = []
  let current = ''
  for (const ch of text) {
    if (ctx.measureText(current + ch).width > maxWidth && current) {
      lines.push(current)
      current = ch
    } else {
      current += ch
    }
  }
  if (current) lines.push(current)
  return lines
}
