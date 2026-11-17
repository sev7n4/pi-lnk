// 文件：apps/server/src/skills/skills.module.di.test.ts
// 回归锚：2026-11-16 生产事故（PR #929 引入 / PR #931 修复）
//
//   #929 给 SkillsService 构造函数新增了 type-only interface 参数（runtime?: RuntimeSkillsClient），
//   编译期 design:paramtypes 该位退化为 Object，Nest 找不到名为 "Object" 的 provider：
//     ERROR [ExceptionHandler] Nest can't resolve dependencies of the SkillsService (PrismaService, ?).
//   ⇒ 容器启动即崩，部署健康检查 15 次全失败，生产回滚到 de30e8f8 才恢复。
//   #931 已补 @Optional()（仅 @Optional()，未加显式 token）。
//
//   #931 的注释自陈盲区：「本地手工 new 绕过 DI 测不到」——确实：
//   既有 skills.controller.sqlite.integration.test.ts 全部是 `new SkillsService(prisma as never, stub)`，
//   直接构造，完全不经过 Nest 容器 ⇒ 没有任何测试能发现 DI 解析失败。
//   本测试补上这一层：走真实 DI 容器（@nestjs/testing），与生产启动路径同构。
//
//   锁死的三条不变量：
//   ① SkillsService / SkillsModule 能被真实 DI 容器实例化（行为级）；
//   ② 第 2 个依赖被标记为可选（optional:paramtypes 含索引 1）——撤掉 @Optional 即红；
//   ③ 默认注入值为 undefined（生产语义：按 PI_RUNTIME_URL 现场构造，与 #929 之前一致），
//      且第 1 个依赖（PrismaService）不得被降级为可选（防止用 @Optional 掩盖真实缺失依赖）。
import { Global, Module } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { PrismaService } from '../prisma/prisma.service'
import { SkillsModule } from './skills.module'
import { SkillsService } from './skills.service'

/** 依赖存根：SkillsModule 不 import PrismaModule（它是 @Global()），JwtModule 在主应用里也是全局的。
 *  这里用 @Global() 存根模块复刻「全局可见」的解析环境。 */
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: 'u', phone: 'p' }) } },
  ],
  exports: [PrismaService, JwtService],
})
class DepsStubModule {}

describe('SkillsModule DI 解析（#929 生产崩溃回归锚，#931 修复）', () => {
  it('① SkillsService 能被真实 DI 容器实例化（修复前此用例因 Nest 解析失败而红）', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [{ provide: PrismaService, useValue: {} }, SkillsService],
    }).compile()
    expect(moduleRef.get(SkillsService)).toBeInstanceOf(SkillsService)
  })

  it('①b SkillsModule（含 controller 与 AuthGuard）整体能编译（与生产启动同构）', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DepsStubModule, SkillsModule],
    }).compile()
    expect(moduleRef.get(SkillsService)).toBeInstanceOf(SkillsService)
  })

  it('② 第 2 个依赖被标记为可选（撤掉 @Optional 即红——这是 #929 事故的根因位）', () => {
    const optionalDeps = Reflect.getMetadata('optional:paramtypes', SkillsService) as number[] | undefined
    expect(optionalDeps).toBeDefined()
    expect(optionalDeps).toContain(1)
  })

  it('③ 未提供运行时客户端时注入值为 undefined（生产语义：按 PI_RUNTIME_URL 现场构造）', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [{ provide: PrismaService, useValue: {} }, SkillsService],
    }).compile()
    const svc = moduleRef.get(SkillsService) as unknown as { runtime?: unknown }
    expect(svc.runtime).toBeUndefined()
  })

  it('③b 第 1 个依赖（PrismaService）仍是必需依赖（不得用 @Optional 掩盖真实缺失依赖）', () => {
    const optionalDeps = Reflect.getMetadata('optional:paramtypes', SkillsService) as number[] | undefined
    expect(optionalDeps ?? []).not.toContain(0)
    const paramtypes = Reflect.getMetadata('design:paramtypes', SkillsService) as unknown[]
    expect(paramtypes?.[0]).toBe(PrismaService)
  })
})
