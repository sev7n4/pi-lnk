import { describe, expect, it } from 'vitest'
import {
  resolveProposeCancelCallId,
  resolveProposeCancelNodeId,
  resolveProposeConfirmCallId,
} from './proposeWaitActions'

describe('proposeWait 取消按钮（2026-10-01）', () => {
  it('有 nodeId 才允许取消', () => {
    expect(resolveProposeCancelNodeId({ toolName: 'propose_generation', nodeId: 'prompt-1' })).toBe(
      'prompt-1',
    )
    expect(resolveProposeCancelNodeId({ toolName: 'propose_generation' })).toBeNull()
    expect(resolveProposeCancelNodeId(null)).toBeNull()
  })

  it('非 propose 工具的阻塞等待不给取消入口', () => {
    expect(resolveProposeCancelNodeId({ toolName: 'ask_user', nodeId: 'x' })).toBeNull()
  })
})

describe('resolveProposeConfirmCallId（L1：显式确认信号）', () => {
  const wait = { toolName: 'propose_generation', callId: 'c1', nodeId: 'n1' }

  it('本节点的 propose 等待 → 返回 callId', () => {
    expect(resolveProposeConfirmCallId(wait, 'n1')).toBe('c1')
  })

  it('不是 propose / 别的节点 / 无等待 → null（退回轮询兜底）', () => {
    expect(resolveProposeConfirmCallId({ ...wait, toolName: 'ask_user' }, 'n1')).toBeNull()
    expect(resolveProposeConfirmCallId(wait, 'n2')).toBeNull()
    expect(resolveProposeConfirmCallId(null, 'n1')).toBeNull()
  })

  it('等待未带 nodeId 时按「当前等待即本节点」处理', () => {
    expect(
      resolveProposeConfirmCallId({ toolName: 'propose_generation', callId: 'c1' }, 'n1'),
    ).toBe('c1')
  })

  it('无 callId（旧路径）/ 空 nodeId → null', () => {
    expect(
      resolveProposeConfirmCallId({ toolName: 'propose_generation', nodeId: 'n1' }, 'n1'),
    ).toBeNull()
    expect(resolveProposeConfirmCallId({ ...wait, callId: '   ' }, 'n1')).toBeNull()
    expect(resolveProposeConfirmCallId(wait, '')).toBeNull()
  })
})

describe('resolveProposeCancelCallId（2026-10-06：取消走显式 decline）', () => {
  it('propose 等待带 callId → 返回 callId（无需 nodeId 匹配）', () => {
    expect(
      resolveProposeCancelCallId({ toolName: 'propose_generation', callId: 'c1', nodeId: 'n1' }),
    ).toBe('c1')
    expect(resolveProposeCancelCallId({ toolName: 'propose_generation', callId: 'c1' })).toBe('c1')
  })

  it('非 propose / 无 callId / 空等待 → null（退回旧的 clear-propose + 轮询路径）', () => {
    expect(resolveProposeCancelCallId({ toolName: 'ask_user', callId: 'c1' })).toBeNull()
    expect(resolveProposeCancelCallId({ toolName: 'propose_generation', nodeId: 'n1' })).toBeNull()
    expect(resolveProposeCancelCallId({ toolName: 'propose_generation', callId: '  ' })).toBeNull()
    expect(resolveProposeCancelCallId(null)).toBeNull()
  })

  it('确认与取消取自同一个 callId（两条臂同源，不会各指一次等待）', () => {
    const wait = { toolName: 'propose_generation', callId: 'c9', nodeId: 'n9' }
    expect(resolveProposeConfirmCallId(wait, 'n9')).toBe(resolveProposeCancelCallId(wait))
  })
})
