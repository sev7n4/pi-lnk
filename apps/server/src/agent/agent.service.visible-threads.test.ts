import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('./agent.service.ts', import.meta.url)), 'utf8')

describe('listThreads 归档行透出（规格 H0-b 读端 / §5.2 谓词解耦）', () => {
  it('listThreads 不得过滤 archivedAt——归档行必须到达前端渲染 H0-c 禁用态', () => {
    // 剥注释再断言：注释可解释「为何不过滤」（含 archivedAt 字样），
    // 契约钉的是 where 子句本身（与 AgentSideRail.historyFetchNoStore.test.ts 同口径）。
    const stripped = src.replace(/\/\/[^\n]*/g, '')
    const start = stripped.indexOf('async listThreads')
    expect(start, 'listThreads 必须存在').toBeGreaterThan(0)
    const scope = stripped.slice(start, stripped.indexOf('\n  async ', start + 1))
    expect(scope).not.toContain('archivedAt')
  })
})
