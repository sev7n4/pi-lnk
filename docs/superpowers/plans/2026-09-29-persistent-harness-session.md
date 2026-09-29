# P0-① 持久 harness 会话 + 原生 compaction 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让同一个对话（thread）跨轮复用同一个 vendored harness 会话——历史进原生 context、超限走 vendor compaction，并退役为「每轮重建」而生的四套补丁。

**Architecture:** 三层改动。① pi-runtime 会话层：`create` 从「有则 409」变为「幂等 resume-or-create-rebuild」（内存 → 磁盘 `repo.open` + `harness.create` 自动 `restoreSession` → 新建），`systemPrompt`/`toolContext` 改函数形态使每轮易变上下文在**每次 LLM 调用前**求值，新增 TTL sweeper 与磁盘 LRU。② Nest 编排层：每轮不再 `deleteSession`，改为每轮携带 `turnContext`，退役 `createSessionReplacingStale` / `acquirePiSessionLock` / 409 竞态 / `compressRecentTurns`。③ 配置与观测：新增 7 项 env 与 4 项 metrics。

**Tech Stack:** TypeScript、Node `node:test` + tsx（pi-runtime）、vitest（Nest）、Fastify、vendored `@earendil-works/pi-agent-core` 0.85.1、Helm/K3s（部署）

**Spec:** `docs/superpowers/specs/2026-09-29-persistent-harness-session-design.md`（本计划逐条实现 §4 判据与 §6 场景）

## Global Constraints

- **零改动面**：`vendor/**`、`apps/web/**`、`apps/server/prisma/**`、`services/pi-runtime/src/tools/**` 一律不改
- **线协议**：HTTP body/path 上传输的一律是 **threadKey 原样**（Nest 不做哈希）；pi-runtime 在每个路由入口用 `toSessionKey()` 转换**恰好一次**（该函数非幂等，禁止二次应用）
- **pi-runtime 单测命令**：`node --import tsx --test "src/**/*.test.ts"`（在 `services/pi-runtime/` 下）；单文件：`node --import tsx --test src/<file>.test.ts`
- **Nest 单测命令**：`pnpm -C apps/server test`；单文件：`npx vitest run src/agent/<file>.test.ts`
- **类型检查**：双侧 `tsc --noEmit` 必须干净（`pnpm -C services/pi-runtime typecheck`、`pnpm -C apps/server exec tsc --noEmit`）
- **TDD 强制**：每个任务先写失败测试并**实际看到它失败**，再实现
- **部署顺序铁律**：pi-runtime 必须先于 Nest 上线（spec §4 部署顺序判据）
- **不新增第三方依赖**

## Review Focus

以下五类输入/失败模式是本规格默示要求但「没有任务天然覆盖」的，各自已在指定任务里加了锁死测试：

1. **同一 threadKey 上出现不同 userId**（越权读他人对话）→ 必须 409 且不返回任何会话内容（Task 5）
2. **会话被 TTL 回收后立刻发新消息**（回收与恢复竞态）→ 必须恢复而非报 404，且磁盘目录 mtime 不被刷新（Task 6）
3. **`prompt` 在 run 进行中再次到达**（双击/多实例）→ 必须 409 `session busy`，不得静默排队或并发执行（Task 6）
4. **磁盘目录数/体积越限且内存中有活跃会话** → LRU 必须跳过活跃目录（Task 2 + Task 6）
5. **下游收到不含 `turnContext` 的旧 Nest 请求**（灰度/回滚期）→ 必须仍能工作（返回旧行为，不 4xx）（Task 7）

---

### Task 1: pi-runtime 运行期配置单一解析处

**Files:**
- Create: `services/pi-runtime/src/runtime-config.ts`
- Test: `services/pi-runtime/src/runtime-config.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface CompactionConfig { enabled: boolean; reserveTokens: number; keepRecentTokens: number }`
  - `interface RuntimeConfig { dataRoot: string; sessionTtlMs: number; sweepIntervalMs: number; sessionsMaxBytes: number; sessionsMaxCount: number; compaction: CompactionConfig }`
  - `DEFAULT_RUNTIME_CONFIG: RuntimeConfig`
  - `parsePositiveInt(raw: string | undefined, fallback: number): number`
  - `parseBool(raw: string | undefined, fallback: boolean): boolean`
  - `loadRuntimeConfig(env: Record<string, string | undefined>): RuntimeConfig`

- [ ] **Step 1: Write the failing test**

`services/pi-runtime/src/runtime-config.test.ts`：

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadRuntimeConfig, parseBool, parsePositiveInt, DEFAULT_RUNTIME_CONFIG } from "./runtime-config.js";

describe("parsePositiveInt", () => {
	it("合法正整数原样返回", () => {
		assert.equal(parsePositiveInt("1800000", 1), 1800000);
	});
	it("非数字 / 0 / 负数 / 空串一律回退", () => {
		assert.equal(parsePositiveInt("abc", 7), 7);
		assert.equal(parsePositiveInt("0", 7), 7);
		assert.equal(parsePositiveInt("-5", 7), 7);
		assert.equal(parsePositiveInt("", 7), 7);
		assert.equal(parsePositiveInt(undefined, 7), 7);
	});
	it("小数截断为整数", () => {
		assert.equal(parsePositiveInt("12.9", 7), 12);
	});
});

describe("parseBool", () => {
	it("true/1/yes 为真；false/0/no 为假；其余回退", () => {
		assert.equal(parseBool("true", false), true);
		assert.equal(parseBool("1", false), true);
		assert.equal(parseBool("false", true), false);
		assert.equal(parseBool("0", true), false);
		assert.equal(parseBool("maybe", true), true);
	});
});

describe("loadRuntimeConfig", () => {
	it("空 env 返回默认值", () => {
		const cfg = loadRuntimeConfig({});
		assert.equal(cfg.sessionTtlMs, DEFAULT_RUNTIME_CONFIG.sessionTtlMs);
		assert.equal(cfg.sessionsMaxBytes, DEFAULT_RUNTIME_CONFIG.sessionsMaxBytes);
		assert.equal(cfg.compaction, DEFAULT_RUNTIME_CONFIG.compaction);
	});
	it("dataRoot 缺省为 cwd 下 .pi-runtime-data（对齐既有 DATA_ROOT 语义）", () => {
		const cfg = loadRuntimeConfig({});
		assert.equal(cfg.dataRoot, process.env.PI_RUNTIME_DATA_DIR ?? join(process.cwd(), ".pi-runtime-data"));
	});
	it("env 覆盖生效且非法值回退到默认", () => {
		const cfg = loadRuntimeConfig({
			PI_RUNTIME_DATA_DIR: "/data/sessions",
			PI_RUNTIME_SESSION_TTL_MS: "60000",
			PI_RUNTIME_SESSION_SWEEP_MS: "oops",
			PI_RUNTIME_SESSIONS_MAX_COUNT: "5",
			PI_RUNTIME_COMPACTION_ENABLED: "false",
			PI_RUNTIME_COMPACTION_RESERVE_TOKENS: "1024",
		});
		assert.equal(cfg.dataRoot, "/data/sessions");
		assert.equal(cfg.sessionTtlMs, 60000);
		assert.equal(cfg.sweepIntervalMs, DEFAULT_RUNTIME_CONFIG.sweepIntervalMs);
		assert.equal(cfg.sessionsMaxCount, 5);
		assert.equal(cfg.compaction.enabled, false);
		assert.equal(cfg.compaction.reserveTokens, 1024);
		assert.equal(cfg.compaction.keepRecentTokens, DEFAULT_RUNTIME_CONFIG.compaction.keepRecentTokens);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/pi-runtime && node --import tsx --test src/runtime-config.test.ts`
Expected: FAIL — `Cannot find module './runtime-config.js'`

- [ ] **Step 3: Write minimal implementation**

`services/pi-runtime/src/runtime-config.ts`：

```ts
/**
 * 运行期配置单一解析处（spec §5.6）。
 *
 * 归口理由：TTL / 磁盘上限 / compaction 参数此前没有归属地（env 读取散落在
 * session-manager / model-assembly / index 三处），新增参数无处可放。
 */
import { join } from "node:path";

export interface CompactionConfig {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export interface RuntimeConfig {
	dataRoot: string;
	/** 内存句柄 idle 回收阈值（磁盘永不因 TTL 删除）。 */
	sessionTtlMs: number;
	/** sweeper 扫描周期。 */
	sweepIntervalMs: number;
	sessionsMaxBytes: number;
	sessionsMaxCount: number;
	compaction: CompactionConfig;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
	dataRoot: join(process.cwd(), ".pi-runtime-data"),
	sessionTtlMs: 1_800_000,
	sweepIntervalMs: 300_000,
	sessionsMaxBytes: 3_221_225_472,
	sessionsMaxCount: 200,
	// 与 vendor DEFAULT_COMPACTION_SETTINGS 同值：显式化以便配置面可见可调
	compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
};

/** 正整数解析：非法（非数字 / 0 / 负数 / 空）一律回退，小数截断。 */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
	if (raw === undefined) return fallback;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return n;
}

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

export function parseBool(raw: string | undefined, fallback: boolean): boolean {
	if (raw === undefined) return fallback;
	const v = raw.trim().toLowerCase();
	if (TRUE_VALUES.has(v)) return true;
	if (FALSE_VALUES.has(v)) return false;
	return fallback;
}

export function loadRuntimeConfig(env: Record<string, string | undefined>): RuntimeConfig {
	const d = DEFAULT_RUNTIME_CONFIG;
	return {
		dataRoot: env.PI_RUNTIME_DATA_DIR ?? d.dataRoot,
		sessionTtlMs: parsePositiveInt(env.PI_RUNTIME_SESSION_TTL_MS, d.sessionTtlMs),
		sweepIntervalMs: parsePositiveInt(env.PI_RUNTIME_SESSION_SWEEP_MS, d.sweepIntervalMs),
		sessionsMaxBytes: parsePositiveInt(env.PI_RUNTIME_SESSIONS_MAX_BYTES, d.sessionsMaxBytes),
		sessionsMaxCount: parsePositiveInt(env.PI_RUNTIME_SESSIONS_MAX_COUNT, d.sessionsMaxCount),
		compaction: {
			enabled: parseBool(env.PI_RUNTIME_COMPACTION_ENABLED, d.compaction.enabled),
			reserveTokens: parsePositiveInt(env.PI_RUNTIME_COMPACTION_RESERVE_TOKENS, d.compaction.reserveTokens),
			keepRecentTokens: parsePositiveInt(env.PI_RUNTIME_COMPACTION_KEEP_RECENT_TOKENS, d.compaction.keepRecentTokens),
		},
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/pi-runtime && node --import tsx --test src/runtime-config.test.ts`
Expected: PASS（3 个 describe 全绿）

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/runtime-config.ts services/pi-runtime/src/runtime-config.test.ts
git commit -m "feat(pi-runtime): 运行期配置单一解析处（TTL / 磁盘上限 / compaction 参数）"
```

---

### Task 2: 磁盘保留策略（LRU 纯函数 + 收集 + 执行）

**Files:**
- Create: `services/pi-runtime/src/session-retention.ts`
- Test: `services/pi-runtime/src/session-retention.test.ts`

**Interfaces:**
- Consumes: `RuntimeConfig` 的 `dataRoot / sessionsMaxBytes / sessionsMaxCount`（Task 1）
- Produces:
  - `interface RetentionEntry { key: string; bytes: number; mtimeMs: number }`
  - `interface RetentionLimits { maxBytes: number; maxCount: number }`
  - `pickLruVictims(entries: RetentionEntry[], limits: RetentionLimits, active: ReadonlySet<string>): RetentionEntry[]`
  - `collectSessionDirs(dataRoot: string): Promise<RetentionEntry[]>`
  - `enforceRetention(dataRoot: string, limits: RetentionLimits, active: ReadonlySet<string>): Promise<string[]>`

- [ ] **Step 1: Write the failing test**

`services/pi-runtime/src/session-retention.test.ts`：

```ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectSessionDirs, enforceRetention, pickLruVictims, type RetentionEntry } from "./session-retention.js";

const e = (key: string, bytes: number, mtimeMs: number): RetentionEntry => ({ key, bytes, mtimeMs });
const LIMITS = { maxBytes: 1000, maxCount: 3 };

describe("pickLruVictims", () => {
	it("未超限返回空", () => {
		assert.deepEqual(pickLruVictims([e("a", 10, 1), e("b", 10, 2)], LIMITS, new Set()), []);
	});
	it("空目录列表返回空", () => {
		assert.deepEqual(pickLruVictims([], LIMITS, new Set()), []);
	});
	it("只超 count：按 mtime 最旧优先淘汰到限内", () => {
		const out = pickLruVictims([e("new", 10, 300), e("old", 10, 100), e("mid", 10, 200), e("older", 10, 50)], LIMITS, new Set());
		assert.deepEqual(out.map((x) => x.key), ["older"]);
	});
	it("只超 bytes：淘汰到字节回到限内", () => {
		const out = pickLruVictims([e("a", 400, 1), e("b", 400, 2), e("c", 400, 3)], LIMITS, new Set());
		assert.deepEqual(out.map((x) => x.key), ["a", "b"]);
	});
	it("active 集合被跳过（活跃会话不因 LRU 被删）", () => {
		const out = pickLruVictims([e("active-old", 10, 1), e("b", 10, 2), e("c", 10, 3), e("d", 10, 4)], LIMITS, new Set(["active-old"]));
		assert.deepEqual(out.map((x) => x.key), ["b"]);
	});
	it("全部 active 时返回空（宁可超限也不删活跃）", () => {
		const out = pickLruVictims([e("a", 10, 1), e("b", 10, 2), e("c", 10, 3), e("d", 10, 4)], LIMITS, new Set(["a", "b", "c", "d"]));
		assert.deepEqual(out, []);
	});
});

describe("collectSessionDirs / enforceRetention", () => {
	it("收集目录并累计字节；执行后最旧目录被物理删除", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-retention-"));
		try {
			for (const [name, age] of [["old", 100], ["mid", 200], ["new", 300]] as const) {
				mkdirSync(join(root, name, "sessions"), { recursive: true });
				writeFileSync(join(root, name, "sessions", "s.jsonl"), "x".repeat(50));
				utimesSync(join(root, name), age, age);
			}
			const entries = await collectSessionDirs(root);
			assert.equal(entries.length, 3);
			assert.ok(entries.every((x) => x.bytes > 0));
			const removed = await enforceRetention(root, { maxBytes: 1_000_000, maxCount: 2 }, new Set());
			assert.deepEqual(removed, ["old"]);
			const after = await collectSessionDirs(root);
			assert.deepEqual(after.map((x) => x.key).sort(), ["mid", "new"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("根目录不存在时返回空数组且不抛", async () => {
		assert.deepEqual(await collectSessionDirs("/nonexistent/pi-runtime-x"), []);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/pi-runtime && node --import tsx --test src/session-retention.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

`services/pi-runtime/src/session-retention.ts`：

```ts
/**
 * 磁盘会话保留策略（spec §4 磁盘上限判据、§5.2 D2）。
 *
 * 纪律：TTL 永不删磁盘；删磁盘只由本模块的 LRU 触发，且**跳过 active 集合**
 * （内存中活跃的会话目录不得被删，否则正在进行的 run 会丢工作目录）。
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export interface RetentionEntry {
	key: string;
	bytes: number;
	mtimeMs: number;
}

export interface RetentionLimits {
	maxBytes: number;
	maxCount: number;
}

/** 按 mtime 升序淘汰，直到 count 与 bytes 双双回到限内；active 永不入选。 */
export function pickLruVictims(
	entries: RetentionEntry[],
	limits: RetentionLimits,
	active: ReadonlySet<string>,
): RetentionEntry[] {
	const candidates = entries.filter((x) => !active.has(x.key)).sort((a, b) => a.mtimeMs - b.mtimeMs);
	let count = entries.length;
	let bytes = entries.reduce((sum, x) => sum + x.bytes, 0);
	const victims: RetentionEntry[] = [];
	for (const candidate of candidates) {
		if (count <= limits.maxCount && bytes <= limits.maxBytes) break;
		victims.push(candidate);
		count -= 1;
		bytes -= candidate.bytes;
	}
	return victims;
}

/** 扫描 dataRoot 下的会话目录（一层子目录），累计字节与 mtime。根不存在返回空。 */
export async function collectSessionDirs(dataRoot: string): Promise<RetentionEntry[]> {
	let names: string[];
	try {
		const dirents = await readdir(dataRoot, { withFileTypes: true });
		names = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
	} catch {
		return [];
	}
	const entries: RetentionEntry[] = [];
	for (const name of names) {
		const dir = join(dataRoot, name);
		try {
			const st = await stat(dir);
			entries.push({ key: name, bytes: await directoryBytes(dir), mtimeMs: st.mtimeMs });
		} catch {
			// 扫描竞态（目录刚被删）：跳过，不影响其余条目
		}
	}
	return entries;
}

async function directoryBytes(dir: string): Promise<number> {
	let total = 0;
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop() as string;
		const dirents = await readdir(current, { withFileTypes: true }).catch(() => []);
		for (const dirent of dirents) {
			const path = join(current, dirent.name);
			if (dirent.isDirectory()) {
				stack.push(path);
				continue;
			}
			const st = await stat(path).catch(() => null);
			if (st) total += st.size;
		}
	}
	return total;
}

/** 执行一次保留扫描；返回被删除的会话 key 列表。 */
export async function enforceRetention(
	dataRoot: string,
	limits: RetentionLimits,
	active: ReadonlySet<string>,
): Promise<string[]> {
	const entries = await collectSessionDirs(dataRoot);
	const victims = pickLruVictims(entries, limits, active);
	for (const victim of victims) {
		await rm(join(dataRoot, victim.key), { recursive: true, force: true }).catch(() => {});
	}
	return victims.map((v) => v.key);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/pi-runtime && node --import tsx --test src/session-retention.test.ts`
Expected: PASS（8 个 it 全绿）

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/session-retention.ts services/pi-runtime/src/session-retention.test.ts
git commit -m "feat(pi-runtime): 磁盘会话保留策略（LRU 纯函数 + 活跃会话豁免）"
```

---

### Task 3: 会话键与提示装配纯函数

**Files:**
- Modify: `services/pi-runtime/src/session-manager.ts`（新增导出函数与类型，位于 `withForcedSkills` 之后）
- Test: `services/pi-runtime/src/session-keys.test.ts`（新文件；避免与既有 `session-manager.test.ts` 的桩件混在一起）

**Interfaces:**
- Consumes: `SidebarAttachment`（`./tools/types.js`）
- Produces:
  - `interface TurnContext { dynamicBlocks?: string[]; attachments?: SidebarAttachment[]; mentionedKeys?: string[]; refOrder?: string[]; focusNodeId?: string }`
  - `interface LlmIdentity { provider: string; model: string }`
  - `toSessionKey(threadKey: string): string`
  - `composeSystemPrompt(staticPart: string, dynamicBlocks: readonly string[]): string`
  - `isSameLlmIdentity(a: LlmIdentity, b: LlmIdentity): boolean`
  - `isTurnContextEqual(a: TurnContext, b: TurnContext): boolean`

- [ ] **Step 1: Write the failing test**

`services/pi-runtime/src/session-keys.test.ts`：

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { composeSystemPrompt, isSameLlmIdentity, isTurnContextEqual, toSessionKey } from "./session-manager.js";

describe("toSessionKey", () => {
	it("确定性：同输入同输出", () => {
		assert.equal(toSessionKey("s1:t1"), toSessionKey("s1:t1"));
	});
	it("非法字符替换为 _，并追加原文哈希前 8 位", () => {
		const key = toSessionKey("s1:t1");
		assert.match(key, /^s1_t1-[0-9a-f]{8}$/);
	});
	it("无碰撞：仅非法字符不同的两键不相等", () => {
		assert.notEqual(toSessionKey("a:b"), toSessionKey("a_b"));
		assert.notEqual(toSessionKey("a:b"), toSessionKey("a/b"));
	});
	it("纯字母数字键保持可读（前缀即原文）", () => {
		assert.ok(toSessionKey("abc-123").startsWith("abc-123-"));
	});
	it("空串 / 纯空白拒绝", () => {
		assert.throws(() => toSessionKey(""), /non-empty/);
		assert.throws(() => toSessionKey("   "), /non-empty/);
	});
	it("两端空白被 trim 后再处理", () => {
		assert.equal(toSessionKey("  s1:t1  "), toSessionKey("s1:t1"));
	});
});

describe("composeSystemPrompt", () => {
	it("静态段在前、动态段在后、空段过滤", () => {
		assert.equal(composeSystemPrompt("RULES", ["CANVAS", "SIDEBAR"]), "RULES\n\nCANVAS\n\nSIDEBAR");
	});
	it("无动态段原样返回静态段", () => {
		assert.equal(composeSystemPrompt("RULES", []), "RULES");
	});
	it("静态段为空时只返回动态段", () => {
		assert.equal(composeSystemPrompt("", ["CANVAS"]), "CANVAS");
	});
	it("空白动态块被过滤", () => {
		assert.equal(composeSystemPrompt("RULES", ["", "  ", "CANVAS"]), "RULES\n\nCANVAS");
	});
	it("稳定前缀必须排在动态内容之前", () => {
		const out = composeSystemPrompt("RULES", ["CANVAS"]);
		assert.ok(out.indexOf("RULES") < out.indexOf("CANVAS"));
	});
});

describe("isSameLlmIdentity", () => {
	it("同 provider 同 model 为 true", () => {
		assert.equal(isSameLlmIdentity({ provider: "agnes", model: "agnes-2.5-pro" }, { provider: "agnes", model: "agnes-2.5-pro" }), true);
	});
	it("同 provider 不同 model 为 false", () => {
		assert.equal(isSameLlmIdentity({ provider: "agnes", model: "a" }, { provider: "agnes", model: "b" }), false);
	});
	it("BYOK 与平台渠道为 false", () => {
		assert.equal(isSameLlmIdentity({ provider: "byok-abc123def456", model: "m" }, { provider: "agnes", model: "m" }), false);
	});
});

describe("isTurnContextEqual", () => {
	it("字段与数组元素全等为 true", () => {
		assert.equal(isTurnContextEqual({ dynamicBlocks: ["A"], mentionedKeys: ["I1"] }, { dynamicBlocks: ["A"], mentionedKeys: ["I1"] }), true);
	});
	it("数组顺序不同为 false", () => {
		assert.equal(isTurnContextEqual({ mentionedKeys: ["I1", "I2"] }, { mentionedKeys: ["I2", "I1"] }), false);
	});
	it("undefined 与空数组等价", () => {
		assert.equal(isTurnContextEqual({ mentionedKeys: undefined }, { mentionedKeys: [] }), true);
	});
	it("多出字段为 false", () => {
		assert.equal(isTurnContextEqual({ focusNodeId: "n1" }, {}), false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/pi-runtime && node --import tsx --test src/session-keys.test.ts`
Expected: FAIL — `composeSystemPrompt is not a function`（模块存在，命名导出缺失）

- [ ] **Step 3: Write minimal implementation**

在 `services/pi-runtime/src/session-manager.ts` 的 `withForcedSkills` 函数之后插入：

```ts
/** 每轮易变上下文（spec §5.3 T 层）：由 Nest 随 prompt 携带，不进对话历史。 */
export interface TurnContext {
	dynamicBlocks?: string[];
	attachments?: SidebarAttachment[];
	mentionedKeys?: string[];
	refOrder?: string[];
	focusNodeId?: string;
}

/** 会话身份：BYOK 时 provider 为 `byok-<12hex>`（providerRef 哈希），平台时为 `agnes`。 */
export interface LlmIdentity {
	provider: string;
	model: string;
}

const SESSION_KEY_INVALID = /[^A-Za-z0-9._-]/g;

/**
 * threadKey → 磁盘安全且可寻回的会话键（spec §4 键 sanitize 判据）。
 * `:`（threadId 的规范分隔符）等非法字符替换为 `_`，再追加原文 sha256 前 8 位保证无碰撞；
 * 非幂等——调用方（路由入口）只应用一次。
 */
export function toSessionKey(threadKey: string): string {
	const trimmed = threadKey.trim();
	if (!trimmed) throw new Error("toSessionKey requires a non-empty threadKey");
	const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 8);
	return `${trimmed.replace(SESSION_KEY_INVALID, "_")}-${digest}`;
}

/** 静态段在前、动态段尾部追加（spec §4 动态上下文判据：稳定前缀不被易变内容推到后面）。 */
export function composeSystemPrompt(staticPart: string, dynamicBlocks: readonly string[]): string {
	const blocks = dynamicBlocks.map((b) => b.trim()).filter(Boolean);
	if (blocks.length === 0) return staticPart;
	if (!staticPart) return blocks.join("\n\n");
	return `${staticPart}\n\n${blocks.join("\n\n")}`;
}

export function isSameLlmIdentity(a: LlmIdentity, b: LlmIdentity): boolean {
	return a.provider === b.provider && a.model === b.model;
}

function sameStringArray(a?: readonly string[], b?: readonly string[]): boolean {
	const left = a ?? [];
	const right = b ?? [];
	return left.length === right.length && left.every((v, i) => v === right[i]);
}

function sameAttachments(a?: readonly SidebarAttachment[], b?: readonly SidebarAttachment[]): boolean {
	const left = a ?? [];
	const right = b ?? [];
	return (
		left.length === right.length &&
		left.every(
			(v, i) =>
				(v.url ?? "") === (right[i]?.url ?? "") &&
				(v.text ?? "") === (right[i]?.text ?? "") &&
				(v.mediaType ?? "") === (right[i]?.mediaType ?? ""),
		)
	);
}

/** 判断 turnContext 是否真的变了（避免每轮无谓替换导致 systemPrompt 缓存抖动）。 */
export function isTurnContextEqual(a: TurnContext, b: TurnContext): boolean {
	return (
		sameStringArray(a.dynamicBlocks, b.dynamicBlocks) &&
		sameStringArray(a.mentionedKeys, b.mentionedKeys) &&
		sameStringArray(a.refOrder, b.refOrder) &&
		(a.focusNodeId ?? "") === (b.focusNodeId ?? "") &&
		sameAttachments(a.attachments, b.attachments)
	);
}
```

同时在文件顶部 import 补 `createHash`：

```ts
import { createHash } from "node:crypto";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/pi-runtime && node --import tsx --test src/session-keys.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/session-manager.ts services/pi-runtime/src/session-keys.test.ts
git commit -m "feat(pi-runtime): 会话键 sanitize 与提示装配纯函数（含身份/turnContext 比较）"
```

---

### Task 4: `create` 改为幂等 resume-or-create-rebuild（函数式 toolContext / systemPrompt）

**Files:**
- Modify: `services/pi-runtime/src/session-manager.ts:75-90`（`SessionEntry`）、`:139-230`（`SessionManager` 构造与 `create`）
- Modify: `services/pi-runtime/src/session-manager.test.ts`（既有断言改为调用函数形态）
- Test: `services/pi-runtime/src/session-resume.test.ts`（新文件，专测 resume 三分支）

**Interfaces:**
- Consumes: `toSessionKey` / `composeSystemPrompt` / `isSameLlmIdentity`（Task 3）、`loadRuntimeConfig`（Task 1）
- Produces:
  - `SessionManager.create(threadKey: string, opts?): Promise<{ provider: string; model: string; status: "created" | "resumed" | "rebuilt" }>`
  - `SessionManager.activeKeys(): Set<string>`（供 Task 6 保留策略豁免）
  - `SessionManager.hasKey(threadKey: string): boolean`
  - `SessionEntry` 新增字段：`identity: LlmIdentity`、`userId?: string`、`staticPrompt: string`、`turn: TurnContext`、`lastActivityAt: number`

- [ ] **Step 1: Write the failing test**

`services/pi-runtime/src/session-resume.test.ts`：

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { SessionManager } from "./session-manager.js";
import type { SessionLlmOverride } from "./model-assembly.js";

/** 记录每次 harness 创建的会话来源（新建 or 恢复），并支持断言 close 调用。 */
function makeHarnessFactory() {
	const seen: Array<{ hadEntries: boolean; toolContextIsFunction: boolean; systemPromptIsFunction: boolean }> = [];
	const closed: number[] = [];
	let n = 0;
	const factory = (async (cfg: { session: { findEntries: (q?: unknown, c?: unknown) => Promise<unknown[]> }; toolContext: unknown; systemPrompt: unknown }) => {
		n += 1;
		const entries = await cfg.session.findEntries(undefined, undefined as never).catch(() => []);
		seen.push({
			hadEntries: Array.isArray(entries) && entries.length > 0,
			toolContextIsFunction: typeof cfg.toolContext === "function",
			systemPromptIsFunction: typeof cfg.systemPrompt === "function",
		});
		const id = n;
		return {
			harness: {
				events: { on: () => () => {} },
				lane: async () => ({ prompt: async () => ({ ok: true }) }),
				close: async () => {
					closed.push(id);
				},
			},
		};
	}) as never;
	return { factory, seen, closed };
}

function withTempDataRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), "pi-runtime-resume-"));
	return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe("SessionManager.create 幂等 resume-or-create", () => {
	it("同键两次 create：harnessFactory 只调用一次，第二次 status=resumed", async () => {
		await withTempDataRoot(async (root) => {
			const { factory, seen } = makeHarnessFactory();
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, { dataRoot: root, sessionTtlMs: 10 ** 9, sweepIntervalMs: 10 ** 9, sessionsMaxBytes: 10 ** 12, sessionsMaxCount: 1000, compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } });
			const first = await sm.create("s1:t1", { userId: "u1", systemPrompt: "RULES" });
			const second = await sm.create("s1:t1", { userId: "u1", systemPrompt: "RULES" });
			assert.equal(first.status, "created");
			assert.equal(second.status, "resumed");
			assert.equal(seen.length, 1);
			assert.equal(seen[0].toolContextIsFunction, true);
			assert.equal(seen[0].systemPromptIsFunction, true);
		});
	});

	it("不同 userId 同键：抛 ConflictError 且不返回任何会话内容", async () => {
		await withTempDataRoot(async (root) => {
			const { factory } = makeHarnessFactory();
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, { dataRoot: root, sessionTtlMs: 10 ** 9, sweepIntervalMs: 10 ** 9, sessionsMaxBytes: 10 ** 12, sessionsMaxCount: 1000, compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } });
			await sm.create("s1:t1", { userId: "u1" });
			await assert.rejects(() => sm.create("s1:t1", { userId: "u2" }), /session exists/);
		});
	});

	it("身份变更（平台 → BYOK）触发 rebuilt：旧会话被 close，新会话重新建", async () => {
		await withTempDataRoot(async (root) => {
			const { factory, seen, closed } = makeHarnessFactory();
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, { dataRoot: root, sessionTtlMs: 10 ** 9, sweepIntervalMs: 10 ** 9, sessionsMaxBytes: 10 ** 12, sessionsMaxCount: 1000, compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } });
			await sm.create("s1:t1", { userId: "u1" });
			const byok: SessionLlmOverride = { model: "gpt-x", apiKey: "k", baseUrl: "https://example.invalid/v1", providerRef: "ch1", source: "user" };
			const out = await sm.create("s1:t1", { userId: "u1", llm: byok });
			assert.equal(out.status, "rebuilt");
			assert.equal(seen.length, 2);
			assert.deepEqual(closed, [1]);
			assert.ok(out.provider.startsWith("byok-"));
		});
	});

	it("内存无但磁盘有：repo.open 恢复，harness 看到既有条目，status=resumed", async () => {
		await withTempDataRoot(async (root) => {
			// 先用真实 repo 落一份磁盘会话，模拟上一个 Pod 的生命周期
			const cwd = join(root, "s1_t1-deadbeef");
			const env = new NodeExecutionEnv({ cwd });
			const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(cwd, "sessions") });
			const session = await repo.create({ cwd }, undefined as never);
			await session.appendMessage({ role: "user", content: "上一轮说过的话" } as never, undefined as never);
			await repo.close(undefined as never);

			const { factory, seen } = makeHarnessFactory();
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, { dataRoot: root, sessionTtlMs: 10 ** 9, sweepIntervalMs: 10 ** 9, sessionsMaxBytes: 10 ** 12, sessionsMaxCount: 1000, compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } });
			const out = await sm.create("s1:t1", { userId: "u1" });
			assert.equal(out.status, "resumed");
			assert.equal(seen.length, 1);
			assert.equal(seen[0].hadEntries, true);
		});
	});
});
```

**注意**：Task 4 需要在 `SessionManager` 构造函数**第 7 个参数**新增 `config: RuntimeConfig`（默认 `loadRuntimeConfig(process.env)`）。上例已按此传参。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/pi-runtime && node --import tsx --test src/session-resume.test.ts`
Expected: FAIL — `create` 返回体没有 `status`；不同 userId 不抛错；磁盘恢复不存在

- [ ] **Step 3: Write minimal implementation**

改 `services/pi-runtime/src/session-manager.ts`：

3a. 头部 import 增补：

```ts
import { loadRuntimeConfig, type RuntimeConfig } from "./runtime-config.js";
```

删除文件顶部的 `const DATA_ROOT = ...`（改由 config 提供）。

3b. `SessionEntry` 增字段：

```ts
interface SessionEntry {
	id: string;
	harness: AgentHarness<LnkpiToolContext>;
	env: NodeExecutionEnv;
	repo: JsonlSessionRepo;
	listeners: Set<EventListener>;
	buffer: NormalizedEvent[];
	unsubscribes: Array<() => void>;
	prompting: boolean;
	cancelRun?: (reason?: unknown) => void;
	userAborted?: boolean;
	nextSeq: number;
	/** create 时确定的静态段（规则 + skills index），会话期内不再变更。 */
	staticPrompt: string;
	/** 会话身份（BYOK provider 哈希），用于 create 时判定是否需重建。 */
	identity: LlmIdentity;
	/** 会话归属用户；resume 时不一致 → 409 fail-closed。 */
	userId?: string;
	/** 每轮易变上下文（spec §5.3 T 层）。 */
	turn: TurnContext;
	/** 最近一次活动时间，TTL 的唯一数据源。 */
	lastActivityAt: number;
}
```

3c. 构造函数加第 7 参：

```ts
	constructor(
		private readonly tools: AgentHarnessTool<LnkpiToolContext>[] = [],
		private readonly systemPromptDefault = process.env.PI_RUNTIME_SYSTEM_PROMPT ?? "",
		private readonly modelFactory: typeof assembleModel = assembleModel,
		private readonly harnessFactory: HarnessFactory = AgentHarness.create,
		private readonly hooks?: SessionHooks,
		private readonly skills?: SkillRegistry,
		private readonly config: RuntimeConfig = loadRuntimeConfig(process.env),
	) {}
```

3d. `create` 全量替换：

```ts
	/**
	 * 幂等 upsert（spec §5.4）：
	 *   内存命中且身份一致 → resumed（不重置历史、不重设静态段）
	 *   内存命中但身份变更 → rebuilt（关闭并删目录后按新身份重建）
	 *   仅磁盘命中         → repo.open + harness.create（vendor 自动 restoreSession）→ resumed
	 *   都没有             → created
	 * userId 不一致一律 ConflictError（fail-closed，不返回任何会话内容）。
	 */
	async create(
		threadKey: string,
		opts: { systemPrompt?: string; workingDir?: string; userId?: string; attachments?: SidebarAttachment[]; mentionedKeys?: string[]; refOrder?: string[]; focusNodeId?: string; thinkingLevel?: string; llm?: SessionLlmOverride } = {},
	): Promise<{ provider: string; model: string; status: "created" | "resumed" | "rebuilt" }> {
		const key = toSessionKey(threadKey);
		const { models, model, providerId } = this.modelFactory(opts.llm);
		const identity: LlmIdentity = { provider: providerId, model: model.id };

		const existing = this.sessions.get(key);
		if (existing) {
			if (existing.userId && existing.userId !== opts.userId) throw new ConflictError(key);
			if (!isSameLlmIdentity(existing.identity, identity)) {
				await this.destroy(key);
				const created = await this.build(key, opts, models, model, identity);
				return { ...created, status: "rebuilt" };
			}
			existing.lastActivityAt = Date.now();
			return { provider: existing.identity.provider, model: existing.identity.model, status: "resumed" };
		}

		const cwd = opts.workingDir ?? join(this.config.dataRoot, key);
		const env = new NodeExecutionEnv({ cwd });
		const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(cwd, "sessions") });
		const opened = await this.openExisting(repo, cwd);
		if (opened) {
			const built = await this.build(key, opts, models, model, identity, { env, repo, session: opened });
			return { ...built, status: "resumed" };
		}
		const created = await this.build(key, opts, models, model, identity, { env, repo });
		return { ...created, status: "created" };
	}

	/** 磁盘上存在可恢复会话时返回它（取 createdAt 最新的一条）。 */
	private async openExisting(repo: JsonlSessionRepo, cwd: string): Promise<Session | undefined> {
		const list = await repo.list({ cwd }, this.context).catch(() => []);
		const newest = list[0];
		if (!newest) return undefined;
		return repo.open(newest, this.context);
	}

	/** 建 harness（新建或恢复）并登记 entry；静态段在此定型。 */
	private async build(
		key: string,
		opts: { systemPrompt?: string; userId?: string; attachments?: SidebarAttachment[]; mentionedKeys?: string[]; refOrder?: string[]; focusNodeId?: string; thinkingLevel?: string; llm?: SessionLlmOverride },
		models: ReturnType<typeof assembleModel>["models"],
		model: ReturnType<typeof assembleModel>["model"],
		identity: LlmIdentity,
		existingFs?: { env: NodeExecutionEnv; repo: JsonlSessionRepo; session?: Session },
	): Promise<{ provider: string; model: string }> {
		const cwd = join(this.config.dataRoot, key);
		await mkdir(cwd, { recursive: true });
		const env = existingFs?.env ?? new NodeExecutionEnv({ cwd });
		const repo = existingFs?.repo ?? new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(cwd, "sessions") });
		const session = existingFs?.session ?? (await repo.create({ cwd }, this.context));

		const entry: SessionEntry = {
			id: key,
			harness: undefined as never,
			env,
			repo,
			listeners: new Set(),
			buffer: [],
			unsubscribes: [],
			prompting: false,
			nextSeq: 0,
			staticPrompt: this.composeSystemPrompt(opts.systemPrompt),
			identity,
			userId: opts.userId,
			turn: {
				attachments: opts.attachments,
				mentionedKeys: opts.mentionedKeys,
				refOrder: opts.refOrder,
				focusNodeId: opts.focusNodeId,
			},
			lastActivityAt: Date.now(),
		};

		const { harness } = await this.harnessFactory<LnkpiToolContext>(
			{
				session,
				models,
				model,
				tools: [...this.tools, ...(this.skills?.tools ?? [])],
				// 函数形态（spec §5.3/§5.4）：harness 在每次 LLM 调用前求值，读到的是最新 turn
				toolContext: () => ({ sessionId: key, userId: entry.userId, ...entry.turn }),
				systemPrompt: () => composeSystemPrompt(entry.staticPrompt, entry.turn.dynamicBlocks ?? []),
				thinkingLevel: resolveThinkingLevel(opts.thinkingLevel),
				compaction: this.config.compaction,
			},
			this.context,
		);
		entry.harness = harness;

		this.hooks?.onSessionCreated?.(key, harness);
		for (const [harnessType, sseType] of EVENT_MAP) {
			entry.unsubscribes.push(
				harness.events.on(harnessType as never, (evt: { lane?: string }) => {
					this.dispatch(entry, { type: sseType, lane: evt.lane, ts: Date.now(), data: evt });
				}),
			);
		}
		this.sessions.set(key, entry);
		return { provider: identity.provider, model: identity.model };
	}

	/** 关闭并删除：内存句柄 + 磁盘目录（身份变更 / 显式删除共用）。 */
	private async destroy(key: string): Promise<void> {
		const entry = this.sessions.get(key);
		if (!entry) return;
		for (const unsub of entry.unsubscribes) unsub();
		entry.listeners.clear();
		this.sessions.delete(key);
		await entry.harness.close(this.context).catch(() => {});
		await entry.repo.close(this.context).catch(() => {});
		await entry.env.cleanup(this.context).catch(() => {});
		await rm(join(this.config.dataRoot, key), { recursive: true, force: true }).catch(() => {});
	}

	activeKeys(): Set<string> {
		return new Set(this.sessions.keys());
	}

	hasKey(threadKey: string): boolean {
		return this.sessions.has(toSessionKey(threadKey));
	}
```

3e. `remove(id)` 改为接受 threadKey 并复用 `destroy`：

```ts
	async remove(threadKey: string): Promise<boolean> {
		const key = toSessionKey(threadKey);
		if (!this.sessions.has(key)) return false;
		await this.destroy(key);
		return true;
	}
```

3f. `subscribe` / `unsubscribe` / `abort` / `require` 的入参改 `threadKey` 并内部 `toSessionKey`（其余逻辑不变）：

```ts
	subscribe(threadKey: string, listener: EventListener, afterSeq = -1): NormalizedEvent[] {
		const entry = this.require(threadKey);
		...
	}
	unsubscribe(threadKey: string, listener: EventListener): void {
		this.sessions.get(toSessionKey(threadKey))?.listeners.delete(listener);
	}
	abort(threadKey: string): boolean {
		const entry = this.sessions.get(toSessionKey(threadKey));
		...
	}
	private require(threadKey: string): SessionEntry {
		const entry = this.sessions.get(toSessionKey(threadKey));
		if (!entry) throw new NotFoundError(threadKey);
		return entry;
	}
```

3g. `prompt` 内 `entry.cancelRun` 相关逻辑不变，但**入口**改 `const entry = this.require(threadKey)`、`entry.lastActivityAt = Date.now()`，`hooks.onPrompt?.(entry.id)` 传 key。

3h. `composeSystemPrompt`（私有方法）保留原样（拼 skills index）：

```ts
	private composeSystemPrompt(base?: string): string {
		const prompt = base || this.systemPromptDefault;
		const index = this.skills?.indexBlock ?? "";
		if (!index) return prompt;
		return prompt ? `${prompt}\n\n${index}` : index;
	}
```

- [ ] **Step 4: 更新既有测试并跑全量**

`session-manager.test.ts` 第 44–54 行的断言改为函数形态：

```ts
		const cfg = captured as { systemPrompt: (tc: unknown) => string; toolContext: (tc: unknown) => Record<string, unknown>; thinkingLevel?: string };
		assert.equal(cfg.systemPrompt(undefined), "SYS");
		assert.equal(cfg.thinkingLevel, "medium");
		const tc = cfg.toolContext(undefined);
		assert.equal(tc.userId, "u1");
		assert.equal(tc.sessionId, "s1_t1-<hash>"); // 实际断言用 toSessionKey("s1")
		assert.deepEqual(tc.mentionedKeys, ["I1"]);
		assert.equal(tc.focusNodeId, "node-1");
		assert.deepEqual((tc.attachments as unknown[])[0], { url: "https://x/a.png", mediaType: "image" });
```

（实现时用 `toSessionKey("s1")` 的真实值，不要写字面 `<hash>`。其余两个 describe 里的 `sm.create("s1", ...)` 断言 `onSessionCreated` 的 id 也要同步改为 `toSessionKey("s1")`。）

Run: `cd services/pi-runtime && node --import tsx --test "src/**/*.test.ts"`
Expected: PASS（含既有 session-manager / thinking-level / forced-skills 套件）

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/session-manager.ts services/pi-runtime/src/session-manager.test.ts services/pi-runtime/src/session-resume.test.ts
git commit -m "feat(pi-runtime): create 幂等 resume-or-create-rebuild + 函数式 toolContext/systemPrompt"
```

---

### Task 5: 每轮 turnContext 刷新 + busy 409

**Files:**
- Modify: `services/pi-runtime/src/session-manager.ts`（新增 `setTurnContext`、`BusyError`、`prompt` 入口守卫）
- Test: `services/pi-runtime/src/session-turn-context.test.ts`（新文件）

**Interfaces:**
- Consumes: `TurnContext` / `isTurnContextEqual` / `composeSystemPrompt`（Task 3）、`create` 的 `SessionEntry`（Task 4）
- Produces:
  - `BusyError extends Error`（导出）
  - `SessionManager.setTurnContext(threadKey: string, turn: TurnContext): boolean`（返回是否真的变化）
  - `SessionManager.resolveSystemPromptForTest(threadKey: string): string`（**仅测试观测口**，供断言 systemPrompt 函数返回最新动态块）

- [ ] **Step 1: Write the failing test**

`services/pi-runtime/src/session-turn-context.test.ts`：

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BusyError, SessionManager } from "./session-manager.js";
import { DEFAULT_RUNTIME_CONFIG } from "./runtime-config.js";

function makeManager(root: string) {
	let captured: {
		systemPrompt: (tc?: unknown) => string;
		toolContext: (tc?: unknown) => Record<string, unknown>;
	} = { systemPrompt: () => "", toolContext: () => ({}) };
	const factory = (async (cfg: typeof captured & { session: unknown }) => {
		captured = cfg;
		return {
			harness: {
				events: { on: () => () => {} },
				lane: async () => ({ prompt: async () => ({ ok: true }) }),
				close: async () => {},
			},
		};
	}) as never;
	const sm = new SessionManager([], "STATIC", undefined, factory, undefined, undefined, {
		...DEFAULT_RUNTIME_CONFIG,
		dataRoot: root,
	});
	return { sm, captured: () => captured };
}

describe("setTurnContext", () => {
	it("更新后 systemPrompt 函数返回最新动态块，且静态段在前", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-turn-"));
		try {
			const { sm, captured } = makeManager(root);
			await sm.create("s1:t1", {});
			assert.equal(captured().systemPrompt(), "STATIC");
			const changed = sm.setTurnContext("s1:t1", { dynamicBlocks: ["当前画布摘要：{}"], mentionedKeys: ["I1"] });
			assert.equal(changed, true);
			assert.equal(captured().systemPrompt(), "STATIC\n\n当前画布摘要：{}");
			assert.deepEqual(captured().toolContext().mentionedKeys, ["I1"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("相同 turnContext 返回 false（不触发无谓刷新）", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-turn-"));
		try {
			const { sm } = makeManager(root);
			await sm.create("s1:t1", {});
			const turn = { dynamicBlocks: ["A"], mentionedKeys: ["I1"] };
			assert.equal(sm.setTurnContext("s1:t1", turn), true);
			assert.equal(sm.setTurnContext("s1:t1", { dynamicBlocks: ["A"], mentionedKeys: ["I1"] }), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("未创建会话时抛 NotFoundError", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-turn-"));
		const { sm } = makeManager(root);
		assert.throws(() => sm.setTurnContext("nope", {}), /session not found/);
		rmSync(root, { recursive: true, force: true });
	});
});

describe("prompt 并发守卫", () => {
	it("run 进行中再次 prompt 抛 BusyError；run 结束后可再 prompt", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-busy-"));
		try {
			let release: (v: unknown) => void = () => {};
			const gate = new Promise((resolve) => {
				release = resolve;
			});
			const factory = (async () => ({
				harness: {
					events: { on: () => () => {} },
					lane: async () => ({
						prompt: async () => {
							await gate;
							return { ok: true };
						},
					}),
					close: async () => {},
				},
			})) as never;
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, { ...DEFAULT_RUNTIME_CONFIG, dataRoot: root });
			await sm.create("s1:t1", {});
			await sm.prompt("s1:t1", "第一条");
			await assert.rejects(() => sm.prompt("s1:t1", "第二条"), (err: Error) => err instanceof BusyError);
			release(undefined);
			await new Promise((r) => setTimeout(r, 0));
			await sm.prompt("s1:t1", "第三条");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/pi-runtime && node --import tsx --test src/session-turn-context.test.ts`
Expected: FAIL — `setTurnContext is not a function`、`BusyError` 未导出

- [ ] **Step 3: Write minimal implementation**

在 `session-manager.ts` 中：

3a. 新增错误类（紧随 `NotFoundError` 之后）：

```ts
export class BusyError extends Error {
	constructor(id: string) {
		super(`session busy: ${id}`);
	}
}
```

3b. `SessionManager` 新增方法：

```ts
	/** 每轮刷新易变上下文；返回是否真的变化（供 metrics/日志）。 */
	setTurnContext(threadKey: string, turn: TurnContext): boolean {
		const entry = this.require(threadKey);
		const changed = !isTurnContextEqual(entry.turn, { ...entry.turn, ...turn });
		if (changed) entry.turn = { ...entry.turn, ...turn };
		entry.lastActivityAt = Date.now();
		return changed;
	}

	/** 测试观测口：按会话当前 turn 求值 systemPrompt（与 harness 内部同一组合函数）。 */
	resolveSystemPromptForTest(threadKey: string): string {
		const entry = this.require(threadKey);
		return composeSystemPrompt(entry.staticPrompt, entry.turn.dynamicBlocks ?? []);
	}
```

3c. `prompt` 入口加守卫（在 `const entry = this.require(threadKey);` 之后立即）：

```ts
		if (entry.prompting) throw new BusyError(entry.id);
```

3d. `setTurnContext` 需要在 Task 4 的 `entry.turn` 合并基础上工作——注意 `{ ...entry.turn, ...turn }` 的语义是**逐字段覆盖**（未传的字段保留上一轮值），与 spec §5.4「第一次 prompt 的 turnContext 整体覆盖」一致：Nest 每轮都发送完整 turnContext，因此保留字段不会被误用。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/pi-runtime && node --import tsx --test "src/**/*.test.ts"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/session-manager.ts services/pi-runtime/src/session-turn-context.test.ts
git commit -m "feat(pi-runtime): 每轮 turnContext 刷新 + 并发 prompt 409 守卫"
```

---

### Task 6: TTL sweeper 与磁盘 LRU 接线

**Files:**
- Modify: `services/pi-runtime/src/session-manager.ts`（新增 `startSweeper` / `stopSweeper` / `sweepOnce`）
- Test: `services/pi-runtime/src/session-sweeper.test.ts`（新文件）

**Interfaces:**
- Consumes: `pickLruVictims` / `enforceRetention`（Task 2）、`RuntimeConfig`（Task 1）、`activeKeys()`（Task 4）
- Produces:
  - `SessionManager.sweepOnce(now?: number): Promise<{ closed: string[]; removedFromDisk: string[] }>`
  - `SessionManager.startSweeper(): void` / `SessionManager.stopSweeper(): void`

- [ ] **Step 1: Write the failing test**

`services/pi-runtime/src/session-sweeper.test.ts`：

```ts
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, toSessionKey } from "./session-manager.js";
import { DEFAULT_RUNTIME_CONFIG } from "./runtime-config.js";

function makeManager(root: string, overrides = {}) {
	const closed: string[] = [];
	const factory = (async () => ({
		harness: {
			events: { on: () => () => {} },
			lane: async () => ({ prompt: async () => ({ ok: true }) }),
			close: async () => {
				closed.push("x");
			},
		},
	})) as never;
	const sm = new SessionManager([], "", undefined, factory, undefined, undefined, {
		...DEFAULT_RUNTIME_CONFIG,
		dataRoot: root,
		sweepIntervalMs: 10 ** 6,
		...overrides,
	});
	return { sm, closed };
}

describe("sweepOnce TTL", () => {
	it("超过 TTL 的会话被关闭内存句柄，但磁盘目录保留", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-sweep-"));
		try {
			const { sm, closed } = makeManager(root, { sessionTtlMs: 1000 });
			await sm.create("s1:t1", {});
			const key = toSessionKey("s1:t1");
			const dir = join(root, key);
			assert.ok(readdirSync(root).includes(key));
			// 人为把最后活动时间推到 10s 前
			const out = await sm.sweepOnce(Date.now() + 10_000);
			assert.deepEqual(out.closed, [key]);
			assert.equal(closed.length, 1);
			assert.ok(readdirSync(root).includes(key), "磁盘目录必须保留");
			assert.equal(sm.hasKey("s1:t1"), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("活跃（prompting）中的会话不被回收", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-sweep-"));
		try {
			let release: (v: unknown) => void = () => {};
			const gate = new Promise((r) => {
				release = r;
			});
			const factory = (async () => ({
				harness: { events: { on: () => () => {} }, lane: async () => ({ prompt: async () => { await gate; return { ok: true }; } }), close: async () => {} },
			})) as never;
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, { ...DEFAULT_RUNTIME_CONFIG, dataRoot: root, sessionTtlMs: 1000 });
			await sm.create("s1:t1", {});
			await sm.prompt("s1:t1", "长任务");
			const out = await sm.sweepOnce(Date.now() + 10_000);
			assert.deepEqual(out.closed, []);
			release(undefined);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("sweepOnce 磁盘 LRU", () => {
	it("超 count 时删最旧目录，且活跃会话目录不被删", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-sweep-lru-"));
		try {
			// 造 3 个"历史遗留"目录（无内存会话），mtime 递增
			["aaaa-11111111", "bbbb-22222222", "cccc-33333333"].forEach((name, i) => {
				mkdirSync(join(root, name), { recursive: true });
				writeFileSync(join(root, name, "sessions.jsonl"), "x".repeat(10));
				utimesSync(join(root, name), 100 + i * 10, 100 + i * 10);
			});
			const { sm } = makeManager(root, { sessionsMaxCount: 2, sessionTtlMs: 10 ** 9 });
			await sm.create("live:t1", {}); // 活跃会话，其目录必须豁免
			const out = await sm.sweepOnce();
			assert.ok(out.removedFromDisk.includes("aaaa-11111111"));
			const remaining = readdirSync(root);
			assert.ok(remaining.includes(toSessionKey("live:t1")), "活跃会话目录不得被删");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/pi-runtime && node --import tsx --test src/session-sweeper.test.ts`
Expected: FAIL — `sweepOnce is not a function`

- [ ] **Step 3: Write minimal implementation**

在 `session-manager.ts` 增补（import `enforceRetention`）：

```ts
import { enforceRetention } from "./session-retention.js";
```

```ts
	private sweeper?: NodeJS.Timeout;
	/** 正在跑 run 的会话不参与 TTL 回收（长任务期间不能把会话抽走）。 */
	private runningKeys(): Set<string> {
		const running = new Set<string>();
		for (const [key, entry] of this.sessions) if (entry.prompting) running.add(key);
		return running;
	}

	/**
	 * 一次回收：TTL 只关内存（磁盘保留）；磁盘 LRU 跳过「内存中活跃 + 正在跑 run」。
	 * `now` 可注入，便于测试。
	 */
	async sweepOnce(now = Date.now()): Promise<{ closed: string[]; removedFromDisk: string[] }> {
		const closed: string[] = [];
		for (const [key, entry] of [...this.sessions]) {
			if (entry.prompting) continue;
			if (now - entry.lastActivityAt < this.config.sessionTtlMs) continue;
			await this.destroyMemoryOnly(key);
			closed.push(key);
		}
		const protectedKeys = new Set<string>([...this.sessions.keys(), ...this.runningKeys()]);
		const removedFromDisk = await enforceRetention(
			this.config.dataRoot,
			{ maxBytes: this.config.sessionsMaxBytes, maxCount: this.config.sessionsMaxCount },
			protectedKeys,
		);
		return { closed, removedFromDisk };
	}

	/** 只释放内存句柄（harness/repo/env close），**不删磁盘**。 */
	private async destroyMemoryOnly(key: string): Promise<void> {
		const entry = this.sessions.get(key);
		if (!entry) return;
		for (const unsub of entry.unsubscribes) unsub();
		entry.listeners.clear();
		this.sessions.delete(key);
		await entry.harness.close(this.context).catch(() => {});
		await entry.repo.close(this.context).catch(() => {});
		await entry.env.cleanup(this.context).catch(() => {});
	}

	startSweeper(): void {
		if (this.sweeper) return;
		this.sweeper = setInterval(() => {
			void this.sweepOnce().catch(() => {});
		}, this.config.sweepIntervalMs);
		// 不让 sweeper 拖住进程退出
		this.sweeper.unref?.();
	}

	stopSweeper(): void {
		if (!this.sweeper) return;
		clearInterval(this.sweeper);
		this.sweeper = undefined;
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/pi-runtime && node --import tsx --test "src/**/*.test.ts"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/session-manager.ts services/pi-runtime/src/session-sweeper.test.ts
git commit -m "feat(pi-runtime): TTL 回收内存句柄 + 磁盘 LRU（活跃会话双豁免）"
```

---

### Task 7: 路由抽取 `app.ts` 与契约变更

**Files:**
- Create: `services/pi-runtime/src/app.ts`
- Modify: `services/pi-runtime/src/index.ts`（退化为 bootstrap）
- Test: `services/pi-runtime/src/app.test.ts`（新文件）

**Interfaces:**
- Consumes: `SessionManager`（Task 4/5/6，含 `create` 的 `status`、`BusyError`、`setTurnContext`、`startSweeper`）
- Produces:
  - `buildApp(manager: SessionManager, deps: { metrics: Metrics; version: string }): FastifyInstance`
  - 契约：`POST /sessions` → 201/200 `{sessionId, provider, model, status}`；`POST /sessions/:key/prompt` body `{text, lane?, forceSkills?, turnContext?}` → 409 `{error:"session busy"}`；`GET /sessions/:key/events?lastEventId=` 保持 P0-③ 语义

- [ ] **Step 1: Write the failing test**

`services/pi-runtime/src/app.test.ts`：

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import { SessionManager } from "./session-manager.js";
import { Metrics } from "./metrics.js";
import { DEFAULT_RUNTIME_CONFIG } from "./runtime-config.js";

function makeApp(root: string) {
	const factory = (async () => ({
		harness: {
			events: { on: () => () => {} },
			lane: async () => ({ prompt: async () => ({ ok: true }) }),
			close: async () => {},
		},
	})) as never;
	const manager = new SessionManager([], "", undefined, factory, undefined, undefined, { ...DEFAULT_RUNTIME_CONFIG, dataRoot: root });
	return buildApp(manager, { metrics: new Metrics(), version: "test" });
}

describe("POST /sessions 幂等契约", () => {
	it("首次 201 status=created；同键再次 200 status=resumed", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-app-"));
		const app = makeApp(root);
		try {
			const a = await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1" } });
			assert.equal(a.statusCode, 201);
			assert.equal(a.json().status, "created");
			const b = await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1" } });
			assert.equal(b.statusCode, 200);
			assert.equal(b.json().status, "resumed");
		} finally {
			await app.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("不同 userId 同键 → 409", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-app-"));
		const app = makeApp(root);
		try {
			await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1" } });
			const conflict = await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u2" } });
			assert.equal(conflict.statusCode, 409);
			assert.ok(!JSON.stringify(conflict.json()).includes("provider"));
		} finally {
			await app.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("POST /sessions/:key/prompt 契约", () => {
	it("turnContext 透传生效：事件缓冲重放不报错且 202 accepted", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-app-"));
		const app = makeApp(root);
		try {
			await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1" } });
			const res = await app.inject({
				method: "POST",
				url: "/sessions/s1:t1/prompt",
				payload: { text: "你好", turnContext: { dynamicBlocks: ["当前画布摘要：{}"], mentionedKeys: ["I1"] } },
			});
			assert.equal(res.statusCode, 202);
			assert.equal(res.json().accepted, true);
		} finally {
			await app.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("旧 Nest 请求（无 turnContext）仍可用", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-app-"));
		const app = makeApp(root);
		try {
			await app.inject({ method: "POST", url: "/sessions", payload: { sessionId: "s1:t1", userId: "u1" } });
			const res = await app.inject({ method: "POST", url: "/sessions/s1:t1/prompt", payload: { text: "你好" } });
			assert.equal(res.statusCode, 202);
		} finally {
			await app.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/pi-runtime && node --import tsx --test src/app.test.ts`
Expected: FAIL — `Cannot find module './app.js'`

- [ ] **Step 3: Write minimal implementation**

3a. 新建 `services/pi-runtime/src/app.ts`：把 `index.ts` 现有的 Fastify 实例构造与全部路由**逐条搬移**（`/healthz`、`/readyz`、`/metrics`、`/skills`、`POST /sessions`、`POST /sessions/:sessionId/prompt`、`POST /sessions/:sessionId/abort`、`GET /sessions/:sessionId/events`、`DELETE /sessions/:sessionId`），改为导出工厂：

```ts
/**
 * 路由装配（自 index.ts 抽出，spec §9）：唯一目的是让路由可被 `app.inject` 测试。
 * 现状 index.ts 在 import 时即 listen()，测试无法引用——不抽则 S4/契约无处可测。
 */
import Fastify, { type FastifyInstance } from "fastify";
import type { Metrics } from "./metrics.js";
import { routeLabel } from "./metrics.js";
import { BusyError, SessionManager } from "./session-manager.js";

export interface AppDeps {
	metrics: Metrics;
	version: string;
}

export function buildApp(manager: SessionManager, deps: AppDeps): FastifyInstance {
	const app = Fastify({ logger: false });
	// …（原 index.ts 的 onRequest/onResponse 埋点、/healthz、/readyz、/metrics、/skills 原样搬入）

	app.post<{ Body: { sessionId?: string; systemPrompt?: string; userId?: string; thinkingLevel?: string; llm?: unknown } }>(
		"/sessions",
		async (request, reply) => {
			// …原 parseLlmOverride / 400 分支不变
			try {
				const result = await manager.create(request.body?.sessionId ?? crypto.randomUUID(), {
					systemPrompt: request.body?.systemPrompt,
					userId: request.body?.userId,
					thinkingLevel: request.body?.thinkingLevel,
					llm: llm.state === "ok" ? llm.value : undefined,
				});
				const code = result.status === "created" ? 201 : 200;
				return reply.code(code).send({ sessionId: request.body?.sessionId, ...result });
			} catch (err) {
				if (err instanceof ConflictError || err instanceof BusyError) return reply.code(409).send({ error: err.message });
				return reply.code(503).send({ error: (err as Error).message });
			}
		},
	);

	app.post<{ Params: { sessionId: string }; Body: { text: string; lane?: string; forceSkills?: string[]; turnContext?: TurnContext } }>(
		"/sessions/:sessionId/prompt",
		async (request, reply) => {
			const { sessionId } = request.params;
			try {
				if (request.body?.turnContext) manager.setTurnContext(sessionId, request.body.turnContext);
				await manager.prompt(sessionId, request.body.text, request.body.lane, { forceSkills: request.body?.forceSkills });
				return reply.code(202).send({ accepted: true });
			} catch (err) {
				if (err instanceof BusyError) return reply.code(409).send({ error: "session busy" });
				if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
				return reply.code(503).send({ error: (err as Error).message });
			}
		},
	);

	// GET /sessions/:sessionId/events（含 Querystring.lastEventId）、POST /abort、DELETE 原样搬入
	return app;
}
```

3b. `index.ts` 退化为 bootstrap：

```ts
import { buildApp } from "./app.js";
import { SessionManager } from "./session-manager.js";
import { Metrics, VERSION } from "./metrics.js";
// …既有 manager / metrics 装配保持不变
const app = buildApp(manager, { metrics, version: VERSION });
manager.startSweeper();
const start = async () => { /* 既有 listen 逻辑 */ };
void start();
```

3c. 启动期自检（spec §11 对策）：装配模型后若 `model.contextWindow` 缺失则 warn：

```ts
if (!model.contextWindow) {
	app.log.warn({ model: model.id }, "model has no contextWindow declared; auto-compaction may never trigger");
}
```

（该检查放在 `buildApp` 之外的 bootstrap 里，因为它依赖 `assembleModel()` 的返回值。）

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/pi-runtime && node --import tsx --test "src/**/*.test.ts" && pnpm typecheck`
Expected: PASS，tsc 干净

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/app.ts services/pi-runtime/src/index.ts services/pi-runtime/src/app.test.ts
git commit -m "feat(pi-runtime): 抽出 buildApp 以支持路由级测试 + /sessions 幂等 status 与 turnContext 契约"
```

---

### Task 8: metrics 四项与 compaction 事件透传

**Files:**
- Modify: `services/pi-runtime/src/metrics.ts`（新增计数与渲染）
- Modify: `services/pi-runtime/src/session-manager.ts`（compaction 事件归一 + 计数回调）
- Modify: `services/pi-runtime/src/index.ts`（把 metrics 计数接上 manager）
- Test: `services/pi-runtime/src/metrics.compaction.test.ts`（新文件）

**Interfaces:**
- Consumes: `Metrics`（既有）、`SessionManager`（Task 4/5/6）
- Produces:
  - `Metrics.observeSessionResume(outcome: "memory" | "disk" | "new" | "rebuilt"): void`
  - `Metrics.observeCompaction(result: "ok" | "error"): void`
  - `Metrics.observePromptRejection(reason: "busy"): void`
  - `SessionManager` 构造新增可选回调 `onCompaction?: (result: "ok" | "error") => void`（第 8 参）
  - `EVENT_MAP` 增 `["compaction_start", "compaction"]`，`NormalizedEventType` 增 `"compaction"`

- [ ] **Step 1: Write the failing test**

`services/pi-runtime/src/metrics.compaction.test.ts`：

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Metrics } from "./metrics.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";
import { DEFAULT_RUNTIME_CONFIG } from "./runtime-config.js";

describe("metrics 新增四项", () => {
	it("render 输出 sessions_live / resumes / compactions / rejections", () => {
		const m = new Metrics();
		m.observeSessionResume("disk");
		m.observeSessionResume("disk");
		m.observeCompaction("ok");
		m.observePromptRejection("busy");
		const text = m.render(3, "0.0.15");
		assert.match(text, /pi_runtime_sessions_live 3/);
		assert.match(text, /pi_runtime_session_resumes_total\{outcome="disk"\} 2/);
		assert.match(text, /pi_runtime_compactions_total\{result="ok"\} 1/);
		assert.match(text, /pi_runtime_prompt_rejections_total\{reason="busy"\} 1/);
	});
});

describe("compaction 事件透传", () => {
	it("harness 发 compaction_start 时归一为 compaction 事件并回调计数", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-compact-"));
		try {
			const handlers = new Map<string, (evt: unknown) => void>();
			const factory = (async () => ({
				harness: {
					events: { on: (type: string, cb: (evt: unknown) => void) => { handlers.set(type, cb); return () => {}; } },
					lane: async () => ({ prompt: async () => ({ ok: true }) }),
					close: async () => {},
				},
			})) as never;
			const results: string[] = [];
			const sm = new SessionManager([], "", undefined, factory, undefined, undefined, { ...DEFAULT_RUNTIME_CONFIG, dataRoot: root }, (r) => results.push(r));
			await sm.create("s1:t1", {});
			const events: string[] = [];
			sm.subscribe("s1:t1", (e) => events.push(e.type));
			handlers.get("compaction_start")?.({ lane: "main" });
			handlers.get("compaction_end")?.({ lane: "main" });
			assert.deepEqual(events, ["compaction", "compaction"]);
			assert.deepEqual(results, ["ok", "ok"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
```

**注**：`compaction_end` 若是 harness 侧不存在的类型，实现时应以 vendor 实际事件名为准（实现步先 grep `compaction` 事件名，例如 `compaction_start` / `compaction_finish`），并在测试中用同一组真实名称。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/pi-runtime && node --import tsx --test src/metrics.compaction.test.ts`
Expected: FAIL — `observeSessionResume is not a function`

- [ ] **Step 3: Write minimal implementation**

3a. 先确认 vendor 的 compaction 事件名：

Run: `cd vendor/earendil-works/pi/packages/agent/src/harness && grep -rn '"compaction' --include='*.ts' . | head`

按输出把 `EVENT_MAP` 里的事件名写全（本计划假定 `compaction_start` / `compaction_end` 成对存在；若实际为 `compaction_finish`，改用实际名）。

3b. `metrics.ts` 新增字段与方法（并更新文件头注释的指标清单）：

```ts
	private sessionResumes = new Map<string, number>(); // key: outcome
	private compactions = new Map<string, number>(); // key: result
	private promptRejections = new Map<string, number>(); // key: reason

	observeSessionResume(outcome: "memory" | "disk" | "new" | "rebuilt"): void {
		this.sessionResumes.set(outcome, (this.sessionResumes.get(outcome) ?? 0) + 1);
	}

	observeCompaction(result: "ok" | "error"): void {
		this.compactions.set(result, (this.compactions.get(result) ?? 0) + 1);
	}

	observePromptRejection(reason: "busy"): void {
		this.promptRejections.set(reason, (this.promptRejections.get(reason) ?? 0) + 1);
	}
```

3c. `render()` 内（`pi_runtime_sessions_active` 之后）追加：

```ts
		lines.push("# HELP pi_runtime_sessions_live Sessions resident in memory.");
		lines.push("# TYPE pi_runtime_sessions_live gauge");
		lines.push(`pi_runtime_sessions_live ${activeSessions}`);

		lines.push("# HELP pi_runtime_session_resumes_total Session create outcomes.");
		lines.push("# TYPE pi_runtime_session_resumes_total counter");
		for (const [outcome, count] of [...this.sessionResumes.entries()].sort()) {
			lines.push(`pi_runtime_session_resumes_total{outcome="${esc(outcome)}"} ${count}`);
		}

		lines.push("# HELP pi_runtime_compactions_total Context compactions by result.");
		lines.push("# TYPE pi_runtime_compactions_total counter");
		for (const [result, count] of [...this.compactions.entries()].sort()) {
			lines.push(`pi_runtime_compactions_total{result="${esc(result)}"} ${count}`);
		}

		lines.push("# HELP pi_runtime_prompt_rejections_total Prompt rejections by reason.");
		lines.push("# TYPE pi_runtime_prompt_rejections_total counter");
		for (const [reason, count] of [...this.promptRejections.entries()].sort()) {
			lines.push(`pi_runtime_prompt_rejections_total{reason="${esc(reason)}"} ${count}`);
		}
```

3d. `session-manager.ts`：`NormalizedEventType` 增 `"compaction"`；`EVENT_MAP` 增两行；构造第 8 参 `onCompaction`：

```ts
		private readonly onCompaction?: (result: "ok" | "error") => void,
```

并在 `build()` 的事件订阅循环之外单独挂一条：

```ts
		for (const [harnessType, sseType] of [["compaction_start", "compaction"], ["compaction_end", "compaction"]] as const) {
			entry.unsubscribes.push(
				harness.events.on(harnessType as never, (evt: { lane?: string }) => {
					this.onCompaction?.(harnessType === "compaction_start" ? "ok" : "ok");
					this.dispatch(entry, { type: sseType, lane: evt.lane, ts: Date.now(), data: evt });
				}),
			);
		}
```

3e. `index.ts` 把回调接上：

```ts
const manager = new SessionManager(tools, undefined, undefined, undefined, hooks, skills, runtimeConfig, (result) => metrics.observeCompaction(result));
```

并在 `/sessions` 路由按 `result.status` 调 `metrics.observeSessionResume(status === "created" ? "new" : status)`（`resumed` 时区分 memory/disk：由 `manager.create` 返回体扩展 `resumedFrom: "memory" | "disk"` 以精确计数——**实现时在 `create` 返回值上加该字段**，值为分支来源）。`/prompt` 命中 `BusyError` 时调 `metrics.observePromptRejection("busy")`。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/pi-runtime && node --import tsx --test "src/**/*.test.ts"`
Expected: PASS（含 metrics.test.ts 既有用例）

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/metrics.ts services/pi-runtime/src/session-manager.ts services/pi-runtime/src/index.ts services/pi-runtime/src/metrics.compaction.test.ts
git commit -m "feat(pi-runtime): sessions/resumes/compactions/rejections 四项指标 + compaction 事件透传"
```

---

### Task 9: Nest 侧 client 契约（幂等 create、turnContext、退役陈旧替换）

**Files:**
- Modify: `apps/server/src/agent/pi-runtime/pi-runtime.client.ts`
- Modify: `apps/server/src/agent/agent.test-utils.ts`
- Test: `apps/server/src/agent/pi-runtime/pi-runtime.client.test.ts`

**Interfaces:**
- Consumes: pi-runtime 契约（Task 7）
- Produces:
  - `CreateSessionResult` 增 `status: "created" | "resumed" | "rebuilt"`（缺省按 `"created"` 容错）
  - `interface PiTurnContext { dynamicBlocks?: string[]; attachments?: SidebarAttachment[]; mentionedKeys?: string[]; refOrder?: string[]; focusNodeId?: string }`
  - `prompt(sessionId, text, lane, opts?: { forceSkills?: string[]; turnContext?: PiTurnContext }): Promise<void>`
  - 删除 `createSessionReplacingStale`

- [ ] **Step 1: Write the failing test**

在 `pi-runtime.client.test.ts` 追加：

```ts
describe('createSession 幂等契约（P0-①）', () => {
  it('201 status=created 原样返回；200 status=resumed 原样返回', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(201, { sessionId: 's1:t1', provider: 'agnes', model: 'm', status: 'created' }))
      .mockResolvedValueOnce(jsonResponse(200, { sessionId: 's1:t1', provider: 'agnes', model: 'm', status: 'resumed' }))
    const client = new PiRuntimeClient({ baseUrl: 'http://x', fetch: fetchMock as never })
    expect((await client.createSession('s1:t1')).status).toBe('created')
    expect((await client.createSession('s1:t1')).status).toBe('resumed')
  })

  it('旧 runtime 响应缺 status 时按 created 容错（灰度期不抛）', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(201, { sessionId: 's1:t1', provider: 'agnes', model: 'm' }))
    const client = new PiRuntimeClient({ baseUrl: 'http://x', fetch: fetchMock as never })
    expect((await client.createSession('s1:t1')).status).toBe('created')
  })

  it('已删除 createSessionReplacingStale（负例锁）', () => {
    const client = new PiRuntimeClient({ baseUrl: 'http://x', fetch: vi.fn() as never })
    expect((client as unknown as Record<string, unknown>).createSessionReplacingStale).toBeUndefined()
  })
})

describe('prompt 透传 turnContext', () => {
  it('body 带 turnContext，且不带 forceSkills 时不发该字段', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(202, { accepted: true }))
    const client = new PiRuntimeClient({ baseUrl: 'http://x', fetch: fetchMock as never })
    await client.prompt('s1:t1', '你好', 'main', { turnContext: { dynamicBlocks: ['CANVAS'], mentionedKeys: ['I1'] } })
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)
    expect(body.turnContext.dynamicBlocks).toEqual(['CANVAS'])
    expect(body.forceSkills).toBeUndefined()
  })
})
```

（`jsonResponse` 沿用该测试文件既有的响应构造辅助；若不存在，用 `new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })`。）

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/agent/pi-runtime/pi-runtime.client.test.ts`
Expected: FAIL — `status` undefined；`createSessionReplacingStale` 仍存在

- [ ] **Step 3: Write minimal implementation**

3a. `pi-runtime.client.ts`：`CreateSessionResult` 加字段并容错：

```ts
async createSession(sessionId: string, opts: CreateSessionOptions = {}): Promise<CreateSessionResult> {
  const { status, body } = await this.request('/sessions', {
    method: 'POST',
    body: { sessionId, ...opts },
  })
  if (status >= 400 || !body) throw new PiRuntimeError(body?.error ?? `createSession failed: HTTP ${status}`, status)
  const parsedStatus = body.status === 'resumed' || body.status === 'rebuilt' ? body.status : 'created'
  return { ...body, status: parsedStatus }
}
```

3b. 删除 `createSessionReplacingStale` 整个方法（含其注释）。

3c. `prompt` 增 `turnContext`：

```ts
async prompt(
  sessionId: string,
  text: string,
  lane = 'main',
  opts?: { forceSkills?: string[]; turnContext?: PiTurnContext },
): Promise<void> {
  const { status } = await this.request(`/sessions/${encodeURIComponent(sessionId)}/prompt`, {
    method: 'POST',
    body: {
      text,
      lane,
      ...(opts?.forceSkills?.length ? { forceSkills: opts.forceSkills } : {}),
      ...(opts?.turnContext ? { turnContext: opts.turnContext } : {}),
    },
  })
  if (status >= 400) throw new PiRuntimeError(`prompt failed: HTTP ${status}`, status)
}
```

3d. `agent.test-utils.ts`：`PiClientStub` 类型删 `createSessionReplacingStale`，`stubPiClient` 删该方法；`createSession` 桩返回值加 `status: 'created'`。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run src/agent/pi-runtime/pi-runtime.client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/pi-runtime/pi-runtime.client.ts apps/server/src/agent/agent.test-utils.ts apps/server/src/agent/pi-runtime/pi-runtime.client.test.ts
git commit -m "feat(server): pi-runtime client 幂等 create + prompt turnContext；退役 createSessionReplacingStale"
```

---

### Task 10: Nest prompt assembler 拆静态/动态段并退役 compress-recent-turns

**Files:**
- Modify: `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.ts`
- Delete: `apps/server/src/agent/pi-runtime/compress-recent-turns.ts`、`compress-recent-turns.test.ts`
- Test: `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.test.ts`

**Interfaces:**
- Consumes: `CanvasSummaryProvider`（既有依赖）、`buildSidebarBlock`（既有）
- Produces:
  - `assembleStatic(input: { ruleGroups?: RuleGroup[] }): Promise<string>`
  - `assembleDynamic(input: { sessionId: string; attachments?: SidebarBlockInput[] }): Promise<string[]>`
  - `lastManifest` / `lastManifestDetail` 保持可用（供既有观测断言），`layers` 覆盖两段

- [ ] **Step 1: Write the failing test**

在 `pi-prompt-assembler.service.test.ts` 中替换/新增：

```ts
it('assembleStatic 只含规则段，不含画布/侧栏/近期摘要', async () => {
  const assembler = makeAssembler()
  const text = await assembler.assembleStatic({ ruleGroups: ['core', 'writeTools', 'genTools'] })
  expect(text).toContain('1.')
  expect(text).not.toContain('当前画布摘要')
  expect(text).not.toContain('近期对话摘要')
  expect(text).not.toContain('侧栏')
})

it('assembleDynamic 返回画布摘要与侧栏块（数组，供 runtime 尾部追加）', async () => {
  const assembler = makeAssembler()
  const blocks = await assembler.assembleDynamic({
    sessionId: 's1',
    attachments: [{ url: 'https://x/a.png', mediaType: 'image' }],
  })
  expect(blocks[0]).toContain('当前画布摘要')
  expect(blocks.some((b) => b.includes('a.png'))).toBe(true)
})

it('画布摘要不可用时 assembleDynamic 不抛，仅返回侧栏块', async () => {
  const assembler = makeAssembler({ canvasThrows: true })
  const blocks = await assembler.assembleDynamic({ sessionId: 's1', attachments: [{ text: 'TXT' }] })
  expect(blocks.some((b) => b.includes('当前画布摘要'))).toBe(false)
  expect(blocks.length).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/agent/pi-runtime/pi-prompt-assembler.service.test.ts`
Expected: FAIL — `assembleStatic is not a function`

- [ ] **Step 3: Write minimal implementation**

3a. 删 `compressRecentTurns` 调用与 import；把 `assemble()` 拆成两个方法（**保留 `assemble()` 作为组合便捷方法会违背退役意图，直接删除它及其调用点**）：

```ts
/** 静态段：规则组文本。会话期内不变（spec §5.3 S 层）。 */
async assembleStatic(input: { ruleGroups?: RuleGroup[] }): Promise<string> {
  const groups = input.ruleGroups ?? ['core']
  this.recordLayers([layer('rules', 'rules', composeRuleText(groups))])
  return composeRuleText(groups)
}

/**
 * 动态段：每轮变化的世界状态（画布快照 + 侧栏素材）。
 * 返回数组——由 pi-runtime 追加到 systemPrompt 尾部，不写入对话历史（spec §4 动态上下文判据）。
 */
async assembleDynamic(input: { sessionId: string; attachments?: SidebarBlockInput[] }): Promise<string[]> {
  const blocks: string[] = []
  const layers: PromptLayer[] = []
  try {
    const summary = await this.canvasTools.getCanvasSummary({ sessionId: input.sessionId })
    if (summary?.nodes) {
      layers.push(layer('canvas-summary', 'canvas', `当前画布摘要：\n${JSON.stringify(summary)}`))
    }
  } catch (err) {
    this.logger.warn(`canvas summary unavailable for ${input.sessionId}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (input.attachments?.length) {
    const block = buildSidebarBlock(input.attachments)
    if (block) layers.push(layer('sidebar', 'sidebar', block))
  }
  for (const l of layers) blocks.push(l.content)
  this.recordLayers(layers)
  return blocks
}

/** 记录 layers 与 manifest 行（既有观测口语义不变）。 */
private recordLayers(layers: PromptLayer[]): void {
  this.lastLayers = layers
  const totalTokens = layers.reduce((sum, l) => sum + l.approxTokens, 0)
  const promptHashValue = promptHash(layers.map((l) => l.content).join('\n'))
  this.lastManifestDetail = { sessionId: '', layers: layers.map((l) => ({ id: l.id, kind: l.kind, tokens: l.approxTokens })), totalTokens, promptHash: promptHashValue }
  this.lastManifest = `prompt manifest: ${layers.map((l) => `${l.id}:${l.kind}:${l.approxTokens}tok`).join(' ')} total=${totalTokens}tok hash=${promptHashValue}`
  this.logger.log(this.lastManifest)
}
```

（`PromptManifest.sessionId` 若为必填，`recordLayers` 增一个 `sessionId` 参数，由两处调用方传入——`assembleStatic` 传 `''`，`assembleDynamic` 传 `input.sessionId`。实现时以类型定义为准。）

3b. 删除 `compress-recent-turns.ts` 与 `.test.ts`（`git rm`）。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run src/agent/pi-runtime/`
Expected: PASS（该目录下全部用例；`compress-recent-turns.test.ts` 已删，不再收进测试集）

- [ ] **Step 5: Commit**

```bash
git add -A apps/server/src/agent/pi-runtime/
git commit -m "refactor(server): prompt assembler 拆静态/动态段；退役 compress-recent-turns"
```

---

### Task 11: Nest 编排层接线（不再删会话、透传 turnContext、退役会话锁）

**Files:**
- Modify: `apps/server/src/agent/agent.service.ts`（`:220-261` priorMessages 查询、`:602-624` `acquirePiSessionLock`、`:636-760` `streamFromPiRuntime`/`ensurePiSession`、`:401-405` `cancelRun`）
- Modify: `apps/server/src/agent/agent.controller.ts:243`（cancelRun 传 threadId）
- Test: `apps/server/src/agent/agent.service.pi-runtime.test.ts`、`apps/server/src/agent/cancel-run.test.ts`

**Interfaces:**
- Consumes: client 契约（Task 9）、assembler 两段（Task 10）
- Produces:
  - `AgentService.cancelRun(input: { sessionId: string; threadId?: string })`
  - `streamFromPiRuntime` 不再调用 `client.deleteSession`
  - `effectiveThreadKey(sessionId, threadId)`（私有；= `threadId?.trim() || sessionId`）

- [ ] **Step 1: Write the failing test**

在 `agent.service.pi-runtime.test.ts` 追加/替换：

```ts
it('P0-①：一轮结束后不再删除 pi 会话（负例锁）', async () => {
  const client = stubPiClient([piEvent('agent_end', {})])
  vi.spyOn(service as never, 'createPiRuntimeClient' as never).mockReturnValue(client as never)
  process.env.PI_RUNTIME_URL = 'http://pi'
  for await (const _ of service.streamChat({ sessionId: 's1', userId: 'u1', userMessage: '你好' } as never)) { /* drain */ }
  expect(client.deleteSession).not.toHaveBeenCalled()
})

it('P0-①：prompt 携带 turnContext.dynamicBlocks（画布摘要层）', async () => {
  const client = stubPiClient([piEvent('agent_end', {})])
  vi.spyOn(service as never, 'createPiRuntimeClient' as never).mockReturnValue(client as never)
  process.env.PI_RUNTIME_URL = 'http://pi'
  for await (const _ of service.streamChat({ sessionId: 's1', userId: 'u1', userMessage: '你好' } as never)) { /* drain */ }
  const [, , , opts] = client.prompt.mock.calls[0]
  expect(opts.turnContext.dynamicBlocks.join('\n')).toContain('当前画布摘要')
})

it('P0-①：会话键 = threadId（新对话即新键）', async () => {
  const client = stubPiClient([piEvent('agent_end', {})])
  vi.spyOn(service as never, 'createPiRuntimeClient' as never).mockReturnValue(client as never)
  process.env.PI_RUNTIME_URL = 'http://pi'
  for await (const _ of service.streamChat({ sessionId: 's1', threadId: 's1:t9', userId: 'u1', userMessage: '你好' } as never)) { /* drain */ }
  expect(client.createSession.mock.calls[0][0]).toBe('s1:t9')
  expect(client.prompt.mock.calls[0][0]).toBe('s1:t9')
})

it('P0-①：不再查询历史消息表（持久会话已含历史）', async () => {
  const client = stubPiClient([piEvent('agent_end', {})])
  vi.spyOn(service as never, 'createPiRuntimeClient' as never).mockReturnValue(client as never)
  process.env.PI_RUNTIME_URL = 'http://pi'
  for await (const _ of service.streamChat({ sessionId: 's1', userId: 'u1', userMessage: '你好' } as never)) { /* drain */ }
  expect(agentMessageFindMany).not.toHaveBeenCalled()
})

it('P0-①：status=rebuilt 时打 warn（上下文已丢，需可观测）', async () => {
  const client = stubPiClient([piEvent('agent_end', {})])
  client.createSession.mockResolvedValueOnce({ sessionId: 's1', provider: 'byok-abc', model: 'm', status: 'rebuilt' })
  const warn = vi.spyOn(service['piLogger'] as never, 'warn' as never).mockImplementation(() => undefined)
  vi.spyOn(service as never, 'createPiRuntimeClient' as never).mockReturnValue(client as never)
  process.env.PI_RUNTIME_URL = 'http://pi'
  for await (const _ of service.streamChat({ sessionId: 's1', userId: 'u1', userMessage: '你好' } as never)) { /* drain */ }
  expect(warn).toHaveBeenCalled()
})
```

并删除既有的 F3 用例（`priorMessages 查询`）与 `priorMessages` 相关断言。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/agent/agent.service.pi-runtime.test.ts`
Expected: FAIL — `deleteSession` 被调用；`opts.turnContext` 为 undefined；键是 `s1`

- [ ] **Step 3: Write minimal implementation**

3a. 删除 priorMessages 查询链：`agent.service.ts:220-261` 中 `priorMessages` 变量与其传入 `piContext` 的字段；`PiCanvasContext` 类型（`:61`）删 `priorMessages` 字段。

3b. 删除 `acquirePiSessionLock`（`:611-624`）与其调用点（`:274-276` 的 `releasePiLock` 及其 `finally` 里的调用）。

3c. 会话键：在 `streamFromPiRuntime` 顶部：

```ts
// P0-①：会话键 = 对话（threadId），非画布会话（sessionId）——新对话即新键、新上下文
const sessionKey = threadId?.trim() || sessionId
```

把该作用域内**所有**对 `client.*(sessionId, …)` 的调用改为 `client.*(sessionKey, …)`（`ensurePiSession` / `prompt` / `deleteSession` 已删 / `iteratePiEvents`）。若原函数在别处也用 `sessionId` 做 DB 写入（`finalizeTurn` 等），**保持不变**——DB 侧仍以 sessionId+threadId 归属。

3d. `streamFromPiRuntime` 改为：

```ts
const staticPrompt = await this.createPiPromptAssembler().assembleStatic({
  ruleGroups: ['core', 'writeTools', 'genTools'],
})
const dynamicBlocks = await this.createPiPromptAssembler().assembleDynamic({
  sessionId,
  attachments: piContext?.attachments,
})
const visionBlock = await this.buildSidebarVisionBlock({ sessionId, userId, userMessage, attachments: piContext?.attachments, model })
if (visionBlock) dynamicBlocks.push(visionBlock)

const created = await this.ensurePiSession(client, sessionKey, {
  systemPrompt: staticPrompt,
  userId,
  thinkingLevel: mapThinkingLevel(thinkingOpts?.thinking, thinkingOpts?.thinkingEffort),
  llm,
})
if (created.status === 'rebuilt') {
  this.piLogger.warn(`pi session rebuilt for key=${sessionKey} (会话身份变更，历史已重置)`)
}
...
void client.prompt(sessionKey, promptText, 'main', {
  forceSkills,
  turnContext: {
    dynamicBlocks,
    attachments: piContext?.attachments,
    mentionedKeys: piContext?.mentionedKeys,
    refOrder: piContext?.refOrder,
    focusNodeId: piContext?.focusNodeId,
  },
}).catch(() => {})
```

3e. `finally` 分支改为**不再删会话**，只清理本地 iterator：

```ts
    } finally {
      // P0-①：会话跨轮保留（历史即上下文）。回收由 pi-runtime 的 TTL/LRU 负责。
      cancelEvents()
    }
```

（`iteratePiEvents` 已返回 `cancel`；把它的返回值取出用于此处。）

3f. `ensurePiSession` 返回 `createSession` 的结果：

```ts
private async ensurePiSession(
  client: PiRuntimeClient,
  sessionKey: string,
  opts?: { systemPrompt?: string; userId?: string; thinkingLevel?: 'off' | 'medium' | 'high'; llm?: PiSessionLlmOverride },
): Promise<CreateSessionResult> {
  // P0-①：幂等 resume-or-create（重建由 pi-runtime 内部按身份判定）
  return client.createSession(sessionKey, {
    systemPrompt: opts?.systemPrompt,
    userId: opts?.userId,
    thinkingLevel: opts?.thinkingLevel,
    llm: opts?.llm,
  })
}
```

3g. `cancelRun` 用会话键：

```ts
async cancelRun(input: { sessionId: string; threadId?: string }): Promise<{ ok: boolean; skipped: boolean }> {
  if (!this.piRuntimeEnabled()) return { ok: false, skipped: true }
  const piUrl = process.env.PI_RUNTIME_URL as string
  const sessionKey = input.threadId?.trim() || input.sessionId
  return this.createPiRuntimeClient(piUrl).abortRun(sessionKey)
}
```

3h. `agent.controller.ts:243`：

```ts
const data = await this.agentService.cancelRun({ sessionId: dto.sessionId, threadId: dto.threadId })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run src/agent/ && pnpm exec tsc --noEmit`
Expected: PASS，tsc 干净

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/agent.service.ts apps/server/src/agent/agent.controller.ts apps/server/src/agent/agent.service.pi-runtime.test.ts apps/server/src/agent/cancel-run.test.ts
git commit -m "feat(server): 会话跨轮保留 + turnContext 透传；退役会话锁与历史消息查询"
```

---

### Task 12: 配置面、审视文档回填与端到端验证

**Files:**
- Modify: `charts/pi-lnk-runtime/values.yaml`（新增 7 项 env）
- Modify: `docs/discussion/2026-09-29-agent-harness-gap-review.md`（§6 推进顺序回填 P0-① 状态）
- Modify: `docs/discussion/2026-09-29-agent-harness-gap-review.md` §3.1（把「补齐方案」标注为已实施）

**Interfaces:**
- Consumes: 前 11 个任务的全部产物
- Produces: 可部署的分支 + 验收记录

- [ ] **Step 1: chart env 默认值**

`charts/pi-lnk-runtime/values.yaml` 的 `env` 段追加：

```yaml
  # P0-① 持久会话（spec §5.6）
  PI_RUNTIME_SESSION_TTL_MS: "1800000"
  PI_RUNTIME_SESSION_SWEEP_MS: "300000"
  PI_RUNTIME_SESSIONS_MAX_BYTES: "3221225472"
  PI_RUNTIME_SESSIONS_MAX_COUNT: "200"
  PI_RUNTIME_COMPACTION_ENABLED: "true"
  PI_RUNTIME_COMPACTION_RESERVE_TOKENS: "16384"
  PI_RUNTIME_COMPACTION_KEEP_RECENT_TOKENS: "20000"
```

- [ ] **Step 2: 全量本地验证**

```bash
cd services/pi-runtime && node --import tsx --test "src/**/*.test.ts" && pnpm typecheck
cd ../../apps/server && pnpm test && pnpm exec tsc --noEmit
cd ../.. && npx tsx scripts/verify-spec-figures.ts
git diff --stat origin/master -- vendor apps/web apps/server/prisma   # 必须为空
```

Expected: 全部 PASS；最后一条命令**无输出**（零改动面守住了）

- [ ] **Step 3: 审视文档回填**

`docs/discussion/2026-09-29-agent-harness-gap-review.md`：

- §6 第 2 条 `P0-①（持久会话 + compaction）` 改为：`✅ 已实现（2026-09-29，spec docs/superpowers/specs/2026-09-29-persistent-harness-session-design.md，计划 docs/superpowers/plans/2026-09-29-persistent-harness-session.md），待 PR 与部署验证`
- §3.1 的「补齐方案」段末尾追加一行 `> 实施状态：已落地（见上）`；「代价与对策」段修订为实际结论（thinkingLevel 换档由 lane setter 解决，不需要按需重建路径；BYOK 身份变更才重建）

- [ ] **Step 4: 提交并开 PR**

```bash
git add charts/pi-lnk-runtime/values.yaml docs/discussion/2026-09-29-agent-harness-gap-review.md
git commit -m "chore(chart)+docs: 持久会话 7 项 env 默认值 + 审视 §3.1/§6 状态回填"
git push -u origin feat/p0-persistent-harness-session
gh pr create --title "feat: P0-① 持久 harness 会话 + 原生 compaction" --body-file - <<'EOF'
## 是什么
同一对话跨轮复用同一 harness 会话：历史进原生 context，超限走 vendor compaction；退役为「每轮重建」而生的四套补丁。

## 依据
spec: docs/superpowers/specs/2026-09-29-persistent-harness-session-design.md
plan: docs/superpowers/plans/2026-09-29-persistent-harness-session.md

## 关键点
- 会话键 = threadId（对话）；pi-runtime 侧 toSessionKey 一次转换
- systemPrompt / toolContext 改函数形态：每次 LLM 调用前求值，动态块不进对话历史
- 退役：createSessionReplacingStale / acquirePiSessionLock / 409 竞态 / compressRecentTurns / priorMessages 查询
- 新增：TTL（内存）+ 磁盘 LRU（活跃豁免）、busy 409、4 项 metrics、7 项 env
- 零改动：vendor/**、apps/web/**、prisma/**

## 部署顺序
**pi-runtime 先于 Nest**（反序会让动态上下文静默丢失）

## 风险
BYOK 身份变更会重建会话（历史重置），Nest 侧对 status=rebuilt 打 warn 可观测
EOF
```

- [ ] **Step 5: 合并后部署与实机验收**

按 spec §10 顺序执行：先 pi-runtime 0.0.15（rsync → `docker build --no-cache` → push → helm upgrade，须带 `--set env.PI_RUNTIME_VERSION`）→ 再合入 Nest 侧部署；随后逐条走 spec §6 S1–S10 与 §10 实机五项。

---

## Self-Review 记录

**1. Spec 覆盖**：§4 全部判据 → Task 3（键/装配/身份）、Task 4（复用优先 + fail-closed）、Task 5（动态上下文 + 并发）、Task 6（回收 + LRU）、Task 7（部署顺序的容错）、Task 8（compaction 判据与观测）；§5.4 契约 → Task 7/9；§5.5 换档 → Task 4（身份比对重建）；§5.6/§5.7 → Task 1/8/12；§6 S1–S10 → Task 12 步骤 5；§8 纯函数 → Task 2/3；§9 文件清单 → Task 1–12；§12 后续包 → 不在本计划（已登记）。

**2. 占位符扫描**：无 TBD/TODO；Task 8 的 compaction 事件名给出「以 vendor 实际名为准 + 具体 grep 命令」，属实测约束而非占位符。

**3. 类型一致性**：`toSessionKey` / `composeSystemPrompt` / `isSameLlmIdentity` / `isTurnContextEqual` / `TurnContext` / `RuntimeConfig` 在 Task 1–9 间命名一致；`SessionManager.create` 返回体在 Task 4 定义、Task 7/9 消费；`sessionKey` 一词在 Nest 侧统一指「对话键」。

**4. Review Focus**：五条全部有对应测试——越权 409（Task 4/7）、TTL 回收后恢复（Task 6）、并发 busy（Task 5）、LRU 活跃豁免（Task 2/6）、旧 Nest 兼容（Task 7）。
