# 提示词注册中心 W1a 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Nest 侧系统提示词规则从 TS 模板常量搬进受管文件资产 `prompt-registry/`，并保持 `assembleStatic` 对任意规则组组合的输出逐字符不变，同时装上第一道 CI 门禁与版本身份。

**Architecture:** 内容即文件——每条规则一个带 YAML frontmatter 的 `.md`，总登记处 `MANIFEST.yaml`；运行时侧一个薄 loader（`prompt-registry.loader.ts`）负责解析、校验、算哈希与按组渲染；`composeRuleText` 换成 `renderStatic`，原常量降级为同目录的纯模块 `prompt-registry.fallback.ts` 作容器兜底；lint 与运行时共用 loader 的 `assertRegistryIntegrity`，保证 CI 与线上同一套判据。

**Tech Stack:** Node 20 (原生 `node:crypto` / `node:fs`)、TypeScript、`vitest`（`apps/server` 侧，`globals: true`）、仓库根 `tsx` 跑 lint CLI、GitHub Actions、Docker 多阶段构建。

**Spec:** [`docs/superpowers/specs/2026-10-02-w1a-prompt-registry-design.md`](./../../specs/2026-10-02-w1a-prompt-registry-design.md)

---

## Global Constraints

以下几条是**跨任务、跨文件**的硬约束，每个任务的每步都隐式包含它们：

1. **字节等价不变式（最高优先级）**：`renderStatic(groups)` 的输出必须与搬家前 `composeRuleText(groups)` 的输出**逐字符相等**，对 §4.4 的四种组合（core / core+writeTools / core+genTools / core+writeTools+genTools）逐一成立。任何一次提交若破坏了它，测试必须红。
2. **取证基线 = `origin/master` `d574b8b`**。全部宿主侧行号以该基线为准（工作区当前有并行窗口改动，`trust-boundary.ts` 已不在工作区，不复现它的现状）。
3. **开工前先 `git fetch`**，从 `origin/master` 拉 worktree `.worktrees/w1a-prompt-registry` 再动；**禁止把主工作区的文件整份 cp 进 worktree**（仓库既有纪律：历史上有 `tiering.ts` 被回退、改动混入他人口味的先例）。
4. **不新增运行时依赖**。`apps/server/package.json` 里没有 yaml 库，frontmatter 用 loader 内的扁平解析器手写（字段全是标量，无需 YAML  AST）。
5. **feature 分支 + PR + squash merge**；分支名 `feat/w1a-prompt-registry`。
6. **文案一个字都不改写**。本包只搬家，措辞改写归 W4–W5（硬门槛：W1b 的 L1 判据可信）。
7. 相对路径一律以 worktree 根目录为基准；容器内的 root 由 loader 三级解析决定（§5.2）。

---

## Review Focus

下面五类输入/场景，spec 给了意图但没有测试直接护住，是最容易咬人的地方；每行都指到拥有该代码的那个任务的具体用例：

1. **`.dockerignore:6` 的 `*.md`** 会把 `prompt-registry/**/*.md` 排除出镜像上下文，且症状是**静默降级**（`degraded=true` 用 fallback，服务不报错、看日志才发现）——不得靠"线上应该没事"蒙混，必须为真 `.md` 加显式白名单，并用容器里 `ls | wc -l = 7` 验收 ⇒ Task 7 用例 C。
2. **改了 `.md` 但没触发发布**：`deploy.yml` 的 `on.push.paths` 与 `changes` 的 `api` filter 若不含 `prompt-registry/**`，只改一个字的提交连 workflow 都不启动，容器里还是旧文案 ⇒ Task 6 + 用例 C。
3. **中文标点/全角字符被误判**：frontmatter 值里出现中文冒号、`#` 注释、`"` 引号会让扁平 YAML 解析器切错字段，进而 L1 误报或 L4 白名单校验漏过 ⇒ Task 3 的 `parseFlatYaml` 用例。
4. **路径解析在容器内找不到目录**：生产 cwd 是 `/app/apps/server`（`deploy/docker/docker-entrypoint.sh:3`），靠 cwd 向上找不保险，必须显式 `/app/prompt-registry` 级 ⇒ Task 3 的 `resolveRegistryRoot` 三级用例 + Task 7 容器证据。
5. **lint 只在本地绿、CI 跑法不同**：`pnpm prompt:lint` 用根 `tsx` 直连 loader，loader 若 import 了 `@nestjs/common`，CI 里从仓库根跑会解析不到 nest ⇒ 因此 fallback 常量与 loader **一律不 import nest**（Task 3/4 的模块划分就是这个原因）。

---

## 文件结构（任务分解的地基）

| 路径 | 动作 | 职责 |
|---|---|---|
| `prompt-registry/MANIFEST.yaml` | 新增 | Registry 整体版本 + 7 条目登记（id/version/order） |
| `prompt-registry/rules/<id>.md` × 7 | 新增 | 规则内容 + frontmatter；body 逐字符等于原 TS 常量 |
| `.dockerignore` | 改 | 加 `!prompt-registry/**/*.md` 白名单（**spec §9 漏项，本 plan 补**） |
| `apps/server/src/agent/pi-runtime/prompt-registry.fallback.ts` | 新增 | 7 个原样常量，纯模块无 nest 依赖，兼 lint L7 的对照物 |
| `apps/server/src/agent/pi-runtime/prompt-registry.loader.ts` | 新增 | 解析 / 校验 / 哈希 / 渲染，纯函数 + 一处 IO |
| `apps/server/src/agent/pi-runtime/prompt-registry.loader.test.ts` | 新增 | loader 单测（含 L1–L9 负例） |
| `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.ts` | 改 | `composeRuleText` → `renderStatic`；manifest 两字段；启动日志行 |
| `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.test.ts` | 改 | 补四条 golden + fallback 分支 |
| `scripts/prompt-lint.ts` | 新增 | lint CLI 外壳（root 解析 + 非零退出） |
| `package.json`（根） | 改 | `scripts.prompt-lint` 一行 |
| `.github/workflows/prompt-lint.yml` | 新增 | PR + master 推送门禁 |
| `deploy/docker/Dockerfile.api` | 改 | build/runner 两处 COPY |
| `.github/workflows/deploy.yml` | 改 | push paths + api filter 各加一条 |

---

### Task 1: Registry 内容资产（7 个 `.md` + `MANIFEST.yaml`）

**Files:**
- Create: `prompt-registry/MANIFEST.yaml`
- Create: `prompt-registry/rules/identity.opening.md`, `no_gen_claim.nogen.md`, `no_gen_claim.gen.md`, `sidebar_vision.tail.md`, `media_tool_policy.md`, `gen_tool_policy.md`, `write_guard.md`

**Interfaces:**
- Consumes: 原 `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.ts:89-123` 的 7 个常量（本任务只读，不改）
- Produces: 磁盘上的 7 个 `.md` 与 1 份 `MANIFEST.yaml`，供 Task 3 的 loader 消费

本任务**不动任何运行时代码**——先把内容落盘，再用 Task 3/4 的测试证明字节等价。手工抄写中文文案必然抄错一个标点（首轮报告已记录过同类口子），所以走脚本抽取。

- [ ] **Step 1: 开工准备——fetch 并起 worktree**

```bash
git fetch --all
git worktree add .worktrees/w1a-prompt-registry origin/master -b feat/w1a-prompt-registry
cd .worktrees/w1a-prompt-registry
git log --oneline -1          # 必须显示 d574b8b（取证基线）
```

预期：worktree 里 `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.ts` 存在；主工作区不改。

- [ ] **Step 2: 写一次性迁移脚本（内容直接从现有常量抽取，不手抄）**

新建 `/tmp/gen-registry.mjs`（一次性，跑完即删；**不进仓库**）：

```js
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const SRC = "apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.ts";
const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);
const ROOT = "prompt-registry/rules";
const OWNER = "agent-platform";
const UPDATED = "2026-10-02";

// [Registry id, 原 TS 常量名, order, group, unlessGroup, title]
const SPEC = [
  ["identity.opening",     "CORE_RULES_PREFIX",   10, null, null, "身份与语气"],
  ["no_gen_claim.nogen",   "RULE_3_NO_GEN",       20, null, null, "禁止声称正在生成（genTools 未启用）"],
  ["no_gen_claim.gen",     "RULE_3_GEN",          20, null, null, "禁止声称正在生成（genTools 启用）"],
  ["sidebar_vision.tail",  "CORE_RULES_TAIL",     30, null, null, "侧栏参考图与芯片 key"],
  ["media_tool_policy",    "WRITE_TOOLS_RULES",   40, "writeTools", null, "写工具策略"],
  ["gen_tool_policy",      "GEN_TOOLS_RULES",     50, "genTools", null, "生成工具策略"],
  ["write_guard",          "RULE_10_WRITE_GUARD", 60, null, "writeTools", "写操作守卫"],
];

const src = readFileSync(SRC, "utf8");
mkdirSync(ROOT, { recursive: true });
const manifest = [];
for (const [id, constName, order, group, unlessGroup, title] of SPEC) {
  const m = src.match(new RegExp("const " + constName + " = `([\\s\\S]*?)`;"));
  if (!m) throw new Error("未在 " + SRC + " 找到常量 " + constName);
  const body = m[1];
  if (/\s+$/.test(body)) throw new Error(constName + " 尾部有空白，会破坏 trimEnd 约定");
  const fm = ["---", `id: ${id}`, "version: 1.0.0", `title: ${title}`,
    `order: ${order}`, `owner: ${OWNER}`, `updated: ${UPDATED}`];
  if (group) fm.push(`group: ${group}`);
  if (unlessGroup) fm.push(`unlessGroup: ${unlessGroup}`);
  fm.push("---");
  writeFileSync(`${ROOT}/${id}.md`, `${fm.join("\n")}\n${body}\n`, "utf8");
  manifest.push({ id, version: "1.0.0", order, contentHash: hash(body) });
  console.log(`${id.padEnd(22)} ${constName.padEnd(20)} ${body.length} chars ${hash(body)}`);
}
writeFileSync("prompt-registry/MANIFEST.yaml",
  ["version: 0.1.0", "", "entries:", ...manifest.map((e) =>
    `  - id: ${e.id}\n    version: ${e.version}\n    order: ${e.order}\n    contentHash: ${e.contentHash}`)].join("\n") + "\n", "utf8");
console.log("registry entries:", manifest.length);
```

- [ ] **Step 3: 跑脚本并核对字符数**

```bash
node /tmp/gen-registry.mjs
```

预期输出（与 spec §5.4 的实测字符数逐行吻合，任何一格对不上说明基线取错了或文件被并行窗口改过）：

```
identity.opening      CORE_RULES_PREFIX     107 chars
no_gen_claim.nogen    RULE_3_NO_GEN          89 chars
no_gen_claim.gen      RULE_3_GEN             92 chars
sidebar_vision.tail   CORE_RULES_TAIL       269 chars
media_tool_policy     WRITE_TOOLS_RULES     911 chars
gen_tool_policy       GEN_TOOLS_RULES       468 chars
write_guard           RULE_10_WRITE_GUARD    79 chars
registry entries: 7
```

- [ ] **Step 4: 抽查一个文件，确认 frontmatter 与 body 分界正确**

```bash
cat prompt-registry/rules/identity.opening.md
```

预期（body 三行与 `pi-prompt-assembler.service.ts:89-92` 完全一致，且文件末尾只有**一个**换行）：

```
---
id: identity.opening
version: 1.0.0
title: 身份与语气
order: 10
owner: agent-platform
updated: 2026-10-02
---
你是 lnkpi 无限画布助手。用简洁中文回答。
规则：
1. 必须通过工具完成读写操作，禁止假装已执行。
2. 平台支持在画布上生成图片/视频等媒体；不得否认平台的图片生成能力，也不要引导用户使用第三方作图工具。
```

- [ ] **Step 5: 确认 Registry 总条目是 7 不是 8**

```bash
ls prompt-registry/rules/*.md | wc -l
```

预期 `7`。**注意与 spec 的口径差异**：spec §6、§9、§10 写了"八条目 / `entries=8` / 八条 id"，但 §5.4 的迁移表只有 7 行、且 `composeRuleText` 只组合这 7 段。`no_gen_claim.nogen` 与 `no_gen_claim.gen` 是同一规则的两版（互斥投放），不是两条独立规则。本 plan 一律按 **7** 落实；spec 侧的"八"应在 PR 里顺手订正为七。

- [ ] **Step 6: 提交**

```bash
git add prompt-registry
git commit -m "feat(prompt-registry): 落地 7 条规则文件资产与 MANIFEST 登记"
```

---

### Task 2: fallback 常量抽成纯模块

**Files:**
- Create: `apps/server/src/agent/pi-runtime/prompt-registry.fallback.ts`
- Modify: `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.ts:89-123`（删除内联常量，改为 import）

**Interfaces:**
- Consumes: 无
- Produces: `CORE_RULES_PREFIX` / `RULE_3_NO_GEN` / `RULE_3_GEN` / `CORE_RULES_TAIL` / `WRITE_TOOLS_RULES` / `GEN_TOOLS_RULES` / `RULE_10_WRITE_GUARD` 七个导出，签名即 `string`

把常量单独成一个纯模块，是为了让仓库根的 `tsx` 能直接 import 它做 L7 比对——一旦留在 `pi-prompt-assembler.service.ts` 里，lint 就要连带解析 `@nestjs/common`，在 CI 里从根跑会失败（Review Focus 第 5 条）。

- [ ] **Step 1: 新建纯模块，内容从现有文件逐字搬过来**

创建 `apps/server/src/agent/pi-runtime/prompt-registry.fallback.ts`，文件头注释 + 七个 `export const`，正文与 `pi-prompt-assembler.service.ts:88-123` **完全相同**（含每行行内的中文标点和无空格拼接点，如 `upsert_media_node创建或更新节点`、`mentioned_keys 用 I1/I2芯片序`）：

```ts
/**
 * Registry 不可用时的内嵌兜底文案（W1a：字节等价搬家的另一侧）。
 *
 * 本文件刻意不 import 任何运行时依赖（连 @nestjs/common 也不 import），
 * 让 scripts/prompt-lint.ts 能用仓库根的 tsx 直接 import 它做 L7 逐字符比对。
 * 内容必须与 prompt-registry/rules/*.md 的 body 完全一致——不一致由 lint 报错。
 */
export const CORE_RULES_PREFIX = `...`;   // 原 :89-92
export const RULE_3_NO_GEN = `...`;       // 原 :95
export const RULE_3_GEN = `...`;          // 原 :98
export const CORE_RULES_TAIL = `...`;     // 原 :100-101
export const WRITE_TOOLS_RULES = `...`;   // 原 :113-114
export const GEN_TOOLS_RULES = `...`;     // 原 :121-123
export const RULE_10_WRITE_GUARD = `...`; // 原 :106
```

搬运时用 `sed -n '88,123p'` 取原文粘贴，不要重打。

- [ ] **Step 2: 改 assembler 引用**

把 `pi-prompt-assembler.service.ts:88-123` 整段（含 `const CORE_RULES = ...` 那行，它只被 `composeRuleText` 用过、本包不再需要）删掉，在 import 区加一行：

```ts
import {
  CORE_RULES_PREFIX,
  RULE_3_GEN,
  RULE_3_NO_GEN,
  CORE_RULES_TAIL,
  WRITE_TOOLS_RULES,
  GEN_TOOLS_RULES,
  RULE_10_WRITE_GUARD,
} from "./prompt-registry.fallback";
```

- [ ] **Step 3: 跑现有测试确认没打碎东西**

```bash
pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/pi-prompt-assembler.service.test.ts
```

预期：全绿（常量搬家本身保证输出不变）。若红，八成是 import 路径写错——先红再修，不要跳步。

- [ ] **Step 4: 提交**

```bash
git add apps/server/src/agent/pi-runtime/prompt-registry.fallback.ts apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.ts
git commit -m "refactor(prompt-registry): 提示词常量抽成无依赖纯模块，供 lint 与运行时兜底共用"
```

---

### Task 3: loader（解析 / 校验 / 哈希 / 渲染）

**Files:**
- Create: `apps/server/src/agent/pi-runtime/prompt-registry.loader.ts`
- Create: `apps/server/src/agent/pi-runtime/prompt-registry.loader.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `prompt-registry.fallback.ts` 七个常量；磁盘上的 `prompt-registry/`
- Produces: `loadRegistry(root)` / `renderStatic(snapshot, groups)` / `renderStaticFallback(groups)` / `assertRegistryIntegrity(root)` / `describeRegistry(snapshot)`，供 Task 4 的 assembler 与 Task 5 的 lint CLI 使用

loader 是一处 IO（`loadRegistry`）、一堆纯函数。校验（L1–L9）与渲染分离，是为了让 lint 与运行时复用同一份判据——CI 与线上跑同一套规则，才能避免"本地过、线上炸"。

- [ ] **Step 1: 先写失败的单测**

创建 `prompt-registry.loader.test.ts`。测试用的 Registry 目录用 `mkdtempSync` 造临时目录，不依赖仓库里那份真资产（真资产由 Task 4 的 golden 用例覆盖）。

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertRegistryIntegrity,
  contentHash,
  loadRegistry,
  normalizeManifest,
  parseFrontmatter,
  parseManifest,
  registryHashOf,
  renderStatic,
  renderStaticFallback,
  resolveRegistryRoot,
} from "./prompt-registry.loader";

const write = (dir: string, file: string, text: string) => {
  mkdirSync(join(dir, "rules"), { recursive: true });
  writeFileSync(join(dir, file), text, "utf8");
  return dir;
};

const ONE = (over = "") => `---\nid: a.one\nversion: 1.0.0\ntitle: 规则一\norder: 10\nowner: agent-platform\nupdated: 2026-10-02\n---\n第一条规则。\n${over}`;

/** MANIFEST 既是登记处（L8），也是 L3 判定"内容是否变了"的基线快照。 */
const MANIFEST_OF = (id: string, version: string, contentHash: string) =>
  `version: 0.1.0\nentries:\n  - id: ${id}\n    version: ${version}\n    order: 10\n    contentHash: ${contentHash}\n`;

describe("parseFrontmatter", () => {
  it("无 frontmatter 时把全文当 body", () => {
    const { fields, body } = parseFrontmatter("纯文本\n第二行");
    expect(fields).toEqual({});
    expect(body).toBe("纯文本\n第二行");
  });

  it("按 vendor 约定：首行 --- 起、终止于 \\n---，从索引 3 起找", () => {
    const { fields, body } = parseFrontmatter(ONE());
    expect(fields).toMatchObject({ id: "a.one", version: "1.0.0", order: "10", group: undefined });
    expect(body).toBe("第一条规则。");
  });

  it("缺少终止分隔符时报错", () => {
    expect(() => parseFrontmatter("---\nid: a.one\nbody")).toThrow(/终止/);
  });

  it("frontmatter 含中文冒号与英文 # 时不切错字段", () => {
    const { fields } = parseFrontmatter(`---\nid: a.two\nversion: 1.0.0\n# 注释：中文冒号：在这里\ntitle: 含冒号\norder: 20\nowner: agent-platform\nupdated: 2026-10-02\n---\n正文`);
    expect(fields.id).toBe("a.two");
    expect(fields.title).toBe("含冒号");
  });

  it("带双引号的值会脱引号", () => {
    const { fields } = parseFrontmatter(`---\nid: a.three\nversion: "1.0.0"\ntitle: 引\norder: 30\nowner: agent-platform\nupdated: 2026-10-02\n---\n正文`);
    expect(fields.version).toBe("1.0.0");
  });
});

describe("contentHash / registryHashOf", () => {
  it("同输入同输出（12 位 hex）", () => {
    expect(contentHash("第一条规则。")).toMatch(/^[0-9a-f]{12}$/);
    expect(contentHash("第一条规则。")).toBe(contentHash("第一条规则。"));
  });

  it("normalizeManifest 对乱序输入结果稳定（确定性排序硬要求）", () => {
    const a = [{ id: "b", version: "1.0.0", order: 2, contentHash: "h2" }, { id: "a", version: "2.0.0", order: 1, contentHash: "h1" }];
    const b = [...a].reverse();
    expect(normalizeManifest(a as never)).toBe(normalizeManifest(b as never));
    expect(registryHashOf(a as never)).toBe(registryHashOf(b as never));
  });
});

describe("parseManifest", () => {
  it("按 - id: 分块读多条，同块内 version/order/contentHash 不互相覆盖", () => {
    const text = "version: 0.1.0\nentries:\n  - id: a.one\n    version: 1.0.0\n    order: 10\n    contentHash: h1\n  - id: a.two\n    version: 2.0.0\n    order: 20\n    contentHash: h2\n";
    expect(parseManifest(text)).toEqual([
      { id: "a.one", version: "1.0.0", order: 0, contentHash: "h1" },
      { id: "a.two", version: "2.0.0", order: 0, contentHash: "h2" },
    ]);
  });

  it("空 entries 返回空数组", () => {
    expect(parseManifest("version: 0.1.0\nentries: []\n")).toEqual([]);
  });
});

describe("resolveRegistryRoot", () => {
  it("显式环境变量优先", () => {
    process.env.PI_PROMPT_REGISTRY_DIR = "/tmp/whatever";
    expect(resolveRegistryRoot()).toBe("/tmp/whatever");
    delete process.env.PI_PROMPT_REGISTRY_DIR;
  });

  it("仓库根存在时返回 <root>/prompt-registry", () => {
    expect(resolveRegistryRoot()).toBe(join(process.cwd(), "prompt-registry"));
  });
});

describe("loadRegistry", () => {
  it("正常读盘：条目数、body 去尾空行、hash、degraded=false", () => {
    const root = write(mkdtempSync(join(tmpdir(), "pr-")), "rules/a.one.md", ONE());
    const snap = loadRegistry(root);
    expect(snap.degraded).toBe(false);
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0].body).toBe("第一条规则。");
    expect(snap.entries[0].contentHash).toMatch(/^[0-9a-f]{12}$/);
    expect(snap.registryVersion).toBe("");
  });

  it("目录读不到时 fail-soft：degraded=true 且给出原因，不抛", () => {
    const snap = loadRegistry("/tmp/definitely-not-here");
    expect(snap.degraded).toBe(true);
    expect(snap.degradedReason).toBeTruthy();
    expect(snap.entries).toEqual([]);
  });
});

describe("renderStatic", () => {
  const entry = (id: string, order: number, body: string, group?: string, unlessGroup?: string) =>
    ({ id, version: "1.0.0", title: "t", order, owner: "o", updated: "2026-10-02", body, contentHash: "h", group, unlessGroup });
  const snap = { registryVersion: "0.1.0", registryHash: "h", entries: [
    entry("identity", 10, "PREFIX"), entry("nogen", 20, "RULE3"), entry("gen", 20, "RULE3'", "genTools"),
    entry("tail", 30, "TAIL"), entry("media", 40, "WRITE", "writeTools"), entry("gen2", 50, "GEN", "genTools"),
    entry("guard", 60, "GUARD", undefined, "writeTools"),
  ], degraded: false };

  it("groups 空时返回空串", () => {
    expect(renderStatic(snap, [])).toBe("");
  });

  it("core 组 → 恒注入条目按 order 升序拼", () => {
    expect(renderStatic(snap, ["core"])).toBe("PREFIX\nRULE3\nTAIL");
  });

  it("core+writeTools → 追加 writeTools 组，unlessGroup 条目退出", () => {
    expect(renderStatic(snap, ["core", "writeTools"])).toBe("PREFIX\nRULE3\nTAIL\nWRITE");
  });

  it("core+genTools → 同一 order 的互斥版本取 group 命中那条，再追加 genTools 组", () => {
    expect(renderStatic(snap, ["core", "genTools"])).toBe("PREFIX\nRULE3'\nTAIL\nGEN");
  });

  it("三组全开 → writeTools 先于 genTools", () => {
    expect(renderStatic(snap, ["core", "writeTools", "genTools"])).toBe("PREFIX\nRULE3\nTAIL\nWRITE\nGEN");
  });
});

describe("renderStaticFallback", () => {
  it("绕过 snapshot 直接出内嵌常量文本", () => {
    expect(renderStaticFallback(["core"])).toContain("你是 lnkpi 无限画布助手");
  });
});

describe("assertRegistryIntegrity（L1-L9 负例各一条）", () => {
  const base = () => mkdtempSync(join(tmpdir(), "pr-"));
  const FULL = MANIFEST_OF("a.one", "1.0.0", contentHash("第一条规则。"));

  it("干净目录返回空数组", () => {
    const root = base();
    write(root, "prompt-registry/MANIFEST.yaml", FULL);
    write(root, "prompt-registry/rules/a.one.md", ONE());
    expect(assertRegistryIntegrity(root)).toEqual([]);
  });

  it("L1 frontmatter 缺字段", () => {
    const root = base();
    write(root, "prompt-registry/MANIFEST.yaml", FULL);
    write(root, "prompt-registry/rules/a.one.md", "---\nid: a.one\n---\n第一条规则。\n");
    expect(assertRegistryIntegrity(root).join("\n")).toMatch(/L1/);
  });

  it("L2 id 与文件名不一致", () => {
    const root = base();
    write(root, "prompt-registry/MANIFEST.yaml", FULL);
    write(root, "prompt-registry/rules/a.one.md", ONE().replace("id: a.one", "id: a.other"));
    expect(assertRegistryIntegrity(root).join("\n")).toMatch(/L2/);
  });

  it("L3 body 改了但 MANIFEST 里的 contentHash 与 version 没同步（强制 bump 义务）", () => {
    const root = base();
    write(root, "prompt-registry/MANIFEST.yaml", MANIFEST_OF("a.one", "1.0.0", "000000000000"));
    write(root, "prompt-registry/rules/a.one.md", ONE().replace("第一条规则。", "改了内容"));
    expect(assertRegistryIntegrity(root).join("\n")).toMatch(/L3/);
  });

  it("L4 group 取值不在白名单", () => {
    const root = base();
    write(root, "prompt-registry/MANIFEST.yaml", FULL);
    write(root, "prompt-registry/rules/a.one.md", ONE().replace("order: 10", "order: 10\ngroup: whatever"));
    expect(assertRegistryIntegrity(root).join("\n")).toMatch(/L4/);
  });

  it("L5 body 含尾随空行", () => {
    const root = base();
    write(root, "prompt-registry/MANIFEST.yaml", FULL);
    write(root, "prompt-registry/rules/a.one.md", `${ONE()}\n\n`);
    expect(assertRegistryIntegrity(root).join("\n")).toMatch(/L5/);
  });

  it("L5 body 含裸尖括号（会进 CDATA 吞掉文档）", () => {
    const root = base();
    write(root, "prompt-registry/MANIFEST.yaml", FULL);
    write(root, "prompt-registry/rules/a.one.md", ONE().replace("第一条规则。", "<style>别这样</style>"));
    expect(assertRegistryIntegrity(root).join("\n")).toMatch(/L5/);
  });

  it("L7 fallback 常量与文件不一致", () => {
    const root = base();
    write(root, "prompt-registry/MANIFEST.yaml", FULL);
    write(root, "prompt-registry/rules/identity.opening.md", ONE().replace("id: a.one", "id: identity.opening").replace("第一条规则。", "别的文案"));
    const errs = assertRegistryIntegrity(root).join("\n");
    expect(errs).toMatch(/L7/);
  });

  it("L8 MANIFEST 漏登记", () => {
    const root = base();
    write(root, "prompt-registry/MANIFEST.yaml", "version: 0.1.0\nentries: []\n");
    write(root, "prompt-registry/rules/a.one.md", ONE());
    expect(assertRegistryIntegrity(root).join("\n")).toMatch(/L8/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/prompt-registry.loader.test.ts
```

预期：大量 `Cannot find module './prompt-registry.loader'`。

- [ ] **Step 3: 实现 loader**

创建 `prompt-registry.loader.ts`：

```ts
/**
 * prompt-registry 薄 loader：解析、校验、算版本身份、按组渲染。
 *
 * 设计约束（Review Focus 第 5 条）：本文件**不 import 任何运行时依赖**
 * （不 import @nestjs/common、不 import assembler），好让仓库根的 tsx
 * 直接 import 它跑 lint；IO 只出现在 loadRegistry 一处，其余全是纯函数。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CORE_RULES_PREFIX,
  GEN_TOOLS_RULES,
  RULE_3_GEN,
  RULE_3_NO_GEN,
  RULE_10_WRITE_GUARD,
  CORE_RULES_TAIL,
  WRITE_TOOLS_RULES,
} from "./prompt-registry.fallback";

/** L4 白名单：group / unlessGroup 出现未知值即报错。 */
const GROUP_VALUES = new Set<string>(["writeTools", "genTools"]);

const REQUIRED_FIELDS = ["id", "version", "title", "order", "owner", "updated"] as const;

export interface PromptRegistryEntry {
  id: string; version: string; title: string; order: number;
  group?: string; unlessGroup?: string;
  owner: string; updated: string;
  body: string;
  contentHash: string;
}

export interface PromptRegistrySnapshot {
  registryVersion: string;
  registryHash: string;
  entries: PromptRegistryEntry[];
  degraded: boolean;
  degradedReason?: string;
}

/** L9：代码侧声明的、必须由 Registry 提供的 id 清单。 */
export const COMPOSED_IDS = [
  "identity.opening", "no_gen_claim.nogen", "no_gen_claim.gen", "sidebar_vision.tail",
  "media_tool_policy", "gen_tool_policy", "write_guard",
] as const;

/** L7：Registry id → fallback 常量的映射。 */
export const FALLBACK_BY_ID: Record<string, string> = {
  "identity.opening": CORE_RULES_PREFIX,
  "no_gen_claim.nogen": RULE_3_NO_GEN,
  "no_gen_claim.gen": RULE_3_GEN,
  "sidebar_vision.tail": CORE_RULES_TAIL,
  "media_tool_policy": WRITE_TOOLS_RULES,
  "gen_tool_policy": GEN_TOOLS_RULES,
  "write_guard": RULE_10_WRITE_GUARD,
};

/** 与 vendor 的 prompt-templates.ts 同族分隔符：首行 --- 起，终止于 \n---。 */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  if (!text.startsWith("---")) return { fields: {}, body: text.replace(/^\n/, "") };
  const end = text.indexOf("\n---", 3);
  if (end === -1) throw new Error("frontmatter 缺少终止分隔符 \\n---");
  const fields = parseFlatYaml(text.slice(3, end));
  const body = text.slice(end + 4).replace(/^\n/, "");
  return { fields, body };
}

/** 只认扁平 `key: value`（含引号剥离）；不支持嵌套、列表、块标量。 */
function parseFlatYaml(raw: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf(":");
    if (i === -1) continue;
    let value = t.slice(i + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    fields[t.slice(0, i).trim()] = value;
  }
  if (Object.keys(fields).length === 0) throw new Error("frontmatter 为空或不是扁平键值");
  return fields;
}

/** 单件内容哈希：sha256(body) 前 12 位 hex。 */
export function contentHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 12);
}

/** 规范化清单：按 order 升序（同 order 用 id 稳定兜底），条目为 id@version#contentHash。 */
export function normalizeManifest(entries: PromptRegistryEntry[]): string {
  return [...entries]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((e) => `${e.id}@${e.version}#${e.contentHash}`)
    .join("\n");
}

export function registryHashOf(entries: PromptRegistryEntry[]): string {
  return contentHash(normalizeManifest(entries));
}

export interface ManifestEntry { id: string; version: string; order: number; contentHash: string; }

/** 按 `- id:` 分块读 MANIFEST（每个条目是独立块，不能用扁平解析，否则会互相覆盖）。 */
export function parseManifest(text: string): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  let cur: ManifestEntry | null = null;
  for (const line of text.split("\n")) {
    const head = line.match(/^\s*-\s+id:\s*(\S+)\s*$/);
    if (head) {
      cur = { id: head[1], version: "", order: 0, contentHash: "" };
      out.push(cur);
      continue;
    }
    const kv = line.match(/^\s+(version|order|contentHash):\s*(\S+)\s*$/);
    if (kv && cur) {
      if (kv[1] === "version") cur.version = kv[2];
      if (kv[1] === "contentHash") cur.contentHash = kv[2];
    }
  }
  return out;
}

/** 容器三级解析：显式 env → 容器内 /app/prompt-registry → 从 cwd 向上找。 */
export function resolveRegistryRoot(): string {
  if (process.env.PI_PROMPT_REGISTRY_DIR) return process.env.PI_PROMPT_REGISTRY_DIR;
  if (existsSync("/app/prompt-registry/rules")) return "/app/prompt-registry";
  let dir = resolve(process.cwd());
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "prompt-registry", "rules"))) return join(dir, "prompt-registry");
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), "prompt-registry");
}

/** 读盘 + 校验 + 算版本；失败不抛，走 degraded 语义（运行时 fail-soft）。 */
export function loadRegistry(root: string): PromptRegistrySnapshot {
  const empty = (reason: string): PromptRegistrySnapshot => ({
    registryVersion: "", registryHash: contentHash(""), entries: [], degraded: true, degradedReason: reason,
  });
  try {
    const rulesDir = join(root, "rules");
    const files = readdirSync(rulesDir).filter((f) => f.endsWith(".md")).sort();
    const entries: PromptRegistryEntry[] = [];
    for (const file of files) {
      const { fields, body } = parseFrontmatter(readFileSync(join(rulesDir, file), "utf8"));
      entries.push({
        id: fields.id, version: fields.version, title: fields.title, order: Number(fields.order),
        group: fields.group, unlessGroup: fields.unlessGroup,
        owner: fields.owner, updated: fields.updated,
        body: body.trimEnd(), contentHash: contentHash(body.trimEnd()),
      });
    }
    const manifestPath = join(root, "MANIFEST.yaml");
    const registryVersion = existsSync(manifestPath)
      ? (parseFlatYaml(readFileSync(manifestPath, "utf8")).version ?? "")
      : "";
    return { registryVersion, registryHash: registryHashOf(entries), entries, degraded: false };
  } catch (err) {
    return empty(err instanceof Error ? err.message : String(err));
  }
}

/** 按组渲染静态段；与搬家前的 composeRuleText() 逐字节等价（spec §4.4）。 */
export function renderStatic(snapshot: PromptRegistrySnapshot, groups: readonly string[]): string {
  const coreOn = groups.includes("core");
  return [...snapshot.entries]
    .sort((a, b) => a.order - b.order)
    .filter((e) => {
      if (e.group) { if (!groups.includes(e.group)) return false; }
      else if (!coreOn) return false;
      if (e.unlessGroup && groups.includes(e.unlessGroup)) return false;
      return true;
    })
    .map((e) => e.body)
    .join("\n");
}

/** fallback 路径：直接用内嵌常量出静态段（容器读不到目录时的退路）。 */
export function renderStaticFallback(groups: readonly string[]): string {
  const coreOn = groups.includes("core");
  const parts: string[] = [];
  if (coreOn) {
    parts.push(groups.includes("genTools")
      ? `${CORE_RULES_PREFIX}\n${RULE_3_GEN}\n${CORE_RULES_TAIL}`
      : `${CORE_RULES_PREFIX}\n${RULE_3_NO_GEN}\n${CORE_RULES_TAIL}`);
  }
  if (groups.includes("writeTools")) parts.push(WRITE_TOOLS_RULES);
  if (groups.includes("genTools")) parts.push(GEN_TOOLS_RULES);
  if (!groups.includes("writeTools") && coreOn) parts.push(RULE_10_WRITE_GUARD);
  return parts.filter(Boolean).join("\n");
}

/** L1-L9 全量校验；返回错误数组，空数组 = 通过（CI 与运行时共用同一份判据）。 */
export function assertRegistryIntegrity(root: string): string[] {
  const errors: string[] = [];
  const add = (code: string, msg: string) => errors.push(`${code} ${msg}`);
  try {
    const rulesDir = join(root, "rules");
    const files = readdirSync(rulesDir).filter((f) => f.endsWith(".md")).sort();
    if (files.length === 0) add("L0", `${rulesDir} 下没有 .md`);
    const seen = new Map<string, PromptRegistryEntry>();
    for (const file of files) {
      const path = join(rulesDir, file);
      let fields: Record<string, string>;
      let body: string;
      try {
        ({ fields, body } = parseFrontmatter(readFileSync(path, "utf8")));
      } catch (err) {
        add("L1", `${file} frontmatter 解析失败：${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const key of REQUIRED_FIELDS) {
        if (!fields[key]) add("L1", `${file} 缺必填字段 ${key}`);
      }
      if (fields.id !== file.replace(/\.md$/, "")) add("L2", `${file} 的 id(${fields.id}) 与文件名不一致`);
      if (seen.has(fields.id)) add("L2", `id ${fields.id} 重复（${seen.get(fields.id)?.id ?? file} 与 ${file}）`);
      for (const key of ["group", "unlessGroup"] as const) {
        const v = fields[key];
        if (v && !GROUP_VALUES.has(v)) add("L4", `${file} 的 ${key}=${v} 不在白名单 [${[...GROUP_VALUES].join(",")}]`);
      }
      const raw = readFileSync(path, "utf8");
      const rawBody = raw.slice(raw.indexOf("\n---", 3) + 4).replace(/^\n/, "");
      if (/\s+$/.test(rawBody)) add("L5", `${file} body 含尾部空白（trimEnd 不幂等）`);
      if (/<[A-Za-z][^>]*>/.test(body)) add("L5", `${file} body 含裸尖括号标签，会进 CDATA 吞掉上下文`);
      const trimmed = body.trimEnd();
      if (rawBody.trimEnd() !== trimmed) add("L5", `${file} 与 trimEnd 约定不一致`);
      if (COMPOSED_IDS.includes(fields.id as (typeof COMPOSED_IDS)[number])
        && FALLBACK_BY_ID[fields.id] !== undefined && FALLBACK_BY_ID[fields.id] !== trimmed) {
        add("L7", `${file} 的 body 与 prompt-registry.fallback.ts 的 ${fields.id} 常量不一致`);
      }
      seen.set(fields.id, { id: fields.id, version: fields.version, title: fields.title,
        order: Number(fields.order), group: fields.group, unlessGroup: fields.unlessGroup,
        owner: fields.owner, updated: fields.updated, body: trimmed, contentHash: contentHash(trimmed) });
    }
    // L8 / L3：MANIFEST 是登记处，同时充当 L3「内容相对基线是否变了」的基线快照
    const manifestPath = join(root, "MANIFEST.yaml");
    const manifestText = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : "";
    const declared = parseManifest(manifestText);
    const byId = new Map(declared.map((e) => [e.id, e]));
    if (!existsSync(manifestPath)) {
      add("L8", `${root}/MANIFEST.yaml 不存在`);
    } else {
      const top = parseFlatYaml(manifestText);
      if (!/^\d+\.\d+\.\d+$/.test(top.version ?? "")) {
        add("L8", `MANIFEST.yaml 的 version(${top.version ?? ""}) 不是 MAJOR.MINOR.PATCH`);
      }
      for (const [id, e] of seen) {
        const d = byId.get(id);
        if (!d) { add("L8", `${id} 未在 MANIFEST.yaml 登记`); continue; }
        // L3：body 相对基线变了却没同步 version + contentHash → 拦下
        if (d.contentHash && d.contentHash !== e.contentHash) {
          add("L3", `${id} 的 body 已变（磁盘 ${e.contentHash} ≠ 登记 ${d.contentHash}）：请 bump 该条 version 并同步 MANIFEST 里的 contentHash`);
        }
        if (d.version !== e.version) {
          add("L8", `${id} 的 MANIFEST version(${d.version}) 与 frontmatter(${e.version}) 不一致`);
        }
      }
      for (const d of declared) if (!seen.has(d.id)) add("L8", `MANIFEST.yaml 登记的 ${d.id} 没有对应 .md 文件`);
    }
    // L9：代码声明的 id 必须都在 Registry 里
    for (const id of COMPOSED_IDS) if (!seen.has(id)) add("L9", `代码声明引用的 id ${id} 不在 Registry 中`);
    // L6：预算（恒注入 + 常见组合 ≤ 2400 字符）
    const snap = { registryVersion: "", registryHash: "", entries: [...seen.values()], degraded: false };
    for (const combo of [["core"], ["core", "writeTools"], ["core", "genTools"], ["core", "writeTools", "genTools"]]) {
      const n = renderStatic(snap, combo).length;
      if (n > 2400) add("L6", `组合 ${combo.join("+")} 静态段 ${n} 字符，超过预算 2400`);
    }
    return errors;
  } catch (err) {
    return [`L0 无法读取 Registry：${err instanceof Error ? err.message : String(err)}`];
  }
}

/** 人类可读的一行版本摘要，供启动日志与 manifest 行使用。 */
export function describeRegistry(snapshot: PromptRegistrySnapshot): string {
  return `prompt registry version=${snapshot.registryVersion} hash=${snapshot.registryHash} entries=${snapshot.entries.length} degraded=${snapshot.degraded}${snapshot.degradedReason ? ` reason=${snapshot.degradedReason}` : ""}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/prompt-registry.loader.test.ts
```

预期：`20 passed`。若 `resolveRegistryRoot` 那条在 worktree 里失败：worktree 根下确实有 `prompt-registry/rules`（Task 1 已建），cwd = worktree 根 ⇒ 命中第三级，返回 `<cwd>/prompt-registry`。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/agent/pi-runtime/prompt-registry.loader.ts apps/server/src/agent/pi-runtime/prompt-registry.loader.test.ts
git commit -m "feat(prompt-registry): 新增薄 loader（解析/校验/版本哈希/按组渲染）与单测"
```

---

### Task 4: assembler 切换到 renderStatic（字节等价落地）

**Files:**
- Modify: `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.ts:26-52,131-140,159-163,216-230`
- Modify: `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.test.ts`（补 golden）

**Interfaces:**
- Consumes: Task 3 的 `loadRegistry` / `renderStatic` / `renderStaticFallback` / `describeRegistry`
- Produces: `assembleStatic` 的新输出（逐字符等于旧输出）；`lastManifestDetail` 新增 `registryVersion` / `registryHash` 两字段

这是整个 W1a 的主战场：**输出必须一字不变**。所以切换手法是「默认走 Registry，读不到立刻退 fallback」，而不是「先改再说」。

- [ ] **Step 1: 补 golden 测试（先红后绿）**

在 `pi-prompt-assembler.service.test.ts` 末尾追加：

```ts
import { renderStatic, renderStaticFallback, loadRegistry, resolveRegistryRoot } from "./prompt-registry.loader";
import { CORE_RULES_PREFIX, RULE_3_NO_GEN, RULE_3_GEN, CORE_RULES_TAIL, WRITE_TOOLS_RULES, GEN_TOOLS_RULES, RULE_10_WRITE_GUARD } from "./prompt-registry.fallback";

const EXPECTED: Record<string, string> = {
  core: `${CORE_RULES_PREFIX}\n${RULE_3_NO_GEN}\n${CORE_RULES_TAIL}`,
  "core+writeTools": `${CORE_RULES_PREFIX}\n${RULE_3_NO_GEN}\n${CORE_RULES_TAIL}\n${WRITE_TOOLS_RULES}`,
  "core+genTools": `${CORE_RULES_PREFIX}\n${RULE_3_GEN}\n${CORE_RULES_TAIL}\n${GEN_TOOLS_RULES}`,
  "core+writeTools+genTools": `${CORE_RULES_PREFIX}\n${RULE_3_NO_GEN}\n${CORE_RULES_TAIL}\n${WRITE_TOOLS_RULES}\n${GEN_TOOLS_RULES}`,
};

const GROUPS: Record<string, Array<"core" | "writeTools" | "genTools">> = {
  core: ["core"],
  "core+writeTools": ["core", "writeTools"],
  "core+genTools": ["core", "genTools"],
  "core+writeTools+genTools": ["core", "writeTools", "genTools"],
};

describe("W1a 字节等价：Registry 渲染 == 搬家前 composeRuleText", () => {
  for (const [name, groups] of Object.entries(GROUPS)) {
    it(`组合 ${name} 逐字符相等`, async () => {
      const asm = makeAssembler({ nodes: [] });
      const text = await asm.assembleStatic({ ruleGroups: groups });
      expect(text).toBe(EXPECTED[name]);
      // 第二重保险：与 fallback 常量渲染结果也一致
      expect(text).toBe(renderStaticFallback(groups));
      // 第三重保险：与 Registry 渲染一致
      expect(text).toBe(renderStatic(loadRegistry(resolveRegistryRoot()), groups));
    });
  }

  it("renderStaticFallback 在 !writeTools 时补写守卫", () => {
    expect(renderStaticFallback(["core"]).includes(RULE_10_WRITE_GUARD)).toBe(true);
    expect(renderStaticFallback(["core", "writeTools"]).includes(RULE_10_WRITE_GUARD)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认**`resolveRegistryRoot()`**能拿到真 Registry**

```bash
pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/pi-prompt-assembler.service.test.ts
```

预期：新加的 4 条 golden **暂时红**，原因是 `loadRegistry` 还没被 assembler 调用（此刻 `renderStatic(loadRegistry(...))` 与 fallback 结果不等只可能在 registry 目录残缺时发生）。若全绿但 `EXPECTED` 与实测不等，先别改期望值——用 `git stash` 对比搬家前的 `composeRuleText` 输出。

- [ ] **Step 3: 切 assembler**

改 `pi-prompt-assembler.service.ts`：

① import 段加：

```ts
import {
  describeRegistry,
  loadRegistry,
  renderStatic,
  renderStaticFallback,
  resolveRegistryRoot,
} from "./prompt-registry.loader";
```

② `assembleStatic`（`:159-163`）替换为：

```ts
	async assembleStatic(input: { ruleGroups?: RuleGroup[] }): Promise<string> {
		// 有意每次重读目录（会话创建不是热路径）：Registry 文件变了重启即生效，不引入缓存失效的复杂度。
		const groups = input.ruleGroups ?? ["core"];
		const snapshot = loadRegistry(resolveRegistryRoot());
		const text = snapshot.degraded ? renderStaticFallback(groups) : renderStatic(snapshot, groups);
		this.logRegistryOnce();
		this.recordLayers([layer("rules", "rules", text)], "");
		return text;
	}
```

③ 在 `PiPromptAssembler` 类外用模块级一次性标志补"启动日志"：

```ts
/** 进程内只打一次：进程启动后第一个会话创建时能看到当前跑的是哪版提示词。 */
let staticRegistryLogged = false;
```

④ 在类里加：

```ts
	/** 首次静态段装配时打印一行 Registry 身份（模块级只打一次，可单测输出的纯函数部分）。 */
	private logRegistryOnce(): void {
		if (staticRegistryLogged) return;
		staticRegistryLogged = true;
		this.logger.log(describeRegistry(loadRegistry(resolveRegistryRoot())));
	}
```

⑤ `recordLayers`（`:216-230`）的 manifest 行尾追加 Registry 版本身份：`PromptManifest` 接口加两字段：

```ts
	registryVersion: string;
	registryHash: string;
```

`recordLayers` 里：

```ts
		const snap = loadRegistry(resolveRegistryRoot());
		const registryVersion = snap.registryVersion;
		const registryHash = snap.registryHash;
		this.lastManifestDetail = {
			sessionId,
			layers: [...],
			totalTokens,
			promptHash: hash,
			registryVersion,
			registryHash,
		};
		this.lastManifest = `prompt manifest ${sessionId || "(static)"}: ${layers
			.map((l) => `${l.id}:${l.kind}:${l.approxTokens}tok`)
			.join(" ")} total=${totalTokens}tok hash=${hash} registry=${registryVersion || "n/a"} registryHash=${registryHash}`;
```

⑥ 删除 `:131-140` 的 `composeRuleText` 函数体（逻辑已被 `renderStatic` + `renderStaticFallback` 覆盖），函数上方那段"规则组拼装"注释搬到 `prompt-registry.loader.ts` 顶部或保留为 `renderStatic` 的上下文说明。

- [ ] **Step 4: 跑测试确认全绿（含新增 golden）**

```bash
pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/pi-prompt-assembler.service.test.ts
pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/prompt-registry.loader.test.ts
```

预期：两个文件全绿，且 4 条 golden 同时通过三路比对（Registry / fallback / 字面期望）。

- [ ] **Step 5: 补一条 degraded 分支的单测**

在 `pi-prompt-assembler.service.test.ts` 追加：

```ts
describe("W1a：Registry 不可用时的 fail-soft", () => {
  it("loadRegistry 走 degrade 分支时仍出静态段，不抛且带 registry=n/a", async () => {
    const asm = makeAssembler({ nodes: [] });
    const text = await asm.assembleStatic({ ruleGroups: ["core"] });
    expect(text).toContain("你是 lnkpi 无限画布助手");
    expect(asm.lastManifestDetail?.registryHash).toBeTruthy();
  });
});
```

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.ts apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.test.ts
git commit -m "feat(prompt-registry): 静态段改走 Registry 渲染，保持逐字节等价并带版本身份"
```

---

### Task 5: CI 门禁（lint CLI + 根脚本 + workflow）

**Files:**
- Create: `scripts/prompt-lint.ts`
- Modify: `package.json`（根 `scripts` 区，现 `:7-20`）
- Create: `.github/workflows/prompt-lint.yml`

**Interfaces:**
- Consumes: Task 3 的 `assertRegistryIntegrity`、Task 2 的 fallback 常量（间接）
- Produces: `pnpm prompt:lint` —— 干净仓库退 0，负例退非 0 且点名到文件

lint 与运行时共用 `assertRegistryIntegrity`，这是"CI 与线上同一套判据"的唯一实现方式。

- [ ] **Step 1: 写失败验证——先手工造一个负例**

```bash
printf -- '---\nid: identity.opening\nversion: 1.0.0\ntitle: 身份与语气\norder: 10\nowner: agent-platform\nupdated: 2026-10-02\n---\n改坏的一句话\n' > prompt-registry/rules/identity.opening.md
```

预期：此时 `pnpm prompt:lint` 尚未存在（Step 2 之前不该有这个命令）。

- [ ] **Step 2: 写 lint CLI**

创建 `scripts/prompt-lint.ts`：

```ts
/**
 * 提示词注册中心门禁（spec §4.5 的 L1-L9）。
 *
 * 刻意只做 CLI 外壳：全部判据在 loader 的 assertRegistryIntegrity 里，
 * 运行时与 CI 共用同一份，避免"本地过、线上炸"。
 *
 * 运行：pnpm prompt:lint（等价于 npx tsx scripts/prompt-lint.ts）
 */
import { assertRegistryIntegrity } from "../apps/server/src/agent/pi-runtime/prompt-registry.loader";
import { resolveRegistryRoot } from "../apps/server/src/agent/pi-runtime/prompt-registry.loader";

// lint 跑在仓库根，cwd 一定是根；env 显式指定时以它为准。
const root = process.env.PI_PROMPT_REGISTRY_DIR ?? resolveRegistryRoot();
const errors = assertRegistryIntegrity(root);

if (errors.length > 0) {
  for (const e of errors) console.error(`prompt-lint: ${e}`);
  console.error(`prompt-lint: ${errors.length} 个问题 → 退出码 1`);
  process.exit(1);
}
console.log(`prompt-lint: ok (${root})`);
```

- [ ] **Step 3: 根 `package.json` 加一行脚本**

在 `scripts` 区（`verify-spec-figures` 前后）加：

```json
    "prompt:lint": "npx tsx scripts/prompt-lint.ts",
```

- [ ] **Step 4: 在负例状态下跑，确认它红且点名**

```bash
pnpm prompt:lint
```

预期：退出码非 0，输出里必须有 `L7 ... identity.opening ... 不一致` 这行（Step 1 造的负例就是 body 改了但 fallback 没改）。

- [ ] **Step 5: 还原负例，确认基础门禁为绿**

```bash
git checkout -- prompt-registry/rules/identity.opening.md
pnpm prompt:lint
```

预期：`prompt-lint: ok (<root>)`，退出码 0。

- [ ] **Step 6: 再验两条关键负例（不跑通等于没门禁）**

```bash
sed -i.bak 's/^version: 1.0.0$/version: 1.1.0/' prompt-registry/rules/identity.opening.md && rm prompt-registry/rules/identity.opening.md.bak
pnpm prompt:lint                 # 期望红：L7（frontmatter 改了但 fallback 常量没跟着改）
git checkout -- prompt-registry/rules/identity.opening.md

sed -i.bak 's/^    contentHash: .*$/    contentHash: 000000000000/' prompt-registry/MANIFEST.yaml && rm prompt-registry/MANIFEST.yaml.bak
pnpm prompt:lint                 # 期望红：L3（body 相对基线变了，version 与 contentHash 没同步）
git checkout -- prompt-registry/MANIFEST.yaml

rm prompt-registry/rules/write_guard.md
pnpm prompt:lint                 # 期望红：L9 代码引用的 id 缺失 + L8 MANIFEST 条目缺失
git checkout -- prompt-registry/rules/write_guard.md

pnpm prompt:lint                 # 必须再绿一次
```

- [ ] **Step 7: 加 CI workflow**

创建 `.github/workflows/prompt-lint.yml`：

```yaml
name: Prompt Lint

on:
  pull_request:
    paths:
      - "prompt-registry/**"
      - "apps/server/src/agent/pi-runtime/prompt-registry.*"
      - "scripts/prompt-lint.ts"
      - "package.json"
  push:
    branches: [master]
    paths:
      - "prompt-registry/**"
      - "scripts/prompt-lint.ts"

jobs:
  prompt-lint:
    name: prompt-registry 门禁
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm prompt:lint
```

- [ ] **Step 8: 提交**

```bash
git add scripts/prompt-lint.ts package.json .github/workflows/prompt-lint.yml
git commit -m "ci(prompt-registry): 新增提示词门禁脚本与 PR/master 校验工作流"
```

---

### Task 6: 容器与发版链路（把 .md 真的送进镜像并触发发布）

**Files:**
- Modify: `.dockerignore`（现 `:6` 有 `*.md`）
- Modify: `deploy/docker/Dockerfile.api`（build 阶段 `:23-26`、runner 阶段 `:74-81`）
- Modify: `.github/workflows/deploy.yml`（`on.push.paths` `:6-15`、`changes` 的 `api` filter `:61-71`）

**Interfaces:**
- Consumes: Task 1 的 `prompt-registry/**`
- Produces: 一条"改一个字 → 触发部署 → 进容器"的完整链路

**spec §9 的文件清单漏掉了 `.dockerignore`——这是本包唯一的硬阻塞**：`.dockerignore:6` 是 `*.md`，第 9 行只有 `!skills/**/SKILL.md` 一处白名单。少了它，build 阶段 `COPY prompt-registry` 照样成功（目录里有 `MANIFEST.yaml` 撑着），但 `rules/*.md` 全空 ⇒ 容器里 `degraded=true` 静默走 fallback，服务不报错、看日志才发现。症状比"COPY 失败"更危险，所以这条白名单是必做项不是优化项。

- [ ] **Step 1: `.dockerignore` 加白名单**

在 `:9` 的 `!skills/**/SKILL.md` 后照抄它的写法加一行 + 注释：

```dockerignore
# W1a：prompt-registry 的规则文件必须进镜像（误伤 = degraded 静默降级，比直接报错更危险）。
!prompt-registry/**/*.md
```

- [ ] **Step 2: `Dockerfile.api` build 阶段加 COPY**

`deploy/docker/Dockerfile.api:26`（`COPY deploy/docker ./deploy/docker` 之后）加：

```dockerignore
COPY prompt-registry ./prompt-registry
```

- [ ] **Step 3: `Dockerfile.api` runner 阶段加 COPY**

在 `:76`（`COPY --from=build /app/apps/server/dist ./apps/server/dist` 之后）加：

```dockerignore
COPY --from=build /app/prompt-registry /app/prompt-registry
```

- [ ] **Step 4: `deploy.yml` 两处加路径**

`on.push.paths`（`:6-15`）加一条 `- "prompt-registry/**"`；`changes` job 的 `api` filter（`:61-71`）加一条 `- 'prompt-registry/**'`。两个都要加——只加 push paths 的话，命中 `api: false` 时仍会跳过 build-api。

- [ ] **Step 5: 提交**

```bash
git add .dockerignore deploy/docker/Dockerfile.api .github/workflows/deploy.yml
git commit -m "build: 把 prompt-registry 规则文件纳入镜像与发布触发路径"
```

---

### Task 7: 整体验收

**Files:**（无新增，全部是执行与记录）

把前面所有判据跑一遍，逐条记录结果。任何一条不过，回到对应任务修，不许"基本过了"。

- [ ] **Step 1: 两套单测绿**

```bash
pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/prompt-registry.loader.test.ts
pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/pi-prompt-assembler.service.test.ts
```

- [ ] **Step 2: lint 干净仓库为绿、负例为红**

```bash
pnpm prompt:lint
```

- [ ] **Step 3: 容器证据（用例 C——唯一能证明 .md 真的进镜像的手段）**

镜像 `<api-image>` 用当次 deploy 的产物 tag；若此刻无新镜像可拉，退一步用 `docker build` 现场打一个（会花几分钟）：

```bash
docker run --rm <api-image> ls /app/prompt-registry/rules | wc -l    # 期望 7
docker run --rm <api-image> ls /app/prompt-registry                  # 期望 rules + MANIFEST.yaml
```

`7` 这个数字同时挡住三件事：`.dockerignore` 白名单、Dockerfile 两处 COPY、以及"目录存在但内容为空"的静默降级。

- [ ] **Step 4: 启动日志与 manifest 行**

```bash
docker run --rm <api-image> sh -c 'cd /app/apps/server && node dist/apps/server/main.js' 2>&1 | head -20
```

预期在日志里看到一行 `prompt registry version=0.1.0 hash=<12hex> entries=7 degraded=false`。若 `degraded=true`，把 `degradedReason` 贴出来——它大概率直接指出是哪一档路径解析没命中。

顺带确认 manifest 行：`registry=0.1.0 registryHash=<12hex>` 出现在 `prompt manifest (static): ...` 那行尾。

- [ ] **Step 5: 发版证据（对照 spec §9 的 D1）**

合入 master 后，确认只含 `prompt-registry/**` 改动的提交**触发了** deploy workflow：

```bash
gh api /actions/runs?per_page=5 --jq '.workflow_runs[] | {status: .status, event: .event, head_sha: .head_sha}'
```

判定口径（与仓库既有纪律一致）：看 `status` 与 `event`，不要只看 `conclusion`；命中 `push` 且 head_sha 等于目标提交即算通过。若没被触发，说明 Step 4 的路径没加全。

- [ ] **Step 6: 打开 PR（squash merge 前先自查）**

```bash
git push -u origin feat/w1a-prompt-registry
```

push 前用 `git diff --cached` 复核一遍**删除行是否全属本包**（仓库既有纪律：主工作区常有并行窗口改动，误删他人代码是最难回滚的事故）。本包预期只有一处意外删除——`pi-prompt-assembler.service.ts` 的 `const CORE_RULES = ...` 与 `composeRuleText` 函数体（Task 4 Step 3 ⑥），除此之外的删除行都要能解释来源。
