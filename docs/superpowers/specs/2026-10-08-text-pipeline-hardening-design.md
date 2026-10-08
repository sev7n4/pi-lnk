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
| G1 | 文本上游调用零重试，429/503/fetch failed 直接判失败退款 | 韧性 |
| G2 | `PlaceholderTextProvider` 静默返回硬编码草案并标 `completed` | 正确性 |
| G3 | 扣费先于 record 创建，崩溃时已扣费 / 零 record / 零退款 | 账本 |
| G4 | reaper 不覆盖 text ⇒ G3 的泄漏无兜底 | 兜底 |
| G5 | `run_text_generation` 丢弃 turnContext，「决策有上下文、执行无上下文」 | 质量 |

前置项 G0：文本链无有效指标，导致上述修复**无法验证效果**。

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
| ② 占位 = P0 假成功 | 生产 `OPENAI_API_KEY` 已配置 ⇒ 占位为死代码 | 保留 G2 但改判理由，见 §3.2 |
| ③ 文本无 generating 态 | 现象成立；但真正缺口在图片侧 | 移出本窗口（§7） |
| ④ 文本与图片缺陷等价 | **不等价**：`NO_PROXY` 含 `.agnes-ai.cn` ⇒ 文本绕过代理隧道，图片经隧道出海 | 前提性错误，已修正 |

**仍然做 G1 的量化依据**：文本 44 条失败中 28 条是 `cancelled`（用户主动取消，非故障），真实故障 15 条中 **12 条（80%）属可重试错误**（429×8、`fetch failed`×3、503×1），仅 3 条 `model_not_found` 属 `NON_RETRYABLE`。

**429 归因**：文案为 `LLM 请求失败: 429 Too Many Requests`，同批伴随 `No available channel for model gemini-3.1-flash` ⇒ 根因是 **agnes 侧该模型渠道容量不足**，非本仓缺陷。重试吸收瞬时抖动，不修复渠道缺失。若该模型长期无渠道，属配置决策（`OPENAI_CHAT_MODEL` 候选摘除），不在本规格范围。

### 2.1 实施顺序

```
G0 指标 ──► G1 重试 ──► G2 占位
                  （三者独立，可并行评审）
G3 record-first ──► G4 reaper 扩 text     ← 严格串行
G5 世界状态注入                            ← 独立 PR，跨 web/runtime 同窗
```

**G0 必须最先**：3 条故障归因困难（`errorCode='unknown'`），无指标则无法证明 G1 是否真的救回了 429。

**G4 严格依赖 G3**：无 `generating` 中间态时，reaper 纳入 `text` 是空转。

---

## 3. 设计

### 3.1 G0 · 文本链指标

**复用现有 Metrics 通道**，不新建体系。`services/pi-runtime/src/metrics.ts` 已有 `observeToolErrorKind` / `observeToolResult`。

已存在、无需新增即可验证 G1：
```
tool_error_kinds_total{tool="run_text_generation", errorKind="timeout"|"network"|"upstream_5xx"|"envelope"}
```
`config.ts` 的 `onCall` 已把 `errorKind` 接入该指标。

新增（`packages/agent/src/tools/text-provider.ts` 侧）：
```
text_upstream_retry_total{outcome="retry"|"exhausted"}   # outcome 由 withUpstreamRetry 的 onRetry 钩子累加
text_gen_duration_seconds{outcome="success"|"failure"}    # histogram
```

**验收判据**：故意注入一次 429，能同时观察到 `tool_error_kinds_total{errorKind="upstream_5xx"}`（或 upstream_4xx）与 `text_upstream_retry_total{outcome="retry"}` 各 +1。

> ⛔ 不用「跑过了」当证据：见 §5 变异验证。

### 3.2 G1 · 文本重试

`packages/agent/src/tools/text-provider.ts:64` 把 `upstreamFetch` 包进 `withUpstreamRetry`（attempts=3，baseDelayMs=1500，与图片侧同参）。

**必须遵守 `!res.ok` 显式 throw 纪律**（`upstream-retry.ts:12-15` 明示：fetch 对 4xx/5xx 是正常返回，只包 fetch 重试永不触发）。文本现有代码 `:72` 已有 `if (!res.ok) throw`，包裹后该分支落在 retry 的 `fn` 内部即可生效。

**超时不等式（必须保持）**：`upstream-fetch.test.ts:93-94` 断言 `UPSTREAM_FETCH_TIMEOUT_MS * 3 + 4500 < 180_000`。文本重试后最坏 `45_000×3 + 4_500 = 139_500ms`：

- < `210_000`（`config.ts` 的 `/agent/internal/run-text-generation` override）
- < `300_000`（`deploy/nginx.conf:32` `proxy_read_timeout`，覆盖前端直连路径）

⇒ 无需新增超时 env。三条路径均安全。

### 3.3 G2 · 占位改抛错

`PlaceholderTextProvider.generate()` 由「返回硬编码草案」改为抛错，仿 `image-provider.ts` 的 `PlaceholderImageProvider`（`:30` 已 `throw new Error('image provider credentials missing: ...')`）。

**改判理由**（原判「死代码」不完整）：`studio.service.ts:2742` 的 **BYOK→平台回退**路径调用 `createTextProvider(undefined).generate(...)`，其可用性**完全依赖** `OPENAI_API_KEY`。若该 env 缺失，该路径会静默返回占位草案并写 `status='completed'` + `providerFallback: true` ⇒ 用户看到"生成成功"但内容是硬编码模板。这是定时炸弹，不是死代码。

`createTextProvider()` 在无 apiKey 且无 env 时直接抛错，由 studio 层既有 catch 接住 → 落 `failed` / `fallback_pending` + 退款，与图片侧行为一致。

### 3.4 G3 · 文本 record-first

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

### 3.5 G4 · reaper 扩 text

`apps/server/src/studio/generation-reaper.service.ts`：

1. `REAP_TYPES` 增加 `'text'`
2. `REAP_REASON_BY_TYPE.text = '文本生成'`
3. 新增 `LNKPI_TEXT_REAP_MINUTES`（默认 **10**），与图片共用 `LNKPI_GENERATION_REAP_MINUTES`（30）时的取值逻辑分离

**为何需要独立阈值**：文本秒级、图片分钟级。共用 30min 会让文本孤儿多存活 20 分钟才被回收。

**退款分类**：`studioPointCategory('text')` 已返回 `'text'`（`point-categories.ts:15`），与扣费侧 `consumeMeta('text', ...)` 同源 ⇒ **无需新增映射**。

**exactly-once**：沿用现有 `updateMany({ where: { id, status: 'generating' } })` 守卫 + 退款同事务。

**顺带修正注释**：`REAP_TYPES` 现有注释称纳入 `image_edit`/`image_upscale` 是「覆盖同类孤儿」，但实测这两个类型当前零 `generating` 态（completed 9 / failed 68）⇒ 实为历史遗留清理。注释需更正，避免后人误以为 reaper 在保护活跃路径。

### 3.6 G5 · 世界状态注入（精简）

**断点**：链路 A 把画布摘要 / 选中指代 / 记忆注入 system prompt，模型据此决策调用 `run_text_generation`；但执行时 `studio.generateText` 只拿节点自身 `prompt + refs`。

**设计**（透传链路已存在，无需新建通道）：

```
turnContext（runtime 侧已持有 tc）
  → client.post('/agent/internal/run-text-generation', { sessionId, userId, nodeId, context })
  → RunTextGenerationDto（新增可选 context）
  → agent-canvas-tools.service.runTextGeneration（校验后透传）
  → studio.generateText(..., nodeContext)
  → generateTextForRefs：system message 追加「创作上下文」段
```

**注入内容**：`selectionDigest`（用户当前选中）+ `canvasSummary` 精简版。**不注入** vision / sidebar / memory 全文 —— 那是模型决策阶段已用的内容，生成阶段只需要「当前在写哪个节点、周围有什么」。

**⛔ 强制验收项 —— DTO whitelist 静默剥字段**：
`apps/server/src/main.ts:30` 是 `new ValidationPipe({ transform: true, whitelist: true })`，且现有 `RunImageGenerationDto` 字段**全无** `@IsOptional()`。新增 `context` 字段**必须**标注 `@IsOptional()`，否则被 `whitelist` 静默剥离 —— 功能看似上线实则失效，且无任何报错。

**跨窗约束**：本项跨 web/runtime 语义改动，按 `AGENTS.md` 须**同窗上线**，与 G1-G4 分开 PR（回滚粒度独立）。

---

## 4. 组件与影响面

| 文件 | 改动 | 对应 |
|---|---|---|
| `packages/agent/src/tools/text-provider.ts` | retry 包裹 + 占位抛错 | G1 G2 |
| `packages/agent/src/tools/text-provider.test.ts` | 补 retry/占位用例 | G1 G2 |
| `apps/server/src/studio/studio.service.ts` | `generateText` 重排 + 三处退款 generationId | G3 |
| `apps/server/src/studio/generation-reaper.service.ts` | `REAP_TYPES` + 阈值 + 注释 | G4 |
| `services/pi-runtime/src/tools/generation.ts` | tool body 加 `context` | G5 |
| `services/pi-runtime/src/tools/config.ts` | 无改（210s 已够） | — |
| `apps/server/src/agent/agent-canvas-tools.controller.ts` | DTO 加可选 `context` | G5 |
| `apps/server/src/agent/agent-canvas-tools.service.ts` | 透传 nodeContext | G5 |
| `packages/agent/src/refs/text-generation.ts` | system message 追加上下文 | G5 |
| `services/pi-runtime/src/metrics.ts` | retry/duration 指标 | G0 |

**不需要改**：`upstream-fetch.ts`（45s 默认值不变，不等式仍成立）、`upstream-retry.ts`（直接复用）、`point-categories.ts`（`text` 分类已存在于 `:15`）。

| `apps/server/src/points/point-categories.ts` | 无需改（`text` 分类已存在于 `:15`） | — |
| `packages/agent/src/tools/upstream-fetch.ts` | 无需改（45s 默认值不变，不等式仍成立） | — |
| `packages/agent/src/tools/upstream-retry.ts` | 无需改（直接复用） | — |

---

## 5. 测试与验收

### 5.1 单元测试

| 项 | 判据 |
|---|---|
| G1 重试 | 模拟首个 429、第二次 200 ⇒ 断言返回成功且重试计数为 1 |
| G1 不重试 | 模拟 `model_not_found` ⇒ 断言**只调 1 次**（`NON_RETRYABLE` 优先） |
| G1 不等式 | `45_000×3 + 4_500 < 210_000`（runtime override）与 `< 300_000`（nginx）各一条断言 |
| G2 占位 | 无 apiKey 无 env ⇒ 断言 **rejects**（不是 resolve 假文案） |
| G3 record-first | 扣费失败 ⇒ 断言占位 record 被删、`generationId` 非 null |
| G4 reaper | 造一条 `status='generating'` 且超阈值的 text record ⇒ 断言 `updateMany` count=1 + 退款 1 笔；再跑一次 ⇒ 断言 count=0（exactly-once） |
| G5 DTO | `context` 字段经 ValidationPipe 后仍存在（防 whitelist 剥离） |

### 5.2 变异验证（必做，交付前）

**「测试全绿」不等于测试能证伪。** 每条新测试须经变异反向验证：

1. 把 `withUpstreamRetry` 的 attempts 改回 1 → G1 测试**必须红**
2. 把占位改回返回文案 → G2 测试**必须红**
3. 把 record-first 改回先扣费 → G3 测试**必须红**
4. 把 `REAP_TYPES` 去掉 `'text'` → G4 测试**必须红**
5. 删掉 `@IsOptional()` → G5 DTO 测试**必须红**

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
| G3 重排扣费顺序，若 `create` 与 `consume` 间抛错会产生 generating 孤儿 | `consume` 的 catch 内 `delete` 占位（照抄 `studio.service.ts:1172-1177` 既有实现） |
| G4 误回收正在生成的 text（阈值过短） | 10min ≫ 文本实际耗时（秒级）；且 `updateMany` 有 `status='generating'` 守卫，completeImage 式竞态不会误退 |
| G5 DTO whitelist 剥离 | §3.6 强制验收项 + §5.1 专项测试 + 变异验证第 5 条 |
| G1 重试放大上游压力（429 本因渠道容量不足） | attempts=3、退避 1500/3000ms，最坏 139.5s；这是吸收抖动而非加压。若上线后 429 **上升**，说明根因是渠道容量，须走配置路径而非继续加重试 |
| 低流量导致效果难验证 | G0 指标先行；必要时用容器内行为探针（同 `.workbuddy/probe-image-ledger-consume.mjs` 模式）做无流量取证 |
