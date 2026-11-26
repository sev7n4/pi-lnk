import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { VideoTimelineWorkerModule } from './agent/video-timeline.worker.module'
import { VideoTimelineWorkerService } from './agent/video-timeline.worker'

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(VideoTimelineWorkerModule, {
    logger: ['error', 'warn', 'log'],
  })
  const service = app.get(VideoTimelineWorkerService)
  const intervalMs = Number(process.env.VIDEO_TIMELINE_POLL_INTERVAL_MS ?? 3000)
  let running = false
  const tick = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      await service.processQueuedJob()
    } catch (err) {
      console.error('[video-timeline-worker] tick failed', err)
    } finally {
      running = false
    }
  }
  void tick().then(() => {
    setInterval(() => void tick(), intervalMs)
  })
}

void main()
