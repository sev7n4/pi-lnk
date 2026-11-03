import { Module } from '@nestjs/common'
import { MembershipController } from './membership.controller'
import { MembershipService } from './membership.service'
import { PointsModule } from '../points/points.module'

@Module({
  imports: [
    // Epic 2 Task 9（2026-11-04）：余额事件化 user 广播——controller SSE 端点订阅
    // SessionEventBus 的 user 通道（PointsModule export 该 provider，共享单例）。
    PointsModule,
  ],
  controllers: [MembershipController],
  providers: [MembershipService],
  // PaymentModule 需注入 MembershipService（入账发分）——Nest 模块封装下
  // 不 export 则 import 方不可见（生产事故：PaymentService 构造器 DI 解析失败，
  // 单元测试直接 new Service 绕过了 DI 容器所以没暴露；已有 DI 装配冒烟测试守门）。
  exports: [MembershipService],
})
export class MembershipModule {}
