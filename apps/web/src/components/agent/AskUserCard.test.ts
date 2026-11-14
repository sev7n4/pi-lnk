import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AskUserCard from './AskUserCard.vue'

const Q2 = [
	{ id: 'style', question: '风格？', options: [{ label: '水墨', value: 'ink' }, { label: '水彩', value: 'water' }] },
	{ id: 'count', question: '张数？', options: [{ label: '1 张', value: '1' }, { label: '2 张', value: '2' }] },
]
// allowOther 缺省视为开启（与旧契约 allowOther !== false 一致）→ 每题渲染 1 行「其他…」
const CHIPS_PER_Q = 3

describe('AskUserCard（spec 2026-10-28 分页单题推进 / T0-T2 + 视觉重制）', () => {
	it('单问题单选：点选项行即 emit submit（低摩擦主路径，S1）', async () => {
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
	it('单问题「其他」：点「其他…」行展开输入，回车即提交（自由文本与选项同通道）', async () => {
		const w = mount(AskUserCard, { props: { questions: [Q2[0]] } })
		await w.find('.ask-chip-other').trigger('click')
		expect(w.find('.ask-other-input').exists()).toBe(true)
		await w.find('.ask-other-input').setValue('手绘风')
		await w.find('.ask-other-input').trigger('keyup.enter')
		expect(w.emitted('submit')![0][0]).toEqual({ answers: { style: ['手绘风'] } })
	})
	it('multiSelect「其他」：文本进已选集合随确认提交（修复旧实现写单选暂存位被静默丢弃）', async () => {
		const q = { id: 'm', question: '多选？', multiSelect: true, options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] }
		const w = mount(AskUserCard, { props: { questions: [q] } })
		await w.findAll('.ask-chip')[0].trigger('click') // A
		await w.find('.ask-chip-other').trigger('click')
		await w.find('.ask-other-input').setValue('自定义')
		await w.find('.ask-other-done').trigger('click')
		expect(w.find('.ask-multi-confirm').text()).toContain('已选 2 项')
		await w.find('.ask-multi-confirm').trigger('click')
		expect(w.emitted('submit')![0][0]).toEqual({ answers: { m: ['a', '自定义'] } })
	})

	// ---- D2 基数信号（单选用 ○ / 多选用 ☑）----
	it('D2：单选题干标注「单选」、多选标注「可多选」（稳定标签，不随选项变化）', () => {
		const single = mount(AskUserCard, { props: { questions: [Q2[0]] } })
		expect(single.find('.ask-cardinality').text()).toContain('单选')
		expect(single.find('.ask-cardinality svg').exists()).toBe(true)

		const multi = mount(AskUserCard, {
			props: { questions: [{ id: 'm', question: '多选？', multiSelect: true, options: [{ label: 'A', value: 'a' }] }] },
		})
		expect(multi.find('.ask-cardinality').text()).toContain('可多选')
		expect(multi.find('.ask-cardinality svg').exists()).toBe(true)
	})

		// ---- D3 序号 + D2 更强版（增强版方案A：前缀仅序号，类型由题级标签 + 末尾徽标形状承载）----
	it('D3：每个选项前缀渲染序号 1..n；「其他…」行不编号（非预设选项）', () => {
		const w = mount(AskUserCard, {
			props: { questions: [{ id: 'q', question: '?', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }, { label: 'C', value: 'c' }] }] },
		})
		expect(w.findAll('.ask-chip-index').map((e) => e.text())).toEqual(['1', '2', '3'])
		expect(w.find('.ask-chip-other').find('.ask-chip-index').exists()).toBe(false)
	})
	it('D2 更强版（方案A）：单/多类型由题级标签 + 末尾徽标形状承载；预设项前缀无冗余 ○/□', () => {
		// 单选：题级标签 ○ 单选；选中后末尾徽标为圆形（无 is-multi）
		const single = mount(AskUserCard, {
			props: { questions: [{ id: 's', question: '?', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] }] },
		})
		const sLabel = single.find('.ask-cardinality svg').element as SVGElement
		expect(sLabel.querySelector('circle')).not.toBeNull()
		expect(sLabel.querySelector('rect')).toBeNull()
		// 预设项前缀不再渲染 ○/□：ask-chip-marker 仅用于「其他…」的 + 图标（2 预设 + 1 其他 ⇒ 1 个 marker）
		expect(single.findAll('.ask-chip-marker')).toHaveLength(1)
		const sBadge = single.find('.ask-chip .ask-chip-check')
		expect(sBadge.exists()).toBe(true)
		expect(sBadge.classes()).not.toContain('is-multi')

		// 多选：题级标签 ☑ 可多选（rect）；末尾徽标携带 is-multi（圆角方形☑）
		const multi = mount(AskUserCard, {
			props: { questions: [{ id: 'm', question: '?', multiSelect: true, options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] }] },
		})
		const mLabel = multi.find('.ask-cardinality svg').element as SVGElement
		expect(mLabel.querySelector('rect')).not.toBeNull()
		expect(mLabel.querySelector('circle')).toBeNull()
		expect(multi.findAll('.ask-chip-marker')).toHaveLength(1) // 仅「其他…」的 + 图标
		const mBadge = multi.find('.ask-chip .ask-chip-check')
		expect(mBadge.exists()).toBe(true)
		expect(mBadge.classes()).toContain('is-multi')
	})

	// ---- 加固：multiSelect 勾选预设项 + 「其他」补充文字 → wire 契约把两者都交给 agent ----
	it('加固：multiSelect 勾选 A、B 并「其他」补充文字 → answers 同时含选项值与自定义文本', async () => {
		const q = { id: 'm', question: '多选？', multiSelect: true, options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] }
		const w = mount(AskUserCard, { props: { questions: [q] } })
		await w.findAll('.ask-chip')[0].trigger('click') // A
		await w.findAll('.ask-chip')[1].trigger('click') // B
		await w.find('.ask-chip-other').trigger('click')
		await w.find('.ask-other-input').setValue('用户自身补充内容')
		await w.find('.ask-other-done').trigger('click')
		expect(w.find('.ask-multi-confirm').text()).toContain('已选 3 项')
		await w.find('.ask-multi-confirm').trigger('click')
		expect(w.emitted('submit')![0][0]).toEqual({ answers: { m: ['a', 'b', '用户自身补充内容'] } })
	})

// ---- D1 修复回归：自定义「其他」可见可移除 + 单选自定义回填 ----
	it('D1：multiSelect 自定义「其他」渲染为可见可移除 chip，移除后不再提交', async () => {
		const q = { id: 'm', question: '多选？', multiSelect: true, options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] }
		const w = mount(AskUserCard, { props: { questions: [q] } })
		await w.findAll('.ask-chip')[0].trigger('click') // A
		await w.find('.ask-chip-other').trigger('click')
		await w.find('.ask-other-input').setValue('自定义')
		await w.find('.ask-other-done').trigger('click')
		const custom = w.findAll('.ask-chip-custom')
		expect(custom).toHaveLength(1)
		expect(custom[0].text()).toContain('自定义')
		await custom[0].trigger('click') // 移除
		expect(w.findAll('.ask-chip-custom')).toHaveLength(0)
		await w.find('.ask-multi-confirm').trigger('click')
		expect(w.emitted('submit')![0][0]).toEqual({ answers: { m: ['a'] } })
	})
	it('D1：多题卡单选自定义「其他」回填——返回该题时「其他…」高亮且重开预填文本', async () => {
		const q = { id: 's', question: '单选？', options: [{ label: 'A', value: 'a' }] }
		const w = mount(AskUserCard, { props: { questions: [q, Q2[1]] } })
		await w.find('.ask-chip-other').trigger('click') // 展开
		await w.find('.ask-other-input').setValue('自填项')
		await w.find('.ask-other-input').trigger('keyup.enter') // 提交并自动推进到 Q2
		expect(w.find('.ask-progress').text()).toContain('第 2 / 2 题')
		await w.find('.ask-nav-prev').trigger('click') // 回到 Q1
		expect(w.find('.ask-chip-other').classes()).toContain('is-selected')
		await w.find('.ask-chip-other').trigger('click') // 重开应预填
		expect((w.find('.ask-other-input').element as HTMLInputElement).value).toBe('自填项')
	})

	// ---- T1 分页单题推进（吸上游 questionnaire.ts 范式）----
	it('多题卡：一次只渲染一题（DOM 有界，防溢出死锁，S2/S6）', () => {
		const five = Array.from({ length: 5 }, (_, i) => ({
			id: `q${i}`, question: `Q${i}?`, options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
		}))
		const w = mount(AskUserCard, { props: { questions: five } })
		// 只渲染当前一题，而非全部 5 题 → 不会因 DOM 无限增长溢出宿主（根因 1 复测）
		expect(w.findAll('.ask-question')).toHaveLength(1)
		expect(w.findAll('.ask-chip')).toHaveLength(CHIPS_PER_Q) // 当前题 2 选项 + 1「其他…」行
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
	it('多题卡：首答自动推进下一未答题 + 上一题回退 + 答案跨页保留 + 答满自动提交（S2/S3）', async () => {
		const w = mount(AskUserCard, { props: { questions: Q2 } })
		await w.findAll('.ask-chip')[0].trigger('click') // Q1=ink → 自动推进 Q2
		expect(w.emitted('submit')).toBeUndefined() // 未答满不提交
		expect(w.find('.ask-progress').text()).toContain('第 2 / 2 题')
		await w.find('.ask-nav-prev').trigger('click') // 回 Q1
		expect(w.find('.ask-progress').text()).toContain('第 1 / 2 题')
		expect(w.findAll('.ask-chip')[0].classes()).toContain('is-selected') // style=ink 仍选中（跨页保留）
		await w.find('.ask-nav-next').trigger('click') // → Q2
		await w.findAll('.ask-chip')[0].trigger('click') // count=1 → 答满自动提交
		expect(w.emitted('submit')![0][0]).toEqual({ answers: { style: ['ink'], count: ['1'] } })
	})
	it('多题卡：修改已答题不触发自动推进（停留原地，防误跳）', async () => {
		const w = mount(AskUserCard, { props: { questions: Q2 } })
		await w.findAll('.ask-chip')[0].trigger('click') // Q1=ink → 推进 Q2
		await w.find('.ask-nav-prev').trigger('click') // 回 Q1
		await w.findAll('.ask-chip')[1].trigger('click') // 改选 water（改答）
		expect(w.find('.ask-progress').text()).toContain('第 1 / 2 题') // 不推进
	})
	it('多题卡：跳过后自动推进 + 可返回「重新作答」', async () => {
		const w = mount(AskUserCard, { props: { questions: Q2 } })
		await w.find('.ask-skip').trigger('click') // skip Q1 → 推进 Q2
		expect(w.find('.ask-progress').text()).toContain('第 2 / 2 题')
		await w.find('.ask-nav-prev').trigger('click')
		expect(w.find('.ask-skipped-note').text()).toContain('此题已跳过')
		await w.find('.ask-unskip').trigger('click')
		expect(w.find('.ask-skipped-note').exists()).toBe(false)
	})
	it('多题卡末页「提交」钮可显式提交（S3）', async () => {
		const w = mount(AskUserCard, { props: { questions: Q2 } })
		await w.findAll('.ask-chip')[0].trigger('click') // Q1=ink（自动推进到末页）
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

	// ---- P0-2（2026-11-11）：确认卡内联方案本体 ----
	it('P0-2：question.plan 存在时渲染方案摘要 + 有序步骤清单（先看方案再决策）', () => {
		const q = {
			id: 'plan_confirm',
			question: '三步制作 Codex 教学视频',
			plan: {
				summary: '三步制作 Codex 知识教学视频（脚本→封面→成片）',
				explanation: '先脚本确保内容准确，再封面吸引点击，最后成片交付',
				steps: [
					{ content: '编写教学脚本大纲：什么是 Codex + 核心功能 + 操作步骤 + 案例演示' },
					{ content: '创建视频封面图', activeForm: '正在创建封面图' },
					{ content: '生成教学视频正文' },
				],
			},
			options: [
				{ label: '开始执行', value: 'execute' },
				{ label: '调整计划', value: 'refine' },
				{ label: '仅保留方案', value: 'keep' },
			],
			allowOther: true,
		}
		const w = mount(AskUserCard, { props: { questions: [q] } })
		const plan = w.find('.ask-plan')
		expect(plan.exists()).toBe(true)
		expect(plan.find('.ask-plan-title').text()).toContain('三步制作 Codex')
		expect(plan.find('.ask-plan-explanation').text()).toContain('先脚本确保内容准确')
		expect(plan.findAll('.ask-plan-step')).toHaveLength(3)
		expect(plan.findAll('.ask-plan-step')[0].find('.ask-plan-step-text').text()).toContain('编写教学脚本大纲')
		expect(plan.findAll('.ask-plan-step')[1].find('.ask-plan-step-active').text()).toContain('正在创建封面图')
		// 方案块不破坏决策交互：3 选项 + 「其他…」共 4 个 chip
		expect(w.findAll('.ask-chip')).toHaveLength(4)
	})
})
