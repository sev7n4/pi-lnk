# 实施计划 · Phase 1 记忆配额驱逐 + 召回预算（A + E）

- **类型**：`feat(memory)`
- **基线 spec**：`docs/superpowers/specs/2026-10-08-pilnk-memory-product-adoption-scope.md`（PR #289 已合并）
- **范围**：spec §6 Phase 1 —— 开发项 **A（配额/驱逐）** + **E（召回 token 预算硬截）**
- **前置纪律**：独立 worktree `feat/pilnk-memory-phase1-quota`（基于 origin/master，不碰 master）；走 PR + CI 全绿后 squash 合并。
- **非目标**：不引入 schema migration、不做 B（策展蒸馏）/ C（去重）/ D（冲突）/ F（生命周期）；不改动作用域语义与 fail-closed 行为。

---

## 1. 目标

把 WorkBuddy 原则 P2（配额硬限）落到产品侧 `AgentMemory`，解决 spec §3 标注的**最大缺口**：
`content` 无上限、召回最多 200 条无 token 预算 → 记忆直接淹没模型上下文。

- **A 配额/驱逐**：给 `saveMemory` 加 per-(userId, scope) 的**条数配额**，超限时按 LRU（createdAt 最旧）驱逐，防单用户记忆无限膨胀。
- **E 召回预算硬截**：`searchMemory` 返回按 tier 排序后，累计字符预算即截断，返回 `truncated` 标记；pi-runtime 侧透传给模型（延续"对用户可见"透明度判据）。

## 2. 关键设计决策（拍板依据）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 配额维度 | **per-(userId, scope) 条数**，非全局、非 token 总量 | user 档（跨画布偏好，少而精）与 canvas 档（情节，多）增长特性不同；条数配额零 schema 改动、可观测、易测。token 总量配额需新增 `tokenCount` 字段（schema 改动 + 估算），列入 Phase 2 评估。 |
| 配额默认值 | `MEMORY_QUOTA_CANVAS = 500`、`MEMORY_QUOTA_USER = 100` | canvas 档情节多给高配额；user 档偏好少，100 足够且防偏好被情节挤占。均为常量，后续可下沉配置。 |
| 超额处置 | **LRU 驱逐最旧**（silent eviction），非拒绝写入 | 记忆不能丢；驱逐最旧非 user 凭据类（本阶段不区分凭据，统一 LRU）最稳妥。拒绝写会让 agent 自动记忆失败，风险更高。 |
| 驱逐原子性 | **软约束（非事务）**：count → findMany(asc) → deleteMany → create 各自独立 | 配额是防膨胀的"护栏"而非硬锁；并发下短暂超一点可接受（类比 WB L3 注入截断的被动约束）。fail-soft：驱逐异常只记日志，不阻断写入。 |
| 召回预算单位 | **字符预算** `MEMORY_RECALL_CHAR_BUDGET = 6000`（近似 token） | 产品侧无 tokenizer；中文 1 字 ≈ 1–2 token，6000 字符 ≈ 1500–2000 token 量级，足以覆盖正常召回、硬截长尾。命名带 CHAR 明示是近似，后续可替换为 tokenizer。 |
| 预算截断位置 | tier 排序 + `slice(limit)` **之后**，再按字符预算截 | 保证高相关（本画布优先）条目先在前列；预算只砍低相关尾部，不降相关度（spec E 非目标）。 |
| 截断可见性 | Nest 返回 `truncated`，pi-runtime `recall_memory` **透传** `truncated` 给模型 | spec E 要求"返回 truncated + 剩余计数 hint"，延续产品侧"对用户可见"透明度传统。 |

## 3. 改动清单

| 文件 | 改动 |
|---|---|
| `apps/server/src/agent/agent-memory.service.ts` | ① 新增常量 `MEMORY_QUOTA_CANVAS` / `MEMORY_QUOTA_USER` / `MEMORY_RECALL_CHAR_BUDGET`；② `saveMemory` 写前调 `evictIfOverQuota`（fail-soft）；③ 新增 `private evictIfOverQuota()`；④ `searchMemory` 返回类型加 `truncated`，items 组装后按字符预算截断。 |
| `apps/server/src/agent/agent-memory.service.test.ts` | ① mock 注入 `count` / `deleteMany`；② 新增 A 配额驱逐用例（超额触发删最旧、fail-soft 不阻断）；③ 新增 E 预算截断用例（超预算 `truncated:true`、高相关项仍在前列）。 |
| `services/pi-runtime/src/tools/memory.ts` | `recall_memory` 透传 `data.truncated` 到工具返回体（条件展开，无 truncated 时不加，向后兼容）。 |
| `services/pi-runtime/src/tools/memory.test.ts` | 可选：新增 truncated 透传用例（mock 返回带 `truncated:true` 验证透传）。 |

> Schema **无改动**（纯运行时 count + 常量），故无 migration，部署风险低。

## 4. 实现细节（代码示意）

### 4.1 `agent-memory.service.ts`

```ts
// 配额（per scope 条数上限；token 总量配额待 Phase 2 评估加字段）
export const MEMORY_QUOTA_CANVAS = 500
export const MEMORY_QUOTA_USER = 100
// 召回字符预算（近似 token 预算，零依赖；6000 字 ≈ 1500–2000 token 量级）
export const MEMORY_RECALL_CHAR_BUDGET = 6000
```

`saveMemory` 写前驱逐（fail-soft）：
```ts
const scope: AgentMemoryScope = /* 既有不变式 */
const quota = scope === 'user' ? MEMORY_QUOTA_USER : MEMORY_QUOTA_CANVAS
await this.evictIfOverQuota(input.userId, scope, quota)
const record = await this.prisma.agentMemory.create({ /* 既有 */ })
```

```ts
/** A：超配额时按 LRU 驱逐最旧超额部分；失败不阻断写入（软约束 + fail-soft）。 */
private async evictIfOverQuota(userId: string, scope: AgentMemoryScope, quota: number): Promise<void> {
  try {
    const count = await this.prisma.agentMemory.count({ where: { userId, scope } })
    const excess = count + 1 - quota
    if (excess <= 0) return
    const oldest = await this.prisma.agentMemory.findMany({
      where: { userId, scope },
      orderBy: { createdAt: 'asc' },
      take: excess,
      select: { id: true },
    })
    if (oldest.length) {
      await this.prisma.agentMemory.deleteMany({ where: { id: { in: oldest.map((o) => o.id) } } })
    }
  } catch {
    // 驱逐是护栏不是硬锁：异常时宁可不驱逐也不让 save 失败
  }
}
```

`searchMemory` 召回预算硬截：
```ts
const limited = matched
  .map((m, i) => ({ m, i }))
  .sort((a, b) => tier(a.m, currentSession) - tier(b.m, currentSession) || a.i - b.i)
  .slice(0, limit)

// E：召回字符预算硬截（截断低相关尾部，不降相关度）
let used = 0
let truncated = false
const budgeted: typeof limited = []
for (const entry of limited) {
  const len = entry.m.content.length
  if (budgeted.length > 0 && used + len > MEMORY_RECALL_CHAR_BUDGET) {
    truncated = true
    break
  }
  budgeted.push(entry)
  used += len
}
const items = budgeted.map(({ m }) => ({ /* 既有字段 + crossCanvas */ }))
return { items, truncated }
```

返回类型：`Promise<{ items: AgentMemoryItem[]; truncated: boolean }>`。

### 4.2 `services/pi-runtime/src/tools/memory.ts`

```ts
const data = (await client.post("/agent/internal/memory-search", { /* 既有 */ })) as
  { items?: MemoryItem[]; truncated?: boolean } | null | undefined;
const items = Array.isArray(data?.items) ? data.items : [];
const kept = dropSuppressed(items);
// ... 既有 crossCanvas / note 逻辑 ...
return memoryResult({
  ok: true,
  count: kept.length,
  items: kept,
  ...(data?.truncated ? { truncated: true } : {}),   // E：截断对用户可见
  ...(crossCanvas.length ? { crossCanvasCount: crossCanvas.length, notice: CROSS_CANVAS_NOTICE } : {}),
  ...(note ? { note } : {}),
});
```

## 5. 测试策略

- **A（G1）**：mock `count` 返回已超配额 → 断言 `deleteMany` 以"最旧 excess 条 id"被调用；失败路径（count 抛错）→ 断言 `create` 仍执行（fail-soft）。
- **E（G5）**：注入 50 条各 200 字记忆（总 10000 字 > 6000 预算）→ 断言返回 `truncated:true` 且 `items.length` 被截到预算内；高相关（tier 0 本画布）条目仍在 `items[0]`。
- **回归**：既有 save/search/scope/promotion/suppress 用例结构不变（仅返回体新增 `truncated` 字段，现有 `out.items` 断言不受影响），全绿。

## 6. 验收映射

| spec 验收 | 本计划落地 |
|---|---|
| G1（A）：超配额触发驱逐；配置项存在可覆盖 | `evictIfOverQuota` + 常量 `MEMORY_QUOTA_*`；单测锁驱逐行为 |
| G5（E）：200 条长记忆召回 ≤ 预算且 `truncated:true`；高相关仍前列 | `MEMORY_RECALL_CHAR_BUDGET` 截断 + pi-runtime 透传；单测锁 |

## 7. 风险与开放问题

- **软约束竞态**：并发写入可能短暂超过配额（非事务）。护栏目的已达，不引入分布式锁；若上线后观察到严重超额，Phase 2 评估 DB 层唯一约束或定时清理。
- **字符≈token 近似**：中文场景近似合理；若接入 tokenizer 可换精确值。预算常量 6000 为经验起点，上线后按真实召回体积调参。
- **驱逐不区分凭据类**：本阶段统一 LRU；spec A 提到"最旧非 user 凭据类"，因无凭据字段标记，留待 B（curated 层）或 Phase 2 细化。
- **无 migration**：纯运行时逻辑，回滚只需还原代码，零数据迁移风险。
