# 画布节点 CRUD 契约补全 + 新建画布去种子 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent 具备「改节点名 / 改节点 dock 提示词 / 改节点芯片 / 增删改上下游关系」四项完整能力且改动对用户实时可见，同时让新建画布不再自动产生提示词节点。

**Architecture:** 三层各自补一小块，不改架构：① Nest `agent-canvas-tools.service` 新增 2 个 internal 端点（`update-node` / `list-model-options`）、扩展 3 个既有方法的返回体与归属校验；② pi-runtime 新增 3 个工具，并把「Nest 返回的 `actions` 放进 `details.actions`」从 `delete_nodes` 单点推广到全部写工具（这是实时通道的真正断点）；③ 前端补 `applyActionsToFlow` 缺的两个 action 分支。服务端始终是唯一写者，实时推送只是提前预览，回合末全量回拉兜底。

**Tech Stack:** TypeScript / NestJS（vitest）/ fastify + vendored pi-agent-core（node:test）/ Vue 3 + Vue Flow（vitest）/ zod + TypeBox / pnpm workspace monorepo。

**Spec:** `docs/superpowers/specs/2026-09-29-canvas-node-crud-completeness-design.md`

## Global Constraints

- 无数据库 schema 变更、无 migration、无存量数据回填（spec §7）。
- `update_node` 的白名单**只允许** `title` + 节点自身模态的模型字段；**禁止**写 `prompt` / `content` / `status` / `generationRecordId` / `manifestKey` / `position`（spec §4.1）。
- 工具入参一律 snake_case，HTTP body 一律 camelCase（全仓既有约定）。
- `sessionId` / `userId` **只取 `toolContext`**，绝不出现在模型可见的 parameter schema 里；需 `userId` 的工具缺身份即 fail-closed（全仓既有安全模型）。
- 工具 tier：`update_node` = `write_light`，`list_model_options` = `read`，`remove_edges` = `write_light`（spec §4.3）。
- pi-runtime 工具总数终态：**39（无 TAVILY）/ 41（有 TAVILY）**。
- 本地测试命令固定为：`pnpm -C services/pi-runtime test`（node --test）、`pnpm -C apps/server test`（vitest）、`pnpm -C apps/web test`、`pnpm -C packages/shared test`。
- **禁止并行跑 pi-runtime 与 apps/server 套件**（资源竞争 SIGKILL 137）。
- **禁止 `pnpm test | grep | head`**（SIGPIPE 使 vitest 提前退出产生假结果）——须 `> log 2>&1` 再 grep。
- 本机已知 flake：`apps/server/src/agent/upstream-ref-inline.test.ts`、`membership.usage.sqlite.integration.test.ts` —— 加 `--hookTimeout=120000` 可过，不计入失败。
- 部署顺序铁律：**deploy-api 绿 → helm upgrade pi-runtime → deploy-web**（spec §10.3）。新工具会打新 Nest 端点，先上 pi-runtime 必 404。

## Review Focus

按"最可能咬到使用者"排序，五条 spec 隐含但无任务测试覆盖的输入/条件：

1. **`update_node` 对不存在或跨账号的 `nodeId`** —— 使用者期望被明确拒绝，而不是静默成功或 500。归属与存在性必须走 `loadOwnedSession` + 显式 `NotFoundException`。
2. **`remove_edges` 传入不存在的 `edgeId`** —— 使用者期望"幂等成功"而非报错（画布已经被别人删了这条边的情形很常见）。服务端跳过不存在的边并只返回实际删除的 actions。
3. **空画布（0 节点）下的全部读路径** —— `get_canvas_summary` / `get_canvas_layout` / `get_node` / `list_model_options` 都必须正常返回空结果而不是抛错；去掉种子后这是默认状态。
4. **`update_node` 传入 `null` / `""` / 只有空白的 `title`** —— 使用者期望"不生效"或明确拒绝，而不是把节点标题清成空串。
5. **`list_model_options` 在用户没有任何 BYOK 渠道、且偏好行尚未建立时** —— 期望返回平台目录（惰性 `ensurePreferences`），而不是空列表或抛错。

---

### Task 1: 共享纯函数 `normalizeModelRef` + web 侧委托

**Files:**
- Modify: `packages/shared/src/studioModelCatalog.ts`（在 `resolveModelKey` 之后追加）
- Test: `packages/shared/src/studioModelCatalog.test.ts`
- Modify: `apps/web/src/constants/studioModels.ts:38-48`

**Interfaces:**
- Consumes: 既有的 `resolveModelKey` / `defaultModelKey` / `encodeChannelModel` / `decodeChannelModel`（同文件与 `providerChannels.ts`）
- Produces:
  ```ts
  export function normalizeModelRef(
    modality: StudioModality,
    raw?: string | null,
  ): { ref: string; channelId: string; modelName: string; fallback: boolean } | null
  ```
  语义：`raw` 空 → `null`；已编码（含 `::`）→ 原样返回且 `fallback: false`；裸名命中目录 → `platform::<modelKey>` 且 `fallback: false`；裸名未命中 → 回落 `platform::<defaultModelKey>` 且 `fallback: true`（**调用方必须据此拒绝，不得静默采用**）。

- [ ] **Step 1: 写失败测试**

追加到 `packages/shared/src/studioModelCatalog.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import {
  defaultModelKey,
  encodeChannelModel,
  normalizeModelRef,
  resolveModelKey,
} from './studioModelCatalog'

describe('normalizeModelRef', () => {
  it('空值 → null', () => {
    expect(normalizeModelRef('image', undefined)).toBeNull()
    expect(normalizeModelRef('image', '')).toBeNull()
    expect(normalizeModelRef('image', '   ')).toBeNull()
  })

  it('已编码 ref 原样通过（BYOK 渠道不被改写）', () => {
    const out = normalizeModelRef('image', 'ch_byok_1::some-model')
    expect(out).toEqual({
      ref: 'ch_byok_1::some-model',
      channelId: 'ch_byok_1',
      modelName: 'some-model',
      fallback: false,
    })
  })

  it('裸名命中目录 → 归一为 platform::<modelKey>', () => {
    const known = resolveModelKey('image', 'seedream-4').modelKey
    const out = normalizeModelRef('image', known)
    expect(out).toEqual({
      ref: encodeChannelModel('platform', known),
      channelId: 'platform',
      modelName: known,
      fallback: false,
    })
  })

  it('裸名未命中 → fallback:true（调用方据此拒绝，不静默采用）', () => {
    const out = normalizeModelRef('image', '完全不存在的模型-xyz')
    expect(out?.fallback).toBe(true)
    expect(out?.ref).toBe(encodeChannelModel('platform', defaultModelKey('image')))
  })

  it('跨模态裸名（video 名传给 image）也判 fallback', () => {
    const videoKey = resolveModelKey('video', defaultModelKey('video')).modelKey
    expect(normalizeModelRef('image', videoKey)?.fallback).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C packages/shared test -- studioModelCatalog`
Expected: FAIL —— `normalizeModelRef is not a function`

- [ ] **Step 3: 实现**

在 `packages/shared/src/studioModelCatalog.ts` 的 `resolveModelKey` 之后追加：

```ts
/**
 * 模型 ref 归一（SSOT）：把「裸模型名 / 已编码 ref / 空值」统一成一种可比较的形态。
 *
 * 调用方（agent 的 update_node、web 的 resolveGenerationModel）**必须**检查 `fallback`：
 * 它为 true 说明裸名不在目录中，此时返回的 ref 是**默认模型**而非用户要的那个——
 * 静默采用会把「设错了模型」伪装成「设置成功」。
 */
export function normalizeModelRef(
  modality: StudioModality,
  raw?: string | null,
): { ref: string; channelId: string; modelName: string; fallback: boolean } | null {
  const trimmed = raw?.trim()
  if (!trimmed) return null
  const decoded = decodeChannelModel(trimmed)
  if (decoded) {
    return {
      ref: trimmed,
      channelId: decoded.channelId,
      modelName: decoded.modelName,
      fallback: false,
    }
  }
  const { modelKey, fallback } = resolveModelKey(modality, trimmed)
  return {
    ref: encodeChannelModel(PLATFORM_CHANNEL_ID, modelKey),
    channelId: PLATFORM_CHANNEL_ID,
    modelName: modelKey,
    fallback,
  }
}
```

若 `PLATFORM_CHANNEL_ID` 与 `decodeChannelModel` 尚未在本文件 import，补齐 import（两者都在 `./providerChannels`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C packages/shared test -- studioModelCatalog`
Expected: PASS（新增 5 例 + 存量全绿）

- [ ] **Step 5: web 侧改为委托（消除即将出现的第三份归一逻辑）**

`apps/web/src/constants/studioModels.ts` 现有实现：

```ts
export function resolveGenerationModel(
  modality: StudioModality,
  requested?: string | null,
): string {
  const trimmed = requested?.trim()
  if (trimmed) {
    if (decodeChannelModel(trimmed)) return trimmed
    return encodeChannelModel('platform', resolveModelKey(modality, trimmed).modelKey)
  }
  return encodeChannelModel('platform', defaultModelKey(modality))
}
```

改为：

```ts
/**
 * 节点级生成模型解析：有值时归一（委托 shared 的 SSOT），无值时回落到平台默认。
 * ⚠️ 与 agent 侧 update_node 共用 normalizeModelRef，勿在组件里重写判定。
 */
export function resolveGenerationModel(
  modality: StudioModality,
  requested?: string | null,
): string {
  const normalized = normalizeModelRef(modality, requested)
  if (normalized) return normalized.ref
  return encodeChannelModel('platform', defaultModelKey(modality))
}
```

- [ ] **Step 6: 跑 web 相关测试确认行为不变**

Run: `pnpm -C apps/web test -- studioModels`
Expected: PASS（既有 `resolveGenerationModel` 行为回归不变）

- [ ] **Step 7: 提交**

```bash
git add packages/shared/src/studioModelCatalog.ts packages/shared/src/studioModelCatalog.test.ts apps/web/src/constants/studioModels.ts
git commit -m "feat(shared): normalizeModelRef 收敛模型 ref 归一逻辑（web 侧委托）"
```

---

### Task 2: 去掉 seed ①②，锁住 seed ③

**Files:**
- Modify: `apps/web/src/pages/CanvasPage.vue:4165-4186`
- Modify: `apps/server/src/sessions/sessions.service.ts:8-32`
- Modify: `apps/server/src/sessions/sessions.controller.ts:7-32`
- Modify: `apps/web/src/services/sessions-api.ts:6-7`
- Modify: `apps/web/src/pages/WorkflowPage.vue:238-258`
- Test: `apps/server/src/sessions/sessions.service.test.ts`（新建）
- Test: `apps/server/src/stories/stories.service.test.ts`（新建）

**Interfaces:**
- Produces: `SessionsService.create(userId: string, title?: string): Promise<...>`（**去掉第三参 `prompt`**）；`CanvasData | null` 一律为 `null`
- Produces: `sessionsApi.create({ title?: string })`
- Consumes: 不动 `StoriesService.create`（行为必须保持）

- [ ] **Step 1: 写失败测试（sessions）**

新建 `apps/server/src/sessions/sessions.service.test.ts`：

```ts
import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { PrismaService } from '../prisma/prisma.service'
import { SessionsService } from './sessions.service'

function makeService() {
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 's1',
    title: (data.title as string) ?? '未命名画布',
    userId: data.userId as string,
    canvasData: (data.canvasData as string | null) ?? null,
    createdAt: new Date('2026-09-29T00:00:00Z'),
    updatedAt: new Date('2026-09-29T00:00:00Z'),
  }))
  return {
    create,
    moduleRef: Test.createTestingModule({
      providers: [SessionsService, { provide: PrismaService, useValue: { session: { create } } }],
    }),
  }
}

describe('SessionsService.create —— 新建画布不种提示词节点（spec 场景 A/B）', () => {
  it('canvasData 恒为 null（不再种 prompt-1）', async () => {
    const { create, moduleRef } = makeService()
    const svc = (await moduleRef.compile()).get(SessionsService)
    const out = await svc.create('u1', '未命名画布')
    expect(create).toHaveBeenCalledOnce()
    const data = create.mock.calls[0][0].data as Record<string, unknown>
    expect(data.canvasData).toBeUndefined()
    expect(JSON.stringify(data)).not.toContain('prompt-1')
    expect(JSON.stringify(data)).not.toContain('描述你的创意场景')
    expect(out.title).toBe('未命名画布')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/server test -- sessions.service`
Expected: FAIL —— 收到 `canvasData: '{"nodes":[{"id":"prompt-1"...}]}'`（断言 `toBeUndefined()` 失败）

- [ ] **Step 3: 实现（去掉 ②）**

`apps/server/src/sessions/sessions.service.ts` 的 `create` 改为：

```ts
  /**
   * 新建画布：**不种任何初始节点**（2026-09-29 拍板）。
   * 历史上带 prompt 时会种一个 prompt-1 提示词节点；用户输入的内容改由
   * `initialPrompt` query 预填到侧栏输入框（CanvasPage.consumeAgentLaunchQuery），
   * 故此处删除该种子不丢内容。见 spec 场景 A/B。
   */
  async create(userId: string, title?: string) {
    const session = await this.prisma.session.create({
      data: {
        userId,
        title: title || '未命名画布',
      },
    })

    return this.formatSession(session)
  }
```

`apps/server/src/sessions/sessions.controller.ts`：`CreateSessionDto` 删掉 `prompt` 字段，`create` 调用改 `this.sessionsService.create(req.user.sub, dto.title)`。

> `ValidationPipe({ whitelist: true })` 无 `forbidNonWhitelisted`，旧调用方传 `prompt` 只会被静默剔除，不会 400。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C apps/server test -- sessions.service`
Expected: PASS

- [ ] **Step 5: 写 seed ③ 回归锁测试**

新建 `apps/server/src/stories/stories.service.test.ts`：

```ts
import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { PrismaService } from '../prisma/prisma.service'
import { StoriesService } from './stories.service'

describe('StoriesService.create —— 剧集画布仍种提示词节点（spec 场景 C，回归锁）', () => {
  it('把 synopsis 种成 prompt-1（本包不允许被「统一成空画布」误伤）', async () => {
    const sessionCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 's1',
      userId: data.userId as string,
      canvasData: data.canvasData as string,
    }))
    const storyCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'st1',
      ...data,
    }))
    const moduleRef = await Test.createTestingModule({
      providers: [
        StoriesService,
        { provide: PrismaService, useValue: { session: { create: sessionCreate }, story: { create: storyCreate } } },
      ],
    }).compile()
    const svc = moduleRef.get(StoriesService)

    await svc.create('u1', { title: '测试剧', synopsis: '三集悬疑剧', episodeCount: 3 })

    const canvasData = sessionCreate.mock.calls[0][0].data.canvasData as string
    const parsed = JSON.parse(canvasData) as { nodes: Array<{ id: string; type: string; data: { prompt: string } }> }
    expect(parsed.nodes).toHaveLength(1)
    expect(parsed.nodes[0].id).toBe('prompt-1')
    expect(parsed.nodes[0].type).toBe('prompt')
    expect(parsed.nodes[0].data.prompt).toBe('三集悬疑剧')
  })

  it('未填 synopsis 时回落 title', async () => {
    const sessionCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 's1',
      userId: data.userId as string,
      canvasData: data.canvasData as string,
    }))
    const storyCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'st1', ...data }))
    const moduleRef = await Test.createTestingModule({
      providers: [
        StoriesService,
        { provide: PrismaService, useValue: { session: { create: sessionCreate }, story: { create: storyCreate } } },
      ],
    }).compile()

    await moduleRef.get(StoriesService).create('u1', { title: '仅标题' })

    const parsed = JSON.parse(sessionCreate.mock.calls[0][0].data.canvasData as string) as {
      nodes: Array<{ data: { prompt: string } }>
    }
    expect(parsed.nodes[0].data.prompt).toBe('仅标题')
  })
})
```

- [ ] **Step 6: 跑测试确认通过（③ 行为未被破坏）**

Run: `pnpm -C apps/server test -- stories.service`
Expected: PASS

- [ ] **Step 7: 前端去掉 ①（前端占位 + catch 伪造）**

`apps/web/src/pages/CanvasPage.vue` 的 `loadSession()` 中，`else` 与 `catch` 两处改为：

```ts
    } else {
      nodes.value = []
      edges.value = []
      nodeCounter = 0
      compositionRunGroup.value = null
      lastKnownCompositionRunGroup.value = null
    }
  } catch {
    // 不再伪造 prompt-1 占位节点：那是本地假数据，用户一旦拖动就会触发
    // saveCanvas() 把假节点 PUT 覆盖掉服务端真画布（静默数据丢失）。
    nodes.value = []
    edges.value = []
    nodeCounter = 0
    compositionRunGroup.value = null
    lastKnownCompositionRunGroup.value = null
    ElMessage.error('画布加载失败，请刷新重试')
  }
```

- [ ] **Step 8: 前端停止传 `prompt`**

`apps/web/src/services/sessions-api.ts`：

```ts
  create: (data: { title?: string }) => api.post<{ data: Session }>('/sessions', data),
```

`apps/web/src/pages/WorkflowPage.vue` 的 `createCanvas()` 里：

```ts
    const { data } = await sessionsApi.create({
      title: prompt.value || '未命名画布',
    })
```

（`initialPrompt` query 逻辑保持不变 —— brief 由此进入侧栏输入框。）

- [ ] **Step 9: 类型检查 + 提交**

Run: `pnpm -C apps/web exec vue-tsc -b --noEmit` 与 `pnpm -C apps/server exec tsc --noEmit`
Expected: 无错误（若 `prompt` 在别处被引用会在此暴露）

```bash
git add apps/web/src/pages/CanvasPage.vue apps/web/src/services/sessions-api.ts apps/web/src/pages/WorkflowPage.vue apps/server/src/sessions apps/server/src/stories
git commit -m "feat(canvas): 新建画布不再种提示词节点（去占位与 brief 种子，锁住剧集种子）"
```

---

### Task 3: Nest 纯函数 `validateNodePatch` + `relationsForNode`

**Files:**
- Modify: `apps/server/src/agent/agent-canvas-tools.service.ts`（模块级函数区，`function nodeStatus` 之后）
- Test: `apps/server/src/agent/agent-node-patch.test.ts`（新建）

**Interfaces:**
- Produces:
  ```ts
  export const UPDATE_NODE_WRITABLE_FIELDS = ['title', 'imageModel', 'videoModel', 'textModel', 'audioModel'] as const

  export type NodeModal = 'image' | 'video' | 'text' | 'audio'
  /** 节点类型 → 允许写哪个模型字段 */
  export const NODE_TYPE_MODEL_FIELD: Record<string, { field: string; modality: NodeModal }>

  export type NodePatchValidation =
    | { ok: true; data: Record<string, unknown> }
    | { ok: false; reason: string; allowed?: string[] }

  export function validateNodePatch(input: {
    patch: Record<string, unknown>
    node: { type?: string; data?: Record<string, unknown> }
    selectable: Record<NodeModal, string[]>
  }): NodePatchValidation

  export function relationsForNode(
    canvas: { nodes: CanvasNode[]; edges: CanvasEdge[] },
    nodeId: string,
  ): { upstream: Array<{ id: string; type: string; title: string }>; downstream: Array<{ id: string; type: string; title: string }> }
  ```
- Consumes: `normalizeModelRef`（Task 1）、既有 `nodeTitle`

- [ ] **Step 1: 写失败测试**

新建 `apps/server/src/agent/agent-node-patch.test.ts`：

```ts
import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import type { CanvasData } from '@lnkpi/shared'
import { relationsForNode, validateNodePatch } from './agent-canvas-tools.service'

const selectable = {
  image: ['platform::seedream-4'],
  video: ['platform::agnes-video-v2.0'],
  text: ['platform::agnes-2.0-flash'],
  audio: ['platform::minimax-speech-2.8-hd'],
}

const imageNode = { type: 'image', data: { title: '旧名' } }

describe('validateNodePatch —— 图 1 的 5 条拒绝分支（spec §4.2）', () => {
  it('拒绝分支 1：非白名单字段（status 不得被模型涂改）', () => {
    const out = validateNodePatch({ patch: { status: 'completed' }, node: imageNode, selectable })
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.allowed).toEqual(['title', 'imageModel'])
  })

  it('拒绝分支 2：空 patch', () => {
    const out = validateNodePatch({ patch: {}, node: imageNode, selectable })
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toMatch(/at least one/i)
  })

  it('拒绝分支 3：模型字段与节点类型不匹配（image 节点传 videoModel）', () => {
    const out = validateNodePatch({ patch: { videoModel: 'platform::agnes-video-v2.0' }, node: imageNode, selectable })
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toMatch(/imageModel/)
  })

  it('拒绝分支 4：ref 不在 selectable 清单内 → 附合法清单', () => {
    const out = validateNodePatch({ patch: { imageModel: 'platform::不存在' }, node: imageNode, selectable })
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.allowed).toEqual(selectable.image)
  })

  it('拒绝分支 5：裸名不在目录中（normalizeModelRef.fallback）→ 不得静默采用默认模型', () => {
    const out = validateNodePatch({ patch: { imageModel: '完全不存在的模型-xyz' }, node: imageNode, selectable })
    expect(out.ok).toBe(false)
  })

  it('放行：title + 合法模型 ref，且只回白名单字段', () => {
    const out = validateNodePatch({
      patch: { title: '茶馆主视觉', imageModel: 'platform::seedream-4' },
      node: imageNode,
      selectable,
    })
    expect(out).toEqual({ ok: true, data: { title: '茶馆主视觉', imageModel: 'platform::seedream-4' } })
  })

  it('Review Focus 4：纯空白 title 被拒绝（不得把标题清成空串）', () => {
    expect(validateNodePatch({ patch: { title: '   ' }, node: imageNode, selectable }).ok).toBe(false)
    expect(validateNodePatch({ patch: { title: '' }, node: imageNode, selectable }).ok).toBe(false)
  })

  it('prompt/text 节点用 textModel；group 节点不允许任何模型字段', () => {
    expect(
      validateNodePatch({
        patch: { textModel: 'platform::agnes-2.0-flash' },
        node: { type: 'prompt', data: {} },
        selectable,
      }).ok,
    ).toBe(true)
    expect(
      validateNodePatch({ patch: { textModel: 'platform::agnes-2.0-flash' }, node: { type: 'group', data: {} }, selectable }).ok,
    ).toBe(false)
  })
})

describe('relationsForNode', () => {
  const canvas = (): CanvasData => ({
    nodes: [
      { id: 'p1', type: 'prompt', position: { x: 0, y: 0 }, data: { title: '文案' } },
      { id: 'i1', type: 'image', position: { x: 1, y: 0 }, data: { title: '主图' } },
      { id: 'v1', type: 'video', position: { x: 2, y: 0 }, data: { title: '成片' } },
    ],
    edges: [
      { id: 'e1', source: 'p1', target: 'i1' },
      { id: 'e2', source: 'i1', target: 'v1' },
      { id: 'e3', source: 'missing', target: 'i1' },
    ],
  })

  it('上游/下游各回 id+type+title 三元组', () => {
    const out = relationsForNode(canvas(), 'i1')
    expect(out.upstream).toEqual([{ id: 'p1', type: 'prompt', title: '文案' }])
    expect(out.downstream).toEqual([{ id: 'v1', type: 'video', title: '成片' }])
  })

  it('悬空边（source 不存在）被跳过而不是崩', () => {
    expect(relationsForNode(canvas(), 'i1').upstream.map((n) => n.id)).not.toContain('missing')
  })

  it('无关系 → 两个空数组', () => {
    const out = relationsForNode(canvas(), 'p1')
    expect(out.upstream).toEqual([])
    expect(out.downstream).toEqual([{ id: 'i1', type: 'image', title: '主图' }])
    expect(relationsForNode({ nodes: [], edges: [] }, 'nope')).toEqual({ upstream: [], downstream: [] })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/server test -- agent-node-patch`
Expected: FAIL —— `validateNodePatch is not a function`

- [ ] **Step 3: 实现**

在 `apps/server/src/agent/agent-canvas-tools.service.ts` 的 `function nodeStatus` 之后追加（文件顶部需 `import { normalizeModelRef } from '@lnkpi/shared'`）：

```ts
/** update_node 的唯一可写字段集（spec §4.1）。改动此表必须同步 spec 与图 1。 */
export const UPDATE_NODE_WRITABLE_FIELDS = ['title', 'imageModel', 'videoModel', 'textModel', 'audioModel'] as const

export type NodeModal = 'image' | 'video' | 'text' | 'audio'

/**
 * 节点类型 → 允许写的模型字段与模态。
 * 非此表的类型（group/shot/sceneComposer）**无**模型字段可写；prompt 与 text 共用 textModel。
 */
export const NODE_TYPE_MODEL_FIELD: Record<string, { field: string; modality: NodeModal }> = {
  image: { field: 'imageModel', modality: 'image' },
  video: { field: 'videoModel', modality: 'video' },
  text: { field: 'textModel', modality: 'text' },
  prompt: { field: 'textModel', modality: 'text' },
  audio: { field: 'audioModel', modality: 'audio' },
}

export type NodePatchValidation =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; reason: string; allowed?: string[] }

/**
 * `update_node` 的入参校验（spec §4.1 判据 R-1~R-4）。
 *
 * 刻意是**模块级纯函数**：本仓 agent 链路没有 schema 校验兜底（harness 不校验），
 * 白名单是唯一防线，必须能被独立单测逐条打靶。
 */
export function validateNodePatch(input: {
  patch: Record<string, unknown>
  node: { type?: string; data?: Record<string, unknown> }
  selectable: Record<NodeModal, string[]>
}): NodePatchValidation {
  const { patch, node, selectable } = input
  const nodeType = String(node.type ?? '')
  const modelRule = NODE_TYPE_MODEL_FIELD[nodeType]
  const writableFields = ['title', ...(modelRule ? [modelRule.field] : [])]

  const unknown = Object.keys(patch).filter((k) => !UPDATE_NODE_WRITABLE_FIELDS.includes(k as never))
  if (unknown.length) {
    return { ok: false, reason: `unsupported field(s): ${unknown.join(', ')}`, allowed: writableFields }
  }
  // R-1：一次只允许一个模型字段，且必须是该节点类型的模态字段
  const modelFields = Object.keys(patch).filter((k) => k !== 'title')
  if (modelFields.length > 1) {
    return { ok: false, reason: 'at most one model field per call', allowed: writableFields }
  }
  if (modelFields.length === 1) {
    if (!modelRule || modelFields[0] !== modelRule.field) {
      return {
        ok: false,
        reason: `node type "${nodeType}" only accepts ${modelRule ? modelRule.field : 'no model field'}`,
        allowed: writableFields,
      }
    }
  }

  const data: Record<string, unknown> = {}
  if ('title' in patch) {
    // Review Focus 4：空白 title 不得把标题清空
    const title = typeof patch.title === 'string' ? patch.title.trim() : ''
    if (!title) return { ok: false, reason: 'title must be a non-empty string', allowed: writableFields }
    data.title = title
  }
  if (modelRule && modelRule.field in patch) {
    const raw = patch[modelRule.field]
    if (typeof raw !== 'string') {
      return { ok: false, reason: `${modelRule.field} must be a string`, allowed: selectable[modelRule.modality] }
    }
    const normalized = normalizeModelRef(modelRule.modality, raw)
    // R-2：fallback 说明裸名不在目录中——不得静默采用被回落出来的默认模型
    if (!normalized || normalized.fallback) {
      return { ok: false, reason: `unknown model "${raw}"`, allowed: selectable[modelRule.modality] }
    }
    // R-3：清单是唯一权威（BYOK ref 也可能已被用户从可选清单移除）
    if (!selectable[modelRule.modality].includes(normalized.ref)) {
      return { ok: false, reason: `model "${raw}" is not in the user's selectable list`, allowed: selectable[modelRule.modality] }
    }
    data[modelRule.field] = normalized.ref
  }

  if (Object.keys(data).length === 0) {
    return { ok: false, reason: 'patch must contain at least one writable field', allowed: writableFields }
  }
  return { ok: true, data }
}

/** 由 canvas.edges 推导节点的上下游（只回 id+type+title，体积可控；悬空边跳过）。 */
export function relationsForNode(
  canvas: { nodes: CanvasNode[]; edges: CanvasEdge[] },
  nodeId: string,
): { upstream: Array<{ id: string; type: string; title: string }>; downstream: Array<{ id: string; type: string; title: string }> } {
  const brief = (id: string) => {
    const node = canvas.nodes.find((n) => n.id === id)
    if (!node) return null
    return { id: node.id, type: String(node.type ?? ''), title: nodeTitle(node) }
  }
  const upstream = canvas.edges
    .filter((e) => e.target === nodeId)
    .map((e) => brief(e.source))
    .filter((n): n is { id: string; type: string; title: string } => n !== null)
  const downstream = canvas.edges
    .filter((e) => e.source === nodeId)
    .map((e) => brief(e.target))
    .filter((n): n is { id: string; type: string; title: string } => n !== null)
  return { upstream, downstream }
}
```

> 若 `CanvasEdge` 类型名在本文件不存在，用文件里既有的边类型（`CanvasData['edges'][number]`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C apps/server test -- agent-node-patch`
Expected: PASS（11 例）

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/agent/agent-canvas-tools.service.ts apps/server/src/agent/agent-node-patch.test.ts
git commit -m "feat(agent): validateNodePatch 白名单校验 + relationsForNode 上下游推导（纯函数 + 单测）"
```

---

### Task 4: Nest `update-node` / `list-model-options` 端点

**Files:**
- Modify: `apps/server/src/agent/agent-canvas-tools.service.ts`（构造函数注入 `ProviderService`；新增 `updateNode` / `listNodeModelOptions`）
- Modify: `apps/server/src/agent/agent-canvas-tools.controller.ts`（+2 端点 + DTO）
- Test: `apps/server/src/agent/agent-canvas-tools.service.test.ts`（追加 describe）

**Interfaces:**
- Consumes: `validateNodePatch`（Task 3）、`ProviderService.bootstrap(userId)`（`apps/server/src/provider/provider.service.ts:239`，返回 `{ platformChannel, channels, preferences }`）
- Produces:
  ```ts
  async updateNode(input: { sessionId: string; userId: string; nodeId: string; patch: Record<string, unknown> }):
    Promise<{ nodeId: string; actions: CanvasAction[] }>

  async listNodeModelOptions(input: { userId: string }): Promise<{
    modalities: Record<NodeModal, Array<{ ref: string; model: string; channelId: string; channelName: string; source: 'platform' | 'user' }>>
  }>
  ```

- [ ] **Step 1: 写失败测试**

在 `apps/server/src/agent/agent-canvas-tools.service.test.ts` 的 testing module providers 里追加 `ProviderService` mock，并新增 `bootstrap`：

```ts
  const providerBootstrap = vi.fn()
  // providers 数组内追加：
  //   { provide: ProviderService, useValue: { bootstrap: providerBootstrap } }
  // beforeEach 内追加：
  providerBootstrap.mockResolvedValue({
    platformChannel: { id: 'platform', name: '平台', models: [] },
    channels: [{ id: 'ch_byok_1', name: '我的渠道', models: [{ name: 'custom-image', capability: 'image' }] }],
    preferences: {
      selectableImageModels: ['platform::seedream-4', 'ch_byok_1::custom-image'],
      selectableVideoModels: ['platform::agnes-video-v2.0'],
      selectableTextModels: ['platform::agnes-2.0-flash'],
      selectableAudioModels: ['platform::minimax-speech-2.8-hd'],
    },
  })
```

新增测试：

```ts
describe('updateNode', () => {
  it('改标题：生成 update_node action 并落库', async () => {
    canvas = { nodes: [{ id: 'i1', type: 'image', position: { x: 0, y: 0 }, data: { title: '旧名' } }], edges: [] }
    const out = await svc.updateNode({ sessionId: 's1', userId: 'u1', nodeId: 'i1', patch: { title: '茶馆主视觉' } })
    expect(out.actions).toEqual([{ type: 'update_node', payload: { id: 'i1', data: { title: '茶馆主视觉' } } }])
    expect(canvas.nodes[0].data.title).toBe('茶馆主视觉')
  })

  it('换芯片：BYOK 渠道 ref 通过清单校验', async () => {
    canvas = { nodes: [{ id: 'i1', type: 'image', position: { x: 0, y: 0 }, data: {} }], edges: [] }
    const out = await svc.updateNode({ sessionId: 's1', userId: 'u1', nodeId: 'i1', patch: { imageModel: 'ch_byok_1::custom-image' } })
    expect(canvas.nodes[0].data.imageModel).toBe('ch_byok_1::custom-image')
    expect(out.nodeId).toBe('i1')
  })

  it('Review Focus 1：nodeId 不存在 → NotFoundException', async () => {
    canvas = emptyCanvas()
    await expect(svc.updateNode({ sessionId: 's1', userId: 'u1', nodeId: 'nope', patch: { title: 'x' } })).rejects.toBeInstanceOf(NotFoundException)
  })

  it('Review Focus 1：跨账号 → ForbiddenException', async () => {
    canvas = emptyCanvas()
    await expect(svc.updateNode({ sessionId: 's1', userId: 'other', nodeId: 'i1', patch: { title: 'x' } })).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('非法 patch → BadRequestException 且附合法清单', async () => {
    canvas = { nodes: [{ id: 'i1', type: 'image', position: { x: 0, y: 0 }, data: {} }], edges: [] }
    await expect(
      svc.updateNode({ sessionId: 's1', userId: 'u1', nodeId: 'i1', patch: { status: 'completed' } }),
    ).rejects.toBeInstanceOf(BadRequestException)
  })
})

describe('listNodeModelOptions', () => {
  it('按模态列出 ref + 来源（platform / user）', async () => {
    const out = await svc.listNodeModelOptions({ userId: 'u1' })
    expect(out.modalities.image).toEqual([
      { ref: 'platform::seedream-4', model: 'seedream-4', channelId: 'platform', channelName: '平台', source: 'platform' },
      { ref: 'ch_byok_1::custom-image', model: 'custom-image', channelId: 'ch_byok_1', channelName: '我的渠道', source: 'user' },
    ])
  })

  it('Review Focus 5：无 BYOK 渠道时仍返回平台目录（不空不抛）', async () => {
    providerBootstrap.mockResolvedValue({
      platformChannel: { id: 'platform', name: '平台', models: [] },
      channels: [],
      preferences: { selectableImageModels: ['platform::seedream-4'], selectableVideoModels: [], selectableTextModels: [], selectableAudioModels: [] },
    })
    const out = await svc.listNodeModelOptions({ userId: 'u1' })
    expect(out.modalities.image).toHaveLength(1)
    expect(out.modalities.video).toEqual([])
  })

  it('Review Focus 1：缺 userId → BadRequestException（fail-closed）', async () => {
    await expect(svc.listNodeModelOptions({ userId: '' })).rejects.toBeInstanceOf(BadRequestException)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/server test -- agent-canvas-tools.service`
Expected: FAIL —— `svc.updateNode is not a function`

- [ ] **Step 3: 实现服务方法**

构造函数追加注入：

```ts
    @Inject(ProviderService) private readonly provider: ProviderService,
```

（并在文件顶部 `import { ProviderService } from '../provider/provider.service'`。`AgentModule` 已 `imports: [ProviderModule]`，无需改 module。）

在 `setNodeContent` 之后追加：

```ts
  /**
   * 改节点属性（spec §4.1 白名单）：title + 节点自身模态的模型字段。
   * 刻意**不碰** prompt/content——那归 setNodeText，避免与本仓
   * 「upsert_prompt_node 全量覆盖 vs set_node_text 部分更新」语义（PR #63）打架。
   */
  async updateNode(input: {
    sessionId: string
    userId: string
    nodeId: string
    patch: Record<string, unknown>
  }): Promise<{ nodeId: string; actions: CanvasAction[] }> {
    const { canvas } = await this.loadOwnedSession(input.sessionId, input.userId)
    const node = canvas.nodes.find((n) => n.id === input.nodeId)
    if (!node) throw new NotFoundException('节点不存在')

    const selectable = await this.selectableModels(input.userId)
    const validated = validateNodePatch({ patch: input.patch, node, selectable })
    if (!validated.ok) {
      throw new BadRequestException({
        message: validated.reason,
        ...(validated.allowed ? { allowed: validated.allowed } : {}),
      })
    }

    const actions: CanvasAction[] = [
      { type: 'update_node', payload: { id: node.id, data: validated.data } },
    ]
    await this.persist(input.sessionId, actions)
    return { nodeId: node.id, actions }
  }

  /**
   * 按模态列出可写模型 ref（= update_node 的合法取值集）。
   * `source` 直接来自 preferences 里的 channelId 前缀：`platform::*` → 平台，其余 → BYOK。
   */
  async listNodeModelOptions(input: { userId: string }): Promise<{
    modalities: Record<NodeModal, Array<{ ref: string; model: string; channelId: string; channelName: string; source: ProviderSource }>>
  }> {
    if (!input.userId) throw new BadRequestException('userId required')
    const { platformChannel, channels, preferences } = await this.provider.bootstrap(input.userId)
    const nameOf = new Map<string, string>([[platformChannel.id, platformChannel.name]])
    for (const ch of channels) nameOf.set(ch.id, ch.name)

    const build = (refs: string[]) =>
      refs.map((ref) => {
        const decoded = decodeChannelModel(ref)
        const channelId = decoded?.channelId ?? PLATFORM_CHANNEL_ID
        return {
          ref,
          model: decoded?.modelName ?? ref,
          channelId,
          channelName: nameOf.get(channelId) ?? channelId,
          source: (channelId === PLATFORM_CHANNEL_ID ? 'platform' : 'user') as ProviderSource,
        }
      })

    return {
      modalities: {
        image: build(preferences.selectableImageModels),
        video: build(preferences.selectableVideoModels),
        text: build(preferences.selectableTextModels),
        audio: build(preferences.selectableAudioModels),
      },
    }
  }

  /** selectable 清单 → validateNodePatch 需要的形态（按模态分桶）。 */
  private async selectableModels(userId: string): Promise<Record<NodeModal, string[]>> {
    const { preferences } = await this.provider.bootstrap(userId)
    return {
      image: preferences.selectableImageModels,
      video: preferences.selectableVideoModels,
      text: preferences.selectableTextModels,
      audio: preferences.selectableAudioModels,
    }
  }
```

需补的 import：`decodeChannelModel` from `@lnkpi/shared`；`ProviderSource` from `../provider/provider-context`；`PLATFORM_CHANNEL_ID` from `../provider/provider.service`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C apps/server test -- agent-canvas-tools.service`
Expected: PASS

- [ ] **Step 5: 加控制器端点**

`apps/server/src/agent/agent-canvas-tools.controller.ts`：

```ts
class UpdateNodeDto {
  @IsString()
  sessionId!: string

  @IsString()
  userId!: string

  @IsString()
  nodeId!: string

  @IsObject()
  patch!: Record<string, unknown>
}

class UserOnlyDto2Dto {
  @IsString()
  userId!: string
}
```

> 实现时若已存在等价的「只含 userId」DTO（如 `UserOnlyDto`），直接复用，不要新增重复类。

端点（放在 `set-node-content` 之后）：

```ts
  @Post('update-node')
  async updateNode(@Body() dto: UpdateNodeDto) {
    const data = await this.tools.updateNode(dto)
    return { code: 0, message: 'ok', data }
  }

  @Post('list-model-options')
  async listModelOptions(@Body() dto: UserOnlyDto2Dto) {
    const data = await this.tools.listNodeModelOptions(dto)
    return { code: 0, message: 'ok', data }
  }
```

- [ ] **Step 6: 控制器测试 + 类型检查**

在 `apps/server/src/agent/agent-canvas-tools.controller.test.ts` 追加：两个新端点各自「透传 dto 给 service 并包成 `{code:0,data}`」的用例；并断言 `patch` 缺字段时 `ValidationPipe` 拒绝（`@IsObject()` 生效）。

Run: `pnpm -C apps/server test -- agent-canvas-tools.controller`
Expected: PASS
Run: `pnpm -C apps/server exec tsc --noEmit`
Expected: 无错误

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/agent/agent-canvas-tools.service.ts apps/server/src/agent/agent-canvas-tools.controller.ts apps/server/src/agent/agent-canvas-tools.service.test.ts apps/server/src/agent/agent-canvas-tools.controller.test.ts
git commit -m "feat(agent): update-node 与 list-model-options 端点（白名单 + fail-closed）"
```

---

### Task 5: 读契约扩展（`get-node` 关系 / `get-canvas-layout` edges）+ `remove-edges` 归属

**Files:**
- Modify: `apps/server/src/agent/agent-canvas-tools.service.ts`（`getNode` / `getCanvasLayout` / `removeEdges`）
- Modify: `apps/server/src/agent/agent-canvas-tools.controller.ts`（`RemoveEdgesDto` + optional `userId`）
- Modify: `packages/shared/src/agentContract.ts`（`GetNodeResponseSchema`）
- Modify: `services/pi-runtime/src/tools/canvas-read.ts`（`get_canvas_layout` description，必须与本任务同时改）
- Test: `apps/server/src/agent/agent-canvas-tools.service.test.ts`（追加）

**Interfaces:**
- Produces: `getNode` 返回 `CanvasNode & { upstream: [...]; downstream: [...] }`
- Produces: `getCanvasLayout` 返回 `{ nodes, groups, edges: Array<{ id: string; source: string; target: string }> }`
- Produces: `removeEdges(input: { sessionId: string; userId?: string; edgeIds: string[]; stage?: boolean })`

- [ ] **Step 1: 写失败测试**

在 `agent-canvas-tools.service.test.ts` 追加：

```ts
describe('getNode 上下游（spec §5.5）', () => {
  beforeEach(() => {
    canvas = {
      nodes: [
        { id: 'p1', type: 'prompt', position: { x: 0, y: 0 }, data: { title: '文案' } },
        { id: 'i1', type: 'image', position: { x: 1, y: 0 }, data: { title: '主图' } },
      ],
      edges: [{ id: 'e1', source: 'p1', target: 'i1' }],
    }
  })

  it('返回 upstream/downstream 三元组', async () => {
    const node = await svc.getNode({ sessionId: 's1', nodeId: 'i1' })
    expect(node.upstream).toEqual([{ id: 'p1', type: 'prompt', title: '文案' }])
    expect(node.downstream).toEqual([])
    expect(node.id).toBe('i1')
  })

  it('Review Focus 3：空画布下 get_node 抛 NotFound（不是崩）', async () => {
    canvas = emptyCanvas()
    await expect(svc.getNode({ sessionId: 's1', nodeId: 'nope' })).rejects.toBeInstanceOf(NotFoundException)
  })
})

describe('getCanvasLayout 返回 edges（spec §5.5 / 目标 3）', () => {
  it('edges 为 {id,source,target} 三元组；空画布回空数组', async () => {
    canvas = {
      nodes: [{ id: 'p1', type: 'prompt', position: { x: 0, y: 0 }, data: {} }],
      edges: [{ id: 'e1', source: 'p1', target: 'i1' }],
    }
    const layout = await svc.getCanvasLayout({ sessionId: 's1' })
    expect(layout.edges).toEqual([{ id: 'e1', source: 'p1', target: 'i1' }])

    canvas = emptyCanvas()
    const empty = await svc.getCanvasLayout({ sessionId: 's1' })
    expect(empty.edges).toEqual([])
    expect(empty.nodes).toEqual([])
  })
})

describe('removeEdges 归属与幂等（spec S8 / Review Focus 2）', () => {
  beforeEach(() => {
    canvas = {
      nodes: [
        { id: 'p1', type: 'prompt', position: { x: 0, y: 0 }, data: {} },
        { id: 'i1', type: 'image', position: { x: 1, y: 0 }, data: {} },
      ],
      edges: [{ id: 'e1', source: 'p1', target: 'i1' }],
    }
  })

  it('带 userId 时校验归属', async () => {
    await expect(svc.removeEdges({ sessionId: 's1', userId: 'other', edgeIds: ['e1'] })).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('不存在的 edgeId 被跳过（幂等成功，不报错）', async () => {
    const out = await svc.removeEdges({ sessionId: 's1', userId: 'u1', edgeIds: ['nope'] })
    expect(out.actions).toEqual([])
  })

  it('删除命中边并回 remove_edge action', async () => {
    const out = await svc.removeEdges({ sessionId: 's1', userId: 'u1', edgeIds: ['e1'] })
    expect(out.actions).toEqual([{ type: 'remove_edge', payload: { id: 'e1' } }])
    expect(canvas.edges).toEqual([])
  })

  it('未传 userId 时保持旧行为（向后兼容既有调用）', async () => {
    const out = await svc.removeEdges({ sessionId: 's1', edgeIds: ['e1'] })
    expect(out.actions).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/server test -- agent-canvas-tools.service`
Expected: FAIL —— `layout.edges` undefined

- [ ] **Step 3: 实现**

`getNode`：在 `return node` 前合成关系字段。

```ts
  async getNode(input: { sessionId: string; nodeId: string }): Promise<CanvasNode & ReturnType<typeof relationsForNode>> {
    const { canvas } = await this.loadSession(input.sessionId)
    const node = canvas.nodes.find((n) => n.id === input.nodeId)
    if (!node) throw new NotFoundException('节点不存在')
    // 上下游是该节点的一等属性；拆第二个读工具只会迫使模型记住"读节点要调两次"
    return { ...node, ...relationsForNode(canvas, node.id) }
  }
```

`getCanvasLayout`：返回体加 `edges`，类型声明同步加字段；实现里在 `return` 处补：

```ts
    return {
      nodes,
      groups: summarizeLayoutGroups(layoutNodes),
      edges: canvas.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    }
```

`removeEdges`：加 optional `userId` 归属校验。

```ts
  async removeEdges(input: {
    sessionId: string
    /** 有则校验归属；缺省保持旧行为（既有调用方兼容） */
    userId?: string
    edgeIds: string[]
    stage?: boolean
  }): Promise<{ actions: CanvasAction[] }> {
    const { canvas } = input.userId
      ? await this.loadOwnedSession(input.sessionId, input.userId)
      : await this.loadSession(input.sessionId)
    // ...（既有循环不变：不存在的 edgeId 跳过）
  }
```

`RemoveEdgesDto` 加：

```ts
  @IsOptional()
  @IsString()
  userId?: string
```

`packages/shared/src/agentContract.ts`：`GetNodeResponseSchema` 由 `CanvasNodeSchema` 改为：

```ts
export const CanvasNodeBriefSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
})

export const GetNodeResponseSchema = CanvasNodeSchema.extend({
  upstream: z.array(CanvasNodeBriefSchema).optional(),
  downstream: z.array(CanvasNodeBriefSchema).optional(),
})
```

`services/pi-runtime/src/tools/canvas-read.ts` 的 `get_canvas_layout` description 改为：

```ts
			description:
				"Get the current canvas layout (nodes with positions and sizes, groups, and edges as source/target id pairs).",
```

（必须与本任务同 commit：原描述声称有 edges 而实现没有，本任务让描述成真。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C apps/server test -- agent-canvas-tools.service`
Expected: PASS
Run: `pnpm -C packages/shared test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/agent/agent-canvas-tools.service.ts apps/server/src/agent/agent-canvas-tools.controller.ts apps/server/src/agent/agent-canvas-tools.service.test.ts packages/shared/src/agentContract.ts services/pi-runtime/src/tools/canvas-read.ts
git commit -m "feat(agent): get_node 回上下游、get_canvas_layout 回 edges、remove_edges 加归属校验"
```

---

### Task 6: 前端 `applyActionsToFlow` 补 `remove_edge` / `set_viewport`

**Files:**
- Modify: `apps/web/src/composables/useCanvasActions.ts:20-88`
- Modify: `apps/web/src/pages/CanvasPage.vue:1495-1512`（应用视口）
- Test: `apps/web/src/composables/useCanvasActions.test.ts`（新建，该文件此前无测试）

**Interfaces:**
- Produces:
  ```ts
  export function applyActionsToFlow(
    nodes: FlowNode[],
    edges: FlowEdge[],
    actions: CanvasAction[],
  ): { nodes: FlowNode[]; edges: FlowEdge[]; viewport?: { x: number; y: number; zoom: number } }
  ```
  （返回值新增 **optional** `viewport`，向后兼容既有调用与测试）

- [ ] **Step 1: 写失败测试**

新建 `apps/web/src/composables/useCanvasActions.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import type { CanvasAction } from '@lnkpi/shared'
import { applyActionsToFlow, type FlowEdge, type FlowNode } from './useCanvasActions'

const node = (id: string, data: Record<string, unknown> = {}): FlowNode => ({
  id,
  type: 'image',
  position: { x: 0, y: 0 },
  data,
})
const edge = (id: string, source: string, target: string): FlowEdge => ({ id, source, target })

describe('applyActionsToFlow —— 6 种 action 全路由（spec 图 4）', () => {
  it('add_node 追加节点', () => {
    const out = applyActionsToFlow([], [], [
      { type: 'add_node', payload: { id: 'n1', nodeType: 'image', position: { x: 5, y: 6 }, data: { title: 'A' } } } as CanvasAction,
    ])
    expect(out.nodes).toHaveLength(1)
    expect(out.nodes[0].id).toBe('n1')
  })

  it('update_node 浅合并 data', () => {
    const out = applyActionsToFlow([node('n1', { title: '旧', keep: 1 })], [], [
      { type: 'update_node', payload: { id: 'n1', data: { title: '新' } } } as CanvasAction,
    ])
    expect(out.nodes[0].data).toEqual({ title: '新', keep: 1 })
  })

  it('remove_node 删节点及其关联边', () => {
    const out = applyActionsToFlow([node('a'), node('b')], [edge('e1', 'a', 'b')], [
      { type: 'remove_node', payload: { id: 'a' } } as CanvasAction,
    ])
    expect(out.nodes.map((n) => n.id)).toEqual(['b'])
    expect(out.edges).toEqual([])
  })

  it('add_edge 追加边', () => {
    const out = applyActionsToFlow([node('a'), node('b')], [], [
      { type: 'add_edge', payload: { source: 'a', target: 'b' } } as CanvasAction,
    ])
    expect(out.edges).toHaveLength(1)
    expect(out.edges[0].source).toBe('a')
  })

  it('remove_edge 按 id 删边（本包新增；此前被静默丢弃）', () => {
    const out = applyActionsToFlow([node('a'), node('b')], [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')], [
      { type: 'remove_edge', payload: { id: 'e1' } } as CanvasAction,
    ])
    expect(out.edges.map((e) => e.id)).toEqual(['e2'])
  })

  it('remove_edge 未命中 / 缺 id → no-op 不抛（Review Focus 2 的前端侧）', () => {
    const actions = [
      { type: 'remove_edge', payload: { id: 'missing' } },
      { type: 'remove_edge', payload: {} },
    ] as CanvasAction[]
    const out = applyActionsToFlow([node('a')], [edge('e1', 'a', 'a')], actions)
    expect(out.edges).toHaveLength(1)
  })

  it('set_viewport 透出 viewport（本包新增；此前被静默丢弃）', () => {
    const out = applyActionsToFlow([], [], [
      { type: 'set_viewport', payload: { viewport: { x: 10, y: 20, zoom: 1.5 } } } as CanvasAction,
    ])
    expect(out.viewport).toEqual({ x: 10, y: 20, zoom: 1.5 })
  })

  it('未知 type 静默丢弃且不抛', () => {
    expect(() =>
      applyActionsToFlow([node('a')], [], [{ type: 'nope', payload: {} } as unknown as CanvasAction]),
    ).not.toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/web test -- useCanvasActions`
Expected: FAIL —— `remove_edge` / `set_viewport` 断言失败（edges 未删、viewport undefined）

- [ ] **Step 3: 实现**

`apps/web/src/composables/useCanvasActions.ts`：

- 返回值类型改为 `{ nodes: FlowNode[]; edges: FlowEdge[]; viewport?: { x: number; y: number; zoom: number } }`
- 函数内声明 `let viewport: { x: number; y: number; zoom: number } | undefined`
- `switch` 内追加：

```ts
      case 'remove_edge': {
        const edgeId = action.payload.id
        if (!edgeId) break
        const idx = newEdges.findIndex((e) => e.id === edgeId)
        if (idx > -1) newEdges.splice(idx, 1)
        break
      }
      case 'set_viewport':
        if (action.payload.viewport) viewport = action.payload.viewport
        break
```

- 末尾 `return { nodes: newNodes, edges: newEdges, viewport }`

`apps/web/src/pages/CanvasPage.vue` 的 `handleAgentActions` 里应用视口：

```ts
async function handleAgentActions(actions: unknown[]) {
  const result = applyActionsToFlow(
    nodes.value as unknown as import('@/composables/useCanvasActions').FlowNode[],
    edges.value as unknown as import('@/composables/useCanvasActions').FlowEdge[],
    actions as CanvasAction[],
  )
  nodes.value = result.nodes as unknown as EditableFlowNode[]
  edges.value = result.edges as unknown as CanvasEdge[]
  if (result.viewport) {
    vueFlowRef.value?.setViewport?.(result.viewport, { duration: 300 })
  }
  // ...（其余不变）
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C apps/web test -- useCanvasActions`
Expected: PASS（8 例）

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/composables/useCanvasActions.ts apps/web/src/composables/useCanvasActions.test.ts apps/web/src/pages/CanvasPage.vue
git commit -m "fix(web): applyActionsToFlow 补 remove_edge / set_viewport（此前静默丢弃）"
```

---

### Task 7: pi-runtime 共享 `resultWithActions` + 11 个既有写工具改造

**Files:**
- Create: `services/pi-runtime/src/tools/result-with-actions.ts`
- Modify: `services/pi-runtime/src/tools/canvas-write.ts`（全部 `textResult` → `resultWithActions`，`set_node_text` 的 prompt 分支接上 actions）
- Modify: `services/pi-runtime/src/tools/delete-nodes.ts`、`generation.ts`（改用共享 helper，消除复制）
- Test: `services/pi-runtime/src/tools/result-with-actions.test.ts`（新建）
- Test: `services/pi-runtime/src/tools/canvas-write.test.ts`（追加）

**Interfaces:**
- Produces:
  ```ts
  export function extractActions(data: unknown): Record<string, unknown>[]
  export function resultWithActions(data: unknown): {
    content: [{ type: "text"; text: string }]
    details: { actions: Record<string, unknown>[] }
  }
  ```

- [ ] **Step 1: 写失败测试**

新建 `services/pi-runtime/src/tools/result-with-actions.test.ts`：

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractActions, resultWithActions } from "./result-with-actions.js";

describe("result-with-actions", () => {
	it("extractActions：只收对象元素，非数组/脏数据回空数组", () => {
		assert.deepEqual(extractActions({ actions: [{ type: "remove_edge", payload: { id: "e1" } }] }), [
			{ type: "remove_edge", payload: { id: "e1" } },
		]);
		assert.deepEqual(extractActions({ actions: "oops" }), []);
		assert.deepEqual(extractActions({}), []);
		assert.deepEqual(extractActions(null), []);
		assert.deepEqual(extractActions({ actions: [null, 1, { type: "x" }] }), [{ type: "x" }]);
	});

	it("resultWithActions：content 保持 {ok,data} 文本，actions 进 details", () => {
		const out = resultWithActions({ actions: [{ type: "add_node", payload: { id: "n1" } }], nodeId: "n1" });
		assert.ok(out.content[0].text.includes("nodeId"), "模型仍能看到业务载荷");
		assert.deepEqual(out.details, { actions: [{ type: "add_node", payload: { id: "n1" } }] });
	});

	it("无 actions 时 details.actions 为空数组（不是 undefined，避免 extractCanvasActions 早退语义歧义）", () => {
		assert.deepEqual(resultWithActions({ ok: true }).details, { actions: [] });
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C services/pi-runtime test 2>&1 | Tail`（实现后同一命令应全绿；实现前该文件报模块不存在）
Expected: FAIL —— `Cannot find module './result-with-actions.js'`

- [ ] **Step 3: 实现 helper**

`services/pi-runtime/src/tools/result-with-actions.ts`：

```ts
/**
 * Nest 写工具的统一返回形态。
 *
 * ⚠️ `actions` **必须**走 `details.actions`：Nest 侧 `extractCanvasActions` 只认
 * `tool_execution_end.result.details.actions`，据此派生 canvas_action SSE → 前端实时改画布。
 * 用 textResult（details:undefined）会把 actions 埋在文本里丢掉，导致
 * 「Nest 已改、画布不变，要等回合末全量回拉」——PR #65 已经踩过一次（delete_nodes）。
 */
export function extractActions(data: unknown): Record<string, unknown>[] {
	const actions = (data as { actions?: unknown } | null | undefined)?.actions;
	if (!Array.isArray(actions)) return [];
	return actions.filter((a): a is Record<string, unknown> => !!a && typeof a === "object");
}

export function resultWithActions(data: unknown): {
	content: [{ type: "text"; text: string }];
	details: { actions: Record<string, unknown>[] };
} {
	return {
		content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }],
		details: { actions: extractActions(data) },
	};
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C services/pi-runtime test 2>&1 | tail -5`
Expected: PASS

- [ ] **Step 5: 改造 11 个既有写工具**

`services/pi-runtime/src/tools/canvas-write.ts`：
- 删掉本文件的 `textResult` / `textRaw` 中与 actions 相关的手工拼装；**保留** `textRaw`（用于 `apply_sidebar_attachments` 的「没有侧栏附件」短路——那里不需要 actions）。
- 把每个写工具的 `return textResult(await client.post(...))` 改为 `return resultWithActions(await client.post(...))`。
- `set_node_text` 的 prompt 分支目前丢弃了返回值，改为收集：

```ts
			execute: async (
				_id,
				p: { node_id: string; prompt?: string; content?: string },
				_u,
				tc: LnkpiToolContext,
			) => {
				if (!p.prompt && !p.content) {
					throw new Error("set_node_text requires prompt or content (at least one)");
				}
				if (p.content && !tc.userId) {
					throw new Error("set_node_text with content requires userId in toolContext (session identity missing)");
				}
				const collected: Record<string, unknown>[] = [];
				if (p.prompt) {
					const done = await client.post("/agent/internal/set-node-prompt", {
						sessionId: tc.sessionId,
						nodeId: p.node_id,
						prompt: p.prompt,
					});
					collected.push(...extractActions(done));
				}
				if (p.content) {
					const done = await client.post("/agent/internal/set-node-content", {
						sessionId: tc.sessionId,
						userId: tc.userId,
						nodeId: p.node_id,
						content: p.content,
					});
					collected.push(...extractActions(done));
				}
				// 两个分支的 actions 合并后一次性回给 Nest（details.actions 是实时通道）
				return resultWithActions({ actions: collected });
			},
```

- `delete-nodes.ts` / `generation.ts` 删掉各自的本地 `extractActions` / `resultWithActions`，改 import 共享 helper（行为不变）。

- [ ] **Step 6: 追加断言：每个写工具都带 details.actions**

在 `services/pi-runtime/src/tools/canvas-write.test.ts` 追加：

```ts
describe("canvas-write: 全部写工具都推 details.actions（实时通道回归锁）", () => {
	const WRITE_TOOLS = [
		"upsert_prompt_node",
		"upsert_media_node",
		"set_node_text",
		"attach_refs",
		"propose_generation",
		"apply_asset_to_node",
		"save_node_to_asset_library",
		"duplicate_node",
		"upload_media_to_canvas",
		"grid_slice_image",
		"connect_nodes",
	] as const;

	it("每个写工具的返回都含 details.actions 数组", async () => {
		const { client } = makeClient();
		const tools = createCanvasWriteTools(client);
		const params: Record<string, unknown> = {
			upsert_prompt_node: { prompt: "P", content: "C" },
			upsert_media_node: { target_type: "image", prompt: "P" },
			set_node_text: { node_id: "n1", prompt: "P" },
			attach_refs: { node_id: "n1", ref_order: ["i1"] },
			propose_generation: { node_id: "n1" },
			apply_asset_to_node: { node_id: "n1", asset_id: "a1", source: "user" },
			save_node_to_asset_library: { node_id: "n1" },
			duplicate_node: { node_id: "n1" },
			upload_media_to_canvas: { url: "https://x/a.png", media_type: "image" },
			grid_slice_image: { cols: 2, rows: 2, source_url: "https://x/a.png" },
			connect_nodes: { edges: [{ source: "n1", target: "n2" }] },
		};
		for (const name of WRITE_TOOLS) {
			const out = (await run(findTool(tools, name), params[name])) as { details?: { actions?: unknown } };
			assert.ok(Array.isArray(out.details?.actions), `${name} must expose details.actions`);
		}
	});
});
```

> `makeClient` 目前返回 `{ echoed: body }`，没有 `actions` 字段 —— 上面只断言 `details.actions` 是数组（空数组也算），所以现有 mock 即可通过；这正是"形状存在性"回归锁。

- [ ] **Step 7: 跑测试 + 类型检查**

Run: `pnpm -C services/pi-runtime test 2>&1 | tail -8`
Expected: PASS（含 delete-nodes / generation 既有用例不回归）
Run: `pnpm -C services/pi-runtime typecheck`
Expected: 无错误

- [ ] **Step 8: 提交**

```bash
git add services/pi-runtime/src/tools/result-with-actions.ts services/pi-runtime/src/tools/result-with-actions.test.ts services/pi-runtime/src/tools/canvas-write.ts services/pi-runtime/src/tools/canvas-write.test.ts services/pi-runtime/src/tools/delete-nodes.ts services/pi-runtime/src/tools/generation.ts
git commit -m "feat(pi-runtime): 写工具统一 resultWithActions，打通 canvas_action 实时通道"
```

---

### Task 8: pi-runtime 工具 `list_model_options`

**Files:**
- Modify: `services/pi-runtime/src/tools/canvas-read.ts`
- Modify: `services/pi-runtime/src/tools/config.ts`
- Modify: `services/pi-runtime/src/tools/config.test.ts`
- Test: `services/pi-runtime/src/tools/canvas-read.test.ts`（追加）

**Interfaces:**
- Produces: 工具 `list_model_options`，`tier: "read"`，参数 `{ modality?: "image"|"video"|"text"|"audio" }`，端点 `POST /agent/internal/list-model-options`，body `{ userId }`

- [ ] **Step 1: 写失败测试**

追加到 `services/pi-runtime/src/tools/canvas-read.test.ts`：

```ts
describe("list_model_options（spec S3）", () => {
	it("tier=read；body 只带 userId；不暴露 sessionId", async () => {
		const { client, calls } = makeClient();
		const tool = createCanvasReadTools(client).find((t) => t.name === "list_model_options")!;
		assert.equal(tool.tier, "read");
		assert.ok(!JSON.stringify(tool.parameters).includes("sessionId"));
		await tool.execute("1", {} as never, undefined as never, CTX, undefined as never, undefined as never);
		assert.equal(calls[0].path, "/agent/internal/list-model-options");
		assert.deepEqual(calls[0].body, { userId: "u1" });
	});

	it("modality 过滤在客户端做（不打第二次 Nest）", async () => {
		const { client, calls } = makeClient();
		const tool = createCanvasReadTools(client).find((t) => t.name === "list_model_options")!;
		await tool.execute("1", { modality: "image" } as never, undefined as never, CTX, undefined as never, undefined as never);
		assert.equal(calls.length, 1);
	});

	it("缺 userId → fail-closed，不打 Nest", async () => {
		const { client, calls } = makeClient();
		const tool = createCanvasReadTools(client).find((t) => t.name === "list_model_options")!;
		await assert.rejects(
			() => tool.execute("1", {} as never, undefined as never, { sessionId: "s1" }, undefined as never, undefined as never),
			/requires userId/,
		);
		assert.equal(calls.length, 0);
	});
});
```

> `makeClient` 需支持回 `{ modalities: { image: [], video: [], text: [], audio: [] } }`；若现有 mock 只回 `{echoed}`，在 mock 里补该形状即可。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C services/pi-runtime test 2>&1 | tail -8`
Expected: FAIL —— `Cannot read properties of undefined (reading 'tier')`

- [ ] **Step 3: 实现**

在 `createCanvasReadTools` 返回数组末尾追加：

```ts
		{
			...base,
			name: "list_model_options",
			label: "可选模型",
			description:
				"List the model refs the user can assign to a canvas node, per modality, with their source (platform or the user's own BYOK channel). Pass one of these refs to update_node; do not invent model names. Optional modality filter narrows the result.",
			parameters: Type.Object({
				modality: Type.Optional(
					Type.String({ description: "image | video | text | audio (omit for all)" }),
				),
			}),
			execute: async (_id, p: { modality?: string }, _u, tc: LnkpiToolContext) => {
				if (!tc.userId) throw new Error("list_model_options requires userId in toolContext");
				const data = (await client.post("/agent/internal/list-model-options", {
					userId: tc.userId,
				})) as { modalities?: Record<string, unknown> };
				const modalities = data?.modalities ?? {};
				const key = p.modality?.trim();
				// 客户端过滤：一次 Nest 调用服务所有模态，避免模型为每个模态各打一次
				const filtered = key && key in modalities ? { [key]: modalities[key] } : modalities;
				return textResult(trimData(filtered));
			},
		},
```

- [ ] **Step 4: 装配 + 更新计数断言**

`config.ts` 无需改（`buildCanvasReadTools` 已装配整个数组）。

`services/pi-runtime/src/tools/config.test.ts`：三处 `assert.equal(tools.length, ...)` 由 **36 → 37**、**38 → 39** 更新，并在第一处追加：

```ts
		assert.ok(tools.some((t) => t.name === "list_model_options" && t.tier === "read"));
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm -C services/pi-runtime test 2>&1 | tail -8`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add services/pi-runtime/src/tools/canvas-read.ts services/pi-runtime/src/tools/canvas-read.test.ts services/pi-runtime/src/tools/config.test.ts
git commit -m "feat(pi-runtime): list_model_options 工具（合法模型 ref + 来源，fail-closed）"
```

---

### Task 9: pi-runtime 工具 `update_node`

**Files:**
- Modify: `services/pi-runtime/src/tools/canvas-write.ts`
- Modify: `services/pi-runtime/src/tools/config.test.ts`
- Test: `services/pi-runtime/src/tools/canvas-write.test.ts`（追加）

**Interfaces:**
- Produces: 工具 `update_node`，`tier: "write_light"`，参数：
  ```ts
  { node_id: string; title?: string; image_model?: string; video_model?: string; text_model?: string; audio_model?: string }
  ```
  端点 `POST /agent/internal/update-node`，body `{ sessionId, userId, nodeId, patch }`（patch 为 camelCase）

- [ ] **Step 1: 写失败测试**

追加到 `canvas-write.test.ts`：

```ts
describe("update_node（spec S2）", () => {
	it("snake_case 入参 → camelCase patch；userId/sessionId 只来自 toolContext", async () => {
		const { client, calls } = makeClient();
		const tool = findTool(createCanvasWriteTools(client), "update_node");
		await run(tool, { node_id: "n1", title: "茶馆主视觉", image_model: "platform::seedream-4" });
		assert.equal(calls[0].path, "/agent/internal/update-node");
		assert.deepEqual(calls[0].body, {
			sessionId: "s1",
			userId: "u1",
			nodeId: "n1",
			patch: { title: "茶馆主视觉", imageModel: "platform::seedream-4" },
		});
	});

	it("一个字段都不给 → fail-closed，不打 Nest", async () => {
		const { client, calls } = makeClient();
		const tool = findTool(createCanvasWriteTools(client), "update_node");
		await assert.rejects(() => run(tool, { node_id: "n1" }), /at least one/);
		assert.equal(calls.length, 0);
	});

	it("禁止的字段不进 patch（模型无法借 update_node 改 prompt/content/status）", async () => {
		const { client, calls } = makeClient();
		const tool = findTool(createCanvasWriteTools(client), "update_node");
		await run(tool, { node_id: "n1", title: "X", status: "completed", prompt: "注入" } as never);
		assert.deepEqual(Object.keys(calls[0].body.patch as object), ["title"]);
	});

	it("toolContext 缺 userId → fail-closed", async () => {
		const { client, calls } = makeClient();
		const tool = findTool(createCanvasWriteTools(client), "update_node");
		await assert.rejects(() => run(tool, { node_id: "n1", title: "X" }, { sessionId: "s1" } as LnkpiToolContext), /requires userId/);
		assert.equal(calls.length, 0);
	});

	it("返回 details.actions（实时通道）", async () => {
		const client = {
			post: async () => ({ nodeId: "n1", actions: [{ type: "update_node", payload: { id: "n1", data: { title: "X" } } }] }),
		} as never;
		const tool = findTool(createCanvasWriteTools(client), "update_node");
		const out = (await run(tool, { node_id: "n1", title: "X" })) as { details?: { actions?: unknown[] } };
		assert.equal(out.details?.actions?.length, 1);
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C services/pi-runtime test 2>&1 | tail -8`
Expected: FAIL —— `tool update_node not registered`

- [ ] **Step 3: 实现**

在 `createCanvasWriteTools` 的 `tools` 数组内（`set_node_text` 之后）追加：

```ts
		{
			...write,
			name: "update_node",
			label: "改节点属性",
			description:
				"Update an existing canvas node's title and/or its model (the chip shown in the node dock). Accepts exactly one model field, matching the node type. Ref must come from list_model_options — invented names are rejected. Does NOT touch prompt/content; use set_node_text for text.",
			parameters: Type.Object({
				node_id: Type.String({ description: "Canvas node id" }),
				title: Type.Optional(Type.String({ description: "New node title (non-empty)" })),
				image_model: Type.Optional(Type.String({ description: "image node model ref from list_model_options" })),
				video_model: Type.Optional(Type.String({ description: "video node model ref from list_model_options" })),
				text_model: Type.Optional(Type.String({ description: "text or prompt node model ref from list_model_options" })),
				audio_model: Type.Optional(Type.String({ description: "audio node model ref from list_model_options" })),
			}),
			execute: async (
				_id,
				p: {
					node_id: string;
					title?: string;
					image_model?: string;
					video_model?: string;
					text_model?: string;
					audio_model?: string;
				},
				_u,
				tc: LnkpiToolContext,
			) => {
				if (!tc.userId) throw new Error("update_node requires userId in toolContext");
				// 白名单在 pi 侧再夹一层：harness 不校验 schema，多余字段必须在此丢弃，
				// 否则模型可以用 {status:...} 之类绕过（Nest 侧也会拒，但别让脏数据出网）
				const patch: Record<string, unknown> = {};
				setIfPresent(patch, "title", p.title);
				setIfPresent(patch, "imageModel", p.image_model);
				setIfPresent(patch, "videoModel", p.video_model);
				setIfPresent(patch, "textModel", p.text_model);
				setIfPresent(patch, "audioModel", p.audio_model);
				if (Object.keys(patch).length === 0) {
					throw new Error("update_node requires at least one of title/image_model/video_model/text_model/audio_model");
				}
				return resultWithActions(
					await client.post("/agent/internal/update-node", {
						sessionId: tc.sessionId,
						userId: tc.userId,
						nodeId: p.node_id,
						patch,
					}),
				);
			},
		},
```

- [ ] **Step 4: 更新计数断言**

`config.test.ts`：**37 → 38**、**39 → 40**；追加：

```ts
		assert.ok(tools.some((t) => t.name === "update_node" && t.tier === "write_light"));
```

并把 Task 7 Step 6 的 `WRITE_TOOLS` 列表加入 `"update_node"`（参数 `{ node_id: "n1", title: "X" }`）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm -C services/pi-runtime test 2>&1 | tail -8`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add services/pi-runtime/src/tools/canvas-write.ts services/pi-runtime/src/tools/canvas-write.test.ts services/pi-runtime/src/tools/config.test.ts
git commit -m "feat(pi-runtime): update_node 工具（标题 + 芯片，白名单 fail-closed）"
```

---

### Task 10: pi-runtime 工具 `remove_edges` + 总量收口

**Files:**
- Create: `services/pi-runtime/src/tools/remove-edges.ts`
- Create: `services/pi-runtime/src/tools/remove-edges.test.ts`
- Modify: `services/pi-runtime/src/tools/registry.ts`、`config.ts`、`config.test.ts`

**Interfaces:**
- Produces: 工具 `remove_edges`，`tier: "write_light"`，参数 `{ edge_ids: string[] }`，端点 `POST /agent/internal/remove-edges`，body `{ sessionId, userId, edgeIds }`
- Produces: `export const REMOVE_EDGES_MAX = 20`

- [ ] **Step 1: 写失败测试**

新建 `services/pi-runtime/src/tools/remove-edges.test.ts`：

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { REMOVE_EDGES_MAX, buildRemoveEdgesTools } from "./remove-edges.js";
import type { NestClient } from "./nest-client.js";
import type { LnkpiToolContext } from "./types.js";

const CTX: LnkpiToolContext = { sessionId: "s1", userId: "u1" };

function makeClient(payload: unknown = { actions: [] }) {
	const calls: { path: string; body: unknown }[] = [];
	return {
		calls,
		client: {
			post: async (path: string, body: unknown) => {
				calls.push({ path, body });
				return payload;
			},
		} as unknown as NestClient,
	};
}

const run = (tool: ReturnType<typeof buildRemoveEdgesTools>[number], params: unknown, ctx = CTX) =>
	tool.execute("1", params as never, undefined as never, ctx as never, undefined as never, undefined as never);

describe("remove_edges（spec S4）", () => {
	it("tier=write_light；sessionId 不进 schema；body 带 userId 与 camelCase edgeIds", async () => {
		const { client, calls } = makeClient();
		const [tool] = buildRemoveEdgesTools(client);
		assert.equal(tool.tier, "write_light");
		assert.ok(!JSON.stringify(tool.parameters).includes("sessionId"));
		await run(tool, { edge_ids: ["e1", "e2"] });
		assert.equal(calls[0].path, "/agent/internal/remove-edges");
		assert.deepEqual(calls[0].body, { sessionId: "s1", userId: "u1", edgeIds: ["e1", "e2"] });
	});

	it("超过上限 → execute 内兜底拒绝", async () => {
		const { client, calls } = makeClient();
		const [tool] = buildRemoveEdgesTools(client);
		const tooMany = Array.from({ length: REMOVE_EDGES_MAX + 1 }, (_, i) => `e${i}`);
		await assert.rejects(() => run(tool, { edge_ids: tooMany }), /at most 20/);
		assert.equal(calls.length, 0);
	});

	it("空数组 → 拒绝；缺 userId → fail-closed 不打 Nest", async () => {
		const { client, calls } = makeClient();
		const [tool] = buildRemoveEdgesTools(client);
		await assert.rejects(() => run(tool, { edge_ids: [] }), /requires edge_ids/);
		await assert.rejects(() => run(tool, { edge_ids: ["e1"] }, { sessionId: "s1" }), /requires userId/);
		assert.equal(calls.length, 0);
	});

	it("Nest 的 actions 进 details.actions（实时删边）", async () => {
		const { client } = makeClient({ actions: [{ type: "remove_edge", payload: { id: "e1" } }] });
		const [tool] = buildRemoveEdgesTools(client);
		const out = (await run(tool, { edge_ids: ["e1"] })) as { details?: { actions?: unknown[] } };
		assert.deepEqual(out.details?.actions, [{ type: "remove_edge", payload: { id: "e1" } }]);
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C services/pi-runtime test 2>&1 | tail -8`
Expected: FAIL —— `Cannot find module './remove-edges.js'`

- [ ] **Step 3: 实现**

`services/pi-runtime/src/tools/remove-edges.ts`：

```ts
/**
 * S4：删边工具（tier=write_light）。
 * 复用既有 Nest 端点 /agent/internal/remove-edges（W32），零 Nest 业务改动（仅加 optional userId）。
 * tier 定 write_light 而非 destructive：边不承载数据、画布 undo 可恢复，
 * 且搭骨架时模型需要频繁纠错，归 destructive 只会给未来审批门禁加噪音。
 */
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import type { NestClient } from "./nest-client.js";
import { resultWithActions } from "./result-with-actions.js";

export const REMOVE_EDGES_MAX = 20;

export function buildRemoveEdgesTools(client: NestClient): LnkpiTool[] {
	return [
		{
			tier: "write_light" as const,
			name: "remove_edges",
			label: "删边",
			description:
				"Remove canvas edges by id (max 20 per call). Ids come from get_canvas_layout. Removing a non-existent edge is a no-op, not an error. Use delete_nodes instead when you want to delete the nodes.",
			parameters: Type.Object({
				edge_ids: Type.Array(Type.String({ description: "Canvas edge id" }), {
					description: "edge ids to remove (1-" + REMOVE_EDGES_MAX + " per call)",
				}),
			}),
			execute: async (_id, p: { edge_ids: string[] }, _u, tc: LnkpiToolContext) => {
				if (!tc?.sessionId) throw new Error("remove_edges: missing sessionId in toolContext");
				if (!tc.userId) throw new Error("remove_edges requires userId in toolContext");
				if (!Array.isArray(p.edge_ids) || p.edge_ids.length === 0) {
					throw new Error("remove_edges requires edge_ids (1-" + REMOVE_EDGES_MAX + " per call)");
				}
				if (p.edge_ids.length > REMOVE_EDGES_MAX) {
					throw new Error("remove_edges accepts at most " + REMOVE_EDGES_MAX + " edges per call");
				}
				return resultWithActions(
					await client.post("/agent/internal/remove-edges", {
						sessionId: tc.sessionId,
						userId: tc.userId,
						edgeIds: p.edge_ids,
					}),
				);
			},
		},
	];
}
```

`registry.ts`：追加 `export { buildRemoveEdgesTools } from "./remove-edges.js";` 与对应 import。
`config.ts`：在 tools 数组里加入 `...buildRemoveEdgesTools(client)`。

- [ ] **Step 4: 更新计数断言（收口到终态）**

`config.test.ts`：**38 → 39**、**40 → 41**；追加：

```ts
		assert.ok(tools.some((t) => t.name === "remove_edges" && t.tier === "write_light"));
```

- [ ] **Step 5: 跑全量 pi-runtime + 类型检查**

Run: `pnpm -C services/pi-runtime test > /tmp/pir.log 2>&1; tail -8 /tmp/pir.log`
Expected: PASS，且工具总数断言为 39 / 41
Run: `pnpm -C services/pi-runtime typecheck`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add services/pi-runtime/src/tools/remove-edges.ts services/pi-runtime/src/tools/remove-edges.test.ts services/pi-runtime/src/tools/registry.ts services/pi-runtime/src/tools/config.ts services/pi-runtime/src/tools/config.test.ts
git commit -m "feat(pi-runtime): remove_edges 工具；工具总数收口 39/41"
```

---

### Task 11: 全量验证 + 部署

**Files:** 无代码改动（仅验证与 ops）

**Interfaces:**
- Consumes: 全部产线（Task 1–10）
- Produces: 生产上线的 pi-runtime 新 tag；验收证据

- [ ] **Step 1: 本地全量验证（串行，勿并行）**

```bash
pnpm -C packages/shared test > /tmp/shared.log 2>&1; tail -5 /tmp/shared.log
pnpm -C services/pi-runtime test > /tmp/pir.log 2>&1; tail -5 /tmp/pir.log
pnpm -C apps/server test -- --hookTimeout=120000 > /tmp/srv.log 2>&1; tail -5 /tmp/srv.log
pnpm -C apps/web test > /tmp/web.log 2>&1; tail -5 /tmp/web.log
pnpm -C services/pi-runtime typecheck && pnpm -C apps/server exec tsc --noEmit
```

Expected：全绿；`apps/server` 中仅 `upstream-ref-inline` / `membership.usage.sqlite.integration` 两个已知 flake 可豁免。

- [ ] **Step 2: 配图与规范校验**

```bash
pnpm verify-spec-figures --file docs/superpowers/specs/2026-09-29-canvas-node-crud-completeness-design.md
pnpm verify-spec-figures --file docs/superpowers/plans/2026-09-29-canvas-node-crud-completeness.md
```

Expected：0 错误 0 警告。

> 本机 `tsx` 在沙箱内会因 `CODEBUDDY_BROKER_DENY` 失败，须非沙箱执行该命令。

- [ ] **Step 3: 推送 + PR + CI**

```bash
git fetch origin
git push -u origin feat/canvas-node-crud-completeness
/usr/local/bin/gh --repo sev7n4/pi-lnk pr create --fill
```

等 CI 三项全绿（Verify spec figures / Build monorepo / Build API Docker image）。**队列未清空前不得合并或 dispatch**。

- [ ] **Step 4: 合并后按顺序部署（顺序错了会 404）**

```bash
KUBECONFIG=/etc/rancher/k3s/k3s.yaml helm history pi-lnk-runtime-dev -n pi-lnk-runtime --max 3   # 先看有没有人并行部署
curl -s http://127.0.0.1:5000/v2/pi-runtime/tags/list                                              # 现查占用 tag，别假设「当前 tag+1」
```

1. 等 master 的 `deploy-api` job 绿（新端点在位）——**必须先**；
2. CVM 构建 pi-runtime（`--no-cache`，上下文 = `/root/pi-lnk-build`，`-f services/pi-runtime/Dockerfile .`）；
3. `helm upgrade pi-lnk-runtime-dev ... --set image.tag=<tag> --set env.PI_RUNTIME_VERSION=<tag>`；
4. web 随 push 自动部署。

- [ ] **Step 5: 生产验收（spec §10.2 判据 9）**

```bash
# pod 真伪：镜像 digest 必须等于 push digest
KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n pi-lnk-runtime get pod -o jsonpath='{.items[0].status.containerStatuses[0].imageID}'
KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n pi-lnk-runtime exec deploy/pi-lnk-runtime -- sh -c \
  'grep -rl "remove_edges" /app/dist | head; grep -rl "list_model_options" /app/dist | head'
curl -s http://119.29.173.89:8888/api/...   # healthz 走 k8s
```

目视验收：新建空白画布为 0 节点；一次对话内跑完 spec 场景 D 六步，每步画布**实时**变化（不等回合末）。

- [ ] **Step 6: 记录**

把部署 rev、imageID digest、六步冒烟结果写入 `.workbuddy/memory/2026-09-29.md`。

---

## 计划自审

**1. Spec 覆盖**

| spec 条目 | 任务 |
|---|---|
| S1 去 seed ①② + 锁 ③（场景 A/B/C） | Task 2 |
| S2 `update_node` | Task 3（校验纯函数）+ Task 4（Nest 端点）+ Task 9（工具） |
| S3 `list_model_options` | Task 4 + Task 8 |
| S4 `remove_edges` | Task 5（归属）+ Task 10（工具） |
| S5 写侧实时打通 | Task 7（既有 11 个）+ Task 8/9/10（新工具自带） |
| S6 前端 action 路由 | Task 6 |
| S7 读契约扩展 | Task 5 |
| S8 `removeEdges` 归属 | Task 5 |
| S9 回归锁 | Task 2（seed）、Task 7（details.actions）、Task 8/9/10（计数） |
| §8 纯函数单测 | Task 1 / Task 3 / Task 6 |
| §10.3 部署顺序 | Task 11 Step 4 |

无遗漏。

**2. Placeholder 扫描**：无 TBD / TODO / "类似 Task N"（每处代码均内联；`UserOnlyDto2Dto` 已在 Task 4 Step 5 显式要求复用既有 DTO）。

**3. 类型一致性**：`normalizeModelRef` 返回形状在 Task 1 / Task 3 一致；`NodeModal` 在 Task 3 / Task 4 一致；`resultWithActions` 返回形状在 Task 7 / 8 / 9 / 10 一致；`applyActionsToFlow` 返回值新增 `viewport?` 在 Task 6 定义且唯一调用点在 `CanvasPage.handleAgentActions`（Task 6 Step 3 同任务内改）；工具计数演进 36→37→38→39 / 38→39→40→41 与 Task 8/9/10 逐一对应。

**4. Review Focus 落位**：五条各自有测试——① Task 4（`updateNode` NotFound/Forbidden）；② Task 5（`removeEdges` 幂等）+ Task 6（前端 no-op）；③ Task 2 Step 1 / Task 5（空画布）；④ Task 3 Step 1；⑤ Task 4（无 BYOK 渠道）。
