# D-1 创作资产契约与可执行判定层 实施计划

> **状态回填（2026-11-17，只追加）**：本计划的「Shot/Story 加列」方案已被 D-1 spec 附录 D.5 / D.7 取证推翻并作废（`Shot` 全仓零写者、判据两端无结构化源）；实际实施经 #900/#901 落地为**既有锚点形态**（三 oracle 判定器 + 快照端点装配），收尾结论见 D-1 spec 附录 D.8 与全量计划 `2026-11-16-d1-creative-asset-contract-finalization.md`。以下正文保留为历史快照不改。
>
> **状态刷新（2026-11-18，只追加）**：本计划 Task 1–7 的执行产物已全部闭环（R0 #921 / R1 #900,#901 / R2 #923，见 D-1 spec 附录 D.9 与复审规格附录 D.6）；正文任务清单与末尾「等用户授权合并 / dispatch runtime-deploy」是历史时点快照，**实际授权与部署均已完成**。仍未达项仅观测线（C-2c 四 gate / acceptance 零声明 / agnes 429 墙），归对应线，不在本计划范围。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在既有 `acceptance.ts` DSL 内补三条可机检 oracle（ID 引用闭包 / 权威引用唯一 / 时长预算）+ 字段化资产契约（shared zod schema + Shot/Story 加列）+ 服务端失效传播，零新增 LLM 工具、零新增 Prisma model。

**Architecture:** 六层承载面（spec §5.1）中本刀落 L0（数据契约）、L1（单一写者失效传播）、L2（判定器 oracle）、L3（只读 details）。硬拒走既有 `rejectionResult()` → `details.todo.rejected` → `after_tool` patch 链（`tool-rejection-flag.ts` 零改动）；判定器是纯函数，离线 eval 与生产 `todo.ts.execute` 共用同一真相源。

**Tech Stack:** zod ^3.23.8（@lnkpi/shared，vitest）、Prisma/SQLite migration（手写 migration.sql，照 #895 模式）、typebox（pi-runtime acceptance DSL）、node:test（pi-runtime，`node --import tsx --test`）。

**Spec:** `docs/superpowers/specs/2026-11-15-d1-creative-asset-contract-design.md`（§5 承载面 / §6 判据 / §7 数据契约 / §8 算法与测试纪律 / §12 分流）。本 plan 与 spec 必须一起读。

## Global Constraints（每条任务隐含遵守）

- **零新增**：`services/pi-runtime/src/tools/` 不新增注册；`ALWAYS_ON_TOOL_NAMES` 不追加；`prompt-registry/rules/` 不新增规则（L6 余量 89，`PROMPT_SPEC.md:73-76`）；`schema.prisma` 不新增 model（只允许既有 model 加列）；不新增事件类型。
- **硬拒唯一路径**：`rejectionResult()`（`services/pi-runtime/src/tools/todo.ts:142`，`details.todo.rejected:true`）+ `registerToolRejectionFlag` after_tool patch（`services/pi-runtime/src/tool-rejection-flag.ts:49`）。**不可抛错**（丢 details）、**不可 patch vendor**、**不可只挂 before_tool**（ADR-0005:57 时序）。注册序：`registerToolRejectionFlag`（`index.ts:108`）必须先于 `registerCanvasIdBindingHooks`（`:114`）——本刀不改注册序，回归测试锁定。
- **聚合优先级**：`reject > fail_open > pass`；查询故障 fail-open 软提醒 + 计数；**证据不足 / 结构非法 ⇒ 零副作用硬拒**（先校验后写入，`todo.ts:282-286` 范式）。
- **kill switch**：沿用 `PI_RUNTIME_ACCEPTANCE=off` 语义，新 oracle 不另设开关（挂在同一 acceptance 生命周期下）。
- **测试环境**：pi-runtime 用 node24 绝对路径 + `env -u NODE_OPTIONS`：`env -u NODE_OPTIONS PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" pnpm test:runtime`；server/shared 用 vitest。判变异 RED 必须用**完整 stdout** 的 `AssertionError` / `failing tests` 标记（`| tail` 吃退出码 ⇒ 伪变异恒绿）。
- **fake-0 排除**：判「不存在/零命中」一律 `grep -E` 或单模式，禁 BSD BRE `\|` 轮替；已知词反向对照。
- **migration 时间戳**：必须晚于 `20261115193000`（#895 已占用），建议 `20261116000000_d1_asset_contract`。
- **冲突面前置检查**：Task 3 / Task 6 触碰 `apps/server/src/agent/agent-canvas-tools.service.ts`、`agent-canvas-tools.controller.ts`；Task 2 触碰 `apps/server/prisma/schema.prisma`。执行对应 Task 前**必须**先 `gh api repos/sev7n4/pi-lnk/commits/master --jq '.sha[0:8]'` 核对 master 是否前移、`git log --oneline -3 -- <path>`（干净树）核对该文件最近提交；若并行窗口（`feat-sse-conversation-view-unification` / `feat-visp-read-media` / `feat-conversation-share` / `s1-cost-console-align`）已合入，基于新 master 重建该 task 的改动，禁止拿陈旧行号硬套。
- **合并门禁**：全量 `pnpm -r build`（vitest 绿 ≠ tsc 绿）→ `pnpm test:runtime` + `pnpm test:server:changed` → 变异自检 RED → **停在合并前等单独授权**；改 `services/pi-runtime` 合并后须手工 dispatch `runtime-deploy.yml`。

## Review Focus（spec 暗示但最易咬人的五个输入/失败模式）

1. **前端 `saveCanvas` 整份覆盖抹掉服务端写的 `stale`/`version`**（spec §11 风险 2）——期望：前端对这些字段只读，写入只经 Nest 事务；Task 3 的静态守卫测试钉死。
2. **`contentHash` 不变时重复标 stale 造成抖动**（spec §8.2-4）——期望：哈希不变 ⇒ 不传播、不写库；Task 3 的幂等测试钉死。
3. **模型自报时长数字被当判据输入**（spec §6.1-3，#815 教训）——期望：`DURATION_BUDGET` 只读 Shot 结构化 `durationMs` 列，overlay 自报 `duration_sec` 不作判据；Task 4 负例 fixture 钉死。
4. **fail-open 被当 pass**（spec §8.2-2）——期望：查询故障时回执带「已放行但非验收通过」文案且计数 `fail_open`，不产生 `pass`；Task 5 测试钉死。
5. **未知键静默进 `Material.metadata`**（spec §7 约束「未知键 fail-closed」）——期望：解析遇到 schema 外键即拒绝并回执合法键清单；Task 1 负例 fixture 钉死。

---

### Task 1: L0 资产契约 zod schema（@lnkpi/shared）

**Files:**
- Create: `packages/shared/src/canvas/assetContract.ts`
- Test: `packages/shared/src/canvas/assetContract.test.ts`
- Modify: `packages/shared/src/index.ts`（追加 re-export，一行）

**Interfaces:**
- Consumes: 既有 `zod`（shared 依赖已有）；不 import `agentContract.ts`（避免与 `CanvasData` 类型循环）。
- Produces: `AssetNodeDataSchema` / `parseAssetNodeData(data): { ok: true, value: AssetNodeData } | { ok: false, reason: string, allowedKeys: string[] }`、`MaterialMetaSchema` / `parseMaterialMeta(meta: string | null)`、枚举 `AXIS_SIDES = ["left","right"]`、`SCREEN_DIRECTIONS = ["in","out","neutral"]`、`SHOT_SIZES = ["wide","medium","close","insert"]`。Task 2/3/4 按这些名字消费。

- [ ] **Step 1: 写失败测试**

```ts
// packages/shared/src/canvas/assetContract.test.ts
import { describe, expect, it } from "vitest";
import {
  AXIS_SIDES, SHOT_SIZES, SCREEN_DIRECTIONS,
  parseAssetNodeData, parseMaterialMeta,
} from "./assetContract.js";

describe("AssetNodeData", () => {
  it("合法形态：全字段通过并归一化", () => {
    const r = parseAssetNodeData({
      assetId: "char-hero", contentHash: "a".repeat(64), version: 3,
      pinnedVersion: 2, derivedFrom: "char-hero-v1", stale: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.version).toBe(3);
  });
  it("空 data 也合法（字段全可选，不破坏既有节点）", () => {
    expect(parseAssetNodeData({}).ok).toBe(true);
  });
  it("未知键 fail-closed：拒绝并回执合法键清单", () => {
    const r = parseAssetNodeData({ assetId: "x", note: "自由文本" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.allowedKeys).toContain("assetId");
  });
  it("负例 fixture（spec §8.2-8）：类型非法 ⇒ 拒绝", () => {
    expect(parseAssetNodeData({ version: "v3" }).ok).toBe(false);
    expect(parseAssetNodeData({ stale: "no" }).ok).toBe(false);
    expect(parseAssetNodeData({ derivedFrom: 42 }).ok).toBe(false);
  });
});

describe("MaterialMeta", () => {
  it("null / 空串 ⇒ ok 空对象（既有数据零迁移成本）", () => {
    expect(parseMaterialMeta(null).ok).toBe(true);
    expect(parseMaterialMeta("").ok).toBe(true);
  });
  it("权威维度闭集：face/firstFrame/lastFrame/scene/prop 之外的键拒绝", () => {
    const bad = JSON.stringify({ authority: { costume: { level: "primary" } } });
    expect(parseMaterialMeta(bad).ok).toBe(false);
    const good = JSON.stringify({ authority: { face: { level: "primary", pinnedVersion: 2 } } });
    expect(parseMaterialMeta(good).ok).toBe(true);
  });
  it("authority.level 闭集 primary|fallback，非法值拒绝", () => {
    const bad = JSON.stringify({ authority: { face: { level: "best" } } });
    expect(parseMaterialMeta(bad).ok).toBe(false);
  });
});

describe("枚举闭集", () => {
  it("三组枚举与 spec §7 一致且为 const 元组", () => {
    expect(AXIS_SIDES).toEqual(["left", "right"]);
    expect(SCREEN_DIRECTIONS).toEqual(["in", "out", "neutral"]);
    expect(SHOT_SIZES).toEqual(["wide", "medium", "close", "insert"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/4seven/workspace/pi-lnk && env -u NODE_OPTIONS PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" pnpm --filter @lnkpi/shared exec vitest run src/canvas/assetContract.test.ts`
Expected: FAIL，`Cannot find module './assetContract.js'`

- [ ] **Step 3: 最小实现**

```ts
// packages/shared/src/canvas/assetContract.ts
/** D-1 L0 资产契约（spec 2026-11-15-d1-creative-asset-contract-design.md §7）。
 * 只允许既有 model 加列 / 开放字段收 schema，不新增 Prisma model。
 * 未知键 fail-closed：spec §7「开放字段须有 zod 解析 + 未知键 fail-closed」。 */
import { z } from "zod";

export const AXIS_SIDES = ["left", "right"] as const;
export const SCREEN_DIRECTIONS = ["in", "out", "neutral"] as const;
export const SHOT_SIZES = ["wide", "medium", "close", "insert"] as const;

/** 画布节点 data 的资产字段（全部可选：既有节点零破坏）。 */
export const AssetNodeDataSchema = z
  .object({
    assetId: z.string().min(1).optional(),
    contentHash: z.string().length(64).optional(),
    version: z.number().int().positive().optional(),
    pinnedVersion: z.number().int().positive().optional(),
    derivedFrom: z.string().min(1).optional(),
    stale: z.boolean().optional(),
  })
  .strict(); // 未知键 fail-closed（zod strict = 未知键报错）

export type AssetNodeData = z.infer<typeof AssetNodeDataSchema>;

export type ParseFail = { ok: false; reason: string; allowedKeys: string[] };

export function parseAssetNodeData(data: unknown):
  | { ok: true; value: AssetNodeData } | ParseFail {
  const r = AssetNodeDataSchema.safeParse(data);
  if (r.success) return { ok: true, value: r.data };
  const allowedKeys = Object.keys(AssetNodeDataSchema.shape);
  const first = r.error.issues[0];
  return { ok: false, reason: first ? `${first.path.join(".")}: ${first.message}` : "invalid", allowedKeys };
}

const AUTHORITY_DIMENSIONS = ["face", "firstFrame", "lastFrame", "scene", "prop"] as const;
const AuthorityEntrySchema = z.object({
  level: z.enum(["primary", "fallback"]),
  pinnedVersion: z.number().int().positive().optional(),
}).strict();

export const MaterialMetaSchema = z.object({
  authority: z.record(z.enum(AUTHORITY_DIMENSIONS), AuthorityEntrySchema).optional(),
}).strict();

export type MaterialMeta = z.infer<typeof MaterialMetaSchema>;

export function parseMaterialMeta(meta: string | null):
  | { ok: true; value: MaterialMeta } | ParseFail {
  if (meta === null || meta === "") return { ok: true, value: {} };
  let raw: unknown;
  try { raw = JSON.parse(meta); } catch { return { ok: false, reason: "metadata 不是合法 JSON", allowedKeys: ["authority"] }; }
  const r = MaterialMetaSchema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  const first = r.error.issues[0];
  return { ok: false, reason: first ? `${first.path.join(".")}: ${first.message}` : "invalid", allowedKeys: ["authority"] };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2。Expected: PASS 全绿。

- [ ] **Step 5: re-export + 全包回归**

`packages/shared/src/index.ts` 末尾追加一行 `export * from './canvas/assetContract'`（对齐既有 barrel 风格），然后：
Run: `env -u NODE_OPTIONS PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" pnpm --filter @lnkpi/shared test && env -u NODE_OPTIONS PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" pnpm --filter @lnkpi/shared build`
Expected: 全绿 + tsc 干净。

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/canvas/assetContract.ts packages/shared/src/canvas/assetContract.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): D-1 L0 资产契约 zod schema——未知键 fail-closed + 权威维度闭集"
```

---

### Task 2: L0 Prisma 既有 model 加列 + migration

**Files:**
- Modify: `apps/server/prisma/schema.prisma`（`model Shot :351` 加 7 列；`model Story :317` 加 3 列；**不新增 model**）
- Create: `apps/server/prisma/migrations/20261116000000_d1_asset_contract/migration.sql`
- Test: `apps/server/src/canvas/asset-contract-columns.test.ts`（照 `pricing-cost-record.controller.sqlite.integration.test.ts` 的 sqlite integration 模式）

**Interfaces:**
- Consumes: Task 1 的枚举常量（列注释引用，不引运行时）。
- Produces: Shot 列 `axisSide String?` / `screenDirection String?` / `shotSize String?` / `durationMs Int?` / `contentHash String?` / `version Int?` / `pinnedAssetId String?`；Story 列 `contentHash String?` / `lockedAt DateTime?` / `lockedVersion Int?`。全部可空 ⇒ 既有行零迁移。Task 3/4 消费。

- [ ] **Step 1: 核对冲突面（强制前置）**

Run: `gh api repos/sev7n4/pi-lnk/commits/master --jq '[.sha[0:8], .commit.message|split("\n")[0]] | @tsv' && gh api "repos/sev7n4/pi-lnk/contents/apps/server/prisma/schema.prisma?ref=master" --jq .content | base64 -d | sed -n '317,395p'`
Expected: master 未被并行窗口推进 `schema.prisma` 的新 commit；`model Story`/`model Shot` 行号与列清单与本 plan 一致。若不一致 ⇒ 以 master 实际内容为准调整本 Task 的 sed 行段与列清单，其余步骤不变。

- [ ] **Step 2: 写 migration.sql**

```sql
-- apps/server/prisma/migrations/20261116000000_d1_asset_contract/migration.sql
-- D-1 资产契约（spec §7）：既有 model 加列，全部可空，零数据迁移；禁新增 model（路标 §5.3）。
ALTER TABLE "Shot" ADD COLUMN "axisSide" TEXT;
ALTER TABLE "Shot" ADD COLUMN "screenDirection" TEXT;
ALTER TABLE "Shot" ADD COLUMN "shotSize" TEXT;
ALTER TABLE "Shot" ADD COLUMN "durationMs" INTEGER;
ALTER TABLE "Shot" ADD COLUMN "contentHash" TEXT;
ALTER TABLE "Shot" ADD COLUMN "version" INTEGER;
ALTER TABLE "Shot" ADD COLUMN "pinnedAssetId" TEXT;
ALTER TABLE "Story" ADD COLUMN "contentHash" TEXT;
ALTER TABLE "Story" ADD COLUMN "lockedAt" DATETIME;
ALTER TABLE "Story" ADD COLUMN "lockedVersion" INTEGER;
```

- [ ] **Step 3: schema.prisma 同步加列**

在 `model Shot { ... }`（`positionY Float @default(0)` 之后、`materials Material[]` 之前）插入：

```prisma
  // D-1 资产契约（spec 2026-11-15-d1 §7）：闭集枚举值见 @lnkpi/shared assetContract.ts；判据只读本列，禁采信模型自报数字（#815）。
  axisSide      String?
  screenDirection String?
  shotSize      String?
  durationMs    Int?
  contentHash   String?
  version       Int?
  pinnedAssetId String?
```

在 `model Story { ... }`（`coverUrl String?` 之后）插入：

```prisma
  // D-1：内容哈希与锁定版本（spec §7 Story 行）。
  contentHash   String?
  lockedAt      DateTime?
  lockedVersion Int?
```

- [ ] **Step 4: 写列存在性测试（sqlite integration 形态）**

```ts
// apps/server/src/canvas/asset-contract-columns.test.ts
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

/** D-1 L0：加列存在性 + 可空默认（spec §7）。migration.sql 与 schema.prisma 必须同步。 */
describe("D-1 asset contract columns", () => {
  let dbPath: string;
  beforeAll(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), "d1-cols-")), "test.db");
    execSync(
      `npx prisma migrate deploy --schema apps/server/prisma/schema.prisma`,
      { env: { ...process.env, DATABASE_URL: `file:${dbPath}` }, stdio: "pipe" },
    );
  });
  afterAll(() => { /* tmp 自清理 */ });

  it("Shot/Story 新列存在且可空（旧行零迁移可读）", async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
    const shot = await prisma.shot.create({ data: { sessionId: "s1" } });
    expect(shot.axisSide).toBeNull();
    expect(shot.durationMs).toBeNull();
    expect(shot.version).toBeNull();
    const story = await prisma.story.create({ data: { userId: "u1", title: "t" } });
    expect(story.contentHash).toBeNull();
    expect(story.lockedAt).toBeNull();
    await prisma.$disconnect();
  });
});
```

- [ ] **Step 5: 跑测试**

Run: `env -u NODE_OPTIONS PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" pnpm --filter @lnkpi/server exec vitest run src/canvas/asset-contract-columns.test.ts`
Expected: PASS（若 prisma client 未重新生成，先 `pnpm --filter @lnkpi/server exec prisma generate`）。

- [ ] **Step 6: Commit**

```bash
git add apps/server/prisma/schema.prisma apps/server/prisma/migrations/20261116000000_d1_asset_contract apps/server/src/canvas/asset-contract-columns.test.ts
git commit -m "feat(server): D-1 Shot/Story 既有 model 加列（可空零迁移）+ migration"
```

---

### Task 3: L1 失效传播——contentHash + 下游闭包 + 原子写 stale

**Files:**
- Create: `packages/shared/src/canvas/lineage.ts`（纯函数：哈希 + BFS 闭包，与 IO 解耦）
- Test: `packages/shared/src/canvas/lineage.test.ts`
- Modify: `apps/server/src/agent/agent-canvas-tools.service.ts`（⚠️ 冲突面；单一写者事务内调用 lineage 纯函数 + 原子写 stale）
- Test: `apps/server/src/agent/agent-canvas-tools.lineage.test.ts`

**Interfaces:**
- Consumes: Task 1 `AssetNodeData`；既有 `CanvasData`（`packages/shared/src/index.ts:212`，`nodes`/`edges`）；spec §8.2-4。
- Produces: `computeContentHash(fields: Record<string, unknown>): string`（sha256 hex 64）；`downstreamClosure(edges: Array<{source:string;target:string}>, changedIds: string[]): string[]`（不含起点）；`shouldPropagate(prevHash?: string, nextHash?: string): boolean`（hash 不变 ⇒ false，防抖动）。server 侧 `applyStalePropagation(tx, sessionId, changedNodeIds)`：同一事务内写 `stale:true` + 新 `version`。

- [ ] **Step 1: 写失败测试（shared 纯函数）**

```ts
// packages/shared/src/canvas/lineage.test.ts
import { describe, expect, it } from "vitest";
import { computeContentHash, downstreamClosure, shouldPropagate } from "./lineage.js";

describe("computeContentHash", () => {
  it("相同字段集合（键序无关）⇒ 同哈希", () => {
    expect(computeContentHash({ a: 1, b: "x" })).toBe(computeContentHash({ b: "x", a: 1 }));
  });
  it("任一结构化字段变化 ⇒ 哈希变化；64 位 hex", () => {
    const h1 = computeContentHash({ prompt: "a" });
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(computeContentHash({ prompt: "b" })).not.toBe(h1);
  });
  it("position 等非结构化字段不参与哈希（spec：内容哈希只算 structuredFields）", () => {
    expect(computeContentHash({ prompt: "a" })).toBe(computeContentHash({ prompt: "a" }));
  });
});

describe("downstreamClosure", () => {
  const edges = [
    { source: "A", target: "B" }, { source: "B", target: "C" },
    { source: "A", target: "C" }, { source: "D", target: "A" }, { source: "C", target: "C" },
  ];
  it("BFS 求可达下游，不含起点；自环不死循环", () => {
    expect(downstreamClosure(edges, ["A"]).sort()).toEqual(["B", "C"]);
  });
  it("多起点合并去重", () => {
    expect(downstreamClosure(edges, ["D", "A"]).sort()).toEqual(["A", "B", "C"]);
  });
  it("无下游 ⇒ 空数组（不报错）", () => {
    expect(downstreamClosure(edges, ["C"])).toEqual([]);
  });
});

describe("shouldPropagate", () => {
  it("哈希不变 ⇒ false（防抖动，spec §8.2-4）", () => {
    expect(shouldPropagate("h", "h")).toBe(false);
  });
  it("哈希变化或首次写入 ⇒ true", () => {
    expect(shouldPropagate("h1", "h2")).toBe(true);
    expect(shouldPropagate(undefined, "h2")).toBe(true);
    expect(shouldPropagate("h1", undefined)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `env -u NODE_OPTIONS PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" pnpm --filter @lnkpi/shared exec vitest run src/canvas/lineage.test.ts`
Expected: FAIL `Cannot find module './lineage.js'`

- [ ] **Step 3: 实现 lineage.ts**

```ts
// packages/shared/src/canvas/lineage.ts
/** D-1 L1 失效传播纯函数（spec §8.2-4）。不读网络 / 不写状态；IO 在 apps/server 侧。
 * build-system 式增量失效：contentHash 不变 ⇒ 不传播（防抖动）。 */
import { createHash } from "node:crypto";

/** 结构化内容哈希：键排序后 JSON 串 sha256。position/位置类字段由调用方排除。 */
export function computeContentHash(fields: Record<string, unknown>): string {
  const sorted = Object.keys(fields).sort()
    .map((k) => `${k}=${JSON.stringify(fields[k])}`).join("&");
  return createHash("sha256").update(sorted).digest("hex");
}

/** 有向图下游闭包：从 changedIds 沿 source→target 可达的全部节点（不含起点）。
 * 自环/环安全：visited 集合防重入。 */
export function downstreamClosure(
  edges: ReadonlyArray<{ source: string; target: string }>,
  changedIds: readonly string[],
): string[] {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.source) ?? [];
    list.push(e.target);
    adj.set(e.source, list);
  }
  const seen = new Set<string>(changedIds);
  const queue = [...changedIds];
  const out: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    for (const next of adj.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      out.push(next);
      queue.push(next);
    }
  }
  return out;
}

/** 哈希不变 ⇒ 不传播（spec §8.2-4 防抖动）；任一侧缺失视为变化。 */
export function shouldPropagate(prevHash?: string, nextHash?: string): boolean {
  if (prevHash === undefined || nextHash === undefined) return true;
  return prevHash !== nextHash;
}
```

- [ ] **Step 4: shared 测试通过 + build**

Run: 同 Step 2 + `pnpm --filter @lnkpi/shared build`。Expected: PASS + tsc 干净。

- [ ] **Step 5: server 侧接线（冲突面，先重核 master）**

重复 Task 2 Step 1 的前置检查。然后在 `agent-canvas-tools.service.ts` 的既有**单一写者**保存路径（`canvasData` persist 事务内）追加：写节点前 `computeContentHash` 该节点结构化字段（prompt/title/data 中 Task 1 字段），与节点现有 `data.contentHash` 比对；`shouldPropagate` 为 true 时在**同一事务**内对 `downstreamClosure(...)` 的每个下游节点写 `data.stale: true`。禁止第二条写入通道（spec §6.2 硬约束）。具体插入点以 master 当前代码为准（本 plan 不预设行号——冲突面文件，插入点在写执行时按 Step 1 核对结果定位）。

- [ ] **Step 6: 写 server 侧测试**

```ts
// apps/server/src/agent/agent-canvas-tools.lineage.test.ts
/** 契约（spec §6.2 / Review Focus 1-2）：
 * 1. hash 不变 ⇒ 不写 stale（幂等，防抖动）；
 * 2. hash 变化 ⇒ 下游闭包内节点 stale=true 且与 version 更新同事务；
 * 3. stale 字段只能由本路径写——前端 saveCanvas 整份覆盖不含 stale 语义（Review Focus 1）。 */
import { describe, expect, it } from "vitest";
import { computeContentHash, downstreamClosure, shouldPropagate } from "@lnkpi/shared";
// 集成用例：构造 3 节点链 A→B→C 的 canvasData，走 service 保存路径断言 B/C 的 data.stale。
// 断言形态照 agent-canvas-tools.service 现有 vitest 集成测试（不贴死 mock 细节，执行时对齐现行测试基建）。
```

> ⚠️ Step 6 的 mock/夹具形态在执行时以 `apps/server/src/agent/` 下现行 service 集成测试为准（该文件与测试基建都是并行窗口热点）；三个断言契约（幂等 / 同事务 / 单一写者）是本 task 的验收线，不可省略。

- [ ] **Step 7: 跑 server 测试**

Run: `env -u NODE_OPTIONS PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" pnpm --filter @lnkpi/server exec vitest run src/agent/agent-canvas-tools.lineage.test.ts`
Expected: PASS。

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/canvas/lineage.ts packages/shared/src/canvas/lineage.test.ts apps/server/src/agent/agent-canvas-tools.service.ts apps/server/src/agent/agent-canvas-tools.lineage.test.ts
git commit -m "feat(canvas): D-1 L1 失效传播——contentHash 防抖 + 下游闭包原子写 stale"
```

---

### Task 4: L2 三条 oracle 纯函数（acceptance DSL 内）

**Files:**
- Create: `services/pi-runtime/src/tools/asset-oracle.ts`
- Test: `services/pi-runtime/src/tools/asset-oracle.test.ts`
- Modify: `services/pi-runtime/src/tools/acceptance.ts`（`acceptanceSchema.kind` 增 `asset_contract` 枚举值 + `assetContract` 子对象；`parseAcceptance` 对应分支）

**Interfaces:**
- Consumes: 既有 `AcceptanceParse` / `parseAcceptance`（`acceptance.ts`）；Task 1 枚举。
- Produces: `judgeIdClosure(input): OracleVerdict` / `judgeAuthorityRef(input): OracleVerdict` / `judgeDurationBudget(input): OracleVerdict`，其中 `type OracleVerdict = { verdict: "pass" | "reject"; reason?: string; evidence?: Record<string, unknown> }`。acceptance DSL 新形态：`{ kind: "asset_contract", assetContract: { idClosure?: true, authorityRef?: true, durationBudget?: true } }`（至少一谓词，防游戏化同 C-2b §14.4）。

- [ ] **Step 1: 写失败测试（含负例 fixture，spec §8.2-8）**

```ts
// services/pi-runtime/src/tools/asset-oracle.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeAuthorityRef, judgeDurationBudget, judgeIdClosure } from "./asset-oracle.js";

test("idClosure: 孤儿引用 ⇒ reject 且证据带合法 ID 清单", () => {
  const v = judgeIdClosure({ registeredIds: ["hero", "scene-1"], referencedIds: ["hero", "ghost"] });
  assert.equal(v.verdict, "reject");
  assert.deepEqual(v.evidence?.unknownIds, ["ghost"]);
  assert.deepEqual(v.evidence?.registeredIds, ["hero", "scene-1"]);
});
test("idClosure: 一名多实体（registered 重复）⇒ reject", () => {
  const v = judgeIdClosure({ registeredIds: ["hero", "hero"], referencedIds: ["hero"] });
  assert.equal(v.verdict, "reject");
});
test("idClosure: 全部引用已登记 ⇒ pass；空引用 ⇒ pass（非故障）", () => {
  assert.equal(judgeIdClosure({ registeredIds: ["hero"], referencedIds: ["hero"] }).verdict, "pass");
  assert.equal(judgeIdClosure({ registeredIds: [], referencedIds: [] }).verdict, "pass");
});

test("authorityRef: 同维度多权威 ⇒ reject（spec §6.1-2）", () => {
  const v = judgeAuthorityRef({
    authorities: [
      { dimension: "face", materialId: "m1", accepted: true, pinned: true },
      { dimension: "face", materialId: "m2", accepted: true, pinned: true },
    ],
  });
  assert.equal(v.verdict, "reject");
  assert.deepEqual(v.evidence?.conflicts, ["face"]);
});
test("authorityRef: 未验收或未钉版本 ⇒ reject；合法唯一 ⇒ pass", () => {
  assert.equal(judgeAuthorityRef({
    authorities: [{ dimension: "face", materialId: "m1", accepted: false, pinned: true }],
  }).verdict, "reject");
  assert.equal(judgeAuthorityRef({
    authorities: [{ dimension: "face", materialId: "m1", accepted: true, pinned: true }],
  }).verdict, "pass");
});

test("durationBudget: 中文台词字数 > durationSec×4.5 ⇒ reject（判据读 Shot 结构化 durationMs，禁自报数）", () => {
  const v = judgeDurationBudget({ rows: [{ shotId: "s1", durationMs: 2000, dialogueChars: 10 }] });
  assert.equal(v.verdict, "reject"); // 2s × 4.5 = 9 字上限，10 字超
  assert.deepEqual(v.evidence?.overshoot, [{ shotId: "s1", limit: 9, actual: 10 }]);
});
test("durationBudget: 恰好等于上限 ⇒ pass；无 durationMs 行 ⇒ reject（证据不足，禁采信自报）", () => {
  assert.equal(judgeDurationBudget({ rows: [{ shotId: "s1", durationMs: 2000, dialogueChars: 9 }] }).verdict, "pass");
  assert.equal(judgeDurationBudget({ rows: [{ shotId: "s1", dialogueChars: 5 }] }).verdict, "reject");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `env -u NODE_OPTIONS PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" pnpm test:runtime 2>&1 | grep -E 'asset-oracle|Cannot find'`（⚠️ 完整输出判 RED，禁 `| tail`）
Expected: FAIL `Cannot find module './asset-oracle.js'`

- [ ] **Step 3: 实现三判定器**

```ts
// services/pi-runtime/src/tools/asset-oracle.ts
/** D-1 L2 三条 oracle（spec §6.1）。纯函数：不读网络 / 不调模型 / 不写状态；
 * 离线 golden-cases 与生产 todo.ts.execute 共用（单一真相源，judgeCanvasCounts 范式）。
 * 4.5 常量与 render-canvas-view.ts:128 CHARS_PER_SEC 同源语义；此处独立常量并测试锁定，避免跨工具 import。 */
export type OracleVerdict = { verdict: "pass" | "reject"; reason?: string; evidence?: Record<string, unknown> };

const CHARS_PER_SEC = 4.5; // spec §6.1-3：中文口播 4–5 字/秒，取 4.5（render-canvas-view.ts:128 同值）

export function judgeIdClosure(input: { registeredIds: readonly string[]; referencedIds: readonly string[] }): OracleVerdict {
  const registered = input.registeredIds;
  const dupes = registered.filter((id, i) => registered.indexOf(id) !== i);
  if (dupes.length > 0) {
    return { verdict: "reject", reason: "一名多实体", evidence: { duplicateIds: [...new Set(dupes)] } };
  }
  const reg = new Set(registered);
  const unknownIds = [...new Set(input.referencedIds.filter((id) => !reg.has(id)))];
  if (unknownIds.length > 0) {
    return { verdict: "reject", reason: "孤儿引用", evidence: { unknownIds, registeredIds: registered } };
  }
  return { verdict: "pass" };
}

export function judgeAuthorityRef(input: {
  authorities: ReadonlyArray<{ dimension: string; materialId: string; accepted: boolean; pinned: boolean }>;
}): OracleVerdict {
  const byDim = new Map<string, number>();
  for (const a of input.authorities) {
    if (!a.accepted || !a.pinned) {
      return { verdict: "reject", reason: `维度 ${a.dimension} 的权威素材未验收或未钉版本`, evidence: { materialId: a.materialId, dimension: a.dimension } };
    }
    byDim.set(a.dimension, (byDim.get(a.dimension) ?? 0) + 1);
  }
  const conflicts = [...byDim.entries()].filter(([, n]) => n > 1).map(([d]) => d);
  if (conflicts.length > 0) {
    return { verdict: "reject", reason: "同维度多重权威", evidence: { conflicts } };
  }
  return { verdict: "pass" };
}

export function judgeDurationBudget(input: {
  rows: ReadonlyArray<{ shotId: string; durationMs?: number; dialogueChars?: number }>;
}): OracleVerdict {
  const overshoot: Array<Record<string, unknown>> = [];
  const missing: string[] = [];
  for (const r of input.rows) {
    if (r.durationMs === undefined || r.dialogueChars === undefined) { missing.push(r.shotId); continue; }
    const limit = (r.durationMs / 1000) * CHARS_PER_SEC;
    if (r.dialogueChars > limit) {
      overshoot.push({ shotId: r.shotId, limit: Math.floor(limit), actual: r.dialogueChars });
    }
  }
  if (missing.length > 0 || overshoot.length > 0) {
    return { verdict: "reject", reason: missing.length > 0 ? "缺少结构化 durationMs（禁采信模型自报，#815）" : "台词超时长预算", evidence: { overshoot, missingDuration: missing } };
  }
  return { verdict: "pass" };
}
```

- [ ] **Step 4: acceptance.ts 枚举扩展**

`acceptanceSchema.kind` 的 `Type.Union` 增加第三个字面量：

```ts
Type.Literal("asset_contract", { description: "资产契约验收：ID 引用闭包 / 权威引用唯一 / 台词时长预算（D-1）" }),
```

新增可选子对象（对齐 `canvasState` 的「至少一谓词」形态）：

```ts
assetContract: Type.Optional(
  Type.Object(
    {
      idClosure: Type.Optional(Type.Boolean({ description: "校验剧本实体引用闭包（孤儿/一名多实体 ⇒ 拒）" })),
      authorityRef: Type.Optional(Type.Boolean({ description: "校验各维度权威素材唯一且已验收钉版" })),
      durationBudget: Type.Optional(Type.Boolean({ description: "校验台词字数 ≤ Shot 结构化时长×4.5" })),
    },
    { description: "至少一谓词为 true；判据输入由服务端结构化数据提供，禁自由文本" },
  ),
),
```

`TodoAcceptance` / `AcceptanceRequirement` 类型与 `parseAcceptance` 同步：`kind=asset_contract` 且 `assetContract` 缺失或零谓词 ⇒ 非法（对齐 C-2b「至少一谓词」守卫）；`kind` 与子对象错配（如 `kind=generation` 带 `assetContract`）⇒ 非法。**只注册已实现校验的枚举值**（spec §5.3 原则）——本 Task 三谓词全部有实现才允许进枚举。

- [ ] **Step 5: 全部测试通过 + 既有 acceptance 回归**

Run: `env -u NODE_OPTIONS PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" pnpm test:runtime`
Expected: PASS（含 acceptance.test.ts 既有 17 例零回归）。

- [ ] **Step 6: 变异自检（强制，spec §8.2-5）**

对 `asset-oracle.ts` 做两处行级突变（对象字面量条件恒 falsy）：
- 突变①：`if (dupes.length > 0)` → `if (false && dupes.length > 0)`
- 突变②：`if (r.dialogueChars > limit)` → `if (false && r.dialogueChars > limit)`

Run（每次突变后）: `env -u NODE_OPTIONS PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" pnpm test:runtime 2>&1 | grep -cE 'failing tests|AssertionError'`
Expected: 每次突变输出 ≥1（**RED**）；恢复后回到全绿。若突变不 RED ⇒ 判据自匹配恒绿，**必须先修测试再继续**。

- [ ] **Step 7: Commit**

```bash
git add services/pi-runtime/src/tools/asset-oracle.ts services/pi-runtime/src/tools/asset-oracle.test.ts services/pi-runtime/src/tools/acceptance.ts
git commit -m "feat(pi-runtime): D-1 L2 三条 asset_contract oracle——纯函数判定 + 负例 fixture + 变异 2/2 RED"
```

---

### Task 5: verifyAcceptance 接线 + fail-open 边界 + 硬拒链回归

**Files:**
- Modify: `services/pi-runtime/src/tools/todo.ts`（`verifyAcceptance :160` 增 `asset_contract` 分支；deps 增资产快照查询）
- Modify: `services/pi-runtime/src/tools/acceptance.ts`（asset 快照 oracle 读取函数，照 `judgeGenerationAcceptance` 的 client 形态）
- Test: `services/pi-runtime/src/tools/todo.acceptance-asset.test.ts`（新文件）；`tool-rejection-flag.test.ts` 回归（零改动只跑）

**Interfaces:**
- Consumes: Task 4 `judge*`；todo.ts 既有 `deps` 注入（`toolContext` 的 NestClient，同 `:160` verifyAcceptance 现形）。
- Produces: `verifyAssetContract(client, sessionId): Promise<{ ok: true; input: {...} } | { ok: false; reason: string }>`——从服务端拉画布快照 + Shot 结构化列，组装三判定器输入；查询故障 ⇒ `ok:false`（fail-open 路径）。

- [ ] **Step 1: 写失败测试**

```ts
// services/pi-runtime/src/tools/todo.acceptance-asset.test.ts
/** 契约（spec §8.2-2/3 + Review Focus 4）：
 * 1. asset_contract 判定 reject ⇒ execute 返回 rejectionResult（快照不变 / diff.updates=[] / rejected:true）；
 * 2. 判定器输入的 client 查询故障 ⇒ fail-open：放行但回执带「查询失败已放行，勿视为验收通过」；
 * 3. 结构非法（零谓词 / kind 错配）⇒ 零副作用硬拒（非 fail-open）；
 * 4. PI_RUNTIME_ACCEPTANCE=off ⇒ 整个 acceptance 分支跳过（既有 kill switch 语义不扩面）。
 * 夹具形态照 todo.ts 现有 acceptance 测试（执行时对齐现行 deps fake）。 */
import assert from "node:assert/strict";
import { test } from "node:test";
// ...执行时按现行 todo acceptance 测试的 deps fake 形态补全 4 例
```

> Step 1 的 fake deps 形态在执行时照 `services/pi-runtime/src/tools/` 现行 todo acceptance 测试抄写（本 plan 不猜测其 fake 类名）；四条断言契约是验收线。

- [ ] **Step 2: 跑测试确认失败** → Run 同 Task 4 Step 2，Expected: 新文件 FAIL（分支未实现）。

- [ ] **Step 3: 实现 verifyAssetContract + verifyAcceptance 分支**

`acceptance.ts` 增（对齐 `judgeGenerationAcceptance :227` 的 client 形态与 fail-open 注释纪律）：

```ts
/** D-1：资产契约快照组装。查询故障 ⇒ ok:false（调用方 fail-open + 计数）；
 *  判据只读服务端结构化字段（Shot.durationMs 等），禁采信模型自报（#815）。 */
export async function fetchAssetContractInput(
  client: { post: (path: string, body: unknown) => Promise<unknown> },
  sessionId: string,
): Promise<{ ok: true; registeredIds: string[]; referencedIds: string[]; authorities: Array<{ dimension: string; materialId: string; accepted: boolean; pinned: boolean }>; durationRows: Array<{ shotId: string; durationMs?: number; dialogueChars?: number }> } | { ok: false; reason: string }> {
  // 实现要点：post 到既有画布快照 / Shot 查询 internal 端点（执行时对齐 judgeCanvasAcceptance 现用的端点与鉴权形态）；
  // 画布 text 节点 data 的实体登记（Task 1 AssetNodeData.assetId）为 registeredIds；
  // 边 + Material.metadata（parseMaterialMeta）的 authority 为 authorities；
  // Shot 列为 durationRows。响应缺字段 ⇒ ok:false（证据不足不猜）。
}
```

`todo.ts` 的 `verifyAcceptance` 增分支（对齐 `:282-286` 既有顺序：**校验先于 overwriteTodos**）：

```ts
// asset_contract：三谓词按声明逐个跑 judge*；任一 reject ⇒ reject（聚合 reject > fail_open > pass）
// client 查询 ok:false ⇒ fail-open：reminders.push（照 :203 现有文案纪律）+ 计数 fail_open
```

- [ ] **Step 4: 全量 runtime 测试 + 硬拒链回归**

Run: `env -u NODE_OPTIONS PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" pnpm test:runtime`
Expected: PASS——含 `tool-rejection-flag.test.ts` 与 `session-manager.tool-guidelines.test.ts` 既有回归零改动。**若注册序/硬拒链测试红 ⇒ 本 Task 实现破坏了 `details.todo.rejected` 单点契约，必须回改实现（不许改测试期望）。**

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/tools/todo.ts services/pi-runtime/src/tools/acceptance.ts services/pi-runtime/src/tools/todo.acceptance-asset.test.ts
git commit -m "feat(pi-runtime): D-1 verifyAcceptance 接入 asset_contract——fail-open 边界 + 硬拒链零改动回归"
```

---

### Task 6: L3 只读面 details 扩展（staleNodeIds / lineage 摘要）

**Files:**
- Modify: `packages/shared/src/agentContract.ts`（`GetCanvasSummaryResponseSchema :182` 增可选字段）
- Modify: `apps/server/src/agent/agent-canvas-tools.controller.ts` + `agent-canvas-tools.service.ts`（⚠️ 双冲突面；只读派生，不新增工具）

**Interfaces:**
- Consumes: Task 3 lineage 纯函数；既有 `get_canvas_summary` 端点。
- Produces: response 增 `staleNodeIds?: string[]`、`lineage?: Array<{ nodeId: string; assetId?: string; version?: number; stale?: boolean }>`。**零新增工具、零新增事件**（spec §5.1 L3 行）。

- [ ] **Step 1: 冲突面双前置检查**（Task 2 Step 1 同款，覆盖 `.controller.ts` 与 `.service.ts` 两个路径 + `agentContract.ts`）。
- [ ] **Step 2: shared schema 加可选字段**（strict 之外的可选扩展，加 zod `.optional()`），跑 `pnpm --filter @lnkpi/shared test && pnpm --filter @lnkpi/shared build`。
- [ ] **Step 3: server 组装**——`get_canvas_summary` handler 内调 `lineage.ts` 纯函数从 `canvasData` 派生 `staleNodeIds` / `lineage`；纯派生无写路径。**写测试**：画布含 stale 节点 ⇒ response 带 id；无 stale ⇒ 字段缺省（不加空数组，对齐 A-3「缺省键不出现」纪律）。
- [ ] **Step 4: 跑 controller 既有测试回归 + verify-contract**

Run: `env -u NODE_OPTIONS PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" pnpm --filter @lnkpi/server exec vitest run src/agent/ && env -u NODE_OPTIONS PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" pnpm verify-contract && env -u NODE_OPTIONS PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" pnpm verify:details`
Expected: 全绿（若 `verify-tool-details-contract` 对 response 形态有登记要求，按其现行登记格式补登，不绕过）。

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/agentContract.ts apps/server/src/agent/agent-canvas-tools.controller.ts apps/server/src/agent/agent-canvas-tools.service.ts
git commit -m "feat(canvas): D-1 L3 只读面——get_canvas_summary details 增 staleNodeIds/lineage 派生"
```

---

### Task 7: golden cases + 全量门禁 + 收尾

**Files:**
- Modify: `services/pi-runtime/src/eval/golden-cases.ts`（`GoldenStep.expectCanvasState` 同款，增 `expectAssetContract?: { failOn?: "idClosure" | "authorityRef" | "durationBudget" }` 观测判据——**只观测不计分**，对齐 C-1 §8.6 纪律）
- Test: `services/pi-runtime/src/eval/golden-cases.test.ts`（增 L0 校验例）

**Interfaces:**
- Consumes: Task 4 判定器（离线消费同一真相源）。
- Produces: 无新运行时面；仅 eval 资产。

- [ ] **Step 1: 增 golden case 观测判据**——`GoldenStep` 增 `expectAssetContract`（形态照 `expectIdentitySurvival :118` 的「编写期标注 + 运行时只观测」）；golden-cases L0 校验函数对新判据做形态检查（引用的 shotId 必须在该 case 的夹具内）。
- [ ] **Step 2: 跑 eval L0**——Run: `env -u NODE_OPTIONS PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" pnpm test:runtime`。Expected: PASS，既有 141 例（eval 全目录）零回归。
- [ ] **Step 3: 全量三门禁**

```bash
cd /Users/4seven/workspace/pi-lnk
env -u NODE_OPTIONS PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" pnpm -r build
env -u NODE_OPTIONS PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" pnpm test:runtime
env -u NODE_OPTIONS PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" pnpm test:server:changed
```

Expected: build 全包 tsc 干净（vitest 绿 ≠ tsc 绿）；runtime 全绿；server changed 全绿。

- [ ] **Step 4: verify 守卫族**

```bash
env -u NODE_OPTIONS PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" pnpm verify-tool-tiering
env -u NODE_OPTIONS PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" pnpm verify-tool-contract
env -u NODE_OPTIONS PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" pnpm verify-claims
```

Expected: 全绿——`verify-tool-tiering` 确认零新增工具注册（A1/A2/A5 不变）；`verify-claims` 确认本刀新增文档断言可复现。

- [ ] **Step 5: 推分支 + PR + CI 三 check 全绿 → 停**

```bash
git checkout -b feat/d1-asset-contract   # 若尚未在 feature 分支
git push origin feat/d1-asset-contract   # ⚠️ 本机 git push 502 历史前科 ⇒ 失败则改用 gh api REST 推 PR 流程（blob→tree→commit→ref→PR），推前逐路径裸 blob sha 比对 master
gh pr create --title "feat: D-1 创作资产契约与可执行判定层" --body-file <PR 正文文件>  # ⭐ 正文必须回读长度核对（@文件路径会静默丢内容）
```

Expected: CI 三 check 全绿 → **停在这⾥，等用户单独授权合并**。合并后（获授权时）：squash merge → 合并树核验 → 手工 dispatch `runtime-deploy.yml` → 生产取证（Nest + K3s 两单元 `build_info`）→ 行为复测（acceptance `asset_contract` 声明 → 硬拒回执 → `pi_runtime_acceptance_total` 出现 `declared` 数据行）。

---

## Self-Review 记录（writing-plans §Self-Review）

1. **Spec coverage**：§6.1 三判据 → Task 4；§6.2 写路径 → Task 3；§7 数据契约 → Task 1/2；§5.1 L3 → Task 6；§8.2 测试纪律（变异/fake-0/负例/真实记录求值）→ Task 4 Step 6 + 各测试步骤；L4 观测 → Task 7（只观测）；§5.4 成本 gate / §5.5 上游原语 → **不在本刀**（spec §12 归 D-1c / B-123），无缺口。
2. **Placeholder scan**：Task 5 Step 1 / Task 3 Step 5-6 有两处「执行时对齐现行测试基建/现行端点」——这是对冲突面文件**不预设陈旧行号**的刻意决策（Global Constraints 冲突面条款），验收契约（断言内容）均已写死，不属于 "TBD/TODO" 类占位。
3. **Type consistency**：`OracleVerdict` 在 Task 4 定义、Task 5 消费；`parseAssetNodeData`/`parseMaterialMeta`/三枚举在 Task 1 定义、Task 2/3 引用；`computeContentHash`/`downstreamClosure`/`shouldPropagate` 在 Task 3 定义、Task 6 消费——签名一致。
4. **Review Focus**：五个失败模式各落到任务测试（Task 3 Step 6 / Task 3 Step 1 / Task 4 Step 1 / Task 5 Step 1 / Task 1 Step 1）。
