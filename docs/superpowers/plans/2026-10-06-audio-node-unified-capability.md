# 音频节点统一创作能力 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让画布「音」这一个节点内部承载 `voice`（配音）/ `design`（综合音频）/ `music`（音乐）三类创作，agent 能自主选分类、填参数、直接产出音频；三类能力对所有用户默认可用（平台级 StepFun 通道）。

**Architecture:** 顶层模态固定四值不动，`audio` 之下新增二阶分类 `AudioKind`。分类是可读可写的节点字段（不跟随模型隐式切换），参数区与模型下拉都按它过滤。执行侧沿用既有「pending 确认 → run → 扣分/退款」链路：`design` 走同步 HTTP 新端点，`music` 走异步任务（创建 `status:'generating'` 的 GenerationRecord，前端既有轮询器直接接管）。平台凭证只从 env 读（`STEPFUN_API_KEY`），按模型名在 resolver 的 else-if 链中分流。

**Tech Stack:** TypeScript / NestJS / Vue 3 / vitest（`@lnkpi/*`）/ `node --import tsx --test`（`@pi-lnk/pi-runtime`）/ TypeBox（工具 schema）

**Spec:** `docs/superpowers/specs/2026-10-06-audio-node-unified-capability-design.md`

## Global Constraints

- **L6 提示词硬线 3200 字符**。改 `prompt-registry` 后必须跑 `pnpm prompt:lint`。最紧组合 `core+writeTools+genTools` 当前实测 3076 ⇒ **余量 124**，规则 23 只能**等量改写**，不得新增长句。
- **积分**：`voice` 5 分（不变）、`design` 5 分、`music` 15 分。三者共用同一条 `points.consume` / `points.refund` 链路。
- **顶层节点类型不新增**：`StudioModality` 仍为 `'text' | 'image' | 'video' | 'audio'`；画布顶层入口仍是 图/文/音/视频。
- **工具参数一律追加到末尾**，不改既有位置参数顺序（仓库纪律：同型参数错位不报错只静默错值）。
- **平台凭证只从 env 读**（`STEPFUN_API_KEY` / `STEPFUN_BASE_URL`），写 DB 无效。变量落点已由 PR #239 建立（GitHub Secret → `deploy.yml` 幂等 upsert → `/opt/lnkpi/.env`）。
- **平台只登记 3 条模型**：`stepaudio-3-tts` / `stepaudio-3-gen-preview` / `stepaudio-3-music-preview`。`realtime`、ASR **不登记**。
- **禁止静默回退**：任何「不可用」必须显式可判读（缺 key、402、终态 FAILED、模型不在目录），不得回落到别的模型或端点。
- **交付前必跑**：目标包 `tsc --noEmit` → 目标包测试 → `pnpm verify-claims` → `pnpm verify-tool-contract` →（改提示词时）`pnpm prompt:lint`。
- **测试命令形态**：`@lnkpi/{shared,agent,server,web}` 用 vitest；`@pi-lnk/pi-runtime` **必须** `cd services/pi-runtime && node --import tsx --test src/<file>.test.ts`（`pnpm --filter ... test -- <pat>` 会把 pattern 追加到 glob 后导致仍跑全量）。

## Review Focus

以下五类输入/失败模式是规格隐含、但没有任何任务测试覆盖时最容易伤到人的，已逐条落到 owning task 的测试里：

1. **平台侧缺 `STEPFUN_API_KEY`** —— 期望：显式报错说「平台音频通道未配置密钥」。**不是**把 `stepaudio-3-*` 模型名发到 OpenAI 端点（静默错路由）。→ Task 3 / Task 4
2. **用户 BYOK 渠道 21 个音频模型平铺一个桶** —— 期望：模型下拉按 kind 过滤，选「音乐」不会列出 TTS 模型。→ Task 9
3. **music 终态 `FAILED` 但 HTTP 200** —— 期望：按任务状态字段判失败、退款、写可判读文案。→ Task 7 / Task 4
4. **存量节点无 `audioKind`** —— 期望：逐字节等价今天的 TTS 行为（扣 5 分、data URL 转存、返回形态不变）。→ Task 2 / Task 4
5. **上游 402 余额不足** —— 期望：文案可判读为「平台音频额度不足」。→ Task 4

---

## File Structure

**Create**
- `packages/agent/src/tools/stepfun-audio.ts` —— StepFun `design` / `music` 两个新调用形态（同步音频生成 + 异步任务），返回 `Buffer` 而非 data URL，强制走对象存储转存。
- `packages/agent/src/tools/stepfun-audio.test.ts` —— 上者的单测（假 fetch）。
- `apps/server/src/studio/audio-kind.ts` —— `AudioKind` 判别、按 kind 取默认模型、StepFun 音频凭证解析、失败文案映射（纯函数，便于单测）。
- `apps/server/src/studio/audio-kind.test.ts`

**Modify**
- `packages/shared/src/platformCredentials.ts` —— 新增 StepFun 平台凭证解析（Task 1）
- `packages/shared/src/platformCredentials.test.ts`
- `packages/shared/src/studioModelCatalog.ts` —— `AudioKind` 类型 + `StudioModelEntry.audioKind` + 2 条新条目 + 4 条既有条目补 kind（Task 2）
- `packages/shared/src/studioModelCatalog.test.ts`
- `apps/server/src/provider/provider-resolver.service.ts` —— else-if 链挂 StepFun（Task 3）
- `apps/server/src/provider/provider-resolver.service.test.ts`
- `apps/server/src/studio/studio.service.ts` —— 音频路径按 kind 分派；第二处入口（降级重放）改走纯函数取凭证；402 文案（Task 4 / Task 6 / Task 7）
  > ⚠️ `apps/server/src/studio/studio.service.test.ts` **本计划不改**：它现在只有 `editImage` 用例（181 行），没有 fallback/prisma/points 夹具；为音频另造一套 mock 必然假绿。音频侧验证走 `audio-kind.ts` 的纯函数用例 + 调用点源码锁。
- `apps/server/src/provider/provider.service.ts` —— 平台可选项含三类（Task 5）
- `apps/server/src/provider/provider.service.test.ts`
- `apps/server/src/agent/agent-canvas-tools.service.ts` —— `listNodeModelOptions` 带 `audioKind`（Task 5）
- `apps/server/src/agent/agent-canvas-tools.service.test.ts`
- `services/pi-runtime/src/tools/generation.ts` —— `run_audio_generation` 扩展 kind + 内联参数（Task 8）
- `services/pi-runtime/src/tools/generation.test.ts`
- `services/pi-runtime/src/tools/config.ts` —— 音频超时按 kind 扩（Task 7）
- `services/pi-runtime/src/tools/config.test.ts`
- `apps/server/src/agent/agent-canvas-tools.controller.ts` —— `runAudioGeneration` body 透传 kind/params（Task 8）
- `apps/web/src/components/canvas/dock-studio/panels/AudioDockPanel.vue` —— chip 行 + 参数区互斥（Task 9）
- `apps/web/src/components/canvas/UniversalModelSelector.vue` —— 按 kind 过滤候选（Task 9）
- `apps/web/src/services/studio-api.ts` —— `AudioGenerateOptions` 增 `kind` + 各类参数（Task 6 / Task 9）
- `apps/web/src/composables/useNodeGeneration.ts` —— 音频分支透传 kind/params（Task 9）
- `apps/web/src/constants/dockAudio.ts` / `apps/web/src/constants/credits.ts` —— kind 常量、按 kind 取模型、积分估算（Task 9）
- `apps/web/src/constants/dockAudio.test.ts` / `apps/web/src/constants/credits.test.ts` —— **已存在**，追加 kind 用例（Task 9）
- `prompt-registry/rules/gen_tool_policy.md` —— 规则 23 等量改写（Task 10）
- `skills/drama-audio-design/*` —— 移除「不支持 BGM/音效」声明（Task 10）
- `services/pi-runtime/src/tools/tiering.test.ts` —— 锁 `run_audio_generation` 归属（Task 10）
- `docs/superpowers/INDEX.md`、`docs/README.md` —— 计划登记（Task 11）

---

## 阶段映射

| 任务 | 阶段 | 交付 |
|---|---|---|
| Task 1–5 | 阶段 0 | 平台 StepFun 通道打通 + 分类元数据 + agent 看得见分类 |
| Task 6 | 阶段 1 | `design`（综合音频）端到端 |
| Task 7 | 阶段 2 | `music`（音乐）端到端 |
| Task 8–10 | 阶段 3 | agent 自主选择 + 治理同步 |
| Task 11 | 验收 | 端到端验收 + 文档登记 |

---

### Task 1: 平台 StepFun 凭证解析

**Files:**
- Modify: `packages/shared/src/platformCredentials.ts`
- Test: `packages/shared/src/platformCredentials.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `DEFAULT_STEPFUN_BASE_URL: string` = `'https://api.stepfun.com/v1'`
  - `PlatformCredentialEnv` 新增 `stepfunApiKey?: string` / `stepfunBaseUrl?: string`
  - `isStepFunPlatformModel(modelName: string): boolean`
  - `resolveStepFunPlatformCredentials(modelName: string, env?: PlatformCredentialEnv): { apiKey: string; baseUrl: string } | null`

- [ ] **Step 1: 写失败测试**

追加到 `packages/shared/src/platformCredentials.test.ts`（文件已有 `resolveFalH3MaxPlatformCredentials` 等用例，沿用其 import 风格）：

```ts
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STEPFUN_BASE_URL,
  isStepFunPlatformModel,
  resolveStepFunPlatformCredentials,
} from './platformCredentials'

describe('resolveStepFunPlatformCredentials', () => {
  it('匹配阶跃全家族模型名（step-tts-* / stepaudio-*）', () => {
    for (const name of [
      'step-tts-mini',
      'stepaudio-3-tts',
      'stepaudio-3-gen-preview',
      'stepaudio-3-music-preview',
    ]) {
      expect(isStepFunPlatformModel(name)).toBe(true)
    }
  })

  it('不误伤其它平台模型', () => {
    for (const name of ['agnes-2.0-flash', 'h3-max-turbo', 'minimax-h3', 'speech-2.8-hd']) {
      expect(isStepFunPlatformModel(name)).toBe(false)
      expect(resolveStepFunPlatformCredentials(name, { stepfunApiKey: 'k' })).toBeNull()
    }
  })

  it('缺省 baseUrl 指向阶跃官方网关', () => {
    expect(
      resolveStepFunPlatformCredentials('stepaudio-3-gen-preview', { stepfunApiKey: 'k' }),
    ).toEqual({ apiKey: 'k', baseUrl: DEFAULT_STEPFUN_BASE_URL })
  })

  it('⚠️ 回归锁：匹配到阶跃模型时，即使 key 为空也返回非 null', () => {
    // 返回 null 会让 resolver 落回 OpenAI 默认端点，把 step 模型名静默发到 OpenAI。
    // 缺 key 的显式失败由调用方负责（apps/server 的音频路径），不在这里静默兜底。
    const r = resolveStepFunPlatformCredentials('stepaudio-3-music-preview', {})
    expect(r).not.toBeNull()
    expect(r!.apiKey).toBe('')
    expect(r!.baseUrl).toBe(DEFAULT_STEPFUN_BASE_URL)
  })

  it('显式 env 覆盖 process.env', () => {
    const saved = process.env.STEPFUN_API_KEY
    process.env.STEPFUN_API_KEY = 'from-process'
    try {
      expect(
        resolveStepFunPlatformCredentials('stepaudio-3-tts', { stepfunApiKey: 'from-arg' })!.apiKey,
      ).toBe('from-arg')
      expect(resolveStepFunPlatformCredentials('stepaudio-3-tts')!.apiKey).toBe('from-process')
    } finally {
      if (saved === undefined) delete process.env.STEPFUN_API_KEY
      else process.env.STEPFUN_API_KEY = saved
    }
  })

  it('STEPFUN_BASE_URL 可覆盖', () => {
    expect(
      resolveStepFunPlatformCredentials('stepaudio-3-tts', {
        stepfunApiKey: 'k',
        stepfunBaseUrl: 'https://stepfun.internal/v1',
      })!.baseUrl,
    ).toBe('https://stepfun.internal/v1')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lnkpi/shared exec vitest run src/platformCredentials.test.ts`
Expected: FAIL —— `isStepFunPlatformModel is not a function`（或 import 报错）

- [ ] **Step 3: 最小实现**

在 `packages/shared/src/platformCredentials.ts` 中：

```ts
export const DEFAULT_STEPFUN_BASE_URL = 'https://api.stepfun.com/v1'
```

`PlatformCredentialEnv` 增两个字段：

```ts
  stepfunApiKey?: string
  stepfunBaseUrl?: string
```

`readPlatformCredentialEnv` 返回值增两项（保持既有键顺序，新键追加末尾）：

```ts
    stepfunApiKey: env.stepfunApiKey ?? readEnv('STEPFUN_API_KEY') ?? '',
    stepfunBaseUrl:
      env.stepfunBaseUrl ?? readEnv('STEPFUN_BASE_URL') ?? DEFAULT_STEPFUN_BASE_URL,
```

文件末尾追加：

```ts
/**
 * 阶跃星辰（StepFun）平台模型判别。
 * 覆盖 `step-tts-*` / `stepaudio-*` 两个命名族；与 `/h3-max/i`、`/^minimax-h3$/i` 无交集。
 */
export function isStepFunPlatformModel(modelName: string): boolean {
  return /^step/i.test(modelName.trim())
}

/**
 * ⚠️ 匹配即返回，**绝不因缺 key 返回 null**：
 * 返回 null 会让 `provider-resolver` 落回 `OPENAI_BASE_URL`，把阶跃模型名静默发到 OpenAI
 * （典型静默错路由）。缺 key 的显式失败由调用方（apps/server 音频路径）负责。
 */
export function resolveStepFunPlatformCredentials(
  modelName: string,
  env?: PlatformCredentialEnv,
): { apiKey: string; baseUrl: string } | null {
  if (!isStepFunPlatformModel(modelName)) return null
  const vars = readPlatformCredentialEnv(env)
  return {
    apiKey: vars.stepfunApiKey,
    baseUrl: vars.stepfunBaseUrl || DEFAULT_STEPFUN_BASE_URL,
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @lnkpi/shared exec vitest run src/platformCredentials.test.ts`
Expected: PASS

- [ ] **Step 5: 类型检查 + 提交**

```bash
pnpm --filter @lnkpi/shared exec tsc --noEmit
git add packages/shared/src/platformCredentials.ts packages/shared/src/platformCredentials.test.ts
git commit -m "feat(shared): 平台级 StepFun 凭证解析（匹配即返回，缺 key 不静默回落）"
```

---

### Task 2: catalog 登记 gen/music + audioKind 元数据

**Files:**
- Modify: `packages/shared/src/studioModelCatalog.ts`
- Test: `packages/shared/src/studioModelCatalog.test.ts`

**Interfaces:**
- Consumes: 无（不依赖 Task 1）
- Produces:
  - `type AudioKind = 'voice' | 'design' | 'music'`
  - `StudioModelEntry.audioKind?: AudioKind`
  - `listModelsByAudioKind(kind: AudioKind): StudioModelEntry[]`
  - catalog 新增 `stepaudio-3-gen-preview`（`design`）、`stepaudio-3-music-preview`（`music`）

- [ ] **Step 1: 写失败测试**

追加到 `packages/shared/src/studioModelCatalog.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import {
  STUDIO_MODEL_CATALOG,
  getModelEntry,
  listModels,
  listModelsByAudioKind,
} from './studioModelCatalog'

describe('audioKind 元数据', () => {
  it('every audio entry declares an audioKind（新增 audio 条目必须声明 kind）', () => {
    for (const entry of STUDIO_MODEL_CATALOG.filter((e) => e.modality === 'audio')) {
      expect(entry.audioKind, `${entry.modelKey} 缺 audioKind`).toBeTruthy()
    }
  })

  it('两条新模型归到正确 kind', () => {
    expect(getModelEntry('stepaudio-3-gen-preview')?.audioKind).toBe('design')
    expect(getModelEntry('stepaudio-3-music-preview')?.audioKind).toBe('music')
  })

  it('既有 4 条 audio 条目均为 voice', () => {
    for (const key of [
      'seed-audio-1.0',
      'minimax-speech-2.8-hd',
      'step-tts-mini',
      'stepaudio-3-tts',
    ]) {
      expect(getModelEntry(key)?.audioKind, key).toBe('voice')
    }
  })

  it('listModelsByAudioKind 只返回该 kind', () => {
    expect(listModelsByAudioKind('music').map((e) => e.modelKey)).toEqual([
      'stepaudio-3-music-preview',
    ])
    expect(listModelsByAudioKind('design').map((e) => e.modelKey)).toEqual([
      'stepaudio-3-gen-preview',
    ])
    expect(listModelsByAudioKind('voice').length).toBe(4)
  })

  it('audio 模态条目数 = 6，且默认模型不变（存量行为锁）', () => {
    expect(listModels('audio').length).toBe(6)
    expect(defaultModelKey('audio')).toBe('minimax-speech-2.8-hd')
  })

  it('新模型登记后能被 resolveModelKey 命中（不再静默回退）', () => {
    const r = resolveModelKey('audio', 'stepaudio-3-music-preview')
    expect(r.fallback).toBe(false)
    expect(r.modelKey).toBe('stepaudio-3-music-preview')
  })
})
```

（`defaultModelKey` / `resolveModelKey` 若未在该测试文件 import，一并补进 import 列表。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lnkpi/shared exec vitest run src/studioModelCatalog.test.ts`
Expected: FAIL —— `listModelsByAudioKind is not a function` / `audioKind` 为 undefined

- [ ] **Step 3: 最小实现**

`packages/shared/src/studioModelCatalog.ts`：

1) 在 `StudioModality` 下方新增类型，并给 `StudioModelEntry` 加字段：

```ts
/**
 * 音频节点内部的二阶分类。顶层模态仍是 `audio`（画布不新增节点类型）。
 * 缺省视作 `voice` ⇒ 存量节点与老路径行为逐字节不变。
 */
export type AudioKind = 'voice' | 'design' | 'music'
```

```ts
export interface StudioModelEntry {
  modelKey: string
  displayName: string
  gatewayModelId: string
  modality: StudioModality
  providerBinding: 'gateway-openai-compat' | 'fal-http' | 'minimax-http'
  /** 仅 `modality === 'audio'` 时存在；缺省视作 `voice` */
  audioKind?: AudioKind
  voices?: StudioVoiceOption[]
  params: Record<string, ParamDisposition>
  defaults?: Record<string, string | number>
}
```

2) 追加两份参数处置表（放在 `STEPFUN_TTS_PARAMS` 之后）：

```ts
/**
 * 综合音频（`stepaudio-3-gen-preview`）：`roles[]` + `scripts[]` + `instruction`
 * 全部原生直传 `POST /audio/generate`；无「待朗读正文」概念，故不走 promptPrefix 通道。
 */
const STEPFUN_DESIGN_PARAMS: Record<string, ParamDisposition> = {
  model: 'native',
  roles: 'native',
  scripts: 'native',
  instruction: 'native',
  response_format: 'native',
}

/**
 * 音乐（`stepaudio-3-music-preview`）。⚠️ 上游字段名是 `model_id` 而非 `model`，
 * 由 `stepfun-audio.ts` 的 music provider 负责改名，此处仍声明 `model` 供 UI 归一。
 */
const STEPFUN_MUSIC_PARAMS: Record<string, ParamDisposition> = {
  model: 'native',
  caption: 'native',
  lyrics: 'native',
  instrumental: 'native',
  temperature: 'native',
  top_k: 'native',
  response_format: 'native',
}
```

3) 给既有 4 条 audio 条目各加一行 `audioKind: 'voice',`（放在 `modality: 'audio',` 之后）。

4) 在 catalog 数组的 audio 段末尾追加两条：

```ts
  {
    modelKey: 'stepaudio-3-gen-preview',
    displayName: 'StepAudio 3 Gen（阶跃·综合音频）',
    gatewayModelId: 'stepaudio-3-gen-preview',
    modality: 'audio',
    audioKind: 'design',
    providerBinding: 'gateway-openai-compat',
    params: STEPFUN_DESIGN_PARAMS,
    defaults: { response_format: 'mp3' },
  },
  {
    modelKey: 'stepaudio-3-music-preview',
    displayName: 'StepAudio 3 Music（阶跃·音乐）',
    gatewayModelId: 'stepaudio-3-music-preview',
    modality: 'audio',
    audioKind: 'music',
    providerBinding: 'gateway-openai-compat',
    params: STEPFUN_MUSIC_PARAMS,
    defaults: { instrumental: 'true', response_format: 'mp3' },
  },
```

5) `listModels` 之后新增：

```ts
export function listModelsByAudioKind(kind: AudioKind): StudioModelEntry[] {
  return STUDIO_MODEL_CATALOG.filter((entry) => entry.modality === 'audio' && audioKindOf(entry) === kind)
}

/** 缺省视作 `voice` —— 缺省值的唯一判据处，勿在调用方各自 `?? 'voice'`。 */
export function audioKindOf(entry: Pick<StudioModelEntry, 'modality' | 'audioKind'>): AudioKind {
  return entry.audioKind ?? 'voice'
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @lnkpi/shared exec vitest run src/studioModelCatalog.test.ts`
Expected: PASS

- [ ] **Step 5: 全包回归 + 提交**

```bash
pnpm --filter @lnkpi/shared exec tsc --noEmit
pnpm --filter @lnkpi/shared exec vitest run
git add packages/shared/src/studioModelCatalog.ts packages/shared/src/studioModelCatalog.test.ts
git commit -m "feat(shared): audio 二阶分类 AudioKind + 登记 gen/music 两条 StepFun 模型"
```

---

### Task 3: resolver 挂载 StepFun 分流

**Files:**
- Modify: `apps/server/src/provider/provider-resolver.service.ts`
- Test: `apps/server/src/provider/provider-resolver.service.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `resolveStepFunPlatformCredentials`
- Produces: `resolveForGeneration` 对 `/^step/i` 的平台模型返回 `{ baseUrl: 'https://api.stepfun.com/v1', apiKey: <STEPFUN_API_KEY|undefined> }`

- [ ] **Step 1: 写失败测试**

追加到 `apps/server/src/provider/provider-resolver.service.test.ts` 的 `describe` 块内（并仿照既有 `originalFalKey` 的写法，在 `beforeEach` 里 `delete process.env.STEPFUN_API_KEY`、在 `afterEach` 复原）：

```ts
  it('routes platform stepfun models to StepFun credentials', async () => {
    process.env.STEPFUN_API_KEY = 'stepfun-env-key'

    const result = await resolver.resolveForGeneration(
      'u1',
      'platform::stepaudio-3-gen-preview',
      'audio',
    )
    expect(result).toEqual({
      channelId: 'platform',
      modelName: 'stepaudio-3-gen-preview',
      apiFormat: 'openai',
      credentials: { apiKey: 'stepfun-env-key', baseUrl: 'https://api.stepfun.com/v1' },
      source: 'platform',
    })
  })

  it('honors STEPFUN_BASE_URL override', async () => {
    process.env.STEPFUN_API_KEY = 'stepfun-env-key'
    process.env.STEPFUN_BASE_URL = 'https://stepfun.custom/v1'

    const result = await resolver.resolveForGeneration('u1', 'platform::stepaudio-3-tts', 'audio')
    expect(result.credentials.baseUrl).toBe('https://stepfun.custom/v1')
  })

  it('🔴 缺 STEPFUN_API_KEY 时 baseUrl 仍指向阶跃（不得回落到 OpenAI 端点）', async () => {
    const result = await resolver.resolveForGeneration(
      'u1',
      'platform::stepaudio-3-music-preview',
      'audio',
    )
    expect(result.credentials.apiKey).not.toBe('platform-env-key')
    expect(result.credentials.apiKey).toBeFalsy()
    expect(result.credentials.baseUrl).toBe('https://api.stepfun.com/v1')
  })

  it('不干扰既有 fal / minimax 分支', async () => {
    process.env.FAL_KEY = 'fal-env-key'
    process.env.MINIMAX_API_KEY = 'minimax-env-key'
    process.env.STEPFUN_API_KEY = 'stepfun-env-key'

    expect(
      (await resolver.resolveForGeneration('u1', 'platform::h3-max-turbo', 'video')).credentials,
    ).toEqual({ apiKey: 'fal-env-key', baseUrl: 'https://fal.run' })
    expect(
      (await resolver.resolveForGeneration('u1', 'platform::minimax-h3', 'video')).credentials,
    ).toEqual({ apiKey: 'minimax-env-key', baseUrl: 'https://api.minimax.io' })
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lnkpi/server exec vitest run src/provider/provider-resolver.service.test.ts`
Expected: FAIL —— `stepaudio-3-*` 拿到的是 `platform-env-key` + `https://platform.example.com/v1`

- [ ] **Step 3: 最小实现**

`apps/server/src/provider/provider-resolver.service.ts`：

import 增 `resolveStepFunPlatformCredentials`，并在 `resolveForGeneration` 的平台分支中，于 `minimax` 之后、`modality === 'image'` 之前插入：

```ts
      const stepfun = resolveStepFunPlatformCredentials(modelName)
      // ...（既有 fal / minimax 判断）
      } else if (stepfun) {
        baseUrl = stepfun.baseUrl
        apiKey = stepfun.apiKey || undefined
      } else if (modality === 'image') {
```

即完整链变为 `fal → minimax → stepfun → image/apimart`。**顺序不可换**：stepfun 判据 `/^step/i` 与另两者无交集，但它必须在 `else if (modality === 'image')` 之前，否则音频模型不会走到这里。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @lnkpi/server exec vitest run src/provider/provider-resolver.service.test.ts`
Expected: PASS（含既有 fal / minimax / apimart 全部用例）

- [ ] **Step 5: 提交**

```bash
pnpm --filter @lnkpi/server exec tsc --noEmit
git add apps/server/src/provider/provider-resolver.service.ts apps/server/src/provider/provider-resolver.service.test.ts
git commit -m "feat(server): resolver 挂载平台级 StepFun 分流（缺 key 也不回落 OpenAI 端点）"
```

---

### Task 4: 音频路径按 kind 分派 + 显式失败文案（含第二处入口覆盖）

**Files:**
- Create: `apps/server/src/studio/audio-kind.ts`
- Create: `apps/server/src/studio/audio-kind.test.ts`
- Modify: `apps/server/src/studio/studio.service.ts`（`generateAudio` 分支；降级重放 `record.type === 'audio'` 段，约 2605-2625 行）
- Test: `apps/server/src/studio/studio.service.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `resolveStepFunPlatformCredentials` / `readPlatformCredentialEnv`；Task 2 的 `AudioKind` / `audioKindOf`
- Produces:
  - `assertStepFunAudioModel(kind: AudioKind, modelName: string): void`（不匹配抛 `BadRequestException`）
  - `audioFailureMessage(kind: AudioKind, err: unknown, channelId: string): string`
  - `isPlatformAudioUnavailable(err: unknown): boolean`
  - `resolvePlatformAudioFallback(modelName: string, env?: PlatformCredentialEnv): { ok: true; credentials: { apiKey: string; baseUrl?: string } } | { ok: false; reason: string }`

> ⚠️ 关于测试层次：`apps/server/src/studio/studio.service.test.ts` 目前**只有 `editImage` 用例**（181 行），没有可复用的 fallback/prisma/points 夹具。为它新造一整套 mock 必然会假绿。因此本任务把「降级重放该用哪套凭证」抽成**纯函数**放在 `audio-kind.ts` 里做单测 —— 这也是仓库既有做法（`platformCredentials.ts` 全是纯函数 + 纯函数测试）。

- [ ] **Step 1: 写失败测试（纯函数层）**

新建 `apps/server/src/studio/audio-kind.test.ts`：

```ts
import { BadRequestException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import {
  assertStepFunAudioModel,
  audioFailureMessage,
  resolvePlatformAudioFallback,
} from './audio-kind'

describe('assertStepFunAudioModel', () => {
  it('design / music 只接受阶跃模型', () => {
    expect(() => assertStepFunAudioModel('design', 'stepaudio-3-gen-preview')).not.toThrow()
    expect(() => assertStepFunAudioModel('music', 'stepaudio-3-music-preview')).not.toThrow()
    expect(() => assertStepFunAudioModel('music', 'minimax-speech-2.8-hd')).toThrow(
      BadRequestException,
    )
  })

  it('voice 不受限（现网模型照旧可用）', () => {
    expect(() => assertStepFunAudioModel('voice', 'seed-audio-1.0')).not.toThrow()
  })
})

describe('audioFailureMessage', () => {
  it('402 且平台渠道 ⇒ 平台音频额度不足', () => {
    const msg = audioFailureMessage('voice', new Error('TTS API 402: insufficient balance'), 'platform')
    expect(msg).toContain('平台音频额度不足')
  })

  it('缺密钥 ⇒ 显式说明未配置，而非泛化失败', () => {
    const msg = audioFailureMessage('design', new Error('missing api key'), 'platform')
    expect(msg).toContain('未配置')
    expect(msg).toContain('STEPFUN_API_KEY')
  })

  it('音乐异步任务的终态失败带任务原因', () => {
    const msg = audioFailureMessage('music', new Error('music task FAILED: content policy'), 'platform')
    expect(msg).toContain('音乐生成失败')
    expect(msg).toContain('content policy')
  })

  it('用户自有渠道失败不改写为平台口径', () => {
    const msg = audioFailureMessage('voice', new Error('TTS API 401: bad key'), 'ch_abc')
    expect(msg).not.toContain('平台音频额度不足')
    expect(msg).toContain('401')
  })
})

describe('resolvePlatformAudioFallback（降级重放该用哪套凭证）', () => {
  it('阶跃模型 ⇒ 阶跃凭证（不再吃 OPENAI_* 兜底）', () => {
    const r = resolvePlatformAudioFallback('stepaudio-3-music-preview', {
      stepfunApiKey: 'sf',
      stepfunBaseUrl: 'https://api.stepfun.com/v1',
      openaiApiKey: 'oai',
      openaiBaseUrl: 'https://platform.example.com/v1',
    })
    expect(r).toEqual({
      ok: true,
      credentials: { apiKey: 'sf', baseUrl: 'https://api.stepfun.com/v1' },
    })
  })

  it('🔴 阶跃模型但缺 STEPFUN_API_KEY ⇒ 显式拒绝（不得退回 OPENAI_API_KEY）', () => {
    const r = resolvePlatformAudioFallback('stepaudio-3-music-preview', {
      openaiApiKey: 'oai',
      openaiBaseUrl: 'https://platform.example.com/v1',
    })
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.reason).toContain('STEPFUN_API_KEY')
  })

  it('非阶跃模型 ⇒ 沿用 OPENAI_*（存量行为逐字节不变）', () => {
    const r = resolvePlatformAudioFallback('minimax-speech-2.8-hd', {
      openaiApiKey: 'oai',
      openaiBaseUrl: 'https://platform.example.com/v1',
    })
    expect(r).toEqual({
      ok: true,
      credentials: { apiKey: 'oai', baseUrl: 'https://platform.example.com/v1' },
    })
  })

  it('两套都没有 ⇒ 显式拒绝并列出两个变量名', () => {
    const r = resolvePlatformAudioFallback('minimax-speech-2.8-hd', {})
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.reason).toMatch(/OPENAI_API_KEY/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lnkpi/server exec vitest run src/studio/audio-kind.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `apps/server/src/studio/audio-kind.ts`**

```ts
import { BadRequestException } from '@nestjs/common'
import { isStepFunPlatformModel, type AudioKind } from '@lnkpi/shared'

const KIND_LABEL: Record<AudioKind, string> = {
  voice: '配音',
  design: '综合音频',
  music: '音乐',
}

/** design / music 只有阶跃提供，别的模型名进来必然是选错了 —— 显式拒绝，不静默换成别的模型。 */
export function assertStepFunAudioModel(kind: AudioKind, modelName: string): void {
  if (kind === 'voice') return
  if (isStepFunPlatformModel(modelName)) return
  throw new BadRequestException(
    `${KIND_LABEL[kind]}分类仅支持阶跃（StepFun）模型，当前模型为 ${modelName || '(空)'}`,
  )
}

export function isPlatformAudioUnavailable(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err ?? '')
  return /\b402\b/.test(text) || /insufficient/i.test(text)
}

/** 「不可用必须显式可判读」——三类失败各给可操作的文案，不复用泛化的 500。 */
export function audioFailureMessage(kind: AudioKind, err: unknown, channelId: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  const platform = channelId === 'platform'

  if (/missing api key/i.test(raw) && platform && kind !== 'voice') {
    return `${KIND_LABEL[kind]}通道未配置平台密钥（STEPFUN_API_KEY），请改用自己的阶跃渠道或联系管理员`
  }
  if (isPlatformAudioUnavailable(err) && platform) {
    return `平台音频额度不足（上游 402），请稍后重试或改用自己的阶跃渠道`
  }
  if (kind === 'music') return `音乐生成失败：${raw}`
  if (kind === 'design') return `综合音频生成失败：${raw}`
  return raw
}

/**
 * 降级重放（`providerFallback` / `channelId:'platform'`）该用哪套凭证。
 *
 * ⚠️ 这里替换掉旧代码的 `createAudioProvider(undefined)` —— 那个调用只认
 * `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_TTS_MODEL`，会把 `stepaudio-3-*`
 * 这类模型名**静默发到 OpenAI 兼容网关**（典型静默错路由，且不报错）。
 *
 * - 阶跃模型 ⇒ 必须用 STEPFUN_* 凭证；缺 key 时**显式拒绝**，不退回 OPENAI_*。
 * - 非阶跃模型 ⇒ 完全沿用旧行为（OPENAI_*），保证存量路径逐字节不变。
 */
export function resolvePlatformAudioFallback(
  modelName: string,
  env?: PlatformCredentialEnv,
): { ok: true; credentials: { apiKey: string; baseUrl?: string } } | { ok: false; reason: string } {
  const sf = resolveStepFunPlatformCredentials(modelName, env)
  if (sf) {
    if (!sf.apiKey) {
      return {
        ok: false,
        reason: `平台音频通道未配置密钥（STEPFUN_API_KEY），无法为 ${modelName} 走平台回退`,
      }
    }
    return { ok: true, credentials: { apiKey: sf.apiKey, baseUrl: sf.baseUrl } }
  }

  const vars = readPlatformCredentialEnv(env)
  if (!vars.openaiApiKey) {
    return {
      ok: false,
      reason: '平台音频通道未配置密钥（OPENAI_API_KEY / STEPFUN_API_KEY）',
    }
  }
  return {
    ok: true,
    credentials: { apiKey: vars.openaiApiKey, baseUrl: vars.openaiBaseUrl || undefined },
  }
}
```

（`readPlatformCredentialEnv` / `PlatformCredentialEnv` 一并加进 import。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @lnkpi/server exec vitest run src/studio/audio-kind.test.ts`
Expected: PASS

- [ ] **Step 5: 接入 `generateAudio`（voice 路径逐字节不动）**

在 `studio.service.ts::generateAudio` 中，`resolveForGeneration` 之后、`createAudioProvider(...)` 之前插入 kind 判定与守卫：

```ts
    const kind: AudioKind = audioKindOf(getModelEntry(resolved.modelName) ?? { modality: 'audio' })
    assertStepFunAudioModel(kind, resolved.modelName)
```

⚠️ `voice` 分支（今天的全部逻辑）**一行不改**。`design` / `music` 的分派在 Task 6 / Task 7 接入；本步骤只落「kind 判定 + 校验 + 失败文案」。catch 段把 `err` 的消息改成 `audioFailureMessage(kind, err, resolved.channelId)`，并在 `metadata` 里加 `audioKind: kind`。

- [ ] **Step 6: 覆盖第二处入口（降级重放）**

`studio.service.ts` 约 2605-2625 行的 `if (record.type === 'audio')` 段，当前是：

```ts
const { url } = await createAudioProvider(undefined).generate(record.prompt, audioOptions)
```

改成经纯函数取凭证，不再吃 `createAudioProvider(undefined)` 的 `OPENAI_*` 兜底：

```ts
        const fallback = resolvePlatformAudioFallback(platformModel)
        if (!fallback.ok) throw new Error(fallback.reason)
        const { url } = await createAudioProvider(fallback.credentials).generate(
          record.prompt,
          audioOptions,
        )
```

- [ ] **Step 7: 补一条「调用点真的用了纯函数」的锁**

纯函数测过了，但纯函数**没被调用**也是绿的。加一条源码级断言（行锚定 + 属性键形状，避免被注释命中）：

```ts
// apps/server/src/studio/audio-kind.test.ts 追加
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('降级重放的调用点锁', () => {
  it('studio.service 的音频降级不再直接 createAudioProvider(undefined)', () => {
    const src = readFileSync(join(__dirname, 'studio.service.ts'), 'utf8')
    assertNoMatch(src, /createAudioProvider\(\s*undefined\s*\)/, '降级重放仍用 undefined 凭证')
  })
})
```

> `assertNoMatch` 请用仓库既有写法；若该文件没有，直接写：
> ```ts
> function assertNoMatch(src: string, re: RegExp, hint: string) {
>   const hit = src.split('\n').findIndex((l) => re.test(l))
>   if (hit >= 0) throw new Error(`${hint}（第 ${hit + 1} 行）`)
> }
> ```
> ⚠️ 不要把断言写成纯 `not.toContain('createAudioProvider(undefined)')` —— 注释里出现同样的字符串会造成**假失败**。

- [ ] **Step 8: 跑测试 + 提交**

```bash
pnpm --filter @lnkpi/server exec vitest run src/studio/audio-kind.test.ts
pnpm --filter @lnkpi/server exec tsc --noEmit
git add apps/server/src/studio/audio-kind.ts apps/server/src/studio/audio-kind.test.ts apps/server/src/studio/studio.service.ts
git commit -m "feat(server): 音频路径 kind 判定 + 显式失败文案 + 降级重放改走平台 StepFun 凭证"
```

⚠️ 本任务**不改** `studio.service.test.ts`（它只有 `editImage` 用例，为音频新造 mock 夹具会假绿）。降级路径的正确性由 Step 7 的调用点锁 + Step 1 的纯函数用例共同保证。

---

### Task 5: 平台可选模型与 agent 可见的分类

**Files:**
- Modify: `apps/server/src/provider/provider.service.ts`（`defaultSelectableFor` 无需改；确认新模型自动进入 `selectableAudioModels`）
- Modify: `apps/server/src/agent/agent-canvas-tools.service.ts`（`listNodeModelOptions`，约 1391-1423 行）
- Test: `apps/server/src/provider/provider.service.test.ts`、`apps/server/src/agent/agent-canvas-tools.service.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `audioKindOf` / `getModelEntry`
- Produces: `listNodeModelOptions` 的每个条目新增 `audioKind?: AudioKind` 字段（仅 audio 模态出现）

- [ ] **Step 1: 写失败测试**

`apps/server/src/provider/provider.service.test.ts` 追加：

```ts
  it('平台默认可选音频模型含三分类', async () => {
    const { platformChannel } = await service.bootstrap('u1')
    const names = platformChannel.models.filter((m) => m.capability === 'audio').map((m) => m.name)
    expect(names).toContain('stepaudio-3-tts')
    expect(names).toContain('stepaudio-3-gen-preview')
    expect(names).toContain('stepaudio-3-music-preview')
  })
```

`apps/server/src/agent/agent-canvas-tools.service.test.ts` 追加：

```ts
  it('list_model_options 的 audio 条目带 audioKind（agent 才能自主选分类）', async () => {
    const out = await service.listNodeModelOptions({ userId: 'u1' })
    const audio = out.modalities.audio
    const music = audio.find((m) => m.model === 'stepaudio-3-music-preview')
    expect(music?.audioKind).toBe('music')
    const voice = audio.find((m) => m.model === 'minimax-speech-2.8-hd')
    expect(voice?.audioKind).toBe('voice')
  })

  it('非 audio 模态不带 audioKind 字段', async () => {
    const out = await service.listNodeModelOptions({ userId: 'u1' })
    expect(out.modalities.image.every((m) => !('audioKind' in m))).toBe(true)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lnkpi/server exec vitest run src/agent/agent-canvas-tools.service.test.ts`
Expected: FAIL —— `audioKind` 为 undefined

- [ ] **Step 3: 实现**

`agent-canvas-tools.service.ts::listNodeModelOptions` 的 `build` 内，按模态补 `audioKind`（用 `modality` 参数决定是否附加，避免非音频模态多出空字段）：

```ts
    const build = (refs: string[], modality: ModelCapability) =>
      refs.map((ref) => {
        const decoded = decodeChannelModel(ref)
        const channelId = decoded?.channelId ?? PLATFORM_CHANNEL_ID
        const model = decoded?.modelName ?? ref
        const entry = getModelEntry(model)
        return {
          ref,
          model,
          channelId,
          channelName: nameOf.get(channelId) ?? channelId,
          source: (channelId === PLATFORM_CHANNEL_ID ? 'platform' : 'user') as ProviderSource,
          ...(modality === 'audio'
            ? { audioKind: entry && entry.modality === 'audio' ? audioKindOf(entry) : 'voice' }
            : {}),
        }
      })
```

调用处补第二个参数：`build(preferences.selectableImageModels, 'image')` 等，`audio` 传 `'audio'`。

⚠️ **默认值纪律**：未登记的音频模型（用户 BYOK 渠道拉回来的 21 个 step 模型里没有 catalog 条目的）一律归 `'voice'` —— 这是「缺省视作 voice」的**唯一**判据处（`audioKindOf`），不要在别处再写一遍 `?? 'voice'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @lnkpi/server exec vitest run src/provider/provider.service.test.ts src/agent/agent-canvas-tools.service.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
pnpm --filter @lnkpi/server exec tsc --noEmit
git add apps/server/src/agent/agent-canvas-tools.service.ts apps/server/src/agent/agent-canvas-tools.service.test.ts apps/server/src/provider/provider.service.test.ts
git commit -m "feat(server): list_model_options 带 audioKind + 平台默认可选含三分类"
```

---

### Task 6: `design`（综合音频）同步调用形态

**Files:**
- Create: `packages/agent/src/tools/stepfun-audio.ts`
- Create: `packages/agent/src/tools/stepfun-audio.test.ts`
- Modify: `apps/server/src/studio/studio.service.ts`（`generateAudio` 的 `design` 分支）
- Modify: `apps/server/src/studio/studio.controller.ts`（`GenerateAudioDto`，约 135 行）—— 增 `kind` / `roles` / `scripts` / `instruction` / `caption` / `lyrics` / `instrumental`（**追加末尾**）
- Modify: `apps/web/src/services/studio-api.ts`（`AudioGenerateOptions` 增字段）

**Interfaces:**
- Consumes: Task 2 的 `AudioKind`
- Produces:
  - `interface StepFunDesignInput { roles: Array<{ role: string; voice: string }>; scripts: Array<{ role?: string; text: string }>; instruction?: string; responseFormat?: string }`
  - `class StepFunDesignProvider { constructor(apiKey: string, baseUrl: string); generate(input: StepFunDesignInput): Promise<{ buffer: Buffer; contentType: string }> }`

- [ ] **Step 1: 写失败测试**

新建 `packages/agent/src/tools/stepfun-audio.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'
import { StepFunDesignProvider } from './stepfun-audio'

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  return vi.fn(async (url: string | URL, init?: RequestInit) =>
    handler(String(url), init ?? {}),
  ) as unknown as typeof fetch
}

describe('StepFunDesignProvider', () => {
  it('POST /audio/generate 并原样返回音频字节', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe('https://api.stepfun.com/v1/audio/generate')
      const body = JSON.parse(String(init.body))
      expect(body.model).toBe('stepaudio-3-gen-preview')
      expect(body.roles).toEqual([{ role: '旁白', voice: 'cixingnansheng' }])
      expect(body.scripts).toEqual([{ role: '旁白', text: '（轻声）今晚的风很温柔。' }])
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      })
    })
    const p = new StepFunDesignProvider('k', 'https://api.stepfun.com/v1', fetchImpl)
    const out = await p.generate({
      roles: [{ role: '旁白', voice: 'cixingnansheng' }],
      scripts: [{ role: '旁白', text: '（轻声）今晚的风很温柔。' }],
    })
    expect(out.contentType).toBe('audio/mpeg')
    expect(out.buffer.byteLength).toBe(4)
  })

  it('非 2xx 一律抛出（不吞、不返回占位音频）', async () => {
    const fetchImpl = fakeFetch(() => new Response('bad request', { status: 400 }))
    const p = new StepFunDesignProvider('k', 'https://api.stepfun.com/v1', fetchImpl)
    await expect(
      p.generate({ roles: [], scripts: [{ text: 'x' }] }),
    ).rejects.toThrow(/StepFun audio\/generate 400/)
  })

  it('返回 JSON 而非音频时显式报错（避免把错误体当 mp3 存下来）', async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response(JSON.stringify({ error: { message: 'model not found' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const p = new StepFunDesignProvider('k', 'https://api.stepfun.com/v1', fetchImpl)
    await expect(p.generate({ roles: [], scripts: [{ text: 'x' }] })).rejects.toThrow(
      /model not found/,
    )
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lnkpi/agent exec vitest run src/tools/stepfun-audio.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `stepfun-audio.ts`（本任务只落 design 部分）**

```ts
/**
 * 阶跃星辰音频的两条**非 OpenAI 兼容**调用形态。
 * 现有 `audio-provider.ts` 只认 `POST /audio/speech`，接不上这两个端点。
 *
 * ⚠️ 一律返回 `Buffer`（不是 data URL）：design 与 music 的产物体量远超内联阈值
 * （music 实测 2.2MB），调用方必须走对象存储转存。
 */
export interface StepFunDesignInput {
  roles: Array<{ role: string; voice: string }>
  scripts: Array<{ role?: string; text: string }>
  instruction?: string
  responseFormat?: string
}

export class StepFunDesignProvider {
  constructor(
    private apiKey: string,
    private baseUrl: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async generate(input: StepFunDesignInput): Promise<{ buffer: Buffer; contentType: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/audio/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: 'stepaudio-3-gen-preview',
        task: 'text_to_audio',
        roles: input.roles,
        scripts: input.scripts,
        ...(input.instruction ? { instruction: input.instruction } : {}),
        response_format: input.responseFormat ?? 'mp3',
      }),
    })
    if (!res.ok) throw new Error(`StepFun audio/generate ${res.status}: ${await res.text()}`)

    const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
    const body = Buffer.from(await res.arrayBuffer())
    // 200 但返回 JSON ⇒ 上游用错误体答复（如 model not found）。当 mp3 存下去会变成
    // 一个「能播但没声音」的坏文件，且无任何报错 —— 必须显式失败。
    if (contentType.includes('application/json')) {
      let detail = body.toString('utf8').slice(0, 300)
      try {
        const parsed = JSON.parse(detail) as { error?: { message?: string } }
        detail = parsed.error?.message ?? detail
      } catch {
        /* 保持原文 */
      }
      throw new Error(`StepFun audio/generate 返回 JSON 而非音频：${detail}`)
    }
    return { buffer: body, contentType }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @lnkpi/agent exec vitest run src/tools/stepfun-audio.test.ts`
Expected: PASS

- [ ] **Step 5: 接到 `generateAudio` 的 `design` 分支**

`studio.service.ts::generateAudio` 中，`voice` 分支保持不动，新增 `design` 分支（在 kind 判定之后）：

```ts
    if (kind === 'design') {
      assertStepFunAudioModel('design', resolved.modelName)
      const apiKey = resolved.credentials.apiKey
      if (!apiKey) throw new Error('missing api key')
      const { buffer, contentType } = await new StepFunDesignProvider(
        apiKey,
        resolved.credentials.baseUrl,
      ).generate({
        roles: designRoles,          // 来自 dto.roles（Task 8 透传）
        scripts: designScripts,      // 来自 dto.scripts
        instruction: dto.instruction,
        responseFormat: 'mp3',
      })
      const stored = await this.upload.saveUserFile(userId, buffer, 'design.mp3', contentType)
      // ...create GenerationRecord（type:'audio', status:'completed', url: stored.url,
      //    metadata: { ...applyChargeMeta(..., 5), audioKind: 'design', channelId: resolved.channelId }）
      return { ...record, url: stored.url }
    }
```

- [ ] **Step 6: DTO 与前端类型对齐**

`apps/server/src/studio/studio.controller.ts` 的 `GenerateAudioDto`（约 135 行）追加可选字段（**一律追加在末尾**）：

```ts
  @IsOptional()
  @IsString()
  kind?: string

  @IsOptional()
  @IsArray()
  roles?: Array<{ role: string; voice: string }>

  @IsOptional()
  @IsArray()
  scripts?: Array<{ role?: string; text: string }>

  @IsOptional()
  @IsString()
  instruction?: string

  @IsOptional()
  @IsString()
  caption?: string

  @IsOptional()
  @IsString()
  lyrics?: string

  @IsOptional()
  @IsBoolean()
  instrumental?: boolean
```

并在 `generateAudio` 控制器里把这些字段并入传给 `studioService.generateAudio` 的 options（**同样追加末尾**）。

> 🔴 **为什么 DTO 装饰器不是可选的**：`apps/server/src/main.ts:30` 是
> `new ValidationPipe({ transform: true, whitelist: true })` —— **没有 `forbidNonWhitelisted`**。
> 也就是说，没有装饰器的字段会被 **静默剥掉**（不报错、不提示），表现为「前端传了 roles，
> 后端拿到的永远是 undefined」，且日志里什么都看不到。新增的每个字段都必须有装饰器。
> `@IsBoolean` 需要从 `class-validator` 补进 import。

`apps/web/src/services/studio-api.ts` 的 `AudioGenerateOptions` 追加（**追加到末尾**，不改既有字段顺序）：

```ts
  /** 音频二阶分类；缺省视作 voice（存量节点不写此字段） */
  kind?: 'voice' | 'design' | 'music'
  /** design：角色→音色表 */
  roles?: Array<{ role: string; voice: string }>
  /** design：脚本段（`()` 语气、`[]` 音效） */
  scripts?: Array<{ role?: string; text: string }>
  instruction?: string
  /** music：风格描述 / 歌词 / 纯音乐 */
  caption?: string
  lyrics?: string
  instrumental?: boolean
```

- [ ] **Step 7: 端到端验收 + 提交**

Run（本地起服务后，用界面上「综合音频」分类跑一次）：
```bash
pnpm --filter @lnkpi/agent exec vitest run src/tools/stepfun-audio.test.ts
pnpm --filter @lnkpi/web exec vue-tsc -b --noEmit
pnpm --filter @lnkpi/server exec tsc --noEmit
```
Expected: 全绿；`voice` 分类手测一次行为与今日一致（扣 5 分、可播放）。

```bash
git add packages/agent/src/tools/stepfun-audio.ts packages/agent/src/tools/stepfun-audio.test.ts apps/server/src/studio/studio.service.ts apps/web/src/services/studio-api.ts
git commit -m "feat(audio): design 综合音频同步生成（/audio/generate + 对象存储转存）"
```

---

### Task 7: `music` 异步任务 + 超时扩档

**Files:**
- Modify: `packages/agent/src/tools/stepfun-audio.ts`（追加 `StepFunMusicProvider`）
- Modify: `packages/agent/src/tools/stepfun-audio.test.ts`
- Modify: `services/pi-runtime/src/tools/config.ts`、`services/pi-runtime/src/tools/config.test.ts`
- Modify: `apps/server/src/studio/studio.service.ts`（`music` 分支）

**Interfaces:**
- Consumes: Task 6 的 `stepfun-audio.ts`；Task 4 的 `audioFailureMessage`
- Produces:
  - `interface StepFunMusicInput { caption: string; lyrics?: string; instrumental?: boolean; temperature?: number; topK?: number; responseFormat?: string }`
  - `class StepFunMusicProvider { submit(input): Promise<{ taskId: string }>; query(taskId): Promise<{ status: 'RUNNING' | 'SUCCESS' | 'FAILED'; buffer?: Buffer; error?: string }>; generate(input, opts?: { intervalMs?: number; timeoutMs?: number }): Promise<{ buffer: Buffer }> }`

- [ ] **Step 1: 写失败测试**

追加到 `packages/agent/src/tools/stepfun-audio.test.ts`：

```ts
describe('StepFunMusicProvider', () => {
  it('submit 用 model_id（不是 model）并拿 task_id', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe('https://api.stepfun.com/v1/audio/music/submit')
      const body = JSON.parse(String(init.body))
      expect(body.model_id).toBe('stepaudio-3-music-preview')
      expect(body.model).toBeUndefined()
      expect(body.caption).toBe('轻柔的钢琴独奏')
      expect(body.instrumental).toBe(true)
      return new Response(JSON.stringify({ task_id: 't1' }), { status: 200 })
    })
    const p = new StepFunMusicProvider('k', 'https://api.stepfun.com/v1', fetchImpl)
    expect(await p.submit({ caption: '轻柔的钢琴独奏', instrumental: true })).toEqual({
      taskId: 't1',
    })
  })

  it('🔴 终态 FAILED 时 HTTP 仍 200，必须按状态字段判失败', async () => {
    let call = 0
    const fetchImpl = fakeFetch((url) => {
      if (url.endsWith('/submit')) {
        return new Response(JSON.stringify({ task_id: 't1' }), { status: 200 })
      }
      call += 1
      return new Response(
        JSON.stringify(
          call === 1
            ? { status: 'RUNNING' }
            : { status: 'FAILED', error: { message: 'content policy' } },
        ),
        { status: 200 },
      )
    })
    const p = new StepFunMusicProvider('k', 'https://api.stepfun.com/v1', fetchImpl)
    await expect(
      p.generate({ caption: 'x' }, { intervalMs: 1, timeoutMs: 5_000 }),
    ).rejects.toThrow(/content policy/)
  })

  it('SUCCESS 时返回音频字节', async () => {
    const fetchImpl = fakeFetch((url) =>
      url.endsWith('/submit')
        ? new Response(JSON.stringify({ task_id: 't1' }), { status: 200 })
        : new Response(
            JSON.stringify({ status: 'SUCCESS', audio: Buffer.from([9, 9]).toString('base64') }),
            { status: 200 },
          ),
    )
    const p = new StepFunMusicProvider('k', 'https://api.stepfun.com/v1', fetchImpl)
    const out = await p.generate({ caption: 'x' }, { intervalMs: 1, timeoutMs: 5_000 })
    expect(out.buffer.byteLength).toBe(2)
  })

  it('轮询超时抛「仍在生成」而不是静默成功', async () => {
    const fetchImpl = fakeFetch((url) =>
      url.endsWith('/submit')
        ? new Response(JSON.stringify({ task_id: 't1' }), { status: 200 })
        : new Response(JSON.stringify({ status: 'RUNNING' }), { status: 200 }),
    )
    const p = new StepFunMusicProvider('k', 'https://api.stepfun.com/v1', fetchImpl)
    await expect(
      p.generate({ caption: 'x' }, { intervalMs: 1, timeoutMs: 5 }),
    ).rejects.toThrow(/仍在生成/)
  })
})
```

`services/pi-runtime/src/tools/config.test.ts` 追加：

```ts
	assert.equal(TOOL_TIMEOUT_OVERRIDES["/agent/internal/run-audio-generation"], 330_000);
	assert.equal(TOOL_TIMEOUT_OVERRIDES["/agent/internal/run-video-generation"], 690_000);
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @lnkpi/agent exec vitest run src/tools/stepfun-audio.test.ts
cd services/pi-runtime && node --import tsx --test src/tools/config.test.ts
```
Expected: FAIL（前者模块不存在；后者期望 330000 实为 210000）

- [ ] **Step 3: 实现 music provider**

追加到 `stepfun-audio.ts`：

```ts
export interface StepFunMusicInput {
  caption: string
  lyrics?: string
  instrumental?: boolean
  temperature?: number
  topK?: number
  responseFormat?: string
}

export type MusicQueryResult =
  | { status: 'RUNNING' }
  | { status: 'SUCCESS'; buffer: Buffer }
  | { status: 'FAILED'; error: string }

export class StepFunMusicProvider {
  constructor(
    private apiKey: string,
    private baseUrl: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private headers() {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` }
  }

  async submit(input: StepFunMusicInput): Promise<{ taskId: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/audio/music/submit`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        task: 'text_to_music',
        // ⚠️ 上游字段名是 model_id，写 model 会被当成未知字段忽略 ⇒ 静默用默认模型。
        model_id: 'stepaudio-3-music-preview',
        caption: input.caption,
        ...(input.lyrics ? { lyrics: input.lyrics } : {}),
        ...(input.instrumental != null ? { instrumental: input.instrumental } : {}),
        ...(input.temperature != null ? { temperature: input.temperature } : {}),
        ...(input.topK != null ? { top_k: input.topK } : {}),
        response_format: input.responseFormat ?? 'mp3',
      }),
    })
    if (!res.ok) throw new Error(`StepFun music/submit ${res.status}: ${await res.text()}`)
    const body = (await res.json()) as { task_id?: string }
    if (!body.task_id) throw new Error(`StepFun music/submit 未返回 task_id：${JSON.stringify(body).slice(0, 200)}`)
    return { taskId: body.task_id }
  }

  /** ⚠️ FAILED 时 HTTP 仍是 200 ⇒ 必须读 status 字段，不能只看 HTTP 码。 */
  async query(taskId: string): Promise<MusicQueryResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/audio/music/query`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ task_id: taskId }),
    })
    if (!res.ok) throw new Error(`StepFun music/query ${res.status}: ${await res.text()}`)
    const body = (await res.json()) as {
      status?: string
      audio?: string
      error?: unknown
    }
    const status = (body.status ?? '').toUpperCase()
    if (status === 'SUCCESS') {
      return { status: 'SUCCESS', buffer: Buffer.from(body.audio ?? '', 'base64') }
    }
    if (status === 'FAILED') {
      const detail =
        typeof body.error === 'object' && body.error && 'message' in body.error
          ? String((body.error as { message?: unknown }).message ?? '')
          : JSON.stringify(body.error ?? body).slice(0, 200)
      return { status: 'FAILED', error: detail }
    }
    return { status: 'RUNNING' }
  }

  async generate(
    input: StepFunMusicInput,
    opts: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<{ buffer: Buffer }> {
    const intervalMs = opts.intervalMs ?? 5_000
    const timeoutMs = opts.timeoutMs ?? 300_000  // 官方 1–3 分钟，留 5 分钟上限
    const { taskId } = await this.submit(input)

    const deadline = Date.now() + timeoutMs
    for (;;) {
      const r = await this.query(taskId)
      if (r.status === 'SUCCESS') return { buffer: r.buffer }
      if (r.status === 'FAILED') throw new Error(`music task FAILED: ${r.error}`)
      if (Date.now() >= deadline) {
        throw new Error(`音乐生成仍在进行（task_id=${taskId}），已等待 ${Math.round(timeoutMs / 1000)}s`)
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
}
```

- [ ] **Step 4: 扩音频工具超时**

`services/pi-runtime/src/tools/config.ts`：把 `"/agent/internal/run-audio-generation": 210_000` 改为 `330_000`，并在该行上方加注释说明依据：

```ts
	// music 实测约 70s、官方 1–3 分钟；同步链路最坏情况（voice 1000 字切分多段串联）也需余量 ⇒ 330s。
	// 与 video 的 690s 同族（都是端点内阻塞，pi 侧无 wait_* 工具）。
	"/agent/internal/run-audio-generation": 330_000,
```

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm --filter @lnkpi/agent exec vitest run src/tools/stepfun-audio.test.ts
cd services/pi-runtime && node --import tsx --test src/tools/config.test.ts
```
Expected: PASS

- [ ] **Step 6: 接入 `generateAudio` 的 `music` 分支（异步 + 乐观扣分 + 终态退款）**

`studio.service.ts` 中：先 `points.consume(..., 15, '音频生成-音乐')`，创建 `GenerationRecord { type:'audio', status:'generating', metadata: { audioKind:'music', ... } }` 并**先返回**给调用方；后台任务里跑 `StepFunMusicProvider.generate()`：

- 成功 → `upload.saveUserFile(userId, buffer, 'music.mp3', contentType)` → 更新 record 为 `completed` + `url`
- 失败 → `points.refund(...)` + 更新 record 为 `failed` + `errorMessage: audioFailureMessage('music', err, resolved.channelId)`

返回体的形态必须让前端既有链路直接接管：`{ ...record, generationStartedAt }`。

> 为什么不需要新端点 / 前端新轮询：`CanvasPage.vue` 的 `startPollingForGeneratingRecords()` 会收集所有带 `generationRecordId` 的节点，`useGenerationPolling` 每 2 秒调 `studioApi.getGeneration(recordId)`；`useNodeGeneration` 的 `resolveStudioRecord` 已对 `status==='generating'` 自动挂上轮询。前端零改动。**不引入 `/audio/start` 这类新端点**——video 有它是历史包袱，音频无必要。

- [ ] **Step 7: 服务层测试 + 提交**

```bash
pnpm --filter @lnkpi/server exec vitest run src/studio/studio.service.test.ts
pnpm --filter @lnkpi/server exec tsc --noEmit
cd services/pi-runtime && node --import tsx --test src/tools/config.test.ts
git add packages/agent/src/tools/stepfun-audio.ts packages/agent/src/tools/stepfun-audio.test.ts services/pi-runtime/src/tools/config.ts services/pi-runtime/src/tools/config.test.ts apps/server/src/studio/studio.service.ts
git commit -m "feat(audio): music 异步生成（submit+query，终态 FAILED 也判失败并退款）+ 音频超时 330s"
```

---

### Task 8: `run_audio_generation` 工具扩展（kind + 内联参数）

**Files:**
- Modify: `services/pi-runtime/src/tools/generation.ts`
- Modify: `services/pi-runtime/src/tools/generation.test.ts`
- Modify: `apps/server/src/agent/agent-canvas-tools.controller.ts`（`runAudioGeneration` 约 1221 行）
- Modify: `apps/server/src/agent/agent-canvas-tools.service.ts`（`runAudioGeneration`）

**Interfaces:**
- Consumes: Task 2 的 `AudioKind`
- Produces: `run_audio_generation` 的新 schema —— 新增参数**一律追加在 `node_id` 之后**：
  `kind?` / `roles?` / `scripts?` / `instruction?` / `caption?` / `lyrics?` / `instrumental?`

- [ ] **Step 1: 写失败测试**

⚠️ 本文件用 **`node:test` + `node:assert/strict`**（不是 vitest），且已有 `fakeClient()` 与 `run(tool, params)` 两个夹具 —— **直接用它们，不要另造**。

追加到 `services/pi-runtime/src/tools/generation.test.ts`（置于该文件既有 `fakeClient` / `run` 定义之后）：

```ts
test("run_audio_generation 把 kind 与内联参数透传到 Nest（不要求先写节点）", async () => {
	const fake = fakeClient();
	const tool = createGenerationTools(fake as never).find((t) => t.name === "run_audio_generation")!;
	await run(tool, {
		node_id: "n1",
		kind: "music",
		caption: "紧张感的弦乐",
		instrumental: true,
	});
	const call = fake.calls.at(-1)!;
	assert.equal(call.path, "/agent/internal/run-audio-generation");
	const body = call.body as Record<string, unknown>;
	assert.equal(body.nodeId, "n1");
	assert.equal(body.kind, "music");
	assert.equal(body.caption, "紧张感的弦乐");
	assert.equal(body.instrumental, true);
});

test("run_audio_generation 不传 kind 时 body 不含 kind / caption（存量调用逐字节不变）", async () => {
	const fake = fakeClient();
	const tool = createGenerationTools(fake as never).find((t) => t.name === "run_audio_generation")!;
	await run(tool, { node_id: "n1" });
	const body = fake.calls.at(-1)!.body as Record<string, unknown>;
	assert.equal("kind" in body, false);
	assert.equal("caption" in body, false);
	assert.equal("roles" in body, false);
});

test("run_audio_generation schema 声明 kind（模型才能自主选分类）", () => {
	const tool = createGenerationTools(fakeClient() as never).find(
		(t) => t.name === "run_audio_generation",
	)!;
	const props = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
	assert.ok("kind" in props, "缺少 kind 参数");
	assert.ok("caption" in props, "缺少 caption 参数");
});
```

注意：`fakeClient().post` 返回的对象**固定含 `url` 与 `actions`**，`resultWithActions` 可正常处理 —— 不需要 mock 别的返回值。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd services/pi-runtime && node --import tsx --test src/tools/generation.test.ts`
Expected: FAIL —— schema 不接受 `kind` / `caption`，或 body 中无这些字段

- [ ] **Step 3: 实现（不改 `runTool` 工厂，单独展开音频工具）**

`generation.ts` 中把 `runTool("run_audio_generation", ...)` 那一项替换为独立对象；其余 4 个 `runTool` 调用**保持不动**（它们是同一工厂，动工厂会牵连全部）：

```ts
		{
			...gen,
			name: "run_audio_generation",
			label: "执行音频生成",
			description:
				"Run audio generation for a canvas media node using node audio params. Requires pending confirmation. `kind` selects the audio sub-type: voice (default, TTS 配音) | design (综合音频：多角色台词+音效+氛围) | music (音乐/BGM). Sub-type-specific params may be passed inline and take precedence over node params: voice uses voice/emotion; design uses roles/scripts/instruction; music uses caption/lyrics/instrumental. Pick the kind that matches the request instead of defaulting to voice; if the requested kind's model is unavailable the tool returns an explicit error — report it, do not silently fall back.",
			parameters: Type.Object({
				node_id: Type.String({
					description: "Media node id to generate for (from canvas summary, not title text)",
				}),
				// ⚠️ 以下参数一律追加在 node_id 之后 —— 本工具的调用按位置对齐，
				// 中间插入会让同型参数错位（不报错、只静默错值）。
				kind: Type.Optional(
					Type.String({ description: "voice | design | music (default: voice)" }),
				),
				voice: Type.Optional(Type.String({ description: "voice: 音色 id" })),
				emotion: Type.Optional(Type.String({ description: "voice: 情绪" })),
				roles: Type.Optional(
					Type.Array(
						Type.Object({ role: Type.String(), voice: Type.String() }),
						{ description: "design: 角色→音色表" },
					),
				),
				scripts: Type.Optional(
					Type.Array(
						Type.Object({
							role: Type.Optional(Type.String()),
							text: Type.String({ description: "台词；() 内为语气、[] 内为音效" }),
						}),
						{ description: "design: 脚本段" },
					),
				),
				instruction: Type.Optional(
					Type.String({ description: "design: 整体演绎指导（≤500 字）" }),
				),
				caption: Type.Optional(Type.String({ description: "music: 风格描述" })),
				lyrics: Type.Optional(Type.String({ description: "music: 歌词（可空）" })),
				instrumental: Type.Optional(
					Type.Boolean({ description: "music: 纯音乐（无歌词）" }),
				),
			}),
			execute: async (
				_id,
				p: {
					node_id: string
					kind?: string
					voice?: string
					emotion?: string
					roles?: Array<{ role: string; voice: string }>
					scripts?: Array<{ role?: string; text: string }>
					instruction?: string
					caption?: string
					lyrics?: string
					instrumental?: boolean
				},
				_u,
				tc: LnkpiToolContext,
				_invocation,
				context: Context,
			) => {
				if (!tc.userId) throw new Error("run_audio_generation requires userId in toolContext");
				// 只把调用方真的给了的字段发出去：缺省 = 沿用节点上的参数（存量语义逐字节不变）。
				const body: Record<string, unknown> = {
					sessionId: tc.sessionId,
					userId: tc.userId,
					nodeId: p.node_id,
				};
				for (const key of [
					"kind",
					"voice",
					"emotion",
					"roles",
					"scripts",
					"instruction",
					"caption",
					"lyrics",
					"instrumental",
				] as const) {
					if (p[key] !== undefined) body[key] = p[key];
				}
				const data = (await client.post("/agent/internal/run-audio-generation", body, {
					signal: context?.abortSignal ?? undefined,
				})) as { url?: string } & Record<string, unknown>;
				return resultWithActions(data);
			},
		},
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd services/pi-runtime && node --import tsx --test src/tools/generation.test.ts`
Expected: PASS

- [ ] **Step 5: Nest 侧透传**

`agent-canvas-tools.controller.ts` 的 `runAudioGeneration` DTO 增可选字段（`kind` / `voice` / `emotion` / `roles` / `scripts` / `instruction` / `caption` / `lyrics` / `instrumental`），controller 原样把 dto 交给 `this.tools.runAudioGeneration(dto)`；`agent-canvas-tools.service.ts::runAudioGeneration` 在构造 `studioService.generateAudio` 的参数时，把这些字段**并入 options 并覆盖节点值**（工具内联优先于节点）。

⚠️ `runAudioGeneration` 的签名同样按位置传参，新字段**追加末尾**。

- [ ] **Step 6: 提交**

```bash
cd services/pi-runtime && node --import tsx --test src/tools/generation.test.ts
pnpm --filter @lnkpi/server exec tsc --noEmit
git add services/pi-runtime/src/tools/generation.ts services/pi-runtime/src/tools/generation.test.ts apps/server/src/agent/agent-canvas-tools.controller.ts apps/server/src/agent/agent-canvas-tools.service.ts
git commit -m "feat(audio): run_audio_generation 支持 kind 与内联参数（新参一律追加末尾）"
```

---

### Task 9: 前端三分类 chip + 参数区/模型下拉按 kind 过滤

**Files:**
- Modify: `apps/web/src/components/canvas/dock-studio/panels/AudioDockPanel.vue`
- Modify: `apps/web/src/components/canvas/UniversalModelSelector.vue`
- Modify: `apps/web/src/composables/useNodeGeneration.ts`
- Modify: `apps/web/src/constants/dockAudio.ts`、`apps/web/src/constants/credits.ts`

**Interfaces:**
- Consumes: Task 2 的 `AudioKind` / `listModelsByAudioKind` / `audioKindOf`；Task 6 的 `AudioGenerateOptions.kind`
- Produces: 节点字段 `data.audioKind: AudioKind`（缺省 `voice`）

- [ ] **Step 1: 写失败测试**

`apps/web/src/constants/dockAudio.test.ts` **已存在**（现有用例锁 `AUDIO_VOICE_OPTIONS` 与 catalog 对齐）⇒ **追加**一个新 `describe`，并把新增符号补进既有 import：

```ts
import { describe, expect, it } from 'vitest'
import { getModelEntry, listModels } from '@lnkpi/shared'
import {
  AUDIO_VOICE_OPTIONS,
  DEFAULT_AUDIO_VOICE,
  AUDIO_KIND_OPTIONS,
  defaultVoiceForKind,
  modelsForAudioKind,
} from './dockAudio'

describe('音频三分类 kind helpers', () => {
  it('三分类固定顺序 voice/design/music（UI 顺序即此）', () => {
    expect(AUDIO_KIND_OPTIONS.map((o) => o.value)).toEqual(['voice', 'design', 'music'])
  })

  it('模型列表按 kind 过滤（选音乐不会列出 TTS 模型）', () => {
    expect(modelsForAudioKind('music').map((m) => m.modelKey)).toEqual([
      'stepaudio-3-music-preview',
    ])
    expect(
      modelsForAudioKind('voice').some((m) => m.modelKey === 'stepaudio-3-music-preview'),
    ).toBe(false)
  })

  it('缺省 kind 视作 voice 且默认模型不变', () => {
    expect(defaultVoiceForKind(undefined)).toBe('minimax-speech-2.8-hd')
  })
})
```

`apps/web/src/constants/credits.test.ts` **已存在** ⇒ 同样**追加**一个 `describe`，import 行把 `estimateAudioCredits` 加进去：

```ts
describe('estimateAudioCredits 按 kind 分档', () => {
  it('音乐 15 分，其余音频 5 分', () => {
    expect(estimateAudioCredits('music')).toBe(15)
    expect(estimateAudioCredits('design')).toBe(5)
    expect(estimateAudioCredits('voice')).toBe(5)
  })

  it('缺省（存量无参调用）= voice = 5 分', () => {
    expect(estimateAudioCredits()).toBe(5)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lnkpi/web exec vitest run src/constants/dockAudio.test.ts src/constants/credits.test.ts`
Expected: FAIL —— `AUDIO_KIND_OPTIONS is not a function` 等

- [ ] **Step 3: 实现常量层**

`dockAudio.ts` 追加：

```ts
import { listModelsByAudioKind, type AudioKind, type StudioModelEntry } from '@lnkpi/shared'

export const AUDIO_KIND_OPTIONS: Array<{ value: AudioKind; label: string }> = [
  { value: 'voice', label: '配音' },
  { value: 'design', label: '综合音频' },
  { value: 'music', label: '音乐' },
]

export function modelsForAudioKind(kind: AudioKind): StudioModelEntry[] {
  return listModelsByAudioKind(kind)
}

/** 分类各自的首选模型；voice 保持目录默认（存量节点零变化）。 */
export function defaultVoiceForKind(kind: AudioKind | undefined): string {
  const k: AudioKind = kind ?? 'voice'
  if (k === 'voice') return defaultModelKey('audio')
  return listModelsByAudioKind(k)[0]?.modelKey ?? defaultModelKey('audio')
}
```

`credits.ts`：`estimateAudioCredits(kind?: AudioKind)`，`music` 返回 15，其余 5。**保留无参调用可编译**（`kind` 可选），确保存量调用点不改。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @lnkpi/web exec vitest run src/constants/dockAudio.test.ts src/constants/credits.test.ts`
Expected: PASS

- [ ] **Step 5: chip 行 + 参数区互斥**

`AudioDockPanel.vue`：在 `DockRefStrip` 之后、`DockPromptSection` 之前插入 chip 行（**照抄 `VideoDockPanel.vue` 的 `.dock-video-chip-actions` 形态**，class 名换成 `dock-audio-kind-chips`，样式同为 `display:flex; flex-wrap:wrap; gap:6px; margin:0 8px 6px;`）：

```html
    <div class="dock-audio-kind-chips">
      <button
        v-for="opt in AUDIO_KIND_OPTIONS"
        :key="opt.value"
        type="button"
        class="neo-chip rounded-md px-2 py-1 text-[10px]"
        :class="{ 'is-on': audioKind === opt.value }"
        :disabled="readonly"
        @click="setAudioKind(opt.value)"
      >
        {{ opt.label }}
      </button>
    </div>
```

脚本侧：

```ts
const audioKind = ref<AudioKind>(audioKindOf({ modality: 'audio', audioKind: props.node.data?.audioKind as AudioKind | undefined }))

function setAudioKind(next: AudioKind) {
  audioKind.value = next
  // 切分类时把模型换成该分类的首选，避免「音乐分类 + TTS 模型」的必错组合
  audioModel.value = resolveGenerationModel('audio', defaultVoiceForKind(next))
  emit('patch', { audioKind: next, audioModel: audioModel.value })
}
```

参数区按 kind 互斥显示：
- `voice` → 保持现有 `VoiceModelSelector` + `AudioVoiceSettingsSelector`
- `design` → 新增角色表（`roles`）+ 脚本段（`scripts`）+ `instruction` 输入
- `music` → 风格描述（`caption`）+ 歌词（`lyrics`）+ 纯音乐开关（`instrumental`）

`UniversalModelSelector` 增可选 prop 以按 kind 过滤候选（缺省不过滤 ⇒ 存量调用零变化）：

```ts
    /** 只对 audio 生效：按二阶分类过滤候选模型 */
    audioKind?: AudioKind
```

`modelOptions` 计算时，`modality === 'audio' && props.audioKind` 走 `modelsForAudioKind(props.audioKind)` 而非 `selectableAudioModels` 全量。

- [ ] **Step 6: 生成时透传 kind 与参数**

`useNodeGeneration.ts` 的 `nodeType === 'audio'` 分支（约 972-991 行）：把 `kind` 与分类参数并入 `studioApi.generateAudio` 的 options，其余**保持不变**（含 `patchNodeData gerationRecordId` + `resolveStudioRecord`）：

```ts
        const kind = (data.audioKind as AudioKind | undefined) ?? 'voice'
        const { data: res } = await studioApi.generateAudio(local, {
          model: resolveGenerationModel('audio', data.audioModel as string | undefined),
          kind,
          ...(kind === 'design'
            ? {
                roles: data.audioRoles as Array<{ role: string; voice: string }>,
                scripts: data.audioScripts as Array<{ role?: string; text: string }>,
                instruction: data.audioInstruction as string | undefined,
              }
            : {}),
          ...(kind === 'music'
            ? {
                caption: local,
                lyrics: data.audioLyrics as string | undefined,
                instrumental: Boolean(data.audioInstrumental),
              }
            : {
                voice: String(data.audioVoice ?? DEFAULT_AUDIO_VOICE),
                emotion: String(data.audioEmotion ?? 'neutral'),
                language: String(data.audioLanguage ?? 'zh'),
                speed: typeof data.audioSpeed === 'number' ? data.audioSpeed : 1,
                volume: typeof data.audioVolume === 'number' ? data.audioVolume : 1,
                pitch: typeof data.audioPitch === 'number' ? data.audioPitch : 0,
              }),
        }, refs, mentionedKeys, signal, canvasScope(node.id))
```

- [ ] **Step 7: 前端全量校验 + 提交**

```bash
pnpm --filter @lnkpi/web exec vitest run src/constants/dockAudio.test.ts src/constants/credits.test.ts src/composables/useNodeGeneration.test.ts
pnpm --filter @lnkpi/web exec vue-tsc -b --noEmit
git add apps/web/src/components/canvas/dock-studio/panels/AudioDockPanel.vue apps/web/src/components/canvas/UniversalModelSelector.vue apps/web/src/composables/useNodeGeneration.ts apps/web/src/constants/dockAudio.ts apps/web/src/constants/credits.ts apps/web/src/constants/dockAudio.test.ts apps/web/src/constants/credits.test.ts
git commit -m "feat(web): 音频节点三分类 chip + 参数区/模型下拉按 kind 过滤"
```

---

### Task 10: 治理同步（规则 23 / skills / 工具分层）

**Files:**
- Modify: `prompt-registry/rules/gen_tool_policy.md`
- Modify: `prompt-registry/MANIFEST.yaml`（`contentHash`）
- Modify: `apps/server/src/agent/pi-runtime/prompt-registry.loader.ts`（`FALLBACK_BY_ID` + 内嵌 fallback 全文）
- Modify: `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.ts`（`renderStaticFallback()` 拼装顺序）
- Modify: `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.test.ts`（`EXPECTED` 硬编码串）
- Modify: `apps/server/src/agent/pi-runtime/prompt-registry.loader.test.ts`（四组合逐字符相等，**若基线需同步则一并改**）
- Modify: `services/pi-runtime/src/tools/tiering.test.ts`
- Modify: `skills/drama-audio-design/SKILL.md`（及同目录相关文件）

**Interfaces:**
- Consumes: Task 8 的工具 schema
- Produces: 规则 23 按 `kind` 描述三类能力；`run_audio_generation` 归属锁

- [ ] **Step 1: 等量改写规则 23（先量长度，再落笔）**

先实测当前字符数，确认可用余量：

```bash
pnpm prompt:lint
```
Expected: 打印 L6 组合长度，最紧组合必须 ≤ 3200。记录当前值（规格基线：3076 / 余 124）。

`prompt-registry/rules/gen_tool_policy.md` 第 14 行原文：

> `run_audio_generation` 只做配音/朗读，不做 BGM/音效/配乐；用户要 BGM/音效时如实说明不支持，禁冒充。

改为（**同长度量级等量替换**，逐字核对字数后再提交）：

> `run_audio_generation` 按 kind 分三类：voice 配音朗读、design 多角色台词+音效、music 配乐/BGM；选错分类或无该分类模型时如实说明，禁冒充。

- [ ] **Step 2: 同步提示词 6 处 + 生成的第 7 处**

按 `AGENTS.md`「改提示词规则 ⇒ 同步 6 处」逐一核对：

1. `prompt-registry/rules/gen_tool_policy.md`（正文）— 已改
2. `prompt-registry/MANIFEST.yaml` — `contentHash` = `sha256(body.trimEnd())` 前 12 位；`version` 两处一致
3. `apps/server/src/agent/pi-runtime/prompt-registry.loader.ts` 的 `COMPOSED_IDS`（本次不涉及）
4. 同上文件的 `FALLBACK_BY_ID` 映射（**重新对齐内嵌 fallback 全文**）
5. 🔴 `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.ts` 的 `renderStaticFallback()` **拼装顺序**
6. 🟡 `apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.test.ts` 的 `EXPECTED` 硬编码串
7. `npx tsx scripts/gen-prompt-spec-map.ts --check`（CI 独立 step）

**同步判据**：磁盘 `renderStatic` == 内嵌 `renderStaticFallback`，四组合**逐字符相等**（由 `apps/server/src/agent/pi-runtime/prompt-registry.loader.test.ts` 校验）。

- [ ] **Step 3: 跑提示词门禁**

```bash
pnpm prompt:lint
pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/prompt-registry.loader.test.ts
pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/pi-prompt-assembler.service.test.ts
npx tsx scripts/gen-prompt-spec-map.ts --check
```
Expected: `prompt:lint` 通过且 L6 总长 ≤ 3200；四组合逐字符相等测试通过；spec-map 无漂移。

⚠️ 若超长，**优先缩短措辞而不是放宽预算**（预算改动属「必须先问人」红线）。

- [ ] **Step 4: 同步 skill 的能力声明**

`skills/drama-audio-design/` 中删除「不支持 BGM/音效生成」类声明，改为：

- 配音（voice）：用 `run_audio_generation` 默认分类
- 多角色台词 + 音效 + 氛围（design）：`kind: "design"` + `roles` + `scripts`
- 配乐 / BGM（music）：`kind: "music"` + `caption`（+ `instrumental`）

⚠️ 改完 skill 还要跑 loader 硬校验（skill 不占 L6 预算，但 SKILL.md 的 frontmatter 形态受 `skills/loader.ts` 约束）：

```bash
pnpm prompt:lint
```
（skill 形态若有疑问，用 `/Users/4seven/.workbuddy/skills/pi-lnk-skill-lint` 的规则自查 frontmatter。）

- [ ] **Step 5: 锁工具分层归属**

`services/pi-runtime/src/tools/tiering.test.ts`：在「被资产点名的工具必须常驻」的用例列表中加入 `run_audio_generation`（它被规则 23 与 `drama-audio-design` 按名字点名 ⇒ 必须常驻）。

- [ ] **Step 6: 跑全部门禁 + 提交**

```bash
pnpm prompt:lint
pnpm verify-claims
pnpm verify-tool-contract
pnpm verify-tool-tiering
cd services/pi-runtime && node --import tsx --test src/tools/tiering.test.ts
pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/prompt-registry.loader.test.ts
git add prompt-registry skills services apps/server/src/agent/pi-runtime
git commit -m "docs(prompt): 规则 23 按 kind 描述三类音频能力 + skills/tiering 同步"
```

⚠️ `AGENTS.md` 归 R6 所有，**本次不动**（新 workflow 才需要改系统地图表）。

---

### Task 11: 端到端验收 + 文档登记

**Files:**
- Modify: `docs/superpowers/INDEX.md`（生成管线组 +1 份 living）
- Modify: `docs/README.md`（登记实施计划）

**Interfaces:**
- Consumes: Task 1–10 全部
- Produces: 计划登记完成；验收证据留痕

- [ ] **Step 1: 三类端到端手测（本地，走真实上游）**

1. `voice`（回归）：任意一条存量音频节点直接点生成 → 扣 5 分、产物可播放、`metadata.audioKind` 为 `voice`
2. `design`：切到「综合音频」→ 2 角色 + 1 音效 → 生成出可播放音频（听到两种音色 + 音效）
3. `music`：切到「音乐」→ 填 caption + 纯音乐 → 节点进入 generating → 轮询到 completed 后画布可回放（产物在对象存储，**不是 data URL**）

- [ ] **Step 2: agent 自主选择验收**

在 agent 会话里给一句：「给这条分镜配个紧张感的背景音乐」。Expected：模型自行选 `music`、填 `caption`、调 `run_audio_generation` 并产出；**不得**落到 `voice`。

再给一句：「这段旁白配两个角色对话，加个关门音效」。Expected：模型选 `design` + 传 `roles`/`scripts`。

- [ ] **Step 3: 失败路径验收（Review Focus 逐条）**

| 场景 | 期望 |
|---|---|
| 摘掉 `STEPFUN_API_KEY`（本地 env 模拟） | 显式提示「通道未配置平台密钥」，**不是**打到 OpenAI 端点 |
| 把上游 key 换成余额为 0 的 key | 文案含「平台音频额度不足」 |
| `music` 用违反内容策略的 caption | record 变 `failed` + 文案含上游原因 + **已退款**，而非 completed |

- [ ] **Step 4: 登记文档**

⚠️ `docs/superpowers/INDEX.md` 是**生成产物**，**禁止手改**。正规流程：

```bash
python3 scripts/docs/gen_index.py > scripts/docs/index_data.json
python3 scripts/docs/gen_index_md.py
```

（本计划与配套规格已在计划分支创建时登记完毕 —— 索引已从 283 份重新生成为 302 份，含这两份。
此后**只有新增文档时**才需要重跑上面两条。）

`docs/README.md` 的「产品交互契约」表已由计划分支登记，无需重复。

- [ ] **Step 5: 提交并开 PR**

```bash
git add docs/superpowers/INDEX.md docs/README.md
git commit -m "docs(plan): 登记音频节点统一创作能力实施计划"
git push -u origin docs/audio-node-unified-capability-plan
/usr/local/bin/gh pr create --base master --head docs/audio-node-unified-capability-plan \
  --title "docs(plan): 音频节点统一创作能力实施计划" --body-file /tmp/pr_body_audio_plan.md
```

---

## Self-Review

**1. Spec coverage**

| 规格章节 | 覆盖任务 |
|---|---|
| §4.1 凭证接入（env 非 DB） | Task 1、Task 3 |
| §4.2 模型登记 + `audioKind` | Task 2 |
| §4.3 第二处入口覆盖（**验收项**） | Task 4 Step 6–7 |
| §4.4 四条风险守卫（配额/402/限免到期/preview 退役） | Task 4（402/缺 key 文案）、Task 5（可选模型为空即显式不可用）、Task 7（终态 FAILED） |
| §4.5 阶段 0 验收 4 条 | Task 5 Step 1、Task 11 Step 3 |
| §5 阶段 1 `design`（端点/参数/UI/产物/积分/验收） | Task 6、Task 9 |
| §6 阶段 2 `music`（异步/超时/产物/前端/积分/失败判读/验收） | Task 7、Task 9 |
| §7 阶段 3（agent 可见分类 / 工具签名 / 规则 23 / skills / 分层 / 验收） | Task 5、Task 8、Task 10、Task 11 Step 2 |
| §8 不变量（voice 逐字节不变 / 不新增节点 / HITL 一致 / 禁静默回退） | Task 2 Step 4、Task 4 Step 5、Task 8 Step 1、Global Constraints |
| §9 C1–C4 已定项 | C1→Global Constraints；C2→Task 5（不改覆盖逻辑）；C3→Task 7（仅积分闸门）；C4→已在 PR #239 完成，本计划不重复 |

**2. Placeholder scan**：无 TBD / 「适当处理」类步骤。Task 4 Step 7 与 Task 9 的 UI 代码给了确切结构；Task 6 Step 5 / Task 7 Step 6 的 record 创建细节指向同文件既有同型段落（`generateAudio` 的 voice 分支）作为模板，属可执行指引而非占位。

**3. Type consistency**：`AudioKind` 只在 `studioModelCatalog.ts` 定义并导出；`audioKindOf()` 是缺省值唯一判据处；`StepFunDesignProvider.generate` 返回 `{ buffer, contentType }` 与 `StepFunMusicProvider.generate` 返回 `{ buffer }` 在 Task 6/7 的调用点一致；`AudioGenerateOptions.kind` 与 Task 8 的 `body.kind` 同枚举。

**4. Review Focus 落点**：五条均已挂到 owning task（Task 3/4、Task 9、Task 7/4、Task 2/4、Task 4），每条都有对应断言。

---

## Execution Handoff

计划落盘后请复核。执行方式二选一：

- **Subagent-driven** —— 每个 task 由新 subagent 实现、独立 reviewer 检查后再进下一个，最后整分支复核。**推荐**：本计划 11 个 task 中 Task 3→4→6→7 共享 `resolver`/`studio.service`/`stepfun-audio` 的接口，且 Task 10 会改提示词（错了要回滚整个 L6 预算），独立复核价值高。
- **Native** —— 我在本会话按序实现全部 task，最后一次性复核。最省成本，但中途没有独立把关。
