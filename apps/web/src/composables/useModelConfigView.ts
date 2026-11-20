// 模型配置视图状态机（2026-11-20）：移动 MobileSheet 与 PC 锚定卡共用同一 push/pop 语义。
// iOS 导航隐喻：list → config → thinking/context，back 逐级回退；close/select 时 reset 复位。
import { computed, ref } from 'vue'

export type ModelConfigView = 'list' | 'config' | 'thinking' | 'context'

const VIEW_TITLES: Record<ModelConfigView, string> = {
  list: '选择模型',
  config: '模型配置',
  thinking: '思考强度',
  context: '上下文窗口',
}

export function useModelConfigView() {
  const view = ref<ModelConfigView>('list')
  const title = computed(() => VIEW_TITLES[view.value])
  const showBack = computed(() => view.value !== 'list')

  /** iOS push/pop：列表←配置←(思考强度|上下文窗口)。list 上是 no-op。 */
  function back() {
    if (view.value === 'config') view.value = 'list'
    else if (view.value === 'thinking' || view.value === 'context') view.value = 'config'
  }

  /** 进入配置页（齿轮入口）。 */
  function openConfig() {
    view.value = 'config'
  }

  /** 关闭弹层 / 选择模型后复位：下次打开从列表起。 */
  function reset() {
    view.value = 'list'
  }

  return { view, title, showBack, back, openConfig, reset }
}
