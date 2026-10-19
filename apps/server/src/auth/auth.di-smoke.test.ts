import { describe, it, expect } from 'vitest'
import { Test } from '@nestjs/testing'
import { JwtModule } from '@nestjs/jwt'
import { AuthModule } from './auth.module'
import { StorageModule } from '../storage/storage.module'
import { PrismaModule } from '../prisma/prisma.module'
import { AuthService } from './auth.service'
import { AuthController } from './auth.controller'

/**
 * AuthModule DI 装配冒烟（与 payment.di-smoke 同理：单元测试都直接 `new`，
 * 绕过了 DI 容器 ⇒ 模块图缺 exports / 少一个注入依赖，只有这里能暴露）。
 *
 * 2026-10-19：AuthService 新增 `STORAGE_ADAPTER` 注入（头像上传落盘）。
 * STORAGE_ADAPTER 由 @Global 的 StorageModule 提供——**必须真跑一次容器**，
 * 否则可能到生产才发现 AuthService 构造器解析失败、容器无限重启。
 */
describe('AuthModule DI 装配冒烟', () => {
  it('AuthModule 可装配，AuthService/AuthController 可解析（含 STORAGE_ADAPTER）', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        JwtModule.register({ global: true, secret: 'smoke-test-secret' }),
        StorageModule,
        AuthModule,
      ],
    }).compile()

    expect(moduleRef.get(AuthService)).toBeInstanceOf(AuthService)
    expect(moduleRef.get(AuthController)).toBeInstanceOf(AuthController)

    await moduleRef.close()
  })
})

// 局部引入避免与PrismaModule 的全局注册顺序耦合（与 payment 冒烟保持同一写法）
function PrismaModuleRef() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../prisma/prisma.module').PrismaModule
}