/**
 * S2-1a 模型目录 DB 包装器（spec: docs/superpowers/specs/2026-10-09-mph-s21-catalog-as-data-design.md）。
 *
 * 分层（规格 §3.2）：
 * - shared 的 `resolveModelKeyFromRows(rows, modality, key)` 是纯函数（无 DB）；
 * - 本模块是 **server 端 DB 包装器**：查 `ModelCatalogEntry`（软删过滤）+ 进程内缓存
 *   → 调纯函数。对外暴露与 shared `resolveModelKey` **同签名的同步函数**，
 *   调用点（studio/material/merge-chat-model）只换 import，零行为改动。
 *
 * 缓存策略（两选项中选定并记录）：**进程内缓存 + 5s TTL 惰性刷新**
 * （不选版本号失效——catalogVersion 表由 Task 2 的写端点引入，本任务无写方，
 * TTL 已满足「后台改 ≤5 分钟生效」判据且不依赖 Task 2 的存储落点）。
 * 刷新在 resolve 调用线程上**异步触发、不阻塞**（fire-and-forget，失败吞掉保旧值，
 * 与 upstream-probe 的非阻塞惯例一致）；刷新期间返回旧缓存。
 *
 * 播种时机（两选项中选定并记录）：**模块 init（Nest onModuleInit）**，非每次调用惰性播种。
 * `ModelCatalogSeedService.onModuleInit` 在 Nest bootstrap 阶段（HTTP 监听之前）注册
 * prisma 句柄并触发播种+装载，保证任何请求期 resolve 调用之前播种已启动。
 * bootstrap 完成前的冷启动窗口内，缓存回落到种子常量 `STUDIO_MODEL_CATALOG`——
 * 与播种后的 DB 状态**逐字节一致**（种子是 insert-only 且内容恰为该常量），行为零漂移。
 *
 * 单写原则（全局约束 §1）：DB 是唯一真源；**种子只插不改**——按 modelKey
 * 存在即跳过（软删行也算存在，下架不因重启复活），人工/后台改动永不被覆盖。
 */

import { Injectable, Inject, OnModuleInit } from '@nestjs/common'
import type { PrismaClient } from '@prisma/client'
import {
  STUDIO_MODEL_CATALOG,
  resolveModelKeyFromRows,
  type StudioModelEntry,
  type StudioModality,
} from '@lnkpi/shared'
import { PrismaService } from '../prisma/prisma.service'

/** 进程内缓存 TTL（毫秒）。5s：spec 判据「后台保存 ≤5 分钟生效」的上限远大于此，留足余量。 */
export const MODEL_CATALOG_CACHE_TTL_MS = 5_000

const VALID_MODALITIES: readonly StudioModality[] = ['text', 'image', 'video', 'audio']
const VALID_PROVIDER_BINDINGS = ['gateway-openai-compat', 'fal-http', 'minimax-http'] as const

/** DB 行的最小形状（列名与 Prisma 逐字一致，见 model-catalog-sync 的注释教训）。 */
export interface ModelCatalogEntryRow {
  id: string
  modelKey: string
  displayName: string
  gatewayModelId: string
  modality: string
  providerBinding: string
  audioKind: string | null
  voices: string | null
  params: string
  defaults: string | null
  deletedAt: Date | null
}

/** 缓存初值 = 种子常量：bootstrap 完成前的冷启动窗口行为与常量模式逐字节一致。 */
let cachedRows: StudioModelEntry[] = STUDIO_MODEL_CATALOG
let cachedAt = 0
let registeredPrisma: PrismaClient | null = null
let refreshInFlight: Promise<void> | null = null

/**
 * DB 行 → 目录条目。modality/providerBinding/params 做白名单/JSON 校验，
 * 脏行跳过（不进缓存，避免一条坏行毒化整个目录解析）；正常播种路径不会有脏行。
 */
export function modelCatalogRowToEntry(row: ModelCatalogEntryRow): StudioModelEntry | null {
  if (!VALID_MODALITIES.includes(row.modality as StudioModality)) return null
  if (!(VALID_PROVIDER_BINDINGS as readonly string[]).includes(row.providerBinding)) return null
  let params: unknown
  try {
    params = JSON.parse(row.params)
  } catch {
    return null
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null
  let voices: unknown
  if (row.voices != null) {
    try {
      voices = JSON.parse(row.voices)
    } catch {
      return null
    }
    if (!Array.isArray(voices)) return null
  }
  let defaults: unknown
  if (row.defaults != null) {
    try {
      defaults = JSON.parse(row.defaults)
    } catch {
      return null
    }
    if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) return null
  }
  return {
    modelKey: row.modelKey,
    displayName: row.displayName,
    gatewayModelId: row.gatewayModelId,
    modality: row.modality as StudioModality,
    providerBinding: row.providerBinding as StudioModelEntry['providerBinding'],
    ...(row.audioKind != null ? { audioKind: row.audioKind as StudioModelEntry['audioKind'] } : {}),
    ...(voices != null ? { voices: voices as StudioModelEntry['voices'] } : {}),
    params: params as StudioModelEntry['params'],
    ...(defaults != null ? { defaults: defaults as StudioModelEntry['defaults'] } : {}),
  }
}

/**
 * 种子播种：`STUDIO_MODEL_CATALOG` → `ModelCatalogEntry`，**insert-if-absent**
 * （存在即跳过——软删行也算存在，下架不复活；绝不 UPDATE，人工/后台改动存活）。
 * 返回本次新插条数（幂等验证用：稳定态第二次调用恒为 0）。
 */
export async function seedModelCatalogEntries(prisma: PrismaClient): Promise<number> {
  const existing = await prisma.modelCatalogEntry.findMany({ select: { modelKey: true } })
  const knownKeys = new Set(existing.map((r) => r.modelKey))
  let inserted = 0
  for (const entry of STUDIO_MODEL_CATALOG) {
    if (knownKeys.has(entry.modelKey)) continue
    await prisma.modelCatalogEntry.create({
      data: {
        modelKey: entry.modelKey,
        displayName: entry.displayName,
        gatewayModelId: entry.gatewayModelId,
        modality: entry.modality,
        providerBinding: entry.providerBinding,
        audioKind: entry.audioKind ?? null,
        voices: entry.voices ? JSON.stringify(entry.voices) : null,
        params: JSON.stringify(entry.params),
        defaults: entry.defaults ? JSON.stringify(entry.defaults) : null,
      },
    })
    inserted++
  }
  return inserted
}

/** 装载当前目录行（软删过滤 + 确定性排序）→ 目录条目数组（脏行跳过）。 */
export async function loadModelCatalogRows(prisma: PrismaClient): Promise<StudioModelEntry[]> {
  const rows = await prisma.modelCatalogEntry.findMany({
    where: { deletedAt: null },
    orderBy: [{ createdAt: 'asc' }, { modelKey: 'asc' }],
  })
  const entries: StudioModelEntry[] = []
  for (const row of rows) {
    const entry = modelCatalogRowToEntry(row)
    if (entry) entries.push(entry)
  }
  return entries
}

/**
 * bootstrap = 播种 + 装载 + 刷新缓存。由 ModelCatalogSeedService.onModuleInit
 * 触发（非阻塞）；也可被 TTL 惰性刷新复用。失败向上抛给调用方处理（保旧缓存）。
 */
export async function refreshModelCatalogCache(prisma: PrismaClient): Promise<void> {
  await seedModelCatalogEntries(prisma)
  const rows = await loadModelCatalogRows(prisma)
  if (rows.length > 0) {
    cachedRows = rows
    cachedAt = Date.now()
  }
}

/** TTL 过期且无在途刷新时，异步触发一次刷新（fire-and-forget，失败吞掉保旧值）。 */
function maybeRefresh(): void {
  if (!registeredPrisma) return
  if (refreshInFlight) return
  if (Date.now() - cachedAt <= MODEL_CATALOG_CACHE_TTL_MS) return
  const prisma = registeredPrisma
  refreshInFlight = refreshModelCatalogCache(prisma)
    .catch((err) => {
      console.error('[model-catalog-store] 目录缓存刷新失败，沿用旧缓存：', err)
    })
    .finally(() => {
      refreshInFlight = null
    })
}

/**
 * server 端 resolve 包装器：**与 shared `resolveModelKey` 同签名的同步函数**。
 * 调用点只换 import（`'@lnkpi/shared'` → 本模块），其余零改动。
 */
export function resolveModelKey(
  modality: StudioModality,
  requested?: string | null,
): { modelKey: string; entry: StudioModelEntry; fallback: boolean } {
  maybeRefresh()
  return resolveModelKeyFromRows(cachedRows, modality, requested)
}

// ── 测试钩子（仅测试使用；生产路径不可达） ──

/** 测试专用：重置模块级缓存/句柄（vitest isolate per file，无需跨文件协调）。 */
export function __resetModelCatalogStoreForTests(): void {
  cachedRows = STUDIO_MODEL_CATALOG
  cachedAt = 0
  registeredPrisma = null
  refreshInFlight = null
}

/** 测试专用：注入 prisma 句柄（模拟 ModelCatalogSeedService 的注册动作）。 */
export function __registerModelCatalogPrismaForTests(prisma: PrismaClient): void {
  registeredPrisma = prisma
}

/** 测试专用：把缓存标记为刚过期（下一次 resolve 触发刷新）。 */
export function __expireModelCatalogCacheForTests(): void {
  cachedAt = 0
}

/** 测试专用：观察在途刷新（同步触发后 await 它再断言新值）。 */
export function __modelCatalogRefreshInFlightForTests(): Promise<void> | null {
  return refreshInFlight
}

/**
 * S2-1a 播种接线：Nest bootstrap 阶段注册 prisma 并**非阻塞**触发播种+装载。
 * 失败不阻断启动（缓存保持种子常量，行为与常量模式一致，下次 TTL 到期重试）。
 */
@Injectable()
export class ModelCatalogSeedService implements OnModuleInit {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    registeredPrisma = this.prisma
    void refreshModelCatalogCache(this.prisma).catch((err) => {
      console.error('[model-catalog-store] bootstrap 播种/装载失败（冷启动回落种子常量）：', err)
    })
  }
}
