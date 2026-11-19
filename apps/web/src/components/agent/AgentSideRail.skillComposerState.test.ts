// 三次修复（2026-11-18）三处回归守卫：
// R3 = 胶囊行独占上行；R2 = PC sheet 相对 composer 容器封顶；R1 = 选技能后保持输入态并回焦。
// 每条断言都钉「规则本体 / 接线出口」，不是只盯注释——变异时对应断言必须转红。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')
const pick = readFileSync(join(here, 'SkillPickSheet.vue'), 'utf8')

function rule(src: string, selector: string): string {
  const at = src.indexOf(selector)
  if (at < 0) return ''
  const open = src.indexOf('{', at)
  const close = src.indexOf('}', open)
  return open >= 0 && close > open ? src.slice(open, close + 1) : ''
}

function block(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker)
  if (start < 0) return ''
  const end = src.indexOf(endMarker, start)
  return end > start ? src.slice(start, end) : src.slice(start)
}

describe('技能 composer 三处回归（R1 输入态 / R2 PC 限宽 / R3 胶囊独占行）', () => {
  it('R3：胶囊行是 input-wrap 的兄弟节点，移动端独占上行', () => {
    const chipsClass = 'class="agent-composer__skill-chips'
    const wrapOpen = '<div class="agent-composer__input-wrap">'
    expect(sfc).toContain(chipsClass)
    expect(sfc.indexOf(chipsClass)).toBeLessThan(sfc.indexOf(wrapOpen))

    const chipsRule = rule(
      sfc,
      '.agent-panel-mobile-dock .composer-bare-bar .agent-composer__skill-chips',
    )
    expect(chipsRule).toContain('order: -1')
    expect(chipsRule).toContain('flex: 1 1 100%')
    expect(chipsRule).toContain('min-width: 0')
  })

  it('R2：PC sheet 卡片宽度相对 .agent-input-dock 封顶，内层不再传导 min-content', () => {
    const cardRule = rule(sfc, '.skill-sheet-card')
    expect(cardRule).toContain('box-sizing: border-box')
    expect(cardRule).toContain('width: min(560px, 100%)')
    expect(cardRule).toContain('max-width: 100%')
    expect(sfc).not.toContain('max-w-[min(92vw,560px)]')

    // 生产 CDP 实测：+ 容器 relative 且 shrink-to-fit=32px 时，100% 会被解析成 32px。
    expect(sfc).toContain("'is-skill-sheet-open': skillSheetOpen")
    const attachRule = rule(sfc, '.agent-attach-menu.is-skill-sheet-open')
    expect(attachRule).toContain('position: static')

    const pickRoot = rule(pick, '.skill-pick-sheet')
    expect(pickRoot).toContain('min-width: 0')
    expect(pickRoot).not.toContain('min-width: 260px')
    const pickName = rule(pick, '.pick-name')
    expect(pickName).toContain('text-overflow: ellipsis')
    expect(pickName).toContain('white-space: nowrap')
  })

  it('R1：技能 toggle/clear 保持输入态，sheet 期间 focusout 不收起，关闭后回焦', () => {
    const toggle = block(sfc, 'function toggleSkillChip', 'function removeSkillChip')
    expect(toggle).toContain('keepComposerInputAfterSkillAction()')
    const clear = block(sfc, 'function clearSkillChips', 'const isProductVisualSkill')
    expect(clear).toContain('keepComposerInputAfterSkillAction()')

    const focusOut = block(sfc, 'function onComposerFocusOut', '/* ---- P1-5 移动端裸条三态')
    expect(focusOut).toContain('if (skillSheetOpen.value || manageOpen.value) return')

    const idle = block(sfc, 'const mobileBarIdle = computed', '/**\n * 空闲条文案')
    expect(idle).toContain('!selectedSkillIds.value.length')

    const close = block(sfc, 'function onSkillSheetClose', '// 输入框被程序填充')
    expect(close).toContain('composerRef.value?.focus()')
    expect(sfc).toContain('@close="onSkillSheetClose"')
    // 三轮 R12：sheet 内 clear/toggle 迁移到「选中即走」出口（onSheetClear/onSheetPick），
    // 二者内部仍调 clearSkillChips/toggleSkillChip 保持输入态；slash 候选仍直连原出口。
    expect((sfc.match(/@clear="onSheetClear"/g) ?? []).length).toBe(2)
    expect((sfc.match(/@toggle="onSheetPick"/g) ?? []).length).toBe(2)
    expect(block(sfc, 'function clearSkillChips', 'const isProductVisualSkill')).toContain('keepComposerInputAfterSkillAction()')
  })
})
