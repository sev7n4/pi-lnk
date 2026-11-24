# P3 立项：视频配音出海（VoiceStudio dub 管线 × pi-lnk）——立项章程

> 性质：立项章程（charter），非实施规格。批准后另出实施 spec 走七步流程。
> 上游锚：`docs/superpowers/specs/2026-11-24-voicestudio-p1p2-implementation-spec.md` §2/§3.3；
> `docs/superpowers/specs/2026-11-24-voicestudio-integration-feasibility-review.md` §6。
> 立项依据（用户拍板 2026-11-24）：③ P3 dub 在 P1/P2 完成后独立立项。
> 日期：2026-11-25

## 0. 一句话定位

**画布视频节点的「配音出海」动作**：用户选中已生成/已上传的视频节点，选目标语言，
pi-lnk 驱动 VoiceStudio dub 管线完成「台词提取 → 本地翻译 → 分段配音（可克隆原声线）→ 混音 → 导出 mp4+srt」，
产物落回画布 SSOT，全程不经云端翻译/配音服务。

## 1. 为什么立项（价值锚）

1. **drama 线的自然延伸**：pi-lnk 的分镜/短剧生产已闭环（视频生成/音频生成/音频管线），出海多语化是同一内容资产的最大化复用；
2. **对冲云服务双墙**：agnes 429 实名墙（LLM）+ 云 TTS 按字符计费——dub 的翻译与语音都走本地引擎，成本恒定；
3. **VS 能力面已吃满盘点**（spec §2 入册项）：dub 是 P2 之后能力面剩余的最大价值块；
4. **合规基础设施已建**：P3 合规收口的台账（VoiceProfileRecord）+ 权利声明 + AI 标识文案，dub 直接复用。

## 2. VS v0.5.8 dub 能力面（源码取证）

| 层 | 文件 | 要点 |
|---|---|---|
| 翻译 | `backend/api/routers/dub_translate.py`（70KB） | **NLLB-200 本地翻译**（facebook/nllb-200-distilled-600M，2.4G 权重）+ 方言子句（dialect_clause）+ 目标语校验 + 脚本比例检测 |
| 生成 | `backend/api/routers/dub_generate.py` | 分段配音 + **speaker clone 复用**（与 P2 桥同一 profile 体系）+ 分段缓存（seg cache）+ OOM 重试 + ref_audio 缺失警告 |
| 导出 | `backend/api/routers/dub_export.py` | SSE 任务流（/tasks/stream）+ job 管理 + **mp4+srt 产物**（tracks 端点） |
| 支撑 | `dub_core` / services: `dub_background/batching/language/mix` | 后台任务、批量分段、语言映射、混音 |
| demo | `backend/assets/samples/demo/dubbing/` | es/fr/ja/zh 四语完整样例（mp4+wav+srt） |

任务形态：**长任务管线**（分钟级），SSE 进度流——与 P1 的短请求 TTS、P2 的四工具都不同形态。

## 3. 等价物检索（第一原则合规，立项前置）

| 需求 | pi-lnk 既有 | VS 提供 | 结论 |
|---|---|---|---|
| 视频台词/音轨提取 | ❌ 无 | VS media_tools / dub 管线内置 | 接线 |
| 本地翻译 | ❌ 全仓无翻译能力（agnes 走云端） | NLLB-200 本地 | 接线；**许可风险见 §6** |
| 多语分段配音 | ❌ 无 | dub_generate + P2 speaker clone 体系复用 | 接线（P2 profile 直接喂 dub） |
| 长任务编排 | ✅ Nest detached 管线（start-audio-generation 模式）+ SSE 时间线（#975） | VS job/SSE | **复用 pi-lnk 既有管线模式**，不新造 |
| 字幕（srt） | ❌ 无 | dub 导出 srt | 接线 |
| 视频节点 SSOT | ✅ 画布 video 节点 + 媒体上传面 | — | 产物落节点，零新造 |

**结论：零自研翻译/配音/字幕引擎；全部接线。pi-lnk 侧新增面 = 一个 Nest dub 管线 + 一个画布动作 + SSE 呈现。**

## 4. 产品形态草案（拍板后细化）

- 入口：视频节点选中 → 画布动作「配音出海」（或 agent 对话「把这个视频配成日语版」）；
- 参数：目标语言（demo 已证 es/fr/ja/zh；全集以 VS language 表为准）+ 是否克隆原声线（clone profile）+ 方言（VS dialect_clause 支持）；
- 进度：复用 #975 SSE 时间线（分段进度：翻译→配音→混音→导出）；
- 产物：新视频节点（dubbed mp4）+ 字幕节点（srt）+ 台账（来源/语言/引擎记录）；
- 计费：本地引擎 = 无按字符成本；是否向用户收费/额度由产品拍板（不在本章程）。

## 5. 技术接缝设计（草案，实施 spec 细化）

| 决策点 | 倾向 | 理由 |
|---|---|---|
| 通道 | **Nest 直连 VS REST**（不经 pi-runtime MCP） | dub 是长任务 + 大文件（mp4），MCP base64 契约不适配；Nest 管线模式（start-audio-generation 同款）天然匹配 SSE job |
| 鉴权 | 复用 OMNIVOICE_API_KEY 三方同钥 | P1 部署已定 |
| 任务状态 | Nest 侧 dub job 表（或复用 audio generation job 结构） | 退款/失败契约同族 |
| 引擎 | dub 语音合成走 active engine（audiocpp-dots） | §3.3 拍板；dub 的 speaker clone 对 dots zero-shot 的适配待 P3.1 验证 |

## 6. 合规与许可（立项级风险清单）

| # | 风险 | 状态 | 对策 |
|---|---|---|---|
| 1 | **NLLB-200 翻译模型 = CC-BY-NC**（VS model_licenses.json 明示 noncommercial） | ⚠️ 与 TTS 引擎同权重级风险 | P3.1 前拍板：a) 限非商用内容 b) 换云端翻译 API（成本回到按字符）c) 逐字核 NLLB 输出物许可（翻译结果是否受权重许可约束存疑，需法务意见） |
| 2 | 原视频素材权利 | P3 合规三件套可复用 | 上传声明扩展到视频（voiceRightsConsent 模式） |
| 3 | 克隆声线的多语化授权 | 台账已建 | dub 使用 clone profile 的记录并入 VoiceProfileRecord（source 标记扩语种） |
| 4 | AI 标识 | 水印 chokepoint 覆盖所有合成出口 | dub 产物 mp4 的音频轨带 AudioSeal；文案声明复用 |
| 5 | 目标市场法规（出海地区 AI 内容法） | 未评估 | P3.1 出目标市场清单后逐个核（EU AI Act Art.50 已由 VS 水印覆盖） |

## 7. 里程碑草案（每步独立走流程）

| 阶段 | 内容 | DoD 骨架 |
|---|---|---|
| **P3.1 spike/评估**（本机 Docker，不占 CVM） | dub 全流程拉通（zh→ja 样例）：翻译质量/克隆适配/时长/内存足迹 + NLLB 许可拍板 | 全流程样例产物 + 评估报告 + 许可拍板记录 |
| **P3.2 Nest dub 管线** | VS REST 接线 + job 表 + SSE | 单测 + 活体样例 + 退款契约 |
| **P3.3 画布 UX + agent 工具** | 视频节点动作 + SSE 呈现 + 权利声明扩展 | 真实路径取证 |
| **P3.4 合规收口 + 生产** | 台账扩展 + 水印验证 + CVM 实测（依赖扩容后资源面） | 冒烟 + 生产 CDP 取证 |

**依赖**：CVM 扩容后资源面（dub 生成阶段内存足迹 P3.1 实测，预估与 TTS 同级 + NLLB 2.4G 峰值）。

## 8. 明确不做

- telephony_twilio（VS 面排除项）；
- 实时语音/同传（延迟不可行：本地 CPU RTF）；
- dub 的 agent MCP 工具化（长任务走 Nest 管线，agent 只发起与读进度）；
- 不动 P1/P2 已闭环契约。

## 9. 立项请求

拍板项：① 是否批准按 §7 里程碑推进（P3.1 先行）；② NLLB 许可取向（§6#1 三选一，可 P3.1 后再定）；③ dub 产品入口形态（节点动作 vs 纯 agent 对话，§4）。
