import { decodeChannelModel } from './providerChannels'

/**
 * 上下文窗口派生规则（单一真相源，2026-11-20 模型选择卡配置页）：
 *  - 服务端 `apps/server/src/provider/model-capability.ts` 的 `resolveModelCapability`
 *    用它给 pi-runtime 装配模型能力；
 *  - 前端模型配置页用它展示「上下文窗口 200K/400K/1M/128K」（只读）。
 * 两端必须同源，否则会出现「卡片显示 1M、实际按 128K 压缩」的假象
 * （同 `modelCapability.ts` 的 reasoning 表两端同源先例）。
 *
 * ⚠️ 这是**模型能力声明值**的展示，不是会话运行时的压缩覆盖值
 * （生产 `PI_RUNTIME_COMPACTION_CONTEXT_WINDOW` 仅影响压缩判定，不属于此处展示语义）。
 */

export const DEFAULT_CONTEXT_WINDOW = 128_000

const CONTEXT_WINDOW_RULES: ReadonlyArray<readonly [RegExp, number]> = [
  [/^claude/i, 200_000],
  [/^gemini/i, 1_000_000],
  [/^gpt-5/i, 400_000],
]

/**
 * @param modelRef `ch_xxx::model-name` 或裸模型名
 */
export function resolveContextWindow(modelRef?: string | null): number {
  const raw = modelRef?.trim() ?? ''
  if (!raw) return DEFAULT_CONTEXT_WINDOW
  const name = (decodeChannelModel(raw)?.modelName ?? raw).trim().toLowerCase()
  if (!name) return DEFAULT_CONTEXT_WINDOW
  return CONTEXT_WINDOW_RULES.find(([re]) => re.test(name))?.[1] ?? DEFAULT_CONTEXT_WINDOW
}

/** 只读展示串：整 K 用 `NK`，百万用 `1M`。 */
export function contextWindowLabel(modelRef?: string | null): string {
  const tokens = resolveContextWindow(modelRef)
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`
  return `${Math.round(tokens / 1000)}K`
}
