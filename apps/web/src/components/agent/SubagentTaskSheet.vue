<script setup lang="ts">
/**
 * 子代理任务详情面板（spec 2026-11-17 subagent SSE visibility，A 档）：
 * 展示派发给子代理的完整任务（折叠引用块）+ 状态/耗时 + 最终报告全文。
 * 结构仿 SkillPickSheet（sheet-head/body/close + role=dialog），零新设计令牌。
 * 断流/截断/degraded 显式标记，报告不完整时不冒充成功。
 */
import type { TimelinePart } from '@/components/agent/turnTimeline'

type SubagentPart = Extract<TimelinePart, { kind: 'subagent_task' }>

const props = defineProps<{
  part: SubagentPart
}>()

const emit = defineEmits<{
  close: []
}>()

const STATUS_LABEL: Record<SubagentPart['status'], string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  timeout: '超时',
  budget_exceeded: '超出预算',
  stream_interrupted: '结果中断',
  interrupted: '已中断',
}

function durationLabel(ms?: number): string {
  if (typeof ms !== 'number' || ms <= 0) return ''
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  return `${min}m${String(sec % 60).padStart(2, '0')}s`
}

const isIncomplete = () =>
  props.part.partial === true ||
  props.part.truncated === true ||
  props.part.status === 'stream_interrupted'
</script>

<template>
  <div class="subagent-task-sheet" role="dialog" aria-modal="true" aria-label="子代理任务详情" data-testid="subagent-task-sheet">
    <div class="sheet-head">
      <span class="sheet-title">{{ part.displayName }} 的任务</span>
      <button type="button" class="sheet-close" aria-label="关闭" data-testid="subagent-sheet-close" @click="emit('close')">
        <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
    <div class="sheet-body">
      <div class="task-block">
        <div class="block-caption">下发任务详情</div>
        <details class="task-details" data-testid="subagent-task-details">
          <summary class="task-summary-line">{{ part.taskSummary }}</summary>
          <pre class="task-full">{{ part.task }}</pre>
        </details>
      </div>

      <div class="status-row" data-testid="subagent-status-row">
        <span
          class="status-pill"
          :class="{ 'status-bad': ['failed', 'timeout', 'budget_exceeded', 'stream_interrupted', 'interrupted'].includes(part.status) }"
        >{{ STATUS_LABEL[part.status] }}</span>
        <span v-if="durationLabel(part.durationMs)" class="status-duration">{{ durationLabel(part.durationMs) }}</span>
        <span v-if="typeof part.turns === 'number'" class="status-duration">{{ part.turns }} 轮</span>
      </div>

      <div v-if="isIncomplete()" class="incomplete-hint" data-testid="subagent-incomplete-hint">
        报告不完整或已中断，结论请谨慎核实。
      </div>

      <div class="report-block">
        <div class="block-caption">最终报告</div>
        <pre v-if="part.report" class="report-full" data-testid="subagent-report">{{ part.report }}</pre>
        <p v-else-if="part.degraded" class="report-fallback" data-testid="subagent-degraded">结果已并入回复</p>
        <p v-else-if="part.status === 'running'" class="report-fallback" data-testid="subagent-still-running">子任务仍在运行，请稍后再看</p>
        <p v-else class="report-fallback" data-testid="subagent-no-report">（未收到报告）</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.subagent-task-sheet { display: flex; flex-direction: column; width: min(560px, 92vw); max-height: 70vh; }
.sheet-head { display: flex; align-items: center; justify-content: space-between; padding: var(--lnk-space-2) var(--lnk-space-3); border-bottom: 1px solid var(--lnk-border-subtle); }
.sheet-title { font-size: var(--lnk-text-sm); font-weight: 600; color: var(--lnk-text-primary); }
.sheet-close { appearance: none; border: 0; background: transparent; cursor: pointer; color: var(--lnk-text-muted); padding: var(--lnk-space-1); border-radius: var(--lnk-radius-sm); }
.sheet-body { flex: 1; overflow-y: auto; padding: var(--lnk-space-3); }
.block-caption { font-size: var(--lnk-text-xs); font-weight: 500; color: var(--lnk-text-muted); margin-bottom: var(--lnk-space-1); }
.task-block { margin-bottom: var(--lnk-space-3); }
.task-details { border: 1px solid var(--lnk-border-subtle); border-radius: var(--lnk-radius-md); background: var(--lnk-surface-raised); padding: var(--lnk-space-2); }
.task-summary-line { cursor: pointer; font-size: var(--lnk-text-sm); color: var(--lnk-text-primary); }
.task-full, .report-full { white-space: pre-wrap; word-break: break-word; font: inherit; font-size: var(--lnk-text-sm); color: var(--lnk-text-primary); margin: var(--lnk-space-2) 0 0; }
.status-row { display: flex; align-items: center; gap: var(--lnk-space-2); margin-bottom: var(--lnk-space-3); }
.status-pill { font-size: var(--lnk-text-xs); padding: 2px var(--lnk-space-2); border-radius: var(--lnk-radius-sm); background: var(--lnk-surface-canvas); color: var(--lnk-text-secondary); }
.status-pill.status-bad { color: var(--lnk-error); }
.status-duration { font-size: var(--lnk-text-xs); color: var(--lnk-text-muted); }
.incomplete-hint { font-size: var(--lnk-text-xs); color: var(--lnk-error); margin-bottom: var(--lnk-space-2); }
.report-block { border-top: 1px solid var(--lnk-border-subtle); padding-top: var(--lnk-space-3); }
.report-fallback { font-size: var(--lnk-text-sm); color: var(--lnk-text-muted); }
</style>
