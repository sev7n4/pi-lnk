# 侧栏参考图绑定 PR-A（止血批）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消灭「模型伪造 attachments → 穿透空 schema → Nest 500 → 模型丧失自愈 → 带病出图」的事故形态：消毒伪造参数 + 错误可行动化（400）+ 平台填充对账文案 + 前端失败持久警示。

**Architecture:** 四个独立小改动，均落在既有管线上、不改 execute 回落语义：① vendor `prepareArguments`（harness `prepareToolCall` 在 validate 之前调用，生产路径 `harness/runtime/drive/tools.ts` 已确认）删伪造参数 → execute 既有回落命中 `tc.attachments`；② Nest 校验失败就地转 `BadRequestException`（与同文件 `BadRequestException('创建媒体节点失败')` 同风格，不引全局 filter）；③ 平台填充时在结果 content 追加一行来源说明（对账）；④ 前端 dock 确认区持久警示（纯函数 helper + SFC 一行渲染）。

**Tech Stack:** pi-runtime（TypeBox / node:test / tsx）、apps/server（Nest / zod / vitest）、apps/web（Vue3 / vitest）、prompt-registry（6 处同步纪律 + `pnpm prompt:lint` 门禁）。

**Spec:** [docs/superpowers/specs/2026-10-13-sidebar-ref-bind-invariant-design.md](../specs/2026-10-13-sidebar-ref-bind-invariant-design.md)（RB-D2 / RB-D3 / RB-D2 对账文案 / RB-D6②；本计划只做 PR-A 批，RB-D4/D5/D7 属 PR-B/C）

**工作目录：** 全程在 worktree `/Users/4seven/workspace/pi-lnk/.worktrees/sidebar-ref-bind-pr-a`（分支 `fix/sidebar-ref-bind-invariant-pr-a`，已 off origin/master 757481b9）。**禁止在主仓 `/Users/4seven/workspace/pi-lnk` 提交**（主仓检出在别的分支）。

## Global Constraints

- L6 提示词预算硬上限 **3200 字符**（当前 3197，余量仅 3）：Task 4 改完必须 `pnpm prompt:lint` exit 0，超了按该任务给定的补偿裁剪执行。
- `vendor/` 目录禁止业务 patch（本批零 vendor 改动；消毒走工具定义自身的 `prepareArguments`）。
- 信号层（`result-signal*.ts`）本批**不改**——PR-B 才覆盖 throw 路径；成功静默 0 token 纪律不破坏。
- 工具常驻/延迟归属不变（`tiering.test.ts` 无需改动；`prepareArguments` 不影响 tier）。
- 提示词规则改一处要**同步 6 处**（AGENTS.md 变更影响面矩阵）：本批改 rule 4，涉及其中 4 处（.md / MANIFEST / fallback 常量 / assembler EXPECTED），COMPOSED_IDS 与 FALLBACK_BY_ID 因 id 不变而免改——见 Task 4。
- 每个任务独立提交，message 惯例 `fix(scope): 描述`；push 用 CVM SOCKS 隧道（直连 502）：
  `env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy git -c http.proxy=socks5h://127.0.0.1:18081 -c http.version=HTTP/1.1 push -u origin fix/sidebar-ref-bind-invariant-pr-a`
- 测试纪律：先写失败测试再实现；`grep -c` 0 命中返回非零，勿用 `|| echo` 伪装结果。

## Review Focus

规格隐含但任务测试未直接覆盖、最容易咬人的五类输入（每条已挂到所属任务的测试步骤）：

1. **老链路显式传合法实体**（模型从上下文回显完整 id/mediaType/label/url）——消毒不得误杀 → Task 1 Step 1 测试 2。
2. **省略 / 空数组 / 非数组 attachments**——SM-D4 与 M-1 回归必须逐字节不变 → Task 1 Step 1 测试 3 + Task 1 Step 4 跑既有全量用例。
3. **tc.attachments 实体缺 id 字段**（runtime `SidebarAttachment` 类型本就只有 url/text/mediaType，旧数据可能无 id）——对账文案须优雅降级不抛错 → Task 2 Step 1 测试 2。
4. **合法形状但超 5 个（SIDEBAR_ATTACHMENT_MAX）**——400 文案必须区分「超限」与「形状错」，不能让模型误判参数形状 → Task 3 Step 1 测试 3。
5. **历史会话消息无 executionTrace**（加载旧会话时 steps undefined）——警示计算不得抛错、不误报 → Task 5 Step 1 测试 3。

---

### Task 0: worktree 依赖借用（环境准备）

**Files:** 无代码改动（软链）。

**Interfaces:**
- Produces: 可运行的 `services/pi-runtime`（node:test+tsx）、`apps/server`（vitest）、`apps/web`（vitest）测试环境。

- [ ] **Step 1: 借用主仓依赖（若 `pnpm install` 未被沙箱拦则可跳过本步直接 install）**

```bash
MAIN=/Users/4seven/workspace/pi-lnk
WT=$MAIN/.worktrees/sidebar-ref-bind-pr-a
cd "$WT" && rm -rf node_modules
ln -s $MAIN/node_modules node_modules
for p in agent shared server web; do mkdir -p "packages/$p/node_modules" "apps/$p/node_modules" 2>/dev/null; done
# pi-runtime 是独立 service（非 pnpm workspace packages/*）
mkdir -p services/pi-runtime/node_modules
ln -s $MAIN/services/pi-runtime/node_modules/* services/pi-runtime/node_modules/ 2>/dev/null || true
# 若上方 glob 为空（主仓未装过 pi-runtime 依赖），直接软链整个：
[ -e services/pi-runtime/node_modules/tsx ] || ln -sfn $MAIN/services/pi-runtime/node_modules services/pi-runtime/node_modules
# 子包相对软链（指本 worktree，绝不能指主仓）：
mkdir -p apps/server/node_modules/@lnkpi apps/web/node_modules/@lnkpi
ln -sfn ../../../shared apps/server/node_modules/@lnkpi/shared
ln -sfn ../../../shared apps/web/node_modules/@lnkpi/shared
# 验证：读到的必须是 worktree 内文件
ls packages/shared/src/index.ts >/dev/null && readlink apps/server/node_modules/@lnkpi/shared | grep -q '\.\./' && echo OK
```

- [ ] **Step 2: 冒烟验证测试可跑**

```bash
cd "$WT/services/pi-runtime" && node --import tsx --test src/tools/canvas-write.test.ts 2>&1 | tail -3
```
Expected: 全部 pass（改动前基线）。

---

### Task 1: runtime prepareArguments 消毒伪造 attachments（RB-D2）

**Files:**
- Modify: `services/pi-runtime/src/tools/canvas-write.ts`（`apply_sidebar_attachments` 工具定义处，约 L447-470；helper 加在 `withWriteSignal` 之后）
- Test: `services/pi-runtime/src/tools/canvas-write.test.ts`

**Interfaces:**
- Consumes: vendor `AgentTool.prepareArguments?: (args: unknown) => Static<TParameters>`（vendor types.ts:2014，`harness/runtime/drive/tools.ts` 生产路径已核实调用顺序 prepare→validate）。
- Produces: `apply_sidebar_attachments` 携带 `prepareArguments`；伪造形态参数被整删除。Task 2 依赖「消毒后 execute 收到的 `p.attachments` 为 undefined」这一语义。

- [ ] **Step 1: 写失败测试**（追加到 `canvas-write.test.ts` 的 `describe("canvas-write: apply_sidebar_attachments", ...)` 块之后）

```ts
describe("canvas-write: apply_sidebar_attachments prepareArguments 消毒（RB-D2）", () => {
	function toolWithArgs() {
		const { client } = makeClient();
		return findTool(createCanvasWriteTools(client), "apply_sidebar_attachments");
	}

	it("事故形态（source/target_node_id 字段全虚构）→ 整参数删除，execute 回落 tc.attachments", () => {
		const out = toolWithArgs().prepareArguments?.({
			node_ids: ["n1"],
			mode: "localRefs",
			attachments: [{ source: "I1", target_node_id: "image-x" }],
		});
		assert.deepEqual(out, { node_ids: ["n1"], mode: "localRefs" });
	});

	it("合法实体（id/mediaType/label + url）原样透传——不误杀老链路显式传参", () => {
		const att = [{ id: "mv6f", mediaType: "image", sourceKind: "upload", label: "a.jpg", url: "https://x/a.png" }];
		const out = toolWithArgs().prepareArguments?.({ node_ids: ["n1"], attachments: att });
		assert.deepEqual(out, { node_ids: ["n1"], attachments: att });
	});

	it("省略 / 空数组 / 非数组 attachments 原样透传（SM-D4、M-1 回归零变化）", () => {
		const t = toolWithArgs();
		assert.deepEqual(t.prepareArguments?.({ node_ids: ["n1"] }), { node_ids: ["n1"] });
		assert.deepEqual(t.prepareArguments?.({ node_ids: ["n1"], attachments: [] }), { node_ids: ["n1"], attachments: [] });
		assert.deepEqual(t.prepareArguments?.({ node_ids: ["n1"], attachments: "I1" }), { node_ids: ["n1"], attachments: "I1" });
	});

	it("混合形态（部分合法部分伪造）→ 整参数删除（确定性，不做逐项过滤）", () => {
		const out = toolWithArgs().prepareArguments?.({
			node_ids: ["n1"],
			attachments: [
				{ id: "a", mediaType: "image", sourceKind: "upload", label: "a.jpg", url: "https://x/a.png" },
				{ source: "I2", target_node_id: "n1" },
			],
		});
		assert.deepEqual(out, { node_ids: ["n1"] });
	});

	it("url 为 blob: 但形状合法 → 不消毒（形状判断与内容治理分离，blob 拒绝仍归 Nest）", () => {
		const att = [{ id: "b", mediaType: "image", sourceKind: "upload", label: "b.jpg", url: "blob:x" }];
		const out = toolWithArgs().prepareArguments?.({ node_ids: ["n1"], attachments: att });
		assert.deepEqual(out, { node_ids: ["n1"], attachments: att });
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd services/pi-runtime && node --import tsx --test src/tools/canvas-write.test.ts 2>&1 | grep -E '消毒|pass|fail' | tail -5
```
Expected: 新 describe 的用例 FAIL（`prepareArguments` 未定义 → `undefined` 不等于期望对象）。

- [ ] **Step 3: 最小实现**（canvas-write.ts：helper 加在 `withWriteSignal` 函数定义之后；工具对象 `name: "apply_sidebar_attachments"` 的字段区加一行）

```ts
/**
 * RB-D2（spec 2026-10-13-sidebar-ref-bind-invariant-design.md）：引用不是值。
 * 事故 cmv6f48s20041p401qm0hxfkh：模型伪造 attachments（{source,target_node_id}）穿透空对象
 * schema 后被 Nest Zod 拒成 500。消毒判据复用 packages/shared SidebarAttachmentSchema 的
 * 必填形状（id/mediaType/label 非空 + url|text 至一非空）；任一项不符 ⇒ 整参数删除，
 * execute 既有回落 `p.attachments?.length ? p.attachments : tc.attachments` 自然命中
 * tc.attachments（SM-D4 路径），execute 逻辑零改动。
 * 全有或全无：混合形态整删——逐项过滤会产出「部分模型编造+部分真实」的杂交数组，不可对账。
 */
function looksLikeSidebarEntity(x: unknown): boolean {
	if (typeof x !== "object" || x === null) return false;
	const a = x as Record<string, unknown>;
	const hasUrl = typeof a.url === "string" && a.url.trim().length > 0;
	const hasText = typeof a.text === "string" && a.text.trim().length > 0;
	return (
		typeof a.id === "string" &&
		a.id.length > 0 &&
		typeof a.mediaType === "string" &&
		a.mediaType.length > 0 &&
		typeof a.label === "string" &&
		a.label.length > 0 &&
		(hasUrl || hasText)
	);
}

function sanitizeSidebarAttachmentsArg(args: unknown): unknown {
	if (typeof args !== "object" || args === null) return args;
	const a = args as Record<string, unknown>;
	if (!Array.isArray(a.attachments) || a.attachments.length === 0) return args;
	if (a.attachments.every(looksLikeSidebarEntity)) return args;
	const { attachments: _fabricated, ...rest } = a;
	return rest;
}
```

工具定义（`name: "apply_sidebar_attachments"` 对象内、`parameters:` 之前）加：

```ts
			prepareArguments: sanitizeSidebarAttachmentsArg,
```

- [ ] **Step 4: 跑全文件测试确认全绿（含既有 SM-D4/M-1/短路用例零回归）**

```bash
cd services/pi-runtime && node --import tsx --test src/tools/canvas-write.test.ts 2>&1 | tail -3
```
Expected: 全部 pass。

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/tools/canvas-write.ts services/pi-runtime/src/tools/canvas-write.test.ts
git commit -m "fix(pi-runtime): apply_sidebar_attachments 消毒伪造 attachments（RB-D2，vendor prepareArguments 首次启用）"
```

---

### Task 2: 平台填充对账文案（RB-D2 后半）

**Files:**
- Modify: `services/pi-runtime/src/tools/canvas-write.ts`（`apply_sidebar_attachments` execute 尾部）
- Test: `services/pi-runtime/src/tools/canvas-write.test.ts`

**Interfaces:**
- Consumes: Task 1 语义（消毒后 `p.attachments` 为 undefined）；`withWriteSignal` 返回 `{ content, details }`（`resultWithActions` content 为单元素 text 块）。
- Produces: 平台填充路径的结果 content 尾部多一个 text 块（对账行）；显式传实体路径 content 不变。

- [ ] **Step 1: 写失败测试**（追加进 Task 1 的 describe 之后）

```ts
describe("canvas-write: apply_sidebar_attachments 平台填充对账文案（RB-D2）", () => {
	it("省略 attachments（平台填充）→ content 尾部追加来源说明行", async () => {
		const { client } = makeClient();
		const tools = createCanvasWriteTools(client);
		const res = await run(findTool(tools, "apply_sidebar_attachments"), { node_ids: ["n1"] });
		const blocks = res.content as Array<{ type: string; text: string }>;
		assert.equal(blocks[0].type, "text");
		const note = blocks.find((b) => b.text.includes("本轮侧栏附件"));
		assert.ok(note, "missing reconciliation note");
		assert.ok(note.text.includes("平台填充"));
	});

	it("tc.attachments 实体缺 id（旧数据形态）→ 文案优雅降级不抛错", async () => {
		const { client } = makeClient();
		const tools = createCanvasWriteTools(client);
		const ctx: LnkpiToolContext = { sessionId: "s1", userId: "u1", attachments: [{ url: "https://x/a.png", mediaType: "image" }] };
		const res = await run(findTool(tools, "apply_sidebar_attachments"), { node_ids: ["n1"] }, ctx);
		const blocks = res.content as Array<{ type: string; text: string }>;
		assert.ok(blocks.some((b) => b.text.includes("平台填充")));
	});

	it("显式传合法实体 → 不追加对账行（老链路 content 形态不变）", async () => {
		const { client } = makeClient();
		const tools = createCanvasWriteTools(client);
		const res = await run(findTool(tools, "apply_sidebar_attachments"), {
			node_ids: ["n1"],
			attachments: [{ id: "a", mediaType: "image", sourceKind: "upload", label: "a.jpg", url: "https://x/a.png" }],
		});
		const blocks = res.content as Array<{ type: string; text: string }>;
		assert.equal(blocks.length, 1);
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd services/pi-runtime && node --import tsx --test src/tools/canvas-write.test.ts 2>&1 | grep -E '对账|pass|fail' | tail -4
```
Expected: 新用例 FAIL（无对账行）。

- [ ] **Step 3: 最小实现**（execute 内，`return withWriteSignal(...)` 处替换）

```ts
				const usedPlatformFill = !p.attachments?.length;
				const result = withWriteSignal(
					await client.post("/agent/internal/apply-sidebar-attachments", body),
					p.node_ids.length,
				);
				// RB-D2 对账：平台填充路径必须声明实际挂载来源（省略参数与消毒删除都落到本分支）。
				if (usedPlatformFill) {
					const ids = (tc.attachments ?? [])
						.map((a) => (typeof (a as { id?: unknown }).id === "string" ? (a as { id: string }).id : ""))
						.filter(Boolean)
						.join(", ");
					const note = `📎 参考图来源：本轮侧栏附件${ids ? `（${ids}）` : ""}，由平台填充并挂载。`;
					const content: Array<{ type: "text"; text: string }> = [...result.content, { type: "text", text: note }];
					return { ...result, content } as typeof result;
				}
				return result;
```

- [ ] **Step 4: 跑全文件测试确认全绿**

```bash
cd services/pi-runtime && node --import tsx --test src/tools/canvas-write.test.ts 2>&1 | tail -3
```
Expected: 全部 pass（Task 1 + Task 2 + 既有用例）。

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/tools/canvas-write.ts services/pi-runtime/src/tools/canvas-write.test.ts
git commit -m "fix(pi-runtime): apply_sidebar_attachments 平台填充路径追加对账文案（RB-D2）"
```

---

### Task 3: Nest 校验失败转 400 可行动错误（RB-D3）

**Files:**
- Modify: `apps/server/src/agent/agent-canvas-tools.service.ts:1563`（`applySidebarAttachments` 内 `validateSidebarAttachments(input.attachments)` 调用点；文件头 import 区加 `ZodError`）
- Test: `apps/server/src/agent/agent-canvas-tools.sidebar.test.ts`

**Interfaces:**
- Consumes: `validateSidebarAttachments`（packages/shared，ZodError 或普通 Error）、`BadRequestException`（文件已 import）。
- Produces: HTTP 400 + message 含缺失字段清单与正确用法。runtime `NestToolError` 的 errorKind 随之从 5xx 族变 4xx 族（nest-client 既有 status 分类，无需改动）。

- [ ] **Step 1: 写失败测试**（追加到 `agent-canvas-tools.sidebar.test.ts` 的 describe 内；复用既有 beforeEach 的 module 装配）

```ts
  it('伪造 attachments（事故形态）→ BadRequestException 400，message 含字段细节与正确用法（RB-D3，不再 500）', async () => {
    await expect(
      svc.applySidebarAttachments({
        sessionId: 's1',
        nodeIds: ['n1'],
        attachments: [{ source: 'I1', target_node_id: 'image-x' } as never],
        mode: 'localRefs',
      }),
    ).rejects.toThrow(BadRequestException)

    await expect(
      svc.applySidebarAttachments({
        sessionId: 's1',
        nodeIds: ['n1'],
        attachments: [{ source: 'I1', target_node_id: 'image-x' } as never],
        mode: 'localRefs',
      }),
    ).rejects.toThrow(/attachments 校验失败/)
    await expect(
      svc.applySidebarAttachments({
        sessionId: 's1',
        nodeIds: ['n1'],
        attachments: [{ source: 'I1', target_node_id: 'image-x' } as never],
        mode: 'localRefs',
      }),
    ).rejects.toThrow(/省略 attachments/)
  })

  it('合法形状但超 5 个 → BadRequest，文案含「最多添加」，与形状错可区分', async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      id: `a${i}`, mediaType: 'image' as const, sourceKind: 'upload' as const, label: `a${i}.jpg`, url: `https://x/${i}.png`,
    }))
    await expect(
      svc.applySidebarAttachments({ sessionId: 's1', nodeIds: ['n1'], attachments: six, mode: 'localRefs' }),
    ).rejects.toThrow(/最多添加 5 个/)
  })
```

（文件头补 `import { BadRequestException } from '@nestjs/common'`——若尚未 import。）

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/server && ./node_modules/vitest/vitest.mjs run src/agent/agent-canvas-tools.sidebar.test.ts 2>&1 | tail -5
```
Expected: 新用例 FAIL（ZodError 未转，`rejects.toThrow(BadRequestException)` 不匹配）。

- [ ] **Step 3: 最小实现**

文件头 import 区加：

```ts
import { ZodError } from 'zod'
```

`applySidebarAttachments` 内（现 1563 行）替换：

```ts
    validateSidebarAttachments(input.attachments)
```

为：

```ts
    // RB-D3（spec 2026-10-13-sidebar-ref-bind-invariant-design.md）：失败必须可行动。
    // 事故实证：ZodError 未转 HttpException → 500，字段级细节全丢，模型丧失自愈能力。
    // 就地转 400（与同文件 BadRequestException('创建媒体节点失败') 同风格，不引全局 filter）。
    try {
      validateSidebarAttachments(input.attachments)
    } catch (e) {
      const detail =
        e instanceof ZodError
          ? e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
          : (e as Error).message
      throw new BadRequestException(
        `attachments 校验失败（${detail}）。正确用法：省略 attachments 参数，由平台自动填充本轮侧栏附件（只传 nodeIds 与 mentionedKeys）。`,
      )
    }
```

- [ ] **Step 4: 跑测试确认全绿**

```bash
cd apps/server && ./node_modules/vitest/vitest.mjs run src/agent/agent-canvas-tools.sidebar.test.ts 2>&1 | tail -3
```
Expected: 全部 pass（含既有用例）。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/agent-canvas-tools.service.ts apps/server/src/agent/agent-canvas-tools.sidebar.test.ts
git commit -m "fix(server): apply-sidebar-attachments ZodError 转 400 可行动错误（RB-D3）"
```

---

### Task 4: 提示词规则 4 收紧（6 处同步纪律，4 处落地）

**Files:**
- Modify: `prompt-registry/rules/media_tool_policy.md`（正文 rule 4 + frontmatter `version: 1.5.0` → `1.6.0`）
- Modify: `prompt-registry/MANIFEST.yaml`（media_tool_policy 条目 version + contentHash）
- Modify: `apps/server/src/agent/pi-runtime/prompt-registry.fallback.ts:43`（`WRITE_TOOLS_RULES` 内 rule 4 段）
- Modify: `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.test.ts`（EXPECTED 硬编码串同步——先 `grep -n '挂参分工'` 定位）
- 免改：`prompt-registry.loader.ts` 的 `COMPOSED_IDS` / `FALLBACK_BY_ID`（id 不变）
- Test: `pnpm prompt:lint`（根目录，独立流水线 prompt-lint.yml）

**Interfaces:**
- Produces: 磁盘 .md == 内嵌常量逐字符相等（renderStatic == renderStaticFallback）；L6 ≤ 3200。

- [ ] **Step 1: 改 .md 正文 rule 4**（整行替换为下文；同时 frontmatter version → 1.6.0）

新 rule 4 全文（相对原文四处变化：①「I1/I2 芯片序」→「芯片序」；②「然后」→「再」；③「此路径不 connect_nodes、不 attach_refs」→「此路径不连画布节点」；④「只用 apply_sidebar_attachments」后追加「（attachments 一律省略，由平台填充本轮附件）」；⑤「禁止 attach_refs 吃芯片 key、connect_nodes 连芯片」→「禁止 attach_refs 吃芯片 key 或连芯片」。净变化约为 **-15 字符**，落在预算内）：

```
4. 用户要创建媒体节点或明确「生成一张…」时：upsert_media_node 建节点（可带 prompt），按需 set_node_text 填参、connect_nodes 连线，再 propose_generation 等用户确认；不要假装已出图。侧栏参考图出结果图：upsert_media_node 新建图节点（明确改某个 image-* 除外），再 apply_sidebar_attachments（mode=localRefs，mentioned_keys 用芯片序），必要时 set_node_text，再 propose_generation；此路径不连画布节点。挂参分工：侧栏 @I*/I1 只用 apply_sidebar_attachments（attachments 一律省略，由平台填充本轮附件）；画布已有 image-*/video-* 才用 attach_refs 或 connect_nodes。禁止 attach_refs 吃芯片 key 或连芯片。闲聊/谢谢/纯识图问句/「重新生成一张」即使工具可见也不得 upsert_media_node、propose_generation。一致性写在提示词与 ref 顺序（先身份后衣服/产品），不要搭工作流。
```

- [ ] **Step 2: 同步 fallback 常量**——`prompt-registry.fallback.ts` `WRITE_TOOLS_RULES` 的 rule 4 段做**逐字符相同**的替换（`pnpm prompt:lint` 的 L7 校验磁盘==常量，此步漏掉必红）。

- [ ] **Step 3: 同步 assembler EXPECTED**——`grep -n '挂参分工' apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.test.ts` 定位 EXPECTED 硬编码串，做相同替换。

- [ ] **Step 4: 重算 contentHash 并更新 MANIFEST**

```bash
node -e "
const c = require('crypto'); const fs = require('fs');
const raw = fs.readFileSync('prompt-registry/rules/media_tool_policy.md', 'utf8');
const parts = raw.split(/^---\$\n?/m);
const body = parts.slice(2).join('---').trimEnd();
console.log(c.createHash('sha256').update(body).digest('hex').slice(0, 12));
"
```
把输出的 hash 写入 `prompt-registry/MANIFEST.yaml` media_tool_policy 条目（`contentHash:` 字段），`version:` 同步为 `1.6.0`。

- [ ] **Step 5: 跑门禁（预算 + 一致性双闸）**

```bash
pnpm prompt:lint 2>&1 | tail -8
```
Expected: exit 0；L6 实测值 ≤ 3200（预计 ~3182）。若超预算：优先把「（attachments 一律省略，由平台填充本轮附件）」缩为「（attachments 省略，平台填充）」（再省 ~8 字符）后重跑。

- [ ] **Step 6: Commit**

```bash
git add prompt-registry/rules/media_tool_policy.md prompt-registry/MANIFEST.yaml apps/server/src/agent/pi-runtime/prompt-registry.fallback.ts apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.test.ts
git commit -m "fix(prompt-registry): media_tool_policy 规则 4 收紧——attachments 一律省略由平台填充（RB-D1/S0-3，v1.6.0）"
```

---

### Task 5: 前端失败步骤持久警示（RB-D6②）

**Files:**
- Modify: `apps/web/src/components/agent/executionTraceReducer.ts`（文件尾导出纯函数）
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（import + computed + proposeWait 模板块内加一行）
- Test: `apps/web/src/components/agent/executionTraceReducer.test.ts`

**Interfaces:**
- Consumes: trace step 形态 `{ status?: string }`（reducer 既有 `status: 'failed'`）。
- Produces: `hasFailedTraceStep(steps)` 纯函数；SFC computed `turnHasFailedStep`。Task 无跨任务接口。

- [ ] **Step 1: 写失败测试**（追加到 `executionTraceReducer.test.ts`）

```ts
describe('hasFailedTraceStep（RB-D6② 持久警示判定）', () => {
  it('存在 failed 步骤 → true', () => {
    expect(hasFailedTraceStep([{ status: 'done' }, { status: 'failed' }])).toBe(true)
  })
  it('全部 done / 空数组 → false', () => {
    expect(hasFailedTraceStep([{ status: 'done' }])).toBe(false)
    expect(hasFailedTraceStep([])).toBe(false)
  })
  it('undefined（历史会话无 trace）→ false 不抛错（Review Focus 5）', () => {
    expect(hasFailedTraceStep(undefined)).toBe(false)
  })
})
```

（文件头 import 区补 `hasFailedTraceStep`。）

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && ./node_modules/vitest/vitest.mjs run src/components/agent/executionTraceReducer.test.ts 2>&1 | tail -4
```
Expected: FAIL（`hasFailedTraceStep` 未导出）。

- [ ] **Step 3: 最小实现**（`executionTraceReducer.ts` 文件尾）

```ts
/** RB-D6②（spec 2026-10-13-sidebar-ref-bind-invariant-design.md）：本轮 trace 是否存在 failed 步骤。 */
export function hasFailedTraceStep(steps: { status?: string }[] | undefined): boolean {
  return (steps ?? []).some((s) => s.status === 'failed')
}
```

- [ ] **Step 4: SFC 接线**（AgentSideRail.vue 三处）

① import 区加：
```ts
import { hasFailedTraceStep } from '@/components/agent/executionTraceReducer'
```

② `proposeWait` computed 附近加：
```ts
// RB-D6②：本轮存在 failed 步骤 ⇒ dock 确认区持久警示（把红色 ✗ 与确认决策连起来）。
const turnHasFailedStep = computed(() => hasFailedTraceStep(lastAssistantMessage.value?.executionTrace?.steps))
```

③ 模板中定位 `proposeWait` 的确认卡片块（`grep -n 'proposeWait' AgentSideRail.vue` 找 template 节点），在该块内第一行前插入：

```html
        <p v-if="turnHasFailedStep" data-testid="failed-step-warning" class="mb-1 text-[11px] leading-4" :style="{ color: 'var(--neo-text-muted)' }">
          ⚠️ 本轮有执行失败的步骤（如参考图挂载），确认生成前请检查执行记录。
        </p>
```

- [ ] **Step 5: 跑测试 + design-token 守卫确认全绿**

```bash
cd apps/web && ./node_modules/vitest/vitest.mjs run src/components/agent/executionTraceReducer.test.ts src/styles/design-token.test.ts 2>&1 | tail -4
```
Expected: 全部 pass（新样式只用既有 token 变量，不引 hex/rgba）。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/agent/executionTraceReducer.ts apps/web/src/components/agent/executionTraceReducer.test.ts apps/web/src/components/agent/AgentSideRail.vue
git commit -m "fix(web): dock 确认区持久警示本轮 failed 步骤（RB-D6②）"
```

---

### Task 6: 全量回归 + push + PR

**Files:** 无新改动（验证批）。

- [ ] **Step 1: typecheck 三包**

```bash
cd services/pi-runtime && ./node_modules/.bin/tsc --noEmit 2>&1 | tail -2
cd ../../apps/server && ./node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1 | tail -2
cd ../../apps/web && ./node_modules/.bin/vue-tsc --noEmit 2>&1 | tail -2 || ./node_modules/.bin/tsc --noEmit 2>&1 | tail -2
```
Expected: 三包零错误。（⚠️ 本机 4 核：顺序执行，勿并行两个 tsc。）

- [ ] **Step 2: 关键测试面全量回归**

```bash
cd services/pi-runtime && node --import tsx --test src/tools/canvas-write.test.ts src/tools/canvas-write.video-contract-desc.test.ts src/tools/tiering.test.ts 2>&1 | tail -3
cd ../../apps/server && ./node_modules/vitest/vitest.mjs run src/agent/agent-canvas-tools.sidebar.test.ts src/agent/pi-runtime/prompt-registry.loader.test.ts 2>&1 | tail -3
```
Expected: 全绿（tiering 归属不回归、loader L7 磁盘==常量）。

- [ ] **Step 3: git status 自检（本地绿≠CI 绿：工作区必须干净才 push）**

```bash
git status --short | grep -v '^??' ; echo "exit=$?"
```
Expected: 无已跟踪文件改动残留（untracked 的 .workbuddy/ 等本地数据属正常）。

- [ ] **Step 4: push + 开 PR**

```bash
git -c http.proxy=socks5h://127.0.0.1:18081 -c http.version=HTTP/1.1 push -u origin fix/sidebar-ref-bind-invariant-pr-a
export PATH="/usr/local/bin:$PATH"
gh pr create --title "fix(agent): 侧栏参考图绑定止血批（RB-D2 消毒 / RB-D3 400 化 / 对账文案 / dock 持久警示）" --body-file - <<'EOF'
## 概要
规格 docs/superpowers/specs/2026-10-13-sidebar-ref-bind-invariant-design.md（PR #400）的 PR-A 止血批，四个 commit：
- RB-D2：vendor prepareArguments 消毒伪造 attachments（事故形态 {source,target_node_id} 整参数删除 → execute 回落 tc.attachments）+ 平台填充对账文案
- RB-D3：Nest apply-sidebar-attachments ZodError → 400 BadRequest（字段细节 + 正确用法），不再 500
- S0-3：media_tool_policy 规则 4 收紧（v1.6.0，6 处同步纪律 + prompt:lint 预算门禁）
- RB-D6②：dock 确认区持久警示本轮 failed 步骤

关联事故复盘：docs/analysis/2026-10-13-sidebar-ref-bind-failure-postmortem.md
EOF
```

- [ ] **Step 5: 盯 CI 全绿（`gh pr checks <n> --watch`）**，第一件事读 `mergeStateStatus`（应 MERGEABLE，BLOCKED=等 CI 属正常）。**合并与生产验证转 `prod-deploy-verify` skill**——验收判据用规格 §4：重放 G1（上传图 + 事故原句无 @）⇒ dock 参考图条可见 或（失败时）模型收到含字段细节的 400 文案并能自愈。
