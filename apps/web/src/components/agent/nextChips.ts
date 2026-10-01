/**
 * 「下一步做什么」动作白名单（决策 4：白名单 + 最多 2 个）。
 *
 * 设计原则借自 A2UI 的核心约束：**agent 只声明意图（chipSet），
 * 按钮长什么样、有什么手势由客户端目录决定**。旧实现把「确认/取消/换方向」
 * 逐条写死在模板的 12 组 `v-if / v-else-if` 里，新增一个 gate 就要复制一整块按钮，
 * 且 plan 组悄悄长到 3 个、topo 组 3 个、image_qa 组 4 个，底部 dock 失去预期。
 *
 * 收敛后：chips 只有一处渲染点（`data-testid="next-chips"`），
 * 未知 / 未登记 chipSet 一律不渲染任何按钮。
 */
export const NEXT_CHIP_MAX = 2

export type NextChipAction =
  | { kind: 'preset'; text: string }
  | { kind: 'confirm_atomic' }
  | { kind: 'cancel_atomic' }
  | { kind: 'scheme_confirm' }
  | { kind: 'scheme_revise' }
  | { kind: 'macro_confirm' }
  | { kind: 'macro_revise' }
  | { kind: 'qa_option'; message: string }

export interface NextChip {
  key: string
  label: string
  /** 回归锚点：既有测试 / 自动化靠 data-testid 定位手势，收敛时不得丢。 */
  testId?: string
  primary?: boolean
  disabled?: boolean
  action: NextChipAction
}

export interface QaOptionLite {
  id?: string
  label: string
  message: string
}

export interface NextChipInput {
  chipSet: string | null | undefined
  /** 画布里是否已有「模板父版本」（recipe_promote 的第二条手势才有意义）。 */
  canPromoteVariant?: boolean
  /** image_qa 之外的 chipSet 不需要；image_qa 豁免见下。 */
  qaOptions?: ReadonlyArray<QaOptionLite> | null
}

/**
 * 白名单表：`AgentChipSet` 13 个非 null 值里，真正表达「下一步动作」的 9 个。
 * 两个例外必须显式写进代码而不是靠注释：
 * - `image_qa` 是**选项**（就用这张 / 重新拍摄 / 生成白底图），不是「下一步动作」；
 *   砍到 2 个会堵死「重新拍摄 → 上传新照片」这条唯一入口，所以豁免上限、原样透出。
 * - `delivery_confirm` 的按钮长在 `ProductVisualDeliveryCard` 组件里，
 *   `topo` / `copy` 的按钮长在 gate presentation 分支内，三者都不是 chips，不在此表。
 */
export function nextChips(input: NextChipInput): NextChip[] {
  const { chipSet } = input
  if (!chipSet) return []

  if (chipSet === 'image_qa') {
    const opts = input.qaOptions ?? []
    return opts.slice(0, 4).map((o, i) => ({
      key: `qa-${o.id ?? i}`,
      label: o.label,
      primary: o.id === 'confirm_pass' || (i === 0 && !o.id),
      action: { kind: 'qa_option', message: o.message } as NextChipAction,
    }))
  }

  switch (chipSet) {
    case 'plan':
      return [
        { key: 'plan-1', label: '确认方案', primary: true, action: { kind: 'preset', text: '1' } },
        { key: 'plan-2', label: '换方向', action: { kind: 'preset', text: '2' } },
      ]
    case 'atomic':
      return [
        {
          key: 'atomic-1',
          label: '确认生成',
          primary: true,
          testId: 'atomic-confirm-dock',
          action: { kind: 'confirm_atomic' },
        },
        {
          key: 'atomic-2',
          label: '取消',
          testId: 'atomic-confirm-cancel',
          action: { kind: 'cancel_atomic' },
        },
      ]
    // generation_propose 已下线（2026-10-01 决策）：propose 确认入口唯一 = 画布节点
    // 「生成」按钮（阻塞等待由琥珀卡指引），聊天侧不再出确认/取消 chips。
    case 'recipe_confirm':
      return [
        {
          key: 'rc-1',
          label: '确认落到画布',
          primary: true,
          action: { kind: 'preset', text: '确认落到画布' },
        },
        { key: 'rc-2', label: '先不改', action: { kind: 'preset', text: '先不改' } },
      ]
    case 'recipe_promote':
      return input.canPromoteVariant
        ? [
            {
              key: 'rp-1',
              label: '保存为当前模板的改版',
              primary: true,
              testId: 'recipe-promote-variant',
              action: { kind: 'preset', text: '保存为当前模板的改版' },
            },
            {
              key: 'rp-2',
              label: '存成一套新模板',
              testId: 'recipe-promote-new',
              action: { kind: 'preset', text: '存成一套新模板' },
            },
          ]
        : [
            {
              key: 'rp-0',
              label: '存成一套新模板',
              primary: true,
              testId: 'recipe-promote-new',
              action: { kind: 'preset', text: '存成一套新模板' },
            },
          ]
    case 'recipe_promote_seed':
      return [
        {
          key: 'rps-1',
          label: '确认锁定这些核心步骤',
          primary: true,
          testId: 'recipe-promote-seed-confirm',
          action: { kind: 'preset', text: '确认锁定这些核心步骤' },
        },
        {
          key: 'rps-2',
          label: '返回',
          testId: 'recipe-promote-seed-back',
          action: { kind: 'preset', text: '返回上一步，这份工作流更像哪一种？' },
        },
      ]
    case 'recipe_promote_variant':
      return [
        {
          key: 'rpv-1',
          label: '确认保存为改版',
          primary: true,
          testId: 'recipe-promote-variant-confirm',
          action: { kind: 'preset', text: '确认保存为改版' },
        },
        {
          key: 'rpv-2',
          label: '返回',
          testId: 'recipe-promote-variant-back',
          action: { kind: 'preset', text: '返回上一步，这份工作流更像哪一种？' },
        },
      ]
    case 'scheme_select':
      return [
        { key: 'sch-1', label: '确认所选变体', primary: true, action: { kind: 'scheme_confirm' } },
        { key: 'sch-2', label: '需要调整方案', action: { kind: 'scheme_revise' } },
      ]
    case 'macro_scheme_select':
      return [
        { key: 'mac-1', label: '确认宏观方案', primary: true, action: { kind: 'macro_confirm' } },
        { key: 'mac-2', label: '需要调整方案', action: { kind: 'macro_revise' } },
      ]
    default:
      // 未知 / 未登记 chipSet（含 delivery_confirm）：不渲染任何按钮
      return []
  }
}

/** 白名单上限（image_qa 豁免自身，见 nextChips 内注释）。 */
export function enforceChipMax(chips: ReadonlyArray<NextChip>, max = NEXT_CHIP_MAX): NextChip[] {
  return chips.slice(0, max)
}
