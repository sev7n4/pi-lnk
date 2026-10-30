import { describe, expect, it } from 'vitest'
import { MACHINE_PAYLOAD_PREFIXES, lineHasMachinePayload } from './machinePayloads'

describe('machinePayloads（K4：机器载荷清单单一来源）', () => {
  it('清单含 __new_task__（回合分类输入，mid-run-interrupt UAT-INT-PV-03 依赖）', () => {
    expect(MACHINE_PAYLOAD_PREFIXES).toContain('__new_task__')
  })
  it('lineHasMachinePayload 判定与迁移前一致（含引号剥离与缩进容忍）', () => {
    expect(lineHasMachinePayload('__new_task__')).toBe(true)
    expect(lineHasMachinePayload('  "__scheme_decision__{...}"')).toBe(true)
    expect(lineHasMachinePayload('帮我把这张图改成夜景')).toBe(false)
    expect(lineHasMachinePayload('__unknown_marker__')).toBe(false)
  })
  it('清单内容快照：与迁移前 agentInterruptGate 的实际清单逐项一致（迁移的是值，不得增删条目）', () => {
    // 生成自迁移前 apps/web/src/components/agent/agentInterruptGate.ts :47 的本地常量。
    expect([...MACHINE_PAYLOAD_PREFIXES]).toEqual([
      '__scheme_decision__',
      '__macro_scheme_decision__',
      '__delivery_decision__',
      '__new_task__',
    ])
  })
})
