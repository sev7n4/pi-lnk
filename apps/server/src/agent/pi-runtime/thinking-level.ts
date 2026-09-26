/** 老契约（thinking:boolean + thinkingEffort:'high'|'max'）→ pi ThinkingLevel。
 * 映射决策 D-T1：high→medium（与生产默认档一致）、max→high；关闭恒 off。 */
export function mapThinkingLevel(
  thinking: boolean | undefined,
  effort: 'high' | 'max' | undefined,
): 'off' | 'medium' | 'high' {
  if (thinking !== true) return 'off'
  return effort === 'max' ? 'high' : 'medium'
}
