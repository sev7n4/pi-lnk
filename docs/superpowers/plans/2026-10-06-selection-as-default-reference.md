# 画布选中 = Agent 默认指代（SEL-REF）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让画布选中（含框选）成为 agent 的默认指代，并在气泡旁以确定性 UI 回执"已绑定 N 个选中节点"。

**Architecture:** 前端每轮把选中集合 `selectedNodeIds`（唯一新增上行字段）随请求发出；Nest 侧据此**派生** `focusNodeId`（不再由前端单独传）、并在 `assembleDynamic` 里拼装自解释 digest 动态块；模型按需调既有常驻工具 `get_node` 读深。回执由前端用**自己发出的请求事实**渲染，不经模型。全链路**不新增 agent 工具、不改静态提示词规则**。

**Tech Stack:** TypeScript · NestJS（`apps/server`）· Vue 3（`apps/web`）· Fastify（`services/pi-runtime`）· zod · vitest

**Spec:** [`docs/superpowers/specs/2026-10-06-selection-as-default-reference-design.md`](../specs/2026-10-06-selection-as-default-reference-design.md)（代号 SEL-REF；执行者须同时读）

## Global Constraints

以下为规格的全项目级要求，每个 task 的要求都隐含包含本节：

- **不新增 agent 工具**（规格 N-2）。常驻/延迟分层一行都不动。
- **不改 `prompt-registry/**` 静态规则**（规格 N-6）——L6 最紧组合余量仅个位数。
- **不碰** Prisma schema / 数据迁移 / 积分与扣费 / 画布持久化格式。
- digest 块的**块首标记必须与 `classifyBlock` 映射一致**（否则 `general` 份额 0、只享 80 字符保底）。
- `SEL_REF_ENABLED` **默认 `off`**；只接受 `on`（大小写不敏感），其余值一律当 `off`。
- 纯函数必须 **byte-stable**（同输入逐字节同输出，无时间/随机源）——prompt cache 友好。
- `focusNodeId` 永远由 `selectedNodeIds` **派生**，任何一侧都不得独立写入。
- 分支纪律：不向 master 直接提交；每个 task 单独 commit。
- 合并后：`apps/server/**` 走 `deploy.yml`；`services/pi-runtime/**` **不会自动上线**，须手工 dispatch `runtime-deploy`（tag = master 短 SHA）。

## Review Focus

规格是愿景文档，它对某个输入的沉默**不是**该输入可以破坏程序的许可。以下五类最可能咬人，各自的测试已折进对应 task：

1. **框选恰好 1 个节点** ⇒ `multiSelectedIds` 有值但 `selectedNodeId` 被 `clearEditorSelection()` 清空 ⇒ 必须与单击等价（Task 5）。
2. **标题含换行 / 超长 / 含 `·`** ⇒ 会破坏 digest 块的行结构，进而改变 `classifyBlock` 与截断行为（Task 1）。
3. **选中后、发送前节点被 Agent 删或改**（`drama-qc-review` 场景）⇒ 必须剔除而不是抛错（Task 1）。
4. **`SEL_REF_ENABLED` 写成 `true` / `ON` / 空串** ⇒ 语义未定义时必须落 `off`（安全侧），不得误开（Task 4）。
5. **回执 chip 展开后标题与实际节点不符** ⇒ 前端必须用**本轮实际发出的 id 集合**渲染，不能用发送后的实时选中态（Task 5）。

---

### Task 1: `buildSelectionDigest` 纯函数

**Files:**
- Create: `packages/shared/src/canvas/selectionDigest.ts`
- Test: `packages/shared/src/canvas/selectionDigest.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  ```ts
  export interface SelectionDigestNode { type: string; title: string; x: number; y: number }
  export interface SelectionDigestInput {
    nodeIds: readonly string[]
    lookup: (id: string) => SelectionDigestNode | undefined
    limit?: number
  }
  export function buildSelectionDigest(input: SelectionDigestInput): string | null
  ```
  后续 task 只依赖这一个函数签名。

- [ ] **Step 1: 写失败测试**

```ts
// packages/shared/src/canvas/selectionDigest.test.ts
import { describe, expect, it } from 'vitest'
import { buildSelectionDigest, type SelectionDigestNode } from './selectionDigest'

const N = (id: string, over: Partial<SelectionDigestNode> = {}): SelectionDigestNode => ({
  type: 'image', title: id, x: 0, y: 0, ...over,
})
const mapOf = (m: Record<string, SelectionDigestNode>) => (id: string) => m[id]
const TAIL = '用户说「这个 / 这几个」时指的就是上面这些；要看细节调 get_node。'

describe('buildSelectionDigest', () => {
  it('空集返回 null（调用方整块不输出）', () => {
    expect(buildSelectionDigest({ nodeIds: [], lookup: () => undefined })).toBeNull()
  })

  it('全部 id 无效返回 null，不注入半截', () => {
    expect(buildSelectionDigest({ nodeIds: ['x', 'y'], lookup: () => undefined })).toBeNull()
  })

  it('单选：含 id/type/标题，标注单选', () => {
    const out = buildSelectionDigest({ nodeIds: ['a'], lookup: mapOf({ a: N('a', { title: '小柚定妆照' }) }) })!
    expect(out).toBe(['【用户当前选中】1 个节点（单选）', '- a · image · 小柚定妆照', TAIL].join('\n'))
  })

  it('按画布位置排序（y → x），与传入顺序无关', () => {
    const m = { a: N('a', { y: 2, x: 0 }), b: N('b', { y: 1, x: 9 }), c: N('c', { y: 1, x: 1 }) }
    const out = buildSelectionDigest({ nodeIds: ['a', 'b', 'c'], lookup: mapOf(m) })!
    expect(out.indexOf('- c')).toBeLessThan(out.indexOf('- b'))
    expect(out.indexOf('- b')).toBeLessThan(out.indexOf('- a'))
    expect(out.startsWith('【用户当前选中】3 个节点（框选）')).toBe(true)
  })

  it('同位置时按 id 稳定排序（byte-stable）', () => {
    const m = { b: N('b'), a: N('a'), c: N('c') }
    const runs = [0, 1, 2].map(() => buildSelectionDigest({ nodeIds: ['c', 'b', 'a'], lookup: mapOf(m) }))
    expect(runs[1]).toBe(runs[0])
    expect(runs[2]).toBe(runs[0])
    expect(runs[0]!.indexOf('- a')).toBeLessThan(runs[0]!.indexOf('- b'))
  })

  it('超过 limit：列前 8 + 「另 N 个」且总数必写', () => {
    const ids = Array.from({ length: 9 }, (_, i) => `n${i}`)
    const m = Object.fromEntries(ids.map((id, i) => [id, N(id, { y: i })]))
    const out = buildSelectionDigest({ nodeIds: ids, lookup: mapOf(m) })!
    expect(out.startsWith('【用户当前选中】9 个节点（框选）')).toBe(true)
    expect(out).toContain('- （另 1 个：n8）')
  })

  it('无效 id 被剔除、总数按剔除后计', () => {
    const ids = Array.from({ length: 9 }, (_, i) => `n${i}`)
    const m = Object.fromEntries(ids.slice(0, 7).map((id, i) => [id, N(id, { y: i })]))
    const out = buildSelectionDigest({ nodeIds: ids, lookup: mapOf(m) })!
    expect(out.startsWith('【用户当前选中】7 个节点（框选）')).toBe(true)
    expect(out).not.toContain('另')
  })

  it('标题里的换行被压平（否则破坏块的行结构）', () => {
    const out = buildSelectionDigest({ nodeIds: ['a'], lookup: mapOf({ a: N('a', { title: '第一行\n第二行' }) }) })!
    expect(out.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1)
    expect(out).toContain('第一行 第二行')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lnkpi/shared test -- selectionDigest`
Expected: FAIL —— `Cannot find module './selectionDigest'`

- [ ] **Step 3: 写最小实现**

```ts
// packages/shared/src/canvas/selectionDigest.ts
export interface SelectionDigestNode {
  type: string
  title: string
  x: number
  y: number
}

export interface SelectionDigestInput {
  nodeIds: readonly string[]
  /** 幂等；返回 undefined = 不属于本会话画布或已删除 ⇒ 剔除（同时承担归属校验） */
  lookup: (id: string) => SelectionDigestNode | undefined
  limit?: number
}

const DEFAULT_LIMIT = 8
const REST_ID_CAP = 16
const TAIL = '用户说「这个 / 这几个」时指的就是上面这些；要看细节调 get_node。'

/** 标题里的换行会破坏块的行结构（进而影响 classifyBlock 与截断），压平成空格。 */
function flattenTitle(raw: string): string {
  return raw.replace(/\s*\n+\s*/g, ' ').trim()
}

export function buildSelectionDigest(input: SelectionDigestInput): string | null {
  const limit = input.limit ?? DEFAULT_LIMIT
  const found: Array<SelectionDigestNode & { id: string }> = []
  for (const id of input.nodeIds) {
    const n = input.lookup(id)
    if (n) found.push({ id, ...n })
  }
  if (found.length === 0) return null

  found.sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const total = found.length
  const lines = found.slice(0, limit).map((n) => `- ${n.id} · ${n.type} · ${flattenTitle(n.title)}`)
  const head = `【用户当前选中】${total} 个节点（${total === 1 ? '单选' : '框选'}）`
  if (total > limit) {
    const rest = found.slice(limit, limit + REST_ID_CAP).map((n) => n.id)
    const more = total - limit > rest.length ? ' …' : ''
    lines.push(`- （另 ${total - limit} 个：${rest.join('、')}${more}）`)
  }
  return [head, ...lines, TAIL].join('\n')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @lnkpi/shared test -- selectionDigest`
Expected: PASS，8 个用例全绿

- [ ] **Step 5: 跑 shared 全量 + 类型检查**

Run: `pnpm --filter @lnkpi/shared test && pnpm --filter @lnkpi/shared build`
Expected: 全绿，无 TS 报错

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/canvas/selectionDigest.ts packages/shared/src/canvas/selectionDigest.test.ts
git commit -m "feat(canvas): buildSelectionDigest 纯函数（位置排序 + 上限 + byte-stable）"
```

---

### Task 2: `classifyBlock` 登记 digest 块首标记

规格 P0-1：`dynamic-budget` 的 `general` 份额为 0、`MIN_BLOCK_CHARS = 80`，未登记的块首会被打回 80 字符。本 task 只补映射，不接线预算（接线是独立工程）。

**Files:**
- Modify: `services/pi-runtime/src/dynamic-budget.ts:46-53`（`classifyBlock`）
- Test: `services/pi-runtime/src/dynamic-budget.test.ts:11-18`（已有 `classifyBlock` 用例块，往里加两行）

**Interfaces:**
- Consumes: Task 1 的块首标记 `【用户当前选中】`
- Produces: `classifyBlock("【用户当前选中】…") === "canvas"`

- [ ] **Step 1: 写失败测试**

在 `services/pi-runtime/src/dynamic-budget.test.ts` 的 `classifyBlock` 用例里追加两行：

```ts
	assert.equal(classifyBlock("【用户当前选中】2 个节点（框选）"), "canvas");
	assert.equal(classifyBlock("【用户当前选中】不存在的块首"), "canvas");
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lnkpi/pi-runtime test -- dynamic-budget`
Expected: FAIL —— 实际返回 `"general"`

- [ ] **Step 3: 补映射**

在 `services/pi-runtime/src/dynamic-budget.ts` 的 `classifyBlock` 中，`if (t.startsWith("当前画布摘要")) return "canvas";` 之后紧接一行：

```ts
	if (t.startsWith("【用户当前选中】")) return "canvas";
```

并把函数上方的注释块补一条（保持注释与代码同源）：

```
 * - canvas: pi-prompt-assembler.service.ts `当前画布摘要：\n{JSON}`
 *          + agent.service.ts `【用户当前选中】`（SEL-REF digest 块，R-S6）
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @lnkpi/pi-runtime test -- dynamic-budget`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add services/pi-runtime/src/dynamic-budget.ts services/pi-runtime/src/dynamic-budget.test.ts
git commit -m "fix(pi-runtime): classifyBlock 登记 SEL-REF digest 块首 → canvas（避免落 general 被截到 80 字）"
```

> ⚠️ 本 task 改 `services/pi-runtime/**`，**合并后不会自动上线**，须手工 dispatch `runtime-deploy`（tag = master 短 SHA）。见 Task 6。

---

### Task 3: 请求契约与 Nest DTO 透传 `selectedNodeIds`

**Files:**
- Modify: `packages/shared/src/agentContract.ts:658`（`AgentConversationRequestSchema` 内，`focusNodeId` 之后）
- Modify: `apps/server/src/agent/agent.controller.ts:88-91`（DTO，紧随 `focusNodeId`）与 `:571`（位置实参）

**Interfaces:**
- Consumes: 无
- Produces: `AgentConversationRequest.selectedNodeIds?: string[]`；`agent.service.ts` 的第 7 个位置参数变为 `selectedNodeIds: string[] | undefined`（`focusNodeId` 仍在其后，由 Task 4 内部派生）

- [ ] **Step 1: 写失败测试**

在 `packages/shared/src/` 现有契约测试中追加（若无 `agentContract.test.ts` 则新建）：

```ts
import { describe, expect, it } from 'vitest'
import { AgentConversationRequestSchema } from './agentContract'

describe('AgentConversationRequestSchema · selectedNodeIds', () => {
  it('接受字符串数组', () => {
    const r = AgentConversationRequestSchema.parse({ sessionId: 's', message: 'm', selectedNodeIds: ['a', 'b'] })
    expect(r.selectedNodeIds).toEqual(['a', 'b'])
  })
  it('缺省时为 undefined（不传空数组）', () => {
    const r = AgentConversationRequestSchema.parse({ sessionId: 's', message: 'm' })
    expect(r.selectedNodeIds).toBeUndefined()
  })
  it('非字符串元素被拒', () => {
    expect(AgentConversationRequestSchema.safeParse({ sessionId: 's', message: 'm', selectedNodeIds: [1] }).success).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lnkpi/shared test -- agentContract`
Expected: FAIL —— `selectedNodeIds` 未声明，`parse` 丢弃该键

- [ ] **Step 3: 加契约字段**

在 `packages/shared/src/agentContract.ts` 的 `AgentConversationRequestSchema` 里，`focusNodeId: z.string().optional(),` 之后紧接：

```ts
  /** SEL-REF：指代信号（本轮画布选中的节点 id 集合）。唯一新增上行字段。 */
  selectedNodeIds: z.array(z.string()).max(200).optional(),
```

> 上限 200 是**防滥用**的硬闸（画布节点数远小于此）；digest 自身的展示上限是 8 条，见 Task 1。

- [ ] **Step 4: 加 DTO 与位置实参**

`apps/server/src/agent/agent.controller.ts` 的 DTO 类中，紧随现有 `focusNodeId` 声明之后：

```ts
  /** SEL-REF：指代信号（本轮选中的节点 id 集合；框选与单选统一走这里） */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  selectedNodeIds?: string[]
```

并在 `:571` 附近的调用实参里，把 `dto.focusNodeId,` 之后插入 `dto.selectedNodeIds,`。

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `pnpm --filter @lnkpi/shared test -- agentContract && pnpm --filter @lnkpi/server exec tsc --noEmit`
Expected: 全绿。若报 `PrismaService` 属性不存在，先 `pnpm --filter @lnkpi/server exec prisma generate`。

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/agentContract.ts apps/server/src/agent/agent.controller.ts packages/shared/src/agentContract.test.ts
git commit -m "feat(agent): 请求契约与 DTO 增加 selectedNodeIds（SEL-REF 唯一新增上行字段）"
```

---

### Task 4: Nest 侧开关 + `focusNodeId` 派生 + digest 动态块

本 task 是链路的中枢。三件事必须同一 commit：不开开关就看不到块，派生不一起做就会漂。

**Files:**
- Modify: `apps/server/src/agent/agent.service.ts:650` 附近（新增 env resolver）＋ `:310`（位置参数）＋ `:1005-1010`（`assembleDynamic`）＋ `:1059` 附近（`turnContext`）
- Modify: `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.ts:159-161`（`assembleDynamic` 入参）＋ `:176` 后（追加 selection 层）
- Test: `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.test.ts`（已存在，追加用例）

**Interfaces:**
- Consumes: Task 1 的 `buildSelectionDigest`；Task 3 的 `selectedNodeIds`
- Produces:
  - `agent.service.ts` 私有 `selectionRefEnabled(): boolean`
  - `agent.service.ts` 私有 `buildSelectionLookup(sessionId: string): Promise<Map<string, { type: string; title: string; x: number; y: number }>>`
  - `assembleDynamic` 入参新增 `selectedNodeIds?: string[]` 与 `selectedNodeLookup?: (id: string) => SelectionDigestNode | undefined`
  - 派生规则：`focusNodeId = selectedNodeIds?.length === 1 ? selectedNodeIds[0] : undefined`

- [ ] **Step 1: 写失败测试（assembler 层）**

在 `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.test.ts` 追加（该文件已有 helper `makeAssembler = (summary: { nodes: unknown[] }) => new PiPromptAssembler({ getCanvasSummary: async () => summary } as never)`，直接复用）：

```ts
it('SEL-REF · selectedNodeIds 非空时追加 digest 层', async () => {
	const asm = makeAssembler({ nodes: [{ id: 'a', type: 'image', title: '小柚定妆照', status: 'ready' }] });
	const blocks = await asm.assembleDynamic({
		sessionId: 's1',
		selectedNodeIds: ['a'],
		selectedNodeLookup: (id) =>
			id === 'a' ? { type: 'image', title: '小柚定妆照', x: 0, y: 0 } : undefined,
	});
	expect(blocks.some((b) => b.startsWith('【用户当前选中】'))).toBe(true);
});

it('SEL-REF · selectedNodeIds 为空时不追加该块', async () => {
	const asm = makeAssembler({ nodes: [] });
	const blocks = await asm.assembleDynamic({ sessionId: 's1', selectedNodeIds: [] });
	expect(blocks.some((b) => b.startsWith('【用户当前选中】'))).toBe(false);
});
```

> 注意：`getCanvasSummary` 的返回**不含坐标**（`{id, type, title, status}`），所以 `selectedNodeLookup` 必须由调用方（`agent.service.ts`）用 `getCanvasLayout` 构造后注入——见 Step 5。assembler 自己不查画布。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lnkpi/server test -- pi-prompt-assembler`
Expected: FAIL —— `assembleDynamic` 不接受 `selectedNodeIds`（TS 编译错或断言失败）

- [ ] **Step 3: assembler 追加 selection 层**

`pi-prompt-assembler.service.ts` 的 `assembleDynamic` 入参类型里，`focusNodeId?: string;` 之后加：

```ts
		/** SEL-REF：指代信号（本轮选中的节点 id 集合）；与摘要焦点过滤语义无关。 */
		selectedNodeIds?: string[];
		/** 本会话画布节点查找（id → type/title/位置）；找不到即剔除，同时承担归属校验。 */
		selectedNodeLookup?: (id: string) => { type: string; title: string; x: number; y: number } | undefined;
```

并在 `if (input.memoryBlock?.trim())` **之前**插入：

```ts
		// SEL-REF：指代信号块。digest 必须在 Nest 侧拼装——本方法持有的 getCanvasSummary
		// 只返回本会话画布的节点，天然完成归属校验（见 spec §5.5）。
		if (input.selectedNodeIds?.length && input.selectedNodeLookup) {
			const digest = buildSelectionDigest({
				nodeIds: input.selectedNodeIds,
				lookup: input.selectedNodeLookup,
			});
			if (digest) layers.push(layer("selection", "canvas", digest));
		}
```

文件顶部 import 增加：

```ts
import { buildSelectionDigest } from '@lnkpi/shared/canvas/selectionDigest';
```

> 依赖已存在（`packages/shared` 是 workspace 包）；若路径解析失败，改用该仓既有的相对/别名写法，**不要**新建包。

- [ ] **Step 4: 跑 assembler 测试确认通过**

Run: `pnpm --filter @lnkpi/server test -- pi-prompt-assembler`
Expected: PASS（含既有用例）

- [ ] **Step 5: env 开关 + 派生 + 接线**

`agent.service.ts` 在 `PI_SIDEBAR_VISION` resolver（`:650` 附近）之后加同形 resolver：

```ts
	private selectionRefEnabled(): boolean {
		return (process.env.SEL_REF_ENABLED?.trim().toLowerCase() || 'off') === 'on';
	}

	/**
	 * SEL-REF：指代节点的 type/title/绝对坐标。
	 * ⚠️ 必须用 `getCanvasLayout` 而不是 `getCanvasSummary`——后者的返回只有
	 * `{id, type, title, status}`，**没有坐标**，而 digest 要按位置稳定排序（S-8）。
	 * 两者都走 `loadSession(sessionId)` ⇒ 同样只返回本会话画布的节点，归属校验白拿。
	 */
	private async buildSelectionLookup(sessionId: string) {
		if (!this.canvasTools) return new Map<string, { type: string; title: string; x: number; y: number }>();
		const layout = await this.canvasTools.getCanvasLayout({ sessionId });
		return new Map(
			layout.nodes.map((n) => [
				n.id,
				{ type: n.type, title: n.title, x: n.absolutePosition.x, y: n.absolutePosition.y },
			]),
		);
	}
```

> 用 `absolutePosition` 而非 `position`：后者是**相对父 group** 的坐标，节点被打组后同一节点在两套坐标系里的值不同，跨 group 比较会错。

`assembleDynamic` 调用点（`:1005` 附近）改为：

```ts
		const selectedNodeIds = this.selectionRefEnabled() ? (piContext?.selectedNodeIds ?? []) : [];
		const selectionLookup = selectedNodeIds.length ? await this.buildSelectionLookup(sessionId) : undefined;
		const dynamicBlocks = await assembler.assembleDynamic({
			sessionId,
			attachments: piContext?.attachments,
			// 审计 P0-①：焦点过滤（>30 节点画布只注入焦点 + 1 跳邻居），换话题污染收口。
			// SEL-REF：focusNodeId 改为由 selectedNodeIds 派生，双字段结构上不可能漂移。
			focusNodeId: selectedNodeIds.length === 1 ? selectedNodeIds[0] : undefined,
			selectedNodeIds,
			selectedNodeLookup: selectionLookup ? (id) => selectionLookup.get(id) : undefined,
			memoryBlock,
		});
```

`turnContext`（`:1059` 附近）里，**删除** `focusNodeId: piContext?.focusNodeId,` 这一行，改为：

```ts
			focusNodeId: selectedNodeIds.length === 1 ? selectedNodeIds[0] : undefined,
			selectedNodeIds,
```

> `piContext` 的类型里 `focusNodeId` 字段可保留（兼容旧客户端），但**不再被本服务写出**。

- [ ] **Step 6: 补 `SEL_REF_ENABLED` 语义测试**

在 `apps/server/src/agent/` 下的既有 service 测试里追加（构造 `process.env` 后调用私有 resolver，用 `(svc as any).selectionRefEnabled()` 或把 resolver 提到导出函数）：

```ts
describe('SEL_REF_ENABLED 语义', () => {
	const env = process.env.SEL_REF_ENABLED
	afterEach(() => { if (env === undefined) delete process.env.SEL_REF_ENABLED; else process.env.SEL_REF_ENABLED = env })

	it.each([
		['on', true], ['ON', true], [' on ', true],
		['off', false], ['true', false], ['', false], [undefined, false],
	])('%s → %s', (v, want) => {
		if (v === undefined) delete process.env.SEL_REF_ENABLED
		else process.env.SEL_REF_ENABLED = v as string
		expect((svc as any).selectionRefEnabled()).toBe(want)
	})
})
```

- [ ] **Step 7: 跑 server 测试 + 类型检查**

Run: `pnpm --filter @lnkpi/server test -- agent && pnpm --filter @lnkpi/server exec tsc --noEmit`
Expected: 全绿

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/agent/agent.service.ts apps/server/src/agent/agent.controller.ts apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.ts apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.test.ts
git commit -m "feat(agent): Nest 侧拼装 SEL-REF digest 块 + focusNodeId 改派生 + SEL_REF_ENABLED 开关（默认 off）"
```

> 本 task 改 `apps/server/**` ⇒ 合并后 `deploy.yml` 会发 api；仍需按 Task 6 手工开 env。

---

### Task 5: 前端发送参数改造 + 回执 chip

**Files:**
- Create: `apps/web/src/components/agent/AgentSelectionBindingChip.vue`
- Modify: `apps/web/src/components/agent/AgentSideRail.vue:158`（props）＋ `:2071`（payload）＋ 用户消息气泡渲染处
- Modify: `apps/web/src/pages/CanvasPage.vue:4838`（绑定）＋ `:403`（`multiSelectedIds`）
- Test: `apps/web/src/components/agent/AgentSelectionBindingChip.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 的 `selectedNodeIds` 契约；Task 4 的 `SEL_REF_ENABLED` 语义（前端不需要知道 env，只按"本轮发了什么"渲染）
- Produces:
  ```ts
  // AgentSideRail.vue
  const props = { ..., selectedNodeIds?: string[] }
  // 每轮发送时冻结的绑定快照（渲染回执的唯一数据源）
  const lastBinding = ref<{ ids: string[]; label: string } | null>(null)
  ```

- [ ] **Step 1: 写失败测试（chip 组件）**

```ts
// apps/web/src/components/agent/AgentSelectionBindingChip.test.ts
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AgentSelectionBindingChip from './AgentSelectionBindingChip.vue'

const nodes = [
  { id: 'a', type: 'image', title: '小柚定妆照' },
  { id: 'b', type: 'prompt', title: '第3镜' },
]

describe('AgentSelectionBindingChip', () => {
  it('显示已绑定 N 个选中节点', () => {
    const w = mount(AgentSelectionBindingChip, { props: { nodeIds: ['a', 'b'], nodes } })
    expect(w.text()).toContain('已绑定 2 个选中节点')
  })
  it('展开后列出 id 与标题', async () => {
    const w = mount(AgentSelectionBindingChip, { props: { nodeIds: ['a', 'b'], nodes } })
    await w.find('[data-test="toggle"]').trigger('click')
    expect(w.text()).toContain('a · image · 小柚定妆照')
    expect(w.text()).toContain('b · prompt · 第3镜')
  })
  it('id 不在 nodes 里时仍显示 id，不显示空标题', async () => {
    const w = mount(AgentSelectionBindingChip, { props: { nodeIds: ['zz'], nodes } })
    await w.find('[data-test="toggle"]').trigger('click')
    expect(w.text()).toContain('zz')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lnkpi/web test -- AgentSelectionBindingChip`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写组件**

```vue
<!-- apps/web/src/components/agent/AgentSelectionBindingChip.vue -->
<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{
  nodeIds: string[]
  nodes: Array<{ id: string; type: string; title?: string }>
}>()

const open = ref(false)
const rows = computed(() =>
  props.nodeIds.map((id) => {
    const n = props.nodes.find((x) => x.id === id)
    return { id, type: n?.type ?? '未知', title: n?.title ?? '' }
  }),
)
</script>

<template>
  <div v-if="nodeIds.length" class="sel-ref-chip" data-test="selection-binding-chip">
    <button data-test="toggle" class="sel-ref-chip__toggle" @click="open = !open">
      已绑定 {{ nodeIds.length }} 个选中节点
    </button>
    <ul v-if="open" class="sel-ref-chip__list">
      <li v-for="r in rows" :key="r.id">{{ r.id }} · {{ r.type }}{{ r.title ? ` · ${r.title}` : '' }}</li>
    </ul>
  </div>
</template>

<style scoped>
.sel-ref-chip { font-size: 12px; }
.sel-ref-chip__toggle { background: none; border: 1px solid var(--border-color, #d3d1c7); border-radius: 8px; padding: 2px 8px; cursor: pointer; }
.sel-ref-chip__list { margin: 4px 0 0; padding-left: 18px; }
</style>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @lnkpi/web test -- AgentSelectionBindingChip`
Expected: PASS，3 个用例全绿

- [ ] **Step 5: 传参与 payload 改造**

`CanvasPage.vue:4838` 附近，把

```html
        :selected-node-id="selectedNodeId"
```

改为（**框选优先**，单选退化为单元素数组；两者都空则传空数组）：

```html
        :selected-node-ids="multiSelectedIds.length ? multiSelectedIds : (selectedNodeId ? [selectedNodeId] : [])"
```

`AgentSideRail.vue`：
1. props（`:158` 附近）把 `selectedNodeId?: string | null` 之后加 `selectedNodeIds?: string[]`；
2. payload（`:2071`）**删除** `focusNodeId: props.selectedNodeId || undefined,`，改为：

```ts
        // SEL-REF：指代信号是唯一新增上行字段；focusNodeId 由服务端派生，前端不再单独发。
        selectedNodeIds: bindingIds.value.length ? bindingIds.value : undefined,
```

3. 在发送函数里、发起请求**之前**冻结本轮快照（渲染回执的唯一数据源）：

```ts
    const bindingIds = props.selectedNodeIds?.slice() ?? []
    lastBinding.value = bindingIds.length ? { ids: bindingIds, label: `${bindingIds.length} 个节点` } : null
```

4. 在用户消息气泡旁渲染（气泡本体之后、工具卡之前）：

```html
        <AgentSelectionBindingChip
          v-if="lastBinding"
          :node-ids="lastBinding.ids"
          :nodes="props.canvasNodes"
        />
```

- [ ] **Step 6: 补 payload 快照测试**

在 `AgentSideRail` 既有的发送参数测试（若无则新建）里断言三态：框选 ⇒ 等于框选集合；单选 ⇒ 单元素数组；未选中 ⇒ `undefined`（**不是空数组**）；且 **payload 中不存在 `focusNodeId` 键**。

- [ ] **Step 7: 跑 web 测试 + 类型检查**

Run: `pnpm --filter @lnkpi/web test -- AgentSideRail AgentSelectionBindingChip && pnpm --filter @lnkpi/web exec vue-tsc -b --noEmit`
Expected: 全绿

- [ ] **Step 8: 提交**

```bash
git add apps/web/src/components/agent/AgentSelectionBindingChip.vue apps/web/src/components/agent/AgentSelectionBindingChip.test.ts apps/web/src/components/agent/AgentSideRail.vue apps/web/src/pages/CanvasPage.vue
git commit -m "feat(web): 发送 selectedNodeIds + 气泡旁渲染确定性回执 chip（SEL-REF R-S8）"
```

---

### Task 6: 规格修正 + 部署开关接线与端到端验收

**Files:**
- Modify: `docs/superpowers/specs/2026-10-06-selection-as-default-reference-design.md`（§5.2 去掉两行 runtime 增量，见下）
- Modify: `docs/README.md`（登记本 plan）
- Modify: `docs/superpowers/INDEX.md`（登记本 plan）

**Interfaces:**
- Consumes: Task 1–5 的全部产出
- Produces: 上线所需的开关值与验收记录

- [ ] **Step 1: 修正规格 §5.2 的 runtime 两行（本 plan 的核实结论）**

规划时核实到：digest 在 **Nest 侧**拼装（§5.5），模型只消费 `dynamicBlocks` 文本；回执由前端用**自己发出的 id 集合**渲染。因此 `turn.selectedNodeIds` 与 `app.ts` 的 `selectedNodeIds` **没有任何消费方**——加了就是规格自己（§5.2 末行 + §11「死字段」行）明令禁止的死字段。

在 §5.2 表格里删除这两行：

```ts
| runtime 入参 | `services/pi-runtime/src/app.ts` | 接收 `selectedNodeIds` 并写入 session turn state（`focusNodeId` 沿用现有兼容分支） |
| runtime 状态 | `services/pi-runtime/src/session-manager.ts` | `turn.selectedNodeIds` |
```

并在表格末尾补一行说明：

```ts
| runtime 侧 | — | **不需要**：`focusNodeId` 已由 Nest 派生并经既有 `turnContext.focusNodeId` 通道下发；digest 文本走 `dynamicBlocks`。V1 不在 runtime 侧加 `selectedNodeIds`（无消费方 ⇒ 死字段） |
```

§9 的文件级清单同步删掉 `services/pi-runtime/src/app.ts` 与 `session-manager.ts` 两行。

同时修正 §5.5 的**方法名错误**（规划时核实到）：该节写「复用已有 `getCanvasSummary({sessionId})`（`agent-canvas-tools.service.ts:845-856`）一次拿到全画布节点的 `id/type/title`」——`id/type/title` 属实，但**该方法不返回坐标**，而 S-8 要求按画布位置稳定排序。正确来源是 `getCanvasLayout({sessionId})`（同文件 `:2493`），它返回 `position` 与 `absolutePosition`，且同样走 `loadSession(sessionId)` ⇒ 归属校验不变。把 §5.5 表格里那一行改为：

```ts
| 节点 `type` / `title` / 坐标来源 | **复用已有 `getCanvasLayout({sessionId})`**（`agent-canvas-tools.service.ts:2493`）——它返回 `id/type/title/position/absolutePosition`。⛔ 不用 `getCanvasSummary`：其返回只有 `{id,type,title,status}`，**无坐标**。坐标取 **`absolutePosition`**（`position` 是相对父 group 的，打组后会漂） | 需新增一次回查 Nest 内部接口 |
```

- [ ] **Step 2: 确认两处登记仍在（spec 修订不应影响它们）**

本 plan 与它的落地 PR 已把登记写进 `docs/README.md` 与 `docs/superpowers/INDEX.md`。spec 修订只动规格正文，不应波及登记——当场确认：

Run: `git grep -n "2026-10-06-selection-as-default-reference" -- docs/README.md docs/superpowers/INDEX.md`
Expected: 两个文件各至少 1 行命中（spec + plan 各一条）

- [ ] **Step 3: 跑门禁**

Run: `pnpm verify-spec-figures && pnpm verify-claims && pnpm verify-links`
Expected: 0 错误 / 6:6 / 0 断链

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/specs/2026-10-06-selection-as-default-reference.md
git commit -m "docs(sel-ref): 规格 §5.2 去 runtime 死字段 + §5.5 改用 getCanvasLayout 取坐标"
```

- [ ] **Step 5:（人工，红线）生产开关接线**

> ⚠️ `AGENTS.md` 红线：改生产 env 属**必须先问人**的操作。以下两步由人执行，agent 不得自行触发。

```
1. 在主机 /opt/lnkpi/.env 追加：SEL_REF_ENABLED=off        # 先保持关
2. 改完执行：cd /opt/lnkpi && docker compose up -d --force-recreate api
```

`SEL_REF_ENABLED` 由 **Nest（api 容器）** 读取（Task 4 的 `agent.service.ts`），不是 pi-runtime，因此**不进 helm chart**，也**不需要** `runtime-deploy`。

- [ ] **Step 6: 端到端目视验收（关态基线）**

保持 `SEL_REF_ENABLED=off`，发一条「这个节点里面是什么」（先选中一个节点）。
Expected: 行为与上线前一致——**不出现回执 chip**，digest 块不出现。

- [ ] **Step 7: 端到端目视验收（开态）**

改为 `SEL_REF_ENABLED=on` + 重建 api 容器，逐条走规格 §10.2：

| 验收 | 操作 | 期望 |
|---|---|---|
| A-2 | 12 节点画布，单选后问「这个节点是什么」 | 回答对上所选节点（**今天必失败的回归点**） |
| A-6 | 框选 3 个后说「**这个**改一下」 | 回复**列出 3 个候选**且未绑定任一个 |
| A-3 | 框选 3 个后说「这几个统一风格」 | 复述对象数 = 3，且**未**自动开跑生成 |
| A-7 | 选中后说「直接改掉」 | 出现确认门 |
| A-8 | 任一带指代的请求 | 气泡旁有回执 chip，展开可见 id/type/title |
| A-11 | 同一选区连发两轮 | digest 块内容**逐字节相同** |

- [ ] **Step 8: 验收结论落文档**

把 Step 6/7 的实际结果追加到本 plan 末尾的「## 上线验收记录」小节（含日期、开关值、逐条通过/未通过）。未通过项不得留在"待办"，须当场定位根因或明确回滚（`SEL_REF_ENABLED=off` 即刻关停）。

---

## 上线顺序与回滚

| 阶段 | 动作 | 回滚 |
|---|---|---|
| 1–5 合并 | 代码进 master。`deploy.yml` 自动发 api+web；`runtime-deploy` **不自动**，需人工 dispatch（Task 2 改了 pi-runtime） | revert 对应 commit |
| 2 关态 | `SEL_REF_ENABLED=off`（默认） | 无需回滚，功能未开 |
| 3 开态灰度 | 置 `on` + 重建 api 容器，走 Step 7 验收 | **一行回滚**：`off` + 重建 api 容器（不需回滚镜像） |
| 4 转正 | 保留 `on`，把「默认 off」改为默认 on 需另开 PR + 改 `agent.service.ts` 的默认值 | 同上 |

## Review Focus 的测试落点（自检用）

| 输入/条件 | 期望行为 | 落在哪个 task 的哪一步 |
|---|---|---|
| 框选恰好 1 个 | 与单击等价 | Task 5 Step 5（CanvasPage 绑定表达式）＋ Step 6 payload 快照 |
| 标题含换行 / 超长 / 含 `·` | 不破坏块的行结构 | Task 1 Step 1「标题里的换行被压平」 |
| 选中后、发送前节点被删 | 剔除而非抛错 | Task 1 Step 1「无效 id 被剔除」＋ Step 3 的 `lookup` 语义 |
| `SEL_REF_ENABLED=true` / `ON` / 空 | 落 `off`（安全侧） | Task 4 Step 6 的 `it.each` 表 |
| 回执 chip 与实际节点不符 | 用本轮发出的 id 集合渲染 | Task 5 Step 5 的 `lastBinding` 冻结 ＋ Step 1 组件用例 |
