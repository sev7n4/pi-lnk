# 积分展示单一真相源（价目表）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让前端所有积分展示值经 `GET /api/pricing/quote`（复用计费 `pricing.quote` 读价目表）派生，使展示值 == 计费值，并把文本回合「预估 → 结算权威值覆盖」契约锁死。

**Architecture:** 服务端新增只读 quote 端点（与计费同源）；前端新增 `usePricingQuote` 组合式统一替换图片/精修面板的硬编码积分展示；文本回合 `turn_settled` 防御性清空预估态。管理后台价目表成为唯一真相源，改价只改表。

**Tech Stack:** NestJS（PricingController）、Vue 3 `<script setup>` + composable、vitest（前端单测）、sqlite harness（服务端集成单测）、Prisma price_list 既有表。

**Spec:** `docs/superpowers/specs/2026-11-02-points-display-single-source.md`

## Global Constraints

- 单一真相源：所有展示积分值必须经 `pricing.quote()` 或其返回的 `chargedPoints` 派生；禁止展示热路径直接调用 `imageGenerationCredits` / `IMAGE_EDIT_MODEL_PRICING` / `estimateCreditsFromUsdCost` 作为最终数字（spec §4 R-SINGLE-SOURCE）。
- 改价只改表：本次修复后运营改价目表条目（如 `image:1K:1` 33→X），前端展示与后端计费同时生效，不动代码（spec §4 R-NO-CODE-CHANGE-ON-REPRICE）。
- 端点契约：`GET /api/pricing/quote` 复用 `pricing.quote(query, undefined)`（global 表），响应 `{code:0,message:"ok",data:{credits,ruleVersion,degraded}}`，永不 throw（spec §5）。
- 分支纪律：本计划全部改在 worktree `fix/points-display-single-source`（基于 origin/master `845eb510`），不直接动 master。
- 提交风格：`fix(scope): 描述`，小步提交；CI 全绿后 squash merge。

## Review Focus

- **输入/失败模式 1（空表/降级）**：`GET /api/pricing/quote` 在价目表缺失时返回 `degraded:true` + 常量兜底，前端标「预估」但仍与计费同值——不报错、不显示 0。
- **输入/失败模式 2（网络不可达）**：`usePricingQuote` fetch 失败时回落本地 `estimateImageCredits`，`isFallback=true`，且初始同步显示本地估算避免闪烁。
- **输入/失败模式 3（文本回合结算后）**：`turn_settled` 到达后 `liveEstimatedCredits` 必须为 `null`，状态行只显「已结算 -X积分」，预估绝不残留为最终数字。
- **输入/失败模式 4（精修模型切换）**：`RefineSidePanel` 切换 `modelKey` 时 `usePricingQuote` 的 `buildQuery` 变化须触发重取，展示值随价目表 `image_edit:<model>` 行更新。
- **输入/失败模式 5（重复请求）**：同一 query 多次渲染只发一次请求（模块级缓存命中）。

---

### Task 1: 服务端 quote 端点（与计费同源）

**Files:**
- Modify: `apps/server/src/pricing/pricing.controller.ts`
- Test: `apps/server/src/pricing/pricing.controller.quote.sqlite.integration.test.ts` (新建)

**Interfaces:**
- Consumes: `PricingService.quote(PricingQuery, userId?)`（既有，返回 `{credits, ruleVersion, grayReleaseId?}`）
- Produces: `GET /api/pricing/quote` 返回 `{code:0, message:"ok", data:{credits, ruleVersion, degraded}}`

- [ ] **Step 1: 写失败测试**（`pricing.controller.quote.sqlite.integration.test.ts`，照 `pricing.controller.sqlite.integration.test.ts` harness 写）：

```ts
it('image:1K:1 经 quote 端点返回价目表值 33（degraded:false）', async () => {
  await seedActiveVersion(prisma, 'v2', [{ matchKey: 'image:1K:1', capability: 'image', credits: 33 }])
  const res = await controller.quote({ capability: 'image', resolution: '1K', count: '1' } as any)
  expect(res.code).toBe(0)
  expect(res.data.credits).toBe(33)
  expect(res.data.degraded).toBe(false)
  expect(res.data.ruleVersion).toBe('v2')
})
it('空表：quote 端点返回 degraded:true + 常量兜底（image 1K = 10）', async () => {
  const res = await controller.quote({ capability: 'image', resolution: '1K', count: '1' } as any)
  expect(res.code).toBe(0)
  expect(res.data.credits).toBe(10)
  expect(res.data.degraded).toBe(true)
})
```

- [ ] **Step 2: 运行测试确认失败** `cd apps/server && pnpm vitest run pricing.controller.quote` → 失败（方法不存在）

- [ ] **Step 3: 最小实现**：在 `PricingController` 增加

```ts
@Get('quote')
async quote(@Query() q: Record<string, string>) {
  const query = {
    capability: q.capability as any,
    modelKey: q.modelKey,
    count: q.count != null ? Number(q.count) : undefined,
    resolution: q.resolution,
    audioKind: q.audioKind as any,
    duration: q.duration != null ? Number(q.duration) : undefined,
    videoMode: q.videoMode,
    referenceImageCount: q.referenceImageCount != null ? Number(q.referenceImageCount) : undefined,
    referenceVideoCount: q.referenceVideoCount != null ? Number(q.referenceVideoCount) : undefined,
  }
  const r = await this.pricing.quote(query, undefined)
  return { code: 0, message: 'ok', data: { credits: r.credits, ruleVersion: r.ruleVersion, degraded: r.ruleVersion === 'constants-fallback' } }
}
```
（保留既有 `@Get('active') active()` 不变。）

- [ ] **Step 4: 运行测试确认通过** `cd apps/server && pnpm vitest run pricing.controller.quote` → PASS

- [ ] **Step 5: 提交** `git add apps/server/src/pricing/pricing.controller.ts apps/server/src/pricing/pricing.controller.quote.sqlite.integration.test.ts && git commit -m "fix(pricing): 新增只读 quote 端点，与计费同源读价目表"`

### Task 2: 前端 fetch 封装

**Files:**
- Create: `apps/web/src/services/pricing-api.ts`
- Test: `apps/web/src/services/pricing-api.test.ts` (新建，mock fetch)

**Interfaces:**
- Consumes: `apiUrl`（`services/api-base.ts`）
- Produces: `fetchPriceQuote(query): Promise<{credits, ruleVersion, degraded}>`、`PriceQuoteQuery` / `PriceQuoteResult` 类型

- [ ] **Step 1: 写失败测试**

```ts
import { fetchPriceQuote } from './pricing-api'
it('拼 querystring 并解析信封', async () => {
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: 0, data: { credits: 33, ruleVersion: 'v2', degraded: false } }) } as any)
  const r = await fetchPriceQuote({ capability: 'image', count: 1, resolution: '1K' })
  expect(r.credits).toBe(33)
  expect(fetch as any).toHaveBeenCalledWith(expect.stringContaining('/pricing/quote?capability=image'))
})
```

- [ ] **Step 2: 运行失败** `cd apps/web && pnpm vitest run pricing-api` → 失败

- [ ] **Step 3: 实现**

```ts
import { apiUrl } from './api-base'
export interface PriceQuoteQuery { capability: string; count?: number; resolution?: string; modelKey?: string; audioKind?: string; duration?: number; videoMode?: string; referenceImageCount?: number; referenceVideoCount?: number }
export interface PriceQuoteResult { credits: number; ruleVersion: string; degraded: boolean }
export async function fetchPriceQuote(q: PriceQuoteQuery): Promise<PriceQuoteResult> {
  const p = new URLSearchParams()
  p.set('capability', q.capability)
  if (q.count != null) p.set('count', String(q.count))
  if (q.resolution) p.set('resolution', q.resolution)
  if (q.modelKey) p.set('modelKey', q.modelKey)
  if (q.audioKind) p.set('audioKind', q.audioKind)
  if (q.duration != null) p.set('duration', String(q.duration))
  if (q.videoMode) p.set('videoMode', q.videoMode)
  if (q.referenceImageCount != null) p.set('referenceImageCount', String(q.referenceImageCount))
  if (q.referenceVideoCount != null) p.set('referenceVideoCount', String(q.referenceVideoCount))
  const res = await fetch(apiUrl(`/pricing/quote?${p.toString()}`))
  if (!res.ok) throw new Error(`pricing quote failed: ${res.status}`)
  const body = (await res.json()) as { code: number; data: PriceQuoteResult }
  if (body.code !== 0) throw new Error(`pricing quote error: ${body.code}`)
  return body.data
}
```

- [ ] **Step 4: 运行通过** `cd apps/web && pnpm vitest run pricing-api` → PASS

- [ ] **Step 5: 提交** `git add apps/web/src/services/pricing-api.ts apps/web/src/services/pricing-api.test.ts && git commit -m "fix(pricing): 前端 fetchPriceQuote 封装，读 quote 端点"`

### Task 3: usePricingQuote 组合式

**Files:**
- Create: `apps/web/src/composables/usePricingQuote.ts`
- Test: `apps/web/src/composables/usePricingQuote.test.ts` (新建，mock fetchPriceQuote)

**Interfaces:**
- Consumes: `fetchPriceQuote`（`services/pricing-api.ts`）
- Produces: `usePricingQuote(buildQuery: () => PriceQuoteQuery, fallback: () => number): { credits: Ref<number>, isFallback: Ref<boolean> }`

- [ ] **Step 1: 写失败测试**（覆盖 Review Focus 2/5：先 fallback 后权威、失败回落、缓存命中不重复）

```ts
import { usePricingQuote } from './usePricingQuote'
import { fetchPriceQuote } from '@/services/pricing-api'
vi.mock('@/services/pricing-api')
it('初始同步显示 fallback，端点返回后翻为权威值', async () => {
  const f = vi.fn().mockResolvedValue({ credits: 33, ruleVersion: 'v2', degraded: false })
  ;(fetchPriceQuote as any).mockImplementation(f)
  const { credits, isFallback } = usePricingQuote(() => ({ capability: 'image', count: 1, resolution: '1K' }), () => 10)
  expect(credits.value).toBe(10) // 初始回落，无闪烁
  await flushPromises()
  expect(credits.value).toBe(33)
  expect(isFallback.value).toBe(false)
})
it('fetch 失败回落 fallback 且 isFallback=true', async () => {
  ;(fetchPriceQuote as any).mockRejectedValue(new Error('net'))
  const { credits, isFallback } = usePricingQuote(() => ({ capability: 'image' }), () => 10)
  await flushPromises()
  expect(credits.value).toBe(10)
  expect(isFallback.value).toBe(true)
})
it('同 query 只请求一次（缓存命中）', async () => {
  const f = vi.fn().mockResolvedValue({ credits: 33, ruleVersion: 'v2', degraded: false })
  ;(fetchPriceQuote as any).mockImplementation(f)
  const q = () => ({ capability: 'image', resolution: '1K' })
  const a = usePricingQuote(q, () => 10); await flushPromises()
  const b = usePricingQuote(q, () => 10); await flushPromises()
  expect(f).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: 运行失败** → 失败

- [ ] **Step 3: 实现**

```ts
import { ref, watch, type Ref } from 'vue'
import { fetchPriceQuote, type PriceQuoteQuery } from '@/services/pricing-api'

const cache = new Map<string, { credits: number; ruleVersion: string; degraded: boolean }>()

export function usePricingQuote(buildQuery: () => PriceQuoteQuery, fallback: () => number) {
  const credits = ref<number>(fallback())
  const isFallback = ref(true)
  let token = 0
  watch(
    buildQuery,
    async () => {
      const my = ++token
      const q = buildQuery()
      const key = JSON.stringify(q)
      try {
        const hit = cache.get(key) ?? (await fetchPriceQuote(q))
        if (!cache.has(key)) cache.set(key, hit)
        if (my !== token) return
        credits.value = hit.credits
        isFallback.value = hit.degraded
      } catch {
        if (my !== token) return
        credits.value = fallback()
        isFallback.value = true
      }
    },
    { immediate: true, deep: true },
  )
  return { credits, isFallback }
}
```

- [ ] **Step 4: 运行通过** `cd apps/web && pnpm vitest run usePricingQuote` → PASS

- [ ] **Step 5: 提交** `git add apps/web/src/composables/usePricingQuote.ts apps/web/src/composables/usePricingQuote.test.ts && git commit -m "fix(pricing): usePricingQuote 组合式，展示值统一走价目表"`

### Task 4: ImageDockPanel 接入

**Files:**
- Modify: `apps/web/src/components/canvas/dock-studio/panels/ImageDockPanel.vue:28,97`

**Interfaces:**
- Consumes: `usePricingQuote`（`composables/usePricingQuote.ts`）、`estimateImageCredits`（`@/constants/credits`，仅作 fallback）
- Produces：模板中 `:credits="credits"`（DockCreditBadge）现由响应式 `Ref<number>` 驱动

- [ ] **Step 1: 改 import** 删除 `import { estimateImageCredits } from '@/constants/credits'`，改为 `import { usePricingQuote } from '@/composables/usePricingQuote'` 与 `import { estimateImageCredits } from '@/constants/credits'`

- [ ] **Step 2: 替换 credits 定义**（原 `const credits = computed(() => estimateImageCredits(imageCount.value, imageResolution.value))`）：

```ts
const { credits, isFallback } = usePricingQuote(
  () => ({ capability: 'image', count: imageCount.value, resolution: imageResolution.value }),
  () => estimateImageCredits(imageCount.value, imageResolution.value),
)
```

- [ ] **Step 3: 在 template 的 DockCreditBadge 使用 isFallback**（如 `:title` 已有「预估消耗积分 N」，可加 `:class="{ 'is-estimate': isFallback }"` 或直接透传）；确认 `:credits="credits"` 因 auto-unwrap 仍可用。

- [ ] **Step 4: 运行 `ImageDockPanel` 相关测试**（若有）`cd apps/web && pnpm vitest run ImageDockPanel` → PASS

- [ ] **Step 5: 提交** `git add apps/web/src/components/canvas/dock-studio/panels/ImageDockPanel.vue && git commit -m "fix(pricing): 图片生成 dock 积分改读价目表 quote"`

### Task 5: RefineSidePanel 接入

**Files:**
- Modify: `apps/web/src/components/canvas/refine/RefineSidePanel.vue:8,15,171`

**Interfaces:**
- Consumes: `usePricingQuote`、`IMAGE_EDIT_MODEL_PRICING`（`@lnkpi/shared`，仅 fallback）
- Produces：`credits` 响应式，随 `modelKey` 走 `image_edit:<model>` 价目表行

- [ ] **Step 1: 改 import**：保持 `IMAGE_EDIT_MODEL_PRICING` import（fallback 用）；增 `import { usePricingQuote } from '@/composables/usePricingQuote'`；移除 `estimateImageCredits` 直接展示用法（仍可作为 fallback）。

- [ ] **Step 2: 替换 credits**（原 `const credits = computed(() => IMAGE_EDIT_MODEL_PRICING[modelKey.value] ?? estimateImageCredits(1))`）：

```ts
const { credits } = usePricingQuote(
  () => ({ capability: 'image_edit', modelKey: modelKey.value }),
  () => IMAGE_EDIT_MODEL_PRICING[modelKey.value] ?? estimateImageCredits(1),
)
```

- [ ] **Step 3: 验证 modelKey 为 ref 且 buildQuery 读其 `.value`**（确认 `modelKey` 在 RefineSidePanel 为 `ref`/响应式，否则改为 `() => ({ capability:'image_edit', modelKey: modelKey.value })` 仍正确）。

- [ ] **Step 4: 运行相关测试** `cd apps/web && pnpm vitest run RefineSidePanel` → PASS

- [ ] **Step 5: 提交** `git add apps/web/src/components/canvas/refine/RefineSidePanel.vue && git commit -m "fix(pricing): 精修面板积分改读价目表 image_edit 行"`

### Task 6: 文本回合预估→结算覆盖（补设计意图缺口）

**Files:**
- Modify: `apps/web/src/stores/agent.ts:587-599`（`trackTurnSettled`）
- Test: `apps/web/src/stores/agent.settled-override.test.ts`（或并入 `agent.test.ts`）

**Interfaces:**
- Consumes: `liveEstimatedCredits`（既有 `Ref<number|null>`）
- Produces：`trackTurnSettled` 内 `liveEstimatedCredits.value = null`，确保预估态在结算后清零

- [ ] **Step 1: 写失败测试**

```ts
it('turn_settled 后 liveEstimatedCredits 清零（预估不残留为最终数字）', () => {
  const store = useAgentStore()
  store.trackTurnUsage({ inputTokens: 100, outputTokens: 50, estimatedCredits: 2 })
  expect(store.liveEstimatedCredits).toBe(2)
  store.trackTurnSettled({ holdId: 'h', credits: 14 })
  expect(store.liveEstimatedCredits).toBeNull()
})
```

- [ ] **Step 2: 运行失败** → 失败（`liveEstimatedCredits` 仍 2）

- [ ] **Step 3: 实现**：在 `trackTurnSettled` 函数体首行加 `liveEstimatedCredits.value = null`（在 `ensureExecutionTrace()` 之后）。

- [ ] **Step 4: 运行通过** `cd apps/web && pnpm vitest run agent.settled-override` → PASS

- [ ] **Step 5: 提交** `git add apps/web/src/stores/agent.ts apps/web/src/stores/agent.settled-override.test.ts && git commit -m "fix(pricing): turn_settled 防御性清空预估态，锁死结算覆盖"`

### Task 7: 类型检查与端到端验证

**Files:** 无新增，仅验证

- [ ] **Step 1: 前端类型检查** `cd apps/web && pnpm vue-tsc --noEmit -p tsconfig.app.json`（或仓库既有 typecheck 脚本）→ 0 错

- [ ] **Step 2: 服务端类型检查** `cd apps/server && pnpm tsc --noEmit` → 0 错

- [ ] **Step 3: 跑全量相关单测** `cd apps/server && pnpm vitest run pricing` + `cd apps/web && pnpm vitest run pricing-api usePricingQuote agent.settled-override` → 全 PASS

- [ ] **Step 4: 提交收尾** 若仅验证无改动则跳过提交；若有 lint 修正一并提交 `git commit -m "chore: 类型检查收尾"`

### Task 8: 推送 + PR + CI + 生产验证

**Files:** 无

- [ ] **Step 1: 推送分支** `git push -u origin fix/points-display-single-source`（https 被代理挡时改用 GitHub REST Git Data API 推送，见团队纪律）

- [ ] **Step 2: 开 PR** `gh pr create --title "fix(pricing): 积分展示单一真相源（价目表）" --body "..."`

- [ ] **Step 3: 盯 CI 全绿** `gh pr checks <n>`

- [ ] **Step 4: squash 合并**（主仓 worktree 占用时勿 `--delete-branch`）

- [ ] **Step 5: 生产取证**（转 `prod-deploy-verify`）：验证「图显值 == 账单 image -N」「回合结算后状态行 == 账单 对话回合结算 -N」
