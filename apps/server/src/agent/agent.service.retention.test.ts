/**
 * W2① 压缩保留段 · Nest 侧填值（Round 2 报告 §08 W2①）。
 *
 *## 契约
 *
 * pi-runtime 已有 `buildRetentionInstructions()` 与 `lane.compact({customInstructions})`
 * 接线（services/pi-runtime/src/compaction-retention.ts + session-manager.ts:1434）。
 * 它缺的是**真实状态**—— Nest 不填，retention 永远是 `{}`，保留段退化为通用兜底，
 * 而代码看起来一切正常。
 *
 * SSOT 是画布节点上的 `data.status === 'pending_confirm'`：
 * `proposeGeneration()` 在返回 propose 卡片前就 persist 进了 `Session.canvasData`
 * （agent-canvas-tools.service.ts:1080-1087），且 pi-runtime 的 generation-gate
 * 跨轮/跨会话重建后仍回查这个字段（gate/generation-gate.ts:147-155）。
 */
import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import { piEvent, stubPiClient } from './agent.test-utils'

describe('W2① 压缩保留段 · Nest 侧 retention 填值', () => {
  const sessionFindUnique = vi.fn()
  const sessionUpdate = vi.fn()
  let service: AgentService

  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.PI_RUNTIME_MODE
    delete process.env.PI_RUNTIME_URL
    sessionFindUnique.mockResolvedValue({ id: 's1', canvasData: null })
    sessionUpdate.mockResolvedValue({})
    service = new AgentService(
      {
        agentMessage: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
        agentThread: {
          findUnique: vi.fn().mockResolvedValue(null),
          upsert: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
        },
        session: { findUnique: sessionFindUnique, update: sessionUpdate },
        idempotencyRecord: {
          create: vi.fn().mockResolvedValue({}),
          findUnique: vi.fn().mockResolvedValue(null),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      } as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      { dataRoot: '/tmp/none' } as never,
    )
  })

  /** 跑一轮，返回本轮实际发给 pi-runtime 的 turnContext。 */
  async function runTurn(): Promise<{ pendingConfirmNodeIds?: string[] }> {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    for await (const _e of service.streamConversation('s1', '继续', 'u1')) {
      // drain
    }
    const opts = pi.prompt.mock.calls[0]?.[3] as
      | { turnContext?: { retention?: { pendingConfirmNodeIds?: string[] } } }
      | undefined
    return opts?.turnContext?.retention ?? {}
  }

  it('有 pending_confirm 节点 → retention 带出其 id', async () => {
    sessionFindUnique.mockResolvedValue({
      id: 's1',
      canvasData: JSON.stringify({
        nodes: [
          { id: 'n-done', data: { status: 'generating' } },
          { id: 'n-wait-1', data: { status: 'pending_confirm' } },
          { id: 'n-wait-2', data: { status: 'pending_confirm' } },
        ],
        edges: [],
      }),
    })
    const retention = await runTurn()
    // 顺序保持画布顺序；非 pending 节点必须被排除
    expect(retention.pendingConfirmNodeIds).toEqual(['n-wait-1', 'n-wait-2'])
  })

  it('无 pending_confirm 节点 → 返回空对象（不传无意义空数组）', async () => {
    sessionFindUnique.mockResolvedValue({
      id: 's1',
      canvasData: JSON.stringify({
        nodes: [
          { id: 'a', data: { status: 'generating' } },
          { id: 'b', data: {} },
          { id: 'c' },
        ],
        edges: [],
      }),
    })
    const retention = await runTurn()
    expect(retention.pendingConfirmNodeIds).toBeUndefined()
  })

  it('canvasData 为 null / 非法 JSON / nodes 非数组 → fail-soft 返回 {}', async () => {
    // 三种畸形输入各跑一轮：保留段是纯增强功能，绝不能把主链路带崩。
    for (const canvasData of [null, '{not json', JSON.stringify({ nodes: 'oops' })]) {
      sessionFindUnique.mockResolvedValue({ id: 's1', canvasData })
      const retention = await runTurn()
      expect(retention.pendingConfirmNodeIds).toBeUndefined()
    }
  })

  it('DB 读失败 → fail-soft 返回 {} 且不抛（prompt 仍正常发出）', async () => {
    sessionFindUnique.mockRejectedValue(new Error('db down'))
    const retention = await runTurn()
    expect(retention.pendingConfirmNodeIds).toBeUndefined()
  })
})
