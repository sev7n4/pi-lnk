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
  /**
   * 思考强度按模型种子（2026-11-20 模型配置页 AD3）。
   * key = `catalogModelKeyFromValue(modelValue)`（与 supportsThinkingLevel 能力判定同源），
   * value = 三档之一。切模型时查表一次性种入会话级单值，运行时仍单值下传（
   * 与 pi-runtime 的 SessionEntry.thinkingLevel 一一对应）——不是运行时 Map。
   */
  thinkingByModel?: Record<string, '标准' | '深入' | '极限'>
}

const DEFAULTS: Preferences = { haptics: true, thinkingByModel: {} }

function load(): Preferences {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<Preferences>
    const haptics = typeof parsed?.haptics === 'boolean' ? parsed.haptics : DEFAULTS.haptics
    // 损坏 / 非对象字段 ⇒ 回落空表，绝不把字符串/数组当表用
    const tbm = parsed?.thinkingByModel
    const thinkingByModel =
      tbm && typeof tbm === 'object' && !Array.isArray(tbm)
        ? (tbm as Record<string, '标准' | '深入' | '极限'>)
        : {}
    return { haptics, thinkingByModel }
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
