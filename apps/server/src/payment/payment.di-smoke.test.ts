import { describe, it, expect } from 'vitest'
import { Test } from '@nestjs/testing'
import { JwtModule } from '@nestjs/jwt'
import { PrismaModule } from '../prisma/prisma.module'
import { PaymentModule } from './payment.module'
import { MembershipModule } from '../membership/membership.module'
import { PaymentService } from './payment.service'
import { MembershipService } from '../membership/membership.service'

/**
 * DI 容器装配冒烟（生产事故防护网）。
 *
 * 背景（2026-10-17 生产事故）：单元测试全部直接 `new Service(...)`，绕过了
 * Nest DI 容器 ⇒ MembershipModule 忘记 `exports: [MembershipService]` 在
 * 全部测试里不可见，一上线 PaymentService 构造器解析失败，
 * api 容器无限重启、health 全红。tsc 不查模块图，本地资源限制也跑不动
 * 完整 AppModule 装配，故用「真实模块 + 最小全局依赖」复刻生产模块图：
 *
 *   PrismaModule（@Global，提供 PrismaService）
 *     └─ JwtModule（提供 JwtService，供 Nest 实例化 Membership/Payment
 *        控制器的 AuthGuard——guard 链断也一样起不来）
 *         └─ PaymentModule（imports MembershipModule）
 *              └─ MembershipService（依赖 PrismaService）
 *
 * 任何一环的 exports 缺失/拼写错误都在 CI 暴露，而非生产暴露。
 */
describe('PaymentModule DI 装配冒烟', () => {
  it('PaymentModule 可装配，PaymentService/MembershipService 可解析', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        // 与 AuthModule 一致：JwtModule 全局注册（真实 AppModule 靠它让
        // 所有模块的 AuthGuard 解析 JwtService）
        JwtModule.register({ global: true, secret: 'smoke-test-secret' }),
        PaymentModule,
        MembershipModule,
      ],
    }).compile()

    // 走到这里 = 模块图无缺失 exports / 无循环依赖 / guard 链完整
    expect(moduleRef.get(PaymentService)).toBeInstanceOf(PaymentService)
    expect(moduleRef.get(MembershipService)).toBeInstanceOf(MembershipService)

    await moduleRef.close()
  })
})
