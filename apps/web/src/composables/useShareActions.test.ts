import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useShareActions } from './useShareActions'
import type { ShareTurn } from '@lnkpi/shared/shareTemplate'

/**
 * Task 3 单测（对齐规格 §4 复制链接判据 + Review Focus 2/3）。
 * 注意：`copyLink` 接受「已解析 url」并在调用点同步写入剪贴板（手势安全）；
 * 上传是异步的 `upload`，须在点击手势之外预先完成并缓存 url。
 * 命名对齐实现：二维码/微信展示为 `showQr`/`showWeChat`（经内部 `qrDataUrl` 暴露）。
 */
describe('useShareActions', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
		// 离线内联 fetch 不需要真网络；统一 reject 让降级分支稳定命中
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline-test')))
	})

	it('openOffline：图片内联 fetch 失败降级不崩 + 生成 Blob + 触发 window.open', async () => {
		const blobUrl = 'blob:http://localhost/1'
		Object.defineProperty(URL, 'createObjectURL', {
			value: vi.fn(() => blobUrl),
			configurable: true,
		})
		const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

		const actions = useShareActions()
		const turn: ShareTurn = {
			id: 't1',
			role: 'user',
			contentText: 'x',
			createdAt: 0,
			attachments: [{ kind: 'image', url: 'https://x/a.png' }],
		}
		await actions.openOffline([turn])

		expect(openSpy).toHaveBeenCalled()
		expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
	})

	it('copyLink：在同步回调写入已解析 url（手势安全，非 await 之后）', async () => {
		const write = vi.fn().mockResolvedValue(undefined)
		Object.defineProperty(navigator, 'clipboard', {
			value: { writeText: write },
			configurable: true,
		})

		const actions = useShareActions()
		const resolved = 'https://x/share/abc.html'
		await actions.copyLink(resolved)

		expect(write).toHaveBeenCalledTimes(1)
		expect(write).toHaveBeenCalledWith(resolved)
	})

	it('showQr：设置内部文本后 qrDataUrl 异步产出 dataURL', async () => {
		const actions = useShareActions()
		actions.showQr('https://x/share/abc.html')
		// qrDataUrl 由 useQrDataUrl 经 watch 异步渲染
		await vi.waitFor(() => expect(actions.qrDataUrl.value).toContain('data:image/png'))
	})
})
