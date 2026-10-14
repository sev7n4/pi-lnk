# 侧栏参考图绑定 PR-C（门禁批）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RB-D5 前置不过不出图（propose_generation fail-closed 门禁：本轮有侧栏图且节点 localRefs 空 ⇒ 不做状态转移，返回 `missing_refs` 可行动文案）+ RB-D6① dock 直生二次确认（节点无 refs 且本轮侧栏有图 ⇒ 点生成先弹确认）。

**Architecture:** 门禁 SSOT 在 Nest（proposeGeneration 返回体增 union 分支 `{confirmed:false, reason:'missing_refs', message}`，不做状态转移）；runtime `propose_generation` 调用体新增 `sidebarImageCount`（本轮 `tc.attachments` 中 `mediaType==="image"` 计数）并在响应中识别 `missing_refs` 短路（不进阻塞等待，镜像同工具既有 not-confirmed 结果形状）。前端为纯提示层：纯函数判定 + CanvasPage `handleNodeGenerate` 内 `ElMessageBox.confirm`，不改 useNodeGeneration。

**Tech Stack:** apps/server（Nest / class-validator / vitest）、services/pi-runtime（node:test / tsx）、apps/web（Vue / element-plus / vitest）。

**Spec:** `docs/superpowers/specs/2026-10-13-sidebar-ref-bind-invariant-design.md`（RB-D5 / RB-D6①；硬表第 5 行；金标 G3）。PR-A（#402）/PR-B（#403）已上线；RB-D6② 持久警示已随 PR-A 落地，本批只做 ①。

**工作目录：** 全程在 worktree `/Users/4seven/workspace/pi-lnk/.worktrees/prc-gate`（分支 `feat/sidebar-ref-bind-prc`，off master e02b5fc9）。**禁止在主仓提交**（主仓工作区在别人的分支 feat/agent-turn-timeline-p0 上，有未提交改动）。

## Ruling（计划评审时已裁决）

1. **runtime 短路返回形状镜像同工具既有 `!outcome.confirmed` 分支**（`{ok:false, confirmed:false, reason, message}` + `details._signal{status:"failed", retryable:false, errorCode:"missing_refs"}`），不用规格措辞的 `withWriteSignal(..., 0)` 字面——同一工具同一失败族契约一致优先；`withWriteSignal` 会把 content 包成 `{ok:true, data}`（模型可见 ok:true 与 fail-closed 语义矛盾）。信号等价（failed / 不可重试 / errorCode 可判），`actions` 缺省（无状态转移 ⇒ 无 CanvasAction，与 not-confirmed 分支一致）。
2. **Nest 门禁限 image/video 节点**。规格硬表三断言（count>0+localRefs空⇒missing_refs / localRefs非空⇒放行 / count=0⇒放行）逐字保留；audio/text/prompt 节点不消费参考图，对其门禁是纯误伤面且可行动出口（apply_sidebar_attachments 绑定）对它们语义不成立。规格未写节点类型限定是疏漏，本裁决收窄而非推翻。
3. **前端「本轮会话有侧栏图」= agent store `messages` 中最近一条 user 消息的 `attachments` 里 `mediaType==="image"` 计数 >0**——与 runtime `tc.attachments` 的「本轮」语义对齐（RB-D5 门禁同源）。侧栏芯片跨轮持久但「本轮」语义不跨轮；这是规格明确的误伤出口（`sidebarImageCount===0` 不触发）。
4. **前端 ref 判定用 `resolveNodeRefs` 全量解析**（localRefs + 上游 edges + refOrder，过滤 stale），非仅 localRefs——前端是提示层，宽判定避免「refs 经画布连线已存在」时误弹；Nest 门禁是 SSOT，仍按规格只看 `data.localRefs`（SM-D7 显式绑定 SSOT）。
5. **`handleAgentGenerateNode`（propose 确认路径）不加二次确认**——那是 propose 流程的确认动作本身（runtime 阻塞等待的 answered 臂），不是 dock 直生；加弹窗会双重打断。
6. **`sidebarImageCount` 始终随 body 上行（含 0）**，Nest DTO `@IsOptional() @IsInt() @Min(0)` 且只认 `>0`；旧 runtime 不发字段 ⇒ 门禁天然关闭（部署窗口期向后兼容，web 先行/后行均可）。

## Global Constraints

- **禁止跨包运行时依赖**：pi-runtime 不 import `@lnkpi/shared`（计数逻辑本地实现，3 行）。
- `vendor/` 零改动；提示词零改动（本批无 prompt-registry 同步面，勿跑 prompt:lint 之外的写入）。
- B-5 回退纪律：`sidebarImageCount===0`（或字段缺省）路径旧行为逐字节保留——含阻塞确认双臂 race、非阻塞 `withWriteSignal(base, 1)`。门禁短路对两种模式（阻塞/非阻塞）都生效，位置在 `base` 取回之后、`!registry || !askUserBlocking()` 分支之前。
- P2 结算归因纪律：短路也是一次 propose 结算，必须 `onProposeOutcome?.("missing_refs", false)`，否则 outcome 分布分母失真。
- 每任务独立提交，`feat(scope): 描述`；push 备用双路：harness 代理直连（本会话已实证）或 SOCKS 隧道（`env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy git -c http.proxy=socks5h://127.0.0.1:18081 -c http.version=HTTP/1.1 push ...`）。
- 测试纪律：先写失败测试再实现；4 核机勿并行两个 tsc；沙箱 shell grep/ls 被劫持 ⇒ 内容检索用 Grep 工具。

## Review Focus（规格隐含、最易咬人的五类输入）

1. **text/prompt/audio 节点 propose**（本轮有侧栏图、节点无 refs）→ 门禁不触发、前端确认不弹（Ruling 2/纯函数 nodeType 判定，Task 1 测试 4 / Task 3 测试 2）。
2. **旧 runtime / 未带 sidebarImageCount 的调用**（部署窗口期）→ DTO 可选、门禁关闭、旧行为逐字节（Task 1 测试 3）。
3. **refs 经画布连线（edges 上游）存在但 localRefs 空** → Nest 门禁按规格仍拦截（localRefs 是 SSOT，规格硬表措辞）；前端不弹确认（宽判定）——两层判定刻意不对称，评审时勿「顺手对齐」。
4. **tc.attachments 含 text/video 附件但无 image** → 计数只算 `mediaType==="image"`，body `sidebarImageCount:0`，门禁关（Task 2 测试 3）。
5. **Nest 正常放行响应**（无 `confirmed:false` 字段，含 `status:'pending_confirm'`）→ runtime 短路判定不得误伤：判定键是 `confirmed === false && reason === "missing_refs"` 严格双条件，`confirmed` 缺省（undefined）不放行短路（Task 2 测试 4 + 现有阻塞确认测试全绿即回归）。

---

### Task 0: worktree 依赖借用（环境准备，控制器执行）

- [x] 软链纪律（PR-A 修正版）：`apps/server/node_modules` 与 `apps/web/node_modules` 逐项软链主仓同路径（含 `.bin`）；`@lnkpi/shared`、`@lnkpi/agent` 指向**本 worktree** `packages/*`（绝对路径，勿相对上跳）；`services/pi-runtime/node_modules` 逐项软链主仓。
- [x] 冒烟：`services/pi-runtime` node:test 可跑（canvas-write.test.ts 59 绿）；`apps/server` vitest 可跑（agent-canvas-tools.service.test.ts 113 绿）。

---

### Task 1: Nest 门禁 RB-D5（DTO + proposeGeneration fail-closed）

**Files:**
- Modify: `apps/server/src/agent/agent-canvas-tools.controller.ts`（ProposeGenerationDto，约 :65）
- Modify: `apps/server/src/agent/agent-canvas-tools.service.ts`（proposeGeneration，约 :1097-1166）
- Test: `apps/server/src/agent/agent-canvas-tools.service.test.ts`（describe 'Phase 2b upsertMediaNode + proposeGeneration'，约 :2524）

**Interfaces:**
- Consumes: 节点 `data.localRefs`（`LocalRefBinding[]`，applySidebarAttachments 写入，SSOT）。
- Produces: `proposeGeneration(input)` 入参增 `sidebarImageCount?: number`；返回类型增 union 分支 `{ confirmed: false; reason: 'missing_refs'; message: string }`。runtime（Task 2）与 controller（透传 DTO）消费此形状。

- [ ] **Step 1: 写失败测试**（追加进 describe 'Phase 2b upsertMediaNode + proposeGeneration'）

```ts
it('RB-D5 门禁：sidebarImageCount>0 且 localRefs 空 → missing_refs，不做状态转移', async () => {
  canvas = {
    nodes: [
      {
        id: 'img-1',
        type: 'image',
        position: { x: 0, y: 0 },
        data: { title: '产品主图', prompt: '蓝色天空产品主图', status: 'draft', imageModel: 'platform::user-default-image' },
      },
    ],
    edges: [],
  }
  const orchStart = vi.spyOn(
    (svc as unknown as { videoOrchestrator: { start: (...args: unknown[]) => unknown } }).videoOrchestrator,
    'start',
  )

  const result = await svc.proposeGeneration({
    sessionId: 's1',
    userId: 'u1',
    nodeId: 'img-1',
    sidebarImageCount: 2,
  })

  expect(result).toMatchObject({ confirmed: false, reason: 'missing_refs' })
  expect((result as { message?: string }).message).toContain('apply_sidebar_attachments')
  // 不做状态转移：节点停 draft、无会话持久化写、零生成调用
  expect(canvas.nodes[0].data.status).toBe('draft')
  expect(sessionUpdate).not.toHaveBeenCalled()
  expect(generateImage).not.toHaveBeenCalled()
  expect(generateVideo).not.toHaveBeenCalled()
  expect(orchStart).not.toHaveBeenCalled()
})

it('RB-D5 放行：localRefs 非空 → pending_confirm（正常状态转移）', async () => {
  canvas = {
    nodes: [
      {
        id: 'img-1',
        type: 'image',
        position: { x: 0, y: 0 },
        data: {
          title: '产品主图',
          prompt: '蓝色天空产品主图',
          status: 'draft',
          imageModel: 'platform::user-default-image',
          localRefs: [{ id: 'a1', mediaType: 'image', sourceKind: 'upload', label: 'a.png', url: 'https://x/a.png' }],
        },
      },
    ],
    edges: [],
  }
  const result = await svc.proposeGeneration({
    sessionId: 's1',
    userId: 'u1',
    nodeId: 'img-1',
    sidebarImageCount: 1,
  })
  expect(result.nodeId).toBe('img-1')
  expect(result.status).toBe('pending_confirm')
  expect(canvas.nodes[0].data.status).toBe('pending_confirm')
})

it('RB-D5 出口：sidebarImageCount=0 与字段缺省 → 旧行为逐字节（pending_confirm）', async () => {
  canvas = {
    nodes: [
      {
        id: 'img-1',
        type: 'image',
        position: { x: 0, y: 0 },
        data: { title: '产品主图', prompt: '蓝色天空产品主图', status: 'draft' },
      },
    ],
    edges: [],
  }
  const withZero = await svc.proposeGeneration({
    sessionId: 's1',
    userId: 'u1',
    nodeId: 'img-1',
    sidebarImageCount: 0,
  })
  expect(withZero.status).toBe('pending_confirm')

  canvas.nodes[0].data.status = 'draft'
  const withoutField = await svc.proposeGeneration({ sessionId: 's1', userId: 'u1', nodeId: 'img-1' })
  expect(withoutField.status).toBe('pending_confirm')
})

it('RB-D5 限界（Ruling 2）：text 节点不受门禁', async () => {
  canvas = {
    nodes: [
      { id: 'text-1', type: 'text', position: { x: 0, y: 0 }, data: { title: 't', prompt: 'p', status: 'draft' } },
    ],
    edges: [],
  }
  const result = await svc.proposeGeneration({
    sessionId: 's1',
    userId: 'u1',
    nodeId: 'text-1',
    sidebarImageCount: 3,
  })
  expect(result.status).toBe('pending_confirm')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/4seven/workspace/pi-lnk/.worktrees/prc-gate/apps/server && ./node_modules/.bin/vitest run src/agent/agent-canvas-tools.service.test.ts`
Expected: 新增 4 用例 FAIL（门禁用例拿到 pending_confirm 而非 missing_refs；限界用例可能因 TS 类型报错——入参尚无 sidebarImageCount）。

- [ ] **Step 3: 实现**

DTO（controller.ts :65 class ProposeGenerationDto 追加字段；class-validator import 增 `IsInt, Min`，`IsOptional` 已有）：

```ts
class ProposeGenerationDto {
  @IsString()
  sessionId!: string

  @IsString()
  userId!: string

  @IsString()
  nodeId!: string

  /**
   * RB-D5（spec 2026-10-13-sidebar-ref-bind-invariant-design.md）：本轮侧栏图片附件计数
   * （runtime tc.attachments 中 mediaType==='image'）。旧 runtime 不发 ⇒ undefined 门禁关
   * （部署窗口期向后兼容，Ruling 6）。
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  sidebarImageCount?: number
}
```

Service（proposeGeneration 签名与门禁；插在 prompt 校验之后、summary 组装之前）：

```ts
  async proposeGeneration(input: {
    sessionId: string
    userId: string
    nodeId: string
    /** RB-D5：本轮侧栏图片附件计数；缺省/0 ⇒ 门禁关（Ruling 6）。 */
    sidebarImageCount?: number
  }): Promise<
    | {
        nodeId: string
        status: 'pending_confirm'
        summary: { /* 原 summary 类型逐字保留，此处省略号仅为计划排版 */ }
        actions: CanvasAction[]
      }
    | { confirmed: false; reason: 'missing_refs'; message: string }
  > {
```

（⚠️ 实现时 summary 子类型必须从原声明**逐字复制**，不可真写省略号。）

```ts
    // RB-D5 前置不过不出图（fail-closed）：本轮有侧栏图但目标节点 localRefs 为空 ⇒
    // 不做状态转移，返回可行动失败。门禁限 image/video 节点（Ruling 2）；localRefs 是
    // SM-D7 显式绑定 SSOT，只看它（规格硬表措辞），edges 上游 refs 不豁免（Review Focus 3）。
    if (
      (node.type === 'image' || node.type === 'video') &&
      typeof input.sidebarImageCount === 'number' &&
      input.sidebarImageCount > 0
    ) {
      const localRefs = (node.data?.localRefs as LocalRefBinding[] | undefined) ?? []
      if (localRefs.length === 0) {
        return {
          confirmed: false,
          reason: 'missing_refs',
          message:
            '参考图未绑定成功，请重试 apply_sidebar_attachments（只传 node_ids 与 mentioned_keys），或请用户在画布上手动添加参考图',
        }
      }
    }
```

- [ ] **Step 4: 跑测试确认通过**（同 Step 2 命令，Expected: 全绿，含既有 proposeGeneration 用例）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/agent-canvas-tools.controller.ts apps/server/src/agent/agent-canvas-tools.service.ts apps/server/src/agent/agent-canvas-tools.service.test.ts
git commit -m "feat(server): propose_generation 前置门禁 RB-D5（sidebarImageCount>0 且 localRefs 空 fail-closed）"
```

---

### Task 2: runtime RB-D5（body 计数 + missing_refs 短路）

**Files:**
- Modify: `services/pi-runtime/src/tools/canvas-write.ts`（propose_generation execute，约 :385-404）
- Test: `services/pi-runtime/src/tools/canvas-write.test.ts`（:123-131 既有 body 断言更新 + 新 describe）

**Interfaces:**
- Consumes: Task 1 的 Nest 返回 union 分支 `{confirmed:false, reason:'missing_refs', message}`（`client.post` 已解包 envelope，返回即 data）。
- Produces: POST body 恒含 `sidebarImageCount: number`；短路结果 `details._signal{status:"failed", retryable:false, errorCode:"missing_refs"}`（wiring/信号层零改动即消费）。

- [ ] **Step 1: 更新既有断言 + 写失败测试**

先改 :123-131 用例（CTX.attachments 恰有 1 个 image）：

```ts
	it("attach_refs 发 refOrder 且不带 userId；propose_generation 带 userId + sidebarImageCount", async () => {
		const { client, calls } = makeClient();
		const tools = createCanvasWriteTools(client);
		await run(findTool(tools, "attach_refs"), { node_id: "n1", ref_order: ["a", "b"] });
		assert.deepEqual(calls[0].body, { sessionId: "s1", nodeId: "n1", refOrder: ["a", "b"] });

		await run(findTool(tools, "propose_generation"), { node_id: "n1" });
		assert.deepEqual(calls[1].body, { sessionId: "s1", userId: "u1", nodeId: "n1", sidebarImageCount: 1 });
	});
```

新 describe（文件尾追加；复用 :481 起的 PendingToolRegistry import）：

```ts
// ── propose_generation RB-D5 门禁短路（spec 2026-10-13-sidebar-ref-bind-invariant-design）──
describe("propose_generation RB-D5 门禁短路", () => {
	function gateClient(gateBody: unknown, record: (path: string, body: Record<string, unknown>) => void) {
		return {
			post: async (path: string, body: Record<string, unknown>) => {
				record(path, body);
				if (path === "/agent/internal/propose-generation") return gateBody;
				return { ok: true };
			},
		} as never;
	}

	it("Nest fail-closed（confirmed:false missing_refs）→ 短路返回，不进阻塞等待、无 get-node 轮询", async () => {
		const paths: string[] = [];
		const outcomes: Array<[string, boolean]> = [];
		const client = gateClient(
			{ confirmed: false, reason: "missing_refs", message: "参考图未绑定成功，请重试 apply_sidebar_attachments（只传 node_ids 与 mentioned_keys），或请用户在画布上手动添加参考图" },
			(p) => paths.push(p),
		);
		const [propose] = createCanvasWriteTools(client, {
			registry: new PendingToolRegistry(),
			pollMs: 5,
			onProposeOutcome: (reason, confirmed) => outcomes.push([reason, confirmed]),
		}).filter((t) => t.name === "propose_generation");

		const result = await run(propose, { node_id: "n1" });
		const text = String((result.content as Array<{ text: string }>)[0].text);
		assert.match(text, /missing_refs/);
		assert.match(text, /apply_sidebar_attachments/);
		const details = result.details as { ok?: boolean; confirmed?: boolean; _signal?: { status?: string; retryable?: boolean; errorCode?: string } };
		assert.equal(details.ok, false);
		assert.equal(details.confirmed, false);
		assert.deepEqual(details._signal, { status: "failed", retryable: false, errorCode: "missing_refs" });
		// 短路：只有 propose-generation 一次调用，无 get-node 快照/轮询，registry 无 pending
		assert.deepEqual(paths, ["/agent/internal/propose-generation"]);
		assert.equal(outcomes.length, 1);
		assert.equal(outcomes[0][0], "missing_refs");
		assert.equal(outcomes[0][1], false);
	});

	it("B-5 off（无 registry）短路同样生效——门禁独立于阻塞模式", async () => {
		const client = gateClient({ confirmed: false, reason: "missing_refs", message: "m" }, () => {});
		const [propose] = createCanvasWriteTools(client).filter((t) => t.name === "propose_generation");
		const result = await run(propose, { node_id: "n1" });
		const text = String((result.content as Array<{ text: string }>)[0].text);
		assert.match(text, /missing_refs/);
		assert.doesNotMatch(text, /"ok":true/);
	});

	it("tc.attachments 只计 image：text/video 附件不计入 body.sidebarImageCount", async () => {
		const bodies: Array<Record<string, unknown>> = [];
		const client = {
			post: async (path: string, body: Record<string, unknown>) => {
				bodies.push(body);
				return { ok: true };
			},
		} as never;
		const tools = createCanvasWriteTools(client);
		const ctx: LnkpiToolContext = {
			sessionId: "s1",
			userId: "u1",
			attachments: [
				{ url: "https://x/a.png", mediaType: "image" },
				{ text: "参考文案", mediaType: "text" },
				{ url: "https://x/v.mp4", mediaType: "video" },
			],
		};
		await run(findTool(tools, "propose_generation"), { node_id: "n1" }, ctx);
		assert.equal(bodies[0].sidebarImageCount, 1);
	});

	it("Nest 正常放行（无 confirmed:false）→ 不短路，走既有路径（Review Focus 5 回归锚）", async () => {
		const reg = new PendingToolRegistry();
		const client = fakeNestClient(["generating"]);
		const [propose] = createCanvasWriteTools(client, { registry: reg, pollMs: 5 }).filter(
			(t) => t.name === "propose_generation",
		);
		const result = await run(propose, { node_id: "n1" });
		assert.equal((result.details as { confirmed?: boolean }).confirmed, true);
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/4seven/workspace/pi-lnk/.worktrees/prc-gate/services/pi-runtime && node --import tsx --test src/tools/canvas-write.test.ts`
Expected: body 断言用例 FAIL（缺 sidebarImageCount）；短路用例 FAIL（拿到 ok:true 结果）。

- [ ] **Step 3: 实现**（canvas-write.ts propose_generation execute）

`const base = await client.post(...)` 处改为：

```ts
			if (!tc.userId) throw new Error("propose_generation requires userId in toolContext");
			// RB-D5（spec 2026-10-13-sidebar-ref-bind-invariant-design.md）：本轮侧栏图片计数随
			// body 上行；门禁 SSOT 在 Nest（localRefs 空 ⇒ confirmed:false missing_refs，不做状态转移）。
			const sidebarImageCount = (tc.attachments ?? []).filter((a) => a.mediaType === "image").length;
			const base = await client.post("/agent/internal/propose-generation", {
				sessionId: tc.sessionId,
				userId: tc.userId,
				nodeId: p.node_id,
				sidebarImageCount,
			});
			// RB-D5 短路：Nest fail-closed ⇒ 不进阻塞等待，镜像同工具 not-confirmed 结果形状
			// （Ruling 1：withWriteSignal 会包出 {ok:true,data} 与 fail-closed 语义矛盾）。
			// 判定键严格双条件：confirmed === false 且 reason === 'missing_refs'（Review Focus 5）。
			const gate = (base ?? null) as { confirmed?: unknown; reason?: unknown; message?: unknown } | null;
			if (gate && gate.confirmed === false && gate.reason === "missing_refs") {
				// P2 结算归因：短路也是一次 propose 结算（分母不失真）
				onProposeOutcome?.("missing_refs", false);
				const message =
					typeof gate.message === "string" && gate.message
						? gate.message
						: "参考图未绑定成功，请重试 apply_sidebar_attachments，或请用户在画布上手动添加参考图";
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ ok: false, confirmed: false, reason: "missing_refs", message }),
						},
					],
					details: {
						ok: false,
						confirmed: false,
						_signal: { status: "failed", retryable: false, errorCode: "missing_refs" },
					},
				};
			}
```

- [ ] **Step 4: 跑测试确认通过**（同 Step 2；既有阻塞确认用例必须全绿——旧行为回归锚）

- [ ] **Step 5: runtime typecheck**

Run: `cd /Users/4seven/workspace/pi-lnk/.worktrees/prc-gate/services/pi-runtime && ./node_modules/.bin/tsc --noEmit`（worktree 无 tsc 时借主仓：`/Users/4seven/workspace/pi-lnk/node_modules/.bin/tsc --noEmit -p tsconfig.json`）

- [ ] **Step 6: Commit**

```bash
git add services/pi-runtime/src/tools/canvas-write.ts services/pi-runtime/src/tools/canvas-write.test.ts
git commit -m "feat(runtime): propose_generation 上行 sidebarImageCount 并短路 missing_refs（RB-D5）"
```

---

### Task 3: web RB-D6①（dock 直生二次确认）

**Files:**
- Create: `apps/web/src/utils/missingRefsConfirm.ts`
- Modify: `apps/web/src/pages/CanvasPage.vue`（handleNodeGenerate，约 :3911-3930；import 区）
- Test: `apps/web/src/utils/missingRefsConfirm.test.ts`（新建）

**Interfaces:**
- Consumes: `resolveNodeRefs`（`@/composables/useNodeRefs` 再导出自 `@lnkpi/shared`）；agent store `messages: AgentStreamMessage[]`（`attachments?: SidebarAttachment[]`）。
- Produces: `shouldConfirmDirectGenerateWithoutRefs(input): boolean`、`latestUserSidebarImageCount(messages): number`、`MISSING_REFS_CONFIRM_TITLE/MESSAGE`（文案常量）。

- [ ] **Step 1: 写失败测试**（新建 `apps/web/src/utils/missingRefsConfirm.test.ts`）

```ts
/**
 * RB-D6① dock 直生二次确认判定（纯函数锁定；wiring 在 CanvasPage.handleNodeGenerate，评审读码验证）。
 */
import { describe, expect, it } from 'vitest'
import type { SidebarAttachment } from '@lnkpi/shared'
import {
  MISSING_REFS_CONFIRM_MESSAGE,
  latestUserSidebarImageCount,
  shouldConfirmDirectGenerateWithoutRefs,
} from './missingRefsConfirm'

const img = (mediaType: SidebarAttachment['mediaType'] = 'image'): SidebarAttachment =>
  ({ id: 'a1', mediaType, sourceKind: 'upload', label: 'a.png', url: 'https://x/a.png' }) as SidebarAttachment

describe('shouldConfirmDirectGenerateWithoutRefs', () => {
  it('image/video 节点 + 无 refs + 本轮有侧栏图 → 确认', () => {
    expect(shouldConfirmDirectGenerateWithoutRefs({ nodeType: 'image', refCount: 0, sidebarImageCount: 1 })).toBe(true)
    expect(shouldConfirmDirectGenerateWithoutRefs({ nodeType: 'video', refCount: 0, sidebarImageCount: 2 })).toBe(true)
  })
  it('非 image/video 节点不确认（Ruling 2 前端镜像）', () => {
    for (const t of ['text', 'prompt', 'audio', 'shot', 'sceneComposer']) {
      expect(shouldConfirmDirectGenerateWithoutRefs({ nodeType: t, refCount: 0, sidebarImageCount: 1 })).toBe(false)
    }
  })
  it('已有 refs 或本轮无侧栏图不确认', () => {
    expect(shouldConfirmDirectGenerateWithoutRefs({ nodeType: 'image', refCount: 1, sidebarImageCount: 1 })).toBe(false)
    expect(shouldConfirmDirectGenerateWithoutRefs({ nodeType: 'image', refCount: 0, sidebarImageCount: 0 })).toBe(false)
  })
})

describe('latestUserSidebarImageCount', () => {
  it('取最近一条 user 消息的 image 附件计数；assistant 中间层不干扰', () => {
    const messages = [
      { role: 'user', attachments: [img()] },
      { role: 'assistant', attachments: undefined },
      { role: 'user', attachments: [img(), img('text') as SidebarAttachment] },
    ]
    expect(latestUserSidebarImageCount(messages)).toBe(1)
  })
  it('无 user 消息 / 无 attachments → 0', () => {
    expect(latestUserSidebarImageCount([{ role: 'assistant' }])).toBe(0)
    expect(latestUserSidebarImageCount([{ role: 'user', attachments: [] }])).toBe(0)
  })
})

it('文案含可行动出口（先绑定参考图 / 直接生成语义）', () => {
  expect(MISSING_REFS_CONFIRM_MESSAGE).toContain('参考图')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/4seven/workspace/pi-lnk/.worktrees/prc-gate/apps/web && ./node_modules/.bin/vitest run src/utils/missingRefsConfirm.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现纯函数**（新建 `apps/web/src/utils/missingRefsConfirm.ts`）

```ts
/**
 * RB-D6①（spec 2026-10-13-sidebar-ref-bind-invariant-design.md）：dock 直生路径二次确认。
 * 前端是提示层（宽判定，Ruling 4：refs 全量解析含上游边）；门禁 SSOT 在 Nest（RB-D5，只看 localRefs）。
 */
import type { SidebarAttachment } from '@lnkpi/shared'

export const MISSING_REFS_CONFIRM_TITLE = '未检测到参考图'
export const MISSING_REFS_CONFIRM_MESSAGE =
  '本轮上传了参考图，但该节点还没有绑定任何参考图，直接生成将不使用参考图。可先让 Agent 执行 apply_sidebar_attachments 绑定，或手动添加参考图。'

export interface MissingRefsConfirmInput {
  nodeType: string
  /** resolveNodeRefs(...).filter((r) => !r.stale).length（localRefs + 上游边全量解析）。 */
  refCount: number
  /** 本轮（最近一条 user 消息）侧栏图片附件计数。 */
  sidebarImageCount: number
}

/** image/video 消费参考图；其余节点型不确认（Ruling 2 前端镜像）。 */
export function shouldConfirmDirectGenerateWithoutRefs(input: MissingRefsConfirmInput): boolean {
  if (input.nodeType !== 'image' && input.nodeType !== 'video') return false
  if (input.refCount > 0) return false
  return input.sidebarImageCount > 0
}

/** 最近一条 user 消息的侧栏图片计数（与 runtime tc.attachments 本轮语义对齐，Ruling 3）。 */
export function latestUserSidebarImageCount(
  messages: Array<{ role: string; attachments?: SidebarAttachment[] }>,
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    return (messages[i].attachments ?? []).filter((a) => a.mediaType === 'image').length
  }
  return 0
}
```

- [ ] **Step 4: 跑测试确认通过**（同 Step 2）

- [ ] **Step 5: CanvasPage 接线**（`handleNodeGenerate`，:3911）

import 区（就近既有 import 追加；`resolveNodeRefs`/`LocalRefBinding` 若已从 `@/composables/useNodeRefs` 导入则并入）：

```ts
import { resolveNodeRefs, type LocalRefBinding } from '@/composables/useNodeRefs'
import {
  MISSING_REFS_CONFIRM_MESSAGE,
  MISSING_REFS_CONFIRM_TITLE,
  latestUserSidebarImageCount,
  shouldConfirmDirectGenerateWithoutRefs,
} from '@/utils/missingRefsConfirm'
```

`handleNodeGenerate` 内、`await generateForNode(fresh)` 之前插入（`agent` store 实例：`useAgentStore()` 已 import，:187）：

```ts
  // RB-D6①：dock 直生路径——本轮侧栏有图但节点无任何 refs（宽判定含上游边）⇒ 二次确认。
  // propose 确认路径 handleAgentGenerateNode 不加（Ruling 5：那是确认动作本身，弹窗双重打断）。
  const agentStore = useAgentStore()
  const freshData = (fresh.data ?? {}) as Record<string, unknown>
  const refCount = resolveNodeRefs({
    targetNodeId: fresh.id,
    targetType: String(fresh.type),
    nodes: nodes.value,
    edges: edges.value,
    localRefs: (freshData.localRefs as LocalRefBinding[]) ?? [],
    refOrder: (freshData.refOrder as string[]) ?? [],
  }).filter((r) => !r.stale).length
  if (
    shouldConfirmDirectGenerateWithoutRefs({
      nodeType: String(fresh.type),
      refCount,
      sidebarImageCount: latestUserSidebarImageCount(agentStore.messages),
    })
  ) {
    try {
      await ElMessageBox.confirm(MISSING_REFS_CONFIRM_MESSAGE, MISSING_REFS_CONFIRM_TITLE, {
        confirmButtonText: '直接生成',
        cancelButtonText: '先绑定参考图',
        type: 'warning',
      })
    } catch {
      return // 用户取消：不生成（Nest RB-D5 门禁仍兜底）
    }
  }
```

（⚠️ 实现者先读 handleNodeGenerate 当前函数体与 `nodes`/`edges` 变量名，接线位置在第二次 busy 检查之后、`generateForNode(fresh)` 之前；`ElMessageBox` 已在 :26 import。）

- [ ] **Step 6: web typecheck + 相关既有测试**

Run: `cd /Users/4seven/workspace/pi-lnk/.worktrees/prc-gate/apps/web && ./node_modules/.bin/vue-tsc -b`（借主仓二进制亦可）与 `./node_modules/.bin/vitest run src/utils/missingRefsConfirm.test.ts src/components/agent`
Expected: 全绿（agent 目录回归确认 executionTrace/sideRail 未被波及）。

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/utils/missingRefsConfirm.ts apps/web/src/utils/missingRefsConfirm.test.ts apps/web/src/pages/CanvasPage.vue
git commit -m "feat(web): dock 直生缺参考图二次确认（RB-D6①，本轮侧栏有图且节点无 refs）"
```

---

### Task 4: 全量回归 + 计划文档提交

- [ ] Step 1: server 全量 agent 测试：`cd apps/server && ./node_modules/.bin/vitest run src/agent`。
- [ ] Step 2: runtime 全量：`cd services/pi-runtime && node --import tsx --test "src/**/*.test.ts"`（4 核机如遇 loader 组合假红，单跑失败集复核——PR-B 实证纪律）。
- [ ] Step 3: `git status --short` 必须为空才 push（本地绿≠CI 绿，#397 实证）。
- [ ] Step 4: 把本计划文件一并 `git add docs/superpowers/plans/2026-10-14-sidebar-ref-bind-pr-c.md` 并 commit（`docs(plan): PR-C 门禁批实施计划`）。
- [ ] Step 5: push + 开 PR（base master），标题 `feat: 侧栏参考图绑定门禁批（RB-D5 propose fail-closed / RB-D6① dock 二次确认）`。

## 硬表对照（spec 硬表第 5 行 + 金标 G3）

| 断言 | 落点 |
|----|------|
| `sidebarImageCount>0` && localRefs 空 ⇒ `missing_refs` 且节点状态不变 | Task 1 测试 1 |
| localRefs 非空 ⇒ 放行 | Task 1 测试 2 |
| `sidebarImageCount=0` ⇒ 放行 | Task 1 测试 3 |
| runtime body 含计数 + missing_refs 短路零轮询 | Task 2 测试 1/2/3 |
| Nest 放行不误伤（短路判定严格双条件） | Task 2 测试 4 |
| 前端判定纯函数矩阵（节点型 / refs / 计数） | Task 3 测试 |
