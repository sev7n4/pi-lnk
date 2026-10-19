<script setup lang="ts">
/**
 * 待确认节点的提示词摘要（ADR-0011 决定 1，2026-10-20 补齐）。
 *
 * 为什么必须有：T4 把 studio dock 对 `pending_confirm` 门控后，dock 里的提示词编辑区
 * 不再随选中弹出；而节点本体原先只有「上传 / 等待生成」占位文案 —— 于是用户在画布上
 * **看不到这次提议的提示词**，「先看提示词再确认」的链路断掉（2026-10-20 真机截图复现：
 * 待确认节点是一张空卡，只有上传图标）。本组件把摘要渲染回节点本体，让节点真正成为
 * 单一锚定表面：看提示词在节点上，改提示词点浮层的「编辑」，确认 / 取消也在浮层。
 *
 * 只读摘要：不提供就地编辑（编辑入口统一走 ProposeConfirmOverlay「编辑」→ dock，
 * 避免两套编辑语义）。比例 / 分辨率 / 张数等参数由 dock 的设置面板承载，不在此重复。
 */
import { computed } from 'vue'
import { NODE_PENDING_CONFIRM_STATUS } from '@/constants/dockStudio'

const props = defineProps<{
  /** 节点提示词（propose 流程建节点时写入 data.prompt） */
  prompt?: string
  /** 节点标签（可选，作为摘要上方的上下文行） */
  label?: string
  /** 节点状态；仅 pending_confirm 渲染 */
  status?: string
}>()

const text = computed(() => String(props.prompt ?? '').trim())
const visible = computed(() => String(props.status ?? '') === NODE_PENDING_CONFIRM_STATUS && text.value.length > 0)
const labelText = computed(() => String(props.label ?? '').trim())
</script>

<template>
  <div v-if="visible" class="node-pending-prompt nodrag" data-testid="node-pending-prompt">
    <span class="node-pending-prompt-chip" data-testid="node-pending-prompt-chip">待确认</span>
    <p v-if="labelText" class="node-pending-prompt-label">{{ labelText }}</p>
    <p class="node-pending-prompt-text" data-testid="node-pending-prompt-text">{{ text }}</p>
    <p class="node-pending-prompt-hint">可在提示词卡片上「编辑」后确认</p>
  </div>
</template>

<style scoped>
/* 颜色全部消费 --lnk-* 语义令牌（neoUsageRatchet 棘轮：新代码禁 --neo-*）。 */
.node-pending-prompt {
  display: flex;
  max-width: 100%;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 0 10px;
  text-align: left;
}
.node-pending-prompt-chip {
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--lnk-warning-border);
  border-radius: 9999px;
  background: var(--lnk-warning-bg);
  font-size: 10px;
  line-height: 15px;
  color: var(--lnk-warning);
}
.node-pending-prompt-label {
  max-width: 100%;
  margin: 0;
  overflow: hidden;
  font-size: 11px;
  line-height: 16px;
  color: var(--lnk-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 提示词正文：多行截断（5 行），完整内容在 dock「编辑」里看 / 改。 */
.node-pending-prompt-text {
  display: -webkit-box;
  max-width: 100%;
  margin: 0;
  overflow: hidden;
  font-size: 12px;
  line-height: 18px;
  color: var(--lnk-text-primary);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 5;
  line-clamp: 5;
}
.node-pending-prompt-hint {
  margin: 0;
  font-size: 10px;
  line-height: 14px;
  color: var(--lnk-text-muted);
}
</style>
