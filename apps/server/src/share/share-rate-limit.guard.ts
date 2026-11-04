import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common'
import { Request } from 'express'

/**
 * 轻量内存限频守卫（不引入 @nestjs/throttler，避免新增重依赖）。
 *
 * 按 userId 限频：默认 60s 窗口内 ≤ 10 次分享创建。
 * 与 AuthGuard 配合（@UseGuards(AuthGuard, ShareRateLimitGuard)）：AuthGuard 先跑，
 * 故 request.user.sub 必然存在；若缺失则兜底拒（防御性，不允许未授权写入）。
 */
@Injectable()
export class ShareRateLimitGuard implements CanActivate {
  private readonly windowMs = 60_000
  private readonly max = 10
  private readonly hits = new Map<string, number[]>()

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: { sub: string } }>()
    const userId = request.user?.sub
    if (!userId) {
      throw new HttpException('未授权', HttpStatus.UNAUTHORIZED)
    }
    const now = Date.now()
    const recent = (this.hits.get(userId) ?? []).filter((t) => now - t < this.windowMs)
    if (recent.length >= this.max) {
      throw new HttpException('分享过于频繁，请稍后再试', HttpStatus.TOO_MANY_REQUESTS)
    }
    recent.push(now)
    this.hits.set(userId, recent)
    return true
  }
}
