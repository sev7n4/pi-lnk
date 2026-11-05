import { describe, it, expect } from 'vitest'
// 会话级分享勾选态接线契约（用户裁决 2026-11-05）：
// 顶栏「分享」→ 进入勾选态（默认全选）→ 本体页各条记录左侧 ☐ → 逐条取消 →
// 顶栏「分享所选」按勾选集打开分享面板。勾选集真相在本页（页面层），不新建全局 store。
import raw from './CanvasPage.vue?raw'

const src = raw
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/<!--[\s\S]*?-->/g, '')
	.replace(/\/\/.*$/gm, '')

describe('CanvasPage 会话级分享勾选接线', () => {
	it('顶栏「分享」进入勾选态并默认全选全部回合', () => {
		expect(src).toMatch(/function openShare\(\)[\s\S]{0,400}shareSelectedIds\.value = agent\.messages\.map\(\(m\) => m\.id\)/)
		expect(src).toMatch(/function openShare\(\)[\s\S]{0,400}shareSelectMode\.value = true/)
	})
	it('勾选集真相在页面层：toggle / confirm / cancel 三件套', () => {
		expect(src).toContain('function toggleShareSelect(id: string)')
		expect(src).toContain('function confirmShare()')
		expect(src).toContain('function cancelShareSelect()')
	})
	it('confirmShare 只分享勾选集', () => {
		expect(src).toMatch(/function confirmShare\(\)[\s\S]{0,600}picked\.has\(m\.id\)/)
		expect(src).toMatch(/function confirmShare\(\)[\s\S]{0,600}shareOpen\.value = true/)
	})
	it('状态接到对话流 ☐ 与移动顶栏（两端同源）', () => {
		expect(src).toContain(':share-select-mode="shareSelectMode"')
		expect(src).toContain(':share-selected-ids="shareSelectedIds"')
		expect(src).toContain('@toggle-share-select="toggleShareSelect"')
		expect(src).toContain(':share-selected-count="shareSelectedIds.length"')
		expect(src).toContain(':on-share-confirm="confirmShare"')
		expect(src).toContain(':on-share-cancel="cancelShareSelect"')
	})
})
