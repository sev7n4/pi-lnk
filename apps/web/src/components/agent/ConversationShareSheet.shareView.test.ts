import { describe, it, expect } from 'vitest'
// 2026-11-05 真机走查六问 · 分享卡片静态契约（iOS 极简）：
// ① 一次一屏一件事——结果视图替换菜单；② 一个主行动 + 四个等权工具；
// ③ 计数唯一；④ 状态切换永不置灰；⑤ 卡片 ✕ 唯一退出口，任何层级都直接回对话页。
import raw from './ConversationShareSheet.vue?raw'

const src = raw
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/<!--[\s\S]*?-->/g, '')
	.replace(/\/\/.*$/gm, '')

const menu = () => src.match(/data-testid="share-menu"[\s\S]*?<\/div>/)?.[0] ?? ''

describe('ConversationSharePanel 极简两屏契约', () => {
	it('主行动 = 系统分享，用转发箭头图标（用户提供的图形）', () => {
		expect(src).toContain('data-testid="share-primary"')
		expect(src).toContain('actions.shareViaSystem(')
		expect(src).toContain('M4 20c0-7 5-12 12-12h3 M14 4l5 4-5 4')
		expect(src).toContain('分享到…')
	})

	it('工具区恰好 4 个等权动作：二维码 / 复制链接 / 生成图片 / 离线打开', () => {
		for (const id of ['mode-qr', 'mode-link', 'mode-image', 'mode-offline']) {
			expect(src, `工具区应包含 ${id}`).toContain(`data-testid="${id}"`)
		}
		const actions = src.match(/data-testid="mode-[a-z]+"/g) ?? []
		expect(actions.length, '同权工具不得超过 4 个').toBe(4)
		expect(menu()).not.toContain('data-testid="share-primary"')
	})

	it('渠道名「微信」退役为功能名「生成二维码」，品牌色圆底移除', () => {
		expect(src).not.toContain('mode-wechat')
		expect(src).not.toContain('--brand-wechat')
		expect(src).not.toContain('微信')
		expect(src).toContain('二维码')
		expect(src).toContain("view.value === 'qr' ? '扫码分享'")
	})

	it('计数只出现一次：不再有 MobileSheet subtitle 重复', () => {
		expect(src).not.toContain(':subtitle=')
		expect(src).not.toContain('已选中')
		expect(src).not.toContain('sheetSubtitle')
		const counts = src.match(/share-selected-count/g) ?? []
		expect(counts.length).toBe(1)
	})

	it('范围切换是永远可点的 toggle（全选 ⇄ 取消全选，不置灰）', () => {
		const toggle = src.match(/<button[\s\S]*?data-testid="share-select-all"[\s\S]*?<\/button>/)?.[0] ?? ''
		expect(toggle).not.toBe('')
		expect(toggle).not.toContain(':disabled')
		expect(toggle).toContain('@click="onToggleAll"')
		expect(src).toContain("emit('toggleAll', !allSelected.value)")
		expect(src).toContain("allSelected ? '取消全选' : '全选'")
		expect(src).not.toContain('emit(\'selectAll\')')
		expect(src).not.toContain('emit(\'clearAll\')')
	})

	it('0 条时留可点恢复路径，不死锁', () => {
		expect(src).toContain('点「全选」加入全部对话')
		expect(src).toMatch(/v-else-if="!canShare"/)
	})

	it('回合级分享可隐藏范围行（单轮不留无效控件）', () => {
		expect(src).toContain('showScope?: boolean')
		expect(src).toContain('{ showScope: true }')
		expect(src).toContain('<div v-if="showScope" class="share-scope"')
	})

	it('结果视图替换菜单（view 状态机 menu → qr / image）', () => {
		expect(src).toMatch(/view\.value = 'qr'/)
		expect(src).toMatch(/view\.value = 'image'/)
		expect(src).toMatch(/view\.value = 'menu'/)
		expect(src).toContain('v-else-if="view === \'qr\'"')
		expect(src).toMatch(/v-if="view === 'menu'"/)
	})

	it('卡片 ✕ 是唯一退出口：任何层级关闭都 emit update:modelValue=false', () => {
		expect(src).toContain('<MobileSheet v-if="modelValue" :title="sheetTitle" @close="close">')
		expect(src).toContain("emit('update:modelValue', false)")
		expect(src).not.toContain('view.value === \'qr\' ? close()')
	})

	it('图标统一 SF Symbols 线性语汇（24 网格 / stroke 2 / currentColor）', () => {
		const svgs = src.match(/<svg[^>]*>/g) ?? []
		expect(svgs.length).toBeGreaterThanOrEqual(6)
		for (const svg of svgs) {
			expect(svg).toContain('viewBox="0 0 24 24"')
			expect(svg).toContain('stroke="currentColor"')
			expect(svg).toContain('stroke-width="2"')
		}
	})
})
