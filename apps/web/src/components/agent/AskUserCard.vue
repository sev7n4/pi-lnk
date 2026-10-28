<script setup lang="ts">
import { computed, ref } from 'vue'
/**
 * ask_user 选项卡组件（spec 2026-10-28-askuser-mobile-multi-question-redesign）：
 * - 单问题卡（length===1）：点 chip 即 emit submit（低摩擦主路径，B-6 不变）。
 * - 多问题卡（length>1）：**分页单题推进**（吸上游 questionnaire.ts 范式，T1）——一次只显示一题，
 *   顶部进度（第 X/N 题 · 已答 A/N），底部导航（上一题 / 下一题 / 提交）。答案按 qid 跨页保留。
 * - T0：卡片自身 max-height + overflow-y:auto（有界可滚），导航钮 sticky 常驻，杜绝高度溢出到 tab 栏。
 * - T2：多题卡提供「提交已答部分」逃生钮，已答 A<N 时显式交还已答部分（其余隐式 skipped）。
 * - 多题自动提交保留（答满即 emit），与显式提交双路径（S3）。
 * 样式走既有 --neo-* / --lnk-* 令牌（暗/亮主题自适应）。
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

/** T1 多题：答满自动提交（保留既有契约 S3）；单题卡由点击直接提交，不走此路径 */
function tryAutoSubmit() {
	if (props.questions.length <= 1) return
	if (answeredCount.value === props.questions.length) doSubmit()
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
	// 多题卡内 multiSelect 确认后也走 tryAutoSubmit（可能补齐最后一题触发自动提交）
	if (props.questions.length === 1) {
		doSubmit()
		return
	}
	tryAutoSubmit()
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
	singleSelected.value[q.id] = value
	tryAutoSubmit()
}
function skip(q: AskUserQuestion) {
	skipped.value.add(q.id)
	// 单题卡 tryAutoSubmit 不适用（无「答满补齐」路径）→ 直接提交全 skipped，
	// 否则 skip 后卡片挂死只能等超时（fix round 1 Finding 1）
	if (props.questions.length === 1) {
		doSubmit()
		return
	}
	tryAutoSubmit()
}
function submitOther(q: AskUserQuestion) {
	const text = otherText.value[q.id]?.trim()
	if (!text) return
	if (props.questions.length === 1) {
		emit('submit', { answers: { [q.id]: [text] } })
		return
	}
	singleSelected.value[q.id] = text
	tryAutoSubmit()
}
</script>

<template>
	<div class="ask-user-card">
		<!-- 多题：进度（T1） -->
		<div v-if="isMulti" class="ask-progress">
			<span>第 {{ currentIndex + 1 }} / {{ props.questions.length }} 题</span>
			<span class="ask-progress-count">已答 {{ answeredCount }} / {{ props.questions.length }}</span>
		</div>

		<!-- 当前题（单题卡即唯一题；多题卡即 current） -->
		<div class="ask-question" :key="current.id">
			<div class="ask-question-text">{{ current.question }}</div>
			<div class="ask-options">
				<button
					v-for="opt in current.options"
					:key="opt.value"
					type="button"
					class="ask-chip"
					:class="{ 'is-selected': current.multiSelect ? isSelected(current.id, opt.value) : singleSelected[current.id] === opt.value }"
					:disabled="skipped.has(current.id)"
					@click="pick(current, opt.value)"
				>{{ opt.label }}</button>
			</div>
			<button
				v-if="current.multiSelect && (multiSelected[current.id]?.length ?? 0) > 0"
				type="button"
				class="ask-multi-confirm"
				@click="confirmMulti()"
			>确认（已选 {{ (multiSelected[current.id] ?? []).length }} 项）</button>
			<div v-if="current.allowOther !== false" class="ask-other">
				<input
					v-model="otherText[current.id]"
					type="text"
					class="ask-other-input"
					placeholder="其他（请说明）"
					@keyup.enter="submitOther(current)"
				/>
				<button type="button" class="ask-other-submit" @click="submitOther(current)">提交</button>
			</div>
			<button type="button" class="ask-skip" :class="{ 'is-skipped': skipped.has(current.id) }" @click="skip(current)">
				{{ skipped.has(current.id) ? '已跳过' : '跳过此题' }}
			</button>
		</div>

		<!-- 多题：底部固定导航（T1）+ 逃生钮（T2） -->
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
			>下一题</button>
			<button
				v-else
				type="button"
				class="ask-nav-submit"
				@click="doSubmit()"
			>提交</button>
			<button
				v-if="answeredCount > 0 && answeredCount < props.questions.length"
				type="button"
				class="ask-partial"
				@click="submitPartial()"
			>提交已答部分（{{ answeredCount }}）</button>
		</div>

		<button type="button" class="ask-cancel" @click="emit('cancel')">取消选项，自行描述</button>
	</div>
</template>

<style scoped>
.ask-user-card {
	display: flex;
	flex-direction: column;
	gap: 12px;
	padding: 12px;
	border: 1px solid var(--neo-border-strong);
	border-radius: 10px;
	background: var(--neo-surface-card);
	color: var(--neo-text-primary);
	/* T0：有界可滚兜底——卡片自身高度受限、内部滚动，绝不依赖宿主滚动容器，
	   杜绝多题/长题干溢出到 tab 栏之下（根因 1 修复，spec §5.1）。 */
	max-height: min(60vh, 520px);
	min-height: 0;
	overflow-y: auto;
}
.ask-progress {
	position: sticky;
	top: 0;
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding-bottom: 8px;
	font-size: 12px;
	color: var(--neo-text-muted);
	background: var(--neo-surface-card);
}
.ask-progress-count {
	font-variant-numeric: tabular-nums;
}
.ask-question {
	display: flex;
	flex-direction: column;
	gap: 6px;
}
.ask-question-text {
	font-size: 13px;
	font-weight: 500;
	color: var(--neo-text-primary);
}
.ask-options {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
}
.ask-chip {
	padding: 4px 12px;
	border: 1px solid var(--neo-border-strong);
	border-radius: 999px;
	background: var(--neo-surface-elevated);
	color: var(--neo-text-primary);
	font-size: 12px;
	cursor: pointer;
	transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.ask-chip:hover {
	border-color: var(--neo-accent-border);
	background: var(--neo-accent-soft);
}
.ask-chip.is-selected {
	border-color: var(--neo-accent-border);
	background: var(--neo-accent-soft);
	color: var(--neo-accent-text);
}
.ask-chip:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}
.ask-multi-confirm {
	align-self: flex-start;
	padding: 4px 12px;
	border: none;
	border-radius: 6px;
	background: var(--neo-accent);
	color: var(--lnk-text-on-accent);
	font-size: 12px;
	cursor: pointer;
	transition: background 0.15s;
}
.ask-multi-confirm:hover {
	background: var(--neo-accent-hover);
}
.ask-other {
	display: flex;
	gap: 6px;
}
.ask-other-input {
	flex: 1;
	min-width: 0;
	padding: 5px 8px;
	border: 1px solid var(--neo-border-strong);
	border-radius: 6px;
	background: var(--neo-surface-elevated);
	color: var(--neo-text-primary);
	font-size: 12px;
}
.ask-other-input::placeholder {
	color: var(--neo-text-muted);
}
.ask-other-submit,
.ask-cancel {
	padding: 4px 10px;
	border: 1px solid var(--neo-border-strong);
	border-radius: 6px;
	background: var(--neo-surface-elevated);
	color: var(--neo-text-secondary);
	font-size: 12px;
	cursor: pointer;
	transition: color 0.15s, border-color 0.15s;
}
.ask-other-submit:hover,
.ask-cancel:hover {
	color: var(--neo-text-primary);
	border-color: var(--neo-accent-border);
}
.ask-cancel {
	align-self: flex-start;
	margin-top: 2px;
}
.ask-skip {
	align-self: flex-start;
	padding: 2px 0;
	border: none;
	background: none;
	color: var(--neo-text-muted);
	font-size: 12px;
	cursor: pointer;
	transition: color 0.15s;
}
.ask-skip:hover {
	color: var(--neo-text-primary);
}
.ask-skip.is-skipped {
	color: var(--neo-text-muted);
	cursor: default;
	text-decoration: line-through;
}
/* T1 底部导航：sticky 常驻可见，长内容滚动时提交/翻页钮不丢失 */
.ask-nav {
	position: sticky;
	bottom: 0;
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	align-items: center;
	padding-top: 10px;
	margin-top: 2px;
	border-top: 1px solid var(--neo-border-strong);
	background: var(--neo-surface-card);
}
.ask-nav-prev,
.ask-nav-next,
.ask-nav-submit {
	min-height: 38px;
	padding: 6px 16px;
	border: 1px solid var(--neo-border-strong);
	border-radius: 8px;
	background: var(--neo-surface-elevated);
	color: var(--neo-text-primary);
	font-size: 13px;
	font-weight: 500;
	cursor: pointer;
	transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.ask-nav-prev:disabled {
	opacity: 0.4;
	cursor: not-allowed;
}
.ask-nav-next,
.ask-nav-submit {
	border-color: var(--neo-accent-border);
	background: var(--neo-accent);
	color: var(--lnk-text-on-accent);
}
.ask-nav-next:hover:not(:disabled),
.ask-nav-submit:hover {
	background: var(--neo-accent-hover);
}
/* T2 逃生钮：已答部分提交，次级样式（accent 描边 + 软底） */
.ask-partial {
	min-height: 38px;
	padding: 6px 14px;
	border: 1px solid var(--neo-accent-border);
	border-radius: 8px;
	background: var(--neo-accent-soft);
	color: var(--neo-accent-text);
	font-size: 12px;
	font-weight: 500;
	cursor: pointer;
	transition: background 0.15s;
}
.ask-partial:hover {
	background: var(--neo-accent-soft);
}
</style>
