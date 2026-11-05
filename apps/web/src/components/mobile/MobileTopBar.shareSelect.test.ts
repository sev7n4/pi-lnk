import { describe, it, expect } from 'vitest'
import raw from './MobileTopBar.vue?raw'

const src = raw
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/<!--[\s\S]*?-->/g, '')
	.replace(/\/\/.*$/gm, '')

describe('MobileTopBar 会话级分享勾选态契约', () => {
	it('勾选态显示「已选 N 条」+ 分享所选 + 取消', () => {
		expect(src).toContain('data-testid="mobile-topbar-select-count"')
		expect(src).toContain('data-testid="mobile-topbar-share-confirm"')
		expect(src).toContain('data-testid="mobile-topbar-share-cancel"')
		expect(src).toContain('已选')
	})
	it('勾选态下原「分享会话」图标钮隐藏（避免两个入口并置）', () => {
		expect(src).toMatch(/v-if="props\.tab === 'chat' && !props\.shareSelectMode"/)
	})
	it('动作以 emit 上抛（壳层桥接 CanvasPage）', () => {
		expect(src).toContain("'share-confirm': []")
		expect(src).toContain("'share-cancel': []")
		expect(src).toContain("emit('share-confirm')")
		expect(src).toContain("emit('share-cancel')")
	})
})
