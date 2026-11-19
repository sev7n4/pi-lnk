// 三轮（2026-11-19）三处交互收敛守卫：
// R10 = MobileSheet 下滑关闭（顶部起手势 + 阈值）；R11 = 技能搜索过滤；R12 = 选中即走。
// 每条断言钉「规则本体 / 接线出口」——变异时对应断言必须转红，不只盯注释。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')
const pick = readFileSync(join(here, 'SkillPickSheet.vue'), 'utf8')
const sheet = readFileSync(join(here, '..', 'mobile', 'MobileSheet.vue'), 'utf8')

function block(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker)
  if (start < 0) return ''
  const end = src.indexOf(endMarker, start)
  return end > start ? src.slice(start, end) : src.slice(start)
}

describe('技能选择交互收敛（R10 下滑关闭 / R11 搜索 / R12 选中即走）', () => {
  it('R10：MobileSheet 支持 swipeToDismiss，阈值 + 顶部起手势 + 绑定 touch', () => {
    expect(sheet).toContain('swipeToDismiss?: boolean')
    expect(sheet).toContain('DISMISS_THRESHOLD_PX = 80')
    expect(sheet).toContain("startAtTop = (bodyRef.value?.scrollTop ?? 0) <= 1")
    const end = block(sheet, 'function onTouchEnd()', '/** 进场后锁 body 滚动') +
      block(sheet, 'function onTouchEnd()', 'onMounted(')
    expect(end).toContain('lastDy > DISMISS_THRESHOLD_PX')
    expect(end).toContain('if (shouldDismiss) dismiss()')
    expect(sheet).toContain('@touchstart.passive="swipeToDismiss && onTouchStart($event)"')
    expect(sheet).toContain('@touchmove="swipeToDismiss && onTouchMove($event)"')
    expect(sheet).toContain('@touchend.passive="swipeToDismiss && onTouchEnd()"')
    expect(sheet).toContain('ref="bodyRef"')
  })

  it('R11：SkillPickSheet 搜索——v-model query + label/desc 双字段过滤 + 输入框落内容顶部', () => {
    expect(pick).toContain("import { computed, ref } from 'vue'")
    expect(pick).toContain('const query = ref(\'\')')
    const filtered = block(pick, 'const filteredSkills = computed', 'function onPick')
    expect(filtered).toContain("s.label.toLowerCase().includes(q)")
    expect(filtered).toContain("(s.desc ?? '').toLowerCase().includes(q)")
    expect(pick).toContain('data-testid="skill-pick-search"')
    expect(pick).toContain('v-model="query"')
    // 搜索框是 sheet-body 的兄弟节点（内容顶部），列表渲染过滤后的集合
    expect(pick.indexOf('data-testid="skill-pick-search"')).toBeLessThan(pick.indexOf('data-testid="skill-pick-list"'))
    expect(pick).toContain('v-for="skill in filteredSkills"')
  })

  it('R12：`+` sheet 选中即走——toggle/clear 均经 onSheetPick/onSheetClear 关闭，slash 候选不关闭', () => {
    const pickFn = block(sfc, 'function onSheetPick', '/** 同上：sheet 内点「自动」')
    expect(pickFn).toContain('toggleSkillChip(id)')
    expect(pickFn).toContain('onSkillSheetClose()')
    const clearFn = block(sfc, 'function onSheetClear', 'const isProductVisualSkill')
    expect(clearFn).toContain('clearSkillChips()')
    expect(clearFn).toContain('onSkillSheetClose()')

    // 两处 sheet（移动 MobileSheet + PC popover）都接新出口
    expect((sfc.match(/@toggle="onSheetPick"/g) ?? []).length).toBe(2)
    expect((sfc.match(/@clear="onSheetClear"/g) ?? []).length).toBe(2)
    expect(sfc).not.toContain('@toggle="toggleSkillChip"')
    // slash 候选仍走原 toggle（就地勾选、不关闭 sheet）
    expect(sfc).toContain('function onSlashSkillSelect')
    expect(block(sfc, 'function onSlashSkillSelect', '/** P3：胶囊 toggle').indexOf('toggleSkillChip(option.id)')).toBeGreaterThan(-1)
  })
})
