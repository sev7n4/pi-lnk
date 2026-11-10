/**
 * AgentSideRail：切后台再回来 / bfcache 恢复时触发历史重放（P0-B，SSE 会话恢复）。
 *
 * 根因（母文档 §3.1）：`useAgentObserver` 的可见性处理只管旁观 SSE，`loadHistory` 仅在
 * mount（bootstrapThread）时跑。切回不重挂载 → 不 hydrate → 停在失效实时态 → 只剩 user 气泡。
 * 本契约把 reconcile 接线钉在源码里：监听 visibilitychange / pageshow(persisted)，且单飞 +
 * 非流式 + 有网才重放，避免 clear 后失败白屏、避免 clobber 流式回合。
 *
 * 采用与 `AgentSideRail.historyFetchNoStore.test.ts` 一致的静态源码契约范式
 *（组件体量大，不真挂载；剥注释后扫描接线，漏接即红）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, './AgentSideRail.vue'), 'utf8')

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
}
const code = stripComments(src)

describe('AgentSideRail：切回/bfcache 恢复触发历史重放（P0-B）', () => {
  it('必须监听 visibilitychange 并绑定 reconcileOnVisible（切后台再回来 hydrate）', () => {
    expect(code, '缺 visibilitychange 监听').toContain(
      "addEventListener('visibilitychange', reconcileOnVisible)",
    )
  })

  it('必须监听 pageshow 并区分 bfcache（e.persisted）恢复', () => {
    expect(code, '缺 pageshow 监听').toContain("addEventListener('pageshow', onPageShowReconcile)")
    expect(code, 'bfcache 恢复必须由 e.persisted 触发').toContain('if (e.persisted)')
  })

  it('reconcileOnVisible 必须单飞 + 非流式 + 有网才重放（防 clear 后失败白屏、防 clobber 流式）', () => {
    expect(code, '必须单飞防 visibilitychange/pageshow 同拍双触发').toContain('reconcileSingleFlight')
    expect(code, '流式回合不重放（实时 SSE 权威、clear 会丢半条消息）').toContain('agent.isStreaming')
    expect(code, '无网不赌 clear 后失败白屏（既有陷阱）').toContain('navigator.onLine === false')
    expect(code, '必须走 loadHistory 以服务端权威快照重放').toContain('void loadHistory()')
  })

  it('onUnmounted 必须移除监听（防内存泄漏 / 重复绑定）', () => {
    expect(code, 'onUnmounted 必须移除 visibilitychange').toContain(
      "removeEventListener('visibilitychange', reconcileOnVisible)",
    )
    expect(code, 'onUnmounted 必须移除 pageshow').toContain(
      "removeEventListener('pageshow', onPageShowReconcile)",
    )
  })
})
