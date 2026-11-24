# VoiceStudio P1+P2 落地规格（拍板后）

> 上游评估：`docs/superpowers/specs/2026-11-24-voicestudio-integration-feasibility-review.md`（可行性判定与协议比对，不重复）
> 拍板（2026-11-24）：① CVM 部署 + 充分吃满能力面；② 克隆首期开放（合规三件套）；③ P3 后置独立立项
> 本规格覆盖：CVM 部署规格、P1/P2 详细设计、PR 切分与 DoD。性质：实施规格（待按七步流程逐 PR 落地）

---

## 0. 范围声明与「充分吃满」的口径

- **吃**：VoiceStudio **headless 服务面**（REST `/v1/*` + MCP `/mcp/` + 模型管理/水印/SFX 路由）的全部产品相关能力。
- **不吃**：Electron/Tauri/mobile/CLI UI 层、telephony_twilio、store/packaging。
- 「吃满」≠ 一个大 PR：**全景盘点入册（§2）+ 切片顺序落地（§7）**。每片独立 CI、独立部署、独立回退。
- 硬件与代码解耦：P1/P2 代码不依赖 CVM 扩容完成；VS 实例地址是 env 配置。未扩容前不在 CVM 常驻引擎，spike 在本机做。

## 1. 等价物检索结论（P1/P2 逐项，第一原则合规）

| 需求 | 等价物 | 结论 |
|---|---|---|
| MCP 客户端 | vendor `@earendil-works/pi-mcp`（**npm 存在 0.99.2**，已核实 `npm view`；与 pi-runtime 在用的 `pi-agent-core@0.99.2`/`pi-ai@0.99.2` 同源同版） | ✅ 精确 pin `0.99.2`，禁自研、禁用 npm `latest`（1.6.0 是 v1.x 线，API 已分叉） |
| OpenAI TTS 客户端 | `packages/agent` `OpenAITTSProvider` | ✅ 复用，仅加字段映射 |
| 音色枚举 | VS `GET /v1/audio/voices` | ✅ 运行时拉取，禁手抄表 |
| ASR | VS `/v1/audio/transcriptions`、MCP `transcribe` | ✅ 接线 |
| 克隆/音色设计 | MCP `clone_voice`/`describe_voice`/`design_voice` | ✅ 接线 |
| 模型预装 | VS `POST /models/install` + `/setup/download-stream` SSE | ✅ 进 runbook |
| 音频落盘/管线/退款/SSOT | Nest `start-audio-generation` detached 管线（P1-B job 化） | ✅ 全复用，零改动 |
| 探活 | VS `GET /health` | ✅ |

## 2. 能力面吃满盘点表（拍板①响应）

| VS 能力 | 服务面接口 | pi-lnk 消费点 | 切片 |
|---|---|---|---|
| TTS 多引擎（omnivoice/CosyVoice/IndexTTS/…） | `POST /v1/audio/speech`（model 字段选引擎） | studioModelCatalog 新模型行 + `voicestudio-http` binding | **P1** |
| 音色/性格/语言枚举 | `GET /v1/audio/voices`；MCP `list_voices/list_personalities/list_languages` | dock 音色下拉运行时同步 | **P1**（REST）/ P2（MCP） |
| 健康探活 | `GET /health`；MCP `check_health` | 云/本地双通道回退判断 | **P1** |
| ASR 转写/翻译（WhisperX 等，646 语言） | `/v1/audio/transcriptions|translations`；MCP `transcribe` | 新 LnkpiTool `transcribe`（QC/字幕/听写入口） | **P2** |
| 音色克隆 | MCP `clone_voice`（base64 参考音频 → profile_id） | 新 LnkpiTool + voice 资产（§6 合规三件套） | **P2** |
| 音色设计 | MCP `describe_voice`/`design_voice` | 新 LnkpiTool（角色 bible → 音色 profile） | **P2** |
| AI 水印 | `/watermark` 路由 | 克隆合规配套（默认开） | **P2** |
| SFX 音效（moss_sfx 引擎） | `/sfx` 路由 | drama-audio-design `design` kind 的音效本地兜底 | **P2.5 评估**（引擎内存足迹定接不接） |
| 人声分离/说话人分离 | media_tools 路由 | 参考素材处理 | 入册，P3 前按需 |
| 长音频/批量（audiobook/longform/batch） | longform_jobs/batch/audiobook 路由 | 整集长台词批产 | 入册，按需 P3 |
| 视频配音出海 | dub_translate/generate/export | P3 独立立项 | **P3** |
| 模型管理 | `/models/install` + SSE | 部署 runbook（非产品能力） | PR-deploy |
| ❌ UI / telephony / store | — | 不吃 | — |

## 3. CVM 部署规格（PR-deploy）

### 3.1 前置条件（拍板①，用户侧操作 + 运维侧清理）

| 前置 | 动作 | 判据 |
|---|---|---|
| **A 内存扩容** | 4G → **8G 最低 / 16G 推荐**（腾讯云控制台，需停机） | ⏰ **时序调整（2026-11-24 01:37 用户拍板）：推迟到 P1/P2/P3 全部完成后执行**，PR-deploy 与生产部署随之顺延。16G 的理由不变：omnivoice CPU 驻留 ~4-5G + WhisperX 驻留 2-4G + 现有 14 容器 used 3.1G + K3s ⇒ 8G 只够单引擎勉强，**16G 才支撑「多引擎共存」的吃满口径**；且终结 swap 2.7G 换页抖动 |
| **B 磁盘清理** | `docker image prune -a --filter "until=168h"`（可回收 9.4G，跑前 `docker ps` 核对保留集）+ `docker builder prune`（3.5G 可全清）；**⛔ 禁触 containerd overlayfs**（K3s 在跑 Pod 真实 FS） | 清后 `df -h /` 可用 ≥ 18G；看门狗阈值（AVAIL_FAIL_KB=6.3G）不变 |

### 3.2 部署形态

- 镜像：官方 `ghcr.io/debpalash/voicestudio:stable`（AGPL 边界 = 未修改官方镜像；**部署时把 digest 记进 runbook**，升级走审计）
- compose（放 `deploy/voicestudio/`）：`--profile cpu`，数据卷 `omnivoice_data`，端口绑 **`172.17.0.1:3900:3900`**（docker0 网关，仅本机 docker 网络可达，**不暴露公网**）
- env：`OMNIVOICE_API_KEY=<强随机>`；`OMNIVOICE_DEVICE=cpu`；`OMNIVOICE_CPU_GENERATE_TIMEOUT_S=600`；`OMNIVOICE_CPU_POOL=4`；`HF_HOME=/app/omnivoice_data/huggingface`
- **网络路径验证项**（部署时逐条实测）：① `lnkpi-api` 容器 → `172.17.0.1:3900` 可达（同 docker0）② K3s pod（pi-runtime）→ 宿主 3900 可达性（K3s DNAT 特性，见 architecture.md values.yaml 注释）③ 不通则改绑宿主 IP 或 network connect
- 模型预装 runbook：**容器 env 必带 `HF_ENDPOINT=https://hf-mirror.com`**（spike 实测：HF 直连 Errno 99/110 必失败）；`POST /models/install {"repo_id":"k2-fsa/OmniVoice"}` → 盯日志/SSE 到 `install done`（大文件可能分段超时重试后 fallback，耐心等）；首请求防 300s 预算
- **许可证门 runbook**（spike 实测流程）：`GET /models/licenses/acceptance/{repo_id}` 取 fingerprint → `POST /models/licenses/accept`（`{repo_id, fingerprint, accepted:true}`）。**⚠️ 默认引擎 OmniVoice = CC-BY-NC（非商业）**——生产商用部署**必须换商业友好引擎**（候选 CosyVoice3/IndexTTS2.5 等，PR-deploy 前逐个核许可），或 VS 通道仅限内部演示/非商用素材
- **⚠️ 水印依赖缺口（spike 发现）**：CPU 容器内 AudioSeal 加载失败（缺 TorchCodec/FFmpeg 共享库）⇒ `Watermark embedding skipped`——§6 合规三件套的「AI 水印默认开」在当前镜像形态下**不生效**，PR-deploy 前须补依赖验证，否则该合规项降级为「云端水印/产品声明」
- **看门狗联动**：VS 数据目录占用纳入磁盘看门狗登记项；扩容后新增内存告警线
- 回退：`docker compose down` 摘除 + Nest 摘 env ⇒ 全量回云通道，pi-lnk 侧零残留

### 3.3 引擎拍板（2026-11-25，OmniVoice CC-BY-NC 处置——v0.5.8 源码取证）

**拍板：主引擎 = `audiocpp-dots`（dots.tts SOAR Q8_0 + audio.cpp v0.9.4 原生运行时）；不安装 OmniVoice 权重。**

| 维度 | dots.tts SOAR（audiocpp-dots）⭐ | Fun-CosyVoice3-0.5B（cosyvoice） | OmniVoice（原默认） |
|---|---|---|---|
| 许可 | **Apache-2.0 代码+权重，商用明确**（VS models.yaml note + 多源核实） | Apache-2.0 ✅ | **CC-BY-NC ❌**（VS 唯一认真审计过的 TTS=noncommercial） |
| CPU 4 核 | **原生 GGUF Q8_0，audio.cpp 无 PyTorch 开销**（VS 官方 note：「native CPU/Vulkan/CUDA/Metal GGUF」） | ❌ 官方镜像无 cosyvoice Python 包（`is_available()` 判 `import cosyvoice`，v0.5.8 tts_backend.py:3575 实证）⇒ 要自装 GitHub repo+SoX，破坏「官方镜像不修改」边界 | PyTorch CPU RTF≈5-8×（spike 实测） |
| 克隆 | zero-shot（soar checkpoint 克隆相似度最佳）✅ | zero-shot ✅ | zero-shot ✅ |
| 多语 | 24 语（zh/yue/en/ja/ko…） | 10 语 | 600+ |
| 权重大小 | 2.96G | 9.8G | 2.4G |
| 排除/入选理由 | **入选**：许可+算力+VS 内建支持三满足 | 排除：镜像依赖缺口 | **不装**：权重不落盘 = 连 NC 许可门都不用过的最强合规形态 |

**切换机制（pi-lnk 零代码改动，纯 env）**：`active_backend_id()` = `prefs.resolve("tts_backend", env="OMNIVOICE_TTS_BACKEND", default="omnivoice")`（v0.5.8 tts_backend.py:4854）⇒ 容器 env 加 **`OMNIVOICE_TTS_BACKEND=audiocpp-dots`** 后，pi-lnk P1 的 `model='omnivoice'` 请求经 `_resolve_engine`（openai_compat.py:393）透传到 audiocpp-dots——`OmniVoiceBackend.is_available()` 判的是 Python 包（官方镜像内置）恒 True，透传无阻。

**MCP 工具面零影响**：`clone_voice` 仅转发 REST `POST /profiles` 存参考素材（引擎无关，mcp_server.py:877 实证）；引擎绑定发生在合成时（profile 参考音频喂给 active engine 做 zero-shot）⇒ P2 四工具照常。`design_voice`（kind=design profile）在 dots 下无 design 能力，表现待活体验证（预期 VS 层拒绝或 fallback，如实转达）。

**部署序列（比 §3.2 增两步）**：① 模型目录页装 **audio.cpp v0.9.4 prebuilt runtime**（`POST /engines/audiocpp/runtime/install`，**loopback-only** ⇒ `docker exec` 容器内触发）→ ② `POST /models/install {"repo_id":"audio-cpp/audio.cpp-gguf","package":"dots-tts-soar-q8_0"}` 装 dots 权重 → ③ env `OMNIVOICE_TTS_BACKEND=audiocpp-dots` → ④ 冒烟。

**待活体验证项（扩容后冒烟判定）**：① dots Q8_0 在 4 核 CPU 的 RTF（audio.cpp 无官方 CPU 数据，估 0.5-3×，必须实测；超标则标注「非实时批产」）；② Q8_0 音质（量化有损，同 OmniVoice 对照听感）；③ clone→profile→合成闭环在 audiocpp-dots 下走通；④ design_voice 行为；⑤ ASR 引擎许可独立核（faster-whisper 系 unreviewed，逐个补审计）。

### 3.4 水印结论（2026-11-25，任务 13 收口——v0.5.8 源码取证 + spike 复测修正）

- **机制完备**：`mark_synthetic` 是全生产者统一 chokepoint（generation.py:1666 起共享尾部，`context="openai_compat.speech"`——`/v1/audio/speech` 输出也过；EU AI Act Art. 50(2) 合规驱动；test_watermark_route_coverage.py 结构性断言所有合成调用点引用它）。默认开：`resolve("watermark.invisible", default=True)`。AudioSeal 在**主依赖**（pyproject.toml:116 `audioseal>=0.1.3`，MIT，CPU ~5ms/段）。
- **缺口实态（spike 复测修正，比原判轻）**：AudioSeal **import 可用**（`audioseal_available:true`；原判「缺 TorchCodec/FFmpeg 共享库」不成立）——真缺口 = **checkpoint 未缓存 + 容器内 HF 直连失败**（checkpoint URL 硬编码 huggingface.co 绕过 HF_ENDPOINT，`_KNOWN_CHECKPOINTS` watermark.py:79）。缺失时 embed 静默降级（合成照常、无水印直通，600s 冷却内不重试）。
- **修复（进 runbook §4）**：容器内经 hf-mirror.com 预下载 generator/detector_base.pth（torch.hub sha1 文件名，`~/.cache/audioseal/`）→ `GET /watermark/status` 判 `audioseal_available:true`。spike 复测：本地张量 embed→detect 闭环 confidence 1.0；generator prefetch 成功日志实证。
- **冷却窗口知识**：embed 失败后 600s 内静默跳过——冒烟若 detect 判负且日志已有 `AudioSeal generator loaded`，重启容器或等 10min 重跑探针；checkpoint 就位后首请求即成功，生产无常态冷却窗口。
- **验证判据两步**：`GET /watermark/status` available:true + 探针 `POST /watermark/detect` confidence 达标。**缺一即合规 #2 未闭环**（伪绿纪律）。
- 边界声明：detect API 是自证（VS 内部 16-bit message），对外水印证据仍以产品文案声明（PR3 已落）+ 台账为主。

## 4. P1 规格：TTS 直连 + 音色同步 + 探活回退（apps/server，1 PR）

### 4.1 改动面

| 点 | 设计 |
|---|---|
| studioModelCatalog | 新增 `{ modelKey:'voicestudio-local', displayName:'VoiceStudio 本地引擎', modality:'audio', audioKind:'voice', providerBinding:'voicestudio-http', params: AUDIO_PARAMS, voices:[], defaults:{ speed:1.0 } }` —— voices 运行时同步，不手抄 |
| provider 构造 | `createAudioProvider` 调用点按 binding 分支：`voicestudio-http` ⇒ `OpenAITTSProvider(env.OMNIVOICE_API_KEY, env.OMNIVOICE_BASE_URL, 'omnivoice')`（baseUrl 含 `/v1`） |
| 字段映射（audio-provider 扩展） | `instruction`→`instructions`；`emotion` 四档→拼接进 `instructions` 文本（如 `emotion=happy` ⇒ instructions 前缀「欢快地」）；`volume/pitch` **不发送**（VS 静默忽略，行为与现状一致，文档声明）；`speed` 直通 |
| 音色同步 | Nest 定时（复用既有拉取模式）`GET /v1/audio/voices` → 缓存 → dock 下拉合并展示（来源标记「本地」）；拉取失败保底云音色表，不阻塞 |
| 探活回退 | 生成前 `GET {base}/health`（5s 超时，带缓存 60s）：不可用 ⇒ **显式报错**「本地引擎不可用，可切换云端模型（Seed/MiniMax/StepFun）」，**禁静默换道**（soundhelix 教训 + 伪绿纪律） |
| **env 未配置 ⇒ 模型不注册** ⭐ | `OMNIVOICE_BASE_URL`/`OMNIVOICE_API_KEY` 任一缺失 ⇒ `voicestudio-local` 行**不下发**（目录按 env 条件注册）——P1 合入 prod 后**零用户可见影响**（CVM 未部署/未扩容阶段），配 env 即自动启用。开发/验证期在本机 Docker 起 VS 实例配 env |
| 失败契约 | 沿用 audio-provider 2026-10-04 契约：失败冒泡到 studio.service catch ⇒ 退款 + failed 状态，禁占位音频 |

### 4.2 明确不做的

- 不动 prompt 规则（模型目录是数据不是 prompt，**不触发 L6 预算与 6 处同步**）；不动 run_audio_generation 工具签名；不新增审批面（audio 已在用户级自动放行 tier）。
- ASR 不进 P1（与 MCP `transcribe` 一起在 P2 接，避免 REST/MCP 双通道重复）。

### 4.3 DoD

1. dock 模型选择卡出现「VoiceStudio 本地引擎」，音色下拉来自运行时同步；
2. 选该模型生成 → 音频落节点 SSOT、可播、结算行正确；
3. VS 停机时：该模型显式报错 + 云模型链路不受影响（对照实验两个会话）；
4. 单测：字段映射逐条、切分（inputLimit 4096）、探活超时、失败显式报错；
5. `vue-tsc -b` 过（若动 dock 类型）。

## 5. P2 规格：MCP 桥 + 克隆/设计/转写工具（services/pi-runtime，1 PR）

### 5.1 依赖与连接

- `package.json` 增 `"@earendil-works/pi-mcp": "0.99.2"`（精确 pin，理由见 §1）。
- `StreamableHttpTransport({ url: env.OMNIVOICE_MCP_URL /* http://<host>:3900/mcp/ */, headers: { Authorization: `Bearer ${env.OMNIVOICE_API_KEY}` } })` —— **鉴权已在 spike 实测确认**：Streamable HTTP 握手 + Bearer key 200，九工具全数在列（`backend/core/auth.py` 确认 Bearer 为 master key 通道）。
- 包装配方照 vendor README（`name: mcp_*` 清洗、`parameters: Type.Unsafe(...)`、`toLlmContent`），外面包一层转成 `LnkpiTool`（补 `tier`/中文 label/description/呈现纪律）。

### 5.2 新工具（全部进**延迟集**，skill 点名走 `load_skill` 通道）

| 工具 | 入参 | 出参 | 备注 |
|---|---|---|---|
| `clone_voice` | `referenceAssetId`（pi-lnk uploads 资产 id，Nest 解析 base64）+ `name` | `profile_id` | **禁 URL/外部路径**（§6）；profile_id 由 agent 写入节点 voice 参数供 `run_audio_generation` 使用 |
| `design_voice` | 文本描述（性别/年龄/音高/风格/口音） | `profile_id` | 描述映射不到属性时 VS 会拒绝——如实转达 |
| `transcribe` | `audioNodeId` 或 `uploadId` | 文本 | QC/字幕/听写的入口 |
| `list_voices` | — | 枚举 | 辅助选声线（P1 REST 已有，MCP 侧保留给 agent 主动查询） |

- **MCP 输出模式用默认 `resources`（base64/JSON）**，不启用 files 模式：VS 在宿主 docker、pi-runtime 在 K3s pod，文件系统不同 namespace，`OMNIVOICE_MCP_BASE_PATH` 共享挂载引入跨 namespace 坑；而本桥真正调用的工具（clone/design/transcribe/list）**产物都是 profile_id 或文本，无音频字节**——`generate_speech` 走 P1 REST 既有落盘管线，不重复接。
- 参考音频 base64 由 Nest 解析资产后经 MCP 下发（MCP 客户端在 pi-runtime，资产读取走 Nest 转发：**实现落点 = pi-runtime 工具 execute 内调 Nest 端点取 base64**，与 P1 工具转发模式一致）。

### 5.3 tiering 与技能

- `ALWAYS_ON_TOOL_NAMES` **不动**；四工具进延迟集；`drama-audio-design` 升 **v0.3**：SKILL.md 增「克隆/设计声线」「转写回读 QC」两节并点名新工具（SKILL 点名 = 按需加载后可见，不触发「规则 × 延迟集」违规）。
- `scripts/verify-tool-tiering.ts` 扫描 + capability-catalog 台账 +4 行（「谁点名」列 = drama-audio-design v0.3）。
- 审批：新工具归 audio 用户级自动放行 tier —— 核对 `resolveAutoApproveTier` 的映射点，若按工具名/分类注册需登记。

### 5.5 实施回填（PR2，2026-11-24——三处规格认知修正，以实现为准）

1. **skill 点名方式修正（§5.3 原文有误）**：`verify-tool-tiering` 的 A1 红线把 `skills/**/*.md` 全文纳入扫描——**skill 点名延迟集工具 = 违规**（模型读完 SKILL.md 直调，吃 vendor "Tool X is unavailable"，与 prompt 规则点名同性质）。正解按 tiering.ts 2026-10-06 R1 先例：**SKILL.md v0.3 两节写「能力描述 + tool_search 搜索话术」，全文不出现四工具名字面量**（搜索关键词「音色」命中克隆/设计/列表的中文 label，「转写」命中转写）。已实测门禁通过。
2. **clone_voice 入参修正（§5.2 原文 referenceAssetId 不存在对应实体）**：pi-lnk 资产标识的实际形态是 **uploads 引用 URL**（`/api/uploads/<userId>/<fileName>`，侧栏音频附件标记 `A{n}` 行内含 `url=` 字段）。入参落为 `url`（uploads 引用），合规 #1「限自有参考音频」由 Nest 侧形态匹配 enforcement（`parseUploadRefPath` + 外部 URL 一律拒绝，与 read-media 同机制）；`transcribe` 入参 `node_id`（经画布 SSOT 解析 `node.data.url`）或 `url` 二选一。
3. **审批面核对结论（§5.3 第三条）**：`resolveAutoApproveTier` 不存在于代码；现实审批映射点是 `isAutoApproveMediaType` + `GENERATION_AUTO_APPROVE` env（介质类型维度，只作用于 start-audio-generation 链路）。四工具不创建生成任务（产物 = profile_id / 文本），**不进任何审批面，无需登记**；tier=gen 仅使 plan pending 期随 gen 族收缩（语义正确），generation-gate 按 run_* 工具名集合拦截、四件不在集合。
4. **profile 命名规范提前落地（§6#3 提前量）**：`lnk-<userId8>-<name>` 在 pi-runtime `buildVoiceProfileName` 实现（userId 取 toolContext，缺失回退 nosession；name 清洗空白/非法字符/截 40）；PR3 只剩 Nest 侧 voice 资产表（source/refAssetId/时间）。
5. **profile_id → 生成通路确认**：VS OpenAI 兼容层 `/v1/audio/speech` 的 `voice` 参数按**精确 profile id** 解析（`_resolve_voice_profile`，v0.5.8 openai_compat.py:198）⇒ P1 的 OpenAITTSProvider 零改动直通；「克隆 → profile_id 落节点 voice → run_audio_generation 出声」闭环成立。
6. **VS 工具失败契约**：MCP 工具失败不抛协议错误，返回 `{error}` JSON（isError 不置位）——包装层 `extractMcpJson` 统一解析并显式报错；连接类错误（连接关闭/会话过期）销毁旧连接重连一次，仍败显式报「本地声纹引擎不可达 + 可切云端」文案。

### 5.4 DoD

1. 四工具在 `tool_search` 可搜到、`load_skill` 后可调；
2. 克隆→生成闭环：上传参考音频 → `clone_voice` → profile_id 落节点 voice → `run_audio_generation` 用该音色出声；
3. `transcribe` 中文短音频返回正确文本；
4. 「延迟集 ∩ 被点名 = ∅」扫描 0 命中；
5. VS 停机时四工具显式报错，不影响画布其余工具；
6. SSE 工具事件面无参数泄漏（既有契约不破坏）。

## 6. 克隆合规三件套（拍板②）

| # | 机制 | 落点 |
|---|---|---|
| 1 | **限自有参考音频**：`clone_voice` 只收 pi-lnk uploads 资产 id（用户自己上传的），禁外部 URL/路径；上传入口加「确认拥有该声音权利」声明 | pi-runtime 工具入参设计（§5.2）+ 上传 UI 文案 |
| 2 | **AI 水印默认开**：VS 内建水印能力随部署开启；产品文案声明克隆音频带 AI 标识 | PR-deploy env + 文案 |
| 3 | **profile 来源标记**：pi-lnk voice 资产记录 `source:'cloned'` + `refAssetId` + 时间；VS 侧 profile 命名规范 `lnk-<userId8>-<name>`（可审计、可清理） | P2 Nest 侧资产表 |
| 4 | 用户协议补「声音克隆授权」条款 | 产品侧 TODO（不阻塞 PR） |

## 7. PR 切分与顺序（每 PR 独立走七步流程）

| 顺序 | PR | 内容 | 前置 |
|---|---|---|---|
| 1 | **P0 spike**（不进仓） | 本机 compose cpu 起 → 预装模型 → `/v1/audio/speech` 中文短句 RTF/音质 → MCP 鉴权 header 实测 → 字段映射实测 → 4 核 RTF 对 CVM 的可参考性结论；产出数字回填评估报告 §4.3 | 无 |
| 2 | **PR1 = P1** | §4 全部（catalog/binding/映射/音色同步/探活回退/env 条件注册 + 测试；开发期用本机 VS 实例联调） | P0 spike 通过 |
| 3 | **PR2 = P2** | §5 全部（MCP 桥/四工具/tiering/skill v0.3） | PR1 合并（voice 资产模型先落） |
| 4 | **PR3 = 合规收口** | §6 三件套（若体量小并入 PR2） | PR2 |
| 5 | **P3 立项** | dub 出海独立 spec（用户拍板：P1/P2 完成后独立立项） | PR2/PR3 |
| 6 | **内存扩容 + PR-deploy** | 前置 A（⏰ 已推迟到此刻）+ B → §3 compose/runbook 部署生产 CVM + 模型预装 | P3 完成后 |
| 7 | 生产复测 | prod-deploy-verify 全套 + 生产 CDP 行为取证（克隆→生成闭环在真实画布走一遍） | PR-deploy 后 |

P3（dub 出海）：P1/P2 全部闭环后独立立项，另立 spec。

## 8. 增量风险

| # | 风险 | 对策 |
|---|---|---|
| 1 | CVM 4 核 RTF 过慢（短句 >30s） | P0 spike 定阈值；超标则该模型标注「非实时批产」场景，实时走云 |
| 2 | 扩容前误部署击穿 swap | PR-deploy DoD 加硬检查：`free -h` available ≥ 6G 才允许起容器 |
| 3 | `:stable` 镜像漂移 | runbook 记 digest；升级走审计 |
| 4 | MCP 鉴权 header 未定 | P0 spike 确认项（§5.1） |
| 5 | 弱模型直调延迟工具 | 台账纪律 + `load_skill` 通道（§5.3） |
| 6 | VS 与云 TTS 音色 id 冲突（同名） | 音色下拉按模型维度隔离展示（目录 voices 字段本来就按模型行组织） |

## 9. PR3 实施回填（2026-11-24，合规收口）

### 9.1 交付面（PR3 = feat/voicestudio-p3-compliance）

| 层 | 内容 |
|---|---|
| **Prisma** | 新模型 `VoiceProfileRecord`（userId/profileId/profileName/displayName/source/refUrl/createdAt；`@@unique([userId,profileId])` 幂等 upsert 不堆行）+ 迁移 `20261124160000_voice_profile_record`（容器 entrypoint 自动 migrate deploy） |
| **Nest** | `agent/voice-profile-registry.ts`：登记纯函数（source ∈ cloned\|designed 校验；**cloned 必填 refUrl 且 uploads 形态校验**——防御纵深：链路绕行也进不了台账；designed 带 refUrl 拒登防脏数据）+ `POST /agent/internal/voice-profiles`（agent-internal.guard 保护，与 read-audio 同 controller） |
| **pi-runtime** | `registerVoiceProfileToNest`：clone_voice / design_voice 成功后 upsert 登记；失败 ⇒ `ok:true + registered:false + warning`（profile 已在 VS 创建是既成事实，报 ok:false 会误导 agent「克隆失败」，静默又违纪律——warning 是唯一不谎报也不哑报的形态；文案明示「勿对外交付成品 + 联系管理员补登」）。**合规 #3 收口修正：design_voice 也走 `buildVoiceProfileName`（lnk-<userId8>-<name>）**——P2 遗漏（P2 仅 clone 走），生产 env 未启用零存量无迁移负担 |
| **web 权利声明** | `voiceRightsConsent.ts`（`confirmVoiceRightsIfNeeded`：audio 文件弹「声音素材权利确认」，文案含授权确认 + **AI 合成标识声明**=合规#2 文案落点；每次弹不记忆跳过——合规最强形态）。**五个上传入口全收口**：① useNodeMediaUpload.applyFile（节点上传+拖拽）② CanvasAssetPanel（资产库）③ useAgentComposer.addFiles（**侧栏 A{n}——克隆参考主来源**）④ CanvasPage.ingestMediaFile（画布拖拽/粘贴导入）⑤ handleDockFileDrop（dock 拖放）。侧栏/dock 的 image accept 面板无需接入 |

### 9.2 设计要点与教训

- **登记失败的形态学**：Nest 不可达时克隆必先失败（resolveAudioBase64 同链路），登记失败=异常网络态；但 profile 已创建不可谎报——`registered:false + warning` 双字段如实呈现。
- **VS 重名非幂等**（clone_voice duplicate name 报错，v0.5.8 mcp_server.py:930 实证）⇒ warning 文案禁写「重试幂等」，改为「管理员补登」。
- **权利声明每次弹**（不 localStorage 记忆）：音频上传低频手动动作，合规最强形态优先于省一次点击；设置页条款复查留产品 TODO（合规 #4 用户协议不阻塞）。
- **上传入口枚举法**：以 `fileToPersistedPayload` 调用方穷举（5 文件）防遗漏——单点接 composable 会漏掉侧栏/dock/画布导入三条独立路径。

### 9.3 验证

- pi-runtime **2109/2109**（+3：clone 登记留痕 / 登记失败 warning / design_voice lnk- 命名+登记）；registry **9/9**；web 权利确认 **8/8**
- 合规三件套最终状态：#1 enforcement（read-audio uploads 形态）✓ + 上传 UI 声明 ✓；#2 AI 标识 = 声明文案 ✓ + VS 侧水印待 PR-deploy 补依赖；#3 台账表 + lnk- 命名统一覆盖 cloned/designed ✓；#4 用户协议条款 = 产品侧 TODO
