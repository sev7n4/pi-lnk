import { describe, expect, it } from 'vitest'
import { PRODUCTION_RULE_GROUPS, resolveRuleGroups } from './rule-groups'

/**
 * 规则组解析（A/B 切组的 env 覆盖入口）。
 * spec：docs/ops/prompt-ab-runbook.md「groups 怎么切」——此前 6/8 场景需手改
 * agent.service.ts 源码才能跑 A/B，存在「忘改回去 ⇒ 非生产提示词带进发版」的扳机。
 * fail-closed：未知值抛错，绝不静默回落默认（否则「以为在测 ['core']，实际三组全开」= 假绿）。
 */
describe('resolveRuleGroups', () => {
  it('undefined / 空串 / 纯空白 → 生产默认三组全开', () => {
    expect(resolveRuleGroups(undefined)).toEqual(['core', 'writeTools', 'genTools'])
    expect(resolveRuleGroups('')).toEqual(['core', 'writeTools', 'genTools'])
    expect(resolveRuleGroups('   ')).toEqual(['core', 'writeTools', 'genTools'])
  })

  it('单组 / 多组正常解析', () => {
    expect(resolveRuleGroups('core')).toEqual(['core'])
    expect(resolveRuleGroups('core,writeTools')).toEqual(['core', 'writeTools'])
    expect(resolveRuleGroups('genTools')).toEqual(['genTools'])
  })

  it('容忍逗号前后空白；空段（尾逗号）忽略', () => {
    expect(resolveRuleGroups(' core , writeTools ,')).toEqual(['core', 'writeTools'])
  })

  it('重复组去重', () => {
    expect(resolveRuleGroups('core,core,writeTools')).toEqual(['core', 'writeTools'])
  })

  it('输出按规范序排列（core → writeTools → genTools），与输入顺序无关', () => {
    expect(resolveRuleGroups('genTools,core')).toEqual(['core', 'genTools'])
    expect(resolveRuleGroups('genTools,writeTools,core')).toEqual(['core', 'writeTools', 'genTools'])
  })

  it('未知组名 → 抛错（报错含允许值清单），绝不静默回落默认', () => {
    expect(() => resolveRuleGroups('core,admin')).toThrow(/core \/ writeTools \/ genTools/)
    expect(() => resolveRuleGroups('ADMIN')).toThrow(/core \/ writeTools \/ genTools/)
  })

  it('大小写敏感：Core ≠ core（防「看着像对」的近似输入混进评测）', () => {
    expect(() => resolveRuleGroups('Core')).toThrow()
  })

  it('PRODUCTION_RULE_GROUPS 与生产硬编码字面量一致且冻结', () => {
    expect([...PRODUCTION_RULE_GROUPS]).toEqual(['core', 'writeTools', 'genTools'])
    expect(Object.isFrozen(PRODUCTION_RULE_GROUPS)).toBe(true)
  })
})
