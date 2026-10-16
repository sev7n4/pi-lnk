// P1-2.1 思考档位（Task 7）：单 chip 三档语义的纯模块。
// 档位写回原状态通道（planningThinking / planningThinkingEffort），映射见 AgentSideRail.vue。
export const THINKING_LEVELS = ['标准', '深入', '极限'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]
export const levelLabel = (v: ThinkingLevel) => `思考·${v}`
