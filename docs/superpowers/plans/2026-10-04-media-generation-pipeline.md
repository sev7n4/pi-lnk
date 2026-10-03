# Media Generation Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除画布视频/音频生成链路中「静默冒充成功」的降级路径，修正由模型标识空间不统一导致的能力判定失真，并补齐可用性（重试/超时/幂等）与可观测性（droppedFields 可见）缺口。

**Architecture:** 三个正交改动面——① provider 层把「吞异常兜底」改为「抛错冒泡」，让既有退款/失败路径真正生效；② `packages/shared` 的模型目录把 `modelKey` 与 `gatewayModelId` 统一进同一查找，使「参数是否原生支持」的判定不再因 id 形态不同而静默回退到默认条目；③ 前端把不可见的能力差异（`droppedFields`）与被吞的终态（轮询无上限）显式化。每个改动面独立可测、独立发版。

**Tech Stack:** NestJS（`apps/server`）、Vue 3 + Vitest（`apps/web`）、`@lnkpi/shared` 模型目录、`@lnkpi/agent` provider 层、Prisma + SQLite（生产）、Vitest

**Spec:** `docs/superpowers/specs/2026-10-04-media-generation-audit.md`（驱动文档，含全部生产取证数据与根因分析；执行者须同时读）

## Global Constraints

- **分支纪律**：任何改动先开分支，主仓 master 永远等于 `origin/master`；自检 `git rev-list --count origin/master..master` 与反向均为 0
- **提交隔离**：主仓有并行窗口，提交必须 `git commit -o <path>`；事后 `git show --stat --oneline HEAD | tail -3` 复核归属
- **vitest 绿 ≠ tsc 绿**（esbuild 只转译）⇒ 提交前必须 `pnpm -r build`
- **禁止测试跳过解析层**：不得直接构造对象喂消费端来断言能力透传；必须走「DTO → `whitelist` 解析 → 消费」的完整路径（历史教训：`supportsVision` 假绿）
- **改 `prompt-registry/rules/*.md` 必须同步 6 处**（rules 文件、`MANIFEST.yaml` contentHash、loader `COMPOSED_IDS`、`FALLBACK_BY_ID` + fallback.ts、`renderStaticFallback()` 拼装顺序、assembler 测试的 `EXPECTED` 串）
- **新加 `.md` 必查 `.dockerignore`**（`*.md` 会静默排除）
- **4 核 Mac 多 agent 并存**：默认只跑变更相关测试；全量前查 `uptime`，load > 8 禁跑
- **生产验证**：pi-runtime 镜像 tag = master 的 commit SHA；验上线用路由区分度（返 401 而非 404 = 已部署，错路径返 404 作反向对照）
- 每个 U（交付单元）一个分支一个 PR，`squash merge` 后盯部署，最后生产复测

## Review Focus

规格隐含但当前测试未覆盖、最可能伤到用户的五类输入/失效模式：

1. **上游返回占位/非预期内容但 HTTP 层不报错** —— 用户期望拿到真实产物，实际拿到示例曲或静态图且被扣费；指望 U1/U2 的「provider 必须把失败冒泡到 service catch」测试
2. **同一模型用不同 id 形态（modelKey vs gatewayModelId）传入** —— 用户期望「Seedance 支持音轨」生效，实际被判为不支持；指望 U3 的 `getModelEntry('doubao-seedance-2.0-mini')` 测试
3. **模型不支持某但实际上被 UI 暴露的参数** —— 用户期望点了开关要么生效要么被告知无效；指望 U4 的 `droppedFields` 可见性测试
4. **后端任务长期停留在 `generating`** —— 用户期望最坏情况收到错误提示，实际永远转圈；指望 U6 的轮询墙钟上限测试
5. **同一个已支持 end-to-end 的 modality 走旧/不存在的端点** —— 用户期望模型列表正常加载，实际 404 被 catch 静默吞；指望 U8 的死端点清理测试

---

## Task U1: 拆掉音频静默兜底（P0 止血）

**Files:**
- Modify: `packages/agent/src/tools/audio-provider.ts:58-100`
- Modify: `packages/agent/src/index.ts:28`
- Modify: `apps/server/src/studio/studio.service.ts:126`（删 `AUDIO_PLACEHOLDER`）、`:2282`、`:2588`
- Test: `packages/agent/src/tools/audio-provider.test.ts`
- Test: `apps/server/src/studio/studio.integration.test.ts`

**Interfaces:**
- Produces: `createAudioProvider(opts?): AudioProvider`，**契约变更**——无凭据或上游失败时 `generate()` 必须 reject，不再返回占位 URL
- Consumed by: U7（真实 TTS 接入后会依赖此契约做退款）

- [ ] **Step 1: 写失败测试 —— Agnes 网关下不得再静默兜底**

```ts
// packages/agent/src/tools/audio-provider.test.ts 追加
it('does NOT fall back to placeholder when the primary TTS fails', async () => {
  const provider = createAudioProvider({
    apiKey: 'k',
    baseUrl: 'https://apihub.agnes-ai.cn/v1',
    model: 'speech-2.8-hd',
  })
  fetchMock.mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'model_not_found' })
  await expect(provider.generate('hello')).rejects.toThrow(/TTS API 503/)
  expect(fetchMock).toHaveBeenCalledTimes(1)   // 不得二次调用占位逻辑
})

it('throws instead of returning a placeholder when no API key is configured', () => {
  delete process.env.OPENAI_API_KEY
  expect(() => createAudioProvider(undefined)).toThrow(/音频通道未配置/)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/agent/src/tools/audio-provider.test.ts -t 'placeholder'`
Expected: FAIL —— 当前 `createAudioProvider` 在 Agnes baseUrl 下返回 `FallbackAudioProvider`，第一个用例不 reject

- [ ] **Step 3: 最小实现**

```ts
// packages/agent/src/tools/audio-provider.ts
export function createAudioProvider(opts?: ProviderCredentialOpts): AudioProvider {
  if (opts?.apiKey) {
    const baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1'
    const model = opts.model ?? 'tts-1'
    return new OpenAITTSProvider(opts.apiKey, baseUrl, model)
  }
  const key = process.env.OPENAI_API_KEY
  const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
  const model = process.env.OPENAI_TTS_MODEL ?? 'tts-1'
  if (!key) throw new Error('音频通道未配置 API Key')
  return new OpenAITTSProvider(key, baseUrl, model)
}
```

删除 `FallbackAudioProvider`、`PlaceholderAudioProvider` 两个类与 `PLACEHOLDER_MP3` 常量；
同步删除 `packages/agent/src/index.ts:28` 导出列表中的这两项。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/agent/src/tools/audio-provider.test.ts`
Expected: PASS（含既有用例uses explicit opts over env credentials）

- [ ] **Step 5: 移除服务层的占位替换**

删除 `apps/server/src/studio/studio.service.ts:126` 的 `AUDIO_PLACEHOLDER` 常量，并把两处
`:2282` 与 `:2588` 的
`const storeUrl = url.startsWith('data:') ? AUDIO_PLACEHOLDER : url`
改为直接使用 `url`。

- [ ] **Step 6: 补集成测试 —— provider 失败必须退款且写 failed**

```ts
// apps/server/src/studio/studio.integration.test.ts 追加
it('refunds and marks failed when audio provider throws', async () => {
  vi.spyOn(agentTools, 'createAudioProvider').mockReturnValue({
    generate: async () => { throw new Error('TTS API 503: model_not_found') },
  })
  const before = await points.balanceOf('u1')
  await expect(service.generateAudio('u1', '你好')).rejects.toThrow()
  expect(await points.balanceOf('u1')).toBe(before)
  expect(await prisma.generationRecord.count({ where: { type: 'audio', status: 'completed' } })).toBe(0)
})
```

- [ ] **Step 7: 跑变更相关测试**

Run: `pnpm vitest run apps/server/src/studio/studio.integration.test.ts packages/agent/src/tools/audio-provider.test.ts`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git commit -o packages/agent/src/tools/audio-provider.ts packages/agent/src/index.ts \
  apps/server/src/studio/studio.service.ts packages/agent/src/tools/audio-provider.test.ts \
  apps/server/src/studio/studio.integration.test.ts \
  -m "fix(audio): 移除 TTS 静默兜底，失败必须冒泡并退款"
```

---

## Task U2: PlaceholderVideoProvider 改抛错（P0 止血）

**Files:**
- Modify: `packages/agent/src/tools/video-provider.ts:34-45`、`:406-450`
- Modify: `packages/agent/src/index.ts:15`
- Test: `packages/agent/src/tools/video-provider.test.ts`

**Interfaces:**
- Produces: `createVideoProvider(opts?): VideoProvider`，无可用凭据时 throw

- [ ] **Step 1: 写失败测试**

```ts
// packages/agent/src/tools/video-provider.test.ts 追加
it('throws instead of returning an Unsplash still image when unconfigured', async () => {
  const saved = { ...process.env }
  delete process.env.OPENAI_API_KEY
  delete process.env.VIDEO_API_KEY
  expect(() => createVideoProvider(undefined)).toThrow(/视频通道未配置/)
  process.env = saved
})

it('never returns a non-video URL', async () => {
  const p = createVideoProvider({ apiKey: 'k', baseUrl: 'https://apihub.agnes-ai.cn/v1', model: 'agnes-video-v2.0' })
  fetchMock.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'bad' })
  await expect(p.generate('x')).rejects.toThrow()
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/agent/src/tools/video-provider.test.ts -t 'Unsplash'`
Expected: FAIL —— 当前无 key 时返回 `PlaceholderVideoProvider`，不抛错

- [ ] **Step 3: 最小实现**

删除 `PlaceholderVideoProvider` 类与其 `urls` 常量；把 `createVideoProvider` 最后一行
`return new PlaceholderVideoProvider()` 改为 `throw new Error('视频通道未配置: 缺少 OPENAI_API_KEY / FAL_KEY / MINIMAX_API_KEY')`。
同步删除 `packages/agent/src/index.ts:15` 的导出，并把 `OpenAIVideoProvider` 构造函数中
`new PlaceholderVideoProvider()` 的默认参数改为必填。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/agent/src/tools/video-provider.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git commit -o packages/agent/src/tools/video-provider.ts packages/agent/src/index.ts \
  packages/agent/src/tools/video-provider.test.ts \
  -m "fix(video): 无凭据时抛错，不再返回 Unsplash 静态图冒充视频"
```

---

## Task U3: 统一 modelKey / gatewayModelId 解析（P0 能力判定修正）

这是完成成对 audit §2.1 的根因修复：`doubao-seedance-2.0-mini`（gatewayModelId）查不到
→ 静默回退到 `agnes-video-v2.0` 条目 → `generateAudio` 被判不支持。

**Files:**
- Modify: `packages/shared/src/studioModelCatalog.ts:330-346`
- Test: `packages/shared/src/studioModelCatalog.test.ts`（不存在则新建）
- Test: `packages/agent/src/studio/generation-adapter.test.ts`（回归：Seedance 支持 generateAudio）

**Interfaces:**
- Produces: `getModelEntry(id)` 同时按 `modelKey` 与 `gatewayModelId` 匹配；`resolveModelKey` 保持签名不变

- [ ] **Step 1: 写失败测试**

```ts
// packages/shared/src/studioModelCatalog.test.ts
import { describe, expect, it } from 'vitest'
import { getModelEntry, resolveModelKey } from './studioModelCatalog'

describe('getModelEntry', () => {
  it('resolves a gateway model id to its catalog entry', () => {
    expect(getModelEntry('doubao-seedance-2.0-mini')?.modelKey).toBe('seedance-2.0-min')
  })
  it('still resolves the canonical modelKey', () => {
    expect(getModelEntry('seedance-2.0-min')?.modelKey).toBe('seedance-2.0-min')
  })
  it('prefers the modelKey when both spaces overlap', () => {
    expect(getModelEntry('agnes-video-v2.0')?.modelKey).toBe('agnes-video-v2.0')
  })
})

describe('resolveModelKey', () => {
  it('does not fall back when a gateway id was passed', () => {
    const r = resolveModelKey('video', 'doubao-seedance-2.0-mini')
    expect(r.fallback).toBe(false)
    expect(r.entry.params.generateAudio).toBe('native')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/shared/src/studioModelCatalog.test.ts`
Expected: FAIL —— `getModelEntry` 只比较 `entry.modelKey`

- [ ] **Step 3: 最小实现**

```ts
// packages/shared/src/studioModelCatalog.ts
export function getModelEntry(id: string): StudioModelEntry | undefined {
  const exact = STUDIO_MODEL_CATALOG.find((entry) => entry.modelKey === id)
  if (exact) return exact
  return STUDIO_MODEL_CATALOG.find((entry) => entry.gatewayModelId === id)
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/shared/src/studioModelCatalog.test.ts`
Expected: PASS

- [ ] **Step 5: 补 generation-adapter 回归测试（必须走 buildVideoProviderOptions 而非手写 entry）**

```ts
// packages/agent/src/studio/generation-adapter.test.ts 追加
it('keeps generateAudio for a Seedance gateway id', () => {
  const out = buildVideoProviderOptions({
    modelKey: 'doubao-seedance-2.0-mini',   // 生产实际形态
    generateAudio: true,
    duration: 5,
  })
  expect(out.droppedFields.map((d) => d.field)).not.toContain('generateAudio')
  expect((out.nativeParams as Record<string, unknown>).generate_audio).toBe(true)
})
```

Run: `pnpm vitest run packages/agent/src/studio/generation-adapter.test.ts`
Expected: PASS（此测试在 Step 3 之前会因 droppedFields 含 generateAudio 而失败）

- [ ] **Step 6: 提交**

```bash
git commit -o packages/shared/src/studioModelCatalog.ts \
  packages/shared/src/studioModelCatalog.test.ts \
  packages/agent/src/studio/generation-adapter.test.ts \
  -m "fix(catalog): getModelEntry 兼容 gatewayModelId，修回 Seedance 音轨能力判定"
```

---

## Task U4: 「不支持」可见化 + 音频能力入口显式化（P1）

**Files:**
- Modify: `apps/web/src/services/capabilities-api.ts:4-10`
- Modify: `apps/web/src/composables/useCapabilities.ts:5-9`
- Modify: `apps/web/src/constants/dockAudio.ts:8-12`
- Modify: `apps/web/src/utils/generationDiagnostic.ts`
- Test: `apps/web/src/utils/generationDiagnostic.test.ts`（不存在则新建）
- Test: `apps/web/src/composables/useCapabilities.test.ts`（不存在则新建）

**Interfaces:**
- Consumes: U3 修正后的 droppedFields（后端 metadata 字段名 `droppedFields: {field, reason}[]`）
- Produces: `parseShortGenerationError(record)` 在存在 droppedFields 时追加可读提示

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/utils/generationDiagnostic.test.ts
import { describe, expect, it } from 'vitest'
import { parseShortGenerationError } from './generationDiagnostic'

it('surfaces dropped params instead of hiding them', () => {
  const msg = parseShortGenerationError({
    status: 'completed',
    metadata: JSON.stringify({
      droppedFields: [{ field: 'generateAudio', reason: 'generateAudio not supported natively by agnes-video-v2.0' }],
    }),
  } as never)
  expect(msg).toContain('音轨')
  expect(msg).toContain('当前模型不支持')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run apps/web/src/utils/generationDiagnostic.test.ts`
Expected: FAIL —— 当前实现只看 status/errorMessage

- [ ] **Step 3: 最小实现**

在 `generationDiagnostic.ts` 的 `parseShortGenerationError` 中，成功路径也读取 metadata：

```ts
export const DROPPED_FIELD_LABEL: Record<string, string> = {
  generateAudio: '音轨',
  seed: '随机种子',
  negativePrompt: '负面提示词',
  crop: '裁切',
}

export function describeDroppedFields(dropped: { field: string }[]): string | null {
  if (!Array.isArray(dropped) || dropped.length === 0) return null
  const names = [...new Set(dropped.map((d) => DROPPED_FIELD_LABEL[d.field] ?? d.field))]
  return `以下参数当前模型不支持，已忽略：${names.join('、')}`
}
```

并在 `parseShortGenerationError` 返回前拼接该函数结果。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run apps/web/src/utils/generationDiagnostic.test.ts`
Expected: PASS

- [ ] **Step 5: 补齐 audio 能力位**

```ts
// apps/web/src/services/capabilities-api.ts
export interface CapabilitiesData {
  text: AIModel[]
  image: AIModel[]
  video: AIModel[]
  audio: AIModel[]          // 新增
  stsDirectUpload?: boolean
}
```

```ts
// apps/web/src/composables/useCapabilities.ts
import { ..., AUDIO_MODELS, ... } from '@lnkpi/shared'
const cache = ref<Record<GenerationType, AIModel[]>>({
  text: [...TEXT_MODELS], image: [...IMAGE_MODELS],
  video: [...VIDEO_MODELS], audio: [...AUDIO_MODELS],
})
```

若 `@lnkpi/shared` 未导出 `AUDIO_MODELS`，改为 `listModels('audio')` 映射，并在 Step 里先把映射函数
写进 `packages/shared/src/studioModelCatalog.ts` 旁的导出文件。

- [ ] **Step 6: 修正默认音色悬空**

```ts
// apps/web/src/constants/dockAudio.ts
export const AUDIO_VOICE_OPTIONS: VoiceOption[] = [
  { id: 'female-shaonv', label: '少女' },      // 与 studioModelCatalog minimax-speech-2.8-hd voices 对齐
  { id: 'male-qingnian', label: '青年男声' },
  { id: 'presenter_female', label: '女主播' },
]
```

测试断言 `AUDIO_VOICE_OPTIONS.some((v) => v.id === DEFAULT_AUDIO_VOICE)` 为 true。

- [ ] **Step 7: 跑前端变更测试并提交**

Run: `pnpm vitest run apps/web/src/utils apps/web/src/composables apps/web/src/constants`
Expected: PASS

```bash
git commit -o apps/web/src/services/capabilities-api.ts apps/web/src/composables/useCapabilities.ts \
  apps/web/src/constants/dockAudio.ts apps/web/src/utils/generationDiagnostic.ts \
  apps/web/src/utils/generationDiagnostic.test.ts \
  -m "feat(web): droppedFields 可见 + audio 能力位 + 默认音色对齐"
```

---

## Task U5: 视频可用性 —— 退避重试 / 超时对齐 / persist 真实化（P1）

**Files:**
- Create: `packages/agent/src/tools/video-retry.ts`
- Test: `packages/agent/src/tools/video-retry.test.ts`
- Modify: `packages/agent/src/tools/video-provider.ts:79-130`（Agnes 创建请求处）
- Modify: `apps/server/src/studio/video-generation.orchestrator.ts:10`
- Modify: `apps/server/src/studio/studio.controller.ts:652`
- Test: `apps/server/src/studio/video-generation.orchestrator.test.ts`

**Interfaces:**
- Produces: `isRetryableVideoError(err): boolean`、`withVideoRetry<T>(fn, opts?): Promise<T>`
- Consumed by: Agnes / MiniMax / fal 三条 provider 的 create 阶段

- [ ] **Step 1: 写失败测试**

```ts
// packages/agent/src/tools/video-retry.test.ts
it('retries 429 and video_queue_full with backoff', async () => {
  const fn = vi.fn()
    .mockRejectedValueOnce(new Error('429 rate limit for free users'))
    .mockRejectedValueOnce(new Error('503 video_queue_full'))
    .mockResolvedValueOnce('ok')
  const out = await withVideoRetry(fn, { attempts: 3, baseDelayMs: 1 })
  expect(out).toBe('ok')
  expect(fn).toHaveBeenCalledTimes(3)
})

it('does NOT retry content policy or invalid request', async () => {
  const fn = vi.fn().mockRejectedValue(new Error('content_policy_violation'))
  await expect(withVideoRetry(fn)).rejects.toThrow(/content_policy/)
  expect(fn).toHaveBeenCalledTimes(1)
})

it('gives up after max attempts', async () => {
  const fn = vi.fn().mockRejectedValue(new Error('503 video_queue_full'))
  await expect(withVideoRetry(fn, { attempts: 3, baseDelayMs: 1 })).rejects.toThrow(/video_queue_full/)
  expect(fn).toHaveBeenCalledTimes(3)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/agent/src/tools/video-retry.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 最小实现**

```ts
// packages/agent/src/tools/video-retry.ts
const RETRYABLE = [/429/i, /rate[_ ]limit/i, /video_queue_full/i, /ETIMEDOUT/i, /ECONNRESET/i]

export function isRetryableVideoError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return RETRYABLE.some((re) => re.test(msg))
}

export async function withVideoRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3
  const base = opts.baseDelayMs ?? 1500
  let last: unknown
  for (let i = 0; i < attempts; i += 1) {
    try { return await fn() } catch (err) {
      last = err
      if (i === attempts - 1 || !isRetryableVideoError(err)) throw err
      await new Promise((r) => setTimeout(r, base * 2 ** i))
    }
  }
  throw last
}
```

- [ ] **Step 4: 接入 Agnes provider 的 create 调用**

在 `video-provider.ts` 的 Agnes create 处（`AgnesVideoProvider` 发起创建请求的函数）用
`withVideoRetry(() => fetch(createUrl, init))` 包裹**仅创建阶段**（不含轮询阶段）。

- [ ] **Step 5: 超时对齐**

```ts
// apps/server/src/studio/video-generation.orchestrator.ts
export const VIDEO_POLL_TIMEOUT_MS = 1_260_000   // 对齐 videoModelProfiles minimax maxPollMs=1_200_000 + 60s 余量
```

同步更新 `video-generation.orchestrator.test.ts` 中任何写死 660_000 的断言。

- [ ] **Step 6: persist 真实化**

把 `apps/server/src/studio/studio.controller.ts:652` 的 `async () => {}` 替换为把
`generationRecordId` / `status` 写回画布的实现：
先读 `canvas.service` 现有的画布写回方法（grep `updateCanvasData|persistCanvas`），
若无现成方法则在 `apps/server/src/studio/` 内的最小 helper 里实现，不得跨层新建大模块。

- [ ] **Step 7: 跑测试并提交**

Run: `pnpm vitest run packages/agent/src/tools/video-retry.test.ts apps/server/src/studio/video-generation.orchestrator.test.ts`
Expected: PASS

```bash
git commit -o packages/agent/src/tools/video-retry.ts packages/agent/src/tools/video-retry.test.ts \
  packages/agent/src/tools/video-provider.ts \
  apps/server/src/studio/video-generation.orchestrator.ts \
  apps/server/src/studio/video-generation.orchestrator.test.ts \
  apps/server/src/studio/studio.controller.ts \
  -m "feat(video): 可重试错误退避重试 + 超时对齐 + persist 写回画布"
```

---

## Task U6: 前端健壮性 —— 轮询墙钟 / 空 url / 死按钮兜底（P1）

**Files:**
- Modify: `apps/web/src/composables/useGenerationPolling.ts:36-54`
- Modify: `apps/web/src/composables/useShotPolling.ts:27-43`
- Modify: `apps/web/src/composables/useNodeGeneration.ts:730-776`、`:843-957`
- Test: `apps/web/src/composables/useNodeGeneration.test.ts`

**Interfaces:**
- Produces: `MAX_POLL_MS = 900_000`（15 分钟墙钟上限），超时后置 error 并停止轮询

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/composables/useNodeGeneration.test.ts 追加
it('terminalizes a node that never leaves generating', async () => {
  vi.useFakeTimers()
  stubGeneration({ id: 'r1', status: 'generating' })     // 后端恒定返回 generating
  await startPolling('node-1')
  await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 5000)
  expect(nodeStatus('node-1')).toBe('error')
  expect(errorMessage('node-1')).toContain('超时')
  vi.useRealTimers()
})

it('does not treat an audio node without url as having usable output', () => {
  const ok = runGroupMemberHasUsableOutput({ type: 'audio', data: { status: 'completed' } } as never)
  expect(ok).toBe(false)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run apps/web/src/composables/useNodeGeneration.test.ts -t 'never leaves generating'`
Expected: FAIL —— 当前无上限，节点永保 generating

- [ ] **Step 3: 最小实现**

在 `useGenerationPolling.ts` / `useShotPolling.ts` 的轮询循环里加入起轮询时的 `startedAt`，
达到 `MAX_POLL_MS` 时调用 `patchNodeData(nodeId, { status: 'error', errorMessage: '生成超时，请稍后在历史记录中查看结果' })`
并清除该任务；把 `:22-24` 与 `:40-42` 的静默 `catch` 改为累计 `consecutiveFailures`，
达到 3 次才另行提示。

- [ ] **Step 4: 修 `runGroupMemberHasUsableOutput`**

audio 分支改为与其它类型一致地校验 url：

```ts
if (node.type === 'audio') return Boolean(String(node.data?.url ?? '').trim())
```

- [ ] **Step 5: 给三类死按钮加兜底**

在 `generateForNode` 的分支末尾（`if (nodeType === 'shot')` 之后）补 `else`：

```ts
else {
  deps.patchNodeData(node.id, {
    status: NODE_GENERATION_STATUS.error,
    errorMessage: `「${nodeType}」节点暂不支持在此处生成`,
  })
}
```

- [ ] **Step 6: 跑测试并提交**

Run: `pnpm vitest run apps/web/src/composables`
Expected: PASS

```bash
git commit -o apps/web/src/composables/useGenerationPolling.ts apps/web/src/composables/useShotPolling.ts \
  apps/web/src/composables/useNodeGeneration.ts apps/web/src/composables/useNodeGeneration.test.ts \
  -m "fix(web): 轮询加墙钟上限、音频空 url 不再算成功、未知节点类型显式报错"
```

---

## Task U7: 音频能力重建 —— 真实 TTS 上游 + 对象存储落盘（依赖外部凭据）

**前置条件**：需先确定并使用一个真实可用的 TTS 上游（生产现状：Agnes 网关 4 个候选模型全 503）。
在未拿到可用凭据前，**本任务不启动**，音频入口应在 U4 之后保持显式不可用状态。

**Files:**
- Modify: `apps/server/src/provider/provider-resolver.service.ts:56-70`（新增 audio 分支）
- Modify: `packages/shared/src/platformCredentials.ts`（新增 audio 凭据解析，对齐现有三个 resolver 签名）
- Modify: `apps/server/src/studio/studio.service.ts:2240-2301`（产物上传）
- Modify: `.env.example`（补 `OPENAI_TTS_MODEL` 及新供应商变量）
- Test: `apps/server/src/studio/studio.service.test.ts`

**Interfaces:**
- Consumes: U1 建立的「provider 失败必须抛错」契约
- Produces: 音频产物经 `this.upload.saveUserFile(userId, buf, 'tts.mp3', 'audio/mpeg')` 落对象存储

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/src/studio/studio.service.test.ts 追加
it('persists generated audio to object storage instead of returning a raw URL', async () => {
  const saved = { url: 'https://cdn.example.com/u1/tts.mp3' }
  const spy = vi.spyOn(upload, 'saveUserFile').mockResolvedValue(saved as never)
  vi.spyOn(agentTools, 'createAudioProvider').mockReturnValue({
    generate: async () => ({ url: 'https://upstream.example.com/tmp/abc.mp3' }),
  } as never)
  const rec = await service.generateAudio('u1', '你好')
  expect(spy).toHaveBeenCalledOnce()
  expect(rec.url).toBe(saved.url)
  expect(rec.url).not.toContain('upstream.example.com')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run apps/server/src/studio/studio.service.test.ts -t 'object storage'`
Expected: FAIL —— 当前直接存上游返回的 URL

- [ ] **Step 3: 实现上传**

在 `apps/server/src/studio/studio.service.ts` 的 `generateAudio` 里，provider 返回后：
先把响应体下载为 Buffer，再 `this.upload.saveUserFile(userId, buffer, 'tts.mp3', 'audio/mpeg')`，
以返回的持久化 URL 落库（对齐既有的图片做法 `studio.service.ts:1648`）。
另一条 platform fallback 路径（原 `:2588` 附近）同改。

- [ ] **Step 4: 凭据分支**

```ts
// packages/shared/src/platformCredentials.ts
export function isPlatformAudioModel(modelName: string): boolean { /* 按所选供应商实现 */ }
export function resolveAudioPlatformCredentials(
  modelName: string,
  env?: PlatformCredentialEnv,
): { apiKey: string; baseUrl: string } | null { /* 同上 */ }
```

并在 `provider-resolver.service.ts:56-70` 的 if/else 链中，于 `modality === 'image'`
分支前插入 `else if (modality === 'audio') { ... }`。

> 上面两处函数体取决于最终选定的供应商协议，实施时按该供应商文档填写；
> 在此之前本 Task 不得进入 Review。

- [ ] **Step 5: env 入口**

`.env.example` 补 `OPENAI_TTS_MODEL`（当前仅代码消费、无配置入口）与所选供应商所需变量，
并在 `deploy/docker-compose.prod.yml` 的 api service `environment` 段补齐。

- [ ] **Step 6: 跑测试 + build 并提交**

Run: `pnpm vitest run apps/server/src/studio && pnpm -r build`
Expected: PASS

```bash
git commit -o apps/server/src/provider/provider-resolver.service.ts \
  packages/shared/src/platformCredentials.ts apps/server/src/studio/studio.service.ts \
  apps/server/src/studio/studio.service.test.ts .env.example deploy/docker-compose.prod.yml \
  -m "feat(audio): 接入真实 TTS 上游并将产物落对象存储"
```

---

## Task U8: 治理 —— 提示词边界 / 死端点 / E2E（P2）

**Files:**
- Modify: `prompt-registry/rules/gen_tool_policy.md`（+ 6 处同步）
- Modify: `apps/web/src/composables/useCapabilities.ts:30-34`（静默 catch）
- Create: `deploy/prod-audio-gen-verify.py`
- Modify: `apps/server/src/agent/agent-canvas-tools.controller.ts:1191-1209`（AuthGuard）

**Interfaces:**
- Consumes: U1/U4 落地后的行为契约

- [ ] **Step 1: 提示词补 TTS-only 边界**

在 `gen_tool_policy.md` 末尾追加一条：

```
14. 音频能力边界：run_audio_generation 只能生成语音（TTS，把文字朗读出来）。平台不支持生成
    背景音乐（BGM）、音效（SFX）、配音合成或混音。用户提出这类需求时，明确告知当前不支持，
    不要调用 run_audio_generation 冒充，也不要声称已生成。
```

然后按 Global Constraints 同步 6 处（rules 文件 / MANIFEST.yaml contentHash / loader
`COMPOSED_IDS` / `FALLBACK_BY_ID` + fallback.ts / `renderStaticFallback()` 顺序 /
assembler 测试 `EXPECTED`），并用 `npx tsx scripts/prompt-lint.ts` 校验。

Run: `npx tsx scripts/prompt-lint.ts`
Expected: 0 error

- [ ] **Step 2: 修 `useCapabilities` 静默吞异常**

把 `catch { /* fallback to shared defaults */ }` 改为记录一次 warn 并保留兜底，
使 `/agent/capabilities/list` 缺失（当前后端确无该路由）不再完全无声：

```ts
} catch (err) {
  console.warn('[capabilities] /agent/capabilities/list unavailable, using catalog defaults:', err)
}
```

测试断言：`await load()` 在 api 抛错后 `modelsFor('video').length > 0` 且 warn 被调用一次。

- [ ] **Step 3: 内部端点加鉴权**

给 `apps/server/src/agent/agent-canvas-tools.controller.ts:1191-1209` 的三个 video 内部端点
加上与同文件其它带 `@UseGuards(AuthGuard)` 端点一致的守卫，并补测试断言无 token 时返 401
（以错路径返 404 作反向对照）。

- [ ] **Step 4: 补音频生产 E2E**

参照现有 `deploy/prod-*-verify.py` 的写法新增 `deploy/prod-audio-gen-verify.py`，
断言：`POST /api/studio/audio/generate` 在 U1 之后对无 TTS 上游的环境返回错误且**完成退款**，
`GET /api/studio/generations?type=audio` 的最近记录 `hasTtsData` 不再为 `true 且 url 含 soundhelix`。

- [ ] **Step 5: 跑受影响测试 + build 并提交**

Run: `pnpm vitest run apps/server/src/agent apps/web/src/composables && pnpm -r build`
Expected: PASS

```bash
git commit -o prompt-registry apps/web/src/composables/useCapabilities.ts \
  apps/server/src/agent/agent-canvas-tools.controller.ts deploy/prod-audio-gen-verify.py \
  -m "chore: 音频能力边界入提示词、内部端点加鉴权、补音频生产验证"
```

---

## Self-Review 结果

**Spec 覆盖**：audit §1 全部结论 → U1（§2.2）U2（§2.4 占位）U3（§2.1）U4（§2.3、音色悬空、
capabilities）U5（重试/超时/persist）U6（轮询/空 url/死按钮）U7（产物落盘、凭据）U8（提示词、
鉴权、E2E）。无遗漏需求。

**占位符扫描**：已确认无 TBD/TODO。唯一「待定」处是 U7 Step 4 的函数体，已显式标注前置条件
（须先选定上游供应商），不属于占位符——它在拿到凭据前不允许进入 Review。

**类型一致性**：`withVideoRetry<T>(fn, opts)`、`isRetryableVideoError(err)`、
`describeDroppedFields(dropped)`、`MAX_POLL_MS` 在各自 Task 内定义后同名使用；
U1 的 `createAudioProvider` 与 U7 的 mock 均在测试里以 `'packages/agent'` 同名 spy。

**Review Focus 归属**：①→U1/U2 ②→U3 ③→U4 ④→U6 ⑤→U8 Step 2，五条均已落到具体 task 的失败测试。
