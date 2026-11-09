import { ref } from 'vue'

/** 移动端 composer 是否处于聚焦（输入）态——跨组件共享单例。
 *
 * 写入方：AgentSideRail（@focusin / @focusout 于 agent-input-dock）。
 * 读取方：MobileTabBar（聚焦态隐藏底部页签并回收其高度，让 SSE 对话流可见区更大）。
 *
 * 模块级单例：同一份响应式状态，避免 prop 透传；composer 与页签分属不同组件树分支。 */
const composerFocused = ref(false)

export function useMobileComposerFocus() {
  return composerFocused
}
