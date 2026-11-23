<script setup lang="ts">
/**
 * 授权自动生成 · 面板（说明 + 开关）——规格 `docs/superpowers/specs/2026-11-22-generation-auto-approve-gate-design.md` §11。
 *
 * ⭐ 为什么独立一个组件：同一段**说明 + 开关**要出现在两个容器里——
 * PC = composer 工具行胶囊的锚定浮层（`.neo-popover`）；移动 = 底部 Sheet（`MobileSheet`）。
 * 文案与开关是「一个能力的两处落点」，必须单源 ⇒ 抽成本组件，两处各渲染一次（禁复制文案）。
 *
 * ⭐ 令牌纪律：零新令牌。琥珀三件套（`--lnk-warning` / `--lnk-warning-bg` / `--lnk-warning-border`）
 * 双主题已存在；开关轨道/旋钮走 `styles/main.css` 的**共享段**（与 PC 设置弹窗、移动「我的→设置」
 * 两处既有开关同一实现 ⇒ 同一能力全站同色同规格）。
 */
withDefaults(defineProps<{ authorized?: boolean }>(), { authorized: false })

const emit = defineEmits<{ toggle: [] }>()
</script>

<template>
  <div class="auto-approve-panel">
    <!-- 作用域必须写清：只有图片与音频免确认，视频始终逐次确认。
         否则用户会误以为「所有生成（含写操作）」都免确认 —— 那是越权承诺。 -->
    <p class="auto-approve-panel-desc" data-testid="auto-approve-panel-desc">
      {{
        authorized
          ? '当前为自动生成：agent 生成图片与音频时将直接执行并扣除积分，不再逐次确认；视频仍会逐次确认。'
          : '当前每次生成都会先问你。开启后，agent 生成图片与音频时将直接执行并扣除积分；视频仍会逐次确认。'
      }}
    </p>
    <div class="auto-approve-panel-sep" />
    <div class="auto-approve-panel-row">
      <span class="auto-approve-panel-row-label">自动生成</span>
      <button
        type="button"
        role="switch"
        class="auto-approve-switch"
        :aria-checked="authorized"
        :aria-label="
          authorized
            ? '收回授权，恢复每次确认'
            : '授权自动生成，后续图片与音频卡片不再逐次确认'
        "
        data-testid="auto-approve-panel-switch"
        @click="emit('toggle')"
      >
        <span class="auto-approve-knob" />
      </button>
    </div>
    <p class="auto-approve-panel-foot">仅在可信任务中保持开启</p>
  </div>
</template>

<style scoped>
.auto-approve-panel-desc {
  margin: 0;
  font-size: var(--lnk-text-xs);
  line-height: var(--lnk-lh-xs);
  color: var(--lnk-text-secondary);
}

.auto-approve-panel-sep {
  height: 0.5px;
  margin: 10px 0;
  background: var(--lnk-border-subtle);
}

.auto-approve-panel-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.auto-approve-panel-row-label {
  font-size: var(--lnk-text-xs);
  color: var(--lnk-text-primary);
}

.auto-approve-panel-foot {
  margin: 10px 0 0;
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  color: var(--lnk-text-muted);
}
</style>
