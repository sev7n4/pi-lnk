import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, './AgentSideRail.vue'), 'utf8')

describe('AgentSideRail legacy 线程禁用态（规格 H0-c）', () => {
  it('移动端对话历史面板接 isArchivedThread 禁用（合并迁移注 2026-10-29：PC 侧栏历史入口已随 ADR-0015/#626 删除，面板为唯一消费方）', () => {
    expect(src.split(':disabled="isArchivedThread(thread)"').length - 1).toBe(1)
    expect(src).toContain('thread-history-layer')
  })
  it('PC 侧栏历史入口不得复活（ADR-0015 统一单对话模型；复活须同步恢复禁用态接线）', () => {
    expect(src).not.toContain('toggleHistoryOpen')
  })
  it('谓词必须是 archivedAt 非空，禁止 id !== sessionId（在役 fork 分支同构，规格 §7.2）', () => {
    expect(src).toContain('thread.archivedAt != null')
    expect(src).not.toContain('return thread.id !== props.sessionId')
  })
  it('归档行有「已归档」标注文案', () => {
    expect(src).toContain('已归档')
  })
  it('selectThread 守卫仍在（双保险：id != agentThreadId 的行不切换）', () => {
    expect(src).toContain('async function selectThread(threadId: string)')
  })
})
