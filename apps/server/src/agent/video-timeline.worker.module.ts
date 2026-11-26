import { Module } from '@nestjs/common'
import { PrismaModule } from '../prisma/prisma.module'
import { StorageModule } from '../storage/storage.module'
import { MediaService } from '../media/media.service'
import { PersistRemoteService } from '../assets/persist-remote.service'
import { VideoTimelineWorkerService } from './video-timeline.worker'

/**
 * 独立进程专用的最小 module。
 *
 * 不能用 MediaModule / AssetsModule：它们带进了 MediaController / AssetsController，
 * 并经由 MediaModule -> AuthModule 注入链要求 STORAGE_ADAPTER，而 worker 上下文
 * 没有 AppModule 的那批全局 provider，导致启动时报
 * "Nest can't resolve dependencies of the AuthService (…, ?)" 直接退出。
 * worker 只需要三个 service + 两个全局 module（PrismaModule / StorageModule），
 * 因此在此直接 provide，绕开无用的 controller 与 AuthModule。
 */
@Module({
  imports: [PrismaModule, StorageModule],
  providers: [VideoTimelineWorkerService, MediaService, PersistRemoteService],
})
export class VideoTimelineWorkerModule {}
