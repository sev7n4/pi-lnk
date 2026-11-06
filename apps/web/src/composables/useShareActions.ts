import { ref } from 'vue'
import { api } from '@/services/api'
import { buildShareHtml, type ShareTurn, type ShareTurnPart } from '@lnkpi/shared/shareTemplate'
import { useQrDataUrl } from './useQrDataUrl'
import { copyTextToClipboard } from '@/utils/copyToClipboard'
import { toPng } from 'html-to-image'

export interface ShareUploadResult {
	shareId: string
	url: string
}

/** 生成图片的固定宽度（与分享模板 .wrap 的 max-width 一致）。 */
const SHARE_IMAGE_WIDTH = 680
/**
 * canvas 面积上限（保守值）。iOS Safari 对 canvas 有面积/边长硬限制，
 * 长会话在 pixelRatio:2 下会产出 1360×数万像素的图 ⇒ 截图失败或下半截空白。
 */
const MAX_IMAGE_PIXELS = 12_000_000

/** 系统分享的结果，供面板给出不打扰的反馈（HIG：系统面板自己负责成败反馈）。 */
export type ShareViaSystemResult = 'shared' | 'copied' | 'cancelled' | 'failed'

/**
 * 分享动作封装（五种模式）。
 *
 * ⚠️ **手势安全**：`copyLink` 接受「已解析的 url」并在调用点（用户点击回调内）同步写入剪贴板。
 * 网络上传 `upload` 是异步的，**必须在点击之前**（面板打开/勾选时）完成并缓存 url，
 * 否则 `await upload` 之后的 `writeText` 会丢失 iOS 用户手势 ⇒ 静默失败（规格 §4 判据）。
 */
export function useShareActions() {
	const loading = ref(false)
	const qrText = ref<string | null>(null)
	const qrDataUrl = useQrDataUrl(qrText)

	/** 上传到后端双写（DB + 静态托管页），返回公开 URL。须在用户手势之外调用。 */
	async function upload(
		turns: ShareTurn[],
		sessionId: string,
		title?: string,
	): Promise<ShareUploadResult> {
		loading.value = true
		try {
		const resp = await api.post('/share/conversation', { sessionId, turns, title })
		// 响应体为 { code, message, data: { shareId, url } }（api 拦截器返回完整 AxiosResponse，
		// 全仓惯例是 resp.data.data 取内层载荷，见 works-api / studio-api 等调用方）
		const body = resp.data
		if (body.code !== 0) {
			throw new Error(body.message || '分享上传失败')
		}
		const payload = body.data
		return { shareId: payload.shareId, url: payload.url } as ShareUploadResult
		} finally {
			loading.value = false
		}
	}

	/** 复制链接：同步写入已解析 url（调用方保证处于点击手势内）。 */
	async function copyLink(url: string): Promise<void> {
		await copyTextToClipboard(url)
	}

	/** 生成二维码（供微信扫码 / 独立大图）。设置内部 ref，模板绑定 `qrDataUrl`。 */
	function showQr(url: string): void {
		qrText.value = url
	}

	/** 微信模式：与二维码相同（不接 JSSDK），面板另行展示「复制链接」。 */
	function showWeChat(url: string): void {
		qrText.value = url
	}

	/** 离线打开：图片预内联 base64 后生成 Blob 本地打开（零后端、真离线）。 */
	async function openOffline(turns: ShareTurn[], title?: string): Promise<void> {
		const prepared = await prepareOfflineTurns(turns)
		const html = buildShareHtml(prepared, { inlineMedia: 'offline', title })
		const blob = new Blob([html], { type: 'text/html' })
		const url = URL.createObjectURL(blob)
		const w = window.open(url, '_blank')
		if (!w) {
			// 弹窗被拦截 ⇒ 退化为下载
			const a = document.createElement('a')
			a.href = url
			a.download = 'conversation.html'
			a.click()
		}
	}

	/**
	 * 生成图片：模板渲染进离屏层 → html-to-image → 返回 PNG dataURL。
	 *
	 * ⚠️ 三个已实证的静默失败源（2026-11-06 逐像素取证）：
	 *  ① 离屏层 `position:fixed; left:-99999px` 会被 html-to-image 原样克隆进 SVG
	 *     foreignObject，内容整体被推出画布 ⇒ 产出**全透明空白图**（不透明像素 0.00%）。
	 *     必须用 `style` 选项在 clone 上覆盖定位；只改原节点没用。
	 *  ② 外链图（CDN 无 CORS）预内联失败后若保留原 url，html-to-image 会抛
	 *     `[object Event]` ⇒ 点按钮无任何反馈。改由 `prepareOfflineTurns` 降级为占位卡。
	 *  ③ 未传 `height` + 固定 pixelRatio:2 ⇒ 长会话超 iOS canvas 面积上限。
	 */
	async function toImage(turns: ShareTurn[], title?: string): Promise<string> {
		const prepared = await prepareOfflineTurns(turns)
		const html = buildShareHtml(prepared, { inlineMedia: 'offline', title })
		const el = document.createElement('div')
		el.style.position = 'fixed'
		el.style.left = '-99999px'
		el.style.top = '0'
		el.style.width = `${SHARE_IMAGE_WIDTH}px`
		el.innerHTML = html
		document.body.appendChild(el)
		try {
			// 显式量高：fixed 离屏节点的默认尺寸会被 html-to-image 算小，导致尾部被裁
			const height = Math.max(1, el.scrollHeight || el.clientHeight || 1)
			const pixelRatio = Math.max(
				0.4,
				Math.min(2, Math.sqrt(MAX_IMAGE_PIXELS / (SHARE_IMAGE_WIDTH * height))),
			)
			return await toPng(el, {
				width: SHARE_IMAGE_WIDTH,
				height,
				cacheBust: true,
				pixelRatio,
				backgroundColor: '#f5f6f8',
				// 关键：只作用于 clone，原节点仍留在视口外，用户不会看到闪屏
				style: { position: 'static', left: '0', top: '0', width: `${SHARE_IMAGE_WIDTH}px` },
			})
		} finally {
			document.body.removeChild(el)
		}
	}

	/**
	 * 系统分享（Web Share API）——面板的「分享到…」主行动。
	 *
	 * ⚠️ **同步手势铁律**：`navigator.share` 必须在用户点击的同步调用栈内触发；
	 *    本函数第一个 `await` 之前不允许有任何异步操作，否则 iOS 会因丢失
	 *    transient user activation 而静默失败。调用方须先用 `upload` 缓存好 url。
	 *    浏览器不支持 Web Share（或调用失败）时降级为复制链接，保证入口永不空转。
	 */
	async function shareViaSystem(params: {
		title: string
		url: string
	}): Promise<ShareViaSystemResult> {
		const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> }
		if (typeof nav.share !== 'function') {
			try {
				await copyLink(params.url)
				return 'copied'
			} catch {
				return 'failed'
			}
		}
		try {
			// 同步阶段调用：await 只等结果，不推迟 share() 本身
			await nav.share({ title: params.title, text: params.title, url: params.url })
			return 'shared'
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled'
			try {
				await copyLink(params.url)
				return 'copied'
			} catch {
				return 'failed'
			}
		}
	}

	return {
		loading,
		qrDataUrl,
		upload,
		copyLink,
		showQr,
		showWeChat,
		openOffline,
		toImage,
		shareViaSystem,
	}
}

/** 离线模式：把图片 url 预抓为 data: URI（带鉴权）；失败降级为空串（占位，不崩页）。 */
async function prepareOfflineTurns(turns: ShareTurn[]): Promise<ShareTurn[]> {
	return Promise.all(
		turns.map(async (t) => {
			const parts = t.parts ? await Promise.all(t.parts.map(inlineImagePart)) : undefined
			const attachments = t.attachments
				? await Promise.all(t.attachments.map(inlineAttachment))
				: undefined
			return { ...t, parts, attachments }
		}),
	)
}

type ShareAttachment = NonNullable<ShareTurn['attachments']>[number]

async function inlineAttachment(a: ShareAttachment): Promise<ShareAttachment> {
	if (a.kind !== 'image' || !a.url || a.url.startsWith('data:')) return a
	try {
		const token = localStorage.getItem('token')
		const res = await fetch(a.url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
		if (!res.ok) return { ...a, url: '', thumbUrl: a.url }
		const blob = await res.blob()
		const dataUrl = await blobToDataUrl(blob)
		return { ...a, url: dataUrl }
	} catch {
		// 外链图（CDN 无 CORS）抓不到 ⇒ 清空 url 让模板渲染占位卡，
		// thumbUrl 保留原地址作为「在线查看」入口。绝不能保留外链 <img>：
		// html-to-image 会因此抛错/污染 canvas，生成图片整条链路静默失败。
		return { ...a, url: '', thumbUrl: a.url }
	}
}

async function inlineImagePart(p: ShareTurnPart): Promise<ShareTurnPart> {
	if (p.type === 'image' && p.url && !p.url.startsWith('data:')) {
		try {
			const token = localStorage.getItem('token')
			const res = await fetch(p.url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
			if (res.ok) {
				const dataUrl = await blobToDataUrl(await res.blob())
				return { ...p, url: dataUrl }
			}
		} catch {
			/* 落到下面的占位卡降级 */
		}
		return { type: 'image', url: '', caption: p.caption, fallbackUrl: p.url }
	}
	return p
}

function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => resolve(String(reader.result))
		reader.onerror = () => reject(reader.error)
		reader.readAsDataURL(blob)
	})
}
