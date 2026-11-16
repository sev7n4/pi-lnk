// 文件：apps/server/src/agent/agent.service.user-skills.test.ts
// M1-3 发起方接线：buildUserSkillResources 的 fail-open 包装单测。
// 核心组装逻辑在 SkillsService.buildSkillResources（集成测试覆盖）；
// client 透传在 pi-runtime.client.test.ts 覆盖；此处专测「接线包装」三态：
//  ① 装配 SkillsService + 有技能 → 返回 {skills}；② 查库异常 → undefined（不阻断对话）；
//  ③ 未装配 / 无 userId → undefined（M0 行为）。
import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'

function makeService(skills: unknown): AgentService {
  // 构造器 @Optional 参数多且中间夹非 optional 项，按位置传参脆弱；
  // 直接构造最小 service 后注入私有字段 skills（本测试只测包装方法，不依赖其他 DI）。
  const service = new AgentService({} as never, {} as never, {} as never)
  ;(service as unknown as { skills: unknown }).skills = skills
  ;(service as unknown as { piLogger: unknown }).piLogger = { warn: vi.fn() }
  return service
}

describe('AgentService.buildUserSkillResources（M1-3 发起方接线包装）', () => {
  it('装配 + 有技能 → 返回 {skills} 供 create 注入', async () => {
    const skill = { name: 's', description: 'd', content: 'c', filePath: '<virtual>/s/SKILL.md' }
    const service = makeService({ buildSkillResources: vi.fn().mockResolvedValue([skill]) })
    const out = await (
      service as unknown as { buildUserSkillResources: (u: string) => Promise<unknown> }
    ).buildUserSkillResources('u1')
    expect(out).toEqual({ skills: [skill] })
  })

  it('查库异常 → fail-open 返回 undefined（技能增强不阻断对话）', async () => {
    const service = makeService({ buildSkillResources: vi.fn().mockRejectedValue(new Error('db down')) })
    const out = await (
      service as unknown as { buildUserSkillResources: (u: string) => Promise<unknown> }
    ).buildUserSkillResources('u1')
    expect(out).toBeUndefined()
  })

  it('组装为空 → undefined（不传 resources，M0 内置行为）', async () => {
    const service = makeService({ buildSkillResources: vi.fn().mockResolvedValue([]) })
    const out = await (
      service as unknown as { buildUserSkillResources: (u: string) => Promise<unknown> }
    ).buildUserSkillResources('u1')
    expect(out).toBeUndefined()
  })

  it('未装配 SkillsService → undefined；无 userId → 不查库', async () => {
    const noSkills = makeService(undefined)
    expect(
      await (
        noSkills as unknown as { buildUserSkillResources: (u?: string) => Promise<unknown> }
      ).buildUserSkillResources('u1'),
    ).toBeUndefined()
    const build = vi.fn().mockResolvedValue([])
    const svc = makeService({ buildSkillResources: build })
    await (
      svc as unknown as { buildUserSkillResources: (u?: string) => Promise<unknown> }
    ).buildUserSkillResources(undefined)
    expect(build).not.toHaveBeenCalled()
  })
})
