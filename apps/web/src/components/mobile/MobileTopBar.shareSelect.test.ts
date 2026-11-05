import { describe, it, expect } from 'vitest'
// 顶栏选择态极简化（用户裁决 2026-11-05）：计数与全选/取消已移入分享面板顶部，
// 顶栏只保留「✕ 退出选择」，避免同一信息两处重复。
import raw from './MobileTopBar.vue?raw'

const src = raw
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/<!--[\s\S]*?-->/g, '')
	.replace(/\/\/.*$/gm, '')

describe('MobileTopBar 会话级分享选择态契约（极简版）', () => {
	it('选择态仅保留「退出选择」按钮', () => {
		expect(src).toContain('data-testid="mobile-topbar-share-cancel"')
		expect(src).toContain("emit('share-cancel')")
	})

	it('不再有顶栏 ✓ 二次确认与计数（已移入面板）', () => {
		expect(src).not.toContain('mobile-topbar-share-confirm')
		expect(src).not.toContain('mobile-topbar-select-count')
		expect(src).not.toContain("'share-confirm': []")
	})

	it('原「分享会话」入口在选择态隐藏（面板已承担分享动作）', () => {
		expect(src).toMatch(/v-if="props\.tab === 'chat' && !props\.shareSelectMode"/)
	})
})
