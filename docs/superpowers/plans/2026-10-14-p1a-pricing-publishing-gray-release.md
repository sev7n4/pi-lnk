# P1-a 定价运营发布流 + 白名单灰度 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 P0 建好的价目表从「只读地基」升级为可运营体系：draft→预览→审批→发布→回滚的版本发布流（spec §8.4）+ 白名单灰度发布（spec §8.5）+ v2 拉新期价目草案种子（spec §6/§7）。**发布流落地后，改价不再发版。**

**Architecture:** 全部骑在 P0 三层定价架构上增量演进：`PriceListVersion.status` 已有 `draft|active|archived` 三态（P0 只用过 active/archived，draft 是现成空档）；新增两张灰度小表 + `PointTransaction.grayReleaseId` 列；灰度解析以「每用户可选第二张表」的形态插入 `PricingService.quote` 缓存层（30s 同周期刷新）；运营操作走 ops-console 既有 `AdminTokenGuard + AdminAuditLog` 模式扩两个 controller。

**Tech Stack:** NestJS + Prisma/SQLite + Vitest + Vue3（admin 页面，参照 AdminPricingPage.vue 模式）

**Spec:** `docs/superpowers/specs/2026-10-13-pricing-baseline-config-design.md`（§8.4/§8.5/§6/§7）+ `docs/superpowers/specs/2026-10-13-billing-points-system-design.md`（§3 域架构）。

**Base:** master `a8b0bd95`（#404 P0 等价迁移已上生产）。分支 `feat/p1a-pricing-publishing`。

**CostWatch 周更明确不在本计划**（spec §8.1 挪 P2）：依赖渠道对账数据面与外部定价页抓取稳定性；P1 出口判据「上游调价一周内可跟随」由「改价不发版」机制本身满足。

---

## Global Constraints

- **无灰度路径行为逐字不变**（P0 等价迁移纪律的延伸）：`quote(q)` 不传 userId 时解析结果与现状完全一致；`PointTransaction` 无灰度时**不新增字段写入**（条件展开），保证既有测试的 `toHaveBeenCalledWith` 精确断言零改动。任何 task 破坏现有测试断言即为实现错误，不许改测试迁就实现。
- **quote 永不 throw**：灰度解析任何异常都落回 global 表或常量兜底，只 warn（P0 四条保底路径纪律的延续）。
- **PrismaModule 是 @Global**（pricing.module 无需 imports）；`PrismaService extends PrismaClient`（无需强转）。
- **admin 域模式照抄** `apps/server/src/admin/platform-channel.controller.ts`：`@UseGuards(AdminTokenGuard)` 逐路由挂载；写操作在 `$transaction` 内、成功后 `tx.adminAuditLog.create({ actor: 'admin', action, resource, before, after })`；新 controller 注册进 `admin.module.ts` controllers 数组。
- **SQLite 迁移验证模式**（P0 Task 1 先例）：新迁移用「临时库 db push 验证 + 本迁移单执行」验证可应用；全新库全链 migrate deploy 断于 8 月旧迁移是**已知存量问题，不在本计划修**。
- **Git 纪律**：禁 `git add -A`，只 add 显式路径；提交前 `git status --short` 必须为空；worktree 依赖软链流程照 P0。
- **测试纪律**：4 核不并行两个包全量 vitest；集成测试 hook 超时 180_000；vitest exit 1 是已知 birpc 伪影，判据 = 用例全绿；`grep -c` 0 命中返回非零会伪装结果；**内容检索只用 Grep 工具/python（本沙箱 shell grep 有劫持前科）**。
- **一次只允许一个 active 灰度 release**：创建第二个前必须先处置现有的（promote/rollback），否则 409。
- **publish/rollback 必须单事务**完成 status 翻转 + audit，杜绝「两个 active / 零 active」中间态落库。
- **发布价格地板**（spec §10，priceFloor = 成本 × 1.05）：仅对**有 costRateId** 的条目校验 `credits ≥ ceil(costYuan × 105)`；无 costRateId 条目跳过并在 diffSummary 标注。地板是 publish 的硬 400，不是提醒。

## Review Focus

1. **boot 自检误杀运营价目**（最危险）：P0 全网等价自检若对 v2 照跑 → boot 失配 → degraded → 全站静默回常量价，新价目形同虚设。→ Task 3 步骤 2 条件化测试。
2. **无 userId 透传的计价点静默走 global**：12 个计价点漏改任意一处，灰度用户在该档位被扣旧价。→ Task 6 步骤 1 挂点计数断言。
3. **空集假绿**：灰度名单 0 命中却创建成功；空 draft 被发布。→ Task 5 / Task 2 非空断言。
4. **发布事务原子性**：publish 半途失败留下两个 active 或零 active。→ Task 2 事务性测试。
5. **灰度窗口边界**：`endsAt` 之后回 global 表（不是常量兜底）；跨窗口预扣-结算按发起时落 meta 的 ruleVersion 执行。→ Task 3 步骤 4。

---

### Task 1: Schema 增量——灰度两表 + grayReleaseId 列

**Files:**
- Modify: `apps/server/prisma/schema.prisma`（定价域 :512 注释块追加两 model；PointTransaction 加一列；PriceListVersion 加反向关系）
- Create: `apps/server/prisma/migrations/<ts>_add_pricing_gray_release/migration.sql`
- Test: `apps/server/src/pricing/pricing-gray.schema.integration.test.ts`（照 P0 `pricing.schema.integration.test.ts` 模式，hook 超时 180_000）

**Interfaces:**
- Produces: `prisma.pricingGrayRelease` / `prisma.pricingGrayWhitelist` / `PointTransaction.grayReleaseId`。Task 2-7 全部消费。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { PrismaClient } from '@prisma/client'

describe('PricingGrayRelease schema', () => {
  it('release 创建 + 名单唯一约束 + 级联删除', async () => {
    const prisma = new PrismaClient()
    try {
      const ver = await prisma.priceListVersion.create({
        data: { version: 'gray-schema-test', status: 'draft',
          entries: { create: { capability: 'text', matchKey: 'text', credits: 5 } } },
      })
      const rel = await prisma.pricingGrayRelease.create({
        data: { versionId: ver.id, status: 'active', startsAt: new Date(), endsAt: new Date(Date.now() + 864e5) },
      })
      await prisma.pricingGrayWhitelist.create({ data: { releaseId: rel.id, userId: 'u1', phone: '13800000001' } })
      await expect(prisma.pricingGrayWhitelist.create({
        data: { releaseId: rel.id, userId: 'u1', phone: '13800000001' } })).rejects.toThrow()
      await prisma.pricingGrayRelease.delete({ where: { id: rel.id } })
      expect(await prisma.pricingGrayWhitelist.count({ where: { releaseId: rel.id } })).toBe(0)
      await prisma.priceListVersion.delete({ where: { id: ver.id } })
    } finally { await prisma.$disconnect() }
  })
  it('PointTransaction 可写 grayReleaseId', async () => {
    const prisma = new PrismaClient()
    try {
      const tx = await prisma.pointTransaction.create({
        data: { userId: 'gray-schema-u', amount: -5, reason: 't', kind: 'consume', grayReleaseId: 'rel_x' },
      })
      expect(tx.grayReleaseId).toBe('rel_x')
      await prisma.pointTransaction.delete({ where: { id: tx.id } })
    } finally { await prisma.$disconnect() }
  })
})
```

- [ ] **Step 2: 跑确认 FAIL**（`./node_modules/vitest/vitest.mjs run src/pricing/pricing-gray.schema.integration.test.ts`，table not found）
- [ ] **Step 3: schema 增量**

```prisma
// PointTransaction 追加（ruleVersion 之后）：
  grayReleaseId String?

// PriceListVersion 追加反向关系（entries 之后）：
  grayReleases PricingGrayRelease[]

// 定价域追加：
model PricingGrayRelease {
  id        String   @id @default(cuid())
  versionId String
  version   PriceListVersion @relation(fields: [versionId], references: [id])
  status    String   @default("active") // active | promoted | rolled_back | expired
  startsAt  DateTime
  endsAt    DateTime
  createdBy String   @default("admin")
  note      String?
  createdAt DateTime @default(now())
  whitelist PricingGrayWhitelist[]
  @@index([status, endsAt])
}

model PricingGrayWhitelist {
  id        String             @id @default(cuid())
  releaseId String
  release   PricingGrayRelease @relation(fields: [releaseId], references: [id], onDelete: Cascade)
  userId    String
  phone     String
  note      String?
  @@unique([releaseId, userId])
  @@index([userId])
}
```

- [ ] **Step 4: 迁移 SQL**（`prisma migrate dev --name add_pricing_gray_release` 生成或手写：2 CREATE TABLE + 1 ALTER TABLE + 3 CREATE INDEX）；临时库单执行验证（P0 Task 1 模式）
- [ ] **Step 5: 跑测试 PASS** → **Step 6: Commit**（显式路径：`apps/server/prisma/schema.prisma`、迁移目录、测试文件）

### Task 2: 发布流服务（draft / diff / publish / rollback）

**Files:**
- Create: `apps/server/src/pricing/pricing-publishing.service.ts`
- Modify: `apps/server/src/pricing/pricing.module.ts`（providers + exports 追加）
- Test: `apps/server/src/pricing/pricing-publishing.service.test.ts`

**Interfaces:**
- Consumes: PrismaService；`computeCreditsFromCost` 无关（本服务不定价，只搬运/校验运营给值）。
- Produces（Task 4/5/7 消费）:

```ts
export interface DiffSummary {
  draftVersion: string
  activeVersion: string | null
  added: number; removed: number; changed: number; unchanged: number
  maxIncrease: { matchKey: string; from: number; to: number; pct: number } | null
  maxDecrease: { matchKey: string; from: number; to: number; pct: number } | null
  floorViolations: { matchKey: string; credits: number; floor: number }[]
  missingCost: string[]        // 有 costRateId 引用但 CostRate 行缺失（发布时按跳过地板处理并告警）
  noCostCoverage: string[]     // 无 costRateId 的 changed 条目（地板跳过标注）
}
export interface PublishEntryInput { matchKey: string; capability: string; credits: number; basis?: string; costRateId?: string | null }

export class PricingPublishingService {
  createDraftFromActive(version: string, note: string): Promise<{ id: string; version: string; entries: number }>
    // version 字符串非空、与现有版本不重名（Prisma unique 冲突 → 400）；active 缺失 → 400「无可复制基线」
    // 复制 active 全部 entries（含 basis/costRateId），新版本 status='draft'
  listVersions(): Promise<Array<{ id; version; status; note; entryCount; publishedAt; createdAt }>>
  getDraft(draftId: string): Promise<{ id; version; status; note; entries: PublishEntryInput[] } | null>
  upsertEntries(draftId: string, entries: PublishEntryInput[]): Promise<number>
    // 仅 status='draft' 可改（否则 400）；credits 必须 Number.isInteger && > 0（否则 400）
  diffSummary(draftId: string): Promise<DiffSummary>
    // 对比当前 active（无 active → 全部计 added）；地板校验逐条算但**不在此抛**（预览用途）
  publish(draftId: string): Promise<{ version: string }>
    // $transaction 内：①draft 存在且 status='draft'，entries 非空（空 → 400，空集假绿防线）
    // ②逐条地板校验（有 costRateId 的）：credits < ceil(costYuan×105) → 400 附违规清单
    // ③draft→active+publishedAt；旧 active→archived（保证任意时刻至多一个 active）
    // ④adminAuditLog.create({ actor:'admin', action:'pricing-version.publish', resource:`price-list-version:<version>`, before, after })
  rollback(): Promise<{ version: string }>
    // 当前 active → archived；publishedAt 最新且非当前 active 的 archived → active
    // 无可回滚目标 → 400；auditLog action='pricing-version.rollback'
}
```

- [ ] **Step 1: 写失败测试**（核心用例，mock PrismaService 或用 sqlite 内存——照 `pricing.service.test.ts` 既有桩模式）：

```ts
// 必须覆盖的用例（每个都是行为断言，不是 smoke）：
// 1. createDraftFromActive：复制条数 = active 条数；basis/costRateId 逐字保留；重名 version → 400
// 2. upsertEntries：draft 可改；active 版本 → 400；credits=0 / 1.5 / NaN → 400
// 3. diffSummary：added/changed/removed 计数 + maxIncrease pct 计算（(to-from)/from）+ noCostCoverage 标注
// 4. publish 幸福路径：事务后旧 active=archived、draft=active+publishedAt、audit 落一条
// 5. publish 空 draft → 400（空集假绿防线：entries.length===0 直接拒）
// 6. publish 地板违规 → 400 且**状态零变化**（draft 仍 draft、旧 active 仍 active）——事务原子性
// 7. publish 后 diffSummary（对 v1）的 changed 计数 = v2 相对 v1 的实际变化数
// 8. rollback：v2 active 时回 v1；v1 是唯一版本 → 400
```

- [ ] **Step 2: 跑确认 FAIL** → **Step 3: 实现**（严格按 Interfaces 契约；publish/rollback 的 audit 用 `tx.adminAuditLog.create`，与 platform-channel.controller.ts:125-144 同模式）→ **Step 4: 跑 PASS** → **Step 5: pricing.module.ts providers/exports 追加** → **Step 6: Commit**

### Task 3: PricingService 适配——删 boot 自愈 + 自检条件化 + 灰度解析

**Files:**
- Modify: `apps/server/src/pricing/pricing.service.ts`（boot 流程 + quote 签名 + 缓存结构）
- Modify: `apps/server/src/pricing/pricing.core.ts`（`PricingQuote` 加可选字段）
- Modify: `apps/server/src/pricing/seed-pricing.ts`（删 :86-90 归档 updateMany——P1 发布流接管）
- Test: `apps/server/src/pricing/pricing.service.test.ts`（扩展）

**Interfaces:**
- Consumes: Task 1 的 `pricingGrayRelease/pricingGrayWhitelist`。
- Produces（Task 6 全部 12 计价点消费）:

```ts
// pricing.core.ts
export interface PricingQuote {
  credits: number
  ruleVersion: string
  /** 灰度命中时的 release id；global/兜底路径为 undefined（条件写入账本，避免破坏既有断言） */
  grayReleaseId?: string
}

// pricing.service.ts
async quote(q: PricingQuery, userId?: string): Promise<PricingQuote>
```

- [ ] **Step 1: 删 boot 自愈**。`onModuleInit` 删除 `seedPricing` import 与 :47-53 自愈分支；无 active 版本 → `degraded = true` + `console.error('[pricing] 无 active 价目表版本 — 已降级常量兜底（P1 起不再自播种，请走运营发布流）')`。`seed-pricing.ts` 删 :86-90 归档 updateMany 行（注释改为「P0 遗物：发布流接管后移除」）。
- [ ] **Step 2: 自检条件化**（本计划最关键的守卫改造）。自检前先查 active 版本条目的 basis 构成：

```ts
const [legacyRows, totalRows] = await this.prisma.$transaction([
  this.prisma.priceListEntry.count({ where: { versionId: version.id, basis: 'legacy-equivalent' } }),
  this.prisma.priceListEntry.count({ where: { versionId: version.id } }),
])
if (totalRows === 0) { this.degraded = true; console.error('[pricing] active 版本零条目 — 降级常量兜底'); return }
if (legacyRows === totalRows) {
  // 原 318 例全网等价自检原样保留（v1 路径不放松一丝）
  ... // 现有 mismatches 逻辑
} else {
  console.log(`[pricing] active 版本含运营定价（legacy-equivalent ${legacyRows}/${totalRows}）——跳过全网等价自检`)
}
```

- [ ] **Step 3: quote 加 userId + 灰度解析**。缓存扩展（30s 同 TTL，灰度与 global 各自独立缓存）：

```ts
interface GrayTable {
  releaseId: string
  version: string
  entries: Map<string, number>
  whitelist: Set<string>
  startsAt: number
  endsAt: number
  loadedAt: number
}
// loadGrayTable(): findFirst pricingGrayRelease where status='active' orderBy createdAt desc
//   → include version(include entries) + whitelist；DB 异常 → null（绝不 throw）
//   now ∈ [startsAt, endsAt] 才返回；窗口外返回 null（惰性过期，无写路径）

async quote(q, userId?): Promise<PricingQuote> {
  const legacy = legacyPriceOf(q)
  if (this.degraded || constants旁路) return { credits: legacy, ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK }
  try {
    const key = buildMatchKey(q)
    // ① 灰度优先：userId 存在且灰度表命中名单
    if (userId) {
      const gray = await this.loadGrayTable()
      if (gray && gray.whitelist.has(userId)) {
        const hit = gray.entries.get(key) ?? gray.entries.get(`${q.capability}:*`)
        if (hit !== undefined) return { credits: hit, ruleVersion: gray.version, grayReleaseId: gray.releaseId }
        // 灰度表缺行 → 落 global 继续解析（灰度版本必须全量枚举，缺行视为数据事故，warn）
        console.warn(`[pricing] 灰度表缺行 ${key}（release ${gray.releaseId}）— 落 global`)
      }
    }
    // ② global（现有逻辑原样）
    const table = await this.loadActiveTable()
    if (!table) throw new Error('no active price list version')
    const hit = table.entries.get(key) ?? table.entries.get(`${q.capability}:*`)
    if (hit === undefined) throw new Error(`no entry for ${key}`)
    return { credits: hit, ruleVersion: table.version }   // 无 grayReleaseId 字段
  } catch (err) { ...现有兜底 warn + return legacy... }
}
```

- [ ] **Step 4: 写测试**（在 pricing.service.test.ts 扩展；现有用例零改动必须继续全绿）：

```ts
// 新增用例：
// 1. quote(q) 不传 userId：返回对象**不含 grayReleaseId 键**（JSON 断言 or Object.keys 断言）——等价性锚
// 2. 灰度命中：whitelist 内 userId → credits=灰度值、ruleVersion=灰度版本、grayReleaseId=releaseId
// 3. 名单未命中 userId → global 值、无 grayReleaseId
// 4. 窗口边界：now < startsAt → global；now > endsAt → global（不是常量兜底——global 表仍可用）
// 5. 灰度表缺行该档 → 落 global 值 + warn（spy console.warn）
// 6. 灰度 DB 查询抛错 → global 值（绝不 throw）
// 7. 自检条件化：active 全 legacy-equivalent → 走等价自检（现有测试）；basis 混入运营价 → 跳过等价自检且 degraded=false
// 8. 无 active 版本 → degraded=true（自愈已删）
```

- [ ] **Step 5: 跑 `src/pricing` 全目录 PASS**（金标准 equivalence 4/4 必须原样绿）→ **Step 6: Commit**

### Task 4: 发布流 admin controller + 集成测试

**Files:**
- Create: `apps/server/src/admin/pricing-publishing.controller.ts`
- Modify: `apps/server/src/admin/admin.module.ts`（controllers 追加；imports 加 `PricingModule`——若 AdminModule 未 import，PricingModule 需 exports 发布服务）
- Test: `apps/server/src/admin/pricing-publishing.controller.sqlite.integration.test.ts`（照 platform-channel 同名测试模式：sqlite + 真实 guard）

**Interfaces:**
- Consumes: `PricingPublishingService`（Task 2）。
- Produces（Task 8 前端消费）: REST 端点（全部挂 `@UseGuards(AdminTokenGuard)`，前缀 `/api/admin/pricing/versions`）:

```
GET    /                       → listVersions()
POST   /draft                  body {version, note} → createDraftFromActive
GET    /:id                    → getDraft
PUT    /:id/entries            body {entries: PublishEntryInput[]} → upsertEntries（返回写入数）
GET    /:id/diff               → diffSummary
POST   /:id/publish            → publish
POST   /rollback               → rollback
```

- [ ] **Step 1: 写失败集成测试**（鉴权用例：无 token → 401（照 platform-channel 测试的 guard 用例）；幸福路径逐端点；publish 400 路径穿透（空 draft/地板违规）；audit 行落库断言 `action='pricing-version.publish'`）
- [ ] **Step 2: FAIL → Step 3: 实现 controller**（DTO 校验：version/note 非空字符串；entries 数组每项 matchKey/capability 非空 + credits 正整数）→ **Step 4: PASS** → **Step 5: admin.module.ts 注册** → **Step 6: Commit**

### Task 5: 白名单灰度服务 + admin controller

**Files:**
- Create: `apps/server/src/pricing/pricing-gray-release.service.ts`
- Create: `apps/server/src/admin/pricing-gray.controller.ts`
- Modify: `apps/server/src/pricing/pricing.module.ts`（providers/exports）；`apps/server/src/admin/admin.module.ts`（controllers）
- Test: `apps/server/src/pricing/pricing-gray-release.service.test.ts` + `apps/server/src/admin/pricing-gray.controller.sqlite.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 两表；User.phone（schema :13 `String @unique`）。
- Produces（Task 8 前端消费）:

```ts
export interface WhitelistPreview { hits: { userId: string; phone: string }[]; misses: string[] }
export class PricingGrayReleaseService {
  previewWhitelist(rawInput: string): Promise<WhitelistPreview>
    // rawInput 按换行/逗号/分号/空格切分 → trim → 去空去重；
    // 每个 token 原样作为 User.phone 精确匹配（不做 +86/横线猜测——录入人以库内存储格式为准，misses 显式列出）
  createRelease(input: { versionId; phones: string[]; startsAt?: Date; endsAt?: Date; note?: string }):
    Promise<{ releaseId: string; version: string; hits: number; window: { startsAt; endsAt } }>
    // ①hits 为空 → 400 附完整 misses 清单（spec §8.5 空集假绿防线，**硬规则**）
    // ②versionId 必须存在（404）且 **status='draft'**（灰度对象是未发布草案——active 版本无需灰度；400 说明）
    // ③窗口默认 startsAt=now、endsAt=now+7d（spec §8.5）；endsAt ≤ startsAt → 400
    // ④已存在 status='active' 的 release → 409（单一 active 灰度约束）
    // ⑤$transaction：release + whitelist 批量建 + auditLog('pricing-gray.create')
  listReleases(): Promise<Array<{ id; status; version; hits: number; startsAt; endsAt; note }>>
    // 读时惰性过期：status='active' 且 now > endsAt → update status='expired' 后返回
  getReport(releaseId: string): Promise<{
    releaseId; version; status; hits: number
    txCount: number; txAmountByCategory: Record<string, number>
    refundCount: number; byUser: Array<{ userId; consumeCount; consumeTotal }>
  }>
    // 全部按 PointTransaction.grayReleaseId = releaseId 聚合（零新增埋点，spec §8.5）
  promote(releaseId: string): Promise<{ version: string }>
    // release 必须 status='active'（否则 400）；内部调用 Task 2 publishing.publish(该 version 的 draftId 形态——
    // 实现：灰度版本 status 仍为 draft，promote = publishing 流程对它执行 publish（事务+地板+audit）+ release.status='promoted'
  rollback(releaseId: string): Promise<void>
    // release.status='rolled_back' + auditLog；白名单用户立即回 global（quote 读 status='active'，天然生效）
}
```

- [ ] **Step 1: 服务层失败测试**（核心用例）：

```ts
// 1. previewWhitelist：'13800000001, 13800000002\n13800000001' 去重；库内 2 命中 1 未命中 → misses 显式返回
// 2. createRelease 空命中 → 400 且 misses 全量列出（空集假绿防线：**断言 400 信息里含每个未命中号码**）
// 3. createRelease 幸福路径：whitelist 行数 = hits 数；默认窗口 = now ~ now+7d（±60s 容差）
// 4. 已有 active release → 409；versionId 是 active 版本 → 400
// 5. listReleases 读时惰性过期：endsAt 过去的 active → 返回前已置 expired
// 6. getReport：按 grayReleaseId 聚合计数正确（预置 3 条流水：2 consume 1 refund）
// 7. promote：版本转 active、旧 active 归档、release=promoted、audit 两条（publish + promote）
// 8. rollback：release 置 rolled_back；quote 对名单用户立即回 global 值
```

- [ ] **Step 2: FAIL → Step 3: 实现服务** → **Step 4: PASS**
- [ ] **Step 5: controller 失败测试 → 实现**（端点：`POST /api/admin/pricing/gray/preview`、`POST /api/admin/pricing/gray`、`GET /api/admin/pricing/gray`、`GET /:id/report`、`POST /:id/promote`、`POST /:id/rollback`；全挂 AdminTokenGuard）→ PASS → **Step 6: Commit**

### Task 6: 12 计价点 userId 透传 + grayReleaseId 条件落账

**Files:**
- Modify: `apps/server/src/points/point-tx.types.ts`（PointTxMeta 加 `grayReleaseId?: string | null`）
- Modify: `apps/server/src/points/points.service.ts`（consume/refundInTx 的 create data 条件附加）
- Modify: `apps/server/src/studio/studio.service.ts`（8 处）、`apps/server/src/canvas/material.service.ts`（3 处）、`apps/server/src/canvas/scene-composer.service.ts`（1 处）
- Test: 既有 39 文件**零改动必须全绿**；`apps/server/src/studio/studio.service.test.ts` 补 1 个灰度路径代表用例

**Interfaces:**
- Consumes: Task 3 `quote(q, userId?)` 返回 `grayReleaseId?`。
- Produces: 灰度命中时流水带 `grayReleaseId`，灰度报告（Task 5）有数据可聚。

- [ ] **Step 1: 挂点盘点（断言先行）**。用 **Grep 工具**（勿信 shell grep）数生产调用点：

```
pattern: this\.pricing\.quote\(   path: apps/server/src   glob: !(*.test).ts
```

预期 **恰 12 处**（studio 8 + material 3 + scene-composer 1）。实际数 ≠ 12 → 停下向 controller 报告差异，不许擅自决定谁多谁少（P0 曾有第 12 点漏编前科）。

- [ ] **Step 2: 类型与落账条件化**：

```ts
// point-tx.types.ts PointTxMeta 追加：
  /** 灰度命中时的 release id（undefined = 走 global，不写库——保持既有断言逐字不变） */
  grayReleaseId?: string | null

// points.service.ts consume 与 refundInTx 的 pointTransaction.create data 内追加一行：
          ...(meta?.grayReleaseId ? { grayReleaseId: meta.grayReleaseId } : {}),
```

- [ ] **Step 3: 12 处透传改造**（统一模式，逐点过）：

```ts
// 改前（典型形态）：
const quote = await this.pricing.quote({ capability: 'video', ... })
// 改后：
const quote = await this.pricing.quote({ capability: 'video', ... }, userId)
// consume meta 处（每点跟随其 consume/consumeMeta 调用）：
...(quote.grayReleaseId ? { grayReleaseId: quote.grayReleaseId } : {})
// 内联形态 `await this.pricing.quote(...).credits` 拆出 quote 变量再改。
// scene-composer.itemQuote 是逐 item 循环 → userId 从 batchGenerate 入参传入（该方法本就有 userId）。
```

- [ ] **Step 4: 回归 + 新增代表用例**：

```ts
// studio.service.test.ts 补 1 例：pricing mock 的 quote 返回 { credits: 5, ruleVersion: 'v2-launch', grayReleaseId: 'rel_1' }
// → 断言 consume 收到的 meta 含 grayReleaseId: 'rel_1'
// 同时断言 mock quote 被以 (queryObject, userId) 两参调用
// 全局判据：既有 39 个测试文件 339 用例零改动全绿（PRD：等价纪律）
```

- [ ] **Step 5: 跑 studio+canvas+points 靶向** → **Step 6: Commit**

### Task 7: v2 拉新期价目草案种子

**Files:**
- Create: `apps/server/src/pricing/seed-pricing-v2-draft.ts`
- Modify: `apps/server/prisma/seed-pricing-v2-draft.ts`（薄入口 + 自运行块，照 P0 seed-pricing 双文件模式）；`apps/server/package.json`（script `db:seed:pricing:v2-draft`，值照 `db:seed:pricing` 改文件名）
- Test: `apps/server/src/pricing/seed-pricing-v2-draft.test.ts`

**Interfaces:**
- Consumes: `enumeratePricingSpace()` / `buildMatchKey` / `legacyPriceOf` / `computeCreditsFromCost`（pricing.core）；`SEED_COST_RATES` 已入库的 CostRate 行（minimax-h3 768p:5s=2.86 / 2k:5s=4.65；seedream-5.0-pro 1K=0.30 / 2K=0.60；gpt-image-2 4K=2.93）。
- Produces: 幂等函数

```ts
export async function seedPricingV2Draft(
  prisma: PrismaClient | PrismaService,
  opts?: { version?: string },   // 默认 'v2-launch'
): Promise<{ version: string; changed: number; copied: number }>
```

**映射规则（全部来自 spec §6 拍板值 + §6.6 档位映射；这是本计划的业务拍板点，实现不得自行发明数值）：**

```ts
// ① image（模型无关档位，锚定 Seedream 5.0 Pro；4K 取 gpt-image-2 成本保守上界防亏损）：
//    1K: ceil(33×count)=33/66/99/132（33 = ceil(0.30×1.10/0.01)，与 §6.1 拉新期列一致）
//    2K: ceil(66×count)=66/132/198/264（= ceil(0.60×1.10/0.01)）
//    4K: ceil(322×count)=322/644/966/1288（322 = ceil(2.93×1.10/0.01)，§6.1 gpt-image-2 4K 列）
//    实现统一为 computeCreditsFromCost(costYuan, 11000) 从 CostRate 行现算，不硬编码 33/66/322；
//    costRateId 挂对应 CostRate 行（1K/2K→seedream-5.0-pro，4K→gpt-image-2），basis='launch-reprice'
// ② video：仅 minimax-h3 家族改价（768p/2k；480p H3 官方无此档照抄 v1；default/h3-max/h3-max-turbo 成本未实测照抄 v1——spec §6.2「fal 路线成本待渠道账单实测后补录」）：
//    基础档（mode '-'）：credits = computeCreditsFromCost(perSec × d, 11000)
//      perSec(768p) = 2.86/5 = 0.572；perSec(2k) = 4.65/5 = 0.93（用 5s 锚点行；测试断言与 10s/15s 行反推的 perSec 差 ≤ 0.001——上游线性定价一致性校验）
//    参考档（mode 'ref'）：v2base + (v1ref − v1base)（加价项保留——spec §6.6「参考图/视频加价项保留」）
//    costRateId 挂家族锚点行（768p→768p:5s，2k→2k:5s），basis='launch-reprice'
// ③ 其余全部档位（text / audio / image_variant / image_edit / 其余 video 家族）：逐字复制 v1 值，basis='legacy-equivalent'
// ④ 版本 status='draft'、note='P1 拉新期价目草案（spec §6/§7 拍板值，发布须走 §8.4 审批流 + §8.5 灰度）'
//    幂等：version 已存在且 status='draft' → 重新 upsert 全部条目；status 非 draft → 400 拒绝（不许偷改已发布版本）
// ⑤ 空间防御：与 P0 seed 同款——enumeratePricingSpace() 为空即 throw；逐条 credits 必须 Number.isInteger && > 0
```

- [ ] **Step 1: 失败测试**（核心断言）：

```ts
// 1. 变更计数精确：changed = image 12 + video minimax-h3 768p/2k 全部档（含 ref 档）——数来自 enumeratePricingSpace 实际枚举，测试里现场计算期望值，不硬编码
// 2. 抽样值断言：image:1K:1=33、image:2K:1=66、image:4K:1=322、
//    video:minimax-h3:768p:5:-:ri0:rv0=315、video:minimax-h3:2k:5:-:ri0:rv0=512、
//    video:minimax-h3:768p:10:-:ri0:rv0=630（computeCreditsFromCost 口径；spec §6.2 表 629 系手算舍入差，以函数口径为准并在测试注释说明）
// 3. ref 加价 delta 保留：v2 ref 档 − v2 base 档 === v1 ref 档 − v1 base 档（逐档）
// 4. 未映射家族逐字 = v1（default/h3-max/h3-max-turbo/audio/text/image_edit/image_variant）
// 5. status='draft'；对 active 无影响（发布前 v1 仍 active）
// 6. 已存在同名非 draft → 400
// 7. 地板自检（脚本内置）：映射后逐条 credits ≥ ceil(costYuan×105)（有 costRateId 者），违规即 throw——不许带病草案进审批
```

- [ ] **Step 2: FAIL → Step 3: 实现 + 薄入口 + script** → **Step 4: PASS** → **Step 5: Commit**

### Task 8: ops-console 前端——发布流页 + 灰度页

**Files:**
- Create: `apps/web/src/pages/admin/AdminPricingVersionsPage.vue` + `AdminPricingVersionsPage.test.ts`
- Create: `apps/web/src/pages/admin/AdminGrayReleasePage.vue` + `AdminGrayReleasePage.test.ts`
- Modify: `apps/web/src/services/admin-api.ts`（类型 + `adminApi` 方法，:178 起的模式）；`apps/web/src/router/index.ts`（:105-111 追加两条 admin 子路由）；`apps/web/src/pages/admin/AdminLayoutPage.vue`（:54-59 菜单追加两项）

**Interfaces:**
- Consumes: Task 4/5 全部 REST 端点；admin-api 既有 token 注入拦截器（:29-32）。

- [ ] **Step 1: admin-api.ts 扩展**（照 :140-146 类型 + :178 方法模式）：

```ts
export interface AdminPriceListVersion { id: string; version: string; status: string; note: string | null; entryCount: number; publishedAt: string | null; createdAt: string }
export interface AdminDiffSummary { /* 与 Task 2 DiffSummary 对齐 */ }
export interface AdminGrayRelease { id: string; status: string; version: string; hits: number; startsAt: string; endsAt: string; note: string | null }
// adminApi.pricingVersions = { list, createDraft, get, putEntries, diff, publish, rollback }
// adminApi.pricingGray = { preview, create, list, report, promote, rollback }
```

- [ ] **Step 2: AdminPricingVersionsPage.vue**（功能面：版本列表表格（状态徽标 draft/active/archived）→「复制 active 建草案」表单（version+note）→ 草案编辑（matchKey/credits 表格行内改值 + 保存）→「影响面预览」面板（diffSummary 全字段渲染，地板违规/成本未覆盖标红）→ 发布按钮（二次确认 + 显示 maxIncrease）→ 回滚按钮）。页面测试照 `AdminPricingPage.test.ts` 既有模式（mock adminApi，断言渲染与交互）。
- [ ] **Step 3: AdminGrayReleasePage.vue**（功能面：release 列表（状态/窗口/命中数）→ 创建表单（选 draft 版本下拉 + 名单 textarea + 窗口时间）→ **创建前必须先「预览命中」并把 N 命中 / M 未命中显式展示，未命中号码逐个列出，0 命中时创建按钮禁用**（spec §8.5 防线的前端表达）→ 报告抽屉（report 全字段）→ promote/rollback 二次确认）。
- [ ] **Step 4: 路由 + 菜单 + 页面测试 PASS** → **Step 5: `apps/web` 全量 vitest PASS**（唯一允许的本机全量）→ **Step 6: Commit**

### Task 9: 出口收口

- [ ] **Step 1: 金标准回归**——`src/pricing` 全目录：equivalence 4/4（318 例 v1 等价）原样绿；publishing/gray/seed-v2 全部新套件绿。
- [ ] **Step 2: 全 server `tsc --noEmit` TSC_EXIT=0**（controller 亲自复跑，不信任何自述——P0 两次 subagent 失实教训）。
- [ ] **Step 3: spec §9 P1 行打勾 + 本计划追加「落地形状偏差记录」小节**（实施中与计划的每一处偏离）。
- [ ] **Step 4: 终审（reasoning subagent）**→ findings 修复波（SDD 规则）→ scoped re-review。
- [ ] **Step 5: 停止于 push 前**——向用户呈现 Rulings 全集，等 push/PR 授权（跨 worktree 副作用需拍板）。

---

## Self-Review 记录

- **Spec 覆盖**：§8.4 发布流 → T2/T4/T8；§8.5 灰度（两表/解析顺序/录入校验/可观测/出口动作/单一 active/默认 7 天窗）→ T1/T3/T5/T8；§6/§7 v2 草案 → T7；§9 P1 出口判据「改价不发版」→ T2「改价不发版」主判据，「初始价目表白名单灰度」→ T5+T7（注：P0 已把等价表 promote 为 global active，P1 灰度的对象是 v2 拉新期草案，v1 无需灰度——这是 P0 等价迁移带来的排期简化，已与 spec 语义一致）；CostWatch → 明确挪 P2（本计划头声明）。§5.3 价格锁、§3.4 token 计费、§8.1/8.2 → P2/P3，不在本计划。
- **占位符扫描**：无 TBD/TODO；Task 6 的 12 处改造以「统一模式 + 挂点计数断言」表达（P0 Task 8/9 先例：机械接线用模式 + 计数验证，逐点行号在派发 brief 时以 Grep 实测为准）。
- **类型一致性**：`PricingQuote.grayReleaseId?`（T3 定义，T6 消费）；`PointTxMeta.grayReleaseId?`（T6 定义，points.service 写库）；`PublishEntryInput`（T2 定义，T4 DTO/T7 upsert 复用）；`DiffSummary`（T2 定义，T4/T8 消费）。
- **Review Focus ↔ 测试映射**：①→T3 步骤 4 用例 7；②→T6 步骤 1 计数断言 + 步骤 4 全绿判据；③→T5 步骤 1 用例 2 + T2 步骤 1 用例 5；④→T2 用例 6（状态零变化）+ publish 事务内审计；⑤→T3 用例 4。

---

## 落地形状偏差记录（2026-10-15 Task 9 收口时补记）

实施过程与本计划文本的每一处偏离，均已回写 spec 或在此说明。**spec 是权威，本计划是论证。**

| # | 计划文本 | 实际落地 | 裁定与代价 |
|---|---|---|---|
| D1 | T7 映射：image 4K = `ceil(322×count)` = 322 | **323**（按 `computeCreditsFromCost` 现算：`ceil(2.93×110)=ceil(322.3)=323`） | 计划/spec 手算错；实现按函数口径（计划自身要求「不硬编码」）⇒ 方向保守。**已回写 spec §6.1**。代价：多收 1 分/张 |
| D2 | T7 映射：video H3 768p/2k 全部档 `costRateId` 挂 5s 锚点行 | **4s 档（30 条）不挂 `costRateId`** | CostRate 无 4s 行；5s 锚点对 4s 算假地板（301 > 252）⇒ 挂上则发布流永远 400。走 `noCostCoverage` 标注进审批。**已回写 spec §6.2**。代价：30 条以「无成本覆盖」进审批，补 4s CostRate 行后恢复（P2 输入） |
| D3 | T8 Step 5：「`apps/web` 全量 vitest PASS（唯一允许的本机全量）」 | **本机 web 全量移交 CI，本机只跑定向 + `design-token.test.ts`** | 项目规范 `docs/agent/delivery.md`「本地测试纪律」第 2 条：全量 `pnpm test` 是 CI 的活（根 `test` = `pnpm -r --if-present test` 已递归覆盖 `apps/web`）。实测本机 web 全量 **52m52s** 未跑完，且与其他窗口抢 4 核CPU。计划条款与规范冲突时规范优先。代价：本机不再有 web 全量门，PR 的 `Build monorepo` 才是权威门 |
| D4 | T6 Step 1：预期恰 12 处 `this.pricing.quote(` | **17 个表达式 / 12 逻辑点** | 口径澄清：helper 分支（studio/material `platformFallbackQuote`、scene-composer `itemQuote`）各按 1 逻辑点计（P0 先例）。17 表达式全部透传。代价：无（口径记录，防后续误判「多改了 5 处」） |
| D5 | T6 未定义 batch 混合灰度语义 | **保守不带键**（批内全命中同一 release 才带） | 与 P0 混合 ruleVersion 裁定同构。代价：混合批次的灰度报告不归因到该 release |
| D6 | T5 `txAmountByCategory` 括注「按 kind」 | **按 `category`** | controller 派发文本笔误；`PointTransaction.category` 字段在位（schema :153），接口字段名即 `txAmountByCategory`。代价：无 |
| D7 | T1 用例 2：`userId: 'gray-schema-u'` 无 User 行 | 用例内补建/清理 User | brief 测试代码 FK 缺陷（spec/schema 权威）。断言数值未动。代价：无 |
| D8 | T3 未提 `seed-pricing` 归档 updateMany 的测试连带 | `pricing.seed.integration.test.ts` 改 17 行 | 原用例断言的正是 P1 明令删除的行为，不改必红；幂等断言全保留。代价：无 |
| D9 | T3Step 1 删boot 自愈 | boot 自播种删除，无 active 版本 → `degraded` + console.error；**但 `degraded` 非永久闩锁**，运行中检测到 active 版本即自愈（终审 Critical C2 修复，见 pricing.service.ts `degradedHealable` / `loadActiveTable`） | 按计划执行；**运维含义变化**：以后新环境必须先跑 `db:seed:pricing` 或经发布流建版本，否则启动即降级常量兜底（这是 P1 的设计意图，非缺陷）。恢复方式：**必须重启进程，或经自愈恢复**（发布流建出版本后，下一笔报价自动切换，`console.warn('[pricing] 已从降级恢复…')` 留痕）。终审修正：初版把 `degraded` 写成 boot 期永久闩锁，使 D9 承诺的「经发布流建版本」替代路径在运行中的进程里完全失效（发布成功、审计有记录、价格不生效、无任何提示）——发布流的存在意义正是 §9 出口判据「改价不发版」，故 `degraded` 必须能自愈。自愈仅限「boot 无 active 版本」这一成因；自检失配/零条目/自检异常的降级刻意保持闩锁（那些 active 版本本身不该被信，恢复等于绕过 P0 等价防线） |
