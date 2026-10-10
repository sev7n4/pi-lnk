<script setup lang="ts">
import { computed, ref } from 'vue'
/**
 * ask_user 选项卡组件（spec docs/superpowers/specs/2026-09-28-ask-user-tool-design.md §5.3；
 * B-6 点选与提交分离）：单问题卡点 chip 即 emit submit（低摩擦主路径）；
 * 多问题卡点选只高亮，答满（含 skipped）自动 submit 全部答案；
 * 多选（multiSelect，D2）：点选切换 + 显式确认按钮，值数组回传；
 * 「其他」自由文本：单问题卡回车/提交即 emit submit，多问题卡写入 singleSelected 后 tryAutoSubmit；
 * emit('cancel') 让 agent 退回开放问（D4）。
 * 样式走 --neo-* token（暗/亮主题自适应，禁用裸色值 fallback）。
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
/** 单选暂存：多问题卡点选不即发；单问题卡点选即发（B-6 主路径低摩擦） */
const singleSelected = ref<Record<string, string>>({})
const skipped = ref<Set<string>>(new Set())

const answeredCount = computed(() =>
	props.questions.filter(
		(q) =>
			skipped.value.has(q.id) ||
			singleSelected.value[q.id] ||
			(multiSelected.value[q.id]?.length ?? 0) > 0,
	).length,
)

function tryAutoSubmit() {
	if (props.questions.length <= 1) return // 单问题卡由点击直接提交
	if (answeredCount.value === props.questions.length) doSubmit()
}
function doSubmit() {
	const answers: Record<string, string[]> = {}
	for (const q of props.questions) {
		if (skipped.value.has(q.id)) continue
		const v = multiSelected.value[q.id] ?? (singleSelected.value[q.id] ? [singleSelected.value[q.id]] : [])
		if (v.length) answers[q.id] = v
	}
	emit('submit', { answers, ...(skipped.value.size ? { skipped: [...skipped.value] } : {}) })
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
	// 多问题卡内 multiSelect 确认后也走 tryAutoSubmit（可能补齐最后一题触发自动提交）
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
	// 单问题卡 tryAutoSubmit 不适用（无「答满补齐」路径）→ 直接提交全 skipped，
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
		<div v-if="props.questions.length > 1" class="ask-progress">已答 {{ answeredCount }}/{{ props.questions.length }}</div>
		<div v-for="q in props.questions" :key="q.id" class="ask-question">
			<div class="ask-question-text">{{ q.question }}</div>
			<div class="ask-options">
				<button
					v-for="opt in q.options"
					:key="opt.value"
					type="button"
					class="ask-chip"
					:class="{ 'is-selected': q.multiSelect ? isSelected(q.id, opt.value) : singleSelected[q.id] === opt.value }"
					:disabled="skipped.has(q.id)"
					@click="pick(q, opt.value)"
				>{{ opt.label }}</button>
			</div>
			<button
				v-if="q.multiSelect && (multiSelected[q.id]?.length ?? 0) > 0"
				type="button"
				class="ask-multi-confirm"
				@click="confirmMulti()"
			>确认（已选 {{ (multiSelected[q.id] ?? []).length }} 项）</button>
			<div v-if="q.allowOther !== false" class="ask-other">
				<input
					v-model="otherText[q.id]"
					type="text"
					class="ask-other-input"
					placeholder="其他（请说明）"
					@keyup.enter="submitOther(q)"
				/>
				<button type="button" class="ask-other-submit" @click="submitOther(q)">提交</button>
			</div>
			<button type="button" class="ask-skip" :class="{ 'is-skipped': skipped.has(q.id) }" @click="skip(q)">
				{{ skipped.has(q.id) ? '已跳过' : '跳过此题' }}
			</button>
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
}
.ask-progress {
	font-size: 12px;
	color: var(--neo-text-muted);
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
</style>
