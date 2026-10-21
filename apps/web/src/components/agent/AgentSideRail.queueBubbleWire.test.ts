// 插话气泡接线的回归锁（2026-10-21）。
//
// 判定逻辑本身在 `queueBubbleSync.ts`（纯函数，行为级单测覆盖）。
// 本组用例锁**组件接线**：pi 侧消费插话时的那条 `pi_message_end` 事件，
// 必须走到 `applyPiUserMessageEvent`（而不是自己内联一套判定）。
//
// ⚠️ **不要用「先全局剥注释再全文扫」**：本组件 230KB，JSDoc 里大量 `/* ... *\/`
// 与 `//` 片段会让朴素正则把真源码一起吃掉（实测 `:generating` 直接消失 ⇒ 假红）。
// 改为**按目标结构定点提取**（花括号配平函数体）+ **剥行注释**，天然不受注释影响。
// 否定断言一律配有效性断言（防空集假绿，见 AGENTS.md 沙箱假阴性纪律）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { requireFnBody } from './sfcSource'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')

describe('插话气泡接线（pi_message_end → 落点判定）', () => {
  it('pi_message_end 事件交给 applyPiUserMessageEvent 判定（不内联判定逻辑）', () => {
    // 提取 handleEvent 里 pi_message_end 那个 case 的分支体
    const body = requireFnBody(sfc, "case 'pi_message_end':")

    // 有效性配对：确实调用了判定函数
    expect(body).toContain('applyPiUserMessageEvent')

    // 判定所需的四项输入都在（缺一项就会退化成「不动作」）
    expect(body).toContain('messages: agent.messages')
    expect(body).toContain('queuedEntryIds')
    expect(body).toContain('slots: queuedSlots.value')
    expect(body).toContain('insertUserMessage')

    // ⭐ 接线不得自己再内联一套「挂到最后一条 user 消息」的旧逻辑
    //    （那正是把上一条消息 fork 切点冲掉的写法）
    expect(
      body,
      'pi_message_end 分支里仍内联着「把 entryId 挂到最后一条 user 消息」的旧判定 —— ' +
        '判定必须收敛到 queueBubbleSync 一处，否则会出现两套落点规则',
    ).not.toMatch(/role\s*===\s*'user'\s*\)\s*\{\s*m\.entryId\s*=/)
  })

  it('插话入队成功时登记 entryId（它是「这条是插话」的权威凭据）', () => {
    const body = requireFnBody(sfc, 'async function deliverQueued(')

    // 有效性配对：确实登记了
    expect(body).toContain('queuedEntryIds.add(')

    // ⭐ 登记必须发生在拿到 entryId 之后，且**不能**被「放弃」路径清掉 ——
    //    「放弃」只收本地气泡，服务端那条仍会被消费，那时仍要补建气泡。
    const addAt = body.indexOf('queuedEntryIds.add(')
    const entryIdAt = body.indexOf('target.entryId =')
    expect(entryIdAt, 'deliverQueued 里没找到 entryId 赋值').toBeGreaterThan(-1)
    expect(addAt, '登记必须发生在拿到 entryId 之后').toBeGreaterThan(entryIdAt)
  })

  it('队列 entryId 登记表存在，且是 Set（按值查、无序、无重复）', () => {
    expect(sfc).toMatch(/const queuedEntryIds = new Set<string>\(\)/)
  })
})
