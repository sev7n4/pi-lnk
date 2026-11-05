import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ConversationShareSheet from './ConversationShareSheet.vue'
import type { ShareTurn } from '@lnkpi/shared/shareTemplate'

// 稳定的 spy（hoist 到模块作用域），供组件内部与测试断言同一实例
const h = vi.hoisted(() => {
	const upload = vi.fn().mockResolvedValue({ shareId: 's1', url: 'https://x/share/s1.html' })
	const copyLink = vi.fn().mockResolvedValue(undefined)
	const openOffline = vi.fn().mockResolvedValue(undefined)
	const toImage = vi.fn().mockResolvedValue('data:image/png;base64,AAAA')
	const shareViaSystem = vi.fn().mockResolvedValue('shared')
	const qr = { value: null as string | null }
	const showQr = vi.fn((_url: string) => {
		qr.value = 'data:image/png;base64,QR'
	})
	const showWeChat = vi.fn((_url: string) => {
		qr.value = 'data:image/png;base64,QR'
	})
	return { upload, copyLink, openOffline, toImage, shareViaSystem, qr, showQr, showWeChat }
})

vi.mock('@/composables/useShareActions', () => ({
	useShareActions: () => ({
		loading: { value: false },
		qrDataUrl: h.qr,
		upload: h.upload,
		copyLink: h.copyLink,
		showQr: h.showQr,
		showWeChat: h.showWeChat,
		openOffline: h.openOffline,
		toImage: h.toImage,
		shareViaSystem: h.shareViaSystem,
	}),
}))

const turn = (id: string, role: 'user' | 'assistant', text: string): ShareTurn => ({
	id,
	role,
	createdAt: 0,
	parts: [{ type: 'text', text }],
})

// MobileSheet 用 <Teleport to="body">，测试需在 document.body 上操作
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null
const bodyText = () => document.body.textContent || ''
async function clickSel(sel: string) {
	const el = q(sel)
	if (!el) throw new Error(`selector not found: ${sel}`)
	el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
	await flushPromises()
	await new Promise((r) => setTimeout(r, 0))
}
const disabled = (sel: string) => (q(sel) as HTMLButtonElement | null)?.disabled === true

async function settle() {
	await flushPromises()
	await new Promise((r) => setTimeout(r, 0))
}

describe('ConversationShareSheet（2026-11-05 真机六问）', () => {
	let wrapper: ReturnType<typeof mount> | null = null
	beforeEach(() => {
		vi.clearAllMocks()
		h.qr.value = null
	})
	afterEach(() => {
		wrapper?.unmount()
		wrapper = null
	})

	const mountSheet = (turns: ShareTurn[], extra: Record<string, unknown> = {}) => {
		wrapper = mount(ConversationShareSheet, {
			props: { turns, sessionId: 'sess-1', modelValue: true, ...extra },
		})
		return wrapper
	}

	it('④ 计数唯一：范围行只出现一次「已选 N / M 条」，无 subtitle 重复', async () => {
		mountSheet([turn('a', 'user', 'hi'), turn('b', 'assistant', 'hello')])
		await settle()
		expect((bodyText().match(/已选 2 \/ 2 条/g) ?? []).length).toBe(1)
		expect(bodyText()).not.toContain('已选中')
		expect(q('[data-testid="share-selected-count"]')).not.toBeNull()
	})

	it('② 全选永远可点：默认全选显示「取消全选」，点击上抛 toggleAll(false)', async () => {
		mountSheet([turn('a', 'user', 'hi')])
		await settle()
		const toggle = q('[data-testid="share-select-all"]')
		expect(toggle).not.toBeNull()
		expect(disabled('[data-testid="share-select-all"]')).toBe(false)
		expect(toggle!.textContent).toContain('取消全选')
		await clickSel('[data-testid="share-select-all"]')
		expect(wrapper!.emitted('toggleAll')?.at(-1)).toEqual([false])
	})

	it('②/③ 0 条不死锁：动作禁用但「全选」仍可点并上抛 toggleAll(true)', async () => {
		mountSheet([], { selectedCount: 0, totalCount: 13 })
		await settle()
		expect(bodyText()).toContain('已选 0 / 13 条')
		expect(disabled('[data-testid="share-primary"]')).toBe(true)
		expect(disabled('[data-testid="mode-qr"]')).toBe(true)
		expect(bodyText()).toContain('点「全选」加入全部对话')
		expect(disabled('[data-testid="share-select-all"]')).toBe(false)
		expect(q('[data-testid="share-select-all"]')!.textContent).toContain('全选')
		await clickSel('[data-testid="share-select-all"]')
		expect(wrapper!.emitted('toggleAll')?.at(-1)).toEqual([true])
	})

	it('⑥ 主行动调系统分享，且点击时不再 await 上传（iOS 同步手势安全）', async () => {
		mountSheet([turn('a', 'user', 'hi')])
		await settle()
		const uploadsBefore = h.upload.mock.calls.length
		expect(uploadsBefore).toBe(1)
		await clickSel('[data-testid="share-primary"]')
		expect(h.shareViaSystem).toHaveBeenCalledWith({
			title: '对话分享',
			url: 'https://x/share/s1.html',
		})
		expect(h.upload.mock.calls.length).toBe(uploadsBefore)
	})

	it('⑤ 生成二维码：结果视图替换菜单（菜单不再同屏）', async () => {
		mountSheet([turn('a', 'user', 'hi')])
		await settle()
		expect(q('[data-testid="share-menu"]')).not.toBeNull()
		await clickSel('[data-testid="mode-qr"]')
		expect(q('[data-testid="share-menu"]')).toBeNull()
		expect(q('[data-testid="share-qr"]')).not.toBeNull()
		expect(h.showQr).toHaveBeenCalledWith('https://x/share/s1.html')
	})

	it('① 卡片 ✕ 关闭一次即回对话页：emit update:modelValue=false', async () => {
		mountSheet([turn('a', 'user', 'hi')])
		await settle()
		await clickSel('[data-testid="m-sheet-close"]')
		expect(wrapper!.emitted('update:modelValue')?.at(-1)).toEqual([false])
	})

	it('① 结果视图里的 ✕ 也直接关闭，不要求先点「返回」', async () => {
		mountSheet([turn('a', 'user', 'hi')])
		await settle()
		await clickSel('[data-testid="mode-qr"]')
		expect(q('[data-testid="share-qr"]')).not.toBeNull()
		await clickSel('[data-testid="m-sheet-close"]')
		expect(wrapper!.emitted('update:modelValue')?.at(-1)).toEqual([false])
	})

	it('结果视图「返回」回到菜单，菜单与结果互斥', async () => {
		mountSheet([turn('a', 'user', 'hi')])
		await settle()
		await clickSel('[data-testid="mode-qr"]')
		await clickSel('[data-testid="qr-back"]')
		expect(q('[data-testid="share-menu"]')).not.toBeNull()
		expect(q('[data-testid="share-qr"]')).toBeNull()
	})

	it('打开即预上传并缓存 url，直接消费传入的全部 turns', async () => {
		mountSheet([turn('a', 'user', 'hi'), turn('b', 'assistant', 'hello')])
		await settle()
		expect(h.upload).toHaveBeenCalledTimes(1)
		const [uploadedTurns] = h.upload.mock.calls[0]
		expect(uploadedTurns.map((t: ShareTurn) => t.id).sort()).toEqual(['a', 'b'])
	})

	it('点击「复制链接」调用 copyLink（同步手势写入）', async () => {
		mountSheet([turn('a', 'user', 'hi')])
		await settle()
		await clickSel('[data-testid="mode-link"]')
		expect(h.copyLink).toHaveBeenCalledWith('https://x/share/s1.html')
	})

	it('点击「离线打开」调用 openOffline（传入全部 turns）', async () => {
		mountSheet([turn('a', 'user', 'hi')])
		await settle()
		await clickSel('[data-testid="mode-offline"]')
		expect(h.openOffline).toHaveBeenCalledWith([expect.objectContaining({ id: 'a' })], undefined)
	})

	it('生成图片 → 预览区替换菜单', async () => {
		mountSheet([turn('a', 'user', 'hi')])
		await settle()
		await clickSel('[data-testid="mode-image"]')
		expect(h.toImage).toHaveBeenCalledWith([expect.objectContaining({ id: 'a' })], undefined)
		expect(q('[data-testid="share-img"]')).not.toBeNull()
		expect(q('[data-testid="share-menu"]')).toBeNull()
	})

	it('title prop 透传给上传 / 系统分享 / 图片 / 离线（「对话·项目名称」）', async () => {
		mountSheet([turn('a', 'user', 'hi')], { title: '对话·测试项目' })
		await settle()
		expect(h.upload).toHaveBeenCalledWith(expect.anything(), 'sess-1', '对话·测试项目')
		await clickSel('[data-testid="share-primary"]')
		expect(h.shareViaSystem).toHaveBeenCalledWith(
			expect.objectContaining({ title: '对话·测试项目' }),
		)
		await clickSel('[data-testid="mode-offline"]')
		expect(h.openOffline).toHaveBeenCalledWith(expect.anything(), '对话·测试项目')
		await clickSel('[data-testid="mode-image"]')
		expect(h.toImage).toHaveBeenCalledWith(expect.anything(), '对话·测试项目')
	})

	it('回合级分享（showScope=false）不显示范围行，但动作仍可用', async () => {
		mountSheet([turn('a', 'user', 'hi')], { showScope: false })
		await settle()
		expect(q('[data-testid="share-select-row"]')).toBeNull()
		expect(q('[data-testid="share-primary"]')).not.toBeNull()
		expect(q('[data-testid="share-menu"]')).not.toBeNull()
	})

	it('面板内不再内联可选对话清单（逐条勾选已退役）', async () => {
		mountSheet([turn('a', 'user', 'hi'), turn('b', 'assistant', 'hello')])
		await settle()
		expect(q('[data-testid="share-list"]')).toBeNull()
		expect(q('[data-testid="share-item-a"]')).toBeNull()
	})
})
