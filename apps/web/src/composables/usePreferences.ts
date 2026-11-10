import { ref, watch } from 'vue'

/**
 * 用户偏好（移动端为主）：当前仅 `haptics`（触感反馈）一项，后续可扩展。
 * 持久化到 localStorage（key `lnkpi.preferences`），无后端账户同步（N-5：v1 仅本地）。
 * 模块级单例 Ref：所有调用方共享同一份状态（设置页与组件读写的就是同一对象）。
 */

const KEY = 'lnkpi.preferences'

export interface Preferences {
  /** 触感反馈总开关；缺省视为开（R-C6） */
  haptics: boolean
}

const DEFAULTS: Preferences = { haptics: true }

function load(): Preferences {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<Preferences>
    const haptics = typeof parsed?.haptics === 'boolean' ? parsed.haptics : DEFAULTS.haptics
    return { haptics }
  } catch {
    // 损坏 JSON / 隐私模式不可读 ⇒ 回落默认，绝不抛错
    return { ...DEFAULTS }
  }
}

const state = ref<Preferences>(load())

watch(
  state,
  (v) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(v))
    } catch {
      /* 隐私模式 / 配额超限：忽略，内存态仍生效 */
    }
  },
  { deep: true },
)

export function usePreferences() {
  return state
}

/** 仅供单测：清空内存态与持久化，回落默认 */
export function __resetForTest() {
  localStorage.clear()
  state.value = { ...DEFAULTS }
}
