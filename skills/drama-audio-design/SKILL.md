---
name: drama-audio-design
version: "0.2.0"
description: 短剧/漫剧配音与声音设计。当用户要求配音、旁白、台词念白、选声线、调情绪或语速、做音效与配乐、音画对齐、设计静默点时使用。覆盖 run_audio_generation 的三类能力：voice 配音朗读、design 多角色台词+音效+氛围、music 配乐/BGM。
---

# 短剧/漫剧配音与声音设计

## 何时使用

用户要处理短剧/漫剧的声音，包括：

- 配音、台词念白、旁白（VO）、选声线
- 情绪演绎、语速调整、音画对齐
- 音效清单、BGM 情绪曲线、静默点设计
- 泛化的"这集的声音怎么做"需求

**能力面**：音频统一走 `run_audio_generation`，按 `kind` 分三类（详见下方能力边界）。上游：drama-storyboard（镜头表的 Audio 列 + 镜头时长）、drama-motion-video（镜头时长与 `generateAudio` 决策）。

## 能力边界（回代码核实，别越界承诺）

| 项 | `kind` | 是否有生成链路 | 说明 |
|---|---|---|---|
| **对白 / 旁白 TTS** | `voice`（默认） | ✅ 有 | `run_audio_generation`；节点参数支持 voice / emotion / language / speed / volume / pitch |
| **多角色台词 + 音效 + 氛围** | `design` | ✅ 有 | 传 `roles`（角色→音色表）+ `scripts`（台词段，`()` 内为语气、`[]` 内为音效）+ `instruction`（≤500 字整体演绎指导） |
| **配乐 / BGM** | `music` | ✅ 有 | 传 `caption`（风格描述）+ 可选 `lyrics`；纯音乐（无歌词）用 `instrumental: true` |
| **混音 / 音量平衡** | — | ❌ 无 | 不在平台能力面，仍只给说明单 |
| **视频自带音频** | — | ⚠️ 视模型 | 视频节点的 `generateAudio` 开启时模型自带音频 → 与 `voice` **二选一**，避免双重人声 |

⚠️ **`kind` 必须按用户诉求选，不要默认全落 `voice`**：要音效/多角色/氛围走 `design`，要 BGM/配乐走 `music`。
⚠️ 某一 `kind` 的模型不可用时工具会**显式报错**——如实转达并说明该分类暂不可用，**不要静默换分类**（那是拿错分类冒充用户要的东西），更不要声称已生成。

可用的 TTS 参数（节点参数，来自 dock / 账号偏好）：

- **voice**：dock 可选 `female-1`（女声·温柔）/ `male-1`（男声·沉稳）/ `narrator`（旁白·磁性）；账号偏好默认 `female-shaonv`
- **emotion**：`neutral` 中性 / `happy` 欢快 / `sad` 低沉 / `serious` 严肃（**只有 4 档**，不要编造更细的情绪值）
- **language**：zh / en / ja
- **speed** / **volume** / **pitch**：数值微调

⚠️ **agent 侧的写权限边界**（回代码核实）：`upsert_media_node` 只写 prompt / title；`update_node` 只能改 **title 与模型芯片**（image_model / video_model / text_model / audio_model，ref 须来自模型选项列表工具（先 tool_search 搜「模型」加载））——**改不了**节点的 emotion / speed / pitch 等 dock 参数（登记在规格 §12 后续包）。所以本 skill 的做法是：**把情绪演绎写进节点 prompt 与说明单，并明确提示用户在 dock 调整参数**——不要声称已设置参数。

## 流程

1. **取上游**：镜头表的 Audio 列（每镜对白 / SFX / BGM / 静默）+ 各镜时长 + 剧本台词原文（**台词不得改写**）
2. **建台词表**：逐镜列「镜号 / 说话人 / 台词原文 / 情绪 / 时长格」
3. **声线分配**（全剧一次定，不许逐镜换）：
   - 主角 / 主要配角各占一个 voice，**同一角色全剧同一 voice**
   - 旁白统一用 `narrator`；旁白与角色对白不要用同一 voice
   - 角色声音气质与角色定位一致（从角色 bible 的性格取：毒舌老板娘 ≠ 女声·温柔）
4. **情绪映射**（剧本情绪 → 4 档 + 参数微调）：

| 剧本情绪 | emotion | speed | pitch |
|---|---|---|---|
| 对峙 / 愤怒 / 威胁 | serious | 1.1 | +1 |
| 悲伤 / 低沉 / 绝望 | sad | 0.9 | −1 |
| 甜点 / 欢快 / 打脸爽感 | happy | 1.05 | 0 |
| 平静叙事 / 交代信息 | neutral | 1.0 | 0 |

5. **时长校验（关键）**：中文约 **4–5 字/秒** → 台词字数上限 ≈ 镜头时长 × 4.5

| 镜头时长 | 台词上限（约） |
|---|---|
| 4 s | 16–20 字 |
| 5 s | 20–25 字 |
| 10 s | 40–50 字 |
| 15 s | 60–75 字 |

   超长处理优先级：**拆分镜 → 提速（≤1.15）→ 精简台词（须用户确认，不得擅自改剧本）**
6. **建节点 + 生成**：`upsert_media_node(target_type="audio", prompt=台词+情绪说明, title="EP01 · S03A 对白")` → `propose_generation` → 用户确认后 `run_audio_generation`（**按需传 `kind`**：纯对白用默认 `voice`；多角色台词+音效用 `kind="design"` + `roles` + `scripts`；BGM/配乐用 `kind="music"` + `caption`，纯音乐加 `instrumental: true`）；`focus_node` 定位
7. **音画对齐**：J-cut（声音先于画面切入）/ L-cut（声音延续到下一镜）/ 同步（对白与画面同起）；在镜头表 Audio 列标注
8. **静默设计**：反转前、情绪峰值前留静默——**不要用 BGM 填满每一秒**；静默点必须显式标注而非漏写
9. **声音设计说明单**（与已生成的音频并存，用来记录设计意图与剪辑期仍需人工的部分）：
   - SFX：具体声源 + 动作 + 环境音 + 时间点（"耳光声，干净室内，00:03"）
   - BGM：配乐风格 + 情绪曲线 + 强度 + 起止点（"压抑钢琴，随反转爬升，00:40 收"）
   - 逐项标注**已由 `kind=design` / `kind=music` 生成**，还是**需用户或剪辑环节补做**（如跨镜拼接、响度平衡）

## QA 闸门

- **Gate 1 台词保真**：TTS 文本与剧本台词**逐字一致**（未改写、未擅加语气词解释性内容）
- **Gate 2 情绪一致**：emotion 档位与剧本情绪峰值一致；同一场情绪不来回跳档
- **Gate 3 时长匹配**：语速 × 字数 ≤ 镜头时长格；无溢出、无硬挤
- **Gate 4 声线一致**：同角色全剧同一 voice；旁白独立；无两角色共用一声线
- **Gate 5 不重复出声**：`generateAudio` 与 `voice` 二选一的决策被遵守，无双重人声
- **Gate 6 静默有效**：关键静默点已标注且未被 BGM 覆盖
- **Gate 7 分类正确**：每次 `run_audio_generation` 的 `kind` 与用户诉求一致（要 BGM 却落 `voice` 即 FAIL）；该 `kind` 模型不可用时如实说明、无静默换分类

**评审结论**：PASS / REVISE（指出哪一 gate 哪一镜）/ REJECT。不虚构已生成。

## 常见踩坑对照表

| 踩坑 | 后果 | 对策 |
|---|---|---|
| 声称已设置 emotion 参数 | 用户以为已生效 | agent 只能写 prompt + 提示用户在 dock 调 |
| 台词超时长 | 配音被截断或赶字 | 先查字数上限，拆分镜优先 |
| 逐镜换声线 | 角色"变声" | 全剧一次分配，登记进角色 bible |
| 写更细的情绪值 | 参数被静默忽略 | 只用 4 档 emotion |
| 擅自改台词凑时长 | 违反剧本保真 | 改词必须用户确认 |
| BGM 铺满全程 | 无呼吸感、反转无力 | 显式设计静默点 |
| 开 generateAudio 又出 TTS | 双重人声 | 项目级二选一 |
| 要 BGM 却默认 `kind=voice` | 生成的是配音，冒充了配乐 | 按诉求显式传 `kind="music"` |
| 该 `kind` 模型不可用就换分类 | 拿错东西冒充用户要的 | 如实说明该分类不可用，不静默换 |

## 规则与边界

- 不虚构已生成；确认前不调用 `run_audio_generation`
- **`kind` 按诉求选**：配音朗读 `voice`（默认）/ 多角色台词+音效+氛围 `design` / 配乐 BGM `music`；选错或该分类模型不可用时如实说明，**禁冒充、禁静默换分类**
- 台词逐字保真；精简或改写须用户明确同意
- 声线分配与情绪映射表登记进 IP bible（`save_memory`），供后续集复用
- **成片混音（跨镜拼接、响度平衡）仍不在本 skill 范围**——只给说明单

## 变更记录

**版本号语义**：`0.MAJOR.MINOR` —— MAJOR 表示流程性变更，MINOR 表示文案微调。

- **0.2.0** (2026-10-07)：**音频三分类能力统一**（配套 `run_audio_generation` 扩 `kind` 与内联参数）——删除「音乐/音效生成不在范围」类声明，能力边界表改按 `kind`（`voice` / `design` / `music`）列出并标注各自的传参；说明单第 9 步改为区分「已生成」与「需人工补做」；新增 Gate 7 分类正确性与两条踩坑；混音仍不在范围。规则侧同步：prompt 规则 23 由「只做配音」改为按 `kind` 描述三类。
- **0.1.2** (2026-10-06)：**点名撤改**（配套读类工具下沉延迟集）——「ref 须来自模型选项列表工具」不再写工具名，改为「先 tool_search 搜『模型』加载」。
- **0.1.1** (2026-09-29)：**权限边界订正**（回 origin/master 核实，PR #71 已合并）——`update_node` 已上线但仅支持 title + 模型芯片（ref 须来自模型选项列表工具（先 tool_search 搜「模型」加载）），仍**改不了** emotion / speed / pitch 等 dock 参数，故「agent 只能写 prompt + 提示用户在 dock 调」的结论不变、表述改准。
- **0.1.0** (2026-09-29)：初版。综合行业配音与声音设计实践，为短剧/漫剧调优：
  - 声音三分类（人声 / 音效 / 配乐）与「voice = 台词 + 情绪 + 语气 + 语速」的描述公式借鉴 Alibaba Model-Studio 视频提示词的 Sound formula
  - 4 档情绪映射与参数微调、语速-时长约束（中文 4–5 字/秒）、静默点设计取自短剧配音与剪辑通行做法
  - **能力边界回代码核实**：`run_audio_generation` 仅 TTS（generation.ts:98-102）；节点参数 voice / emotion(neutral·happy·sad·serious) / language(zh·en·ja) / speed / volume / pitch 见 `constants/dockAudio.ts`；`generateAudio` 见 `shared/src/index.ts:200`；agent 侧无节点参数写权限（`update_node` 属 §12 后续包）
