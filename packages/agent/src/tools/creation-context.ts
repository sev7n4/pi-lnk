/**
 * G5 · 世界状态注入（文本生成阶段）。
 *
 * 断点：链路 A 把画布摘要 / 选中指代 / 记忆注入 system prompt，**模型据此决策**
 * 调用 `run_text_generation`；但工具落到 `studio.generateText` 时上下文全部丢弃，
 * 只拿节点自身 `prompt + refs` 裸调 LLM —— **决策有上下文、执行无上下文**。
 *
 * 这里补的是执行侧的那一半。⛔ 注入范围刻意收窄：只有
 * 「当前在写哪个节点」（selectionDigest）+「周围有什么」（canvasSummary 精简版）。
 * **不注入** vision / sidebar / memory 全文 —— 那是决策阶段已经读过的内容，
 * 生成阶段重复灌入只会稀释 prompt 并放大 token 成本。
 */

export interface CreationContext {
  /** 用户当前选中的节点（指代消解后的摘要，不是原始节点 JSON）。 */
  selectionDigest?: string
  /** 画布概况精简版（节点数 / 类型分布一类的短摘要）。 */
  canvasSummary?: string
}

/**
 * 拼出 system message 尾部的「创作上下文」段。
 *
 * 返回空串表示「没有可注入的内容」—— 调用方必须原样返回原 system，
 * 不得追加一个空标题（空段会静默改变 prompt，且无法从日志里看出来）。
 */
export function buildCreationContextSection(ctx?: CreationContext | null): string {
  if (!ctx) return ''
  const lines: string[] = []
  const selection = ctx.selectionDigest?.trim()
  const summary = ctx.canvasSummary?.trim()
  if (selection) lines.push(`- ${selection}`)
  if (summary) lines.push(`- ${summary}`)
  if (lines.length === 0) return ''
  return `\n\n【创作上下文】\n${lines.join('\n')}`
}

/** 把上下文段追加到 system prompt 末尾；无内容时原样返回。 */
export function appendCreationContext(system: string, ctx?: CreationContext | null): string {
  const section = buildCreationContextSection(ctx)
  return section ? `${system}${section}` : system
}
