import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ⚠️ 不用 `new URL('./AgentSideRail.vue', import.meta.url)`：Vite 会把该模式当
// 资源引用改写，运行时 URL 变成非 file scheme ⇒ fileURLToPath 抛错。
// 与同目录 AgentSideRail.sel-ref.test.ts 同款写法。
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'AgentSideRail.vue'), 'utf8')

describe('AgentSideRail 加载更早消息（规格 H1-a 前端半边 / 验收 S5）', () => {
  it('按钮由 historyHasMore 驱动，点击走 loadOlder', () => {
    expect(src).toContain('v-if="historyHasMore"')
    expect(src).toContain('@click="loadOlder()"')
  })
  it('翻页请求带 before 游标且 no-store（K1 纵深防御）', () => {
    expect(src).toContain('before=${encodeURIComponent(historyCursor.value)}')
    expect(src.split('loadOlder').length - 1).toBeGreaterThanOrEqual(3)
  })
  it('prepend 只补头部、不整体重建（Task 8 修复：整体重建会抹掉窗口外尾部轮次）', () => {
    expect(src).toContain('agent.prependHistory(older)')
    expect(src).not.toContain('agent.loadHistory(historyRows.value)')
  })
})
