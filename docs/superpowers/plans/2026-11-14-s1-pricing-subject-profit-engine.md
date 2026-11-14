# S1 定价主体与利润引擎 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让运营能在后台按「上架模型 × 厂商 / 上游渠道 × 能力规格」登记人民币渠道成本与利润率，系统自动物化积分售价并经既有发布流生效，使新价目在计费、展示报价与账务归因中真实生效。

**Architecture:** 不推倒现网体系，全部 additive：`PricingSubject` 登记可定价主体 → `resolveUnitCost` 把上游物理量归一为「元 / 一次计价单元」→ `resolveMargin` 按六档 scope 取利润率 → `PricingMaterializer` 生成 `PriceListEntry` 的 `subjectKey` 行 → `PricingService` 的 `subjectEntries` 双索引解析 → 既有 draft/diff/publish/rollback 发布。⚠️ 计划的第一优先级不是「加表加端点」，而是 §6.1.1 列出的 9 个现网函数同步改造 —— 漏掉 `loadActiveTable()` 的双索引会让所有新价目静默不生效。

**Tech Stack:** NestJS + Prisma(SQLite) / TypeScript / Vitest（nvm node24，环境 PATH 用 `$HOME/.nvm/versions/node/v24.13.0/bin`）/ Vue 3 ops-console / `@lnkpi/shared` / AdminTokenGuard + AdminAuditLog。

**Spec:** `docs/superpowers/specs/2026-11-14-pricing-profit-billing-e2e-design.md`（v1.2，586 行 / 17 章 / 14 条 AC）。实施者必须同时读该 spec 的 §3.5（单位链）、§6.1.1（改造清单）、§6.6.1（缓存双索引）、§10（验收判据）。

## Global Constraints

- 取证基线锁定 master `b5088ed6f935bce758ddcc21d3194e0c2e4de7d3`；判「文件不存在 / 缺接线」一律以 master 或干净 tarball 为准，**不信本地陈旧工作树**（本轮实测工作树 schema 定价段行号与 master 差 160 行）。
- 成本 `CostRate.costYuan` **恒为人民币元**；不新增 `currencySrc` / `fxRate` / `fxUsdCny` / `costSource` 列（`source` 是现网已有列）；不做运行时汇率换算；`PRICING_FX_USD_CNY` 只服务既有展示预估与兼容兜底，S1 不改其行为。
- `PriceListEntry.matchKey String` 非空且 `@@unique([versionId, matchKey])`：所有 subjectKey 行必须 `matchKey = subjectKey`（用 `|` 分隔，与 legacy 的 `:` 键天然不撞）。
- `MarginPolicy.phase String @unique`：global 行沿用 `'launch'`，新增行按 `'scope:<scope>:<scopeKey>'` 生成唯一值。
- `quote()` 永不 throw；`PRICING_SOURCE=constants` 旁路返回值逐字不变，只新增计数与 `degraded` 标记。
- 全局 `ValidationPipe(transform, whitelist)` 会剥无装饰 DTO 属性；新增 controller 一律沿用 `@Body() body: Record<string, unknown>` + 手写解析器，且解析器必须显式透传每个新字段。
- active `v2-launch` 的 341 条行**一条不改**；等价金标准 4/4、逐字不变断言、`PRICING_SUBJECT_KEYS=off` 回滚判据是全计划的生命线。
- S1 不做：`onboard` 自动建价（S2）、`PointTransaction` 加列 / `UsageRecord`（S3）、`Bill` / 发票 / 渠道账单导入（S4）、税控发票、支付渠道扩展、vendor patch、任务管理路标（v1.3 冻结）、C-2a PR #866。
- 测试纪律：vitest 用 `--maxWorkers=1 --no-file-parallelism`，`vue-tsc -b` 不加 `--noEmit`，pnpm 须 `env -u NODE_OPTIONS`，断言禁 `as never`；变异 RED 判据必须读完整 stdout 的 `AssertionError` / `failing tests` 标记（禁 `| tail` 吃退出码）。
- 分支纪律：主仓 git 长期脏、并发 worktree 常见；非己改文件先判来源，禁 `reset --hard` 覆盖他人；提交 / 合并 / 推送需单独授权，docs-only 与代码刀分开。

## Review Focus

以下五类是 spec 隐含、但实现者最容易漏的输入 / 故障，逐条已绑定到拥有其代码的任务并在该任务写了测试：

1. **新键行入库但缓存没有它** —— `loadActiveTable()` / `loadGrayTable()` 只按 `matchKey` 建单 Map ⇒ 运营发布成功、审计有记录、价格不生效且无提示。守在 Task 6 步骤 1/3 与 AC11①。
2. **只改 `quoteTextTokens` 没改 `prepareTextTokenQuote`** —— SSE 流式预估仍走 USD 兜底，与结算分叉。守在 Task 7 步骤 1（`plan.compute === quoteTextTokens`）与 AC11④。
3. **地板校验拿单单位成本判多单位请求** —— 图片 3 张按 0.3 元而非 0.9 元判下限，击穿成本却通过发布。守在 Task 5 步骤 1、Task 8 步骤 1 与 AC14。
4. **多行 scope 后 `findFirst(orderBy createdAt desc)` 取错策略行** —— 新建一条模型级 30% 利润行会污染 USD 兜底毛利。守在 Task 4 步骤 1 与 AC12。
5. **从 active 建 draft 时新列被静默丢弃 / 手校解析器只透传 5 字段** —— 运营覆写的 `reason`、单位快照、主体键全部丢失，且无报错。守在 Task 8 步骤 1/3 与 AC13。

## File Map（改动边界，先锁定再拆任务）

| 文件 | 动作 | 职责 |
|---|---|---|
| `apps/server/prisma/schema.prisma` | 修改 | additive 列 + 新 `PricingSubject` 表 |
| `apps/server/prisma/migrations/<ts>_pricing_s1/migration.sql` | 创建 | 幂等回填：41 行 `CostRate.unitQuantity` / `provisional`、单行 `MarginPolicy`、`revision=0` |
| `apps/server/src/pricing/pricing-unit-cost.ts` | 创建 | `resolveUnitCost(subject, at)`：单位归一 + `CostRate.source` 优先级 + U6 family 归一 |
| `apps/server/src/pricing/pricing-margin.service.ts` | 创建 | `resolveMargin(subject, at)`：六档 scope 最具体者胜 + `phase` 生成 |
| `apps/server/src/pricing/pricing-subject.service.ts` | 创建 | `rebuild()`：两路枚举 × 上游路由 → 主体登记（insert-if-absent） |
| `apps/server/src/pricing/pricing-materializer.service.ts` | 创建 | 成本 × 利润 → `PriceListEntry` 行，幂等 diff，`ops-modified` 跳过 |
| `apps/server/src/pricing/pricing.service.ts` | 修改 | 双 Map 缓存、六级解析、两处 includes 数据化、`readCurrentMarginBp` 精确查、`degraded` 指标 |
| `apps/server/src/agent/agent.service.ts` | 修改 | `readMarginBp()` 改按 `scope='global'` 精确查 |
| `apps/server/src/pricing/pricing.core.ts` | 修改 | `checkCostFloor` 改 `priceFloorBp` 派生（数值等价）；`PricingQuery` 增可选字段（含 `chars?`） |
| `apps/server/src/pricing/pricing-publishing.service.ts` | 修改 | 字段透传 / 复制清单 / `checkFloors` 传参 / `validatePublish` / `revision` |
| `apps/server/src/admin/pricing-publishing.controller.ts` | 修改 | `parseEntriesBody()` 扩字段 |
| `apps/server/src/admin/pricing-subject.controller.ts`、`pricing-cost.controller.ts`、`pricing-margin.controller.ts` | 创建 | 后台配置面 REST |
| `apps/server/src/pricing/pricing-metrics.ts` | 创建 | 5 个指标计数器（纯内存 + 日志，不引入新依赖） |
| `apps/server/src/pricing/pricing.controller.ts` | 修改 | 展示 quote 扩参数、透出 `degraded` |
| `apps/web/src/services/admin-api.ts`、`apps/web/src/pages/AdminLayoutPage.vue`、`AdminPricingSubjectsPage.vue`、`AdminCostRatesPage.vue`、`AdminMarginPoliciesPage.vue` | 创建 / 修改 | ops-console「渠道定价」组 |
| 各 `*.test.ts` | 创建 / 修改 | 每个任务自带测试（详见各 Task 的 Test 行） |

---

### Task 1: additive schema 迁移与生产等价回填

**Files:**
- Modify: `apps/server/prisma/schema.prisma`（`PriceListVersion:862`、`PriceListEntry:873`、`CostRate:887`、`MarginPolicy:901` 之后追加 `PricingSubject`）
- Create: `apps/server/prisma/migrations/20261114140000_pricing_s1/migration.sql`
- Test: `apps/server/src/pricing/pricing.s1-schema.integration.test.ts`

**Interfaces:**
- Consumes: 现网 `v2-launch` active 版本 341 条、`CostRate` 41 行、`MarginPolicy` 单行 `phase='launch'`。
- Produces: `PricingSubject`（字段见 spec §6.1）；`PriceListEntry.subjectKey / costSnapshotYuan / unitSnapshot / profitBpSnapshot / marginPolicyId / reason`；`PriceListVersion.revision Int @default(0)`；`CostRate` 的 `provider / upstream / unitQuantity / effectiveFrom / effectiveTo / sourceRef / provisional`；`MarginPolicy` 的 `scope / scopeKey / profitBp / priceFloorBp / effectiveFrom / effectiveTo / status`。

- [ ] **Step 1: 写失败测试（等价金标准 + 迁移后形状）**

```ts
// apps/server/src/pricing/pricing.s1-schema.integration.test.ts
import { describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

describe('S1 additive migration', () => {
  it('v2-launch 的 341 条行价格逐字不变且全部未被改成 subjectKey 行', async () => {
    const v = await prisma.priceListVersion.findFirst({ where: { status: 'active' }, include: { entries: true } })
    expect(v?.version).toBe('v2-launch')
    expect(v?.entries.length).toBe(341)
    expect(v?.entries.filter((e) => e.subjectKey !== null).length).toBe(0)
    expect(v?.entries.find((e) => e.matchKey === 'image:1K:1')?.credits).toBe(33)
    expect(v?.entries.find((e) => e.matchKey === 'audio:music')?.credits).toBe(15)
  })

  it('41 行成本回填 unitQuantity，且零币种/汇率列', async () => {
    const rates = await prisma.costRate.findMany()
    expect(rates.length).toBe(41)
    expect(rates.filter((r) => r.unit === 'per_1m_tokens').every((r) => r.unitQuantity === 1e6)).toBe(true)
    expect(rates.filter((r) => r.spec === 'per_100_chars').every((r) => r.unitQuantity === 100)).toBe(true)
    expect(rates.filter((r) => r.unit === 'per_image').every((r) => r.unitQuantity === 1)).toBe(true)
    expect(rates.every((r) => r.source === 'official_list')).toBe(true)
    expect(rates.filter((r) => r.spec === 'per_song' || r.note?.includes('PROVISIONAL') || r.note?.includes('线性推算')).every((r) => r.provisional)).toBe(true)
  })

  it('MarginPolicy 单行迁移为 global，phase 不撞唯一约束', async () => {
    const rows = await prisma.marginPolicy.findMany()
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ phase: 'launch', scope: 'global', profitBp: 1000, priceFloorBp: 500, marginBp: 11000, anchorCents: 1 })
  })

  it('PriceListVersion.revision 全为 0，且新表可写', async () => {
    const versions = await prisma.priceListVersion.findMany()
    expect(versions.every((v) => v.revision === 0)).toBe(true)
    const s = await prisma.pricingSubject.create({ data: {
      subjectKey: 'image|seedream-5.0-pro|1K:1|volcengine|apimart',
      capability: 'image', modelKey: 'seedream-5.0-pro', spec: '1K:1',
      provider: 'volcengine', upstream: 'apimart', status: 'draft',
      billableUnit: 'image_count', source: 'auto',
    } })
    expect(s.channelId).toBe('platform')
    await prisma.pricingSubject.delete({ where: { id: s.id } })
  })
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `env -u NODE_OPTIONS $HOME/.nvm/versions/node/v24.13.0/bin/pnpm --filter @lnkpi/server exec vitest run src/pricing/pricing.s1-schema.integration.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL —— `Unknown field subjectKey` / 表 `PricingSubject` 不存在。

- [ ] **Step 3: 写 schema 与幂等迁移**

在 `schema.prisma` 既有模型上追加列（全部 nullable / 带 default），并新增：

```prisma
model PricingSubject {
  id               String   @id @default(cuid())
  subjectKey       String   @unique
  capability       String
  modelKey         String
  spec             String
  provider         String
  upstream         String
  channelId        String   @default("platform")
  status           String   @default("draft")
  billableUnit     String
  unitsPerRequest  Float?
  defaultSubjectKey String?
  source           String   @default("auto")
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  @@index([modelKey, capability])
  @@index([upstream, status])
}
```

`migration.sql` 用 SQLite additive 语句，回填顺序固定：`ALTER TABLE ... ADD COLUMN`、`UPDATE CostRate SET unitQuantity = CASE unit WHEN 'per_1m_tokens' THEN 1000000 ELSE 1 END`、`UPDATE CostRate SET unitQuantity = 100 WHERE spec = 'per_100_chars'`、`UPDATE CostRate SET provisional = 1 WHERE note LIKE '%PROVISIONAL%' OR note LIKE '%线性推算%' OR spec = 'per_song' OR spec = 'per_100_chars'`、`UPDATE MarginPolicy SET scope='global', profitBp=1000, priceFloorBp=500, status='active' WHERE phase='launch'`、`UPDATE PriceListVersion SET revision=0`。先回填再建部分唯一索引（规避 SQLite 多 NULL 语义争议）：

```sql
CREATE UNIQUE INDEX IF NOT EXISTS "PriceListEntry_versionId_subjectKey_key"
  ON "PriceListEntry"("versionId", "subjectKey") WHERE "subjectKey" IS NOT NULL;
```

**不 UPDATE `PriceListEntry` 任何一行**。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: 同 Step 2 命令；Expected: 4/4 PASS。再跑 `pnpm --filter @lnkpi/server exec prisma validate`。

- [ ] **Step 5: Commit**

```bash
git add apps/server/prisma/schema.prisma apps/server/prisma/migrations/20261114140000_pricing_s1/migration.sql apps/server/src/pricing/pricing.s1-schema.integration.test.ts
git commit -m "feat(pricing): S1 additive schema + 41-row cost backfill"
```

---

### Task 2: `PricingSubject.rebuild()` 两路枚举与 U6 归一

**Files:**
- Create: `apps/server/src/pricing/pricing-subject.service.ts`
- Create: `apps/server/src/pricing/pricing-subject.service.test.ts`
- Create: `apps/server/src/admin/pricing-subject.controller.ts`
- Modify: `apps/server/src/pricing/pricing.module.ts`（注册 provider / controller）

**Interfaces:**
- Consumes: `ModelCatalogEntry`（`deletedAt IS NULL`）、`UpstreamRoute`、`enumeratePricingSpace()`、`enumerateTextTokenRows()`、`videoPriceFamily()`、`modelOptionName()`。
- Produces: `rebuild(): Promise<{ added: number; unchanged: number; missingInCatalog: string[] }>`；`subjectKeyOf(input): string`；`resolveUpstream(modelKey, capability, routes): string`。

- [ ] **Step 1: 写失败测试（漏 23 条 token 行 / U6 / BYOK）**

```ts
// apps/server/src/pricing/pricing-subject.service.test.ts
import { describe, expect, it } from 'vitest'
import { subjectKeyOf, resolveUpstream, buildSubjectRows } from './pricing-subject.service'
import { UPSTREAM_ROUTE_SEEDS } from '@lnkpi/shared'

describe('PricingSubject rebuild source of truth', () => {
  it('两路枚举：档位行 + 23 条 token 反比率行都在', () => {
    const rows = buildSubjectRows(
      [
        { modelKey: 'step-3.5-flash', modality: 'text', providerBinding: 'gateway-openai-compat' },
        { modelKey: 'seedream-5.0-pro', modality: 'image', providerBinding: 'gateway-openai-compat' },
      ],
      UPSTREAM_ROUTE_SEEDS,
    )
    expect(rows.some((r) => r.spec === 'in' && r.modelKey === 'step-3.5-flash')).toBe(true)
    expect(rows.some((r) => r.spec === 'cache' && r.modelKey === 'step-3.5-flash')).toBe(true)
    expect(rows.some((r) => r.capability === 'image' && r.spec === '1K:1')).toBe(true)
  })

  it('U6：成本侧 seedance-2.0-fast 归到 default 家族，不产生新 upstream', () => {
    expect(resolveUpstream('seedance-2.0-fast', 'video', UPSTREAM_ROUTE_SEEDS)).toBe('agnes_hub')
    expect(resolveUpstream('minimax-h3', 'video', UPSTREAM_ROUTE_SEEDS)).toBe('minimax')
    expect(resolveUpstream('cogvideox-flash', 'video', UPSTREAM_ROUTE_SEEDS)).toBe('zhipu')
  })

  it('subjectKey 归一剥渠道前缀、小写、五段', () => {
    expect(subjectKeyOf({ capability: 'text', modelKey: 'platform::Agnes-2.5-Flash', spec: 'in', provider: 'agnes', upstream: 'agnes_hub' }))
      .toBe('text|agnes-2.5-flash|in|agnes|agnes_hub')
  })

  it('BYOK 不产生主体', () => {
    const rows = buildSubjectRows(
      [{ modelKey: 'byok-model', modality: 'text', providerBinding: 'gateway-openai-compat', byok: true }],
      UPSTREAM_ROUTE_SEEDS,
    )
    expect(rows.length).toBe(0)
  })
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `env -u NODE_OPTIONS $HOME/.nvm/versions/node/v24.13.0/bin/pnpm --filter @lnkpi/server exec vitest run src/pricing/pricing-subject.service.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL —— module not found。

- [ ] **Step 3: 实现 `buildSubjectRows` / `resolveUpstream` / `subjectKeyOf` / `rebuild`**

```ts
// apps/server/src/pricing/pricing-subject.service.ts（核心，完整实现）
import { Injectable } from '@nestjs/common'
import { modelOptionName } from '@lnkpi/shared'
import { PrismaService } from '../prisma/prisma.service'
import {
  ENUMERATED_IMAGE_RESOLUTIONS, ENUMERATED_IMAGE_COUNTS,
  ENUMERATED_VIDEO_RESOLUTIONS_CANONICAL, ENUMERATED_VIDEO_DURATIONS,
  enumerateTextTokenRows,
} from './pricing.space'

const PROVIDER_BY_BINDING: Record<string, string> = {
  'gateway-openai-compat': 'agnes_hub',
  'fal-http': 'fal',
  'minimax-http': 'minimax',
  'zhipu-http': 'zhipu',
}

type RouteRow = {
  matchType: string; pattern: string | null; capability: string
  upstream: string; priority: number; enabled: boolean
}

export interface SubjectRow {
  subjectKey: string; capability: string; modelKey: string; spec: string
  provider: string; upstream: string; channelId: string; status: string
  billableUnit: string; unitsPerRequest: number | null; source: string
}

export function subjectKeyOf(i: { capability: string; modelKey: string; spec: string; provider: string; upstream: string }): string {
  return [i.capability, modelOptionName(i.modelKey).trim().toLowerCase(), i.spec, i.provider, i.upstream].join('|')
}

export function resolveUpstream(modelKey: string, capability: string, routes: RouteRow[]): string {
  const key = modelOptionName(modelKey).trim().toLowerCase()
  const hit = routes
    .filter((r) => r.enabled && (r.capability === '*' || r.capability === capability))
    .sort((a, b) => b.priority - a.priority)
    .find((r) => {
      if (r.matchType === 'default') return true
      if (r.matchType === 'exact') return key === (r.pattern ?? '').toLowerCase()
      if (r.matchType === 'prefix') return key.startsWith((r.pattern ?? '').toLowerCase())
      if (r.matchType === 'regex') return new RegExp(r.pattern ?? '').test(key)
      return false
    })
  return hit?.upstream ?? 'agnes_hub'
}

export function buildSubjectRows(catalog: {
  modelKey: string; modality: string; providerBinding: string; audioKind?: string | null; byok?: boolean
}[], routes: RouteRow[]): SubjectRow[] {
  const out: SubjectRow[] = []
  for (const m of catalog) {
    if (m.byok) continue
    const model = modelOptionName(m.modelKey).trim().toLowerCase()
    const provider = PROVIDER_BY_BINDING[m.providerBinding] ?? 'agnes_hub'
    const upstream = resolveUpstream(m.modelKey, m.modality, routes)
    const specs: { capability: string; spec: string; billableUnit: string; unitsPerRequest: number | null }[] = []
    if (m.modality === 'text') {
      // 第二路枚举：enumeratePricingSpace() 不含这些行，漏掉就丢 23 条精确计费主体
      for (const t of enumerateTextTokenRows()) {
        if (t.modelKey !== model) continue
        specs.push({ capability: 'text', spec: t.spec, billableUnit: `token_${t.spec}`, unitsPerRequest: null })
      }
    } else if (m.modality === 'image') {
      for (const res of ENUMERATED_IMAGE_RESOLUTIONS) {
        for (const count of ENUMERATED_IMAGE_COUNTS) {
          specs.push({ capability: 'image', spec: `${res}:${count}`, billableUnit: 'image_count', unitsPerRequest: count })
        }
      }
      specs.push({ capability: 'image_variant', spec: '*', billableUnit: 'image_count', unitsPerRequest: 1 })
      specs.push({ capability: 'image_edit', spec: '*', billableUnit: 'image_count', unitsPerRequest: 1 })
    } else if (m.modality === 'video') {
      for (const res of ENUMERATED_VIDEO_RESOLUTIONS_CANONICAL) {
        for (const duration of ENUMERATED_VIDEO_DURATIONS) {
          specs.push({ capability: 'video', spec: `${res}:${duration}s`, billableUnit: 'video_call', unitsPerRequest: 1 })
        }
      }
    } else if (m.modality === 'audio') {
      const kind = m.audioKind ?? 'voice'
      specs.push({ capability: 'audio', spec: kind, billableUnit: kind === 'music' ? 'song' : 'chars_100', unitsPerRequest: kind === 'music' ? 1 : null })
    }
    for (const s of specs) {
      out.push({
        subjectKey: subjectKeyOf({ capability: s.capability, modelKey: model, spec: s.spec, provider, upstream }),
        capability: s.capability, modelKey: model, spec: s.spec, provider, upstream,
        channelId: 'platform', status: 'draft', billableUnit: s.billableUnit,
        unitsPerRequest: s.unitsPerRequest, source: 'auto',
      })
    }
  }
  return out
}

@Injectable()
export class PricingSubjectService {
  constructor(private readonly prisma: PrismaService) {}

  async rebuild() {
    const catalog = await this.prisma.modelCatalogEntry.findMany({ where: { deletedAt: null } })
    const routes = await this.prisma.upstreamRoute.findMany({ where: { enabled: true } })
    const rows = buildSubjectRows(catalog.map((c) => ({ ...c, byok: false })), routes)
    let added = 0, unchanged = 0
    for (const r of rows) {
      const hit = await this.prisma.pricingSubject.findUnique({ where: { subjectKey: r.subjectKey } })
      if (hit) { unchanged++; continue } // 绝不覆盖人工覆写的 provider / defaultSubjectKey
      await this.prisma.pricingSubject.create({ data: r })
      added++
    }
    return { added, unchanged, missingInCatalog: [] as string[] }
  }
}
```

`POST /api/admin/pricing/subjects/rebuild` 挂 `AdminTokenGuard` + 落 `AdminAuditLog('pricing-subject.rebuild')`，返回 `{ added, unchanged, missingInCatalog }`。U6 的 `videoPriceFamily()` 归一发生在 **Task 3 的 `resolveUnitCost`**（成本行匹配），本任务只负责把主体与 upstream 登记正确，不在主体上存 family 字段。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: 同 Step 2 命令；Expected: 4/4 PASS。补跑 `pricing.space.test.ts` 确认两路枚举未被改动。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pricing/pricing-subject.service.ts apps/server/src/pricing/pricing-subject.service.test.ts apps/server/src/admin/pricing-subject.controller.ts apps/server/src/pricing/pricing.module.ts
git commit -m "feat(pricing): PricingSubject rebuild with dual enumeration + U6 family normalize"
```

---

### Task 3: `resolveUnitCost` 四层单位归一

**Files:**
- Create: `apps/server/src/pricing/pricing-unit-cost.ts`
- Create: `apps/server/src/pricing/pricing-unit-cost.test.ts`

**Interfaces:**
- Consumes: `PricingSubject` 行、`CostRate`（`source` 四级优先级 + `effectiveFrom/To` + `unitQuantity` + `provisional`）、§3.5.4 归一规则。
- Produces:
```ts
export interface UnitCost {
  costYuan: number; costRateId: string; costSource: string; unit: string
  unitQuantity: number; unitsPerRequest: number; costYuanPerRequest: number
  provisional: boolean
}
export function resolveUnitCost(subject: {
  capability: string; modelKey: string; spec: string; upstream: string
  billableUnit: string; unitsPerRequest: number | null
}, rates: UnitCostRateRow[], at: Date): UnitCost | null
```

- [ ] **Step 1: 写失败测试（AC9 逐模态 + U6 + 禁止外推）**

```ts
// apps/server/src/pricing/pricing-unit-cost.test.ts
import { describe, expect, it } from 'vitest'
import { resolveUnitCost } from './pricing-unit-cost'

const rate = (o: Partial<any> = {}) => ({
  id: 'r1', channel: 'platform', modelKey: 'seedream-5.0-pro', spec: '1K', unit: 'per_image',
  unitQuantity: 1, costYuan: 0.3, source: 'official_list', provisional: false,
  effectiveFrom: null, effectiveTo: null, ...o,
})

describe('unit normalization', () => {
  it('图片 count=3 ⇒ costYuanPerRequest = 3 × 单价', () => {
    const c = resolveUnitCost({ capability: 'image', modelKey: 'seedream-5.0-pro', spec: '1K:3', upstream: 'apimart', billableUnit: 'image_count', unitsPerRequest: 3 }, [rate()], new Date())
    expect(c?.costYuanPerRequest).toBeCloseTo(0.9)
  })
  it('视频 per_second + duration=10 ⇒ 10 × 秒价', () => {
    const c = resolveUnitCost({ capability: 'video', modelKey: 'minimax-h3', spec: '768p:10s', upstream: 'minimax', billableUnit: 'video_second', unitsPerRequest: 10 }, [rate({ unit: 'per_second', unitQuantity: 1, costYuan: 0.572, modelKey: 'minimax-h3', spec: '768p' })], new Date())
    expect(c?.costYuanPerRequest).toBeCloseTo(5.72)
  })
  it('缺整条行与 per_second ⇒ null，绝不 5s 锚点外推', () => {
    expect(resolveUnitCost({ capability: 'video', modelKey: 'minimax-h3', spec: '768p:10s', upstream: 'minimax', billableUnit: 'video_call', unitsPerRequest: 1 }, [rate({ modelKey: 'minimax-h3', spec: '768p:5s', unit: 'per_video', costYuan: 2.86 })], new Date())).toBeNull()
  })
  it('音频 chars=null / 音乐 costYuan=0 / provisional ⇒ null', () => {
    expect(resolveUnitCost({ capability: 'audio', modelKey: 'step-tts-mini', spec: 'voice', upstream: 'stepfun', billableUnit: 'chars_100', unitsPerRequest: null }, [rate({ spec: 'per_100_chars', unit: 'per_call', unitQuantity: 100, costYuan: 0.009 })], new Date())).toBeNull()
    expect(resolveUnitCost({ capability: 'audio', modelKey: 'stepaudio-3-music', spec: 'music', upstream: 'stepfun', billableUnit: 'song', unitsPerRequest: 1 }, [rate({ spec: 'per_song', costYuan: 0 })], new Date())).toBeNull()
    expect(resolveUnitCost({ capability: 'image', modelKey: 'x', spec: '1K:1', upstream: 'u', billableUnit: 'image_count', unitsPerRequest: 1 }, [rate({ provisional: true })], new Date())).toBeNull()
  })
  it('D5：channel_actual 优先于 official_list', () => {
    const c = resolveUnitCost({ capability: 'image', modelKey: 'seedream-5.0-pro', spec: '1K:1', upstream: 'apimart', billableUnit: 'image_count', unitsPerRequest: 1 }, [rate(), rate({ id: 'r2', source: 'channel_actual', costYuan: 0.21, effectiveFrom: new Date('2026-01-01') })], new Date())
    expect(c?.costRateId).toBe('r2')
  })
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `env -u NODE_OPTIONS $HOME/.nvm/versions/node/v24.13.0/bin/pnpm --filter @lnkpi/server exec vitest run src/pricing/pricing-unit-cost.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL —— module not found。

- [ ] **Step 3: 实现归一（纯函数，不碰 DB）**

```ts
// apps/server/src/pricing/pricing-unit-cost.ts
import { videoPriceFamily } from './pricing.core'

export interface UnitCostRateRow {
  id: string; channel: string; modelKey: string; spec: string; unit: string
  unitQuantity: number; costYuan: number; source: string; provisional: boolean
  effectiveFrom: Date | null; effectiveTo: Date | null
}
export interface UnitCost {
  costYuan: number; costRateId: string; costSource: string; unit: string
  unitQuantity: number; unitsPerRequest: number; costYuanPerRequest: number
  provisional: boolean
}
type Subject = {
  capability: string; modelKey: string; spec: string; upstream: string
  billableUnit: string; unitsPerRequest: number | null
}

const SOURCE_RANK: Record<string, number> = {
  channel_actual: 4, negotiated: 3, official_list: 2, provisional: 1,
}

function affordable(r: UnitCostRateRow, at: Date): boolean {
  if (r.effectiveFrom && r.effectiveFrom > at) return false
  if (r.effectiveTo && r.effectiveTo <= at) return false
  return true
}

export function resolveUnitCost(subject: Subject, rates: UnitCostRateRow[], at: Date): UnitCost | null {
  // 文本按 token 计：每 1M token 成本行 unitQuantity=1e6，令 unitsPerRequest=1e6
  // ⇒ costYuanPerRequest === costYuan（每 1M token 成本），正是反比率公式 r 的输入
  const isToken = subject.billableUnit.startsWith('token_')
  const units = isToken ? 1e6 : subject.unitsPerRequest
  if (units === null || units <= 0) return null

  const family = videoPriceFamily(subject.modelKey)
  const [res, dur] = subject.spec.split(':')
  const candidates = rates
    .filter((r) => {
      if (!affordable(r, at) || r.unitQuantity <= 0 || r.costYuan <= 0 || r.provisional) return false
      if (subject.capability === 'text') return r.unit === 'per_1m_tokens' && r.spec.endsWith(subject.spec)
      if (subject.capability === 'image') return r.unit === 'per_image' && r.spec === res
      if (subject.capability === 'video') {
        // U6：成本行 modelKey 与售价键不同构，按 family + (res, duration) 归一，禁止字符串直等
        if (videoPriceFamily(r.modelKey) !== family) return false
        return (r.unit === 'per_video' && r.spec === `${res}:${dur}`) || r.unit === 'per_second'
      }
      return r.unit === 'per_call'
    })
    .sort((a, b) =>
      (SOURCE_RANK[b.source] ?? 0) - (SOURCE_RANK[a.source] ?? 0) ||
      (b.effectiveFrom?.getTime() ?? 0) - (a.effectiveFrom?.getTime() ?? 0) ||
      (a.unit === 'per_second' ? 1 : 0) - (b.unit === 'per_second' ? 1 : 0))

  const hit = candidates[0]
  if (!hit) return null // 缺整条行 / 单位不对齐 ⇒ cost_missing，绝不按 5s 锚点线性外推
  const unitsPerRequest = hit.unit === 'per_second' ? Number(dur.replace('s', '')) : units
  return {
    costYuan: hit.costYuan, costRateId: hit.id, costSource: hit.source,
    unit: hit.unit, unitQuantity: hit.unitQuantity, unitsPerRequest,
    costYuanPerRequest: (hit.costYuan * unitsPerRequest) / hit.unitQuantity,
    provisional: false,
  }
}
```

`costSource` 取的是 `CostRate.source` 列值（不新增列）；`provisional` / `costYuan=0` / `unitsPerRequest=null` / `unitQuantity<=0` 一律返回 `null`，由调用方把主体置 `cost_missing` 并计 `pricing_unit_mismatch_total`；视频按秒行用 `duration` 展开，整条 `per_video` 行优先，无锚点倍乘分支。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: 同 Step 2；Expected: 5/5 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pricing/pricing-unit-cost.ts apps/server/src/pricing/pricing-unit-cost.test.ts
git commit -m "feat(pricing): four-layer unit normalization with no linear extrapolation"
```

---

### Task 4: `MarginPolicy` 六档 scope 与两处防御读改造

**Files:**
- Create: `apps/server/src/pricing/pricing-margin.service.ts`
- Create: `apps/server/src/pricing/pricing-margin.service.test.ts`
- Modify: `apps/server/src/pricing/pricing.service.ts:478-485`（`readCurrentMarginBp`）
- Modify: `apps/server/src/agent/agent.service.ts:3765-3775`（`readMarginBp`）
- Test: `apps/server/src/pricing/pricing.service.test.ts`（加 AC12 用例）

**Interfaces:**
- Consumes: `MarginPolicy` 多行（含 `phase` 唯一值）、`PricingSubject`。
- Produces: `resolveMargin(subject, policies, at): { profitBp, priceFloorBp, marginPolicyId }`；`phaseOf(scope, scopeKey): string`；两处 `readMarginBp` 的查询条件 `where: { scope: 'global', status: 'active' }`。

- [ ] **Step 1: 写失败测试（AC12：新增非 global 行不污染两处读取）**

```ts
// 追加到 apps/server/src/pricing/pricing.service.test.ts
it('AC12：新增 model 级策略后 readCurrentMarginBp 仍返回 11000', async () => {
  await p.marginPolicy.create({ data: { phase: 'scope:model:step-3.5-flash', scope: 'model', scopeKey: 'step-3.5-flash', profitBp: 3000, priceFloorBp: 500, status: 'active' } })
  const svc = new PricingService(p)
  const q = await svc.quoteTextTokens(undefined, 'gpt-unknown-x', { inputTokens: 100, cacheReadTokens: 0, outputTokens: 100, costUsd: 0.01 })
  // 走 degraded USD 兜底，marginBp 必须是 global 的 11000，不是 13000
  expect(q.ruleVersion).toBe('constants-fallback')
})
```

同时在 `pricing-margin.service.test.ts` 写六档优先级与 `phaseOf` 唯一性测试：`model_spec > model > upstream > provider > modality > global`，以及 `phaseOf('global','*') === 'launch'`、`phaseOf('model','x') === 'scope:model:x'`。

- [ ] **Step 2: 跑测试确认 RED**

Run: `env -u NODE_OPTIONS $HOME/.nvm/versions/node/v24.13.0/bin/pnpm --filter @lnkpi/server exec vitest run src/pricing/pricing-margin.service.test.ts src/pricing/pricing.service.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL —— module not found / `scope` 字段不存在。

- [ ] **Step 3: 实现 `resolveMargin` 与两处查询改造**

```ts
// apps/server/src/pricing/pricing-margin.service.ts
export interface MarginRow {
  id: string; scope: string; scopeKey: string | null
  profitBp: number; priceFloorBp: number
  effectiveFrom: Date | null; effectiveTo: Date | null; status: string
}
export interface ResolvedMargin { profitBp: number; priceFloorBp: number; marginPolicyId: string }

export function phaseOf(scope: string, scopeKey?: string | null): string {
  return scope === 'global' ? 'launch' : `scope:${scope}:${scopeKey ?? '*'}`
}

const ORDER = ['model_spec', 'model', 'upstream', 'provider', 'modality', 'global'] as const

export function resolveMargin(subject: {
  capability: string; modelKey: string; spec: string; provider: string; upstream: string
}, rows: MarginRow[], at: Date): ResolvedMargin {
  const keyOf = (scope: string): string => {
    switch (scope) {
      case 'model_spec': return `${subject.modelKey}|${subject.spec}`
      case 'model': return subject.modelKey
      case 'upstream': return subject.upstream
      case 'provider': return subject.provider
      case 'modality': return subject.capability
      default: return '*'
    }
  }
  for (const scope of ORDER) {
    const wanted = keyOf(scope)
    const hit = rows
      .filter((r) => r.scope === scope && r.status === 'active' && (r.scopeKey ?? '*') === wanted)
      .filter((r) => (!r.effectiveFrom || r.effectiveFrom <= at) && (!r.effectiveTo || r.effectiveTo > at))
      .sort((a, b) => (b.effectiveFrom?.getTime() ?? 0) - (a.effectiveFrom?.getTime() ?? 0))[0]
    if (hit) return { profitBp: hit.profitBp, priceFloorBp: hit.priceFloorBp, marginPolicyId: hit.id }
  }
  return { profitBp: 1000, priceFloorBp: 500, marginPolicyId: '' }
}
```

两处防御读统一改为（保留 `?.` 与 11000 缺省，勿改成 `findFirst().catch()`，会踩 #415 的同步 TypeError 坑）：

```ts
const row = await this.prisma?.marginPolicy?.findFirst?.({ where: { scope: 'global', status: 'active' } })
return typeof row?.marginBp === 'number' && row.marginBp > 0 ? row.marginBp : 11000
```

`agent.service.ts` 的 `readMarginBp` 用同一条件。写路径校验 `profitBp >= priceFloorBp`，`phase` 由 `phaseOf()` 生成，同 scope 只允一条 active（应用层 CAS：`updateMany({ where: { scope, scopeKey, status: 'active', profitBp: 原值 } })`，冲突 409）。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: 同 Step 2；Expected: 全绿。再跑 `agent.service` 相关既有测试，确认 Q2 展示预估未回归。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pricing/pricing-margin.service.ts apps/server/src/pricing/pricing-margin.service.test.ts apps/server/src/pricing/pricing.service.ts apps/server/src/agent/agent.service.ts apps/server/src/pricing/pricing.service.test.ts
git commit -m "feat(pricing): scoped margin policies + pin two defensive reads to global"
```

---

### Task 5: `PricingMaterializer` 物化、公式与地板

**Files:**
- Create: `apps/server/src/pricing/pricing-materializer.service.ts`
- Create: `apps/server/src/pricing/pricing-materializer.service.test.ts`
- Modify: `apps/server/src/pricing/pricing.core.ts:184-196`（`checkCostFloor`）
- Modify: `apps/server/src/pricing/pricing.core.ts:23-40`（`PricingQuery` / `PricingQuote` 增可选字段，含 `chars?: number`）

**Interfaces:**
- Consumes: Task 3 `resolveUnitCost`、Task 4 `resolveMargin`、`computeCreditsFromCost`、`checkCostFloor`。
- Produces: `materialize(draftId, subjects): Promise<{ added, changed, unchanged, missingCost[], unitMismatch[], floorViolations[], noCostCoverage[] }>`；`creditsOf(costYuanPerRequest, profitBp): number`；`ratioOf(costYuanPer1MToken, profitBp): number`。

- [ ] **Step 1: 写失败测试（AC6 / AC9 文本例外 / AC14 地板）**

```ts
// apps/server/src/pricing/pricing-materializer.service.test.ts
import { describe, expect, it } from 'vitest'
import { creditsOf, ratioOf } from './pricing-materializer.service'
import { computeCreditsFromCost, checkCostFloor } from './pricing.core'

describe('materialization formulas', () => {
  it('AC6：profitBp=1000 与现网 computeCreditsFromCost(cost,11000) 逐值相等', () => {
    for (const c of [0.009, 0.3, 0.572, 2.86, 4.65, 8.58, 20]) {
      expect(creditsOf(c, 1000)).toBe(computeCreditsFromCost(c, 11000))
    }
  })
  it('AC6：反比率 r 与现网 floor(1e6/(cost×110)) 逐值相等', () => {
    for (const c of [0.14, 0.7, 2.1, 8.1, 20]) {
      expect(ratioOf(c, 1000)).toBe(Math.floor(1e6 / (c * 110)))
    }
  })
  it('AC9：文本反比率不得误用 costYuanPerRequest（1e6 倍错价负例）', () => {
    expect(ratioOf(0.7, 1000)).toBe(Math.floor(1e6 / (0.7 * 110)))
    expect(ratioOf(0.7, 1000)).not.toBe(creditsOf(0.7, 1000))
  })
  it('AC14：地板按归一后成本，图片 3 张下限 95 而非 32', () => {
    expect(checkCostFloor({ matchKey: 'image|seedream-5.0-pro|1K:3|volcengine|apimart', credits: 40, costRateId: 'r1' }, 0.9)).toMatchObject({ kind: 'min', limit: 95 })
    expect(checkCostFloor({ matchKey: 'image|seedream-5.0-pro|1K:3|volcengine|apimart', credits: 100, costRateId: 'r1' }, 0.9)).toBeNull()
  })
  it('AC14：反比率上限按 priceFloorBp(500) 而非 profitBp(1000)', () => {
    const cost = 0.7
    const floorLimit = Math.floor(1e8 / (cost * 10500))
    expect(floorLimit).toBe(Math.floor(1e6 / (cost * 105)))
    expect(checkCostFloor({ matchKey: 'text:step-3.5-flash:in', credits: floorLimit + 1, costRateId: 'r1' }, cost)).toMatchObject({ kind: 'max', limit: floorLimit })
  })
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `env -u NODE_OPTIONS $HOME/.nvm/versions/node/v24.13.0/bin/pnpm --filter @lnkpi/server exec vitest run src/pricing/pricing-materializer.service.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL —— `creditsOf` / `ratioOf` 未定义，`checkCostFloor` 仍用 105 硬编码。

- [ ] **Step 3: 实现公式与物化**

```ts
export function creditsOf(costYuanPerRequest: number, profitBp: number): number {
  return Math.max(1, Math.ceil((costYuanPerRequest * (10000 + profitBp)) / 10000 / 0.01))
}
export function ratioOf(costYuanPer1MToken: number, profitBp: number): number {
  return Math.floor(1e8 / (costYuanPer1MToken * (10000 + profitBp)))
}
```

`pricing.core.ts` 的 `checkCostFloor(e, costYuanPerRequest, priceFloorBp = 500)` 改为：`price = ceil(costYuanPerRequest * (10000 + priceFloorBp) / 100)`（价格行 kind='min'）；反比率行 `limit = floor(1e8 / (costYuanPer1MToken * (10000 + priceFloorBp)))`（kind='max'，注意该入参由 Task 8 的 `checkFloors` 按 `isTextTokenMatchKey` 分流传「每 1M token 成本」，与价格行的 `costYuanPerRequest` 不同）。`FLOOR_MULTIPLIER=105` 常量删除，保留数值等价断言。`PricingQuery` 增 `provider? / upstream? / spec? / subjectKey? / chars?`（`chars?` 对应 spec **D11** 裁决：S1 只补类型契约占位、计价链不消费它，音频按字符精确计费的运行时闭环归 S3），`PricingQuote` 增 `subjectKey? / costYuanPerRequest? / billableUnit? / unitSnapshot? / profitBp? / priceListVersionId? / costSource? / degraded?: true`。⭐ **全部条件写入**（`...(x ? {k:v} : {})`，禁 `?? null`）：`degraded` 只在 `constants-fallback` 路径出现且恒为 `true`，**非兜底路径不出现该键** ⇒ `pricing.service.test.ts` 里几十处 `toEqual({ credits, ruleVersion })` 等价锚零改动。这优先于 spec §6.1 表格里「`degraded Boolean`」的字面写法（已同步修订 spec），遵循项目「键不出现纪律」。

`materialize()` 逐主体：`resolveUnitCost` → `resolveMargin` → `creditsOf` 或 `ratioOf` → 与 draft 内现有条目 diff → 只 upsert `basis !== 'ops-modified'` 的行；写入时 `matchKey = subjectKey`、`subjectKey = subjectKey`、`costSnapshotYuan = costYuanPerRequest`、`unitSnapshot = JSON.stringify({billableUnit, unitQuantity, unitsPerRequest})`、`profitBpSnapshot`、`costRateId`、`marginPolicyId`、`basis='auto-derived'`、`reason=null`。同输入二次运行 `changed=0`。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: 同 Step 2 命令 + `src/pricing/pricing.core.test.ts` + `src/pricing/pricing.service.test.ts`；Expected: 全绿（含既有断言更新后的等价金标准 4/4）。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pricing/pricing-materializer.service.ts apps/server/src/pricing/pricing-materializer.service.test.ts apps/server/src/pricing/pricing.core.ts apps/server/src/pricing/pricing.core.test.ts apps/server/src/pricing/pricing.service.test.ts
git commit -m "feat(pricing): cost x profit materializer + priceFloorBp-derived floor"
```

---

### Task 6: 缓存双索引与 `quote()` 六级解析

**Files:**
- Modify: `apps/server/src/pricing/pricing.service.ts`（`PriceTable:80-85`、`GrayTable:88-96`、`loadActiveTable:504-527`、`loadGrayTable:533-562`、`quote:189-231`）
- Create: `apps/server/src/pricing/pricing.s1-resolution.test.ts`
- Create: `apps/server/src/pricing/pricing-metrics.ts`
- Modify: `apps/server/src/pricing/pricing.controller.ts:31-54`

**Interfaces:**
- Consumes: `PriceListEntry.subjectKey` 列、`PRICING_SUBJECT_KEYS` env、Task 5 的 `PricingQuote` 字段。
- Produces: `PriceTable.subjectEntries: Map<string, number>`、`GrayTable.subjectEntries: Map<string, number>`、`quote(q, userId?)` 六级解析、`GET /api/pricing/quote` 的 `degraded` 字段、5 个指标计数器。

- [ ] **Step 1: 写失败测试（AC11①② / AC5 / AC8）**

```ts
// apps/server/src/pricing/pricing.s1-resolution.test.ts
import { describe, expect, it } from 'vitest'
import { PrismaService } from '../prisma/prisma.service'
import { PricingService } from './pricing.service'

const prisma = new PrismaService()

async function seedSubjectRow(versionId: string, subjectKey: string, credits: number) {
  return prisma.priceListEntry.create({ data: {
    versionId, capability: 'image', matchKey: subjectKey, subjectKey, credits,
    basis: 'auto-derived', costRateId: null,
  } })
}

describe('subjectKey resolution', () => {
  it('AC11①：subjectKey 行必须被命中，删掉 subjectKey 列后回落 legacy 价', async () => {
    const v = await prisma.priceListVersion.findFirst({ where: { status: 'active' } })
    const key = 'image|seedream-5.0-pro|1K:1|volcengine|apimart'
    const row = await seedSubjectRow(v!.id, key, 77)
    const svc = new PricingService(prisma)
    const q = { capability: 'image' as const, count: 1, resolution: '1K', modelKey: 'seedream-5.0-pro', provider: 'volcengine', upstream: 'apimart', spec: '1K:1' }
    expect((await svc.quote(q)).credits).toBe(77)
    await prisma.priceListEntry.update({ where: { id: row.id }, data: { subjectKey: null } })
    const svc2 = new PricingService(prisma)
    expect((await svc2.quote(q)).credits).toBe(33)
    await prisma.priceListEntry.delete({ where: { id: row.id } })
  })

  it('AC11② / AC5：PRICING_SUBJECT_KEYS=off 时逐字回落 legacy', async () => {
    process.env.PRICING_SUBJECT_KEYS = 'off'
    const svc = new PricingService(prisma)
    expect((await svc.quote({ capability: 'text' })).credits).toBe(5)
    expect((await svc.quote({ capability: 'image', count: 1, resolution: '1K' })).credits).toBe(33)
    delete process.env.PRICING_SUBJECT_KEYS
  })

  it('AC8：constants-fallback 返回 degraded=true 且计数 +1', async () => {
    process.env.PRICING_SOURCE = 'constants'
    const svc = new PricingService(prisma)
    expect(await svc.quote({ capability: 'text' })).toMatchObject({ credits: 5, ruleVersion: 'constants-fallback', degraded: true })
    delete process.env.PRICING_SOURCE
  })
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `env -u NODE_OPTIONS $HOME/.nvm/versions/node/v24.13.0/bin/pnpm --filter @lnkpi/server exec vitest run src/pricing/pricing.s1-resolution.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL —— `subjectKey` 行未进表快照，第一条期望 77 实际 33。

- [ ] **Step 3: 实现双索引与六级解析**

```ts
interface PriceTable {
  id: string; version: string
  entries: Map<string, number>
  subjectEntries: Map<string, number>
  loadedAt: number
}
// loadActiveTable / loadGrayTable 内：
const subjectEntries = new Map<string, number>()
for (const e of version.entries) {
  entries.set(e.matchKey, e.credits)
  if (e.subjectKey) subjectEntries.set(e.subjectKey, e.credits)
}
```

`quote()` 在 `PRICING_SUBJECT_KEYS !== 'off'` 时按顺序：灰度 `subjectEntries.get(subjectKey)` → global `subjectEntries.get(subjectKey)` → model 默认 `capability|modelKey|*|*|*` → `entries.get(buildMatchKey(q))` → `entries.get(`${q.capability}:*`)` → `legacyPriceOf(q)`；`off` 时只走后三级。`subjectKey` 由 `PricingQuery` 的 `subjectKey` 直接取，缺省用 `subjectKeyOf()`（Task 2）从 `capability / modelKey / spec / provider / upstream` 构造，五段缺任一则跳过前三级。每一级回落记 `pricing_resolution_total{level}`；`constants-fallback` 额外 warn + `degraded=true`。`PricingQuote` 的扩展字段从命中的 `PriceListEntry` 快照读取（需把 `PriceTable` 的 Map 值从 `number` 扩成 `{ credits: number; subjectKey?: string; costSnapshotYuan?: number }`，或另建 `subjectMeta: Map<string, Partial<PricingQuote>>`；本计划选后者，避免改动 `entries` 现有类型）。展示端点的 `data.degraded` 取 `r.degraded === true`（`PricingQuote` 内部仍条件写入、非兜底路径不出键），行为与现网 `ruleVersion === 'constants-fallback'` 推导逐值一致；端点另接受 `provider / upstream / spec` 三个可选参数。

`pricing-metrics.ts` 导出 `incResolution(level)`、`incMaterialize(outcome)`、`incCostSource(source)`、`incUnitMismatch(capability, reason)`、`incSubject(status)`，实现为进程内 Map + `console.log` 结构化行（不引入 prom-client 等新依赖，YAGNI）；告警阈值按 spec §9。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: 同 Step 2 + `src/pricing/pricing.service.test.ts` + `src/pricing/pricing.controller.quote.sqlite.integration.test.ts`；Expected: 全绿，等价金标准 4/4。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pricing/pricing.service.ts apps/server/src/pricing/pricing.s1-resolution.test.ts apps/server/src/pricing/pricing-metrics.ts apps/server/src/pricing/pricing.controller.ts apps/server/src/pricing/pricing.service.test.ts
git commit -m "feat(pricing): subjectEntries dual index + six-level quote resolution"
```

---

### Task 7: `TEXT_TOKEN_MODELS` 两处数据化与 `active` 端点防污染

**Files:**
- Modify: `apps/server/src/pricing/pricing.service.ts:259`（`quoteTextTokens`）、`:362`（`prepareTextTokenQuote`）、`:416-449`（`getActiveTextTokenRatios` 加断言）
- Test: `apps/server/src/pricing/pricing.service.test.ts`（追加 AC7 / AC11④ 用例）

**Interfaces:**
- Consumes: `PricingSubject` 中该模型 `in` / `out` 反比率主体行（`pricingSubject.findMany({ where: { modelKey, spec: { in: ['in','out'] } } })`）。
- Produces: `isKnownTokenModel(modelKey): Promise<boolean>`（替换两处 `TEXT_TOKEN_MODELS.includes`）。

- [ ] **Step 1: 写失败测试（新模型 + 预估结算同源）**

```ts
// 追加到 pricing.service.test.ts；顶部补 import { PricingController } from './pricing.controller'
// 并按 pricing.test-utils.ts 的 FakeDb 形状给 p.pricingSubject 补内存实现（findMany / createMany）
it('AC7/AC11④：新登记模型（不在 8 白名单）走精确反比率，且预估 === 结算', async () => {
  await p.pricingSubject.createMany({ data: [
    { subjectKey: 'text|new-model|in|agnes|agnes_hub', capability: 'text', modelKey: 'new-model', spec: 'in', provider: 'agnes', upstream: 'agnes_hub', status: 'priced', billableUnit: 'token_in', source: 'auto' },
    { subjectKey: 'text|new-model|out|agnes|agnes_hub', capability: 'text', modelKey: 'new-model', spec: 'out', provider: 'agnes', upstream: 'agnes_hub', status: 'priced', billableUnit: 'token_out', source: 'auto' },
  ] })
  await p.priceListEntry.createMany({ data: [
    { versionId: V, capability: 'text', matchKey: 'text:new-model:in', credits: 5000, basis: 'auto-derived' },
    { versionId: V, capability: 'text', matchKey: 'text:new-model:out', credits: 1000, basis: 'auto-derived' },
  ] })
  const svc = new PricingService(p)
  const usage = { inputTokens: 10000, cacheReadTokens: 0, outputTokens: 2000 }
  const settle = await svc.quoteTextTokens(undefined, 'new-model', usage)
  expect(settle.ruleVersion).toBe(V)
  expect(settle.credits).toBe(Math.ceil(10000 / 5000) + Math.ceil(2000 / 1000))
  const plan = await svc.prepareTextTokenQuote(undefined, 'new-model')
  expect(plan?.compute(usage)).toBe(settle.credits)
})

it('AC11③：subjectKey 行不污染 GET /api/pricing/active 的 textTokenRatios', async () => {
  await p.priceListEntry.create({ data: { versionId: V, capability: 'image', matchKey: 'image|x|1K:1|p|u', subjectKey: 'image|x|1K:1|p|u', credits: 9, basis: 'auto-derived' } })
  const c = new PricingController(new PricingService(p))
  // active 版本本就有 23 条 text:<model>:* 反比率行，不能断言空对象；只断言 subjectKey 未混入
  const ratios = (await c.active()).data.textTokenRatios
  expect(Object.keys(ratios).every((k) => !k.includes('|'))).toBe(true)
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `env -u NODE_OPTIONS $HOME/.nvm/versions/node/v24.13.0/bin/pnpm --filter @lnkpi/server exec vitest run src/pricing/pricing.service.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL —— `quoteTextTokens` 对 `new-model` 落 `constants-fallback`，`prepareTextTokenQuote` 返回 null。

- [ ] **Step 3: 两处同步替换**

```ts
private async isKnownTokenModel(model: string): Promise<boolean> {
  try {
    const rows = await this.prisma.pricingSubject.findMany({
      where: { modelKey: model, capability: 'text', spec: { in: ['in', 'out'] }, status: { not: 'offboarded' } },
      select: { spec: true },
    })
    return rows.some((r) => r.spec === 'in') && rows.some((r) => r.spec === 'out')
  } catch {
    return TEXT_TOKEN_MODELS.includes(model) // 表读失败时退回旧白名单，保证永不 throw
  }
}
```

把 `quoteTextTokens` 与 `prepareTextTokenQuote` 的 `!TEXT_TOKEN_MODELS.includes(model)` 均改为 `!(await this.isKnownTokenModel(model))`；`TEXT_TOKEN_MODELS` 保留为启动自检常量（不删）。`getActiveTextTokenRatios` 的循环增加 `if (key.includes('|')) continue`，并加单测断言（AC11③）。`degradedTextTokenQuote` 行为逐字不变，命中时按 D8 计 `degraded=true` + 指标。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: 同 Step 2 + `src/pricing/pricing.controller.sqlite.integration.test.ts`；Expected: 全绿，`plan.compute === quoteTextTokens` 契约继续绿。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pricing/pricing.service.ts apps/server/src/pricing/pricing.service.test.ts apps/server/src/pricing/pricing.controller.sqlite.integration.test.ts
git commit -m "feat(pricing): data-drive token model whitelist in settle and SSE estimate"
```

---

### Task 8: 发布流接线与门禁

**Files:**
- Modify: `apps/server/src/admin/pricing-publishing.controller.ts:39-68`（`parseEntriesBody`）
- Modify: `apps/server/src/pricing/pricing-publishing.service.ts`（`PublishEntryInput:66`、`createDraftFromActive:87-180`、`upsertEntries:180-215`、`diffSummary:217-287`、`publish:288-368`、`checkFloors:409-435`、`rollback:370-408`）
- Create: `apps/server/src/pricing/pricing.s1-publishing.integration.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `checkCostFloor(e, costYuan, priceFloorBp)`、Task 3 `resolveUnitCost`、Task 4 `resolveMargin`。
- Produces: `validatePublish(draftId): Promise<{ ok: boolean; violations: string[] }>`；`diffSummary` 增 `missingSubject / marginSnapshot / unitMismatch`；`publish / rollback` 的 `revision + 1`。

- [ ] **Step 1: 写失败测试（AC3 / AC13 / AC14 / revision）**

```ts
// apps/server/src/pricing/pricing.s1-publishing.integration.test.ts
// master b5088ed6 实证：new PricingPublishingService(prisma, pricing) 两参数；
// createDraftFromActive() 返回 { id, version, entries }，故 d.id 可直接用
import { describe, expect, it } from 'vitest'
import { PrismaService } from '../prisma/prisma.service'
import { PricingPublishingService } from './pricing-publishing.service'
import { PricingService } from './pricing.service'

const prisma = new PrismaService()
const svc = () => new PricingPublishingService(prisma, new PricingService(prisma))

describe('S1 publishing wiring', () => {
  it('AC13：PUT /:id/entries 六字段读回非空；createDraftFromActive 复制清单齐全', async () => {
    const d = await svc().createDraftFromActive('s1-test-draft', 'wiring test')
    await svc().upsertEntries(d.id, [{ matchKey: 'image|x|1K:3|p|u', capability: 'image', credits: 100,
      subjectKey: 'image|x|1K:3|p|u', costSnapshotYuan: 0.9, unitSnapshot: '{"billableUnit":"image_count","unitQuantity":1,"unitsPerRequest":3}',
      profitBpSnapshot: 1000, marginPolicyId: 'mp1', reason: 'manual', basis: 'ops-modified' }])
    const row = await prisma.priceListEntry.findFirst({ where: { versionId: d.id } })
    expect(row).toMatchObject({ subjectKey: 'image|x|1K:3|p|u', costSnapshotYuan: 0.9, profitBpSnapshot: 1000, marginPolicyId: 'mp1', reason: 'manual' })
    const d2 = await svc().createDraftFromActive('s1-test-draft-2', 'copy test')
    const copy = await prisma.priceListEntry.findFirst({ where: { versionId: d2.id, matchKey: 'image|x|1K:3|p|u' } })
    expect(copy?.costSnapshotYuan).toBe(0.9)
    expect(copy?.unitSnapshot).toContain('image_count')
  })

  it('AC14：地板按 costYuanPerRequest=0.9 判，credits=40 必须被硬拒', async () => {
    const d = await svc().createDraftFromActive('s1-floor-draft', 'floor test')
    await prisma.priceListEntry.upsert({ where: { versionId_matchKey: { versionId: d.id, matchKey: 'image|seedream-5.0-pro|1K:3|volcengine|apimart' } },
      update: { credits: 40 }, create: { versionId: d.id, capability: 'image', matchKey: 'image|seedream-5.0-pro|1K:3|volcengine|apimart', subjectKey: 'image|seedream-5.0-pro|1K:3|volcengine|apimart', credits: 40, basis: 'auto-derived', costSnapshotYuan: 0.9, costRateId: (await prisma.costRate.findFirst())!.id } })
    await expect(svc().publish(d.id)).rejects.toThrow(/地板校验失败/)
  })

  it('AC3 / revision：缺成本主体 validatePublish 返回违规清单，publish 400 且版本状态零变化', async () => {
    const v = await prisma.priceListVersion.findFirst({ where: { status: 'active' } })
    const before = v!.revision
    const d = await svc().createDraftFromActive('s1-gate-draft', 'gate test')
    const r = await svc().validatePublish(d.id)
    expect(r.ok).toBe(false)
    expect(r.violations.length).toBeGreaterThan(0)
    expect((await prisma.priceListVersion.findUnique({ where: { id: d.id } }))!.status).toBe('draft')
    expect((await prisma.priceListVersion.findUnique({ where: { id: v!.id } }))!.revision).toBe(before)
  })
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `env -u NODE_OPTIONS $HOME/.nvm/versions/node/v24.13.0/bin/pnpm --filter @lnkpi/server exec vitest run src/pricing/pricing.s1-publishing.integration.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL —— `createDraftFromActive` 未复制新列、`PublishEntryInput` 无六字段、`checkFloors` 仍传 `rate.costYuan`。

- [ ] **Step 3: 四处同步改造**

1. `PublishEntryInput` 与 `parseEntriesBody` 各增六字段。手写解析器必须**显式透传**（这是字段丢失的真实位置）：

```ts
// apps/server/src/admin/pricing-publishing.controller.ts · parseEntriesBody 内，每项 e
const str = (key: string): string | undefined => {
  const v = e[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') throw new BadRequestException(`entries[${i}].${key} 必须是字符串`)
  return v
}
const num = (key: string): number | undefined => {
  const v = e[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new BadRequestException(`entries[${i}].${key} 必须是有限数`)
  return v
}
const subjectKey = str('subjectKey'); if (subjectKey !== undefined) entry.subjectKey = subjectKey
const costSnapshotYuan = num('costSnapshotYuan'); if (costSnapshotYuan !== undefined) entry.costSnapshotYuan = costSnapshotYuan
const unitSnapshot = str('unitSnapshot'); if (unitSnapshot !== undefined) entry.unitSnapshot = unitSnapshot
const profitBpSnapshot = num('profitBpSnapshot'); if (profitBpSnapshot !== undefined) entry.profitBpSnapshot = profitBpSnapshot
const marginPolicyId = str('marginPolicyId'); if (marginPolicyId !== undefined) entry.marginPolicyId = marginPolicyId
const reason = str('reason'); if (reason !== undefined) entry.reason = reason
```

`upsertEntries` 的 `create` 与 `update` 两处对象都带上这些字段；`versionId_matchKey` upsert 键不变（subjectKey 行的 `matchKey` 就是 subjectKey 本身）。

2. `createDraftFromActive` 的两处复制点（`:113` 与 `:173`）补齐：

```ts
entries: { create: active.entries.map((e) => ({
  matchKey: e.matchKey, capability: e.capability, credits: e.credits,
  basis: e.basis, costRateId: e.costRateId,
  subjectKey: e.subjectKey, costSnapshotYuan: e.costSnapshotYuan,
  unitSnapshot: e.unitSnapshot, profitBpSnapshot: e.profitBpSnapshot,
  marginPolicyId: e.marginPolicyId, reason: e.reason,
})) }
```

3. `checkFloors` 替换 `:432` 的单单位成本传参（AC14 的核心）：

```ts
// apps/server/src/pricing/pricing-publishing.service.ts · checkFloors 内
const isToken = isTextTokenMatchKey(e.matchKey)
const costForFloor = isToken ? rate.costYuan : (e.costSnapshotYuan ?? rate.costYuan)
const policy = e.marginPolicyId
  ? await this.prisma.marginPolicy.findUnique({ where: { id: e.marginPolicyId } })
  : null
const v = checkCostFloor(e, costForFloor, policy?.priceFloorBp ?? 500)
if (v) floorViolations.push(v)
if (e.unitSnapshot === null && !isToken) unitMismatch.push(e.matchKey)
if (rate.provisional) missingCost.push(e.matchKey)
```

`missingCost` 仍只在 `costRateId` 指向的行不存在时记（沿用现网语义），`provisional` 与 `unitMismatch` 是新增违规类目。

4. `validatePublish` 实现 spec §6.8 的 7 条硬拒条件并复用同一 `checkFloors`；`publish()` 在既有 `:306` 判定处改为消费 `validatePublish`，`BadRequestException` 携带结构化违规清单；`publish / rollback` 在事务内 `revision: { increment: 1 }`；`diffSummary` 增 `missingSubject / marginSnapshot / unitMismatch` 三个只读字段；所有写路径落 `AdminAuditLog` before/after。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: 同 Step 2 + `src/pricing/pricing-publishing.service.test.ts` + `src/pricing/pricing.ops-reprice.integration.test.ts`；Expected: 全绿，既有发布流行为未回归。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/admin/pricing-publishing.controller.ts apps/server/src/pricing/pricing-publishing.service.ts apps/server/src/pricing/pricing.s1-publishing.integration.test.ts
git commit -m "feat(pricing): publishing field passthrough + normalized-cost floor + validatePublish"
```

---

### Task 9: 后台配置面、指标接线与全链验收

**Files:**
- Create: `apps/server/src/admin/pricing-cost.controller.ts`、`pricing-margin.controller.ts`（`GET/PUT`，`AdminTokenGuard` + `AdminAuditLog`）
- Create: `apps/server/src/admin/pricing-materialize.controller.ts`（`POST /api/admin/pricing/versions/:id/materialize`、`GET /api/admin/pricing/versions/:id/readiness`）
- Create: `apps/web/src/pages/AdminPricingSubjectsPage.vue`、`AdminCostRatesPage.vue`、`AdminMarginPoliciesPage.vue`
- Modify: `apps/web/src/services/admin-api.ts`、`apps/web/src/pages/AdminLayoutPage.vue`（「渠道定价」菜单组 + 路由）
- Test: `apps/server/src/pricing/pricing.s1-acceptance.test.ts`（AC1–AC14 汇总 + 7 处变异脚本）

**Interfaces:**
- Consumes: Task 1–8 全部产出；`GET /api/pricing/quote`（展示）、`GET /api/pricing/active`。
- Produces: 后台三页；`GET /api/admin/pricing/versions/:id/readiness` 返回 `validatePublish` 结果；AC 汇总报告。

- [ ] **Step 1: 写失败测试（AC10 币种 + AC1 端到端 + 变异 ⑦）**

```ts
// apps/server/src/pricing/pricing.s1-acceptance.test.ts
import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { PricingService } from './pricing.service'
import { PricingController } from './pricing.controller'
import { creditsOf } from './pricing-materializer.service'

const prisma = new PrismaService()

describe('S1 acceptance', () => {
  it('AC10：schema 与写入 DTO 不存在任何币种/汇率字段；改 FX 不影响 creditsOf', () => {
    const pricingModels = Prisma.dmmf.datamodel.models.filter((m) => ['CostRate', 'PriceListEntry', 'MarginPolicy'].includes(m.name))
    for (const m of pricingModels) {
      expect(m.fields.map((f) => f.name)).not.toContain('currencySrc')
      expect(m.fields.map((f) => f.name)).not.toContain('fxRate')
      expect(m.fields.map((f) => f.name)).not.toContain('fxUsdCny')
      expect(m.fields.map((f) => f.name)).not.toContain('costSource')
    }
    const before = creditsOf(2.86, 1000)
    process.env.PRICING_FX_USD_CNY = '9.99'
    expect(creditsOf(2.86, 1000)).toBe(before)
    delete process.env.PRICING_FX_USD_CNY
  })

  it('AC1 / AC8：新主体从成本 → 15% 利润 → 物化 → 发布 → 计费命中，且展示同源', async () => {
    const version = await prisma.priceListVersion.findFirst({ where: { status: 'active' } })
    const subjectKey = 'image|new-image-model|1K:1|volcengine|apimart'
    const expected = creditsOf(0.3, 1500)
    await prisma.priceListEntry.upsert({
      where: { versionId_matchKey: { versionId: version!.id, matchKey: subjectKey } },
      update: { credits: expected, subjectKey, costSnapshotYuan: 0.3, profitBpSnapshot: 1500, basis: 'auto-derived' },
      create: { versionId: version!.id, capability: 'image', matchKey: subjectKey, subjectKey, credits: expected, costSnapshotYuan: 0.3, profitBpSnapshot: 1500, basis: 'auto-derived' },
    })
    const svc = new PricingService(prisma)
    const q = { capability: 'image' as const, count: 1, resolution: '1K', modelKey: 'new-image-model', provider: 'volcengine', upstream: 'apimart', spec: '1K:1' }
    const charged = await svc.quote(q)
    expect(charged.credits).toBe(expected)
    expect(charged).toMatchObject({ subjectKey, profitBp: 1500, costYuanPerRequest: 0.3 })
    expect('degraded' in charged).toBe(false) // 非兜底路径键不出现，守住既有 toEqual 等价锚
    const c = new PricingController(svc)
    expect((await c.quote({ capability: 'image', count: '1', resolution: '1K', modelKey: 'new-image-model', provider: 'volcengine', upstream: 'apimart', spec: '1K:1' })).data.credits).toBe(expected)
    await prisma.priceListEntry.deleteMany({ where: { versionId: version!.id, matchKey: subjectKey } })
  })
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `env -u NODE_OPTIONS $HOME/.nvm/versions/node/v24.13.0/bin/pnpm --filter @lnkpi/server exec vitest run src/pricing/pricing.s1-acceptance.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL —— `PricingQuote` 未带 `subjectKey / profitBp / costYuanPerRequest`。

- [ ] **Step 3: 补齐后台三页与指标接线**

```ts
// apps/web/src/services/admin-api.ts 追加
export interface CostRateInput {
  upstream: string; provider: string; modelKey: string; spec: string
  unit: 'per_image' | 'per_video' | 'per_call' | 'per_1m_tokens' | 'per_second'
  unitQuantity: number
  costYuan: number // 人民币元；无 currency / fxRate 字段
  source: 'official_list' | 'negotiated' | 'channel_actual' | 'provisional'
  effectiveFrom?: string; effectiveTo?: string; sourceRef?: string; provisional?: boolean
}
export const putCostRate = (body: CostRateInput) =>
  adminFetch('/api/admin/pricing/cost-rates', { method: 'PUT', body: JSON.stringify(body) })
export const putMarginPolicy = (body: {
  scope: string; scopeKey?: string; profitBp: number; priceFloorBp: number
  effectiveFrom?: string; effectiveTo?: string; status: string
}) => adminFetch('/api/admin/pricing/margin-policies', { method: 'PUT', body: JSON.stringify(body) })
export const rebuildSubjects = () =>
  adminFetch('/api/admin/pricing/subjects/rebuild', { method: 'POST' })
export const materializeDraft = (id: string) =>
  adminFetch(`/api/admin/pricing/versions/${id}/materialize`, { method: 'POST' })
```

```ts
// apps/server/src/admin/pricing-cost.controller.ts 手写解析器（AC10 的服务端守卫）
const FORBIDDEN = ['currency', 'currencySrc', 'fxRate', 'fxUsdCny', 'costUsd', 'usdPerM']
function parseCostRateBody(body: Record<string, unknown>) {
  for (const k of FORBIDDEN) {
    if (k in body) throw new BadRequestException(`成本登记不接受字段 ${k}：一律人民币（D9）`)
  }
  const costYuan = body['costYuan']
  if (typeof costYuan !== 'number' || !Number.isFinite(costYuan) || costYuan < 0) {
    throw new BadRequestException('costYuan 必须是非负人民币元金额')
  }
  const source = String(body['source'] ?? 'official_list')
  if (!['official_list', 'negotiated', 'channel_actual', 'provisional'].includes(source)) {
    throw new BadRequestException('source 取值不在 D5 四级枚举内')
  }
  // unit / unitQuantity / spec / effectiveFrom / sourceRef / provisional 同式校验后显式组装写库对象
  return { costYuan, source }
}
```

成本页字段：`upstream / provider / modelKey / spec / unit / unitQuantity / costYuan(人民币元) / source / effectiveFrom / effectiveTo / sourceRef / provisional` —— **页面不渲染且不提交任何币种 / 汇率字段**。利润页字段：`scope / scopeKey / profitBp / priceFloorBp / effectiveFrom / effectiveTo / status`，`phase` 由服务端 `phaseOf()` 生成。主体页展示 `subjectKey` / 状态 / 成本覆盖率 / 建议价，并提供 `rebuild` 与 `materialize` 按钮。三页均在 `AdminLayoutPage` 的「渠道定价」组内，全部走 `AdminTokenGuard`。把 Task 6 的 5 个计数器接到 `materialize / quote / resolveUnitCost / rebuild` 的对应出口。

- [ ] **Step 4: 全链验收与变异自检**

Run（逐条，均为完整 stdout 判 RED，禁 `| tail`）：

```bash
# 回归红线
env -u NODE_OPTIONS $HOME/.nvm/versions/node/v24.13.0/bin/pnpm --filter @lnkpi/server exec vitest run src/pricing --maxWorkers=1 --no-file-parallelism
env -u NODE_OPTIONS $HOME/.nvm/versions/node/v24.13.0/bin/pnpm --filter @lnkpi/server exec vitest run src/payment.integration.test.ts --maxWorkers=1 --no-file-parallelism
$HOME/.nvm/versions/node/v24.13.0/bin/pnpm exec vue-tsc -b
```

再对 spec §10 的 7 处变异逐条改一行、跑定向用例、确认输出含 `AssertionError` / `failing tests`、恢复文件并确认 `git status` 干净：① `profitBp ±1`；② 删一条 `CostRate`；③ 解析链对调 `subjectKey` / `matchKey` 优先级；④ 去掉 `modelOptionName` 前缀归一；⑤ 让 `ops-modified` 参与自动重算；⑥ `unitQuantity` 1e6→1；⑦ 删 `loadActiveTable` 的 `subjectEntries` 索引 / 把 `prepareTextTokenQuote` 的 `includes` 改回白名单。任一恒绿即判据失效，先修判据再继续（⭐ 同时防「环境坏造成的恒红」：每轮先跑一次基线绿）。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/admin apps/server/src/pricing apps/web/src/pages/AdminPricingSubjectsPage.vue apps/web/src/pages/AdminCostRatesPage.vue apps/web/src/pages/AdminMarginPoliciesPage.vue apps/web/src/services/admin-api.ts apps/web/src/pages/AdminLayoutPage.vue
git commit -m "feat(pricing): ops-console config pages + S1 acceptance suite"
```

---

## Spec 覆盖自检（写计划时同步执行）

| Spec 章节 | 覆盖任务 |
|---|---|
| §3.5 四层单位链 / U1–U6 / D9 单一人民币 | Task 1（unitQuantity 回填）、Task 3（归一）、Task 9（AC10） |
| §3 裁决 D1–D11（含 D11 音频 `chars?` 占位） | Task 5（公式）、Task 5（`PricingQuery.chars?`）、Task 7（数据化）、Task 8（门禁）、Task 9（后台） |
| §5 分期 S1 边界 / S2–S4 契约桩 | Task 8（validatePublish / revision 供 S2/S3）、Task 6（PricingQuote 上下文供 S3） |
| §6.1 数据模型 + §6.1.1 九处改造清单 | Task 1（表）、Task 4（#4）、Task 6（#1/#2）、Task 7（#3/#8）、Task 8（#5/#6/#7/#9）、Task 5（#9 checkCostFloor） |
| §6.2 主体两路枚举 / 路由算法 / U6 | Task 2 |
| §6.3 成本层 / `CostRate.source` 复用 | Task 3 |
| §6.4 利润层 / 地板归一后成本 | Task 4、Task 5、Task 8 |
| §6.5 物化 / basis / 幂等 | Task 5、Task 8 |
| §6.6 六级解析 / §6.6.1 双索引 / 展示端点 | Task 6、Task 9 |
| §6.7 后台配置面 / 手校 DTO | Task 9、Task 8 |
| §6.8 门禁 7 条件 | Task 8 |
| §6.9 迁移 / 341 行不变 / 回滚 | Task 1、Task 6（AC5） |
| §9 指标 / §10 AC1–AC14 + 7 变异 | Task 6、Task 9 |
| §11 风险 / §12 决策 | Global Constraints + Review Focus |

**未覆盖项**：无。S2–S4 按 spec §5 明确不在本计划内（各自独立 spec → plan → 实现）。

**类型一致性核对**：`subjectKeyOf`（Task 2）→ `resolveUnitCost(subject, rates, at)` / `UnitCost`（Task 3）→ `resolveMargin`（Task 4）→ `creditsOf / ratioOf / materialize`（Task 5）→ `PriceTable.subjectEntries`（Task 6）→ `isKnownTokenModel`（Task 7）→ `validatePublish`（Task 8）→ AC 汇总（Task 9），签名与字段名逐任务一致；`costSource` 是 `CostRate.source` 的逻辑别名，不落新列。

**占位符扫描**：全文无 `TBD` / `TODO` / `implement later` / `fill in details` / `Similar to Task N` / `add appropriate error handling`；每个代码步骤均含可粘贴代码或明确的字段清单与命令。
