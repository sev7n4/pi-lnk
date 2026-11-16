# T1 文本 token 物化→扣费链路接通 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 物化器对文本 token 主体同步 upsert 三段 `text:<model>:<spec>` 反比率行，使「定价中心改成本/利润 → 物化 → 发布 → 文本对话扣费跟随变化」端到端接通（当前发布后文本仍扣旧 3636=275 分/百万）。

**Architecture:** 在 `PricingMaterializerService.materialize()` 循环内（credits 计算后、六段主体行写入前）对 `isToken` 主体额外 upsert 一条三段行：`matchKey=text:<model>:<spec>`、`subjectKey=null`、`credits=ratioOf(...)`、`costRateId` 必带。三段行跟随发布门禁既有 token 行语义（`pricing-publishing.service.ts:492` 豁免 unitSnapshot、`:545-547` 地板判上限用 `rate.costYuan`）。模型键归一复用 `modelOptionName().trim().toLowerCase()`（与 `quoteTextTokens:392` 同源，天然同形）。六段文本主体行写入逻辑零改动，仅加 deprecated 注释。六处读取点（报价/预估/公开端点/冻结/结算/卡片）零改动。

**Tech Stack:** NestJS + Prisma(SQLite) + vitest（server 侧）；测试参照 `pricing.s1-acceptance.test.ts` 的临时 sqlite + `prisma db push` 集成模式。

**Spec:** `docs/superpowers/specs/2026-11-15-text-token-reprice-link-design.md`（含 §4.3 核对点与 §5 判据；执行时 spec 与本计划一并阅读）

## Global Constraints

- 币种恒人民币（D9）；不新增 currency/fx 字段。
- `creditsOf` / `ratioOf` 公式零改动；`computeTextTokenCredits` 零改动。
- studio 文本直生单行 `text`=5 分链路（`studio.service.ts:641,803`）不动（Out of Scope）。
- `seed-pricing-v2-draft.test.ts:218` 的 3636 断言不动（测 seed 逻辑，非本刀范围）。
- seed 阶段写入的既有 draft 行不迁移；物化只 upsert 当前 draft 内的三段行。
- `PRICING_SUBJECT_KEYS` / `TEXT_TOKEN_BILLING` 杀开关行为不变。
- 三段行计数**不并入** `MaterializeResult.added/changed/unchanged`（摘要「已出价」是主体数视角，镜像行不重复计）。
- 测试命令：`env -u NODE_OPTIONS CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 node $HOME/.cache/node/corepack/v1/pnpm/9.15.0/bin/pnpm.cjs exec vitest run <file> --maxWorkers=1 --no-file-parallelism`（PATH 用 `$HOME/.nvm/versions/node/v24.13.0/bin` 绝对路径前缀）。
- 推 PR 用 `gh api` REST（blob→tree(`base_tree` 只传改动路径)→commit→ref→PR）；推前逐路径裸 blob sha 与改动前基准（tarball 原版）比对；CI 全绿后停在合并前等用户单独授权。

## Review Focus

1. **模型键带渠道前缀**（生产 `quoteTextTokens` 传 `platform::agnes-2.5-flash`）→ 物化拼 key 必须剥前缀归一，否则三段 key 与 quote 读的 key 不同形、修复静默失效。钉法：Task 1 守卫断言两端同用 `modelOptionName().trim().toLowerCase()` 同源函数（`@lnkpi/shared`）；Task 4 端到端用带前缀参数调用 `quoteTextTokens` 验证全链同形。fixture 主体表 `modelKey` 用裸名（生产 `PricingSubject.modelKey` 由 `ModelCatalogEntry.modelKey` 生成，为裸形态）。
2. **运营手改三段行**（发布流页行内改 `text:` 行，`basis='ops-modified'`）→ 物化不得覆盖手改值 → Task 3 钉住。
3. **同输入二次物化** → 三段行幂等（不重复 create、无脏 update）→ Task 3 钉住。
4. **跨版本隔离**：物化只写 draft 版本，active 版本条目逐字不变 → Task 2/4 fixture 含 active 版本并断言不变。
5. **反比率误用正价公式**（creditsOf 替代 ratioOf）→ 数量级错价（181818 vs 66）→ Task 2 断言精确 ratioOf 值钉住。

---

### Task 1: 归一化同源守卫（防 key 漂移）

**Files:**
- Test: `apps/server/src/pricing/pricing-text-reprice-link.sqlite.integration.test.ts`（新建）

**Interfaces:**
- Consumes: `modelOptionName`（`pricing.core.ts` 导出）、`TEXT_TOKEN_MODELS`（`pricing.core.ts:177-188`）
- Produces: 测试文件骨架与 helper（`openDb` / `runMaterialize`），Task 2-5 复用

- [ ] **Step 1: 建测试骨架 + 归一化守卫测试**

参照 `pricing.s1-acceptance.test.ts:13-76` 的模式（临时 sqlite、`prisma db push`、beforeEach 清表）。守卫断言：对每个 `TEXT_TOKEN_MODELS` 成员 m，`modelOptionName(m).trim().toLowerCase() === m`（保证物化端复用该函数拼三段 key 后与扣费端 `pricing.service.ts:392` 同形）。

```ts
// apps/server/src/pricing/pricing-text-reprice-link.sqlite.integration.test.ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { modelOptionName } from '@lnkpi/shared'
import { TEXT_TOKEN_MODELS } from './pricing.core'
import { ratioOf } from './pricing-materializer.service'
import { PricingMaterializerService } from './pricing-materializer.service'
import { PricingPublishingService } from './pricing-publishing.service'
import { PricingService } from './pricing.service'
import type { SubjectRow } from './pricing-subject.service'

let prisma: PrismaClient
let dbUrl: string

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 't1-reprice-'))
  dbUrl = `file:${join(dir, 't1.db')}`
  process.env.DATABASE_URL = dbUrl
  execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: join(process.cwd(), 'apps/server'), stdio: 'pipe', env: { ...process.env, DATABASE_URL: dbUrl },
  })
  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })
})
afterAll(async () => { await prisma.$disconnect() })
beforeEach(async () => {
  await prisma.priceListEntry.deleteMany()
  await prisma.priceListVersion.deleteMany()
  await prisma.costRate.deleteMany()
  await prisma.marginPolicy.deleteMany()
  await prisma.pricingSubject.deleteMany()
  await prisma.adminAuditLog.deleteMany()
  await prisma.priceListVersion.create({ data: { id: 'base-active', version: 'base-active', status: 'active' } })
})

function subjectRowsOf(rows: { subjectKey: string; capability: string; modelKey: string; spec: string; provider: string; upstream: string; channelId: string; status: string; billableUnit: string; unitsPerRequest: number | null; source: string }[]): SubjectRow[] {
  return rows.map((r) => ({ ...r }))
}

async function runMaterialize(draftId: string): Promise<ReturnType<PricingMaterializerService['materialize']>> {
  const subjects = await prisma.pricingSubject.findMany()
  const costRates = await prisma.costRate.findMany()
  const marginRows = await prisma.marginPolicy.findMany()
  return new PricingMaterializerService(prisma as unknown as never).materialize(draftId, subjectRowsOf(subjects as never), costRates as never, marginRows as never, new Date())
}

describe('T1 归一化同源守卫（spec §4.3 核对点 1）', () => {
  it('TEXT_TOKEN_MODELS 每个成员经 modelOptionName 归一后恒等（物化拼 key 与 quoteTextTokens:392 同形）', () => {
    for (const m of TEXT_TOKEN_MODELS) {
      expect(modelOptionName(m).trim().toLowerCase()).toBe(m)
    }
  })
})
```

- [ ] **Step 2: 跑测试确认 PASS（这是守卫不是 RED 驱动任务）**

Run: `cd apps/server && <Global Constraints 测试命令> src/pricing/pricing-text-reprice-link.sqlite.integration.test.ts`
Expected: 1 passed。若 RED：说明 `modelOptionName` 会改写某模型名 → 物化端拼 key 必须同样归一（实现已如此设计），记录到 PR 描述并继续。

- [ ] **Step 3: 无实现改动，跳过 commit（与 Task 2 合并提交）**

---

### Task 2: 三段 text: 行物化 upsert（TDD）

**Files:**
- Modify: `apps/server/src/pricing/pricing-materializer.service.ts`
- Test: `apps/server/src/pricing/pricing-text-reprice-link.sqlite.integration.test.ts`

**Interfaces:**
- Consumes: `buildTextTokenMatchKey(modelKey, spec)`、`TEXT_TOKEN_SPECS`（`pricing.core.ts:159-195`）；`buildEntryData`（本文件私有方法）；Task 1 的 `runMaterialize`
- Produces: 物化产物含三段行（`matchKey=text:<model>:<spec>`, `subjectKey=null`, `credits=ratioOf(...)`）；Task 3-5 依赖该产物

- [ ] **Step 1: 写失败测试**

```ts
describe('T1 三段 text: 行物化（spec §4.1）', () => {
  const SUBJECT_KEY = 'text|agnes-2.5-flash|in|agnes_hub|default'
  beforeEach(async () => {
    await prisma.pricingSubject.create({
      data: {
        subjectKey: SUBJECT_KEY,
        capability: 'text', modelKey: 'agnes-2.5-flash', spec: 'in',
        provider: 'agnes_hub', upstream: 'default', channelId: 'platform', status: 'priced',
        billableUnit: 'token_in', unitsPerRequest: 1e6, source: 'auto',
      },
    })
    await prisma.costRate.create({
      data: { id: 'cr-in', channel: 'platform', modelKey: 'agnes-2.5-flash', spec: 'per_1m_tokens_in', unit: 'per_1m_tokens', unitQuantity: 1e6, costYuan: 0.05, source: 'official_list' },
    })
    await prisma.marginPolicy.create({
      data: { id: 'mp-global', phase: 'launch', scope: 'global', scopeKey: '*', profitBp: 1000, priceFloorBp: 500, status: 'active' },
    })
  })

  it('物化后 draft 含三段行：modelKey 前缀剥净、credits=ratioOf(0.05,1000)=181818、subjectKey=null、costRateId 必带', async () => {
    const pub = new PricingPublishingService(prisma as unknown as never, new PricingService(prisma as unknown as never))
    const draft = await pub.createDraftFromActive('t1-draft', 't1-v1')
    const res = await runMaterialize(draft.id)
    expect(res.missingCost).toHaveLength(0)
    const row = await prisma.priceListEntry.findFirst({ where: { versionId: draft.id, matchKey: 'text:agnes-2.5-flash:in' } })
    expect(row).not.toBeNull()
    expect(row!.credits).toBe(ratioOf(0.05, 1000)) // floor(1e8/(0.05×11000))=181818；误用 creditsOf 会得 66（数量级负例）
    expect(row!.subjectKey).toBeNull()
    expect(row!.basis).toBe('auto-derived')
    expect(row!.costRateId).toBe('cr-in')
  })

  it('跨版本隔离：物化只写 draft，active 版本条目数不变', async () => {
    const before = await prisma.priceListEntry.findMany({ where: { versionId: 'base-active' } })
    const pub = new PricingPublishingService(prisma as unknown as never, new PricingService(prisma as unknown as never))
    const draft = await pub.createDraftFromActive('t1-draft2', 't1-v2')
    await runMaterialize(draft.id)
    const after = await prisma.priceListEntry.findMany({ where: { versionId: 'base-active' } })
    expect(after.length).toBe(before.length)
  })
})
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: 同 Task 1 Step 2
Expected: FAIL（`text:agnes-2.5-flash:in` 行不存在，`row` 为 null）

- [ ] **Step 3: 实现（materialize 循环内）**

`pricing-materializer.service.ts` 三处改动：

(a) import 增加（`modelOptionName` 来自 `@lnkpi/shared`——`pricing.service.ts:21` 同源，禁止复制实现；`buildTextTokenMatchKey`/`TEXT_TOKEN_SPECS` 来自 `./pricing.core`）：

```ts
import { checkCostFloor, buildTextTokenMatchKey, TEXT_TOKEN_SPECS } from './pricing.core'
import { modelOptionName } from '@lnkpi/shared'
```

(b) `bySubjectKey` 索引旁新增（`existing` 取得之后）：

```ts
const textByKey = new Map(
  existing
    .filter((e) => e.matchKey.startsWith('text:') && !e.matchKey.includes('|'))
    .map((e) => [e.matchKey, e]),
)
```

(c) 循环体内、`checkCostFloor` 调用之后、六段 `bySubjectKey.get` 逻辑之前插入（位置关键：六段 ops-modified `continue` 不得阻断三段刷新——三段的手改保护独立判断）：

```ts
// T1 文本扣费真相源（spec 2026-11-15-text-token-reprice-link-design §4.1）：
// 物化同步刷三段 text:<model>:<spec> 反比率行。六段文本主体行是零消费副产物
// （deprecated：禁止消费，退役计划见 spec §3.1）。三段行跟随门禁既有 token 行语义
// （pricing-publishing.service.ts:492 豁免 unitSnapshot、:545-547 地板判上限用
// rate.costYuan）——不要求 subjectKey/快照，costRateId 必带供地板校验。
// 模型键归一与 quoteTextTokens:392 同源（modelOptionName+trim+toLowerCase），
// 生产带渠道前缀（platform::x）也剥净同形。计数不并入 added/changed/unchanged
// （摘要是主体数视角，镜像行不重复计）。
if (isToken && (TEXT_TOKEN_SPECS as readonly string[]).includes(s.spec)) {
  const textKey = buildTextTokenMatchKey(modelOptionName(s.modelKey).trim().toLowerCase(), s.spec as Parameters<typeof buildTextTokenMatchKey>[1])
  const prevText = textByKey.get(textKey)
  if (prevText?.basis !== 'ops-modified') {
    if (!prevText) {
      await this.prisma.priceListEntry.create({
        data: { versionId: draftId, capability: s.capability, matchKey: textKey, ...this.buildEntryData(s, unit, margin, credits), subjectKey: null },
      })
    } else if (prevText.credits !== credits) {
      await this.prisma.priceListEntry.update({
        where: { id: prevText.id },
        data: { credits, basis: 'auto-derived', reason: null, costSnapshotYuan: unit.costYuanPerRequest, profitBpSnapshot: margin.profitBp, costRateId: unit.costRateId, marginPolicyId: margin.marginPolicyId },
      })
    }
  }
}
```

若 `modelOptionName` 在物化器文件尚未导入，按 (a) 补 import。

- [ ] **Step 4: 跑测试确认 PASS**

Run: 同 Task 1 Step 2
Expected: 3 passed（Task 1 守卫 1 + 本任务 2）

- [ ] **Step 5: 无独立 commit（与 Task 5 合并统一提交）**

---

### Task 3: ops-modified 保护 + 幂等

**Files:**
- Test: `apps/server/src/pricing/pricing-text-reprice-link.sqlite.integration.test.ts`

**Interfaces:**
- Consumes: Task 2 产物（三段行 upsert 已实现）；fixture 同 Task 2 的 beforeEach
- Produces: 无（行为保证，Task 6 变异依赖）

- [ ] **Step 1: 写失败测试（追加到 Task 2 的 describe 内）**

```ts
  it('幂等：同输入二次物化，三段行仅一条且 credits 不变', async () => {
    const pub = new PricingPublishingService(prisma as unknown as never, new PricingService(prisma as unknown as never))
    const draft = await pub.createDraftFromActive('t1-draft3', 't1-v3')
    await runMaterialize(draft.id)
    await runMaterialize(draft.id)
    const rows = await prisma.priceListEntry.findMany({ where: { versionId: draft.id, matchKey: 'text:agnes-2.5-flash:in' } })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.credits).toBe(ratioOf(0.05, 1000))
  })

  it('ops-modified 保护：运营手改三段行后，新成本物化不覆盖手改值', async () => {
    const pub = new PricingPublishingService(prisma as unknown as never, new PricingService(prisma as unknown as never))
    const draft = await pub.createDraftFromActive('t1-draft4', 't1-v4')
    await runMaterialize(draft.id)
    await prisma.priceListEntry.updateMany({ where: { versionId: draft.id, matchKey: 'text:agnes-2.5-flash:in' }, data: { credits: 12345, basis: 'ops-modified', reason: '运营手工调价' } })
    await prisma.costRate.update({ where: { id: 'cr-in' }, data: { costYuan: 0.10 } })
    await runMaterialize(draft.id)
    const row = await prisma.priceListEntry.findFirst({ where: { versionId: draft.id, matchKey: 'text:agnes-2.5-flash:in' } })
    expect(row!.credits).toBe(12345)
    expect(row!.basis).toBe('ops-modified')
  })
```

- [ ] **Step 2: 跑测试确认 PASS**

Run: 同 Task 1 Step 2
Expected: 5 passed。若 ops-modified 用例 RED：检查实现里 `prevText?.basis !== 'ops-modified'` 分支位置是否在 update 之前。

- [ ] **Step 3: 无独立 commit**

---

### Task 4: 端到端——改成本 → 物化 → 发布 → quoteTextTokens 跟随（核心判据）

**Files:**
- Test: `apps/server/src/pricing/pricing-text-reprice-link.sqlite.integration.test.ts`

**Interfaces:**
- Consumes: `PricingPublishingService.publish(draftId)`、`PricingService.quoteTextTokens(userId, modelKey, usage)`（usage 字段：`inputTokens/cacheReadTokens/outputTokens`）；发布后必须 **new PricingService** 取 active 表（参照 s1-acceptance AC1 `:108` 的新实例纪律）
- **fixture 铁律（2026-11-15 核对 `isKnownTokenModel:625` 后补）**：`quoteTextTokens` 精确计费要求主体表同时存在 spec='in' 与 spec='out' 的文本主体（缺任一 → 静默落 USD 兜底）；`getActiveTextTokenRatios` 同样要求 in/out 两行齐备才成组。**fixture 必须建 in/cache/out 三主体 + 三档 costRate**，否则 Task 4/5 假绿或行为完全不同。

- [ ] **Step 1: 写失败测试（新增 describe）**

```ts
describe('T1 端到端：改成本→物化→发布→文本扣费跟随（spec §5.1 核心判据）', () => {
  const USAGE = { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }
  const SPECS = [
    { spec: 'in', cost: 0.05, crId: 'cr-in' },
    { spec: 'cache', cost: 0.5, crId: 'cr-cache' },
    { spec: 'out', cost: 0.15, crId: 'cr-out' },
  ]

  beforeEach(async () => {
    for (const t of SPECS) {
      await prisma.pricingSubject.create({
        data: {
          subjectKey: `text|agnes-2.5-flash|${t.spec}|agnes_hub|default`,
          capability: 'text', modelKey: 'agnes-2.5-flash', spec: t.spec,
          provider: 'agnes_hub', upstream: 'default', channelId: 'platform', status: 'priced',
          billableUnit: `token_${t.spec}`, unitsPerRequest: 1e6, source: 'auto',
        },
      })
      await prisma.costRate.create({
        data: { id: t.crId, channel: 'platform', modelKey: 'agnes-2.5-flash', spec: `per_1m_tokens_${t.spec}`, unit: 'per_1m_tokens', unitQuantity: 1e6, costYuan: t.cost, source: 'official_list' },
      })
    }
    await prisma.marginPolicy.create({
      data: { id: 'mp-global', phase: 'launch', scope: 'global', scopeKey: '*', profitBp: 1000, priceFloorBp: 500, status: 'active' },
    })
  })

  async function materializeAndPublish(tag: string): Promise<void> {
    const pub = new PricingPublishingService(prisma as unknown as never, new PricingService(prisma as unknown as never))
    const draft = await pub.createDraftFromActive(`${tag}-draft`, tag)
    await runMaterialize(draft.id)
    await pub.publish(draft.id)
  }

  it('第一轮 in 0.05 → 6 分/百万；改 0.10 再物化发布 → 12 分/百万（价格跟随）', async () => {
    await materializeAndPublish('t1-e2e-a')
    let svc = new PricingService(prisma as unknown as never)
    const q1 = await svc.quoteTextTokens(undefined, 'platform::agnes-2.5-flash', USAGE)
    expect(q1.credits).toBe(Math.ceil(1e6 / ratioOf(0.05, 1000))) // ceil(1e6/181818)=6

    await prisma.costRate.update({ where: { id: 'cr-in' }, data: { costYuan: 0.10 } })
    await materializeAndPublish('t1-e2e-b')
    svc = new PricingService(prisma as unknown as never)
    const q2 = await svc.quoteTextTokens(undefined, 'platform::agnes-2.5-flash', USAGE)
    expect(q2.credits).toBe(Math.ceil(1e6 / ratioOf(0.10, 1000))) // 90909 → 1e6/90909=11.00001 → ceil=12
    expect(q2.credits).not.toBe(q1.credits)
  })
})
```

- [ ] **Step 2: 跑测试确认 PASS**

Run: 同 Task 1 Step 2
Expected: 6 passed。若 FAIL 且 credits 呈 USD 兜底值（远小于 6）：核对 fixture 三档主体是否齐建（`isKnownTokenModel:625` 要求 in+out 双主体，缺任一静默落兜底）。

- [ ] **Step 3: 无独立 commit**

---

### Task 5: 六处读取一致性守卫 + deprecated 注释 + 统一提交

**Files:**
- Test: `apps/server/src/pricing/pricing-text-reprice-link.sqlite.integration.test.ts`
- Modify: `apps/server/src/pricing/pricing-materializer.service.ts`（注释）

**Interfaces:**
- Consumes: Task 2 产物；`getActiveTextTokenRatios`（`pricing.service.ts:542-578`，返回 `Record<model, { in, cache?, out }>`，**in/out 两行齐备才成组**——Task 4 三档 fixture 已满足）
- 测试归属：下面两个守卫用例**追加到 Task 4 的端到端 describe 内**（复用其三档 fixture 的 beforeEach 与 `materializeAndPublish` helper）

- [ ] **Step 1: 写一致性守卫测试（追加）**

```ts
  it('接线守卫：active 表中三段行与六段文本主体行 credits 逐一相等（spec §5.3，防双写漂移）', async () => {
    await materializeAndPublish('t1-guard')
    const active = await prisma.priceListVersion.findFirst({ where: { status: 'active' }, include: { entries: true } })
    const threeSeg = new Map<string, number>()
    for (const e of active!.entries) {
      if (e.matchKey.startsWith('text:') && !e.matchKey.includes('|')) threeSeg.set(e.matchKey, e.credits)
    }
    expect(threeSeg.size).toBeGreaterThanOrEqual(3)
    for (const e of active!.entries) {
      if (e.matchKey.includes('|') && e.matchKey.startsWith('text|')) {
        const [, model, spec] = e.matchKey.split('|')
        expect(threeSeg.get(`text:${model}:${spec}`)).toBe(e.credits)
      }
    }
  })

  it('公开反比率端点读到新值（getActiveTextTokenRatios 与扣费同源；Record 形态，:542-578）', async () => {
    await materializeAndPublish('t1-ratios')
    const svc = new PricingService(prisma as unknown as never)
    const ratios = await svc.getActiveTextTokenRatios()
    expect(ratios['agnes-2.5-flash']?.in).toBe(ratioOf(0.05, 1000))
    expect(ratios['agnes-2.5-flash']?.out).toBe(ratioOf(0.15, 1000))
  })
```

- [ ] **Step 2: 跑测试确认 PASS**

Run: 同 Task 1 Step 2
Expected: 8 passed

- [ ] **Step 3: 加 deprecated 注释（物化器六段写入处）**

在 `buildEntryData` 方法 doc 注释补一行：

```ts
   * ⚠️ deprecated（T1，2026-11-15）：capability=text 的六段主体行是零消费副产物——
   * deriveSubjectSpec('text') 恒 undefined，扣费/卡片/公开端点全读三段 text: 行
   * （本文件物化循环内同步刷三段行）。禁止任何新代码消费六段文本行；退役计划见
   * spec 2026-11-15-text-token-reprice-link-design §3.1。
```

- [ ] **Step 4: 全量回归**

Run: `cd apps/server && <Global Constraints 测试命令>（不带文件参数跑全量）`
Expected: 全绿（基线 2872+，含既有 seed 3636 断言不受影响）
Run: `cd apps/web && env -u NODE_OPTIONS ... pnpm.cjs exec vue-tsc -b`
Expected: 0 errors

- [ ] **Step 5: 变异自检（4 组，每组改后必须 RED、还原后恢复 GREEN）**

| # | 变异（对象字面量条件恒 falsy 或删除分支） | 判据 |
|---|---|---|
| 1 | 三段 upsert 的 `if (isToken && ...)` 改为 `if (false && ...)` | Task 2 两用例 + Task 4 端到端 RED |
| 2 | 三段 create 的 `credits` 改为 `creditsOf(unit.costYuanPerRequest, margin.profitBp)`（正价口径错配） | Task 2 精确值断言 RED（66 ≠ 181818） |
| 3 | 删除 `prevText?.basis !== 'ops-modified'` 条件（恒允许覆盖） | Task 3 ops-modified 用例 RED |
| 4 | 三段 create 漏传 `costRateId`（data 里删掉该字段——由 buildEntryData 展开补 null） | Task 4 发布被门禁 missingCost/地板拦截 RED（发布 throw 或 verdict fail） |

变异判定纪律：**必须用完整 stdout 的 `AssertionError` / `failing tests` 标记判 RED**（管道 `| tail` 会吃掉退出码——多次复踩）；模块解析失败/整文件 fail 不算判据 RED，须核 per-test。

- [ ] **Step 6: REST 推 PR（改动前基准比对）**

从 `gh api repos/sev7n4/pi-lnk/tarball/master` 取改动前基准；对每条改动路径（materializer 实现 + 新测试文件）比对「改动前基准裸 blob sha ≠ 改后裸 blob sha」且「新 master 上其余路径零 DELTA」。REST 推送：blob→tree(`base_tree` 只传改动路径)→commit→ref→PR（POST /pulls，502 只重试 POST）。PR 正文写回读长度核验（@文件路径会静默丢内容）。CI 全绿后**停在合并前等用户单独授权**。

---

## Self-Review 结论

- **Spec 覆盖**：§4.1（Task 2/3）、§4.3 核对点 1（Task 1 守卫+同源归一实现）、2（`TEXT_TOKEN_SPECS` 防御）、3/4（Task 2 实现注释+Task 6 变异 4）、§5.1（Task 4）、§5.2（Task 5 ratios 端点）、§5.3（Task 5 接线守卫）、§5.4（Task 6 四组）、§5.5（Task 5 Step 4 全量）、§3.1 deprecated（Task 5 Step 3）。无缺口。
- **类型一致**：`buildTextTokenMatchKey(modelKey, spec)` 签名、`SubjectRow` 字段、`MaterializeResult` 字段均与源码核对一致；三段行 data 字段与 `buildEntryData` 产物一致。
- **Review Focus 覆盖**：前缀键（Task 2 用例 1 modelKey 带 `platform::`）、ops-modified（Task 3）、幂等（Task 3）、跨版本（Task 2 用例 2）、公式误用（Task 6 变异 2 + AC9 既有）。
