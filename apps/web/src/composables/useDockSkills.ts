import { ref } from 'vue'
import { AGENT_SKILLS, mergeAgentSkills, runtimeSkillsToInstalled } from '@/constants/agentSkillMap'
import { skillApi } from '@/services/skill-api'
import type { AgentSkillDef } from '@/constants/agentSkillMap'

/**
 * 技能 UI/UX 二轮 R4（2026-11-18）：dockSkills 加载逻辑抽为组合式——
 * AgentSideRail（PC 管理弹层）与 MobileCanvasShell（移动端技能中心）共用同一数据源，
 * 消灭「移动端技能中心不可见内置技能」的双端信息不对称（规格 §1.1 P3 / RC4）。
 *
 * 数据面与 AgentSideRail 原实现逐字对齐（fail-soft：runtime/mine 失败 → 空数组，
 * 回退内置兜底，不阻断 UI）；合并/去重/过滤复用 mergeAgentSkills（吃满上游，零第二套合并）。
 */
export function useDockSkills() {
  const dockSkills = ref<AgentSkillDef[]>([...AGENT_SKILLS])
  async function loadDockSkills(): Promise<void> {
    const runtime = await skillApi.runtimeList().catch(() => [])
    const mine = await skillApi.mine().catch(() => [])
    dockSkills.value = mergeAgentSkills(AGENT_SKILLS, [...runtimeSkillsToInstalled(runtime), ...mine])
  }
  return { dockSkills, loadDockSkills }
}
