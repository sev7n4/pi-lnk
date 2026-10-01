# 上下文工程 P0 修复实施计划（压缩口径 / cost / 工具分层 / 焦点过滤）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按审计报告（`docs/2026-10-01-context-engineering-audit.html`）的优先级顺序修复四个 P0/P1 缺口：①压缩触发口径 ②中文 token 估算 ③cost 恒为 0 ④工具 schema 全量注入 ⑤画布摘要无焦点过滤。**全部修复只用 vendor pi-agent-core 的原生能力（`AgentHarnessOptions.compaction` / `activeToolNames` / `AgentToolResult.addedToolNames` / `usage` 事件 / `calculateCost`），零 vendor patch。**

**Architecture:** pi-runtime 侧：runtime-config 新增 targetRatio → session-manager 建会话时按 `model.contextWindow` 反推 reserveTokens；工具拆「常驻 + 延迟」两档，`load_tools` 元工具经 vendor 原生 `addedToolNames` 机制激活延迟工具；usage 事件接 metrics。apps/server 侧：`assembleDynamic` 透传 focusNodeId 做画布摘要焦点过滤；turn_usage 附带 cost。

**Tech Stack:** TypeScript / NestJS / Fastify / vendor pi-agent-core 0.85.1（只读）/ node:test（pi-runtime）+ vitest（apps/server）

**Spec:** `docs/2026-10-01-context-engineering-audit.html`（§差距清单 §落地路线）

## Global Constraints

- **vendor 红线（D-γ'）**：`vendor/earendil-works/pi/**` 只读，禁止任何 patch。所有改动只在 `services/pi-runtime/**` 与 `apps/server/**`。
- **分支纪律**：建分支前必 `git fetch`，从 `origin/master` 建新 worktree（using-git-worktrees skill）；三个 PR 串行：PR1=Task 1+2，PR2=Task 3，PR3=Task 4+5。
- **测试只跑变更相关**（禁两套全量同跑）：pi-runtime 用 `cd services/pi-runtime && node --import tsx --test src/<file>.test.ts`；apps/server 用 `node apps/server/node_modules/vitest/vitest.mjs run apps/server/src/<file>.test.ts`（worktree 内按 MEMORY.md 的软链法装依赖）。
- **落盘复核**：每次 Edit/Write 后用 `git status --short` 确认 ` M`/`??`（历史有 Edit 报成功未落盘案例）。
- **部署 env 纪律**：新增 env（`PI_RUNTIME_COMPACTION_TARGET_RATIO`、`PI_RUNTIME_TOOL_TIERING`、`AGNES_COST_*_PER_M`）是数字/浮点 → runtime-deploy.yml 跑完后**必须手工 `--set-string` 补**（rev30-32 科学计数法事故）；`feature_grep`/`feature_file` 留空。
- **前端零改动**：turn_usage 新增 cost 字段向后兼容（web 不解析则忽略）。
- 类型判据：pi-runtime `tsc --noEmit`；涉及 apps/server 时 `vue-tsc -b` 不适用，用 server 的 build。

## Review Focus

1. **极小 contextWindow（BYOK 自报 8k）**：ratio 反推不得使 reserve 为负或 ≥ window——实现里必须 clamp 到 `[16384, window − keepRecent − 1]`（窗口过小时取上限）。测试钉在 Task 1。
2. **env 优先级**：显式 `PI_RUNTIME_COMPACTION_RESERVE_TOKENS` 存在时 targetRatio 失效（旧口径完全保留）；`PI_RUNTIME_COMPACTION_TARGET_RATIO` 非法值（0/1/负数/非数字）回退旧口径。测试钉在 Task 1。
3. **load_tools 传未知/已加载工具名**：必须返回文本错误（列出可加载清单），不得 throw、不得把未知名塞进 addedToolNames。测试钉在 Task 4。
4. **`PI_RUNTIME_TOOL_TIERING=off`**：行为与现状逐字节一致——不传 activeToolNames、无 load_tools、无延迟索引块。测试钉在 Task 4。
5. **focusNodeId 指向不存在节点**：全量摘要回退（fail-open），不丢任何节点。测试钉在 Task 5。
6. **agnes 网关不回 usage**：usage 事件不出现，metrics 保持 0 不报错；cost 费率未配置时 metrics 保持 0。测试钉在 Task 3。

---

### Task 1: 压缩触发口径 —— targetRatio 按窗口反推 reserveTokens（PR1）

**Files:**
- Modify: `services/pi-runtime/src/runtime-config.ts`
- Modify: `services/pi-runtime/src/session-manager.ts`（仅 :537 一处 + 新 import）
- Test: `services/pi-runtime/src/runtime-config.test.ts`
- Test: `services/pi-runtime/src/session-turn-context.test.ts`（或新建 `session-manager.compaction-settings.test.ts`）

**Interfaces:**
- Consumes: vendor `AgentHarnessOptions.compaction?: CompactionSettings`（`{enabled, reserveTokens, keepRecentTokens}`，唯一消费点 vendor `compaction.ts:248`：`contextTokens > contextWindow - reserveTokens`）。
- Produces: `effectiveCompactionSettings(compaction: CompactionConfig, contextWindow: number): CompactionSettings`（session-manager 导出，纯函数可测）；`CompactionConfig` 新增可选 `targetRatio?: number`。

背景：现口径 = `model.contextWindow − reserveTokens(16384)`。agnes 1M 窗口 → 98.4% 才触发（只留 1.6% 回包头寸）；BYOK 128k → 87%。行业口径 60–70%。改法：触发点 = `window × targetRatio`，即 `reserveTokens = window × (1 − targetRatio)`，host 侧算好传 vendor 既有入口，**不动 vendor**。

- [ ] **Step 1: 写失败测试（runtime-config）**

在 `runtime-config.test.ts` 追加：

```ts
describe("PI_RUNTIME_COMPACTION_TARGET_RATIO", () => {
	it("默认 0.7", () => {
		const cfg = loadRuntimeConfig({});
		assert.equal(cfg.compaction.targetRatio, 0.7);
	});
	it("显式 RESERVE_TOKENS 存在时 ratio 失效（旧口径优先）", () => {
		const cfg = loadRuntimeConfig({
			PI_RUNTIME_COMPACTION_RESERVE_TOKENS: "16384",
			PI_RUNTIME_COMPACTION_TARGET_RATIO: "0.7",
		});
		assert.equal(cfg.compaction.targetRatio, undefined);
		assert.equal(cfg.compaction.reserveTokens, 16384);
	});
	it("非法 ratio（0 / 1 / 负数 / 非数字）回退 undefined", () => {
		assert.equal(loadRuntimeConfig({ PI_RUNTIME_COMPACTION_TARGET_RATIO: "0" }).compaction.targetRatio, undefined);
		assert.equal(loadRuntimeConfig({ PI_RUNTIME_COMPACTION_TARGET_RATIO: "1" }).compaction.targetRatio, undefined);
		assert.equal(loadRuntimeConfig({ PI_RUNTIME_COMPACTION_TARGET_RATIO: "-0.5" }).compaction.targetRatio, undefined);
		assert.equal(loadRuntimeConfig({ PI_RUNTIME_COMPACTION_TARGET_RATIO: "abc" }).compaction.targetRatio, undefined);
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd services/pi-runtime && node --import tsx --test src/runtime-config.test.ts`
Expected: FAIL（`targetRatio` 为 undefined / 无该字段）

- [ ] **Step 3: 实现 runtime-config**

`CompactionConfig` 加字段 + 默认值 + 解析：

```ts
export interface CompactionConfig {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	/**
	 * 触发点 = contextWindow × targetRatio（行业口径 0.6~0.7）。
	 * 显式设置 PI_RUNTIME_COMPACTION_RESERVE_TOKENS 时本字段失效（旧口径优先）。
	 */
	targetRatio?: number;
}
```

`DEFAULT_RUNTIME_CONFIG.compaction` 改为 `{ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, targetRatio: 0.7 }`。
`loadRuntimeConfig` 的 compaction 段改为：

```ts
		compaction: (() => {
			const enabled = parseBool(env.PI_RUNTIME_COMPACTION_ENABLED, d.compaction.enabled);
			const reserveRaw = env.PI_RUNTIME_COMPACTION_RESERVE_TOKENS;
			const reserveTokens = parsePositiveInt(reserveRaw, d.compaction.reserveTokens);
			// 显式 reserveTokens = 旧口径，targetRatio 失效（Review Focus #2）
			if (reserveRaw !== undefined && reserveRaw.trim() !== "") {
				return { enabled, reserveTokens, keepRecentTokens: keepRecent(env), targetRatio: undefined };
			}
			const raw = env.PI_RUNTIME_COMPACTION_TARGET_RATIO;
			let targetRatio = d.compaction.targetRatio;
			if (raw !== undefined && raw.trim() !== "") {
				const n = Number(raw);
				targetRatio = Number.isFinite(n) && n > 0 && n < 1 ? n : undefined;
			}
			return { enabled, reserveTokens, keepRecentTokens: keepRecent(env), targetRatio };
		})(),
```

（`keepRecent(env)` 即现有的 `parsePositiveInt(env.PI_RUNTIME_COMPACTION_KEEP_RECENT_TOKENS, …)`，可内联。）

- [ ] **Step 4: 写失败测试（effectiveCompactionSettings）**

新建 `services/pi-runtime/src/session-manager.compaction-settings.test.ts`：

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { effectiveCompactionSettings } from "./session-manager.js";

const BASE = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, targetRatio: 0.7 };

describe("effectiveCompactionSettings", () => {
	it("1M 窗口：触发点 = 70%（reserve=300k）", () => {
		const s = effectiveCompactionSettings(BASE, 1_000_000);
		assert.equal(s.reserveTokens, 300_000);
		assert.equal(s.keepRecentTokens, 20_000);
	});
	it("128k 窗口：两渠道口径拉齐（reserve=38.4k）", () => {
		assert.equal(effectiveCompactionSettings(BASE, 128_000).reserveTokens, 38_400);
	});
	it("targetRatio undefined：走旧 reserveTokens", () => {
		const s = effectiveCompactionSettings({ ...BASE, targetRatio: undefined }, 1_000_000);
		assert.equal(s.reserveTokens, 16_384);
	});
	it("极小窗口：clamp 到 window − keepRecent − 1，不产生负数/永不触发", () => {
		const s = effectiveCompactionSettings(BASE, 8_192);
		assert.ok(s.reserveTokens < 8_192);
		assert.ok(s.reserveTokens >= 0);
	});
	it("enabled=false 原样透传", () => {
		const s = effectiveCompactionSettings({ ...BASE, enabled: false }, 1_000_000);
		assert.equal(s.enabled, false);
	});
});
```

- [ ] **Step 5: 跑测试确认失败**

Run: `cd services/pi-runtime && node --import tsx --test src/session-manager.compaction-settings.test.ts`
Expected: FAIL（函数不存在）

- [ ] **Step 6: 实现 effectiveCompactionSettings 并接入 session-manager**

`session-manager.ts` 导出（放 `normalizeTurnContext` 附近）：

```ts
import type { CompactionSettings } from "@earendil-works/pi-agent-core";

/** 审计 P0-①：触发点 = window×targetRatio；floor 保摘要头寸，cap 防小窗口永不触发。 */
export function effectiveCompactionSettings(
	compaction: RuntimeConfig["compaction"],
	contextWindow: number,
): CompactionSettings {
	if (!compaction.enabled) return { enabled: false, reserveTokens: 0, keepRecentTokens: compaction.keepRecentTokens };
	if (compaction.targetRatio === undefined || compaction.targetRatio <= 0 || compaction.targetRatio >= 1) {
		return { enabled: true, reserveTokens: compaction.reserveTokens, keepRecentTokens: compaction.keepRecentTokens };
	}
	const keepRecent = Math.min(compaction.keepRecentTokens, Math.floor(contextWindow / 2));
	const byRatio = Math.ceil(contextWindow * (1 - compaction.targetRatio));
	const reserveTokens = Math.max(16_384, Math.min(byRatio, contextWindow - keepRecent - 1));
	return { enabled: true, reserveTokens, keepRecentTokens: keepRecent };
}
```

:537 处 `compaction: this.config.compaction` 改为 `compaction: effectiveCompactionSettings(this.config.compaction, model.contextWindow)`（`model` 在同作用域，见 :524）。

- [ ] **Step 7: 跑测试确认通过 + 全量 pi-runtime 相关套件不回归**

Run: `cd services/pi-runtime && node --import tsx --test src/runtime-config.test.ts src/session-manager.compaction-settings.test.ts src/session-manager.test.ts src/app.test.ts`
Expected: PASS

- [ ] **Step 8: git status 复核落盘后提交**

```bash
git -C <worktree> add services/pi-runtime/src/runtime-config.ts services/pi-runtime/src/runtime-config.test.ts services/pi-runtime/src/session-manager.ts services/pi-runtime/src/session-manager.compaction-settings.test.ts
git -C <worktree> commit -m "fix(pi-runtime): compaction 触发点改为窗口比例口径（targetRatio 默认 0.7，两渠道拉齐）"
```

---

### Task 2: CJK-aware approxTokens（PR1，与 Task 1 同 PR）

**Files:**
- Modify: `services/pi-runtime/src/skills/registry.ts:33-35`
- Modify: `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.ts:54-56`
- Test: `services/pi-runtime/src/skills/loader.test.ts`（追加）或 registry 同目录新 test
- Test: `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.test.ts`（追加）

**Interfaces:**
- Produces: 两处 `approxTokens(s: string): number` 签名不变，口径统一改为「CJK 字符 ≈1 token/字 + 其余 ≈1/4 token/字符」。消费方（index.ts:25 的 skills 指标、Nest manifest）零改动。

背景：`ceil(len/4)` 对中文低估 3–4 倍（现代 tokenizer 中文约 0.6–1.5 token/字，取 1.0 保守偏安全）。

- [ ] **Step 1: 写失败测试（两端同公式，各一段）**

```ts
const CJK = "四个中文字符"; // 6 CJK
it("CJK 每字约 1 token（旧口径低估 3 倍）", () => {
	assert.equal(approxTokens(CJK), 6);
});
it("纯 ASCII 维持 1/4 口径", () => {
	assert.equal(approxTokens("abcdefgh"), 2);
});
it("混合文本", () => {
	// 2 CJK + 8 ASCII → 2 + 2 = 4
	assert.equal(approxTokens("两个汉字abcdefgh"), 4);
});
```

（Nest 侧用 vitest `expect(...).toBe(...)` 风格改写。）

- [ ] **Step 2: 跑测试确认失败**（旧实现：CJK 6 字 → 2；8 ASCII → 2；混合 10 字符 → 3）

- [ ] **Step 3: 两处同步实现（签名/正则逐字一致，注释互指）**

```ts
const CJK_CHAR_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/;

/** CJK ≈1 token/字 + 其余 ≈1/4 token/字符（中文低估修复，审计 P0-②）。
 *  与 services/pi-runtime/src/skills/registry.ts 同口径，改必须同步。 */
export function approxTokens(s: string): number {
	let cjk = 0;
	let other = 0;
	for (const ch of s) {
		if (CJK_CHAR_RE.test(ch)) cjk += 1;
		else other += 1;
	}
	return Math.ceil(cjk + other / 4);
}
```

- [ ] **Step 4: 跑测试确认通过**（两端各自的命令）

- [ ] **Step 5: git status 复核 + 提交**

```bash
git -C <worktree> commit -am "fix(context): approxTokens 改 CJK-aware 口径（pi-runtime skills 指标 + Nest prompt manifest）"
```

---

### Task 3: 恢复 cost —— 费率 env 化 + usage 事件接 metrics（PR2）

**Files:**
- Modify: `services/pi-runtime/src/model-assembly.ts`
- Modify: `services/pi-runtime/src/metrics.ts`
- Modify: `services/pi-runtime/src/session-manager.ts`（attachEvents 加 usage 订阅）
- Modify: `apps/server/src/agent/pi-runtime/pi-events.ts`（turn_usage 附 cost）
- Test: `model-assembly.test.ts` / `metrics.test.ts` / `pi-events.test.ts` 各追加

**Interfaces:**
- Consumes: vendor `calculateCost(model, usage)`（`pi-ai/models.ts:891`，openai-completions `:1546` 已在调）——**费率来自 `model.cost`，现在被 :78/:164 硬写 0 抹平**；vendor `usage` 事件（`lane.ts:1578` / `structural.ts:202`，载荷 `{row:{usage}, totals}`）。
- Produces: `Metrics.observeUsage(u: Usage): void`；Prometheus 新增 `pi_runtime_usage_tokens_total{kind}` / `pi_runtime_usage_cost_total{kind}`；turn_usage data 新增可选 `cost`。

- [ ] **Step 1: model-assembly 写失败测试**

```ts
it("agnes 费率从 env 读取（每百万 token）", () => {
	process.env.AGNES_COST_INPUT_PER_M = "2.5";
	process.env.AGNES_COST_OUTPUT_PER_M = "10";
	// 触发 agnesProvider 构造（经 assembleModel 或直接测内部函数——按现有测试的暴露方式）
	// 断言 model.cost.input === 2.5 && model.cost.output === 10
});
it("env 未配置 → 全 0（现状不变）", () => { /* model.cost 四项全 0 */ });
it("非法费率字符串回退 0", () => { /* AGNES_COST_INPUT_PER_M="abc" → 0 */ });
it("SessionLlmOverride.cost 透传 BYOK 模型", () => { /* override.cost 生效 */ });
```

- [ ] **Step 2: 实现 model-assembly**

```ts
/** 每百万 token 费率（USD）。vendor calculateCost 只认 model.cost——审计 P0-③：
 * 此前硬写 0 把整条 cost 链抹平。未配置 = 0（行为不变），配置即全链生效。 */
function costRatesFromEnv(): Model["cost"] {
	const num = (raw: string | undefined): number => {
		if (raw === undefined || raw.trim() === "") return 0;
		const n = Number(raw);
		return Number.isFinite(n) && n >= 0 ? n : 0;
	};
	return {
		input: num(process.env.AGNES_COST_INPUT_PER_M),
		output: num(process.env.AGNES_COST_OUTPUT_PER_M),
		cacheRead: num(process.env.AGNES_COST_CACHE_READ_PER_M),
		cacheWrite: num(process.env.AGNES_COST_CACHE_WRITE_PER_M),
	};
}
```

`agnesProvider()` 的 models[0].cost 改为 `costRatesFromEnv()`；`SessionLlmOverride` 加可选 `cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }`（注释：Nest 暂无渠道费率目录，为 seam，今日不填）；`overrideProvider` 的 cost 改为 `override.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`。

- [ ] **Step 3: metrics 写失败测试 → 实现**

```ts
observeUsage(u: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number } }): void;
// 累计：usageTokens["input"/"output"/"cache_read"/"cache_write"]，usageCost 同四 kind（cost 四字段求和）
// render() 追加：
//   pi_runtime_usage_tokens_total{kind="input|output|cache_read|cache_write"}  counter
//   pi_runtime_usage_cost_total{kind=...}  counter（未配费率时恒 0，符合 Review Focus #6）
```

- [ ] **Step 4: session-manager attachEvents 订阅 usage（只进 metrics，不进 SSE——避免 Nest 未知事件类型风险）**

在 `attachEvents` 内（EVENT_MAP 循环之外）追加：

```ts
		entry.unsubscribes.push(
			harness.events.on("usage" as never, (evt: { row?: { usage?: Usage } }) => {
				if (evt.row?.usage) this.metrics?.observeUsage(evt.row.usage);
			}),
		);
```

（若 SessionManager 无 metrics 引用则经构造注入——按现有 onCompaction 回调的形态对齐，倾向加 `onUsage?: (u: Usage) => void` hook，由 index.ts 接 metrics，与 onCompaction 同构。）

- [ ] **Step 5: Nest pi-events 写失败测试 → 实现**

`TurnUsage` 加 `cost?: number`；`extractUsageDelta` 从 `usage.cost` 四字段求和（vendor 口径：cost 在 message.usage.cost 上）；`createUsageAccumulator` 累积 cost，`agent_end` 时 `turn_usage.data` 在 `cost > 0` 时附带 `cost`（未配费率 = 0 → 不带字段，向后兼容）。测试：message_end 带 cost → turn_usage 带；不带 → 不带。

- [ ] **Step 6: 跑相关套件**（pi-runtime 三个 test 文件 + `node apps/server/node_modules/vitest/vitest.mjs run apps/server/src/agent/pi-runtime/pi-events.test.ts`）

- [ ] **Step 7: git status 复核 + 提交**

```bash
git -C <worktree> commit -am "feat(context): 恢复 cost 链路——费率 env 化 + usage 事件 metrics + turn_usage 附 cost（审计 P0-③）"
```

---

### Task 4: 工具渐进加载 —— load_tools + vendor addedToolNames（PR3-A）

**Files:**
- Create: `services/pi-runtime/src/tools/tiering.ts`
- Modify: `services/pi-runtime/src/session-manager.ts`（create 组装处 :520-540）
- Modify: `services/pi-runtime/src/tools/config.ts`（可选：resolveTools 返回不变，分层在 session-manager 做）
- Test: `services/pi-runtime/src/tools/tiering.test.ts`（新建）

**Interfaces:**
- Consumes: vendor `AgentHarnessOptions.activeToolNames?: string[]`（`agent-harness.ts:523`，`drive/generation.ts:90` 只把 active 工具 schema 发给 provider）；vendor `AgentToolResult.addedToolNames`（`types.ts:370`「Names of tools introduced by this result and available from this transcript point onward」→ `tool-placement.ts:204` 自动并入 activeToolNames 并发 `config_update` 事件）；host 既有 `toolSummary(tool)`（`tools/types.ts:74`）。
- Produces: `splitTools(tools, enabled) → { alwaysActive, deferred, loadToolsTool?, deferredIndexBlock? }`；`createLoadToolsTool(deferred): LnkpiTool`。

背景：38 个工具 schema 全量每轮进 system prompt 尾部，压缩砍不掉。常驻保留日常主链路 23 个，15 个低频工具（资产/画布编排/破坏性/记忆写）延迟加载。**激活机制 100% 用 vendor 原生 addedToolNames——host 不碰 activeToolNames 运行态。**

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitTools, createLoadToolsTool, DEFERRED_BY_DEFAULT, buildDeferredIndexBlock } from "./tiering.js";
import { resolveTools } from "./config.js"; // 或用最小 fake 工具数组

it("常驻+延迟 = 全集，无交集", () => {
	const tools = fakeTools(); // 造 38 个最小 LnkpiTool（name/tier/execute stub）
	const { alwaysActive, deferred } = splitTools(tools, true);
	assert.equal(alwaysActive.length + deferred.length, tools.length);
	const names = new Set(alwaysActive.map(t => t.name));
	for (const d of deferred) assert.ok(!names.has(d.name));
});
it("核心链路工具必须常驻（规则 4/5 引用的不能延迟）", () => {
	const { alwaysActive } = splitTools(fakeTools(), true);
	const names = new Set(alwaysActive.map(t => t.name));
	for (const n of ["upsert_media_node","set_node_text","connect_nodes","apply_sidebar_attachments","propose_generation","run_image_generation","ask_user","get_canvas_summary","load_skill"]) {
		assert.ok(names.has(n), `${n} 必须常驻`);
	}
});
it("enabled=false：全部常驻、无 load_tools、无索引块", () => {
	const r = splitTools(fakeTools(), false);
	assert.equal(r.alwaysActive.length, fakeTools().length);
	assert.equal(r.deferred.length, 0);
	assert.equal(r.loadToolsTool, undefined);
	assert.equal(r.deferredIndexBlock, "");
});
it("load_tools：合法名单 → addedToolNames 原样返回", async () => {
	const { loadToolsTool, deferred } = splitTools(fakeTools(), true);
	const target = deferred[0].name;
	const res = await loadToolsTool!.execute("t1", { tools: [target] } as never);
	assert.deepEqual(res.addedToolNames, [target]);
});
it("load_tools：未知名 → 文本报错列出可加载清单，addedToolNames 不含未知名", async () => {
	const { loadToolsTool } = splitTools(fakeTools(), true);
	const res = await loadToolsTool!.execute("t1", { tools: ["no_such_tool"] } as never);
	assert.match(res.content[0].text, /no_such_tool/);
	assert.ok(!res.addedToolNames || res.addedToolNames.length === 0);
});
it("延迟索引块：每行 name — summary，体积 < 1500 字符", () => {
	const block = buildDeferredIndexBlock(splitTools(fakeTools(), true).deferred);
	assert.match(block, /load_tools/);
	assert.ok(block.length < 1500);
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 tiering.ts**

```ts
/** 工具渐进加载（审计 P0-④）。vendor 原生机制：
 *  1) AgentHarnessOptions.activeToolNames —— 建会话时只激活常驻集，schema 不进 prompt；
 *  2) AgentToolResult.addedToolNames —— load_tools 结果携带名单，harness 自动并入
 *     activeToolNames（tool-placement.ts:204），自该转录点起可用。
 *  kill switch：PI_RUNTIME_TOOL_TIERING=off → 现状行为（全量常驻）。 */
import { Type } from "typebox";
import { toolSummary, type LnkpiTool } from "./types.js";

const ALWAYS_ON_TOOL_NAMES = new Set([
	// read（画布/生成/资产/模型/web/文档/记忆读）
	"get_canvas_summary","get_canvas_layout","get_node","get_generation_status","get_generation_diagnostic",
	"list_generation_tasks","list_user_assets","list_model_options","web_search","web_fetch","read_document","recall_memory",
	// write 核心链路（prompt 规则 4/5 逐字引用，不可延迟）
	"upsert_media_node","upsert_prompt_node","set_node_text","update_node","connect_nodes","attach_refs",
	"apply_sidebar_attachments","propose_generation",
	// gen（用户确认后当轮即用；propose 场景 addedToolNames 双保险）
	"run_image_generation","run_video_generation","run_text_generation","run_prompt_generation","run_audio_generation","cancel_generation",
	// 交互与元
	"ask_user","load_skill","load_tools",
]);

export function splitTools(tools: LnkpiTool[], enabled: boolean): {
	alwaysActive: LnkpiTool[];
	deferred: LnkpiTool[];
	loadToolsTool?: LnkpiTool;
	deferredIndexBlock: string;
} {
	if (!enabled) return { alwaysActive: tools, deferred: [], deferredIndexBlock: "" };
	const deferred = tools.filter((t) => !ALWAYS_ON_TOOL_NAMES.has(t.name));
	const alwaysActive = tools.filter((t) => ALWAYS_ON_TOOL_NAMES.has(t.name));
	const loadToolsTool = deferred.length ? createLoadToolsTool(deferred) : undefined;
	return { alwaysActive, deferred, loadToolsTool, deferredIndexBlock: buildDeferredIndexBlock(deferred) };
}

export function buildDeferredIndexBlock(deferred: LnkpiTool[]): string {
	if (!deferred.length) return "";
	const lines = deferred.map((t) => `- ${t.name}：${toolSummary(t)}`);
	return `\n以下工具未加载完整定义（省上下文），需要时调用 load_tools 按名加载：\n${lines.join("\n")}`;
}

export function createLoadToolsTool(deferred: LnkpiTool[]): LnkpiTool {
	const byName = new Map(deferred.map((t) => [t.name, t] as const));
	return {
		tier: "skill",
		name: "load_tools",
		label: "加载延迟工具",
		description: "按名单加载未激活工具的完整定义。仅接受「未加载工具清单」中列出的名字；加载后即可直接调用。",
		parameters: Type.Object({ tools: Type.Array(Type.String(), { min: 1, description: "要加载的工具名" }) }),
		execute: async (_id, p: { tools: string[] }) => {
			const valid = p.tools.filter((n) => byName.has(n));
			const unknown = p.tools.filter((n) => !byName.has(n));
			const text = unknown.length
				? `未知的工具名：${unknown.join("、")}。可加载：${deferred.map((t) => t.name).join("、")}。`
				: `已加载 ${valid.length} 个工具，现在可直接调用：${valid.join("、")}。`;
			return {
				content: [{ type: "text", text }],
				details: { loaded: valid, unknown },
				...(valid.length && !unknown.length ? { addedToolNames: valid } : {}),
			};
		},
	} as LnkpiTool;
}
```

（`execute` 返回类型以 `AgentToolResult` 为准：`content`/`details` 必填，`addedToolNames` 可选；部分未知名时先报错不激活——保守策略，模型重试即可。）

- [ ] **Step 4: 接入 session-manager create**

```ts
const tieringEnabled = this.config.toolTiering; // runtime-config 加 parseBool(env.PI_RUNTIME_TOOL_TIERING, true)
const allTools = [...this.tools, ...(this.skills?.tools ?? [])];
const { alwaysActive, loadToolsTool, deferredIndexBlock } = splitTools(allTools, tieringEnabled);
// harnessFactory options:
		tools: loadToolsTool ? [...alwaysActive, loadToolsTool] : allTools,
		...(tieringEnabled && deferredIndexBlock ? { /* 静态段追加 */ } : {}),
```

静态段追加：`entry.staticPrompt` 在 create 入口赋值处改为 `opts.systemPrompt + deferredIndexBlock`（tiering off 时为 ""，逐字节回现状）。

runtime-config.ts 同步加 `toolTiering: boolean`（env `PI_RUNTIME_TOOL_TIERING`，默认 true，parseBool 复用）。

- [ ] **Step 5: 跑 tiering.test + session-manager 全套件**

Run: `cd services/pi-runtime && node --import tsx --test src/tools/tiering.test.ts src/session-manager.test.ts src/app.test.ts`

- [ ] **Step 6: git status 复核 + 提交**

```bash
git -C <worktree> commit -am "feat(pi-runtime): 工具渐进加载——常驻/延迟分层 + load_tools（vendor addedToolNames 原生激活，审计 P0-④）"
```

---

### Task 5: 画布摘要焦点过滤 —— focusNodeId 进 assembleDynamic（PR3-B）

**Files:**
- Modify: `apps/server/src/agent/agent-canvas-tools.service.ts:575-586`（getCanvasSummary）
- Modify: `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.ts:158-184`（assembleDynamic）
- Modify: `apps/server/src/agent/agent.service.ts:679-682`（透传 focusNodeId）
- Test: `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.test.ts` 追加；canvas-tools 侧按现有测试文件追加

**Interfaces:**
- Produces: `getCanvasSummary(input: { sessionId; focusNodeId? })` → 返回可选 `omittedCount?: number; focusNodeId?: string`；`assembleDynamic(input 加 focusNodeId?)`。controller :1008 不传 focusNodeId → 全量（现行为不变）。
- Consumes: `piContext.focusNodeId`（agent.service.ts:731 已在透传给 turnContext，本轮只是让动态摘要也吃到）。

背景：审计 P0-①「换话题污染」根因——全画布摘要无条件每轮注入。修法：有焦点且画布大时只回焦点节点 + 1 跳邻居 + omittedCount，fail-open。

- [ ] **Step 1: 写失败测试（assembler 侧）**

```ts
it("有 focusNodeId 时透传给 getCanvasSummary", async () => {
	// fake canvasTools 断言收到 focusNodeId
});
it("omittedCount>0 时摘要带提示行（告知模型可 get_canvas_layout 取全量）", async () => {
	// fake 返回 { nodes:[...], omittedCount: 40, focusNodeId: "image-1" }
	// 断言 layer content 包含 "40" 与 "get_canvas_layout"
});
it("无 focusNodeId：行为与现状一致", async () => { /* 不传 → getCanvasSummary 收到 undefined */ });
```

- [ ] **Step 2: 写失败测试（canvas-tools 侧，焦点过滤规则）**

```ts
it("无焦点 / 焦点不存在 / 节点数 ≤ 30 → 全量返回（fail-open）", () => {});
it("节点数 > 30 且焦点存在 → 焦点 + 1 跳邻居 + omittedCount", () => {
	// 构造 32 节点 + 边：focus 的上下游 2 节点入选
	// 断言 nodes 含 focus 与两邻居、不含远端节点；omittedCount === 32 - 3
});
```

- [ ] **Step 3: 跑测试确认失败 → 实现**

`agent-canvas-tools.service.ts`：

```ts
  /** 焦点过滤阈值：≤ 此数全量返回（fail-open），避免小画布反而丢信息。 */
  private static readonly CANVAS_SUMMARY_FULL_LIMIT = 30

  async getCanvasSummary(input: { sessionId: string; focusNodeId?: string }): Promise<{
    nodes: Array<{ id: string; type: string; title: string; status: string }>
    omittedCount?: number
    focusNodeId?: string
  }> {
    const { canvas } = await this.loadSession(input.sessionId)
    const all = canvas.nodes.map((n) => ({ id: n.id, type: n.type, title: nodeTitle(n), status: nodeStatus(n) }))
    const focus = input.focusNodeId
    if (!focus || all.length <= AgentCanvasToolsService.CANVAS_SUMMARY_FULL_LIMIT) return { nodes: all }
    if (!canvas.nodes.some((n) => n.id === focus)) return { nodes: all }
    const keep = new Set<string>([focus])
    for (const e of canvas.edges) {
      if (e.source === focus) keep.add(e.target)
      if (e.target === focus) keep.add(e.source)
    }
    const nodes = all.filter((n) => keep.has(n.id))
    return { nodes, omittedCount: all.length - nodes.length, focusNodeId: focus }
  }
```

`pi-prompt-assembler.service.ts` assembleDynamic：input 加 `focusNodeId?: string`；`:165` 改 `getCanvasSummary({ sessionId: input.sessionId, focusNodeId: input.focusNodeId })`；layer 内容在 `omittedCount` 存在时追加：

```ts
const note = summary.omittedCount
	? `\n（画布共 ${summary.omittedCount + summary.nodes.length} 个节点，当前聚焦 ${summary.focusNodeId}，其余 ${summary.omittedCount} 个未列出；需要全量时调用 get_canvas_layout）`
	: "";
layers.push(layer("canvas-summary", "canvas", `当前画布摘要：\n${JSON.stringify(summary.nodes)}${note}`));
```

`agent.service.ts:679` 改：

```ts
    const dynamicBlocks = await assembler.assembleDynamic({
      sessionId,
      attachments: piContext?.attachments,
      focusNodeId: piContext?.focusNodeId,
    })
```

- [ ] **Step 4: 跑相关 vitest 套件**（pi-prompt-assembler + canvas-tools 相关 + agent.service 若有测试）

- [ ] **Step 5: git status 复核 + 提交**

```bash
git -C <worktree> commit -am "feat(context): 画布摘要焦点过滤——focusNodeId + 1 跳邻居 + omittedCount（fail-open，审计 P0-①）"
```

---

## Self-Review 记录

- spec 覆盖：审计五条修复点全部有 task；「不要做」清单（后台自动 recap）不在计划内。✓
- 类型一致性：`effectiveCompactionSettings`/`splitTools`/`observeUsage`/`approxTokens` 各任务间签名已对齐。✓
- 遗留说明：①压缩阈值分母的 **估算路径**（agnes 不回 usage 时 chars/4 低估）是 vendor 侧行为，host 无法修——靠 targetRatio=0.7 的余量 + 生产验证 agnes 是否回 usage（审计给的互证坐标）。②BYOK 费率目录（Nest 侧）是后续产品项，本计划只留 `SessionLlmOverride.cost` seam。③setActiveTools 运行态 host 不调，全走 vendor addedToolNames。
