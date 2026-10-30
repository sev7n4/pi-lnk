/**
 * K4（规格 2026-10-28 §4）：机器载荷清单**单一来源**。
 *
 * 历史对话里用户气泡可能整段是这些载荷（旧版方案/交付确认按钮、发起新任务 chip 发出），
 * 渲染面必须过滤；此前清单散在 web 组件内（agentInterruptGate），任何新消费方
 * （过滤、可见性、测试）一律 import 本模块，禁止再复制字面量。
 *
 * ⚠️ 只用于**读/渲染面**过滤：服务端写路径不得清洗（`__new_task__` 是回合分类输入，
 * mid-run-interrupt 规格 UAT-INT-PV-03 依赖）。
 */
export const MACHINE_PAYLOAD_PREFIXES = [
  '__scheme_decision__',
  '__macro_scheme_decision__',
  '__delivery_decision__',
  '__new_task__',
] as const

export function lineHasMachinePayload(line: string): boolean {
  const trimmed = line.trimStart().replace(/^["']+|["']+$/g, '')
  return MACHINE_PAYLOAD_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}
