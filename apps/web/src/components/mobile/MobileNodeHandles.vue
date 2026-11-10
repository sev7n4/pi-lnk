<script setup lang="ts">
import { Handle, Position, useNodeId } from '@vue-flow/core'
import './MobileNodeHandles.css'

/**
 * `useNodeId()` 在真实画布节点内返回该节点的 id；在孤立挂载（无 VueFlow 节点上下文，
 * 如组件库预览 / 旧版单测）下返回 ""。手柄只在确属 VueFlow 节点时渲染，
 * 既保护非画布挂载不崩，也避免把无意义手柄挂到节点外。
 */
const nodeId = useNodeId()


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
