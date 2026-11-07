import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentTurnTimeline from './AgentTurnTimeline.vue'
import { MOBILE_NODE_OPEN_VIEWER_KEY } from '@/composables/canvasNodeActions'
import type { TimelinePart } from './turnTimeline'
import type { DeliveryItem } from './deliverySummary'

/**
 * E2-a 回合产物幽灵摘要（规格 2026-11-04-e2a-ghost-delivery-summary §3 D-b/D-c/E-d）：
 * 锁「用户可感知的结果」——显隐边界、展开两态、viewer 直开路由、令牌纪律。
 */

const artifact = (over: Partial<Extract<TimelinePart, { kind: 'artifact' }>> = {}): TimelinePart => ({
  kind: 'artifact',
  id: `a-${over.nodeId ?? 'n1'}`,
  nodeId: over.nodeId ?? 'n1',
  nodeType: over.nodeType ?? 'image',
  title: over.title ?? '概念图 A',
  status: over.status ?? 'done',
  ...(over.url === undefined ? {} : { url: over.url }),
  ...(over.progressElapsedMs === undefined ? {} : { progressElapsedMs: over.progressElapsedMs }),
} as TimelinePart)

const canvasNode = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, data })

function mountTimeline(
  parts: TimelinePart[],
  opts: {
    viewer?: ReturnType<typeof vi.fn>
    nodes?: unknown[] | null
    digestEntry?: DeliveryItem | null
  } = {},
) {
  return mount(AgentTurnTimeline, {
    props: {
      parts,
      canvasNodes: (opts.nodes === undefined ? [] : opts.nodes) as never,
      ...(opts.digestEntry === undefined ? {} : { digestEntry: opts.digestEntry }),
    },
    global: opts.viewer
      ? { provide: { [MOBILE_NODE_OPEN_VIEWER_KEY as symbol]: opts.viewer } }
      : undefined,
    attachTo: document.body,
  })
}

describe('AgentTurnTimeline — 幽灵摘要显隐（D-b）', () => {
  it('done≥1 且无 running ⇒ 渲染，文案含「查看本轮产物 · 2」', () => {
    const w = mountTimeline(
      [
        artifact({ nodeId: 'n1', url: 'https://x/a.png' }),
        artifact({ nodeId: 'n2', title: '概念图 B', url: 'https://x/b.png' }),
      ],
      {
        nodes: [
          canvasNode('n1', 'image', { url: 'https://x/a.png' }),
          canvasNode('n2', 'image', { url: 'https://x/b.png' }),
        ],
      },
    )
    const row = w.find('[data-test="delivery-summary"]')
    expect(row.exists(), '有产物且回合收束 ⇒ 幽灵行在').toBe(true)
    expect(row.text()).toContain('查看本轮产物 · 2')
  })

  it('N=0 ⇒ 不渲染', () => {
    const w = mountTimeline([artifact({ nodeId: 'n1', status: 'failed' })])
    expect(w.find('[data-test="delivery-summary"]').exists()).toBe(false)
  })

  it('failed 不计入 N', () => {
    const w = mountTimeline(
      [
        artifact({ nodeId: 'n1', url: 'https://x/a.png' }),
        artifact({ nodeId: 'n2', status: 'failed' }),
      ],
      { nodes: [canvasNode('n1', 'image', { url: 'https://x/a.png' })] },
    )
    expect(w.find('[data-test="delivery-summary"]').text()).toContain('· 1')
  })

  it('存在 running artifact（回合进行中）⇒ 不渲染', () => {
    const w = mountTimeline([
      artifact({ nodeId: 'n1', url: 'https://x/a.png' }),
      artifact({ nodeId: 'n3', status: 'running', progressElapsedMs: 12_000 }),
    ])
    expect(w.find('[data-test="delivery-summary"]').exists()).toBe(false)
  })
})

describe('AgentTurnTimeline — 展开两态与 tile（D-d/E-d）', () => {
  it('默认收起；点击展开出现 tile 条，再点收起', async () => {
    const w = mountTimeline([artifact({ nodeId: 'n1', url: 'https://x/a.png' })], {
      nodes: [canvasNode('n1', 'image', { url: 'https://x/a.png' })],
    })
    expect(w.find('[data-test="delivery-strip"]').exists()).toBe(false)
    await w.find('[data-test="delivery-toggle"]').trigger('click')
    expect(w.find('[data-test="delivery-strip"]').exists()).toBe(true)
    expect(w.findAll('[data-test^="delivery-tile-"]').length).toBe(1)
    await w.find('[data-test="delivery-toggle"]').trigger('click')
    expect(w.find('[data-test="delivery-strip"]').exists()).toBe(false)
  })

  it('无图产物（audio/text）渲染类型 tile，video 带时长徽标', async () => {
    const w = mountTimeline([
      artifact({ nodeId: 'n1', nodeType: 'audio', title: 'bgm' }),
      artifact({ nodeId: 'n2', nodeType: 'text', title: '文案', url: undefined }),
      artifact({ nodeId: 'n3', nodeType: 'video', title: '宣传片', url: 'https://x/v.mp4' }),
    ], {
      nodes: [
        canvasNode('n1', 'audio', {}),
        canvasNode('n2', 'text', {}),
        canvasNode('n3', 'video', { url: 'https://x/v.mp4', durationMs: 84_000 }),
      ],
    })
    await w.find('[data-test="delivery-toggle"]').trigger('click')
    const strip = w.find('[data-test="delivery-strip"]').text()
    expect(strip).toContain('1:24')
  })
})

describe('AgentTurnTimeline — viewer 直开路由（D-c）', () => {
  it('resolve 成功 + inject 命中 ⇒ openViewer({id,type,data})，data 为节点本体', async () => {
    const viewer = vi.fn()
    const w = mountTimeline([artifact({ nodeId: 'n1', url: 'https://x/a.png' })], {
      viewer,
      nodes: [canvasNode('n1', 'image', { url: 'https://x/a.png' })],
    })
    await w.find('[data-test="delivery-toggle"]').trigger('click')
    await w.find('[data-test="delivery-tile-n1"]').trigger('click')
    expect(viewer).toHaveBeenCalledTimes(1)
    expect(viewer).toHaveBeenCalledWith({ id: 'n1', type: 'image', data: { url: 'https://x/a.png' } })
    expect(w.emitted('focusNode'), 'viewer 命中时不发定位').toBeUndefined()
  })

  it('inject 缺省（预览页/桌面）⇒ 降级 emit focusNode', async () => {
    const w = mountTimeline([artifact({ nodeId: 'n1', url: 'https://x/a.png' })], {
      nodes: [canvasNode('n1', 'image', { url: 'https://x/a.png' })],
    })
    await w.find('[data-test="delivery-toggle"]').trigger('click')
    await w.find('[data-test="delivery-tile-n1"]').trigger('click')
    expect(w.emitted('focusNode')).toEqual([['n1']])
  })

  it('定位角标 ⇒ 始终 emit focusNode', async () => {
    const viewer = vi.fn()
    const w = mountTimeline([artifact({ nodeId: 'n1', url: 'https://x/a.png' })], {
      viewer,
      nodes: [canvasNode('n1', 'image', { url: 'https://x/a.png' })],
    })
    await w.find('[data-test="delivery-toggle"]').trigger('click')
    await w.find('[data-test="delivery-locate-n1"]').trigger('click')
    expect(w.emitted('focusNode')).toEqual([['n1']])
  })

  it('节点已删（canvasNodes 无此 nodeId）⇒ tile 整体从清单过滤，计数同步减（Q2）', async () => {
    const w = mountTimeline(
      [
        artifact({ nodeId: 'n1', url: 'https://x/a.png' }),
        artifact({ nodeId: 'n2', title: '概念图 B', url: 'https://x/b.png' }),
      ],
      { nodes: [canvasNode('n1', 'image', { url: 'https://x/a.png' })] },
    )
    expect(w.find('[data-test="delivery-summary"]').text(), '计数只含存活节点').toContain('· 1')
    await w.find('[data-test="delivery-toggle"]').trigger('click')
    expect(w.find('[data-test="delivery-tile-n1"]').exists()).toBe(true)
    expect(w.find('[data-test="delivery-tile-n2"]').exists(), '已删节点不留幽灵 tile').toBe(false)
  })

  it('canvasNodes=null（未接线/未知态）⇒ 不过滤，保守显示', () => {
    const w = mountTimeline([artifact({ nodeId: 'n1', url: 'https://x/a.png' })], { nodes: null })
    expect(w.find('[data-test="delivery-summary"]').text()).toContain('· 1')
  })
})

describe('AgentTurnTimeline — 埋点接线（§6）', () => {
  it('四类打点在位：impression / expand / viewer_open / locate', () => {
    const src = readSelf()
    expect(src).toContain("observeDeliveryCard('impression')")
    expect(src).toContain("observeDeliveryCard('expand')")
    expect(src).toContain("observeDeliveryCard('viewer_open'")
    expect(src).toContain("observeDeliveryCard('locate'")
  })
})

describe('AgentTurnTimeline — 令牌纪律（E-d）', () => {
  it('全文件 hex 数保持 0（基线 f2c954ce 即 0，棘轮只减不增）', () => {
    expect(readSelf().match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toHaveLength(0)
  })
  it('--neo- 不超过基线 15 处（neoUsageRatchet 同口径）', () => {
    expect((readSelf().match(/--neo-/g) ?? []).length).toBeLessThanOrEqual(15)
  })
  it('新增幽灵摘要样式段（E2-A-DELIVERY 标记内）零 --neo- / 零 hex', () => {
    const src = readSelf()
    const seg = src.slice(src.indexOf('E2-A-DELIVERY-BEGIN'), src.indexOf('E2-A-DELIVERY-END'))
    expect(seg.length, '标记段必须存在于 style 内').toBeGreaterThan(0)
    expect(seg).not.toMatch(/--neo-/)
    expect(seg).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})

describe('AgentTurnTimeline — 交付条裁切防回归（2026-11-05 Q3）', () => {
  it('.delivery-strip 为上溢定位角标（top:-5px）预留头部 padding，防 overflow-x 滚动容器裁切', () => {
    const rule = readSelf().match(/\.delivery-strip \{[^}]*\}/)
    expect(rule, '.delivery-strip 规则必须在位').toBeTruthy()
    const pt = rule![0].match(/padding-top\s*:\s*(\d+)px/)
    expect(pt, '必须以 px 显式设置 padding-top').toBeTruthy()
    expect(Number(pt![1]), '头部预留须 ≥6px（角标上溢 5px + 1px 余量）').toBeGreaterThanOrEqual(6)
  })
})

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
function readSelf(): string {
  return readFileSync(join(here, 'AgentTurnTimeline.vue'), 'utf8')
}

// ── 2026-11-06：文本/HTML/总览 tile 分叉（规格 #636 §4.7 + E2-a D-d）───────
describe('AgentTurnTimeline — 交付条文本系产物可区分', () => {
  it('纯文本 ⇒ 文档图标 + 左下「文本」小字，无 HTML/总览图标', async () => {
    const w = mountTimeline([artifact({ nodeId: 't1', nodeType: 'text', title: '文案' })], {
      nodes: [canvasNode('t1', 'text', { content: '一段文案' })],
    })
    await w.find('[data-test="delivery-toggle"]').trigger('click')
    const tile = w.find('[data-test="delivery-tile-t1"]')
    expect(tile.exists()).toBe(true)
    expect(tile.find('[data-testid="delivery-tile-icon-html"]').exists()).toBe(false)
    expect(tile.find('[data-testid="delivery-tile-type"]').text()).toBe('文本')
    w.unmount()
  })

  it('format:html ⇒ 代码图标 + 左下「HTML」小字（入口即可预期沙箱预览）', async () => {
    const w = mountTimeline([artifact({ nodeId: 't1', nodeType: 'text', title: '落地页' })], {
      nodes: [canvasNode('t1', 'text', { format: 'html', content: '<html><title>落地页</title></html>' })],
    })
    await w.find('[data-test="delivery-toggle"]').trigger('click')
    const tile = w.find('[data-test="delivery-tile-t1"]')
    expect(tile.find('[data-testid="delivery-tile-icon-html"]').exists()).toBe(true)
    expect(tile.find('[data-testid="delivery-tile-type"]').text()).toBe('HTML')
    w.unmount()
  })

  it('P1a：系统总览不进「本轮产物」清单（零产物/历史回合不再虚报）', async () => {
    const w = mountTimeline([artifact({ nodeId: 'n1', url: 'https://x/a.png' })], {
      nodes: [
        canvasNode('n1', 'image', { url: 'https://x/a.png' }),
        canvasNode('d1', 'text', { digest: true, format: 'html', source: 'system-digest' }),
      ],
    })
    await w.find('[data-test="delivery-toggle"]').trigger('click')
    expect(w.find('[data-test="delivery-tile-n1"]').exists()).toBe(true)
    expect(w.find('[data-test="delivery-tile-d1"]').exists()).toBe(false)
    expect(w.find('[data-test="digest-entry"]').exists()).toBe(false)
    w.unmount()
  })

  it('P1a：digestEntry 只在最后一轮传入 ⇒ 独立「画布总览」入口，点击走 viewer（含 digest_open）', async () => {
    const viewer = vi.fn()
    // 纯聊天回合（只有 text part、零 artifact）仍是真实渲染的 timeline 回合
    const w = mountTimeline([{ kind: 'text', id: 't-1', text: '好的', status: 'done' }], {
      viewer,
      nodes: [canvasNode('d1', 'text', { digest: true, format: 'html', source: 'system-digest' })],
      digestEntry: { nodeId: 'd1', nodeType: 'text', title: '画布总览', digest: true, format: 'html' },
    })
    // 零产物回合 ⇒ 交付条整行隐藏，但会话级总览入口仍可用
    expect(w.find('[data-test="delivery-toggle"]').exists()).toBe(false)
    const entry = w.find('[data-test="digest-entry"]')
    expect(entry.exists()).toBe(true)
    expect(entry.text()).toContain('画布总览')
    await entry.trigger('click')
    expect(viewer).toHaveBeenCalledTimes(1)
    w.unmount()
  })
})
