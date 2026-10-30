# 会话历史恢复治本 H0+H1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地规格 [`docs/superpowers/specs/2026-10-28-agent-history-recovery-h0-h1-design.md`](../specs/2026-10-28-agent-history-recovery-h0-h1-design.md) 的 9 项：服务端缓存收口、legacy 线程归并、失败重试入口、分页游标、轻量计数、死端点退役、加载期净化、机器载荷单源。

**Architecture:** H0 在服务端响应出口统一缓存决策（`NoCacheInterceptor`）+ 数据层 expand→migrate 归并；H1 补齐读协议（游标分页 / count 合并 / 死端点清除 / sanitize / shared 单源）。服务端纯逻辑全部抽为可单测的导出函数（`messages-cursor.ts` / `isCacheablePath` / `visibleThreadWhere`），prisma 接线薄。

**Tech Stack:** NestJS + Prisma(SQLite) + Vue3 + vitest（服务端与 web 均为 vitest）。

**Spec:** `docs/superpowers/specs/2026-10-28-agent-history-recovery-h0-h1-design.md`（判据 K1-K5、契约 §5.2、验收 S1-S8、文件清单 §9）

## Global Constraints

- 测试一律 node24 + web 侧 `--maxWorkers=1 --no-file-parallelism`，批次 ≤3 文件（4 核/8GB 会 OOM 137）。
- web 样式只用既有 `--lnk-*` 令牌（本计划只用已实测存在的：`--lnk-border-subtle` / `--lnk-surface-raised` / `--lnk-text-muted` / `--lnk-accent`），禁新增 hex / `--neo-*`。
- 缓存正确性归服务端（K1）：前端既有 `cache:'no-store'` 全部保留为纵深防御，本计划不删任何一处。
- commit 只在 feature worktree 内做，`git add` 只加点名文件（禁 `add -A`）；H0 与 H1 分组 PR（分组建议见文末）。
- H0-b 的生产执行（备份→演练→deploy→校验）不在本计划内自动执行；本地只做迁移与脚本，生产三道闸按规格 §7.3 人工走。
- 改 `AgentSideRail.vue` 后必跑 `vue-tsc -b`（node24 + `NODE_OPTIONS=--max-old-space-size=3072`）。
- 迁移命名对齐 ADR-0015 T1：`<ts>_unify_legacy_thread_messages`；时间戳用 `20261028` 前缀（与库内 `20261022043000` 风格一致）。

## Review Focus

规格隐含但单测最易漏的 5 类输入（每条已在对应 task 钉测试）：

1. **304 条件重校验路径**——收口后任何 GET 都必须带 no-store（Task 1 行为测试；前端既有 `historyFetchNoStore.test.ts` 保持绿作纵深）。
2. **畸形游标**（base64 垃圾 / 缺分隔符 / 坏日期）必须 400 而非静默空页（Task 7）。
3. **同毫秒消息页边界**——游标必须带 id 决胜，否则同毫秒写入重复/漏（Task 7）。
4. **全畸形历史输入**（metadata 全损坏 + 空 assistant 行）不得崩溃，输出空数组（Task 11）。
5. **threads 拉取失败现场保留**——fail-open，不得清 fork key（Task 9）。

---

### Task 1: H0-a 服务端缓存收口（NoCacheInterceptor）

**Files:**
- Create: `apps/server/src/common/no-cache.interceptor.ts`
- Create: `apps/server/src/common/no-cache.interceptor.test.ts`
- Modify: `apps/server/src/main.ts`

**Interfaces:**
- Produces: `NoCacheInterceptor`（Nest 全局拦截器）、`isCacheablePath(path, whitelist?)`、`CACHEABLE_GET_PATHS: readonly string[]`（今日为空，将来可缓存端点的显式出口）

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/src/common/no-cache.interceptor.test.ts
import { describe, expect, it, vi } from 'vitest'
import { CACHEABLE_GET_PATHS, NoCacheInterceptor, isCacheablePath } from './no-cache.interceptor'

function makeCtx(method: string, originalUrl: string) {
  const res = { setHeader: vi.fn() }
  const ctx = { switchToHttp: () => ({ getRequest: () => ({ method, originalUrl }), getResponse: () => res }) }
  return { ctx, res }
}

const passthrough = { handle: () => 'next' } as never

describe('isCacheablePath', () => {
  it('空白名单恒 false（K1：默认全禁）', () => {
    expect(CACHEABLE_GET_PATHS).toEqual([])
    expect(isCacheablePath('/api/works')).toBe(false)
  })
  it('白名单精确与前缀匹配，且不做意外子串匹配', () => {
    expect(isCacheablePath('/api/exports/x', ['/api/exports'])).toBe(true)
    expect(isCacheablePath('/api/exportsfoo', ['/api/exports'])).toBe(false)
  })
})

describe('NoCacheInterceptor', () => {
  it('动态 GET 注入 Cache-Control: no-store（S2 的服务端半边）', () => {
    const { ctx, res } = makeCtx('GET', '/api/agent/chat/threads?sessionId=s1')
    new NoCacheInterceptor().intercept(ctx as never, passthrough)
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })
  it('非 GET 不注入', () => {
    const { ctx, res } = makeCtx('POST', '/api/agent/chat/conversation')
    new NoCacheInterceptor().intercept(ctx as never, passthrough)
    expect(res.setHeader).not.toHaveBeenCalled()
  })
  it('白名单路径不注入（构造注入，可测）', () => {
    const { ctx, res } = makeCtx('GET', '/api/exports/doc.pdf')
    new NoCacheInterceptor(['/api/exports']).intercept(ctx as never, passthrough)
    expect(res.setHeader).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/common/no-cache.interceptor.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

```ts
// apps/server/src/common/no-cache.interceptor.ts
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import type { Observable } from 'rxjs'

/**
 * H0-a（规格 2026-10-28 §5.1）：动态 GET 统一注入 `Cache-Control: no-store`。
 *
 * 为什么在服务端收口（K1）：Express 对全部动态 GET 默认打 ETag、无 Cache-Control ⇒
 * 浏览器条件重校验拿 304 空体 ⇒ 前端 fetch `res.ok=false`/`json()` 抛错。此前修复
 * 全靠前端逐点补 `no-store`（已 8 处、3 次生产事故）——正确性不得依赖每个调用点的自觉。
 *
 * 白名单今日为空：将来出现「明确可缓存」的端点（如导出下载）在 CACHEABLE_GET_PATHS 显式登记。
 * `/api/uploads/*` 走 express static 中间件，先于拦截器执行，不受影响；
 * SSE（/runs/events）被注入 no-store 无副作用（本就不应缓存）。
 */
export const CACHEABLE_GET_PATHS: readonly string[] = []

export function isCacheablePath(path: string, whitelist: readonly string[] = CACHEABLE_GET_PATHS): boolean {
  return whitelist.some((p) => path === p || path.startsWith(`${p}/`))
}

@Injectable()
export class NoCacheInterceptor implements NestInterceptor {
  constructor(private readonly whitelist: readonly string[] = CACHEABLE_GET_PATHS) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp()
    const req = http.getRequest<{ method?: string; originalUrl?: string }>()
    if (req.method === 'GET' && !isCacheablePath(req.originalUrl ?? '', this.whitelist)) {
      http.getResponse<{ setHeader: (k: string, v: string) => void }>().setHeader('Cache-Control', 'no-store')
    }
    return next.handle()
  }
}
```

`apps/server/src/main.ts` 在 `app.useGlobalPipes(...)`（:30）之后加：

```ts
import { NoCacheInterceptor } from './common/no-cache.interceptor'
// H0-a（规格 2026-10-28 §5.1）：动态 GET 统一 no-store，缓存策略服务端收口（K1）
app.useGlobalInterceptors(new NoCacheInterceptor())
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/common/no-cache.interceptor.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: PASS（6 用例）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/common/no-cache.interceptor.ts apps/server/src/common/no-cache.interceptor.test.ts apps/server/src/main.ts
git commit -m "fix(agent): 收口动态 GET 缓存策略——全局 NoCacheInterceptor 注入 no-store（规格 H0-a）"
```

---

### Task 2: H0-b 迁移一（expand）：AgentThread.archivedAt 加列

**Files:**
- Modify: `apps/server/prisma/schema.prisma`（AgentThread 模型块，:376 起）
- Create: `apps/server/prisma/migrations/20261028200000_add_thread_archived_at/migration.sql`

**Interfaces:**
- Produces: `AgentThread.archivedAt: DateTime?`（后续 Task 3/4 消费；ADR-0015 T4 活跃叶子派生须排除）

- [ ] **Step 1: 改 schema**

在 `model AgentThread` 的 `turnState String?` 之后加（保持既有注释风格）：

```prisma
  /**
   * H0-b（规格 2026-10-28 §7.1）：legacy 归并标记。归并迁移把 id != sessionId 的
   * 孤儿线程行置值后，listThreads 过滤之（前端不可见、数据保留供审计）。
   * ⚠️ ADR-0015 Phase 2（T2/T4）实施时：parentThreadId 落地后，归档谓词须收窄为
   * 「id != sessionId 且 parentThreadId IS NULL」，活跃叶子派生必须排除已归档行。
   */
  archivedAt DateTime?
```

- [ ] **Step 2: 写迁移 SQL**

```sql
-- apps/server/prisma/migrations/20261028200000_add_thread_archived_at/migration.sql
-- H0-b expand：纯 additive 加列，可原样回滚（规格 §7.1 / K2）
ALTER TABLE "AgentThread" ADD COLUMN "archivedAt" DATETIME;
```

- [ ] **Step 3: 验证迁移可执行**

Run: `cd apps/server && npx prisma format && npx prisma migrate dev --name verify_add_thread_archived_at --create-only && npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script | head -5`
Expected: 无 drift 报错（本地 dev 库 `migrate dev` 应用成功即视为通过；`--create-only` 产物若为空删掉即可）

- [ ] **Step 4: Commit**

```bash
git add apps/server/prisma/schema.prisma apps/server/prisma/migrations/20261028200000_add_thread_archived_at/migration.sql
git commit -m "feat(agent): AgentThread.archivedAt 加列（规格 H0-b expand，纯 additive）"
```

---

### Task 3: H0-b 迁移二（migrate）：legacy 归并 + 校验脚本

**Files:**
- Create: `apps/server/prisma/migrations/20261028210000_unify_legacy_thread_messages/migration.sql`
- Create: `scripts/verify-thread-unify.ts`

**Interfaces:**
- Consumes: Task 2 的 `archivedAt` 列
- Produces: 校验脚本 `verify-thread-unify.ts`（生产三道闸第 4 步的执行件，规格 §7.3）

- [ ] **Step 1: 写归并迁移 SQL（图 2 四步顺序）**

```sql
-- apps/server/prisma/migrations/20261028210000_unify_legacy_thread_messages/migration.sql
-- H0-b migrate（规格 §7.2）：把 legacy 孤儿线程消息归并到共享线程（threadId == sessionId）。
-- 幂等来源：三步全是条件 UPDATE/DELETE，重跑影响行数为零。
-- 回滚 = 恢复文件级备份（移动不可逆，规格 §7.2）。
-- ⚠️ 执行前置闸门：verify-thread-unify.ts 的 Phase 1 时刻前置断言必须为 0
--（孤儿线程 id 与在役 fork 分支同构，防误伤活跃分支，规格 §7.2 边界）。

-- 第 1 步：去重——孤儿行与同会话共享线程行同键（runId 非空）时删孤儿侧
DELETE FROM "AgentMessage"
WHERE "threadId" != "sessionId"
  AND "runId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "AgentMessage" m2
    WHERE m2."threadId" = m2."sessionId"
      AND m2."sessionId" = "AgentMessage"."sessionId"
      AND m2."runId" = "AgentMessage"."runId"
      AND m2."role" = "AgentMessage"."role"
      AND m2."content" = "AgentMessage"."content"
  );

-- 第 2 步：去重——runId 为空的存量行：同会话 + 同 role + 同 content + 同 createdAt（同毫秒全同文本视为重复）
DELETE FROM "AgentMessage"
WHERE "threadId" != "sessionId"
  AND "runId" IS NULL
  AND EXISTS (
    SELECT 1 FROM "AgentMessage" m2
    WHERE m2."threadId" = m2."sessionId"
      AND m2."sessionId" = "AgentMessage"."sessionId"
      AND m2."role" = "AgentMessage"."role"
      AND m2."content" = "AgentMessage"."content"
      AND m2."createdAt" = "AgentMessage"."createdAt"
  );

-- 第 3 步：移动（createdAt 原值保留，时序天然不变）
UPDATE "AgentMessage" SET "threadId" = "sessionId" WHERE "threadId" != "sessionId";

-- 第 4 步：归档孤儿线程行（保留供审计，含其 turnState）；strftime 产出 Prisma 兼容的 ISO-8601
UPDATE "AgentThread"
SET "archivedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE "id" != "sessionId" AND "archivedAt" IS NULL;

-- 共享线程的 turnState 不动（规格 §7.2 第 4 条：活跃线程回合连续性状态只认共享线程行）
```

- [ ] **Step 2: 写校验脚本**

```ts
// scripts/verify-thread-unify.ts
/**
 * H0-b 归并校验（规格 §7.3 第 4 步 / §8 幂等判据 / 验收 S3+S4）。
 * 用法：DATABASE_URL=... npx tsx scripts/verify-thread-unify.ts
 * 全部断言通过退出码 0；任一失败非 0（生产门禁：不通过即停发回滚）。
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  // 前置断言（规格 §7.2 边界 / §8）：孤儿线程 id 形态与在役 fork（重跑）分支**同构**
  //（生产实证 223 条孤儿全为 `sessionId:后缀` 复合键）。Phase 1 上线（2026-10-26 21:32 CST）
  // 之后出现的孤儿行疑似活跃 fork 分支，归并会破坏重跑特性 ⇒ 必须中止转人工。
  const PHASE1_CUTOFF = 1793021520000 // 2026-10-26 21:32 CST

  const [orphanMessages, orphanThreads, totalMessages, postPhase1OrphanThreads] = await Promise.all([
    prisma.agentMessage.count({ where: { NOT: { threadId: prisma.agentMessage.fields.sessionId } } }),
    prisma.agentThread.count({ where: { AND: [{ NOT: { id: prisma.agentThread.fields.sessionId } }, { archivedAt: null }] } }),
    prisma.agentMessage.count(),
    prisma.agentThread.count({
      where: { AND: [{ NOT: { id: prisma.agentThread.fields.sessionId } }, { createdAt: { gte: new Date(PHASE1_CUTOFF) } }] },
    }),
  ])

  console.log({ totalMessages, orphanMessages, unarchivedOrphanThreads: orphanThreads, postPhase1OrphanThreads })

  if (postPhase1OrphanThreads !== 0) {
    console.error(`✗ 发现 ${postPhase1OrphanThreads} 条 Phase 1 上线后创建的孤儿线程——疑似在役 fork（重跑）活跃分支，禁止归并，转人工判定（规格 §7.2 边界）`)
    process.exitCode = 1
  }
  if (orphanMessages !== 0) {
    console.error(`✗ 仍有 ${orphanMessages} 条孤儿消息（threadId != sessionId）`)
    process.exitCode = 1
  }
  if (orphanThreads !== 0) {
    console.error(`✗ 仍有 ${orphanThreads} 条孤儿线程未归档（id != sessionId 且 archivedAt 为空）`)
    process.exitCode = 1
  }
  if (process.exitCode !== 1) {
    console.log('✓ 归并后置条件全部满足；重跑迁移将影响 0 行（幂等）')
  }
}

main().finally(() => prisma.$disconnect())
```

- [ ] **Step 3: 本地库演练（含幂等双跑）**

Run:
```bash
cd apps/server && npx prisma migrate dev && cd .. && DATABASE_URL=file:./apps/server/prisma/dev.db npx tsx scripts/verify-thread-unify.ts
```
Expected: 迁移应用成功；脚本输出 `✓`。再手动对 dev 库重跑一遍迁移 SQL（`sqlite3` 执行 migration.sql 全文）后重跑脚本——输出不变即幂等实证。

- [ ] **Step 4: Commit**

```bash
git add apps/server/prisma/migrations/20261028210000_unify_legacy_thread_messages/migration.sql scripts/verify-thread-unify.ts
git commit -m "feat(agent): legacy 线程归并迁移（去重→移动→归档）+ 幂等校验脚本（规格 H0-b / ADR-0015 T1）"
```

---

### Task 4: H0-b 读端契约：listThreads 保留归档行透出（H0-c 禁用态数据源）

**Files:**
- Test: `apps/server/src/agent/agent.service.visible-threads.test.ts`（新增，负向契约守卫）

**Interfaces:**
- Produces: `listThreads` 行透出 `archivedAt` 列（Task 2 加列后 Prisma findMany 自然带出，**零代码改动**）；**禁止**加 `archivedAt: null` 过滤——归档行必须到达前端渲染禁用态（规格 §5.2 / §7.2 谓词解耦）
- Consumes: Task 2 的 `archivedAt` 列

> 审核修订说明（2026-10-28）：本 task 原设计为「listThreads 过滤已归档行」，与 H0-c 禁用态矛盾（行被过滤后前端无从渲染禁用态），且会误伤在役 fork 分支的可见性。改为**负向契约守卫**：用测试钉死「listThreads 不过滤」，防止后续实施者凭直觉补上过滤。

- [ ] **Step 1: 写守卫测试（守卫性质：对现状直接通过）**

```ts
// apps/server/src/agent/agent.service.visible-threads.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('./agent.service.ts', import.meta.url)), 'utf8')

describe('listThreads 归档行透出（规格 H0-b 读端 / §5.2 谓词解耦）', () => {
  it('listThreads 不得过滤 archivedAt——归档行必须到达前端渲染 H0-c 禁用态', () => {
    const start = src.indexOf('async listThreads')
    expect(start, 'listThreads 必须存在').toBeGreaterThan(0)
    const scope = src.slice(start, src.indexOf('\n  async ', start + 1))
    expect(scope).not.toContain('archivedAt')
  })
})
```

- [ ] **Step 2: 跑测试确认通过（守卫：现状即应通过）**

Run: `cd apps/server && npx vitest run src/agent/agent.service.visible-threads.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: PASS（当前 listThreads 无 archivedAt 过滤；若 FAIL 说明有人已加过滤，先回滚该改动）

- [ ] **Step 3: 确认归档行可达前端**

Task 2 加列后，`listThreads` 的 `findMany` 未用 `select` 收窄 ⇒ `archivedAt` 随行自然透出。用 sqlite3 对 dev 库手工置一行 `archivedAt` 非空，curl `chat/threads` 确认该行在响应中且带值。

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/agent/agent.service.visible-threads.test.ts
git commit -m "test(agent): 钉死 listThreads 保留归档行透出（规格 H0-b 读端 / H0-c 禁用态数据源）"
```

---

### Task 5: H0-c legacy 行禁用态（历史面板过渡态）

**Files:**
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（PC popover :4257 与移动端 thread-history-layer :4160 两处 `v-for`；`selectThread` :1630 守卫保留为双保险；`AgentThreadRow` :156 加 `archivedAt` 字段）
- Test: `apps/web/src/components/agent/AgentSideRail.legacyThreadArchived.test.ts`（新增）

**Interfaces:**
- Produces: `isArchivedThread(thread)` 组件内辅助函数（模板两处消费），谓词 = `archivedAt` 非空
- Consumes: Task 4 透出的 `archivedAt` 列

> ⚠️ 禁用谓词**禁止 `id !== sessionId`**：在役 fork（重跑）分支线程 id 同为 `sessionId:后缀` 复合键（生产实证，规格 §7.2 边界），按 id 判禁会误杀活跃分支。

- [ ] **Step 1: 写失败测试（静态契约，沿 historyFetchNoStore.test.ts 的文件文本断言模式）**

```ts
// apps/web/src/components/agent/AgentSideRail.legacyThreadArchived.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('./AgentSideRail.vue', import.meta.url)), 'utf8')

describe('AgentSideRail legacy 线程禁用态（规格 H0-c）', () => {
  it('两处线程列表（PC popover + 移动端层）都接 isArchivedThread 禁用', () => {
    expect(src.split(':disabled="isArchivedThread(thread)"').length - 1).toBeGreaterThanOrEqual(2)
  })
  it('谓词必须是 archivedAt 非空，禁止 id !== sessionId（在役 fork 分支同构，规格 §7.2）', () => {
    expect(src).toContain('thread.archivedAt != null')
    expect(src).not.toContain('return thread.id !== props.sessionId')
  })
  it('归档行有「已归档」标注文案', () => {
    expect(src).toContain('已归档')
  })
  it('selectThread 守卫仍在（双保险：id != agentThreadId 的行不切换）', () => {
    expect(src).toContain('async function selectThread(threadId: string)')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/agent/AgentSideRail.legacyThreadArchived.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL（无 `isArchivedThread`）

- [ ] **Step 3: 实现**

`AgentThreadRow`（:156）加 `archivedAt?: string | null`。

script 区（`selectThread` 定义旁）加：

```ts
/** H0-c（规格 §2/§5.2 谓词解耦）：归档行（迁移置 archivedAt）渲染禁用态，停止「点了没反应」。
 *  谓词必须是 archivedAt 而非 id 比较——在役 fork（重跑）分支 id 同为 sessionId:后缀 复合键。 */
function isArchivedThread(thread: AgentThreadRow): boolean {
  return thread.archivedAt != null
}
```

PC popover（:4257 起的 `v-for="thread in threads"`）：

```html
<button
  v-for="thread in threads"
  :key="thread.id"
  type="button"
  class="..."
  :class="{ 'is-current': thread.id === agentThreadId }"
  :disabled="isArchivedThread(thread)"
  :title="thread.title"
  @click="selectThread(thread.id)"
>
  <span class="block truncate font-medium">{{ thread.title }}{{ isArchivedThread(thread) ? '（已归档 · 即将合并到主对话）' : '' }}</span>
```

（`class`/结构按现场保持，只加 `:disabled` 与标注；移动端 :4160 处的 `v-for` 同样加 `:disabled="isArchivedThread(thread)"` 与同款标注，点击仍走 `closeThreadHistory()`。）

样式：禁用态不加新 CSS 类则用原生 disabled + 既有 opacity；如需样式，只允许既有令牌（`--lnk-text-disabled` / `--lnk-border-subtle`），禁 hex。

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `cd apps/web && npx vitest run src/components/agent/AgentSideRail.legacyThreadArchived.test.ts src/components/agent/AgentSideRail.forkKeyWiring.test.ts --maxWorkers=1 --no-file-parallelism && NODE_OPTIONS=--max-old-space-size=3072 npx vue-tsc -b`
Expected: PASS + tsc 绿

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agent/AgentSideRail.vue apps/web/src/components/agent/AgentSideRail.legacyThreadArchived.test.ts
git commit -m "fix(agent): 历史面板 legacy 线程渲染禁用态+归档标注（规格 H0-c，消灭点了没反应）"
```

---

### Task 6: H0-d loadHistory 失败重试入口

**Files:**
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（`loadHistory` :1926；消息循环 :4401 上方；script 区 ref 声明）
- Test: `apps/web/src/components/agent/AgentSideRail.historyRetryCard.test.ts`（新增）

**Interfaces:**
- Produces: `historyLoadState: Ref<'idle' | 'loading' | 'failed'>`（Task 8 的分页改造延续消费）

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/components/agent/AgentSideRail.historyRetryCard.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('./AgentSideRail.vue', import.meta.url)), 'utf8')

describe('AgentSideRail 历史加载失败重试卡（规格 H0-d / K3 / 验收 S1）', () => {
  it('存在失败态状态机（不再是 toast+空白）', () => {
    expect(src).toContain("'idle' | 'loading' | 'failed'")
  })
  it('失败卡带重试入口且重新调用 loadHistory', () => {
    expect(src).toContain('对话历史加载失败')
    expect(src).toContain('@click="loadHistory()"')
  })
  it('res.ok 失败分支与 catch 分支都置 failed', () => {
    expect(src.match(/historyLoadState\.value = 'failed'/g)?.length).toBeGreaterThanOrEqual(2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/agent/AgentSideRail.historyRetryCard.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL

- [ ] **Step 3: 实现**

script 区（`loadHistory` 上方）：

```ts
/** H0-d（规格 §2/K3）：历史加载失败必须 fail-visible + 可重入，禁止 toast+空白（验收 S1）。 */
type HistoryLoadState = 'idle' | 'loading' | 'failed'
const historyLoadState = ref<HistoryLoadState>('idle')
```

`loadHistory`（:1926）精确改动——`old_string`：

```ts
async function loadHistory() {
  agent.clear()
  taskProgress.value = emptyTaskProgress()
  try {
```

`new_string`：

```ts
async function loadHistory() {
  agent.clear()
  taskProgress.value = emptyTaskProgress()
  historyLoadState.value = 'loading'
  try {
```

`old_string`：

```ts
    if (!res.ok) {
      ElMessage.warning('对话历史加载失败，请检查网络后刷新')
      return
    }
```

`new_string`：

```ts
    if (!res.ok) {
      ElMessage.warning('对话历史加载失败，请检查网络后刷新')
      historyLoadState.value = 'failed'
      return
    }
```

成功路径：在 `if (json.data?.length) {` 块结束后（`}` 与 `} catch {` 之间）插入 `historyLoadState.value = 'idle'`；`catch` 分支：

`old_string`：

```ts
  } catch {
    ElMessage.warning('对话历史加载失败，请检查网络后刷新')
  }
  scrollToBottom(true)
```

`new_string`：

```ts
  } catch {
    ElMessage.warning('对话历史加载失败，请检查网络后刷新')
    historyLoadState.value = 'failed'
  }
  scrollToBottom(true)
```

模板：`v-for="msg in agent.messages"`（:4401）所在滚动容器顶部插入：

```html
<div
  v-if="historyLoadState === 'failed'"
  class="mx-3 my-2 flex items-center justify-between rounded-lg border px-3 py-2"
  :style="{ borderColor: 'var(--lnk-border-subtle)', background: 'var(--lnk-surface-raised)' }"
>
  <span class="text-xs" :style="{ color: 'var(--lnk-text-muted)' }">对话历史加载失败</span>
  <button
    type="button"
    class="text-xs font-medium"
    :style="{ color: 'var(--lnk-accent)' }"
    @click="loadHistory()"
  >重试</button>
</div>
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `cd apps/web && npx vitest run src/components/agent/AgentSideRail.historyRetryCard.test.ts src/components/agent/AgentSideRail.historyFetchNoStore.test.ts --maxWorkers=1 --no-file-parallelism && NODE_OPTIONS=--max-old-space-size=3072 npx vue-tsc -b`
Expected: PASS + tsc 绿

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agent/AgentSideRail.vue apps/web/src/components/agent/AgentSideRail.historyRetryCard.test.ts
git commit -m "fix(agent): 历史加载失败渲染重试卡（规格 H0-d / K3，消灭 toast+空白）"
```

---

### Task 7: H1-a 服务端分页游标

**Files:**
- Create: `apps/server/src/agent/messages-cursor.ts`
- Create: `apps/server/src/agent/messages-cursor.test.ts`
- Modify: `apps/server/src/agent/agent.controller.ts`（DTO :215、端点 :256）
- Modify: `apps/server/src/agent/agent.service.ts`（`getMessages` :280）

**Interfaces:**
- Produces: `encodeCursor(row): string`、`decodeCursor(raw): { createdAt: Date; id: string }`（畸形输入抛 `BadRequestException`）、`paginateVisibleRows(rows, take)`（入参必须已按 `(createdAt desc, id desc)` 排序且完成 superseded 过滤；返回 `{ page /* asc */, hasMore, nextCursor }`）
- Consumes: 无（独立基座；Task 8 前端消费其输出）

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/src/agent/messages-cursor.test.ts
import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor, paginateVisibleRows } from './messages-cursor'

const row = (id: string, iso: string) => ({ id, createdAt: new Date(iso) })

describe('encodeCursor/decodeCursor', () => {
  it('往返一致（Review Focus #2/#3 地基）', () => {
    const r = row('m1', '2026-10-28T10:00:00.000Z')
    expect(decodeCursor(encodeCursor(r))).toEqual(r)
  })
  it('畸形输入抛错而非静默空页', () => {
    expect(() => decodeCursor('not-a-cursor!!')).toThrow()
    expect(() => decodeCursor(Buffer.from('no-separator', 'utf8').toString('base64url'))).toThrow()
    expect(() => decodeCursor(Buffer.from('bad-date|x', 'utf8').toString('base64url'))).toThrow()
  })
})

describe('paginateVisibleRows', () => {
  const rows = [
    row('m4', '2026-10-28T10:03:00.000Z'),
    row('m3', '2026-10-28T10:02:00.000Z'),
    row('m2', '2026-10-28T10:01:00.000Z'),
    row('m1', '2026-10-28T10:00:00.000Z'),
  ]
  it('首页取最新 take 条，输出 asc，尾部 hasMore=false 无游标', () => {
    const p = paginateVisibleRows(rows.slice(0, 3), 5)
    expect(p.page.map((r) => r.id)).toEqual(['m1', 'm2', 'm3'])
    expect(p.hasMore).toBe(false)
    expect(p.nextCursor).toBeNull()
  })
  it('hasMore=true 时游标指向本页最早一行（asc 首行）', () => {
    const p = paginateVisibleRows(rows, 2)
    expect(p.page.map((r) => r.id)).toEqual(['m3', 'm4'])
    expect(p.hasMore).toBe(true)
    expect(p.nextCursor).toBe(encodeCursor(row('m3', '2026-10-28T10:02:00.000Z')))
  })
  it('同毫秒行按 id 决胜（Review Focus #3：页边界不重不漏）', () => {
    const tied = [row('b', '2026-10-28T10:00:00.000Z'), row('a', '2026-10-28T10:00:00.000Z')]
    const p = paginateVisibleRows(tied, 1)
    expect(p.page[0]!.id).toBe('b')
    // 游标必须指向页内 desc 序末行（= 本页最早一行 b）：下一页 where id < b 才能取回 a。
    // 若指向页外行 a，则 id < a 永远取不到 a ⇒ 同毫秒页边界丢行。
    expect(p.nextCursor).toBe(encodeCursor(row('b', '2026-10-28T10:00:00.000Z')))
  })
  it('空输入得空页', () => {
    expect(paginateVisibleRows([], 10)).toEqual({ page: [], hasMore: false, nextCursor: null })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/agent/messages-cursor.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// apps/server/src/agent/messages-cursor.ts
import { BadRequestException } from '@nestjs/common'

/**
 * H1-a（规格 §5.2/§8）：历史分页游标。seq 就绪（2026-10-21 Task 7）后由 seq 游标替换，
 * 本模块届时整体退役——所有分页语义收敛在这一个文件里，替换面最小。
 */
export interface CursorRow {
  createdAt: Date
  id: string
}

export function encodeCursor(row: CursorRow): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url')
}

export function decodeCursor(raw: string): CursorRow {
  let decoded: string
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8')
  } catch {
    throw new BadRequestException('malformed cursor')
  }
  const sep = decoded.lastIndexOf('|')
  const iso = sep > 0 ? decoded.slice(0, sep) : ''
  const id = sep > 0 ? decoded.slice(sep + 1) : ''
  const ts = new Date(iso)
  if (!iso || !id || Number.isNaN(ts.getTime())) {
    throw new BadRequestException('malformed cursor')
  }
  return { createdAt: ts, id }
}

/** rows 必须已按 (createdAt desc, id desc) 排序且完成 superseded 过滤；page 输出 asc。 */
export function paginateVisibleRows<T extends CursorRow>(rows: T[], take: number) {
  const page = rows.slice(0, take)
  const hasMore = rows.length > take
  const nextCursor = page.length ? encodeCursor(page[page.length - 1]) : null
  return { page: [...page].reverse(), hasMore, nextCursor }
}
```

`agent.service.ts` 的 `getMessages`（:280）整体替换为：

```ts
  async getMessages(sessionId: string, threadId: string, before?: string, limit?: number) {
    if (!sessionId?.trim() || !threadId?.trim()) {
      throw new BadRequestException('sessionId and threadId are required')
    }
    const take = Math.min(Math.max(limit ?? 100, 1), 200)
    const cursor = before ? decodeCursor(before) : null
    const rows = await this.prisma.agentMessage.findMany({
      where: {
        sessionId,
        threadId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // overfetch 给 superseded 过滤留余量（D13：过滤不得发生在 take 之后）；
      // supersededBy 真列化（规格 §12，随 Task 7 seq 收口）后退役。
      take: take * 2,
    })
    const visible = rows.filter((r) => {
      if (r.role !== 'assistant') return true
      let supersededBy: unknown
      try {
        const parsed = r.metadata ? JSON.parse(r.metadata) : null
        supersededBy =
          parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).supersededBy : null
      } catch {
        supersededBy = null
      }
      return !supersededBy
    })
    return paginateVisibleRows(visible, take)
  }
```

（import 区加 `import { decodeCursor, paginateVisibleRows } from './messages-cursor'`。）

`agent.controller.ts`：DTO（:215）改为：

```ts
class GetAgentMessagesQueryDto {
  @IsString()
  sessionId!: string

  @IsString()
  threadId!: string

  @IsOptional()
  @IsString()
  before?: string

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number
}
```

端点（:256）改为：

```ts
  @Get('chat/user/messages')
  async getMessages(@Query() query: GetAgentMessagesQueryDto) {
    const result = await this.agentService.getMessages(query.sessionId, query.threadId, query.before, query.limit)
    // data 形状与排序不变（asc，向后兼容）；hasMore/nextCursor 服务端权威输出（K5）
    return { code: 0, message: 'ok', data: result.page, hasMore: result.hasMore, nextCursor: result.nextCursor }
  }
```

（`@Max/@Min` 若未 import 需从 `class-validator` 补。）

- [ ] **Step 4: 跑测试确认通过 + 服务端全量回归**

Run: `cd apps/server && npx vitest run src/agent/messages-cursor.test.ts src/agent/agent.service.visible-threads.test.ts --maxWorkers=1 --no-file-parallelism && npx vitest run src/agent --maxWorkers=1 --no-file-parallelism 2>&1 | tail -3`
Expected: PASS，agent 目录既有测试无回归

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/messages-cursor.ts apps/server/src/agent/messages-cursor.test.ts apps/server/src/agent/agent.controller.ts apps/server/src/agent/agent.service.ts
git commit -m "feat(agent): 历史消息分页游标 before/limit + hasMore/nextCursor（规格 H1-a / K5）"
```

---

### Task 8: H1-a 前端「加载更早消息」

**Files:**
- Modify: `apps/web/src/stores/agent.ts`（:99 导出 `PersistedAgentMessage` 类型）
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（`loadHistory` 消费游标字段；新增 `loadOlder`；模板 :4401 上方按钮）
- Test: `apps/web/src/components/agent/AgentSideRail.loadOlderWiring.test.ts`（新增）

**Interfaces:**
- Consumes: Task 7 的 `hasMore/nextCursor` 响应字段、Task 6 的 `historyLoadState`
- Produces: `loadOlder(): Promise<void>`、组件状态 `historyRows/historyCursor/historyHasMore/historyLoadingOlder`

- [ ] **Step 1: 写失败测试（静态契约）**

```ts
// apps/web/src/components/agent/AgentSideRail.loadOlderWiring.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('./AgentSideRail.vue', import.meta.url)), 'utf8')

describe('AgentSideRail 加载更早消息（规格 H1-a 前端半边 / 验收 S5）', () => {
  it('按钮由 historyHasMore 驱动，点击走 loadOlder', () => {
    expect(src).toContain('v-if="historyHasMore"')
    expect(src).toContain('@click="loadOlder()"')
  })
  it('翻页请求带 before 游标且 no-store（K1 纵深防御）', () => {
    expect(src).toContain('before=${encodeURIComponent(historyCursor.value)}')
    expect(src.split('loadOlder').length - 1).toBeGreaterThanOrEqual(3)
  })
  it('prepend 后整体重建历史（loadHistory 幂等映射，不叠加重复）', () => {
    expect(src).toContain('agent.loadHistory(historyRows.value)')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/agent/AgentSideRail.loadOlderWiring.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL

- [ ] **Step 3: 实现**

`stores/agent.ts:99` 的 `type PersistedAgentMessage = ...` 前加 `export`（AgentSideRail 需要该类型声明 historyRows）。

`AgentSideRail.vue` script 区（Task 6 的 `historyLoadState` 旁）加：

```ts
const historyRows = ref<PersistedAgentMessage[]>([])
const historyCursor = ref<string | null>(null)
const historyHasMore = ref(false)
const historyLoadingOlder = ref(false)
```

（import 区补 `import type { PersistedAgentMessage } from '@/stores/agent'`。）

`loadHistory` 内，`const json = await res.json()` 之后、`if (json.data?.length) {` 之前插入：

```ts
    // H1-a（规格 §5.2）：服务端权威分页字段（K5）
    historyRows.value = (json.data ?? []) as PersistedAgentMessage[]
    historyHasMore.value = json.hasMore === true
    historyCursor.value = json.nextCursor ?? null
```

并把该块内原有的 `agent.loadHistory(json.data)` 改为 `agent.loadHistory(historyRows.value)`（其余任务卡/ask_user 恢复逻辑仍读原始 `msgs = json.data`，不动——机器载荷行须参与 `hasUserAfter` 判定）。

`loadHistory` 之后新增：

```ts
/** H1-a（规格 §5.2/验收 S5）：向前翻页取更早消息；prepend 后整体重建（loadHistory 幂等映射）。 */
async function loadOlder() {
  if (!historyCursor.value || historyLoadingOlder.value) return
  historyLoadingOlder.value = true
  try {
    const res = await fetch(
      apiUrl(
        `/api/agent/chat/user/messages?sessionId=${encodeURIComponent(props.sessionId)}&threadId=${encodeURIComponent(agentThreadId.value)}&before=${encodeURIComponent(historyCursor.value)}`,
      ),
      { cache: 'no-store' },
    )
    if (!res.ok) return
    const json = await res.json()
    const older = (json.data ?? []) as PersistedAgentMessage[]
    historyRows.value = [...older, ...historyRows.value]
    historyHasMore.value = json.hasMore === true
    historyCursor.value = json.nextCursor ?? null
    agent.loadHistory(historyRows.value)
  } catch {
    // 翻页失败保持现场：按钮仍在，可再点（K3）
  } finally {
    historyLoadingOlder.value = false
  }
}
```

模板（:4401 `v-for="msg in agent.messages"` 容器顶部、Task 6 重试卡之后）：

```html
<button
  v-if="historyHasMore"
  type="button"
  class="mx-auto my-2 block rounded-full border px-3 py-1 text-xs"
  :disabled="historyLoadingOlder"
  :style="{ borderColor: 'var(--lnk-border-subtle)', color: 'var(--lnk-text-muted)' }"
  @click="loadOlder()"
>{{ historyLoadingOlder ? '加载中…' : '加载更早消息' }}</button>
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `cd apps/web && npx vitest run src/components/agent/AgentSideRail.loadOlderWiring.test.ts src/stores/agent.test.ts --maxWorkers=1 --no-file-parallelism && NODE_OPTIONS=--max-old-space-size=3072 npx vue-tsc -b`
Expected: PASS + tsc 绿

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/stores/agent.ts apps/web/src/components/agent/AgentSideRail.vue apps/web/src/components/agent/AgentSideRail.loadOlderWiring.test.ts
git commit -m "feat(agent): 「加载更早消息」游标翻页接入（规格 H1-a 前端，长对话不丢头部）"
```

---

### Task 9: H1-b 轻量计数 + bootstrap fail-open

**Files:**
- Modify: `apps/server/src/agent/agent.service.ts`（`listThreads` 加 `messageCount`）
- Modify: `apps/web/src/components/agent/streamRecovery.ts`（`resolveBootstrapThreadId` 重写，:120）
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（`fetchThreads` 失败返回 null；bootstrap 调用点 :1665；删 `messageCountFor` 实现；`AgentThreadRow` :156 加字段）
- Test: `apps/web/src/components/agent/streamRecovery.test.ts`（改写 bootstrap 用例）

**Interfaces:**
- Produces: `chat/threads` 行增 `messageCount: number`；`resolveBootstrapThreadId(sessionId, { threads: Array<{ id; messageCount }> | null })`——**签名变更**：`messageCountFor` 与死参数 `cachedThreadId`（D4）一并退役；`threads: null` 表示拉取失败（fail-open）

- [ ] **Step 1: 改写测试（不得只删不断言：删除的全量下载计数路径转为否定断言）**

`streamRecovery.test.ts` 中 `resolveBootstrapThreadId` 相关 describe 块替换为：

```ts
import { clearForkedThreadId, getForkedThreadId, persistForkedThreadId, resolveBootstrapThreadId } from './streamRecovery'

function stubLocalStorage() {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  return store
}

describe('resolveBootstrapThreadId（H1-b：threads 行计数 + fail-open）', () => {
  it('fork key 有消息（messageCount>0）⇒ 激活分支线程', async () => {
    stubLocalStorage()
    persistForkedThreadId('s1', 'branch_1')
    const id = await resolveBootstrapThreadId('s1', {
      threads: [{ id: 'branch_1', messageCount: 3 }, { id: 's1', messageCount: 9 }],
    })
    expect(id).toBe('branch_1')
  })
  it('fork key 无消息 ⇒ 清 fork key 回落共享线程（原行为不变）', async () => {
    stubLocalStorage()
    persistForkedThreadId('s1', 'branch_1')
    const id = await resolveBootstrapThreadId('s1', {
      threads: [{ id: 's1', messageCount: 9 }],
    })
    expect(id).toBe('s1')
    expect(getForkedThreadId('s1')).toBeNull()
  })
  it('threads=null（拉取失败）⇒ fail-open：保留 fork key 现场不清（Review Focus #5 / K3）', async () => {
    stubLocalStorage()
    persistForkedThreadId('s1', 'branch_1')
    const id = await resolveBootstrapThreadId('s1', { threads: null })
    expect(id).toBe('branch_1')
    expect(getForkedThreadId('s1')).toBe('branch_1')
  })
  it('threads=null 且无 fork key ⇒ 回落共享线程，同样不清任何 key', async () => {
    stubLocalStorage()
    const id = await resolveBootstrapThreadId('s1', { threads: null })
    expect(id).toBe('s1')
    expect(getForkedThreadId('s1')).toBeNull()
  })
})
```

（若文件里还有对旧签名 `messageCountFor` 的用例，删除并在同文件补一条否定断言：`expect(src).not.toContain('messageCountFor')` 风格的静态断言放在 `AgentSideRail.loadOlderWiring.test.ts` 不合适——改为在本文件顶部加 `it('messageCountFor 已退役（D3：bootstrap 不再全量下载计数）', async () => { expect((await import('./streamRecovery') as Record<string, unknown>).messageCountFor).toBeUndefined() })`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/agent/streamRecovery.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL（新签名不存在）

- [ ] **Step 3: 实现**

`streamRecovery.ts` 的 `resolveBootstrapThreadId`（:120）整体替换为：

```ts
export async function resolveBootstrapThreadId(
  sessionId: string,
  opts: {
    /**
     * threads 行（含服务端 messageCount，H1-b）；**null = 拉取失败**。
     * fail-open（K3/D3）：失败时保留 fork key 现场（不清、不覆盖），渲染层由 H0-d 重试卡兜底。
     * 旧 `messageCountFor`（全量下载 user/messages 只为数数）与死参数 `cachedThreadId`（D4）一并退役。
     */
    threads: Array<{ id: string; messageCount: number }> | null
  },
): Promise<string> {
  const shared = createAgentThreadId(sessionId)
  const forked = getForkedThreadId(sessionId)
  if (opts.threads === null) {
    return forked ?? shared
  }
  if (forked && forked !== shared) {
    const count = opts.threads.find((t) => t.id === forked)?.messageCount ?? 0
    if (count > 0) return forked
    clearForkedThreadId(sessionId) // 分支线程已空（异常/竞态）→ 清陈旧 fork key，回落共享
  }
  return shared
}
```

`agent.service.ts` 的 `listThreads`（Task 4 版本）改为：

```ts
  async listThreads(sessionId: string) {
    if (!sessionId?.trim()) {
      throw new BadRequestException('sessionId is required')
    }
    // H1-b（规格 §5.2）：messageCount 随 threads 一次带回，bootstrap 不再为计数全量下载消息（D3）
    const [threads, counts] = await Promise.all([
      this.prisma.agentThread.findMany({
        where: { sessionId }, // 不得过滤 archivedAt（Task 4 守卫：归档行透出供 H0-c 禁用态）
        orderBy: { updatedAt: 'desc' },
        take: 50,
      }),
      this.prisma.agentMessage.groupBy({
        by: ['threadId'],
        where: { sessionId },
        _count: { _all: true },
      }),
    ])
    const countByThread = new Map(counts.map((c) => [c.threadId, c._count._all]))
    return threads.map((t) => ({ ...t, messageCount: countByThread.get(t.id) ?? 0 }))
  }
```

`AgentSideRail.vue`：

- `interface AgentThreadRow`（:156）加 `messageCount?: number`；
- `fetchThreads` 失败分支 `catch { return [] }` 改为：

```ts
  } catch {
    return null // fail-open（K3/D3）：null ≠ 空数组，bootstrap 不得清 fork key（H0-d 重试卡兜底展示）
  }
```

（成功路径 `if (!res.ok) return null` 同步加上；返回类型改 `Promise<AgentThreadRow[] | null>`，`threads.value = rows ?? threads.value`。）

- bootstrap 调用点（:1665-1684）整体替换为：

```ts
  const list = await fetchThreads()
  threads.value = list ?? threads.value
  agentThreadId.value = await resolveBootstrapThreadId(props.sessionId, { threads: list })
```

（原 `messageCountFor` 内联实现整块删除。）

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `cd apps/web && npx vitest run src/components/agent/streamRecovery.test.ts src/components/agent/AgentSideRail.forkKeyWiring.test.ts src/components/agent/AgentSideRail.historyFetchNoStore.test.ts --maxWorkers=1 --no-file-parallelism && NODE_OPTIONS=--max-old-space-size=3072 npx vue-tsc -b`
Expected: PASS + tsc 绿

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/agent.service.ts apps/web/src/components/agent/streamRecovery.ts apps/web/src/components/agent/streamRecovery.test.ts apps/web/src/components/agent/AgentSideRail.vue
git commit -m "feat(agent): threads 响应带 messageCount，bootstrap 计数轻量化+fail-open（规格 H1-b / D3/D4）"
```

---

### Task 10: H1-c thread-state 死端点退役

**Files:**
- Modify: `apps/server/src/agent/agent.controller.ts`（删 `@Get('thread-state')` :375 起；W27 phase-state :384 本包不动）
- Modify: `apps/web/src/components/agent/streamRecovery.ts`（删 `fetchThreadStateSafe` :53-66、`ThreadStateRead` 类型；`shouldKeepReconciling` 调用方改传 `null`）
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（删 :1892 与 :3171 两处调用及死分支）
- Test: `apps/web/src/components/agent/streamRecovery.test.ts`（改写）、`apps/web/src/components/agent/AgentSideRail.historyFetchNoStore.test.ts`（保持绿）

**Interfaces:**
- 删除: `fetchThreadStateSafe` / `ThreadStateRead`（streamRecovery 导出面收窄）
- 保留: `shouldKeepReconciling(null, polls)` 语义不变（thread-state 恒 null 下生产行为本就是「轮到上限」）

- [ ] **Step 1: 先全域 grep 复验（规格 §11：C 级证据实施前必复验）**

Run: `grep -rn "agent/thread-state\|fetchThreadStateSafe\|ThreadStateRead" apps/web/src apps/server/src services packages --include='*.ts' --include='*.vue' | grep -v test`
Expected: 仅本任务点名的 3 处消费 + 定义。若出现额外消费方，**停下扩规格**，不得顺手删。

- [ ] **Step 2: 改写测试**

`streamRecovery.test.ts`：删 `fetchThreadStateSafe` 用例，替换为：

```ts
it('fetchThreadStateSafe 已退役（H1-c：死端点清除，D20 不许半死）', async () => {
  const mod = (await import('./streamRecovery')) as Record<string, unknown>
  expect(mod.fetchThreadStateSafe).toBeUndefined()
})
```

`AgentSideRail.historyFetchNoStore.test.ts`：如其中断言引用了 `fetchThreadStateSafe` 文本，改为断言 `reconcileLatestAssistant` 的 no-store（同文件既有第 2 处）；断言数量不减。

- [ ] **Step 3: 实现**

- `streamRecovery.ts`：删 `fetchThreadStateSafe`、`ThreadStateRead`；文件头注释补一行「thread-state 已随 H1-c 退役（规格 2026-10-28 §5.2）」。
- `AgentSideRail.vue`：
  - :1880 起 `refreshThreadCheckpoint`：删除 thread-state fetch 分支，调用 `shouldKeepReconciling(null, polls)`（行为与恒 null 生产现状一致），保留注释「终态判定待 H3 seq 游标窗重接 turnState（规格 §12）」；
  - :3171 处 `reconcileLatestAssistant` 内的 thread-state 请求与 null 判定分支删除（「只同步运行已停止」的现状分支保留）。
- `agent.controller.ts`：删 `@Get('thread-state')` 处理器及其 service 方法（`getThreadState`，若仅此端点消费）。

- [ ] **Step 4: 全域验证 + 测试**

Run: `grep -rn "agent/thread-state\|fetchThreadStateSafe" apps/web/src apps/server/src --include='*.ts' --include='*.vue' | grep -v '\.test\.' ; cd apps/web && npx vitest run src/components/agent/streamRecovery.test.ts src/components/agent/AgentSideRail.historyFetchNoStore.test.ts src/components/agent/AgentSideRail.forkKeyWiring.test.ts --maxWorkers=1 --no-file-parallelism && NODE_OPTIONS=--max-old-space-size=3072 npx vue-tsc -b`
Expected: grep 零命中（验收 S7）；测试 PASS；tsc 绿

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/agent.controller.ts apps/web/src/components/agent/streamRecovery.ts apps/web/src/components/agent/AgentSideRail.vue apps/web/src/components/agent/streamRecovery.test.ts
git commit -m "refactor(agent): 退役 thread-state 死端点与 3 处消费（规格 H1-c / D20，不许半死）"
```

---

### Task 11: H1-d 加载期 sanitize

**Files:**
- Create: `apps/web/src/components/agent/historySanitize.ts`
- Create: `apps/web/src/components/agent/historySanitize.test.ts`
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（`loadHistory` 消费）

**Interfaces:**
- Produces: `sanitizeHistoryMessages<T extends HistoryRow>(rows): { rows, degradedIds: Set<string>, droppedEmptyAssistant: number, lastRenderableAssistantIndex: number }`
- Consumes: `isMachineOnlyVisibleText`（agentInterruptGate，K4 清单经 Task 12 收敛到 shared 后仍经其中转，本任务不改 import）

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/components/agent/historySanitize.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sanitizeHistoryMessages } from './historySanitize'

const row = (over: Partial<{ id: string; role: string; content: string; metadata: string | null }>) => ({
  id: 'm',
  role: 'assistant',
  content: '正文',
  metadata: null,
  ...over,
})

describe('sanitizeHistoryMessages（规格 H1-d / §8 / 验收 S8）', () => {
  it('metadata 损坏 ⇒ 行保留并列入 degradedIds（D15：与「本来就没有过程」可区分）', () => {
    const r = row({ id: 'm1', metadata: '{oops' })
    const s = sanitizeHistoryMessages([r])
    expect(s.rows).toHaveLength(1)
    expect(s.degradedIds.has('m1')).toBe(true)
  })
  it('空 assistant 行（无正文无 metadata）⇒ 剔除并计数（D16：不干扰任务卡恢复定位）', () => {
    const s = sanitizeHistoryMessages([row({ id: 'm1', content: '' })])
    expect(s.rows).toHaveLength(0)
    expect(s.droppedEmptyAssistant).toBe(1)
  })
  it('纯机器载荷 user 行（__new_task__）⇒ 剔除（K4；DB 原文不动，回合分类不受影响）', () => {
    const s = sanitizeHistoryMessages([
      row({ id: 'm1', role: 'user', content: '__new_task__' }),
      row({ id: 'm2', role: 'user', content: '帮我把这张图改成夜景' }),
    ])
    expect(s.rows.map((r) => r.id)).toEqual(['m2'])
  })
  it('恢复定位取最后一条非空 assistant（D16/D17）', () => {
    const s = sanitizeHistoryMessages([
      row({ id: 'm1', role: 'user', content: 'q' }),
      row({ id: 'm2', role: 'assistant', content: '' }),
      row({ id: 'm3', role: 'assistant', content: '完成' }),
    ])
    expect(s.lastRenderableAssistantIndex).toBe(2)
  })
  it('全畸形输入得空结果而非抛错（Review Focus #4）', () => {
    const s = sanitizeHistoryMessages([
      row({ id: 'm1', content: '', metadata: '{oops' }),
      row({ id: 'm2', content: '' }),
    ])
    expect(s.rows).toHaveLength(0)
    expect(s.lastRenderableAssistantIndex).toBe(-1)
  })

  it('AgentSideRail 恢复锚点消费非空 assistant（§8④ 消费点：防空行 metadata 污染任务卡恢复）', () => {
    const rail = readFileSync(fileURLToPath(new URL('./AgentSideRail.vue', import.meta.url)), 'utf8')
    expect(rail).toContain("find((m) => m.role === 'assistant' && m.content?.trim())")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/agent/historySanitize.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// apps/web/src/components/agent/historySanitize.ts
import { isMachineOnlyVisibleText } from '@/components/agent/agentInterruptGate'

/**
 * H1-d（规格 §2/§8，Claude Code「加载期 sanitize 防崩溃」实践）：
 * 历史消息进入渲染前的统一净化边界。畸形输入在此被消化成显式降级信号，
 * 而不是静默丢行或把渲染层炸成白屏（D15/D16/D17）。
 *
 * 只净化渲染视图：DB 原文不动（__new_task__ 是服务端回合分类输入，规格 §2 明确不做写路径清洗）。
 */
export interface HistoryRow {
  id: string
  role: string
  content: string
  metadata?: string | null
}

export interface SanitizeResult<T extends HistoryRow> {
  rows: T[]
  /** metadata 损坏但正文保留的行（渲染层据此标注「过程数据缺失」） */
  degradedIds: Set<string>
  /** 被剔除的空 assistant 行数（无正文且无任何 metadata） */
  droppedEmptyAssistant: number
  /** 渲染序列里最后一条非空 assistant 的下标（任务卡/恢复定位用），无则 -1 */
  lastRenderableAssistantIndex: number
}

function isParsableJson(s: string): boolean {
  try {
    JSON.parse(s)
    return true
  } catch {
    return false
  }
}

export function sanitizeHistoryMessages<T extends HistoryRow>(input: readonly T[]): SanitizeResult<T> {
  const rows: T[] = []
  const degradedIds = new Set<string>()
  let droppedEmptyAssistant = 0
  for (const r of input) {
    const contentEmpty = !r.content?.trim()
    const metaBroken = r.metadata != null && !isParsableJson(r.metadata)
    if (r.role === 'user' && !contentEmpty && isMachineOnlyVisibleText(r.content)) {
      continue // K4：纯机器载荷 user 行不进渲染序列
    }
    if (r.role === 'assistant' && contentEmpty && (r.metadata == null || r.metadata === '')) {
      droppedEmptyAssistant++ // D16：空 assistant 行剔除，恢复定位不受干扰
      continue
    }
    if (r.role === 'assistant' && metaBroken) {
      degradedIds.add(r.id) // D15：行保留（正文可能有效），降级显式化
    }
    rows.push(r)
  }
  let lastRenderableAssistantIndex = -1
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.role === 'assistant' && rows[i]!.content?.trim()) lastRenderableAssistantIndex = i
  }
  return { rows, degradedIds, droppedEmptyAssistant, lastRenderableAssistantIndex }
}
```

`AgentSideRail.vue` 的 `loadHistory`：`const json = await res.json()` 与分页字段之后，把 `agent.loadHistory(historyRows.value)` 改为：

```ts
    // H1-d（规格 §2）：渲染前净化；hasUserAfter 仍读原始 msgs（机器载荷 user 行也算「之后有用户」，防重复弹卡）
    const sanitized = sanitizeHistoryMessages(historyRows.value)
    degradedHistory.value = sanitized.degradedIds.size > 0
    agent.loadHistory(sanitized.rows)
```

（script 区加 `const degradedHistory = ref(false)`。）

**恢复锚点修正（规格 §2 H1-d / §8④ 的消费点，实代码 `loadHistory` 内）**——空 assistant 行的 metadata 会污染任务卡 seeding（2026-10-28 生产案例即空 assistant 行），两处锚点改为非空 assistant：

`old_string`：

```ts
      const lastAssistantMsg = [...msgs].reverse().find((m) => m.role === 'assistant')
```

`new_string`：

```ts
      // H1-d（§8④）：恢复锚点 = 最后一条非空 assistant（空行 metadata 会污染任务卡/ask_user 恢复）
      const lastAssistantMsg = [...msgs].reverse().find((m) => m.role === 'assistant' && m.content?.trim())
```

`old_string`：

```ts
      const lastAssistantIdx = msgs.map((m) => m.role).lastIndexOf('assistant')
```

`new_string`：

```ts
      let lastAssistantIdx = -1
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]!.role === 'assistant' && msgs[i]!.content?.trim()) {
          lastAssistantIdx = i
          break
        }
      }
```

（`hasUserAfter = msgs.slice(lastAssistantIdx + 1).some(...)` 逻辑不动：机器载荷/空行 user 仍计入「之后有用户」，防止已答 ask 卡重复弹出。`lastRenderableAssistantIndex` 保留在 sanitize 返回值中作为纯函数判据，组件内以上述原始下标扫描等价实现——两者必须一致，由下方静态断言钉住消费点。）

模板（消息区顶部，Task 6 重试卡旁）：

```html
<p v-if="degradedHistory" class="mx-3 my-1 text-xs" :style="{ color: 'var(--lnk-text-muted)' }">部分历史行的过程数据缺失，已降级显示</p>
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `cd apps/web && npx vitest run src/components/agent/historySanitize.test.ts src/components/agent/bubbleVisibility.test.ts src/components/agent/agentInterruptGate.test.ts --maxWorkers=1 --no-file-parallelism && NODE_OPTIONS=--max-old-space-size=3072 npx vue-tsc -b`
Expected: PASS + tsc 绿

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agent/historySanitize.ts apps/web/src/components/agent/historySanitize.test.ts apps/web/src/components/agent/AgentSideRail.vue
git commit -m "feat(agent): 历史加载期 sanitize——畸形 metadata 降级/空行剔除/恢复定位修正（规格 H1-d）"
```

---

### Task 12: H1-e 机器载荷清单 shared 单源

**Files:**
- Create: `packages/shared/src/machinePayloads.ts`
- Create: `packages/shared/src/machinePayloads.test.ts`
- Modify: `packages/shared/src/index.ts`（追加导出）
- Modify: `apps/web/src/components/agent/agentInterruptGate.ts`（:47 清单改 import）

**Interfaces:**
- Produces: `MACHINE_PAYLOAD_PREFIXES`、`lineHasMachinePayload(line)`（shared 导出）
- Consumes: 无

- [ ] **Step 1: 写失败测试**

```ts
// packages/shared/src/machinePayloads.test.ts
import { describe, expect, it } from 'vitest'
import { MACHINE_PAYLOAD_PREFIXES, lineHasMachinePayload } from './machinePayloads'

describe('machinePayloads（K4：机器载荷清单单一来源）', () => {
  it('清单含 __new_task__（回合分类输入，mid-run-interrupt UAT-INT-PV-03 依赖）', () => {
    expect(MACHINE_PAYLOAD_PREFIXES).toContain('__new_task__')
  })
  it('lineHasMachinePayload 判定与迁移前一致（含引号剥离与缩进容忍）', () => {
    expect(lineHasMachinePayload('__new_task__')).toBe(true)
    expect(lineHasMachinePayload('  "__scheme_decision__{...}"')).toBe(true)
    expect(lineHasMachinePayload('帮我把这张图改成夜景')).toBe(false)
    expect(lineHasMachinePayload('__unknown_marker__')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/shared && npx vitest run src/machinePayloads.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// packages/shared/src/machinePayloads.ts
/**
 * K4（规格 2026-10-28 §4）：机器载荷清单**单一来源**。
 *
 * 历史对话里用户气泡可能整段是这些载荷（旧版方案/交付确认按钮、发起新任务 chip 发出），
 * 渲染面必须过滤；此前清单散在 web 组件内（agentInterruptGate），任何新消费方
 * （过滤、可见性、测试）一律 import 本模块，禁止再复制字面量。
 *
 * ⚠️ 只用于**读/渲染面**过滤：服务端写路径不得清洗（`__new_task__` 是回合分类输入，
 * mid-run-interrupt 规格 UAT-INT-PV-03 依赖）。
 */
export const MACHINE_PAYLOAD_PREFIXES = [
  '__scheme_decision__',
  '__macro_scheme_decision__',
  '__delivery_decision__',
  '__new_task__',
] as const

export function lineHasMachinePayload(line: string): boolean {
  const trimmed = line.trimStart().replace(/^["']+|["']+$/g, '')
  return MACHINE_PAYLOAD_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}
```

`packages/shared/src/index.ts` 追加 `export * from './machinePayloads'`。

`agentInterruptGate.ts`：删除本地 `MACHINE_PAYLOAD_PREFIXES` 常量与 `lineHasMachinePayload`，改：

```ts
import { lineHasMachinePayload } from '@lnkpi/shared'
export { lineHasMachinePayload }
```

（`filterMachinePayloadLines` 保留在此文件——它是 web 渲染策略，清单才是单源。）

- [ ] **Step 4: 跑测试 + web 侧回归**

Run: `cd packages/shared && npx vitest run src/machinePayloads.test.ts --maxWorkers=1 --no-file-parallelism && cd ../../apps/web && npx vitest run src/components/agent/agentInterruptGate.test.ts src/components/agent/bubbleVisibility.test.ts src/components/agent/historySanitize.test.ts --maxWorkers=1 --no-file-parallelism && NODE_OPTIONS=--max-old-space-size=3072 npx vue-tsc -b`
Expected: 全 PASS + tsc 绿

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/machinePayloads.ts packages/shared/src/machinePayloads.test.ts packages/shared/src/index.ts apps/web/src/components/agent/agentInterruptGate.ts
git commit -m "refactor(shared): 机器载荷清单收敛单源（规格 H1-e / K4，消灭多副本漂移面）"
```

---

## PR 分组建议（对应规格 §2 批次）

| PR | Tasks | 内容 | 依赖 |
|---|---|---|---|
| PR-1 | Task 1 | H0-a 缓存收口 | 无 |
| PR-2 | Task 2-5 | H0-b 归并（expand+migrate+读端）+ H0-c 禁用态 | PR-1（缓存收口先行，归并验收不受 304 干扰） |
| PR-3 | Task 6 | H0-d 重试卡 | 无（可并行） |
| PR-4 | Task 7-8 | H1-a 分页游标（前后端一个 PR，契约成对） | 无 |
| PR-5 | Task 9 | H1-b 轻量计数 | 无（listThreads 改写基于现状；归档行仍透出，遵守 Task 4 守卫） |
| PR-6 | Task 10 | H1-c 死端点退役 | 无 |
| PR-7 | Task 11-12 | H1-d sanitize + H1-e 单源 | 无；两 task 同 PR 因 Task 11 消费 K4 清单 |

## Self-Review 记录

1. **Spec 覆盖**：规格 §2 的 9 项 ↔ Task 1-12 一一对应（H0-a=1、H0-b=2/3/4、H0-c=5、H0-d=6、H1-a=7/8、H1-b=9、H1-c=10、H1-d=11、H1-e=12）；§10.3 S1-S8 各有归属 task；H2/H3 不在本计划（规格 §12）。
2. **占位符扫描**：无 TBD/TODO；所有代码步骤给出完整代码或精确 old/new 锚点；「class/结构按现场保持」仅指 Task 5 模板里既有 class 名保留（非占位）。
3. **类型一致性**：`resolveBootstrapThreadId` 新签名在 Task 9 定义并被 AgentSideRail 调用点对齐；`paginateVisibleRows` 返回 `{page, hasMore, nextCursor}` 与 controller `result.page` 对齐；`sanitizeHistoryMessages` 返回 `degradedIds`（规格 §8① 的 `degraded: true` 以 Set 形式承载，语义等价、避免 store 字段穿管——已在 Task 11 注明）。
4. **Review Focus**：5 条输入各有钉死测试（Task 1 行为测试 / Task 7 畸形游标+同毫秒 / Task 11 全畸形 / Task 9 fail-open）。
5. **审核修订（2026-10-28 晚，生产+源码复核后）**：
   - ① Task 7 同毫秒用例期望修正——游标必须指向页内 desc 序末行（原期望指向页外行 a，若照改实现会同毫秒页边界丢行）；
   - ② Task 11 补恢复锚点消费——原计划「恢复定位保持读原始 msgs」违背规格 §2/§8④；实代码证实空 assistant 行 metadata 会污染任务卡/ask_user 恢复（2026-10-28 生产案例即空 assistant 行），两处锚点改非空 assistant 并加静态断言；
   - ③ Task 4/5/9 谓词解耦——listThreads 由「过滤已归档行」改为**负向契约守卫不过滤**（原设计与 H0-c 禁用态自相矛盾：行被过滤前端无从渲染）；H0-c 禁用谓词 = `archivedAt` 非空（原 `id !== sessionId` 会误杀在役 fork 重跑分支——生产实证 223 条孤儿 id 与 fork 分支同为 `sessionId:后缀` 复合键，且 Phase 1 上线后仍有分支消息写入）；
   - ④ Task 3 校验脚本加 Phase 1 时刻前置断言（`createdAt ≥ 2026-10-26 21:32` 孤儿行数必须为 0，非零 = 疑似活跃 fork 分支，中止转人工）；
   - ⑤ PR 表修正：PR-5 依赖改「无」、PR-7 依赖列笔误清除。
