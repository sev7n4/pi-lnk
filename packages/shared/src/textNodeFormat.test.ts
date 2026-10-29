import { describe, expect, it } from 'vitest'
import {
  TEXT_NODE_FORMATS,
  assertTextNodeFormat,
  htmlNodeSummary,
  resolveTextNodeFormat,
  stripHtmlTags,
} from './textNodeFormat'

describe('TEXT_NODE_FORMATS', () => {
  it('白名单恰为 plain/markdown/html（规格 §4.4）', () => {
    expect([...TEXT_NODE_FORMATS]).toEqual(['plain', 'markdown', 'html'])
  })
})

describe('resolveTextNodeFormat（读取侧 fail-soft）', () => {
  it('缺省/未知值/非字符串 ⇒ plain，不抛错', () => {
    expect(resolveTextNodeFormat(undefined)).toBe('plain')
    expect(resolveTextNodeFormat('jsx')).toBe('plain')
    expect(resolveTextNodeFormat(42)).toBe('plain')
    expect(resolveTextNodeFormat({})).toBe('plain')
  })
  it('合法值原样返回', () => {
    expect(resolveTextNodeFormat('html')).toBe('html')
    expect(resolveTextNodeFormat('markdown')).toBe('markdown')
  })
})

describe('assertTextNodeFormat（写入侧 fail-closed）', () => {
  it('非法值 throw 且错误信息列合法值', () => {
    expect(() => assertTextNodeFormat('jsx')).toThrow(/plain, markdown, html/)
    expect(() => assertTextNodeFormat(undefined)).toThrow()
  })
  it('合法值不抛', () => {
    expect(() => assertTextNodeFormat('html')).not.toThrow()
  })
})

describe('stripHtmlTags', () => {
  it('剥标签与 script/style 内容', () => {
    expect(stripHtmlTags('<style>.x{}</style><h1>标题</h1><p>正文</p>')).toBe('标题 正文')
  })
  it('压平空白实体', () => {
    expect(stripHtmlTags('<p>a&nbsp;&nbsp;b</p>')).toBe('a b')
  })
})

describe('htmlNodeSummary（优先级 label > title > strip，≤40 字符）', () => {
  it('label 存在优先', () => {
    expect(htmlNodeSummary({ label: '节点标题', content: '<title>页标题</title><p>正文</p>' })).toBe('节点标题')
  })
  it('label 缺失走 title', () => {
    expect(htmlNodeSummary({ content: '<title>页标题</title><p>正文</p>' })).toBe('页标题')
  })
  it('title 缺失走 strip 首段', () => {
    expect(htmlNodeSummary({ content: '<h1>大标题</h1><p>正文</p>' })).toBe('大标题 正文')
  })
  it('空 content ⇒ 空串', () => {
    expect(htmlNodeSummary({ content: '' })).toBe('')
    expect(htmlNodeSummary(undefined)).toBe('')
  })
  it('超长截断到 ≤40', () => {
    const s = htmlNodeSummary({ content: `<p>${'字'.repeat(60)}</p>` })
    expect(s.length).toBeLessThanOrEqual(40)
  })
})
