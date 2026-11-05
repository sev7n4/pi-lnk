import { describe, it, expect } from 'vitest'
// 2026-11-05 真机走查第 1 问：顶栏残留 ✕ 导致「关两次」。
// 裁决：顶栏永远只有常驻分享入口，✕ 只存在于分享卡片头部（唯一退出口）。
import raw from './MobileTopBar.vue?raw'

const src = raw
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/<!--[\s\S]*?-->/g, '')
	.replace(/\/\/.*$/gm, '')

describe('MobileTopBar 分享入口（无第二 ✕）', () => {
	it('顶栏不存在「退出选择」✕ 按钮与其事件', () => {
		expect(src).not.toContain('mobile-topbar-share-cancel')
		expect(src).not.toContain("emit('share-cancel')")
		expect(src).not.toContain("'share-cancel': []")
	})

	it('顶栏不再持有分享选择态', () => {
		expect(src).not.toContain('shareSelectMode')
	})

	it('chat 页签分享入口常驻，不随面板开关变形', () => {
		expect(src).toContain('v-if="props.tab === \'chat\'"')
		expect(src).toContain('data-testid="mobile-topbar-share"')
		expect(src).toContain("emit('share')")
	})

	it('不存在二次确认 / 计数重复的顶栏残留', () => {
		expect(src).not.toContain('mobile-topbar-share-confirm')
		expect(src).not.toContain('mobile-topbar-select-count')
	})
})
