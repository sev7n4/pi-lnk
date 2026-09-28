<script setup lang="ts">
import { ref } from 'vue'
/**
 * ask_user 选项卡组件（spec docs/superpowers/specs/2026-09-28-ask-user-tool-design.md §5.3）。
 * AgentSideRail canvas_command 分支收到 type=ask_user 时渲染本组件；
 * 用户点 chip 或提交"其他"→ emit('select', value)，AgentSideRail 监听调 sendMessage；
 * emit('cancel') 让 agent 退回开放问（D4 已拍板带取消）。
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
					@click="pick(opt.value)"
				>{{ opt.label }}</button>
			</div>
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
		<button type="button" class="ask-cancel" @click="emit('cancel')">取消</button>
	</div>
</template>

<style scoped>
.ask-user-card {
	display: flex;
	flex-direction: column;
	gap: 12px;
	padding: 12px;
	border: 1px solid var(--border-color, #e5e7eb);
	border-radius: 8px;
	background: var(--bg-secondary, #f9fafb);
}
.ask-question {
	display: flex;
	flex-direction: column;
	gap: 6px;
}
.ask-question-text {
	font-size: 13px;
	font-weight: 500;
}
.ask-options {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
}
.ask-chip {
	padding: 4px 10px;
	border: 1px solid var(--border-color, #d1d5db);
	border-radius: 999px;
	background: var(--bg-primary, #fff);
	font-size: 12px;
	cursor: pointer;
	transition: background 0.15s;
}
.ask-chip:hover {
	background: var(--accent-bg, #eff6ff);
	border-color: var(--accent-color, #3b82f6);
}
.ask-other {
	display: flex;
	gap: 6px;
}
.ask-other-input {
	flex: 1;
	padding: 4px 8px;
	border: 1px solid var(--border-color, #d1d5db);
	border-radius: 4px;
	font-size: 12px;
}
.ask-other-submit,
.ask-cancel {
	padding: 4px 10px;
	border: 1px solid var(--border-color, #d1d5db);
	border-radius: 4px;
	background: var(--bg-primary, #fff);
	font-size: 12px;
	cursor: pointer;
}
.ask-cancel {
	align-self: flex-start;
	margin-top: 4px;
}
</style>
