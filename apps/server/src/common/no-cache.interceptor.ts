import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import type { Observable } from 'rxjs'

/**
 * H0-a（规格 2026-10-28 §5.1）：动态 GET 统一注入 `Cache-Control: no-store`。
 *
 * 为什么在服务端收口（K1）：Express 对全部动态 GET 默认打 ETag、无 Cache-Control ⇒
 * 浏览器条件重校验拿 304 空体 ⇒ 前端 fetch `res.ok=false`/`json()` 抛错。此前修复
 * 全靠前端逐点补 `no-store`（已 8 处、3 次生产事故）——正确性不得依赖每个调用点的自觉。
 *
 * 白名单今日为空：将来出现「明确可缓存」的端点（如导出下载）在 CACHEABLE_GET_PATHS 显式登记。
 * `/api/uploads/*` 走 express static 中间件，先于拦截器执行，不受影响；
 * SSE（/runs/events）被注入 no-store 无副作用（本就不应缓存）。
 */
export const CACHEABLE_GET_PATHS: readonly string[] = []

export function isCacheablePath(path: string, whitelist: readonly string[] = CACHEABLE_GET_PATHS): boolean {
  return whitelist.some((p) => path === p || path.startsWith(`${p}/`))
}

@Injectable()
export class NoCacheInterceptor implements NestInterceptor {
  constructor(private readonly whitelist: readonly string[] = CACHEABLE_GET_PATHS) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp()
    const req = http.getRequest<{ method?: string; originalUrl?: string }>()
    if (req.method === 'GET' && !isCacheablePath(req.originalUrl ?? '', this.whitelist)) {
      http.getResponse<{ setHeader: (k: string, v: string) => void }>().setHeader('Cache-Control', 'no-store')
    }
    return next.handle()
  }
}
