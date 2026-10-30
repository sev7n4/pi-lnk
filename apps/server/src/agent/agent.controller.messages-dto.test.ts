import 'reflect-metadata'
import { ValidationPipe } from '@nestjs/common'
import { plainToInstance } from 'class-transformer'
import { describe, expect, it } from 'vitest'
import { GetAgentMessagesQueryDto } from './agent.controller'

/**
 * H1-a 修复轮 1（审查 #1，Important）：全局 ValidationPipe({transform:true, whitelist:true})
 * 未开 enableImplicitConversion，HTTP query 恒为 string ⇒ `?limit=50` 以字符串进 @IsInt
 * 即 400（dead-on-arrival）。修法：limit 加 @Type(() => Number)。本测试用
 * plainToInstance + ValidationPipe.transform 模拟真实 HTTP query 输入（字符串值）钉死，
 * 直调 service/DTO 传 number 的既有测试测不出此坑。
 */

const pipe = new ValidationPipe({ transform: true, whitelist: true })

function transformQuery(query: Record<string, unknown>) {
  return pipe.transform(query, {
    metatype: GetAgentMessagesQueryDto,
    type: 'query',
  } as never) as Promise<GetAgentMessagesQueryDto>
}

describe('GetAgentMessagesQueryDto 经 ValidationPipe（模拟 HTTP query）', () => {
  it('字符串 limit 能通过校验并转为 number（审查 #1 回归钉死）', async () => {
    const dto = await transformQuery({ sessionId: 's1', threadId: 't1', limit: '50' })
    expect(dto.limit).toBe(50)
    expect(typeof dto.limit).toBe('number')
  })

  it('不传 limit 仍通过（undefined 保持可选）', async () => {
    const dto = await transformQuery({ sessionId: 's1', threadId: 't1' })
    expect(dto.limit).toBeUndefined()
  })

  it('whitelist 剥离未装饰字段；超界 limit 仍被拒', async () => {
    const dto = await transformQuery({ sessionId: 's1', threadId: 't1', limit: '50', evil: 'x' })
    expect((dto as unknown as Record<string, unknown>).evil).toBeUndefined()
    await expect(transformQuery({ sessionId: 's1', threadId: 't1', limit: '500' })).rejects.toThrow()
    await expect(transformQuery({ sessionId: 's1', threadId: 't1', limit: 'abc' })).rejects.toThrow()
  })
})
