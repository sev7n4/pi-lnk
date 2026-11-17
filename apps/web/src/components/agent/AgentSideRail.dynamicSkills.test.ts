// M1-3 + 内置技能可发现 + P3 胶囊升级（本刀）技能接线守卫（fs-scan，与 AgentSideRail 其他守卫同惯例）。
// 动态合并逻辑本身在 agentSkillMap.test.ts（mergeAgentSkills + runtimeSkillsToInstalled 纯函数）覆盖；
// 此处锁「数据源=运行时 /skills/runtime ∪ mine（经 mergeAgentSkills 复用合并）+ sheet/`/` 同一胶囊出口」。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')

describe('AgentSideRail 技能接线（M1-3 + P3 胶囊）', () => {
  it('P3 C1：技能选择 sheet 数据源 = dockSkills（禁独立拉取/硬编码；inline 子菜单退役）', () => {
    expect(sfc).toContain('<SkillPickSheet')
    expect(sfc).toContain(':skills="dockSkills.map((s) => ({ id: s.id, label: s.label, desc: s.desc }))"')
    // 旧 inline 子菜单交互退役
    expect(sfc).not.toContain('skillSubmenuOpen')
    expect(sfc).toContain('skillSheetOpen = true; attachMenuOpen = false')
  })

  it('P3 C2/C3：selectedSkillIds 胶囊状态 + toggle 同出口 + 发送受理后清空', () => {
    expect(sfc).toContain('const selectedSkillIds = ref<string[]>([])')
    expect(sfc).toContain('activeSkillId = computed(() => selectedSkillIds.value[0] ?? null)')
    // `/` 候选与 sheet 同一 toggle 出口（N1 靶点：禁另造独立出口）
    expect(sfc).toContain('@slash-select="onSlashSkillSelect"')
    expect(sfc).toContain('function onSlashSkillSelect(option: { id: string }) {\n  toggleSkillChip(option.id)\n}')
    // 发送载荷带 skillIds（skillId = 首个胶囊兼容位）
    expect(sfc).toContain('skillIds: selectedSkillIds.value.length ? selectedSkillIds.value : undefined')
    expect(sfc).toContain('skillId: selectedSkillIds.value[0] ?? undefined')
    // 随消息一次性：请求受理后才清空
    expect(sfc).toContain('selectedSkillIds.value = []')
  })

  it('P3 C2：胶囊条 chips 行渲染（X 移除）', () => {
    expect(sfc).toContain('data-testid="skill-chips-row"')
    expect(sfc).toContain('data-testid="skill-chip-remove"')
    expect(sfc).toContain('@click.stop="removeSkillChip(chipId)"')
  })

  it('P3 C6：sheet 底部管理入口 → 打开管理弹层（SkillDiscoverPanel mine tab）', () => {
    // manage-skills-btn 按钮本体在 SkillPickSheet.test.ts 覆盖；此处锁宿主接线
    expect(sfc).toContain('@manage="skillSheetOpen = false; manageOpen = true"')
    // F2：管理弹层把 dockSkills 作为只读内置技能传入（零 fetch，单一事实源）
    expect(sfc).toContain(':builtin-skills="dockSkills.map((s) => ({ id: s.id, label: s.label, desc: s.desc }))"')
  })

  it('onMounted 拉取：skillApi.runtimeList + skillApi.mine 并源，经 runtimeSkillsToInstalled 适配后复用 mergeAgentSkills', () => {
    expect(sfc).toContain('skillApi.runtimeList()')
    expect(sfc).toContain('skillApi.mine()')
    expect(sfc).toContain('runtimeSkillsToInstalled(runtime)')
    expect(sfc).toContain('mergeAgentSkills(AGENT_SKILLS,')
    expect(sfc).toContain('void loadDockSkills()')
  })

  it('B6 fail-soft：runtime/mine 各自 catch 空数组回退，初始值静态内置兜底（不阻断对话）', () => {
    expect(sfc).toContain('.catch(() => [])')
    expect(sfc).toContain('const dockSkills = ref<AgentSkillDef[]>([...AGENT_SKILLS])')
    // 旧整体 try/catch 已被逐源 catch 取代——不允许把异常吞成整体回退后丢弃 mine
    const block = sfc.slice(sfc.indexOf('async function loadDockSkills'))
    expect(block.slice(0, 600)).not.toContain('try {')
  })
})
