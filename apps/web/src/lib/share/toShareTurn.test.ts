import { describe, it, expect } from 'vitest'
import type { AgentStreamMessage } from '@/stores/agent'
import type { TurnTimeline } from '@/components/agent/turnTimeline'
import { toShareTurn } from './toShareTurn'

function msgWithTimeline(parts: TurnTimeline['parts']): AgentStreamMessage {
	return {
		id: 'm1',
		role: 'assistant',
		content: '正文兜底',
		timeline: { parts, turnStartedAt: 0, pendingNodeMeta: {} },
	}
}

describe('toShareTurn', () => {
	it('timeline parts → 结构化 ShareTurnPart（text/thinking/tool/artifact/notice）', () => {
		const msg = msgWithTimeline([
			{ kind: 'text', id: 't1', text: '正文', status: 'done' },
			{ kind: 'thinking', id: 'th1', text: '想了想', status: 'done', startedAt: 0, endedAt: 1 },
			{ kind: 'tool', id: 'tool1', toolName: 'search', args: 'q', status: 'done' },
			{ kind: 'artifact', id: 'a1', nodeId: 'n1', nodeType: 'image', title: '图', status: 'done', url: 'https://x/i.png' },
			{ kind: 'notice', id: 'n1', text: '注意点', tone: 'info' },
		])

		const turn = toShareTurn(msg)
		expect(turn.id).toBe('m1')
		expect(turn.role).toBe('assistant')

		const texts = turn.parts?.filter((p) => p.type === 'text') ?? []
		expect(texts.some((p) => p.type === 'text' && p.text === '正文')).toBe(true)
		expect(texts.some((p) => p.type === 'text' && p.text === '注意点')).toBe(true)

		const thinking = turn.parts?.find((p) => p.type === 'thinking')
		expect(thinking).toBeTruthy()
		if (thinking && thinking.type === 'thinking') expect(thinking.done).toBe(true)

		const tool = turn.parts?.find((p) => p.type === 'tool')
		expect(tool).toBeTruthy()
		if (tool && tool.type === 'tool') expect(tool.name).toBe('search')

		const img = turn.parts?.find((p) => p.type === 'image')
		expect(img).toBeTruthy()
		if (img && img.type === 'image') expect(img.url).toBe('https://x/i.png')
	})

	it('无 timeline 时退化为正文 contentText + text part', () => {
		const msg: AgentStreamMessage = { id: 'm2', role: 'user', content: '用户输入' }
		const turn = toShareTurn(msg)
		expect(turn.contentText).toBe('用户输入')
		expect(turn.parts?.[0]).toEqual({ type: 'text', text: '用户输入' })
	})

	it('video 类 artifact 映射为 video part', () => {
		const msg = msgWithTimeline([
			{ kind: 'artifact', id: 'a2', nodeId: 'n2', nodeType: 'video', title: '片', status: 'done', url: 'https://x/v.mp4' },
		])
		const turn = toShareTurn(msg)
		const vid = turn.parts?.find((p) => p.type === 'video')
		expect(vid).toBeTruthy()
		if (vid && vid.type === 'video') expect(vid.url).toBe('https://x/v.mp4')
	})

	it('attachments 按 mediaType 映射 kind', () => {
		const msg: AgentStreamMessage = {
			id: 'm3',
			role: 'user',
			content: 'x',
			attachments: [
				{ id: 'a', mediaType: 'image', sourceKind: 'upload', label: '图', url: 'https://x/a.png' },
				{ id: 'b', mediaType: 'video', sourceKind: 'upload', label: '片', url: 'https://x/b.mp4' },
				{ id: 'c', mediaType: 'audio', sourceKind: 'asset', label: '声', url: 'https://x/c.mp3' },
			],
		}
		const turn = toShareTurn(msg)
		expect(turn.attachments).toEqual([
			{ kind: 'image', url: 'https://x/a.png', thumbUrl: 'https://x/a.png' },
			{ kind: 'video', url: 'https://x/b.mp4', thumbUrl: 'https://x/b.mp4' },
			{ kind: 'file', url: 'https://x/c.mp3', thumbUrl: 'https://x/c.mp3' },
		])
	})
})
