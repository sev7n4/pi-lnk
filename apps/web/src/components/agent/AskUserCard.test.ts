import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AskUserCard from './AskUserCard.vue'

const Q2 = [
	{ id: 'style', question: '风格？', options: [{ label: '水墨', value: 'ink' }, { label: '水彩', value: 'water' }] },
	{ id: 'count', question: '张数？', options: [{ label: '1 张', value: '1' }, { label: '2 张', value: '2' }] },
]

describe('AskUserCard（spec 2026-10-28 分页单题推进 / T0-T2）', () => {
	it('单问题单选：点 chip 即 emit submit（低摩擦主路径，S1）', async () => {
		const w = mount(AskUserCard, { props: { questions: [Q2[0]] } })
		await w.findAll('.ask-chip')[0].trigger('click')
		expect(w.emitted('submit')![0][0]).toEqual({ answers: { style: ['ink'] } })
	})
	it('单问题卡 skip 即 submit（全 skipped，防阻塞死锁）', async () => {
		const w = mount(AskUserCard, { props: { questions: [Q2[0]] } })
		await w.findAll('.ask-skip')[0].trigger('click')
		expect(w.emitted('submit')![0][0]).toEqual({ answers: {}, skipped: ['style'] })
	})
	it('cancel：emit cancel 契约保留', async () => {
		const w = mount(AskUserCard, { props: { questions: [Q2[0]] } })
		await w.find('.ask-cancel').trigger('click')
		expect(w.emitted('cancel')).toHaveLength(1)
		expect(w.emitted('submit')).toBeUndefined()
	})
	it('multiSelect 单题：点选后需显式确认钮（D2 语义保留）', async () => {
		const q = { id: 'm', question: '多选？', multiSelect: true, options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] }
		const w = mount(AskUserCard, { props: { questions: [q] } })
		await w.findAll('.ask-chip')[0].trigger('click')
		expect(w.emitted('submit')).toBeUndefined()
		await w.find('.ask-multi-confirm').trigger('click')
		expect(w.emitted('submit')![0][0]).toEqual({ answers: { m: ['a'] } })
	})

	// ---- T1 分页单题推进（吸上游 questionnaire.ts 范式）----
	it('多题卡：一次只渲染一题（DOM 有界，防溢出死锁，S2/S6）', () => {
		const five = Array.from({ length: 5 }, (_, i) => ({
			id: `q${i}`, question: `Q${i}?`, options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
		}))
		const w = mount(AskUserCard, { props: { questions: five } })
		// 只渲染当前一题，而非全部 5 题 → 不会因 DOM 无限增长溢出宿主（根因 1 复测）
		expect(w.findAll('.ask-question')).toHaveLength(1)
		expect(w.findAll('.ask-chip')).toHaveLength(2) // 仅当前题的 2 个选项
		expect(w.find('.ask-progress').text()).toContain('第 1 / 5 题')
	})
	it('多题卡：5 题可逐题导航抵达每一题（无 Q5 死锁，S2）', async () => {
		const five = Array.from({ length: 5 }, (_, i) => ({
			id: `q${i}`, question: `Q${i}?`, options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
		}))
		const w = mount(AskUserCard, { props: { questions: five } })
		for (let i = 0; i < 5; i++) {
			expect(w.find('.ask-progress').text()).toContain(`第 ${i + 1} / 5 题`)
			expect(w.findAll('.ask-question')).toHaveLength(1) // 每屏仅一题
			if (i < 4) {
				expect(w.find('.ask-nav-next').exists()).toBe(true)
				await w.find('.ask-nav-next').trigger('click')
			} else {
				expect(w.find('.ask-nav-submit').exists()).toBe(true)
				expect(w.find('.ask-nav-next').exists()).toBe(false)
			}
		}
	})
	it('多题卡：上一题/下一题导航 + 答案跨页保留 + 答满自动提交（S2/S3）', async () => {
		const w = mount(AskUserCard, { props: { questions: Q2 } })
		await w.findAll('.ask-chip')[0].trigger('click') // Q1=ink
		expect(w.emitted('submit')).toBeUndefined() // 未答满不提交
		expect(w.find('.ask-progress').text()).toContain('第 1 / 2 题')
		await w.find('.ask-nav-next').trigger('click') // → Q2
		expect(w.find('.ask-progress').text()).toContain('第 2 / 2 题')
		await w.find('.ask-nav-prev').trigger('click') // 回 Q1
		expect(w.find('.ask-progress').text()).toContain('第 1 / 2 题')
		expect(w.findAll('.ask-chip')[0].classes()).toContain('is-selected') // style=ink 仍选中（跨页保留）
		await w.find('.ask-nav-next').trigger('click') // → Q2
		await w.findAll('.ask-chip')[0].trigger('click') // count=1 → 答满自动提交
		expect(w.emitted('submit')![0][0]).toEqual({ answers: { style: ['ink'], count: ['1'] } })
	})
	it('多题卡末页「提交」钮可显式提交（S3）', async () => {
		const w = mount(AskUserCard, { props: { questions: Q2 } })
		await w.findAll('.ask-chip')[0].trigger('click') // Q1=ink（未答满）
		await w.find('.ask-nav-next').trigger('click') // → Q2（末页，未答）
		expect(w.find('.ask-nav-submit').exists()).toBe(true)
		expect(w.find('.ask-nav-next').exists()).toBe(false) // 末页无「下一题」
		await w.find('.ask-nav-submit').trigger('click')
		expect(w.emitted('submit')![0][0]).toEqual({ answers: { style: ['ink'] } })
	})

	// ---- T2 部分提交逃生 ----
	it('多题卡「提交已答部分」：已答 A<N 时显式交还已答部分（其余隐式 skipped，S4）', async () => {
		const w = mount(AskUserCard, { props: { questions: Q2 } })
		await w.findAll('.ask-chip')[0].trigger('click') // 只答 Q1
		expect(w.find('.ask-partial').exists()).toBe(true) // 逃生钮可见（1<2）
		expect(w.find('.ask-partial').text()).toContain('提交已答部分（1）')
		await w.find('.ask-partial').trigger('click')
		// 仅交还已答部分；未答隐式 skipped（wire 契约：只 POST answers）
		expect(w.emitted('submit')![0][0]).toEqual({ answers: { style: ['ink'] } })
	})
	it('多题卡逃生钮仅在 0<已答<N 时出现（S4 边界）', () => {
		const w = mount(AskUserCard, { props: { questions: Q2 } })
		expect(w.find('.ask-partial').exists()).toBe(false) // 0 答：不显
	})
})
