/**
 * 对话历史加载的 **fetch 缓存契约**（2026-10-28 生产事故防回归）。
 *
 * 事故：画布 `cmvryhipi00wxnx01hczzkf92` 刷新/切回后「对话页记录看不到」。
 * 生产取证（nginx access log，18:18:02-05 三连刷新）：`chat/threads` 与
 * `chat/user/messages` 全部回 **304**。端点带 `ETag` 且无 `Cache-Control`
 * ⇒ 浏览器带 If-None-Match 重校验 ⇒ 304 空体 ⇒ `res.ok` false（/ `json()` 抛错）
 * ⇒ `loadHistory` 在 `agent.clear()` 之后走告警分支直接 return ⇒ 历史不回填 ⇒ 整页空白。
 *
 * 修复口径：历史/线程拉取一律 `cache: 'no-store'`——与
 * `reconcileLatestAssistant` 的既有修复（2026-10-01 同根因）一致。
 * 本契约把 bootstrap 路径的 fetch 钉在代码里，漏掉任何一个都会让对应入口
 * 在「内容未变的重进」时白屏。
 *
 * H1-c（2026-10-28）：原第 4 例钉的 `refreshThreadCheckpoint` thread-state 请求已随
 * 死端点退役，改钉 `reconcileLatestAssistant` 的 no-store；另加否定断言：组件不得再
 * 发 thread-state 请求（D20 不许半死）。
 *
 * ⚠️ 断言前一律 `stripComments`：注释里会写事故成因（含 "304"），
 * 全文扫描会让注释命中当成代码命中（假绿）。
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

/** 剥注释后的源码（所有断言都基于它）。 */
const code = stripComments(src)

/** 函数体截取：懒匹配到第一个行首 `}`（内部块均有缩进，不会提前截断）。 */
function fnBlock(signature: string): string {
  const re = new RegExp(`${signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?\\n\\}`)
  return code.match(re)?.[0] ?? ''
}

describe('AgentSideRail 对话历史 fetch 禁缓存契约（304 空体 ⇒ 历史白屏）', () => {
  it('loadHistory 拉 chat/user/messages 必须 cache: no-store（刷新/切回后历史回填的主路径）', () => {
    const block = fnBlock('async function loadHistory()')
    expect(block, '必须能定位 loadHistory 函数体').toContain('chat/user/messages')
    expect(block, '必须禁缓存，否则 304 空体 ⇒ agent.clear() 后历史不回填').toContain(
      "cache: 'no-store'",
    )
  })

  it('fetchThreads 拉 chat/threads 必须 cache: no-store（否则对话抽屉恒「暂无对话记录」）', () => {
    const block = fnBlock('async function fetchThreads()')
    expect(block, '必须能定位 fetchThreads 函数体').toContain('chat/threads')
    expect(block, '必须禁缓存').toContain("cache: 'no-store'")
  })

  it('messageCountFor 已退役（H1-b/D3）：bootstrapThread 不得再全量下载消息只为计数（S6）', () => {
    const block = fnBlock('async function bootstrapThread()')
    expect(block, '必须能定位 bootstrapThread 函数体').toContain('resolveBootstrapThreadId')
    expect(block, 'messageCountFor 必须彻底退役（计数随 threads 行带回）').not.toContain(
      'messageCountFor',
    )
    expect(block, 'bootstrap 不得再请求 chat/user/messages 只为数数（S6 契约）').not.toContain(
      'chat/user/messages',
    )
  })

  it('reconcileLatestAssistant 拉 chat/user/messages 必须 cache: no-store（H1-c 后接替退役的 thread-state 钉子）', () => {
    const block = fnBlock('async function reconcileLatestAssistant(')
    expect(block, '必须能定位 reconcileLatestAssistant 函数体').toContain('chat/user/messages')
    expect(block, '必须禁缓存，否则 304 空体会让 json() 抛错、静默中断回查').toContain(
      "cache: 'no-store'",
    )
  })

  it('thread-state 已退役（H1-c）：组件不得再请求 agent/thread-state（D20 不许半死）', () => {
    expect(code, 'thread-state 死端点的所有前端调用必须清除（含字符串字面量）').not.toContain(
      'thread-state',
    )
  })
})
