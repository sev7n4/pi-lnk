import { Test } from '@nestjs/testing'
import { vi } from 'vitest'
import { MediaProbeService } from '../media/media-probe.service'
import { PointsService } from '../points/points.service'
import { ProviderResolverService } from '../provider/provider-resolver.service'
import { StudioService } from './studio.service'
import { PrismaService } from '../prisma/prisma.service'
import { UploadService } from '../upload/upload.service'

export function createMediaProbeMock(probeUrl = vi.fn(async (url: string) => ({
  url,
  width: 1024,
  height: 1024,
  bytes: 900_000,
  mimeType: 'image/png',
  probeStatus: 'ok' as const,
}))) {
  return { probeUrl }
}

export function defaultPlatformResolve(model?: string) {
  const modelName = model?.includes('::') ? model.split('::')[1]! : (model ?? '')
  return {
    channelId: 'platform',
    modelName,
    apiFormat: 'openai' as const,
    credentials: {
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL ?? '',
    },
    source: 'platform' as const,
  }
}

export function createPrismaMock() {
  let storedRecord: Record<string, unknown> | null = null
  return {
    user: {
      findUnique: async () => ({ id: 'u1', points: 9999 }),
      update: async () => ({ id: 'u1', points: 9994 }),
      updateMany: async () => ({ count: 1 }),
    },
    pointTransaction: {
      create: async (args: { data: Record<string, unknown> }) => ({
        id: 'pt1',
        ...args.data,
      }),
    },
    generationRecord: {
      create: async (args: { data: Record<string, unknown> }) => {
        storedRecord = { id: 'g1', createdAt: new Date(), ...args.data }
        return storedRecord
      },
      // record-first（G3 修复）后 generatePrompt 等以 update 终态收尾并返回更新后的记录，
      // 与真实 prisma update 语义一致：合并 stored 返回。
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        storedRecord = { ...(storedRecord ?? { id: args.where.id }), ...args.data }
        return storedRecord
      },
      delete: async () => ({}),
      findFirst: async () => storedRecord,
      findMany: async () => [],
    },
    session: {
      findUnique: async () => null,
    },
    $transaction: async (arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (tx: unknown) => Promise<unknown>)({
          user: {
            updateMany: async () => ({ count: 1 }),
            findUnique: async () => ({ points: 9994 }),
          },
          pointTransaction: {
            create: async (a: { data: Record<string, unknown> }) => ({ id: 'pt1', ...a.data }),
          },
        })
      }
      return Promise.all(arg as Promise<unknown>[])
    },
  }
}

export async function createStudioService() {
  const moduleRef = await Test.createTestingModule({
    providers: [
      StudioService,
      PointsService,
      {
        provide: PrismaService,
        useValue: createPrismaMock(),
      },
      {
        provide: ProviderResolverService,
        useValue: {
          resolveForGeneration: vi.fn(async (_userId: string, model?: string) =>
            defaultPlatformResolve(model),
          ),
        },
      },
      {
        provide: MediaProbeService,
        useValue: createMediaProbeMock(),
      },
      {
        provide: UploadService,
        useValue: { saveUserFile: vi.fn(async () => ({ url: 'https://cdn/comp.png' })) },
      },
    ],
  }).compile()

  return moduleRef.get(StudioService)
}

export const defaultMergeRefsResult = {
  mergedText: '',
  skippedMerge: true,
}

export function mockMergeRefsToPrompt(mergedText: string) {
  return vi.fn(async () => ({ mergedText, skippedMerge: true }))
}
