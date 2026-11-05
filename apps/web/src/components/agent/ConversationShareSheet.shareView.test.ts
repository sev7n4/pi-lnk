import { describe, it, expect } from 'vitest'
// 分享面板极简契约（用户裁决 2026-11-05 · 苹果 iOS 极简哲学）：
// ① 一次一屏一件事——结果视图**替换**菜单，不与选择器同屏堆叠；
// ② 同权动作 ≤4——朋友圈/QQ/企业微信首期与微信同行为（均二维码+链接）故收敛；
// ③ 选择控件落在面板顶部，一步完成「全选 / 取消」。
import raw from './ConversationShareSheet.vue?raw'

const src = raw
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/<!--[\s\S]*?-->/g, '')
	.replace(/\/\/.*$/gm, '')

describe('ConversationSharePanel 极简两屏契约', () => {
	it('L0 菜单只有 4 个动作：微信 / 复制链接 / 生成图片 / 离线打开', () => {
		const menu = src.match(/data-testid="share-menu"[\s\S]*?<\/template>/)?.[0] ?? ''
		for (const id of ['mode-wechat', 'mode-link', 'mode-image', 'mode-offline']) {
			expect(menu, `菜单应包含 ${id}`).toContain(`data-testid="${id}"`)
		}
		const actions = menu.match(/data-testid="mode-[a-z]+"/g) ?? []
		expect(actions.length, '同权动作不得超过 4 个').toBe(4)
	})

	it('朋友圈/QQ/企业微信占位入口已收敛（与微信同行为，避免重复占位）', () => {
		expect(src).not.toContain('朋友圈')
		expect(src).not.toContain('企业微信')
		expect(src).not.toMatch(/label:\s*'QQ'/)
	})

	it('结果视图替换菜单（view 状态机 menu → qr / image）', () => {
		expect(src).toMatch(/view\.value = 'qr'/)
		expect(src).toMatch(/view\.value = 'image'/)
		expect(src).toMatch(/view\.value = 'menu'/)
		expect(src).toContain("v-else-if=\"view === 'qr'\"")
	})

	it('选择行在全选/取消一键操作（不割裂到二级）', () => {
		expect(src).toContain('data-testid="share-select-row"')
		expect(src).toContain('data-testid="share-select-all"')
		expect(src).toContain('data-testid="share-select-clear"')
		expect(src).toContain("emit('selectAll')")
		expect(src).toContain("emit('clearAll')")
	})

	it('菜单动作与结果视图互斥渲染（不同屏）', () => {
		expect(src).toMatch(/v-if="view === 'menu'"/)
		expect(src).toMatch(/v-else-if="view === 'qr'"/)
	})
})
