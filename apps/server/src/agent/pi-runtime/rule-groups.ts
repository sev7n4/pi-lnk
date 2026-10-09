/**
 * 规则组真值源 + env 覆盖解析（A/B 评测专用入口）。
 *
 * ── 为什么这个模块存在 ──
 * 生产 `ruleGroups` 此前硬编码在 agent.service.ts 的 assembleStatic 调用点，
 * **无 env 开关、无配置项**（prompt-ab-runbook「groups 怎么切」节原文）。
 * 代价：8 个 A/B 场景里 6 个需要**手改生产源码**才能构造规则组子集，
 * runbook 只能靠「⚠️ 改完记得改回去」这条人肉纪律兜底——
 * 忘改回去 = 把非生产提示词带进发版，属最坏的失效模式。
 *
 * 本模块把「默认值」收敛为**唯一真值源**：
 *   - agent.service.ts 从这里 import（替代内联字面量）；
 *   - scripts/verify-ab-scenarios.ts 的 (b) 判据从这里 import（替代正则解析源码，
 *     消除「生产改形状、脚本解析不到」的第二真值源漂移）。
 *
 * ── fail-closed ──
 * 未知组名**抛错**而不是回落默认：env 写错时若静默给三组全开，
 * 操作者会「以为在测 ['core']，实际测的是生产配置」——机检制造它本该防的假绿。
 *
 * ⚠️ 覆盖只应出现在 A/B 评测环境：groups=['core'] 时 write_guard /
 * no_gen_claim.nogen（unlessGroup 守卫）**不注入**，而工具注册
 * （tools/config.ts resolveToolsWithClient）不接 groups、照样全量下发 schema
 * ⇒ 覆盖态不是安全边界，仅是提示词构成开关。生产部署不得设置该变量。
 */

/** 规则组取值。与 prompt-registry MANIFEST 的 group 字段同域。
 * todoTools（C1 2026-10-09）：task_tool 规则（todo_write 任务计划汇报）。
 * ⚠️ kill switch 不走 AGENT_RULE_GROUPS：PI_RUNTIME_TODO_TOOL=off 时由调用方
 * （agent.service.ts）从 groups 里剔除 todoTools——与本文件 A/B 语义正交。 */
export type RuleGroup = 'core' | 'writeTools' | 'genTools' | 'todoTools'

/** 生产默认：全组开（B-5：run_* 生成工具已注册；C1：todo_write 已注册）。
 * PI_RUNTIME_TODO_TOOL=off 时调用方必须剔除 todoTools（双侧部署单元各自读 env）。 */
export const PRODUCTION_RULE_GROUPS: readonly RuleGroup[] = Object.freeze([
  'core',
  'writeTools',
  'genTools',
  'todoTools',
] as RuleGroup[])

/** 规范序：输出与输入顺序无关，保证同组合同一构成（renderStatic 按 order 排，本序仅保证确定性）。 */
const CANONICAL_ORDER: Record<RuleGroup, number> = { core: 0, writeTools: 1, genTools: 2, todoTools: 3 }

/**
 * 解析 `AGENT_RULE_GROUPS` 环境变量。
 *
 * @param raw env 原始值；undefined / 空串 / 纯空白 → 生产默认三组全开。
 * @returns 去重、按规范序排列的规则组。
 * @throws 未知组名（含大小写不符）——报错信息附允许值清单。
 */
export function resolveRuleGroups(raw: string | undefined): RuleGroup[] {
  const trimmed = raw?.trim()
  if (!trimmed) return [...PRODUCTION_RULE_GROUPS]
  const parts = [...new Set(trimmed.split(',').map((s) => s.trim()).filter(Boolean))]
  const unknown = parts.filter((p) => !(p in CANONICAL_ORDER))
  if (unknown.length > 0) {
    throw new Error(
      `AGENT_RULE_GROUPS 含未知规则组「${unknown.join('、')}」。允许值: core / writeTools / genTools / todoTools`,
    )
  }
  return (parts as RuleGroup[]).sort((a, b) => CANONICAL_ORDER[a] - CANONICAL_ORDER[b])
}
