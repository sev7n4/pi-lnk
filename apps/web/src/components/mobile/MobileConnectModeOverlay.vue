<script setup lang="ts">
import { useMobileNodeConnect } from '@/composables/useMobileNodeConnect'
import { useHaptics } from '@/composables/useHaptics'
import './MobileConnectModeOverlay.css'

/**
 * 移动端连线模式浮层（R-C1 / R-C4）。
 *
 * 点源 `+` 进入「连线模式」后，全画布浮出「选择要连接的目标」提示 + 一个「取消」出口
 * （R-C4 三选一之一；另两选：再点源 `+` 由手柄处理 / 点空白画布由 CanvasPage `@pane-click`
 * 处理）。
 *
 * 视觉层级：**非阻塞**提示——wrapper `pointer-events:none`，仅提示条 / 取消按钮恢复
 * `pointer-events:auto`，故不阻挡用户点目标节点完成连线（R-C2）。
 *
 * 触感：进入模式触感（connectModeEnter）由手柄点击点发出（更贴近用户手势），此处不再
 * 重复触发，避免 Android 双震；取消触感（connectCancel）在此处统一发出。
 */
const connect = useMobileNodeConnect()
const haptics = useHaptics()

function onCancel() {
  connect.cancel()
  haptics.fire('connectCancel')
}
</script>

<template>
  <div
    v-if="connect.pendingSource.value"
    class="connect-mode-overlay"
    data-testid="connect-mode-overlay"
  >
    <div class="connect-mode-pill" role="status" aria-live="polite">
      <span class="connect-mode-text">选择要连接的目标</span>
      <button
        type="button"
        class="connect-mode-cancel"
        data-testid="connect-mode-cancel"
        @click.stop="onCancel"
      >
        取消
      </button>
    </div>
  </div>
</template>
