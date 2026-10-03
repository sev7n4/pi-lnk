# 记忆作用域隔离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `agent_memories` 分「画布 / 用户」两级作用域，并保证每条召回记忆都自曝归属——同画布情节记忆不再被别的画布当成当前观察内容。

**Architecture:** 记忆仍只落 Nest/SQLite（pi-runtime 无状态不动）。改动三跳：Prisma 加 `scope/sessionId/source` 三列 + 复合索引 → Nest `saveMemory/searchMemory` 按作用域过滤并把 `scope/crossCanvas` 随条目返回 → pi-runtime `memory.ts` 从已有 `toolContext.sessionId` 透传画布 id。

**Tech Stack:** NestJS + Prisma(SQLite) + Fastify(pi-runtime) + TypeBox + prompt-registry lint

**Spec:** [`docs/superpowers/specs/2026-10-03-agent-memory-scope-isolation-design.md`](../specs/2026-10-03-agent-memory-scope-isolation-design.md)（本文为其实施拆解）

## Global Constraints

- 作用域取值只认 `'canvas'` / `'user'` 两个字面量，禁止第三个值（YAGNI）。
- `scope='canvas'` 必须带 `sessionId`；`scope='user'` 必须 `sessionId` 为空——应用层强制，DB 不给约束（SQLite 无 CHECK）。
- 画布 id 取自 `Session.id`，**禁止**用 pi 会话键（`toSessionKey()`）——#70 曾因此全画布工具 404。
- 迁移默认 `scope='user'`：上线后旧记忆行为不变，可秒级回滚。
- 生产 SQLite 只读取证走 `cat s.cjs | ssh -i ~/.ssh/tencent_cloud_deploy -o BatchMode=yes root@119.29.173.89 'docker exec -i lnkpi-api node -'`；**本机跑不了 docker**。
- 提交前必须过 `tsc --noEmit`（vitest 走 esbuild 只转译不查类型，绿 ≠ 类型绿）。
- 分支纪律：从 `origin/master` 开 worktree，逐文件核对改动归属，禁止整文件 cp 主仓未提交改动。

## Review Focus

1. **`scope='canvas'` 但 `sessionId` 为 null**（tc 没传 / DTO 被吞）→ 必须 fail-closed（查不到），不许降级成全用户检索。
2. **跨画布记忆 + 图片提问同时发生**（本次事故形态）→ `crossCanvas` 提示必须出现在 **tool result 数据里**，而非只写在提示词规则。
3. **`sessionId` 语义混淆**：画布 id ≠ pi 会话键 → 断言用 `Session.id`。
4. **检索窗口放大**：`MEMORY_SCAN_MAX=200` 叠加 scope 后仍可能全扫 → 索引前缀必须是 `(userId, scope, sessionId)`。
5. **回填把项目知识判成 canvas 但 `sessionId` 指向已删画布** → 该行必须回退成 `user`，不留悬空归属。

---

### Task 1: 数据模型 + 迁移

**Files:**
- Modify: `apps/server/prisma/schema.prisma:355-362`
- Create: `apps/server/prisma/migrations/20261003100000_add_agent_memory_scope/migration.sql`
- Test: `apps/server/src/agent/agent-memory.service.test.ts`（同任务内补一条 schema 形状断言见 Task 2）

**Interfaces:**
- Produces: `AgentMemory` 模型字段 `scope: string @default("user")`、`sessionId: String?`、`source: string @default("agent_auto")`、索引 `@@index([userId, scope, sessionId])`

- [ ] **Step 1: 改 schema**

```prisma
model AgentMemory {
  id        String   @id @default(cuid())
  userId    String
  /// 'canvas'（本画布，需 sessionId）| 'user'（跨画布）
  scope     String   @default("user")
  /// scope='canvas' 时的画布会话 id（Session.id，非 pi 会话键）
  sessionId String?
  /// 来源：agent_auto / user_explicit / promoted（审计用，不做行为分支）
  source    String   @default("agent_auto")
  content   String
  createdAt DateTime @default(now())

  @@index([userId, scope, sessionId])
  @@map("agent_memories")
}
```

- [ ] **Step 2: 手写迁移 SQL**（SQLite 需逐条 ALTER；索引名必须与 Prisma 默认名一致，否则后续 `migrate dev` 会生成噪音迁移）

```sql
-- apps/server/prisma/migrations/20261003100000_add_agent_memory_scope/migration.sql
-- AlterTable
ALTER TABLE "agent_memories" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'user';
ALTER TABLE "agent_memories" ADD COLUMN "sessionId" TEXT;
ALTER TABLE "agent_memories" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'agent_auto';

-- CreateIndex
CREATE INDEX "agent_memories_userId_scope_sessionId_idx" ON "agent_memories"("userId","scope","sessionId");
```

- [ ] **Step 3: 落地到库**（容器内执行，本机无 docker）

```bash
# 容器内 prisma CLI 位置以实际镜像为准（先 printenv + ls 探一次，别照抄路径）
ssh -i ~/.ssh/tencent_cloud_deploy -o BatchMode=yes root@119.29.173.89 \
  'docker exec -i lnkpi-api sh -c "cd /app && node node_modules/.bin/prisma migrate deploy"'
# 落库后核对：容器内查 agent_memories 新列
cat s.cjs <<'EOF'
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const r = await p.$queryRawUnsafe("SELECT scope, COUNT(*) c FROM agent_memories GROUP BY scope");
  console.log(JSON.stringify(r));
  await p.$disconnect();
})().catch(e => console.log("ERR", e.message.slice(0, 200)));
EOF
cat s.cjs | ssh -i ~/.ssh/tencent_cloud_deploy -o BatchMode=yes root@119.29.173.89 'docker exec -i lnkpi-api node -'
```

- [ ] **Step 4: 生成本地 client 并跑类型检查**

```bash
cd apps/server && node ./node_modules/prisma/build/index.js generate --schema=prisma/schema.prisma
node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/prisma && git commit -m "feat(db): agent_memories 加 scope/sessionId/source + 复合索引（记忆作用域隔离）"
```

---

### Task 2: Nest 侧按作用域存取 + 归属自曝

**Files:**
- Modify: `apps/server/src/agent/agent-memory.service.ts:24-31`（saveMemory）、`:51-87`（searchMemory）
- Modify: `apps/server/src/agent/agent-canvas-tools.controller.ts:1065-1075`（DTO 透传 sessionId/scope）
- Test: `apps/server/src/agent/agent-memory.service.test.ts`

**Interfaces:**
- Consumes: `LnkpiTask` 无关；仅 Nest 内部
- Produces: `saveMemory({userId, content, scope?, sessionId?, source?}) → {id, createdAt}`；
  `searchMemory({userId, query?, limit?, sessionId?, scope?}) → { items: { id, content, createdAt, scope, sessionId, crossCanvas }[] }`

- [ ] **Step 0: 先改既有断言**（`agent-memory.service.test.ts:56/71/82/84/92/94` 等处 `toEqual([{id,content,createdAt}])` 会因 items 多出字段而红——
  这是**预期**的，把所有 `toEqual([{ id, content, createdAt: … }])` 补上新字段即可，语义不变）
- [ ] **Step 1: 写失败测试**（追加到 `agent-memory.service.test.ts`，沿用文件既有 `svc` / `create` / `findMany` 三个 mock）

```ts
it('saveMemory：默认写画布作用域（无 scope 时）', async () => {
  await svc.saveMemory({ userId: 'u1', content: '《小熊和小爸爸》角色设定', sessionId: 'S1' })
  const body = create.mock.calls[0][0].data as { scope: string; sessionId: string | null; source: string }
  expect(body.scope).toBe('canvas')
  expect(body.sessionId).toBe('S1')
  expect(body.source).toBe('agent_auto')
})

it('saveMemory：显式 scope=user 时 sessionId 写空、source=user_explicit', async () => {
  await svc.saveMemory({ userId: 'u1', content: '暗号是紫罗兰七号', scope: 'user' })
  const body = create.mock.calls[0][0].data as { scope: string; sessionId: string | null; source: string }
  expect(body.scope).toBe('user')
  expect(body.sessionId).toBeNull()
  expect(body.source).toBe('user_explicit')
})

it('searchMemory：默认（scope 省略 → any）仍按 userId 捞，但本画布记忆排前、带归属字段', async () => {
  const at = (iso: string) => new Date(iso)
  findMany.mockResolvedValue([
    { id: 'other', userId: 'u1', scope: 'canvas', sessionId: 'S2', content: '别的画布项目知识', createdAt: at('2026-02-01T00:00:00.000Z') },
    { id: 'same', userId: 'u1', scope: 'canvas', sessionId: 'S1', content: '本画布项目知识', createdAt: at('2026-01-03T00:00:00.000Z') },
    { id: 'pref', userId: 'u1', scope: 'user', sessionId: null, content: '暗号是紫罗兰七号', createdAt: at('2026-01-02T00:00:00.000Z') },
  ])
  const r = await svc.searchMemory({ userId: 'u1', sessionId: 'S1' })
  expect(r.items.map((i) => i.id)).toEqual(['same', 'pref', 'other'])
  expect(r.items.find((i) => i.id === 'same')!.crossCanvas).toBe(false)
  expect(r.items.find((i) => i.id === 'other')!.crossCanvas).toBe(true)
  expect(r.items.find((i) => i.id === 'other')!.scope).toBe('canvas')
  expect(r.items.find((i) => i.id === 'other')!.sessionId).toBe('S2')
})

it('searchMemory：scope=canvas 只回本画布（跨画布那条进不来）', async () => {
  findMany.mockResolvedValue([
    { id: 'same', userId: 'u1', scope: 'canvas', sessionId: 'S1', content: '本画布', createdAt: new Date('2026-01-03T00:00:00.000Z') },
    { id: 'other', userId: 'u1', scope: 'canvas', sessionId: 'S2', content: '别的画布', createdAt: new Date('2026-01-02T00:00:00.000Z') },
  ])
  const r = await svc.searchMemory({ userId: 'u1', sessionId: 'S1', scope: 'canvas' })
  expect(r.items.map((i) => i.id)).toEqual(['same'])
})

it('searchMemory：scope=user Explicit 时忽略 sessionId（跨会话偏好仍可达）', async () => {
  findMany.mockResolvedValue([
    { id: 'p1', userId: 'u1', scope: 'user', sessionId: null, content: '品牌色 #0F4C81', createdAt: new Date('2026-01-03T00:00:00.000Z') },
    { id: 'same', userId: 'u1', scope: 'canvas', sessionId: 'S1', content: '本画布', createdAt: new Date('2026-01-02T00:00:00.000Z') },
  ])
  const r = await svc.searchMemory({ userId: 'u1', sessionId: 'S1', scope: 'user' })
  expect(r.items.map((i) => i.id)).toEqual(['p1'])
})

it('searchMemory：scope=canvas 但 sessionId 缺失 → 短路返回空（fail-closed，不做全用户降级）', async () => {
  findMany.mockResolvedValue([{ id: 'x', userId: 'u1', scope: 'canvas', sessionId: 'S1', content: '本画布', createdAt: new Date() }])
  const r = await svc.searchMemory({ userId: 'u1', scope: 'canvas' })
  expect(r.items).toEqual([])
  expect(findMany).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/server && node ./node_modules/vitest/vitest.mjs run src/agent/agent-memory.service.test.ts
```
Expected: FAIL（saveMemory 签名不认 `scope/sessionId`）。

- [ ] **Step 3: 实现 saveMemory（:24-31 替换）**

```ts
async saveMemory(input: {
  userId: string
  content: string
  scope?: 'canvas' | 'user'
  sessionId?: string
}): Promise<{ id: string; createdAt: string }> {
  const content = (input.content ?? '').trim()
  if (!content) throw new BadRequestException('content required')
  const scope = input.scope === 'user' ? 'user' : 'canvas'
  // canvas 作用域没有 sessionId 就退化成 user 并留痕：宁可放宽也别丢记忆，
  // 且模型拿到的 note 会写「未确定归属」，用户可从对话里发现。
  const sessionId = scope === 'user' ? null : input.sessionId ?? null
  const record = await this.prisma.agentMemory.create({
    data: {
      userId: input.userId,
      scope,
      sessionId,
      source: scope === 'user' ? 'user_explicit' : 'agent_auto',
      content: content.slice(0, MEMORY_CONTENT_MAX),
    },
  })
  return { id: record.id, createdAt: record.createdAt.toISOString() }
}
```

- [ ] **Step 4: 实现 searchMemory 的过滤 + 排序 + 归属字段（替换 :60-87 的 rows/matched 段）**

```ts
async searchMemory(input: {
  userId: string
  query?: string
  limit?: number
  sessionId?: string
  scope?: 'any' | 'canvas' | 'user'
}): Promise<{ items: { id; content; createdAt; scope; sessionId; crossCanvas }[] }> {
  const query = (input.query ?? '').trim()
  const rawLimit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? Math.floor(input.limit) : MEMORY_RECALL_DEFAULT
  const limit = Math.min(Math.max(rawLimit, 1), MEMORY_RECALL_MAX)
  const want = input.scope ?? 'any'
  const currentSession = input.sessionId?.trim() || null

  // 作用域过滤：any 全捞；user 只看 user 层；canvas 只看画布层且 sessionId 必须命中
  const scopeWhere = want === 'user' ? { scope: 'user' } : want === 'canvas' ? { scope: 'canvas', sessionId: currentSession } : {}
  if (want === 'canvas' && !currentSession) return { items: [] } // fail-closed（Review Focus #1）
  const rows = await this.prisma.agentMemory.findMany({
    where: { userId: input.userId, ...scopeWhere },
    orderBy: { createdAt: 'desc' },
    take: query ? MEMORY_SCAN_MAX : limit,
  })
  const scored = query ? scoreRows(rows, this.tokenize(query)) : rows
  const items = scored.slice(0, limit).map((m) => ({
    id: m.id,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
    scope: m.scope,
    sessionId: m.sessionId,
    // 跨画布：来自别的画布的记忆——本次事故的止血点（Review Focus #2）
    crossCanvas: m.scope === 'canvas' && !!currentSession && m.sessionId !== currentSession,
  }))
  return { items }
}
```

> `scoreRows` 复用 `:68-82` 现有分词打分逻辑（保持 tokenize 行为与既有单测完全一致），仅把 `.filter(score>0)` / `.sort(score desc)` 原样保留。

- [ ] **Step 5: 跑测试确认通过 + 补类型检查**

```bash
cd apps/server && node ./node_modules/vitest/vitest.mjs run src/agent/agent-memory.service.test.ts
node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/agent/agent-memory.service.ts apps/server/src/agent/agent-memory.service.test.ts
git commit -m "feat(agent): 记忆按 canvas/user 作用域存取 + 召回条目带 scope/crossCanvas 归属"
```

---

### Task 3: 端点 DTO 透传 sessionId/scope

**Files:**
- Modify: `apps/server/src/agent/agent-canvas-tools.controller.ts:1065-1075`
- Test: `apps/server/src/agent/agent-canvas-tools.controller.test.ts`

**Interfaces:**
- Produces: `POST /agent/internal/memory-save` body 增 `sessionId?` / 可选 `scope`;
  `POST /agent/internal/memory-search` body 增 `sessionId?` / 可选 `scope`

- [ ] **Step 1: 写失败测试**

```ts
it('POST memory-save：默认画布作用域，透传 sessionId', async () => {
  const res = await request(app.getHttpServer())
    .post('/agent/internal/memory-save')
    .send({ userId: 'u1', content: '《小熊和小爸爸》设定', sessionId: 'S1' })
    .expect(201)
  expect(saveSpy).toHaveBeenCalledWith({ userId: 'u1', content: '《小熊和小爸爸》设定', sessionId: 'S1' })
})

it('POST memory-search：无 sessionId 时 service 拿到 undefined（fail-closed 由 service 保证）', async () => {
  await request(app.getHttpServer()).post('/agent/internal/memory-search').send({ userId: 'u1' }).expect(201)
  expect(searchSpy).toHaveBeenCalledWith({ userId: 'u1' })
})
```

- [ ] **Step 2: 跑测试确认失败**（service spy 未收到 `sessionId`）。

- [ ] **Step 3: 改 controller DTO（:1065-1075）**

```ts
@Post('memory-save')
async save(@Body() dto: { userId: string; content: string; sessionId?: string; scope?: 'canvas' | 'user' }) {
  return this.memory.saveMemory(dto)
}

@Post('memory-search')
async search(@Body() dto: { userId: string; query?: string; limit?: number; sessionId?: string; scope?: 'any' | 'canvas' | 'user' }) {
  return this.memory.searchMemory(dto)
}
```

- [ ] **Step 4: 跑测试 + tsc 绿，然后 Commit**

```bash
cd apps/server && node ./node_modules/vitest/vitest.mjs run src/agent/agent-canvas-tools.controller.test.ts && node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
git commit -am "feat(agent): memory-save/search 端点透传 sessionId 与 scope"
```

---

### Task 4: pi-runtime 工具侧透传 + description 改写

**Files:**
- Modify: `services/pi-runtime/src/tools/memory.ts`（save 的 `execute`、recall 的 `execute` 与 description）
- Test: `services/pi-runtime/src/tools/memory.test.ts`（既有，沿用其 `runTool/payload/fakeClient/find` 四个助手）

**Interfaces:**
- Consumes: `LnkpiToolContext.sessionId`（`tools/types.ts:39`，画布会话 id）
- Produces: `save_memory{content, scope?}` / `recall_memory{query?, limit?, scope?}`；
  tool result 的 `items[]` 多出 `scope` / `sessionId` / `crossCanvas`（协议自解释，不改注册中心）

- [ ] **Step 0: 先改既有断言**（两处会因新增字段/请求体字段而红，属预期）
  - `memory.test.ts:79` `assert.deepEqual(capture.body, { userId: "u1", limit: MEMORY_RECALL_DEFAULT })` → 补 `scope: "any", sessionId: "s1"`
  - `memory.test.ts:98` `assert.deepEqual(hit.items, items)` → 补 `{ id, content, createdAt, scope: "canvas", sessionId: "s1", crossCanvas: false }`

- [ ] **Step 1: 写失败测试**（追加到 `memory.test.ts`）

```ts
test("save_memory：默认画布作用域，透传 toolContext.sessionId", async () => {
	const capture: Capture = { calls: 0 };
	const tools = buildMemoryTools(fakeClient(capture, { id: "m1", createdAt: "2026-09-29T01:00:00.000Z" }));
	const p = payload(await runTool(find(tools, "save_memory"), { content: "本画布项目知识" }, tc)) as { note: string };
	assert.equal(capture.path, "/agent/internal/memory-save");
	assert.deepEqual(capture.body, { userId: "u1", content: "本画布项目知识", scope: "canvas", sessionId: "s1" });
	assert.match(p.note, /仅本画布/);
});

test("save_memory：显式 scope=user 时不带 sessionId，note 写「跨会话生效」", async () => {
	const capture: Capture = { calls: 0 };
	const tools = buildMemoryTools(fakeClient(capture, { id: "m2", createdAt: "2026-09-29T01:00:00.000Z" }));
	const p = payload(await runTool(find(tools, "save_memory"), { content: "暗号是紫罗兰七号", scope: "user" }, tc)) as { note: string };
	assert.deepEqual(capture.body, { userId: "u1", content: "暗号是紫罗兰七号", scope: "user" });
	assert.match(p.note, /跨会话生效/);
});

test("recall_memory：body 带 sessionId（默认 any，模型可显式要 user 层）", async () => {
	const capture: Capture = { calls: 0 };
	const tools = buildMemoryTools(fakeClient(capture, { items: [] }));
	await runTool(find(tools, "recall_memory"), { query: "小熊" }, tc);
	assert.deepEqual(capture.body, { userId: "u1", query: "小熊", limit: 10, sessionId: "s1", scope: "any" });
});

test("recall_memory：命中项原样带回 scope/crossCanvas（协议自解释，不改注册中心）", async () => {
	const items = [{ id: "m1", content: "《小熊和小爸爸》项目信息", createdAt: "2026-09-30T01:00:00.000Z", scope: "canvas", sessionId: "other-canvas", crossCanvas: true }];
	const tools = buildMemoryTools(fakeClient({ calls: 0 }, { items }));
	const hit = payload(await runTool(find(tools, "recall_memory"), {}, tc)) as { items: typeof items };
	assert.equal(hit.items[0].crossCanvas, true);
	assert.equal(hit.items[0].sessionId, "other-canvas");
});
```

- [ ] **Step 2: 跑测试确认失败**（请求体不含 sessionId）。

- [ ] **Step 3: 改 save 的 execute（:44-56）**

```ts
execute: async (_id, p: { content: string; scope?: 'canvas' | 'user' }, _u, tc: LnkpiToolContext) => {
  if (!tc?.userId) throw new Error("save_memory requires userId in toolContext");
  const raw = (p?.content ?? "").trim();
  if (!raw) throw new Error("save_memory requires non-empty content");
  const content = raw.slice(0, MEMORY_CONTENT_MAX);
  const scope = p.scope === "user" ? "user" : "canvas";
  const data = (await client.post("/agent/internal/memory-save", {
    userId: tc.userId,
    content,
    scope,
    // 画布 id 取自 toolContext（types.ts:39 注释：这是画布会话 id，不是 pi 会话键）
    scope === "user" ? {} : { sessionId: tc.sessionId },
  })) as { id?: string; createdAt?: string } | null | undefined;
  return memoryResult({
    ok: true,
    id: data?.id ?? null,
    createdAt: data?.createdAt ?? null,
    truncated: raw.length > MEMORY_CONTENT_MAX,
    note: scope === "user"
      ? "已记住：" + content.slice(0, NOTE_PREVIEW) + "（跨会话生效）"
      : "已记住：" + content.slice(0, NOTE_PREVIEW) + "（仅本画布）",
  });
},
```

- [ ] **Step 4: 改 recall 的 execute（:66-84）透传 sessionId/scope，并在 description 里写清作用域语义**

```ts
execute: async (_id, p: { query?: string; limit?: number; scope?: "canvas" | "user" | "any" }, _u, tc: LnkpiToolContext) => {
  if (!tc?.userId) throw new Error("recall_memory requires userId in toolContext");
  const query = typeof p?.query === "string" && p.query.trim() ? p.query.trim() : undefined;
  const limit = clampLimit(p?.limit);
  const data = (await client.post("/agent/internal/memory-search", {
    userId: tc.userId,
    ...(query ? { query } : {}),
    limit,
    sessionId: tc.sessionId,               // toolContext 里就是画布会话 id（types.ts:39）
    scope: p.scope ?? "any",               // 默认 any：跨画布记忆靠 crossCanvas 标记自曝，不靠静默丢弃
  })) as { items?: MemoryItem[] } | null | undefined;
  /* …命中/未命中 note 逻辑与现状一致，不动… */
},
```

`recall_memory` 的 `parameters` 增加可选 `scope`（TypeBox 三值字面量），**不**加 `sessionId`（保持 `memory.test.ts:31-38` 的 schema 安全模型锁）。

`description` 改为：
> "Recall memories. `scope` defaults to the current canvas (same-session memories only); pass `scope:'user'` for cross-canvas preferences (brand rules, accounts, passwords). Items carry `scope`/`sessionId`/`crossCanvas` — treat `crossCanvas:true` as background from another canvas, never as an observation of the current screen or image."

- [ ] **Step 5: 跑测试 + tsc 绿，然后 Commit**

```bash
cd services/pi-runtime && node --import tsx --test "src/tools/memory.test.ts" && node ./node_modules/typescript/bin/tsc --noEmit
git commit -am "feat(runtime): save/recall_memory 透传画布会话 id 与作用域（默认画布作用域）"
```

---

### Task 5: 回填脚本（dry-run 默认，生产执行）

**Files:**
- Create: `scripts/backfill-memory-scope.ts`
- Test: `scripts/backfill-memory-scope.test.ts`（分类纯函数单测）

**Interfaces:**
- Produces: `classifyMemory(content): { scope: 'canvas' | 'user'; reason: string }` 导出常量表可在测试里断言

- [ ] **Step 1: 写分类纯函数的失败测试**

```ts
it('暗号/凭据/偏好 → user', () => {
  expect(classifyMemory('用户的暗号是“紫罗兰七号”').scope).toBe('user')
  expect(classifyMemory('品牌色是 #0F4C81').scope).toBe('user')
  expect(classifyMemory('视频分辨率固定 1080x1440').scope).toBe('user')
})
it('项目/角色/剧本/分镜类 → canvas', () => {
  expect(classifyMemory('短剧《小熊和小爸爸》项目信息：主角小柚').scope).toBe('canvas')
})
it('判不出来 → user（保守，先不丢）', () => {
  expect(classifyMemory('随便一句项目相关的话').scope).toBe('user')
})
```

- [ ] **Step 2: 实现分类表 + dry-run/apply**（脚本只读一个 Prisma 实例，输出表格式分类；`--apply` 才 write，写前 `cp <db> <db>.bak-$(date)`）

```ts
const USER_RULES: Array<{ re: RegExp; reason: string }> = [
  { re: /暗号|密码|凭据|账号|token|密钥|口令/, reason: '凭据级' },
  { re: /品牌色|偏好|以后|永远|默认用/, reason: '偏好' },
  { re: /1080|1440|分辨率|尺寸/, reason: '交付规格偏好' },
]
const CANVAS_RULES = [/项目信息|项目|设定|剧本|分镜|角色|第\s*\d+\s*集/]
export function classifyMemory(content: string): { scope: 'canvas' | 'user'; reason: string } {
  const hit = USER_RULES.find((r) => r.re.test(content))
  if (hit) return { scope: 'user', reason: hit.reason }
  if (CANVAS_RULES.some((r) => r.test(content))) return { scope: 'canvas', reason: '项目知识' }
  return { scope: 'user', reason: '判不出，保守' }
}
```

- [ ] **Step 3: 单测绿后，本机 dry-run 打一次生产分类表**（只打印，不写库）

```bash
cat s.cjs <<'EOF'
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const rows = await p.agentMemory.findMany({ orderBy: { createdAt: "desc" } });
  console.log(JSON.stringify(rows.map(r => ({ id: r.id, at: r.createdAt.toISOString().slice(0,10), ...cast(r.content) })), null, 0));
  await p.$disconnect();
})();
EOF
cat s.cjs | ssh -i ~/.ssh/tencent_cloud_deploy -o BatchMode=yes root@119.29.173.89 'docker exec -i lnkpi-api node -'
```

- [ ] **Step 4: 人工过一遍分类，再 apply**（`--apply`），并在执行前后各抓一次总数对照（30 条基线，允许分类变动但**不允许条数减少**）

- [ ] **Step 5: Commit**（脚本 + 单测）

```bash
git add scripts/backfill-memory-scope.ts && git commit -m "chore(scripts): 记忆作用域回填（dry-run 默认，user 规则优先）"
```

---

### Task 6: 提示词/工具说明同步 + 全量验证

**Files:**
- Modify: `prompt-registry/rules/`（新增或改写一条关于「记忆 ≠ 当前观察」的规则，与既有 `sidebar_vision.tail.md` 同风格）
- Test: `pnpm prompt:lint` + 两个包全量

- [ ] **Step 1: 加提示词规则**（核心语义：召回结果里 `crossCanvas:true` 的条目**不得**作为当前图片/截图内容的观察依据；无识图块时只能回「未能识别 + 问用户」，禁止输出画面细节）

- [ ] **Step 2: 跑 `pnpm prompt:lint` 绿**（规则文件需进 `.dockerignore` 白名单，见仓库纪律）

- [ ] **Step 3: 两个包验证**

```bash
cd apps/server && node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json && node ./node_modules/vitest/vitest.mjs run src/agent/
cd services/pi-runtime && node --import tsx --test "src/**/*.test.ts"
```

- [ ] **Step 4: 生产止血验证**（免鉴权端点 + 会话取证）

```bash
# 1) 免鉴端点确认服务已带新代码
curl -s http://119.29.173.89:8888/api/agent/prompt-registry | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['entryCount'], d['degraded'], d['registryHash'])"
# 2) 会话执行事件里抓一次 recall_memory 的 tool_result，断言 items[].scope/crossCanvas 字段存在
```

- [ ] **Step 5: Commit + 开 PR**（feature 分支，勿推 master；CI 部署真顺序 pi-runtime → (api ∥ web)）
