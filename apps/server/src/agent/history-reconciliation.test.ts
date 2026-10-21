import { describe, expect, it } from 'vitest'
import { QUEUE_MARK } from './pi-runtime/pi-runtime.client'
import {
	latestUserText,
	reconcileAfterTurn,
	reconcileHistory,
	stripQueueMarks,
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

describe('stripQueueMarks（剥队列消息行首 kind 标签）', () => {
	it('剥 steer 标签（含 client 拼接口径里的那个换行）', () => {
		// client 拼接口径：`QUEUE_MARK[path] + "\n" + text`（pi-runtime.client.ts:401）
		expect(stripQueueMarks(`${QUEUE_MARK.steer}\n画个乌龟`)).toBe('画个乌龟')
	})

	it('剥 followup 标签', () => {
		expect(stripQueueMarks(`${QUEUE_MARK.followup}\n继续`)).toBe('继续')
	})

	it('无标签 ⇒ 原样返回', () => {
		expect(stripQueueMarks('画个乌龟')).toBe('画个乌龟')
	})

	it('⭐ 只剥一个：用户原话自带标签时，剥完应正好等于 Nest 存的原话', () => {
		// 极端形态：用户自己打的字以 steer 标签开头，该消息又走了 steer
		// ⇒ pi 侧 = 标签 + "\n" + （标签 + 原话）；剥一个恰好回到 Nest 存的原话。
		const userSaid = `${QUEUE_MARK.steer}继续`
		expect(stripQueueMarks(`${QUEUE_MARK.steer}\n${userSaid}`)).toBe(userSaid)
	})

	it('标签在行中（不是行首）⇒ 不动', () => {
		expect(stripQueueMarks(`请${QUEUE_MARK.steer}继续`)).toBe(`请${QUEUE_MARK.steer}继续`)
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

	// ── 队列消息 kind 标签（2026-10-22 生产假阳修复）─────────────────────────
	//
	// ⭐ 生产实证：thread `cmvi3cvhk…`「画个乌龟」——12:37 用户重发（变 steer），
	// 12:49 该轮**正常完成**（assistant stopReason=stop），对账却判 `diverged`
	// 并自愈写了一条**假** turnState（interruption=history_diverged、空 steps）。
	// 根因：Nest `AgentMessage` 存**用户原话**（#542 口径），pi transcript 里同一条
	// 消息被 `QUEUE_MARK` 加了行首标签 ⇒ 前缀比对从第 0 字符就分叉。
	// ⚠️ **每次插话都会触发** ⇒ 这不是偶发，是系统性假阳。
	it('⭐ 插话（steer）：pi 侧带 kind 标签、Nest 存原话 ⇒ aligned（不假红）', () => {
		const r = reconcileHistory({
			nestUserMessage: { id: 'm1', content: '画个乌龟', createdAt: 2 },
			tail: [userEntry(`${QUEUE_MARK.steer}\n画个乌龟`, 1), assistantEntry('好的', 2)],
		})
		expect(r.verdict).toBe('aligned')
	})

	it('⭐ 尾随（followUp）同理 ⇒ aligned', () => {
		const r = reconcileHistory({
			nestUserMessage: { id: 'm1', content: '继续', createdAt: 2 },
			tail: [userEntry(`${QUEUE_MARK.followup}\n继续`, 1), assistantEntry('好的', 2)],
		})
		expect(r.verdict).toBe('aligned')
	})

	it('⭐ 剥掉标签后内容仍不同 ⇒ diverged（防「无脑剥离」把真分叉判成一致）', () => {
		const r = reconcileHistory({
			nestUserMessage: { id: 'm1', content: '画个乌龟', createdAt: 2 },
			tail: [userEntry(`${QUEUE_MARK.steer}\n画个狗`, 1)],
		})
		expect(r.verdict).toBe('diverged')
		// detail.piText 保留**原始**文本（含标签）——人工排查时要看到 pi 侧到底存了什么
		expect(r.detail?.piText).toBe(`${QUEUE_MARK.steer}\n画个狗`)
	})

	it('⭐ 插话标签 + 400 字截断同时存在 ⇒ aligned（生产真实组合：长插话被截断）', () => {
		// pi 侧 text 按**全文字长**截断（mark + "\n" + body 截到 400 + `…`）
		// ⇒ 剥标签后剩下的正文仍 ≥ 比对长度 ⇒ 前缀命中。
		const body = 'A'.repeat(500)
		const keep = 400 - QUEUE_MARK.steer.length - 1
		const piTruncated = `${QUEUE_MARK.steer}\n${'A'.repeat(keep)}…`
		const r = reconcileHistory({
			nestUserMessage: { id: 'm1', content: body, createdAt: 2 },
			tail: [userEntry(piTruncated, 1)],
		})
		expect(r.verdict).toBe('aligned')
	})

	it('⭐ 插话消息 + pi 侧确有一条**不同**的旧 user 消息 ⇒ diverged（真分叉不漏）', () => {
		// 事故原形态：插话根本没到 pi 侧 ⇒ tail 里最近的 user 是更早的轮次
		const r = reconcileHistory({
			nestUserMessage: { id: 'm1', content: '画个乌龟', createdAt: 3 },
			tail: [userEntry('先出章鱼的静帧图', 1), assistantEntry('好的', 2)],
		})
		expect(r.verdict).toBe('diverged')
	})
})

// ── 编排层（IO）────────────────────────────────────────────────────────────

/** 造一个最小 prisma 假件。 */
function makePrisma(messages: Array<{ id: string; content: string; createdAt?: Date }>) {
	return {
		agentMessage: {
			// 与实现一致：用 findFirst 取**最近一条**（createdAt 倒序的第一条）
			findFirst: async () => {
				const sorted = [...messages].sort(
					(a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
				)
				const m = sorted[0]
				return m
					? { id: m.id, content: m.content, createdAt: m.createdAt ?? new Date(1_700_000_000_000) }
					: null
			},
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
				findFirst: async () => {
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

	it('⭐ 插话（steer）消息 ⇒ aligned 且不写假 turn_state（2026-10-22 生产假阳）', async () => {
		// 行为级判据落在可观测出口：turnState.record 未被调用 + 无 history_diverged 告警。
		// 修复前这里会 diverged + 自愈（生产 12:49:05 实证）。
		const prisma = makePrisma([{ id: 'm1', content: '画个乌龟' }])
		const client = makeClient([userEntry(`${QUEUE_MARK.steer}\n画个乌龟`, 1), assistantEntry('好的', 2)])
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

	it('⭐ 插话消息但 pi 侧最近的 user 是**别的**内容 ⇒ 仍 diverged 仍自愈（写 Nest 原话）', async () => {
		// 防「剥离修复」把真分叉一起修没：标签只是噪音，内容不符仍是分叉。
		const prisma = makePrisma([{ id: 'm1', content: '画个乌龟' }])
		const client = makeClient([userEntry(`${QUEUE_MARK.steer}\n画个狗`, 1)])
		const ts = makeTurnState()

		const out = await reconcileAfterTurn({
			prisma: prisma as never,
			client: client as never,
			turnState: ts.store as never,
			threadId: 't1',
			sessionKey: 'k1',
			logger,
		})

		expect(out.verdict).toBe('diverged')
		expect(out.healed).toBe(true)
		expect(ts.records).toHaveLength(1)
		expect(ts.records[0].userText).toBe('画个乌龟')
	})
})
