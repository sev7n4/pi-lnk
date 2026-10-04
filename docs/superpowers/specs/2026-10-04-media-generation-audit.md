---
id: media-generation-audit
version: 1.0.0
title: 画布视频/音频节点生成链路审计
order: 60
owner: agent-platform
updated: 2026-10-04
---

# 画布视频 / 音频节点生成链路 — 审计（本主线的驱动文档）

> 本文件是「音视频生成链路」开发主线的**事实基础**。所有结论均来自生产取证与上游实测，
> 而非代码形态推断。下游实施计划见
> `docs/superpowers/plans/2026-10-04-media-generation-pipeline.md`。

**审计对象**：`pi-lnk` @ `7573e0e`（审计开始时 = `origin/master`）
**覆盖范围**：`apps/web`（Vue 前端）、`apps/server`（Nest）、`services/pi-runtime`（工具层）、
`packages/shared`（模型目录 / 参数门禁）、`packages/agent`（provider 层）、`prompt-registry`、`deploy`

**取证方法**（可复用）：生产库是 **SQLite**
（`DATABASE_URL=file:/app/apps/server/data/lnkpi.db`，非 postgres），
在 `lnkpi-api` 容器内 `require('/app/apps/server/node_modules/@prisma/client')` 直查即可；
容器内还能用 `process.env` + `fetch` **直连上游做能力探测**——这是判定
「上游到底有没有这能力」的唯一可靠手段。

---

## 1. 生产硬证据

### 1.1 音频（GenerationRecord type=audio，全量 18 条）

| 观测项 | 结果 |
|---|---|
| url | 18/18 均为 `https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3` |
| `hasTtsData`（真实 TTS 产物标志） | **0 条为 true** |
| status | 18/18 `completed`，无一条 failed |
| 积分 | 扣费 18 笔 × 5 分，**退款 0 笔** |
| model 字段 | `minimax-speech-2.8-hd` × 5；**`female-1` × 13**（音色 id 被写成模型名） |
| 最近一次 | 2026-08-01（审计日 2026-10-03，两个月零使用） |

### 1.2 上游 Agnes 网关实测（容器内带生产 Key 直连）

```
POST https://apihub.agnes-ai.cn/v1/audio/speech
  model=tts-1                  -> 503  model_not_found: No available channel for model tts-1
  model=speech-2.8-hd          -> 503  model_not_found
  model=minimax-speech-2.8-hd  -> 503  model_not_found
  model=seed-audio-1.0         -> 503  model_not_found
```

**结论：平台通道上没有任何可用的 TTS 模型。** 与库里 18/18 `hasTtsData=false` 完全吻合——
不是偶发失败，是必然失败。

### 1.3 视频（GenerationRecord type=video，796 条）

| 状态 | 数量 |
|---|---|
| completed | 417 |
| failed | 252 |
| fallback_pending | 122 |
| generating（未终态，最老 2026-07-20） | 5 |

- **未产出率 = (252 + 122) / 796 = 47%**
- 扣费 850 笔 / 退款 398 笔
- `video url=unsplash` 占位图：1 条（`PlaceholderVideoProvider` 线上确已触发）

**上游原始错误分布**（failed + fallback_pending 近 400 条样本）

| 错误 | 次数 | 判读 |
|---|---|---|
| `429 You've reached the API rate limit for free users` | 103 | 生产跑在**免费额度**通道 |
| `503 video_queue_full` | 72 | 明确可重试，但代码**零重试** |
| `fail_to_fetch_task`（litellm.BadRequest） | 30 | 上游任务回查失败 |
| `invalid_request: image URL could not be downloaded` | 22 | 上游拉不到我方图片 URL |
| `content_policy_violation` | 19 | 内容审核 |
| `invalid_request: media URL could not be downloaded` | 12 | 同上 |

`failureClass` 分布：unknown 204 / upstream 88 / network 22 / auth 3 / 空 57
→ **55% 的失败未被归类**，原始报文被直接拼进用户可见文案。

### 1.4 `generateAudio` 丢弃分布（关键修正）

| 模型 | 丢弃次数 |
|---|---|
| `agnes-video-v2.0` | 278 |
| `agnes-video-2.5-flash` | 57 |
| `doubao-seedance-2.0-mini` | 12 |
| `doubao-seedance-2.0` | 4 |
| `MiniMax-H3` | 1 |

⚠️ **对早期结论的修正**：初版报告称「generateAudio 从未真正下发」，此说法**不准确**。
准确表述是——

- **335 次（Agnes 系列）是诚实的丢弃**：`agnes-video-v2.0` / `agnes-video-2.5-flash`
  在 catalog 中确实未声明 `generateAudio`，`AgnesVideoProvider` 也不发该字段，
  即上游真的不支持。真实缺陷是**用户看不到「此模型无音轨」这个差异**（见 §2.3）。
- **16 次（Seedance 系列）是真 bug**：`seedance-2.0-min` / `seedance-2.0` 在 catalog 中
  **明确声明 `generateAudio: 'native'`**，却仍被丢弃。根因见 §2.1。

---

## 2. 根因分析

### 2.1 🔴 模型标识空间不统一 → 能力判定错误地静默回退（16 次误丢的根因）

一个模型有两套 id：`modelKey`（`seedance-2.0-min`）与 `gatewayModelId`（`doubao-seedance-2.0-mini`）。

```ts
// packages/shared/src/studioModelCatalog.ts:333
export function getModelEntry(modelKey: string) {
  return STUDIO_MODEL_CATALOG.find((entry) => entry.modelKey === modelKey)  // 只按 modelKey 精确匹配
}

// packages/shared/src/studioModelCatalog.ts:340
export function resolveModelKey(modality, requested) {
  const fallbackKey = defaultModelKey(modality)         // video -> 'agnes-video-v2.0'
  const fallbackEntry = getModelEntry(fallbackKey)!
  if (!requested) return { modelKey: fallbackKey, entry: fallbackEntry, fallback: false }
  const entry = getModelEntry(requested)
  if (entry?.modality === modality) return { modelKey: requested, entry, fallback: false }
  return { modelKey: fallbackKey, entry: fallbackEntry, fallback: true }   // ← 静默回退
}
```

调用方（生产记录 `model` 字段即为证据）传的是 `doubao-seedance-2.0-mini`，于是：

```
resolveModelKey('video','doubao-seedance-2.0-mini')
  → getModelEntry 查不到 → fallback:true，entry = agnes-video-v2.0 条目
  → generation-adapter.ts:644  const catalog = resolveModelKey('video', modelKey)
  → catalog.entry 是 Agnes 条目（即使 gatewayModelHint 把 resolvedKey/catalogGateway 改对了，
     catalog.entry 仍是 Agnes —— 见 generation-adapter.ts:647-654）
  → catalog.entry.params.generateAudio === undefined ≠ 'native'
  → droppedFields.push({ field:'generateAudio', reason:'generateAudio not supported natively by agnes-video-v2.0' })
```

这是**又一个静默降级**：「查不到就回退默认条目」使能力判定失真，且 `fallback: true`
这个信号在参数判定处完全没被使用。

### 2.2 🔴 音频三重静默叠加（100% 假成功）

```
上游无 TTS 通道（503）
  → ① FallbackAudioProvider(audio-provider.ts:60-73) catch → console.warn
       → 返回占位 MP3，不抛错
  → ② studio.service.ts:2282  const storeUrl = url.startsWith('data:') ? AUDIO_PLACEHOLDER : url
       占位 MP3 是 https，非 data: → 原样入库
  → ③ 未抛错 ⇒ 不进 catch ⇒ 不退款、status 写 completed
```

与识图事故（`supportsVision` 被 parse 层白名单剥掉）**同形态**：
上游不支持 + 兜底吞异常 + 写成功态。判据从 `image_tokens` 换成 `hasTtsData`。

⚠️ 对比：视频侧无 key 兜底是 `UnsupportedVideoGatewayProvider`（**抛错，正确**），
音频侧是 `FallbackAudioProvider`（**吞错，错误**）——同一项目两种兜底哲学。

### 2.3 🔴 「不支持」不可见

`droppedFields`（`generation-adapter.ts:695` 等）只写进 metadata，**前端零渲染**。
用户在 UI 上看到「生成带音轨视频」的开关，Agnes 模型下点了毫无效果且无反馈。

### 2.4 🔴 视频可用性缺口

- **零重试**：429 / `video_queue_full` 等明确可重试错误直接判失败（175 次）
- **超时错配**：orchestrator `VIDEO_POLL_TIMEOUT_MS = 660_000`
  vs `videoModelProfiles.ts:178` minimax `maxPollMs = 1_200_000` → 该模型必然先被判 timeout，
  而后台任务仍在跑，状态自相矛盾
- **persist 是空函数**：`studio.controller.ts:652` 传 `async () => {}`，
  orchestrator 内 `await persist(...)` 全被丢弃 → 节点 `status:'generating'` 与
  `generationRecordId` **从未写回画布**
- **积分泄漏**：`points.consume`（`studio.service.ts:2077`）早于可抛错步骤
  （`resolveForGeneration` 会抛 `NotFoundException('channel not found')`），抛错即扣费无记录无退款
- **无幂等**：视频端点无 idempotency-key，同节点重复点击 → 两条记录 + 两次扣费
- **无限流**：项目内唯一限流只保护 `media-probe`
- `PlaceholderVideoProvider`（`video-provider.ts:35-45`）返回 Unsplash **JPEG 静态图**冒充视频
- 三处轮询错误 `continue` 无限吞：`video-provider.ts:121`、
  `minimax-h3-video-provider.ts:179-184`、`fal-video-queue.ts:116-121`

### 2.5 前端缺口

- **轮询无墙钟上限**：`useGenerationPolling.ts:52-54`、`useShotPolling.ts:27-43`
  均 `setInterval(2000)` 且无最大轮次，catch 静默吞异常 → 后端 5 条卡 `generating`
  的记录让节点**永远转圈**
- **三类节点「生成」是死按钮**：`worldModel` / `mediaInput` / `group` 在
  `generateForNode`（`useNodeGeneration.ts:843-957`）无分支、无 else 兜底 →
  点击后不发请求、不报错、不改状态
- `runGroupMemberHasUsableOutput`（`:730-742`）对 audio 直接 `return true` 不校验 url
- `waitForRunGroupMemberSettled`（`:744-776`）`for(;;)` + 150ms 忙等，无退出上限
- `capabilities-api.ts:4-10` 的 `CapabilitiesData` 无 audio 字段
- `dockAudio.ts:8-12` 的 `AUDIO_VOICE_OPTIONS`（`female-1/male-1/narrator`）
  不含默认值 `DEFAULT_AUDIO_VOICE='female-shaonv'`（`:31`）

### 2.6 治理缺口

- `prompt-registry/rules/` 只说可以调 `run_audio_generation`，**未声明「仅 TTS，
  不能生成 BGM/音效/混音」** → 模型会向用户承诺不存在的能力
- `deploy/` 下 40+ 个专项验证脚本唯独无 audio；`run_audio_generation` 只出现在负例断言
- `agent/internal/*`（含 `run-video-generation`）**无 AuthGuard**，而 `main.ts` 无全局守卫
- `OPENAI_TTS_MODEL` 有实现（`audio-provider.ts:94`）无 env 入口（`.env.example` 与生产 env 均无）

### 2.7 已证伪的判断

音频**不是**「只有壳」：`audio` 节点类型在 shared / Nest / pi-runtime 三处均为合法值，
`run_audio_generation` 有执行器、有 HITL 门禁、有超时（210s）与单测，
Nest 有端点、provider 有真实 HTTP 调用。成熟度差距落在
**产物持久化、失败可见性、能力边界、验证覆盖**四项，而非链路本身。

音乐 / 音效 / 混音：**全仓确无** provider、工具或端点
（`skills/drama-audio-design/SKILL.md:25-27` 已诚实标注）。

---

## 3. 修复顺序原则

1. **先止血**：所有「静默冒充成功」的路径必须在改动当天消失（音频兜底、视频占位图）。
2. **再修能力判定**：模型标识解析统一后才谈参数透传，否则能力表继续失真。
3. **可用性与治理并行**：重试/超时/幂等属于稳定性，可与前端可见性并行推进。
4. **依赖外部资源的放最后**：接真实 TTS 上游需要采购凭据，在此之前音频入口应**显式不可用**。
