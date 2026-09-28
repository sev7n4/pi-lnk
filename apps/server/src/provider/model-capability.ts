import { decodeChannelModel, supportsThinkingLevel } from '@lnkpi/shared'

export type ModelCapability = {
  reasoning: boolean
  contextWindow: number
  maxTokens: number
}

/**
 * 保守默认（spec §3.2 三层解析第 3 层）：
 *  - reasoning=false：pi 的 thinkingLevel 会给 reasoning 模型发 `reasoning_effort` 参数，
 *    多数 OpenAI 兼容网关对**非** reasoning 模型收到该参数会 400 —— 拿不准就 false。
 *  - contextWindow=128k / maxTokens=8k：偏小只会导致 harness 提前压缩（安全），
 *    偏大会导致上游超限报错（危险）。
 */
const DEFAULT_CAPABILITY: ModelCapability = {
  reasoning: false,
  contextWindow: 128_000,
  maxTokens: 8_192,
}

/**
 * 第 2 层：内置静态能力表（按模型名匹配常见系）。
 * reasoning 的模式表已上移到 `@lnkpi/shared` 的 `supportsThinkingLevel`——前端「深度思考」开关的
 * 可见性判的是同一张表，两端必须同源，否则会出现「开关能开但 pi 强制 off」的假象。
 * 第 1 层（渠道 models 元数据扩展字段）现状不存在——`pullModels` 只存
 * `{ name, capability(模态) }`——将来扩字段时在 shared 侧优先消费即可，契约不变。
 */

const CONTEXT_WINDOW_RULES: ReadonlyArray<readonly [RegExp, number]> = [
  [/^claude/i, 200_000],
  [/^gemini/i, 1_000_000],
  [/^gpt-5/i, 400_000],
]

/**
 * 解析模型能力（供 pi-runtime 会话级装配用）。
 * @param providerRef `ch_xxx::model-name` 或裸模型名
 */
export function resolveModelCapability(providerRef: string): ModelCapability {
  const raw = providerRef?.trim() ?? ''
  if (!raw) return { ...DEFAULT_CAPABILITY }
  const decoded = decodeChannelModel(raw)
  const name = (decoded?.modelName ?? raw).trim().toLowerCase()
  if (!name) return { ...DEFAULT_CAPABILITY }

  return {
    reasoning: supportsThinkingLevel(raw),
    contextWindow:
      CONTEXT_WINDOW_RULES.find(([re]) => re.test(name))?.[1] ?? DEFAULT_CAPABILITY.contextWindow,
    maxTokens: DEFAULT_CAPABILITY.maxTokens,
  }
}
