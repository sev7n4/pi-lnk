import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AskUserCard from './AskUserCard.vue'

const Q2 = [
	{ id: 'style', question: '风格？', options: [{ label: '水墨', value: 'ink' }, { label: '水彩', value: 'water' }] },
	{ id: 'count', question: '张数？', options: [{ label: '1 张', value: '1' }, { label: '2 张', value: '2' }] },
]

describe('AskUserCard（B-6 点选与提交分离）', () => {
	it('单问题单选：点 chip 即 emit submit（低摩擦主路径）', async () => {
		const w = mount(AskUserCard, { props: { questions: [Q2[0]] } })
		await w.findAll('.ask-chip')[0].trigger('click')
		expect(w.emitted('submit')![0][0]).toEqual({ answers: { style: ['ink'] } })
	})
	it('多问题：点选只高亮不提交；答满自动 submit 全部答案', async () => {
		const w = mount(AskUserCard, { props: { questions: Q2 } })
		const chips = w.findAll('.ask-chip')
		await chips[0].trigger('click') // style=ink
		expect(w.emitted('submit')).toBeUndefined() // 未答满不提交
		expect(w.find('.ask-progress').text()).toContain('1/2')
		await w.findAll('.ask-chip')[2].trigger('click') // count=1
		expect(w.emitted('submit')![0][0]).toEqual({ answers: { style: ['ink'], count: ['1'] } })
	})
	it('跳过钮：未答问题标 skipped 后可提交（部分作答合法）', async () => {
		const w = mount(AskUserCard, { props: { questions: Q2 } })
		await w.findAll('.ask-skip')[0].trigger('click') // 跳过 style
		await w.findAll('.ask-chip')[2].trigger('click') // count=1
		expect(w.emitted('submit')![0][0]).toEqual({ answers: { count: ['1'] }, skipped: ['style'] })
	})
	it('单问题卡 skip 即 submit（全 skipped，防阻塞死锁）', async () => {
		const w = mount(AskUserCard, { props: { questions: [Q2[0]] } })
		await w.findAll('.ask-skip')[0].trigger('click')
		expect(w.emitted('submit')![0][0]).toEqual({ answers: {}, skipped: ['style'] })
	})
	it('cancel：emit cancel 契约保留（AgentSideRail 据此路由）', async () => {
		const w = mount(AskUserCard, { props: { questions: [Q2[0]] } })
		await w.find('.ask-cancel').trigger('click')
		expect(w.emitted('cancel')).toHaveLength(1)
		expect(w.emitted('submit')).toBeUndefined()
	})
	it('multiSelect：点选后需显式确认钮（既有 D2 语义保留）', async () => {
		const q = { id: 'm', question: '多选？', multiSelect: true, options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] }
		const w = mount(AskUserCard, { props: { questions: [q] } })
		await w.findAll('.ask-chip')[0].trigger('click')
		expect(w.emitted('submit')).toBeUndefined()
		await w.find('.ask-multi-confirm').trigger('click')
		expect(w.emitted('submit')![0][0]).toEqual({ answers: { m: ['a'] } })
	})
})
