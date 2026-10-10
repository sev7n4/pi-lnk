import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { isDefaultModelKey } from '@lnkpi/shared'
import { PrismaService } from '../prisma/prisma.service'
import {
  bumpModelCatalogVersion,
  modelCatalogRowToEntry,
  readModelCatalogVersion,
  refreshModelCatalogCache,
} from '../provider/model-catalog-store'
import { AdminTokenGuard } from './admin-token.guard'

/**
 * S2-1b 模型目录运营端点（spec: docs/superpowers/specs/2026-10-09-mph-s21-catalog-as-data-design.md §3.3）：
 *
 * - `GET    /api/admin/model-catalog`        全量条目（含软删，带 deletedAt 标记）+ 当前版本号；
 * - `POST   /api/admin/model-catalog`        新增（软删同 key 视为恢复上架，清 deletedAt 并覆盖字段）；
 * - `PUT    /api/admin/model-catalog/:id`    更新（modelKey 不可变；软删行 404，恢复走 POST）；
 * - `DELETE /api/admin/model-catalog/:id`    下架 = 软删（deletedAt，同 S0-1 语义）。
 *
 * - AdminTokenGuard（fail-closed，与 S1-1/S1-2 同一 guard）。
 * - 写操作（POST/PUT/DELETE）在**同一事务**内完成：条目落库 + 审计行（who/when/before/after）
 *   + `catalogVersion` 原子 +1（单调递增、last-write-win）；事务提交后刷新目录缓存，
 *   使「保存后台 → 本进程下一次 provider 调用镜像即对齐」确定性成立（跨实例由
 *   ensurePlatformChannel 的版本比对兜底）。
 * - 审计 `actor` 恒为 'admin'：共享密钥鉴权（Bearer LNKPI_ADMIN_TOKEN）无更细身份，
 *   密钥本身绝不落库/落日志。
 * - 默认模型防呆：DELETE `isDefaultModelKey` 命中 → 400 —— 默认模型被软删会让
 *   `resolveModelKeyFromRows` 的确定性 fallback 悬空，全模态解析退化。
 * - 单写原则（全局约束 §1.6）：本控制器**不写** `availability` 字段——
 *   探活器是唯一置 `unavailable` 的写入方；本控制器也不写该字段（条目层无此列）。
 */

const VALID_MODALITIES = ['text', 'image', 'video', 'audio'] as const
const VALID_PROVIDER_BINDINGS = ['gateway-openai-compat', 'fal-http', 'minimax-http'] as const
const VALID_AUDIO_KINDS = ['voice', 'design', 'music'] as const

/**
 * POST 并发兜底（B3 遗留③）：create 的查重（上方 409）是事务外 check-then-act，
 * 并发同 key create（或多实例部署）会在窗口内双双通过查重 → 后落库者撞 DB
 * `modelKey @unique` 拒绝（Prisma P2002）→ 500。这里把事务内 create/update 的
 * P2002 转成与既有查重**同形**的 409（审计/版本 bump 都未执行，事务随异常回滚）。
 * 判定走鸭子类型（code === 'P2002' + meta.target 含 modelKey），与本文件其余
 * 错误处理同风格；表上非 id 唯一约束只有 modelKey（schema.prisma:305），array /
 * 约束名两种 target 形态都按 includes 命中。
 */
function isUniqueModelKeyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string; meta?: { target?: string[] | string } }
  if (e.code !== 'P2002') return false
  const target = e.meta?.target
  if (target === undefined) return true // 唯一非 id 约束只有 modelKey，缺 target 也按它处理
  if (Array.isArray(target)) return target.includes('modelKey')
  return target.includes('modelKey')
}

const ACTOR = 'admin'
const RESOURCE_PREFIX = 'model-catalog'

/** admin API 的条目形状（JSON 字段已解析；meta 字段 ISO 字符串）。 */
export type AdminCatalogEntry = {
  id: string
  modelKey: string
  displayName: string
  gatewayModelId: string
  modality: string
  providerBinding: string
  audioKind: string | null
  voices: { id: string; label: string }[] | null
  params: Record<string, unknown>
  defaults: Record<string, unknown> | null
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

type CatalogEntryRow = {
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
  createdAt: Date
  updatedAt: Date
}

function parseJsonField<T>(raw: string | null, fallback: T): T {
  if (raw == null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function rowToAdminEntry(row: CatalogEntryRow): AdminCatalogEntry {
  return {
    id: row.id,
    modelKey: row.modelKey,
    displayName: row.displayName,
    gatewayModelId: row.gatewayModelId,
    modality: row.modality,
    providerBinding: row.providerBinding,
    audioKind: row.audioKind,
    voices: parseJsonField<{ id: string; label: string }[] | null>(row.voices, null),
    params: parseJsonField<Record<string, unknown>>(row.params, {}),
    defaults: parseJsonField<Record<string, unknown> | null>(row.defaults, null),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`${field} 必须是非空字符串`)
  }
  return value.trim()
}

/** 软删快照（审计 before/after 用）：行级 JSON，Date → ISO。 */
function auditSnapshot(row: CatalogEntryRow): Record<string, unknown> {
  return {
    ...rowToAdminEntry(row),
  }
}

@Controller('admin/model-catalog')
export class ModelCatalogAdminController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  @UseGuards(AdminTokenGuard)
  async list() {
    const [version, rows] = await Promise.all([
      readModelCatalogVersion(this.prisma),
      this.prisma.modelCatalogEntry.findMany({
        orderBy: [{ createdAt: 'asc' }, { modelKey: 'asc' }],
      }),
    ])
    return { code: 0, message: 'ok', data: { version, entries: rows.map(rowToAdminEntry) } }
  }

  @Post()
  @UseGuards(AdminTokenGuard)
  async create(@Body() body: Record<string, unknown>) {
    const input = parseEntryInput(body, false)
    const existing = await this.prisma.modelCatalogEntry.findUnique({
      where: { modelKey: input.modelKey! },
    })
    if (existing && existing.deletedAt == null) {
      throw new ConflictException(`modelKey 已存在: ${existing.modelKey}`)
    }

    const data = {
      modelKey: input.modelKey!,
      displayName: input.displayName!,
      gatewayModelId: input.gatewayModelId!,
      modality: input.modality!,
      providerBinding: input.providerBinding!,
      audioKind: input.audioKind ?? null,
      voices: input.voices ? JSON.stringify(input.voices) : null,
      params: JSON.stringify(input.params!),
      defaults: input.defaults ? JSON.stringify(input.defaults) : null,
      // 软删同 key = 恢复上架（下架条目的生命周期闭环；active 行在上方已 409 拦截）
      deletedAt: null,
    }
    const { row, version } = await this.prisma.$transaction(async (tx) => {
      let row: CatalogEntryRow
      try {
        row = await (existing
          ? tx.modelCatalogEntry.update({ where: { id: existing.id }, data })
          : tx.modelCatalogEntry.create({ data }))
      } catch (err) {
        // 并发窗口兜底：查重通过后、落库前另一请求/实例同 key 抢先提交 → P2002
        // → 与既有查重同形的 409（审计与 bump 尚未执行，事务整体回滚）。
        if (isUniqueModelKeyError(err)) {
          throw new ConflictException(`modelKey 已存在: ${input.modelKey}`)
        }
        throw err
      }
      await tx.adminAuditLog.create({
        data: {
          actor: ACTOR,
          action: `${RESOURCE_PREFIX}.create`,
          resource: `${RESOURCE_PREFIX}:${row.modelKey}`,
          before: existing ? JSON.stringify(auditSnapshot(existing)) : null,
          after: JSON.stringify(auditSnapshot(row)),
        },
      })
      const version = await bumpModelCatalogVersion(tx)
      return { row, version }
    })
    await refreshModelCatalogCache(this.prisma)
    return { code: 0, message: 'ok', data: { version, entry: rowToAdminEntry(row) } }
  }

  @Put(':id')
  @UseGuards(AdminTokenGuard)
  async update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    const existing = await this.prisma.modelCatalogEntry.findUnique({ where: { id } })
    if (!existing || existing.deletedAt != null) {
      throw new NotFoundException('目录条目不存在（或已下架，恢复请用 POST 同 modelKey）')
    }
    const input = parseEntryInput(body, true)
    if (input.modelKey && input.modelKey !== existing.modelKey) {
      throw new BadRequestException('modelKey 不可修改（目录条目的稳定标识，停用记录/镜像以它对齐）')
    }

    const data: Partial<Prisma.ModelCatalogEntryUpdateInput> = {}
    if (input.displayName !== undefined) data.displayName = input.displayName
    if (input.gatewayModelId !== undefined) data.gatewayModelId = input.gatewayModelId
    if (input.modality !== undefined) data.modality = input.modality
    if (input.providerBinding !== undefined) data.providerBinding = input.providerBinding
    if (input.audioKind !== undefined) data.audioKind = input.audioKind
    if (input.voices !== undefined) {
      data.voices = input.voices ? JSON.stringify(input.voices) : null
    }
    if (input.params !== undefined) data.params = JSON.stringify(input.params)
    if (input.defaults !== undefined) {
      data.defaults = input.defaults ? JSON.stringify(input.defaults) : null
    }

    const { row, version } = await this.prisma.$transaction(async (tx) => {
      const row = await tx.modelCatalogEntry.update({ where: { id }, data })
      await tx.adminAuditLog.create({
        data: {
          actor: ACTOR,
          action: `${RESOURCE_PREFIX}.update`,
          resource: `${RESOURCE_PREFIX}:${row.modelKey}`,
          before: JSON.stringify(auditSnapshot(existing)),
          after: JSON.stringify(auditSnapshot(row)),
        },
      })
      const version = await bumpModelCatalogVersion(tx)
      return { row, version }
    })
    await refreshModelCatalogCache(this.prisma)
    return { code: 0, message: 'ok', data: { version, entry: rowToAdminEntry(row) } }
  }

  @Delete(':id')
  @UseGuards(AdminTokenGuard)
  async remove(@Param('id') id: string) {
    const existing = await this.prisma.modelCatalogEntry.findUnique({ where: { id } })
    if (!existing || existing.deletedAt != null) {
      throw new NotFoundException('目录条目不存在（或已下架）')
    }
    if (isDefaultModelKey(existing.modelKey)) {
      throw new BadRequestException(
        `${existing.modelKey} 是目录默认模型，禁止下架（resolveModelKey 的确定性 fallback 依赖它）`,
      )
    }

    const deletedAt = new Date()
    const { row, version } = await this.prisma.$transaction(async (tx) => {
      const row = await tx.modelCatalogEntry.update({
        where: { id },
        data: { deletedAt },
      })
      await tx.adminAuditLog.create({
        data: {
          actor: ACTOR,
          action: `${RESOURCE_PREFIX}.delete`,
          resource: `${RESOURCE_PREFIX}:${row.modelKey}`,
          before: JSON.stringify(auditSnapshot(existing)),
          after: JSON.stringify(auditSnapshot(row)),
        },
      })
      const version = await bumpModelCatalogVersion(tx)
      return { row, version }
    })
    await refreshModelCatalogCache(this.prisma)
    return { code: 0, message: 'ok', data: { version, id: row.id, modelKey: row.modelKey } }
  }
}

type ParsedEntryInput = {
  modelKey?: string
  displayName?: string
  gatewayModelId?: string
  modality?: string
  providerBinding?: string
  audioKind?: string | null
  voices?: { id: string; label: string }[] | null
  params?: Record<string, unknown>
  defaults?: Record<string, unknown> | null
}

/** 字段白名单校验。create=true 时必填项齐全；update 只校验出现的字段（partial）。 */
function parseEntryInput(body: Record<string, unknown>, partial: boolean): ParsedEntryInput {
  const out: Record<string, unknown> = {}
  const req = (key: 'modelKey' | 'displayName' | 'gatewayModelId' | 'modality' | 'providerBinding') => {
    if (key in body || !partial) out[key] = validateField(key, body[key])
  }
  req('modelKey')
  req('displayName')
  req('gatewayModelId')
  req('modality')
  req('providerBinding')

  if ('audioKind' in body) {
    const v = body['audioKind']
    if (v === null) {
      out['audioKind'] = null
    } else if (typeof v === 'string' && (VALID_AUDIO_KINDS as readonly string[]).includes(v)) {
      out['audioKind'] = v
    } else {
      throw new BadRequestException(
        `audioKind 必须是 ${VALID_AUDIO_KINDS.join('/')} 或 null，收到: ${String(v)}`,
      )
    }
  }

  if ('voices' in body) {
    const v = body['voices']
    if (v === null) {
      out['voices'] = null
    } else if (
      Array.isArray(v) &&
      v.every((x) => x && typeof x === 'object' && typeof (x as { id: unknown }).id === 'string' && typeof (x as { label: unknown }).label === 'string')
    ) {
      out['voices'] = v as { id: string; label: string }[]
    } else {
      throw new BadRequestException('voices 必须是 { id, label }[] 或 null')
    }
  }

  if ('params' in body || !partial) {
    const v = body['params']
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      throw new BadRequestException('params 必须是非数组对象（字段名 → 处置）')
    }
    out['params'] = v as Record<string, unknown>
  }

  if ('defaults' in body) {
    const v = body['defaults']
    if (v === null) {
      out['defaults'] = null
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out['defaults'] = v as Record<string, unknown>
    } else {
      throw new BadRequestException('defaults 必须是对象或 null')
    }
  }

  return out as ParsedEntryInput
}

function validateField(key: string, value: unknown): string {
  const s = assertNonEmptyString(value, key)
  if (key === 'modality' && !(VALID_MODALITIES as readonly string[]).includes(s)) {
    throw new BadRequestException(`modality 必须是 ${VALID_MODALITIES.join('/')}，收到: ${s}`)
  }
  if (key === 'providerBinding' && !(VALID_PROVIDER_BINDINGS as readonly string[]).includes(s)) {
    throw new BadRequestException(
      `providerBinding 必须是 ${VALID_PROVIDER_BINDINGS.join('/')}，收到: ${s}`,
    )
  }
  return s
}
