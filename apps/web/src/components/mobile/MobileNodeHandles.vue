<script setup lang="ts">
import { computed } from 'vue'
import { Handle, Position, useNodeId } from '@vue-flow/core'
import { useMobileNodeConnect } from '@/composables/useMobileNodeConnect'
import { useHaptics } from '@/composables/useHaptics'
import './MobileNodeHandles.css'

/**
 * `useNodeId()` 在真实画布节点内返回该节点的 id；在孤立挂载（无 VueFlow 节点上下文，
 * 如组件库预览 / 旧版单测）下返回 ""。手柄只在确属 VueFlow 节点时渲染，
 * 既保护非画布挂载不崩，也避免把无意义手柄挂到节点外。
 */
const nodeId = useNodeId()

/**
 * 连线模式状态机（模块级单例，见 useMobileNodeConnect）：点源 + 进入模式、再点同一源取消。
 * 本组件只消费 `enter` / `cancel` + 触感反馈；落库通道由 CanvasPage 注册，无需 inject。
 */
const connect = useMobileNodeConnect()
const haptics = useHaptics()

/**
 * 连线态视觉提示（M-1 / A-2）：进入模式后所有节点左锚发光（提示可连）、源节点脉冲高亮。
 * 仅消费令牌（R-C9），不阻挡瓦片点击（pointer-events 由 .css 控制）。
 */
const isLinking = computed(() => !!connect.pendingSource.value)
const isSource = computed(
  () => !!nodeId && connect.pendingSource.value === nodeId,
)

/**
 * 点源 + ：进入连线模式（R-C1）；再次点击同一源 ⇒ 取消（R-C4 三选一之一）。
 * 用覆盖层 div 拦截点击：既捕获点按进入模式，又 `.stop` 阻止 VueFlow 原生 click-connect
 * 与我们的状态机并发（VueFlow 的 Handle 根自带 onClick=handleClick，父子同元素，
 * 父层 `.stop` 无法拦截子层监听 ⇒ 必须在子元素上拦截）。
 */
function onPlusClick() {
  if (!nodeId) return
  if (connect.pendingSource.value === nodeId) {
    connect.cancel()
    haptics.fire('connectCancel')
  } else {
    connect.enter(nodeId)
    haptics.fire('connectModeEnter')
  }
}


/**
 * 移动端节点连线锚点（修复 P3：MobileCanvasEdge.css 自注"锚点退化——MobileNodeTile 无 Handle"）。
 *
 * ⭐ 与 PC `NeoBaseNode.vue:272-295` 同 id / 同 position：
 *   - `id="target"` `Position.Left`  —— 下游节点的入边锚（左侧）
 *   - `id="source"` `Position.Right` —— 上游节点的出边锚（右侧）
 *   ⇒ 直接复用既有边的 `sourceHandle:'source'` / `targetHandle:'target'`
 *     （CanvasPage.vue:1528-1529），存量边无需迁移即可从 A 右 → B 左路由。
 *
 * 外层垫一个满尺寸的 `.neo-node-wrapper` + 常驻 `.show-handles`：
 *   - 直接复用 PC 全套手柄样式（neo-node.css 的 `.neo-node-wrapper .vue-flow__handle.neo-flow-handle`
 *     体系），视觉与 PC 一致；
 *   - `.show-handles` 让圆形 + 号常显且命中区可点（触摸无 hover，常驻即 hover 等价物）。
 *
 * 移动端差异化覆盖见 MobileNodeHandles.css：
 *   - wrapper `position:absolute; inset:0` 铺满瓦片，且 `pointer-events:none` 让瓦片主体仍可点开查看器；
 *   - 仅手柄 / 命中区显式恢复 `pointer-events:auto`，所以拖手柄=连线、点瓦片主体=打开，互不冲突；
 *   - 命中区收到 44px 触控标准（比 PC 的 ~72px 收一档），减小对瓦片正文的误触。
 */
</script>

<template>
  <div
    v-if="nodeId"
    class="neo-node-wrapper mobile-node-connect-wrap show-handles"
    :class="{ 'is-link-mode': isLinking, 'is-source': isSource }"
    data-testid="mobile-node-handles"
  >
    <Handle id="target" type="target" :position="Position.Left" class="neo-flow-handle">
      <div class="handle-hitbox" />
      <div class="handle-plus">
        <div class="handle-plus-inner" />
      </div>
    </Handle>
    <Handle id="source" type="source" :position="Position.Right" class="neo-flow-handle">
      <div class="handle-hitbox" />
      <div class="handle-plus">
        <div class="handle-plus-inner" />
      </div>
      <div
        class="handle-tap-catch"
        role="button"
        :aria-label="connect && connect.pendingSource.value === nodeId ? '取消连线' : '进入连线模式'"
        @click.stop="onPlusClick"
      />
    </Handle>
  </div>
</template>

<style scoped>
/* wrapper 满铺瓦片并让出指针事件；手柄可点性由 MobileNodeHandles.css 显式恢复。
 * 此处 scoped 仅兜底本地结构，主覆盖放全局 css 以压过 neo-node.css。 */
.mobile-node-connect-wrap {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
</style>
