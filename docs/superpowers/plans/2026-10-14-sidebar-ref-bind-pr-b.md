# 侧栏参考图绑定 PR-B（契约批）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消灭「runtime 放行 ↔ Nest 拒绝」的契约中间地带（RB-D7 fixture 双端镜像测试）+ 补信号层 throw 路径盲区（RB-D4，`_isError` 形参预留未用）+ 落地 PR-A 终审登记的 4 个错误文案硬化 Minor（agent.service 裸调用 500 / 超限文案失配 / 非数组 TypeError 英文文案 / PROMPT_SPEC stale）。

**Architecture:** 三块独立改动：① 共享 fixture JSON（`packages/shared/fixtures/`，纯数据文件，无跨包 import）为唯一 SSOT，shared 侧（vitest）与 runtime 侧（node:test）各自读同一份断言镜像不变量；② 信号层：新增 `signalFromErrorContent`（从 NestToolError 文本提取 `http <status>`，4xx⇒invalid_params 不可重试 / 5xx⇒upstream_5xx 退避），wiring 的 `readSignal(details) ?? (isError ? signalFromErrorContent(content) : undefined)` 单点扩展；③ 错误文案硬化全落在 Nest 侧既有 catch/调用点。

**Tech Stack:** packages/shared（zod / vitest）、pi-runtime（node:test / tsx）、apps/server（Nest / vitest）。

**Spec:** `docs/superpowers/specs/2026-10-13-sidebar-ref-bind-invariant-design.md`（RB-D4 / RB-D7；硬表第 5/6/7/8 行）。PR-A 批（RB-D2/D3/S0-3/RB-D6②）已随 #402 上线。

**工作目录：** 全程在 worktree `/Users/4seven/workspace/pi-lnk/.worktrees/sidebar-ref-bind-pr-b`（分支 `fix/sidebar-ref-bind-invariant-pr-b`，off origin/master 25a76fca，依赖软链已由控制器建好并冒烟验证）。**禁止在主仓提交**。

## Ruling（计划评审时已裁决）

- fixture 在规格四形态（SM-D4 回落实体 / 老链路显式 / 畸形态 / 空数组）之外**追加两个真实跨界形态**：`non-array`（字符串 `"I1"`，M-1 透传形态，PR-A 实证会打到 Nest 变 TypeError）与 `over-limit`（6 个合法实体，M-2 文案失配的载体）。理由：两者都是真实发生的跨界形态，镜像矩阵不覆盖它们等于留盲区。
- 镜像不变量的精确语义：`expectZod:"pass"` ⇒ runtime 消毒透传；`reject(reason:"limit")` ⇒ 透传（Nest SSOT 裁量）；`reject(reason:"non-array")` ⇒ 透传（消毒只管数组，non-array 归 Nest 400）；`reject(reason:"shape")` ⇒ **整删除**（回落 tc.attachments）。即：runtime 只做「数组内形状守门」，其余全部归 Nest。
- 信号层 throw 分支的匹配面：仅匹配 NestToolError 文本模式 `/\bhttp (\d{3})\b/`（envelope=`code=`、timeout/network 无状态码 ⇒ undefined 不妄言）；非 nest 工具（ask_user 等）错误消息不含该模式 ⇒ 维持「契约外零接触」裁定。

## Global Constraints

- **禁止跨包运行时依赖**：pi-runtime 不 import `@lnkpi/shared`；共享只经 fixture JSON 文件（两侧测试各自用相对路径读取）。
- `vendor/` 零改动；提示词零改动（本批无 6 处同步问题）；`result-signal` patch 面纪律不变（只 content/details，绝不碰 isError/usage/terminate）；成功静默 0 token 纪律不变（无 _signal 且非 nest 形态 isError 的结果零注入）。
- 信号 metrics（observeResultSignal）随 throw 分支自然覆盖 nest 错误分类，**不新增 metrics 接口**（RB-D9 属 PR-D）。
- 每任务独立提交，`fix(scope): 描述`；push 备用双路：SOCKS 隧道（`env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy git -c http.proxy=socks5h://127.0.0.1:18081 -c http.version=HTTP/1.1 push ...`）或 harness 代理直连（本会话已实证可行）。
- 测试纪律：先写失败测试再实现；4 核机勿并行两个 tsc；loader 类重组件 vitest 测试单独跑（组合跑会 5s 超时假红，PR-A 实证）。

## Review Focus（规格隐含、最易咬人的五类输入）

1. **非 nest 错误消息**（harness immediateError 的 `Tool "x" is unavailable`、ask_user 裸 isError）→ 零注入（Task 3 测试 3）。
2. **envelope/timeout/network 消息**（`code=` / `timeout after` / `network error`，无 http 状态码）→ 不妄言，undefined（Task 3 测试 6）。
3. **isError 但 details 已有合法 _signal** → readSignal 优先，message 提取不生效（Task 3 测试 5）。
4. **fixture 与双侧断言漂移** → 镜像不变量表在两侧测试文件各自全量断言，任何一侧改 fixture 必双侧同步（Task 1/2 镜像断言）。
5. **agent.service.stream 有 ~40 处按位置调用的测试** → Task 4b 只包 try/catch 不改参数表（该文件注释明示：参数表末尾追加会移位静默错值）。

---

### Task 0: worktree 依赖借用（环境准备，控制器已完成）

- [x] worktree `fix/sidebar-ref-bind-invariant-pr-b` off 25a76fca；软链纪律（PR-A 修正版）：`@lnkpi/*` 绝对路径指本 worktree `packages/*`（server/web/agent 三处 ×shared+agent）；per-item 含 `.bin`；pi-runtime 逐项软链主仓。
- [x] 冒烟：`services/pi-runtime` node:test 可跑；`apps/server` vitest 可跑。

---

### Task 1: 契约 fixture + shared 侧守卫与 Zod 矩阵测试（RB-D7 上半 + M-3）

**Files:**
- Create: `packages/shared/fixtures/sidebar-attachments-contract.json`
- Modify: `packages/shared/src/sidebarAttachments.ts`（`validateSidebarAttachments` 顶部加非数组守卫）
- Test: `packages/shared/src/sidebarAttachments.contract.test.ts`（新建）

**Interfaces:**
- Produces: fixture JSON 为唯一契约 SSOT，条目形态 `{ name, note, attachments, expectZod: "pass"|"reject", rejectReason?: "shape"|"limit"|"non-array" }`；`validateSidebarAttachments` 对非数组抛含「attachments 必须是数组」的 Error（替代 TypeError）。
- runtime 侧（Task 2）与 Nest 侧（PR-A 已有 400 化）消费同一 fixture。

- [ ] **Step 1: 写 fixture JSON**（六个条目，逐字使用）

```json
[
  {
    "name": "platform-fill-entities",
    "note": "SM-D4 平台填充回落：execute 把 tc.attachments 实体放进 POST body（事故会话的正确终态）",
    "attachments": [
      { "id": "mv6f01", "mediaType": "image", "sourceKind": "upload", "label": "girl.png", "url": "https://cdn.example/girl.png" },
      { "id": "mv6f02", "mediaType": "image", "sourceKind": "upload", "label": "dress.jpg", "url": "https://cdn.example/dress.jpg" }
    ],
    "expectZod": "pass"
  },
  {
    "name": "legacy-explicit-entity",
    "note": "老链路显式传参：模型从上下文回显完整实体（不得误杀）",
    "attachments": [
      { "id": "mv6f03", "mediaType": "image", "sourceKind": "asset", "label": "a.jpg", "url": "https://cdn.example/a.png" }
    ],
    "expectZod": "pass"
  },
  {
    "name": "fabricated-chips",
    "note": "事故形态：模型伪造 attachments，字段全虚构（{source,target_node_id}）——消毒整删后不会出现在 body，此处建模「消毒前模型 try 传参」",
    "attachments": [
      { "source": "I1", "target_node_id": "image-x" }
    ],
    "expectZod": "reject",
    "rejectReason": "shape"
  },
  {
    "name": "empty-array",
    "note": "空数组：M-1 老回落语义（空数组 ⇒ 平台填充），Zod 放行",
    "attachments": [],
    "expectZod": "pass"
  },
  {
    "name": "non-array-string",
    "note": "M-1 缺陷形态：模型把芯片 key 当 attachments 传（字符串）——消毒透传，Nest 必拒（M-3：须中文可行动文案，不得 TypeError）",
    "attachments": "I1",
    "expectZod": "reject",
    "rejectReason": "non-array"
  },
  {
    "name": "over-limit",
    "note": "M-2 载体：形状全合法但超 SIDEBAR_ATTACHMENT_MAX=5——消毒透传，Nest 拒（文案须可区分「超限」与「形状错」）",
    "attachments": [
      { "id": "a0", "mediaType": "image", "sourceKind": "upload", "label": "0.jpg", "url": "https://cdn.example/0.png" },
      { "id": "a1", "mediaType": "image", "sourceKind": "upload", "label": "1.jpg", "url": "https://cdn.example/1.png" },
      { "id": "a2", "mediaType": "image", "sourceKind": "upload", "label": "2.jpg", "url": "https://cdn.example/2.png" },
      { "id": "a3", "mediaType": "image", "sourceKind": "upload", "label": "3.jpg", "url": "https://cdn.example/3.png" },
      { "id": "a4", "mediaType": "image", "sourceKind": "upload", "label": "4.jpg", "url": "https://cdn.example/4.png" },
      { "id": "a5", "mediaType": "image", "sourceKind": "upload", "label": "5.jpg", "url": "https://cdn.example/5.png" }
    ],
    "expectZod": "reject",
    "rejectReason": "limit"
  }
]
```

- [ ] **Step 2: 写失败测试**（新建 `packages/shared/src/sidebarAttachments.contract.test.ts`）

```ts
/**
 * RB-D7 契约镜像（shared/Zod 侧）：fixture 是唯一 SSOT。
 * 断言 validateSidebarAttachments 对每个条目的过/拒矩阵；
 * rejectReason=non-array 时错误文案必须中文可行动（含「attachments 必须是数组」），
 * 不得是 TypeError 的 "items.map is not a function"（PR-A 终审 M-3）。
 */
import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { validateSidebarAttachments, SIDEBAR_ATTACHMENT_MAX } from './sidebarAttachments'

interface FixtureEntry {
  name: string
  note: string
  attachments: unknown
  expectZod: 'pass' | 'reject'
  rejectReason?: 'shape' | 'limit' | 'non-array'
}

const fixture: FixtureEntry[] = JSON.parse(
  await readFile(fileURLToPath(new URL('../fixtures/sidebar-attachments-contract.json', import.meta.url)), 'utf8'),
) as FixtureEntry[]

describe('sidebar attachments 契约矩阵（RB-D7 fixture SSOT）', () => {
  it('fixture 本身有效（非空、字段齐）', () => {
    expect(fixture.length).toBeGreaterThanOrEqual(5)
    for (const e of fixture) {
      expect(e.name, e.note).toBeTruthy()
      expect(['pass', 'reject']).toContain(e.expectZod)
      if (e.expectZod === 'reject') expect(e.rejectReason).toBeTruthy()
    }
  })

  for (const e of fixture) {
    it(`[${e.name}] Zod ${e.expectZod}${e.rejectReason ? `（${e.rejectReason}）` : ''}`, () => {
      if (e.expectZod === 'pass') {
        expect(() => validateSidebarAttachments(e.attachments as never)).not.toThrow()
        return
      }
      try {
        validateSidebarAttachments(e.attachments as never)
        expect.unreachable(`${e.name} 应被拒绝`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        expect(msg).not.toMatch(/items\.map is not a function/)
        if (e.rejectReason === 'limit') expect(msg).toContain(`最多添加 ${SIDEBAR_ATTACHMENT_MAX}`)
        if (e.rejectReason === 'non-array') expect(msg).toContain('attachments 必须是数组')
      }
    })
  }
})
```

- [ ] **Step 3: 跑测试确认失败**（non-array 条目红：TypeError 无中文文案）

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/sidebar-ref-bind-pr-b/packages/shared && ./node_modules/vitest/vitest.mjs run src/sidebarAttachments.contract.test.ts 2>&1 | tail -4
```

- [ ] **Step 4: 最小实现**（`validateSidebarAttachments` 顶部，`if (items.length > ...)` 之前）

```ts
  // RB-D7/M-3：非数组输入曾走到 items.map 抛英文 TypeError（PR-A 终审 M-3）。
  // 守卫为可行动中文文案：M-1 形态（芯片 key 当数组传）在 Nest 侧可直接自愈。
  if (!Array.isArray(items)) {
    throw new Error('attachments 必须是数组（每项为侧栏附件实体）；请省略该参数，由平台自动填充本轮侧栏附件')
  }
```

- [ ] **Step 5: 跑测试全绿 + shared 全量回归**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/sidebar-ref-bind-pr-b/packages/shared && ./node_modules/vitest/vitest.mjs run 2>&1 | tail -4
```

- [ ] **Step 6: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk/.worktrees/sidebar-ref-bind-pr-b add packages/shared/fixtures/sidebar-attachments-contract.json packages/shared/src/sidebarAttachments.ts packages/shared/src/sidebarAttachments.contract.test.ts
git -C /Users/4seven/workspace/pi-lnk/.worktrees/sidebar-ref-bind-pr-b commit -m "fix(shared): 侧栏附件契约 fixture + 非数组守卫中文文案（RB-D7 上半，M-3）"
```

---

### Task 2: runtime 侧消毒契约镜像测试（RB-D7 下半，纯测试）

**Files:**
- Test: `services/pi-runtime/src/tools/canvas-write.contract-mirror.test.ts`（新建；无实现改动）

**Interfaces:**
- Consumes: Task 1 fixture；`createCanvasWriteTools` / `findTool` / `makeClient`（canvas-write.test.ts 既有 helper，从该文件 import 或按同构重建——以文件既有导出为准，若 helper 未导出则在镜像测试内用 `import { createCanvasWriteTools } from "./canvas-write.js"` 自建最小 client fake，形态抄 canvas-write.test.ts 顶部 makeClient）。
- Produces: 镜像不变量测试——每个 fixture 条目断言 `prepareArguments` 输出与 Ruling 表一致。

- [ ] **Step 1: 写镜像测试**（直接可绿的测试——本任务锁既有行为，红绿循环不适用；若断言失败即发现真回归，停下报告）

```ts
/**
 * RB-D7 契约镜像（runtime 消毒侧）：与 packages/shared/fixtures/sidebar-attachments-contract.json
 * 共享 SSOT。镜像不变量（Ruling 2026-10-13 PR-B）：
 *   Zod pass            ⇒ prepareArguments 透传
 *   reject(limit)       ⇒ 透传（Nest SSOT 裁量，M-2）
 *   reject(non-array)   ⇒ 透传（消毒只管数组形态）
 *   reject(shape)       ⇒ 整参数删除（execute 回落 tc.attachments，RB-D2）
 * 任何一侧改 fixture 必双侧同步——漂移即本测试红。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCanvasWriteTools } from "./canvas-write.js";
// makeClient/findTool 的既有实现从 canvas-write.test.ts 顶部抄形态（见该文件 L1-39）。

interface FixtureEntry {
	name: string;
	attachments: unknown;
	expectZod: "pass" | "reject";
	rejectReason?: "shape" | "limit" | "non-array";
}

const fixture: FixtureEntry[] = JSON.parse(
	readFileSync(fileURLToPath(new URL("../../../../packages/shared/fixtures/sidebar-attachments-contract.json", import.meta.url)), "utf8"),
) as FixtureEntry[];

/** Ruling 表：Zod 结论 ⇒ 消毒行为。 */
function expectSanitize(e: FixtureEntry): "passthrough" | "delete" {
	if (e.expectZod === "pass") return "passthrough";
	if (e.rejectReason === "shape") return "delete"; // 仅数组内形状错
	return "passthrough"; // limit / non-array 归 Nest
}

describe("canvas-write: 侧栏附件契约镜像（RB-D7，fixture SSOT）", () => {
	const { client } = makeClient();
	const tool = findTool(createCanvasWriteTools(client), "apply_sidebar_attachments");

	for (const e of fixture) {
		it(`[${e.name}] sanitize ⇒ ${expectSanitize(e)}`, () => {
			const args = { node_ids: ["n1"], mode: "localRefs", attachments: e.attachments };
			const out = tool.prepareArguments?.(args) as Record<string, unknown> | undefined;
			assert.ok(out, "prepareArguments 必须有返回值");
			if (expectSanitize(e) === "passthrough") {
				assert.deepEqual(out.attachments, e.attachments);
			} else {
				assert.equal("attachments" in out, false, "伪造形态必须整参数删除（含键删除，非 undefined）");
			}
			// 非目标参数永不消毒：node_ids/mode 原样保留
			assert.deepEqual(out.node_ids, ["n1"]);
			assert.equal(out.mode, "localRefs");
		});
	}
});
```

（实现注：若 `makeClient`/`findTool` 未从 canvas-write.test.ts 导出，在镜像测试文件内复制其最小形态并注明「与 canvas-write.test.ts 同构，漂移时以彼为准」。）

- [ ] **Step 2: 跑测试确认全绿**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/sidebar-ref-bind-pr-b/services/pi-runtime && node --import tsx --test src/tools/canvas-write.contract-mirror.test.ts 2>&1 | tail -3
```

- [ ] **Step 3: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk/.worktrees/sidebar-ref-bind-pr-b add services/pi-runtime/src/tools/canvas-write.contract-mirror.test.ts
git -C /Users/4seven/workspace/pi-lnk/.worktrees/sidebar-ref-bind-pr-b commit -m "test(pi-runtime): 侧栏附件契约镜像测试——消毒谓词对照 shared fixture（RB-D7 下半）"
```

---

### Task 3: 信号层 throw 路径分支（RB-D4）

**Files:**
- Modify: `services/pi-runtime/src/tools/result-signal-listener.ts`（新增导出 `signalFromErrorContent`；`appendSignalLine` 的 `_isError` 语义注释更新）
- Modify: `services/pi-runtime/src/result-signal-wiring.ts`（handler 首行 `readSignal ?? isError 分支`）
- Test: `services/pi-runtime/src/tools/result-signal-listener.test.ts` + `services/pi-runtime/src/result-signal-wiring.test.ts`（各追加）

**Interfaces:**
- Consumes: NestToolError 文本模式（nest-client.ts:124 `nest <path> http <status>: <msg>`，实证）；vendor `createErrorToolResult`（throw ⇒ content=[{text:message}], details=undefined, isError=true，execution/tools.ts 实证）。
- Produces: wiring 对 nest 形态错误合成 `_signal` → 既有 signalLines 产出 `⚠️[<tier>]` 行；metrics 自然覆盖。成功静默/契约外工具行为逐字节不变。

- [ ] **Step 1: 写失败测试**（追加到 `result-signal-listener.test.ts`）

```ts
describe("signalFromErrorContent（RB-D4 throw 路径）", () => {
	it("isError + nest http 4xx ⇒ {status:failed, retryable:false, errorCode:invalid_params}", () => {
		const sig = signalFromErrorContent([
			{ type: "text", text: "nest /agent/internal/apply-sidebar-attachments http 400: attachments 校验失败（id: Required）。正确用法：省略 attachments 参数。" },
		]);
		assert.deepEqual(sig, { status: "failed", retryable: false, errorCode: "invalid_params" });
	});

	it("isError + nest http 5xx ⇒ {status:failed, retryable:true, errorCode:upstream_5xx}", () => {
		const sig = signalFromErrorContent([{ type: "text", text: "nest /x http 502: Bad Gateway" }]);
		assert.deepEqual(sig, { status: "failed", retryable: true, errorCode: "upstream_5xx" });
	});

	it("非 nest 错误（harness immediateError / ask_user）⇒ undefined（Review Focus 1）", () => {
		assert.equal(signalFromErrorContent([{ type: "text", text: 'Tool "x" is unavailable' }]), undefined);
	});

	it("envelope/timeout/network（无 http 状态码）⇒ undefined 不妄言（Review Focus 2）", () => {
		assert.equal(signalFromErrorContent([{ type: "text", text: "nest /x code=1: boom" }]), undefined);
		assert.equal(signalFromErrorContent([{ type: "text", text: "nest /x timeout after 60000ms: T" }]), undefined);
		assert.equal(signalFromErrorContent([{ type: "text", text: "nest /x network error: ECONNRESET" }]), undefined);
	});

	it("空内容 / 无文本块 ⇒ undefined", () => {
		assert.equal(signalFromErrorContent([]), undefined);
		assert.equal(signalFromErrorContent([{ type: "image", data: "x" } as never]), undefined);
	});
});

describe("appendSignalLine × throw 路径（RB-D4）", () => {
	it("nest 4xx 错误 + 无 _signal + 既有 actions ⇒ ⚠️ 行 + _signal 合成且 actions 保留（硬表第 6 行）", () => {
		const patch = appendSignalLine(
			"apply_sidebar_attachments",
			"write",
			true,
			[{ type: "text", text: "nest /x http 400: attachments 校验失败" }],
			{ actions: [{ type: "canvas_apply_refs" }] },
		);
		assert.ok(patch, "throw 路径必须有 patch");
		const lastText = (patch.content.at(-1) as { type: string; text: string }).text;
		assert.ok(lastText.includes("⚠️[write]"));
		assert.ok(lastText.includes("invalid_params"));
		assert.ok(lastText.includes("重试同参无意义"));
		const sig = (patch.details as { _signal?: { errorCode?: string; retryable?: boolean } })._signal;
		assert.equal(sig?.errorCode, "invalid_params");
		assert.equal(sig?.retryable, false);
		assert.deepEqual((patch.details as { actions: unknown[] }).actions, [{ type: "canvas_apply_refs" }]);
	});

	it("details 已有合法 _signal ⇒ readSignal 优先，message 提取不生效（Review Focus 3）", () => {
		const patch = appendSignalLine(
			"gen_image",
			"gen",
			true,
			[{ type: "text", text: "nest /x http 400: should-not-win" }],
			{ _signal: { status: "failed", retryable: true, errorCode: "rate_limited" } },
		);
		assert.ok(patch);
		const sig = (patch!.details as { _signal: { errorCode?: string } })._signal;
		assert.equal(sig.errorCode, "rate_limited");
	});

	it("非 nest 错误 + 无 _signal ⇒ undefined（零注入，成功静默纪律不受影响）", () => {
		assert.equal(
			appendSignalLine("ask_user", "unknown", true, [{ type: "text", text: 'Tool "x" is unavailable' }], undefined),
			undefined,
		);
	});
});
```

- [ ] **Step 2: 跑测试确认失败**（`signalFromErrorContent` 未导出；appendSignalLine throw 用例红）

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/sidebar-ref-bind-pr-b/services/pi-runtime && node --import tsx --test src/tools/result-signal-listener.test.ts 2>&1 | grep -E '^# (pass|fail)'
```

- [ ] **Step 3: 最小实现**（result-signal-listener.ts）

```ts
/**
 * RB-D4（spec 2026-10-13-sidebar-ref-bind-invariant-design.md）：信号层 throw 路径分支。
 * NestToolError 文本模式（nest-client.ts:124）：`nest <path> http <status>: <msg>`。
 * 4xx ⇒ invalid_params（参数错不可重试）；5xx ⇒ upstream_5xx（退避）。
 * envelope(code=)/timeout/network 无状态码 ⇒ undefined 不妄言；非 nest 消息不匹配 ⇒
 * 维持 10-12 Ruling「契约外工具零注入」。
 */
export function signalFromErrorContent(content: SignalContentBlock[]): ToolResultSignal | undefined {
	let text = "";
	for (const b of content) {
		if (isTextBlock(b)) text += `${b.text}\n`;
	}
	const m = /\bhttp ([1-5]\d{2})\b/.exec(text);
	if (!m) return undefined;
	const status = Number(m[1]);
	if (status >= 500) return { status: "failed", retryable: true, errorCode: "upstream_5xx" };
	if (status >= 400) return { status: "failed", retryable: false, errorCode: "invalid_params" };
	return undefined;
}
```

（`appendSignalLine` 不改——信号合成在 wiring 单点完成；`_isError` 形参保留并把注释从「预留未用」改为「由 wiring 在调用前消费」。）

- [ ] **Step 4: wiring 分支**（result-signal-wiring.ts handler 首两行替换）

```ts
			const signal =
				readSignal(event.details) ?? (event.isError ? signalFromErrorContent(event.content) : undefined);
			if (!signal) return undefined; // 契约外工具 / 非 nest 错误零接触（不打点不注入）
```

（import 区补 `signalFromErrorContent`；其余 metrics/extra/appendSignalLine 流不动——signal 存在即走既有注入路径。）

- [ ] **Step 5: wiring 测试追加**（result-signal-wiring.test.ts）

```ts
	it("RB-D4：nest 4xx throw（无 _signal）⇒ 注入 ⚠️ 行 + metrics 计 failed", async () => {
		const hooks = new FakeHooks();
		const metrics = new Metrics();
		registerResultSignalListener(hooks, {}, { tiers: TIERS, metrics });
		const patch = (await hooks.handlers[0]({
			toolCallId: "c9",
			toolName: "apply_sidebar_attachments",
			args: { node_ids: ["n1"] },
			content: [{ type: "text", text: "nest /x http 400: attachments 校验失败" }],
			isError: true,
		})) as { content?: unknown[]; details?: Record<string, unknown> } | undefined;
		assert.ok(patch, "throw 路径必须有 patch");
		assert.ok(JSON.stringify(patch.content).includes("⚠️[unknown]"));
		assert.equal((patch.details?._signal as { errorCode?: string }).errorCode, "invalid_params");
	});
```

（`apply_sidebar_attachments` 不在 TIERS ⇒ tier=unknown，符合既有 fallback 语义。）

- [ ] **Step 6: 信号层全量回归**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/sidebar-ref-bind-pr-b/services/pi-runtime && node --import tsx --test src/tools/result-signal-listener.test.ts src/result-signal-wiring.test.ts src/result-signal-golden.test.ts 2>&1 | grep -E '^# (pass|fail)'
```

Expected: 全绿（golden 用例零回归 = 成功静默纪律未被破坏）。

- [ ] **Step 7: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk/.worktrees/sidebar-ref-bind-pr-b add services/pi-runtime/src/tools/result-signal-listener.ts services/pi-runtime/src/tools/result-signal-listener.test.ts services/pi-runtime/src/result-signal-wiring.ts services/pi-runtime/src/result-signal-wiring.test.ts
git -C /Users/4seven/workspace/pi-lnk/.worktrees/sidebar-ref-bind-pr-b commit -m "fix(pi-runtime): 信号层 throw 路径——NestToolError 4xx/5xx 合成 _signal 可行动注入（RB-D4）"
```

---

### Task 4: 错误文案硬化收尾（M-2 / agent.service:260 / M-4）

**Files:**
- Modify: `apps/server/src/agent/agent-canvas-tools.service.ts`（applySidebarAttachments catch 内文案分支）
- Modify: `apps/server/src/agent/agent.service.ts:260`（裸调用 try/catch → BadRequestException，同 PR-A 风格）
- Modify: `prompt-registry/PROMPT_SPEC.md`（生成区间外手写 🟡 块「余量 89 字符」→「余量 165 字符」；**手写区不动生成区间**）
- Test: `apps/server/src/agent/agent-canvas-tools.sidebar.test.ts`（超限文案断言收紧）+ `apps/server/src/agent/agent.service.test.ts`（:254 用例扩展）

**Interfaces:**
- Consumes: Task 1 的中文守卫（non-array 已在 shared 收口）。
- Produces: ① 超限与形状错文案可区分且指引正确（超限 ⇒ 裁剪指引，非「省略」）；② 用户消息附件路径不再 500；③ 文档数字与实测一致。

- [ ] **Step 1: 写失败测试**（sidebar.test.ts：收紧既有超限用例的断言——指引必须是「裁剪」而非「省略」）

```ts
  it('超限 400 指引必须是「裁剪到 5 个以内」而非「省略 attachments」（M-2：平台填充同样受 5 个上限约束）', async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      id: `b${i}`, mediaType: 'image' as const, sourceKind: 'upload' as const, label: `b${i}.jpg`, url: `https://x/${i}.png`,
    }))
    await expect(
      svc.applySidebarAttachments({ sessionId: 's1', nodeIds: ['n1'], attachments: six, mode: 'localRefs' }),
    ).rejects.toThrow(/裁剪 attachments 至 5 个以内/)
    await expect(
      svc.applySidebarAttachments({ sessionId: 's1', nodeIds: ['n1'], attachments: six, mode: 'localRefs' }),
    ).rejects.not.toThrow(/正确用法：省略 attachments 参数/)
  })
```

- [ ] **Step 2: 实现文案分支**（PR-A catch 块内，`detail` 组装后）

```ts
      const isOverLimit = /最多添加/.test(detail)
      throw new BadRequestException(
        isOverLimit
          ? `attachments 校验失败（${detail}）。请裁剪 attachments 至 ${SIDEBAR_ATTACHMENT_MAX} 个以内，或改用多轮逐个挂载。`
          : `attachments 校验失败（${detail}）。正确用法：省略 attachments 参数，由平台自动填充本轮侧栏附件（只传 nodeIds 与 mentionedKeys）。`,
      )
```

（import 区补 `SIDEBAR_ATTACHMENT_MAX`，来自 `@lnkpi/shared`——server 已依赖 shared，非跨包新增。）

- [ ] **Step 3: agent.service.ts:260 400化**（只包 try/catch，参数表零改动——Review Focus 5）

```ts
    let validatedAttachments: SidebarAttachment[] | undefined
    try {
      validatedAttachments = attachments?.length ? validateSidebarAttachments(attachments) : undefined
    } catch (e) {
      // RB-D3 延伸（PR-A 终审）：用户消息附件路径同样不再 500，字段细节 + 正确用法直达。
      const detail = e instanceof ZodError
        ? e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
        : (e as Error).message
      throw new BadRequestException(`参考素材校验失败（${detail}）。请检查上传的参考素材后重试。`)
    }
```

（import：`BadRequestException` 若未导入则补；`ZodError` from 'zod'；类型 `SidebarAttachment` from '@lnkpi/shared' 若未导入。）

- [ ] **Step 4: agent.service.test.ts:254 用例扩展**（既有 'forwards validated sidebar attachments' 之后追加）

```ts
  it('RB-D3 延伸：非法参考素材（超限）⇒ BadRequestException 400 化，不再裸 500', async () => {
    // 复用 :254 用例的既有装配方式（mock/fake 同款），attachments 传 6 个合法形状实体。
    await expect(
      buildStreamInput({ attachments: sixValidEntities }),
    ).rejects.toThrow(BadRequestException)
  })
```

（实现注：装配形态以该测试文件既有 helper 为准——只断言 rejects.toThrow(BadRequestException) 与 message 含「最多添加」；若 stream() 是 generator，用 `for await` 驱动首项触发。）

- [ ] **Step 5: PROMPT_SPEC.md M-4**（手写区单行：`余量 89 字符` → `余量 165 字符`；生成区间 `<!-- BEGIN/END:* -->` 零触碰）

- [ ] **Step 6: 跑测试全绿 + prompt:lint 门禁**

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/sidebar-ref-bind-pr-b/apps/server && ./node_modules/vitest/vitest.mjs run src/agent/agent-canvas-tools.sidebar.test.ts src/agent/agent.service.test.ts 2>&1 | grep -E 'Test Files|Tests '
cd /Users/4seven/workspace/pi-lnk/.worktrees/sidebar-ref-bind-pr-b && pnpm prompt:lint 2>&1 | tail -2
```

- [ ] **Step 7: Commit**

```bash
git -C /Users/4seven/workspace/pi-lnk/.worktrees/sidebar-ref-bind-pr-b add apps/server/src/agent/agent-canvas-tools.service.ts apps/server/src/agent/agent-canvas-tools.sidebar.test.ts apps/server/src/agent/agent.service.ts apps/server/src/agent/agent.service.test.ts prompt-registry/PROMPT_SPEC.md
git -C /Users/4seven/workspace/pi-lnk/.worktrees/sidebar-ref-bind-pr-b commit -m "fix(server): 附件错误文案硬化——超限/形状可区分指引、用户消息路径 400 化（RB-D3 延伸，M-2/M-4）"
```

---

### Task 5: 全量回归 + push + PR

**Files:** 无新改动（验证批）。

- [ ] **Step 1: typecheck 三包**（顺序执行，勿并行——4 核纪律）

```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/sidebar-ref-bind-pr-b/services/pi-runtime && ./node_modules/.bin/tsc --noEmit 2>&1 | tail -2
cd /Users/4seven/workspace/pi-lnk/.worktrees/sidebar-ref-bind-pr-b/packages/shared && ./node_modules/.bin/tsc --noEmit 2>&1 | tail -2
cd /Users/4seven/workspace/pi-lnk/.worktrees/sidebar-ref-bind-pr-b/apps/server && ./node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1 | tail -2
```

（web 本批零改动，不跑 vue-tsc。）

- [ ] **Step 2: 关键测试面回归**（各自单独跑，勿组合——PR-A 实证 5s 超时假红）

```bash
cd services/pi-runtime && node --import tsx --test src/tools/canvas-write.test.ts src/tools/canvas-write.contract-mirror.test.ts src/tools/result-signal-listener.test.ts src/tools/tiering.test.ts 2>&1 | grep -E '^# (pass|fail)'
cd ../../packages/shared && ./node_modules/vitest/vitest.mjs run 2>&1 | grep -E 'Test Files|Tests '
cd ../../apps/server && ./node_modules/vitest/vitest.mjs run src/agent/agent-canvas-tools.sidebar.test.ts 2>&1 | grep -E 'Test Files|Tests '
```

- [ ] **Step 3: git status 自检**（`git status --short | grep -v '^??'` 必须为空才 push）

- [ ] **Step 4: push + 开 PR**（title: `fix(agent): 侧栏参考图绑定契约批（RB-D7 镜像 / RB-D4 信号 throw 路径 / 错误文案硬化）`；正文概述：fixture SSOT 双端镜像矩阵 / 信号层 4xx⇒invalid_params、5xx⇒upstream_5xx 可行动注入（补 10-12 盲区）/ PR-A 终审 M-2/M-3/M-4 + agent.service:260 400 化；关联规格与 PR-A #402）

- [ ] **Step 5: 盯 CI 全绿**（重点 prompt-registry 门禁——本批动了 PROMPT_SPEC.md 手写区，若 gen-prompt-spec-map --check 红则核对是否误触生成区间）。合并与生产验证转 `prod-deploy-verify`：验收判据 = 硬表第 6/7/8 行测试 + 触发一次真实 apply 失败路径看 runtime 日志出现 `⚠️[write]` 注入（可选，G1 重放属 PR-D 全量验收）。
