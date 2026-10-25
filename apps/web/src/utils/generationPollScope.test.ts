/**
 * 生成记录轮询范围判据（纯函数层）。
 *
 * ⭐ 契约：**终态记录不进入持续轮询**（否则 77 个节点的画布每轮 77 条串行请求，
 *   长期占死同源连接槽位 ⇒ 画布载荷请求饿死 ⇒ 画布显示为空）。
 */
import { describe, expect, it } from 'vitest'
import { isRecordInflight, pickInflightRecords, shouldPollNode } from './generationPollScope'

describe('生成记录轮询范围', () => {
  it('只有服务端还在跑的记录才算 in-flight', () => {
    expect(isRecordInflight('generating')).toBe(true)
    expect(isRecordInflight('pending')).toBe(true)
    expect(isRecordInflight('completed')).toBe(false)
    expect(isRecordInflight('failed')).toBe(false)
    expect(isRecordInflight('error')).toBe(false)
    expect(isRecordInflight(undefined)).toBe(false)
  })

  it('pickInflightRecords：77 条终态记录 ⇒ 选出 0 条（变异点：不过滤）', () => {
    const records = Array.from({ length: 77 }, (_, i) => ({
      id: `rec-${i}`,
      status: 'completed',
    }))
    expect(pickInflightRecords(records).length, '终态记录不得进轮询队列').toBe(0)

    const mixed = [
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'generating' },
      { id: 'c', status: 'completed' },
      { id: 'd', status: 'pending' },
    ]
    expect(pickInflightRecords(mixed).map((r) => r.id)).toEqual(['b', 'd'])
  })

  it('shouldPollNode：无 recordId / 无状态 / 终态 ⇒ 都不轮询', () => {
    expect(shouldPollNode('generating', false), '没有 recordId ⇒ 没什么可轮询').toBe(false)
    expect(shouldPollNode('completed', true)).toBe(false)
    expect(shouldPollNode('failed', true)).toBe(false)
    expect(shouldPollNode('error', true)).toBe(false)
    expect(shouldPollNode(undefined, true), '无状态 ⇒ 交给 list 一次性回填').toBe(false)
    expect(shouldPollNode('', true)).toBe(false)
  })

  it('shouldPollNode：生成中才轮询', () => {
    expect(shouldPollNode('generating', true)).toBe(true)
    expect(shouldPollNode('pending', true)).toBe(true)
  })
})
