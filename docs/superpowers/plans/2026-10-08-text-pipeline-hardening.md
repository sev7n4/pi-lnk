# 文本生成链路加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让文本生成链路具备与图片侧同等的超时/重试/兜底/账本能力，消除「永久挂起」与「占位假成功」两类静默缺陷。

**Architecture:** 保持文本生成**同步执行**（不引入 detached），采纳图片侧 record-first 顺序（先建 generating record → 扣费带 generationId → 同步生成 → 更新终态），使 reaper 能观测崩溃残留。同时把 `vision-text.ts` 这条被遗漏的独立分支纳入统一的上游调用纪律。

**Tech Stack:** TypeScript · NestJS · Prisma · SQLite · Vitest · pnpm workspace

**Spec:** `docs/superpowers/specs/2026-10-08-text-pipeline-hardening-design.md`

---

## Global Constraints

- **工作分支**：`fix/text-pipeline-hardening`（已创建，勿向本地 master 提交）
- **Node runtime**：`/Users/4seven/.workbuddy/binaries/node/versions/22.22.2-6/bin/node`
- **测试命令**：
  - `packages/agent`：`pnpm --filter @lnkpi/agent exec vitest run`
  - `apps/server`：`pnpm test:server`
- **上游调用纪律**：所有上游 HTTP 一律走 `upstreamFetch`（`packages/agent/src/tools/upstream-fetch.ts`），**禁止裸 `fetch`**
- **`!res.ok` 纪律**：`fetch` 对 4xx/5xx 是正常返回，必须在 `!res.ok` 分支显式 `throw`，否则 `withUpstreamRetry` 永不触发（见 `upstream-retry.ts:12-15`）
- **超时文案纪律**：超时错误文案必须含 ASCII `timeout`（`upstream-retry.ts` 的 `/timed? ?out/i` 靠它判可重试）
- **超时不等式**：`upstream-fetch.test.ts:93-94` 断言 `UPSTREAM_FETCH_TIMEOUT_MS * 3 + 4500 < 180_000`。任何改动单次超时的 PR 必须重算并保持成立
- **DTO 纪律**：`apps/server/src/main.ts:30` 是 `ValidationPipe({ transform: true, whitelist: true })`。DTO 新增可选字段**必须**标 `@IsOptional()`，否则被静默剥离
- **重试参数**：一律 `attempts=3, baseDelayMs=1500`（与图片侧一致），最坏 `45_000×3 + 4_500 = 139_500ms`
- **⛔ 不改**：`vendor/` · `prompt-registry/` 规则正文 · 工具分层（`tiering.ts`） · `services/pi-runtime/src/tools/config.ts`（210s override 已足够）
- **⛔ 本窗口不做**：图片侧 3 条未修 consume 路径（`studio:1311` / `studio:1492` / `material.service:413`）· O7 幂等键 · O8 限流 · O10 规则缓存

## Review Focus

以下五类输入/状况最可能咬人，而 spec 未穷举。每条都已在下方对应 Task 中配了测试。

1. **vision 请求带图片 payload 比纯文本慢** → 45s 可能不足，表现为 `UpstreamTimeoutError` 而非成功。合理预期：超时必须是**有界失败**，绝不能是永久 pending。→ Task 2
2. **`!res.ok` 的 throw 位置写错**（放在 retry 回调外）→ 4xx/5xx 不重试，上游 503 时用户直接见失败而非自动恢复。合理预期：503 应被重试 3 次。→ Task 2 变异验证
3. **文本生成并发时 reaper 误回收** → 正在生成的 text 被当作孤儿退款。合理预期：只回收超阈值且仍处 `generating` 的记录。→ Task 4
4. **DTO 加字段漏 `@IsOptional()`** → 功能看似上线实则静默失效，无任何报错。合理预期：字段必须穿透 ValidationPipe。→ Task 6
5. **扣费成功但建 record 失败** → 已扣费、零 record、零退款。合理预期：占位 record 要被删除，且不产生 generating 残留。→ Task 3

---

## File Structure

| 文件 | 责任 | Task |
|---|---|---|
| `packages/agent/src/refs/vision-text.ts` | vision 文本生成（上游调用 + 占位） | 1, 2, 3 |
| `packages/agent/src/refs/vision-text.test.ts` | vision 路径的行为测试 | 1, 2 |
| `packages/agent/src/tools/text-provider.ts` | 非 vision 文本生成（上游调用 + 占位） | 4, 5, 3 |
| `packages/agent/src/tools/text-provider.test.ts` | 非 vision 路径的行为测试 | 4, 5 |
| `packages/agent/src/refs/text-generation.ts` | 三分支路由 + retryCount 传递 + 上下文注入 | 3, 6 |
| `apps/server/src/studio/studio.service.ts` | `generateText` 编排（扣费 + record + 退款 + 可观测字段） | 3 |
| `apps/server/src/studio/generation-reaper.service.ts` | 在飞任务回收 | 4 |
| `apps/server/src/agent/agent-canvas-tools.controller.ts` | 内部工具端点 DTO | 6 |
| `apps/server/src/agent/agent-canvas-tools.service.ts` | 内部工具服务 | 6 |
| `services/pi-runtime/src/tools/generation.ts` | tool body 透传 nodeContext | 6 |

**Task 编号 ≠ spec 编号**，对照关系：

| spec | plan Task | 依赖 |
|---|---|---|
| G1' vision 重试+超时（最高性价比） | Task 2 | — |
| G2' vision 占位 | Task 1 | — |
| G3 record-first + 账本 | Task 3 | — |
| G0 可观测（降级为 metadata 字段） | Task 3 Step 5 | Task 2 |
| G1 非 vision 重试 | Task 4 | Task 3 |
| G4 reaper 扩 text | Task 4 | **Task 3（必须）** |
| G2 非 vision 占位 | Task 5 | Task 4 |
| G5 世界状态注入 | Task 6 | —（独立 PR） |

---

## Task 1: vision 路径的占位改抛错（先红后绿）

**Files:**
- Modify: `packages/agent/src/refs/vision-text.ts:19-42`（删 `buildPlaceholder`）、`:57-59`（改抛错）
- Test: `packages/agent/src/refs/vision-text.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `generateTextWithImages(prompt, imageUrls, opts)` 签名不变；行为变更 —— 无 apiKey 时从 resolve 改为 reject

- [ ] **Step 1: 改写现存断言占位的测试为断言抛错**

`packages/agent/src/refs/vision-text.test.ts` 中 `describe('generateTextWithImages without key')` 的两个用例当前**断言占位存在**，必须先改成断言抛错（否则改动后测试仍绿，失去判别力）。

```ts
describe('generateTextWithImages without key', () => {
  afterEach(() => {
    delete process.env.OPENAI_API_KEY
  })

  it('throws instead of returning a placeholder', async () => {
    await expect(
      generateTextWithImages('春季连衣裙', ['https://example.com/dress.jpg']),
    ).rejects.toThrow(/credentials missing/)
  })

  it('never returns placeholder draft content', async () => {
    await expect(
      generateTextWithImages('', ['https://example.com/a.jpg']),
    ).rejects.toThrow()
    // 断言：不可能出现占位文案
    await expect(
      generateTextWithImages('x', ['https://example.com/a.jpg']).catch((e: Error) => e.message),
    ).resolves.not.toContain('草案')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @lnkpi/agent exec vitest run src/refs/vision-text.test.ts
```
Expected: FAIL —— 当前实现 resolve 占位文案而非 reject

- [ ] **Step 3: 改实现**

`packages/agent/src/refs/vision-text.ts`：

1. **删除** `buildPlaceholder` 整个函数（原 `:19-42`）
2. **替换** `:57-59` 的占位 return：

```ts
  const key = opts.apiKey ?? process.env.OPENAI_API_KEY
  if (!key) {
    throw new Error('vision text credentials missing: set OPENAI_API_KEY or provide a BYOK key')
  }
```

- [ ] **Step 4: 确认无残留引用**

```bash
git grep -n buildPlaceholder -- packages/ apps/ services/
```
Expected: 零命中（函数已删，无人调用）

- [ ] **Step 5: 运行测试确认通过**

```bash
pnpm --filter @lnkpi/agent exec vitest run src/refs/vision-text.test.ts
```
Expected: PASS

- [ ] **Step 6: 变异验证**

把抛错改回 `return { text: '草案' }`，重跑测试。
Expected: **必须 FAIL**。若仍 PASS ⇒ 测试无效，重写。

- [ ] **Step 7: 提交**

```bash
git add packages/agent/src/refs/vision-text.ts packages/agent/src/refs/vision-text.test.ts
git commit -m "fix(agent): vision 文本无凭据改抛错，消除占位假成功

buildPlaceholder 返回硬编码模板并被标 completed，生产已有 7 笔
（2026-07-14）与 PlaceholderTextProvider 文案逐字吻合的记录。

抛错后由 studio 层既有 catch 接住，落 failed/fallback_pending + 退款，
与 image-provider.ts:30 的 PlaceholderImageProvider 行为一致。"
```

---

## Task 2: vision 路径换 upstreamFetch + 加超时与重试

**Files:**
- Modify: `packages/agent/src/refs/vision-text.ts:1-2`（import）、`:64-86`（fetch 调用）
- Test: `packages/agent/src/refs/vision-text.test.ts`

**Interfaces:**
- Consumes: Task 1 的抛错行为
- Produces: `generateTextWithImages` 对上游调用具备 45s 超时 + 3 次重试

- [ ] **Step 1: 写超时测试（最关键的一条）**

```ts
it('aborts a hanging upstream instead of pending forever', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    ),
  )
  await expect(
    generateTextWithImages('x', ['https://example.com/a.jpg'], { apiKey: 'k' }),
  ).rejects.toThrow()
}, 60_000)
```

- [ ] **Step 2: 运行确认失败（或挂起）**

```bash
pnpm --filter @lnkpi/agent exec vitest run src/refs/vision-text.test.ts -t 'aborts a hanging upstream'
```
Expected: FAIL —— 裸 `fetch` 无 signal，挂起直到 vitest 超时

- [ ] **Step 3: 写重试测试**

```ts
it('retries on 503 and succeeds on second attempt', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'unavailable' })
    .mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok result' } }] }),
    })
  vi.stubGlobal('fetch', fetchMock)
  const result = await generateTextWithImages('x', ['https://example.com/a.jpg'], {
    apiKey: 'k',
    baseUrl: 'https://example.invalid/v1',
  })
  expect(result.text).toBe('ok result')
  expect(fetchMock.mock.calls.length).toBe(2)
}, 30_000)

it('does not retry on non-retryable error', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: false, status: 400, text: async () => 'model_not_found' })
  vi.stubGlobal('fetch', fetchMock)
  await expect(
    generateTextWithImages('x', ['https://example.com/a.jpg'], {
      apiKey: 'k',
      baseUrl: 'https://example.invalid/v1',
    }),
  ).rejects.toThrow()
  expect(fetchMock).toHaveBeenCalledOnce()
}, 30_000)
```

- [ ] **Step 4: 运行确认失败**

```bash
pnpm --filter @lnkpi/agent exec vitest run src/refs/vision-text.test.ts
```
Expected: FAIL —— 503 场景当前只调 1 次就抛错

- [ ] **Step 5: 改实现**

`packages/agent/src/refs/vision-text.ts` 顶部加 import：

```ts
import { upstreamFetch } from '../tools/upstream-fetch'
import { withUpstreamRetry } from '../tools/upstream-retry'
```

替换 `:64-86` 的 fetch 调用。**⛔ 关键：`!res.ok` 的 throw 必须在 `withUpstreamRetry` 回调内部**：

```ts
  const res = await withUpstreamRetry(async () => {
    const r = await upstreamFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0.7,
        messages: [
          { role: 'system', content: ECOMMERCE_VISION_SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'text', text: userText },
              ...urls.map((url) => ({ type: 'image_url', image_url: { url } })),
            ],
          },
        ],
      }),
    })
    // ⛔ 纪律：必须在回调内 throw，否则 4xx/5xx 不会触发重试
    if (!r.ok) throw new Error(`Vision API ${r.status}: ${await r.text()}`)
    return r
  })
```

- [ ] **Step 6: 运行确认通过**

```bash
pnpm --filter @lnkpi/agent exec vitest run src/refs/vision-text.test.ts
```
Expected: PASS（全部用例）

- [ ] **Step 7: 变异验证（两条，各必须红）**

7a. 把 `upstreamFetch` 改回裸 `fetch`（去掉 signal）→ 超时测试**必须 FAIL**
7b. 把 `if (!r.ok) throw` 移到回调**外** → 503 重试测试**必须 FAIL**

任一仍 PASS ⇒ 对应测试无效，重写。

- [ ] **Step 8: 提交**

```bash
git add packages/agent/src/refs/vision-text.ts packages/agent/src/refs/vision-text.test.ts
git commit -m "fix(agent): vision 文本上游调用补超时与重试

vision-text.ts:64 用裸 fetch，是文本侧唯一无超时保护的上游请求 ——
2026-10-08 生产事故根因（fetch 无 AbortSignal ⇒ await 永不 settle）的残留，
#271 引入 upstreamFetch 时漏掉了本文件。隧道楔死时此路径永久挂起：
不落 record、不退款，且因无 generating 态而 reaper 也扫不到。

生产活跃：visionUsed=1 记录 82 笔（text 66 + prompt 16）。
改后：45s 超时 + 3 次退避重试，最坏 139.5s < runtime 210s < nginx 300s。"
```

---

## Task 3: 文本 record-first + 账本对齐

**Files:**
- Modify: `apps/server/src/studio/studio.service.ts:698-836`（`generateText`）
- Test: `apps/server/src/studio/studio.integration.test.ts`（该文件已 mock `createTextProvider`）

**Interfaces:**
- Consumes: 无（与 Task 1/2 独立）
- Produces: `generateText` 产出的 record 携带非空 `generationId`；三处退款的 `generationId` 均为 `record.id`

- [ ] **Step 1: 写失败测试：账本 generationId 非空**

在 `apps/server/src/studio/studio.integration.test.ts` 加：

```ts
it('records generationId on both charge and refund for text generation', async () => {
  const consumeCalls: Array<{ category: string; generationId: string | null }> = []
  // 复用文件内已有的 prisma / points mock
  // 触发一次成功的 generateText，然后：
  expect(consumeCalls.length).toBeGreaterThan(0)
  for (const c of consumeCalls) {
    expect(c.generationId).not.toBeNull()
  }
})
```

> **实施注**：该测试文件已有 `createTextProvider` mock 与 prisma/points 桩。实施者须先读文件顶部的既有 setup，照其模式接入 `consume` 调用捕获，不要重写整个 mock 体系。若既有 mock 无法捕获 `consumeMeta` 的实参，则改为直接断言 `prisma.generationRecord.create` 的调用顺序（create 在 consume 之前）。

- [ ] **Step 2: 运行确认失败**

```bash
pnpm test:server -- studio.integration
```
Expected: FAIL —— 当前 `generationId` 为 `null`

- [ ] **Step 3: 改实现：record-first**

`apps/server/src/studio/studio.service.ts` 的 `generateText` 重排为：

```ts
    const cost = 5
    const chargeReason = '文本生成'
    const resolved = await this.resolver.resolveForGeneration(userId, model, 'text')
    const { modelKey: resolvedKey, entry, fallback } = resolveModelKey('text', resolved.modelName)
    const gatewayModelId =
      resolved.source === 'user' ? resolved.modelName : entry.gatewayModelId
    const { mergedText, skippedMerge, mergeDegraded, referenceImages } = await this.resolveMergedPrompt(
      prompt, refs, 'text', mentionedKeys,
      resolved.source === 'user' ? resolved.credentials : undefined,
      gatewayModelId,
    )
    const storeModel = resolved.source === 'user' ? model ?? resolvedKey : resolvedKey
    const textOpts = {
      thinking: !!thinking,
      thinkingEffort: thinkingEffort === 'max' ? ('max' as const) : ('high' as const),
    }
    const baseMeta = { /* 保持原样不变 */ }

    // 账本对账：先建 generating 占位再扣费，扣费交易携带 generationId。
    // 与 generateImage 主路径（studio.service.ts:1132-1177）同构。
    const record = await this.prisma.generationRecord.create({
      data: {
        userId,
        type: 'text',
        prompt: mergedText,
        model: storeModel,
        url: null,
        status: 'generating',
        metadata: JSON.stringify(applyChargeMeta({ ...baseMeta }, cost)),
        ...withCanvasScope(scope),
      },
    })
    try {
      await this.points.consume(
        userId,
        cost,
        chargeReason,
        consumeMeta('text', { model: model ?? null, generationId: record.id }),
      )
    } catch (err) {
      await this.prisma.generationRecord
        .delete({ where: { id: record.id } })
        .catch(() => undefined)
      throw err
    }
```

然后把后续的 `create` 全部改为 `update`：
- 成功分支 → `update({ where: { id: record.id }, data: { status: 'completed', metadata: JSON.stringify(applyChargeMeta({ ...baseMeta, text, visionUsed }, cost)) } })`
- 平台失败分支 → `update({ where: { id: record.id }, data: { status: 'failed', metadata: JSON.stringify(failedMeta) } })`
- BYOK 分支 → `update({ where: { id: record.id }, data: { status: 'fallback_pending', metadata: JSON.stringify(this.byokPendingMeta(resolved, err, cost, { originalModel: model, ...baseMeta })) } })`

三处退款的 `refundMeta(..., { model: resolved.modelName, generationId: null })` 全部改为 `generationId: record.id`。

⛔ **保持不变**：`if (cancel?.isCancelled())` 分支仍在生成后检查，退款后 `throwCancelledException(cost)`（取消语义不因 record-first 而改变）；`if (isCancelledException(err)) throw err` 仍在 catch 首位。

- [ ] **Step 4: 运行中间检查**

```bash
pnpm test:server -- studio.integration
```
Expected: 账本测试（Step 1-2）已 PASS；可观测字段在下一步补

- [ ] **Step 5: 加可观测字段（G0，降级实现）**

`apps/server` 与 `packages/agent` **都没有 metrics 设施**（全仓唯一 `Metrics` 在 pi-runtime，另一进程）。加 Prometheus 指标需先给 apps/server 引入 `prom-client` —— 属独立基础设施工作，**不在本计划**。

改用已有的 `GenerationRecord.metadata` 载体。在 Task 3 已加的 `baseMeta` 中补：

```ts
    const baseMeta = {
      modelKey: resolvedKey,
      gatewayModelId,
      channelId: resolved.channelId,
      skippedMerge,
      refsCount: refs?.length ?? 0,
      visionUsed: false,
      referenceImages,
      thinking: textOpts.thinking,
      thinkingEffort: textOpts.thinking ? textOpts.thinkingEffort : undefined,
      // 可观测：重试救回率靠这几个字段 + SQL 统计，不依赖监控设施
      textPath: 'text_provider' as const,   // 'text_provider' | 'vision'
      retryCount: retryCount ?? 0,
      upstreamAttempts: (retryCount ?? 0) + 1,
      ...(fallback && resolved.source === 'platform' ? { modelFallback: true } : {}),
    }
```

`retryCount` 的来源：`generateTextForRefs` 返回值扩展为 `{ text, visionUsed, retryCount }`，由各 provider 从 `withUpstreamRetry` 的 `onRetry` 钩子累加。

**⚠️ 本步骤依赖 Task 2 已为 `vision-text.ts` 建立同样的 `retryCount` 传递**，两条路径的计数口径必须一致（都是「实际重试次数」，非「总尝试数」）。

**验收判据**（上线后跑 SQL 即可，无需监控设施）：
```sql
SELECT json_extract(metadata,'$.retryCount') AS retries,
       json_extract(metadata,'$.textPath') AS path, status, COUNT(*)
FROM GenerationRecord WHERE type IN ('text','prompt')
  AND json_extract(metadata,'$.retryCount') IS NOT NULL
GROUP BY retries, path, status;
```
`retries > 0 AND status='completed'` = 重试救回的生成数。

- [ ] **Step 6: 运行确认通过**

```bash
pnpm test:server -- studio.integration studio.fallback
```
Expected: PASS（注意 `studio.fallback.test.ts` 覆盖 BYOK 回退路径，`:358` 断言 `createTextProvider` 被调用）

- [ ] **Step 7: 变异验证**

把 `consume` 移回 `create` 之前（即恢复原顺序）。
Expected: 测试**必须 FAIL**（`generationId` 变 null）

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/studio/studio.service.ts apps/server/src/studio/studio.integration.test.ts
git commit -m "fix(server): 文本生成改 record-first，账本携带 generationId

生产实测 text 类交易 155/155 笔 generationId 为 NULL（123 success +
23 byok_refund + 9 failed_refund），扣费与生成记录无法 JOIN。

改为「建 generating 占位 → consume 带 generationId → 同步生成 → update
终态」，与 generateImage 主路径（:1132-1177）同构。扣费失败时删除占位，
不留 generating 孤儿。

metadata 补 retryCount/upstreamAttempts/textPath —— apps/server 无 metrics
设施，重试救回率靠这几个字段 + SQL 统计，不引入 prom-client。

保持同步执行：文本秒级完成，detached 的 fast-path 竞态是纯负债。"
```

---

## Task 4: 非 vision 文本路径补重试 + reaper 扩 text

**Files:**
- Modify: `packages/agent/src/tools/text-provider.ts:64-75`、`apps/server/src/studio/generation-reaper.service.ts:24`、`:27-31`、`:103-105`
- Test: `packages/agent/src/tools/text-provider.test.ts`、`apps/server/src/studio/generation-reaper.service.test.ts`

**Interfaces:**
- Consumes: **Task 3 的 record-first**（reaper 依赖 `generating` 态存在）；**Task 2 建立的 `retryCount` 口径**（两条路径必须一致）
- Produces: 非 vision 文本路径具备重试；reaper 回收超阈值的 text generating 记录，退款文案「文本生成」

> ⚠️ **Task 4 必须在 Task 3 之后**。reaper 扫 `status='generating'`，Task 3 未完成时该状态永不出现 ⇒ 本任务无法验证。

- [ ] **Step 1: 写重试测试**

在 `packages/agent/src/tools/text-provider.test.ts` 加：

```ts
describe('OpenAITextProvider retry', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('retries on 429 then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'done' } }] }),
      })
    vi.stubGlobal('fetch', fetchMock)
    const provider = createTextProvider({ apiKey: 'k', baseUrl: 'https://x.invalid/v1' })
    const { text } = await provider.generate('hello')
    expect(text).toBe('done')
    expect(fetchMock.mock.calls.length).toBe(2)
  }, 30_000)

  it('does not retry model_not_found', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 404, text: async () => 'model_not_found' })
    vi.stubGlobal('fetch', fetchMock)
    const provider = createTextProvider({ apiKey: 'k', baseUrl: 'https://x.invalid/v1' })
    await expect(provider.generate('hello')).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledOnce()
  }, 30_000)
})
```

- [ ] **Step 2: 运行确认失败**

```bash
pnpm --filter @lnkpi/agent exec vitest run src/tools/text-provider.test.ts
```
Expected: FAIL —— 429 场景当前只调 1 次

- [ ] **Step 3: 改 text-provider 实现**

`packages/agent/src/tools/text-provider.ts` 加 import 并把 `:64-75` 改为：

```ts
    const res = await withUpstreamRetry(async () => {
      const r = await upstreamFetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      })
      // ⛔ 纪律：必须在回调内 throw
      if (!r.ok) throw new Error(`Text API ${r.status}: ${await r.text()}`)
      return r
    })
```

- [ ] **Step 4: 运行确认通过**

```bash
pnpm --filter @lnkpi/agent exec vitest run src/tools/text-provider.test.ts
```
Expected: PASS

- [ ] **Step 5: 写 reaper text 测试**

在 `apps/server/src/studio/generation-reaper.service.test.ts` 加：

```ts
it('reaps stale text records with 文本生成 refund reason', async () => {
  const thresholdMs = Number(process.env.LNKPI_TEXT_REAP_MINUTES ?? 10) * 60_000
  generationRecord.findMany.mockResolvedValue([
    {
      id: 'rec-text-1',
      type: 'text',
      userId: 'u1',
      model: 'agnes-2.0-flash',
      metadata: JSON.stringify({ chargedPoints: 5 }),
    },
  ])
  const n = await service.reapOnce('manual')
  expect(n).toBe(1)
  expect(points.refundInTx).toHaveBeenCalledWith(
    expect.anything(),
    'u1',
    5,
    '文本生成-超时回收退款',
    expect.objectContaining({}),
  )
  // 阈值：text 用独立的 10min，不是图片的 30min
  expect(thresholdMs).toBe(600_000)
})

it('does not reap twice (exactly-once)', async () => {
  generationRecord.updateMany.mockResolvedValue({ count: 0 })
  const n = await service.reapOnce('manual')
  expect(n).toBe(0)
})
```

- [ ] **Step 6: 运行确认失败**

```bash
pnpm test:server -- generation-reaper
```
Expected: FAIL —— `REAP_TYPES` 不含 `text`，`findMany` 的 where 不匹配

- [ ] **Step 7: 改 reaper 实现**

`apps/server/src/studio/generation-reaper.service.ts`：

1. `:24` → `const REAP_TYPES = ['image', 'image_edit', 'image_upscale', 'text'] as const`
2. `:27-31` 的 `REAP_REASON_BY_TYPE` 增加 `text: '文本生成',`
3. `:103-105` 的阈值解析改为按 type 分派：

```ts
  async reapOnce(reason: 'startup' | 'periodic' | 'manual'): Promise<number> {
    const imageMinutes = Number(process.env.LNKPI_GENERATION_REAP_MINUTES ?? DEFAULT_REAP_MINUTES)
    // 文本生成秒级完成，卡 10 分钟必然是崩溃残留；共用图片的 30min 会让孤儿多存活 20 分钟
    const textMinutes = Number(process.env.LNKPI_TEXT_REAP_MINUTES ?? DEFAULT_TEXT_REAP_MINUTES)
    ...
    // 查询时按 type 分别用各自 cutoff，或取两者较小值以保证不漏
```

**实施注**：最简正确实现是取 `Math.min(imageMinutes, textMinutes)` 作为统一 cutoff 扫全类型（宁可多扫，不可漏扫），多扫到的由 `updateMany` 的 `status='generating'` 守卫兜住。若要精确分派，需两次 `findMany`（按 type 分组用各自 cutoff）。**默认采用两次 findMany 方案**，语义更清晰：

```ts
    const cutoffs: Array<{ types: readonly string[]; cutoff: Date }> = [
      { types: ['image', 'image_edit', 'image_upscale'], cutoff: new Date(Date.now() - imageMinutes * 60_000) },
      { types: ['text'], cutoff: new Date(Date.now() - textMinutes * 60_000) },
    ]
```

同时在 `DEFAULT_REAP_MINUTES` 旁新增 `const DEFAULT_TEXT_REAP_MINUTES = 10`。

4. 更正 `:12-23` 的注释：现有注释称纳入 `image_edit`/`image_upscale` 是覆盖活跃孤儿，实测这两个类型当前零 `generating` 态（completed 9 / failed 68）⇒ 那是历史遗留清理。注释须写明，避免后人误判。

- [ ] **Step 8: 运行确认通过**

```bash
pnpm test:server -- generation-reaper
```
Expected: PASS

- [ ] **Step 9: 变异验证（两条）**

9a. 把 `REAP_TYPES` 的 `'text'` 删掉 → reaper text 测试**必须 FAIL**
9b. 把 `text-provider` 的 `withUpstreamRetry` 改回直接调用 → 重试测试**必须 FAIL**

- [ ] **Step 10: 提交**

```bash
git add packages/agent/src/tools/text-provider.ts packages/agent/src/tools/text-provider.test.ts apps/server/src/studio/generation-reaper.service.ts apps/server/src/studio/generation-reaper.service.test.ts
git commit -m "fix(agent,server): 非 vision 文本补重试，reaper 覆盖 text

text-provider.ts:64 直调 upstreamFetch 未包 withUpstreamRetry，是四类生成
里唯一无重试的。上游 429 抖动时图片自动退避 3 次，文本直接判失败退款。
生产实测 15 条真实故障中 12 条（80%）可被重试救回。

reaper 纳入 text（依赖 Task 3 的 record-first 产生 generating 态），
并给文本独立 10min 阈值：文本秒级完成，卡 10 分钟必然是崩溃残留，
共用图片的 30min 会让孤儿多存活 20 分钟。退款分类走既有
studioPointCategory('text') → 'text'，无需新增映射。

顺带更正注释：image_edit/image_upscale 当前零 generating 态，
reaper 对它们是历史遗留清理而非活跃保护。"
```

---

## Task 5: 非 vision 占位改抛错

**Files:**
- Modify: `packages/agent/src/tools/text-provider.ts:34-40`、`:80-89`
- Test: `packages/agent/src/tools/text-provider.test.ts`

**Interfaces:**
- Consumes: Task 4 的重试改动（同文件，须在其后）
- Produces: `createTextProvider()` 无 apiKey 且无 env 时抛错，不再返回占位

- [ ] **Step 1: 写抛错测试**

```ts
describe('createTextProvider without any credentials', () => {
  afterEach(() => {
    delete process.env.OPENAI_API_KEY
    vi.unstubAllGlobals()
  })

  it('throws instead of returning placeholder text', async () => {
    const provider = createTextProvider()
    await expect(provider.generate('x')).rejects.toThrow(/credentials missing/)
  })

  it('never emits placeholder draft content', async () => {
    const provider = createTextProvider()
    const msg = await provider.generate('万物生剧本').catch((e: Error) => e.message)
    expect(msg).not.toContain('草案')
    expect(msg).not.toContain('霓虹')
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
pnpm --filter @lnkpi/agent exec vitest run src/tools/text-provider.test.ts
```
Expected: FAIL —— 当前返回占位文案

- [ ] **Step 3: 改实现**

删除 `PlaceholderTextProvider` 类（原 `:34-40`），把 `createTextProvider` 的 `:80-89` 改为：

```ts
export function createTextProvider(opts?: ProviderCredentialOpts): TextProvider {
  if (opts?.apiKey) {
    return new OpenAITextProvider(opts.apiKey, opts.baseUrl, opts.model)
  }
  const key = process.env.OPENAI_API_KEY
  if (key) {
    return new OpenAITextProvider(key, process.env.OPENAI_BASE_URL, process.env.OPENAI_CHAT_MODEL)
  }
  throw new Error('text provider credentials missing: set OPENAI_API_KEY or provide a BYOK key')
}
```

同步从 `packages/agent/src/index.ts:8` 移除 `PlaceholderTextProvider` 的导出。

⚠️ `createTextProvider` 从「返回对象」变为「可能抛错」，这是**签名语义变化**。须 grep 全仓确认所有调用点都在 try 块内或能正确处理：

```bash
git grep -n "createTextProvider" -- packages/ apps/ services/
```
逐个核对：`studio.service.ts:2742`（BYOK 回退）在 try 内 ✓；`refs/text-generation.ts:58,76` 由 `generateTextForRefs` 的调用方包裹 ✓。

- [ ] **Step 4: 运行确认通过**

```bash
pnpm --filter @lnkpi/agent exec vitest run src/tools/text-provider.test.ts src/refs/text-generation.test.ts
pnpm test:server -- studio.integration studio.fallback
```
Expected: 全部 PASS

- [ ] **Step 5: 变异验证**

把 throw 改回 `return new PlaceholderTextProvider()` 并恢复该类。
Expected: 测试**必须 FAIL**

- [ ] **Step 6: 提交**

```bash
git add packages/agent/src/tools/text-provider.ts packages/agent/src/tools/text-provider.test.ts packages/agent/src/index.ts
git commit -m "fix(agent): 文本占位改抛错，消除假成功

生产已有 7 笔 completed 记录的内容是 PlaceholderTextProvider 的硬编码
草案（2026-07-14，与文案逐字吻合）。当前虽因 OPENAI_API_KEY 已配置而
不走该分支，但 studio.service.ts:2742 的 BYOK→平台回退完全依赖同一
env，配置一旦回退即复发。

与 image-provider.ts:30 的 PlaceholderImageProvider 行为对齐。"
```

---

## Task 6: 世界状态注入（G5）

**Files:**
- Modify: `services/pi-runtime/src/tools/generation.ts`（tool body 加 `context`）
- Modify: `apps/server/src/agent/agent-canvas-tools.controller.ts`（DTO）
- Modify: `apps/server/src/agent/agent-canvas-tools.service.ts`（透传）
- Modify: `packages/agent/src/refs/text-generation.ts`（system message 注入）
- Test: 对应三个测试文件

**Interfaces:**
- Consumes: 无（独立任务，但**跨 web/runtime 须同窗上线**）
- Produces: `run_text_generation` 可选携带 `nodeContext`，注入到生成 prompt

> ⚠️ **独立 PR**：本任务跨 `services/pi-runtime` 与 `apps/server`，按 `AGENTS.md` 必须同窗上线，但**回滚粒度独立**于 Task 1-5。不得与前五个任务混入同一 PR。

- [ ] **Step 1: 写 DTO 穿透测试（防 whitelist 静默剥离）**

`apps/server/src/agent/agent-canvas-tools.controller.ts` 新建专用 DTO（**不复用** `RunImageGenerationDto`，避免把图片端点的字段契约带进文本）：

```ts
export class RunTextGenerationDto {
  @IsString()
  sessionId!: string

  @IsString()
  userId!: string

  @IsString()
  nodeId!: string

  // ⛔ 必须 @IsOptional()：main.ts:30 的 whitelist:true 会剥掉未标注的字段
  @IsOptional()
  @IsObject()
  nodeContext?: {
    selectionDigest?: string
    canvasSummary?: string
  }
}
```

测试（放在 `apps/server/src/agent/` 下的合适测试文件）：

```ts
it('keeps nodeContext through ValidationPipe whitelist', async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true })
  const dto = await pipe.transform(
    {
      sessionId: 's1',
      userId: 'u1',
      nodeId: 'n1',
      nodeContext: { selectionDigest: '节点A', canvasSummary: '3 个节点' },
    },
    { type: 'body', metatype: RunTextGenerationDto },
  )
  expect(dto.nodeContext).toEqual({ selectionDigest: '节点A', canvasSummary: '3 个节点' })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
pnpm test:server -- agent-canvas-tools
```
Expected: FAIL —— DTO 尚不存在

- [ ] **Step 3: 实现 DTO 并改端点**

`agent-canvas-tools.controller.ts:1254-1258`：

```ts
  @Post('run-text-generation')
  async runTextGeneration(@Body() dto: RunTextGenerationDto) {
    const data = await this.tools.runTextGeneration(dto)
    return { code: 0, message: 'ok', data }
  }
```

- [ ] **Step 4: 写并运行 runtime 侧透传测试**

`services/pi-runtime/src/tools/generation.test.ts` 加：

```ts
it('includes nodeContext in run_text_generation body when provided', async () => {
  // 断言 client.post 收到 { sessionId, userId, nodeId, nodeContext }
})
```

改 `services/pi-runtime/src/tools/generation.ts` 的 `run_text_generation` 分支，body 构造后追加：

```ts
if (context?.nodeContext) body.nodeContext = context.nodeContext
```

> **实施注**：`run_text_generation` 的工具签名当前只有 `node_id`。`nodeContext` 的来源须从 `tc`（turnContext）取，具体字段名以实现时读到的 `tc` 结构为准——注入内容限定为 `selectionDigest` 与 canvas 摘要精简版，**不注入** vision/sidebar/memory 全文。

- [ ] **Step 5: 写并实现 studio 侧注入测试**

`packages/agent/src/refs/text-generation.test.ts` 加：

```ts
it('appends node context to the system message', async () => {
  // 断言 system content 含注入的上下文片段
})
```

`packages/agent/src/refs/text-generation.ts` 的 `TextGenerationWithRefsOptions` 加 `nodeContext?: { selectionDigest?: string; canvasSummary?: string }`，并在构造 messages 时把上下文拼入 system 段。

- [ ] **Step 6: 运行全部测试**

```bash
pnpm --filter @lnkpi/agent exec vitest run
pnpm test:server
pnpm test:runtime
```
Expected: 全部 PASS

- [ ] **Step 7: 变异验证**

删掉 DTO 的 `@IsOptional()`。
Expected: DTO 测试**必须 FAIL**（字段被剥离）

- [ ] **Step 8: 提交**

```bash
git add services/pi-runtime/src/tools/generation.ts apps/server/src/agent/agent-canvas-tools.controller.ts apps/server/src/agent/agent-canvas-tools.service.ts packages/agent/src/refs/text-generation.ts
git commit -m "feat: run_text_generation 注入精简世界状态

链路 A 把画布摘要/选中指代/记忆注入 system prompt，模型据此决定生成某节点
文案；但工具落到 studio.generateText 时上下文全部丢弃，只拿节点自身
prompt + refs 裸调 LLM —— 决策有上下文、执行无上下文。

注入 selectionDigest + canvas 摘要精简版，不注入 vision/sidebar/memory
全文（那是决策阶段已用的内容，生成阶段只需知道在写哪个节点、周围有什么）。

⛔ DTO 新增 nodeContext 必须标 @IsOptional()：main.ts:30 的 whitelist:true
会静默剥掉未标注字段，功能看似上线实则失效且无任何报错。"
```

---

## 交付前检查清单

- [ ] 全部变异验证（spec §5.2 的 8 条）已执行且均能变红
- [ ] `pnpm test` 全绿
- [ ] `pnpm prompt:lint` 绿（未改 prompt-registry，应无影响，但须确认）
- [ ] `pnpm verify-claims` 绿（AGENTS.md 判据 6 管工具故障断言）
- [ ] 生产 env 未新增未消费的环境变量
- [ ] 未改 `vendor/` · `prompt-registry/` · `tiering.ts` · `config.ts`
- [ ] 上线前确认当前非文本生成高峰（文本流量 8 月 236 / 10 月 6，波动大）
- [ ] `runtime-deploy.yml` 需**手派**（纯 workflow_dispatch，无 push 触发）