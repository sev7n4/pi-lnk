import { describe, it, expect } from 'vitest'
import { buildShareHtml, escapeHtml, type ShareTurn, type ShareTurnPart } from './shareTemplate'

const turn = (over: Partial<ShareTurn> = {}): ShareTurn => ({
	id: 't1',
	role: 'user',
	contentText: 'hi',
	createdAt: 0,
	...over,
})
const parts = (p: ShareTurnPart[]): ShareTurn => turn({ parts: p })

describe('buildShareHtml', () => {
	it('① 自包含：无外链 script/link', () => {
		const h = buildShareHtml([turn()])
		expect(h).not.toMatch(/<script\s+src=/i)
		expect(h).not.toMatch(/<link\s+href=/i)
		expect(h).toContain('<style>')
	})
	it('② 空 turns 兜底不抛错', () => {
		expect(() => buildShareHtml([])).not.toThrow()
		expect(buildShareHtml([])).toContain('暂无分享内容')
	})
	it('③ XSS：注入 onerror 不执行', () => {
		const evil = '<img src=x onerror=alert(1)>'
		const h = buildShareHtml([turn({ contentText: evil })])
		expect(h).toContain(escapeHtml(evil))
		expect(h).not.toContain('<img src=x onerror=alert(1)>')
	})
	it('④ 图片附件以 <img src=url> 呈现', () => {
		const h = buildShareHtml(
			[turn({ attachments: [{ kind: 'image', url: 'https://x/a.png' }] })],
			{ inlineMedia: 'online' },
		)
		expect(h).toContain('src="https://x/a.png"')
	})
	it('⑤ 离线副本不依赖运行时 CSS 变量', () => {
		const h = buildShareHtml([turn()])
		expect(h).not.toMatch(/var\(--/)
	})
	it('⑥ 折叠块渲染为原生 <details>，thinking 默认收起（无 JS 可展开）', () => {
		const h = buildShareHtml([parts([{ type: 'thinking', text: 'let me think', done: true }])])
		expect(h).toContain('<details')
		expect(h).toContain('<summary')
		// thinking 不应带 open 属性
		expect(h).not.toMatch(/<details[^>]*open[^>]*>/)
		expect(h).not.toContain('useDisclosure') // 不搬 JS 状态机
		// 工具调用才默认展开
		const tool = buildShareHtml([parts([{ type: 'tool', name: 'search', args: { q: 1 } }])])
		expect(tool).toMatch(/<details[^>]*open[^>]*>/)
	})
	it('⑦ Mermaid 内联已净化 SVG，无 mermaid 库/无 script', () => {
		const svg = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
		const h = buildShareHtml([parts([{ type: 'mermaid', svg, code: 'graph TD' }])])
		expect(h).toContain('<details')
		expect(h).toContain(svg)
		expect(h).not.toContain('<script')
	})
	it('⑧ offline 模式图片内联 data: URI', () => {
		const h = buildShareHtml(
			[turn({ attachments: [{ kind: 'image', url: 'data:image/png;base64,AAAA' }] })],
			{ inlineMedia: 'offline' },
		)
		expect(h).toContain('data:image')
	})
	it('⑨ agent HTML 产物内联为 iframe srcdoc sandbox + CSP', () => {
		const html = '<h1>artifact</h1>'
		const h = buildShareHtml([parts([{ type: 'html', content: html, title: '产物' }])])
		expect(h).toContain('<iframe')
		expect(h).toContain('srcdoc=')
		expect(h).toContain('sandbox="allow-scripts"')
		expect(h).toContain("default-src 'none'") // HTML_NODE_CSP 内联（srcdoc 内 ' 不转义）
		// 沙箱内脚本不得获取父页面：断言 sandbox 无 allow-same-origin / allow-top-navigation
		expect(h).not.toMatch(/allow-(same-origin|top-navigation)/)
	})
	it('video 附件渲染为占位卡（非坏链）', () => {
		const h = buildShareHtml([turn({ attachments: [{ kind: 'video', url: 'https://x/v.mp4' }] })])
		expect(h).toContain('在线观看')
		expect(h).not.toContain('<video')
	})
	it('includeOg 注入 OG meta', () => {
		const h = buildShareHtml([turn()], {
			includeOg: true,
			og: { title: 'T', description: 'D', image: 'https://x/og.png' },
		})
		expect(h).toContain('og:title')
		expect(h).toContain('og:description')
		expect(h).toContain('og:image')
	})
})
