import { describe, expect, it } from 'vitest'
import { Test } from '@nestjs/testing'
import { PrismaService } from '../prisma/prisma.service'
import { STORAGE_ADAPTER } from '../storage/storage.adapter'
import { VideoTimelineWorkerModule } from './video-timeline.worker.module'
import { VideoTimelineWorkerService } from './video-timeline.worker'

/**
 * 回归锁：worker 是独立进程，Nest 上下文只有自己的 module。
 *
 * 曾经 module 错误地 import MediaModule / AssetsModule，经由 MediaModule -> AuthModule
 * 拉进 AuthService，而 worker 上下文没有 STORAGE_ADAPTER，启动时直接报
 * "Nest can't resolve dependencies of the AuthService" 退出——worker 从未真正处理过任务。
 * 用真实的 module 定义做 compile() 才能抓到这类依赖解析缺陷；
 * 直接 new Service(fakeDeps) 的测试永远发现不了。
 */
describe('VideoTimelineWorkerModule 依赖解析', () => {
  it('可独立 compile 且能解析出 VideoTimelineWorkerService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [VideoTimelineWorkerModule],
    })
      .overrideProvider(PrismaService)
      .useValue({ generationRecord: {}, session: {} })
      .overrideProvider(STORAGE_ADAPTER)
      .useValue({ persist: async () => ({}) })
      .compile()

    expect(moduleRef.get(VideoTimelineWorkerService)).toBeInstanceOf(VideoTimelineWorkerService)
    await moduleRef.close()
  })
})
