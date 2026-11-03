/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import {
  looksLikeConfirmTurn,
  looksLikeCopyWriteTurn,
  pickAssistantForLatestUserTurn,
  pickTrailingOutOfTurnRow,
  shouldApplyReconciledAssistant,
} from './assistantReconcile'

describe('pickAssistantForLatestUserTurn', () => {
  it('returns assistant after the latest user message only', () => {
    const rows = [
      { role: 'user', content: 'old brief' },
      { role: 'assistant', content: '上一轮仍在处理中，请稍候；拆解出图通常需要一两分钟。' },
      { role: 'user', content: '请帮我做蓝牙耳机营销方案' },
    ]
    expect(pickAssistantForLatestUserTurn(rows)).toBeNull()
  })

  it('returns current-turn assistant when present', () => {
    const rows = [
      { role: 'user', content: 'old brief' },
      { role: 'assistant', content: '上一轮仍在处理中' },
      { role: 'user', content: '新方案' },
      { role: 'assistant', content: '定位：蓝牙耳机\n请确认是否按此方案拆解画布并出图' },
    ]
    expect(pickAssistantForLatestUserTurn(rows)?.content).toContain('请确认是否按此方案拆解')
  })
})

describe('shouldApplyReconciledAssistant', () => {
  it('rejects stale confirm-gate overwrite of in-progress exec tip', () => {
    const local = '正在按方案拆解画布并出图，请稍候…'
    const db =
      '定位：露营折叠椅\n请确认是否按此方案拆解画布并出图；如需修改请直接说明。'
    expect(shouldApplyReconciledAssistant(local, db)).toBe(false)
  })

  it('accepts longer completed progress from DB', () => {
    const local = '正在按方案拆解画布并出图，请稍候…'
    const db =
      '正在按方案拆解画布并出图，请稍候…已按方案拆解 9 个画布节点骨架\n· 主图：出图成功'
    expect(shouldApplyReconciledAssistant(local, db)).toBe(true)
  })

  it('accepts db when local empty', () => {
    expect(shouldApplyReconciledAssistant('', 'hello')).toBe(true)
  })

  it('does not replace busy tip with stale copy draft', () => {
    const local = '上一轮仍在处理中，请稍候；拆解出图通常需要一两分钟。'
    const db = '【主文案草稿】\n# 文案\n请确认后回复「写入主文案」'
    expect(shouldApplyReconciledAssistant(local, db)).toBe(false)
  })

  it('does not replace write success with longer draft', () => {
    const local = '已将确认的主文案写入画布节点。'
    const db = '【主文案草稿】\n很长的旧草稿……请确认后回复「写入主文案」'
    expect(shouldApplyReconciledAssistant(local, db)).toBe(false)
  })

  it('prefers write success from DB over local draft bubble', () => {
    const local = '【主文案草稿】\n旧草稿'
    const db = '已将确认的主文案写入画布节点。'
    expect(shouldApplyReconciledAssistant(local, db)).toBe(true)
  })
})

describe('looksLikeConfirmTurn', () => {
  it('matches chip confirm', () => {
    expect(looksLikeConfirmTurn('确认')).toBe(true)
  })

  it('matches copy write chip', () => {
    expect(looksLikeCopyWriteTurn('写入主文案')).toBe(true)
    expect(looksLikeConfirmTurn('写入主文案')).toBe(true)
  })

  it('rejects long brief', () => {
    expect(
      looksLikeConfirmTurn('请为保温杯写一份方案，写完后先等我确认。'),
    ).toBe(false)
  })
})

describe('pickTrailingOutOfTurnRow', () => {
  const briefRow = {
    id: 'brief-1',
    role: 'assistant',
    content: '✅ 黄色小龙虾已生成完成，可在画布中查看。',
    metadata: '{"outOfTurn":true}',
  }

  it('最后一条为 outOfTurn assistant ⇒ 返回该行', () => {
    const rows = [
      { id: 'u1', role: 'user', content: '帮我生成一只黄色的小龙虾' },
      { id: 'a1', role: 'assistant', content: '已为你创建图片节点并启动生成。' },
      briefRow,
    ]
    expect(pickTrailingOutOfTurnRow(rows)).toBe(briefRow)
  })

  it('最后一行是主轮 assistant（无 outOfTurn 标记）⇒ null（多端回声走既有启发式）', () => {
    const rows = [
      { id: 'u1', role: 'user', content: '帮我做方案' },
      { id: 'a1', role: 'assistant', content: '主轮回答，长文本……' },
    ]
    expect(pickTrailingOutOfTurnRow(rows)).toBeNull()
  })

  it('outOfTurn 行后面还有更新的 user 消息 ⇒ null（不做越位插入，交给 loadHistory）', () => {
    const rows = [
      { id: 'u0', role: 'user', content: '生成图片' },
      { id: 'a0', role: 'assistant', content: '生成中' },
      briefRow,
      { id: 'u1', role: 'user', content: '再来一只绿色的' },
    ]
    expect(pickTrailingOutOfTurnRow(rows)).toBeNull()
  })

  it('metadata 坏 JSON ⇒ null（降级语义与 historySanitize 一致）', () => {
    const rows = [
      { id: 'a1', role: 'assistant', content: '正文', metadata: '{broken' },
    ]
    expect(pickTrailingOutOfTurnRow(rows)).toBeNull()
  })

  it('outOfTurn 但正文为空 ⇒ null（空行不渲染）', () => {
    const rows = [
      { id: 'a1', role: 'assistant', content: '   ', metadata: '{"outOfTurn":true}' },
    ]
    expect(pickTrailingOutOfTurnRow(rows)).toBeNull()
  })
})
