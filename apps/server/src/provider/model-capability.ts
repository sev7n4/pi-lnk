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
 *
 * ⚠️ 视觉输入能力**不在**本文件按正则猜，见 `resolveVisionInputSupport`。
 * 渠道 `models[].capability` 记的是**输出模态**（这模型是文/图/视频生成器），
 * 与「能否接收图片输入」是两个维度，不可互相推导。
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

/** 视觉「输入」能力的三态。`unknown` 是一等公民，不是 false 的别名。 */
export type VisionInputSupport = 'supported' | 'unsupported' | 'unknown'

/**
 * 渠道元数据里显式声明的视觉输入能力。
 *
 * 与 `ProviderChannel.models[].capability`（**输出模态**）严格区分：
 * `capability: "image"` 意思是"这模型是画图生成器"，跟它能不能看图无关。
 * 用输出去推输入会把画图模型错当成能理解图片的对话模型。
 */
export type DeclaredVisionInput = 'vision' | 'text' | 'video' | 'audio' | 'image'

export type VisionInputEvidence = {
  /** 渠道/平台显式声明的输入模态。无则留空。 */
  declared?: DeclaredVisionInput
  /** 探针实测：真发一张图看上游认不认。压倒一切声明。 */
  probed?: boolean
}

/**
 * 解析「该模型能否接收图片输入」。
 *
 * 为什么不用正则猜（2026-10-03 事故）：
 *   `sidebar-vision.ts` 曾用三条正则猜视觉能力，判错时不会报错——只是让
 *   pi-runtime 少声明一个 `input:"image"`，图片随后被静默替换成
 *   `(image omitted: ...)`，上游照常 200。正则既会漏判也会误判，且都不可见。
 *
 * 优先级：**探针 > 显式声明 > unknown**。没有证据就是 unknown，
 * 绝不大胆返回 true——让调用方自己决定是发图还是走识图兜底。
 * 猜测在这里是负资产：它同时可能让非视觉渠道 400，或让视觉渠道静默失效。
 */
export function resolveVisionInputSupport(
  providerRef: string | null | undefined,
  evidence: VisionInputEvidence = {},
): VisionInputSupport {
  const raw = providerRef?.trim() ?? ''
  if (!raw) return 'unknown'
  if (typeof evidence.probed === 'boolean') {
    return evidence.probed ? 'supported' : 'unsupported'
  }
  if (evidence.declared === 'vision') return 'supported'
  if (evidence.declared !== undefined) return 'unsupported'
  return 'unknown'
}
