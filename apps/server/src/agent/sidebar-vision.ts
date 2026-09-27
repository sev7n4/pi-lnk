/**
 * 侧栏识图（③）：把老 LangGraph `parse_sidebar_media` 的能力补到 pi 路径。
 *
 * 逐条平移自老 runtime（非重写）：
 *   `services/agent-runtime/app/graph/product_visual_v2/vision_qa_client.py: supports_vision_model`
 *   `services/agent-runtime/app/graph/sidebar_media_parse.py: image_urls_for_parse / format_parse_context_block`
 *
 * 为什么不是「把图片塞进多模态请求」：老链路的侧栏识图是**图 → Nest vision QA →
 * 结构化字段**（品类/外观/材质/图中文字 + 白底清晰度等 QA），再作为文本上下文给模型，
 * 不是让对话模型直接看图。pi 路径按同语义补齐，避免行为漂移。
 */

export interface SidebarAttachmentLike {
  url?: string
  text?: string
  mediaType?: string
}

/** 老 runtime `MAX_PARSE_IMAGE_URLS`：一次最多解析 4 张（侧栏上限 5，第 5 张不进识图）。 */
export const MAX_PARSE_IMAGE_URLS = 4

/** 侧栏里需要解析的图片 URL（去重，保序，上限 4）。 */
export function imageUrlsForParse(attachments: SidebarAttachmentLike[] | undefined): string[] {
  const urls: string[] = []
  for (const att of attachments ?? []) {
    if (!att || typeof att !== 'object') continue
    if ((att.mediaType ?? '').trim().toLowerCase() !== 'image') continue
    const url = (att.url ?? '').trim()
    if (url && !urls.includes(url)) urls.push(url)
    if (urls.length >= MAX_PARSE_IMAGE_URLS) break
  }
  return urls
}

/** 与老 runtime 同款白名单：命中 deepseek-flash 系 → true；命中非视觉系 → false；其余看视觉系。 */
const VISION_MODEL =
  /(?:^|[/:])(?:gemini|gpt-4o|gpt-4-turbo|gpt-4-vision|gpt-5|claude-(?:opus|sonnet|haiku|3)|agnes)(?:[-./]|$)/
const DEEPSEEK_FLASH = /(?:^|[/:])deepseek(?:-v4(?:\.1)?)?-flash(?:-vision-exp)?(?:[-./]|$)/
const NON_VISION =
  /(?:^|[/:])(?:deepseek|o[134](?:-|$|-mini|-pro)|text-embedding|whisper|tts|dall-e)(?:[-./]|$)/

/**
 * 模型是否支持侧栏识图。
 * 注意：`ch_x::` 前缀的渠道 ref 也要能判——正则以 `[/:]` 作为分隔符，
 * `ch_x::deepseek-flash` 会被 `[/:]` 命中后匹配到模型名。
 */
export function supportsVisionModel(model?: string | null): boolean {
  const m = (model ?? '').trim()
  if (!m) return false
  if (DEEPSEEK_FLASH.test(m)) return true
  if (NON_VISION.test(m)) return false
  return VISION_MODEL.test(m)
}

export interface SidebarVisionParse {
  visionUsed: boolean
  userFacingSummary?: string
  fields?: { category?: string; appearance?: string; materialHint?: string; textInImage?: string }
  unknown?: string[]
}

/** 命中「需要向用户追问」的场景时才提示待确认项（老链路 _PARSE_ASK_UNKNOWN_MARKERS）。 */
const ASK_UNKNOWN_MARKERS = ['上架', '投放', '营销方案', '全链路', '详情页']

export function parseBlockAsksUnknown(text: string): boolean {
  return ASK_UNKNOWN_MARKERS.some((m) => (text ?? '').includes(m))
}

/**
 * 识图失败兜底（平移老 runtime `explore._PARSE_FAIL_NO_EMPTY_LISTING`）。
 * 老链路在 `vision_used=false` 时**仍然输出【侧栏参考图解析】块**（摘要=未知），
 * 再追加这一行——否则模型手里只剩文件名，会照着文件名编一版「上架方案」。
 * 原文以「4.」开头（挂在 explore 规则 4 之后），pi 侧规则编号不复用，故去掉序号。
 */
export const SIDEBAR_VISION_FAIL_HINT =
  '参考图未能识别。禁止写出空品类、空规格的上架方案框架；用文字说明失败并询问用户。'

/**
 * 跨轮复用：老 runtime 把解析结果按 (url, provider_ref) 存在 thread state 里，
 * 同线程追问不再重调 vision。Nest 侧没有 thread state，用「进程内键 + TTL」近似：
 * 键 = providerRef + 本轮图片 URL 集合（集合变了就重解析，与老链路「新 url 才调」同效果），
 * 值 = 渲染好的文本块。只缓存**成功**结果——失败不缓存，下一轮可自愈。
 */
const PARSE_CACHE_TTL_MS = 30 * 60 * 1000
const PARSE_CACHE_MAX = 256
const parseBlockCache = new Map<string, { block: string; ts: number }>()

export function sidebarParseCacheKey(urls: string[], providerRef?: string): string {
  return `${providerRef ?? ''}||${urls.join('|')}`
}

export function getCachedParseBlock(urls: string[], providerRef?: string): string | null {
  const hit = parseBlockCache.get(sidebarParseCacheKey(urls, providerRef))
  if (!hit) return null
  if (Date.now() - hit.ts > PARSE_CACHE_TTL_MS) {
    parseBlockCache.delete(sidebarParseCacheKey(urls, providerRef))
    return null
  }
  return hit.block
}

export function setCachedParseBlock(
  urls: string[],
  providerRef: string | undefined,
  block: string,
): void {
  const key = sidebarParseCacheKey(urls, providerRef)
  parseBlockCache.set(key, { block, ts: Date.now() })
  if (parseBlockCache.size > PARSE_CACHE_MAX) {
    // 简单 FIFO 淘汰：Map 保序，删最老的
    const oldest = parseBlockCache.keys().next().value
    if (oldest !== undefined) parseBlockCache.delete(oldest)
  }
}

/** 仅供测试：清空进程内缓存。 */
export function resetSidebarParseCache(): void {
  parseBlockCache.clear()
}

/** 平移 `format_parse_context_block`：解析结果 → 注入 systemPrompt 的文本块。 */
export function formatParseContextBlock(
  parse: SidebarVisionParse,
  opts?: { userText?: string },
): string {
  const summary = (parse.userFacingSummary ?? '').trim() || '未知'
  const category = (parse.fields?.category ?? '').trim()
  const categoryLine = category || '未知，勿编造'
  const askUnknown = parseBlockAsksUnknown(opts?.userText ?? '')
  const unknown = parse.unknown ?? []
  const unknownHint =
    askUnknown && unknown.length ? `\n待确认项：${unknown.join('、')}` : ''
  const commerce = askUnknown
    ? '图中未出现的价格/平台/资质不要编，改为向用户确认。'
    : '图中未出现的价格/平台/资质不要编造；不要向用户追问这些项，也不要因此推迟摆盘或 propose_generation。'
  return [
    '【侧栏参考图解析】',
    `摘要：${summary}`,
    `品类：${categoryLine}${unknownHint}`,
    '请基于以上理解回答或写方案。不要声称只能看到文件名或画布节点标题。',
    commerce,
  ].join('\n')
}
