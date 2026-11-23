import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentTurnTimeline from './AgentTurnTimeline.vue'
import type { TimelinePart } from './turnTimeline'
import type { AgentTaskProgressState } from './agentTaskProgress'

const mountTurn = (parts: TimelinePart[], streaming = true, progress?: AgentTaskProgressState) =>
  mount(AgentTurnTimeline, { props: { parts, streaming, taskProgress: progress }, attachTo: document.body })

const thinking = (id = 't1'): TimelinePart => ({
  kind: 'thinking', id, text: '思考摘要原文', status: 'running', startedAt: 1,
})

describe('流尾当前态（B 形态，2026-11-23 二次拍板）', () => {
  it('零 parts（message_start 后首个 part 前）仍渲染 1 条「等待模型响应」且在根首原位', () => {
    const w = mountTurn([])
    const rows = w.findAll('[data-testid="turn-current-state"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text()).toContain('等待模型响应')
    expect(w.element.firstElementChild?.getAttribute('data-testid')).toBe('turn-current-state')
  })

  it('DOM 序：状态行在最后一个 part 之后，清单仍留轮首', () => {
    const marker = 'DOM 序锚点文本'
    const w = mountTurn(
      [thinking(), { kind: 'text', id: 'txt-marker', text: marker, status: 'done' } as TimelinePart],
      true,
      { items: [{ id: '1', title: '写脚本', status: 'running' }], finished: false } as AgentTaskProgressState,
    )
    const state = w.find('[data-testid="turn-current-state"]').element
    const lastPart = w.findAll('p').find((p) => p.text().includes(marker))!.element
    const checklist = w.find('[data-testid="turn-task-checklist"]').element
    // DOCUMENT_POSITION_FOLLOWING：前者在后者之前
    expect(lastPart.compareDocumentPosition(state) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(checklist.compareDocumentPosition(state) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('活跃轮恰好 1 条，文本取 turnLiveStatus', () => {
    const w = mountTurn([thinking()])
    const rows = w.findAll('[data-testid="turn-current-state"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text()).toContain('深度思考中')
  })

  it('streaming=false 或收口后 0 条', () => {
    expect(mountTurn([thinking()], false).findAll('[data-testid="turn-current-state"]')).toHaveLength(0)
    const final = [{ kind: 'notice', id: 'notice:turn-summary', text: '已生成 1 张' } as TimelinePart]
    expect(mountTurn(final, true).findAll('[data-testid="turn-current-state"]')).toHaveLength(0)
  })

  it('旧三阶段词 / 序号 / UI 拼小结不出现', () => {
    const html = mountTurn([thinking()]).html()
    for (const banned of ['探索中', '创作中', '收尾中', '①', '②', '③', '小结：']) {
      expect(html).not.toContain(banned)
    }
  })

  it('推理摘要仍在 thinking 原位；工具结果仍在 tool 原位', () => {
    const parts: TimelinePart[] = [
      { kind: 'thinking', id: 't1', text: '真实推理摘要', status: 'done', startedAt: 1, endedAt: 2 },
      { kind: 'tool', id: 'k1', toolName: 'get_canvas_summary', status: 'done',
        resultSummary: '画布为空' } as TimelinePart,
    ]
    const html = mountTurn(parts).html()
    expect(html).toContain('真实推理摘要')
    expect(html).toContain('画布为空')
  })
})

describe('流内折叠 checklist', () => {
  const progress = {
    items: [
      { id: '1', title: '写脚本', activeForm: '正在写脚本', status: 'running' },
      { id: '2', title: '生成分镜', status: 'done' },
    ],
    finished: false,
  } as AgentTaskProgressState

  it('活跃轮有清单、默认折叠；空任务 0 块', () => {
    const w = mountTurn([thinking()], true, progress)
    const list = w.find('[data-testid="turn-task-checklist"]')
    expect(list.exists()).toBe(true)
    expect(list.attributes('open')).toBeUndefined()
    expect(list.text()).toContain('任务 1/2')
    expect(mountTurn([thinking()], true).findAll('[data-testid="turn-task-checklist"]')).toHaveLength(0)
  })

  it('展开后逐项显示状态词与 activeForm', async () => {
    const w = mountTurn([thinking()], true, progress)
    await w.find('[data-testid="turn-task-checklist"] summary').trigger('click')
    const text = w.find('[data-testid="turn-task-checklist"]').text()
    expect(text).toContain('进行中')
    expect(text).toContain('正在写脚本')
    expect(text).toContain('完成')
  })

  it('完成态＝打钩 ✓ + 删除线；进行中排序置顶（Codex 一手）', async () => {
    const w = mountTurn([thinking()], true, progress)
    await w.find('[data-testid="turn-task-checklist"] summary').trigger('click')
    const rows = w.findAll('[data-testid="turn-checklist-item"]')
    expect(rows[0]!.text()).toContain('正在写脚本')          // InProgress 置顶
    const doneRow = rows.find((r) => r.text().includes('生成分镜'))!
    expect(doneRow.text()).toContain('✓')                    // 打钩，非 ×
    expect(doneRow.find('.line-through').exists()).toBe(true)// 删除线
  })

  it('带 nodeId 的清单项点击定位到画布（复用 focusNode，不丢旧卡能力）', async () => {
    const withNode = {
      items: [{ id: '1', title: '生成分镜', status: 'done', nodeId: 'node-42' }],
      finished: false,
    } as AgentTaskProgressState
    const w = mountTurn([thinking()], true, withNode)
    await w.find('[data-testid="turn-task-checklist"] summary').trigger('click')
    await w.find('[data-testid="turn-checklist-item"]').trigger('click')
    expect(w.emitted('focusNode')).toEqual([['node-42']])
  })

  it('用户展开后任务 patch 不弹回（useDisclosure 意图优先）', async () => {
    const w = mountTurn([thinking()], true, progress)
    const list = w.find('[data-testid="turn-task-checklist"]')
    await list.find('summary').trigger('click')
    expect((list.element as HTMLDetailsElement).open).toBe(true)
    await w.setProps({
      taskProgress: {
        ...progress,
        items: [...progress.items, { id: '3', title: '导出', status: 'running' }] as never,
      },
    })
    expect((w.find('[data-testid="turn-task-checklist"]').element as HTMLDetailsElement).open).toBe(true)
  })

  it('收口后当前态消失、清单折叠保留为凭据', () => {
    const final = [{ kind: 'notice', id: 'notice:turn-summary', text: 'x' } as TimelinePart]
    const w = mountTurn(final, false, progress)
    expect(w.findAll('[data-testid="turn-current-state"]')).toHaveLength(0)
    const list = w.find('[data-testid="turn-task-checklist"]')
    expect(list.exists()).toBe(true)
    expect(list.attributes('open')).toBeUndefined()
  })
})
