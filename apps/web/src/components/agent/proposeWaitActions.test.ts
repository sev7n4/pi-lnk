import { describe, expect, it } from 'vitest'
import {
  resolveProposeCancelNodeId,
  resolveProposeConfirmCallId,
  shouldSyncProposePending,
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

describe('shouldSyncProposePending（L2：等待开始同步 pending_confirm）', () => {
  it('draft / 无状态 → 同步（stale 值的唯一来源）', () => {
    expect(shouldSyncProposePending('draft')).toBe(true)
    expect(shouldSyncProposePending('')).toBe(true)
    expect(shouldSyncProposePending(undefined)).toBe(true)
    expect(shouldSyncProposePending(null)).toBe(true)
  })

  it('在途 / 终态 → 不同步（不得把已确认的节点拽回待确认）', () => {
    for (const s of [
      'pending_confirm',
      'generating',
      'fallback_pending',
      'completed',
      'error',
      'failed',
    ]) {
      expect(shouldSyncProposePending(s), s).toBe(false)
    }
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

  it('无 callId（blocking 关闭的旧路径）/ 空 nodeId → null', () => {
    expect(
      resolveProposeConfirmCallId({ toolName: 'propose_generation', nodeId: 'n1' }, 'n1'),
    ).toBeNull()
    expect(resolveProposeConfirmCallId({ ...wait, callId: '   ' }, 'n1')).toBeNull()
    expect(resolveProposeConfirmCallId(wait, '')).toBeNull()
  })
})
