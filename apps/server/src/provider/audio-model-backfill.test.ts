import { describe, expect, it } from 'vitest'
import { planAudioModelBackfill, planPlatformChannelSync } from './audio-model-backfill'

/**
 * B3：存量用户的可选音频模型回填（一次性脚本）的纯逻辑单测。
 *
 * 核心不变量：
 *  1. **只增不删**：快照里已有的条目（含用户主动停用后留下的其他条目）一个都不许丢。
 *  2. **幂等**：同一输入跑两次，第二次 `changed` 必须全为 false。
 *  3. **可审计**：`added` 逐条列出让 apply 前能人工核对。
 */

const CATALOG = [
  'platform::minimax-speech-2.8-hd', // voice
  'platform::stepaudio-3-gen-preview', // design（新）
  'platform::stepaudio-3-music-preview', // music（新）
]

describe('planAudioModelBackfill', () => {
  it('存量快照缺两条新模型 ⇒ 并入，且不改动已有条目的顺序', () => {
    const plan = planAudioModelBackfill(
      [
        {
          userId: 'u1',
          selectableAudioModels: JSON.stringify([
            'platform::minimax-speech-2.8-hd',
            'ch_byok_1::my-custom-voice',
          ]),
        },
      ],
      CATALOG,
    )
    expect(plan[0]!.changed).toBe(true)
    // 已有条目在前、顺序不变；BYOK 自定义模型原样保留。
    expect(plan[0]!.target).toEqual([
      'platform::minimax-speech-2.8-hd',
      'ch_byok_1::my-custom-voice',
      'platform::stepaudio-3-gen-preview',
      'platform::stepaudio-3-music-preview',
    ])
    expect(plan[0]!.added).toEqual([
      'platform::stepaudio-3-gen-preview',
      'platform::stepaudio-3-music-preview',
    ])
  })

  it('🔴 幂等：已并入后再跑一次 ⇒ 0 变更', () => {
    const first = planAudioModelBackfill(
      [{ userId: 'u1', selectableAudioModels: JSON.stringify(['platform::minimax-speech-2.8-hd']) }],
      CATALOG,
    )
    const second = planAudioModelBackfill(
      [{ userId: 'u1', selectableAudioModels: JSON.stringify(first[0]!.target) }],
      CATALOG,
    )
    expect(second[0]!.changed).toBe(false)
    expect(second[0]!.added).toEqual([])
    // 目标值必须与第一次完全一致（否则「跑两次结果不同」就是非幂等）。
    expect(second[0]!.target).toEqual(first[0]!.target)
  })

  it('🔴 只增不删：快照里已有的条目一条都不能消失（含目录里已下架的）', () => {
    // 'platform::retired-model' 已从目录移除但仍在用户快照里 —— 回填不得动它。
    const snapshot = ['platform::retired-model', 'platform::minimax-speech-2.8-hd']
    const plan = planAudioModelBackfill(
      [{ userId: 'u1', selectableAudioModels: JSON.stringify(snapshot) }],
      CATALOG,
    )
    for (const kept of snapshot) expect(plan[0]!.target).toContain(kept)
    expect(plan[0]!.target.slice(0, 2)).toEqual(snapshot)
  })

  it('空快照（默认 "[]"）⇒ 并入全部目录条目', () => {
    const plan = planAudioModelBackfill([{ userId: 'u1', selectableAudioModels: '[]' }], CATALOG)
    expect(plan[0]!.target).toEqual(CATALOG)
    expect(plan[0]!.changed).toBe(true)
  })

  it('用户主动停用过的模型会被重新加回来（已知代价，脚本必须如实报告而不是静默）', () => {
    // 用户曾把 music 模型从可选里删掉。DB 里这与「新上架」同形，无法区分 ⇒ 本口径选择并入。
    // 这条测试的作用是把该行为**钉死并显式命名**，避免以后有人误以为它没发生。
    const plan = planAudioModelBackfill(
      [{ userId: 'u1', selectableAudioModels: JSON.stringify(['platform::minimax-speech-2.8-hd']) }],
      CATALOG,
    )
    expect(plan[0]!.added).toContain('platform::stepaudio-3-music-preview')
    expect(plan[0]!.reason).toContain('2')
  })

  it('脏数据（非法 JSON）⇒ 保守当空数组补齐，并计入 changed 供人工核对', () => {
    const plan = planAudioModelBackfill([{ userId: 'u1', selectableAudioModels: 'not-json' }], CATALOG)
    expect(plan[0]!.changed).toBe(true)
    expect(plan[0]!.target).toEqual(CATALOG)
  })

  it('🔴 回归锁：入参字段名必须与 Prisma 列名逐字一致，否则整表被误判为待写', () => {
    // 真实实现曾把入参字段叫 `dbSelectableAudioModels`，而 Prisma 返回的是
    // `selectableAudioModels` ⇒ 纯函数读到 undefined ⇒ 走「解析失败当空数组」分支
    // ⇒ dry-run 报告**每一行**都 +6、target 变成完整目录 ⇒ 用户的既有选择被整体丢弃，
    // 而脚本输出看起来完全正常。本条把该失效形态显式钉住（错字段名 ⇒ 必然全表重写），
    // 与下面那条「字段名正确 ⇒ 已完整的行不动」互为对照。
    const plan = planAudioModelBackfill(
      // @ts-expect-error 故意传错字段名，模拟历史缺陷
      [{ userId: 'u1', dbSelectableAudioModels: JSON.stringify(CATALOG) }],
      CATALOG,
    )
    expect(plan[0]!.changed).toBe(true)
    expect(plan[0]!.added).toEqual(CATALOG)
  })

  it('🔴 字段名正确时，已是目标态的行（含全量目录）必须 0 变更', () => {
    const plan = planAudioModelBackfill(
      [{ userId: 'u1', selectableAudioModels: JSON.stringify(CATALOG) }],
      CATALOG,
    )
    expect(plan[0]!.changed).toBe(false)
    expect(plan[0]!.added).toEqual([])
  })
})

describe('planPlatformChannelSync', () => {
  const CATALOG_MODELS = [
    { name: 'minimax-speech-2.8-hd', capability: 'audio' },
    { name: 'stepaudio-3-gen-preview', capability: 'audio' },
    { name: 'stepaudio-3-music-preview', capability: 'audio' },
  ]

  it('历史快照缺新模型 ⇒ 对齐到目录', () => {
    const plan = planPlatformChannelSync(
      JSON.stringify([{ name: 'minimax-speech-2.8-hd', capability: 'audio' }]),
      CATALOG_MODELS,
    )
    expect(plan.changed).toBe(true)
    expect(plan.target).toEqual(CATALOG_MODELS)
  })

  it('幂等：已对齐后再跑 ⇒ 0 变更', () => {
    const plan = planPlatformChannelSync(JSON.stringify(CATALOG_MODELS), CATALOG_MODELS)
    expect(plan.changed).toBe(false)
  })

  it('🔴 顺序/能力不同也算落后（平台渠道是目录镜像，必须逐条相等）', () => {
    const plan = planPlatformChannelSync(
      JSON.stringify([
        { name: 'stepaudio-3-music-preview', capability: 'audio' },
        { name: 'minimax-speech-2.8-hd', capability: 'audio' },
        { name: 'stepaudio-3-gen-preview', capability: 'audio' },
      ]),
      CATALOG_MODELS,
    )
    expect(plan.changed).toBe(true)
  })
})
