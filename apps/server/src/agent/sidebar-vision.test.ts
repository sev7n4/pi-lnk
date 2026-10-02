/**
 * 侧栏识图（③）纯函数测试——逐条对齐老 runtime 的 pytest（老 runtime 已于 2026-09-27 退役删除，下列路径仅作历史语义出处）：
 *   services/agent-runtime/tests/test_supports_vision_model.py
 *   services/agent-runtime/app/graph/sidebar_media_parse.py: format_parse_context_block
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  formatParseContextBlock,
  getCachedParseBlock,
  imageUrlsForParse,
  parseBlockAsksUnknown,
  resetSidebarParseCache,
  setCachedParseBlock,
  supportsVisionModel,
} from './sidebar-vision'

describe('supportsVisionModel（对齐老 runtime test_supports_vision_model.py）', () => {
  it('deepseek-flash 系 → true（含渠道前缀与 -vision-exp）', () => {
    for (const m of [
      'deepseek-flash',
      'ch_x::deepseek-flash',
      'deepseek-v4-flash',
      'deepseek-v4.1-flash',
      'deepseek-v4-flash-vision-exp',
    ]) {
      expect(supportsVisionModel(m), m).toBe(true)
    }
  })

  it('非视觉系 → false（deepseek-v4-pro / deepseek-v3.2）', () => {
    expect(supportsVisionModel('deepseek-v4-pro')).toBe(false)
    expect(supportsVisionModel('ch_x::deepseek-v3.2')).toBe(false)
  })

  it('视觉系 → true（gemini / gpt-4o / gpt-5 / claude / agnes）', () => {
    expect(supportsVisionModel('gemini-3.5-flash-lite')).toBe(true)
    expect(supportsVisionModel('gpt-4o')).toBe(true)
    expect(supportsVisionModel('gpt-5')).toBe(true)
    expect(supportsVisionModel('claude-sonnet-4')).toBe(true)
    expect(supportsVisionModel('agnes-2.5-flash')).toBe(true)
  })

  it('空值 / undefined → false（不抛）', () => {
    expect(supportsVisionModel('')).toBe(false)
    expect(supportsVisionModel('   ')).toBe(false)
    expect(supportsVisionModel(undefined)).toBe(false)
    expect(supportsVisionModel(null)).toBe(false)
  })
})

describe('imageUrlsForParse', () => {
  it('只取 mediaType=image 且带 url，去重保序', () => {
    expect(
      imageUrlsForParse([
        { url: 'https://a/1.png', mediaType: 'image' },
        { url: 'https://a/1.png', mediaType: 'image' },
        { url: 'https://a/2.png', mediaType: 'image' },
        { text: 'hello', mediaType: 'text' },
        { url: 'https://a/3.mp4', mediaType: 'video' },
        { url: '   ', mediaType: 'image' },
      ]),
    ).toEqual(['https://a/1.png', 'https://a/2.png'])
  })

  it('undefined / 空数组 → []', () => {
    expect(imageUrlsForParse(undefined)).toEqual([])
    expect(imageUrlsForParse([])).toEqual([])
  })

  it('上限 4 张（老 runtime MAX_PARSE_IMAGE_URLS）：第 5 张不进识图', () => {
    const five = [1, 2, 3, 4, 5].map((i) => ({
      url: `https://a/${i}.png`,
      mediaType: 'image',
    }))
    expect(imageUrlsForParse(five)).toEqual([
      'https://a/1.png',
      'https://a/2.png',
      'https://a/3.png',
      'https://a/4.png',
    ])
  })
})

describe('侧栏识图跨轮缓存（老 runtime thread state 缓存的 Nest 侧近似）', () => {
  it('同 provider + 同图片集合 → 命中；换集合或换 provider → 未命中', () => {
    resetSidebarParseCache()
    const urls = ['https://a/1.png']
    expect(getCachedParseBlock(urls, 'p1')).toBeNull()
    setCachedParseBlock(urls, 'p1', 'BLOCK')
    expect(getCachedParseBlock(urls, 'p1')).toBe('BLOCK')
    expect(getCachedParseBlock(['https://a/1.png', 'https://a/2.png'], 'p1')).toBeNull()
    expect(getCachedParseBlock(urls, 'p2')).toBeNull()
    resetSidebarParseCache()
  })

  it('TTL 过期 → 未命中（失败不会永久粘住）', () => {
    resetSidebarParseCache()
    const urls = ['https://a/1.png']
    setCachedParseBlock(urls, 'p1', 'BLOCK')
    const realNow = Date.now
    Date.now = () => realNow() + 31 * 60 * 1000
    try {
      expect(getCachedParseBlock(urls, 'p1')).toBeNull()
    } finally {
      Date.now = realNow
      resetSidebarParseCache()
    }
  })
})

describe('formatParseContextBlock', () => {
  const parse = {
    visionUsed: true,
    userFacingSummary: '一双白色运动鞋，侧拍',
    fields: { category: '运动鞋' },
    unknown: ['price_band', 'platform'],
  }

  it('非追问场景：给摘要/品类，并明确「不要追问」', () => {
    const block = formatParseContextBlock(parse, { userText: '帮我摆盘' })
    expect(block).toContain('【侧栏参考图解析】')
    expect(block).toContain('摘要：一双白色运动鞋，侧拍')
    expect(block).toContain('品类：运动鞋')
    expect(block).toContain('不要向用户追问这些项')
    expect(block).not.toContain('待确认项')
  })

  it('追问场景（含「上架」等）：带待确认项，改为向用户确认', () => {
    const block = formatParseContextBlock(parse, { userText: '这图上架要用什么主图' })
    expect(block).toContain('待确认项：price_band、platform')
    expect(block).toContain('改为向用户确认')
  })

  it('缺摘要/品类 → 兜底文案（不编造）', () => {
    const block = formatParseContextBlock({ visionUsed: true })
    expect(block).toContain('摘要：未知')
    expect(block).toContain('品类：未知，勿编造')
  })

  it('parseBlockAsksUnknown 标记判定', () => {
    expect(parseBlockAsksUnknown('写个营销方案')).toBe(true)
    expect(parseBlockAsksUnknown('换个角度')).toBe(false)
  })
})

describe('supportsVisionModel env 名单（T1：SIDEBAR_VISION_MODELS）', () => {
  afterEach(() => {
    delete process.env.SIDEBAR_VISION_MODELS
  })

  it('名单非空：命中 → true（优先于缺省正则）', () => {
    process.env.SIDEBAR_VISION_MODELS = 'qwen-vl(?:-.+)?,glm-4v'
    expect(supportsVisionModel('qwen-vl-max')).toBe(true)
    expect(supportsVisionModel('glm-4v-flash')).toBe(true)
  })

  it('名单非空且未命中 → false（名单即运维覆盖面，识图兜底路径生效）', () => {
    process.env.SIDEBAR_VISION_MODELS = 'glm-4v'
    expect(supportsVisionModel('gemini-2.5-flash')).toBe(false)
  })

  it('名单为空/未设置 → 回落缺省三正则（缺省行为不变）', () => {
    expect(supportsVisionModel('gemini-2.5-flash')).toBe(true)
    expect(supportsVisionModel('deepseek-v4-pro')).toBe(false)
    process.env.SIDEBAR_VISION_MODELS = '  '
    expect(supportsVisionModel('gemini-2.5-flash')).toBe(true)
  })
})
