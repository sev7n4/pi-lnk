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
	const qr = { value: null as string | null }
	const showQr = vi.fn((_url: string) => {
		qr.value = 'data:image/png;base64,QR'
	})
	const showWeChat = vi.fn((_url: string) => {
		qr.value = 'data:image/png;base64,QR'
	})
	return { upload, copyLink, openOffline, toImage, qr, showQr, showWeChat }
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

describe('ConversationShareSheet', () => {
	let wrapper: ReturnType<typeof mount> | null = null
	beforeEach(() => vi.clearAllMocks())
	afterEach(() => {
		wrapper?.unmount()
		wrapper = null
	})

	const mountSheet = (turns: ShareTurn[], modelValue = true) => {
		wrapper = mount(ConversationShareSheet, { props: { turns, sessionId: 'sess-1', modelValue } })
		return wrapper
	}

	it('副标题显示「将分享 N 条对话」（勾选集合由页面侧决定，面板不再内联筛选）', async () => {
		mountSheet([turn('a', 'user', 'hi'), turn('b', 'assistant', 'hello')])
		await flushPromises()
		expect(bodyText()).toContain('将分享 2 条对话')
	})

	it('面板内不再内联可选对话列表（选择已上移到对话页面本体）', async () => {
		mountSheet([turn('a', 'user', 'hi'), turn('b', 'assistant', 'hello')])
		await flushPromises()
		// 旧的多选列表 / 单选条目必须消失
		expect(q('[data-testid="share-list"]')).toBeNull()
		expect(q('[data-testid="share-item-a"]')).toBeNull()
		expect(q('[data-testid="share-item-b"]')).toBeNull()
	})

	it('打开即预上传并缓存 url（手势安全前置），且直接消费传入的全部 turns', async () => {
		mountSheet([turn('a', 'user', 'hi'), turn('b', 'assistant', 'hello')])
		await flushPromises()
		await new Promise((r) => setTimeout(r, 0))
		expect(h.upload).toHaveBeenCalledTimes(1)
		// 不再二次筛选：传入几条就上传几条
		const [uploadedTurns] = h.upload.mock.calls[0]
		expect(uploadedTurns).toHaveLength(2)
		expect(uploadedTurns.map((t: ShareTurn) => t.id).sort()).toEqual(['a', 'b'])
	})

	it('点击「复制链接」调用 copyLink（同步手势写入）', async () => {
		mountSheet([turn('a', 'user', 'hi')])
		await flushPromises()
		await new Promise((r) => setTimeout(r, 0))
		await clickSel('[data-testid="mode-link"]')
		expect(h.copyLink).toHaveBeenCalledWith('https://x/share/s1.html')
	})

	it('点击「离线打开」调用 openOffline（传入全部 turns）', async () => {
		mountSheet([turn('a', 'user', 'hi')])
		await flushPromises()
		await clickSel('[data-testid="mode-offline"]')
		expect(h.openOffline).toHaveBeenCalledWith([expect.objectContaining({ id: 'a' })])
	})

	it('品牌渠道（微信）点击 → showQr 暴露二维码', async () => {
		mountSheet([turn('a', 'user', 'hi')])
		await flushPromises()
		await new Promise((r) => setTimeout(r, 0))
		await clickSel('[data-testid="mode-wechat"]')
		expect(h.showQr).toHaveBeenCalled()
		expect(q('[data-testid="share-qr"]')).not.toBeNull()
	})

	it('生成图片 → 预览区出现', async () => {
		mountSheet([turn('a', 'user', 'hi')])
		await flushPromises()
		await clickSel('[data-testid="mode-image"]')
		expect(h.toImage).toHaveBeenCalledWith([expect.objectContaining({ id: 'a' })])
		expect(q('[data-testid="share-img"]')).not.toBeNull()
	})

	it('close 事件：关闭回传 update:modelValue=false', async () => {
		mountSheet([turn('a', 'user', 'hi')])
		await flushPromises()
		await clickSel('[data-testid="m-sheet-close"]')
		expect(wrapper!.emitted('update:modelValue')?.at(-1)).toEqual([false])
	})
})
