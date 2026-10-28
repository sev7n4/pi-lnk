<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
/**
 * ask_user 选项卡组件（spec 2026-10-28-askuser-card-visual-refinement，承接 2026-10-28-askuser-mobile-multi-question-redesign T0-T2）：
 * - 交互契约不变：单题卡点选即提交（B-6）/ 多题卡分页单题推进（T1）/ 答满自动提交（S3）/
 *   「提交已答部分」逃生（T2）/ cancel 通道（S5）。wire 契约不变：只 POST answers，未答隐式 skipped。
 * - 视觉重制（Apple 式收敛 × 墨流令牌）：选项 chip → 全宽触控行（44px），选中=翻面 + accent 对勾；
 *   「跳过」上收题头右上；「其他」收进选项列表末位（点选原地展开输入，回车即提交）；
 *   「提交已答部分 / 改用文字描述」降级为底部静默链接区。多题卡进度改分段条。
 * - 行为增强：单选答后自动推进到下一未答题（修改已答题不推进，防误跳）；
 *   multiSelect 的「其他」文本进已选集合（修复旧实现写入单选暂存位被静默丢弃的缺陷）。
 * - 样式只消费 --lnk-* L2/L3 令牌（暗/亮主题自适应；design-token.test.ts 成对性守卫）。
 *   6 态契约齐备：hover/active/focus-visible(2px border-focus 外环)/disabled（显式 text-disabled，不用 opacity）。
 *   动效只动 transform/opacity，prefers-reduced-motion 强制静止。
 *   零第三方图标：对勾为内联 SVG（24 网格）。
 * AskUserQuestion 结构与 pi-events.ts 同构（内联避免跨包 import server 类型）。
 */
interface AskUserQuestion {
	id: string
	question: string
	options: { label: string; value: string }[]
	multiSelect?: boolean
	allowOther?: boolean
}

interface Props {
	questions: AskUserQuestion[]
}
const props = defineProps<Props>()
const emit = defineEmits<{
	submit: [payload: { answers: Record<string, string[]>; skipped?: string[] }]
	cancel: []
}>()

const otherText = ref<Record<string, string>>({})
/** 「其他」行的展开态：点「其他…」行原地展开输入（chip 化，与选项同视觉同通道） */
const otherEditing = ref<Record<string, boolean>>({})
const otherInputEl = ref<HTMLInputElement | null>(null)
const multiSelected = ref<Record<string, string[]>>({})
/** 单选暂存：多题卡点选不即发；单题卡点选即发（B-6 主路径低摩擦） */
const singleSelected = ref<Record<string, string>>({})
const skipped = ref<Set<string>>(new Set())
/** T1 分页游标：仅多题卡使用；单题卡恒显示唯一题 */
const currentIndex = ref(0)

const isMulti = computed(() => props.questions.length > 1)
const current = computed(() => props.questions[currentIndex.value] ?? props.questions[0])

const answeredCount = computed(() =>
	props.questions.filter(
		(q) =>
			skipped.value.has(q.id) ||
			singleSelected.value[q.id] ||
			(multiSelected.value[q.id]?.length ?? 0) > 0,
	).length,
)

/** 当前题是否已答（驱动「下一题 ✓」反馈） */
const currentAnswered = computed(() => isAnswered(current.value))

function isAnswered(q: AskUserQuestion) {
	if (skipped.value.has(q.id)) return false
	if (q.multiSelect) return (multiSelected.value[q.id]?.length ?? 0) > 0
	return !!singleSelected.value[q.id]
}

/** T1 收集当前所有已作答（跳过的题不进 answers，未答隐式 skipped，wire 契约不变） */
function collectAnswers(): Record<string, string[]> {
	const answers: Record<string, string[]> = {}
	for (const q of props.questions) {
		if (skipped.value.has(q.id)) continue
		const v = multiSelected.value[q.id] ?? (singleSelected.value[q.id] ? [singleSelected.value[q.id]] : [])
		if (v.length) answers[q.id] = v
	}
	return answers
}

function doSubmit() {
	const answers = collectAnswers()
	emit('submit', { answers, ...(skipped.value.size ? { skipped: [...skipped.value] } : {}) })
}

/** T2 逃生：已答 A<N 时显式交还已答部分，其余隐式 skipped。不依赖 30min 超时 */
function submitPartial() {
	if (answeredCount.value === 0) return
	doSubmit()
}

function goPrev() {
	if (currentIndex.value > 0) currentIndex.value -= 1
}
function goNext() {
	if (currentIndex.value < props.questions.length - 1) currentIndex.value += 1
}

/** 答后自动推进：前进到下一个未答且未跳过的题（环绕查找）；全部已答/已跳过则留原地 */
function advanceToNextUnanswered() {
	const n = props.questions.length
	for (let step = 1; step < n; step++) {
		const i = (currentIndex.value + step) % n
		const q = props.questions[i]
		if (!skipped.value.has(q.id) && !isAnswered(q)) {
			currentIndex.value = i
			return
		}
	}
}

function isSelected(qid: string, value: string) {
	return multiSelected.value[qid]?.includes(value) ?? false
}
function toggleMulti(q: AskUserQuestion, value: string) {
	const prev = multiSelected.value[q.id] ?? []
	multiSelected.value[q.id] = prev.includes(value)
		? prev.filter((v) => v !== value)
		: [...prev, value]
}
function confirmMulti() {
	// 多题卡 multiSelect 确认后：答满自动提交（S3），否则推进到下一未答题
	if (props.questions.length === 1) {
		doSubmit()
		return
	}
	if (answeredCount.value === props.questions.length) {
		doSubmit()
		return
	}
	advanceToNextUnanswered()
}
function pick(q: AskUserQuestion, value: string) {
	if (q.multiSelect) {
		toggleMulti(q, value)
		return
	}
	if (props.questions.length === 1) {
		emit('submit', { answers: { [q.id]: [value] } })
		return
	}
	// 修改已答题 = 原地改选，不自动推进（防误跳）；首答才推进
	const wasAnswered = !!singleSelected.value[q.id]
	singleSelected.value[q.id] = value
	if (answeredCount.value === props.questions.length) {
		doSubmit()
		return
	}
	if (!wasAnswered) advanceToNextUnanswered()
}
function skip(q: AskUserQuestion) {
	skipped.value.add(q.id)
	// 单题卡 tryAutoSubmit 不适用（无「答满补齐」路径）→ 直接提交全 skipped，
	// 否则 skip 后卡片挂死只能等超时（fix round 1 Finding 1）
	if (props.questions.length === 1) {
		doSubmit()
		return
	}
	if (answeredCount.value === props.questions.length) {
		doSubmit()
		return
	}
	advanceToNextUnanswered()
}
function unskip(q: AskUserQuestion) {
	skipped.value.delete(q.id)
}
function startOther(q: AskUserQuestion) {
	otherEditing.value[q.id] = true
	nextTick(() => otherInputEl.value?.focus())
}
function cancelOther(q: AskUserQuestion) {
	otherEditing.value[q.id] = false
	otherText.value[q.id] = ''
}
function submitOther(q: AskUserQuestion) {
	const text = otherText.value[q.id]?.trim()
	if (!text) return
	otherEditing.value[q.id] = false
	otherText.value[q.id] = ''
	if (q.multiSelect) {
		// fix：multiSelect 的「其他」进已选集合（旧实现写单选暂存位，提交时被静默丢弃）
		const prev = multiSelected.value[q.id] ?? []
		if (!prev.includes(text)) multiSelected.value[q.id] = [...prev, text]
	} else if (props.questions.length === 1) {
		emit('submit', { answers: { [q.id]: [text] } })
		return
	} else {
		singleSelected.value[q.id] = text
	}
	if (props.questions.length > 1) {
		if (answeredCount.value === props.questions.length) {
			doSubmit()
			return
		}
		advanceToNextUnanswered()
	}
}
</script>

<template>
	<div class="ask-user-card">
		<!-- 多题：分段进度条 + 元信息（T1，sticky 顶部，T0 有界滚动时常驻） -->
		<div v-if="isMulti" class="ask-progress">
			<div class="ask-progress-track" aria-hidden="true">
				<i
					v-for="(q, i) in props.questions"
					:key="q.id"
					:class="{ 'is-past': i < currentIndex, 'is-cur': i === currentIndex }"
				/>
			</div>
			<div class="ask-progress-meta">
				<span>第 {{ currentIndex + 1 }} / {{ props.questions.length }} 题</span>
				<span class="ask-progress-count">已答 {{ answeredCount }} / {{ props.questions.length }}</span>
			</div>
		</div>

		<!-- 当前题（单题卡即唯一题；多题卡即 current） -->
		<div class="ask-question" :key="current.id">
			<div class="ask-question-head">
				<div class="ask-question-text">{{ current.question }}</div>
				<button
					type="button"
					class="ask-skip"
					:disabled="skipped.has(current.id)"
					:aria-label="skipped.has(current.id) ? '已跳过此题' : '跳过此题，稍后可返回'"
					@click="skip(current)"
				>{{ skipped.has(current.id) ? '已跳过' : '跳过' }}</button>
			</div>
			<div class="ask-options">
				<button
					v-for="opt in current.options"
					:key="opt.value"
					type="button"
					class="ask-chip"
					:class="{ 'is-selected': current.multiSelect ? isSelected(current.id, opt.value) : singleSelected[current.id] === opt.value }"
					:aria-pressed="current.multiSelect ? isSelected(current.id, opt.value) : singleSelected[current.id] === opt.value"
					:disabled="skipped.has(current.id)"
					@click="pick(current, opt.value)"
				>
					<span class="ask-chip-label">{{ opt.label }}</span>
					<span class="ask-chip-check" aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7" /></svg>
					</span>
				</button>
				<!-- 「其他」收进选项列表末位：点选原地展开输入，回车/完成即提交（与选项同通道） -->
				<template v-if="current.allowOther !== false">
					<div v-if="otherEditing[current.id]" class="ask-other-editor">
						<input
							ref="otherInputEl"
							v-model="otherText[current.id]"
							type="text"
							class="ask-other-input"
							placeholder="直接写下你的想法"
							@keyup.enter="submitOther(current)"
							@keyup.escape="cancelOther(current)"
						/>
						<button type="button" class="ask-other-done" @click="submitOther(current)">完成</button>
					</div>
					<button
						v-else
						type="button"
						class="ask-chip ask-chip-other"
						aria-label="其他：输入自定义答案"
						@click="startOther(current)"
					>
						<span class="ask-chip-label">其他…</span>
					</button>
				</template>
			</div>
			<button
				v-if="current.multiSelect && (multiSelected[current.id]?.length ?? 0) > 0"
				type="button"
				class="ask-multi-confirm"
				@click="confirmMulti()"
			>确认（已选 {{ (multiSelected[current.id] ?? []).length }} 项）</button>
			<div v-if="skipped.has(current.id)" class="ask-skipped-note">
				<span>此题已跳过</span>
				<button type="button" class="ask-unskip" @click="unskip(current)">重新作答</button>
			</div>
		</div>

		<!-- 静默链接区（T2 逃生 + 文字描述通道）：次级呈现，不与主路径争夺注意力 -->
		<div class="ask-footnote">
			<button
				v-if="answeredCount > 0 && answeredCount < props.questions.length"
				type="button"
				class="ask-partial"
				@click="submitPartial()"
			>提交已答部分（{{ answeredCount }}）</button>
			<button type="button" class="ask-cancel" @click="emit('cancel')">都不合适？改用文字描述</button>
		</div>

		<!-- 多题：底部固定导航（T1），sticky 常驻 -->
		<div v-if="isMulti" class="ask-nav">
			<button
				type="button"
				class="ask-nav-prev"
				:disabled="currentIndex === 0"
				@click="goPrev()"
			>上一题</button>
			<button
				v-if="currentIndex < props.questions.length - 1"
				type="button"
				class="ask-nav-next"
				@click="goNext()"
			>下一题<svg v-if="currentAnswered" class="ask-next-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 13 4 4L19 7" /></svg></button>
			<button
				v-else
				type="button"
				class="ask-nav-submit"
				@click="doSubmit()"
			>提交</button>
		</div>
	</div>
</template>

<style scoped>
/* ── 卡片：raised 面 + xl 圆角 + 轻阴影；T0 有界自滚，绝不依赖宿主滚动容器 ── */
.ask-user-card {
	display: flex;
	flex-direction: column;
	gap: var(--lnk-space-3);
	padding: var(--lnk-pad-card);
	border: 1px solid var(--lnk-border-subtle);
	border-radius: var(--lnk-radius-xl);
	background: var(--lnk-surface-raised);
	color: var(--lnk-text-primary);
	box-shadow: var(--lnk-shadow-sm);
	font-size: var(--lnk-text-base);
	max-height: min(60vh, 520px);
	min-height: 0;
	overflow-y: auto;
}

/* ── 分段进度条 + 元信息（sticky 顶部；负 margin 盖住卡片内边距，滚动时不漏底） ── */
.ask-progress {
	position: sticky;
	top: 0;
	z-index: 1;
	display: flex;
	flex-direction: column;
	gap: var(--lnk-space-2);
	margin: calc(-1 * var(--lnk-pad-card)) calc(-1 * var(--lnk-pad-card)) 0;
	padding: var(--lnk-pad-card) var(--lnk-pad-card) var(--lnk-space-1);
	background: var(--lnk-surface-raised);
}
.ask-progress-track {
	display: flex;
	gap: var(--lnk-space-1);
}
.ask-progress-track i {
	height: 4px;
	flex: 1;
	border-radius: var(--lnk-radius-full);
	background: var(--lnk-surface-sunken);
	transition: background var(--lnk-duration-base) var(--lnk-ease-standard), opacity var(--lnk-duration-base) var(--lnk-ease-standard);
}
.ask-progress-track i.is-past {
	background: var(--lnk-accent);
}
.ask-progress-track i.is-cur {
	background: var(--lnk-accent);
	opacity: 0.45;
}
.ask-progress-meta {
	display: flex;
	justify-content: space-between;
	align-items: baseline;
	font-size: var(--lnk-text-xs);
	color: var(--lnk-text-muted);
}
.ask-progress-count {
	font-variant-numeric: tabular-nums;
}

/* ── 题干 + 跳过（右上 ghost 位） ── */
.ask-question {
	display: flex;
	flex-direction: column;
	gap: var(--lnk-space-3);
}
.ask-question-head {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: var(--lnk-space-3);
}
.ask-question-text {
	font-size: var(--lnk-text-md);
	font-weight: var(--lnk-weight-semibold);
	line-height: var(--lnk-lh-md);
	color: var(--lnk-text-primary);
}
.ask-skip {
	flex: none;
	padding: var(--lnk-space-1) var(--lnk-space-2);
	border: none;
	border-radius: var(--lnk-radius-sm);
	background: none;
	color: var(--lnk-text-muted);
	font-family: inherit;
	font-size: var(--lnk-text-sm);
	cursor: pointer;
	transition: color var(--lnk-duration-instant) var(--lnk-ease-standard);
}
.ask-skip:hover:not(:disabled) {
	color: var(--lnk-text-primary);
}
.ask-skip:focus-visible {
	outline: 2px solid var(--lnk-border-focus);
	outline-offset: 2px;
}
.ask-skip:disabled {
	color: var(--lnk-text-disabled);
	cursor: not-allowed;
}

/* ── 选项：全宽触控行（≥44px）；默认 sunken 井，选中翻面 + accent 对勾 ── */
.ask-options {
	display: flex;
	flex-direction: column;
	gap: var(--lnk-space-2);
}
.ask-chip {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--lnk-gap-inline);
	width: 100%;
	min-height: var(--lnk-touch-target);
	padding: var(--lnk-space-2) var(--lnk-space-3);
	border: 1px solid transparent;
	border-radius: var(--lnk-radius-lg);
	background: var(--lnk-surface-sunken);
	color: var(--lnk-text-primary);
	font-family: inherit;
	font-size: var(--lnk-text-base);
	font-weight: var(--lnk-weight-medium);
	text-align: left;
	cursor: pointer;
	transition: transform var(--lnk-duration-instant) var(--lnk-ease-standard), border-color var(--lnk-duration-fast) var(--lnk-ease-standard), background var(--lnk-duration-fast) var(--lnk-ease-standard);
}
@media (hover: hover) {
	.ask-chip:hover:not(:disabled) {
		border-color: var(--lnk-border-default);
	}
}
.ask-chip:active:not(:disabled) {
	transform: scale(0.98);
}
.ask-chip:focus-visible {
	outline: 2px solid var(--lnk-border-focus);
	outline-offset: 2px;
}
.ask-chip.is-selected {
	border-color: var(--lnk-accent-border);
	background: var(--lnk-surface-raised);
	box-shadow: 0 0 0 2px var(--lnk-accent-subtle);
}
.ask-chip:disabled {
	color: var(--lnk-text-disabled);
	cursor: not-allowed;
}
.ask-chip-check {
	flex: none;
	display: flex;
	align-items: center;
	justify-content: center;
	width: var(--lnk-space-5);
	height: var(--lnk-space-5);
	border-radius: var(--lnk-radius-full);
	background: var(--lnk-accent);
	color: var(--lnk-text-on-accent);
	opacity: 0;
	transform: scale(0.5);
	transition: opacity var(--lnk-duration-fast) var(--lnk-ease-standard), transform var(--lnk-duration-base) var(--lnk-ease-spring);
}
.ask-chip.is-selected .ask-chip-check {
	opacity: 1;
	transform: scale(1);
}
.ask-chip-check svg {
	width: var(--lnk-space-3);
	height: var(--lnk-space-3);
}
.ask-chip-other .ask-chip-label {
	color: var(--lnk-text-secondary);
}

/* ── 「其他」展开的输入编辑器：sunken 井 + focus 2px border-focus 外环（Input 规范） ── */
.ask-other-editor {
	display: flex;
	align-items: center;
	gap: var(--lnk-space-2);
	padding: var(--lnk-space-1) var(--lnk-space-1) var(--lnk-space-1) var(--lnk-space-3);
	border: 1px solid var(--lnk-border-default);
	border-radius: var(--lnk-radius-lg);
	background: var(--lnk-surface-sunken);
	transition: border-color var(--lnk-duration-fast) var(--lnk-ease-standard), box-shadow var(--lnk-duration-fast) var(--lnk-ease-standard);
}
.ask-other-editor:focus-within {
	border-color: var(--lnk-border-focus);
	box-shadow: 0 0 0 2px var(--lnk-border-focus);
}
.ask-other-input {
	flex: 1;
	min-width: 0;
	min-height: calc(var(--lnk-touch-target) - 2 * var(--lnk-space-1));
	border: none;
	background: none;
	color: var(--lnk-text-primary);
	font-family: inherit;
	font-size: var(--lnk-text-base);
}
.ask-other-input::placeholder {
	color: var(--lnk-text-muted);
}
.ask-other-input:focus {
	outline: none;
}
.ask-other-done {
	flex: none;
	padding: var(--lnk-space-2) var(--lnk-space-3);
	border: none;
	border-radius: var(--lnk-radius-full);
	background: var(--lnk-accent);
	color: var(--lnk-text-on-accent);
	font-family: inherit;
	font-size: var(--lnk-text-sm);
	font-weight: var(--lnk-weight-medium);
	cursor: pointer;
	transition: background var(--lnk-duration-fast) var(--lnk-ease-standard), transform var(--lnk-duration-instant) var(--lnk-ease-standard);
}
.ask-other-done:hover {
	background: var(--lnk-accent-hover);
}
.ask-other-done:active {
	transform: scale(0.98);
}
.ask-other-done:focus-visible {
	outline: 2px solid var(--lnk-border-focus);
	outline-offset: 2px;
}

/* ── multiSelect 确认：primary pill（每屏唯一主操作） ── */
.ask-multi-confirm {
	align-self: flex-start;
	min-height: var(--lnk-control-sm);
	padding: 0 var(--lnk-space-4);
	border: none;
	border-radius: var(--lnk-radius-full);
	background: var(--lnk-accent);
	color: var(--lnk-text-on-accent);
	font-family: inherit;
	font-size: var(--lnk-text-sm);
	font-weight: var(--lnk-weight-medium);
	cursor: pointer;
	transition: background var(--lnk-duration-fast) var(--lnk-ease-standard), transform var(--lnk-duration-instant) var(--lnk-ease-standard);
}
.ask-multi-confirm:hover {
	background: var(--lnk-accent-hover);
}
.ask-multi-confirm:active {
	transform: scale(0.98);
}
.ask-multi-confirm:focus-visible {
	outline: 2px solid var(--lnk-border-focus);
	outline-offset: 2px;
}

/* ── 跳过提示（可返回） ── */
.ask-skipped-note {
	display: flex;
	align-items: center;
	gap: var(--lnk-space-2);
	font-size: var(--lnk-text-sm);
	color: var(--lnk-text-muted);
}
.ask-unskip {
	padding: 0;
	border: none;
	background: none;
	color: var(--lnk-accent-text);
	font-family: inherit;
	font-size: var(--lnk-text-sm);
	cursor: pointer;
}
.ask-unskip:hover {
	text-decoration: underline;
	text-underline-offset: 2px;
}
.ask-unskip:focus-visible {
	outline: 2px solid var(--lnk-border-focus);
	outline-offset: 2px;
}

/* ── 静默链接区：逃生口存在但不争夺注意力 ── */
.ask-footnote {
	display: flex;
	flex-wrap: wrap;
	justify-content: center;
	gap: var(--lnk-space-1) var(--lnk-space-4);
	padding-top: var(--lnk-space-1);
}
.ask-partial,
.ask-cancel {
	padding: var(--lnk-space-1) var(--lnk-space-2);
	border: none;
	border-radius: var(--lnk-radius-sm);
	background: none;
	font-family: inherit;
	font-size: var(--lnk-text-sm);
	cursor: pointer;
	transition: color var(--lnk-duration-instant) var(--lnk-ease-standard);
}
.ask-partial {
	color: var(--lnk-accent-text);
	font-weight: var(--lnk-weight-medium);
}
.ask-cancel {
	color: var(--lnk-text-muted);
}
.ask-partial:hover,
.ask-cancel:hover {
	text-decoration: underline;
	text-underline-offset: 2px;
}
.ask-partial:focus-visible,
.ask-cancel:focus-visible {
	outline: 2px solid var(--lnk-border-focus);
	outline-offset: 2px;
}

/* ── 底部导航（sticky 底部；负 margin 盖住卡片内边距） ── */
.ask-nav {
	position: sticky;
	bottom: 0;
	z-index: 1;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--lnk-space-3);
	margin: 0 calc(-1 * var(--lnk-pad-card)) calc(-1 * var(--lnk-pad-card));
	padding: var(--lnk-space-3) var(--lnk-pad-card) var(--lnk-pad-card);
	border-top: 1px solid var(--lnk-border-subtle);
	background: var(--lnk-surface-raised);
}
.ask-nav-prev {
	min-height: var(--lnk-control-sm);
	padding: 0 var(--lnk-space-2);
	border: none;
	border-radius: var(--lnk-radius-sm);
	background: none;
	color: var(--lnk-text-secondary);
	font-family: inherit;
	font-size: var(--lnk-text-base);
	cursor: pointer;
	transition: color var(--lnk-duration-instant) var(--lnk-ease-standard);
}
.ask-nav-prev:hover:not(:disabled) {
	color: var(--lnk-text-primary);
}
.ask-nav-prev:disabled {
	color: var(--lnk-text-disabled);
	cursor: not-allowed;
}
.ask-nav-prev:focus-visible {
	outline: 2px solid var(--lnk-border-focus);
	outline-offset: 2px;
}
.ask-nav-next,
.ask-nav-submit {
	display: inline-flex;
	align-items: center;
	gap: var(--lnk-space-1);
	min-height: var(--lnk-control-md);
	padding: 0 var(--lnk-space-5);
	border: none;
	border-radius: var(--lnk-radius-full);
	background: var(--lnk-accent);
	color: var(--lnk-text-on-accent);
	font-family: inherit;
	font-size: var(--lnk-text-base);
	font-weight: var(--lnk-weight-medium);
	cursor: pointer;
	transition: background var(--lnk-duration-fast) var(--lnk-ease-standard), transform var(--lnk-duration-instant) var(--lnk-ease-standard);
}
.ask-nav-next:hover,
.ask-nav-submit:hover {
	background: var(--lnk-accent-hover);
}
.ask-nav-next:active,
.ask-nav-submit:active {
	transform: scale(0.98);
}
.ask-nav-next:focus-visible,
.ask-nav-submit:focus-visible {
	outline: 2px solid var(--lnk-border-focus);
	outline-offset: 2px;
}
.ask-next-check {
	width: var(--lnk-space-3);
	height: var(--lnk-space-3);
}

/* ── 动效降级（Design_system §2.9） ── */
@media (prefers-reduced-motion: reduce) {
	.ask-user-card *,
	.ask-user-card *::before,
	.ask-user-card *::after {
		animation-duration: 0.01ms !important;
		animation-iteration-count: 1 !important;
		transition-duration: 0.01ms !important;
	}
}
</style>
