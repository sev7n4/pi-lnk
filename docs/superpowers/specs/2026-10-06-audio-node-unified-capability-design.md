# 音频节点统一创作能力设计（「音」模态的细分承载）

> 2026-10-06 · 上游：`2026-10-06-u6-3-audio-capability-source.md` / `2026-10-04-media-generation-audit.md`（U6/U7）
**状态：** 待复核（2026-10-06）——§9「待确认项」有 4 个默认值可否决
> 基线：`origin/master`，2026-10-06 17:40 实测核实

---

## 0. 结论先行

1. **不新增画布节点类型**。顶层模态固定为 `text | image | video | audio`（`packages/shared/src/providerChannels.ts:1` 的 `ModelCapability` 与 `StudioModality` 同构），音频节点内部新增二阶分类 `AudioKind = 'voice' | 'design' | 'music'`。
2. **单节点 + 单工具**。agent 通过 `run_audio_generation(node_id, kind?, ...params)` 自主选分类、填参数、直接产出；不新增工具（现 47 个已偏多）。
3. **平台级打通是本方案的前置**。用户已确认可提供平台级 StepFun key ⇒ 三类能力对所有用户默认可用，不再依赖用户自配 BYOK。
4. **顺序**：阶段 0（平台通道）→ 阶段 1（`design` 综合音频）→ 阶段 2（`music` 音乐）→ 阶段 3（agent 自主选择 + 治理同步）。

---

## 1. 现状核实（全部回代码实测，非推断）

| # | 事实 | 位置 | 对本设计的含义 |
|---|---|---|---|
| 1 | 音频节点=**纯 TTS**；契约 `generate(text, {model,voice,speed,volume,pitch,emotion,instruction})`，单次 `POST {baseUrl}/audio/speech`，返回 `{url:'data:audio/mpeg;base64,…'}` | `packages/agent/src/tools/audio-provider.ts:129-144` | 现有参数域是**一维标量**，装不下 roles/scripts/caption |
| 2 | 工具 `run_audio_generation` **只接受 `node_id`**，无内联参数 | `services/pi-runtime/src/tools/generation.ts:123-128`（`runTool` 工厂 `:62-66` 写死 `node_id`） | 「agent 自主填参数」需扩工具 schema |
| 3 | 音频端点**只有 run、无 wait**；工具超时 **210s** | `services/pi-runtime/src/tools/config.ts`（video 为 690s） | music 必须扩超时（阶段 2） |
| 4 | 音频生成唯一后端入口走 `resolver.resolveForGeneration(userId, model, 'audio')`，每次 **5 分**（`chargeReason='音频生成'`） | `apps/server/src/studio/studio.service.ts:2264-2270` | 新分类复用同一条扣分/退款链路 |
| 5 | **第二处音频入口不走 resolver**：降级重放 `providerFallback:true` / `channelId:'platform'` 用 `createAudioProvider(undefined)` | `apps/server/src/studio/studio.service.ts:2611-2616` | ⚠️ 平台凭证必须同时覆盖此路（见 §4.3） |
| 6 | 平台渠道**凭证只来自 env**：`apiKey = process.env.OPENAI_API_KEY`，再按模型名被 `resolve{FalH3Max,MiniMaxH3,Apimart}PlatformCredentials` 覆盖；DB 行只供 `baseUrl`/`apiFormat`/models（`hasApiKey` 恒 false、`readOnly`） | `apps/server/src/provider/provider-resolver.service.ts:48-78`；`provider.service.ts:23,280-282` | **平台 key 只能进 env，写 DB 无效** |
| 7 | 平台渠道 models 由 `catalogModels()` 从 `STUDIO_MODEL_CATALOG` **全量同步**（`pullModels` 时） | `apps/server/src/provider/provider.service.ts:170-175,339-345` | 登记进 catalog 即进入平台可选项 |
| 8 | catalog 现有 audio 条目 4 条：`seed-audio-1.0`/`minimax-speech-2.8-hd`/`step-tts-mini`/`stepaudio-3-tts`；**无 gen / music** | `packages/shared/src/studioModelCatalog.ts:323,337,356,375` | 必须登记，否则 `resolveModelKey` **静默回退**（音色/参数按错的表处理） |
| 9 | 渠道拉取时能力判定 `AUDIO_MODEL_RE = /(whisper\|tts\|audio\|suno\|fish-speech\|cosyvoice\|speech\|voice)/i` **只判四模态、不分音频子类** | `packages/shared/src/providerChannels.ts:34-42` | 用户 BYOK 渠道的 21 个 step 模型会**平铺成一个 audio 桶**（实测），不拆子类必选错 |
| 10 | 规则 23 写死「`run_audio_generation` 只做配音/朗读，不做 BGM/音效/配乐」 | `prompt-registry/rules/gen_tool_policy.md:14` | 接入后必须改写；**L6 硬线 3200**，#231 后最紧组合 3076 ⇒ **余量 124 字符**，只能等量改写 |
| 11 | `skills/drama-audio-design` 显式声明「不支持 BGM/音效生成」 | `skills/drama-audio-design/` | 接入后不同步 ⇒ 模型会继续按旧认知拒绝用户 |
| 12 | 节点内部二阶分类**已有三个先例**：`MediaInputKind`（媒体输入）、`videoMode`（文生/图生/首尾帧，UI = 引用条下方 chip 行）、视频合成 mode | `apps/web/src/components/canvas/canvasDockMenu.ts`；`dock-studio/panels/inferVideoDockMode.ts`；`VideoDockPanel.vue` | 音频加分类是**延伸既有模式**，不是新发明 |
| 13 | `set_node_generation_params` 音频字段共 **7 个标量**：`audio_voice/emotion/language/speed/volume/pitch/model` | `services/pi-runtime/src/tools/canvas-write.ts:245-252,275-277` | 装不下脚本/音乐风格 ⇒ 新参数走工具内联，不落节点 |
| 14 | StepFun 限免 4 模型（`stepaudio-3-{realtime,chat,gen,music}-preview`）**官方无截止日期**；先例 `step-2x-large` 于 2026-06-12 无预告转收费 | 官方定价页 + 平台公告（2026-10-06 核实） | 必须做「不可用 → 显式提示」，禁静默降级 |
| 15 | 4 个限免模型**已实测全部可用**（容器内解密 BYOK key 探测）：chat 200 / gen 同步返 `audio/mpeg` 199KB / music `submit→query` 约 70s SUCCESS 2.2MB / realtime WS 101→`response.done` | `.workbuddy/memory/2026-10-06.md` | 技术上无阻碍，风险只在窗口期与 ID 退役 |

---

## 2. 已拍板决策

| # | 决策 | 来源 |
|---|---|---|
| D1 | 分类集合 = **三类**：`voice`（配音，= 现 TTS）/ `design`（综合音频，多角色台词+音效+氛围）/ `music`（音乐/BGM）。**ASR、realtime 本期不入节点** | 用户选择 |
| D2 | 分类形态 = **节点内显式分类**（可读可写字段），不跟随模型隐式切换 | 用户选择 |
| D3 | agent 侧 = **单工具 + kind 参数**，参数可内联传（不必先写节点再执行） | 用户选择 |
| D4 | 积分 = **综合音频 5 分 / 音乐 15 分**（配音维持 5 分）；官方定价公布后再调 | 用户选择 |
| D5 | 优先级 = **先 `design`，后 `music`**（前者同步 HTTP、工程量最小） | 用户选择 |
| D6 | **平台可提供 StepFun key，模型与现有 BYOK 一致，让平台侧也可用** | 用户（本轮机加） |

---

## 3. 领域模型

```
StudioModality = 'text' | 'image' | 'video' | 'audio'      // 顶层，不变
AudioKind      = 'voice' | 'design' | 'music'              // 新增，audio 之下
```

- 节点字段 `audioKind?: AudioKind`，**缺省视作 `voice`** ⇒ 存量节点与老路径行为**逐字节不变**。
- 参数区与模型下拉**都按 `audioKind` 过滤**（不是只过滤其一）。
- 分类切换 UI：复用视频节点同款「引用条下方 chip 行」（`VideoDockPanel.vue` 既有形态）。
- 每个 catalog audio 条目新增 `audioKind` 元数据 + 该 kind 的参数处置表（复用既有 `ParamDisposition`：`native` / `promptPrefix` / `instruction` / `metadataOnly`，见 `studioModelCatalog.ts:86` 的 `STEPFUN_TTS_PARAMS`）。

---

## 4. 阶段 0：平台级 StepFun 通道（前置，必做）

> 目标：所有用户默认可用 `voice/design/music`，且**失败可判读**（不是「点了必死」）。

### 4.1 凭证接入（env，非 DB）

按既有平台凭证模式（`packages/shared/src/platformCredentials.ts`）四处改动：

1. `PlatformCredentialEnv` 增 `stepfunApiKey?` / `stepfunBaseUrl?`
2. `readPlatformCredentialEnv()` 增 `STEPFUN_API_KEY` / `STEPFUN_BASE_URL`（缺省 base `https://api.stepfun.com/v1`）
3. 新增 `resolveStepFunPlatformCredentials(modelName, env)`：以 `/^step/i` 匹配（`step-tts-mini` / `stepaudio-3-*` 均命中，与 `/h3-max/i`、`/^minimax-h3$/i` 无重叠）
4. `provider-resolver.service.ts` 的 `else if` 链挂载（置于 fal / minimax 之后，不影响既有分支）

密钥落点：`/opt/lnkpi/.env` + helm values ⇒ **属「必须先问人」红线（AGENTS.md 角色边界 #4）**。
✅ 已于 2026-10-06 由用户提供并授权注入（PR #239）：单一来源 = GitHub Secret `STEPFUN_API_KEY`，
由 `deploy.yml` 的 `Inject platform provider keys into CVM .env` 步骤幂等 upsert 进 `/opt/lnkpi/.env`。
⚠️ 因此本项**不要再按「手工在 CVM 上改一次」处理**——Sync 步骤会备份并还原 `.env`，
只手工改会在换机/首次部署时静默丢失，且无任何报错。

### 4.2 模型登记

`STUDIO_MODEL_CATALOG` 新增条目（`audio` 模态 + `audioKind`）：

| modelKey | gatewayModelId | audioKind | 参数处置要点 |
|---|---|---|---|
| `stepaudio-3-gen-preview` | 同名 | `design` | `roles[]`(≤500 字) + `scripts[]`(≤1000 字, `()`语气 `[]`音效) + `instruction`；同步返音频 |
| `stepaudio-3-music-preview` | 同名 | `music` | `caption` / `lyrics` / `instrumental` / `temperature` / `top_k`；**字段名是 `model_id` 不是 `model`** |

同时给既有 4 条补 `audioKind: 'voice'`。

⚠️ 登记后需触发一次平台渠道 models 同步（`pullModels` 路径会调 `catalogModels()`），否则平台下拉仍是旧列表。

### 4.3 第二处入口必须一并覆盖

`studio.service.ts:2615` 的降级重放路径直接用 `createAudioProvider(undefined)`，只认 `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_TTS_MODEL`。若只改 resolver，**降级时会把 step 模型名发到 OpenAI 默认端点** —— 典型静默错路由。
处理方式：让该路径改走 resolver（或至少按 `audioKind` 显式取平台 stepfun 凭证）。**这是本阶段的验收项，不是可选项。**

### 4.4 平台 key 带来的新风险与守卫（必须一起做）

| 风险 | 守卫 |
|---|---|
| 单 key 共享 ⇒ 单个用户/会话打爆配额，全体不可用 | per-user 限流 + 复用积分作闸门（D4 的 15 分对 music 有实际抑制） |
| 余额耗尽（仓库既有记录：StepFun 平台侧曾实测 **402 余额不足**） | 启动探针 + 402 时**显式**返回「平台音频额度不足」而非泛化失败；`deploy/stepfun-tts-live-probe.mjs` 已有可复用探针 |
| 限免到期后平台自付成本 | 定价/开关集中在一处 env，可一键降级为「仅 BYOK 可用」 |
| `-preview` 模型 ID 退役 | 不可用 → 显式提示（U6③ 的 `selectableAudioModels` 机制），禁静默回退到默认 TTS |

### 4.5 阶段 0 验收判据

1. 平台渠道下拉出现 2 条新模型，且**归到正确 kind**（不是平铺进 audio 桶）。
2. 未配置任何 BYOK 渠道的新用户，`selectableAudioModels` 默认含这三类。
3. 平台 key 缺失/402 时，生成返回**可判读的错误文案**（非通用 500、非静默回退到 OpenAI TTS）。
4. 降级重放路径用 step 模型时**不再**打到 OpenAI 端点。

---

## 5. 阶段 1：综合音频（`design`）

- **端点**：`POST {baseUrl}/audio/generate`（同步返音频二进制/SSE），OpenAI 兼容链路之外需新增一个调用形态（现有 `audio-provider` 只认 `/audio/speech`）。
- **参数域**：`roles[]`（角色→音色）+ `scripts[]`（可含 `()` 语气、`[]` 音效）+ `instruction`（整体演绎指导）+ `response_format`。
- **UI**：独立参数表单（角色表 + 脚本段），与 `voice` 的参数区**互斥显示**。
- **产物**：同步音频需复用现有 `upload.saveUserFile` 转存（`studio.service.ts:2300+` 已有 TTS 的 data-url 转存先例）。
- **积分**：5 分（D4），沿用同一 `points.consume` 链路。
- **验收**：节点切到「综合音频」→ 填 2 角色 + 1 音效 → 生成出可播放音频；`voice` 分类行为与今日逐字节一致。

---

## 6. 阶段 2：音乐（`music`）

- **异步**：`POST /audio/music/submit` → 轮询 `/audio/music/query`（实测约 70s，官方 1–3 分钟）。
- **超时**：`TOOL_TIMEOUT_OVERRIDES` 为 `/agent/internal/run-audio-generation` 增设按 kind 的超时（或拆独立路径），参考 video 的 690s 模式。**210s 不够**。
- **产物**：实测 2.2MB mp3 ⇒ **必须对象存储转存**，不得沿用内联 base64 data URL。
- **前端**：参考视频既有形态 —— `POST /studio/video/start` + 状态轮询（`studio-api.ts` 同类方法），音乐走同级「start + status」。
- **积分**：15 分（D4）。
- **失败判读**：music 终态 `FAILED` 时 **HTTP 仍可能 200** ⇒ 必须读任务状态字段，不能只看 HTTP 码。
- **验收**：生成 30 秒以上可播放音频；超时/失败有明确文案；产物落在对象存储且画布可回放。

---

## 7. 阶段 3：agent 自主选择 + 治理同步

1. **让 agent 看得见分类**（当前缺的一环）：`list_model_options` 返回的音频模型必须带 `audioKind`，否则模型只能猜名字 ⇒ 做不到「自主选择分类」。
2. **工具签名**（D3）：`run_audio_generation(node_id, kind?, roles?, scripts?, instruction?, caption?, lyrics?, instrumental?, …)`；新增参数**一律追加到末尾**（`streamConversation` 式位置参数风险，见工程纪律），并保持 HITL 门禁（`src/gate/generation-gate.ts`）不变。
3. **规则 23 改写**：从「只做配音/朗读，不做 BGM/音效/配乐」改为按 `kind` 描述三类能力与各自边界。⚠️ **L6 余量仅 124 字符** ⇒ 等量改写，不得新增长句；改完必跑 `pnpm prompt:lint`。
4. **skills 同步**：`skills/drama-audio-design` 的「不支持 BGM/音效」声明必须改，否则模型按旧认知拒绝用户。
5. **工具分层**：`run_audio_generation` 维持常驻（已被规则/skill 点名）；若新增独立工具，须先回答「哪个资产按名字点名了它」，并在 `services/pi-runtime/src/tools/tiering.test.ts` 锁归属。
6. **验收**：给模型一句「给这条分镜配个紧张感的背景音乐」→ 自动选 `music`、填 caption、直接产出；不走错分类、不静默失败。

---

## 8. 不变量

- `voice` 分类的**端到端行为逐字节不变**（含参数、扣分、返回形态）。
- 顶层节点类型不新增；图/文/音/视频 四个入口不变。
- HITL（propose → 用户确认 → run）与积分/退款链路对三类一视同仁。
- 「不可用」必须**显式可判读**，任何路径禁止静默回退到别的模型/端点。

---

## 9. 待确认项（默认值已给，可否决）

| # | 事项 | 默认 |
|---|---|---|
| C1 | 平台侧登记哪些 step 模型 | 仅本期三类所需的 3 条（`stepaudio-3-tts` / `-gen-preview` / `-music-preview`）。realtime、ASR **不登记** |
| C2 | 平台 key 与用户 BYOK 同名模型冲突时的优先级 | **以用户选择为准**（`modelValue` 里编了 `channelId`，天然分离；不做隐式覆盖） |
| C3 | per-user 限额粒度 | 只靠积分闸门 + 单会话并发 1，不做独立日额度（后续按用量再定） |
| C4 | CVM 上注入 `STEPFUN_API_KEY` 的时机 | ✅ **已执行（2026-10-06，PR #239）**：GitHub Secret + `deploy.yml` 注入步骤（非手工）。生产 `/opt/lnkpi/.env` 已注入并核验（1 行、600、变量名集合只多出该项）；合并 #239 触发的部署会再幂等写一次 |
