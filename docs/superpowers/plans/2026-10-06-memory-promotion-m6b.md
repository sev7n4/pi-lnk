# M6b 记忆晋升候选队列 + 抑制标记入口 Implementation Plan

- 日期：2026-10-06
- 设计依据：`docs/superpowers/specs/2026-10-06-memory-promotion-m6b-design.md`（判据继承 2026-10-04 spec §13.3）
- 分支：`feat/memory-promotion-m6b`（worktree `.worktrees/m6b-promotion`）
- 全局约束：不新增/修改任何提示词规则（L6 零消耗）；不碰 `apps/server/prisma/schema.prisma`（无迁移，复用现有列）；改 `metrics.ts` 已在设计 §2.2 明示跨界理由。

## Task 1: 候选聚合（服务层，TDD）

- [x] **Step 1 写失败测试**：`agent-memory.service.test.ts` 追加 `promotionCandidates` 套件——① 同 sessionId 同内容 3 行 → 1 候选 count=3，`memoryIds` 全量、`sampleContents` ≤3 条截断 120 字；② 2 行不进；③ 跨 sessionId 同内容不合并；④ 尾部标点/空白/大小写差不分裂（normalize）；⑤ `source='promoted'` 不计入；⑥ count 降序、同级 lastSeenAt 降序；⑦ 空库返回空数组不抛。
- [x] **Step 2 实现**：`AgentMemoryService.promotionCandidates(input: { minCount?, limit? })`——`findMany({ where: { scope: 'canvas', source: { not: 'promoted' } }, orderBy: createdAt desc, take: 5000 })` → JS 聚合 Map。normalize：trim → 折叠空白 → 小写 → 反复剥离尾部标点 `。.！!？?；;，,、`。
- [x] **Step 3 跑绿**：`pnpm --filter @lnkpi/server exec vitest run src/agent/agent-memory.service.test.ts`（单文件，本机 90-170s 正常）。

## Task 2: Nest 端点（队列 + 抑制标记）

- [x] **Step 1 失败测试** ⚠️ **偏差记录**：未建 `agent.controller.memory-ops.test.ts`——两个端点是薄封装（AuthGuard + DTO + 委托 `AgentMemoryService`），行为判据（归属校验 404 / fail-soft 转发 / 幂等 / 未配置不转发 / 非 2xx 判 false）已下沉到 `agent-memory.service.test.ts` 的 `suppressMemory` 套件（7 条）+ `promotionCandidates` 套件（10 条）；controller 再测只会重复断言委托。Guard 装配由 `@UseGuards(AuthGuard)` 编译期可见保证。
- [x] **Step 2 实现**：`agent.controller.ts` 挂 `GET memory/promotion-candidates`（AuthGuard）与 `POST memory/suppressions`（AuthGuard）。转发用 `PI_RUNTIME_URL`（agent.service 同源读取方式），`AbortController` 超时 3s，失败仅日志。
- [x] **Step 3 跑绿 + `tsc --noEmit`**（vitest 绿 ≠ tsc 绿）。

## Task 3: pi-runtime 内部端点 + 指标接通

- [x] **Step 1 失败测试**：`app.test.ts` 追加——POST `/internal/memory-suppress` 后 ① recall_memory 结果剔除该条；② 缺 body 字段 → 400；③ 指标 `pi_runtime_memory_suppressed_total` 首次 +1、重复不再 +1（幂等）。
- [x] **Step 2 实现**：`app.ts` 加路由（Fastify schema 校验 body）；`metrics.ts` 加 `observeMemorySuppressed()` + 渲染行（`# HELP/TYPE counter`，命名 `pi_runtime_memory_suppressed_total`——重名会静默毁掉 /metrics，先全仓确认无同名）。
- [x] **Step 3 跑绿**：`node --import tsx --test services/pi-runtime/src/app.test.ts`。

## Task 4: runbook + 文档

- [x] **Step 1**：`docs/ops/memory-m6b-runbook.md`——队列 curl 示例、抑制止血 curl、晋升→6 处同步→PR 操作序列、指标读数口径（0 = 链路未触发，不是无污染）。
- [x] **Step 2**：设计/计划文档随分支提交。

## Task 5: 收口

- [ ] 全量相关测试 + `pnpm prompt:lint`（确认零预算影响）+ `pnpm -r build`。
- [ ] commit（`git commit -o` 逐文件）→ push → PR → 盯 CI → squash merged。
- [ ] 部署：本 PR 动了 `apps/server/**` 与 `services/pi-runtime/**` ⇒ deploy.yml（api）自动跑；**pi-runtime 需手工 dispatch**（tag = master 短 SHA）——**合并后先问人再派**（红线：不擅自发 pi-runtime）。
- [ ] 生产验证：队列端点带 token 实测、`/metrics` 出现新 counter。
