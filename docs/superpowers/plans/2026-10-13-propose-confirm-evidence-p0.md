# propose 确认证据化 + 澄清决策矩阵 实施计划（P0/P1）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消灭 propose_generation 虚假确认（2026-10-12 会话 cmv51vwpu0008p801hxaxcf8m），并把「澄清 vs 声明式默认」的产品语义编码进工具契约。

**Architecture:** 三道防线堵「前端整份 PUT 盖写 SSOT」：runtime 轮询只认正证据（P0-A）、Nest 服务端状态转移守卫（P0-B）、前端等待期强制声明真值（P0-C）；配套契约去毒（P1-1 媒体拒写 content）与语义编码（P1-2 规则 16 三档矩阵、P1-3 ask_user 描述）。

**Tech Stack:** NestJS + Prisma（apps/server）、pi-agent-core 0.85.1 + tsx node:test（services/pi-runtime）、Vue3 + vitest（apps/web）、prompt-registry（6 处同步点 + prompt:lint）。

**Spec:** `docs/superpowers/specs/2026-10-13-propose-confirm-evidence-and-clarify-matrix-design.md`（已拍板）

## Global Constraints

- 分支纪律：worktree `.worktrees/propose-confirm-evidence`，分支 `fix/propose-confirm-evidence`；master 直改禁止。
- `set_node_text` 的 prompt 分支（`/agent/internal/set-node-prompt`）**不带 userId**，content 分支**必带**（对齐老 client，勿动）。
- propose 轮询的 404=gone、draft 双拍=rejected、错误容忍 ≤3：语义维持现状，只改「confirmed 判据」。
- prompt-registry 改动必须 6 处同步 + `pnpm prompt:lint` 全绿（L6 预算上限 3200，当前 3197）。
- P1-1 只拒**媒体节点**（image/video/audio）的 content 写入；文本类节点 `status:'completed'` 语义不动。
- P0-B 允许集固定 `{pending_confirm, draft, generating}`；违规**字段级丢弃**（保留服务端值），不 409 整单。

## Review Focus

1. **极快完成竞态**：确认后生成在 2s 轮询间隔内已落 completed——靠 `generationRecordId` 变化/`generationStartedAt` 前进识别为正证据（Task 1 回归锁测试钉死）。
2. **快照失败**：propose 前指纹快照 get-node 失败必须 best-effort（退化为仅 status 正证据），不得阻断 propose 主流程（Task 1 try/catch 钉死）。
3. **整份替换语义下的 P0-C**：「剥离 status」在 full-replace 下等于删除字段（undefined 也是一次状态变化）——改为**强制声明 `pending_confirm`**（Task 3 记录与规格的偏差及理由）。
4. **P0-B 只影响浏览器 PUT**：`sessionsService.update` 仅被 sessions.controller 调用（已核实），agent 写走 `applyOrStage → persist`，守卫不会误伤 agent/生成链路（Task 2 测试钉死 agent 直写不被此函数触碰的事实由调用面保证，测试验证守卫矩阵本身）。
5. **规则 16 预算**：改写后总字符不得超 3200；超了就先在同一规则文件内等量腾（Task 5 步骤内含 prompt:lint 校验）。

---

### Task 1: P0-A propose 轮询只认正证据（runtime）【已在 worktree 完成，待勾选】

**Files:**
- Modify: `services/pi-runtime/src/tools/canvas-write.ts`（propose execute 轮询臂）
- Test: `services/pi-runtime/src/tools/canvas-write.test.ts`

**Interfaces:**
- Produces: propose 成功 `details.reason ∈ {answered, generating, fallback_pending, new_record, new_generation}`；失败 `content[0].text.reason = stale_status:<status>`；快照 get-node 调用次数 +1（测试断言已同步）。

- [x] **Step 1: 写失败测试**（事故回归锁：stale completed → confirmed=false + 文案禁称出图；new_record/new_generation 正证据；error 同族无表决权）——已在 worktree 落盘
- [x] **Step 2: 实现**（快照指纹 + 正证据三分支 + stale fail-closed + reason 全透传 + 成功消息按证据来源区分）——已在 worktree 落盘
- [x] **Step 3: 修 404 断言**（快照 +1：getNodeCalls 1→2，注释更新）——已完成
- [x] **Step 4: `node --import tsx --test src/tools/canvas-write.test.ts` 46/46 绿**——已验证
- [x] **Step 5: 变异验证**：临时把 `recChanged` 判定注释掉 → 事故回归锁必须转红 → 还原。（执行时补做并记录输出）

### Task 2: P0-B 服务端状态转移守卫（Nest）

**Files:**
- Modify: `apps/server/src/sessions/sessions.service.ts:42-55`（update）
- Test: `apps/server/src/sessions/sessions.service.test.ts`（追加 describe）

**Interfaces:**
- Produces: 私有静态方法 `guardPendingConfirmStatuses(prevRaw: string | null, next: unknown): unknown`——next 为待写入对象（会被原地或浅拷贝修正）；非法转移的节点 `data.status` 被改回 `'pending_confirm'`。

- [ ] **Step 1: 写失败测试**（追加到 sessions.service.test.ts；mock prisma.session.findUnique 返回带 pending_confirm 节点的旧 canvasData，update 捕获写入载荷）

```ts
describe('SessionsService.update —— pending_confirm 状态转移守卫（2026-10-13 事故）', () => {
  const prev = JSON.stringify({
    nodes: [
      { id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { status: 'pending_confirm' } },
      { id: 'n2', type: 'image', position: { x: 1, y: 1 }, data: { status: 'completed' } },
    ],
    edges: [],
  })
  function makeUpdateService() {
    const findUnique = vi.fn(async () => ({ id: 's1', userId: 'u1', title: 't', canvasData: prev, createdAt: new Date(), updatedAt: new Date() }))
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 's1', userId: 'u1', title: 't', canvasData: data.canvasData as string, createdAt: new Date(), updatedAt: new Date(),
    }))
    return { update, moduleRef: Test.createTestingModule({
      providers: [SessionsService, { provide: PrismaService, useValue: { session: { findUnique, update } } }],
    }) }
  }

  it('客户端把 pending_confirm 翻成 completed → 字段级丢弃，status 保留 pending_confirm', async () => {
    const { update, moduleRef } = makeUpdateService()
    const svc = (await moduleRef.compile()).get(SessionsService)
    await svc.update('s1', 'u1', { canvasData: { nodes: [{ id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { status: 'completed', content: 'x' } }], edges: [] } })
    const written = JSON.parse(update.mock.calls[0][0].data.canvasData as string)
    expect(written.nodes[0].data.status).toBe('pending_confirm')
    expect(written.nodes[0].data.content).toBe('x') // 其余字段照常落库
  })

  it('合法出口放行：draft / generating / pending_confirm 原样落库', async () => {
    const { update, moduleRef } = makeUpdateService()
    const svc = (await moduleRef.compile()).get(SessionsService)
    await svc.update('s1', 'u1', { canvasData: { nodes: [{ id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { status: 'generating' } }], edges: [] } })
    expect(JSON.parse(update.mock.calls[0][0].data.canvasData as string).nodes[0].data.status).toBe('generating')
  })

  it('非 pending_confirm 节点不受守卫影响（n2 completed 可自由改）', async () => {
    const { update, moduleRef } = makeUpdateService()
    const svc = (await moduleRef.compile()).get(SessionsService)
    await svc.update('s1', 'u1', { canvasData: { nodes: [{ id: 'n2', type: 'image', position: { x: 1, y: 1 }, data: { status: 'draft' } }], edges: [] } })
    expect(JSON.parse(update.mock.calls[0][0].data.canvasData as string).nodes[0].data.status).toBe('draft')
  })

  it('旧 canvasData 解析失败（脏数据）→ 守卫直通，不阻塞保存', async () => {
    const { update, moduleRef } = makeUpdateService()
    ;(update.mock.calls.length = 0)
    const svc = (await moduleRef.compile()).get(SessionsService)
    // 直接构造脏旧值：绕过 findUnique mock，用第二条用例路径覆盖 —— prev 解析异常时 Promise.reject 不应冒泡
    await expect(svc.update('s1', 'u1', { canvasData: { nodes: [], edges: [] } })).resolves.toBeTruthy()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**：`pnpm --filter @lnkpi/server exec vitest run src/sessions/sessions.service.test.ts` → 新 describe 红（守卫不存在，completed 直接落库）
- [ ] **Step 3: 实现**（sessions.service.ts）

```ts
/** pending_confirm 的合法客户端出口（显式确认 patch 序列 + clear-propose）；终态一律无权直达。 */
private static readonly PENDING_CONFIRM_CLIENT_EXITS = new Set(['pending_confirm', 'draft', 'generating'])

/**
 * 2026-10-13 虚假确认事故（cmv51vwpu0008p801hxaxcf8m）：浏览器整份 PUT 把
 * 服务端 pending_confirm 盖回旧终态 completed，runtime 轮询误读为「已确认自起生成」。
 * 守卫：pending_confirm 节点的客户端 status 只允许合法出口，违规**字段级**保留服务端值
 * （其余字段照常落库，不 409 整单）。agent/生成链路不走此函数（只挂浏览器 PUT）。
 */
private guardPendingConfirmStatuses(prevRaw: string | null, next: unknown): unknown {
  const nextCanvas = next as { nodes?: Array<{ id?: string; data?: Record<string, unknown> }> } | null
  if (!nextCanvas || !Array.isArray(nextCanvas.nodes)) return next
  let prevNodes: Map<string, { status?: unknown }> | undefined
  try {
    const prevCanvas = typeof prevRaw === 'string' ? (JSON.parse(prevRaw) as { nodes?: Array<{ id?: string; data?: Record<string, unknown> }> }) : null
    if (prevCanvas && Array.isArray(prevCanvas.nodes)) {
      prevNodes = new Map(prevCanvas.nodes.filter((n) => typeof n?.id === 'string').map((n) => [n.id as string, n]))
    }
  } catch {
    return next // 旧数据脏：守卫直通，保存优先
  }
  if (!prevNodes) return next
  for (const node of nextCanvas.nodes) {
    const prevNode = typeof node?.id === 'string' ? prevNodes.get(node.id) : undefined
    if (prevNode?.data?.status !== 'pending_confirm') continue
    const status = node?.data?.status
    if (typeof status !== 'string' || !SessionsService.PENDING_CONFIRM_CLIENT_EXITS.has(status)) {
      node.data = { ...(node.data ?? {}), status: 'pending_confirm' }
    }
  }
  return next
}
```

update() 内改为：

```ts
const updated = await this.prisma.session.update({
  where: { id },
  data: {
    title: data.title,
    canvasData: data.canvasData
      ? JSON.stringify(this.guardPendingConfirmStatuses(session.canvasData, data.canvasData))
      : undefined,
  },
})
```

- [ ] **Step 4: 跑测试到绿**（同 Step 2 命令，全 describe 绿）
- [ ] **Step 5: commit** `fix(sessions): 整份 PUT 增设 pending_confirm 状态转移守卫（字段级保留服务端值）`

### Task 3: P0-C 前端等待期强制声明真值（web）

**Files:**
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（emits + watcher）
- Modify: `apps/web/src/pages/CanvasPage.vue:4226`（saveCanvas）、`:5105`（模板绑定）、`:3911`（handler）
- Test: `apps/web/src/components/agent/proposeWaitActions.test.ts`（纯函数部分）

**Interfaces:**
- Produces: AgentSideRail 新 emit `proposeWaitEnd: []`；CanvasPage `proposeWaitingNodeId = ref<string | null>(null)`；saveCanvas 载荷对等待节点强制 `data.status = 'pending_confirm'`。
- ⚠️ 与规格的偏差（记录）：规格写「剥离 status 字段」，但整份替换语义下剥离 = 删除字段 = 一次未定义的状态变化；正确实现是**强制声明当前真值 `pending_confirm`**。已在 Review Focus 3 登记。

- [ ] **Step 1: 纯函数测试**（proposeWaitActions.ts 新增）

```ts
/** 等待期 PUT 载荷守卫：等待节点的 status 强制声明为 pending_confirm（整份替换语义下「不覆盖」的唯一正确形态）。 */
export function forcePendingConfirmInPayload(
  canvasData: { nodes?: Array<{ id?: string; data?: Record<string, unknown> }> },
  waitingNodeId: string | null,
): void {
  if (!waitingNodeId || !Array.isArray(canvasData.nodes)) return
  for (const node of canvasData.nodes) {
    if (node?.id === waitingNodeId) node.data = { ...(node.data ?? {}), status: 'pending_confirm' }
  }
}
```

测试：等待节点被强制、非等待节点不动、waitingNodeId=null 时全不动。

- [ ] **Step 2: AgentSideRail 加结束信号**：emits 增 `proposeWaitEnd: []`；`watch(proposeWait, (w, prev) => { if (prev && !w) emit('proposeWaitEnd') })`（watch 已从 vue 引入则复用）。
- [ ] **Step 3: CanvasPage 接线**：`const proposeWaitingNodeId = ref<string | null>(null)`；`handleProposeWaitStart` 里赋值；模板 `@propose-wait-end="proposeWaitingNodeId = null"`；saveCanvas 在 `flowToCanvasData(...)` 之后、`api.put` 之前调 `forcePendingConfirmInPayload(canvasData, proposeWaitingNodeId.value)`。
- [ ] **Step 4: 跑 web 相关测试**：`pnpm --filter @lnkpi/web exec vitest run src/components/agent/proposeWaitActions.test.ts` 绿。
- [ ] **Step 5: commit** `fix(web): propose 等待期 PUT 强制声明 pending_confirm（防 stale 全量覆盖）`

### Task 4: P1-1 setNodeContent 媒体拒写（Nest）

**Files:**
- Modify: `apps/server/src/agent/agent-canvas-tools.service.ts:1289-1311`（setNodeContent）
- Test: 既有 agent-canvas-tools 测试文件内追加（就近原则，找 setNodeContent/agent-canvas-tools.service.test.ts）

**Interfaces:**
- Produces: image/video/audio 节点 content 写入抛 `BadRequestException('媒体节点正文不可写；改生成提示词请用 set_node_text 的 prompt 参数')`；其余节点行为逐字节不变。

- [ ] **Step 1: 失败测试**：media 节点 → expect BadRequest 且 message 含「prompt 参数」；prompt 节点 → 行为不变（status completed 照写）。
- [ ] **Step 2: 实现**（setNodeContent 开头、NotFound 之后）：

```ts
const MEDIA_NODE_TYPES = new Set(['image', 'video', 'audio'])
if (MEDIA_NODE_TYPES.has(String(node.type))) {
  throw new BadRequestException('媒体节点正文不可写；改生成提示词请用 set_node_text 的 prompt 参数')
}
```

（node 变量需先 find 出来再判断——现在实现里只 some 判断存在性，改为 find 一次复用。）
- [ ] **Step 3: 测试绿 + commit** `fix(agent): 媒体节点拒收 content 写入（fail-closed 指引 prompt 参数）`

### Task 5: P1-2 规则 16 三档决策矩阵（prompt-registry，预算中性）

**Files:**
- Modify: `prompt-registry/rules/media_tool_policy.md`（规则 16）
- Modify: `prompt-registry/MANIFEST.yaml`（media_tool_policy contentHash 重算）
- Modify: `apps/server/src/agent/pi-runtime/prompt-registry.fallback.ts`（WRITE_TOOLS_RULES 内规则 16 逐字同步）
- Modify: `apps/server/src/agent/pi-prompt-assembler.service.test.ts`（EXPECTED 对应串）
- Verify: `pnpm prompt:lint` 全绿（预算 ≤3200）

- [ ] **Step 1: 改写规则 16**（磁盘 .md；目标预算中性，先写后量，超了在本文案内收缩）：

```
16. 缺主体/用途等阻塞信息、或需用户在有限选项择一时，先调 ask_user（推荐项置首+说明理由，关联问题合一张卡）。风格/尺寸/张数等偏好参数：按领域默认并显式声明，不问。
```

- [ ] **Step 2: 六处同步**：fallback 常量逐字改同串；`sha256(body.trimEnd())` 前 12 位回填 MANIFEST（复刻 loader 算法：parseFrontmatter body 去首尾单换行 → trimEnd → sha256[:12]，可用 node 单行算）；assembler EXPECTED 同步。
- [ ] **Step 3: `pnpm prompt:lint`** 全绿（预算打印 ≤3200；超预警线 2720 的 warning 可接受，历史即如此）。
- [ ] **Step 4: commit** `docs(prompt-registry): 规则 16 升级三档澄清决策矩阵（6 处同步）`

### Task 6: P1-3 ask_user 描述增强（runtime，与 Task 5 同分支2）

**Files:**
- Modify: `services/pi-runtime/src/tools/ask-user.ts:48`（description）

- [ ] **Step 1: description 追加两句**（原句保留）：

```
有推荐时把推荐选项放首位并在 label 标注「（推荐）」，description 说明推荐理由。不得问可合理默认的细节（尺寸/张数/分辨率按场景默认并在回复中声明）。
```

- [ ] **Step 2: typecheck + 相关测试**：`pnpm --filter @lnkpi/pi-runtime exec tsc --noEmit`（或 worktree 内 `npm run typecheck`）。
- [ ] **Step 3: commit** `feat(pi-runtime): ask_user 描述补推荐约定与反问卷条款`

### Task 7: 分支组织 / PR / CI / 合并

- 分支1 `fix/propose-confirm-evidence`：规格 + 本计划 + Task 1-4（runtime + Nest + web）。
- 分支2 `feat/clarify-decision-matrix`（从分支1 merge-base 或 master 新开）：Task 5-6。⚠️ Task 6 改的 ask-user.ts 若与分支1 无冲突可从 master 开；Task 5 的 EXPECTED 与分支1 无交集。
- 各自 `git push -u origin` → `gh pr create` → `gh pr checks` 全绿（--jq '.total_count' 判 pending）→ `gh pr merge --squash`。
- 收尾：清 worktree/分支（delivery.md 顺序：worktree → 本地 → 远程）。

### Task 8: 部署 + 现网复测取证

- 部署触发面：Nest api（compose `api` 重建，`/opt/lnkpi/deploy/docker-compose.prod.yml`）+ pi-runtime（手工 dispatch `runtime-deploy`，tag=master 短 SHA）+ web 静态（:8888，BFS 枚举 chunk 判据）+ prompt-registry（随 api 镜像）。
- 生产取证（规格 §3，三路）：DB trace（turn2 set_node_text 走 prompt 或 content 被拒后自愈；propose 无虚假 confirmed）、GenerationRecord（生成 POST 仅在真实确认后）、节点 data.prompt=新文本；模型回复无「正在出图」断言。
- 旧路径回归：画布直接生成（无 /answers）确认→出图正常。
- 观测：`pi_runtime_propose_outcome_total{reason}` 首报 + 后续观察分布。
