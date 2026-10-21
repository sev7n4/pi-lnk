import { describe, expect, it } from 'vitest'
import {
	latestUserText,
	reconcileAfterTurn,
	reconcileHistory,
	stripTruncationMark,
	RECONCILE_PREFIX_LEN,
	type TailEntry,
} from './history-reconciliation'

/** 造一条 pi 侧 transcriptTail 的 user 消息。 */
function userEntry(text: string, seq = 1): TailEntry {
	return { seq, id: `e${seq}`, type: 'message', role: 'user', text }
}

/** 造一条 assistant 消息。 */
function assistantEntry(text: string, seq = 2): TailEntry {
	return { seq, id: `e${seq}`, type: 'message', role: 'assistant', text }
}

describe('latestUserText（取窗口内最近一条 user 消息）', () => {
	it('取最近的那条（不是最旧的）', () => {
		const tail = [userEntry('第一条', 1), assistantEntry('中间', 2), userEntry('第二条', 3)]
		expect(latestUserText(tail)).toBe('第二条')
	})

	it('跳过 assistant 与非 message 条目', () => {
		const tail = [
			{ seq: 0, id: 'c1', type: 'custom' },
			assistantEntry('助手说话', 1),
			userEntry('用户说话', 2),
		]
		expect(latestUserText(tail)).toBe('用户说话')
	})

	it('空窗口 ⇒ undefined', () => {
		expect(latestUserText([])).toBeUndefined()
	})

	it('只有 assistant ⇒ undefined', () => {
		expect(latestUserText([assistantEntry('x')])).toBeUndefined()
	})
})

describe('stripTruncationMark（去 pi 侧截断尾标）', () => {
	it('去掉尾部 …', () => {
		expect(stripTruncationMark('abc…')).toBe('abc')
	})

	it('无 … 不动', () => {
		expect(stripTruncationMark('abc')).toBe('abc')
	})
})

describe('reconcileHistory（对账判据）', () => {
	it('两侧一致 ⇒ aligned', () => {
		const r = reconcileHistory({
			nestUserMessage: { id: 'm1', content: '让他们抱在一起', createdAt: 1 },
			tail: [userEntry('让他们抱在一起', 1), assistantEntry('好的', 2)],
		})
		expect(r.verdict).toBe('aligned')
	})

	it('⭐ 生产事故形态：Nest 有「让他们抱在一起」、pi 侧窗口内只有更早的 user 消息 ⇒ diverged', () => {
		// 这是 2026-10-21 事故的真实形态：Nest 有那条 user 消息，pi 侧**整轮不存在**
		// ⇒ pi 侧 tail 里只有更早的轮次 ⇒ 最近一条对不上 ⇒ 分叉。
		const r = reconcileHistory({
			nestUserMessage: { id: 'm-new', content: '让他们抱在一起', createdAt: 2 },
			tail: [userEntry('先出章鱼的静帧图', 1), assistantEntry('好的', 2)],
		})
		expect(r.verdict).toBe('diverged')
		expect(r.detail?.nestMessageId).toBe('m-new')
		expect(r.detail?.nestPrefix).toBe('让他们抱在一起')
		expect(r.detail?.reason).toBeTruthy()
	})

	it('⭐ pi 侧窗口内无 user 消息 ⇒ insufficient_window（不误报分叉）', () => {
		// 窗口（16 条）滑过去了 ≠ 分叉 ⇒ 宁可漏报不可误报（误报会触发自愈副作用）
		const r = reconcileHistory({
			nestUserMessage: { id: 'm1', content: '让他们抱在一起', createdAt: 1 },
			tail: Array.from({ length: 16 }, (_, i) => assistantEntry(`助手 ${i}`, i)),
		})
		expect(r.verdict).toBe('insufficient_window')
	})

	it('Nest 侧无 user 消息 ⇒ aligned（无可分叉之物）', () => {
		const r = reconcileHistory({ nestUserMessage: undefined, tail: [userEntry('x', 1)] })
		expect(r.verdict).toBe('aligned')
	})

	it('⭐ pi 侧文本被截断到 400 字 ⇒ 前缀比对仍判 aligned（不假红）', () => {
		// pi 侧 text 是 `SNAPSHOT_TEXT_LIMIT=400` 截断的 ⇒ 与 Nest 全文不等是正常的
		const long = 'A'.repeat(600)
		const piTruncated = `${'A'.repeat(400)}…`
		const r = reconcileHistory({
			nestUserMessage: { id: 'm1', content: long, createdAt: 1 },
			tail: [userEntry(piTruncated, 1)],
		})
		expect(r.verdict).toBe('aligned')
	})

	it('⭐ 截断恰好在比对长度边界 ⇒ 仍 aligned（去尾标后取较短者比对）', () => {
		const exact = 'B'.repeat(RECONCILE_PREFIX_LEN)
		const r = reconcileHistory({
			nestUserMessage: { id: 'm1', content: exact, createdAt: 1 },
			tail: [userEntry(`${exact}…`, 1)],
		})
		expect(r.verdict).toBe('aligned')
	})

	it('内容不同 ⇒ diverged（不是仅仅长度不同）', () => {
		const r = reconcileHistory({
			nestUserMessage: { id: 'm1', content: '让他们抱在一起', createdAt: 1 },
			tail: [userEntry('让他们分开', 1)],
		})
		expect(r.verdict).toBe('diverged')
		expect(r.detail?.piText).toBe('让他们分开')
	})

	it('Nest 消息更短时按较短者比对（不因 pi 侧更长而假红）', () => {
		const r = reconcileHistory({
			nestUserMessage: { id: 'm1', content: '继续', createdAt: 1 },
			tail: [userEntry('继续做刚才那件事', 1)],
		})
		expect(r.verdict).toBe('aligned')
	})

	it('⭐ 长消息且尾部不同 ⇒ diverged（防「宽松包含」把分叉判成一致）', () => {
		// ⭐ 这个用例是**变异测试逼出来的**：原有用例都是短消息（< 20 字）⇒
		// 「严格前缀比对」与「宽松 includes」**行为等价** ⇒ 测不出判据被放宽。
		// ⇒ 必须用「长消息 + 只有尾部不同」才能区分：
		//   严格：前 200 字逐字比 ⇒ 尾部不同 ⇒ diverged ✓
		//   宽松：pi.includes(nest 前 20 字) ⇒ true ⇒ aligned ✗（漏报分叉）
		const head = 'A'.repeat(150)
		const nest = `${head}DIFFERENT_TAIL`
		const pi = `${head}OTHER_TAIL`
		const r = reconcileHistory({
			nestUserMessage: { id: 'm1', content: nest, createdAt: 1 },
			tail: [userEntry(pi, 1)],
		})
		expect(r.verdict).toBe('diverged')
	})

	it('⭐ 长消息且尾部不同、但前 200 字相同 ⇒ aligned（截断场景不误报）', () => {
		// 与上条对照：前 200 字相同（pi 侧被 400 字截断，尾部本来就可能不同）
		// ⇒ 应判 aligned（截断不是分叉）。
		const head = 'B'.repeat(200)
		const nest = `${head}TAIL_A`
		const pi = `${head}TAIL_B`
		const r = reconcileHistory({
			nestUserMessage: { id: 'm1', content: nest, createdAt: 1 },
			tail: [userEntry(pi, 1)],
		})
		expect(r.verdict).toBe('aligned')
	})

	it('首尾空白不影响判定', () => {
		const r = reconcileHistory({
			nestUserMessage: { id: 'm1', content: '  让他们抱在一起  ', createdAt: 1 },
			tail: [userEntry(' 让他们抱在一起 ', 1)],
		})
		expect(r.verdict).toBe('aligned')
	})
})

// ── 编排层（IO）────────────────────────────────────────────────────────────

/** 造一个最小 prisma 假件。 */
function makePrisma(messages: Array<{ id: string; content: string; createdAt?: Date }>) {
	return {
		agentMessage: {
			findMany: async () =>
				messages.map((m) => ({
					id: m.id,
					content: m.content,
					createdAt: m.createdAt ?? new Date(1_700_000_000_000),
				})),
		},
	}
}

/** 造一个最小 client 假件。 */
function makeClient(tail: TailEntry[] | undefined) {
	return { snapshot: async () => (tail === undefined ? undefined : { transcriptTail: tail }) }
}

/** 造一个记录写入的 turnState 假件。 */
function makeTurnState() {
	const records: Array<Record<string, unknown>> = []
	return {
		records,
		store: {
			record: async (input: Record<string, unknown>) => {
				records.push(input)
				return true
			},
		},
	}
}

const logger = { warn: () => undefined }

describe('reconcileAfterTurn（编排：读 Nest → 调 snapshot → 比对 → 自愈）', () => {
	it('⭐ 分叉 ⇒ 告警 + 自愈（写入 turn_state，含 Nest 那条 user 消息）', async () => {
		const prisma = makePrisma([{ id: 'm1', content: '让他们抱在一起' }])
		const client = makeClient([userEntry('先出章鱼的静帧图', 1), assistantEntry('好的', 2)])
		const ts = makeTurnState()
		const warns: string[] = []

		const out = await reconcileAfterTurn({
			prisma: prisma as never,
			client: client as never,
			turnState: ts.store as never,
			threadId: 't1',
			sessionKey: 'k1',
			logger: { warn: (m: string) => warns.push(m) },
		})

		expect(out.verdict).toBe('diverged')
		expect(out.healed).toBe(true)
		expect(out.nestMessageId).toBe('m1')
		// 自愈内容：Nest 那条 user 消息（模型下一轮就看得见）
		expect(ts.records).toHaveLength(1)
		expect(ts.records[0].userText).toBe('让他们抱在一起')
		expect(ts.records[0].userMessageId).toBe('m1')
		expect(ts.records[0].threadId).toBe('k1')
		// 告警两条（分叉 + 已自愈）
		expect(warns.some((w) => w.includes('history_diverged'))).toBe(true)
		expect(warns.some((w) => w.includes('history_reconcile healed'))).toBe(true)
	})

	it('一致 ⇒ 不告警不写状态', async () => {
		const prisma = makePrisma([{ id: 'm1', content: '让他们抱在一起' }])
		const client = makeClient([userEntry('让他们抱在一起', 1)])
		const ts = makeTurnState()
		const warns: string[] = []

		const out = await reconcileAfterTurn({
			prisma: prisma as never,
			client: client as never,
			turnState: ts.store as never,
			threadId: 't1',
			sessionKey: 'k1',
			logger: { warn: (m: string) => warns.push(m) },
		})

		expect(out.verdict).toBe('aligned')
		expect(out.healed).toBe(false)
		expect(ts.records).toHaveLength(0)
		expect(warns.filter((w) => w.includes('history_diverged'))).toHaveLength(0)
	})

	it('窗口不足 ⇒ 不写状态（不误报自愈）', async () => {
		const prisma = makePrisma([{ id: 'm1', content: '让他们抱在一起' }])
		const client = makeClient(Array.from({ length: 16 }, (_, i) => assistantEntry(`a${i}`, i)))
		const ts = makeTurnState()

		const out = await reconcileAfterTurn({
			prisma: prisma as never,
			client: client as never,
			turnState: ts.store as never,
			threadId: 't1',
			sessionKey: 'k1',
			logger,
		})

		expect(out.verdict).toBe('insufficient_window')
		expect(out.healed).toBe(false)
		expect(ts.records).toHaveLength(0)
	})

	it('Nest 侧无 user 消息 ⇒ aligned 且不调 snapshot', async () => {
		let snapshotCalled = false
		const client = {
			snapshot: async () => {
				snapshotCalled = true
				return { transcriptTail: [] }
			},
		}
		const out = await reconcileAfterTurn({
			prisma: makePrisma([]) as never,
			client: client as never,
			threadId: 't1',
			sessionKey: 'k1',
			logger,
		})
		expect(out.verdict).toBe('aligned')
		expect(snapshotCalled).toBe(false)
	})

	it('⛔ snapshot 取不到 ⇒ 不判定、不写状态（不抛错）', async () => {
		const ts = makeTurnState()
		const out = await reconcileAfterTurn({
			prisma: makePrisma([{ id: 'm1', content: 'x' }]) as never,
			client: makeClient(undefined) as never,
			turnState: ts.store as never,
			threadId: 't1',
			sessionKey: 'k1',
			logger,
		})
		expect(out.verdict).toBe('insufficient_window')
		expect(ts.records).toHaveLength(0)
	})

	it('⛔ prisma 抛错 ⇒ fail-soft（返回、不抛出、不写状态）', async () => {
		const prisma = {
			agentMessage: {
				findMany: async () => {
					throw new Error('db down')
				},
			},
		}
		const ts = makeTurnState()
		const warns: string[] = []
		const out = await reconcileAfterTurn({
			prisma: prisma as never,
			client: makeClient([]) as never,
			turnState: ts.store as never,
			threadId: 't1',
			sessionKey: 'k1',
			logger: { warn: (m: string) => warns.push(m) },
		})
		expect(out.verdict).toBe('insufficient_window')
		expect(ts.records).toHaveLength(0)
		expect(warns.some((w) => w.includes('history_reconcile failed'))).toBe(true)
	})

	it('⛔ 无 turnState 存储（未装配）⇒ 分叉仍告警但不自愈（不崩）', async () => {
		const warns: string[] = []
		const out = await reconcileAfterTurn({
			prisma: makePrisma([{ id: 'm1', content: '让他们抱在一起' }]) as never,
			client: makeClient([userEntry('别的内容', 1)]) as never,
			threadId: 't1',
			sessionKey: 'k1',
			logger: { warn: (m: string) => warns.push(m) },
		})
		expect(out.verdict).toBe('diverged')
		expect(out.healed).toBe(false)
		expect(warns.some((w) => w.includes('history_diverged'))).toBe(true)
	})
})
