import { describe, expect, it } from 'vitest'
import { enforceChipMax, nextChips, type NextChip } from '@/components/agent/nextChips'

/** AgentChipSet 全部非 null 取值（apps/web/src/components/agent/agentChipSet.ts:5）。 */
const CHIP_SETS = [
  'plan',
  'copy',
  'topo',
  'atomic',
  'generation_propose',
  'recipe_confirm',
  'recipe_promote',
  'recipe_promote_seed',
  'recipe_promote_variant',
  'image_qa',
  'scheme_select',
  'macro_scheme_select',
  'delivery_confirm',
] as const

/** 收敛前既有手势的回归锚点，任何一条从白名单里掉出去 = 交互手势消失。 */
const PRESERVED_TESTIDS = [
  'atomic-confirm-dock',
  'atomic-confirm-cancel',
  'generation-propose-confirm',
  'generation-propose-cancel',
  'recipe-promote-variant',
  'recipe-promote-new',
  'recipe-promote-seed-confirm',
  'recipe-promote-seed-back',
  'recipe-promote-variant-confirm',
  'recipe-promote-variant-back',
]

function allChips(): NextChip[] {
  return CHIP_SETS.flatMap((set) => [
    ...nextChips({ chipSet: set, canPromoteVariant: true }),
    ...nextChips({ chipSet: set, canPromoteVariant: false }),
  ])
}

describe('nextChips（决策 4：白名单 + 最多 2 个）', () => {
  it('generation_propose → 确认生成 / 取消，锚点不丢', () => {
    const chips = nextChips({ chipSet: 'generation_propose' })
    expect(chips.map((c) => c.label)).toEqual(['确认生成', '取消'])
    expect(chips.map((c) => c.testId)).toEqual([
      'generation-propose-confirm',
      'generation-propose-cancel',
    ])
    expect(chips.filter((c) => c.primary)).toHaveLength(1)
  })

  it('atomic → 确认生成 / 取消，锚点不丢', () => {
    const chips = nextChips({ chipSet: 'atomic' })
    expect(chips.map((c) => c.testId)).toEqual(['atomic-confirm-dock', 'atomic-confirm-cancel'])
  })

  it('recipe_promote：有父版本时两条手势，无父版本降级为单主按钮', () => {
    expect(nextChips({ chipSet: 'recipe_promote', canPromoteVariant: true })).toHaveLength(2)
    const single = nextChips({ chipSet: 'recipe_promote', canPromoteVariant: false })
    expect(single).toHaveLength(1)
    expect(single[0].primary).toBe(true)
    expect(single[0].testId).toBe('recipe-promote-new')
  })

  it('未知 chipSet / null → 空（不渲染任何按钮）', () => {
    expect(nextChips({ chipSet: 'future_kind' })).toEqual([])
    expect(nextChips({ chipSet: null })).toEqual([])
    expect(nextChips({ chipSet: undefined })).toEqual([])
  })

  it('delivery_confirm 不在 chips 白名单（按钮长在 ProductVisualDeliveryCard 里）', () => {
    expect(nextChips({ chipSet: 'delivery_confirm' })).toEqual([])
  })

  it('copy / topo 不在 chips 白名单（按钮长在 gate presentation 分支内）', () => {
    expect(nextChips({ chipSet: 'copy' })).toEqual([])
    expect(nextChips({ chipSet: 'topo' })).toEqual([])
  })

  it('除 image_qa 外，任何 chipSet 产出的 chips 恒 ≤ 2', () => {
    for (const set of CHIP_SETS) {
      if (set === 'image_qa') continue
      for (const canPromoteVariant of [true, false]) {
        const chips = nextChips({ chipSet: set, canPromoteVariant })
        expect(chips.length, `chipSet=${set}`).toBeLessThanOrEqual(2)
      }
    }
  })

  it('image_qa 豁免上限：原样透出 QA 选项（砍到 2 会堵死「重新拍摄」上传入口）', () => {
    const chips = nextChips({
      chipSet: 'image_qa',
      qaOptions: [
        { id: 'confirm_pass', label: '就用这张图，继续', message: '就用这张图，继续' },
        { id: 'retake', label: '重新拍摄', message: '我重新拍摄上传' },
        { id: 'ai_white_bg', label: '生成白底图', message: '生成标准白底图' },
      ],
    })
    expect(chips.map((c) => c.label)).toEqual(['就用这张图，继续', '重新拍摄', '生成白底图'])
    expect(chips.filter((c) => c.primary)).toHaveLength(1)
    expect(chips[0].primary).toBe(true)
  })

  it('回归防线：收敛前所有 data-testid 锚点仍被白名单覆盖', () => {
    const emitted = new Set(allChips().map((c) => c.testId).filter(Boolean) as string[])
    for (const id of PRESERVED_TESTIDS) {
      expect(emitted.has(id), `锚点 ${id} 从白名单掉出去了`).toBe(true)
    }
  })

  it('enforceChipMax 兜底截断', () => {
    expect(enforceChipMax(allChips().filter((c) => !c.testId))).toHaveLength(2)
  })
})
