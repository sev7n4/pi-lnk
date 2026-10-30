import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ⚠️ 不用 `new URL('./AgentSideRail.vue', import.meta.url)`：Vite 会把该模式当
// 资源引用改写，运行时 URL 变成非 file scheme ⇒ fileURLToPath 抛错。
// 与同目录 AgentSideRail.sel-ref.test.ts 同款写法。
const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, './AgentSideRail.vue'), 'utf8')
const storeSrc = readFileSync(join(here, '../../stores/agent.ts'), 'utf8')

/** 截取从 `marker` 首次出现开始的约 1600 字符窗口（覆盖一个函数体）。 */
function fnWindow(marker: string): string {
  const start = src.indexOf(marker)
  expect(start, `源码中应存在 ${marker}`).toBeGreaterThanOrEqual(0)
  return src.slice(start, start + 1600)
}

describe('AgentSideRail 加载更早消息·修复轮（审查 Important-1 防丢尾部 / Minor-2 游标残留）', () => {
  it('Important-1：loadOlder 只 prepend 更早行，不再整体重建（整体 replace 会抹掉会话内新增的尾部轮次）', () => {
    // 重建输入必须经 store 的 prependHistory（窗口 ∪ 尾部合并语义的落点），而非 loadHistory 整体替换
    expect(src).toContain('agent.prependHistory(older)')
    const body = fnWindow('async function loadOlder')
    expect(body).not.toContain('agent.loadHistory(')
  })
  it('Important-1：store 侧 prependHistory 按 id 去重 + 尾部保留（幂等、流式不炸的落点）', () => {
    expect(storeSrc).toContain('function prependHistory(history: PersistedAgentMessage[])')
    // 去重：过滤已存在于 messages 的 id（重复点击 / 与尾部重叠均不重复渲染）
    expect(storeSrc).toContain('!known.has(persisted.id)')
    // 不整体重建：prepend 是 [...mapped, ...messages.value]，不是替换
    expect(storeSrc).toContain('[...fresh.map(mapPersistedToMessage), ...messages.value]')
  })
  it('Important-1：loadHistory 与 prependHistory 共用同一映射器（prepend 行与首载行产出同形）', () => {
    expect(storeSrc).toContain('history.map(mapPersistedToMessage)')
    expect(storeSrc).toContain('fresh.map(mapPersistedToMessage)')
  })
  it('Minor-2：loadHistory 起点同步清零游标（跨线程残留 + 首载在途期竞态一并关闭）', () => {
    const body = fnWindow('async function loadHistory')
    expect(body).toContain('historyCursor.value = null')
    expect(body).toContain('historyHasMore.value = false')
    // 清零必须发生在 fetch 之前（起点同步，失败早退/在途期都无残留）
    expect(body.indexOf('historyCursor.value = null')).toBeLessThan(body.indexOf('await fetch'))
  })
  it('P3：loadOlder 翻页同样走净化边界（sanitizeHistoryMessages），与首载渲染一致', () => {
    // 首载 loadHistory 已 sanitize，翻页若不净化会漏出 __new_task__ 机器载荷气泡 / 空 assistant
    // 行，与首载渲染不一致（审查 P3）。净化只改渲染视图，DB 原文不动，prepend 安全。
    const body = fnWindow('async function loadOlder')
    expect(body).toContain('sanitizeHistoryMessages((json.data')
  })
})
