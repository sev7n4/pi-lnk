# P0 定价等价迁移（常量 → 可配置价目表服务）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]` syntax for tracking.

**Goal:** 把全部生成计价的「数值」从代码常量搬进数据库价目表（PriceListVersion/PriceListEntry + CostRate/MarginPolicy 三表），由 `PricingService.quote()` 统一供给；迁移后**每一个档位的行为与今天逐字符一致**（等价迁移），扣费流水带上 `ruleVersion` 可追溯哪版价目收的钱。

**Architecture:** 纯函数核心 `pricing.core.ts`（查询规范化 + 匹配键 + `legacyPriceOf()` 委托现有常量 + 成本→积分公式）；`pricing.space.ts` 枚举产品实际暴露的离散档位空间（种子与金标准测试同一来源）；`seed-pricing.ts` 用 `legacyPriceOf` 逐档生成 v1 价目（boot 时无 active 版本则自动 seed，P0 专属，P1 换运营发布流）；`PricingService` 读 active 版本（30s 缓存），表缺行/DB 异常/自检失配一律**降级常量兜底 + 告警**，`PRICING_SOURCE=constants` 一键旁路。11 个计价点（studio 8 + material 3，其中各含 1 个 platformFallback）改调 `quote()`，`ruleVersion` 经 `PointTxMeta` 落账。

**Tech Stack:** NestJS 10、Prisma 6（SQLite，手写 migration.sql）、vitest 3（unplugin-swc）、tsx

**Spec:** `docs/superpowers/specs/2026-10-13-pricing-baseline-config-design.md`（§4 数据模型 / §5 定价公式 / §9 P0 行）

## Global Constraints

- **等价迁移是第一纪律**：P0 不改任何价格数值。金标准判据 = 全网枚举空间内 `quote().credits === legacyPriceOf()` 且 `ruleVersion` 指向表版本（Task 6 出口）。
- **积分锚 ¥0.01/分**（1 分 = 1 分人民币）；人民币不进钱包；`computeCreditsFromCost(costYuan, marginBp) = ceil(costYuan × marginBp ÷ 100)`（marginBp 11000 = 1.10×）。
- **P0 不做**：价格地板/取整 ladder/灰度白名单（§8.5）/token 计费（§6.5）/运营后台/前端改动。`apps/web/src/constants/credits.ts` 与 membership 发放链路（签到/升级/邀请）**零改动**。
- **价目服务故障必须保功能**：任何异常路径 → 现有常量兜底 + `console.warn/error` 告警，绝不阻断生成。
- **禁止 `2>/dev/null` 吞错误**；禁 `git add -A`（只 add 显式路径）；分支纪律见 Task 0（worktree + PR + CI 绿 + squash）。
- 每步命令用绝对路径或 `git -C`；本机 4 核，不并行跑两个包的全量 vitest。

## Review Focus

- **空集假绿**：枚举空间为空/种子 0 行时「等价测试全绿」——Task 3/4/6 都必须断言 `space.length > 300`、种子行数 > 0、每行 credits 为正整数。
- **表外组合静默走旧价**：P1 改价后未枚举组合（BYOK 怪时长/怪分辨率）仍落常量 ⇒ P0 的 fallback 必须 warn + 可计数；Task 6 用 duration=7/20 的 case 钉住「miss → fallback → 等于 legacy」。
- **H3 参考图加价漏维度**：`reference_to_video` 是真实路径（#397 运动契约），枚举必须含 mode × refImageCount(0-6) × refVideoCount(0-2)；Task 2 用 ri6/rv1 case 钉住加价算术。
- **ruleVersion 断链**：扣费落了但 ruleVersion 为 null（meta 没传）⇒ Task 8/9 每处 consume 的 meta 都必须带 `ruleVersion: quote.ruleVersion`；Task 6 金标准断言命中时 `ruleVersion === 'v1-legacy-equivalent'`（不是 constants-fallback）。
- **fallback 路径从未真实触发**（假绿）⇒ Task 5 必须真实制造「表缺行」「findFirst 抛错」「无 active 版本」「自检失配」「constants 模式」五条路径并断言走了 legacy + 告警发出。

---

### Task 0: 开分支（worktree）

**Files:** 无（纯 git 操作）

- [ ] **Step 1: 同步 master 并开 worktree**

```bash
cd /Users/4seven/workspace/pi-lnk && git fetch origin
git worktree add .worktrees/p0-pricing-migration -b feat/p0-pricing-migration origin/master
```

- [ ] **Step 2: 装依赖（若报 ERR_PNPM_CODEBUDDY_BROKER_DENY 走借用绕行）**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/p0-pricing-migration && pnpm install --frozen-lockfile
```

若报 `ERR_PNPM_CODEBUDDY_BROKER_DENY`（symlink ENOENT/EEXIST）：别重试，按分支纪律「worktree 依赖借用」绕行——

```bash
MAIN=/Users/4seven/workspace/pi-lnk
WT=$MAIN/.worktrees/p0-pricing-migration
cd "$WT" && rm -rf node_modules packages/*/node_modules
ln -s $MAIN/node_modules node_modules
mkdir -p packages/shared/node_modules packages/agent/node_modules packages/server/node_modules
mkdir -p packages/server/node_modules/@lnkpi packages/agent/node_modules/@lnkpi
# 跨包软链必须指向**本 worktree** 的包（相对路径），否则测到的是主仓旧代码
ln -s ../../../shared packages/server/node_modules/@lnkpi/shared
ln -s ../../../agent  packages/server/node_modules/@lnkpi/agent
ln -s ../../../shared packages/agent/node_modules/@lnkpi/shared
# 验证（必须打印相对路径且文件存在）：
readlink packages/server/node_modules/@lnkpi/shared && ls packages/server/node_modules/@lnkpi/shared/src/index.ts
```

- [ ] **Step 3: 基线验证（改任何代码前）**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/p0-pricing-migration/apps/server && ./node_modules/vitest/vitest.mjs run src/points/points.service.test.ts
pnpm --filter @lnkpi/server exec prisma generate
```

Expected: 测试 PASS；prisma generate 成功（新模型依赖它）。

- [ ] **Step 4: Commit（无代码改动则跳过；直接进 Task 1）**

---

### Task 1: Schema 三表 + PointTransaction.ruleVersion + migration

**Files:**
- Modify: `apps/server/prisma/schema.prisma`（追加 4 个 model；PointTransaction 加 1 列）
- Create: `apps/server/prisma/migrations/20261013210000_add_pricing_tables/migration.sql`

**Interfaces:**
- Consumes: 无
- Produces: Prisma client 新模型 `PriceListVersion` / `PriceListEntry` / `CostRate` / `MarginPolicy`；`PointTransaction.ruleVersion` 列

- [ ] **Step 1: 写失败测试（集成：临时 SQLite 上建表并写入读出）**

```ts
// apps/server/src/pricing/pricing.schema.integration.test.ts
import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const serverRoot = path.resolve(__dirname, '../..')

describe('pricing schema against real SQLite', () => {
  let dir: string
  let prisma: PrismaClient

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-pricing-schema-'))
    const databaseUrl = `file:${path.join(dir, 'test.db')}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  })

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates pricing tables and PointTransaction.ruleVersion', async () => {
    const v = await prisma.priceListVersion.create({
      data: { version: 'v1-legacy-equivalent', status: 'active', note: 't' },
    })
    const entry = await prisma.priceListEntry.create({
      data: { versionId: v.id, capability: 'text', matchKey: 'text', credits: 5 },
    })
    expect(entry.credits).toBe(5)
    const user = await prisma.user.create({ data: { phone: '17300000001', nickname: 'p' } })
    const tx = await prisma.pointTransaction.create({
      data: { userId: user.id, amount: -5, reason: '文本生成', ruleVersion: 'v1-legacy-equivalent' },
    })
    expect(tx.ruleVersion).toBe('v1-legacy-equivalent')
    const rate = await prisma.costRate.create({
      data: { channel: 'platform', modelKey: 'seedream-5.0-pro', spec: '1K', unit: 'per_image', costYuan: 0.3 },
    })
    expect(rate.costYuan).toBeCloseTo(0.3)
    const policy = await prisma.marginPolicy.create({
      data: { phase: 'launch', anchorCents: 1, marginBp: 11000 },
    })
    expect(policy.marginBp).toBe(11000)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/server && ./node_modules/vitest/vitest.mjs run src/pricing/pricing.schema.integration.test.ts`
Expected: FAIL（PrismaClient 无 priceListVersion 模型 / 列不存在）

- [ ] **Step 3: 改 schema.prisma**

在 `model PointTransaction { ... }` 块内 `balanceAfter Int?` 之后加：

```prisma
  ruleVersion String?
```

在文件末尾（`GenerationRecord` 等 model 之后）追加：

```prisma
// ── 定价体系（P0 等价迁移 · spec 2026-10-13-pricing-baseline-config-design.md §4）──
// P0 口径：PriceListEntry.credits 是权威售价（显式值，seed 自 legacy 常量）；
// CostRate/MarginPolicy 为溯源与 P1 重定价地基，P0 不从它们推导售价。

model PriceListVersion {
  id          String           @id @default(cuid())
  version     String           @unique
  status      String           @default("draft") // draft | active | archived
  note        String?
  createdAt   DateTime         @default(now())
  publishedAt DateTime?
  entries     PriceListEntry[]
}

model PriceListEntry {
  id         String           @id @default(cuid())
  versionId  String
  version    PriceListVersion @relation(fields: [versionId], references: [id], onDelete: Cascade)
  capability String
  matchKey   String
  credits    Int
  basis      String           @default("legacy-equivalent")
  costRateId String?
  costRate   CostRate?        @relation(fields: [costRateId], references: [id])
  @@unique([versionId, matchKey])
  @@index([versionId, capability])
}

model CostRate {
  id        String          @id @default(cuid())
  channel   String
  modelKey  String
  spec      String
  unit      String
  costYuan  Float
  source    String          @default("official_list")
  note      String?
  createdAt DateTime        @default(now())
  entries   PriceListEntry[]
  @@unique([channel, modelKey, spec])
}

model MarginPolicy {
  id                  String   @id @default(cuid())
  phase               String   @unique
  anchorCents         Int      @default(1)
  marginBp            Int      @default(11000)
  capabilityOverrides String? // JSON，如 {"video":11000}；P1 重定价消费
  createdAt           DateTime @default(now())
}
```

- [ ] **Step 4: 手写 migration.sql**

```sql
-- P0 定价等价迁移：价目表三表 + 流水 ruleVersion（spec §4）
CREATE TABLE "PriceListVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" DATETIME
);
CREATE UNIQUE INDEX "PriceListVersion_version_key" ON "PriceListVersion"("version");

CREATE TABLE "PriceListEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "versionId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "matchKey" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "basis" TEXT NOT NULL DEFAULT 'legacy-equivalent',
    "costRateId" TEXT,
    CONSTRAINT "PriceListEntry_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "PriceListVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PriceListEntry_costRateId_fkey" FOREIGN KEY ("costRateId") REFERENCES "CostRate"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PriceListEntry_versionId_matchKey_key" ON "PriceListEntry"("versionId", "matchKey");
CREATE INDEX "PriceListEntry_versionId_capability_idx" ON "PriceListEntry"("versionId", "capability");

CREATE TABLE "CostRate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channel" TEXT NOT NULL,
    "modelKey" TEXT NOT NULL,
    "spec" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "costYuan" REAL NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'official_list',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "CostRate_channel_modelKey_spec_key" ON "CostRate"("channel", "modelKey", "spec");

CREATE TABLE "MarginPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phase" TEXT NOT NULL,
    "anchorCents" INTEGER NOT NULL DEFAULT 1,
    "marginBp" INTEGER NOT NULL DEFAULT 11000,
    "capabilityOverrides" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "MarginPolicy_phase_key" ON "MarginPolicy"("phase");

ALTER TABLE "PointTransaction" ADD COLUMN "ruleVersion" TEXT;
```

- [ ] **Step 5: regenerate + 跑测试**

```bash
pnpm --filter @lnkpi/server exec prisma generate
cd apps/server && ./node_modules/vitest/vitest.mjs run src/pricing/pricing.schema.integration.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/prisma/schema.prisma apps/server/prisma/migrations/20261013210000_add_pricing_tables/migration.sql apps/server/src/pricing/pricing.schema.integration.test.ts
git commit -m "feat(pricing): 价目表三表 + PointTransaction.ruleVersion（P0 等价迁移地基）"
```

---

### Task 2: pricing.core.ts 纯函数核心

**Files:**
- Create: `apps/server/src/pricing/pricing.core.ts`
- Test: `apps/server/src/pricing/pricing.core.test.ts`

**Interfaces:**
- Consumes: `@lnkpi/shared` 的 `imageGenerationCredits` / `IMAGE_EDIT_MODEL_PRICING` / `P1_IMAGE_EDIT_MODEL_KEY`；`../points/video-credits` 的 `videoCreditsForModel`
- Produces:
  - `type PricingCapability = 'text' | 'image' | 'image_variant' | 'image_edit' | 'video' | 'audio'`
  - `type AudioPriceKind = 'voice' | 'music'`
  - `type VideoPriceFamily = 'default' | 'minimax-h3' | 'h3-max' | 'h3-max-turbo'`
  - `interface PricingQuery { capability; modelKey?; count?; resolution?; audioKind?; duration?; videoMode?; referenceImageCount?; referenceVideoCount? }`
  - `interface PricingQuote { credits: number; ruleVersion: string }`
  - `const RULE_VERSION_CONSTANTS_FALLBACK = 'constants-fallback'`
  - `function videoPriceFamily(modelKey?: string): VideoPriceFamily`
  - `function canonicalVideoResolution(resolution?: string): '480p' | '768p' | '2k'`
  - `function canonicalImageResolution(resolution?: string): '1K' | '2K' | '4K'`
  - `function canonicalImageCount(count?: number): 1 | 2 | 3 | 4`
  - `function buildMatchKey(q: PricingQuery): string`
  - `function legacyPriceOf(q: PricingQuery): number`
  - `function computeCreditsFromCost(costYuan: number, marginBp: number): number`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/src/pricing/pricing.core.test.ts
import { describe, expect, it } from 'vitest'
import {
  buildMatchKey,
  canonicalImageCount,
  canonicalImageResolution,
  canonicalVideoResolution,
  computeCreditsFromCost,
  legacyPriceOf,
  videoPriceFamily,
  type PricingQuery,
} from './pricing.core'

describe('videoPriceFamily（与 videoCreditsForModel 的分支逐字对齐）', () => {
  it.each([
    ['minimax-h3', 'minimax-h3'],
    ['MINIMAX-H3', 'minimax-h3'],
    ['minimax-h3-max', 'h3-max'],
    ['h3-max', 'h3-max'],
    ['h3-max-turbo', 'h3-max-turbo'],
    ['H3-MAX-TURBO', 'h3-max-turbo'],
    ['seedance-2.0', 'default'],
    ['ch1::sora', 'default'],
    [undefined, 'default'],
  ])('modelKey %s → %s', (key, expected) => {
    expect(videoPriceFamily(key)).toBe(expected)
  })
})

describe('canonicalVideoResolution', () => {
  it.each([
    [undefined, '768p'],
    ['480P', '480p'],
    ['480p', '480p'],
    ['720p', '768p'],
    ['1080p', '768p'],
    ['2K', '2k'],
    ['2k', '2k'],
    ['weird', '768p'],
  ])('%s → %s', (input, expected) => {
    expect(canonicalVideoResolution(input)).toBe(expected)
  })
})

describe('canonicalImageResolution / Count（大小写敏感，镜像 FACTORS 查找）', () => {
  it.each([
    [undefined, '1K'],
    ['1K', '1K'],
    ['2K', '2K'],
    ['4K', '4K'],
    ['2k', '1K'],   // 小写不是 FACTORS 键 ⇒ legacy 回落 factor 1，规范化必须同果
    ['weird', '1K'],
  ])('image %s → %s', (input, expected) => {
    expect(canonicalImageResolution(input)).toBe(expected)
  })
  it.each([
    [undefined, 1],
    [0, 1],
    [-3, 1],
    [2.7, 2],
    [9, 4],
    [NaN, 1],
  ])('count %s → %s', (input, expected) => {
    expect(canonicalImageCount(input)).toBe(expected)
  })
})

describe('legacyPriceOf（= 现行常量，逐档钉死）', () => {
  it.each<PricingQuery>([
    { capability: 'text' },
    { capability: 'image', count: 1, resolution: '1K' },
    { capability: 'image', count: 3, resolution: '2K' },
    { capability: 'image', count: 2, resolution: '4K' },
    { capability: 'image', count: 1, resolution: '2k' }, // 小写 ⇒ 10（quirk 锁定）
    { capability: 'image_variant' },
    { capability: 'image_edit', modelKey: 'image2' },
    { capability: 'image_edit', modelKey: 'ch9::gpt-image-2' },
    { capability: 'image_edit' },
    { capability: 'audio', audioKind: 'voice' },
    { capability: 'audio', audioKind: 'music' },
    { capability: 'audio' },
    { capability: 'video', modelKey: 'seedance-2.0', duration: 5 },
    { capability: 'video', modelKey: 'h3-max-turbo', duration: 5, resolution: '480p' },
    { capability: 'video', modelKey: 'h3-max-turbo', duration: 5 },
    { capability: 'video', modelKey: 'h3-max', duration: 5, resolution: '480p' },
    { capability: 'video', modelKey: 'h3-max', duration: 5, resolution: '768p' },
    { capability: 'video', modelKey: 'minimax-h3', duration: 5, resolution: '768p' },
    { capability: 'video', modelKey: 'minimax-h3', duration: 5, resolution: '2K' },
    { capability: 'video', modelKey: 'minimax-h3', duration: 15, resolution: '768p' },
    { capability: 'video', modelKey: 'minimax-h3', duration: 4 },
    // H3 参考图加价：免费 5 张，超出的每张 +5；参考视频每个 +15
    { capability: 'video', modelKey: 'minimax-h3', duration: 5, resolution: '768p', videoMode: 'reference_to_video', referenceImageCount: 4 },
    { capability: 'video', modelKey: 'minimax-h3', duration: 5, resolution: '768p', videoMode: 'reference_to_video', referenceImageCount: 5 },
    { capability: 'video', modelKey: 'minimax-h3', duration: 5, resolution: '768p', videoMode: 'reference_to_video', referenceImageCount: 6, referenceVideoCount: 1 },
    // 非 reference 模式下 ri/rv 不参与加价
    { capability: 'video', modelKey: 'minimax-h3', duration: 5, resolution: '768p', videoMode: 'image_to_video', referenceImageCount: 3 },
  ])('case %j', (q) => {
    const expected: Record<string, number> = {
      '{"capability":"text"}': 5,
      '{"capability":"image","count":1,"resolution":"1K"}': 10,
      '{"capability":"image","count":3,"resolution":"2K"}': 45,
      '{"capability":"image","count":2,"resolution":"4K"}': 40,
      '{"capability":"image","count":1,"resolution":"2k"}': 10,
      '{"capability":"image_variant"}': 10,
      '{"capability":"image_edit","modelKey":"image2"}': 10,
      '{"capability":"image_edit","modelKey":"ch9::gpt-image-2"}': 10,
      '{"capability":"image_edit"}': 10,
      '{"capability":"audio","audioKind":"voice"}': 5,
      '{"capability":"audio","audioKind":"music"}': 15,
      '{"capability":"audio"}': 5,
      '{"capability":"video","modelKey":"seedance-2.0","duration":5}': 30,
      '{"capability":"video","modelKey":"h3-max-turbo","duration":5,"resolution":"480p"}': 30,
      '{"capability":"video","modelKey":"h3-max-turbo","duration":5}': 36,
      '{"capability":"video","modelKey":"h3-max","duration":5,"resolution":"480p"}': 36,
      '{"capability":"video","modelKey":"h3-max","duration":5,"resolution":"768p"}': 45,
      '{"capability":"video","modelKey":"minimax-h3","duration":5,"resolution":"768p"}': 36,
      '{"capability":"video","modelKey":"minimax-h3","duration":5,"resolution":"2K"}': 54,
      '{"capability":"video","modelKey":"minimax-h3","duration":15,"resolution":"768p"}': 84,
      '{"capability":"video","modelKey":"minimax-h3","duration":4}': 30,
      '{"capability":"video","modelKey":"minimax-h3","duration":5,"resolution":"768p","videoMode":"reference_to_video","referenceImageCount":4}': 36,
      '{"capability":"video","modelKey":"minimax-h3","duration":5,"resolution":"768p","videoMode":"reference_to_video","referenceImageCount":5}': 36,
      '{"capability":"video","modelKey":"minimax-h3","duration":5,"resolution":"768p","videoMode":"reference_to_video","referenceImageCount":6,"referenceVideoCount":1}': 56,
      '{"capability":"video","modelKey":"minimax-h3","duration":5,"resolution":"768p","videoMode":"image_to_video","referenceImageCount":3}': 36,
    }
    expect(legacyPriceOf(q)).toBe(expected[JSON.stringify(q)])
  })
})

describe('buildMatchKey', () => {
  it.each([
    [{ capability: 'text' } as PricingQuery, 'text'],
    [{ capability: 'image', count: 2, resolution: '2K' } as PricingQuery, 'image:2K:2'],
    [{ capability: 'image', count: 1 } as PricingQuery, 'image:1K:1'],
    [{ capability: 'image_variant' } as PricingQuery, 'image_variant'],
    [{ capability: 'image_edit', modelKey: 'image2' } as PricingQuery, 'image_edit:image2'],
    [{ capability: 'image_edit' } as PricingQuery, 'image_edit:image2'],
    [{ capability: 'audio', audioKind: 'music' } as PricingQuery, 'audio:music'],
    [{ capability: 'audio' } as PricingQuery, 'audio:voice'],
    [{ capability: 'video', modelKey: 'seedance-2.0', duration: 5 } as PricingQuery, 'video:default:768p:5:-:ri0:rv0'],
    [{ capability: 'video', modelKey: 'h3-max', duration: 5, resolution: '1080p' } as PricingQuery, 'video:h3-max:768p:5:-:ri0:rv0'],
    [{ capability: 'video', modelKey: 'minimax-h3', duration: 5, videoMode: 'reference_to_video', referenceImageCount: 6, referenceVideoCount: 1 } as PricingQuery, 'video:minimax-h3:768p:5:ref:ri6:rv1'],
    [{ capability: 'video', modelKey: 'minimax-h3', duration: 5, videoMode: 'image_to_video', referenceImageCount: 6 } as PricingQuery, 'video:minimax-h3:768p:5:-:ri0:rv0'],
  ])('case %j → %s', (q, expected) => {
    expect(buildMatchKey(q)).toBe(expected)
  })
})

describe('computeCreditsFromCost（1 分 = ¥0.01；marginBp 11000 = 1.10×）', () => {
  it.each([
    [0.3, 11000, 33],
    [0.6, 11000, 66],
    [2.86, 11000, 315],
    [4.65, 11000, 512],
    [0.072, 11000, 8],
    [0.0025, 11000, 1],
    [0.3, 25000, 75],
    [0.3, 35000, 105],
    // 0.12×110=13.2 ⇒ ceil 14（spec §6.1 的 13 是 floor 口径；P1 重定价以本函数为准并回改 spec）
    [0.12, 11000, 14],
  ])('cost %s × marginBp %s → %s', (cost, bp, expected) => {
    expect(computeCreditsFromCost(cost, bp)).toBe(expected)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/server && ./node_modules/vitest/vitest.mjs run src/pricing/pricing.core.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 pricing.core.ts**

```ts
/**
 * 定价纯函数核心（P0 等价迁移 · spec 2026-10-13-pricing-baseline-config-design.md §5）。
 *
 * 三条纪律：
 * 1. `legacyPriceOf` 是现行常量（shared/imageCredits、points/video-credits、
 *    shared/imageEditProfiles、text 5 / audio 5·15）的唯一委托出口——等价迁移的
 *    「旧行为」以它为准，金标准测试全网比对；
 * 2. 规范化函数（family/resolution/count）必须与 legacy 公式的**实际分支结果**
 *    逐档同果（大小写、未知值回落都算），否则表命中会静默改价；
 * 3. 本文件不碰 DB、不碰 Nest——种子、服务、测试三个消费方共用。
 */
import {
  IMAGE_EDIT_MODEL_PRICING,
  P1_IMAGE_EDIT_MODEL_KEY,
  imageGenerationCredits,
} from '@lnkpi/shared'
import { videoCreditsForModel } from '../points/video-credits'

export type PricingCapability = 'text' | 'image' | 'image_variant' | 'image_edit' | 'video' | 'audio'
export type AudioPriceKind = 'voice' | 'music'
export type VideoPriceFamily = 'default' | 'minimax-h3' | 'h3-max' | 'h3-max-turbo'

export interface PricingQuery {
  capability: PricingCapability
  modelKey?: string
  count?: number
  resolution?: string
  audioKind?: AudioPriceKind
  duration?: number
  videoMode?: string
  referenceImageCount?: number
  referenceVideoCount?: number
}

export interface PricingQuote {
  credits: number
  ruleVersion: string
}

/** 走常量兜底时落账的 ruleVersion 字面量（与表版本区分，便于审计「这笔钱哪来的」）。 */
export const RULE_VERSION_CONSTANTS_FALLBACK = 'constants-fallback'

/** 镜像 videoCreditsForModel 的家族分支（h3-max 家族 / 官方 H3 / 其余）。 */
export function videoPriceFamily(modelKey?: string): VideoPriceFamily {
  const key = (modelKey || '').toLowerCase()
  if (key.includes('h3-max')) return key.includes('turbo') ? 'h3-max-turbo' : 'h3-max'
  if (key === 'minimax-h3' || (key.includes('minimax-h3') && !key.includes('h3-max'))) return 'minimax-h3'
  return 'default'
}

/**
 * 视频分辨率规范化：legacy 只区分 480（h3-max 家族系数）与 2k（官方 H3 系数），
 * 其余（720p/1080p/缺省/未知）全部等价 768p 档。
 */
export function canonicalVideoResolution(resolution?: string): '480p' | '768p' | '2k' {
  const res = (resolution || '768p').toLowerCase()
  if (res.includes('480')) return '480p'
  if (res.includes('2k')) return '2k'
  return '768p'
}

/** 镜像 FACTORS 查找：键大小写敏感，未命中回落 1K。 */
export function canonicalImageResolution(resolution?: string): '1K' | '2K' | '4K' {
  if (resolution === '2K') return '2K'
  if (resolution === '4K') return '4K'
  return '1K'
}

/** 镜像 imageGenerationCredits 的 count 钳制（1..4，非有限数回落 1）。 */
export function canonicalImageCount(count?: number): 1 | 2 | 3 | 4 {
  const raw = Number(count)
  if (!Number.isFinite(raw)) return 1
  return Math.max(1, Math.min(4, Math.floor(raw))) as 1 | 2 | 3 | 4
}

function canonicalVideoDuration(duration?: number): number {
  return Number.isFinite(duration) ? Number(duration) : 5
}

/**
 * 匹配键：种子枚举、价目查询、金标准测试三处同源。
 * video 段 = family:resolution:duration:mode:ri:rv；非 reference_to_video 的
 * ri/rv 恒规范为 0（legacy 在该模式不看参考数）。
 */
export function buildMatchKey(q: PricingQuery): string {
  switch (q.capability) {
    case 'text':
      return 'text'
    case 'image':
      return `image:${canonicalImageResolution(q.resolution)}:${canonicalImageCount(q.count)}`
    case 'image_variant':
      return 'image_variant'
    case 'image_edit':
      return `image_edit:${q.modelKey ?? P1_IMAGE_EDIT_MODEL_KEY}`
    case 'audio':
      return `audio:${q.audioKind ?? 'voice'}`
    case 'video': {
      const family = videoPriceFamily(q.modelKey)
      const isRef = family === 'minimax-h3' && q.videoMode === 'reference_to_video'
      const ri = isRef ? Math.max(0, Math.floor(q.referenceImageCount ?? 0)) : 0
      const rv = isRef ? Math.max(0, Math.floor(q.referenceVideoCount ?? 0)) : 0
      return `video:${family}:${canonicalVideoResolution(q.resolution)}:${canonicalVideoDuration(q.duration)}:${isRef ? 'ref' : '-'}:ri${ri}:rv${rv}`
    }
  }
}

/** 现行常量行为（= 迁移前的代码路径）。任何查询都可求值，用于兜底与金标准比对。 */
export function legacyPriceOf(q: PricingQuery): number {
  switch (q.capability) {
    case 'text':
      return 5
    case 'image':
      return imageGenerationCredits({ count: q.count, resolution: q.resolution })
    case 'image_variant':
      return 10
    case 'image_edit':
      return IMAGE_EDIT_MODEL_PRICING[q.modelKey ?? P1_IMAGE_EDIT_MODEL_KEY] ?? 10
    case 'audio':
      return q.audioKind === 'music' ? 15 : 5
    case 'video':
      return videoCreditsForModel({
        duration: canonicalVideoDuration(q.duration),
        modelKey: q.modelKey,
        resolution: q.resolution,
        videoMode: q.videoMode,
        referenceImageCount: q.referenceImageCount,
        referenceVideoCount: q.referenceVideoCount,
      })
  }
}

/**
 * 成本 → 积分（spec §5.1）：credits = ceil(成本(元) × 毛利系数 ÷ 积分锚(0.01元))。
 * P1 重定价消费；P0 种子不用它（条目显式值 = legacyPriceOf）。
 */
export function computeCreditsFromCost(costYuan: number, marginBp: number): number {
  return Math.ceil((costYuan * marginBp) / 100)
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/server && ./node_modules/vitest/vitest.mjs run src/pricing/pricing.core.test.ts`
Expected: PASS（23 个 legacy case 全过；若某 case 数值不符，**先核对我给的期望值 vs 现行常量**，以现行常量为准改测试期望并在 commit message 说明）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pricing/pricing.core.ts apps/server/src/pricing/pricing.core.test.ts
git commit -m "feat(pricing): 纯函数核心（查询规范化/匹配键/legacy 委托/成本公式）"
```

---

### Task 3: pricing.space.ts 离散档位枚举

**Files:**
- Create: `apps/server/src/pricing/pricing.space.ts`
- Test: `apps/server/src/pricing/pricing.space.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `PricingQuery` / `buildMatchKey` / `legacyPriceOf`
- Produces:
  - `enumeratePricingSpace(): PricingQuery[]`（种子行空间；canonical 拼写）
  - `enumerateAliasCases(): PricingQuery[]`（别名/表外 case，仅金标准测试用）
  - `enumerateOutOfSpaceCases(): PricingQuery[]`（必须走 fallback 的 case）
  - 常量：`ENUMERATED_VIDEO_MODEL_KEYS` / `ENUMERATED_VIDEO_DURATIONS` / `ENUMERATED_VIDEO_RESOLUTIONS_CANONICAL` / `ENUMERATED_REF_IMAGE_COUNTS` / `ENUMERATED_REF_VIDEO_COUNTS` / `ENUMERATED_IMAGE_RESOLUTIONS` / `ENUMERATED_IMAGE_COUNTS`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/src/pricing/pricing.space.test.ts
import { describe, expect, it } from 'vitest'
import { buildMatchKey, legacyPriceOf } from './pricing.core'
import {
  enumerateAliasCases,
  enumerateOutOfSpaceCases,
  enumeratePricingSpace,
} from './pricing.space'

describe('enumeratePricingSpace', () => {
  const space = enumeratePricingSpace()

  it('非空且规模符合预期（空集假绿防线）', () => {
    expect(space.length).toBeGreaterThan(300)
  })

  it('每个 case 的 legacy 价格都是正整数', () => {
    for (const q of space) {
      const credits = legacyPriceOf(q)
      expect(Number.isInteger(credits), `${buildMatchKey(q)} → ${credits}`).toBe(true)
      expect(credits).toBeGreaterThan(0)
    }
  })

  it('匹配键唯一（否则种子 upsert 会静默合并行）', () => {
    const keys = space.map(buildMatchKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('覆盖全部能力与 H3 参考图维度', () => {
    const keys = new Set(space.map(buildMatchKey))
    expect(keys.has('text')).toBe(true)
    expect(keys.has('image:1K:1')).toBe(true)
    expect(keys.has('image:4K:4')).toBe(true)
    expect(keys.has('image_variant')).toBe(true)
    expect(keys.has('image_edit:image2')).toBe(true)
    expect(keys.has('image_edit:*')).toBe(true)
    expect(keys.has('audio:voice')).toBe(true)
    expect(keys.has('audio:music')).toBe(true)
    expect(keys.has('video:default:768p:5:-:ri0:rv0')).toBe(true)
    expect(keys.has('video:minimax-h3:2k:15:ref:ri6:rv2')).toBe(true)
  })
})

describe('enumerateAliasCases / enumerateOutOfSpaceCases', () => {
  it('别名 case 全部可求值且键命中某条种子行', () => {
    const seedKeys = new Set(enumeratePricingSpace().map(buildMatchKey))
    for (const q of enumerateAliasCases()) {
      expect(seedKeys.has(buildMatchKey(q)), buildMatchKey(q)).toBe(true)
    }
  })
  it('表外 case 的键不在种子行里（必须走 fallback）', () => {
    const seedKeys = new Set(enumeratePricingSpace().map(buildMatchKey))
    for (const q of enumerateOutOfSpaceCases()) {
      expect(seedKeys.has(buildMatchKey(q)), buildMatchKey(q)).toBe(false)
    }
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/server && ./node_modules/vitest/vitest.mjs run src/pricing/pricing.space.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 pricing.space.ts**

```ts
/**
 * 离散档位空间枚举（P0 · spec §6）。
 *
 * 唯一消费者：seed-pricing（写行）、金标准等价测试（逐档比对）。
 * 边界口径：
 * - 视频时长取前端 VIDEO_DURATION_OPTIONS（4/5/10/15）；表外时长（7/20…）
 *   归 enumerateOutOfSpaceCases，由 PricingService fallback 承接；
 * - 视频分辨率只枚举 canonical 三档（480p/768p/2k，720p·1080p 与 768p 同价），
 *   别名拼写归 enumerateAliasCases；
 * - 参考图加价仅官方 H3 + reference_to_video 生效（legacy 分支），
 *   ri 枚举 0..6（前 5 张免费）、rv 枚举 0..2。
 */
import type { PricingQuery } from './pricing.core'

export const ENUMERATED_IMAGE_RESOLUTIONS = ['1K', '2K', '4K'] as const
export const ENUMERATED_IMAGE_COUNTS = [1, 2, 3, 4] as const
export const ENUMERATED_VIDEO_MODEL_KEYS = ['seedance-2.0', 'h3-max', 'h3-max-turbo', 'minimax-h3'] as const
export const ENUMERATED_VIDEO_DURATIONS = [4, 5, 10, 15] as const
export const ENUMERATED_VIDEO_RESOLUTIONS_CANONICAL = ['480p', '768p', '2k'] as const
export const ENUMERATED_REF_IMAGE_COUNTS = [0, 1, 2, 3, 4, 5, 6] as const
export const ENUMERATED_REF_VIDEO_COUNTS = [0, 1, 2] as const

export function enumeratePricingSpace(): PricingQuery[] {
  const out: PricingQuery[] = []
  out.push({ capability: 'text' })
  for (const resolution of ENUMERATED_IMAGE_RESOLUTIONS) {
    for (const count of ENUMERATED_IMAGE_COUNTS) {
      out.push({ capability: 'image', resolution, count })
    }
  }
  out.push({ capability: 'image_variant' })
  // image_edit 的 '*' 默认行 = legacy 的 `?? 10`（BYOK 渠道编辑键走它）
  out.push({ capability: 'image_edit', modelKey: 'image2' })
  out.push({ capability: 'image_edit', modelKey: '*' })
  out.push({ capability: 'audio', audioKind: 'voice' })
  out.push({ capability: 'audio', audioKind: 'music' })
  for (const modelKey of ENUMERATED_VIDEO_MODEL_KEYS) {
    for (const resolution of ENUMERATED_VIDEO_RESOLUTIONS_CANONICAL) {
      for (const duration of ENUMERATED_VIDEO_DURATIONS) {
        out.push({ capability: 'video', modelKey, resolution, duration })
        if (modelKey === 'minimax-h3') {
          for (const ri of ENUMERATED_REF_IMAGE_COUNTS) {
            for (const rv of ENUMERATED_REF_VIDEO_COUNTS) {
              out.push({
                capability: 'video',
                modelKey,
                resolution,
                duration,
                videoMode: 'reference_to_video',
                referenceImageCount: ri,
                referenceVideoCount: rv,
              })
            }
          }
        }
      }
    }
  }
  return out
}

/** 别名拼写：规范化后必须命中同一条种子行且价格不变。 */
export function enumerateAliasCases(): PricingQuery[] {
  return [
    { capability: 'image', resolution: '720p', count: 1 },
    { capability: 'image', resolution: '2k', count: 1 },
    { capability: 'image', count: 2 },
    { capability: 'image', count: 9 },
    { capability: 'image_edit', modelKey: 'ch9::gpt-image-2' },
    { capability: 'audio' },
    { capability: 'video', modelKey: 'ch1::sora', duration: 5 },
    { capability: 'video', modelKey: 'MiniMax-H3', duration: 5 },
    { capability: 'video', modelKey: 'h3-max', resolution: '1080p', duration: 5 },
    { capability: 'video', modelKey: 'minimax-h3', duration: 5, videoMode: 'image_to_video', referenceImageCount: 3 },
    { capability: 'video', modelKey: 'h3-max', resolution: '480P', duration: 10 },
  ]
}

/** 表外组合：键不在种子行 ⇒ 必须走 fallback 且价格等于 legacy。 */
export function enumerateOutOfSpaceCases(): PricingQuery[] {
  return [
    { capability: 'video', modelKey: 'seedance-2.0', duration: 7 },
    { capability: 'video', modelKey: 'seedance-2.0', duration: 20 },
    { capability: 'video', modelKey: 'minimax-h3', duration: 6, resolution: '768p' },
    { capability: 'image', count: 1, resolution: '8K' },
  ]
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/server && ./node_modules/vitest/vitest.mjs run src/pricing/pricing.space.test.ts`
Expected: PASS。若「匹配键唯一」失败：说明有 canonical 碰撞，回到 Task 2 核规范化函数。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pricing/pricing.space.ts apps/server/src/pricing/pricing.space.test.ts
git commit -m "feat(pricing): 离散档位空间枚举（种子与金标准同源）"
```

---

### Task 4: seed-pricing.ts 种子脚本 + 集成测试

**Files:**
- Create: `apps/server/prisma/seed-pricing.ts`
- Test: `apps/server/src/pricing/pricing.seed.integration.test.ts`
- Modify: `apps/server/package.json`（加 `db:seed:pricing` script）

**Interfaces:**
- Consumes: Task 2/3 的 `buildMatchKey` / `legacyPriceOf` / `enumeratePricingSpace`
- Produces:
  - `export const PRICING_VERSION_V1 = 'v1-legacy-equivalent'`
  - `export async function seedPricing(prisma: PrismaClient): Promise<{ version: string; entries: number }>`（幂等 upsert；同时 seed CostRate/MarginPolicy；把其他 active 版本归档）
  - `export const SEED_COST_RATES: Array<{ channel; modelKey; spec; unit; costYuan; source; note? }>`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/src/pricing/pricing.seed.integration.test.ts
import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildMatchKey, legacyPriceOf } from './pricing.core'
import { enumeratePricingSpace } from './pricing.space'
import { PRICING_VERSION_V1, seedPricing } from '../../prisma/seed-pricing'

const serverRoot = path.resolve(__dirname, '../..')

describe('seedPricing against real SQLite', () => {
  let dir: string
  let prisma: PrismaClient

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-pricing-seed-'))
    const databaseUrl = `file:${path.join(dir, 'test.db')}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  })

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  it('seeds every enumerated case with legacy-identical credits (idempotent)', async () => {
    const first = await seedPricing(prisma)
    const space = enumeratePricingSpace()
    expect(first.version).toBe(PRICING_VERSION_V1)
    expect(first.entries).toBe(new Set(space.map(buildMatchKey)).size)

    const rows = await prisma.priceListEntry.findMany({
      where: { version: { version: PRICING_VERSION_V1 } },
    })
    expect(rows.length).toBe(first.entries)
    for (const q of space) {
      const row = rows.find((r) => r.matchKey === buildMatchKey(q))
      expect(row, buildMatchKey(q)).toBeDefined()
      expect(row!.credits).toBe(legacyPriceOf(q))
    }

    const second = await seedPricing(prisma)
    expect(second.entries).toBe(first.entries)
    const after = await prisma.priceListEntry.count()
    expect(after).toBe(first.entries)
  })

  it('seeds exactly one active version and launch margin policy', async () => {
    const active = await prisma.priceListVersion.findMany({ where: { status: 'active' } })
    expect(active.length).toBe(1)
    const policy = await prisma.marginPolicy.findUnique({ where: { phase: 'launch' } })
    expect(policy?.marginBp).toBe(11000)
    expect(policy?.anchorCents).toBe(1)
    const rates = await prisma.costRate.count()
    expect(rates).toBeGreaterThanOrEqual(15)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/server && ./node_modules/vitest/vitest.mjs run src/pricing/pricing.seed.integration.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 seed-pricing.ts**

```ts
/**
 * 价目表种子（P0 · spec §6/§9）。
 *
 * v1 = legacy-equivalent：逐档调 legacyPriceOf 落显式值——表与常量**同源同值**，
 * 这是「等价迁移」的定义。P1 起改价走运营发布流（§8.4），本脚本退役为历史工具。
 *
 * boot 时若无 active 版本，PricingService 会调用本函数自愈（P0 专属便利，
 * 见 pricing.service.ts 注释）；手动执行：`pnpm --filter @lnkpi/server db:seed:pricing`。
 */
import { PrismaClient } from '@prisma/client'
import { buildMatchKey, legacyPriceOf } from '../src/pricing/pricing.core'
import { enumeratePricingSpace } from '../src/pricing/pricing.space'

export const PRICING_VERSION_V1 = 'v1-legacy-equivalent'

/** 上游官方挂牌成本（spec §2，2026-10-13 各官方定价页实证）。溯源用，P0 不推导售价。 */
export const SEED_COST_RATES = [
  { channel: 'platform', modelKey: 'seedream-5.0-pro', spec: '1K', unit: 'per_image', costYuan: 0.3 },
  { channel: 'platform', modelKey: 'seedream-5.0-pro', spec: '2K', unit: 'per_image', costYuan: 0.6 },
  { channel: 'platform', modelKey: 'seedream-5.0-flash', spec: '1K', unit: 'per_image', costYuan: 0.12 },
  { channel: 'platform', modelKey: 'gpt-image-2', spec: '1024', unit: 'per_image', costYuan: 0.072 },
  { channel: 'platform', modelKey: 'gpt-image-2', spec: '2K', unit: 'per_image', costYuan: 0.572 },
  { channel: 'platform', modelKey: 'gpt-image-2', spec: '4K', unit: 'per_image', costYuan: 2.93 },
  { channel: 'platform', modelKey: 'minimax-h3', spec: '768p:5s', unit: 'per_video', costYuan: 2.86 },
  { channel: 'platform', modelKey: 'minimax-h3', spec: '2k:5s', unit: 'per_video', costYuan: 4.65 },
  { channel: 'platform', modelKey: 'minimax-h3', spec: '768p:10s', unit: 'per_video', costYuan: 5.72 },
  { channel: 'platform', modelKey: 'minimax-h3', spec: '768p:15s', unit: 'per_video', costYuan: 8.58 },
  { channel: 'platform', modelKey: 'h3-max', spec: '480p:5s', unit: 'per_video', costYuan: 1.79, note: 'fal 路线待渠道账单实测' },
  { channel: 'platform', modelKey: 'seedance-2.0-fast', spec: '480p:5s', unit: 'per_video', costYuan: 1.93 },
  { channel: 'platform', modelKey: 'step-tts-mini', spec: 'per_100_chars', unit: 'per_call', costYuan: 0.009 },
  { channel: 'platform', modelKey: 'stepaudio-3-tts', spec: 'per_100_chars', unit: 'per_call', costYuan: 0.025 },
  { channel: 'platform', modelKey: 'minimax-speech-2.8-hd', spec: 'per_100_chars', unit: 'per_call', costYuan: 0.0715, note: '超价格地板，仅 BYOK' },
  { channel: 'platform', modelKey: 'step-3.5-flash', spec: 'per_1m_tokens_in', unit: 'per_1m_tokens', costYuan: 0.7 },
  { channel: 'platform', modelKey: 'step-3.5-flash', spec: 'per_1m_tokens_out', unit: 'per_1m_tokens', costYuan: 2.1 },
  { channel: 'platform', modelKey: 'stepaudio-3-music', spec: 'per_song', unit: 'per_call', costYuan: 0, note: '限免窗口，watchWindow' },
] as const

export async function seedPricing(prisma: PrismaClient): Promise<{ version: string; entries: number }> {
  const space = enumeratePricingSpace()
  if (space.length === 0) throw new Error('seedPricing: 枚举空间为空——拒绝写空价目表（空集假绿防线）')

  const version = await prisma.priceListVersion.upsert({
    where: { version: PRICING_VERSION_V1 },
    update: { status: 'active' },
    create: {
      version: PRICING_VERSION_V1,
      status: 'active',
      note: 'P0 等价迁移：与代码常量逐档一致（legacy-equivalent）',
      publishedAt: new Date(),
    },
  })

  let entries = 0
  for (const q of space) {
    const matchKey = buildMatchKey(q)
    const credits = legacyPriceOf(q)
    if (!Number.isInteger(credits) || credits <= 0) {
      throw new Error(`seedPricing: 非法积分值 ${matchKey} → ${credits}`)
    }
    await prisma.priceListEntry.upsert({
      where: { versionId_matchKey: { versionId: version.id, matchKey } },
      update: { credits },
      create: { versionId: version.id, capability: q.capability, matchKey, credits, basis: 'legacy-equivalent' },
    })
    entries++
  }

  for (const r of SEED_COST_RATES) {
    await prisma.costRate.upsert({
      where: { channel_modelKey_spec: { channel: r.channel, modelKey: r.modelKey, spec: r.spec } },
      update: { costYuan: r.costYuan, note: 'note' in r ? r.note : null },
      create: { ...r, note: 'note' in r ? r.note : null },
    })
  }
  await prisma.marginPolicy.upsert({
    where: { phase: 'launch' },
    update: { marginBp: 11000, anchorCents: 1 },
    create: { phase: 'launch', anchorCents: 1, marginBp: 11000 },
  })

  // P0 单一 active 版本：其余一律归档（P1 发布流接管后删除本行）
  await prisma.priceListVersion.updateMany({
    where: { status: 'active', version: { not: PRICING_VERSION_V1 } },
    data: { status: 'archived' },
  })
  return { version: PRICING_VERSION_V1, entries }
}

if (process.argv[1] && process.argv[1].endsWith('seed-pricing.ts')) {
  seedPricing(new PrismaClient())
    .then((r) => console.log(`✅ pricing seed: ${r.version} active, ${r.entries} entries`))
    .catch((err) => {
      console.error('❌ pricing seed failed:', err)
      process.exitCode = 1
    })
    .finally(() => void new PrismaClient().$disconnect())
}
```

- [ ] **Step 4: package.json 加 script**

在 `apps/server/package.json` 的 scripts 里 `db:seed` 之后加：

```json
"db:seed:pricing": "tsx prisma/seed-pricing.ts",
```

- [ ] **Step 5: 运行确认通过**

Run: `cd apps/server && ./node_modules/vitest/vitest.mjs run src/pricing/pricing.seed.integration.test.ts`
Expected: PASS（幂等：第二次 entries 不变、总行数不变）

- [ ] **Step 6: Commit**

```bash
git add apps/server/prisma/seed-pricing.ts apps/server/src/pricing/pricing.seed.integration.test.ts apps/server/package.json
git commit -m "feat(pricing): v1 种子脚本（legacy 逐档显式值 + 官方成本溯源）"
```

---

### Task 5: PricingService（查询/缓存/兜底/自检）

**Files:**
- Create: `apps/server/src/pricing/pricing.service.ts`
- Create: `apps/server/src/pricing/pricing.module.ts`
- Create: `apps/server/src/pricing/pricing.test-utils.ts`
- Test: `apps/server/src/pricing/pricing.service.test.ts`

**Interfaces:**
- Consumes: Task 2/3/4 的全部导出；`PrismaService`
- Produces:
  - `class PricingService implements OnModuleInit`，方法 `async quote(q: PricingQuery): Promise<PricingQuote>`
  - `PricingModule`（providers/exports: PricingService）
  - `createPricingMock()`（测试替身：quote 委托 legacyPriceOf，ruleVersion 固定 `'test-constants'`）

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/src/pricing/pricing.service.test.ts
import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PricingService } from './pricing.service'
import { RULE_VERSION_CONSTANTS_FALLBACK, buildMatchKey, legacyPriceOf } from './pricing.core'
import { enumeratePricingSpace } from './pricing.space'
import type { PrismaService } from '../prisma/prisma.service'

const V = 'v1-legacy-equivalent'

function fakePrisma(
  entries: Array<{ matchKey: string; credits: number }> | null,
  opts: { throws?: boolean } = {},
) {
  const findFirst = vi.fn(async () => {
    if (opts.throws) throw new Error('db down')
    if (!entries) return null
    return {
      id: 'plv1',
      version: V,
      status: 'active',
      entries: entries.map((e, i) => ({ id: `e${i}`, ...e })),
    }
  })
  return { prisma: { priceListVersion: { findFirst } } as unknown as PrismaService, findFirst }
}

function entryMap(credits: Record<string, number>) {
  return Object.entries(credits).map(([matchKey, c]) => ({ matchKey, credits: c }))
}

describe('PricingService.quote', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.PRICING_SOURCE
  })

  it('表命中返回表值与版本号', async () => {
    const { prisma } = fakePrisma(entryMap({ text: 5, 'video:default:768p:5:-:ri0:rv0': 30 }))
    const svc = new PricingService(prisma)
    await expect(svc.quote({ capability: 'text' })).resolves.toEqual({ credits: 5, ruleVersion: V })
    await expect(svc.quote({ capability: 'video', modelKey: 'seedance-2.0', duration: 5 })).resolves.toEqual({
      credits: 30,
      ruleVersion: V,
    })
  })

  it('image_edit 未命中具体键时落 capability 默认行 *', async () => {
    const { prisma } = fakePrisma(entryMap({ 'image_edit:*': 10 }))
    const svc = new PricingService(prisma)
    await expect(svc.quote({ capability: 'image_edit', modelKey: 'ch9::x' })).resolves.toEqual({
      credits: 10,
      ruleVersion: V,
    })
  })

  it('表缺行 → 常量兜底 + warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { prisma } = fakePrisma(entryMap({ text: 5 }))
    const svc = new PricingService(prisma)
    await expect(svc.quote({ capability: 'video', modelKey: 'seedance-2.0', duration: 5 })).resolves.toEqual({
      credits: 30,
      ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK,
    })
    expect(warn).toHaveBeenCalled()
  })

  it('DB 抛错 → 常量兜底 + warn（绝不抛给调用方）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { prisma } = fakePrisma(null, { throws: true })
    const svc = new PricingService(prisma)
    await expect(svc.quote({ capability: 'text' })).resolves.toEqual({
      credits: 5,
      ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK,
    })
    expect(warn).toHaveBeenCalled()
  })

  it('无 active 版本 → 常量兜底', async () => {
    const { prisma } = fakePrisma(null)
    const svc = new PricingService(prisma)
    await expect(svc.quote({ capability: 'audio', audioKind: 'music' })).resolves.toEqual({
      credits: 15,
      ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK,
    })
  })

  it('PRICING_SOURCE=constants 旁路 DB 且不调 findFirst', async () => {
    process.env.PRICING_SOURCE = 'constants'
    const { prisma, findFirst } = fakePrisma(entryMap({ text: 999 }))
    const svc = new PricingService(prisma)
    await expect(svc.quote({ capability: 'text' })).resolves.toEqual({
      credits: 5,
      ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK,
    })
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('30s 内重复查询命中缓存（findFirst 只调一次）', async () => {
    const { prisma, findFirst } = fakePrisma(entryMap({ text: 5 }))
    const svc = new PricingService(prisma)
    await svc.quote({ capability: 'text' })
    await svc.quote({ capability: 'text' })
    expect(findFirst).toHaveBeenCalledTimes(1)
  })
})

describe('PricingService.onModuleInit 启动自检', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.PRICING_SOURCE
  })

  it('表与 legacy 全网一致 → 不降级 + 日志通过', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const space = enumeratePricingSpace()
    const entries = space.map((q) => ({ matchKey: buildMatchKey(q), credits: legacyPriceOf(q) }))
    const { prisma } = fakePrisma(entries)
    const svc = new PricingService(prisma)
    await svc.onModuleInit()
    const quote = await svc.quote({ capability: 'text' })
    expect(quote.ruleVersion).toBe(V)
    expect(log).toHaveBeenCalled()
  })

  it('表值与 legacy 失配 → 自动降级常量（后续 quote 不再信表）', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { prisma } = fakePrisma(entryMap({ text: 99, 'video:default:768p:5:-:ri0:rv0': 30 }))
    const svc = new PricingService(prisma)
    await svc.onModuleInit()
    await expect(svc.quote({ capability: 'text' })).resolves.toEqual({
      credits: 5,
      ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK,
    })
    expect(err).toHaveBeenCalled()
  })

  it('PRICING_SOURCE=constants → 自检直接跳过', async () => {
    process.env.PRICING_SOURCE = 'constants'
    const { prisma, findFirst } = fakePrisma(null)
    const svc = new PricingService(prisma)
    await svc.onModuleInit()
    expect(findFirst).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/server && ./node_modules/vitest/vitest.mjs run src/pricing/pricing.service.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 pricing.service.ts**

```ts
/**
 * 价目表服务（P0 · spec §4/§9）。
 *
 * 解析顺序：active 版本精确行 → capability 默认行（matchKey 以 `:*` 结尾，
 * 目前仅 image_edit 有，镜像 legacy 的 `?? 10`）→ 常量兜底 + warn。
 *
 * 四条保底路径（全部真实可测，见 pricing.service.test.ts）：
 * 表缺行 / DB 抛错 / 无 active 版本 / 启动自检失配 ⇒ 常量兜底。
 *
 * ⚠️ P0 专属：boot 时若无 active 版本，调用 seedPricing 自愈（部署零手工步）。
 * P1 运营发布流（spec §8.4）上线后删除自愈分支，改为「无版本 = 告警 + 全量兜底」。
 */
import { Inject, Injectable, OnModuleInit } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import {
  RULE_VERSION_CONSTANTS_FALLBACK,
  buildMatchKey,
  legacyPriceOf,
  type PricingQuery,
  type PricingQuote,
} from './pricing.core'
import { enumeratePricingSpace } from './pricing.space'
import { seedPricing } from '../../prisma/seed-pricing'

const CACHE_TTL_MS = 30_000

interface PriceTable {
  version: string
  entries: Map<string, number>
  loadedAt: number
}

@Injectable()
export class PricingService implements OnModuleInit {
  private cache: PriceTable | null = null
  private degraded = false

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    if (process.env.PRICING_SOURCE === 'constants') {
      console.log('[pricing] PRICING_SOURCE=constants — 价目表旁路，全部走常量兜底')
      return
    }
    try {
      let table = await this.loadActiveTable()
      if (!table) {
        // P0 自愈：无 active 版本时按 legacy 常量播种（幂等；PrismaService extends PrismaClient，无需强转）。
        // P1 删除本分支，改为告警 + 全量兜底。
        const seeded = await seedPricing(this.prisma)
        console.warn(`[pricing] boot 未发现 active 版本，已自播种 ${seeded.version}（${seeded.entries} 行）`)
        table = await this.loadActiveTable()
      }
      if (!table) {
        this.degraded = true
        console.error('[pricing] 无 active 价目表版本 — 已降级常量兜底')
        return
      }
      const space = enumeratePricingSpace()
      const mismatches = space.filter((q) => {
        const row = table!.entries.get(buildMatchKey(q))
        return row === undefined || row !== legacyPriceOf(q)
      })
      if (mismatches.length > 0) {
        this.degraded = true
        console.error(
          `[pricing] 启动自检失配 ${mismatches.length}/${space.length} 例（首例 ${buildMatchKey(mismatches[0])}）— 已降级常量兜底`,
        )
        return
      }
      console.log(`[pricing] 启动自检通过：${space.length} 例全网等价（版本 ${table.version}）`)
    } catch (err) {
      this.degraded = true
      console.error('[pricing] 启动自检异常，已降级常量兜底：', err)
    }
  }

  /** 报价。任何失败路径都返回常量兜底值，绝不 throw。 */
  async quote(q: PricingQuery): Promise<PricingQuote> {
    const legacy = legacyPriceOf(q)
    if (this.degraded || process.env.PRICING_SOURCE === 'constants') {
      return { credits: legacy, ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK }
    }
    try {
      const table = await this.loadActiveTable()
      if (!table) throw new Error('no active price list version')
      const key = buildMatchKey(q)
      const hit = table.entries.get(key) ?? table.entries.get(`${q.capability}:*`)
      if (hit === undefined) throw new Error(`no entry for ${key}`)
      return { credits: hit, ruleVersion: table.version }
    } catch (err) {
      console.warn(
        `[pricing] 查询落常量兜底（${buildMatchKey(q)}）：`,
        err instanceof Error ? err.message : err,
      )
      return { credits: legacy, ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK }
    }
  }

  private async loadActiveTable(): Promise<PriceTable | null> {
    if (this.cache && Date.now() - this.cache.loadedAt < CACHE_TTL_MS) return this.cache
    const version = await this.prisma.priceListVersion.findFirst({
      where: { status: 'active' },
      include: { entries: true },
    })
    if (!version) {
      this.cache = null
      return null
    }
    const entries = new Map<string, number>()
    for (const e of version.entries) entries.set(e.matchKey, e.credits)
    this.cache = { version: version.version, entries, loadedAt: Date.now() }
    return this.cache
  }
}
```

注意：本代码块首行 import 已含 `Inject`（构造器装饰器需要）；`seedPricing(this.prisma)` 无需强转（PrismaService extends PrismaClient）。

- [ ] **Step 4: 实现 pricing.module.ts 与 pricing.test-utils.ts**

```ts
// apps/server/src/pricing/pricing.module.ts
import { Module } from '@nestjs/common'
import { PricingService } from './pricing.service'

@Module({
  providers: [PricingService],
  exports: [PricingService],
})
export class PricingModule {}
```

```ts
// apps/server/src/pricing/pricing.test-utils.ts
/**
 * 测试替身：quote 委托 legacyPriceOf ⇒ 各测试模块拿到「与常量一致」的定价，
 * 既有断言语义不变；同时覆盖「调用点确实走了 quote」的接线。
 * ruleVersion 固定 'test-constants' 以便与生产表版本区分。
 */
import { vi } from 'vitest'
import { legacyPriceOf, type PricingQuery, type PricingQuote } from './pricing.core'

export function createPricingMock() {
  return {
    onModuleInit: vi.fn(async () => {}),
    quote: vi.fn(async (q: PricingQuery): Promise<PricingQuote> => ({
      credits: legacyPriceOf(q),
      ruleVersion: 'test-constants',
    })),
  }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `cd apps/server && ./node_modules/vitest/vitest.mjs run src/pricing/pricing.service.test.ts`
Expected: PASS（11 个 case；自检两个 case 依赖 Task 2/3 的导出，若失败先回查 Task 2/3）

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/pricing/pricing.service.ts apps/server/src/pricing/pricing.module.ts apps/server/src/pricing/pricing.test-utils.ts apps/server/src/pricing/pricing.service.test.ts
git commit -m "feat(pricing): 价目表服务（30s 缓存/四条兜底路径/启动全网自检）"
```

---

### Task 6: 金标准等价集成测试（P0 出口判据）

**Files:**
- Create: `apps/server/src/pricing/pricing.equivalence.integration.test.ts`

**Interfaces:**
- Consumes: Task 2-5 全部
- Produces: 无（纯验证；本测试绿 = P0 等价迁移成立）

- [ ] **Step 1: 写测试（直接实现，无前置失败态——它验证的是已建好的系统）**

```ts
// apps/server/src/pricing/pricing.equivalence.integration.test.ts
/**
 * P0 出口判据（spec §9）：全网枚举空间内，价目表服务与现行常量**逐档相等**，
 * 且命中时 ruleVersion 指向表版本（证明表是真来源，不是常量旁路）。
 */
import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RULE_VERSION_CONSTANTS_FALLBACK, legacyPriceOf } from './pricing.core'
import {
  enumerateAliasCases,
  enumerateOutOfSpaceCases,
  enumeratePricingSpace,
} from './pricing.space'
import { PRICING_VERSION_V1, seedPricing } from '../../prisma/seed-pricing'
import { PricingService } from './pricing.service'
import type { PrismaService } from '../prisma/prisma.service'

const serverRoot = path.resolve(__dirname, '../..')

describe('金标准：价目表 ≡ 现行常量（全网枚举）', () => {
  let dir: string
  let prisma: PrismaClient
  let svc: PricingService

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-pricing-equiv-'))
    const databaseUrl = `file:${path.join(dir, 'test.db')}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    await seedPricing(prisma)
    svc = new PricingService(prisma as unknown as PrismaService)
    await svc.onModuleInit()
  })

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  it('枚举空间非空（空集假绿防线）', () => {
    expect(enumeratePricingSpace().length).toBeGreaterThan(300)
  })

  it('全网逐档：quote === legacy 且 ruleVersion 指向表版本', async () => {
    for (const q of enumeratePricingSpace()) {
      const quote = await svc.quote(q)
      expect(quote.credits, JSON.stringify(q)).toBe(legacyPriceOf(q))
      expect(quote.ruleVersion, JSON.stringify(q)).toBe(PRICING_VERSION_V1)
    }
  })

  it('别名拼写：quote === legacy（命中同一行）', async () => {
    for (const q of enumerateAliasCases()) {
      const quote = await svc.quote(q)
      expect(quote.credits, JSON.stringify(q)).toBe(legacyPriceOf(q))
      expect(quote.ruleVersion, JSON.stringify(q)).toBe(PRICING_VERSION_V1)
    }
  })

  it('表外组合：走 fallback 且 quote === legacy', async () => {
    for (const q of enumerateOutOfSpaceCases()) {
      const quote = await svc.quote(q)
      expect(quote.credits, JSON.stringify(q)).toBe(legacyPriceOf(q))
      expect(quote.ruleVersion, JSON.stringify(q)).toBe(RULE_VERSION_CONSTANTS_FALLBACK)
    }
  })
})
```

- [ ] **Step 2: 运行确认通过**

Run: `cd apps/server && ./node_modules/vitest/vitest.mjs run src/pricing/pricing.equivalence.integration.test.ts`
Expected: PASS。**任何一条失败都禁止进入 Task 7**——先修 Task 2/3 的规范化或种子，别改调用点。

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/pricing/pricing.equivalence.integration.test.ts
git commit -m "test(pricing): 金标准全网等价集成测试（P0 出口判据）"
```

---

### Task 7: PointsService 落账 ruleVersion

**Files:**
- Modify: `apps/server/src/points/point-tx.types.ts`（PointTxMeta 加字段）
- Modify: `apps/server/src/points/points.service.ts`（consume/refundInTx 两处 create 加字段）
- Modify: `apps/server/src/points/points.service.test.ts`（更新 2 处精确断言 + 新增 2 case）

**Interfaces:**
- Consumes: Task 1 的 schema 列
- Produces: `PointTxMeta.ruleVersion?: string | null`（Task 8/9 的调用点经它传版本号）

> **spec §9 的 `lockedCredits` 一项已由现存机制满足**：`applyChargeMeta` 把 `chargedPoints` 写进 `GenerationRecord.metadata`，退款路径（reaper / cancel / 平台回退）读 `meta.chargedPoints` 原额退——即「价格锁」早已落地，P0 不重复建设；本任务只补 `ruleVersion`（哪版价目收的这笔钱）。

- [ ] **Step 1: 改 point-tx.types.ts**

```ts
export interface PointTxMeta {
  kind: PointKind
  category: PointCategory
  status?: PointTxStatus | null
  model?: string | null
  generationId?: string | null
  /** 扣费时的价目表版本（P0 定价等价迁移；兜底路径为 'constants-fallback'）。 */
  ruleVersion?: string | null
}
```

- [ ] **Step 2: 改 points.service.ts 两处 create**

`consume()` 内 `tx.pointTransaction.create({ data: { ... balanceAfter: user?.points ?? null, } })` 改为在 `balanceAfter` 行后加：

```ts
          ruleVersion: meta?.ruleVersion ?? null,
```

`refundInTx()` 内同样位置加同一行。

- [ ] **Step 3: 更新 points.service.test.ts**

把两个精确匹配断言（`expect(create).toHaveBeenCalledWith({ data: {... } })`）的 `data` 对象里 `balanceAfter: 90` / `balanceAfter: 95` 之后各加一行 `ruleVersion: null,`；并在文件末尾追加：

```ts
  it('persists ruleVersion from meta and defaults to null', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }))
    const findUnique = vi.fn(async () => ({ points: 90 }))
    const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'pt3', ...args.data }))
    const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ user: { updateMany, findUnique }, pointTransaction: { create } }),
    )
    const moduleRef = await Test.createTestingModule({
      providers: [PointsService, { provide: PrismaService, useValue: { $transaction } }],
    }).compile()
    const svc = moduleRef.get(PointsService)

    await svc.consume('u1', 10, '图像生成', {
      kind: 'consume',
      category: 'image',
      ruleVersion: 'v1-legacy-equivalent',
    })
    expect(create.mock.calls[0][0].data.ruleVersion).toBe('v1-legacy-equivalent')

    await svc.consume('u1', 10, '图像生成', { kind: 'consume', category: 'image' })
    expect(create.mock.calls[1][0].data.ruleVersion).toBeNull()
  })
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/server && ./node_modules/vitest/vitest.mjs run src/points/points.service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/points/point-tx.types.ts apps/server/src/points/points.service.ts apps/server/src/points/points.service.test.ts
git commit -m "feat(points): 扣费/退款流水落 ruleVersion（价目版本可追溯）"
```

---

### Task 8: studio.service.ts 接线（8 个计价点 + DI + 测试 sweep）

**Files:**
- Modify: `apps/server/src/studio/studio.service.ts`（构造器 + 3 处 import + 8 个计价点 + platformFallbackCost→platformFallbackQuote）
- Modify: `apps/server/src/studio/studio.module.ts`（import PricingModule）
- Modify: `apps/server/src/studio/studio.test-utils.ts`（provider 加 pricing mock）
- Modify: 17 个 studio 测试文件（provider sweep，见 Step 5 表）

**Interfaces:**
- Consumes: Task 5 的 `PricingService` / `PricingModule` / `createPricingMock`；Task 7 的 `PointTxMeta.ruleVersion`
- Produces: StudioService 第 6 个构造参数 `private readonly pricing: PricingService`

- [ ] **Step 1: 构造器与 import**

构造器（`:516-522`）在 `upload` 参数后加：

```ts
    @Inject(PricingService) private readonly pricing: PricingService,
```

import 区加：

```ts
import { PricingService } from '../pricing/pricing.service'
```

删除三处已无使用者的 import（删前各跑一次 `grep -n "IMAGE_EDIT_MODEL_PRICING\|imageGenerationCredits\|videoCreditsForModel" apps/server/src/studio/studio.service.ts`，确认只剩 import 行本身；`P1_IMAGE_EDIT_MODEL_KEY` 仍被 `:1561` 使用，**保留**）：
- `IMAGE_EDIT_MODEL_PRICING`（约 `:47`，从 @lnkpi/shared 的 import 列表里删这一个名字）
- `imageGenerationCredits`（约 `:71`，同上）
- `videoCreditsForModel`（约 `:89`，整行删）

- [ ] **Step 2: 六个直接计价点**

`:757`（文本生成）：

```ts
// before
    const cost = 5
    const chargeReason = '文本生成'
// after
    const quote = await this.pricing.quote({ capability: 'text' })
    const cost = quote.credits
    const chargeReason = '文本生成'
```

`:921`（提示词模式生成）：同上两行替换（chargeReason 为 `'提示词模式生成'`）。

`:1194`（图像生成）：

```ts
// before
    const cost = imageGenerationCredits({ count: n, resolution })
// after
    const quote = await this.pricing.quote({ capability: 'image', count: n, resolution })
    const cost = quote.credits
```

`:1404`（图像变体）：

```ts
// before
    const cost = 10
// after
    const quote = await this.pricing.quote({ capability: 'image_variant' })
    const cost = quote.credits
```

`:1577`（图像精修）：

```ts
// before
    const cost = IMAGE_EDIT_MODEL_PRICING[editModelKey] ?? 10
// after
    const quote = await this.pricing.quote({ capability: 'image_edit', modelKey: editModelKey })
    const cost = quote.credits
```

`:2215`（视频生成）：

```ts
// before
    const durationCredits = videoCreditsForModel({
      duration,
      modelKey: model,
      resolution,
      videoMode: resolvedVideoMode,
      referenceImageCount: referenceBundle.images.length,
      referenceVideoCount: referenceBundle.videos.length,
    })
// after
    const videoQuote = await this.pricing.quote({
      capability: 'video',
      modelKey: model,
      resolution,
      duration,
      videoMode: resolvedVideoMode,
      referenceImageCount: referenceBundle.images.length,
      referenceVideoCount: referenceBundle.videos.length,
    })
    const durationCredits = videoQuote.credits
```

`:2407`（音频）：

```ts
// before
    const cost = kind === 'music' ? 15 : 5
// after
    const quote = await this.pricing.quote({ capability: 'audio', audioKind: kind })
    const cost = quote.credits
```

- [ ] **Step 3: 七处 consume 的 meta 补 ruleVersion**

在上述七个点各自的 `consumeMeta(...)` 调用里加 `ruleVersion`（视频点用 `videoQuote.ruleVersion`，其余用 `quote.ruleVersion`）：
- `:808` `consumeMeta('text', { model: model ?? null, generationId: record.id })` → `{ model: model ?? null, generationId: record.id, ruleVersion: quote.ruleVersion }`
- `:963` 同上（prompt 点）
- `:1269` image 点
- `:1433` variant 点
- `:1686` edit 点
- `:2354` video 点：`consumeMeta('video', { model: model ?? null, generationId: record.id, ruleVersion: videoQuote.ruleVersion })`
- `:2413` audio 点

- [ ] **Step 4: platformFallbackCost → platformFallbackQuote**

整函数替换（`:604-629`）：

```ts
  private async platformFallbackQuote(type: string, meta: Record<string, unknown>): Promise<PricingQuote> {
    if (type === 'text' || type === 'prompt') {
      return this.pricing.quote({ capability: 'text' })
    }
    // ⚠️ 保持 legacy 语义：平台回退的 audio 恒按 voice 5 分计（哪怕原记录是 music）
    if (type === 'audio') return this.pricing.quote({ capability: 'audio', audioKind: 'voice' })
    if (type === 'image') {
      const count = Number(meta.count ?? 1) || 1
      return this.pricing.quote({ capability: 'image', count })
    }
    if (type === 'video') {
      return this.pricing.quote({
        capability: 'video',
        duration: Number(meta.duration ?? 5),
        modelKey:
          (typeof meta.modelKey === 'string' && meta.modelKey) ||
          (typeof meta.originalModel === 'string' && meta.originalModel) ||
          undefined,
        resolution: typeof meta.resolution === 'string' ? meta.resolution : undefined,
        videoMode: typeof meta.videoMode === 'string' ? meta.videoMode : undefined,
        referenceImageCount: typeof meta.referenceImageCount === 'number'
          ? meta.referenceImageCount
          : Array.isArray(meta.referenceImages)
            ? meta.referenceImages.length
            : undefined,
        referenceVideoCount: typeof meta.referenceVideoCount === 'number'
          ? meta.referenceVideoCount
          : Array.isArray(meta.referenceVideos)
            ? meta.referenceVideos.length
            : undefined,
      })
    }
    throw new BadRequestException('不支持的生成类型')
  }
```

顶部 import 加 `import type { PricingQuote } from '../pricing/pricing.core'`。

两个调用点：

```ts
// :2735 before
    const platformCost = this.platformFallbackCost(record.type, meta)
// after
    const fallbackQuote = await this.platformFallbackQuote(record.type, meta)
    const platformCost = fallbackQuote.credits
```

```ts
// :2745 before
      consumeMeta(pointCategory, pointExtra),
// after
      consumeMeta(pointCategory, { ...pointExtra, ruleVersion: fallbackQuote.ruleVersion }),
```

```ts
// :3061 before
          : this.platformFallbackCost(record.type, meta)
// after
          : (await this.platformFallbackQuote(record.type, meta)).credits
```

- [ ] **Step 5: studio.module.ts + 测试 sweep**

`studio.module.ts`：加 `import { PricingModule } from '../pricing/pricing.module'`，imports 数组加 `PricingModule`。

`studio.test-utils.ts` 的 `createStudioService` providers 数组里，`StudioService,` 行之后加：

```ts
      { provide: PricingService, useValue: createPricingMock() },
```

并加 import：`import { createPricingMock } from '../pricing/pricing.test-utils'` 与 `import { PricingService } from '../pricing/pricing.service'`。

对其余 17 个文件执行同一规则（每个 `providers: [` 数组里 `StudioService,` 行之后插入上面那行；文件顶部加同样两行 import）。清单（按 grep 结果，行号会随编辑漂移，以 `StudioService,` 行为锚）：

| 文件 | providers 数组中含 StudioService 的次数 |
|---|---|
| studio.matting.test.ts | 1 |
| studio.prompt-record-first.test.ts | 1 |
| video-generation.integration.test.ts | 2 |
| studio.audio-kind-match.test.ts | 3 |
| studio.service.test.ts | 1 |
| studio.catalog-rows-wiring.test.ts | 1 |
| studio.image-ledger.test.ts | 1 |
| studio.diagnostic.test.ts | 1 |
| studio.audio-music.test.ts | 5 |
| studio.image-ledger-coverage.test.ts | 1 |
| studio.video-preflight.test.ts | 1 |
| run-vision-qa-context.test.ts | 1 |
| studio.media-info.test.ts | 1 |
| studio.edit-image.test.ts | 1 |
| studio.fallback.test.ts | 1 |
| studio.entry-availability.test.ts | 1 |
| studio.segment.test.ts | 4 |

合计 28 处（+ test-utils 1 处 = 29）。`studio.platform-fallback-signal.test.ts` 直接 `new StudioService(...)` 传 13 个 `{} as never`，第 6 个会落到 pricing 上且该测试只调 `platformGatewayModelId`（不碰 pricing）——**无需改动**。

- [ ] **Step 6: 验证 sweep 完整性 + 编译 + 测试**

```bash
grep -rn "provide: PricingService" apps/server/src --include="*.ts" | wc -l   # 必须 ≥ 29
cd apps/server && ./node_modules/vitest/vitest.mjs run src/studio src/points 2>&1 | tail -20
pnpm --filter @lnkpi/server exec tsc --noEmit
```

Expected: 测试全 PASS；tsc 无错。若某测试报 `Nest can't resolve dependencies of StudioService` ⇒ 该文件的 provider 漏插，回 Step 5 补。若某断言因 meta 新增 `ruleVersion` 精确匹配失败 ⇒ 把该处 `toHaveBeenCalledWith` 改 `toMatchObject` 或补 `ruleVersion` 期望值（**不要**改价格数值断言——价格必须仍是 10/5/30/15）。

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/studio/studio.service.ts apps/server/src/studio/studio.module.ts apps/server/src/studio/studio.test-utils.ts apps/server/src/studio/
git commit -m "feat(studio): 8 个计价点改调 PricingService.quote（行为等价）"
```

---

### Task 9: material.service.ts 接线（3 个计价点 + DI + 测试 sweep）

**Files:**
- Modify: `apps/server/src/canvas/material.service.ts`（构造器 + 2 处 import + 3 个计价点）
- Modify: `apps/server/src/canvas/canvas.module.ts`（import PricingModule）
- Modify: 4 个 material 测试文件（provider sweep）

**Interfaces:**
- Consumes: Task 5/7 同 Task 8
- Produces: MaterialService 第 5 个构造参数 `private readonly pricing: PricingService`

- [ ] **Step 1: 构造器与 import**

构造器（`:287-292`）在 `mediaProbe` 参数后加：

```ts
    @Inject(PricingService) private readonly pricing: PricingService,
```

加 import：`import { PricingService } from '../pricing/pricing.service'`、`import type { PricingQuote } from '../pricing/pricing.core'`；删除 `imageGenerationCredits` 与 `videoCreditsForModel` 两个 import（删前 grep 确认无其他使用者）。

- [ ] **Step 2: 图像素材计价（`:411`）**

```ts
// before
    const cost = imageGenerationCredits({ count: 1, resolution })
    const chargeReason = '图像生成'
// after
    const quote = await this.pricing.quote({ capability: 'image', count: 1, resolution })
    const cost = quote.credits
    const chargeReason = '图像生成'
```

- [ ] **Step 3: 视频素材计价（`:522`）**

```ts
// before
    const cost = videoCreditsForModel({
      duration,
      modelKey: model,
      resolution,
      videoMode: resolvedVideoMode,
      referenceImageCount: referenceBundle.images.length,
      referenceVideoCount: referenceBundle.videos.length,
    })
    const chargeReason = '视频生成'
// after
    const quote = await this.pricing.quote({
      capability: 'video',
      modelKey: model,
      resolution,
      duration,
      videoMode: resolvedVideoMode,
      referenceImageCount: referenceBundle.images.length,
      referenceVideoCount: referenceBundle.videos.length,
    })
    const cost = quote.credits
    const chargeReason = '视频生成'
```

- [ ] **Step 4: platformFallbackCost → platformFallbackQuote（`:350-374`）**

整函数替换（注意 material 版的 meta 回退键是 `meta.model`，**不是** studio 版的 `meta.originalModel`——逐字保留差异）：

```ts
  private async platformFallbackQuote(type: string, meta: Record<string, unknown>): Promise<PricingQuote> {
    if (type === 'image') return this.pricing.quote({ capability: 'image', count: 1 })
    if (type === 'video') {
      return this.pricing.quote({
        capability: 'video',
        duration: Number(meta.duration ?? 5),
        modelKey:
          (typeof meta.modelKey === 'string' && meta.modelKey) ||
          (typeof meta.model === 'string' && meta.model) ||
          undefined,
        resolution: typeof meta.resolution === 'string' ? meta.resolution : undefined,
        videoMode: typeof meta.videoMode === 'string' ? meta.videoMode : undefined,
        referenceImageCount: typeof meta.referenceImageCount === 'number'
          ? meta.referenceImageCount
          : Array.isArray(meta.referenceImages)
            ? meta.referenceImages.length
            : undefined,
        referenceVideoCount: typeof meta.referenceVideoCount === 'number'
          ? meta.referenceVideoCount
          : Array.isArray(meta.referenceVideos)
            ? meta.referenceVideos.length
            : undefined,
      })
    }
    throw new BadRequestException('不支持的素材类型')
  }
```

调用点：

```ts
// :607 before
    const platformCost = this.platformFallbackCost(material.type, meta)
// after
    const fallbackQuote = await this.platformFallbackQuote(material.type, meta)
    const platformCost = fallbackQuote.credits
```

```ts
// :617 before
      consumeMeta(pointCategory, pointExtra),
// after
      consumeMeta(pointCategory, { ...pointExtra, ruleVersion: fallbackQuote.ruleVersion }),
```

```ts
// :812 before
          : this.platformFallbackCost(material.type, meta)
// after
          : (await this.platformFallbackQuote(material.type, meta)).credits
```

两处普通计价的 consume meta（`:445` image / `:536` video）各加 `ruleVersion: quote.ruleVersion`。

- [ ] **Step 5: canvas.module.ts + 测试 sweep**

`canvas.module.ts`：加 `import { PricingModule } from '../pricing/pricing.module'`，imports 数组加 `PricingModule`。

4 个测试文件各 provider 数组（`MaterialService,` 行之后插入，文件顶部加两行 import，同 Task 8 Step 5）：

| 文件 | 数组数 |
|---|---|
| material.service.test.ts | 2 |
| material.fallback.test.ts | 1 |
| material.catalog-rows-wiring.test.ts | 1 |
| material.diagnostic.test.ts | 1 |

- [ ] **Step 6: 验证 + 编译 + 测试**

```bash
grep -rn "provide: PricingService" apps/server/src --include="*.ts" | wc -l   # 必须 ≥ 34
cd apps/server && ./node_modules/vitest/vitest.mjs run src/canvas src/studio 2>&1 | tail -20
pnpm --filter @lnkpi/server exec tsc --noEmit
```

Expected: 全 PASS / 无 tsc 错。

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/canvas/material.service.ts apps/server/src/canvas/canvas.module.ts apps/server/src/canvas/
git commit -m "feat(canvas): material 3 个计价点改调 PricingService.quote（行为等价）"
```

---

### Task 10: 全量验证 + 文档 + PR

**Files:**
- Modify: `docs/superpowers/specs/2026-10-13-pricing-baseline-config-design.md`（§9 P0 行标记完成）

- [ ] **Step 1: 全量测试（server 包；4 核纪律：不与其他包并行）**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/p0-pricing-migration/apps/server && ./node_modules/vitest/vitest.mjs run 2>&1 | tail -15
```

Expected: 全 PASS（含 Task 6 金标准）。**金标准必须绿**——它红了说明等价性被破坏，禁止合并。

- [ ] **Step 2: 类型检查 + shared 包回归**

```bash
pnpm --filter @lnkpi/server exec tsc --noEmit
pnpm --filter @lnkpi/shared exec tsc --noEmit
cd packages/shared && ./node_modules/vitest/vitest.mjs run 2>&1 | tail -5
```

Expected: 全绿。

- [ ] **Step 3: 更新 spec §9**

把 `2026-10-13-pricing-baseline-config-design.md` §9 表格 P0 行的出口判据后追加 `（✅ 2026-10-13 完成：金标准全网等价 + ruleVersion 落账 + boot 自播种）`。

- [ ] **Step 4: 部署检查单（合并后执行，转 prod-deploy-verify skill）**

1. CI 全绿 → `gh pr merge --squash`（不加 --delete-branch）；
2. 盯 deploy run 成功 + `docker exec lnkpi-api` 侧 `/api/health` 200；
3. **验证 boot 日志**含 `[pricing] 启动自检通过：N 例全网等价（版本 v1-legacy-equivalent）`（无 active 版本时会有一次 `boot 未发现 active 版本，已自播种` 属正常）；
4. 生产抽 1 次生成，查 `PointTransaction.ruleVersion = 'v1-legacy-equivalent'`；
5. 回滚命令（一次性环境变量，不写 .env）：`cd /opt/lnkpi/deploy && LNKPI_API_IMAGE=lnkpi-api:<旧sha> docker compose -f docker-compose.prod.yml up -d --no-build api`。

- [ ] **Step 5: Push + PR**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/p0-pricing-migration
git push -u origin feat/p0-pricing-migration
gh pr create --base master --title "feat(pricing): P0 定价等价迁移（常量→价目表服务，行为零变化）" --body "见 docs/superpowers/plans/2026-10-13-p0-pricing-equivalent-migration.md；出口判据=金标准全网等价测试绿"
```

盯 `gh pr checks` 全绿再合并（合并前查无在跑的 workflow 互相挤掉）。
