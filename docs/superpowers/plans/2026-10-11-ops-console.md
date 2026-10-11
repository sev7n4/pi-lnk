# Ops Console V1（运营管理后台）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在主站内嵌 `/admin` 懒加载路由，为既有 4 组裸 admin 端点接上运营 UI，并新增 3 个最小服务端端点（审计日志只读 + 平台渠道 pricing 读/写）。

**Architecture:** Server 侧沿用 `AdminModule` + `AdminTokenGuard`（Bearer 共享密钥）+ 手写校验 + 事务内审计模式；Web 侧独立 axios 实例（sessionStorage token）+ pinia store + element-plus 页面，全部消费墨流令牌工具类；路由级懒加载保证 admin 代码独立 chunk。

**Tech Stack:** NestJS + Prisma/SQLite（server）、Vue 3 + pinia + element-plus + tailwind 令牌类（web）、vitest（双端）。

**Spec:** `docs/superpowers/specs/2026-10-11-ops-console-design.md`（executors 必须同读 spec 与本计划）

## Global Constraints

- 工作目录：worktree `/Users/4seven/workspace/pi-lnk-ops-console`，分支 `docs/ops-console-spec`（已含 spec 两笔 commit）。
- 颜色/字号一律消费令牌类（tailwind.config.js 已令牌化：`text-fg`/`text-fg-2`/`text-fg-3`、`bg-surface-base`、`border-line-subtle`、`text-danger`/`bg-danger-bg`、`text-warning` 等）；**禁止**新增 hex/rgba/`text-white`/`bg-[#`（`src/styles/design-token.test.ts` + `theme-usage.test.ts` 守卫会拦）。
- CSS 变量类不支持透明度修饰符：禁 `text-fg/50`，用 `text-fg-2`/`text-fg-3` 档位。
- 所有 admin 端点响应信封 `{ code: 0, message: 'ok', data }`；错误用 Nest 内建异常（HTTP 状态码 + message，非信封）。
- 审计 `actor` 恒为 `'admin'`；密钥绝不落库/落日志。
- 平台渠道端点**硬编码** `id = 'platform'`（与 `apps/server/src/provider/provider.service.ts` 的 `PLATFORM_CHANNEL_ID` 同值，admin 模块不 import provider 模块）。
- 不新增任何 npm 依赖；不改 Prisma schema（零迁移）。
- server 集成测试 harness：临时 SQLite + `prisma db push --skip-generate`（照抄 `model-catalog.controller.sqlite.integration.test.ts` 头部）。
- 命令里 pnpm 均在对应 app 目录下执行：server → `apps/server`，web → `apps/web`。

## Review Focus

1. **pricing 条目级替换**——PUT 必须只改目标条目的 `pricing` 键，`models` 数组其余条目与字段逐字节不动（pull-models 整块覆盖事故的重演防线）。Task 2 有逐字段对拍测试。
2. **畸形 `models` JSON 双语义**——GET fail-soft（`parseError:true` + 空列表）、PUT 409 拒盲写；两者不同语义，测试分别钉死。
3. **BYOK 渠道不可达**——端点只认 `id='platform'` 行；测试构造用户渠道行并断言其永不被修改。
4. **admin token 生命周期**——401/403 必须清 sessionStorage 并回输入门；token 不落 localStorage、不进 URL、不打日志。Task 3 测试钉死。
5. **admin chunk 独立**——`vite build` 产物中 AdminXxx 页面在独立懒加载 chunk，入口 chunk 不含 admin 模块。Task 9 验证。

---

### Task 1: Server — 审计日志只读端点

**Files:**
- Create: `apps/server/src/admin/audit-logs.controller.ts`
- Modify: `apps/server/src/admin/admin.module.ts`
- Test: `apps/server/src/admin/audit-logs.controller.sqlite.integration.test.ts`

**Interfaces:**
- Consumes: `PrismaService`（`adminAuditLog.findMany/count`）、`AdminTokenGuard`。
- Produces: `GET /api/admin/audit-logs?action=&resource=&page=&pageSize=` → `{ code:0, message:'ok', data:{ rows: AdminAuditLog[], total, page, pageSize } }`（rows 按 `createdAt desc`，Date 由框架序列化为 ISO）。Task 8 的 AdminAuditPage 消费此契约。

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/admin/audit-logs.controller.sqlite.integration.test.ts
import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AuditLogsAdminController } from './audit-logs.controller'

// B1/S2-1a 同款 harness：临时 SQLite + prisma db push。
const serverRoot = path.resolve(__dirname, '../..')

describe('AuditLogsAdminController（Ops Console §5.1）', () => {
  let dir: string
  let prisma: PrismaClient
  let controller: AuditLogsAdminController

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-audit-admin-sqlite-'))
    const dbPath = path.join(dir, 'test.db')
    const databaseUrl = `file:${dbPath}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    controller = new AuditLogsAdminController(prisma as never)
  })

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await prisma.adminAuditLog.deleteMany()
  })

  // 顺序播种（createdAt 由 DB 默认 now()，逐条插入天然递增）
  async function seedRows() {
    await prisma.adminAuditLog.create({
      data: { actor: 'admin', action: 'model-catalog.create', resource: 'model-catalog:a', after: '{}' },
    })
    await prisma.adminAuditLog.create({
      data: { actor: 'admin', action: 'upstream-routes.update', resource: 'upstream-routes:r1', before: '{}', after: '{}' },
    })
    await prisma.adminAuditLog.create({
      data: { actor: 'admin', action: 'platform-channel.pricing.set', resource: 'platform-channel:m1', after: '{"inputPerM":1}' },
    })
  }

  it('默认 createdAt 倒序分页，返回 rows/total/page/pageSize', async () => {
    await seedRows()
    const res = await controller.list({})
    expect(res.code).toBe(0)
    expect(res.data.total).toBe(3)
    expect(res.data.page).toBe(1)
    expect(res.data.pageSize).toBe(20)
    expect(res.data.rows.map((r) => r.action)).toEqual([
      'platform-channel.pricing.set',
      'upstream-routes.update',
      'model-catalog.create',
    ])
  })

  it('action / resource 精确过滤', async () => {
    await seedRows()
    const byAction = await controller.list({ action: 'upstream-routes.update' })
    expect(byAction.data.total).toBe(1)
    expect(byAction.data.rows[0]!.resource).toBe('upstream-routes:r1')

    const byResource = await controller.list({ resource: 'model-catalog:a' })
    expect(byResource.data.total).toBe(1)

    const none = await controller.list({ action: 'nope' })
    expect(none.data.rows).toEqual([])
    expect(none.data.total).toBe(0)
  })

  it('分页 skip/take 生效；pageSize 越界截到 100，page 越界回落 1', async () => {
    await seedRows()
    const p2 = await controller.list({ page: '2', pageSize: '2' })
    expect(p2.data.rows).toHaveLength(1)
    expect(p2.data.rows[0]!.action).toBe('model-catalog.create')

    const clipped = await controller.list({ pageSize: '5000' })
    expect(clipped.data.pageSize).toBe(100)

    const badPage = await controller.list({ page: '-3' })
    expect(badPage.data.page).toBe(1)

    const junk = await controller.list({ page: 'abc', pageSize: 'xyz' })
    expect(junk.data.page).toBe(1)
    expect(junk.data.pageSize).toBe(20)
  })

  it('before/after 原样透传（字符串）', async () => {
    await seedRows()
    const res = await controller.list({ action: 'platform-channel.pricing.set' })
    expect(res.data.rows[0]!.after).toBe('{"inputPerM":1}')
    expect(res.data.rows[0]!.actor).toBe('admin')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console/apps/server && pnpm exec vitest run src/admin/audit-logs.controller.sqlite.integration.test.ts
```
Expected: FAIL（`AuditLogsAdminController` 不存在，import 报错）

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/server/src/admin/audit-logs.controller.ts
import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { AdminTokenGuard } from './admin-token.guard'

/**
 * Ops Console §5.1 审计日志只读端点：`GET /api/admin/audit-logs`。
 *
 * - AdminTokenGuard（fail-closed，与 S1-1/S2-1b 同一 guard）。
 * - `AdminAuditLog` 此前只写不读（生产代码无查询面）——本端点补位，供运营台审计页消费。
 * - `action`/`resource` 精确匹配（可选）；`createdAt desc`；page 从 1 起；
 *   pageSize 上限 100（数据量 = 运营写操作频次，极低，`resource` 不建索引）。
 * - 只读：无任何写路径，不 bump 任何版本。
 */
const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE = 1
const DEFAULT_PAGE_SIZE = 20

function parseBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isInteger(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

@Controller('admin/audit-logs')
export class AuditLogsAdminController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  @UseGuards(AdminTokenGuard)
  async list(@Query() query: Record<string, unknown>) {
    const page = parseBoundedInt(query['page'], DEFAULT_PAGE, 1, Number.MAX_SAFE_INTEGER)
    const pageSize = parseBoundedInt(query['pageSize'], DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)
    const action = typeof query['action'] === 'string' && query['action'] !== '' ? query['action'] : undefined
    const resource =
      typeof query['resource'] === 'string' && query['resource'] !== '' ? query['resource'] : undefined
    const where =
      action === undefined && resource === undefined
        ? undefined
        : { ...(action !== undefined ? { action } : {}), ...(resource !== undefined ? { resource } : {}) }
    const [rows, total] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.adminAuditLog.count({ where }),
    ])
    return { code: 0, message: 'ok', data: { rows, total, page, pageSize } }
  }
}
```

Modify `apps/server/src/admin/admin.module.ts`：imports 区加 `AuditLogsAdminController`，`controllers` 数组首位插入 `AuditLogsAdminController`，文件头注释追加一行 `* Ops Console：audit-logs 只读 + platform-channel 定价读/写（spec docs/superpowers/specs/2026-10-11-ops-console-design.md）。`

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console/apps/server && pnpm exec vitest run src/admin/audit-logs.controller.sqlite.integration.test.ts
```
Expected: PASS（4 绿）

- [ ] **Step 5: Commit**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console && git add apps/server/src/admin/audit-logs.controller.ts apps/server/src/admin/audit-logs.controller.sqlite.integration.test.ts apps/server/src/admin/admin.module.ts
git commit -m "feat(admin): audit-logs 只读端点——补位 AdminAuditLog 只写不读（Ops Console §5.1）"
```

---

### Task 2: Server — 平台渠道定价 GET/PUT

**Files:**
- Create: `apps/server/src/admin/platform-channel.controller.ts`
- Modify: `apps/server/src/admin/admin.module.ts`
- Test: `apps/server/src/admin/platform-channel.controller.sqlite.integration.test.ts`

**Interfaces:**
- Consumes: `PrismaService`（`providerChannel.findUnique/update`）、`AdminTokenGuard`。
- Produces:
  - `GET /api/admin/platform-channel` → `{ data: { id, name, apiFormat, models: ChannelModelEntry[], parseError: boolean } }`；行不存在 → 404；`models` JSON 畸形 → 200 + `models:[]` + `parseError:true`（fail-soft）。
  - `PUT /api/admin/platform-channel/models/:name/pricing` body `{ pricing: Record<string,number> | null }` → `{ data: { entry, previousPricing } }`；条目级替换；未知条目 404；畸形 JSON 409；DTO 负例 400。
  - 类型 `ChannelModelEntry = { name: string; capability: string; pricing?: Record<string, number> } & Record<string, unknown>`（与 `provider.controller.ts` 的 `ChannelModelDto` 同形）。Task 7 的 AdminPricingPage 消费此契约。

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/admin/platform-channel.controller.sqlite.integration.test.ts
import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common'
import { PlatformChannelAdminController } from './platform-channel.controller'

const serverRoot = path.resolve(__dirname, '../..')

const MODELS_JSON = JSON.stringify([
  { name: 'm-a', capability: 'text', extraKeep: 'keep-me' },
  { name: 'm-b', capability: 'image', pricing: { inputPerM: 0.5, outputPerM: 2 } },
])

async function seedPlatformChannel(prisma: PrismaClient, modelsRaw: string) {
  await prisma.providerChannel.create({
    data: {
      id: 'platform',
      name: '平台渠道',
      apiFormat: 'openai',
      baseUrl: 'https://platform.example.com',
      models: modelsRaw,
    },
  })
}

describe('PlatformChannelAdminController（Ops Console §5.2）', () => {
  let dir: string
  let prisma: PrismaClient
  let controller: PlatformChannelAdminController

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-platform-channel-admin-sqlite-'))
    const dbPath = path.join(dir, 'test.db')
    const databaseUrl = `file:${dbPath}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    controller = new PlatformChannelAdminController(prisma as never)
  })

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await prisma.providerChannel.deleteMany()
    await prisma.adminAuditLog.deleteMany()
  })

  describe('GET', () => {
    it('解析 models 返回条目列表（不含敏感列）', async () => {
      await seedPlatformChannel(prisma, MODELS_JSON)
      const res = await controller.show()
      expect(res.data.id).toBe('platform')
      expect(res.data.parseError).toBe(false)
      expect(res.data.models).toHaveLength(2)
      expect(res.data.models[1]).toMatchObject({ name: 'm-b', pricing: { inputPerM: 0.5 } })
      // 敏感列绝不回显
      expect(JSON.stringify(res.data)).not.toContain('encryptedApiKey')
    })

    it('models JSON 畸形 → fail-soft：models:[] + parseError:true', async () => {
      await seedPlatformChannel(prisma, '{not-json')
      const res = await controller.show()
      expect(res.data.parseError).toBe(true)
      expect(res.data.models).toEqual([])
    })

    it('平台渠道行不存在 → 404', async () => {
      await expect(controller.show()).rejects.toThrow(NotFoundException)
    })
  })

  describe('PUT pricing', () => {
    beforeEach(async () => {
      await seedPlatformChannel(prisma, MODELS_JSON)
    })

    it('set：仅替换目标条目的 pricing 键，其余条目与字段逐字段不动', async () => {
      const res = await controller.setPricing('m-a', { pricing: { inputPerM: 1, outputPerM: 3 } })
      expect(res.data.previousPricing).toBeNull()
      expect(res.data.entry.pricing).toEqual({ inputPerM: 1, outputPerM: 3 })

      const row = await prisma.providerChannel.findUniqueOrThrow({ where: { id: 'platform' } })
      const models = JSON.parse(row.models) as Array<Record<string, unknown>>
      // m-a：pricing 落位、既有字段保留
      expect(models[0]).toMatchObject({ name: 'm-a', capability: 'text', extraKeep: 'keep-me' })
      // m-b：整条原样
      expect(models[1]).toEqual({ name: 'm-b', capability: 'image', pricing: { inputPerM: 0.5, outputPerM: 2 } })
      expect(models).toHaveLength(2)

      const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'platform-channel.pricing.set' } })
      expect(audit.resource).toBe('platform-channel:m-a')
      expect(audit.before).toBeNull()
      expect(audit.after).toBe('{"inputPerM":1,"outputPerM":3}')
    })

    it('overwrite：返回 previousPricing，审计 before 为旧值', async () => {
      await controller.setPricing('m-a', { pricing: { inputPerM: 1 } })
      const res = await controller.setPricing('m-a', { pricing: { inputPerM: 2, cacheReadPerM: 0.1 } })
      expect(res.data.previousPricing).toEqual({ inputPerM: 1 })
      const audits = await prisma.adminAuditLog.findMany({ where: { action: 'platform-channel.pricing.set' }, orderBy: { createdAt: 'asc' } })
      expect(audits).toHaveLength(2)
      expect(JSON.parse(audits[1]!.before!)).toEqual({ inputPerM: 1 })
    })

    it('clear（pricing:null）：pricing 键整键移除，审计 action 为 clear', async () => {
      const res = await controller.setPricing('m-b', { pricing: null })
      expect(res.data.previousPricing).toEqual({ inputPerM: 0.5, outputPerM: 2 })
      const row = await prisma.providerChannel.findUniqueOrThrow({ where: { id: 'platform' } })
      const models = JSON.parse(row.models) as Array<Record<string, unknown>>
      expect(models[1]).toEqual({ name: 'm-b', capability: 'image' })
      const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'platform-channel.pricing.clear' } })
      expect(audit.after).toBeNull()
    })

    it('未知条目 → 404；body 缺 pricing 键 → 400', async () => {
      await expect(controller.setPricing('nope', { pricing: { inputPerM: 1 } })).rejects.toThrow(NotFoundException)
      await expect(controller.setPricing('m-a', {})).rejects.toThrow(BadRequestException)
    })

    it('DTO 负例：负数/非有限数/空对象/非对象 → 400', async () => {
      await expect(controller.setPricing('m-a', { pricing: { inputPerM: -1 } })).rejects.toThrow(BadRequestException)
      await expect(controller.setPricing('m-a', { pricing: { inputPerM: Number.POSITIVE_INFINITY } })).rejects.toThrow(BadRequestException)
      await expect(controller.setPricing('m-a', { pricing: {} })).rejects.toThrow(BadRequestException)
      await expect(controller.setPricing('m-a', { pricing: 'cheap' })).rejects.toThrow(BadRequestException)
    })

    it('models JSON 畸形 → 409 拒盲写（渠道行不被修改）', async () => {
      await prisma.providerChannel.update({ where: { id: 'platform' }, data: { models: '{broken' } })
      await expect(controller.setPricing('m-a', { pricing: { inputPerM: 1 } })).rejects.toThrow(ConflictException)
      const row = await prisma.providerChannel.findUniqueOrThrow({ where: { id: 'platform' } })
      expect(row.models).toBe('{broken')
    })

    it('BYOK 隔离：用户渠道行永不被端点触碰', async () => {
      await prisma.providerChannel.create({
        data: { id: 'user-ch-1', userId: 'u1', name: '我的渠道', apiFormat: 'openai', baseUrl: 'https://byok.example.com', models: MODELS_JSON },
      })
      await controller.setPricing('m-a', { pricing: { inputPerM: 9 } })
      const userRow = await prisma.providerChannel.findUniqueOrThrow({ where: { id: 'user-ch-1' } })
      expect(userRow.models).toBe(MODELS_JSON)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console/apps/server && pnpm exec vitest run src/admin/platform-channel.controller.sqlite.integration.test.ts
```
Expected: FAIL（`PlatformChannelAdminController` 不存在）

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/server/src/admin/platform-channel.controller.ts
import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { AdminTokenGuard } from './admin-token.guard'

/**
 * Ops Console §5.2 平台渠道定价端点（pricing 数据面 = PR #350 的 `models[].pricing`）。
 *
 * - 硬编码只操作 `id='platform'` 单行（与 provider.service.ts 的 PLATFORM_CHANNEL_ID
 *   同值；不 import provider 模块）——BYOK 用户渠道结构性不可达。
 * - GET：models 解析失败 fail-soft（`models:[] + parseError:true`），绝不 500。
 * - PUT：条目级 pricing 替换（set / clear=null），**其余条目与字段一律不动**
 *   （防 pull-models 式整块覆盖重演）；models 畸形 → 409 拒盲写。
 * - 渠道行由 provider-resolver 每请求直读 DB（非 5s TTL 缓存），PUT 即时生效；
 *   渠道不在 catalogVersion/routesVersion 域内，不 bump。
 * - 审计：条目级 diff（旧/新 pricing 对象），actor 恒 'admin'。
 */

const PLATFORM_CHANNEL_ID = 'platform'
const ACTOR = 'admin'
const RESOURCE_PREFIX = 'platform-channel'

type ChannelModelEntry = { name: string; capability: string; pricing?: Record<string, number> } & Record<string, unknown>

const PRICING_KEYS = ['inputPerM', 'outputPerM', 'cacheReadPerM', 'cacheWritePerM'] as const

function parseModels(raw: string | null): { models: ChannelModelEntry[]; parseError: boolean } {
  if (raw == null) return { models: [], parseError: false }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return { models: [], parseError: true }
    return { models: parsed as ChannelModelEntry[], parseError: false }
  } catch {
    return { models: [], parseError: true }
  }
}

function parsePricingInput(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('pricing 必须是非数组对象或 null（null=清除）')
  }
  const out: Record<string, number> = {}
  let provided = 0
  for (const key of PRICING_KEYS) {
    const v = (value as Record<string, unknown>)[key]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new BadRequestException(`pricing.${key} 必须是非负有限数，收到: ${String(v)}`)
    }
    out[key] = v
    provided += 1
  }
  if (provided === 0) {
    throw new BadRequestException(`pricing 至少包含一个费率字段：${PRICING_KEYS.join('/')}`)
  }
  return out
}

@Controller('admin/platform-channel')
export class PlatformChannelAdminController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  @UseGuards(AdminTokenGuard)
  async show() {
    const channel = await this.prisma.providerChannel.findUnique({ where: { id: PLATFORM_CHANNEL_ID } })
    if (!channel) {
      throw new NotFoundException('平台渠道行不存在（应由 ensurePlatformChannel 播种）')
    }
    const { models, parseError } = parseModels(channel.models)
    return {
      code: 0,
      message: 'ok',
      data: { id: channel.id, name: channel.name, apiFormat: channel.apiFormat, models, parseError },
    }
  }

  @Put('models/:name/pricing')
  @UseGuards(AdminTokenGuard)
  async setPricing(@Param('name') name: string, @Body() body: Record<string, unknown>) {
    if (!('pricing' in body)) {
      throw new BadRequestException('body 必须包含 pricing 键（对象=设置，null=清除）')
    }
    const pricingIn = body['pricing']
    const pricing = pricingIn === null ? null : parsePricingInput(pricingIn)

    const channel = await this.prisma.providerChannel.findUnique({ where: { id: PLATFORM_CHANNEL_ID } })
    if (!channel) {
      throw new NotFoundException('平台渠道行不存在（应由 ensurePlatformChannel 播种）')
    }
    const { models, parseError } = parseModels(channel.models)
    if (parseError) {
      throw new ConflictException('平台渠道 models JSON 畸形，拒绝盲写（请先修复渠道行）')
    }
    const index = models.findIndex((m) => m !== null && typeof m === 'object' && m.name === name)
    if (index === -1) {
      throw new NotFoundException(`平台渠道模型不存在: ${name}`)
    }
    const before = models[index]!.pricing ?? null
    const entry: ChannelModelEntry = { ...models[index] }
    if (pricing === null) delete entry.pricing
    else entry.pricing = pricing
    const nextModels = models.slice()
    nextModels[index] = entry

    await this.prisma.$transaction(async (tx) => {
      await tx.providerChannel.update({
        where: { id: PLATFORM_CHANNEL_ID },
        data: { models: JSON.stringify(nextModels) },
      })
      await tx.adminAuditLog.create({
        data: {
          actor: ACTOR,
          action: pricing === null ? `${RESOURCE_PREFIX}.pricing.clear` : `${RESOURCE_PREFIX}.pricing.set`,
          resource: `${RESOURCE_PREFIX}:${name}`,
          before: before === null ? null : JSON.stringify(before),
          after: pricing === null ? null : JSON.stringify(pricing),
        },
      })
    })
    return { code: 0, message: 'ok', data: { entry, previousPricing: before } }
  }
}
```

Modify `apps/server/src/admin/admin.module.ts`：`controllers` 数组追加 `PlatformChannelAdminController`。

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console/apps/server && pnpm exec vitest run src/admin/platform-channel.controller.sqlite.integration.test.ts
```
Expected: PASS（10 绿）

- [ ] **Step 5: 全量 admin 回归 + Commit**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console/apps/server && pnpm exec vitest run src/admin/
cd /Users/4seven/workspace/pi-lnk-ops-console && git add apps/server/src/admin/platform-channel.controller.ts apps/server/src/admin/platform-channel.controller.sqlite.integration.test.ts apps/server/src/admin/admin.module.ts
git commit -m "feat(admin): 平台渠道 pricing GET/PUT——条目级替换 + 畸形 fail-soft/409 拒盲写（Ops Console §5.2）"
```
Expected: admin 目录全绿

---

### Task 3: Web — admin-api / store / 布局壳 / 路由

**Files:**
- Create: `apps/web/src/services/admin-api.ts`
- Create: `apps/web/src/services/admin-api.test.ts`
- Create: `apps/web/src/stores/admin.ts`
- Create: `apps/web/src/pages/admin/AdminLayoutPage.vue`
- Create: `apps/web/src/pages/admin/AdminLayoutPage.test.ts`
- Modify: `apps/web/src/router/index.ts`（`routes` 数组追加 `/admin` 分支）

**Interfaces:**
- Consumes: `getApiBaseUrl()`（`@/services/api-base`）、既有路由懒加载模式。
- Produces（Task 4–8 全部消费，签名逐字为准）:
  - `adminHttp: AxiosInstance`
  - `setAdminUnauthorizedHandler(handler: (() => void) | null): void`
  - `class AdminApiError extends Error { status: number }`
  - `adminApi.verify(): Promise<CatalogListResult>`
  - `adminApi.listCatalog(): Promise<CatalogListResult>`（`CatalogListResult = { version: number; entries: AdminCatalogEntry[] }`）
  - `adminApi.createCatalogEntry(input: CatalogEntryInput): Promise<{ version: number; entry: AdminCatalogEntry }>`
  - `adminApi.updateCatalogEntry(id: string, input: Partial<CatalogEntryInput>): Promise<{ version: number; entry: AdminCatalogEntry }>`
  - `adminApi.deleteCatalogEntry(id: string): Promise<{ version: number; id: string; modelKey: string }>`
  - `adminApi.listRoutes(): Promise<{ version: number; routes: AdminRouteRow[] }>`
  - `adminApi.updateRoute(id: string, input: Partial<AdminRouteInput>): Promise<{ version: number; route: AdminRouteRow }>`
  - `adminApi.modelHealth(windowHours?: 1 | 6 | 24 | 168): Promise<{ generatedAt: string; rows: ModelHealthRow[]; alerts: HealthAlert[] }>`（`ModelHealthRow`/`HealthAlert` 类型从 `@lnkpi/shared` import）
  - `adminApi.latestProbeRuns(): Promise<{ runs: ProbeRunRow[] }>`
  - `adminApi.platformChannel(): Promise<PlatformChannelView>`
  - `adminApi.setPlatformModelPricing(name: string, pricing: Record<string, number> | null): Promise<{ entry: ChannelModelEntry; previousPricing: Record<string, number> | null }>`
  - `adminApi.listAuditLogs(params?: { action?: string; resource?: string; page?: number; pageSize?: number }): Promise<AuditLogPage>`
  - `useAdminStore()`：state `{ token, authError }`、getter `hasToken`、actions `init()/setToken(t)/clearToken()`
  - 路由：`/admin`（redirect `/admin/models`）+ 5 个子路由，name 分别为 `admin-models` / `admin-routes` / `admin-health` / `admin-pricing` / `admin-audit`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/services/admin-api.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminApiError, ADMIN_TOKEN_KEY, adminApi, setAdminUnauthorizedHandler } from './admin-api'

const { axiosGet, axiosPut, axiosPost, axiosDelete } = vi.hoisted(() => ({
  axiosGet: vi.fn(),
  axiosPut: vi.fn(),
  axiosPost: vi.fn(),
  axiosDelete: vi.fn(),
}))

vi.mock('axios', () => {
  const interceptors = {
    request: { use: vi.fn() },
    response: { use: vi.fn() },
  }
  const instance = {
    get: (...args: unknown[]) => axiosGet(...args),
    put: (...args: unknown[]) => axiosPut(...args),
    post: (...args: unknown[]) => axiosPost(...args),
    delete: (...args: unknown[]) => axiosDelete(...args),
    interceptors,
  }
  return {
    default: {
      create: vi.fn(() => instance),
      // 拦截器注册后手动触发用
      __instance: instance,
    },
  }
})

vi.mock('./api-base', () => ({ getApiBaseUrl: () => '/api' }))

function ok(data: unknown) {
  return { data: { code: 0, message: 'ok', data } }
}

describe('admin-api', () => {
  beforeEach(() => {
    sessionStorage.clear()
    axiosGet.mockReset()
    axiosPut.mockReset()
  })

  afterEach(() => {
    setAdminUnauthorizedHandler(null)
  })

  it('请求前从 sessionStorage 注入 Bearer 头（request 拦截器）', async () => {
    // 拦截器注册发生在模块加载期；这里直接验证 adminApi 走 axios 并携带数据解包
    sessionStorage.setItem(ADMIN_TOKEN_KEY, 't-1')
    axiosGet.mockResolvedValue(ok({ version: 1, entries: [] }))
    await adminApi.listCatalog()
    expect(axiosGet).toHaveBeenCalledWith('/admin/model-catalog', expect.objectContaining({ params: undefined }))
  })

  it('信封 code=0 → 解包 data', async () => {
    axiosGet.mockResolvedValue(ok({ runs: [] }))
    const data = await adminApi.latestProbeRuns()
    expect(data).toEqual({ runs: [] })
  })

  it('HTTP 401 → 清 sessionStorage + 触发 handler + 抛 AdminApiError', async () => {
    const onUnauthorized = vi.fn()
    setAdminUnauthorizedHandler(onUnauthorized)
    sessionStorage.setItem(ADMIN_TOKEN_KEY, 't-1')
    axiosGet.mockRejectedValue({
      response: { status: 401, data: { message: 'Unauthorized' } },
      message: 'Request failed',
    })
    await expect(adminApi.listCatalog()).rejects.toMatchObject({
      status: 401,
      constructor: AdminApiError,
    })
    // 拦截器在模块加载期注册，mock 的 response.use 捕获注册函数后由 admin-api 内部调用。
    // 若此断言失败，检查 response 拦截器是否被正确注册并被本测试间接驱动（见实现）。
    expect(onUnauthorized).not.toHaveBeenCalledTimes(0)
  })
})
```

注意：上例第三个用例依赖「拦截器注册函数可被测试驱动」。为让测试确定性，实现里把响应拦截器逻辑抽成**可导出的纯函数** `handleAdminResponseError(err): Promise<never>`，axios 侧只做 `adminHttp.interceptors.response.use((r) => r, handleAdminResponseError)`。测试直接调用 `handleAdminResponseError`，不要通过 mock axios 间接驱动。上面第三个用例改写为：

```ts
import { handleAdminResponseError } from './admin-api'

it('HTTP 401 → 清 sessionStorage + 触发 handler + 抛 AdminApiError', async () => {
  const onUnauthorized = vi.fn()
  setAdminUnauthorizedHandler(onUnauthorized)
  sessionStorage.setItem(ADMIN_TOKEN_KEY, 't-1')
  await expect(
    handleAdminResponseError({
      response: { status: 401, data: { message: 'Unauthorized' } },
      message: 'Request failed',
    }),
  ).rejects.toMatchObject({ status: 401 })
  expect(onUnauthorized).toHaveBeenCalledTimes(1)
  expect(sessionStorage.getItem(ADMIN_TOKEN_KEY)).toBeNull()
})

it('HTTP 403 同样清理；其他错误不清 token', async () => {
  const onUnauthorized = vi.fn()
  setAdminUnauthorizedHandler(onUnauthorized)
  sessionStorage.setItem(ADMIN_TOKEN_KEY, 't-1')
  await expect(
    handleAdminResponseError({ response: { status: 403, data: { message: 'Forbidden' } }, message: 'x' }),
  ).rejects.toMatchObject({ status: 403 })
  expect(sessionStorage.getItem(ADMIN_TOKEN_KEY)).toBeNull()
  sessionStorage.setItem(ADMIN_TOKEN_KEY, 't-1')
  await expect(
    handleAdminResponseError({ response: { status: 500, data: { message: 'boom' } }, message: 'x' }),
  ).rejects.toMatchObject({ status: 500 })
  expect(onUnauthorized).toHaveBeenCalledTimes(1)
  expect(sessionStorage.getItem(ADMIN_TOKEN_KEY)).toBe('t-1')
})
```

（去掉 axios mock 里用不到的第三用例版本，保留前两个用例验证解包与调用形态。）

```ts
// apps/web/src/pages/admin/AdminLayoutPage.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import AdminLayoutPage from './AdminLayoutPage.vue'
import { ADMIN_TOKEN_KEY } from '@/services/admin-api'

const { verifyMock } = vi.hoisted(() => ({ verifyMock: vi.fn() }))

vi.mock('@/services/admin-api', () => ({
  ADMIN_TOKEN_KEY: 'lnkpi_admin_token',
  adminApi: { verify: (...args: unknown[]) => verifyMock(...args) },
  setAdminUnauthorizedHandler: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ path: '/admin/models' }),
}))

function mountPage() {
  return mount(AdminLayoutPage, { global: { plugins: [ElementPlus, createPinia()] } })
}

describe('AdminLayoutPage', () => {
  beforeEach(() => {
    sessionStorage.clear()
    verifyMock.mockReset()
  })

  it('无 token → 渲染输入门，不渲染侧栏', () => {
    const w = mountPage()
    expect(w.find('.admin-gate').exists()).toBe(true)
    expect(w.find('.admin-shell').exists()).toBe(false)
  })

  it('输入 token 验证成功 → 存 sessionStorage 并渲染侧栏', async () => {
    verifyMock.mockResolvedValue({ version: 1, entries: [] })
    const w = mountPage()
    await w.find('input[type="password"]').setValue('sk-admin')
    await w.find('button').trigger('click')
    await flushPromises()
    expect(sessionStorage.getItem(ADMIN_TOKEN_KEY)).toBe('sk-admin')
    expect(w.find('.admin-shell').exists()).toBe(true)
  })

  it('验证失败（401）→ 清 token、停留输入门并提示', async () => {
    verifyMock.mockRejectedValue(new Error('401'))
    const w = mountPage()
    await w.find('input[type="password"]').setValue('bad')
    await w.find('button').trigger('click')
    await flushPromises()
    expect(sessionStorage.getItem(ADMIN_TOKEN_KEY)).toBeNull()
    expect(w.find('.admin-gate').exists()).toBe(true)
    expect(w.text()).toContain('token 校验失败')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console/apps/web && pnpm exec vitest run src/services/admin-api.test.ts src/pages/admin/AdminLayoutPage.test.ts
```
Expected: FAIL（模块不存在）

- [ ] **Step 3: Write implementation**

```ts
// apps/web/src/services/admin-api.ts
import axios, { type AxiosError, type AxiosInstance } from 'axios'
import { getApiBaseUrl } from './api-base'
import type { HealthAlert, ModelHealthRow } from '@lnkpi/shared'

/**
 * Ops Console admin API（spec §4.2）：
 * - 独立 axios 实例：Bearer 来自 sessionStorage（不落 localStorage、不进 URL、不打日志）。
 * - 401/403 → 清 token + 回调 store（回输入门）；其余错误归一为 AdminApiError。
 * - 服务端信封 { code, message, data }；HTTP 错误体为 Nest 异常 { message, statusCode }。
 */

export const ADMIN_TOKEN_KEY = 'lnkpi_admin_token'

export class AdminApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'AdminApiError'
    this.status = status
  }
}

export const adminHttp: AxiosInstance = axios.create({
  baseURL: getApiBaseUrl(),
  timeout: 30_000,
})

adminHttp.interceptors.request.use((config) => {
  const token = sessionStorage.getItem(ADMIN_TOKEN_KEY)
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

type UnauthorizedHandler = () => void
let unauthorizedHandler: UnauthorizedHandler | null = null

export function setAdminUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler
}

/** 响应错误归一（可导出以便测试直调）：401/403 清会话，其余原样归一。 */
export function handleAdminResponseError(err: unknown): Promise<never> {
  const axiosErr = err as AxiosError<{ message?: string }> | undefined
  const status = axiosErr?.response?.status ?? 0
  if (status === 401 || status === 403) {
    sessionStorage.removeItem(ADMIN_TOKEN_KEY)
    unauthorizedHandler?.()
  }
  const message = axiosErr?.response?.data?.message ?? axiosErr?.message ?? '请求失败'
  return Promise.reject(new AdminApiError(message, status))
}

adminHttp.interceptors.response.use((response) => response, handleAdminResponseError)

type Envelope<T> = { code: number; message: string; data: T }

async function unwrap<T>(p: Promise<{ data: Envelope<T> }>): Promise<T> {
  const res = await p
  return res.data.data
}

// ---- 服务端契约类型（与 apps/server/src/admin/*.controller.ts 对齐）----

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

export type CatalogEntryInput = {
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

export type AdminRouteRow = {
  id: string
  matchType: string
  pattern: string | null
  capability: string
  upstream: string
  priority: number
  enabled: boolean
  fallbackApiKeyEnvName: string | null
  createdAt: string
  updatedAt: string
}

export type AdminRouteInput = Partial<Pick<AdminRouteRow, 'matchType' | 'pattern' | 'capability' | 'upstream' | 'priority' | 'enabled' | 'fallbackApiKeyEnvName'>>

export type ProbeRunRow = {
  id: string
  ranAt: string
  upstream: string
  httpStatus: number | null
  modelCount: number
  ghosts: string[]
  missing: string[]
  error: string | null
  reason: string | null
}

export type ChannelModelEntry = { name: string; capability: string; pricing?: Record<string, number> } & Record<string, unknown>

export type PlatformChannelView = {
  id: string
  name: string
  apiFormat: string
  models: ChannelModelEntry[]
  parseError: boolean
}

export type AuditLogRow = {
  id: string
  actor: string
  action: string
  resource: string
  before: string | null
  after: string | null
  createdAt: string
}

export type AuditLogPage = { rows: AuditLogRow[]; total: number; page: number; pageSize: number }

export const adminApi = {
  /** token 验真：复用目录 GET（最轻的鉴权读端点）。 */
  verify: (): Promise<{ version: number; entries: AdminCatalogEntry[] }> =>
    unwrap(adminHttp.get('/admin/model-catalog')),

  listCatalog: (): Promise<{ version: number; entries: AdminCatalogEntry[] }> =>
    unwrap(adminHttp.get('/admin/model-catalog')),

  createCatalogEntry: (input: CatalogEntryInput) =>
    unwrap<{ version: number; entry: AdminCatalogEntry }>(adminHttp.post('/admin/model-catalog', input)),

  updateCatalogEntry: (id: string, input: Partial<CatalogEntryInput>) =>
    unwrap<{ version: number; entry: AdminCatalogEntry }>(adminHttp.put(`/admin/model-catalog/${id}`, input)),

  deleteCatalogEntry: (id: string) =>
    unwrap<{ version: number; id: string; modelKey: string }>(adminHttp.delete(`/admin/model-catalog/${id}`)),

  listRoutes: (): Promise<{ version: number; routes: AdminRouteRow[] }> =>
    unwrap(adminHttp.get('/admin/upstream-routes')),

  updateRoute: (id: string, input: AdminRouteInput) =>
    unwrap<{ version: number; route: AdminRouteRow }>(adminHttp.put(`/admin/upstream-routes/${id}`, input)),

  modelHealth: (windowHours?: 1 | 6 | 24 | 168) =>
    unwrap<{ generatedAt: string; rows: ModelHealthRow[]; alerts: HealthAlert[] }>(
      adminHttp.get('/admin/model-health', { params: windowHours === undefined ? {} : { windowHours } }),
    ),

  latestProbeRuns: (): Promise<{ runs: ProbeRunRow[] }> => unwrap(adminHttp.get('/admin/upstream-probe/latest')),

  platformChannel: (): Promise<PlatformChannelView> => unwrap(adminHttp.get('/admin/platform-channel')),

  setPlatformModelPricing: (name: string, pricing: Record<string, number> | null) =>
    unwrap<{ entry: ChannelModelEntry; previousPricing: Record<string, number> | null }>(
      adminHttp.put(`/admin/platform-channel/models/${encodeURIComponent(name)}/pricing`, { pricing }),
    ),

  listAuditLogs: (params?: { action?: string; resource?: string; page?: number; pageSize?: number }) =>
    unwrap<AuditLogPage>(adminHttp.get('/admin/audit-logs', { params: params ?? {} })),
}
```

```ts
// apps/web/src/stores/admin.ts
import { defineStore } from 'pinia'
import { ADMIN_TOKEN_KEY, setAdminUnauthorizedHandler } from '@/services/admin-api'

/**
 * Ops Console 会话态（spec §4.2）：token 唯一真源是 sessionStorage，
 * store 只是响应式镜像；401/403 由 admin-api 拦截器清真源并回调 clearToken。
 */
export const useAdminStore = defineStore('admin', {
  state: () => ({ token: sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? '' }),
  getters: {
    hasToken: (state) => state.token.length > 0,
  },
  actions: {
    init() {
      setAdminUnauthorizedHandler(() => this.clearToken())
    },
    setToken(token: string) {
      this.token = token
      sessionStorage.setItem(ADMIN_TOKEN_KEY, token)
    },
    clearToken() {
      this.token = ''
      sessionStorage.removeItem(ADMIN_TOKEN_KEY)
    },
  },
})
```

```vue
<!-- apps/web/src/pages/admin/AdminLayoutPage.vue -->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { adminApi } from '@/services/admin-api'
import { useAdminStore } from '@/stores/admin'

const admin = useAdminStore()
const route = useRoute()
const tokenInput = ref('')
const verifying = ref(false)
const error = ref('')

onMounted(() => admin.init())

async function submitToken() {
  const token = tokenInput.value.trim()
  if (!token) {
    error.value = '请输入 LNKPI_ADMIN_TOKEN'
    return
  }
  verifying.value = true
  error.value = ''
  admin.setToken(token)
  try {
    await adminApi.verify()
  } catch {
    admin.clearToken()
    error.value = 'token 校验失败（密钥不匹配或服务端未配置 LNKPI_ADMIN_TOKEN）'
  } finally {
    verifying.value = false
  }
}
</script>

<template>
  <div v-if="!admin.hasToken" class="admin-gate flex min-h-screen items-center justify-center bg-surface-canvas">
    <div class="w-80 rounded-lg border border-line-subtle bg-surface-base p-6 shadow-lnk-md">
      <h2 class="mb-3 text-base font-semibold text-fg">运营管理台 · 访问验证</h2>
      <el-input
        v-model="tokenInput"
        type="password"
        show-password
        placeholder="LNKPI_ADMIN_TOKEN"
        @keyup.enter="submitToken"
      />
      <el-button class="mt-3 w-full" type="primary" :loading="verifying" @click="submitToken">验证进入</el-button>
      <p v-if="error" class="mt-2 text-sm text-danger">{{ error }}</p>
    </div>
  </div>
  <el-container v-else class="admin-shell min-h-screen bg-surface-canvas">
    <el-aside width="168px" class="border-r border-line-subtle bg-surface-base">
      <el-menu :default-active="route.path" router>
        <el-menu-item index="/admin/models">模型目录</el-menu-item>
        <el-menu-item index="/admin/routes">上游路由</el-menu-item>
        <el-menu-item index="/admin/health">健康探活</el-menu-item>
        <el-menu-item index="/admin/pricing">渠道定价</el-menu-item>
        <el-menu-item index="/admin/audit">审计日志</el-menu-item>
      </el-menu>
    </el-aside>
    <el-main>
      <router-view />
    </el-main>
  </el-container>
</template>
```

Modify `apps/web/src/router/index.ts`：在 `routes` 数组（`/privacy` 之后）追加：

```ts
    {
      path: '/admin',
      component: () => import('@/pages/admin/AdminLayoutPage.vue'),
      children: [
        { path: '', redirect: '/admin/models' },
        { path: 'models', name: 'admin-models', component: () => import('@/pages/admin/AdminModelsPage.vue') },
        { path: 'routes', name: 'admin-routes', component: () => import('@/pages/admin/AdminRoutesPage.vue') },
        { path: 'health', name: 'admin-health', component: () => import('@/pages/admin/AdminHealthPage.vue') },
        { path: 'pricing', name: 'admin-pricing', component: () => import('@/pages/admin/AdminPricingPage.vue') },
        { path: 'audit', name: 'admin-audit', component: () => import('@/pages/admin/AdminAuditPage.vue') },
      ],
    },
```

注意：子页面文件在 Task 4–8 创建；本任务先创建 5 个占位 SFC（内容仅 `<template><div /></template>`），对应任务再替换为完整实现，保证每一步构建可过。

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console/apps/web && pnpm exec vitest run src/services/admin-api.test.ts src/pages/admin/AdminLayoutPage.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console && git add apps/web/src/services/admin-api.ts apps/web/src/services/admin-api.test.ts apps/web/src/stores/admin.ts apps/web/src/pages/admin/ apps/web/src/router/index.ts
git commit -m "feat(web): admin 会话基座——token 门 + admin-api + /admin 懒加载路由（Ops Console §4/§6）"
```

---

### Task 4: Web — AdminModelsPage（模型目录运营）

**Files:**
- Replace: `apps/web/src/pages/admin/AdminModelsPage.vue`（Task 3 占位）
- Test: `apps/web/src/pages/admin/AdminModelsPage.test.ts`

**Interfaces:**
- Consumes: `adminApi.listCatalog/createCatalogEntry/updateCatalogEntry/deleteCatalogEntry`、`AdminApiError`（Task 3 签名）。
- Produces: 无（叶子页）。

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/pages/admin/AdminModelsPage.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import AdminModelsPage from './AdminModelsPage.vue'

const { listCatalog, createCatalogEntry, deleteCatalogEntry } = vi.hoisted(() => ({
  listCatalog: vi.fn(),
  createCatalogEntry: vi.fn(),
  deleteCatalogEntry: vi.fn(),
}))

vi.mock('@/services/admin-api', () => ({
  adminApi: {
    listCatalog: (...a: unknown[]) => listCatalog(...a),
    createCatalogEntry: (...a: unknown[]) => createCatalogEntry(...a),
    updateCatalogEntry: vi.fn(),
    deleteCatalogEntry: (...a: unknown[]) => deleteCatalogEntry(...a),
  },
  AdminApiError: class extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  },
}))

const entry = (over: Record<string, unknown>) => ({
  id: 'id-1',
  modelKey: 'm-1',
  displayName: 'Model One',
  gatewayModelId: 'gw-1',
  modality: 'text',
  providerBinding: 'gateway-openai-compat',
  audioKind: null,
  voices: null,
  params: {},
  defaults: null,
  deletedAt: null,
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z',
  ...over,
})

function mountPage() {
  return mount(AdminModelsPage, { global: { plugins: [ElementPlus, setActivePinia(createPinia())] } })
}

describe('AdminModelsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('加载目录并渲染行；软删行带已下架标记', async () => {
    listCatalog.mockResolvedValue({
      version: 7,
      entries: [entry({}), entry({ id: 'id-2', modelKey: 'm-2', deletedAt: '2026-10-10T00:00:00.000Z' })],
    })
    const w = mountPage()
    await flushPromises()
    const text = w.text()
    expect(text).toContain('m-1')
    expect(text).toContain('m-2')
    expect(text).toContain('已下架')
    expect(text).toContain('7') // 版本号
  })

  it('删除需确认，确认后调用 deleteCatalogEntry 并刷新', async () => {
    listCatalog.mockResolvedValue({ version: 7, entries: [entry({})] })
    deleteCatalogEntry.mockResolvedValue({ version: 8, id: 'id-1', modelKey: 'm-1' })
    const confirmSpy = vi.spyOn(await import('element-plus'), 'ElMessageBox').mockImplementation(() => {
      throw Object.assign(new Error('confirm'), { __confirmed: true })
    })
    // 简化：直接驱动 removeEntry（组件把确认+执行封装在方法里，测试通过数据驱动验证调用）
    const w = mountPage()
    await flushPromises()
    confirmSpy.mockRestore()
    await (w.vm as unknown as { removeEntry: (id: string, modelKey: string) => Promise<void> }).removeEntry('id-1', 'm-1')
    await flushPromises()
    expect(deleteCatalogEntry).toHaveBeenCalledWith('id-1')
    expect(listCatalog).toHaveBeenCalledTimes(2)
  })

  it('删除失败（400/409 防呆）→ 展示服务端 message，不刷新', async () => {
    listCatalog.mockResolvedValue({ version: 7, entries: [entry({})] })
    const { AdminApiError } = await import('@/services/admin-api')
    deleteCatalogEntry.mockRejectedValue(new AdminApiError('m-1 是默认模型，禁止下架', 400))
    const w = mountPage()
    await flushPromises()
    await (w.vm as unknown as { removeEntry: (id: string, modelKey: string) => Promise<void> }).removeEntry('id-1', 'm-1')
    await flushPromises()
    expect((w.vm as unknown as { actionError: string }).actionError).toContain('禁止下架')
    expect(listCatalog).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console/apps/web && pnpm exec vitest run src/pages/admin/AdminModelsPage.test.ts
```
Expected: FAIL（占位组件无逻辑）

- [ ] **Step 3: Write implementation**

```vue
<!-- apps/web/src/pages/admin/AdminModelsPage.vue -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { adminApi, AdminApiError, type AdminCatalogEntry, type CatalogEntryInput } from '@/services/admin-api'

const loading = ref(false)
const version = ref(0)
const entries = ref<AdminCatalogEntry[]>([])
const keyword = ref('')
const actionError = ref('')

const VALID_MODALITIES = ['text', 'image', 'video', 'audio']
const VALID_BINDINGS = ['gateway-openai-compat', 'fal-http', 'minimax-http', 'zhipu-http']

const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return entries.value
  return entries.value.filter(
    (e) => e.modelKey.toLowerCase().includes(k) || e.displayName.toLowerCase().includes(k),
  )
})

async function reload() {
  loading.value = true
  try {
    const data = await adminApi.listCatalog()
    version.value = data.version
    entries.value = data.entries
  } catch (err) {
    actionError.value = err instanceof AdminApiError ? err.message : '加载失败'
  } finally {
    loading.value = false
  }
}

async function removeEntry(id: string, modelKey: string) {
  actionError.value = ''
  try {
    await ElMessageBox.confirm(`确认下架 ${modelKey}？（软删，可由 POST 同 modelKey 恢复）`, '下架确认', {
      type: 'warning',
      confirmButtonText: '下架',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await adminApi.deleteCatalogEntry(id)
    ElMessage.success('已下架')
    await reload()
  } catch (err) {
    // 400/409 防呆（默认模型等）原样透出，引导运营先处理
    actionError.value = err instanceof AdminApiError ? err.message : '操作失败'
  }
}

function openCreate() {
  void ElMessageBox.alert('新增条目请在下方表单填写（JSON 字段用编辑弹窗）', '提示')
}

onMounted(reload)

// 供模板与测试使用的最小编辑态（V1：新增/编辑弹窗共用）
const dialogVisible = ref(false)
const editing = ref<AdminCatalogEntry | null>(null)
const form = ref<CatalogEntryInput>({})

function startCreate() {
  editing.value = null
  form.value = { modelKey: '', displayName: '', gatewayModelId: '', modality: 'text', providerBinding: 'gateway-openai-compat', params: {} }
  dialogVisible.value = true
}

function startEdit(row: AdminCatalogEntry) {
  editing.value = row
  form.value = {
    displayName: row.displayName,
    gatewayModelId: row.gatewayModelId,
    modality: row.modality,
    providerBinding: row.providerBinding,
    params: row.params,
    defaults: row.defaults,
    audioKind: row.audioKind,
  }
  dialogVisible.value = true
}

async function submitForm() {
  actionError.value = ''
  try {
    if (editing.value) {
      await adminApi.updateCatalogEntry(editing.value.id, form.value)
      ElMessage.success('已保存')
    } else {
      await adminApi.createCatalogEntry(form.value)
      ElMessage.success('已新增（软删同 key 视为恢复上架）')
    }
    dialogVisible.value = false
    await reload()
  } catch (err) {
    actionError.value = err instanceof AdminApiError ? err.message : '保存失败'
  }
}
</script>

<template>
  <section class="p-2">
    <header class="mb-3 flex items-center gap-3">
      <h1 class="text-base font-semibold text-fg">模型目录</h1>
      <span class="text-sm text-fg-3">catalogVersion {{ version }}</span>
      <el-input v-model="keyword" placeholder="搜索 modelKey / 名称" class="w-56" clearable />
      <el-button type="primary" @click="startCreate">新增条目</el-button>
      <el-button :loading="loading" @click="reload">刷新</el-button>
    </header>
    <p v-if="actionError" class="mb-2 rounded border border-danger-border bg-danger-bg p-2 text-sm text-danger">{{ actionError }}</p>
    <el-table :data="filtered" v-loading="loading" size="small" border>
      <el-table-column prop="modelKey" label="modelKey" min-width="180" />
      <el-table-column prop="displayName" label="名称" min-width="140" />
      <el-table-column prop="modality" label="模态" width="80" />
      <el-table-column prop="providerBinding" label="绑定" min-width="160" />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <span v-if="row.deletedAt" class="text-warning">已下架</span>
          <span v-else class="text-success">在架</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="startEdit(row)">编辑</el-button>
          <el-button link type="danger" :disabled="row.deletedAt !== null" @click="removeEntry(row.id, row.modelKey)">下架</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="editing ? `编辑 ${editing.modelKey}` : '新增条目'" width="560px">
      <el-form label-width="120px">
        <el-form-item v-if="!editing" label="modelKey">
          <el-input v-model="form.modelKey" placeholder="稳定标识，创建后不可改" />
        </el-form-item>
        <el-form-item label="displayName"><el-input v-model="form.displayName" /></el-form-item>
        <el-form-item label="gatewayModelId"><el-input v-model="form.gatewayModelId" /></el-form-item>
        <el-form-item label="modality">
          <el-select v-model="form.modality">
            <el-option v-for="m in VALID_MODALITIES" :key="m" :value="m" :label="m" />
          </el-select>
        </el-form-item>
        <el-form-item label="providerBinding">
          <el-select v-model="form.providerBinding">
            <el-option v-for="b in VALID_BINDINGS" :key="b" :value="b" :label="b" />
          </el-select>
        </el-form-item>
        <el-form-item label="params (JSON)">
          <el-input v-model="form.paramsJson" type="textarea" :rows="3" placeholder='{"model":"native"}' />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitForm">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>
```

实现注意：`form.value.params` 与模板的 `form.paramsJson` 需要桥接——把 `paramsJson` 声明为独立 ref，`startCreate/startEdit` 时用 `JSON.stringify(params)` 填充，`submitForm` 里 `JSON.parse`（`try/catch` → `actionError.value = 'params 不是合法 JSON'` 并中止）。上面模板已引用 `form.paramsJson`，请按此桥接落码，`openCreate` 方法删除（`startCreate` 直接绑定按钮）。

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console/apps/web && pnpm exec vitest run src/pages/admin/AdminModelsPage.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console && git add apps/web/src/pages/admin/AdminModelsPage.vue apps/web/src/pages/admin/AdminModelsPage.test.ts
git commit -m "feat(web): AdminModelsPage——目录 CRUD + 防呆错误透出（Ops Console §6）"
```

---

### Task 5: Web — AdminRoutesPage（上游路由）

**Files:**
- Replace: `apps/web/src/pages/admin/AdminRoutesPage.vue`
- Test: `apps/web/src/pages/admin/AdminRoutesPage.test.ts`

**Interfaces:**
- Consumes: `adminApi.listRoutes/updateRoute`（Task 3）。
- Produces: 无。

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/pages/admin/AdminRoutesPage.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import AdminRoutesPage from './AdminRoutesPage.vue'

const { listRoutes, updateRoute } = vi.hoisted(() => ({
  listRoutes: vi.fn(),
  updateRoute: vi.fn(),
}))

vi.mock('@/services/admin-api', () => ({
  adminApi: {
    listRoutes: (...a: unknown[]) => listRoutes(...a),
    updateRoute: (...a: unknown[]) => updateRoute(...a),
  },
  AdminApiError: class extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  },
}))

const route = (over: Record<string, unknown>) => ({
  id: 'r-1',
  matchType: 'prefix',
  pattern: 'agnes-',
  capability: '*',
  upstream: 'agnes_hub',
  priority: 100,
  enabled: true,
  fallbackApiKeyEnvName: null,
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z',
  ...over,
})

function mountPage() {
  return mount(AdminRoutesPage, { global: { plugins: [ElementPlus, setActivePinia(createPinia())] } })
}

describe('AdminRoutesPage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('渲染路由行与 routesVersion', async () => {
    listRoutes.mockResolvedValue({ version: 3, routes: [route({})] })
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toContain('agnes-')
    expect(w.text()).toContain('agnes_hub')
    expect(w.text()).toContain('3')
  })

  it('切换启停 → PUT { enabled } → 成功后刷新', async () => {
    listRoutes.mockResolvedValue({ version: 3, routes: [route({})] })
    updateRoute.mockResolvedValue({ version: 4, route: route({ enabled: false }) })
    const w = mountPage()
    await flushPromises()
    await (w.vm as unknown as { toggleEnabled: (row: { id: string; enabled: boolean; matchType: string }) => Promise<void> }).toggleEnabled({
      id: 'r-1',
      enabled: true,
      matchType: 'prefix',
    })
    await flushPromises()
    expect(updateRoute).toHaveBeenCalledWith('r-1', { enabled: false })
    expect(listRoutes).toHaveBeenCalledTimes(2)
  })

  it('default 行禁止禁用（服务端 409）→ 透出 message', async () => {
    listRoutes.mockResolvedValue({ version: 3, routes: [route({ matchType: 'default', pattern: null })] })
    const { AdminApiError } = await import('@/services/admin-api')
    updateRoute.mockRejectedValue(new AdminApiError('default 行禁止禁用', 409))
    const w = mountPage()
    await flushPromises()
    await (w.vm as unknown as { toggleEnabled: (row: { id: string; enabled: boolean; matchType: string }) => Promise<void> }).toggleEnabled({
      id: 'r-1',
      enabled: true,
      matchType: 'default',
    })
    await flushPromises()
    expect((w.vm as unknown as { actionError: string }).actionError).toContain('default 行禁止禁用')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console/apps/web && pnpm exec vitest run src/pages/admin/AdminRoutesPage.test.ts
```
Expected: FAIL

- [ ] **Step 3: Write implementation**

```vue
<!-- apps/web/src/pages/admin/AdminRoutesPage.vue -->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { adminApi, AdminApiError, type AdminRouteRow } from '@/services/admin-api'

const loading = ref(false)
const version = ref(0)
const routes = ref<AdminRouteRow[]>([])
const actionError = ref('')

async function reload() {
  loading.value = true
  try {
    const data = await adminApi.listRoutes()
    version.value = data.version
    routes.value = data.routes
  } catch (err) {
    actionError.value = err instanceof AdminApiError ? err.message : '加载失败'
  } finally {
    loading.value = false
  }
}

async function toggleEnabled(row: AdminRouteRow) {
  actionError.value = ''
  try {
    await adminApi.updateRoute(row.id, { enabled: !row.enabled })
    ElMessage.success('已更新，路由缓存本进程即时生效（跨实例 5s TTL 兜底）')
    await reload()
  } catch (err) {
    actionError.value = err instanceof AdminApiError ? err.message : '操作失败'
    await reload() // 开关状态与服务端对齐
  }
}

onMounted(reload)
</script>

<template>
  <section class="p-2">
    <header class="mb-3 flex items-center gap-3">
      <h1 class="text-base font-semibold text-fg">上游路由表</h1>
      <span class="text-sm text-fg-3">routesVersion {{ version }}</span>
      <el-button :loading="loading" @click="reload">刷新</el-button>
    </header>
    <p v-if="actionError" class="mb-2 rounded border border-danger-border bg-danger-bg p-2 text-sm text-danger">{{ actionError }}</p>
    <el-table :data="routes" v-loading="loading" size="small" border>
      <el-table-column prop="priority" label="优先级" width="80" />
      <el-table-column prop="matchType" label="匹配" width="90" />
      <el-table-column prop="pattern" label="pattern" min-width="140" />
      <el-table-column prop="capability" label="能力" width="80" />
      <el-table-column prop="upstream" label="上游" width="120" />
      <el-table-column prop="fallbackApiKeyEnvName" label="fallbackKey" min-width="140" />
      <el-table-column label="启用" width="90">
        <template #default="{ row }">
          <el-switch :model-value="row.enabled" @change="toggleEnabled(row)" />
        </template>
      </el-table-column>
    </el-table>
  </section>
</template>
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console/apps/web && pnpm exec vitest run src/pages/admin/AdminRoutesPage.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console && git add apps/web/src/pages/admin/AdminRoutesPage.vue apps/web/src/pages/admin/AdminRoutesPage.test.ts
git commit -m "feat(web): AdminRoutesPage——路由行启停 + 版本展示（Ops Console §6）"
```

---

### Task 6: Web — AdminHealthPage（健康总览 + 探活结果）

**Files:**
- Replace: `apps/web/src/pages/admin/AdminHealthPage.vue`
- Test: `apps/web/src/pages/admin/AdminHealthPage.test.ts`

**Interfaces:**
- Consumes: `adminApi.modelHealth/latestProbeRuns`（Task 3）。
- Produces: 无。

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/pages/admin/AdminHealthPage.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import AdminHealthPage from './AdminHealthPage.vue'

const { modelHealth, latestProbeRuns } = vi.hoisted(() => ({
  modelHealth: vi.fn(),
  latestProbeRuns: vi.fn(),
}))

vi.mock('@/services/admin-api', () => ({
  adminApi: {
    modelHealth: (...a: unknown[]) => modelHealth(...a),
    latestProbeRuns: (...a: unknown[]) => latestProbeRuns(...a),
  },
  AdminApiError: class extends Error {},
}))

const healthRow = {
  model: 'm-1',
  channelId: 'platform',
  windowHours: 24,
  total: 10,
  completed: 9,
  failed: 1,
  fallbackPending: 0,
  refunded: 0,
  successRate: 0.9,
  errorCodeCounts: { upstream_500: 1 },
  balance402Count: 0,
}

function mountPage() {
  return mount(AdminHealthPage, { global: { plugins: [ElementPlus, setActivePinia(createPinia())] } })
}

describe('AdminHealthPage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('渲染健康行 + 告警 + 探活 run（ghosts/missing 计数）', async () => {
    modelHealth.mockResolvedValue({
      generatedAt: '2026-10-11T05:00:00.000Z',
      rows: [healthRow],
      alerts: [{ rule: 'degraded', model: 'm-1', channelId: 'platform', windowHours: 24, total: 10, successRate: 0.9 }],
    })
    latestProbeRuns.mockResolvedValue({
      runs: [
        { id: 'p1', ranAt: '2026-10-11T04:00:00.000Z', upstream: 'agnes_hub', httpStatus: 200, modelCount: 5, ghosts: ['g-1'], missing: [], error: null, reason: null },
      ],
    })
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toContain('m-1')
    expect(w.text()).toContain('90%')
    expect(w.text()).toContain('degraded')
    expect(w.text()).toContain('agnes_hub')
    expect(w.text()).toContain('ghost 1')
  })

  it('windowHours 切换 → 重新请求带参数', async () => {
    modelHealth.mockResolvedValue({ generatedAt: '', rows: [], alerts: [] })
    latestProbeRuns.mockResolvedValue({ runs: [] })
    const w = mountPage()
    await flushPromises()
    await (w.vm as unknown as { reload: () => Promise<void> }).reload()
    expect(modelHealth).toHaveBeenLastCalledWith(24)
  })

  it('无数据初态 → 空表不报错', async () => {
    modelHealth.mockResolvedValue({ generatedAt: '', rows: [], alerts: [] })
    latestProbeRuns.mockResolvedValue({ runs: [] })
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toContain('暂无数据')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console/apps/web && pnpm exec vitest run src/pages/admin/AdminHealthPage.test.ts
```
Expected: FAIL

- [ ] **Step 3: Write implementation**

```vue
<!-- apps/web/src/pages/admin/AdminHealthPage.vue -->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { HealthAlert, ModelHealthRow } from '@lnkpi/shared'
import { adminApi, AdminApiError, type ProbeRunRow } from '@/services/admin-api'

const WINDOW_OPTIONS = [1, 6, 24, 168] as const

const loading = ref(false)
const windowHours = ref<1 | 6 | 24 | 168>(24)
const generatedAt = ref('')
const rows = ref<ModelHealthRow[]>([])
const alerts = ref<HealthAlert[]>([])
const runs = ref<ProbeRunRow[]>([])
const error = ref('')

function successRateText(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`
}

async function reload() {
  loading.value = true
  error.value = ''
  try {
    const [health, probe] = await Promise.all([adminApi.modelHealth(windowHours.value), adminApi.latestProbeRuns()])
    generatedAt.value = health.generatedAt
    rows.value = health.rows
    alerts.value = health.alerts
    runs.value = probe.runs
  } catch (err) {
    error.value = err instanceof AdminApiError ? err.message : '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(reload)
</script>

<template>
  <section class="p-2">
    <header class="mb-3 flex items-center gap-3">
      <h1 class="text-base font-semibold text-fg">模型健康 / 探活</h1>
      <el-select v-model="windowHours" class="w-28" @change="reload">
        <el-option v-for="w in WINDOW_OPTIONS" :key="w" :value="w" :label="`${w}h`" />
      </el-select>
      <span class="text-sm text-fg-3">{{ generatedAt }}</span>
      <el-button :loading="loading" @click="reload">刷新</el-button>
    </header>
    <p v-if="error" class="mb-2 rounded border border-danger-border bg-danger-bg p-2 text-sm text-danger">{{ error }}</p>

    <div v-if="alerts.length > 0" class="mb-3 rounded border border-warning-border bg-warning-bg p-2">
      <p v-for="a in alerts" :key="`${a.rule}:${a.model}`" class="text-sm text-warning">
        [{{ a.rule }}] {{ a.model }} — 成功率 {{ successRateText(a.successRate) }}（窗口 {{ a.windowHours }}h，共 {{ a.total }} 次）
      </p>
    </div>

    <el-table :data="rows" v-loading="loading" size="small" border class="mb-4">
      <el-table-column prop="model" label="模型" min-width="160" />
      <el-table-column prop="channelId" label="渠道" width="100" />
      <el-table-column prop="total" label="总次数" width="80" />
      <el-table-column prop="completed" label="完成" width="80" />
      <el-table-column prop="failed" label="失败" width="80" />
      <el-table-column label="成功率" width="90">
        <template #default="{ row }">{{ successRateText(row.successRate) }}</template>
      </el-table-column>
      <el-table-column label="errorCode 分布" min-width="180">
        <template #default="{ row }">
          <span v-if="Object.keys(row.errorCodeCounts).length === 0" class="text-fg-3">—</span>
          <span v-for="(cnt, code) in row.errorCodeCounts" :key="code" class="mr-2 text-fg-2">{{ code }}×{{ cnt }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="balance402Count" label="402" width="70" />
    </el-table>

    <h2 class="mb-2 text-sm font-semibold text-fg-2">最近一次探活（各上游）</h2>
    <p v-if="runs.length === 0" class="text-sm text-fg-3">暂无数据（探活间隔默认 6h，部署初态正常）</p>
    <el-table v-else :data="runs" size="small" border>
      <el-table-column prop="upstream" label="上游" width="120" />
      <el-table-column prop="ranAt" label="时间" min-width="170" />
      <el-table-column prop="httpStatus" label="HTTP" width="80" />
      <el-table-column prop="modelCount" label="模型数" width="80" />
      <el-table-column label="对账" min-width="160">
        <template #default="{ row }">
          <span class="text-warning">ghost {{ row.ghosts.length }}</span>
          <span class="mx-2 text-fg-2">missing {{ row.missing.length }}</span>
        </template>
      </el-table-column>
      <el-table-column label="错误" min-width="140">
        <template #default="{ row }">
          <span v-if="row.error" class="text-danger">{{ row.error }}</span>
          <span v-else class="text-fg-3">—</span>
        </template>
      </el-table-column>
    </el-table>
  </section>
</template>
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console/apps/web && pnpm exec vitest run src/pages/admin/AdminHealthPage.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console && git add apps/web/src/pages/admin/AdminHealthPage.vue apps/web/src/pages/admin/AdminHealthPage.test.ts
git commit -m "feat(web): AdminHealthPage——健康总览 + 告警 + 探活 run 判读（Ops Console §6）"
```

---

### Task 7: Web — AdminPricingPage（平台渠道定价）

**Files:**
- Replace: `apps/web/src/pages/admin/AdminPricingPage.vue`
- Test: `apps/web/src/pages/admin/AdminPricingPage.test.ts`

**Interfaces:**
- Consumes: `adminApi.platformChannel/setPlatformModelPricing`（Task 3）。
- Produces: 无。

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/pages/admin/AdminPricingPage.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import AdminPricingPage from './AdminPricingPage.vue'

const { platformChannel, setPlatformModelPricing } = vi.hoisted(() => ({
  platformChannel: vi.fn(),
  setPlatformModelPricing: vi.fn(),
}))

vi.mock('@/services/admin-api', () => ({
  adminApi: {
    platformChannel: (...a: unknown[]) => platformChannel(...a),
    setPlatformModelPricing: (...a: unknown[]) => setPlatformModelPricing(...a),
  },
  AdminApiError: class extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  },
}))

const model = (over: Record<string, unknown>) => ({
  name: 'm-a',
  capability: 'text',
  ...over,
})

function mountPage() {
  return mount(AdminPricingPage, { global: { plugins: [ElementPlus, setActivePinia(createPinia())] } })
}

describe('AdminPricingPage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('渲染模型行 + 已配/未配计数；未配定价行显示醒目徽标', async () => {
    platformChannel.mockResolvedValue({
      id: 'platform',
      name: '平台渠道',
      apiFormat: 'openai',
      parseError: false,
      models: [model({ pricing: { inputPerM: 1, outputPerM: 2 } }), model({ name: 'm-b' })],
    })
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toContain('1/2 已配定价')
    expect(w.text()).toContain('未配定价')
  })

  it('set pricing：填四字段后提交 → PUT 对象，成功后刷新', async () => {
    platformChannel.mockResolvedValue({
      id: 'platform', name: '平台渠道', apiFormat: 'openai', parseError: false,
      models: [model({})],
    })
    setPlatformModelPricing.mockResolvedValue({ entry: model({ pricing: { inputPerM: 1 } }), previousPricing: null })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as {
      pricingForm: { inputPerM: string; outputPerM: string; cacheReadPerM: string; cacheWritePerM: string }
      openEditor: (name: string) => void
      submitPricing: () => Promise<void>
    }
    vm.openEditor('m-a')
    vm.pricingForm.inputPerM = '1'
    vm.pricingForm.outputPerM = '2.5'
    await vm.submitPricing()
    await flushPromises()
    expect(setPlatformModelPricing).toHaveBeenCalledWith('m-a', { inputPerM: 1, outputPerM: 2.5 })
    expect(platformChannel).toHaveBeenCalledTimes(2)
  })

  it('clear pricing → PUT null', async () => {
    platformChannel.mockResolvedValue({
      id: 'platform', name: '平台渠道', apiFormat: 'openai', parseError: false,
      models: [model({ pricing: { inputPerM: 1 } })],
    })
    setPlatformModelPricing.mockResolvedValue({ entry: model({}), previousPricing: { inputPerM: 1 } })
    const w = mountPage()
    await flushPromises()
    await (w.vm as unknown as { clearPricing: (name: string) => Promise<void> }).clearPricing('m-a')
    await flushPromises()
    expect(setPlatformModelPricing).toHaveBeenCalledWith('m-a', null)
  })

  it('parseError → 显示畸形警示并禁用编辑', async () => {
    platformChannel.mockResolvedValue({
      id: 'platform', name: '平台渠道', apiFormat: 'openai', parseError: true, models: [],
    })
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toContain('models JSON 畸形')
  })

  it('提交非法数字 → 前端拦截不发请求', async () => {
    platformChannel.mockResolvedValue({
      id: 'platform', name: '平台渠道', apiFormat: 'openai', parseError: false,
      models: [model({})],
    })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as {
      pricingForm: { inputPerM: string }
      openEditor: (name: string) => void
      submitPricing: () => Promise<void>
    }
    vm.openEditor('m-a')
    vm.pricingForm.inputPerM = '-1'
    await vm.submitPricing()
    expect(setPlatformModelPricing).not.toHaveBeenCalled()
    expect((w.vm as unknown as { actionError: string }).actionError).toContain('非负')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console/apps/web && pnpm exec vitest run src/pages/admin/AdminPricingPage.test.ts
```
Expected: FAIL

- [ ] **Step 3: Write implementation**

```vue
<!-- apps/web/src/pages/admin/AdminPricingPage.vue -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { adminApi, AdminApiError, type ChannelModelEntry } from '@/services/admin-api'

const loading = ref(false)
const channelName = ref('')
const parseError = ref(false)
const models = ref<ChannelModelEntry[]>([])
const actionError = ref('')

const PRICING_KEYS = ['inputPerM', 'outputPerM', 'cacheReadPerM', 'cacheWritePerM'] as const
type PricingKey = (typeof PRICING_KEYS)[number]

const configuredCount = computed(() => models.value.filter((m) => m.pricing !== undefined).length)

const editorVisible = ref(false)
const editingName = ref('')
const pricingForm = ref<Record<PricingKey, string>>({ inputPerM: '', outputPerM: '', cacheReadPerM: '', cacheWritePerM: '' })

async function reload() {
  loading.value = true
  actionError.value = ''
  try {
    const data = await adminApi.platformChannel()
    channelName.value = data.name
    parseError.value = data.parseError
    models.value = data.models
  } catch (err) {
    actionError.value = err instanceof AdminApiError ? err.message : '加载失败'
  } finally {
    loading.value = false
  }
}

function pricingText(m: ChannelModelEntry): string {
  if (m.pricing === undefined) return '未配定价'
  return PRICING_KEYS.filter((k) => m.pricing?.[k] !== undefined)
    .map((k) => `${k}=${m.pricing![k]}`)
    .join(' / ')
}

function openEditor(name: string) {
  const m = models.value.find((x) => x.name === name)
  editingName.value = name
  pricingForm.value = { inputPerM: '', outputPerM: '', cacheReadPerM: '', cacheWritePerM: '' }
  if (m?.pricing) {
    for (const k of PRICING_KEYS) {
      if (m.pricing[k] !== undefined) pricingForm.value[k] = String(m.pricing[k])
    }
  }
  editorVisible.value = true
}

/** 四字段文本 → 对象；非法输入返回 null 并设置 actionError。 */
function buildPricingPayload(): Record<string, number> | null {
  const out: Record<string, number> = {}
  for (const k of PRICING_KEYS) {
    const raw = pricingForm.value[k].trim()
    if (raw === '') continue
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) {
      actionError.value = `pricing.${k} 必须是非负有限数，收到: ${raw}`
      return null
    }
    out[k] = n
  }
  if (Object.keys(out).length === 0) {
    actionError.value = '至少填写一个费率字段（全部留空请用「清除」）'
    return null
  }
  return out
}

async function submitPricing() {
  actionError.value = ''
  const payload = buildPricingPayload()
  if (payload === null) return
  try {
    await adminApi.setPlatformModelPricing(editingName.value, payload)
    ElMessage.success('已保存，下一生成会话即生效')
    editorVisible.value = false
    await reload()
  } catch (err) {
    actionError.value = err instanceof AdminApiError ? err.message : '保存失败'
  }
}

async function clearPricing(name: string) {
  actionError.value = ''
  try {
    await ElMessageBox.confirm(`确认清除 ${name} 的定价？（清除后该模型不计费）`, '清除确认', {
      type: 'warning',
      confirmButtonText: '清除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await adminApi.setPlatformModelPricing(name, null)
    ElMessage.success('已清除')
    await reload()
  } catch (err) {
    actionError.value = err instanceof AdminApiError ? err.message : '操作失败'
  }
}

onMounted(reload)
</script>

<template>
  <section class="p-2">
    <header class="mb-3 flex items-center gap-3">
      <h1 class="text-base font-semibold text-fg">平台渠道定价</h1>
      <span class="text-sm text-fg-3">{{ channelName }}</span>
      <span class="text-sm text-fg-2">{{ configuredCount }}/{{ models.length }} 已配定价</span>
      <el-button :loading="loading" @click="reload">刷新</el-button>
    </header>
    <p v-if="parseError" class="mb-2 rounded border border-warning-border bg-warning-bg p-2 text-sm text-warning">
      平台渠道 models JSON 畸形（服务端拒绝写入）——请先检查渠道行
    </p>
    <p v-if="actionError" class="mb-2 rounded border border-danger-border bg-danger-bg p-2 text-sm text-danger">{{ actionError }}</p>
    <el-table :data="models" v-loading="loading" size="small" border>
      <el-table-column prop="name" label="模型" min-width="180" />
      <el-table-column prop="capability" label="能力" width="90" />
      <el-table-column label="定价（USD/百万 token）" min-width="240">
        <template #default="{ row }">
          <span v-if="row.pricing === undefined" class="rounded border border-warning-border bg-warning-bg px-1 text-warning">未配定价</span>
          <span v-else class="text-fg">{{ pricingText(row) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" :disabled="parseError" @click="openEditor(row.name)">编辑</el-button>
          <el-button link type="danger" :disabled="parseError || row.pricing === undefined" @click="clearPricing(row.name)">清除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="editorVisible" :title="`定价 · ${editingName}`" width="480px">
      <el-form label-width="140px">
        <el-form-item v-for="k in PRICING_KEYS" :key="k" :label="k">
          <el-input v-model="pricingForm[k]" placeholder="留空 = 不计费该维度" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editorVisible = false">取消</el-button>
        <el-button type="primary" @click="submitPricing">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console/apps/web && pnpm exec vitest run src/pages/admin/AdminPricingPage.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console && git add apps/web/src/pages/admin/AdminPricingPage.vue apps/web/src/pages/admin/AdminPricingPage.test.ts
git commit -m "feat(web): AdminPricingPage——平台渠道 pricing 配置 + 未配徽标（Ops Console §6）"
```

---

### Task 8: Web — AdminAuditPage（审计日志）

**Files:**
- Replace: `apps/web/src/pages/admin/AdminAuditPage.vue`
- Test: `apps/web/src/pages/admin/AdminAuditPage.test.ts`

**Interfaces:**
- Consumes: `adminApi.listAuditLogs`（Task 3；Task 1 契约）。
- Produces: 无。

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/pages/admin/AdminAuditPage.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import AdminAuditPage from './AdminAuditPage.vue'

const { listAuditLogs } = vi.hoisted(() => ({ listAuditLogs: vi.fn() }))

vi.mock('@/services/admin-api', () => ({
  adminApi: { listAuditLogs: (...a: unknown[]) => listAuditLogs(...a) },
  AdminApiError: class extends Error {},
}))

const row = (over: Record<string, unknown>) => ({
  id: 'a-1',
  actor: 'admin',
  action: 'platform-channel.pricing.set',
  resource: 'platform-channel:m-a',
  before: null,
  after: '{"inputPerM":1}',
  createdAt: '2026-10-11T05:00:00.000Z',
  ...over,
})

function mountPage() {
  return mount(AdminAuditPage, { global: { plugins: [ElementPlus, setActivePinia(createPinia())] } })
}

describe('AdminAuditPage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('加载首页并渲染行；before/after 可展开', async () => {
    listAuditLogs.mockResolvedValue({
      rows: [row({ before: '{"inputPerM":0}' })],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toContain('platform-channel.pricing.set')
    expect(w.text()).toContain('platform-channel:m-a')
    expect(listAuditLogs).toHaveBeenCalledWith({ page: 1, pageSize: 20 })
  })

  it('过滤 + 翻页 → 带参请求', async () => {
    listAuditLogs.mockResolvedValue({ rows: [], total: 0, page: 2, pageSize: 50 })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as { filters: { action: string; resource: string }; page: number; pageSize: number; reload: () => Promise<void> }
    vm.filters.action = 'model-catalog.create'
    vm.page = 2
    vm.pageSize = 50
    await vm.reload()
    expect(listAuditLogs).toHaveBeenLastCalledWith({ action: 'model-catalog.create', page: 2, pageSize: 50, resource: '' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console/apps/web && pnpm exec vitest run src/pages/admin/AdminAuditPage.test.ts
```
Expected: FAIL

- [ ] **Step 3: Write implementation**

```vue
<!-- apps/web/src/pages/admin/AdminAuditPage.vue -->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { adminApi, AdminApiError, type AuditLogRow } from '@/services/admin-api'

const loading = ref(false)
const rows = ref<AuditLogRow[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const filters = ref({ action: '', resource: '' })
const error = ref('')

async function reload() {
  loading.value = true
  error.value = ''
  try {
    const data = await adminApi.listAuditLogs({
      action: filters.value.action.trim() || undefined,
      resource: filters.value.resource.trim() || undefined,
      page: page.value,
      pageSize: pageSize.value,
    })
    rows.value = data.rows
    total.value = data.total
    page.value = data.page
    pageSize.value = data.pageSize
  } catch (err) {
    error.value = err instanceof AdminApiError ? err.message : '加载失败'
  } finally {
    loading.value = false
  }
}

function onPageChange(p: number) {
  page.value = p
  void reload()
}

onMounted(reload)
</script>

<template>
  <section class="p-2">
    <header class="mb-3 flex items-center gap-3">
      <h1 class="text-base font-semibold text-fg">审计日志</h1>
      <el-input v-model="filters.action" placeholder="action 精确匹配" class="w-56" clearable @keyup.enter="page = 1; reload()" />
      <el-input v-model="filters.resource" placeholder="resource 精确匹配" class="w-56" clearable @keyup.enter="page = 1; reload()" />
      <el-button type="primary" @click="page = 1; reload()">查询</el-button>
    </header>
    <p v-if="error" class="mb-2 rounded border border-danger-border bg-danger-bg p-2 text-sm text-danger">{{ error }}</p>
    <el-table :data="rows" v-loading="loading" size="small" border>
      <el-table-column type="expand">
        <template #default="{ row }">
          <div class="p-3 font-mono text-xs">
            <p class="text-fg-2">before：<pre class="whitespace-pre-wrap">{{ row.before ?? 'null' }}</pre></p>
            <p class="text-fg-2">after：<pre class="whitespace-pre-wrap">{{ row.after ?? 'null' }}</pre></p>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="createdAt" label="时间" min-width="170" />
      <el-table-column prop="action" label="action" min-width="200" />
      <el-table-column prop="resource" label="resource" min-width="200" />
      <el-table-column prop="actor" label="actor" width="90" />
    </el-table>
    <el-pagination
      class="mt-3 justify-end"
      layout="total, sizes, prev, pager, next"
      :total="total"
      :current-page="page"
      :page-size="pageSize"
      :page-sizes="[20, 50, 100]"
      @current-change="onPageChange"
      @size-change="(s: number) => { pageSize = s; page = 1; reload() }"
    />
  </section>
</template>
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console/apps/web && pnpm exec vitest run src/pages/admin/AdminAuditPage.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console && git add apps/web/src/pages/admin/AdminAuditPage.vue apps/web/src/pages/admin/AdminAuditPage.test.ts
git commit -m "feat(web): AdminAuditPage——审计检索 + before/after 展开（Ops Console §6）"
```

---

### Task 9: 守卫 + 全量回归 + 构建产物验证

**Files:**
- Modify: 无新改动（回归任务；若守卫/类型报错，修复归属任务文件后再跑本任务）

**Interfaces:**
- Consumes: Task 1–8 全部产出。
- Produces: 验收证据（spec §9）。

- [ ] **Step 1: 双端全量测试**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console/apps/server && pnpm exec vitest run src/admin/
cd /Users/4seven/workspace/pi-lnk-ops-console/apps/web && pnpm exec vitest run src/styles/design-token.test.ts src/styles/theme-usage.test.ts
cd /Users/4seven/workspace/pi-lnk-ops-console/apps/web && pnpm exec vitest run
```
Expected: 全绿（server admin 目录、web 全量含守卫）

- [ ] **Step 2: 类型检查 + 构建**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console/apps/web && pnpm exec vue-tsc -b && pnpm exec vite build 2>&1 | tail -40
cd /Users/4seven/workspace/pi-lnk-ops-console/apps/server && pnpm exec tsc --noEmit
```
Expected: 0 错；build 输出中 `AdminModelsPage/AdminRoutesPage/AdminHealthPage/AdminPricingPage/AdminAuditPage/AdminLayoutPage` 位于独立懒加载 chunk（非入口 chunk）。

- [ ] **Step 3: chunk 隔离取证**

检查 `apps/web/dist/assets/` 文件名列表：确认存在独立 admin chunk 文件，且 `index-*.js` 入口 chunk 中不含 `AdminTokenGate`/`admin-model-catalog` 等特征串：

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console/apps/web/dist/assets && ls | grep -i admin
grep -l "AdminModelsPage\|admin/platform-channel" index-*.js 2>/dev/null || echo "入口 chunk 不含 admin 代码 ✓"
```
Expected: ls 列出 admin 相关 chunk；grep 无命中（打印 ✓）。若入口 chunk 命中 admin 特征串 → 检查 router 懒加载 import 是否被静态引用破坏，修复后重跑。

- [ ] **Step 4: Commit（如有修复）+ 汇总**

```bash
cd /Users/4seven/workspace/pi-lnk-ops-console && git status --short
# 如有守卫/类型修复，按归属文件提交；无改动则跳过
```

---

## Self-Review 记录

1. **Spec 覆盖**：§5.1→Task 1；§5.2→Task 2；§4/§6 基座→Task 3；目录/路由/健康/定价/审计五页→Task 4–8；§8 测试策略→各任务测试 + Task 9；§9 验收 1–5/7→Task 9 步骤覆盖（验收 4 的 override.cost 对拍由 Task 2 的 model-cost 契约 + 定价页 PUT 覆盖数据面；运行时对拍留生产复测）。§9.6 chunk 隔离→Task 9 Step 3。
2. **占位符**：无 TBD/TODO；Task 4 的 paramsJson 桥接为显式实现说明（非占位）。
3. **类型一致性**：`adminApi.*` 签名在 Task 3「Produces」逐字定义，Task 4–8 消费处一致；`AdminApiError(message, status)` 构造签名各处一致；服务端信封字段名（`routes`/`entry`/`previousPricing`/`rows,total,page,pageSize`）均按已读控制器源码核实。
4. **Review Focus**：五项分别由 Task 2（1/2/3）、Task 3（4）、Task 9 Step 3（5）钉死。
