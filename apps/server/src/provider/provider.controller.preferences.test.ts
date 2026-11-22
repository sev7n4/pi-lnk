import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { UpdatePreferencesDto } from './provider.controller'

/**
 * DTO 透传回归（AGENTS.md 硬约束：改 DTO 必写透传回归）。
 *
 * 全局 ValidationPipe = `{ transform: true, whitelist: true }`（src/main.ts:31）——
 * `whitelist` 会**剥掉无装饰属性**：漏一个装饰器 ⇒ 字段被静默丢弃
 * （用户点了授权开关，服务端永远收不到 ⇒ 授权失效且无报错）。
 *
 * 授权自动生成（规格 2026-11-22-generation-auto-approve-gate-design §3.2）的
 * `autoApproveGenerations` 走这条通道。
 */
describe('UpdatePreferencesDto 透传回归（whitelist 剥无装饰属性）', () => {
  it('autoApproveGenerations 带装饰器 ⇒ 保留且通过校验', async () => {
    const dto = plainToInstance(UpdatePreferencesDto, { autoApproveGenerations: 'auto' })
    const errors = await validate(dto, { whitelist: true })
    expect(errors).toHaveLength(0)
    expect(dto.autoApproveGenerations).toBe('auto')
  })

  it('非法值被 IsIn 白名单拦下（manual/auto 之外一律拒）', async () => {
    const dto = plainToInstance(UpdatePreferencesDto, { autoApproveGenerations: 'yes' })
    const errors = await validate(dto, { whitelist: true })
    expect(errors.length).toBeGreaterThan(0)
  })

  it('未传该字段 ⇒ 无错误且不产生该键（缺省走服务端 manual）', async () => {
    const dto = plainToInstance(UpdatePreferencesDto, { systemPrompt: 'x' })
    const errors = await validate(dto, { whitelist: true })
    expect(errors).toHaveLength(0)
    expect(dto.autoApproveGenerations).toBeUndefined()
  })
})
