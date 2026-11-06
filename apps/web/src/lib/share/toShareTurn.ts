/**
 * 消息 → 分享回合 映射器（跨端单源：web 回合级 / 会话级入口共用）。
 *
 * 把 `AgentStreamMessage`（pi-lnk 内部对话模型）抽成 `ShareTurn`（分享模板消费的结构化模型）。
 * 优先用 `msg.timeline.parts`（有序时间线唯一真相）**逐类**映射 8 种 part：
 * text / thinking / tool / canvas / artifact / notice / proposal / question。
 * 无 timeline（flag 关闭 / 旧数据）时退化为 `msg.content` + `msg.attachments`。
 *
 * ⚠️ 交互态只做**静态快照**：proposal / question 保留题面、选项、终态，
 * 不搬按钮与确认逻辑（离线页零 JS，可点按钮 = 死交互）。
 * ⚠️ agent HTML 产物（node 正文）需异步 `get_node` 取全文，本期以 artifact 卡保留
 * 标题/状态；mermaid/node_graph 的 SVG 同理，模板已有渲染器但当前无生产者。
 */
import type { AgentStreamMessage } from '@/stores/agent'
import type { ShareTurn, ShareTurnPart, ShareDeliveryItem } from '@lnkpi/shared/shareTemplate'
import type { SidebarAttachment } from '@lnkpi/shared'

const VIDEO_NODE_TYPES = new Set(['video', 'mp4', 'movie', 'animation'])
const AUDIO_NODE_TYPES = new Set(['audio', 'mp3', 'music', 'voice', 'tts', 'speech'])
const IMAGE_NODE_TYPES = new Set(['image', 'img', 'picture', 'photo', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'])
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|#|$)/i
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac)(\?|#|$)/i
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|svg|avif|heic)(\?|#|$)/i

type TimelinePart = NonNullable<AgentStreamMessage['timeline']>['parts'][number]
type ArtifactPart = Extract<TimelinePart, { kind: 'artifact' }>

function isVideoArtifact(p: ArtifactPart): boolean {
	return VIDEO_NODE_TYPES.has(p.nodeType.toLowerCase()) || VIDEO_EXT.test(p.url ?? '')
}

function isAudioArtifact(p: ArtifactPart): boolean {
	return AUDIO_NODE_TYPES.has(p.nodeType.toLowerCase()) || AUDIO_EXT.test(p.url ?? '')
}

function isImageArtifact(p: ArtifactPart): boolean {
	return IMAGE_NODE_TYPES.has(p.nodeType.toLowerCase()) || IMAGE_EXT.test(p.url ?? '')
}

function mapTimelinePart(p: TimelinePart): ShareTurnPart | null {
	switch (p.kind) {
		case 'text':
			return p.text.trim() ? { type: 'text', text: p.text } : null
		case 'thinking':
			return p.text.trim() ? { type: 'thinking', text: p.text, done: p.status === 'done' } : null
		case 'tool':
			// 产品时间线只展示 resultSummary + 状态/耗时，args 不进快照（避免把内部参数当正文）
			return {
				type: 'tool',
				name: p.toolName,
				result: p.resultSummary,
				isError: p.isError,
				status: p.status,
				ms: p.ms,
			}
		case 'artifact': {
			if (p.status === 'done' && p.url) {
				if (isVideoArtifact(p)) return { type: 'video', url: p.url, title: p.title }
				if (isAudioArtifact(p)) return { type: 'audio', url: p.url, title: p.title }
				if (isImageArtifact(p)) return { type: 'image', url: p.url, caption: p.title }
				// text / html / mermaid 等节点：不伪装成 <img>（旧实现会产出破图）
			}
			// 未完成 / 无 url：保住标题、状态、失败原因，不再塌成一行「产物：X（done）」
			return {
				type: 'artifact',
				nodeType: p.nodeType,
				title: p.title,
				status: p.status,
				url: p.url,
				errorText: p.errorText,
			}
		}
		case 'notice':
			return p.text.trim()
				? { type: 'notice', text: p.text, tone: p.tone, detail: p.detail }
				: null
		case 'canvas':
			return p.label ? { type: 'canvas', label: p.label, nodeId: p.nodeId } : null
		case 'proposal':
			return { type: 'proposal', title: p.title, status: p.status }
		case 'question':
			return {
				type: 'question',
				title: p.title,
				status: p.status,
				questions: p.questions.map((q) => ({
					question: q.question,
					options: q.options.map((o) => o.label),
					multiSelect: q.multiSelect,
					allowOther: q.allowOther,
				})),
			}
		default:
			return null
	}
}

/** 回合末交付摘要（与 AgentTurnTimeline 的 turnDeliveryItems 同源：done 的 artifact）。 */
function deriveDelivery(parts: readonly TimelinePart[] | undefined): ShareDeliveryItem[] {
	if (!parts?.length) return []
	return parts
		.filter((p): p is ArtifactPart => p.kind === 'artifact' && p.status === 'done')
		.map((p) => ({ title: p.title, nodeType: p.nodeType, url: p.url }))
}

function mapAttachment(a: SidebarAttachment): { kind: 'image' | 'video' | 'file'; url: string; thumbUrl?: string } {
	const kind: 'image' | 'video' | 'file' =
		a.mediaType === 'image' ? 'image' : a.mediaType === 'video' ? 'video' : 'file'
	return { kind, url: a.url ?? '', thumbUrl: a.url }
}

export function toShareTurn(msg: AgentStreamMessage, _sessionId?: string): ShareTurn {
	const parts: ShareTurnPart[] = []

	if (msg.timeline?.parts?.length) {
		for (const p of msg.timeline.parts) {
			const mapped = mapTimelinePart(p)
			if (mapped) parts.push(mapped)
		}
	}

	// 兜底：无结构化 parts 时用正文
	if (parts.length === 0 && msg.content) {
		parts.push({ type: 'text', text: msg.content })
	}

	const attachments = msg.attachments?.map(mapAttachment)
	const attachmentField = attachments && attachments.length ? attachments : undefined

	return {
		id: msg.id,
		role: msg.role,
		contentText: msg.content,
		parts,
		createdAt: normalizeCreatedAt((msg as { createdAt?: string | number }).createdAt),
		attachments: attachmentField,
		delivery: deriveDelivery(msg.timeline?.parts),
	}
}

/**
 * 取消息真实时间：优先用服务端下发的 `createdAt`（历史消息），
 * 缺省/非法时回退到 `Date.now()`（仅本地刚发出、尚未回写的实时消息）。
 * 之前写死 `Date.now()` 会导致所有分享消息都显示「分享那一刻」而非消息时刻（#6）。
 */
function normalizeCreatedAt(raw: string | number | undefined): number {
	if (typeof raw === 'number' && !Number.isNaN(raw)) return raw
	if (typeof raw === 'string' && raw.trim()) {
		const t = Date.parse(raw)
		if (!Number.isNaN(t)) return t
	}
	return Date.now()
}
