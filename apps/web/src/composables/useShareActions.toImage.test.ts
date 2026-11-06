/**
 * 生成图片三重静默失败的回归守卫（2026-11-06 逐像素取证）：
 *  ① 离屏定位被克隆进 foreignObject ⇒ 全透明空白图；
 *  ② 外链图（CDN 无 CORS）残留 ⇒ toPng 抛错、UI 零反馈；
 *  ③ 未量高 + 固定 pixelRatio:2 ⇒ 长会话超 iOS canvas 面积上限。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useShareActions } from './useShareActions'
import type { ShareTurn } from '@lnkpi/shared/shareTemplate'

const toPng = vi.hoisted(() => vi.fn().mockResolvedValue('data:image/png;base64,OK'))

vi.mock('html-to-image', () => ({ toPng }))
vi.mock('@/services/api', () => ({ api: { post: vi.fn() } }))

const imageTurn = (url: string): ShareTurn => ({
	id: 't1',
	role: 'assistant',
	createdAt: 0,
	parts: [{ type: 'text', text: '海报' }, { type: 'image', url, caption: '海报' }],
})

describe('useShareActions.toImage', () => {
	let originalScrollHeight: PropertyDescriptor | undefined

	beforeEach(() => {
		vi.clearAllMocks()
		toPng.mockResolvedValue('data:image/png;base64,OK')
		// 外链图一律抓不到（生产 CDN 无 CORS 的等价态）
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('CORS blocked')))
		originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
	})

	afterEach(() => {
		if (originalScrollHeight) {
			Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
		} else {
			Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
		}
	})

	it('① 用 style 覆盖 clone 定位（不能只改原节点），且显式量高 + 白底', async () => {
		Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 620 })
		const actions = useShareActions()
		const out = await actions.toImage([imageTurn('data:image/png;base64,AAAA')])
		expect(out).toBe('data:image/png;base64,OK')
		expect(toPng).toHaveBeenCalledTimes(1)

		const [el, opts] = toPng.mock.calls[0]
		expect(opts.style).toMatchObject({ position: 'static', left: '0', top: '0' })
		expect(opts.width).toBe(680)
		expect(opts.height).toBe(620)
		expect(opts.backgroundColor).toBeTruthy()
		// 原节点仍在视口外，用户看不到闪屏
		expect(el.style.left).toBe('-99999px')
	})

	it('③ 长会话动态降 pixelRatio，避免 iOS canvas 面积超限', async () => {
		Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 40_000 })
		const actions = useShareActions()
		await actions.toImage([imageTurn('data:image/png;base64,AAAA')])
		const [, opts] = toPng.mock.calls[0]
		expect(opts.height).toBe(40_000)
		expect(opts.pixelRatio).toBeLessThan(1)
		expect(680 * 40_000 * opts.pixelRatio ** 2).toBeLessThanOrEqual(12_000_000 + 1)
	})

	it('短会话仍用 2 倍清晰度', async () => {
		Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 600 })
		const actions = useShareActions()
		await actions.toImage([imageTurn('data:image/png;base64,AAAA')])
		expect(toPng.mock.calls[0][1].pixelRatio).toBe(2)
	})

	it('② 外链图抓取失败 ⇒ 占位卡 + 在线查看，DOM 里不残留外链 <img>', async () => {
		Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 620 })
		const actions = useShareActions()
		await actions.toImage([imageTurn('https://cdn.example.com/o.png')])
		const [el] = toPng.mock.calls[0]
		expect(el.innerHTML).not.toContain('<img class="img"')
		expect(el.innerHTML).not.toContain('src="https://cdn.example.com/o.png"')
		expect(el.innerHTML).toContain('图片需在在线分享页查看')
		expect(el.innerHTML).toContain('href="https://cdn.example.com/o.png"')
	})

	it('附件里的外链图同样降级（用户上传的图不会让整张长图失败）', async () => {
		Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 620 })
		const actions = useShareActions()
		const t: ShareTurn = {
			id: 'u1', role: 'user', createdAt: 0,
			parts: [{ type: 'text', text: '看看' }],
			attachments: [{ kind: 'image', url: 'https://cdn.example.com/up.png' }],
		}
		await actions.toImage([t])
		const [el] = toPng.mock.calls[0]
		expect(el.innerHTML).not.toContain('src="https://cdn.example.com/up.png"')
		expect(el.innerHTML).toContain('图片需在在线分享页查看')
	})

	it('成功与失败都移除离屏节点，不污染 body', async () => {
		Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 620 })
		const before = document.body.childElementCount
		const actions = useShareActions()
		await actions.toImage([imageTurn('data:image/png;base64,AAAA')])
		expect(document.body.childElementCount).toBe(before)

		toPng.mockRejectedValueOnce(new Error('canvas too large'))
		await expect(actions.toImage([imageTurn('data:image/png;base64,AAAA')])).rejects.toThrow('canvas too large')
		expect(document.body.childElementCount).toBe(before)
	})
})
