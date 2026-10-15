import { Controller, Get } from '@nestjs/common'
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
}
