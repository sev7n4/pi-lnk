/**
 * 消息 → 分享回合 映射器（跨端单源：web 回合级 / 会话级入口共用）。
 *
 * 把 `AgentStreamMessage`（pi-lnk 内部对话模型）抽成 `ShareTurn`（分享模板消费的结构化模型）。
 * 优先用 `msg.timeline.parts`（有序时间线唯一真相）映射 text/thinking/tool/artifact(图片·视频)/
 * notice；无 timeline（flag 关闭 / 旧数据）时退化为 `msg.content` + `msg.attachments`。
 *
 * ⚠️ 范围：本期只抽「文本类 + 图片/视频产物 + 工具调用 + 思考」。agent HTML 产物（node 正文）
 * 需异步 `get_node` 取全文，留给调用方在打开面板前 `resolveArtifactContents(turns)` 补全
 * （见规格 §5.2 / 计划 Task 5 Step 1 接口约定）。mermaid/node_graph 的 SVG 同理走运行时字段提取。
 */
import type { AgentStreamMessage } from '@/stores/agent'
import type { ShareTurn, ShareTurnPart } from '@lnkpi/shared/shareTemplate'
import type { SidebarAttachment } from '@lnkpi/shared'

const VIDEO_NODE_TYPES = new Set(['video', 'mp4', 'movie', 'animation'])

function mapTimelinePart(p: NonNullable<AgentStreamMessage['timeline']>['parts'][number]): ShareTurnPart | null {
	switch (p.kind) {
		case 'text':
			return p.text.trim() ? { type: 'text', text: p.text } : null
		case 'thinking':
			return p.text.trim() ? { type: 'thinking', text: p.text, done: p.status === 'done' } : null
		case 'tool':
			return {
				type: 'tool',
				name: p.toolName,
				args: p.args,
				result: p.resultSummary,
				isError: p.isError,
			}
		case 'artifact': {
			if (p.status === 'done' && p.url) {
				if (VIDEO_NODE_TYPES.has(p.nodeType.toLowerCase())) {
					return { type: 'video', url: p.url, title: p.title }
				}
				return { type: 'image', url: p.url, caption: p.title }
			}
			if (p.title) return { type: 'text', text: `产物：${p.title}（${p.status}）` }
			return null
		}
		case 'notice':
			return p.text.trim() ? { type: 'text', text: p.text } : null
		case 'canvas':
			return p.label ? { type: 'text', text: p.label } : null
		// proposal / question 是交互态，分享快照里省略
		default:
			return null
	}
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
		createdAt: Date.now(),
		attachments: attachmentField,
	}
}
