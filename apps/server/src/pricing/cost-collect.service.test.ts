// apps/server/src/pricing/cost-collect.service.test.ts
import { describe, expect, it } from 'vitest'
import { parseFalVideoCosts, fxUsdCny, collectMinimax, collectStepfun, collectZhipu, type AdapterModel } from './cost-collect.service'

/**
 * 采集适配器纯逻辑回归（fetch 注入路径由 sqlite 集成测试覆盖）。
 * spec: docs/design/2026-11-15-cost-auto-collect-design.md §3。
 */

const falVideoModel: AdapterModel = { modelKey: 'h3-max', gatewayModelId: 'minimax/h3-max', videoRes: ['480p', '768p', '2k'], audioTiers: [] }

const FAL_PAGE_SNIPPET = `<div>Video costs <strong>$0.05</strong> per second at <strong>480p</strong>, <strong>$0.08</strong> per second at <strong>768p</strong> and <strong>$0.32</strong> per second at <strong>2K</strong>.</div>`

describe('parseFalVideoCosts（fal 页面 SSR 直价句式解析）', () => {
  it('解析 HTML 内每分辨率直价（** 加粗与标签剥离）', () => {
    const out = parseFalVideoCosts(FAL_PAGE_SNIPPET)
    expect(out).toEqual([
      { res: '480p', usd: 0.05 },
      { res: '768p', usd: 0.08 },
      { res: '2k', usd: 0.32 },
    ])
  })
  it('2K/1080p/4K 中仅枚举内档位保留（1080p/4K 不猜）', () => {
    const out = parseFalVideoCosts('Video costs $0.05 per second at 480p, $0.16 per second at 1080p and $0.16 per second at 4K.')
    expect(out).toEqual([{ res: '480p', usd: 0.05 }])
  })
  it('无句式返回空数组（跳过不猜）', () => {
    expect(parseFalVideoCosts('<html>pricing unavailable</html>')).toEqual([])
  })
})

describe('collectMinimax（官方牌价常量表 + fx 录入侧折算）', () => {
  const m: AdapterModel = { modelKey: 'minimax-h3', gatewayModelId: 'MiniMax-H3', videoRes: ['480p', '768p', '2k'], audioTiers: [] }
  it('768p/2k 有官方价（×fx），480p 官方不提供 ⇒ skip 不猜', () => {
    const rep = collectMinimax([m])
    expect(rep.status).toBe('ok')
    const specs = rep.candidates.map((c) => c.spec).sort()
    expect(specs).toEqual(['2k', '768p'])
    const fx = fxUsdCny()
    const p768 = rep.candidates.find((c) => c.spec === '768p')!
    expect(p768.costYuan).toBeCloseTo(0.08 * fx, 10)
    expect(p768.evidence.url).toContain('platform.minimax.io')
    expect(rep.skips).toEqual([{ modelKey: 'minimax-h3', spec: '480p', reason: expect.stringContaining('该分辨率') }])
  })
})

describe('collectZhipu（CogVideoX-Flash 免费 ⇒ D1 显式 0 价）', () => {
  it('三档分辨率全部 0 元 official_list 行', () => {
    const m: AdapterModel = { modelKey: 'cogvideox-flash', gatewayModelId: 'cogvideox-flash', videoRes: ['480p', '768p', '2k'], audioTiers: [] }
    const rep = collectZhipu([m])
    expect(rep.candidates).toHaveLength(3)
    for (const c of rep.candidates) {
      expect(c.costYuan).toBe(0)
      expect(c.source).toBe('official_list')
      expect(c.unit).toBe('per_second')
    }
    expect(rep.candidates[0]!.evidence.url).toContain('docs.bigmodel.cn')
  })
})

describe('collectStepfun（人民币直价 + 口径不匹配跳过）', () => {
  it('step-tts-mini voice=0.009 元/百字符精确；gen/music 口径不匹配 skip', () => {
    const mini: AdapterModel = { modelKey: 'step-tts-mini', gatewayModelId: 'step-tts-mini', videoRes: [], audioTiers: [{ spec: 'voice', rowSpec: 'per_100_chars', unit: 'per_call', unitQuantity: 100 }] }
    const gen: AdapterModel = { modelKey: 'stepaudio-3-gen-preview', gatewayModelId: 'stepaudio-3-gen-preview', videoRes: [], audioTiers: [{ spec: 'design', rowSpec: 'per_100_chars', unit: 'per_call', unitQuantity: 100 }] }
    const rep = collectStepfun([mini, gen])
    expect(rep.candidates).toHaveLength(1)
    expect(rep.candidates[0]!.costYuan).toBe(0.009)
    expect(rep.candidates[0]!.rowSpec).toBe('per_100_chars')
    expect(rep.skips).toHaveLength(1)
    expect(rep.skips[0]!.reason).toContain('口径不匹配')
  })
})
