export const PASTE_TEXT_CHIP_MIN_CHARS = 1000

export type PasteSkipReason =
  | 'ok' | 'empty' | 'has-files' | 'has-selection'
  | 'composing' | 'too-short' | 'capacity-full'

/** 剪贴板与选区探测结果；pendingCount / maxCount 由持有 sidebar 的宿主补齐。 */
export interface PasteTextProbe {
  text: string
  itemTypes: readonly string[]
  hasFiles: boolean
  selectionStart: number
  selectionEnd: number
  isComposing: boolean
}

export interface PasteTextContext extends PasteTextProbe {
  pendingCount: number
  maxCount: number
}

export interface PasteDecision {
  promote: boolean
  reason: PasteSkipReason
}

/**
 * 长文本粘贴是否提升为 T* 文本素材芯片。
 * 长度按 Unicode 码点计（中文/emoji 不按字节膨胀），阈值只是必要非充分条件。
 */
export function shouldPromotePasteToTextChip(
  ctx: PasteTextContext,
  minChars = PASTE_TEXT_CHIP_MIN_CHARS,
): PasteDecision {
  if (!ctx.text.trim()) return { promote: false, reason: 'empty' }
  if (ctx.hasFiles || ctx.itemTypes.some((t) => /^(image|video|audio)\//.test(t))) {
    return { promote: false, reason: 'has-files' }
  }
  if (ctx.selectionStart !== ctx.selectionEnd) return { promote: false, reason: 'has-selection' }
  if (ctx.isComposing) return { promote: false, reason: 'composing' }
  if ([...ctx.text].length < minChars) return { promote: false, reason: 'too-short' }
  if (ctx.pendingCount >= ctx.maxCount) return { promote: false, reason: 'capacity-full' }
  return { promote: true, reason: 'ok' }
}

/** 只读取剪贴板与选区，不接触任何业务状态。 */
export function readPasteTextProbe(event: ClipboardEvent, el: HTMLTextAreaElement): PasteTextProbe {
  const data = event.clipboardData
  const items = data ? Array.from(data.items) : []
  return {
    text: data?.getData('text/plain') ?? '',
    itemTypes: items.map((i) => i.type),
    hasFiles: (data?.files.length ?? 0) > 0 || items.some((i) => i.kind === 'file'),
    selectionStart: el.selectionStart ?? 0,
    selectionEnd: el.selectionEnd ?? 0,
    isComposing: (event as Event & { isComposing?: boolean }).isComposing ?? false,
  }
}
