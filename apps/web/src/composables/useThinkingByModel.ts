import { catalogModelKeyFromValue } from '@/constants/studioModels'
import { type ThinkingLevel } from '@/components/agent/composer/thinkingLevels'
import { usePreferences } from './usePreferences'

/**
 * 思考强度按模型「种子」表（2026-11-20 模型配置页 AD3）。
 *
 * ⚠️ 语义边界（勿误改成运行时 Map）：
 *  - 上游 pi 内核 `AgentState.thinkingLevel` / `ConversationConfigState.thinkingLevel` 都是
 *    **会话级单值**；唯一 per-model 存储（pi-coding-agent 的 `modelThinkingLevels`）也只是
 *    **会话初始化种子**，解析后立即收敛为单一 level。
 *  - 本 composable 复刻该形态：持久层按模型 key 存种子，切模型时查表**一次性种入**
 *    composer 级单值，运行时仍单值下传（与 pi-runtime 的 SessionEntry.thinkingLevel 一一对应）。
 *  - 与 Claude Code `modelSettings.<model>.effortLevel` 同构（持久按模型 / 运行时单值）。
 *
 * 复用 `usePreferences` 的 localStorage 通道（lnkpi.preferences），不新建 key/store。
 * key 用 `catalogModelKeyFromValue`（与 supportsThinkingLevel 能力判定同源，非裸 provider/modelId）。
 */
export function useThinkingByModel() {
  const prefs = usePreferences()

  /** 读某模型的种子档；无种子返回 undefined（调用方决定回落策略）。 */
  function seedFor(modelValue: string): ThinkingLevel | undefined {
    if (!modelValue) return undefined
    const key = catalogModelKeyFromValue(modelValue)
    return prefs.value.thinkingByModel?.[key]
  }

  /** 写某模型的种子档（改档时调，与会话单值写回并行）。 */
  function saveSeed(modelValue: string, level: ThinkingLevel): void {
    if (!modelValue) return
    const key = catalogModelKeyFromValue(modelValue)
    prefs.value.thinkingByModel = { ...(prefs.value.thinkingByModel ?? {}), [key]: level }
  }

  return { seedFor, saveSeed }
}
