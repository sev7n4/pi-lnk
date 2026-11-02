import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentTurnTimeline from './AgentTurnTimeline.vue'
import type { TimelinePart } from './turnTimeline'
import type { ProposalCanvasNode } from '@/composables/useProposalNodeData'

/**
 * proposal 卡演进两阶段：
 * - 2026-10-28 根治规格：决策点收敛进对话流内联 proposal part（取代对话流外浮卡）。
 * - 2026-11-02 卡片 UX 优化：升级为紧凑决策中枢——标题取节点名、元信息
 *   （模型·比例·预计积分·张数）恒可见、提示词 1 行预览、三动作
 *   （落锚生成/调整/取消）+ 终态折叠行（未扣减删除线=积分诚实）+
 *   品牌三联「对话──锚(滑)──画布」轨道。
 *
 * ledger R1/R2 修正：节点数据经 `canvasNodes` prop 传入（vue-flow 节点结构化
 * 形状），**不读 canvasEditor store / 不用 Pinia** —— 那是精修编辑器 store，
 * 不含画布节点。节点字段为扁平 `data`（实证自 useNodeGeneration /
 * MobileNodeEditorSheet），非嵌套 params。
 *
 * 断言落在 DOM 出口（标题/按钮/事件），不碰源码字符串。
 */

type ProposalPart = Extract<TimelinePart, { kind: 'proposal' }>

const seedNode: ProposalCanvasNode = {
  id: 'n1',
  type: 'image',
  data: {
    label: '产品主图',
    prompt: '极简电竞耳机主图',
    imageModel: 'realism-v2',
    imageAspect: '1:1',
    imageResolution: '1K',
    imageCount: 1,
    style: '写实',
  },
}

function proposalPart(overrides: Partial<ProposalPart> = {}): TimelinePart {
  return {
    kind: 'proposal',
    id: 'proposal:call-1',
    toolName: 'propose_generation',
    nodeId: 'n1',
    title: '提议生成',
    status: 'pending_confirm',
    callId: 'call-1',
    startedAt: Date.now(),
    ...overrides,
  }
}

function mountCard(overrides: { parts?: TimelinePart[]; canvasNodes?: ProposalCanvasNode[] } = {}) {
  return mount(AgentTurnTimeline, {
    props: {
      parts: overrides.parts ?? [proposalPart()],
      canvasNodes: overrides.canvasNodes ?? [seedNode],
    },
  })
}

describe('AgentTurnTimeline — proposal 紧凑决策卡（2026-11-02）', () => {
  it('pending_confirm：标题取节点名而非提示词，元信息含模型·比例·预计积分', () => {
    const w = mountCard()
    const card = w.find('[data-test="proposal-card"]')
    expect(card.exists()).toBe(true)
    // 标题位（.name）必须来自节点 label，不得回退到提示词
    expect(w.find('.name').text()).toBe('产品主图')
    expect(w.find('.name').text()).not.toContain('极简电竞耳机主图')
    expect(card.text()).toContain('realism-v2')
    expect(card.text()).toContain('1:1')
    expect(card.text()).toMatch(/预计\s*\d+\s*积分/)
    expect(card.text()).toContain('待确认')
  })

  it('无自相矛盾文案（「等待你在画布上确认生成」随决策卡入流而退役）', () => {
    const w = mountCard()
    expect(w.text()).not.toContain('等待你在画布上确认生成')
  })

  it('三动作齐全：落锚生成 / 调整（aria） / 取消（aria），决策点在对话流内', () => {
    const w = mountCard()
    const texts = w.findAll('button').map((b) => b.text())
    expect(texts).toContain('落锚生成')
    expect(w.find('button[aria-label="参数微调"]').exists()).toBe(true)
    expect(w.find('button[aria-label="取消"]').exists()).toBe(true)
    // 定位收敛纪律（2026-11-02）：每卡一个定位入口=页脚 tether button；
    // 决策行不排 CanvasLocateButton，header 锚 glyph 降级纯装饰
    expect(w.find('button[title="在画布中定位"]').exists()).toBe(false)
    expect(w.find('button[data-test="locate-link"]').exists()).toBe(true)
  })

  it('点「落锚生成」⇒ emit confirmProposal(nodeId)（单一执行入口不变量）', async () => {
    const w = mountCard()
    await w.findAll('button').find((b) => b.text() === '落锚生成')!.trigger('click')
    expect(w.emitted('confirmProposal')).toEqual([['n1']])
  })

  it('点「取消」⇒ emit cancelProposal(nodeId)（同源同语义）', async () => {
    const w = mountCard()
    await w.find('button[aria-label="取消"]').trigger('click')
    expect(w.emitted('cancelProposal')).toEqual([['n1']])
  })

  it('定位唯一入口：页脚 tether（button，键盘可达）emit focusNode；header 锚 glyph 不可点', async () => {
    const w = mountCard()
    const link = w.find('button[data-test="locate-link"]')
    expect(link.exists()).toBe(true)
    expect(link.element.tagName).toBe('BUTTON')
    await link.trigger('click')
    expect(w.emitted('focusNode')).toEqual([['n1']])
    expect(w.find('[data-test="locate-glyph"]').exists()).toBe(false)
  })

  it('无 nodeId 的 proposal（异常形态）：不渲染定位按钮/锚 glyph/弱链接，确认不 emit（防误操作）', async () => {
    const w = mountCard({ parts: [proposalPart({ nodeId: undefined })] })
    expect(w.find('button[title="在画布中定位"]').exists()).toBe(false)
    expect(w.find('[data-test="locate-glyph"]').exists()).toBe(false)
    expect(w.find('[data-test="locate-link"]').exists()).toBe(false)
    await w.findAll('button').find((b) => b.text() === '落锚生成')!.trigger('click')
    expect(w.emitted('confirmProposal')).toBeUndefined()
  })

  it('nodeId 解析失败降级不崩（ghost 节点：卡面在、标题占位、定位入口仍在）', () => {
    const w = mountCard({ parts: [proposalPart({ nodeId: 'ghost' })] })
    expect(w.find('[data-test="proposal-card"]').exists()).toBe(true)
    expect(w.text()).toContain('在画布查看')
  })

  it('提示词容器恒单行（single-line 类，超长不撑爆卡面）', () => {
    const long: ProposalCanvasNode = {
      id: 'n-long',
      type: 'image',
      data: { ...(seedNode.data ?? {}), prompt: 'x'.repeat(500) },
    }
    const w = mountCard({ parts: [proposalPart({ nodeId: 'n-long' })], canvasNodes: [long] })
    expect(w.find('[data-test="prompt-preview"]').classes()).toContain('single-line')
  })

  it('品牌锚 glyph 用 currentColor（随主题反相）；三联轨道 aria 可达', () => {
    const w = mountCard()
    const glyphSvg = w.find('[data-test="anchor-glyph"] svg')
    expect(glyphSvg.exists()).toBe(true)
    expect(glyphSvg.attributes('stroke')).toBe('currentColor')
    const rail = w.find('.trilink-rail')
    expect(rail.exists()).toBe(true)
    expect(rail.attributes('aria-label')).toContain('对话')
  })

  it('终态标签分流（2026-10-31 教训）：不得一律显示「已确认」', () => {
    expect(mountCard({ parts: [proposalPart({ status: 'confirmed' })] }).text()).toContain('已落锚')
    expect(mountCard({ parts: [proposalPart({ status: 'declined' })] }).text()).toContain('已取消')
    expect(mountCard({ parts: [proposalPart({ status: 'expired' })] }).text()).toContain('已超时')
  })

  it('终态：操作全部收起（不残留可操作入口），declined/expired 显「未扣减」', () => {
    for (const st of ['confirmed', 'declined', 'expired'] as const) {
      const w = mountCard({ parts: [proposalPart({ status: st })] })
      expect(w.find('button[aria-label="取消"]').exists()).toBe(false)
      expect(w.findAll('button').map((b) => b.text())).not.toContain('落锚生成')
      if (st !== 'confirmed') expect(w.text()).toContain('未扣减')
      expect(w.find('[data-test="locate-link"]').exists()).toBe(true)
    }
  })

  // PM 裁决（2026-11-02）：执行卡在场时 confirmed 提议卡塌缩为单行凭据——
  // 两卡同题同轨同屏读作渲染事故（用户实测「为什么会有两张卡片」）。
  const artifactPart = (status: 'running' | 'done' | 'failed'): TimelinePart => ({
    kind: 'artifact',
    id: 'artifact:n1',
    nodeId: 'n1',
    nodeType: 'image',
    title: '产品主图',
    status,
  })

  it('执行卡在场：confirmed 提议卡折叠单行（✓已落锚+标题+画布回链），轨道/参数不重复渲染', () => {
    const w = mountCard({
      parts: [proposalPart({ status: 'confirmed' }), artifactPart('running')],
    })
    expect(w.find('[data-test="proposal-folded"]').exists()).toBe(true)
    const card = w.find('[data-test="proposal-card"]')
    expect(card.classes()).toContain('folded')
    expect(card.text()).toContain('已落锚')
    expect(card.text()).toContain('产品主图')
    // 折叠后全量面退役：无锚轨、无参数 chips、无提示词预览
    expect(card.find('.trilink-rail').exists()).toBe(false)
    expect(card.find('.meta').exists()).toBe(false)
    expect(card.find('[data-test="prompt-preview"]').exists()).toBe(false)
    // 画布回链仍在（完整参数出口）
    expect(card.find('[data-test="locate-link"]').exists()).toBe(true)
  })

  it('无执行卡（刚确认瞬间）：confirmed 保持全卡，不折叠', () => {
    const w = mountCard({ parts: [proposalPart({ status: 'confirmed' })] })
    expect(w.find('[data-test="proposal-folded"]').exists()).toBe(false)
    expect(w.find('[data-test="proposal-card"] .trilink-rail').exists()).toBe(true)
  })

  it('折叠只对同 nodeId 生效：他节点执行卡不触发折叠', () => {
    const other = { ...artifactPart('running'), nodeId: 'n-other', id: 'artifact:n-other' }
    const w = mountCard({ parts: [proposalPart({ status: 'confirmed' }), other] })
    expect(w.find('[data-test="proposal-folded"]').exists()).toBe(false)
  })
})
