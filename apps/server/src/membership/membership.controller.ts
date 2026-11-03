import { BadRequestException, Body, Controller, Get, Inject, Optional, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import { IsString } from 'class-validator'
import type { Request, Response } from 'express'
import { AuthGuard } from '../auth/auth.guard'
import { PointsRangeKey } from '../points/points-range'
import { parseShanghaiDay, parseUsageDaysRange } from '../points/points-usage-range'
import { SessionEventBus } from '../points/session-event-bus.service'
import { MembershipService, PointCategory, PointKind } from './membership.service'

class UpgradeDto {
  @IsString()
  plan!: string

  /// 风险 #2：升级必须持有已支付订单（Order.status=PAID）。
  /// 订单由 POST /payment/order 创建并经支付宝回调/查单入账。
  @IsString()
  orderId!: string
}

function parseRange(range: string): PointsRangeKey {
  return range === '7d' || range === 'all' || range === 'month' ? range : 'month'
}

const DEFAULT_TRANSACTIONS_LIMIT = 50
const MAX_TRANSACTIONS_LIMIT = 100

export function parseLimit(raw?: string): number {
  if (raw == null || raw === '') return DEFAULT_TRANSACTIONS_LIMIT
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return DEFAULT_TRANSACTIONS_LIMIT
  return Math.min(n, MAX_TRANSACTIONS_LIMIT)
}

@Controller('membership')
export class MembershipController {
  constructor(
    @Inject(MembershipService) private readonly membershipService: MembershipService,
    // Epic 2 Task 9：余额事件化 user 广播。@Optional 保持既有单测手工构造零破坏；
    // 运行时缺省 ⇒ SSE 端点立即结束（前端退避重试，余额退化为 refreshPoints 兜底）。
    @Optional()
    @Inject(SessionEventBus)
    private readonly eventBus?: SessionEventBus,
  ) {}

  @Get('plans')
  getPlans() {
    const data = this.membershipService.getPlans()
    return { code: 0, message: 'ok', data }
  }

  @Get('points')
  @UseGuards(AuthGuard)
  async getPoints(@Req() req: { user: { sub: string } }) {
    const data = await this.membershipService.getPoints(req.user.sub)
    return { code: 0, message: 'ok', data }
  }

  @Get('points-breakdown')
  @UseGuards(AuthGuard)
  async getPointsBreakdown(@Req() req: { user: { sub: string } }) {
    // 多池记账：按 purchased/granted/subscription 汇总可用余额（扣除已过期正额）。
    // 只读聚合，与 getPoints（User.points 单一权威余额）并存，不改动计费扣减链路。
    const data = await this.membershipService.getPointsBreakdown(req.user.sub)
    return { code: 0, message: 'ok', data }
  }

  @Post('claim-daily')
  @UseGuards(AuthGuard)
  async claimDaily(@Req() req: { user: { sub: string } }) {
    const data = await this.membershipService.claimDaily(req.user.sub)
    return { code: 0, message: 'ok', data }
  }

  @Post('upgrade')
  @UseGuards(AuthGuard)
  async upgrade(@Req() req: { user: { sub: string } }, @Body() dto: UpgradeDto) {
    // 资损安全：仅校验已支付订单后发放（F2 失败闭合在支付闭环落地后按订单校验解除）。
    const data = await this.membershipService.upgrade(req.user.sub, dto.plan, dto.orderId)
    return { code: 0, message: 'ok', data }
  }

  /// 退订当前套餐：「一个用户同时只持有一个套餐」的换购前置动作（放弃档位，积分保留）。
  @Post('cancel-subscription')
  @UseGuards(AuthGuard)
  async cancelSubscription(@Req() req: { user: { sub: string } }) {
    const data = await this.membershipService.cancelSubscription(req.user.sub)
    return { code: 0, message: 'ok', data }
  }

  /// 订阅快照（当前档位/周期/到期/是否已取消续期）——「我的订阅」页数据源。
  @Get('subscription')
  @UseGuards(AuthGuard)
  async subscription(@Req() req: { user: { sub: string } }) {
    const data = await this.membershipService.getSubscription(req.user.sub)
    return { code: 0, message: 'ok', data }
  }

  /// 取消自动续期（≠ 立即退订）：当前周期内继续可用，到期后惰性失效。
  @Post('cancel-auto-renew')
  @UseGuards(AuthGuard)
  async cancelAutoRenew(@Req() req: { user: { sub: string } }) {
    const data = await this.membershipService.cancelAutoRenew(req.user.sub)
    return { code: 0, message: 'ok', data }
  }

  @Get('transactions')
  @UseGuards(AuthGuard)
  async transactions(
    @Req() req: { user: { sub: string } },
    @Query('range') range = 'month',
    @Query('day') day?: string,
    @Query('kind') kind?: PointKind,
    @Query('category') category?: PointCategory,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    if (day && !parseShanghaiDay(day)) throw new BadRequestException('无效日期')
    const data = await this.membershipService.listTransactions(req.user.sub, {
      range: day ? undefined : parseRange(range),
      day,
      kind,
      category,
      cursor,
      limit: parseLimit(limit),
    })
    return { code: 0, message: 'ok', data }
  }

  /**
   * Epic 4（2026-11-04）：会话维度积分流水（跨会话聚合卡数据源）。
   * `sessionId` 必填（防全量拉取）；`since`（ISO）增量补拉；升序、限 200。
   */
  @Get('point-transactions')
  @UseGuards(AuthGuard)
  async pointTransactions(
    @Req() req: { user: { sub: string } },
    @Query('sessionId') sessionId?: string,
    @Query('since') since?: string,
  ) {
    if (!sessionId) throw new BadRequestException('sessionId 必填')
    const data = await this.membershipService.listSessionTransactions(
      req.user.sub,
      sessionId,
      since,
    )
    return { code: 0, message: 'ok', data }
  }

  /**
   * Epic 2 Task 9（2026-11-04）：余额事件化 user 广播——SSE 长连接。
   * 订阅 SessionEventBus 的 **user 通道**：任何会话/生成扣费或退款提交后，
   * 该用户打开的所有标签页都实时收到 credit_tx（balanceAfter 即权威余额）。
   * 传输纪律与 agent 旁听流同款（fetch + 手工解析，浏览器 EventSource 带不了 auth 头）：
   * - 订阅建立立刻写注释帧（客户端拿到响应头才算连上，防「200+0 字节」静默故障）；
   * - 15s 心跳保活（防 nginx/浏览器掐静默长连接）；credit_tx 低频，无需 idle 闸门；
   * - `res.on('close')` 必须退订（R1：防 emitter 泄漏）；
   * - 事件源头已由 CREDIT_TX flag 闸门（off 不 emit），本端点不重复设闸。
   */
  @Get('point-events')
  @UseGuards(AuthGuard)
  async pointEvents(@Req() req: Request & { user: { sub: string } }, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    if (!this.eventBus) {
      // 总线未装配（如单测手工构造）→ 不建立常驻连接，前端退避重试 + refreshPoints 兜底
      res.end()
      return
    }
    res.write(': point-events-ready\n\n')
    const heartbeat = setInterval(() => {
      try {
        res.write('data: {"type":"heartbeat"}\n\n')
      } catch {
        // 客户端已断开，close 回调会清理
      }
    }, 15_000)
    const unsubscribe = this.eventBus.subscribeUser(req.user.sub, (ev) => {
      try {
        res.write(`data: ${JSON.stringify(ev)}\n\n`)
      } catch {
        // 写失败 = 连接已断，close 回调清理
      }
    })
    res.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  }

  @Get('points-summary')
  @UseGuards(AuthGuard)
  async pointsSummary(
    @Req() req: { user: { sub: string } },
    @Query('range') range = 'month',
  ) {
    const data = await this.membershipService.pointsSummary(req.user.sub, parseRange(range))
    return { code: 0, message: 'ok', data }
  }

  @Get('usage')
  @UseGuards(AuthGuard)
  async usage(@Req() req: { user: { sub: string } }) {
    const data = await this.membershipService.usage(req.user.sub)
    return { code: 0, message: 'ok', data }
  }

  @Get('usage-days')
  @UseGuards(AuthGuard)
  async usageDays(
    @Req() req: { user: { sub: string } },
    @Query('range') range?: string,
  ) {
    const data = await this.membershipService.usageDays(req.user.sub, parseUsageDaysRange(range))
    return { code: 0, message: 'ok', data }
  }
}
