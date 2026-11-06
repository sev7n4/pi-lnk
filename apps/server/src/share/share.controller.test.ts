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

  it('2026-11-06 新增保真字段同样穿透 whitelist 管道（delivery + 8 类 part 字段）', async () => {
    const payload = {
      sessionId: 's1',
      turns: [
        {
          id: 'a1',
          role: 'assistant',
          createdAt: 1762300006000,
          attachments: [{ kind: 'image', url: 'https://x/u.png', thumbUrl: 'https://x/u.png' }],
          delivery: [{ title: '海报 A', nodeType: 'image', url: 'https://x/a.png' }],
          parts: [
            { type: 'notice', text: '积分不足', tone: 'error', detail: 'tokens 1.2k' },
            { type: 'tool', name: 'run_gen', status: 'done', ms: 17000, result: '完成' },
            { type: 'audio', url: 'https://x/a.mp3', title: '配音', durationMs: 4200 },
            { type: 'artifact', nodeType: 'text', title: '文案', status: 'failed', errorText: '余额不足' },
            { type: 'proposal', title: '生成 4 张', status: 'confirmed' },
            { type: 'question', title: '确认风格', status: 'answered', questions: [{ question: '选哪种？', options: ['写实'], multiSelect: true }] },
            { type: 'image', url: '', caption: '海报', fallbackUrl: 'https://x/a.png' },
          ],
        },
      ],
    }
    const dto = (await pipe.transform(payload, meta)) as CreateShareDto
    const t = dto.turns[0]
    expect(t.delivery).toEqual(payload.turns[0].delivery)
    expect(t.attachments?.[0].thumbUrl).toBe('https://x/u.png')
    expect(t.parts).toEqual(payload.turns[0].parts)
    // 任何一层被剥空都会让托管页静默丢内容（历史事故形态）
    expect(t.parts?.every((p) => Object.keys(p).length > 1)).toBe(true)
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
