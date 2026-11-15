// apps/server/src/pricing/pricing-announcement.service.test.ts
// 调价公告生成器单测（2026-11-15-pricing-change-announcement-design §5 降噪 + §9 验收）。
import { describe, expect, it } from 'vitest'
import { buildChangeDetails, specLabelOf, summarize } from './pricing-announcement.service'
import { TEXT_TOKEN_KEY_PATTERN } from './pricing.core'

function entry(matchKey: string, credits: number, subjectKey: string | null = null) {
  const capability = matchKey.split('|')[0] ?? matchKey.split(':')[0] ?? 'text'
  return { matchKey, subjectKey, capability, credits }
}

const names = new Map([
  ['h3-max', '海螺 H3 Max'],
  ['agnes-2.5-flash', 'Agnes 2.5 Flash'],
  ['cogvideox-flash', 'CogVideoX Flash'],
])

describe('buildChangeDetails（降噪过滤）', () => {
  const from = [
    entry('image|h3-max|768p|volcengine|apimart', 45, 'image|h3-max|768p|volcengine|apimart'),
    entry('text:agnes-2.5-flash:in', 3636),
    entry('video|cogvideox-flash|768p:5s|zhipu|official', 1, 'video|cogvideox-flash|768p:5s|zhipu|official'),
    entry('image|legacy-model|1K|foo|bar', 10), // legacy-equivalent（无 subjectKey、非 text:）→ 不公告
  ]
  const to = [
    entry('image|h3-max|768p|volcengine|apimart', 315, 'image|h3-max|768p|volcengine|apimart'),
    entry('text:agnes-2.5-flash:in', 181818),
    entry('video|cogvideox-flash|768p:5s|zhipu|official', 0, 'video|cogvideox-flash|768p:5s|zhipu|official'),
    entry('image|legacy-model|1K|foo|bar', 999), // legacy 行变了也不公告（不在扣费路径）
  ]

  it('主体行 + 文本反比率行入明细；legacy-equivalent 行过滤（§5.1）', () => {
    const items = buildChangeDetails(from, to, names)
    expect(items.map((i) => `${i.capability}|${i.modelKey}|${i.spec}`)).toEqual([
      'text|agnes-2.5-flash|in',
      'image|h3-max|768p',
      'video|cogvideox-flash|768p:5s',
    ])
  })

  it('from/to/pct/kind 逐字段正确（涨价/降价/新增）', () => {
    const items = buildChangeDetails(from, to, names)
    const text = items.find((i) => i.modelKey === 'agnes-2.5-flash')!
    expect(text.from).toBe(3636)
    expect(text.to).toBe(181818)
    expect(text.kind).toBe('increase')
    const img = items.find((i) => i.modelKey === 'h3-max')!
    expect(img.from).toBe(45)
    expect(img.to).toBe(315)
    expect(Math.round((img.pct as number) * 100)).toBe(600)
    const vid = items.find((i) => i.modelKey === 'cogvideox-flash')!
    expect(vid.kind).toBe('decrease')
    expect(vid.to).toBe(0)
    // displayName 落目录名，缺目录回落 modelKey
    expect(img.displayName).toBe('海螺 H3 Max')
    expect(text.displayName).toBe('Agnes 2.5 Flash')
  })

  it('credits 不变的行不入明细（改成本但利润抵消 ⇒ 不生成公告的前置）', () => {
    const items = buildChangeDetails(
      [entry('image|a|1K|p|u', 33, 'image|a|1K|p|u')],
      [entry('image|a|1K|p|u', 33, 'image|a|1K|p|u')],
      names,
    )
    expect(items).toEqual([])
  })

  it('按 |Δ| 降序（Top N 首屏感知项在前）', () => {
    const items = buildChangeDetails(from, to, names)
    const deltas = items.map((i) => Math.abs(i.to - i.from))
    for (let i = 1; i < deltas.length; i++) expect(deltas[i - 1]!).toBeGreaterThanOrEqual(deltas[i]!)
  })

  it('specLabelOf 人话化（§5.3）', () => {
    expect(specLabelOf('video', '768p:5s')).toBe('768p · 5 秒')
    expect(specLabelOf('text', 'in')).toBe('输入（每百万 token）')
    expect(specLabelOf('audio', 'music')).toBe('音乐（每首）')
    expect(specLabelOf('image', '2K')).toBe('2K（每张）')
  })

  it('summarize 摘要拼装', () => {
    const items = buildChangeDetails(from, to, names)
    const s = summarize(items)
    expect(s).toContain('涨价')
    expect(s).toContain('降价')
    expect(summarize([])).toBe('')
  })

  it('TEXT_TOKEN_KEY_PATTERN 判据与 text: 反比率行匹配（键形真源）', () => {
    expect(TEXT_TOKEN_KEY_PATTERN.test('text:agnes-2.5-flash:in')).toBe(true)
    expect(TEXT_TOKEN_KEY_PATTERN.test('image|h3-max|768p|volcengine|apimart')).toBe(false)
  })
})
