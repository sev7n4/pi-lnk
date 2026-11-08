/**
 * ADR-0015 退役残留：PC 侧历史 popover 死链不得复现。
 * 所有断言读真实源文件；注释必须剥离（历史归因注释会提到已退役符号）。
 * 否定断言一律配肯定断言，防止「把文件删空也能绿」。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfcRaw = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')
const threadRaw = readFileSync(join(here, 'useAgentThread.ts'), 'utf8')

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
}

const sfc = stripComments(sfcRaw)
const thread = stripComments(threadRaw)
const tpl = sfcRaw
  .slice(sfcRaw.indexOf('<template>'), sfcRaw.lastIndexOf('</template>'))
  .replace(/<!--[\s\S]*?-->/g, '')

/** 按内容锚点切块（不按行号，行号会随改动位移）。 */
function blockOf(src: string, anchor: string, endAnchor: string): string {
  const start = src.indexOf(anchor)
  if (start < 0) return ''
  const stop = src.indexOf(endAnchor, start + anchor.length)
  return stop < 0 ? src.slice(start) : src.slice(start, stop)
}

/** 函数体截取：懒匹配到第一个行首 `}`（内部块均有缩进）。 */
function fnBlock(signature: string): string {
  const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${escaped}[\\s\\S]*?\\n\\}`)
  return thread.match(re)?.[0] ?? ''
}

describe('ADR-0015 退役残留：PC 历史 popover 死链', () => {
  it('组 1：SFC 与 useAgentThread 均不再出现 historyOpen / historyRef', () => {
    expect(sfc).not.toContain('historyOpen')
    expect(sfc).not.toContain('historyRef')
    expect(thread).not.toContain('historyOpen')

    const depsBlock = blockOf(thread, 'export interface AgentThreadDeps', 'export interface AgentThreadApi')
    expect(depsBlock, '必须能定位 AgentThreadDeps 接口块').toContain('agentThreadId')
    expect(depsBlock).not.toContain('historyOpen')

    const injectBlock = blockOf(sfc, 'useAgentThread({', '\n})')
    expect(injectBlock, '必须能定位 useAgentThread 注入块').toContain('threads,')
    expect(injectBlock).not.toContain('historyOpen')
  })

  it('组 2：移动端历史面板与 defineExpose 契约完整（存在性配对）', () => {
    expect(sfc).toContain('const threads = ref<AgentThreadRow[]>([])')
    expect(sfc).toContain('async function fetchThreads()')
    expect(sfc).toContain('async function openThreadHistory()')
    expect(sfc).toContain('function closeThreadHistory()')
    expect(sfc).toContain('mobileThreadHistoryOpen')
    expect(tpl).toContain('v-for="thread in threads"')

    const exposeBlock = blockOf(sfc, 'defineExpose({', '</script>')
    expect(exposeBlock, '必须能定位 defineExpose 块').toContain('openThreadHistory,')
    expect(exposeBlock).toContain('closeThreadHistory,')
  })

  it('组 3：每个 useClickOutside 目标都必须在模板有 ref 绑定（类别化判据）', () => {
    const targets = [...sfc.matchAll(/useClickOutside\((\w+)/g)].map((m) => m[1])
    expect(targets.length, '至少两处活 click-outside 仍存活（防空集假绿）').toBeGreaterThanOrEqual(2)
    for (const name of targets) {
      expect(tpl, `${name} 必须有模板 ref 绑定，否则是挂空元素的死监听`).toContain(`ref="${name}"`)
    }
    expect(sfc).toContain("import { useClickOutside } from '@/composables/useClickOutside'")
    expect(targets).toContain('attachMenuRef')
    expect(targets).toContain('thinkingMenuRef')
  })

  it('组 4：selectThread 守卫与切线程编排未被连带删除', () => {
    const fn = fnBlock('async function selectThread(')
    expect(fn, '必须能定位 selectThread 函数体').toContain('if (threadId !== getSessionId())')
    expect(fn).toContain('if (threadId === agentThreadId.value)')
    expect(fn).toContain('clearComposer()')
    expect(fn).toContain('clearForkedThreadId(getSessionId())')
    expect(fn).toContain('await loadHistory()')
  })
})
