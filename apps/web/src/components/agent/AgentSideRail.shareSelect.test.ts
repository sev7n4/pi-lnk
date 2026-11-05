import { describe, it, expect } from 'vitest'
// 静态契约：读源文件做正则断言（与 AgentSideRail.icon.test.ts 同款 ?raw 导入方式）。
// 会话级分享勾选态（用户裁决 2026-11-05）：点顶栏「分享」后本体页各条对话记录左侧出现 ☐，
// 默认全选，可逐条取消；勾选集真相在 CanvasPage，本组件只渲染 + 上抛切换。
import raw from './AgentSideRail.vue?raw'

const src = raw
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/<!--[\s\S]*?-->/g, '')
	.replace(/\/\/.*$/gm, '')

describe('AgentSideRail 会话级分享勾选态契约', () => {
	it('每条对话记录左侧渲染 ☐ 勾选钮（仅勾选态出现）', () => {
		expect(src).toContain('data-testid="agent-turn-check"')
		expect(src).toContain('v-if="props.shareSelectMode"')
		expect(src).toContain('agent-turn--share-select')
	})
	it('勾选钮只上抛 toggleShareSelect（勾选集真相在 CanvasPage）', () => {
		expect(src).toContain("emit('toggleShareSelect', msg.id)")
		expect(src).toContain('toggleShareSelect: [id: string]')
	})
	it('勾选态样式：绝对定位 + 左侧留白（不改既有 flex 排版）', () => {
		expect(src).toMatch(/\.agent-turn--share-select\s*\{[^}]*position:\s*relative/)
		expect(src).toMatch(/\.agent-turn--share-select\s*\{[^}]*padding-left:\s*44px/)
		expect(src).toMatch(/\.agent-turn-check\s*\{[^}]*position:\s*absolute/)
	})
	it('勾选钮用内联 SVG（禁 emoji），选中态描品牌色', () => {
		const btn = src.match(/<button[^>]*data-testid="agent-turn-check"[\s\S]*?<\/button>/)
		expect(btn).not.toBeNull()
		expect(btn![0]).toContain('<svg')
		expect(btn![0]).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u)
		expect(src).toMatch(/\.agent-turn-check\.is-checked\s*\{[^}]*color:\s*var\(--lnk-accent\)/)
	})
	it('回合级分享入口不受勾选态影响（仍单选本轮）', () => {
		expect(src).toContain('@click="openShare(msg)"')
	})
})
