import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import { NestExpressApplication } from '@nestjs/platform-express'
import { join } from 'path'
import { AppModule } from './app.module'
import { isOriginAllowed, parseCorsOrigins } from './cors.util'
import { NoCacheInterceptor } from './common/no-cache.interceptor'

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule)

  // 分片上传 JSON body 含 base64（~3MB/片），默认 100kb 会 413
  app.useBodyParser('json', { limit: '10mb' })
  app.useBodyParser('urlencoded', { limit: '10mb', extended: true })

  app.setGlobalPrefix('api')
  app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/api/uploads/' })

  const corsOrigins = parseCorsOrigins(process.env.CORS_ORIGIN)
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true)
        return
      }
      callback(null, isOriginAllowed(origin, corsOrigins))
    },
    credentials: true,
  })
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }))
  // H0-a（规格 2026-10-28 §5.1）：动态 GET 统一 no-store，缓存策略服务端收口（K1）
  app.useGlobalInterceptors(new NoCacheInterceptor())

  const port = process.env.PORT || 3001
  await app.listen(port)
  console.log(`🚀 超创平台 API 运行在 http://localhost:${port}`)
}

bootstrap()
