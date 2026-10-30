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
  /**
   * 隐藏底部提示行（「可在提示词卡片上「编辑」后确认」）。
   *
   * ⭐ R4-T1（2026-10-23）新增，**默认 false ⇒ PC 行为逐字节不变**。
   *   移动端瓦片复用本组件，但移动端的编辑入口在编辑 sheet、不在卡片上
   *   ⇒ 那句 PC 语境提示在移动端是错的 ⇒ 由移动端传 `hide-hint` 关掉。
   *
   *   ⛔ 刻意做成 prop 而不是移动端用 CSS `:deep()` 隐藏——靠样式藏别人的文案
   *   在 PC 改文案时会露出不相关内容，且 jsdom 不计算 scoped 样式（测不到）。
   */
  hideHint?: boolean
  /**
   * P0-2（规格 2026-10-30-propose-confirm-execution-unity §4.3）：part 锚强制可见。
   *
   * 等待期节点 status 恒 draft（update_node{pending_confirm} 随 tool_result 迟到，
   * 2026-10-29 生产事故），仅按 status 门控会让提议 prompt 在磁贴上消失。调用方
   * 传「该节点被 proposal part（waiting_user 事件）锚定」的真值即可在等待期渲染。
   * 缺省 false ⇒ 旧行为逐字节不变。
   */
  proposeWaiting?: boolean
}>()

const text = computed(() => String(props.prompt ?? '').trim())
const visible = computed(
  () =>
    (props.proposeWaiting === true || String(props.status ?? '') === NODE_PENDING_CONFIRM_STATUS) &&
    text.value.length > 0,
)
const labelText = computed(() => String(props.label ?? '').trim())
</script>

<template>
  <div v-if="visible" class="node-pending-prompt nodrag" data-testid="node-pending-prompt">
    <span class="node-pending-prompt-chip" data-testid="node-pending-prompt-chip">待确认</span>
    <p v-if="labelText" class="node-pending-prompt-label">{{ labelText }}</p>
    <p class="node-pending-prompt-text" data-testid="node-pending-prompt-text">{{ text }}</p>
    <p v-if="!hideHint" class="node-pending-prompt-hint">可在提示词卡片上「编辑」后确认</p>
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
