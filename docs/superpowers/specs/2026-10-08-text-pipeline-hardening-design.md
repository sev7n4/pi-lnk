# 文本生成链路加固 · 设计规格

- 日期：2026-10-08
- 基线：`origin/master` = `0006f33c`
- 输入：`文本生成链路诊断报告.html`（含 §8 生产复核结论）
- 范围：**仅文本（text / prompt）链路**。图片侧 3 条未修 consume 路径不在本窗口边界（见 §7）

---

## 1. 目标与非目标

### 1.1 要解决的问题

文本生成链路相对图片侧已验证加固存在五处缺口。本规格按**「能否验证效果」**排序实施，而非按报告原始 P0 排序（理由见 §2）。

| 编号 | 问题 | 类别 |
|---|---|---|
| G0 | 文本链无可用观测手段（重试是否救回无法证明） | 可观测性 |
| G1 | `text-provider.ts` 上游调用零重试，429/503/fetch failed 直接判失败退款 | 韧性 |
| G1' | **`vision-text.ts` 用裸 `fetch`（无超时保护）+ 零重试** | 韧性 |
| G2 | `PlaceholderTextProvider` 静默返回硬编码草案并标 `completed` | 正确性 |
| G2' | **`vision-text.ts` 的 `buildPlaceholder` 是第二套占位** | 正确性 |
| G3 | 扣费先于 record 创建，崩溃时已扣费 / 零 record / 零退款 | 账本 |
| G4 | reaper 不覆盖 text ⇒ G3 的泄漏无兜底 | 兜底 |
| G5 | `run_text_generation` 丢弃 turnContext，「决策有上下文、执行无上下文」 | 质量 |

> **G1'/G2' 是写 spec 时二次调研新增的**（原诊断报告 §3.1/§3.3 只看了 `text-provider.ts`）。
> `vision-text.ts` 是 `generateTextForRefs` 的第三条分支（`visionUsed=1` 时走），
> **完全绕过 `OpenAITextProvider`**，因此报告的「文本重试」「文本占位」两条结论对它不成立。
> 生产实证：`visionUsed=1` 活跃记录 **82 笔**（text 66 + prompt 16）。
> 详见 §3.2 与 §2.2。

### 1.2 非目标

- 不改 vendor。
- 不改 prompt-registry 规则正文（不触发 6 处同步）。
- 不改工具分层（`run_text_generation` / `run_prompt_generation` 维持 `tiering.ts` 现有豁免状态）。
- 不动 video / audio 链路。
- 不改图片侧任何代码。

---

## 2. 排序依据（为何不按报告原 P0）

报告 §6 按**代码形态**排优先级（谁缺哪个机制），未做生产取证。§8 复核后，四条原判断被推翻：

| 报告原判断 | 生产实测 | 处置 |
|---|---|---|
| ① 零重试 = 最直接韧性缺口 | 可重试故障**全部发生在 2026-09-15 及之前**，此后零真实故障 | 降级为 G1，但**仍做**（12/15 故障可救，见下） |
| ② 占位 = P0 假成功 | 生产 `OPENAI_API_KEY` 已配置 ⇒ **当前**不走占位分支；但 2026-07-14 确有 `completed` 记录内容为占位文案（见 §2.2） | 保留 G2，**严重性上调**为「已发生过的真实事故，配置回退即复发」 |
| ③ 文本无 generating 态 | 现象成立；但真正缺口在图片侧 | 移出本窗口（§7） |
| ④ 文本与图片缺陷等价 | **不等价**：`NO_PROXY` 含 `.agnes-ai.cn` ⇒ 文本绕过代理隧道，图片经隧道出海 | 前提性错误，已修正 |
| ⑤ 文本侧缺陷都在 `text-provider.ts` | **漏**：`vision-text.ts` 是独立第三条分支，三条缺陷各自独立 | 新增 G1'/G2'，见 §2.2 |

**仍然做 G1 的量化依据**：文本 44 条失败中 28 条是 `cancelled`（用户主动取消，非故障），真实故障 15 条中 **12 条（80%）属可重试错误**（429×8、`fetch failed`×3、503×1），仅 3 条 `model_not_found` 属 `NON_RETRYABLE`。

**429 归因**：文案为 `LLM 请求失败: 429 Too Many Requests`，同批伴随 `No available channel for model gemini-3.1-flash` ⇒ 根因是 **agnes 侧该模型渠道容量不足**，非本仓缺陷。重试吸收瞬时抖动，不修复渠道缺失。若该模型长期无渠道，属配置决策（`OPENAI_CHAT_MODEL` 候选摘除），不在本规格范围。

### 2.2 二次调研发现：`vision-text.ts` 是被整体遗漏的分支

`packages/agent/src/refs/text-generation.ts:51` 的 `generateTextForRefs` 有**三条分支**：

| 分支 | 条件 | 走向 |
|---|---|---|
| 无参考图 | `refs.length === 0` | `createTextProvider()` → `OpenAITextProvider`（G1/G2 对象） |
| **vision 模型** | `supportsVisionTextModel(model)` | **`generateTextWithImages()`** → `vision-text.ts`（G1'/G2' 对象） |
| 非 vision 模型带图 | 其余 | `OpenAITextProvider` + `appendImageRefsForTextOnlyPrompt` |

`vision-text.ts` 独立携带三个缺陷，**与 `text-provider.ts` 无任何共享**：

| 缺陷 | 位置 | 说明 |
|---|---|---|
| **无超时保护** | `:64` 裸 `fetch(...)` | ⛔ **这是 2026-10-08 生产事故根因的残留**。事故根因是「上游 fetch 一处 AbortSignal 都没有 ⇒ await 永不 settle」，#271 引入 `upstreamFetch` 时**漏掉了本文件**。隧道楔死时此路径永久挂起：不落 record、不退款，且因无 generating 态而 reaper 也扫不到 |
| 零重试 | `:64` | 同 G1 |
| 第二套占位 | `:58` `buildPlaceholder()` | 独立于 `PlaceholderTextProvider`，触发条件同样是「无 apiKey」 |

**生产证据**：`visionUsed=1` 的活跃记录 **82 笔**（text 66 + prompt 16）⇒ 活跃路径，非死代码。

**占位假成功的实证**：查 `status='completed'` 且 `metadata.text LIKE '%草案%'` 的记录，命中 **7 笔**，其中 2026-07-14 的内容为
`【AI 创作草案】\n\n基于「生成一个万物生剧本」的扩写：\n\n场景一：主角站在霓虹闪烁的街头…`
—— 与 `PlaceholderTextProvider:37` 的硬编码文案**逐字吻合**。

⇒ **报告「占位在生产是死代码」的判断不准确**。准确表述：占位在 `OPENAI_API_KEY` 配置前**确实发生过假成功**（7 月），当前被 env 阻断。严重性从「死代码」上调为「**已发生的事故，配置一旦回退即复发**」。

### 2.1 实施顺序

```
G2' vision 占位 ──► G1' vision 重试+超时 ──┐（最高性价比：它是唯一无超时保护的上游路径）
                                          ├──► G0 metadata 可观测字段
G3 record-first ──► G4 reaper 扩 text─────┘   ← G4 严格依赖 G3
G1 非vision 重试 ──► G2 非vision 占位          ← 与上方序列并行
G5 世界状态注入                                ← 独立 PR，跨 web/runtime 同窗
```

**排序说明**（与 plan 的 Task 编号对照见 plan 的 File Structure 表）：

1. **G1' 排最前**：它是文本侧唯一**真正无超时**的上游路径（裸 `fetch`），修复成本一行，风险敞口是「永久挂起 + 已扣费 + reaper 扫不到」。
2. **G4 严格依赖 G3**：无 `generating` 中间态时 reaper 纳入 text 是空转。
3. **G5 独立 PR**：跨 web/runtime 语义改动，与前后端加固混在一起会让回滚粒度失效。

**G4 严格依赖 G3**：无 `generating` 中间态时，reaper 纳入 `text` 是空转。

---

## 3. 设计

### 3.1 G0 · 可观测性（**降级实现，不建 metrics 设施**）

**调研结论（写 spec 时二次发现）**：`apps/server` 与 `packages/agent` **都没有任何 metrics 设施**——全仓唯一的 `Metrics` 类在 `services/pi-runtime/src/metrics.ts`，那是**另一个进程**。`apps/server` 连 `Logger` 都没用（`git grep "new Logger" apps/server/src/studio/studio.service.ts` 零命中），也没有 `/metrics` 端点。

这解释了 MEMORY 记录的「主路径无指标，96% 图片生成带 nodeId 走画布直连⇒盲区」。

**⇒ 原计划的「加 Prometheus 指标」不可行**，它需要先给 apps/server 引入 `prom-client` —— 那是独立的基础设施工作，不属本规格。

**降级方案**：利用已有的 `GenerationRecord.metadata` 承载可观测字段。metadata 已在生产落库、已在 `points-usage` 侧被查询，是现成的载体。

| 字段 | 落点 | 用途 |
|---|---|---|
| `retryCount` | `generateText` 的 `baseMeta` | 本次生成实际重试次数（0 表示上游一次成功） |
| `upstreamAttempts` | 同上 | 总尝试次数（`retryCount + 1`） |
| `visionUsed` | 已存在 | 区分 vision 路径（G1'）与纯文本路径（G1） |
| `textPath` | 新增 | `'text_provider'` \| `'vision'` —— 重试与占位修复分属两条路径，需能分开归因 |

**已存在的免费信号**（无需任何新增）：
- `tool_error_kinds_total{tool="run_text_generation", errorKind=...}` —— pi-runtime 侧 `config.ts` 的 `onCall` 已接入，覆盖 Nest 边界错误分类

**验收判据**：
- 造一次可重试故障 ⇒ `GenerationRecord.metadata.retryCount >= 1` 且 `status` 为 `completed`（重试救回）而非 `failed`
- 上线后跑 SQL 即可统计重试救回率，无需任何监控设施：
  ```sql
  SELECT json_extract(metadata,'$.retryCount') AS retries, status, COUNT(*)
  FROM GenerationRecord WHERE type IN ('text','prompt')
    AND json_extract(metadata,'$.retryCount') IS NOT NULL
  GROUP BY retries, status;
  ```
  `retries > 0 AND status='completed'` 的行数 = 重试救回的生成数（对照 `retries > 0 AND status='failed'` = 重试耗尽）

**明确移出**：`apps/server` 接入 `prom-client` + `/metrics` 端点（报告 O9 全量）—— 属基础设施工作，需独立评估其运维成本，不在本规格。

### 3.2 G1 · `text-provider.ts` 重试

`packages/agent/src/tools/text-provider.ts:64` 把 `upstreamFetch` 包进 `withUpstreamRetry`（attempts=3，baseDelayMs=1500，与图片侧同参）。

**必须遵守 `!res.ok` 显式 throw 纪律**（`upstream-retry.ts:12-15` 明示：fetch 对 4xx/5xx 是正常返回，只包 fetch 重试永不触发）。文本现有代码 `:72` 已有 `if (!res.ok) throw`，包裹后该分支落在 retry 的 `fn` 内部即可生效。

**超时不等式（必须保持）**：`upstream-fetch.test.ts:93-94` 断言 `UPSTREAM_FETCH_TIMEOUT_MS * 3 + 4500 < 180_000`。文本重试后最坏 `45_000×3 + 4_500 = 139_500ms`：

- < `210_000`（`config.ts` 的 `/agent/internal/run-text-generation` override）
- < `300_000`（`deploy/nginx.conf:32` `proxy_read_timeout`，覆盖前端直连路径）

⇒ 无需新增超时 env。三条路径均安全。

### 3.3 G1' · `vision-text.ts` 换 `upstreamFetch` + 加超时（**最高性价比项**）

`packages/agent/src/refs/vision-text.ts:64` 的裸 `fetch(...)` 改为 `upstreamFetch(...)`。

**这是本规格最应优先的代码改动**：该调用是**文本侧唯一无超时保护**的上游请求。隧道楔死时（MEMORY 记录的事故形态：TCP 层看起来健康但数据永不返回），`await` 永不 settle ⇒ 生成永不返回、无 record、无退款，且**因无 generating 态而 reaper 也扫不到**（§3.4 的 G3 修复只能覆盖 `text-provider` 路径，此路径在 record-first 后才进入 reaper 视野）。

**改动**：
```ts
// 现状（:64）
const res = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', ... })

// 改后
const res = await withUpstreamRetry(async () => {
  const r = await upstreamFetch(`${baseUrl}/chat/completions`, {
    method: 'POST', headers: {...}, body: JSON.stringify({...}),
  })
  // ⛔ 纪律：!res.ok 必须显式 throw，否则重试永不触发
  if (!r.ok) throw new Error(`Vision API ${r.status}: ${await r.text()}`)
  return r
})
```

⛔ **注意**：`vision-text.ts:85` 现有的 `if (!res.ok) throw` 位于 fetch 之外，必须**移入** `withUpstreamRetry` 的回调内部，否则 `withUpstreamRetry` 只会重试网络异常，不会重试 4xx/5xx。

**超时取值**：不传 `timeoutMs`，用 `upstreamFetch` 默认 `UPSTREAM_FETCH_TIMEOUT_MS = 45_000`。vision 请求带图片 payload，通常比纯文本慢；若实测不足，后续可加 `LNKPI_VISION_TEXT_TIMEOUT_SEC`，**但必须重算 §3.2 的不等式**。

### 3.4 G2 · `PlaceholderTextProvider` 改抛错

`PlaceholderTextProvider.generate()` 由「返回硬编码草案」改为抛错，仿 `image-provider.ts` 的 `PlaceholderImageProvider`（`:30` 已 `throw new Error('image provider credentials missing: ...')`）。

**改判理由**（原判「死代码」不完整）：`studio.service.ts:2742` 的 **BYOK→平台回退**路径调用 `createTextProvider(undefined).generate(...)`，其可用性**完全依赖** `OPENAI_API_KEY`。若该 env 缺失，该路径会静默返回占位草案并写 `status='completed'` + `providerFallback: true` ⇒ 用户看到"生成成功"但内容是硬编码模板。**生产已有 7 笔此类记录（2026-07-14）**。

`createTextProvider()` 在无 apiKey 且无 env 时直接抛错，由 studio 层既有 catch 接住 → 落 `failed` / `fallback_pending` + 退款，与图片侧行为一致。

### 3.5 G2' · `vision-text.ts` 的 `buildPlaceholder` 改抛错

`vision-text.ts:57-59`：

```ts
// 现状
if (!key) {
  return { text: buildPlaceholder(userText, urls.length) }   // 静默返回模板
}

// 改后
if (!key) {
  throw new Error('vision text credentials missing: set OPENAI_API_KEY or provide a BYOK key')
}
```

同时**删除 `buildPlaceholder` 函数**（`:19-42`）——保留它等于给后人留一个可被误用的假成功工具。

⚠️ `buildPlaceholder` 的文案（`【电商视觉方案草案】...（配置 OPENAI_API_KEY 后可获得真实视觉模型输出）`）与 `PlaceholderTextProvider` 的是**两套独立模板**，不能只改一处。

**同步检查**：`merge-refs.ts` 也 import 了 `text-provider`，需确认无第三条占位路径。

### 3.6 G3 · 文本 record-first

`apps/server/src/studio/studio.service.ts` 的 `generateText`（`:698-836`）改为：

```
create record(status='generating', metadata 含 chargedPoints)
  → try { consume(generationId: record.id) }
      catch → delete 占位（不留 generating 孤儿）→ 重新抛出
  → generateTextForRefs()（同步）
  → update record(status='completed'|'failed'|'fallback_pending')
```

**与图片侧一致性**：完全对齐 `studio.service.ts:1132-1177`（`generateImage` 主路径）的既有实现，含 `applyChargeMeta` / `withCanvasScope` 用法。

**退款侧同步改**：三处退款（`cancelled_refund` / `failed_refund` / `byok_refund`）的 `generationId: null` 全部改为 `record.id`。

**保持同步执行，不做 detached**：文本秒级完成；图片需要 detached 是因为分钟级耗时。引入 detached 会带来 fast-path / grace-window 竞态（`studio.service.ts:1190-1204` 的复杂度），对文本是纯负债。

**NOT_RETRYABLE 边界不变**：`isCancelledException(err)` 分支仍先行 `throw err`，不退款（取消已在 generate 前检查过）。

**依赖顺序**：G3 未完成时不得实施 G4。

### 3.7 G4 · reaper 扩 text

`apps/server/src/studio/generation-reaper.service.ts`：

1. `REAP_TYPES` 增加 `'text'`
2. `REAP_REASON_BY_TYPE.text = '文本生成'`
3. 新增 `LNKPI_TEXT_REAP_MINUTES`（默认 **10**），与图片共用 `LNKPI_GENERATION_REAP_MINUTES`（30）时的取值逻辑分离

**为何需要独立阈值**：文本秒级、图片分钟级。共用 30min 会让文本孤儿多存活 20 分钟才被回收。

**退款分类**：`studioPointCategory('text')` 已返回 `'text'`（`point-categories.ts:15`），与扣费侧 `consumeMeta('text', ...)` 同源 ⇒ **无需新增映射**。

**exactly-once**：沿用现有 `updateMany({ where: { id, status: 'generating' } })` 守卫 + 退款同事务。

**顺带修正注释**：`REAP_TYPES` 现有注释称纳入 `image_edit`/`image_upscale` 是「覆盖同类孤儿」，但实测这两个类型当前零 `generating` 态（completed 9 / failed 68）⇒ 实为历史遗留清理。注释需更正，避免后人误以为 reaper 在保护活跃路径。

### 3.8 G5 · 世界状态注入（精简）

**断点**：链路 A 把画布摘要 / 选中指代 / 记忆注入 system prompt，模型据此决策调用 `run_text_generation`；但执行时 `studio.generateText` 只拿节点自身 `prompt + refs`。

**设计**（透传链路已存在，无需新建通道）：

```
turnContext（runtime 侧已持有 tc）
  → client.post('/agent/internal/run-text-generation', { sessionId, userId, nodeId, nodeContext })
  → RunTextGenerationDto（**新建专用 DTO**，新增可选 nodeContext；不复用 RunImageGenerationDto）
  → agent-canvas-tools.service.runTextGeneration（校验后透传）
  → studio.generateText(..., nodeContext)
  → generateTextForRefs：system message 追加「创作上下文」段
```

**注入内容**：`selectionDigest`（用户当前选中）+ `canvasSummary` 精简版。**不注入** vision / sidebar / memory 全文 —— 那是模型决策阶段已用的内容，生成阶段只需要「当前在写哪个节点、周围有什么」。

**⛔ 强制验收项 —— DTO whitelist 静默剥字段**：
`apps/server/src/main.ts:30` 是 `new ValidationPipe({ transform: true, whitelist: true })`，且现有 `RunImageGenerationDto` 字段**全无** `@IsOptional()`。新增 `nodeContext` 字段**必须**标注 `@IsOptional()`，否则被 `whitelist` 静默剥离 —— 功能看似上线实则失效，且无任何报错。

**跨窗约束**：本项跨 web/runtime 语义改动，按 `AGENTS.md` 须**同窗上线**，与 G1-G4 分开 PR（回滚粒度独立）。

---

## 4. 组件与影响面

| 文件 | 改动 | 对应 |
|---|---|---|
| `packages/agent/src/refs/vision-text.ts` | **裸 `fetch` → `upstreamFetch` + `withUpstreamRetry`；`buildPlaceholder` 改抛错并删除** | **G1' G2'** |
| `packages/agent/src/tools/text-provider.ts` | retry 包裹 + 占位抛错 | G1 G2 |
| `packages/agent/src/tools/text-provider.test.ts` | 补 retry/占位用例 | G1 G2 |
| `apps/server/src/studio/studio.service.ts` | `generateText` 重排 + 三处退款 generationId | G3 |
| `apps/server/src/studio/generation-reaper.service.ts` | `REAP_TYPES` + 阈值 + 注释 | G4 |
| `services/pi-runtime/src/tools/generation.ts` | tool body 加 `nodeContext` | G5 |
| `services/pi-runtime/src/tools/config.ts` | 无改（210s 已够） | — |
| `apps/server/src/agent/agent-canvas-tools.controller.ts` | **新建 `RunTextGenerationDto`**（含可选 `nodeContext`） | G5 |
| `apps/server/src/agent/agent-canvas-tools.service.ts` | 透传 nodeContext | G5 |
| `packages/agent/src/refs/text-generation.ts` | 三分支路由 + `retryCount` 传递 + 上下文注入 | G0 G5 |
| ~~`services/pi-runtime/src/metrics.ts`~~ | ~~retry/duration 指标~~ **不改** —— 该 `Metrics` 在 pi-runtime 进程，而重试发生在 apps/server 进程，跨进程不可达 | — |

**不需要改**：
- `packages/agent/src/tools/upstream-fetch.ts` —— 45s 默认值不变，不等式仍成立
- `packages/agent/src/tools/upstream-retry.ts` —— 直接复用
- `apps/server/src/points/point-categories.ts` —— `text` 分类已存在于 `:15`

---

## 5. 测试与验收

### 5.1 单元测试

| 项 | 判据 |
|---|---|
| G1 重试 | 模拟首个 429、第二次 200 ⇒ 断言返回成功且重试计数为 1 |
| G1 不重试 | 模拟 `model_not_found` ⇒ 断言**只调 1 次**（`NON_RETRYABLE` 优先） |
| G1 不等式 | `45_000×3 + 4_500 < 210_000`（runtime override）与 `< 300_000`（nginx）各一条断言 |
| G2 占位 | 无 apiKey 无 env ⇒ 断言 **rejects**（不是 resolve 假文案） |
| **G1' 超时** | 模拟挂起的 vision 上游 ⇒ 断言在 45s 内 reject `UpstreamTimeoutError`（**不是永久 pending**） |
| **G1' 重试** | 首个 503、第二次 200 ⇒ 断言成功且调用 2 次；`model_not_found` ⇒ 断言只调 1 次 |
| **G2' 占位** | 无 apiKey 无 env 调 `generateTextWithImages` ⇒ 断言 **rejects**，且错误文案不含「草案」 |
| **G2' 无残留** | 静态检查：`git grep buildPlaceholder` 零命中（函数已删） |
| G3 record-first | 扣费失败 ⇒ 断言占位 record 被删、`generationId` 非 null |
| G4 reaper | 造一条 `status='generating'` 且超阈值的 text record ⇒ 断言 `updateMany` count=1 + 退款 1 笔；再跑一次 ⇒ 断言 count=0（exactly-once） |
| G5 DTO | `nodeContext` 字段经 ValidationPipe 后仍存在（防 whitelist 剥离） |

### 5.2 变异验证（必做，交付前）

**「测试全绿」不等于测试能证伪。** 每条新测试须经变异反向验证：

1. 把 `withUpstreamRetry` 的 attempts 改回 1 → G1 **和 G1'** 测试**必须红**
2. 把 `text-provider` 占位改回返回文案 → G2 测试**必须红**
3. 把 `vision-text.ts` 的 `upstreamFetch` 改回裸 `fetch` → **G1' 超时测试必须红**（这是最关键的一条：它是「永久挂起 vs 有界失败」的唯一判别）
4. 把 `vision-text.ts` 的 `!res.ok` throw 移出 retry 回调 → **G1' 重试测试必须红**（验证 4xx/5xx 真能触发重试）
5. 把 `buildPlaceholder` 恢复 → G2' 测试**必须红**
6. 把 record-first 改回先扣费 → G3 测试**必须红**
7. 把 `REAP_TYPES` 去掉 `'text'` → G4 测试**必须红**
8. 删掉 `@IsOptional()` → G5 DTO 测试**必须红**

任一条变异后测试仍绿 ⇒ 该测试无效，必须重写。

### 5.3 生产验证

上线后按序观察（文本流量低，勿在高峰采样）：

1. `tool_error_kinds_total{tool="run_text_generation"}` — G1 前基线 vs 后
2. `text_upstream_retry_total{outcome="retry"}` — 应 > 0（否则说明无抖动可救，或重试未生效）
3. `GenerationRecord` 中 `type='text'` 的 `status` 分布 — 应出现 `failed` 占比下降
4. `PointTransaction` 中 `category='text'` 的 `generationId IS NULL` 占比 — 应**归零**（G3 的直接判据）
5. reaper 日志中 `[startup]` / `[periodic]` 的文本回收条数

---

## 6. 部署约束

| 约束 | 说明 |
|---|---|
| 分支纪律 | 新开分支 → 开发 → 提交 → PR → 盯 CI → squash 合并 → 盯部署 → 生产验证（`docs/agent/delivery.md`） |
| 流水线 | `packages/agent` + `apps/server` 改动走 `deploy.yml`（push master + paths 白名单）；`services/pi-runtime` 改动走 `runtime-deploy.yml`（**纯 workflow_dispatch，须手派**） |
| G5 同窗 | 跨 web/runtime 语义改动必须同窗；让"不认识对方"的一侧后发 |
| 上线时机 | 文本流量 8 月 236 次 / 10 月 6 次，波动大 ⇒ 避开高峰，低峰上线 |
| G1 不触及上游 | 文本走 agnes 且在 `NO_PROXY` 内 ⇒ **不受**代理隧道事故影响，无需额外预案 |

---

## 7. 明确移出本窗口

| 项 | 理由 |
|---|---|
| 图片侧 3 条未修 consume 路径（`studio.service.ts:1311` / `:1492` / `material.service.ts:413`） | **影响面大于文本侧任何一项**（image consume 1229 笔中 1223 笔 `generationId` 为 NULL，2026-10 仍 295 笔）。但属图片链路，独立窗口处理。⚠️ 记录在此以免遗漏 |
| `image_edit` 在 `REAP_TYPES` 中的无效覆盖 | 实测该类型零 `generating` 态；本规格仅更正注释，是否移除待图片侧窗口决定 |
| O7 生成调用幂等键 | 无生产证据。仅靠 gate V-γ 重试预算 + SSOT status 兜底 |
| O8 conversation 入口限流 | 无生产证据。有 busy 409 串行守卫 |
| O10 规则段内存缓存 | 无生产证据。性能损耗未观测到 |
| `gemini-3.1-flash` 渠道摘除 | 属配置决策（`OPENAI_CHAT_MODEL` 候选），非代码缺陷修复 |
| video / audio 链路同类缺口 | 超出文本链路边界 |

---

## 8. 风险

| 风险 | 缓解 |
|---|---|
| **G1' vision 路径 45s 可能不足**（带图片 payload 通常更慢） | 先按默认 45s 实施并观察；实测不够再加 `LNKPI_VISION_TEXT_TIMEOUT_SEC`，但**必须重算 §3.2 不等式**（`upstream-fetch.test.ts:93-94` 会拦） |
| **G1' 改 `!res.ok` 位置时漏移** ⇒ 4xx/5xx 不重试 | 变异验证第 4 条专门覆盖此场景 |
| G3 重排扣费顺序，若 `create` 与 `consume` 间抛错会产生 generating 孤儿 | `consume` 的 catch 内 `delete` 占位（照抄 `studio.service.ts:1172-1177` 既有实现） |
| G4 误回收正在生成的 text（阈值过短） | 10min ≫ 文本实际耗时（秒级）；且 `updateMany` 有 `status='generating'` 守卫，completeImage 式竞态不会误退 |
| G5 DTO whitelist 剥离 | §3.8 强制验收项 + §5.1 专项测试 + 变异验证第 8 条 |
| G1/G1' 重试放大上游压力（429 本因渠道容量不足） | attempts=3、退避 1500/3000ms，最坏 139.5s；这是吸收抖动而非加压。若上线后 429 **上升**，说明根因是渠道容量，须走配置路径而非继续加重试 |
| 低流量导致效果难验证 | G0 指标先行；必要时用容器内行为探针（同 `.workbuddy/probe-image-ledger-consume.mjs` 模式）做无流量取证 |
| **G0 指标可能无处可埋**（`apps/server` 与 `packages/agent` 均无 metrics 设施，只有 pi-runtime 有） | 实施 G0 前先确认埋点出口；若 apps/server 无 `/metrics` 端点，G0 降级为「用 `GenerationRecord.metadata` 落 retry 计数」而非 Prometheus 指标 |
