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
	async function upload(turns: ShareTurn[], sessionId: string): Promise<ShareUploadResult> {
		loading.value = true
		try {
		const resp = await api.post('/share/conversation', { sessionId, turns })
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
	async function openOffline(turns: ShareTurn[]): Promise<void> {
		const prepared = await prepareOfflineTurns(turns)
		const html = buildShareHtml(prepared, { inlineMedia: 'offline' })
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

	/** 生成图片：模板渲染进隐藏层 → html-to-image → 返回 PNG dataURL。 */
	async function toImage(turns: ShareTurn[]): Promise<string> {
		const html = buildShareHtml(turns, { inlineMedia: 'online' })
		const el = document.createElement('div')
		el.style.position = 'fixed'
		el.style.left = '-99999px'
		el.style.top = '0'
		el.innerHTML = html
		document.body.appendChild(el)
		try {
			return await toPng(el, { width: 680, cacheBust: true })
		} finally {
			document.body.removeChild(el)
		}
	}

	return { loading, qrDataUrl, upload, copyLink, showQr, showWeChat, openOffline, toImage }
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
	if (a.kind !== 'image' || a.url.startsWith('data:')) return a
	try {
		const token = localStorage.getItem('token')
		const res = await fetch(a.url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
		if (!res.ok) return { ...a, url: '' }
		const blob = await res.blob()
		const dataUrl = await blobToDataUrl(blob)
		return { ...a, url: dataUrl }
	} catch {
		return { ...a, url: '' }
	}
}

async function inlineImagePart(p: ShareTurnPart): Promise<ShareTurnPart> {
	if (p.type === 'image' && !p.url.startsWith('data:')) {
		try {
			const token = localStorage.getItem('token')
			const res = await fetch(p.url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
			if (res.ok) {
				const dataUrl = await blobToDataUrl(await res.blob())
				return { ...p, url: dataUrl }
			}
		} catch {
			/* 降级：保留原 url（离线时显示 alt 文本） */
		}
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
