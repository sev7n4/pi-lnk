<script setup lang="ts">
import { ref } from 'vue'
/**
 * ask_user 选项卡组件（spec docs/superpowers/specs/2026-09-28-ask-user-tool-design.md §5.3）。
 * AgentSideRail canvas_command 分支收到 type=ask_user 时渲染本组件；
 * 单选：点 chip 即回传；多选（multiSelect）：点选切换 + 确认按钮按空格拼接回传（D2）；
 * 「其他」输入自由文本回传；emit('cancel') 让 agent 退回开放问（D4）。
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
	select: [value: string]
	cancel: []
}>()

const otherText = ref<Record<string, string>>({})
const multiSelected = ref<Record<string, string[]>>({})

function isSelected(qid: string, value: string) {
	return multiSelected.value[qid]?.includes(value) ?? false
}
function toggleMulti(q: AskUserQuestion, value: string) {
	const prev = multiSelected.value[q.id] ?? []
	multiSelected.value[q.id] = prev.includes(value)
		? prev.filter((v) => v !== value)
		: [...prev, value]
}
function confirmMulti(q: AskUserQuestion) {
	const values = multiSelected.value[q.id] ?? []
	if (values.length) emit('select', values.join(' '))
}
function pick(value: string) {
	emit('select', value)
}
function submitOther(qid: string) {
	const text = otherText.value[qid]?.trim()
	if (text) emit('select', text)
}
</script>

<template>
	<div class="ask-user-card">
		<div v-for="q in props.questions" :key="q.id" class="ask-question">
			<div class="ask-question-text">{{ q.question }}</div>
			<div class="ask-options">
				<button
					v-for="opt in q.options"
					:key="opt.value"
					type="button"
					class="ask-chip"
					:class="{ 'is-selected': q.multiSelect && isSelected(q.id, opt.value) }"
					@click="q.multiSelect ? toggleMulti(q, opt.value) : pick(opt.value)"
				>{{ opt.label }}</button>
			</div>
			<button
				v-if="q.multiSelect && (multiSelected[q.id]?.length ?? 0) > 0"
				type="button"
				class="ask-multi-confirm"
				@click="confirmMulti(q)"
			>确认（已选 {{ (multiSelected[q.id] ?? []).length }} 项）</button>
			<div v-if="q.allowOther !== false" class="ask-other">
				<input
					v-model="otherText[q.id]"
					type="text"
					class="ask-other-input"
					placeholder="其他（请说明）"
					@keyup.enter="submitOther(q.id)"
				/>
				<button type="button" class="ask-other-submit" @click="submitOther(q.id)">提交</button>
			</div>
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
.ask-multi-confirm {
	align-self: flex-start;
	padding: 4px 12px;
	border: none;
	border-radius: 6px;
	background: var(--neo-accent);
	color: #fff;
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
</style>
