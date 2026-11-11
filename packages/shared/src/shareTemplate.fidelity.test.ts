/**
 * 分享页对产品 SSE 对话的保真回归（2026-11-06）。
 * 这里的每一条都对应一次真实取证：换行折叠、附件全丢、时区差 8 小时、
 * notice 丢 tone、外链图污染截图链路、公开页 SVG 直插 XSS。
 */
import { describe, it, expect } from 'vitest'
import {
	buildShareHtml,
	escapeHtml,
	fmtShareTime,
	sanitizeSvg,
	type ShareTurn,
	type ShareTurnPart,
} from './shareTemplate'

const turn = (over: Partial<ShareTurn> = {}): ShareTurn => ({
	id: 't1', role: 'assistant', createdAt: 0, ...over,
})
const parts = (p: ShareTurnPart[]): ShareTurn => turn({ parts: p })

describe('正文保真', () => {
	it('文本用 white-space:pre-wrap 承载换行，3+ 连续换行折叠为空行', () => {
		const h = buildShareHtml([parts([{ type: 'text', text: '第一行\n第二行\n\n\n\n第三段' }])])
		expect(h).toContain('.text{white-space:pre-wrap')
		expect(h).toContain('第一行\n第二行\n\n第三段')
		expect(h).not.toContain('\n\n\n\n第三段')
	})

	it('助手回复是无框满宽正文（产品形态），用户气泡仍收窄', () => {
		const h = buildShareHtml([turn()])
		expect(h).toContain('.msg.assistant .bubble{width:100%;background:transparent;border:none')
		expect(h).toContain('.msg.user .bubble{max-width:82%')
	})
})

describe('时间保真', () => {
	it('固定按 UTC+8 输出，不随宿主 TZ 漂移（容器 UTC / 浏览器 CST 必须一致）', () => {
		const ts = Date.UTC(2026, 10, 6, 1, 20, 3)
		expect(fmtShareTime(ts)).toBe('2026/11/6 09:20:03')
		const before = fmtShareTime(ts)
		const prev = process.env.TZ
		process.env.TZ = 'America/New_York'
		try {
			expect(fmtShareTime(ts)).toBe(before)
		} finally {
			process.env.TZ = prev
		}
	})

	it('分享页时间落在页面里，且脚注说明时区', () => {
		const h = buildShareHtml([turn({ createdAt: Date.UTC(2026, 10, 6, 1, 20, 3) })])
		expect(h).toContain('2026/11/6 09:20:03')
		expect(h).toContain('北京时间 (UTC+8)')
		expect(h).not.toContain('Invalid Date')
	})
})

describe('内容不丢', () => {
	it('parts 与 attachments 合并渲染（旧实现 parts 非空时附件 100% 丢弃）', () => {
		const h = buildShareHtml([
			turn({
				parts: [{ type: 'text', text: '帮我看看这张图' }],
				attachments: [
					{ kind: 'image', url: 'https://x/user-upload.png' },
					{ kind: 'file', url: 'https://x/brief.pdf' },
				],
			}),
		])
		expect(h).toContain('帮我看看这张图')
		expect(h).toContain('src="https://x/user-upload.png"')
		expect(h).toContain('https://x/brief.pdf')
	})

	it('notice 按 tone 渲染独立配色，error 不再被当普通正文', () => {
		const h = buildShareHtml([parts([
			{ type: 'notice', text: '生成失败', tone: 'error' },
			{ type: 'notice', text: '排队中', tone: 'warn' },
		])])
		expect(h).toContain('notice notice--error')
		expect(h).toContain('notice notice--warn')
		expect(h).toContain('错误')
	})

	it('tool 带 ✓/✗ 与耗时，args 不再当正文铺开', () => {
		const h = buildShareHtml([parts([
			{ type: 'tool', name: 'run_gen', result: '完成 4 张', status: 'done', ms: 17000, args: { secret: 'x' } },
			{ type: 'tool', name: 'run_fail', status: 'failed', isError: true },
		])])
		expect(h).toContain('✓ 完成 · 17000ms')
		expect(h).toContain('✗ 失败')
		expect(h).not.toContain('secret')
	})

	// D1（2026-11-11 生产事故）：turn_interrupted 的 tool 在分享页不得复刻
	// 「✓ 用时 0ms」式二次说谎——既不能标完成/失败，也不能编造完成耗时。
	it('★ D1 回归锁：interrupted tool 明确标「未收到结果」，禁止 ✓/✗ 与耗时', () => {
		const h = buildShareHtml([parts([
			{
				type: 'tool', name: 'spawn_subagent', status: 'interrupted',
				ms: 0, result: undefined, args: { task: '调研 X' },
			},
		])])
		expect(h).toContain('⏹ 未收到结果')
		expect(h).not.toContain('✓ 完成')
		expect(h).not.toContain('✗ 失败')
		expect(h).not.toContain('0ms')
		expect(h).not.toContain('调研 X')
	})

	it('★ D1 回归锁：正常 done tool 仍保留 ✓ 与真实耗时（不被 interrupted 分支吞掉）', () => {
		const h = buildShareHtml([parts([
			{ type: 'tool', name: 'search', status: 'done', ms: 17000, result: '命中 3 条' },
		])])
		expect(h).toContain('✓ 完成 · 17000ms')
		expect(h).toContain('命中 3 条')
	})

	it('artifact / audio / file / canvas 各有卡片，不伪装成破图', () => {
		const h = buildShareHtml([parts([
			{ type: 'artifact', nodeType: 'text', title: '文案稿', status: 'failed', errorText: '余额不足' },
			{ type: 'audio', url: 'https://x/a.mp3', title: '配音', durationMs: 4200 },
			{ type: 'file', url: 'https://x/b.pdf', title: '需求文档' },
			{ type: 'canvas', label: '新建 4 个节点', nodeId: 'n1' },
		])])
		expect(h).toContain('文案稿')
		expect(h).toContain('余额不足')
		expect(h).toContain('配音')
		expect(h).toContain('需求文档')
		expect(h).toContain('新建 4 个节点')
		// 没有任何一个被塞进 <img src=...pdf/mp3>
		expect(h).not.toContain('src="https://x/a.mp3"')
		expect(h).not.toContain('src="https://x/b.pdf"')
	})

	it('proposal / question 静态还原：题面、选项、终态齐全，且无按钮', () => {
		const h = buildShareHtml([parts([
			{ type: 'proposal', title: '生成 4 张海报', status: 'confirmed' },
			{
				type: 'question', title: '确认风格', status: 'answered',
				questions: [{ question: '选哪种？', options: ['写实', '插画'], multiSelect: true, allowOther: true }],
			},
		])])
		expect(h).toContain('生成 4 张海报')
		expect(h).toContain('已确认')
		expect(h).toContain('选哪种？')
		expect(h).toContain('<li>写实</li>')
		expect(h).toContain('（多选）')
		expect(h).toContain('<li>其他</li>')
		expect(h).not.toContain('<button')
	})

	it('回合末交付摘要条渲染产物 tile', () => {
		const h = buildShareHtml([turn({
			delivery: [{ title: '海报 A', nodeType: 'image' }, { title: '分镜', nodeType: 'video' }],
		})])
		expect(h).toContain('本轮产物 · 2')
		expect(h).toContain('海报 A')
		expect(h).toContain('分镜')
	})
})

describe('生成图片链路', () => {
	it('offline 外链图降级为占位卡 + 在线查看，绝不留下会污染 canvas 的外链 <img>', () => {
		const h = buildShareHtml(
			[parts([{ type: 'image', url: '', caption: '海报', fallbackUrl: 'https://cdn/x.png' }])],
			{ inlineMedia: 'offline' },
		)
		expect(h).not.toContain('<img class="img"')
		expect(h).toContain('图片需在在线分享页查看')
		expect(h).toContain('href="https://cdn/x.png"')
	})

	it('online 托管页仍正常显示外链图（不被降级误伤）', () => {
		const h = buildShareHtml(
			[parts([{ type: 'image', url: 'https://cdn/x.png' }])],
			{ inlineMedia: 'online' },
		)
		expect(h).toContain('src="https://cdn/x.png"')
		expect(h).toContain('loading="lazy"')
	})
})

describe('安全与主题', () => {
	it('sanitizeSvg 剥掉 script / onload / javascript: 但保留合法 SVG', () => {
		const clean = sanitizeSvg('<svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script><rect width="10" height="10"/></svg>')
		expect(clean).toContain('<rect')
		expect(clean).not.toContain('<script')
		expect(clean).not.toContain('onload')
		expect(sanitizeSvg('<svg><a href="javascript:alert(1)">x</a></svg>')).not.toContain('javascript:')
		expect(sanitizeSvg('<div>not svg</div>')).toBe('')
	})

	it('mermaid SVG 自带 <style> 保留上色，但 @import / url() 外连能力被剥', () => {
		const svg = '<svg><style>.node{fill:#fff} @import url(https://evil/x.css); .x{background:url(https://evil/t.png)}</style><rect class="node"/></svg>'
		const clean = sanitizeSvg(svg)
		expect(clean).toContain('.node{fill:#fff}')
		expect(clean).not.toContain('@import')
		expect(clean).not.toContain('url(https://evil')
		expect(clean).toContain('<rect')
	})

	it('恶意 svg part 不进页面，合法 mermaid svg 仍能渲染', () => {
		const evil = buildShareHtml([parts([{ type: 'mermaid', svg: '<div><script>alert(1)</script></div>' }])])
		expect(evil).not.toContain('<script')
		const ok = buildShareHtml([parts([{ type: 'mermaid', svg: '<svg viewBox="0 0 10 10"><rect/></svg>' }])])
		expect(ok).toContain('<svg viewBox="0 0 10 10">')
	})

	it('深色适配存在，且全程零 CSS 变量（离线自包含）', () => {
		const h = buildShareHtml([turn()])
		expect(h).toContain('@media (prefers-color-scheme: dark)')
		expect(h).not.toMatch(/var\(--/)
	})

	it('用户文本一律转义（XSS）', () => {
		const evil = '<img src=x onerror=alert(1)>'
		const h = buildShareHtml([parts([{ type: 'notice', text: evil, tone: 'error' }])])
		expect(h).toContain(escapeHtml(evil))
		expect(h).not.toContain('<img src=x onerror=alert(1)>')
	})
})
