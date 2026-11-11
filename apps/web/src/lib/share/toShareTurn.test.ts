import { describe, it, expect } from 'vitest'
import type { AgentStreamMessage } from '@/stores/agent'
import type { TurnTimeline } from '@/components/agent/turnTimeline'
import type { ShareTurnPart } from '@lnkpi/shared/shareTemplate'
import { toShareTurn } from './toShareTurn'

function msgWithTimeline(parts: TurnTimeline['parts']): AgentStreamMessage {
	return {
		id: 'm1',
		role: 'assistant',
		content: '正文兜底',
		timeline: { parts, turnStartedAt: 0, pendingNodeMeta: {} },
	}
}

const ofType = (parts: ShareTurnPart[] | undefined, type: ShareTurnPart['type']) =>
	parts?.filter((p) => p.type === type) ?? []

describe('toShareTurn · 产品时间线 8 类 part 逐类保真', () => {
	it('text / thinking / tool / artifact(image) / notice 各有对应 part', () => {
		const msg = msgWithTimeline([
			{ kind: 'text', id: 't1', text: '正文\n第二段', status: 'done' },
			{ kind: 'thinking', id: 'th1', text: '想了想', status: 'done', startedAt: 0, endedAt: 1 },
			{ kind: 'tool', id: 'tool1', toolName: 'search', args: 'q', resultSummary: '命中 3 条', status: 'done', ms: 1200 },
			{ kind: 'artifact', id: 'a1', nodeId: 'n1', nodeType: 'image', title: '图', status: 'done', url: 'https://x/i.png' },
			{ kind: 'notice', id: 'n1', text: '注意点', tone: 'warn', detail: 'token 明细' },
		])

		const { parts } = toShareTurn(msg)
		expect(ofType(parts, 'text')[0]).toMatchObject({ type: 'text', text: '正文\n第二段' })
		expect(ofType(parts, 'thinking')[0]).toMatchObject({ type: 'thinking', done: true })
		expect(ofType(parts, 'tool')[0]).toMatchObject({
			type: 'tool', name: 'search', result: '命中 3 条', status: 'done', ms: 1200,
		})
		// 工具 args 不再当正文塞进快照
		expect(JSON.stringify(parts)).not.toContain('"args"')
		expect(ofType(parts, 'image')[0]).toMatchObject({ type: 'image', url: 'https://x/i.png', caption: '图' })
		expect(ofType(parts, 'notice')[0]).toMatchObject({
			type: 'notice', text: '注意点', tone: 'warn', detail: 'token 明细',
		})
		// notice 不再被压成普通 text（旧实现会让 warn/error 失去语义）
		expect(ofType(parts, 'text').some((p) => p.type === 'text' && p.text === '注意点')).toBe(false)
	})

	it('thinking running → done:false（模板据此默认展开）', () => {
		const { parts } = toShareTurn(msgWithTimeline([
			{ kind: 'thinking', id: 'th', text: '思考中', status: 'running', startedAt: 0 },
		]))
		expect(ofType(parts, 'thinking')[0]).toMatchObject({ done: false })
	})

	it('tool 失败态传 isError/status，不丢红色标记', () => {
		const { parts } = toShareTurn(msgWithTimeline([
			{ kind: 'tool', id: 't', toolName: 'gen', status: 'failed', isError: true, resultSummary: '超时' },
		]))
		expect(ofType(parts, 'tool')[0]).toMatchObject({ status: 'failed', isError: true })
	})

	// D1（2026-11-11）：产品时间线新增 interrupted 后，分享快照必须原样透传，
	// 否则公开页会把「子代理没回来」渲染成无状态（等价于「没什么问题」）。
	it('★ D1 回归锁：tool interrupted 状态透传到分享快照，不塌成 done/running', () => {
		const { parts } = toShareTurn(msgWithTimeline([
			{
				kind: 'tool', id: 't', toolName: 'spawn_subagent', args: '调研 X',
				status: 'interrupted', ms: 0,
			},
		]))
		expect(ofType(parts, 'tool')[0]).toMatchObject({
			type: 'tool', name: 'spawn_subagent', status: 'interrupted',
		})
		expect(ofType(parts, 'tool')[0]).not.toMatchObject({ status: 'done' })
		expect(JSON.stringify(parts)).not.toContain('"args"')
	})

	it('notice tone: error 与 info 都不丢', () => {
		const { parts } = toShareTurn(msgWithTimeline([
			{ kind: 'notice', id: 'n', text: '出错', tone: 'error' },
			{ kind: 'notice', id: 'n2', text: '说明', tone: 'info' },
		]))
		expect(ofType(parts, 'notice').map((p) => p.type === 'notice' && p.tone)).toEqual(['error', 'info'])
	})

	it('canvas 保留 label + nodeId（旧实现只剩一行文本）', () => {
		const { parts } = toShareTurn(msgWithTimeline([
			{ kind: 'canvas', id: 'c', label: '新建 4 个节点', nodeId: 'node-1' },
		]))
		expect(ofType(parts, 'canvas')[0]).toMatchObject({ type: 'canvas', label: '新建 4 个节点', nodeId: 'node-1' })
	})

	it('artifact 按 nodeType 分流：video / audio / image / 其他', () => {
		const { parts } = toShareTurn(msgWithTimeline([
			{ kind: 'artifact', id: 'a1', nodeId: 'n1', nodeType: 'video', title: '片', status: 'done', url: 'https://x/v.mp4' },
			{ kind: 'artifact', id: 'a2', nodeId: 'n2', nodeType: 'audio', title: '声', status: 'done', url: 'https://x/a.mp3' },
			{ kind: 'artifact', id: 'a3', nodeId: 'n3', nodeType: 'image', title: '图', status: 'done', url: 'https://x/i.png' },
			{ kind: 'artifact', id: 'a4', nodeId: 'n4', nodeType: 'text', title: '文案', status: 'done', url: 'https://x/t.txt' },
		]))
		expect(ofType(parts, 'video')).toHaveLength(1)
		expect(ofType(parts, 'audio')).toHaveLength(1)
		expect(ofType(parts, 'image')).toHaveLength(1)
		// text/html 节点不再伪装成破图
		expect(ofType(parts, 'artifact')[0]).toMatchObject({ nodeType: 'text', title: '文案', status: 'done' })
		expect(JSON.stringify(parts)).not.toContain('"caption":"文案"')
	})

	it('artifact 未完成/失败：保住状态与 errorText，不塌成一行「产物：X」', () => {
		const { parts } = toShareTurn(msgWithTimeline([
			{ kind: 'artifact', id: 'a', nodeId: 'n', nodeType: 'image', title: '海报', status: 'failed', errorText: '余额不足' },
		]))
		expect(ofType(parts, 'artifact')[0]).toMatchObject({
			type: 'artifact', title: '海报', status: 'failed', errorText: '余额不足',
		})
		expect(ofType(parts, 'text').some((p) => p.type === 'text' && p.text.includes('产物：'))).toBe(false)
	})

	it('proposal 静态快照：标题 + 终态，不带可点按钮所需字段', () => {
		const { parts } = toShareTurn(msgWithTimeline([
			{ kind: 'proposal', id: 'p', toolName: 'propose_generation', title: '生成 4 张海报', status: 'confirmed', startedAt: 0 },
		]))
		expect(ofType(parts, 'proposal')[0]).toMatchObject({
			type: 'proposal', title: '生成 4 张海报', status: 'confirmed',
		})
	})

	it('question 静态快照：题目 + 选项 + 多选/其他标记', () => {
		const { parts } = toShareTurn(msgWithTimeline([
			{
				kind: 'question', id: 'q1', title: '确认风格', status: 'answered', startedAt: 0,
				questions: [{
					id: 'q', question: '选哪种？', multiSelect: true, allowOther: true,
					options: [{ label: '写实', value: 'real' }, { label: '插画', value: 'illu' }],
				}],
			},
		]))
		expect(ofType(parts, 'question')[0]).toMatchObject({
			type: 'question', title: '确认风格', status: 'answered',
			questions: [{ question: '选哪种？', options: ['写实', '插画'], multiSelect: true, allowOther: true }],
		})
	})

	it('delivery 只收 done artifact，顺序与事件到达序一致', () => {
		const { delivery } = toShareTurn(msgWithTimeline([
			{ kind: 'artifact', id: 'a1', nodeId: 'n1', nodeType: 'image', title: '图一', status: 'done', url: 'https://x/1.png' },
			{ kind: 'artifact', id: 'a2', nodeId: 'n2', nodeType: 'image', title: '失败', status: 'failed' },
			{ kind: 'artifact', id: 'a3', nodeId: 'n3', nodeType: 'image', title: '图二', status: 'done', url: 'https://x/2.png' },
		]))
		expect(delivery?.map((d) => d.title)).toEqual(['图一', '图二'])
	})

	it('无 timeline 时退化为正文 contentText + text part', () => {
		const msg: AgentStreamMessage = { id: 'm2', role: 'user', content: '用户输入' }
		const turn = toShareTurn(msg)
		expect(turn.contentText).toBe('用户输入')
		expect(turn.parts?.[0]).toEqual({ type: 'text', text: '用户输入' })
	})

	it('attachments 按 mediaType 映射 kind（模板与 parts 合并渲染）', () => {
		const msg: AgentStreamMessage = {
			id: 'm3', role: 'user', content: 'x',
			attachments: [
				{ id: 'a', mediaType: 'image', sourceKind: 'upload', label: '图', url: 'https://x/a.png' },
				{ id: 'b', mediaType: 'video', sourceKind: 'upload', label: '片', url: 'https://x/b.mp4' },
				{ id: 'c', mediaType: 'audio', sourceKind: 'asset', label: '声', url: 'https://x/c.mp3' },
			],
		}
		expect(toShareTurn(msg).attachments).toEqual([
			{ kind: 'image', url: 'https://x/a.png', thumbUrl: 'https://x/a.png' },
			{ kind: 'video', url: 'https://x/b.mp4', thumbUrl: 'https://x/b.mp4' },
			{ kind: 'file', url: 'https://x/c.mp3', thumbUrl: 'https://x/c.mp3' },
		])
	})

	it('createdAt 取消息真实时间，非法值才回退', () => {
		expect(toShareTurn({ id: 'x', role: 'user', content: '', createdAt: 1762300000000 }).createdAt).toBe(1762300000000)
		expect(toShareTurn({ id: 'x', role: 'user', content: '', createdAt: '2026-11-05T01:00:00Z' }).createdAt).toBe(Date.parse('2026-11-05T01:00:00Z'))
	})
})
