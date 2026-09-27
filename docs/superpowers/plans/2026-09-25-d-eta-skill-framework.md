# D-η' Skill 框架实现计划（typed layers + 注入 manifest + drop-in 验收）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pi-runtime 获得 skill 能力——`SKILL.md` 目录免改码 drop-in，模型经 `load_skill` 工具按需加载技能正文；同时 Nest assembler 升级为 typed layers 并输出注入 manifest。

**Architecture:** skill 子系统整体归属 pi-runtime（单容器持有 skills：启动时 discover → 会话创建时把技能索引追加到 systemPrompt 尾部 → `load_skill` 本地工具按需返回正文）。Nest 侧只做内部重构：`PiPromptAssembler` 的 `parts: string[]` 升级为 `PromptLayer[]` 并打 manifest 日志，**输出文本逐字符不变**。老 runtime loader 的通用约定（frontmatter 校验、name=目录名、坏 skill 跳过）以 TS 移植，`lnkpi.*` 扩展元数据与 prompt_version 机制不迁。

**Tech Stack:** TypeScript（pi-runtime：fastify + vendored `@earendil-works/pi-agent-core`；Nest：@nestjs/common）、TypeBox（`import { Type } from "typebox"`）、node:test + node:assert（pi-runtime 测试）、vitest（Nest 测试）。

**Spec:** `docs/discussion/2026-09-25-workbuddy-alignment.md`（§4 优先级表、§5 D-η' 范围定案）+ `docs/superpowers/plans/2026-09-24-p1-roadmap-revision.md` §6.5/§6.6。

## 0. 配图索引

本文档不含图（TDD 任务序列与代码块表达，无状态机/拓扑需要图示）。

## Global Constraints

- vendored pi（`vendor/earendil-works/pi/`）禁止任何业务 patch（VENDORED.md 纪律）；所有 harness 层改动只落在 `services/pi-runtime/src/` 与 `apps/server/src/`
- 工具定义签名与现有 `LnkpiTool` 一致：`execute: async (_id, p) => {...}` 两参；参数用 TypeBox（`import { Type } from "typebox"`）
- Nest assembler 重构后**输出文本逐字符不变**（现有 `pi-prompt-assembler.service.test.ts` 全绿是硬门槛）
- 规则组机制（core/writeTools/genTools）与规则编号不动
- skill 无新 SSE 事件、无新 HTTP 端点（`load_skill` 走既有 tool_call 通道）
- skills 目录：仓库根 `skills/`（drop-in 目录），镜像内路径 `/app/skills`，运行时环境变量 `PI_RUNTIME_SKILLS_DIR`（默认 `./skills`）
- SKILL.md 格式对齐 Anthropic 事实标准：YAML frontmatter 必填 `name`（小写连字符、=目录名、≤64 字符）+ `description`（≤1024 字符）；正文 Markdown；可选 `references/`、`scripts/` 子目录
- 部署纪律：本批只发 pi-runtime 镜像 + helm（Nest 无接口变化），发布门走 pi-lnk master；验收三件套照旧（镜像 tag=sha+healthy / PI_RUNTIME_MODE=active / thread-verify PASS=16 FAIL=0）
- 执行时用 `superpowers:using-git-worktrees` 开分支 `p1/skill-framework`（自 master）

## Review Focus

1. **坏 skill**（frontmatter 缺 name/description、name≠目录名、description>1024）→ `discoverSkills` 跳过该目录并 warn，绝不能让 session 创建失败—— pinned by Task 2 Step 1 测试 `skips invalid skill dirs without throwing`
2. **skills 目录不存在/为空** → `indexBlock=""`、`tools=[]`，行为与现状完全一致（systemPrompt 不追加任何内容、工具列表不变）—— pinned by Task 2 `returns empty registry for missing dir` + Task 4 `no skills means prompt unchanged`
3. **load_skill 传未知 name** → 返回 `ok:false` 错误文本内容（走工具正常返回通道），不 throw、不炸 harness—— pinned by Task 3 `returns error content for unknown name`
4. **systemPrompt 为空 + 有 skills** → default prompt + index 块仍正确拼接（不出现孤立空段）—— pinned by Task 4 `appends index even with empty base prompt`
5. **skill body 极大** → `load_skill` 原样返回不截断（对齐「摘要 JSON 不截断」先例），manifest 记录 approxTokens—— pinned by Task 3 `returns full body without truncation`

---

### Task 1: Nest assembler typed layers（输出不变 + manifest）

**Files:**
- Modify: `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.ts`
- Test: `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.test.ts`

**Interfaces:**
- Produces: `export type PromptLayerKind = "rules" | "canvas" | "sidebar" | "recent" | "skill" | "memory";`（`skill` 与 `memory` 为预留：`skill` 是 D-η' 第一个按层管理的住客，`memory` 阶段二；本期不产出）、`export interface PromptLayer { id: string; kind: PromptLayerKind; content: string; approxTokens: number; }`、`export function approxTokens(s: string): number`（`Math.ceil(s.length / 4)`）。`assemble()` 对外签名与返回类型（`Promise<string>`）不变。
- ⚠️ **2026-09-28 实现校准**：`PromptLayer` 增加 `approxTokens` 字段、`kind` 增加 `skill`，并新增结构化
  `PromptManifest { sessionId, layers, totalTokens, promptHash }` 与 `lastManifestDetail`。
  依据 `docs/discussion/2026-09-25-workbuddy-alignment.md` §4 第 1、2 项——该处要求层自带
  `approxTokens`、且 kind 含 `skill`；与本文档原口径（无 approxTokens、无 skill）冲突，
  实现取**并集**以同时满足。另补 `prompt_hash`（对齐 §4 第 2 项的 manifest 三要素）。

- [ ] **Step 1: 写失败测试（manifest + 输出不变）**

在 `pi-prompt-assembler.service.test.ts` 追加（沿用文件内现有 stub 风格，`canvasTools` stub 返回 `{ nodes: [] }`）：

```ts
it("assemble 输出与 layers join 一致（重构不改文本）", async () => {
	const service = createService(); // 文件内已有的构造 helper
	const out = await service.assemble({ sessionId: "s1", ruleGroups: ["core"] });
	// 捕获内部 layers：通过新增的 lastLayers 暴露（仅测试用）
	expect(service.lastLayers?.map((l) => l.kind)).toEqual(["rules", "canvas"]);
	expect(out).toBe(service.lastLayers!.map((l) => l.content).join("\n"));
});

it("manifest 日志包含每层 id/kind/approxTokens", async () => {
	const service = createService();
	await service.assemble({ sessionId: "s1", ruleGroups: ["core", "genTools"] });
	const logged = service.lastManifest as string;
	expect(logged).toContain("rules:");
	expect(logged).toContain("canvas:");
	expect(logged).toMatch(/canvas:\d+tok/);
});
```

（若文件内无 `createService` helper，按现有测试的构造方式内联 `new PiPromptAssembler(stubCanvasTools)`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/4seven/workspace/pi-lnk && pnpm vitest run apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.test.ts`
Expected: FAIL（`lastLayers`/`lastManifest` 不存在）

- [ ] **Step 3: 实现 typed layers**

`pi-prompt-assembler.service.ts` 修改（保持 `composeRuleText` 等既有函数不动）：

```ts
export type PromptLayerKind = "rules" | "canvas" | "sidebar" | "recent" | "skill" | "memory";

export interface PromptLayer {
	id: string;
	kind: PromptLayerKind;
	content: string;
	/** 该层 token 估算，随层携带（manifest/观测直接消费）。 */
	approxTokens: number;
}

/** 每轮注入 manifest（结构化，供 log/metrics 消费）。 */
export interface PromptManifest {
	sessionId: string;
	layers: Array<{ id: string; kind: PromptLayerKind; tokens: number }>;
	totalTokens: number;
	/** 最终 prompt 的稳定哈希（12 位 hex），用于跨轮 diff / 回归比对。 */
	promptHash: string;
}

export function approxTokens(s: string): number {
	return Math.ceil(s.length / 4);
}

/** 构造层并顺带算出 token 估算（避免调用点漏算）。 */
function layer(id: string, kind: PromptLayerKind, content: string): PromptLayer {
	return { id, kind, content, approxTokens: approxTokens(content) };
}
```

`assemble` 内部改为构建 layers（**内容与顺序和现有 parts 完全一致**，只是从 `string[]` 换成 `PromptLayer[]`）：

```ts
async assemble(input: { /* 签名不变 */ }): Promise<string> {
	const groups = input.ruleGroups ?? ["core"];
	const layers: PromptLayer[] = [{ id: "rules", kind: "rules", content: composeRuleText(groups) }];

	try {
		const summary = await this.canvasTools.getCanvasSummary({ sessionId: input.sessionId });
		if (summary?.nodes) {
			layers.push({ id: "canvas-summary", kind: "canvas", content: `当前画布摘要：\n${JSON.stringify(summary)}` });
		}
	} catch (err) { /* 现有 warn 逻辑不动 */ }

	if (input.attachments?.length) {
		const block = buildSidebarBlock(input.attachments);
		if (block) layers.push({ id: "sidebar", kind: "sidebar", content: block });
	}

	const recent = compressRecentTurns(input.priorMessages ?? [], input.maxTurns ?? 4);
	if (recent) layers.push({ id: "recent-turns", kind: "recent", content: `近期对话摘要：\n${recent}` });

	this.lastLayers = layers;
	this.lastManifest = `prompt manifest ${input.sessionId}: ${layers
		.map((l) => `${l.id}:${l.kind}:${approxTokens(l.content)}tok`)
		.join(" ")}`;
	this.logger.log(this.lastManifest);

	return layers.map((l) => l.content).join("\n");
}
```

类上追加两个字段（测试观测口，文档注释注明 non-production API）：

```ts
/** 测试观测口：最近一次 assemble 的 layers 与 manifest 行。 */
lastLayers?: PromptLayer[];
lastManifest?: string;
```

- [ ] **Step 4: 跑全量 assembler 测试确认通过（含既有用例）**

Run: `cd /Users/4seven/workspace/pi-lnk && pnpm vitest run apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.test.ts`
Expected: PASS（新旧全部）。再跑 `pnpm vitest run apps/server/src/agent` 确认无回归。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.ts apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.test.ts
git commit -m "refactor(server): PiPromptAssembler typed layers + 注入 manifest（输出不变）"
```

### Task 2: pi-runtime SkillRegistry（discover / parse / validate / index block）

**Files:**
- Create: `services/pi-runtime/src/skills/loader.ts`
- Test: `services/pi-runtime/src/skills/loader.test.ts`

**Interfaces:**
- Produces:
  - `export interface SkillIndexEntry { skillId: string; name: string; description: string; dir: string; }`
  - `export interface LoadedSkill extends SkillIndexEntry { body: string; }`
  - `export function discoverSkills(root: string): SkillIndexEntry[]`（目录缺失→`[]`；坏 skill 跳过 + `console.warn`）
  - `export function loadSkill(entry: SkillIndexEntry): LoadedSkill`（每次读盘，抛错=调用方处理）
  - `export function buildSkillIndexBlock(entries: SkillIndexEntry[]): string`（空数组→`""`）

- [ ] **Step 1: 写失败测试**

`services/pi-runtime/src/skills/loader.test.ts`：

```ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSkillIndexBlock, discoverSkills, loadSkill } from "./loader.js";

function makeSkill(root: string, dirName: string, frontmatter: string, body = "正文内容。"): string {
	const dir = join(root, dirName);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
	return dir;
}

test("discovers valid skills with name and description", () => {
	const root = mkdtempSync(join(tmpdir(), "skills-"));
	makeSkill(root, "good-skill", 'name: good-skill\ndescription: "做某事。当用户要求某事时使用。"');
	const entries = discoverSkills(root);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].name, "good-skill");
	assert.equal(entries[0].skillId, "good-skill");
	rmSync(root, { recursive: true, force: true });
});

test("skips invalid skill dirs without throwing (missing description)", () => {
	const root = mkdtempSync(join(tmpdir(), "skills-"));
	makeSkill(root, "bad-skill", "name: bad-skill");
	makeSkill(root, "good-skill", 'name: good-skill\ndescription: "ok"');
	assert.equal(discoverSkills(root).length, 1); // 坏的跳过，好的仍在
	rmSync(root, { recursive: true, force: true });
});

test("skips skill whose name != dir name and over-length description", () => {
	const root = mkdtempSync(join(tmpdir(), "skills-"));
	makeSkill(root, "dir-a", 'name: other-name\ndescription: "x"');
	makeSkill(root, "dir-b", `name: dir-b\ndescription: "${"长".repeat(1025)}"`);
	assert.equal(discoverSkills(root).length, 0);
	rmSync(root, { recursive: true, force: true });
});

test("missing root returns empty array", () => {
	assert.deepEqual(discoverSkills("/nonexistent-skills-dir-xyz"), []);
});

test("buildSkillIndexBlock empty when no entries", () => {
	assert.equal(buildSkillIndexBlock([]), "");
});

test("loadSkill returns body", () => {
	const root = mkdtempSync(join(tmpdir(), "skills-"));
	makeSkill(root, "sk1", 'name: sk1\ndescription: "d"', "## 步骤\n1. 先做 A");
	const [entry] = discoverSkills(root);
	const loaded = loadSkill(entry);
	assert.equal(loaded.body, "## 步骤\n1. 先做 A");
	rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/4seven/workspace/pi-lnk && pnpm --filter @pi-lnk/pi-runtime test`（入口以 `services/pi-runtime/package.json` scripts 为准）
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 loader.ts**

```ts
/**
 * SKILL.md 加载器（D-η'）：格式对齐 Anthropic 事实标准（github.com/anthropics/skills）。
 * 通用约定 TS 移植自老 runtime app/skills/loader.py（name=目录名、≤64 字符、
 * description≤1024、坏 skill 跳过）；lnkpi.* 扩展元数据与 prompt_version 机制不迁。
 * 渐进披露：index（name+description）常驻 systemPrompt，正文经 load_skill 按需加载。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface SkillIndexEntry {
	skillId: string;
	name: string;
	description: string;
	dir: string;
}

export interface LoadedSkill extends SkillIndexEntry {
	body: string;
}

export function discoverSkills(root: string): SkillIndexEntry[] {
	let children: string[];
	try {
		children = readdirSync(root);
	} catch {
		return [];
	}
	const entries: SkillIndexEntry[] = [];
	for (const child of children.sort()) {
		const dir = join(root, child);
		try {
			if (!statSync(dir).isDirectory() || child.startsWith("_")) continue;
			const { frontmatter } = parseSkillMd(readFileSync(join(dir, "SKILL.md"), "utf8"));
			const name = String(frontmatter.name ?? "");
			const description = String(frontmatter.description ?? "");
			validateName(name, child);
			validateDescription(description);
			entries.push({ skillId: child, name, description, dir });
		} catch (err) {
			console.warn(`[skills] skipping ${child}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return entries;
}

export function loadSkill(entry: SkillIndexEntry): LoadedSkill {
	const { frontmatter, body } = parseSkillMd(readFileSync(join(entry.dir, "SKILL.md"), "utf8"));
	validateName(String(frontmatter.name ?? ""), entry.skillId);
	validateDescription(String(frontmatter.description ?? ""));
	return { ...entry, body };
}

export function buildSkillIndexBlock(entries: SkillIndexEntry[]): string {
	if (entries.length === 0) return "";
	const lines = entries.map((e) => `- ${e.name}: ${e.description}`);
	return [
		"## 可用技能（Skills）",
		"用户意图匹配某技能描述时，先调用 load_skill 工具加载完整说明，再按说明执行；未匹配到技能时不要调用 load_skill。",
		...lines,
	].join("\n");
}

function parseSkillMd(content: string): { frontmatter: Record<string, unknown>; body: string } {
	if (!content.startsWith("---")) throw new Error("SKILL.md must begin with YAML frontmatter");
	// 手动解析 frontmatter：首个 "---" 与下一个 "\n---" 之间
	const end = content.indexOf("\n---", 3);
	if (end === -1) throw new Error("invalid frontmatter in SKILL.md");
	const raw = content.slice(4, end);
	const body = content.slice(end + 4).replace(/^\n+/, "");
	return { frontmatter: parseSimpleYaml(raw), body };
}

/** 最小 YAML 子集解析：仅支持 `key: value` 行（name/description 已够用；值可带引号）。 */
function parseSimpleYaml(raw: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const line of raw.split("\n")) {
		const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
		if (!m) continue;
		let v: unknown = m[2].trim();
		if (typeof v === "string" && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
		out[m[1]] = v;
	}
	return out;
}

function validateName(name: string, dirName: string): void {
	if (!name) throw new Error("name is required in frontmatter");
	if (name.length > 64) throw new Error("name must be at most 64 characters");
	if (!NAME_PATTERN.test(name)) throw new Error("name must use lowercase letters, digits, and hyphens only");
	if (name !== dirName) throw new Error("name must match the skill directory name");
}

function validateDescription(description: string): void {
	if (!description) throw new Error("description is required in frontmatter");
	if (description.length > 1024) throw new Error("description must be at most 1024 characters");
}
```

> 实现注记：最小 YAML 解析器只支持单行 `key: value`。若第三方 skill 的 description 用了 YAML 多行语法（`>`/`|`），会被当作普通字符串处理导致触发变差——这是已知限制，drop-in 验收用例须覆盖多行 description（Task 6），届时若不过再引入 `yaml` 依赖（先查 `services/pi-runtime/package.json` 是否已有，禁止轻率新增）。

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2。
Expected: PASS 全部。

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/skills/
git commit -m "feat(pi-runtime): SKILL.md loader（Anthropic 格式 + 坏 skill 跳过 + index block）"
```

### Task 3: load_skill 本地工具（tier=skill）

**Files:**
- Modify: `services/pi-runtime/src/tools/types.ts`（`ToolTier` 联合类型追加 `"skill"`）
- Create: `services/pi-runtime/src/tools/skill-tool.ts`
- Test: `services/pi-runtime/src/tools/skill-tool.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `SkillIndexEntry` / `loadSkill`
- Produces: `export function createSkillTools(entries: SkillIndexEntry[], metrics: Metrics): LnkpiTool[]`（entries 为空→`[]`；非空→单个 `load_skill` 工具）。返回形态与 `ui-command.ts` 的 `uiResult` 同构：`{ content: [{ type: "text", text }], details: {...} }`。

- [ ] **Step 1: 写失败测试**

`services/pi-runtime/src/tools/skill-tool.test.ts`（先读 `ui-command.test.ts` 对齐 execute 调用方式，若签名不同以其为准）：

```ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverSkills } from "../skills/loader.js";
import { createSkillTools } from "./skill-tool.js";
import { Metrics } from "../metrics.js";

function setup(root: string, name: string, body: string) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: "测试技能"\n---\n\n${body}\n`, "utf8");
}

test("empty entries yields no tools", () => {
	assert.deepEqual(createSkillTools([], new Metrics()), []);
});

test("load_skill returns full body without truncation", async () => {
	const root = mkdtempSync(join(tmpdir(), "skills-"));
	const bigBody = "很长的正文。".repeat(5000); // 30k 字符
	setup(root, "big-skill", bigBody);
	const [tool] = createSkillTools(discoverSkills(root), new Metrics());
	const res = await tool.execute("t1", { name: "big-skill" });
	const parsed = JSON.parse(res.content[0].text);
	assert.equal(parsed.ok, true);
	assert.equal(parsed.body, bigBody);
	rmSync(root, { recursive: true, force: true });
});

test("load_skill returns error content for unknown name (no throw)", async () => {
	const root = mkdtempSync(join(tmpdir(), "skills-"));
	setup(root, "real-skill", "body");
	const [tool] = createSkillTools(discoverSkills(root), new Metrics());
	const res = await tool.execute("t1", { name: "no-such-skill" });
	const parsed = JSON.parse(res.content[0].text);
	assert.equal(parsed.ok, false);
	assert.ok(parsed.error.includes("no-such-skill"));
	rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/4seven/workspace/pi-lnk && pnpm --filter @pi-lnk/pi-runtime test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 skill-tool.ts + tier 扩展**

`types.ts`：`ToolTier` 追加 `| "skill";`，注释补 `skill = SKILL.md 按需加载（D-η'）。`

`tools/skill-tool.ts`：

```ts
/**
 * load_skill（D-η'）：SKILL.md 正文按需加载工具。
 * index（name+description）常驻 systemPrompt（SessionManager 注入），模型意图匹配后
 * 调用本工具取正文；只读本地文件，不走 Nest、不经 Gate。
 */
import { Type } from "typebox";
import type { LnkpiTool } from "./types.js";
import type { Metrics } from "../metrics.js";
import { loadSkill, type SkillIndexEntry } from "../skills/loader.js";

export function createSkillTools(entries: SkillIndexEntry[], metrics: Metrics): LnkpiTool[] {
	if (entries.length === 0) return [];
	const byName = new Map(entries.map((e) => [e.name, e]));
	return [
		{
			tier: "skill",
			name: "load_skill",
			label: "加载技能说明",
			description:
				"Load the full instructions of a skill by name. Call this when the user's intent matches a skill listed in the 可用技能 section, then follow the returned instructions.",
			parameters: Type.Object({
				name: Type.String({ description: "Skill name, exactly as listed in 可用技能" }),
			}),
			execute: async (_id, p: { name: string }) => {
				const entry = byName.get(p.name);
				if (!entry) {
					metrics.observeToolCall("load_skill", "error");
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: `unknown skill: ${p.name}` }) }],
						details: { ok: false as const, error: `unknown skill: ${p.name}` },
					};
				}
				try {
					const loaded = loadSkill(entry);
					metrics.observeToolCall("load_skill", "ok");
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ ok: true, body: loaded.body }) }],
						details: { ok: true as const, body: loaded.body },
					};
				} catch (err) {
					metrics.observeToolCall("load_skill", "error");
					const msg = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: msg }) }],
						details: { ok: false as const, error: msg },
					};
				}
			},
		},
	];
}
```

- [ ] **Step 4: 跑测试确认通过 + 工具回归**

Run: `pnpm --filter @pi-lnk/pi-runtime test`
Expected: PASS（含现有全部工具测试）

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/tools/types.ts services/pi-runtime/src/tools/skill-tool.ts services/pi-runtime/src/tools/skill-tool.test.ts
git commit -m "feat(pi-runtime): load_skill 本地工具（tier=skill，按需返回 SKILL.md 正文）"
```

### Task 4: SessionManager 集成（index 注入 + 工具合并 + gauge）

**Files:**
- Modify: `services/pi-runtime/src/session-manager.ts`
- Modify: `services/pi-runtime/src/index.ts`（启动时构建 registry 并注入）
- Modify: `services/pi-runtime/src/metrics.ts`（`skills_loaded` gauge）
- Test: `services/pi-runtime/src/session-manager.test.ts`、`services/pi-runtime/src/metrics.test.ts`

**Interfaces:**
- Consumes: Task 2 `discoverSkills` / `buildSkillIndexBlock`；Task 3 `createSkillTools`
- Produces:
  - `src/skills/loader.ts` 追加 `export class SkillRegistry { constructor(root: string, metrics: Metrics); readonly entries: SkillIndexEntry[]; readonly indexBlock: string; readonly tools: LnkpiTool[]; }`
  - `SessionManager` 构造函数追加可选参 `skills?: SkillRegistry`（排在现有 `hooks?` 之后）；`create()` 内 systemPrompt 经 `composeSystemPrompt` 组装
  - `Metrics` 追加 `setSkillsLoaded(n: number): void`，render 输出 `pi_runtime_skills_loaded` gauge

- [ ] **Step 1: 写失败测试**

`session-manager.test.ts` 追加（沿用现有 harnessFactory 捕获 stub 模式，先读现有「create() 把 tools/toolContext/systemPrompt 原样传给 harnessFactory」用例）：

```ts
it("no skills means prompt unchanged (byte-identical to base)", async () => {
	// SessionManager 不传 skills；断言 captured.systemPrompt === "SYS"
});

it("appends skill index block to systemPrompt", async () => {
	// 用 SkillRegistry 指向临时 skills 目录（含 1 个合法 skill）；
	// 断言 captured.systemPrompt === "SYS\n\n" + registry.indexBlock，
	// 且传入 harness 的 tools 数组尾部含 name === "load_skill"
});

it("appends index even with empty base prompt", async () => {
	// opts.systemPrompt 不传且 systemPromptDefault=""；断言 captured.systemPrompt === registry.indexBlock
});
```

`metrics.test.ts` 追加：

```ts
it("renders pi_runtime_skills_loaded gauge", () => {
	const m = new Metrics();
	m.setSkillsLoaded(2);
	assert.ok(m.render(0, "test").includes("pi_runtime_skills_loaded 2"));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @pi-lnk/pi-runtime test`
Expected: 新增用例 FAIL

- [ ] **Step 3: 实现**

`src/skills/loader.ts` 追加：

```ts
import type { LnkpiTool } from "../tools/types.js";
import type { Metrics } from "../metrics.js";
import { createSkillTools } from "../tools/skill-tool.js";

export class SkillRegistry {
	readonly entries: SkillIndexEntry[];
	readonly indexBlock: string;
	readonly tools: LnkpiTool[];

	constructor(root: string, metrics: Metrics) {
		this.entries = discoverSkills(root);
		this.indexBlock = buildSkillIndexBlock(this.entries);
		this.tools = createSkillTools(this.entries, metrics);
	}
}
```

`session-manager.ts`：构造函数追加 `private readonly skills?: SkillRegistry`（`hooks?` 之后）；`create()` 内两处改为：

```ts
tools: [...this.tools, ...(this.skills?.tools ?? [])],
// ...
systemPrompt: this.composeSystemPrompt(opts.systemPrompt),
```

```ts
private composeSystemPrompt(base?: string): string {
	const prompt = base || this.systemPromptDefault;
	const index = this.skills?.indexBlock ?? "";
	if (!index) return prompt;
	return prompt ? `${prompt}\n\n${index}` : index;
}
```

`index.ts`：在构建 SessionManager 处（现有 `new SessionManager(...)` 调用点）追加：

```ts
const skillRegistry = new SkillRegistry(process.env.PI_RUNTIME_SKILLS_DIR ?? "./skills", metrics);
metrics.setSkillsLoaded(skillRegistry.entries.length);
// 作为最后一个实参传入 new SessionManager(...)
```

`metrics.ts`：追加 `private skillsLoaded = 0;` 与：

```ts
setSkillsLoaded(n: number): void {
	this.skillsLoaded = n;
}
```

`render()` 在 `pi_runtime_sessions_active` 行后追加：

```ts
lines.push("# HELP pi_runtime_skills_loaded Skills discovered at startup.");
lines.push("# TYPE pi_runtime_skills_loaded gauge");
lines.push(`pi_runtime_skills_loaded ${this.skillsLoaded}`);
```

- [ ] **Step 4: 跑全量 pi-runtime 测试**

Run: `pnpm --filter @pi-lnk/pi-runtime test`
Expected: PASS（新旧全部）

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/session-manager.ts services/pi-runtime/src/index.ts services/pi-runtime/src/metrics.ts services/pi-runtime/src/session-manager.test.ts services/pi-runtime/src/metrics.test.ts services/pi-runtime/src/skills/loader.ts
git commit -m "feat(pi-runtime): session 集成 skill 注入（index 常驻 + load_skill 注册 + gauge）"
```

### Task 5: 领域 skill 重写 + 镜像/helm 接线

**Files:**
- Create: `skills/ecommerce-product-photo/SKILL.md`
- Modify: `services/pi-runtime/Dockerfile`（追加 `COPY skills ./skills`）
- Modify: `charts/pi-lnk-runtime/` values/templates（env 追加 `PI_RUNTIME_SKILLS_DIR: /app/skills`；先用 `grep -rn "NEST_BASE_URL" charts/pi-lnk-runtime/` 定位 env 注入的实际文件）
- Test: 无新自动化测试（格式由 Task 2 覆盖；本任务产物是内容 + 接线，验收在 Task 6）

**Interfaces:**
- Consumes: Task 2 loader 校验规则（name=目录名、小写连字符、description≤1024）
- Produces: 仓库根 `skills/` 成为 drop-in 目录；镜像内 `/app/skills`

- [ ] **Step 1: 通读老 skill 提炼领域知识**

Run: `cat services/agent-runtime/skills/ecommerce-product-visual/SKILL.md`
提炼电商商品图的领域要点（提示词结构、一致性写法、ref 顺序等），忽略 `lnkpi.*` 元数据、eval yaml、老链路工具名。

- [ ] **Step 2: 重写为标准格式 skill**

`skills/ecommerce-product-photo/SKILL.md`（骨架如下，领域内容按 Step 1 提炼后重写，不逐字拷贝）：

```markdown
---
name: ecommerce-product-photo
description: 电商商品图/产品视觉生成指导。当用户要求生成商品图、产品场景图、白底图、模特上身图、商品细节图，或提到商品摄影、场景搭配、营销视觉时使用。
---

# 电商商品图生成

## 何时使用
（从老 skill 提炼：哪些用户意图属于本技能）

## 执行步骤
1. 明确商品主体、场景与风格；缺失关键信息先与用户确认
2. 用 upsert_media_node 创建 image 节点并撰写提示词（结构：主体 → 场景 → 光线 → 风格 → 质量词）
3. 侧栏参考图用 apply_sidebar_attachments（mode=localRefs，@I* 芯片序）；画布已有图才用 attach_refs
4. 一致性要求写在提示词文本与 ref 顺序（先身份/主体，后服装/产品）
5. propose_generation 提议生成，等待用户确认

## 规则与边界
- 不虚构已出图；确认前不调用 run_*
- 芯片 key（@I1/I2）不是画布节点 id；禁止 connect_nodes 连芯片
（以下领域要点从老 skill 重写补充……）
```

> 注意：正文引用的工具名必须与 pi 链路现有工具一致（`upsert_media_node`/`apply_sidebar_attachments`/`propose_generation` 等），不得引用老链路独有工具。

- [ ] **Step 3: 镜像与 helm 接线**

Dockerfile 在 `COPY services/pi-runtime/ services/pi-runtime/` 之后追加：

```dockerfile
COPY skills ./skills
```

helm env 追加 `PI_RUNTIME_SKILLS_DIR: /app/skills`。

- [ ] **Step 4: 本地冒烟**

Run: `cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && PI_RUNTIME_SKILLS_DIR=/Users/4seven/workspace/pi-lnk/skills npm run build && npm test`
Expected: build 成功、测试全绿。

- [ ] **Step 5: Commit**

```bash
git add skills/ services/pi-runtime/Dockerfile charts/pi-lnk-runtime/
git commit -m "feat(skills): 电商商品图 skill（Anthropic 格式重写）+ 镜像/helm 接线"
```

### Task 6: drop-in 验收 + 全量回归 + 部署

**Files:**
- Modify: `services/pi-runtime/src/skills/loader.test.ts`（drop-in 端到端用例）
- Modify: `docs/ops/RUNBOOK-pi-runtime-deploy.md`（追加 skill 章节）

**Interfaces:**
- Consumes: 前 5 个任务全部产物
- Produces: 可部署镜像 + 验收记录

- [ ] **Step 1: drop-in 自动化验收测试**

`loader.test.ts` 追加端到端用例：把一个「第三方风格」SKILL.md（测试内嵌字符串，模拟外部作者写的文件，**含 YAML 多行 description（`>` 语法）与 `references/` 子目录**）写入临时目录 → `discoverSkills` 发现且 description 解析正确 → `buildSkillIndexBlock` 含其 name → `createSkillTools` 的 `load_skill` 取到正文。全程零业务代码改动即通过 = 验收线成立。若多行 description 解析失败，按 Task 2 注记引入 `yaml` 依赖修复。

- [ ] **Step 2: 全量回归**

Run: `cd /Users/4seven/workspace/pi-lnk && pnpm -r test && pnpm -r build`
Expected: 全绿（CI「Build monorepo」口径）。

- [ ] **Step 3: Runbook 更新**

`docs/ops/RUNBOOK-pi-runtime-deploy.md` 追加：skills 目录链路（仓库 `skills/` → 镜像 `/app/skills` → env `PI_RUNTIME_SKILLS_DIR`）、新增 skill 的 drop-in 步骤、`/metrics` 观测点（`pi_runtime_skills_loaded`、`load_skill|ok`）。

- [ ] **Step 4: Commit + PR + 部署**

```bash
git add services/pi-runtime/src/skills/loader.test.ts docs/ops/RUNBOOK-pi-runtime-deploy.md
git commit -m "test(pi-runtime): drop-in 验收用例 + runbook skill 章节"
git push origin p1/skill-framework && gh pr create --repo sev7n4/pi-lnk --base master
```

merge 后走发布门（dispatch deploy.yml {ref:master,branch:master}），验收：镜像 tag=sha+healthy、`/metrics` 出现 `pi_runtime_skills_loaded 1`、公网发「帮我做一张商品白底图」观察 SSE tool_call 是否出现 `load_skill`、thread-verify PASS=16 FAIL=0。

## Self-Review 记录

- Spec coverage：alignment §4 #1 typed layers（Task 1）、#2 manifest（Task 1+4）、§5 范围定案（老 skills 不迁=Task 5 重写而非搬运；drop-in 验收=Task 6；MCP/connector/expert 不涉及）✅；`memory` kind 预留 ✅
- 类型一致性：`SkillRegistry` Task 4 定义/消费；`createSkillTools` Task 3 定义、Task 4 消费；`approxTokens` Task 1 内闭环 ✅
- Review Focus 5 条均 pinned ✅
