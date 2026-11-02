import { Controller, Get, Query } from '@nestjs/common'
import { PricingService } from './pricing.service'

/**
 * P2 T8：公开活动价目端点。公开只读、无 guard（返回的是已挂牌反比率，无敏感字段）；
 * 全局 prefix /api ⇒ 真实路径 GET /api/pricing/active。返回信封照 admin controller
 * 形态 `{ code, message, data }`。
 */
@Controller('pricing')
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  /**
   * 当前 active 版本的文本 token 反比率 map。空态（无 active 版本 / 无 token 行，
   * 如 v1 只有 legacy `text` 单行）→ `textTokenRatios` 为空对象，端点不报错。
   */
  @Get('active')
  async active() {
    const textTokenRatios = await this.pricing.getActiveTextTokenRatios()
    return { code: 0, message: 'ok', data: { textTokenRatios } }
  }

  /**
   * 展示层报价（修复规格 2026-11-02-points-display-single-source）：前端「消耗 N 积分 /
   * 预估 N 积分」唯一取数口。直接复用计费引擎 `pricing.quote()`，与计费同源同表 ⇒
   * 展示值 == 计费值（管理后台价目表单一真相，改价只改表、不动代码）。
   * 不传 userId ⇒ 走 global 表（与计费非灰度口径一致）；灰度折扣不预显，实际扣费以
   * 结算为准。`pricing.quote` 内部永不 throw（缺行/DB 错/无 active 版本/启动自检失配
   * 均落常量兜底），故本端点对展示层稳定返回信封。
   */
  @Get('quote')
  async quote(@Query() q: Record<string, string>) {
    const query = {
      capability: q.capability as never,
      modelKey: q.modelKey,
      count: q.count != null ? Number(q.count) : undefined,
      resolution: q.resolution,
      audioKind: q.audioKind as never,
      duration: q.duration != null ? Number(q.duration) : undefined,
      videoMode: q.videoMode,
      referenceImageCount: q.referenceImageCount != null ? Number(q.referenceImageCount) : undefined,
      referenceVideoCount: q.referenceVideoCount != null ? Number(q.referenceVideoCount) : undefined,
    }
    const r = await this.pricing.quote(query, undefined)
    return {
      code: 0,
      message: 'ok',
      data: {
        credits: r.credits,
        ruleVersion: r.ruleVersion,
        degraded: r.ruleVersion === 'constants-fallback',
      },
    }
  }
}
