// 插话撤回链路的前端接线守卫（2026-10-20 P0）。
//
// 背景：气泡上的「放弃 / 取回内容」此前**只清前端 `queued.value`**，服务端那条仍在 vendor
// inbox 里照常被消费 —— 用户以为撤回了，实际它还会插进 agent 上下文。
// 本守卫锁「撤回必须真的打到服务端」这条契约。
//
// ⚠️ 不用「全局剥注释再扫」：本组件 230KB，朴素正则会把真源码吃掉（见 composerSteerButton 测试头注）。
// 改为按目标结构定点提取。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')

/** 花括号配平提取函数全文；缺失即 throw（保持非空类型，免得一处处 `!` 断言）。 */
function requireFnBody(signature: string): string {
  const start = sfc.indexOf(signature)
  if (start === -1) throw new Error(`未找到函数：${signature}`)
  let depth = 0
  let opened = false
  for (let i = start + signature.length; i < sfc.length; i++) {
    const ch = sfc[i]
    if (ch === '{') {
      depth++
      opened = true
    } else if (ch === '}') {
      depth--
      if (opened && depth === 0) return sfc.slice(start, i + 1)
    }
  }
  throw new Error(`函数体未闭合：${signature}`)
}

describe('插话撤回接线（P0）', () => {
  it('withdrawQueued 真的打服务端撤回端点，不是只清前端', () => {
    const body = requireFnBody('async function withdrawQueued()')

    // 有效性配对：确实调了服务端端点。⚠️ 必须匹配 `await fetch(apiUrl(...` 的**完整调用形态**，
    // 不能只 contains 端点串 —— 否则把调用藏进 `if (false)` 后面也照样通过（变异实测过）。
    expect(body).toMatch(
      /await fetch\(\s*apiUrl\(\s*['"]\/api\/agent\/runs\/queue\/cancel['"]\s*\)/,
    )
    expect(body).toContain('entryId')

    // 撤回失败必须**保留气泡**（服务端那条还在，假装撤回是更糟的谎报）
    expect(body).toMatch(/catch[\s\S]*ElMessage\.error/)
    const catchAt = body.indexOf('catch')
    const dismissAt = body.indexOf('dismissQueued()')
    expect(
      catchAt,
      'withdrawQueued 没有失败分支 —— 撤回失败时前端会假装撤回成功',
    ).toBeGreaterThan(-1)
    expect(dismissAt).toBeGreaterThan(-1)
  })

  it('已入队的取回必须先撤回（否则同句话会同时存在两条）', () => {
    const body = requireFnBody('async function requeueQueued()')

    // 有效性配对：先判断是否已入队
    expect(body).toContain('entryId')
    expect(body).toContain('withdrawQueued()')
    // 撤回调用必须在写入 input 之前
    expect(body.indexOf('withdrawQueued()')).toBeLessThan(body.indexOf('input.value ='))
  })

  it('entryId 由入队响应提取并落进槽位（撤回键的来源）', () => {
    const deliver = requireFnBody('async function deliverQueued(intent: QueueIntent)')
    expect(deliver).toContain('slot.entryId')

    const slot = /interface QueuedSlot \{[\s\S]*?\n\}/.exec(sfc)
    expect(slot, '未找到 QueuedSlot 接口').toBeTruthy()
    expect(slot![0]).toContain('entryId')
  })

  it('撤回按钮只在拿到 entryId 时出现（没 key 就不给骗人的按钮）', () => {
    // 模板区（剥 HTML 注释后再找按钮）
    const tpl = sfc
      .slice(sfc.indexOf('<template>'), sfc.lastIndexOf('</template>'))
      .replace(/<!--[\s\S]*?-->/g, '')
    expect(tpl).toContain('withdrawQueued')
    // 出现条件必须带 entryId 门控
    expect(tpl).toMatch(/v-if="queued\.entryId[^"]*"[\s\S]{0,200}@click="withdrawQueued"/)
  })

  it('already_consumed 必须如实告知，不得当成撤回成功', () => {
    const body = requireFnBody('async function withdrawQueued()')
    expect(body).toContain('already_consumed')
    // 撤回成功与否以 outcome 判定，不是「请求没报错就算成功」
    expect(body).toMatch(/outcome\s*===\s*'cancelled'/)
  })
})