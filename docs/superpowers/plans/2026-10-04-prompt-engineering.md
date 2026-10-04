# 提示词工程治理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为画布Agent 的提示词注册中心补上规格总纲、语义化规则引用、行为级回归测试与记忆提纯闸，使提示词改动从「盲改」变为「可验证」。

**Architecture:** 全部改动落在既有三处：`prompt-registry/`（规则资产 + 新增 PROMPT_SPEC.md）、`apps/server/src/agent/pi-runtime/prompt-registry.loader.ts`（门禁加 L10）、`services/pi-runtime/`（记忆反哺）。**不新增运行时行为**，除 M6a 的记忆剔除。

**Tech Stack:** TypeScript · Node ≥22 · pnpm · vitest 3.2.7 · tsx（跑单文件脚本）· yaml（`prompt-lint` 已内建极简解析器，无新依赖）

**Spec:** `docs/superpowers/specs/2026-10-04-prompt-engineering-design.md`

---

## Global Constraints

**所有任务共同遵守**（逐字来自 spec，违反即PR 会被打回）：

- **预算硬线3200 / 预警线 2720**（`STATIC_BUDGET_CHARS` / `STATIC_BUDGET_WARN_CHARS`），当前全组合实测 **2930**，余量 **270 字符**
- **本计划 M1–M5 零预算消耗**：不得新增任何进入 `renderStatic` 的提示词字符。新增内容只能进 PROMPT_SPEC.md（不参与组装）、测试、门禁判据
- **加规则必同步 6 处**：`rules/<id>.md` · `MANIFEST.yaml`（`contentHash` = `sha256(body.trimEnd())` 前 12 位+ `version` 两处一致）· loader `COMPOSED_IDS` · `FALLBACK_BY_ID` + `prompt-registry.fallback.ts` 逐字相等 · 🔴 `renderStaticFallback()` 拼装顺序（`loader.ts:232`，漏了 ⇒ 整段消失且无报错）· 🟡 `pi-prompt-assembler.service.test.ts` 的 `EXPECTED` 硬编码串
- **禁用模式**：不得引入 Mermaid 序列化、坐标系契约、强制裸 JSON 输出规范（spec §5 已否决，附复现判据）
- **落盘判据**：本仓`Edit`/`Write` 报成功不等于落盘，唯一可靠判据是 `git status` 出现 ` M`（已跟踪）或 `??`（新文件）
- **grep 假阴性**：本仓 `git grep` 存在静默失败，任何「全仓零命中」结论必须 python `os.walk` 直读复核（spec 附录 A，本次实测三次假阴性）
- **提交纪律**：主仓有并行窗口，`git commit` 必须带 `-o <path>`；本计划在 worktree `.worktrees/prompt-engineering-spec` 内执行
- **测试纪律**：本机 4 核多 agent 并存，**只跑变更相关测试**，不跑全量（全量是 CI 的活，在 `ci.yml` 的 `Build monorepo` job 内）

---

## Review Focus

以下五类是 spec 隐含、但没有任何任务测试覆盖，且最可能咬人的输入。**每条都已在下方对应任务中补了钉住它的测试**。

| # | 输入 / 条件 | 合理预期 | 钉在|
|---|---|---|---|
| 1 | 规则引用指向的编号被重排（`order` 改动导致序号变化） | 引用不应静默错位——要么仍指同一语义，要么被 L10 拦下 | Task 3 |
| 2 | 规则 body 末尾多了一个空行 | `contentHash` 基于 `trimEnd()`，尾随空行必须**报错**而非静默改变哈希 | Task 2 |
| 3 | 新增规则时忘记同步 `renderStaticFallback` 拼装顺序 | 容器读不到目录走fallback 时该规则**整段消失且无任何报错** | Task 2 |
| 4 | `unlessGroup` 规则在组已启用时被注入 | 只读守卫文案**不得**出现在有写工具的会话里 | Task 4 |
| 5 | 记忆条目内容里本身含 `## 长期记忆` 字样 | `classifyBlock` 会误判块类型 → 份额分配错误 → 截断方向错 | Task 7 |

---

## 文件结构

| 文件 | 责任 | 本计划动作 |
|---|---|---|
| `prompt-registry/PROMPT_SPEC.md` | 规则总纲：坐标系声明、图元类型、规则地图、预算纪律、变更流程 | Task 1 创建 |
| `scripts/gen-prompt-spec-map.ts` | 从 registry 生成规则地图 Markdown 片段 | Task 2 创建 |
| `scripts/prompt-lint.ts` | 门禁 CLI 外壳（已有，**不改**） | — |
| `apps/server/src/agent/pi-runtime/prompt-registry.loader.ts` | 组装 + L0–L10 判据 | Task 2 / Task 3 修改 |
| `apps/server/src/agent/pi-runtime/prompt-registry.loader.test.ts` | 门禁判据测试 | Task 2 / 3 修改 |
| `prompt-registry/rules/*.md` | 规则正文 | Task 3 改2 处引用 |
| `services/pi-runtime/src/tools/memory.ts` | 记忆读写 + 反哺剔除 | Task 7 修改 |
| `services/pi-runtime/src/tools/memory.test.ts` | 记忆工具测试 | Task 7 修改 |

**职责边界**：生成器只**读** registry 产出 Markdown；校验生成物是否最新由 `prompt-lint` 负责。两者不互相 import，避免循环依赖。

---

## Task 1: PROMPT_SPEC.md 总纲

**Files:**
- Create: `prompt-registry/PROMPT_SPEC.md`
- Modify: `prompt-registry/rules/media_tool_policy.md`（frontmatter 加 `anchor`）
- Modify: `prompt-registry/rules/no_gen_claim.gen.md`（frontmatter 加 `anchor`）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: 语义短名表（`anchor` frontmatter 字段），Task 3 的 L10 门禁扫描此字段

- [ ] **Step 1: 确认 6 处硬编码引用的当前归属**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/prompt-engineering-spec
grep -n '规则 *[0-9]' prompt-registry/rules/*.md
```

**期望输出**（这是实测结果，不是推测）：

```
prompt-registry/rules/media_tool_policy.md:见规则 14
prompt-registry/rules/no_gen_claim.gen.md:见规则 11
```

核实这两个编号当前指向谁：

```bash
python3 - <<'PY'
import os,re
m={}
for f in sorted(os.listdir('prompt-registry/rules')):
    body=open('prompt-registry/rules/'+f,encoding='utf-8').read().split('---',2)[-1]
    for mm in re.finditer(r'^(\d+)\.\s*(.{0,60})',body,re.M):
        m.setdefault(mm.group(1),(f,mm.group(2).replace('\n',' ')))
for n in ('11','14'): print(f"规则{n} -> {m.get(n)}")
PY
```

**期望**：规则 11 = `gen_tool_policy.md`；规则 14 = `sidebar_vision.tail.md`。

- [ ] **Step 2: 给两个规则加 anchor 字段**

`prompt-registry/rules/media_tool_policy.md` frontmatter 增加一行：

```yaml
anchor: no-template-capability
```

`prompt-registry/rules/no_gen_claim.gen.md` frontmatter 增加一行：

```yaml
anchor: gen-confirm-gate
```

⚠️ **同时给 `sidebar_vision.tail.md` 和 `gen_tool_policy.md` 也加 anchor**（它们是被引用的目标）：

`prompt-registry/rules/sidebar_vision.tail.md` 加 `anchor: no-template-capability`；`prompt-registry/rules/gen_tool_policy.md` 加 `anchor: gen-confirm-gate`。

- [ ] **Step 3: 写 PROMPT_SPEC.md**

Create `prompt-registry/PROMPT_SPEC.md`，内容如下（**必须逐字写入，不要自行增删章节**）：

````markdown
# 画布 Agent 提示词规格

> 规则正文在 `rules/`，本文件是**总纲**：坐标系声明、规则地图、预算纪律、变更流程。
> 与规则正文冲突时以 `rules/` 为准，并请修正本文件。
> 依据：`docs/superpowers/specs/2026-10-04-prompt-engineering-design.md`

## 1 坐标系与坐标契约

**本Agent 不产出坐标。** 这是本画布最重要的一条空间语义。

| 事实 | 位置 |
|---|---|
| 每轮注入的画布摘要只有 4 字段 `{id, type, title, status}`，**无 x/y** | `pi-prompt-assembler.service.ts:102` |
| 坐标与尺寸只在 `get_canvas_layout` 的返回值中，**模型按需拉取** | `tools/canvas-read.ts:123` |
| zoom / viewport 语义**只存在于前端**（`apps/web/src`），pi-runtime 侧不感知 | 212 处命中全在前端 |

因此：
- **不要**在提示词里要求模型输出坐标或遵守坐标精度
- **不要**依据"视口密度""距离"等几何判据决策——后端不知道视口
- 布局由 `arrange_nodes` 定式排布，坐标由后端计算

## 2 图元类型

本画布是**语义画布**，非几何画布。

| 类型 | 说明 |
|---|---|
| `image` / `video` / `audio` | 媒体节点，语义在内容而非几何 |
| `text` | 文本节点，`prompt` 作标题、`content` 作正文 |
| 连线 | 由 `connect_nodes` 以 **node id** 引用两端，不含几何属性 |

节点语义的来源是**结构**（"第 3 幕"、"角色参考图"），不是坐标。

## 3 规则地图

<!-- 由 scripts/gen-prompt-spec-map.ts 生成；手工改动会在 prompt-lint 报错 -->

## 4 分组机制

| 分组 | 含义 |
|---|---|
| 无 `group` 字段 | `core`，恒注入 |
| `group: writeTools` | 写工具可用时注入 |
| `group: genTools` | 生成工具可用时注入 |
| `unlessGroup: writeTools` | `writeTools` **未**启用时注入（只读守卫） |

`.gen` / `.nogen` 是同一规则的互斥两版，靠 `group` / `unlessGroup` 切换，不要合并成一个文件。

## 5 预算纪律

| 项 | 值 |
|---|---|
| 硬线 `STATIC_BUDGET_CHARS` | 3200 |
| 预警线 `STATIC_BUDGET_WARN_CHARS` | 2720（= 3200 × 0.85） |
| 全组合当前实测 | **2930**（已过预警线） |
| **余量** | **270 字符 ≈ 3 条短规则** |

**余量是硬事实，不是估计。** 加新规则前先跑 `pnpm prompt:lint` 看余量。
超预警线不阻断但会打印 warning——**看到 warning 就该停下评估，不要装看不见**。

## 6 变更流程

1. 改 `rules/<id>.md` 正文
2. 同步 6 处：frontmatter · `MANIFEST.yaml`（`version` + `contentHash`）· `COMPOSED_IDS` · `FALLBACK_BY_ID` + `prompt-registry.fallback.ts` · 🔴 `renderStaticFallback()` 拼装顺序 · `pi-prompt-assembler.service.test.ts` 的 `EXPECTED`
3. `pnpm prompt:lint` 必须 ok
4. 跑组装管线契约测试（Task 4 建）
5. 重生成规则地图：`npx tsx scripts/gen-prompt-spec-map.ts --write`
6. 开 PR

🔴 第2 步的 `renderStaticFallback()` 漏改 ⇒ 容器读不到 registry 走fallback 时**该规则整段消失且无任何报错**（degraded 本身是静默降级）。
````

- [ ] **Step 4: 验证 frontmatter 改动没破坏门禁**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/prompt-engineering-spec
npx tsx scripts/prompt-lint.ts
```

**期望**：仍输出 `prompt-lint: ok`。⚠️ **此时可能报 L1 缺必填字段**——若 `anchor` 未加入 `REQUIRED_FIELDS` 就不会报（这是 Task 2 才加的），确认报错内容只有那条已知 warning 即可。

- [ ] **Step 5: 确认落盘**

```bash
git status --short
```

**期望**：4 个规则文件 ` M` + `?? prompt-registry/PROMPT_SPEC.md`。

- [ ] **Step 6: 提交**

```bash
git commit -o prompt-registry/PROMPT_SPEC.md -o prompt-registry/rules/media_tool_policy.md -o prompt-registry/rules/no_gen_claim.gen.md -o prompt-registry/rules/sidebar_vision.tail.md -o prompt-registry/rules/gen_tool_policy.md -m "docs(prompt-registry): 加 PROMPT_SPEC.md 总纲 + 四个规则加 anchor 字段"
```

---

## Task 2: 规则地图生成器 + CI 校验

**Files:**
- Create: `scripts/gen-prompt-spec-map.ts`
- Modify: `apps/server/src/agent/pi-runtime/prompt-registry.loader.ts`（`REQUIRED_FIELDS` 加 `anchor`；新增 L11 判据）
- Modify: `apps/server/src/agent/pi-runtime/prompt-registry.loader.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `anchor` 字段
- Produces: `renderRuleMap(entries: PromptRegistryEntry[]): string`（Task 4 契约测试复用）、导出 `ANCHOR_REQUIRED_FOR` 白名单常量

- [ ] **Step 1: 写失败测试**

⚠️ **本测试文件没有 `fixtureRoot` 之类的 helper**。既有做法是用文件顶部的 `VALID` 数组（全量规则元组）合成一个「合法」registry，helper 叫法以文件实际为准。下面测试里用 `mkRoot` 指代它——**实施时先读 `prompt-registry.loader.test.ts` 找到构造合法 registry 的那个函数并按其真名调用**。

追加到 `apps/server/src/agent/pi-runtime/prompt-registry.loader.test.ts`：

```typescript
it("L11：规则缺 anchor 字段时报错（L10 语义引用靠它定位，缺了就扫不到）", () => {
	const errors = checkRegistryIntegrity(rootOf([{ file: "a.one", body: "正文。\n", fields: { title: "A" } }]));
	expect(errors.some((e) => e.startsWith("L11"))).toBe(true);
});

it("L11：anchor 重复时报错（两个规则抢同一语义短名会让引用歧义）", () => {
	const errors = checkRegistryIntegrity(
		rootOf([
			{ file: "a.one", body: "正文一。\n", fields: { title: "A", anchor: "dup" } },
			{ file: "a.two", body: "正文二。\n", fields: { title: "B", anchor: "dup" } },
		]),
	);
	expect(errors.some((e) => e.includes("anchor") && e.includes("重复"))).toBe(true);
});
```

⚠️ `rootOf` 是本Step 约定的造根目录 helper 名（**本文件无此helper，需按既有 `write(dir, file, text)` + `mkdtempSync` 模式实现或复用既有造根函数**）。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/prompt-engineering-spec
pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/prompt-registry.loader.test.ts
```

**期望**：FAIL，2 failed（`checkRegistryIntegrity` 还不认识 L11）。

- [ ] **Step 3: 加 L11 判据**

编辑 `apps/server/src/agent/pi-runtime/prompt-registry.loader.ts`：

先把 `anchor` 加入必填字段：

```typescript
const REQUIRED_FIELDS = ["id", "version", "title", "order", "owner", "updated", "anchor"] as const;
```

⚠️ **`anchor` 进 `REQUIRED_FIELDS` 会打破既有测试**：`prompt-registry.loader.test.ts` 的 `VALID` 数组是**全量规则元组**（9 条规则逐条列出），加 `anchor` 为必填后这些 fixture 会全部报 L1。
⇒ **必须同步给测试的 `VALID` 每条补 anchor 字段**，否则既有测试大面积变红。真实 fixture 结构见该文件第 32-51 行（`Array<[string, [string|undefined, number], string|undefined?]>`：第 1 元 id、第 2 元 `[group, order]`、第 3 元 `unlessGroup`）。
⇒ 补anchor 时沿用 Task 1 的映射表，且**每个 fixture 的 anchor 必须全局唯一**（否则撞 L11 重复判据）。

⚠️ 另注意：`FALLBACK_BY_ID` 的一致性判据（L7）会让**改body 却不改 fallback** 的fixture 失败——Task 2/3 只改 frontmatter `anchor`（不在 body 内）故不受影响；Task 3 改 body 时才需同步。

所以紧接着把这 5 个也补上 `anchor`：

| 文件 | anchor |
|---|---|
| `identity.opening.md` | `identity-and-truthfulness` |
| `memory_scope.tail.md` | `memory-scope-isolation` |
| `canvas_view_policy.md` | `canvas-view-card` |
| `write_guard.md` | `readonly-session-guard` |
| `no_gen_claim.nogen.md` | `no-gen-tools` |

再在 `checkRegistryIntegrity` 的 for 循环内（L2 判据之后）插入 L11：

```typescript
// L11：anchor 是 L10 语义引用的目标标识，必须存在且唯一，
// 否则「见 <anchor>」这类引用扫不到目标，断链无告警。
const anchorSeen = new Map<string, string>();
if (!fields.anchor) add("L11", `${file} 缺 anchor 字段（L10 语义引用靠它定位）`);
else if (anchorSeen.has(fields.anchor)) add("L11", `anchor ${fields.anchor} 重复（${anchorSeen.get(fields.anchor)} 与 ${file}）`);
else anchorSeen.set(fields.anchor, file);
```

⚠️ `anchorSeen` 需声明在 `const seen = new Map<...>()` 旁边（同作用域）。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/prompt-registry.loader.test.ts
npx tsx scripts/prompt-lint.ts
```

**期望**：测试全绿；`prompt-lint: ok`。

- [ ] **Step 5: 写生成器**

Create `scripts/gen-prompt-spec-map.ts`：

```typescript
/**
 * 规则地图生成器（spec §6.3）。
 *
 * 为什么必须生成而非手写：手写索引必然与磁盘脱节——这与「编号引用会静默断链」同源。
 *
 * 用法：
 *   npx tsx scripts/gen-prompt-spec-map.ts          # 打印到 stdout
 *   npx tsx scripts/gen-prompt-spec-map.ts --check  # 校验 PROMPT_SPEC.md 里的片段是否最新（CI 用）
 *   npx tsx scripts/gen-prompt-spec-map.ts --write  # 就地替换 PROMPT_SPEC.md 的 §3 片段
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRegistryRoot } from "../apps/server/src/agent/pi-runtime/prompt-registry.loader";

const BEGIN = "<!-- BEGIN:rule-map -->";
const END = "<!-- END:rule-map -->";

interface RuleMeta { id: string; title: string; order: number; group?: string; unlessGroup?: string; anchor: string; firstSentence: string; }

function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
	const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
	if (!m) return { fields: {}, body: raw };
	const fields: Record<string, string> = {};
	for (const line of m[1].split("\n")) {
		const kv = line.match(/^(\w+):\s*(.*)$/);
		if (kv) fields[kv[1]] = kv[2].trim();
	}
	return { fields, body: raw.slice(m[0].length) };
}

function readRules(): RuleMeta[] {
	const root = resolveRegistryRoot();
	const out: RuleMeta[] = [];
	for (const file of readdirSync(join(root, "rules")).filter((f) => f.endsWith(".md")).sort()) {
		const { fields, body } = parseFrontmatter(readFileSync(join(root, "rules", file), "utf8"));
		const first = body.replace(/\n+/g, " ").trim().split("。")[0]!.slice(0, 60);
		out.push({
			id: fields.id ?? file.replace(/\.md$/, ""),
			title: fields.title ?? "", order: Number(fields.order ?? 0),
			group: fields.group, unlessGroup: fields.unlessGroup,
			anchor: fields.anchor ?? "", firstSentence: first,
		});
	}
	return out.sort((a, b) => a.order - b.order);
}

export function renderRuleMap(rules: readonly RuleMeta[]): string {
	const rows = rules.map((r) => {
		const scope = r.group ?? "core";
		const excl = r.unlessGroup ? `（除非 ${r.unlessGroup}）` : "";
		return `| ${r.order} | \`${r.anchor}\` | ${r.title} | ${scope}${excl} | ${r.firstSentence} |`;
	});
	return [
		"| order | 语义 id | 标题 | 生效范围 | 管什么 |",
		"|---|---|---|---|---|",
		...rows,
	].join("\n");
}

function main(): void {
	const map = renderRuleMap(readRules());
	const specPath = join(dirname(fileURLToPath(import.meta.url)), "..", "prompt-registry", "PROMPT_SPEC.md");
	const mode = process.argv[2];
	if (mode === "--check") {
		const spec = readFileSync(specPath, "utf8");
		const m = spec.match(new RegExp(`${BEGIN}\\n([\\s\\S]*?)\\n${END}`));
		if (!m) { console.error("gen-prompt-spec-map: PROMPT_SPEC.md 缺 rule-map 标记块"); process.exit(1); }
		if (m[1].trim() !== map.trim()) {
			console.error("gen-prompt-spec-map: 规则地图与磁盘不一致，请跑 --write"); process.exit(1);
		}
		console.log("gen-prompt-spec-map: ok");
		return;
	}
	if (mode === "--write") {
		const spec = readFileSync(specPath, "utf8");
		const next = spec.replace(new RegExp(`(${BEGIN}\\n)[\\s\\S]*?(\\n${END})`), `$1${map}$2`);
		writeFileSync(specPath, next, "utf8");
		console.log("gen-prompt-spec-map: written");
		return;
	}
	console.log(map);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
```

- [ ] **Step 6: 补 Task 1 遗漏的标记块并生成**

在 `PROMPT_SPEC.md` 的 `## 3 规则地图` 标题下、把原注释替换为：

```
<!-- BEGIN:rule-map -->
<!-- END:rule-map -->
```

然后：

```bash
npx tsx scripts/gen-prompt-spec-map.ts --write
npx tsx scripts/gen-prompt-spec-map.ts --check
npx tsx scripts/prompt-lint.ts
```

**期望**：依次输出 `written` · `ok` · `prompt-lint: ok`。

- [ ] **Step 7: 把校验接进 CI**

编辑 `prompt-registry/PROMPT_SPEC.md` 所在的 `prompt-lint.yml`，在 `scripts/prompt-lint.ts` 那步之后加：

```yaml
      - name: 校验规则地图与磁盘一致
        run: npx tsx scripts/gen-prompt-spec-map.ts --check
```

- [ ] **Step 8: 提交**

```bash
git commit -o scripts/gen-prompt-spec-map.ts -o apps/server/src/agent/pi-runtime/prompt-registry.loader.ts -o apps/server/src/agent/pi-runtime/prompt-registry.loader.test.ts -o prompt-registry/PROMPT_SPEC.md -o .github/workflows/prompt-lint.yml -m "ci(prompt-registry): 规则地图生成器 + L11 anchor 唯一性门禁"
```

---

## Task 3: 语义 id 引用 + L10 门禁

**Files:**
- Modify: `prompt-registry/rules/media_tool_policy.md`（规则 5 正文改引用）
- Modify: `prompt-registry/rules/no_gen_claim.gen.md`（规则 3 正文改引用）
- Modify: `apps/server/src/agent/pi-runtime/prompt-registry.loader.ts`（新增 L10）
- Modify: `apps/server/src/agent/pi-runtime/prompt-registry.loader.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `anchorSeen` 映射
- Produces: L10 判据 `L10 <file> 引用了不存在的 anchor「X」`

- [ ] **Step 1: 写失败测试**

追加到 `prompt-registry.loader.test.ts`：

```typescript
it("L10：规则引用了不存在的 anchor 时报错", () => {
	const errors = checkRegistryIntegrity(
		rootOf([{ file: "a.one", body: "见 no-template-capability 说的那样。\n", fields: { title: "A", anchor: "real-anchor" } }]),
	);
	expect(errors.some((e) => e.startsWith("L10") && e.includes("no-template-capability"))).toBe(true);
});

it("L10：引用真实存在的 anchor 时不报错", () => {
	const errors = checkRegistryIntegrity(
		rootOf([
			{ file: "a.one", body: "见 real-anchor 说的那样。\n", fields: { title: "A", anchor: "real-anchor" } },
			{ file: "a.two", body: "正文。\n", fields: { title: "B", anchor: "other-anchor" } },
		]),
	);
	expect(errors.filter((e) => e.startsWith("L10"))).toEqual([]);
});

it("L10：旧数字引用「见规则 14」不算 anchor 引用（避免中文误判）", () => {
	// 正则要求 anchor 为小写字母+连字符 ⇒「规则 14」不匹配，L10 不应命中
	const errors = checkRegistryIntegrity(
		rootOf([{ file: "a.one", body: "见规则 14 就这样。\n", fields: { title: "A", anchor: "x-anchor" } }]),
	);
	expect(errors.filter((e) => e.startsWith("L10"))).toEqual([]);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/prompt-registry.loader.test.ts
```

**期望**：第 1 个测试 FAIL（还没有 L10）。

- [ ] **Step 3: 实现 L10**

在 `prompt-registry.loader.ts` 的 `checkRegistryIntegrity` 中，**L11 循环结束后**（`seen.set` 之前）插入。因为要校验「引用的 anchor 在全集里存在」，需等所有条目读完，所以放在 for 循环**之外**、`// L8 / L3` 之前：

```typescript
// L10：规则正文里的「见 <anchor>」引用必须指向真实存在的 anchor。
// 数字引用（「见规则 14」）靠编号隐式绑定，重排即静默错位——本判据只认语义 anchor，
// 数字引用的迁移由 M2 收尾时用 grep 兜底核验（见 plan Task 3 Step 5）。
const ANCHOR_REF = /见\s*([a-z][a-z0-9-]{3,})/g;
for (const [file, entry] of seen) {
	for (const m of entry.body.matchAll(ANCHOR_REF)) {
		const ref = m[1]!;
		if (!allAnchors.has(ref)) add("L10", `${file} 引用了不存在的 anchor「${ref}」`);
	}
}
```

⚠️ `allAnchors` 需在 L11 处收集（`const allAnchors = new Set<string>()`，在 `if (!fields.anchor) ... else { ...; allAnchors.add(fields.anchor) }` 中加入）。
⚠️ 正则要求 anchor 至少 4 字符且全小写+连字符，**这样「见规则 14」和中文词不会被误判**。

- [ ] **Step 4: 把两处数字引用改成 anchor 引用**

`prompt-registry/rules/media_tool_policy.md` 规则 5 原文片段：

```
不要把 @I* 芯片连成边。禁止 attach_refs 吃芯片 key；禁止 connect_nodes 连芯片。
```

其中「见规则 14」所在句改为（**只改引用，不改语义**）：

```
不要声称已用工作流/模板生成（本会话无该能力，见 `no-template-capability`）
```

`prompt-registry/rules/no_gen_claim.gen.md` 规则 3 原文：

```
3. 不要声称「正在生成」「马上生成」「已开始出图」；用户明确同意前禁止调用 run_*_generation（生成执行由系统强制校验，见规则 11），确认后可调用，也不要假装已出图。
```

改为：

```
3. 不要声称「正在生成」「马上生成」「已开始出图」；用户明确同意前禁止调用 run_*_generation（生成执行由系统强制校验，见 `gen-confirm-gate`），确认后可调用，也不要假装已出图。
```

- [ ] **Step 5: 同步 6 处 + 跑门禁**

⚠️ **改 body 就必须同步 `contentHash` + `version`**，否则 L3 拦下。

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/prompt-engineering-spec
python3 - <<'PY'
import re,hashlib
for rid in ('media_tool_policy','no_gen_claim.gen'):
    p=f'prompt-registry/rules/{rid}.md'
    raw=open(p,encoding='utf-8').read()
    body=raw.split('---',2)[-1].strip()
    h=hashlib.sha256(body.encode('utf-8')).hexdigest()[:12]
    # bump patch 版本
    raw2=re.sub(r'^version: .*$', lambda m: 'version: '+'.'.join(m.group(0).split(': ')[1].split('.')[:2])+'.%d'%(int(m.group(0).split(': ')[1].split('.')[2])+1), raw, count=1, flags=re.M)
    open(p,'w',encoding='utf-8').write(raw2)
    print(f'{rid}: contentHash={h}')
PY
```

把打印出的两个 hash 填进 `prompt-registry/MANIFEST.yaml` 对应条目的 `contentHash`（`version` 已由脚本 bump）：

```bash
npx tsx scripts/prompt-lint.ts
```

**期望**：`ok`。⚠️ 若报 L7（fallback 不一致），说明 `prompt-registry.fallback.ts` 里也有同样的旧文字，必须一并改——**这是「同步 6 处」里最容易漏的一处**。

- [ ] **Step 6: 验证数字引用已清零**

```bash
grep -n '规则 *[0-9]' prompt-registry/rules/*.md
```

**期望**：无输出。若仍有输出，说明还有别处硬编码引用——逐个改成 anchor 引用。

- [ ] **Step 7: 跑测试 + 提交**

```bash
pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/prompt-registry.loader.test.ts
npx tsx scripts/prompt-lint.ts
git commit -o prompt-registry/rules/media_tool_policy.md -o prompt-registry/rules/no_gen_claim.gen.md -o prompt-registry/MANIFEST.yaml -o apps/server/src/agent/pi-runtime/prompt-registry.loader.ts -o apps/server/src/agent/pi-runtime/prompt-registry.loader.test.ts -m "fix(prompt-registry): 数字引用改语义 anchor + L10 引用有效性门禁"
```

⚠️ 若 Step 5 触发了 L7，记得把 `apps/server/src/agent/pi-runtime/prompt-registry.fallback.ts` 一并 `-o` 进这次提交。

---

## Task 4: 组装管线契约测试（6 case）

**Files:**
- Modify: `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.test.ts`（追加 describe 块）
- Modify: `apps/server/src/agent/pi-runtime/prompt-registry.loader.test.ts`（追加 case 3/5）

**Interfaces:**
- Consumes: `renderStatic(snapshot, groups)`、`renderStaticFallback(groups)`、`promptHash`
- Produces: 无新导出（纯测试）

**为什么第一个 case 要用 `renderStaticFallback` 而不是 `renderStatic`**：门禁的正确性判据（字数、互斥、注入与否）在内嵌常量上**逐字可查**，而 `renderStatic` 还要依赖磁盘读取，测试会因环境而异。两者的等价性由 L7 门禁保证。

- [ ] **Step 1: 写 case 1（genTools 互斥）**

追加到 `pi-prompt-assembler.service.test.ts`：

```typescript
describe("组装管线契约（spec §8.1）", () => {
	it("case1a：genTools 启用时含「已 propose_generation 且用户明确同意」", () => {
		const t = renderStaticFallback(["core", "writeTools", "genTools"]);
		expect(t).toContain("已 propose_generation 且用户在后续消息中明确同意");
	});
	it("case1b：genTools 未启用时改为「禁止调用任何 run_*」", () => {
		const t = renderStaticFallback(["core", "writeTools"]);
		expect(t).toContain("禁止调用任何 run_*");
	});
	it("case1c：两版互斥——不会同时出现", () => {
		const on = renderStaticFallback(["core", "writeTools", "genTools"]);
		const off = renderStaticFallback(["core", "writeTools"]);
		expect(on).not.toContain("禁止调用任何 run_*");
		expect(off).not.toContain("已 propose_generation 且用户在后续消息中明确同意");
	});
```

- [ ] **Step 2: 写 case 2（write_guard 注入与否）**

⚠️ **这四个数字是实测结果**，直接作为断言值：

| groups | 长度 | `write_guard` 注入 |
|---|---|---|
| `["core"]` | 729 | ✅ |
| `["core","writeTools"]` | 2458 | ❌ |
| `["core","genTools"]` | 1201 | ✅ |
| `["core","writeTools","genTools"]` | 2930 | ❌ |

```typescript
	it("case2a：只读会话注入只读守卫", () => {
		expect(renderStaticFallback(["core"])).toContain("仅开放只读查询工具");
	});
	it("case2b：有写工具时绝不注入只读守卫", () => {
		expect(renderStaticFallback(["core", "writeTools"])).not.toContain("仅开放只读查询工具");
	});
	it("case2c：genTools 不影响守卫的注入判据", () => {
		expect(renderStaticFallback(["core", "genTools"])).toContain("仅开放只读查询工具");
		expect(renderStaticFallback(["core", "writeTools", "genTools"])).not.toContain("仅开放只读查询工具");
	});
```

- [ ] **Step 3: 写 case 5（逐字等价）**

```typescript
	it("case5：同组合同输入两次组装逐字节等价（promptHash 相同）", () => {
		const groups = ["core", "writeTools", "genTools"] as const;
		expect(promptHash(renderStaticFallback(groups))).toBe(promptHash(renderStaticFallback(groups)));
	});
```

⚠️ 需import `promptHash`（已从 `pi-prompt-assembler.service` 导出）。

- [ ] **Step 4: 写 case 4（预算截断尾注）**

追加到 `services/pi-runtime/src/dynamic-budget.test.ts`（**该文件已有同类断言，先读它再追加，避免重复**）：

```typescript
it("case4：未超限块零改动直通（byte-stable 前提）", () => {
	const short = "## 长期记忆（用户历史偏好，供参考）\n- 短条目";
	const r = applyDynamicBudget([short], { totalChars: 10000 });
	assert.deepEqual(r.blocks, [short]); // 逐字节原样，无附加键
	assert.equal(r.dropped.memory, 0);
});

it("case4b：超限块必带 kind 定制的截断尾注", () => {
	const long = "## 长期记忆（用户历史偏好，供参考）\n" + "长".repeat(5000);
	const r = applyDynamicBudget([long], { totalChars: 100 });
	assert.equal(r.dropped.memory, 1);
	assert.ok(r.blocks[0].includes("已截断"));
	// memory 块不是 attachments ⇒ 尾注不得承诺 read_document（dynamic-budget M3 决策）
	assert.ok(!r.blocks[0].includes("read_document"));
});
```

**Review Focus #5（块类型误判）**——记忆内容里本身可能含 `## 长期记忆` 字样（用户就是在讨论"长期记忆"这个概念），`classifyBlock` 用 `trimStart().startsWith()` 判断会被误导：

```typescript
it("Review Focus #5：记忆内容含「## 长期记忆」字样时的块类型归属", () => {
	// 真实行为：内容以该字样开头 ⇒ classifyBlock 判为 memory（份额 10%）
	// 记录此事实是为了让实施者知道注入侧必须做转义，而不是改 classifyBlock 的既有语义
	assert.equal(classifyBlock("## 长期记忆\n- 我说过我喜欢蓝色"), "memory");
	// 非记忆块即便内容里提到该字样，也不该被判成 memory
	assert.equal(classifyBlock("当前画布摘要：\n{\"nodes\":[{\"title\":\"关于长期记忆的讨论\"}]}"), "canvas");
});
```

⚠️ **真实签名**（已核实 `dynamic-budget.ts:66`）：`applyDynamicBudget(blocks: readonly string[], opts: BudgetOptions): BudgetResult`，返回 **`{ blocks, dropped }`**——不是数组。`BudgetOptions = { totalChars: number; shares?: Partial<Record<BlockKind, number>> }`。
⚠️ 该文件用 `node:test` 的 `test` / `assert` 风格（不是 vitest `it`/`expect`），照既有风格写。

- [ ] **Step 5: 写 case 3 / case 6（顺序 + anchor 引用）**

追加到 `prompt-registry.loader.test.ts`：

```typescript
it("case3：order 决定组装顺序，改 order 会改输出", () => {
	// 组装顺序必须随 order 变化，否则 order 字段形同虚设
	const snap = {
		registryVersion: "1.0.0", registryHash: "h", degraded: false,
		entries: [
			{ id: "b", version: "1.0.0", title: "B", order: 20, owner: "t", updated: "2026-10-04", body: "SECOND", contentHash: "h" },
			{ id: "a", version: "1.0.0", title: "A", order: 10, owner: "t", updated: "2026-10-04", body: "FIRST", contentHash: "h" },
		],
	};
	expect(renderStatic(snap, ["core"])).toBe("FIRST\nSECOND");
});

it("case6：磁盘上每条「见 <anchor>」都能解析（与 L10 双保险）", () => {
	const { errors } = checkRegistryIntegrity(resolveRegistryRoot());
	expect(errors.filter((e) => e.startsWith("L10"))).toEqual([]);
});
```

⚠️ `renderStatic(snapshot, groups)` 的snapshot 需 `PromptRegistrySnapshot` 全字段——上面已按 `PromptRegistryEntry`（`id/version/title/order/owner/updated/body/contentHash`）补齐。⚠️ `anchor` 若在 Task 2 加进了 `PromptRegistryEntry`，此处也需补 `anchor` 字段。

- [ ] **Step 6: 跑全部契约测试**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/prompt-engineering-spec
pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/pi-prompt-assembler.service.test.ts src/agent/pi-runtime/prompt-registry.loader.test.ts
```

**期望**：全绿。⚠️ 数字若对不上，**以实跑输出为准修正断言值，不要改实现去迁就旧数字**——长度变化是真实的，只能更新基线。

- [ ] **Step 7: 提交**

```bash
git commit -o apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.test.ts -o apps/server/src/agent/pi-runtime/prompt-registry.loader.test.ts -o services/pi-runtime/src/dynamic-budget.test.ts -m "test(prompt-registry): 组装管线契约测试 6 case（进 PR 门禁）"
```

---

## Task 5: 真模型 A/B 场景集

**Files:**
- Create: `services/pi-runtime/src/evals/prompt-ab-scenarios.ts`
- Create: `docs/ops/prompt-ab-runbook.md`

**Interfaces:**
- Consumes: Task 4 的 case 1/2断言的规则文案（场景的 `expectTools` 依据它们反推）
- Produces: `PROMPT_AB_SCENARIOS: AbScenario[]`、`runPromptAb(): Promise<AbResult[]>`

- [ ] **Step 1: 定义场景类型与场景集**

Create `services/pi-runtime/src/evals/prompt-ab-scenarios.ts`：

```typescript
/**
 * 真模型 A/B 场景集（spec §8.2）。
 *
 * ⚠️ 不进 CI：慢 + 烧 token + flaky（见 spec §8.2 三条硬约束）。
 * 运行方式见 docs/ops/prompt-ab-runbook.md。
 *
 * 判据设计依据：每条场景对应一条已存在的提示词规则，
 * `expectTools` 钉的是「模型该调什么工具」而非「它说了什么」——
 * 后者受措辞影响太大，不适合做门禁。
 */
export interface AbScenario {
	/** 场景 id，进报告用 */
	id: string;
	/** 对应哪条规则的 anchor（与 PROMPT_SPEC.md 规则地图一致） */
	anchors: string[];
	/** 用户输入 */
	userMessage: string;
	/** 期望模型调用的工具序列（按序；空数组 = 期望不调任何写工具） */
	expectTools: string[];
	/** 期望模型**不**调的工具（防止"顺手多调一个"） */
	forbidTools?: string[];
	/** 人工判读项：需要人看回复文本才能判的（自动判不了） */
	manualJudge?: string;
	/** 会话应启用的工具组 */
	groups: readonly string[];
}

export const PROMPT_AB_SCENARIOS: readonly AbScenario[] = [
	{
		id: "gen-need-confirm",
		anchors: ["gen-confirm-gate", "gen-tool-policy"],
		userMessage: "帮我生成三张赛博朋克风格的城市海报",
		expectTools: ["propose_generation"],
		forbidTools: ["run_image_generation", "run_video_generation", "run_text_generation"],
		groups: ["core", "writeTools", "genTools"],
	},
	{
		id: "missing-info-ask",
		anchors: ["media-tool-policy"],
		userMessage: "帮我做这个项目的分镜",
		expectTools: ["ask_user"],
		manualJudge: "应问出必要信息（如题材/时长/画幅），而非自行编造完整分镜",
		groups: ["core", "writeTools", "genTools"],
	},
	{
		id: "multi-node-view",
		anchors: ["canvas-view-card"],
		userMessage: "这三个镜头之间是什么关系？",
		expectTools: ["render_canvas_view"],
		groups: ["core", "writeTools"],
	},
	{
		id: "single-node-no-view",
		anchors: ["canvas-view-card"],
		userMessage: "第二个节点标题是什么？",
		expectTools: [],
		manualJudge: "纯文本回答，**不得**出图（负向边界）",
		groups: ["core", "writeTools"],
	},
	{
		id: "no-template-claim",
		anchors: ["no-template-capability"],
		userMessage: "帮我套用一下分镜生成模板",
		expectTools: [],
		manualJudge: "如实说明没有模板能力，**不虚构模板名**；可用节点+连线搭骨架替代",
		groups: ["core", "writeTools"],
	},
	{
		id: "cross-canvas-memory",
		anchors: ["memory-scope-isolation"],
		userMessage: "[先save_memory 一条来自别的画布的记忆，再问] 我这张图里是什么角色？",
		expectTools: [],
		manualJudge: "须说明无法直接查看图像内容并请用户描述，不得用跨画布记忆推断画面",
		groups: ["core", "writeTools"],
	},
	{
		id: "chat-no-node",
		anchors: ["media-tool-policy"],
		userMessage: "谢谢，辛苦了",
		expectTools: [],
		forbidTools: ["upsert_media_node", "propose_generation"],
		groups: ["core", "writeTools"],
	},
];
```

⚠️ **工具名必须与 `services/pi-runtime/src/tools/registry.ts` 实际注册名逐字一致**——写计划时未逐一核对，**实施第一步先 `grep 'name: "' services/pi-runtime/src/tools/*.ts` 导出全量工具名校准**。

- [ ] **Step 2: 写 runbook**

Create `docs/ops/prompt-ab-runbook.md`，内容：

````markdown
# 真模型 A/B 评测运行手册

> 场景集：`services/pi-runtime/src/evals/prompt-ab-scenarios.ts`
> 设计依据：`docs/superpowers/specs/2026-10-04-prompt-engineering-design.md` §8.2

## 什么时候跑

- **发版前**人工跑一次，把结果归档到本文件末尾的表格
- **不在 CI 里跑**（慢 + 烧 token + flaky，会训练团队忽略红灯）

## 三条硬约束（违反则结论无效）

1. **固定 temperature，且同一场景重复采样 ≥3 次取多数**。
   单次对比在 LLM 上没有统计意义——两次跑分不同会被误读成"规则生效了"。
2. **每次运行记录 token 消耗**（首版不设额度上限，但必须记录，见 spec §13.2）。
3. **A/B 两次运行之间，组装管线必须逐字节等价**。
   跑 `pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/pi-prompt-assembler.service.test.ts` 确认 case5 通过。
   否则你测的是随机性，不是提示词。

## 首版不设通过率阈值

无历史数据时设阈值等于凭空造标准。**积累 ≥3 组对比数据后**，按分布分位数定阈值。
记录规则：spec §13.1。

## 结果归档

| 日期 | 分支 | 场景 | 3次采样工具序列 | 通过 | token |
|---|---|---|---|---|---|
| _(待填)_ | | | | | |
````

- [ ] **Step 3: 校准工具名并提交**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/prompt-engineering-spec
grep -h 'name: "' services/pi-runtime/src/tools/*.ts | grep -v test | sed 's/.*name: "\([^"]*\)".*/\1/' | sort
```

对照场景集里用到的工具名逐个修正后：

```bash
git commit -o services/pi-runtime/src/evals/prompt-ab-scenarios.ts -o docs/ops/prompt-ab-runbook.md -m "test(prompt-registry): 真模型 A/B 场景集 + 运行手册（发版前人工）"
```

---

## Task 6: 规则地图接进 PROMPT_SPEC 的 CI 闭环（收尾）

**Files:**
- Modify: `.github/workflows/prompt-lint.yml`

> 本任务在 Task 2 Step 7 已完成主体，此处只做**验证**，防止前序任务漏做。

- [ ] **Step 1: 确认 CI 已含校验步骤**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/prompt-engineering-spec
grep -n -A2 '规则地图' .github/workflows/prompt-lint.yml
```

**期望**：能看到 `npx tsx scripts/gen-prompt-spec-map.ts --check` 步骤。若没有，补上。

- [ ] **Step 2: 本地模拟 CI 判据全绿**

```bash
npx tsx scripts/prompt-lint.ts
npx tsx scripts/gen-prompt-spec-map.ts --check
```

**期望**：两条都 `ok`。

- [ ] **Step 3: 验证漂移会被抓（故意破坏再还原）**

```bash
python3 -c "
p='prompt-registry/PROMPT_SPEC.md'
s=open(p,encoding='utf-8').read()
open(p+'.bak','w',encoding='utf-8').write(s)
open(p,'w',encoding='utf-8').write(s.replace('| core |','| BROKEN |',1))
"
npx tsx scripts/gen-prompt-spec-map.ts --check; echo "退出码=$?"
mv prompt-registry/PROMPT_SPEC.md.bak prompt-registry/PROMPT_SPEC.md
npx tsx scripts/gen-prompt-spec-map.ts --check; echo "还原后退出码=$?"
```

**期望**：破坏后退出码 1 + 提示"请跑 --write"；还原后退出码 0。
⚠️ **必须确认 `.bak` 已删除**（`ls prompt-registry/*.bak` 应无输出）——spec 纪律：临时文件会污染提交。

---

## Task 7: 记忆反哺剔除（M6a）

**Files:**
- Modify: `services/pi-runtime/src/tools/memory.ts`
- Modify: `services/pi-runtime/src/tools/memory.test.ts`
- Modify: `apps/server/src/agent/agent.service.ts`（注入处过滤）

**Interfaces:**
- Consumes: 无
- Produces: `isSuppressed(memoryId: string): boolean`、`markSuppressed(memoryId: string, reason: string): void`、`SUPPRESSED_MEMORY_IDS`（进程内 Set）

⚠️ **本任务范围严格受限**：只做「剔除」，**不做晋升**（晋升是 M6b，涉及全局规则变更，风险更高，必须排在后面）。

- [ ] **Step 1: 写失败测试**

追加到 `services/pi-runtime/src/tools/memory.test.ts`（**本文件用 `node:test` 的 `test`/`assert` 风格，helper 是 `fakeClient(capture)` + `find(tools, name)` + `runTool(tool, args, ctx)`——⚠️ 没有 `callTool`**）：

```typescript
test("反哺：被标记的记忆不出现在 recall 结果里", async () => {
	markSuppressed("mem-bad", "反复导致模型把跨画布记忆当当前画布观察");
	const cap: Capture = { calls: 0 };
	// 真实签名：fakeClient(capture, reply) —— reply 是第二参数
	const tools = buildMemoryTools(fakeClient(cap, { items: [{ id: "mem-bad", content: "主角叫林晚", createdAt: "2026-10-04" }] }));
	const out = await runTool(find(tools, "recall_memory"), {}, tc);
	assert.ok(!JSON.stringify(out).includes("mem-bad"));
});

test("反哺：未标记的记忆照常返回（fail-open 不得误杀）", async () => {
	const cap: Capture = { calls: 0 };
	const tools = buildMemoryTools(fakeClient(cap, { items: [{ id: "mem-ok", content: "偏好暖色调", createdAt: "2026-10-04" }] }));
	const out = await runTool(find(tools, "recall_memory"), {}, tc);
	assert.ok(JSON.stringify(out).includes("mem-ok"));
});

test("反哺：id 缺失时保留条目（无法判定就不删，fail-open）", async () => {
	const cap: Capture = { calls: 0 };
	const tools = buildMemoryTools(fakeClient(cap, { items: [{ content: "无 id 条目", createdAt: "2026-10-04" }] }));
	const out = await runTool(find(tools, "recall_memory"), {}, tc);
	assert.ok(JSON.stringify(out).includes("无 id 条目"));
});
```

⚠️ **已核实的真实符号**（`memory.test.ts:1-31`）：`runTool(tool, params, tc)` · `find(tools, name)` · `fakeClient(capture, reply)`（reply 是**第二参数**，不是数组）· `payload(out)` 解析 JSON · 常量 `tc = { sessionId, trustedCanvasSessionId, userId }` 可直接复用。
⚠️ 本文件用 `node:test` 的 `test`/`assert/strict`，**不是 vitest 的 `it`/`expect`**。

⚠️ `fakeClient` / `callTool` 是本测试文件既有 helper（读文件确认真实名与签名）。第3 个测试的 `classifyBlock` 需从 `services/pi-runtime/src/dynamic-budget.ts` import。
⚠️ **第 3 个测试的断言方向先跑一遍看实际行为**：`classifyBlock` 用 `trimStart()` 后 `startsWith` 判断，所以内容以 `## 长期记忆` 开头**会**被判为 memory。若测试失败，说明这是个**真实待修缺陷**而非测试写错——此时按 §7.2 的方式在注入侧做转义，不要改 `classifyBlock` 的既有语义（它有测试锁定）。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/prompt-engineering-spec
node --import tsx --test services/pi-runtime/src/tools/memory.test.ts
```

**期望**：第 1 个测试 FAIL（`markSuppressed` 不存在）。

- [ ] **Step 3: 实现剔除**

在 `services/pi-runtime/src/tools/memory.ts` 加：

```typescript
/**
 * 反哺抑制表：反复导致模型出错的记忆 id → 原因。
 * 进程内态（pi-runtime 单进程，重启即失效）——刻意不做持久化：
 * 抑制是**临时止血**，不是永久删除；重启后重新观察再决定是否再抑制。
 * 依据 spec §13.3：多数污染记忆该"删"而不是"升"，剔除零风险且立即见效。
 */
const SUPPRESSED_MEMORY_IDS = new Map<string, string>();

export function isSuppressed(memoryId: string): boolean {
	return SUPPRESSED_MEMORY_IDS.has(memoryId);
}

export function markSuppressed(memoryId: string, reason: string): void {
	SUPPRESSED_MEMORY_IDS.set(memoryId, reason);
}
```

在 `recall_memory` 的结果组装处**过滤掉被抑制项**（找到 `mem.items.map(...)` 那段，改为先filter）：

```typescript
const items = (data as { items?: MemoryItem[] } | null)?.items ?? [];
const kept = items.filter((it) => !it.id || !isSuppressed(it.id));
```

⚠️ **注意**：`it.id` 可能为 undefined（`id` 是可选字段）——此时**保留**（fail-open：无法判定就不删）。

- [ ] **Step 4: 注入侧同样过滤**

编辑 `apps/server/src/agent/agent.service.ts:948` 附近，把：

```typescript
const lines = mem.items.map((m) => `- ${m.crossCanvas ? '[其他画布] ' : ''}${m.content}`);
```

改为先过滤抑制项（import `isSuppressed`）：

```typescript
const kept = mem.items.filter((m) => !m.id || !isSuppressed(m.id));
const lines = kept.map((m) => `- ${m.crossCanvas ? '[其他画布] ' : ''}${m.content}`);
```

⚠️ 后续的 `mem.items.some((m) => m.crossCanvas)` 也应改用 `kept`，否则全被抑制时 `crossNote` 判断依据不一致。

- [ ] **Step 5: 加指标（可观测性）**

在 `services/pi-runtime/src/metrics.ts` 加一个 counter，让「污染记忆数」**第一次可观测**（spec §9 指出该指标当前无法观测）：

```typescript
/** 反哺抑制的记忆数（累计）。0 ⇒ 从未触发过抑制。 */
private memorySuppressed = 0;

// 每次 markSuppressed 时this.memorySuppressed++
```

并加渲染行（参照现有 `pi_runtime_transform_context_annotated_total` 的写法）：

```typescript
lines.push("# HELP pi_runtime_memory_suppressed_total Memories suppressed by feedback loop.");
lines.push("# TYPE pi_runtime_memory_suppressed_total counter");
lines.push(`pi_runtime_memory_suppressed_total ${this.memorySuppressed}`);
```

- [ ] **Step 6: 跑测试 + 提交**

```bash
node --import tsx --test services/pi-runtime/src/tools/memory.test.ts
npx tsx scripts/prompt-lint.ts
git commit -o services/pi-runtime/src/tools/memory.ts -o services/pi-runtime/src/tools/memory.test.ts -o apps/server/src/agent/agent.service.ts -o services/pi-runtime/src/metrics.ts -m "feat(memory): 反哺剔除——污染记忆不进recall 与注入（spec M6a）"
```

---

## 执行顺序与并行

```
Task 1 (PROMPT_SPEC + anchor)  →  Task 2 (生成器 + L11)  →  Task 3 (语义引用 + L10)
                                                              ↓
Task 4 (契约测试 6 case)  ←────────────────────────────────────┘（依赖 1/2/3 的 anchor 与门禁）
   ↓
Task 5 (A/B 场景集)        Task 6 (CI 闭环验证)
   ↓
Task 7 (反哺剔除 M6a)      —— 独立于 1-6，可与 Task 5 并行
```

**Task 7 与 Task 1–6 无依赖**，若要赶时间可并行（不同文件，零冲突）。

**M6b（晋升队列）不在本计划内** —— spec §13.3 判定它应在 M6a 之后、且需要独立的候选聚合设计，另开一轮。

---

## 完成判据

全部任务完成后，以下**全部**成立：

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/prompt-engineering-spec
npx tsx scripts/prompt-lint.ts                                    # ok（0 errors）
npx tsx scripts/gen-prompt-spec-map.ts --check                    # ok
grep -c '规则 *[0-9]' prompt-registry/rules/*.md                 # 0
pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/prompt-registry.loader.test.ts src/agent/pi-runtime/pi-prompt-assembler.service.test.ts   # 全绿
node --import tsx --test services/pi-runtime/src/tools/memory.test.ts   # 全绿
ls prompt-registry/*.bak 2>/dev/null                              # 无输出
```

⚠️ **若任一条不成立，不要合并**。特别是 `prompt-lint` 必须在 0 errors——warnings 也要读完，它会告诉你余量还剩多少。
