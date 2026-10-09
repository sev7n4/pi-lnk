import { describe, expect, it } from 'vitest'
import {
  encodeChannelModel,
  PLATFORM_CHANNEL_ID,
  STUDIO_MODEL_CATALOG,
  type StudioModality,
} from '@lnkpi/shared'
import { planDisabledModelsOnPreferencesUpdate, planUserSelectableSyncRow, type SelectableFieldsRow } from './model-catalog-sync'
import { planPlatformChannelSync } from './audio-model-backfill'

const P = 'platform::'
const CATALOG = {
  image: [`${P}agnes-image-2.1-flash`, `${P}agnes-image-2.0-flash`],
  video: [`${P}agnes-video-v2.0`],
  text: [`${P}agnes-text-v1`],
  audio: [`${P}step-tts-mini`],
}

function row(overrides: Partial<SelectableFieldsRow> = {}): SelectableFieldsRow {
  return {
    selectableImageModels: '[]',
    selectableVideoModels: '[]',
    selectableTextModels: '[]',
    selectableAudioModels: '[]',
    disabledModels: '[]',
    ...overrides,
  }
}

describe('planUserSelectableSyncRow', () => {
  it('并入目录新增条目：既有在前、新增在后，幂等', () => {
    const input = row({
      selectableImageModels: JSON.stringify([`${P}agnes-image-2.0-flash`]),
    })
    const plan = planUserSelectableSyncRow(input, CATALOG, P)
    expect(plan.changed).toBe(true)
    expect(plan.added.image).toEqual([`${P}agnes-image-2.1-flash`])
    const once = JSON.parse(plan.data.selectableImageModels!) as string[]
    expect(once).toEqual([`${P}agnes-image-2.0-flash`, `${P}agnes-image-2.1-flash`])
    // 第二次跑（把第一次产出的全部字段回填 = 已对齐的目标态）：不再变化
    const again = planUserSelectableSyncRow(
      {
        ...input,
        ...plan.data,
      } as SelectableFieldsRow,
      CATALOG,
      P,
    )
    expect(again.changed).toBe(false)
  })

  it('用户停用的模型不复活（disabledModels 命中 ⇒ 不并入）', () => {
    const plan = planUserSelectableSyncRow(
      row({
        selectableImageModels: '[]',
        disabledModels: JSON.stringify(CATALOG.image),
      }),
      CATALOG,
      P,
    )
    expect(plan.added.image).toBeUndefined()
    // image 全部被停用 ⇒ image 字段零变化（不产生写库字段）
    expect(plan.data.selectableImageModels).toBeUndefined()
  })

  it('目录已移除的平台条目被清掉，BYOK 条目一律保留', () => {
    const plan = planUserSelectableSyncRow(
      row({
        selectableImageModels: JSON.stringify([
          `${P}dead-image-model`,
          'ch_abc::my-own-image-model',
          `${P}agnes-image-2.0-flash`,
        ]),
      }),
      CATALOG,
      P,
    )
    const target = JSON.parse(plan.data.selectableImageModels!) as string[]
    expect(target).toEqual([
      'ch_abc::my-own-image-model',
      `${P}agnes-image-2.0-flash`,
      `${P}agnes-image-2.1-flash`,
    ])
  })

  it('停用清单里目录已不存在的条目被清理（防无限增长）', () => {
    const plan = planUserSelectableSyncRow(
      row({
        disabledModels: JSON.stringify([`${P}dead-model`, `${P}agnes-image-2.1-flash`]),
      }),
      CATALOG,
      P,
    )
    expect(JSON.parse(plan.data.disabledModels!) as string[]).toEqual([`${P}agnes-image-2.1-flash`])
  })

  it('脏 JSON 按空数组处理（不抛错，保守并入目录）', () => {
    const plan = planUserSelectableSyncRow(
      row({ selectableImageModels: 'not-json', disabledModels: 'not-json' }),
      CATALOG,
      P,
    )
    const target = JSON.parse(plan.data.selectableImageModels!) as string[]
    expect(target).toEqual(CATALOG.image)
  })

  it('已完全对齐 ⇒ changed=false 且不产生任何写库字段', () => {
    const full = {
      selectableImageModels: JSON.stringify(CATALOG.image),
      selectableVideoModels: JSON.stringify(CATALOG.video),
      selectableTextModels: JSON.stringify(CATALOG.text),
      selectableAudioModels: JSON.stringify(CATALOG.audio),
      disabledModels: '[]',
    }
    const plan = planUserSelectableSyncRow(full, CATALOG, P)
    expect(plan.changed).toBe(false)
    expect(plan.data).toEqual({})
  })
})

describe('planDisabledModelsOnPreferencesUpdate', () => {
  it('旧有新无 ⇒ 记入停用', () => {
    const plan = planDisabledModelsOnPreferencesUpdate(
      row({ selectableImageModels: JSON.stringify([`${P}agnes-image-2.0-flash`]) }),
      { image: [`${P}agnes-image-2.1-flash`] },
      CATALOG,
    )
    expect(plan.changed).toBe(true)
    expect(plan.newlyDisabled).toEqual([`${P}agnes-image-2.0-flash`])
    expect(plan.target).toEqual([`${P}agnes-image-2.0-flash`])
  })

  it('重新启用 ⇒ 从停用清单移出', () => {
    const plan = planDisabledModelsOnPreferencesUpdate(
      row({
        selectableImageModels: JSON.stringify([`${P}agnes-image-2.0-flash`]),
        disabledModels: JSON.stringify([`${P}agnes-image-2.0-flash`]),
      }),
      { image: [`${P}agnes-image-2.0-flash`, `${P}agnes-image-2.1-flash`] },
      CATALOG,
    )
    expect(plan.reEnabled).toEqual([`${P}agnes-image-2.0-flash`])
    expect(plan.target).toEqual([])
  })

  it('excludeFromPrev（sync 刚并入且请求里没有）不算停用 —— 防草稿跨上架窗口误停', () => {
    const plan = planDisabledModelsOnPreferencesUpdate(
      row({ selectableImageModels: JSON.stringify([`${P}agnes-image-2.0-flash`, `${P}agnes-image-2.1-flash`]) }),
      { image: [`${P}agnes-image-2.0-flash`] },
      CATALOG,
      { image: [`${P}agnes-image-2.1-flash`] }, // sync 刚并入的
    )
    expect(plan.changed).toBe(false)
    expect(plan.newlyDisabled).toEqual([])
  })

  it('BYOK 条目摘除不记录（对齐不会复活它们）', () => {
    const plan = planDisabledModelsOnPreferencesUpdate(
      row({
        selectableImageModels: JSON.stringify(['ch_abc::my-own-model', `${P}agnes-image-2.0-flash`]),
      }),
      { image: [`${P}agnes-image-2.0-flash`] },
      CATALOG,
    )
    expect(plan.changed).toBe(false)
  })

  it('目录外模型不在遍历范围（不产生停用记录）', () => {
    const plan = planDisabledModelsOnPreferencesUpdate(
      row({ selectableImageModels: JSON.stringify([`${P}dead-model`]) }),
      { image: [] },
      CATALOG,
    )
    expect(plan.changed).toBe(false)
  })

  it('多次停用同一条不重复记录（disabledSet 去重）', () => {
    const plan = planDisabledModelsOnPreferencesUpdate(
      row({
        selectableImageModels: JSON.stringify([`${P}agnes-image-2.0-flash`]),
        disabledModels: JSON.stringify([`${P}agnes-image-2.0-flash`]),
      }),
      { image: [] },
      CATALOG,
    )
    expect(plan.target).toEqual([`${P}agnes-image-2.0-flash`])
  })
})

/**
 * S0-1 幽灵模型下架闭环（2026-10-09）：目录删除 3 个 agnes hub 无渠道的文本模型后，
 * 既有 sync 机制（#306）必须把 DB 镜像与用户快照收敛干净。目录现为 25 条
 * （文本仅 agnes-2.0-flash），fixture 按 provider.service.ts 的真实编码方式构造
 * （`catalogModels()` / `defaultSelectableFor()`：name=modelKey、capability=modality、
 * 编码值=`platform::<modelKey>`）。
 */
describe('S0-1 幽灵模型下架 sync 闭环', () => {
  const GHOST_KEYS = ['deepseek-v4', 'gemini-3.1-flash', 'gpt-5.5']

  /** 与 provider.service.ts `catalogModels()` 同构：当前目录的全量镜像。 */
  const CATALOG_MODELS = STUDIO_MODEL_CATALOG.map((entry) => ({
    name: entry.modelKey,
    capability: entry.modality,
  }))

  /** 与 provider.service.ts `catalogEncodedByModality()` 同构：按 modality 分桶的编码清单。 */
  function catalogEncodedByModalityFixture(): Record<StudioModality, string[]> {
    const bucket = (modality: StudioModality) =>
      STUDIO_MODEL_CATALOG.filter((e) => e.modality === modality).map((e) =>
        encodeChannelModel(PLATFORM_CHANNEL_ID, e.modelKey),
      )
    return {
      image: bucket('image'),
      video: bucket('video'),
      text: bucket('text'),
      audio: bucket('audio'),
    }
  }

  it('A2：预置 28 条含 3 幽灵的镜像行 → sync 后 25 条且幽灵消失', () => {
    const staleMirror = JSON.stringify([
      ...CATALOG_MODELS,
      ...GHOST_KEYS.map((name) => ({ name, capability: 'text' })),
    ])
    expect(JSON.parse(staleMirror)).toHaveLength(28) // fixture 自检：下架前的镜像形态

    const plan = planPlatformChannelSync(staleMirror, CATALOG_MODELS)
    expect(plan.changed).toBe(true)
    expect(plan.target).toHaveLength(25)
    const names = plan.target.map((m) => m.name)
    for (const key of GHOST_KEYS) {
      expect(names, `幽灵 ${key} 仍在镜像中`).not.toContain(key)
    }
    expect(names).toContain('agnes-2.0-flash') // 真实可用文本模型保留
  })

  it('A3：deepseek-v4 既在 selectableTextModels 又在 disabledModels（同形歧义复合形态）→ sync 后两者均清理', () => {
    const ghostRef = encodeChannelModel(PLATFORM_CHANNEL_ID, 'deepseek-v4')
    const agnesRef = encodeChannelModel(PLATFORM_CHANNEL_ID, 'agnes-2.0-flash')
    // 下架前的文本快照（4 条旧目录序）+ 该幽灵的停用记录 = #306 已知的同形歧义复合形态。
    const input = row({
      selectableTextModels: JSON.stringify([
        ghostRef,
        encodeChannelModel(PLATFORM_CHANNEL_ID, 'gemini-3.1-flash'),
        encodeChannelModel(PLATFORM_CHANNEL_ID, 'gpt-5.5'),
        agnesRef,
      ]),
      disabledModels: JSON.stringify([ghostRef]),
    })

    const plan = planUserSelectableSyncRow(input, catalogEncodedByModalityFixture(), P)
    expect(plan.changed).toBe(true)
    // selectable：3 个幽灵清掉，真实模型保留原顺序，无复活
    const selectable = JSON.parse(plan.data.selectableTextModels!) as string[]
    expect(selectable).toEqual([agnesRef])
    // disabled：幽灵的停用记录一并清理（清空）
    expect(JSON.parse(plan.data.disabledModels!) as string[]).toEqual([])

    // 闭环：把产出回填再跑一次 = 已对齐，不再变化
    const again = planUserSelectableSyncRow(
      { ...input, ...plan.data } as SelectableFieldsRow,
      catalogEncodedByModalityFixture(),
      P,
    )
    expect(again.changed).toBe(false)
  })
})
