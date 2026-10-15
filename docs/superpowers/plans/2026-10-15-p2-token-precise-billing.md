# P2 · token 精确计费（agent 对话回合）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agent 对话回合从「纯展示预估」（Q2）升级为 token 精确计费——回合发起按典型回合 ×1.2 预扣冻结，回合结束按实际 usage（input/cacheRead/output 分项）经价目表反比率结算，差额解冻；前端回合明细落 settled 态、文本徽标改「⚡1积分起」。

**Architecture:** 三层——① 定价数据基础（CostRate 14 行 + 价目表反比率行 `text:<model>:in|:cache|:out`，毛利烘在比率里、改价走既有发布流）；② 结算原语（PointHold 表 + freeze/settleFromhold/release 三原语，全部 $transaction 原子，复用 reaper exactly-once 范式）；③ 接入（pi-events TurnUsage 扩列保留 cache tokens → agent.service 回合发起预扣/finalizeTurn 结算 → `turn_settled` executionEvent → 前端 settled 展示）。全程挂 `TEXT_TOKEN_BILLING` flag，off 时零预扣零结算（维持 Q2 展示现状），上线默认 off。

**Tech Stack:** NestJS + Prisma/SQLite（增量迁移）、vitest（mock 桩 + sqlite 集成）、Vue3 + Element Plus。

**Spec:** `docs/superpowers/specs/2026-10-13-pricing-baseline-config-design.md` §6.5（换算与呈现定稿）、§6.7（前端呈现）、§2.4（文本成本表）；前置侦察事实清单见 `.superpowers/sdd/2026-10-14-p1a-pricing-publishing-gray-release/progress.md` 末节。

## Global Constraints

- **等价纪律（生命线）**：v1 全部行（含 `text` 单行 5 分）逐字不变，金标准 `pricing.equivalence.integration.test.ts` **4/4 必绿**；`text` 单行保留（studio 直生不动，见 Out of Scope）；新反比率行只进新版本（v1 不重播）。
- **quote 永不 throw**：任何缺失（CostRate/价目行/模型未知）→ degraded 走 USD 成本兜底 `estimateCreditsFromUsdCost`（pricing.core.ts:160-166 已有），绝不抛错打断对话。
- **键不出现纪律**：meta 条件展开 `...(x ? {k: v} : {})`，禁止 `?? null`。
- **flag 门禁**：所有预扣/结算代码包在 `TEXT_TOKEN_BILLING === 'on'` 内；off 时行为与 Q2 完全一致（回归判据）。
- **原子性**：freeze/settle/release 单事务 + `updateMany` 条件守卫（与既有 consume 的 `points: {gte: cost}` 守卫同构）；与 reaper `refundInTx` exactly-once 共存——hold 未 settle 前 reaper 不碰该用户余额行。
- **本机测试纪律**：禁全量（web 全量 52 分钟前科）；跑定向 + 金标准；vitest exit 1 是已知 birpc 伪影，判据=用例全绿；集成 hook 超时 180_000。
- **设计体系**：改 .vue 只用 L2/L3 令牌类，禁裸 hex / rgba( 文字色 / text-white / bg-[#。
- **minCredits=1**：单回合结算不足 1 分按 1 分（spec §6.5 ③）。

## Review Focus

1. **hold 泄漏**（最危险）：回合发起预扣后进程崩溃/回调丢失 → 冻结额永不释放 → 用户余额永久变少。期望：超时未结算的 hold 可被自动 release。→ Task 3 加 `releaseExpiredHolds(olderThanMs)` + Task 6 在 finalizeTurn 与 streamConversation error 路径双保险 release/settle，测试 pin「error 路径也解冻」。
2. **cache tokens 折叠丢失**：现状 pi-events.ts:629 把 cacheRead/cacheWrite 折进 inputTokens，双比率展示会拿到假数据。期望：TurnUsage 三列分开且**旧 executionEvents（无 cache 字段）重放不炸**。→ Task 5 测试 pin 新旧两种事件形态。
3. **模型缺行**：step-2-16k 无 cache 反比率行 / 未知模型 → 结算 NaN 或 throw。期望：缺 cache 行时 cache tokens 并入 in 项计费；模型完全未知 → USD 兜底。→ Task 4 测试 pin 两种缺行形态。
4. **并发/无交互 run**：automation run（无用户交互）与多画布并发对话的预扣归属。期望：run=结算单（拍板规则，见 §归属规则）；automation 预扣失败降级为不预扣照常执行 + warn（不阻塞自动化）。→ Task 6 测试 pin。
5. **并发 freeze 原子性**：同用户多 run 同时预扣 → 可用余额 = points − pointsFrozen 的条件守卫防超扣。→ Task 3 测试 pin「两笔并发 freeze 总额不超可用」。

## 已拍板（2026-10-15 用户确认，已回写 spec §6.5 实施拍板注）

- **Q1 反比率烘当前生效阶段**（上线时拉新期 1.1× 现算）：spec §6.5 表数字为成长期 2.5× 参照口径；阶段切换时经发布流重发布新比率。
- **Q2 run=结算单**：steer 并入当前 run；drain/followUp/automation 派生 run 各自预扣结算；automation 预扣失败降级照常执行 + warn。
- **执行方式**：subagent-driven（每 task 独立实现+评审，最后整分支终审）。

## Out of Scope（后续计划）

studio 文本直生/提示词模式迁移 token 口径（继续 5 分/次，`text` 行保留）；阶段切换机制（launch→growth）；CostWatch 周更；渠道对账校准。

---

### Task 1: CostRate 文本成本行补录（14 行）

**Files:**
- Modify: `apps/server/src/pricing/seed-pricing.ts`（SEED_COST_RATES，现 20 行 → 34 行）
- Test: `apps/server/src/pricing/pricing.seed.integration.test.ts`

**Interfaces:**
- Produces: CostRate 行 `(channel:'platform', modelKey, spec, unit:'per_1m_tokens', costYuan)`——spec 键：`per_1m_tokens_in` / `per_1m_tokens_out` / `per_1m_tokens_cache`（Task 4 的反比率换算与 degraded 消费）；模型键：`step-3.5-flash` / `step-3.7-flash` / `step-2-16k` / `step-5-preview` / `minimax-m2.7`（小写连字符，与既有 `step-3.5-flash` 一致）。

- [ ] **Step 1: 写失败测试**（断言新增行的存在与值——加断言不删断言）

```ts
// pricing.seed.integration.test.ts 追加用例（照文件内既有用例风格）
it('文本 5 模型成本行：in/out 全量 + cache 4 行（step-2-16k 上游未公布）', async () => {
  const rows = await prisma.costRate.findMany({
    where: { channel: 'platform', modelKey: { in: ['step-3.5-flash', 'step-3.7-flash', 'step-2-16k', 'step-5-preview', 'minimax-m2.7'] } },
  });
  const by = new Map(rows.map(r => [`${r.modelKey}:${r.spec}`, r.costYuan]));
  // in/out（spec §2.4 挂牌价）
  expect(by.get('step-3.5-flash:per_1m_tokens_in')).toBe(0.7);
  expect(by.get('step-3.5-flash:per_1m_tokens_out')).toBe(2.1);
  expect(by.get('step-3.7-flash:per_1m_tokens_in')).toBe(1.35);
  expect(by.get('step-3.7-flash:per_1m_tokens_out')).toBe(8.1);
  expect(by.get('step-2-16k:per_1m_tokens_in')).toBe(6);
  expect(by.get('step-2-16k:per_1m_tokens_out')).toBe(18);
  expect(by.get('step-5-preview:per_1m_tokens_in')).toBe(7);
  expect(by.get('step-5-preview:per_1m_tokens_out')).toBe(20);
  expect(by.get('minimax-m2.7:per_1m_tokens_in')).toBe(2.15);
  expect(by.get('minimax-m2.7:per_1m_tokens_out')).toBe(8.58);
  // cache（§2.4 挂牌 / M2.7 系推算：in成本 × 1.9K/9.3K ≈ 0.44）
  expect(by.get('step-3.5-flash:per_1m_tokens_cache')).toBe(0.14);
  expect(by.get('step-3.7-flash:per_1m_tokens_cache')).toBe(0.27);
  expect(by.get('step-5-preview:per_1m_tokens_cache')).toBe(0.7);
  expect(by.get('minimax-m2.7:per_1m_tokens_cache')).toBe(0.44);
  expect(by.has('step-2-16k:per_1m_tokens_cache')).toBe(false); // 上游未公布
});
```

- [ ] **Step 2: 跑测试确认失败** — `cd apps/server && ./node_modules/vitest/vitest.mjs run src/pricing/pricing.seed.integration.test.ts` → 新用例 FAIL（行缺失）
- [ ] **Step 3: SEED_COST_RATES 增 14 行**（照既有行形态，note 注明 `spec §2.4 挂牌价` / M2.7 cache 注明 `推算：in×1.9/9.3，P2 渠道对账校准`）
- [ ] **Step 4: 跑测试通过**（同 Step 2 命令 → 全绿；注意既有行数下界断言同步 `>= 34`）
- [ ] **Step 5: Commit** — `git add apps/server/src/pricing/seed-pricing.ts apps/server/src/pricing/pricing.seed.integration.test.ts && git commit -m "feat(pricing): 文本 5 模型 CostRate 成本行补录（P2 token 计费 T1）"`

### Task 2: schema 增量（PointHold 表 + User.pointsFrozen）+ 迁移

**Files:**
- Modify: `apps/server/prisma/schema.prisma`（User 表 + 新 model）
- Create: `apps/server/prisma/migrations/<ts>_p2_token_billing/migration.sql`
- Test: 复用 Task 3 的测试文件（迁移在临时库 hook 里自动跑）

**Interfaces:**
- Produces: `User.pointsFrozen Int @default(0)`；`PointHold { id String @id @default(cuid()), userId String, user User @relation(...), amount Int, status String @default("held") /* held|settled|released */, settledCredits Int?, reason String?, createdAt DateTime @default(now()), settledAt DateTime? }` + `@@index([userId, status])` + `@@index([status, createdAt])`（Task 3 过期扫描用）。

- [ ] **Step 1: schema 编辑**（User 表加 `pointsFrozen Int @default(0)`；新 model PointHold 如上；User 加 `holds PointHold[]`）
- [ ] **Step 2: 生成迁移** — `cd apps/server && ../../node_modules/.bin/prisma migrate dev --name p2_token_billing --create-only`（连**临时库**，hook 超时 180_000；照 P1-a T1 的临时库验证姿势），手检 SQL：`ALTER TABLE "User" ADD COLUMN "pointsFrozen" INTEGER NOT NULL DEFAULT 0` + `CREATE TABLE "PointHold" (...)`
- [ ] **Step 3: 迁移幂等性自查** — SQL 里无数据回填、纯增量（旧代码读库不受影响）
- [ ] **Step 4: Commit** — `git add apps/server/prisma && git commit -m "feat(pricing): PointHold 表 + User.pointsFrozen（P2 token 计费 T2）"`

### Task 3: points.service 冻结三原语

**Files:**
- Modify: `apps/server/src/points/points.service.ts`（现有 consume/refund 不动，追加三方法）
- Modify: `apps/server/src/points/point-tx.types.ts`（PointTxMeta `holdId?: string`）
- Test: `apps/server/src/points/points.service.test.ts`（追加用例）

**Interfaces:**
- Produces（Task 6 消费，签名精确）:
  - `freeze(userId: string, amount: number, reason: string): Promise<PointHold>` — 余额守卫 `updateMany({ where: { id: userId, points: { gte: <已有冻结 + amount> } } })`（实现上用读-改-写单事务 + `pointsFrozen: { increment: amount }`，守卫 `points - pointsFrozen >= amount`）；不足 → `BadRequestException('可用积分不足')`；流水 `kind='freeze', category='other', status='held', meta.holdId`
  - `settleFromHold(holdId: string, actualCredits: number, reason: string, meta?: PointTxMeta): Promise<{ settled: number; released: number }>` — 单事务：hold 必须 `held`（否则 409）；`pointsFrozen -= hold.amount`、`points -= actualCredits`；流水 `kind='consume'`（meta.holdId + 全部透传）；若 `actual < hold.amount` 差额自然留在余额（冻结只减 hold.amount）
  - `release(holdId: string, reason: string): Promise<void>` — held → released，`pointsFrozen -= amount`，流水 `kind='release'`
  - `releaseExpiredHolds(olderThanMs = 30 * 60_000): Promise<number>` — 扫 `status='held' AND createdAt < now-olderThanMs` 逐笔 release，返回笔数（Task 6 的兜底调用点）
- 幂等：settle/release 对已终结 hold 幂等返回（不再扣/放）。

- [ ] **Step 1: 写失败测试**（照 points.service.test.ts 既有桩模式）：freeze 正常 + 余额不足拒；settleFromHold 扣实际 + 冻结清零 + 流水 kind='consume' 带 holdId；实际 < hold 时余额正确（hold 100、settle 7 → 余额 = 原-7）；release 全退；**过期扫描**（两笔 hold，一笔超时 → release 1 笔）；**并发守卫**（可用 100，并发 freeze 80+80 → 恰一笔成功）
- [ ] **Step 2: 跑失败** — `./node_modules/vitest/vitest.mjs run src/points/points.service.test.ts` → FAIL
- [ ] **Step 3: 实现三原语**（照 consume 的 `$transaction` + `updateMany` 条件守卫模式写）
- [ ] **Step 4: 跑通过** → 全绿（含既有用例零改动）
- [ ] **Step 5: Commit** — `feat(pricing): 积分冻结三原语 freeze/settleFromHold/release（P2 T3）`

### Task 4: 文本 token 价目（反比率行 + quoteTextTokens）

**Files:**
- Modify: `apps/server/src/pricing/pricing.core.ts`（`buildTextTokenMatchKey` + `TEXT_TOKEN_MODELS` 常量）
- Modify: `apps/server/src/pricing/pricing.space.ts`（枚举空间扩 text token 行）
- Modify: `apps/server/src/pricing/pricing.service.ts`（新方法 `quoteTextTokens`）
- Test: `apps/server/src/pricing/pricing.service.test.ts` + `pricing.space.test.ts`

**Interfaces:**
- Consumes: Task 1 的 CostRate 行（反比率换算）
- Produces（Task 6 消费，签名精确）:
  - `buildTextTokenMatchKey(modelKey: string, spec: 'in' | 'cache' | 'out'): string` → `text:<modelKey>:in` 等（`text` 单行 matchKey 不动）
  - `TEXT_TOKEN_MODELS: readonly string[]` = `['step-3.5-flash','step-3.7-flash','step-2-16k','step-5-preview','minimax-m2.7']`
  - `quoteTextTokens(userId: string | undefined, modelKey: string, usage: { inputTokens: number; cacheReadTokens: number; outputTokens: number }): Promise<PricingQuote & { breakdown?: { in: number; cache: number; out: number } }>` — 反比率行：`credits = ceil(inputTokens/rIn) + ceil(cacheReadTokens/rCache) + ceil(outputTokens/rOut)`（cacheWrite 已被上游折入 input 口径则天然计入；step-2-16k 无 cache 行 → cache tokens 并入 in 项）；三行齐才走价目口径，缺任一行 / 未知模型 / quote throw → degraded：`estimateCreditsFromUsdCost(usage.cost 求和, marginBp, fx)`，breakdown 缺省（键不出现）；`min 1`；`ruleVersion` 取价目版本或 `'constants-fallback'`；grayReleaseId 语义不变（quote(q, userId) 两参）
- **反比率计算（Q1 拍板后落地）**：`r = floor(1e6 / (costYuan × marginBp / 100))（等价于 floor(1e6 × 100 / (costYuan × marginBp))；勿写成 costYuan × 100 × marginBp——会差 100×）`（marginBp 取当前生效阶段；拉新期 11000 → step-3.5-flash in = floor(1e6/77) = 12987）。反比率行 `credits` 存该整数，`basis='launch-reprice'`，costRateId 挂对应 CostRate 行。

- [ ] **Step 1: 写失败测试**（pricing.service.test.ts，mock prisma 桩照既有模式，比率行用 mock 固定值）：①三行齐（mock 行 rIn=1000 / rCache=5000 / rOut=500）→ `quoteTextTokens(undefined, 'step-3.5-flash', {inputTokens: 2001, cacheReadTokens: 10001, outputTokens: 999})` 断言 `credits === 8`（ceil(2001/1000)=3 + ceil(10001/5000)=3 + ceil(999/500)=2）且 breakdown `{in:3, cache:3, out:2}`；②cache 行缺 → cache tokens 并入 in 项（同 mock 但 rCache 缺失：ceil(2001+10001/1000)=13 + 2 = 15）；③模型未知 → USD 兜底且 quote 不 throw；④`min 1`（用量各 1 token → 1）；⑤`text` 单行 matchKey 不受影响（回归锚）；⑥space 枚举含 `text:step-3.5-flash:in` 等 15 行且 v1 等价断言不涉新行
- [ ] **Step 2: 跑失败** → FAIL
- [ ] **Step 3: 实现**（buildTextTokenMatchKey + space 枚举 + quoteTextTokens；quote 主路径不 throw，内部 try/catch 落兜底）
- [ ] **Step 4: 跑通过 + 金标准** — `./node_modules/vitest/vitest.mjs run src/pricing` → 全绿含 equivalence 4/4（⚠️ 枚举空间扩行后自检会因混入非 legacy basis 而跳过全网自检——断言「跳过 + degraded=false」的既有用例适配，**不是放松**）
- [ ] **Step 5: Commit** — `feat(pricing): 文本 token 反比率价目 + quoteTextTokens（P2 T4）`

### Task 5: TurnUsage 扩列（cache tokens 三列）

**Files:**
- Modify: `apps/server/src/agent/pi-runtime/pi-events.ts:613-636`（extractUsageDelta）与 `:649-701`（createUsageAccumulator/TurnUsage）
- Test: `apps/server/src/agent/pi-runtime/pi-events.test.ts:259-287`（既有行为锁适配 + 新增）

**Interfaces:**
- Produces（Task 6 消费）: `TurnUsage` 增加 `cacheReadTokens?: number; cacheWriteTokens?: number`；`inputTokens` 语义**收窄为纯 input**（不含 cache 折叠）——⚠️ 同步改所有消费方：`turnSummaryLine`（executionTraceReducer.ts:482-504）、前端 reducer `applyTurnUsage`（:450-462）、`agent.service.ts:1284-1305` 的 Q2 预估（cost 口径不变）、以及它们的测试断言（旧事件无 cache 字段 → 字段缺省 0，不炸）。
- vendor 原始 tokens 直取：`usage.input / usage.cacheRead / usage.cacheWrite / usage.output`（vendor types.ts:383-403），不再折叠。

- [ ] **Step 1: 写失败测试**（pi-events.test.ts）：①message_end 带 `usage: {input: 100, cacheRead: 200, cacheWrite: 50, output: 30, ...}` → 折叠 turn_usage 断言 `{inputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 50, outputTokens: 30}`；②旧形态事件（无 cache 字段）→ 字段缺省不炸；③cost 求和口径不变（回归锚）
- [ ] **Step 2: 跑失败** → FAIL
- [ ] **Step 3: 实现**（extractUsageDelta 四列直取；accumulator 逐项累加；agent.service Q2 预估的 cost 兜底口径不动）
- [ ] **Step 4: 跑通过** — `./node_modules/vitest/vitest.mjs run src/agent/pi-runtime/pi-events.test.ts` + 前端 `executionTraceReducer` 相关测试（cd apps/web && run src/components/agent/executionTraceReducer*.test.ts 或按文件名 Grep 定位）
- [ ] **Step 5: Commit** — `feat(agent): TurnUsage 保留 cache tokens 三列（P2 T5）`

### Task 6: 预扣 + 结算接入（agent 回合）

**Files:**
- Modify: `apps/server/src/agent/agent.service.ts`（streamConversation 入口 :1329 附近 + finalizeTurn :1556-1582）
- Test: `apps/server/src/agent/agent.service.test.ts`（照既有 mock 桩模式；沙箱 dock 测试 wall-clock 超时是已知，判据=用例绿）

**Interfaces:**
- Consumes: Task 3 三原语、Task 4 quoteTextTokens、Task 5 TurnUsage
- Produces: executionEvents 新事件 `turn_settled: { holdId, credits, breakdown?, ruleVersion, degraded? }`（落 AgentMessage.metadata，随既有重放通道到前端）；环境开关 `TEXT_TOKEN_BILLING`（`on` 才启用）
- **行为规格**：
  1. 回合发起（streamConversation 入口，flag on）：`hold = ceil(quoteTextTokens(userId, model, {inputTokens: 8000, cacheReadTokens: 0, outputTokens: 500}).credits × 1.2)`（典型回合口径 = spec §6.5 的 8K in + 0.5K out）；freeze 失败（余额不足）→ 回合拒绝（402 语义，与 studio「先扣后退」一致）；**automation 触发的 run 预扣失败 → 降级不预扣照常执行 + warn**（Review Focus 4）
  2. finalizeTurn：有 hold → `settleFromHold(holdId, credits)`，credits = `quoteTextTokens(userId, model, usage 实际值)`（usage 来自 Task 5 的 turn_usage 折叠值）；推 `turn_settled` executionEvent；**error 路径也走 release/settle**（Review Focus 1：error → release 全退 + turn_settled `{released: true}`）
  3. 归属 = run（Q2 拍板）：steer 并入当前 run 不新扣；drain/followUp/automation 派生 run 各自预扣结算
  4. flag off：零预扣零结算，Q2 展示预估照旧（回归判据）

- [ ] **Step 1: 写失败测试**（agent.service.test.ts）：①flag on + 余额足 → freeze 被调（预扣额 = ceil(典型×1.2)）+ finalizeTurn settle（credits 按实际 usage）+ turn_settled 事件；②余额不足 → 回合拒绝；③**error 路径 → release**；④flag off → freeze/settle 均不调（回归锚）；⑤automation run 预扣失败 → 照常执行
- [ ] **Step 2: 跑失败** → FAIL
- [ ] **Step 3: 实现**（streamConversation 入口 freeze；finalizeTurn settle + 事件；error 分支 release；try/catch 全包——**计费故障绝不打断对话**，降级 USD 兜底或 release + warn）
- [ ] **Step 4: 跑通过** — `./node_modules/vitest/vitest.mjs run src/agent` + 金标准（回归确认）
- [ ] **Step 5: Commit** — `feat(agent): 对话回合预扣结算 + turn_settled 事件（P2 T6，flag off 默认）`

### Task 7: 前端回合明细 settled 态

**Files:**
- Modify: `apps/web/src/components/agent/executionTraceReducer.ts:450-504`（applyTurnUsage 扩列 + turn_settled 处理 + turnSummaryLine settled 段）
- Modify: `apps/web/src/components/agent/turnStatusBar.ts`（mode 加 `'settled'`）
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（turn-status-line 渲染 settled 段，:3361 附近）
- Modify: `apps/web/src/stores/agent.ts:417-426`（turn_settled 事件消费 + auth store points 刷新触发）
- Test: 对应 .test.ts 文件（Grep 定位既有测试文件名）

**Interfaces:**
- Consumes: Task 6 的 `turn_settled` executionEvent（经既有 executionEvents 重放通道，零新接口）
- Produces: 回合结束状态行「已结算 -N 积分（输入 X.Xk · 缓存 X.Xk · 输出 X.Xk）」；degraded 回合显示「-N 积分（按成本估算）」；**预估 vs 实际差额**：reducer 已跟踪 estimatedCredits（applyTurnUsage :450-462），settled 段在 `|实际−预估| ≥ 2 积分` 时追加「（预估 M）」

- [ ] **Step 1: 写失败测试**（reducer 测试：turn_settled 事件 → 摘要行含「已结算」+ tokens 三段 + 幂等重放；旧 turn_usage 无 cache 字段不炸——Task 5 已锚，此处锚 settled 渲染）
- [ ] **Step 2: 跑失败** → FAIL
- [ ] **Step 3: 实现**（reducer + turnStatusBar settled mode + AgentSideRail 渲染 + stores/agent 消费事件后触发 `auth.refreshUser()` 或等价的余额刷新——读 auth store 现有刷新方法名照用）
- [ ] **Step 4: 跑通过** — `cd apps/web && ./node_modules/vitest/vitest.mjs run <上述 4 文件对应测试>`
- [ ] **Step 5: Commit** — `feat(web): 回合积分结算明细 settled 态（P2 T7）`

### Task 8: 文本徽标「⚡1积分起」+ 活动价目端点

**Files:**
- Modify: `apps/web/src/constants/credits.ts:15-17`（estimateTextCredits → 返回 1，注释「floor 1，token 计费 §6.7」；BASE_GENERATION_CREDITS.text 保留供他处引用则同步核对两处消费点）
- Modify: `apps/web/src/components/canvas/dock-studio/shared/DockCreditBadge.vue`（新增可选 props `variant?: 'fixed' | 'from'`——from 显示「⚡N积分起」+ hover 明细插槽/文案「按 token 计费 · 单次至少 1 积分 · 典型 1–2」）
- Modify: `apps/web/src/pages/studios/TextDockPanel.vue:60,228` 与 `PromptDockPanel.vue:262`（传 variant="from"）
- Modify: `apps/server/src/pricing/pricing.controller.ts`（新文件，若 pricing 域无 public controller 则创建）——`GET /api/pricing/active`：只读返回当前 active 版本的 text 相关比率行（模型 → {in, cache, out} 反比率 map，无敏感字段，无 guard 或公开只读）
- Test: DockCreditBadge 渲染测试 + pricing.controller 测试（若 controller 文件新建则照 pricing-publishing.controller 测试的 harness 模式，无 guard 断言公开 200）

- [ ] **Step 1: 写失败测试**（徽标 variant=from 断言文案「积分起」+ hover 明细；estimateTextCredits===1；GET /api/pricing/active 200 + text 比率 map 形状）
- [ ] **Step 2: 跑失败** → FAIL
- [ ] **Step 3: 实现**（⚠️ credits.ts 改动会牵动两处 DockPanel 的 computed/调用——逐一核对；design-token 合规）
- [ ] **Step 4: 跑通过** — web 定向 + server pricing 定向 + design-token.test.ts（87 用例，改样式必跑）
- [ ] **Step 5: Commit** — `feat(web)+feat(pricing): 文本徽标 1 积分起 + 活动价目端点（P2 T8）`

---

## 依赖顺序与上线形态

T1 → T4（反比率换算依赖 CostRate）；T2 → T3（schema）→ T6；T5 → T6（TurnUsage）；T6 → T7（事件）；T4 → T8（端点）。
**分支策略**：单分支 `feat/p2-token-billing` 按 Task 顺序提交，PR 一次走 CI（Build monorepo 全量为权威门）。
**上线形态**：全部合并部署后 `TEXT_TOKEN_BILLING` 默认 **off**（零行为变化）；生产验证 flag off 回归 → 灰度开 flag（.env + 容器重建）→ 真实对话回合验证预扣/结算/明细 → 观察一周 → 固化 on。
