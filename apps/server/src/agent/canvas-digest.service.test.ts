import { describe, expect, it } from 'vitest'
import { renderDigestHtml, type DigestSnapshot } from './canvas-digest.service'

/**
 * Canvas Digest 纯渲染函数测试（spec 2026-11-05-canvas-digest-design §5.3/§6.0）。
 * 判据锚点：D3 封顶 / D4 内容边界 / D7 XSS / D8 URL 绝对化 / D9 有正据才收 / S1 验收清单。
 */

const OPTS = { publicBaseUrl: 'https://pi.example.com' }

/** Asia/Shanghai 14:32 == UTC 06:32 —— 断言服务端渲染使用固定 UTC 输入得到本地时刻。 */
function fixture(overrides?: Partial<DigestSnapshot>): DigestSnapshot {
  return {
    digestVersion: 1,
    updatedAt: new Date('2026-11-05T06:32:00Z'),
    nodes: [
      { id: 'img1', nodeType: 'image', title: '主视觉草图', url: '/uploads/a.png' },
      {
        id: 'img2',
        nodeType: 'image',
        title: '备选封面',
        url: 'https://cdn.example.com/b.jpg',
      },
      { id: 'vid1', nodeType: 'video', title: '开场镜头', url: '/uploads/c.mp4', durationSec: 42 },
      { id: 'aud1', nodeType: 'audio', title: '旁白配音', url: '/uploads/d.mp3' },
      { id: 'txt1', nodeType: 'text', title: '角色设定文案', content: '机密正文不应出现' },
    ],
    ...overrides,
  }
}

describe('renderDigestHtml', () => {
  it('S1 首产出：输出 HTML 含 Header/更新时间/版本与 viewport、lazy、双主题', () => {
    const html = renderDigestHtml(fixture(), OPTS)
    expect(typeof html).toBe('string')
    expect(html).toContain('画布总览')
    expect(html).toContain('14:32')
    expect(html).toContain('第 1 版')
    expect(html).toContain('<meta name="viewport"')
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('prefers-color-scheme')
  })

  it('S1 分区固定顺序 图片→视频→音频→文本', () => {
    const html = renderDigestHtml(fixture(), OPTS) as string
    const order = ['image', 'video', 'audio', 'text'].map((t) =>
      html.indexOf(`data-section="${t}"`),
    )
    expect(order.every((i) => i >= 0)).toBe(true)
    expect(order[0]).toBeLessThan(order[1]!)
    expect(order[1]!).toBeLessThan(order[2]!)
    expect(order[2]!).toBeLessThan(order[3]!)
  })

  it('S1 Stats 分类型计数行', () => {
    const html = renderDigestHtml(fixture(), OPTS) as string
    expect(html).toContain('2 图片')
    expect(html).toContain('1 视频')
    expect(html).toContain('1 音频')
    expect(html).toContain('1 文本')
  })

  it('S1 video 时长徽标（durationSec 42 ⇒ 0:42）', () => {
    const html = renderDigestHtml(fixture(), OPTS) as string
    expect(html).toContain('0:42')
  })

  it('D4 内容边界：不读节点正文（text.content 不出现在输出）', () => {
    const html = renderDigestHtml(fixture(), OPTS) as string
    expect(html).not.toContain('机密正文不应出现')
  })

  it('D7 XSS：title 恶意 payload 全上下文转义', () => {
    const html = renderDigestHtml(
      fixture({
        nodes: [
          { id: 'x1', nodeType: 'image', title: '<script>alert(1)</script>', url: '/a.png' },
          { id: 'x2', nodeType: 'image', title: '"><img src=x onerror=alert(1)>', url: '/b.png' },
          { id: 'x3', nodeType: 'image', title: `'单引号"&双引号`, url: '/c.png' },
        ],
      }),
      OPTS,
    ) as string
    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&quot;')
    expect(html).toContain('&#39;')
  })

  it('D8 URL 绝对化：相对 url 拼 publicBaseUrl；绝对 url 透传', () => {
    const html = renderDigestHtml(fixture(), OPTS) as string
    expect(html).toContain('https://pi.example.com/uploads/a.png')
    expect(html).toContain('https://cdn.example.com/b.jpg')
    expect(html).not.toContain('https://pi.example.com/https')
  })

  it('D9 有正据才收：无 url 的 draft 节点不进分区，Footer 计入未收录', () => {
    const html = renderDigestHtml(
      fixture({
        nodes: [
          { id: 'img1', nodeType: 'image', title: '已产出', url: '/uploads/a.png' },
          { id: 'img9', nodeType: 'image', title: '生成中草图' },
        ],
      }),
      OPTS,
    ) as string
    expect(html).not.toContain('生成中草图')
    expect(html).toContain('1 项生成中未收录')
  })

  it('P2 未收录按状态分桶：failed / draft / generating 各自成文案，不再一律「生成中」', () => {
    const html = renderDigestHtml(
      fixture({
        nodes: [
          { id: 'ok', nodeType: 'image', title: '已产出', url: '/a.png' },
          { id: 'f1', nodeType: 'image', title: '失败的图', status: 'failed' },
          { id: 'f2', nodeType: 'image', title: '报错的图', status: 'error' },
          { id: 'd1', nodeType: 'text', status: 'draft' },
          { id: 'g1', nodeType: 'image', title: '正在出图', status: 'generating' },
          { id: 'u1', nodeType: 'image', title: '状态未知' },
        ],
      }),
      OPTS,
    ) as string
    expect(html).toContain('2 项生成失败未收录')
    expect(html).toContain('1 项待完成未收录')
    // 状态缺省保守归入「生成中」，历史快照文案零变化
    expect(html).toContain('2 项生成中未收录')
    expect(html).not.toContain('5 项生成中未收录')
  })

  it('D3 封顶：101 节点只渲染 100 + 其余 1 项未收录', () => {
    const nodes = Array.from({ length: 101 }, (_, i) => ({
      id: `img${i}`,
      nodeType: 'image' as const,
      title: `图${i}`,
      url: `/uploads/${i}.png`,
    }))
    const html = renderDigestHtml(fixture({ nodes }), OPTS) as string
    const tiles = html.match(/data-node-id="img/g) ?? []
    expect(tiles.length).toBe(100)
    expect(html).toContain('其余 1 项未收录')
  })

  it('D4 title 缺失兜底：未命名图片/视频/音频/文档', () => {
    const html = renderDigestHtml(
      fixture({
        nodes: [
          { id: 'i', nodeType: 'image', url: '/i.png' },
          { id: 'v', nodeType: 'video', url: '/v.mp4' },
          { id: 'a', nodeType: 'audio', url: '/a.mp3' },
          { id: 't', nodeType: 'text', content: '有正据的正文' },
        ],
      }),
      OPTS,
    ) as string
    expect(html).toContain('未命名图片')
    expect(html).toContain('未命名视频')
    expect(html).toContain('未命名音频')
    expect(html).toContain('未命名文档')
  })

  it('空快照（无任何可收录节点）⇒ 返回 null', () => {
    expect(renderDigestHtml(fixture({ nodes: [] }), OPTS)).toBeNull()
    expect(
      renderDigestHtml(fixture({ nodes: [{ id: 'd', nodeType: 'image', title: '生成中' }] }), OPTS),
    ).toBeNull()
  })
})

// ── Task 2：触发判定 / 快照采集 / upsert 编排（spec D1/D2/D6/S6/S7）──

import {
  CanvasDigestService,
  buildDigestUpsertActions,
  collectDigestSnapshot,
  resolveNextDigestVersion,
} from './canvas-digest.service'
import { applyCanvasActions } from '@lnkpi/agent'

type RawNode = {
  id: string
  type?: string
  position?: { x: number; y: number }
  data?: Record<string, unknown>
}

function canvasOf(nodes: RawNode[]): { nodes: RawNode[]; edges: unknown[] } {
  return { nodes, edges: [] }
}

describe('collectDigestSnapshot', () => {
  it('空间序 y→x 扫描序 + 画布态字段映射（title/url/mediaInfo.durationSec）', () => {
    const snapshot = collectDigestSnapshot(
      canvasOf([
        { id: 'b', type: 'image', position: { x: 400, y: 100 }, data: { title: '右图', url: '/b.png' } },
        { id: 'a', type: 'image', position: { x: 100, y: 100 }, data: { title: '左图', url: '/a.png' } },
        {
          id: 'v',
          type: 'video',
          position: { x: 100, y: 400 },
          data: { title: '视频', url: '/v.mp4', mediaInfo: { output: { durationSec: 42 } } },
        },
      ]),
    )
    expect(snapshot.nodes.map((n) => n.id)).toEqual(['a', 'b', 'v'])
    expect(snapshot.nodes[2]).toMatchObject({ nodeType: 'video', durationSec: 42 })
  })

  it('防自吞：data.digest 节点自身与下线类型不进快照', () => {
    const snapshot = collectDigestSnapshot(
      canvasOf([
        { id: 'd1', type: 'text', data: { digest: true, title: '画布总览', content: '<html/>' } },
        { id: 'legacy', type: 'prompt', data: { title: '历史类型' } },
        { id: 'keep', type: 'text', data: { title: '正文文档', content: 'x' } },
      ]),
    )
    expect(snapshot.nodes.map((n) => n.id)).toEqual(['keep'])
  })
})

describe('buildDigestUpsertActions', () => {
  it('D2 无 digest 节点 ⇒ add_node（text/format html/source/digest/digestVersion）', () => {
    const { nodeId, actions } = buildDigestUpsertActions({
      canvas: canvasOf([{ id: 'img1', type: 'image', data: { title: '图', url: '/a.png' } }]),
      html: '<html>总览</html>',
      digestVersion: 1,
    })
    expect(actions.length).toBe(1)
    const action = actions[0]!
    expect(action.type).toBe('add_node')
    const payload = action.payload as { nodeType: string; data: Record<string, unknown> }
    expect(payload.nodeType).toBe('text')
    expect(payload.data.format).toBe('html')
    expect(payload.data.source).toBe('system-digest')
    expect(payload.data.digest).toBe(true)
    expect(payload.data.digestVersion).toBe(1)
    expect(payload.data.title).toBe('画布总览')
    expect(payload.data.content).toBe('<html>总览</html>')
    expect(nodeId).toBe(String((action.payload as { id: string }).id))
  })

  it('D2 已有 digest 节点 ⇒ update_node 同 nodeId（digestVersion++，不新增节点）', () => {
    const { nodeId, actions } = buildDigestUpsertActions({
      canvas: canvasOf([
        { id: 'img1', type: 'image', data: { title: '图', url: '/a.png' } },
        { id: 'd1', type: 'text', data: { digest: true, digestVersion: 3 } },
      ]),
      html: '<html>v4</html>',
      digestVersion: 4,
    })
    expect(actions.length).toBe(1)
    expect(actions[0]!.type).toBe('update_node')
    const payload = actions[0]!.payload as { id: string; data: Record<string, unknown> }
    expect(payload.id).toBe('d1')
    expect(payload.data.digestVersion).toBe(4)
    expect(payload.data.content).toBe('<html>v4</html>')
    expect(nodeId).toBe('d1')
  })
})

describe('CanvasDigestService.maybeRender', () => {
  const tools = { upsertDigestNode: vi.fn() }
  const prisma = { session: { findUnique: vi.fn() } }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CANVAS_DIGEST = 'on'
  })

  const service = new CanvasDigestService(prisma as never, tools as never)

  it('S6 flag off ⇒ null 且零调用', async () => {
    const prev = process.env.CANVAS_DIGEST
    delete process.env.CANVAS_DIGEST
    try {
      const result = await service.maybeRender({
        sessionId: 's1',
        userId: 'u1',
        canvasActions: [{ type: 'add_node', payload: {} } as never],
      })
      expect(result).toBeNull()
      expect(prisma.session.findUnique).not.toHaveBeenCalled()
      expect(tools.upsertDigestNode).not.toHaveBeenCalled()
    } finally {
      if (prev === undefined) delete process.env.CANVAS_DIGEST
      else process.env.CANVAS_DIGEST = prev
    }
  })

  it('D1 canvasActions 为空 ⇒ null 零调用（纯聊天回合跳过）', async () => {
    process.env.CANVAS_DIGEST = 'on'
    const result = await service.maybeRender({ sessionId: 's1', userId: 'u1', canvasActions: [] })
    expect(result).toBeNull()
    expect(prisma.session.findUnique).not.toHaveBeenCalled()
  })

  it('正常路径：读画布 ⇒ 渲染 ⇒ upsert（html 含总览、digestVersion 递增）', async () => {
    process.env.CANVAS_DIGEST = 'on'
    prisma.session.findUnique.mockResolvedValue({
      canvasData: JSON.stringify(
        canvasOf([{ id: 'img1', type: 'image', position: { x: 0, y: 0 }, data: { title: '图', url: '/a.png' } }]),
      ),
    })
    tools.upsertDigestNode.mockResolvedValue({ nodeId: 'text-1', actions: [] })
    const result = await service.maybeRender({
      sessionId: 's1',
      userId: 'u1',
      canvasActions: [{ type: 'add_node', payload: {} } as never],
    })
    expect(result).toEqual({ nodeId: 'text-1', actions: [] })
    const call = tools.upsertDigestNode.mock.calls[0]?.[0] as { html: string; digestVersion: number }
    expect(call.html).toContain('画布总览')
    expect(call.digestVersion).toBe(1)
    expect(call.html).toContain('1 图片')
    // F1（final review）：Header 版本号须为计算后的本轮版本（曾恒渲染 snapshot 里未回填的 0）
    expect(call.html).toContain('第 1 版')
  })

  it('D6 二轮翻新：已有 digest 节点 ⇒ digestVersion 递增传递', async () => {
    process.env.CANVAS_DIGEST = 'on'
    prisma.session.findUnique.mockResolvedValue({
      canvasData: JSON.stringify(
        canvasOf([
          { id: 'img1', type: 'image', position: { x: 0, y: 0 }, data: { title: '图', url: '/a.png' } },
          { id: 'd1', type: 'text', position: { x: 0, y: 900 }, data: { digest: true, digestVersion: 3 } },
        ]),
      ),
    })
    tools.upsertDigestNode.mockResolvedValue({ nodeId: 'd1', actions: [] })
    await service.maybeRender({
      sessionId: 's1',
      userId: 'u1',
      canvasActions: [{ type: 'add_node', payload: {} } as never],
    })
    const call = tools.upsertDigestNode.mock.calls[0]?.[0] as { digestVersion: number; html: string }
    expect(call.digestVersion).toBe(4)
    // F1：翻新轮 Header 同步「第 4 版」
    expect(call.html).toContain('第 4 版')
  })

  it('S7 fail-soft：upsert 抛错 ⇒ resolve null 不向上抛', async () => {
    process.env.CANVAS_DIGEST = 'on'
    prisma.session.findUnique.mockResolvedValue({
      canvasData: JSON.stringify(
        canvasOf([{ id: 'img1', type: 'image', position: { x: 0, y: 0 }, data: { title: '图', url: '/a.png' } }]),
      ),
    })
    tools.upsertDigestNode.mockRejectedValue(new Error('staged conflict'))
    const result = await service.maybeRender({
      sessionId: 's1',
      userId: 'u1',
      canvasActions: [{ type: 'add_node', payload: {} } as never],
    })
    expect(result).toBeNull()
  })

  it('无可收录节点（全 draft）⇒ null 且不写', async () => {
    process.env.CANVAS_DIGEST = 'on'
    prisma.session.findUnique.mockResolvedValue({
      canvasData: JSON.stringify(
        canvasOf([{ id: 'img1', type: 'image', data: { title: '生成中' } }]),
      ),
    })
    const result = await service.maybeRender({
      sessionId: 's1',
      userId: 'u1',
      canvasActions: [{ type: 'add_node', payload: {} } as never],
    })
    expect(result).toBeNull()
    expect(tools.upsertDigestNode).not.toHaveBeenCalled()
  })
})

describe('Task 6：媒体加载失败降级（spec §10 风险——裂图图标）', () => {
  it('image/video tile 带内联 onerror 降级到类型图标；模板内含 dgFail 定义', () => {
    const html = renderDigestHtml({
      nodes: [
        { id: 'i1', nodeType: 'image', title: '图', url: 'https://x/a.png' },
        { id: 'v1', nodeType: 'video', title: '视频', url: 'https://x/a.mp4', durationSec: 30 },
      ],
      digestVersion: 1,
      updatedAt: new Date('2026-11-05T12:00:00Z'),
    }, { publicBaseUrl: 'https://x.example' })
    expect(html).toContain("onerror=\"dgFail(this,'image')\"")
    expect(html).toContain("onerror=\"dgFail(this,'video')\"")
    expect(html).toContain('function dgFail')
    expect(html).toContain('icon-fallback')
    // 资源正常路径不受影响：src 照旧
    expect(html).toContain('src="https://x/a.png"')
  })
})

// ── P1b（2026-11-07 生产事故）：版本号落地 + 双源自愈 ────────────────────────
describe('P1b resolveNextDigestVersion（元数据 + 上一版 HTML Header 双源）', () => {
  const digestNode = (data: Record<string, unknown>) => ({
    id: 'digest-canvas', type: 'text', data: { digest: true, ...data },
  })

  it('无 digest 节点 ⇒ 1', () => {
    expect(resolveNextDigestVersion(canvasOf([]))).toBe(1)
  })

  it('元数据正常 ⇒ +1；元数据与 Header 一致 ⇒ +1', () => {
    expect(resolveNextDigestVersion(canvasOf([digestNode({ digestVersion: 4 })]))).toBe(5)
    expect(
      resolveNextDigestVersion(
        canvasOf([digestNode({ digestVersion: 4, content: '<span class="ver">第 4 版</span>' })]),
      ),
    ).toBe(5)
  })

  it('事故形态：元数据被客户端回灌成 4、HTML 已是第 5 版 ⇒ 取 max 得 6（自愈）', () => {
    const next = resolveNextDigestVersion(
      canvasOf([digestNode({ digestVersion: 4, content: '<span class="ver">第 5 版</span>' })]),
    )
    expect(next).toBe(6)
  })

  it('脏正文的「第 99 版」不算数（只认渲染器 Header 形态）；非法元数据不抛', () => {
    expect(
      resolveNextDigestVersion(canvasOf([digestNode({ digestVersion: 3, content: '第 99 版' })])),
    ).toBe(4)
    expect(
      resolveNextDigestVersion(canvasOf([digestNode({ digestVersion: 'x' })])),
    ).toBe(1)
  })
})

describe('P1b 落库链路：buildDigestUpsertActions → applier.apply', () => {
  it('update_node 经真实 applier 后 digestVersion/content/status 全部落地（防字段被剥）', () => {
    const before = canvasOf([
      { id: 'img1', type: 'image', position: { x: 0, y: 0 }, data: { title: '图', url: '/a.png' } },
      {
        id: 'd1', type: 'text', position: { x: 80, y: 900 },
        data: { digest: true, digestVersion: 4, status: 'completed', content: '旧' },
      },
    ])
    const { actions } = buildDigestUpsertActions({
      canvas: before,
      html: '<span class="ver">第 5 版</span>',
      digestVersion: 5,
    })
    const after = applyCanvasActions(before as never, actions)
    const node = after.nodes.find((n) => n.id === 'd1')
    expect(node?.data?.digestVersion).toBe(5)
    expect(node?.data?.content).toBe('<span class="ver">第 5 版</span>')
    expect(node?.data?.status).toBe('completed')
    expect(node?.data?.digest).toBe(true)
    expect(after.nodes).toHaveLength(2)
  })
})
