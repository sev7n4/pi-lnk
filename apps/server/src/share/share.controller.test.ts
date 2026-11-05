import { describe, it, expect } from 'vitest'
import { ValidationPipe } from '@nestjs/common'
import { CreateShareDto } from './share.controller'

/**
 * 回归测试（线上事故级）：托管分享页曾长期只渲染「空气泡 + 兜底时间」。
 *
 * 根因：全局管道 `new ValidationPipe({ transform: true, whitelist: true })`
 * （apps/server/src/main.ts）会剥掉「嵌套对象上无校验装饰器」的属性。
 * 若 turns 用 `@ValidateNested({ each: true })` + `@Type(() => Object)`，
 * 每个 turn 的 id/role/createdAt/parts/contentText 会被清空
 * ⇒ 服务端渲染不出正文（早期症状：createdAt 丢失 → 「Invalid Date」）。
 *
 * 本测试用与生产完全一致的管道配置锁住「回合对象原样透传」。
 */
const pipe = new ValidationPipe({ transform: true, whitelist: true })
const meta = { type: 'body' as const, metatype: CreateShareDto }

describe('CreateShareDto（分享创建入参）', () => {
  it('回合对象在 whitelist 管道下原样透传（不被剥字段）', async () => {
    const payload = {
      sessionId: 's1',
      turns: [
        {
          id: 't1',
          role: 'user',
          contentText: '你好',
          createdAt: 1762300000000,
          parts: [{ type: 'text', text: '你好' }],
        },
        {
          id: 't2',
          role: 'assistant',
          createdAt: 1762300006000,
          parts: [{ type: 'thinking', text: 'let me think', done: true }],
        },
      ],
    }
    const dto = (await pipe.transform(payload, meta)) as CreateShareDto
    expect(dto.turns).toHaveLength(2)
    expect(dto.turns[0].id).toBe('t1')
    expect(dto.turns[0].role).toBe('user')
    expect(dto.turns[0].createdAt).toBe(1762300000000)
    expect(dto.turns[0].contentText).toBe('你好')
    expect(dto.turns[0].parts?.[0]).toEqual({ type: 'text', text: '你好' })
    expect(dto.turns[1].parts?.[0]).toEqual({ type: 'thinking', text: 'let me think', done: true })
  })

  it('title 缺省不报错（老 bundle 不带 title）', async () => {
    const dto = (await pipe.transform({ sessionId: 's1', turns: [] }, meta)) as CreateShareDto
    expect(dto.title).toBeUndefined()
    expect(dto.turns).toEqual([])
  })

  it('sessionId 缺失 → 抛校验错误（400）', async () => {
    await expect(pipe.transform({ turns: [] }, meta)).rejects.toThrow()
  })

  it('turns 非数组 → 抛校验错误（400）', async () => {
    await expect(pipe.transform({ sessionId: 's1', turns: 'nope' }, meta)).rejects.toThrow()
  })
})
