# U6③ 调研：「用户有无 audio 能力」的数据来源

> 2026-10-06 · 对应 `2026-10-04-media-generation-audit.md` U6 第 3 项（音频 Dock 死按钮兜底）。
> 结论先行：**首选 `GET /provider/bootstrap` 的 `preferences.selectableAudioModels`**；
> `useCapabilities` 不适合承载 per-user audio 判定。

## 1. 死按钮问题回顾

`AudioDockPanel.vue` 的生成按钮 / 麦克风 / `VoiceModelSelector` 无条件渲染。
用户渠道里没有任何 audio 模型时，点「生成」必然走到 `run_audio_generation` 的
`NotFoundException('channel not found')`（或 U7 平台凭据缺失的 503）——
按钮可点但永远失败，无前置引导。

## 2. 候选数据源盘点（2026-10-06 实测 origin/master）

| # | 来源 | 位置 | per-user | audio 维度 | 评价 |
|---|---|---|---|---|---|
| A | `provider/bootstrap` → `preferences.selectableAudioModels` | `provider.service.ts:239` + prisma `UserAiPreferences.selectableAudioModels` | ✅ | ✅ 显式 | **首选**：与 `VoiceModelSelector`/`UniversalModelSelector` 同源；用户在 provider 设置里勾了什么，dock 就该按什么兜底 |
| B | `provider/bootstrap` → `channels[].models` + `inferModelCapability()` | `providerChannels.ts:42`（`AUDIO_MODEL_RE`） | ✅ | ⚠️ 名称正则推断 | 备选：比 A 更「实时」（未勾选但渠道里有），但要在前端复制能力推断逻辑 |
| C | `GET /agent/capabilities/list` | `agent.controller.ts:211` | ❌ 静态常量 | ❌ **无 audio 字段** | 不推荐：返回 `{text,image,video,stsDirectUpload}` 全来自 shared 静态 catalog，加 per-user 语义会混淆该端点定位 |
| D | 前端 catalog `listModels('audio')` | `useCapabilities.ts:18` 的兜底 | ❌ | ✅ | 现状就是它 ⇒ 正是死按钮成因：catalog 有 audio 模型 ≠ 用户用得了 |

## 3. 关键事实（纠正既有认知）

1. **`/agent/capabilities/list` 路由是存在的**（`agent.controller.ts:211`，经 `AgentService.getCapabilities()`）。
   `useCapabilities.ts:57` 注释「后端当前没有这条路由（审计 §2.5）」**已过时**——审计基线之后有人补了路由，
   但服务端始终没返回 audio 维度，前端 `data.data.audio` 恒为 undefined，永远走 catalog 兜底。
2. audio 模型的**编码形态**是 `channelId::modelName`（`encodeChannelModel`），`channelId === 'platform'` 表平台通道。
   判「有无能力」直接看数组长度即可，无需解码。
3. 能力推断的权威正则在 shared：`AUDIO_MODEL_RE = /(whisper|tts|audio|suno|fish-speech|cosyvoice|speech|voice)/i`；
   用户手动 tag 优先于推断（`resolvePulledModelCapability`）——**前端若走候选 B 必须复用 shared 函数，不要本地重写正则**。
4. U1 之后失败会冒泡退款，所以死按钮的代价是「点了必失败」，不是「静默假成功」——
   兜底的价值是**前置禁用 + 引导去 provider 设置配渠道**，而不是防扣费。

## 4. 建议实现口径（待拍板，未动代码）

- **判定**：`selectableAudioModels.length === 0` ⇒ dock 生成按钮禁用 + 一句引导
  「在 设置→渠道 里配置含 TTS 的模型后可用」（链到 `ProviderConfigDialog`）。
  麦克风/音色选择器保持可用（录文案、选偏好不依赖上游渠道）。
- **数据获取**：dock 所在页若已拉过 `provider/bootstrap`（provider 设置链路已有 `provider-api.ts:96`）则复用；
  否则懒拉一次。不建议为此扩 `/agent/capabilities/list`。
- **边缘**：`selectableAudioModels` 勾了但渠道密钥失效 ⇒ 仍走 U1 的 fail-loud 冒泡，本兜底不负责预检密钥。
