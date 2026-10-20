// 插话多槽位守卫（2026-10-21 P2）。
//
// 背景：`queued` 曾是**单个** ref（`ref<QueuedSlot | null>`），连发第 2 条插话时
// `queueDraftAsPending` 直接覆盖赋值 ⇒ **第 1 条文字当场消失且无处可寻**，而服务端
// （vendor lane inbox）本来就支持多条 —— 那条还在队列里，照常被消费。
// 本守卫在源码层面钉住「多槽位」这条契约（与 queueWithdraw 同款静态提取写法）。
//
// ⚠️ 不用「全局剥注释再扫」：本组件 230KB，朴素正则会把真源码吃掉（见 composerSteerButton 测试头注）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')

/** 花括号配平提取函数全文（按函数名前缀定位，不锁形参表）。 */
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

/** 模板区（剥 HTML 注释，避免注释里的样例代码被当成真源码）。 */
const tpl = sfc
  .slice(sfc.indexOf('<template>'), sfc.lastIndexOf('</template>'))
  .replace(/<!--[\s\S]*?-->/g, '')

describe('插话多槽位（P2）', () => {
  it('槽位是数组而非单值：连发第 2 条不得覆盖第 1 条', () => {
    // 单槽位的病态形态
    expect(sfc).not.toMatch(/const queued = ref<QueuedSlot \| null>\(null\)/)
    // 数组 + 追加语义（不能是 `= [{...}]` 的覆盖赋值）
    expect(sfc).toMatch(/const queuedSlots = ref<QueuedSlot\[\]>\(\[\]\)/)
    const body = requireFnBody('async function queueDraftAsPending(')
    expect(body).toMatch(/queuedSlots\.value = \[\s*\.\.\.queuedSlots\.value,/)
  })

  it('槽位带本地 id 供 v-for 定位（pending 态还没有 entryId）', () => {
    const slot = /interface QueuedSlot \{[\s\S]*?\n\}/.exec(sfc)
    expect(slot, '未找到 QueuedSlot 接口').toBeTruthy()
    expect(slot![0]).toContain('id: string')
    expect(tpl).toMatch(/v-for="slot in queuedSlots"\s*:key="slot\.id"/)
  })

  it('每个气泡的动作都带槽位实参（撤回/放弃/取回不得整批误伤）', () => {
    expect(tpl).toMatch(/@click="deliverQueued\('steer', slot\)"/)
    expect(tpl).toMatch(/@click="deliverQueued\('followup', slot\)"/)
    expect(tpl).toMatch(/@click="dismissQueued\(slot\)"/)
    expect(tpl).toMatch(/@click="requeueQueued\(slot\)"/)
    expect(tpl).toMatch(/@click="withdrawQueued\(slot\)"/)
  })

  it('放弃只收这一条（按 id 过滤，不是整批清空）', () => {
    const body = requireFnBody('function dismissQueued(')
    expect(body).toMatch(/filter\(\(s\) => s\.id !== slot\.id\)/)
  })

  it('applied 只推进最早那条已入队的，后面的不许谎报「已接住」', () => {
    const body = requireFnBody('function markQueueApplied(')
    expect(body).toMatch(/find\(\(s\) => s\.state === 'accepted'\)/)
  })

  it('满了不吞草稿：上限检查在清空输入框之前，且给出提示', () => {
    const body = requireFnBody('async function queueDraftAsPending(')
    const capAt = body.indexOf('MAX_QUEUED_SLOTS')
    const clearAt = body.indexOf("input.value = ''")
    expect(capAt, '没有槽位上限 ⇒ 无限堆叠会顶掉对话阅读区').toBeGreaterThan(-1)
    expect(clearAt).toBeGreaterThan(-1)
    // 关键次序：先判满再清草稿 —— 反过来就是「消息凭空消失」的另一种形态
    expect(capAt).toBeLessThan(clearAt)
    expect(body).toContain('ElMessage.warning')
  })
})
