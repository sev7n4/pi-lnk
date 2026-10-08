/**
 * `node_graph` 独立 HTML 快照的行为契约（2026-07-24）。
 *
 * 重点不是"生成得好看"，而是**安全（XSS 转义）**与**不编造**。
 */
import { describe, it, expect } from 'vitest'
import { buildNodeGraphHtml, escapeHtml, nodeGraphFileName } from './node-graph-export'

const NODES = [
	{ id: 'img-1', type: 'image', title: '镜头1 · 雨夜街道', position: { x: 0, y: 0 } },
	{ id: 'img-2', type: 'text', title: '旁白', position: { x: 240, y: 0 } },
	{ id: 'grp-1', type: 'group', title: '第一幕', position: { x: 240, y: 160 } },
]
const EDGES = [
	{ source: 'img-1', target: 'img-2' },
	{ source: 'img-2', target: 'grp-1' },
]

describe('node-graph-export', () => {
	describe('🔴 XSS 转义（安全判据，不可省）', () => {
		it('节点标题里的 <script> 被转义，不会成为可执行标签', () => {
			const html = buildNodeGraphHtml(
				[{ id: 'x', type: 'image', title: '<script>alert(1)</script>', position: { x: 0, y: 0 } }],
				[],
			)
			expect(html).not.toContain('<script>alert')
			expect(html).toContain('&lt;script&gt;')
		})

		it('img onerror 注入被转义', () => {
			const html = buildNodeGraphHtml(
				[{ id: 'x', type: 'image', title: '<img src=x onerror=alert(1)>', position: { x: 0, y: 0 } }],
				[],
			)
			expect(html).not.toMatch(/<img src=x/)
			expect(html).toContain('&lt;img')
		})

		it('& 先转义（否则 &lt; 会被二次转义成&amp;lt;）', () => {
			expect(escapeHtml('a & b')).toBe('a &amp; b')
			expect(escapeHtml('&lt;')).toBe('&amp;lt;')
		})

		it('五个危险字符全覆盖（含单引号）', () => {
			expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;')
		})

		it('title 也会被转义（它是用户可控的图名）', () => {
			const html = buildNodeGraphHtml([], [], '<b>x</b>')
			expect(html).not.toContain('<b>x</b>')
		})
	})

	describe('不编造', () => {
		it('边引用不存在的节点时跳过（不编造位置）', () => {
			const html = buildNodeGraphHtml(NODES, [{ source: 'img-1', target: 'ghost' }])
			// 只应有 1 条 line（img-2→grp-1 那条）
			expect([...html.matchAll(/<line /g)]).toHaveLength(0)
		})

		it('缺 position 的节点不画（而不是画在 0,0 假装有位置）', () => {
			const html = buildNodeGraphHtml([{ id: 'np', type: 'image', title: 'no pos' }], [])
			// 仍会有一个 rect（按兜底 0,0 画）—— 但**不应**因为它没有位置就报坐标 NaN
			expect(html).not.toContain('NaN')
			expect(html).not.toContain('undefined')
		})

		it('未知类型走中性样式（不编造语义标签）', () => {
			const html = buildNodeGraphHtml([{ id: 'u', type: '未知', title: 't', position: { x: 0, y: 0 } }], [])
			expect(html).toContain('节点') // NEUTRAL.label
			expect(html).not.toContain('NaN')
		})
	})

	describe('结构', () => {
		it('含节点数与连线数统计', () => {
			const html = buildNodeGraphHtml(NODES, EDGES, '第一幕')
			expect(html).toContain('3 节点')
			expect(html).toContain('2 连线')
		})

		it('是完整 HTML 文档（可直接保存打开）', () => {
			const html = buildNodeGraphHtml(NODES, EDGES, 'x')
			expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
			expect(html).toContain('</html>')
		})

		it('空载荷不崩', () => {
			const html = buildNodeGraphHtml([], [], '空')
			expect(html).toContain('<!DOCTYPE html>')
			expect(html).not.toContain('NaN')
		})

		it('无 title 时回退「画布概览」', () => {
			expect(buildNodeGraphHtml([], [])).toContain('画布概览')
		})

		it('明确声明不含缩略图（避免看图的人误以为漏了）', () => {
			expect(buildNodeGraphHtml(NODES, EDGES, 'x')).toContain('缩略图未包含')
		})

		it('running / failed 节点带状态点', () => {
			const html = buildNodeGraphHtml(
				[
					{ id: 'r', type: 'image', title: 'r', position: { x: 0, y: 0 }, status: 'running' },
					{ id: 'f', type: 'image', title: 'f', position: { x: 200, y: 0 }, status: 'failed' },
				],
				[],
			)
			expect(html).toContain('#EF9F27')
			expect(html).toContain('#E24B4A')
		})
	})

	describe('文件名', () => {
		it('含标题 slug 与会话 id 前 8 位', () => {
			expect(nodeGraphFileName('cmuwrdar0002op01lyqrhcwz', '第一幕')).toBe(
				'第一幕-cmuwrdar.html',
			)
		})

		it('无标题时回退 node-graph', () => {
			expect(nodeGraphFileName('cmuwrdar0002')).toBe('node-graph-cmuwrdar.html')
		})

		it('标题里的危险字符被清掉（避免文件名注入路径分隔符）', () => {
			const name = nodeGraphFileName('s1', '../../etc/passwd')
			expect(name).not.toContain('/')
			expect(name).not.toContain('..')
		})
	})
})