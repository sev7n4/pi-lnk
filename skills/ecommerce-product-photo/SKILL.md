---
name: ecommerce-product-photo
version: "0.5.0"
description: 电商商品图/产品视觉生成指导。当用户要求生成商品图、产品场景图、白底图、模特上身图、商品细节图，或提到商品摄影、场景搭配、营销视觉时使用。本 skill 只覆盖静态商品图；视频脚本不在范围。
---

# 电商商品图生成

## 何时使用

用户上传商品实拍图并要求制作电商用图，或口头描述商品视觉需求，包括：

- 白底主图 / 电商主图（hero_main）
- 生活场景图、使用场景图（scene_lifestyle）
- 商品细节图、微距特写（detail_macro）
- 模特上身 / 手持展示图（model_display）
- 包装主视觉、包装结构 / 物流包装效果图（packaging_hero）
- 泛化的"商品摄影、场景搭配、营销视觉"需求

**视频脚本不在本 skill 范围**；用户只要静态商品图时走本 skill，要视频时另起 video skill。

## 商品身份锁（Identity Lock）—— 写提示词前必做

借鉴 aiskillstore/generating-product-photos 与 nexu-io/ecommerce-image-workflow。在写任何提示词之前，先从用户上传的参考图（或口头描述）提取并锁定商品身份锚点，写成一段内部 identity lock，后续每条 prompt 都要复用它：

- **类别与形态**：是什么商品、整体造型
- **形状与轮廓**：外轮廓特征、关键结构线
- **主色与材质**：主体颜色（用词 + hex，如"哑光黑 #1a1a1a"）、材质（金属/塑料/皮革/玻璃/布艺）
- **固定细节**：Logo 位置、标签文字、图案、紧固件、接口、提手、按键、缝线等不可变特征
- **比例与尺寸线索**：长宽比、相对参照物的大小
- **不可变项清单（must not change）**：明确列出"Logo 不得移动/重写、配件数量不得增减、包装文字不得改写、颜色不得偏色"等

identity lock 不可省略；无参考图时先向用户索取，不要凭商品名脑补身份。

## destination → shot 类型映射

借鉴 sanky369/vibe-building-skills。按用途分流 shot 类型，避免堆砌：

- **电商 listing（淘宝/京东/亚马逊详情页）** → 1 白底主图 + 1–2 细节图（+ 1 场景图若平台允许多图）
- **独立站 landing page** → 1 hero + 1 场景 + 1 细节
- **社交/广告素材** → 1–2 场景 + 1 flat lay（或 hero）
- **"就要一张"** → 选最能服务该用途的一类，并说明为何选它

需求模糊时可给默认三件套（白底主图 + 场景图 + 细节图）并说明这是默认组合。

## 执行步骤

1. **锁商品身份**：按"商品身份锁"小节提取 identity lock，写进内部上下文
2. **补全缺失信息**（文本结构化选项 + 其他可编辑，一次性问全）：按项给预设选项让用户选或补充其他，降低商家认知负载（"风格"等专业词用户未必答得出）；用户可单字回（"场景选 A"）或写其他；用户 waived 或信息已够后不再追问
   - **商品主体**：开放描述（每商品不同不预设）；用户已上传参考图则从图提取，跳过此问
   - **场景**：A 家居 / B 办公 / C 户外 / D 影棚白底 / E 纯色背景 / 其他（请说明）
   - **风格**：A 简约高级 / B 喜庆 / C 性冷淡 / D ins风 / E 国潮 / F 工业风 / 其他（请说明）
   - **用途(destination)**：A 电商listing / B 独立站landing / C 社交广告 / D 单图 / 其他（请说明）
   - **平台规范**：不问用户；由 destination 自动查"平台硬规格"表
   - ⚠️ 当前为**文本选项**（agent 在回复里列选项，用户手打回复）；可点击选项卡体验需 pi-runtime `ask_user` 工具（已实现并注册）+ 前端渲染分支（见 `docs/superpowers/specs/2026-09-28-ask-user-tool-design.md`）
3. **按 destination 分流 shot 类型**：查"destination → shot 类型映射"，确定本次产出哪些图
4. **建节点 + 写 prompt**：用 `upsert_media_node` 创建 image 节点；每条 prompt 顶部带 fidelity lock 段落（见"提示词写法"），正文按"主体 → 场景 → 光线 → 风格 → 质量词"结构展开；每类图可给 1–3 个变体方案供挑选，标推荐项
5. **挂参考图（数据层）**：侧栏参考图用 `apply_sidebar_attachments`（mode=localRefs，@I* 芯片序）；画布已有图才用 `attach_refs`；ref 顺序为先身份/主体，后服装/产品。此步是**数据层**——影响生成时参考哪些图
6. **连视觉边（视觉层）**：用 `connect_nodes` 把白底主图作基准图，场景图/细节图/模特图/包装图各自有向边 `source=主图id target=该图id`，表达"从主图衍生、参考主图一致性"
   - 维度区分：`attach_refs`（step5）是**数据层**（生成时参考哪些图，影响出图），`connect_nodes`（本步）是**视觉层**（画布画箭头 + 驱动沿边布局）——两者不同维度，都要做
   - 配合 `arrange_nodes(along_edges)` 可自动分层（主图居左，衍生图向右展开）；该工具待开发（见 `docs/superpowers/specs/2026-09-28-arrange-nodes-tool-design.md`，已拍板待开发）
7. **提议生成**：`propose_generation` 提议生成，等待用户确认；确认前不调用 `run_*`
8. **出图后 QA 闸门 + 定位**：出图后先 `focus_node` 定位到刚生成的节点（让用户第一时间看到结果），再对照"出图后 QA 闸门"自检并报告 PASS/REVISE/REJECT。**自检前必须先看图**，按 `imageRefine` 取值分四种情形：`imageRefine="attached"` 时图已作为附加图片块进入上下文，必须先查看该图再做逐 gate 自检，不得凭 prompt 想象画面下结论；`imageRefine="skipped"` 时如实向用户说明"未能获取图片用于自检"（可结合结果中的 `imageRefineReason` 说明原因），不得假装已自检；结果中**不存在 `imageRefine` 字段**（自评回流被关闭）时按 `skipped` 同款处理：如实说明本次无法取得图片用于自检，不得凭 prompt 想象下结论；`imageRefine="n/a"`（生成未完成）时走原 status 分支：`status=timeout` 稍后用 `get_generation_status` 查询，`status=fallback_pending` 提示用户在画布节点上确认平台兜底。

## 出图后 QA 闸门

借鉴 aiskillstore/generating-product-photos 的四 gate。出图后、用户确认收图前，agent 逐图自检并给结论。

**看图是自检的前提**：`imageRefine="attached"` 时生成图已作为附加图片块在上下文中，必须先实际查看图片，再逐 gate 判断；`imageRefine="skipped"` 时无法获取图片（原因见结果中的 `imageRefineReason`），如实说明"未能获取图片用于自检"，**不得把 skipped 当作 PASS 交付**，也不得凭 prompt 描述脑补画面自检；结果中**不存在 `imageRefine` 字段**（自评回流被关闭）时按 `skipped` 同款处理，同样不得盲检交付；`imageRefine="n/a"` 表示生成未完成，不走本闸门，按生成结果的 status 分支处理（`timeout` 稍后 `get_generation_status` 查询；`fallback_pending` 提示用户在画布节点确认平台兜底）。

四 gate 条目：

- **Gate 1 商品身份一致性**：形状/颜色/材质/Logo/标签/接口/配件数量是否与 identity lock 一致；任何一项走样即 REVISE
- **Gate 2 构图与镜头规范**：是否符该 shot 类型规范（白底图商品占框比例、场景图主体是否清晰、细节图对焦是否到位）
- **Gate 3 文字与声明**：是否虚构认证/参数/材质/未提供的卖点文案；包装文字是否被改写
- **Gate 4 套图一致性**：同一商品在不同图里是否同一视觉世界（光照/色调/风格统一）

**评审结论**：PASS 直接交付 / REVISE 局部重画（指出哪一 gate 哪一项）/ REJECT 整体重做。REVISE/REJECT 时不虚构已修复。

### 自评与重试预算

每个节点的生成闸门只允许一次未经用户再确认的重试，预算纪律如下：

- **PASS** → 直接交付，并给出逐 gate 一句话自评结论；结论必须引用图中可见证据（如商品占框比例、背景纯净度、Logo/包装文字是否原样保留），不得只复述 gate 名称（让用户知道每项检查的结果依据）
- **REVISE** → 先归因到具体 gate 与具体项 → 用 `set_node_text` 修正 prompt（针对性修改，不是推倒重写）→ **再次调用 `run_image_generation`**（同节点第 2 次，系统自动放行，无需用户再确认；这是"确认前不调用 `run_*`"规则的文档化例外——重试发生在用户对本次生成的原始确认之后）
- **第二次仍不通过，或第 3 次调用被系统拦截** → **必须 `ask_user`**：给出两次自评的对比结论（哪一 gate、哪些项仍未达标）与可选修正方向（如"往冷调走 / 保留原图换构图 / 人工改图"），由用户决定下一步。**禁止继续无提示重试**
- `imageRefine="skipped"` 或结果中无 `imageRefine` 字段（同 skipped 处理）不得当 PASS 交付；`imageRefine="n/a"` 走 status 分支（`timeout` 查询 / `fallback_pending` 用户确认兜底），不消耗重试预算
- **诚实兜底**：若结果标注 `imageRefine="attached"` 但你实际无法在上下文中看到该图片（纯文本渠道等），必须如实说明"看不到图、无法自评"，不得凭空编造自评结论。

## 平台硬规格

借鉴 inference-sh/product-photography 的 Amazon packshot 规格 + 国内平台常见基线。**以平台最新规则为准，本表为常见基线**：

| 平台 | 背景 | 尺寸 | 商品占框 | 禁项 |
|---|---|---|---|---|
| Amazon 主图 | 纯白 RGB(255,255,255) | 最长边 ≥1000px（建议 1600px+ 支缩放） | ≥85% | 无道具/文字/水印/logo |
| 淘宝主图 | 白底 | 800×800 或 1000×1000 | 居中 | 无牛皮癣（文字拼贴轰炸） |
| 京东主图 | 白底 | 800×800 | ≥60% | 无水印拼图 |
| 通用 | — | JPEG/PNG/sRGB | — | — |

跨境 listing 走 Amazon 规格时，白底主图优先作为基准图，其余视角/场景图可参考它保持商品一致；先主体后周边，逐层扩展。

## 规则与边界

- 不虚构已出图；确认前不调用 `run_*`
- 芯片 key（@I1/I2）不是画布节点 id；禁止 `connect_nodes` 连芯片
- **identity lock 不可省略**；无参考图时先索取，不脑补
- 按用户意图动态选型：用户没提的类型（如包装、模特、视频）不要自作主张加入
- 每类图可给 1–3 个变体方案，标出推荐项；每个变体都要有完整 prompt，把用户说的卖点、材质、风格约束融进去
- listing / 包装类任务建议至少包含一张有人感的图（模特上身、手持、有人使用的场景），避免全部是冷冰冰的产品渲染
- 白底主图优先作为基准图，其余视角 / 场景图可参考它保持商品一致；先主体后周边，逐层扩展
- **视频脚本不在本 skill 范围**

## 提示词写法

- **fidelity lock 段落**（每条 prompt 顶部必带，借鉴 nexu-io）：写出"保持参考图商品身份不变：形状、轮廓、颜色、材质、Logo/标签位置、可见结构细节、比例；不得重新设计商品；不得增删或移动商品特征"
- **结构**（fidelity lock 之后）：主体（商品、材质、卖点）→ 场景（环境、道具、氛围）→ 光线（柔光、逆光、影棚光）→ 风格（简约高级、喜庆、性冷淡等）→ 质量词（高清、商业摄影级）
- 卖点要落到画面语义，不要只写形容词：如"12 小时保温"写成分区展示杯身材质与保温结构，而非仅写"保温"
- 用户强调的限制（运输不压坏、突出新鲜等）必须显式出现在提示词里
- 颜色用词 + hex（如"哑光黑 #1a1a1a"）
- 显式声明不得出现的元素（无水印、无虚构 logo、无虚构认证文案）

## 变更记录

**版本号语义**：`0.MAJOR.MINOR` —— MAJOR 表示流程性变更（新增步骤/闸门/小节），MINOR 表示文案或规则微调。frontmatter 的 `version` 字段为文档性，pi-runtime loader 当前只读 `name`+`description`，`version` 保留以便 grep 与 git 追溯，不影响 drop-in 加载。

- **0.1.0** (2026-09-25, commit `3ec049f`, Codex)：初版。从 lnkpi `ecommerce-product-visual` 按 Anthropic 格式重写迁入 pi-runtime drop-in 体系。
- **0.2.0** (2026-09-28, 借鉴社区最佳实践)：补 3 处缺口 + 边界明确。
  - 新增"商品身份锁"前置步骤（借鉴 aiskillstore/generating-product-photos、nexu-io/ecommerce-image-workflow）
  - 新增"出图后 QA 闸门"四 gate（借鉴 aiskillstore/generating-product-photos）
  - 新增"平台硬规格"表（借鉴 inference-sh/product-photography 的 Amazon packshot 规格 + 淘宝/京东常见基线）
  - 新增"destination → shot 类型映射"（借鉴 sanky369/vibe-building-skills）
  - 提示词写法加 fidelity lock 段落要求（借鉴 nexu-io/ecommerce-image-workflow）
  - 明确视频脚本不在本 skill 范围
- **0.3.0** (2026-09-28, PM 视角优化 step2)：step2 由开放式提问改为文本结构化选项 + 其他可编辑。
  - 场景/风格/用途三项给预设选项 + 其他（降低商家认知负载，对齐 WorkBuddy AskUserQuestion 渐进披露哲学）
  - 商品主体保持开放（每商品不同不预设），有参考图则从图提取跳过此问
  - 平台规范从"问用户"改为 agent 自查"平台硬规格"表（用户是商家未必懂 RGB/sRGB）
  - 标注当前为文本选项；可点击选项卡体验需 pi-runtime `ask_user` 工具 + 前端渲染分支（见 spec 文档）
- **0.4.0** (2026-09-28, 连线策略 + 生成后 focus 定位)：新增"连视觉边"步骤 + QA 闸门扩展 focus 定位。
  - 新增 step6"连视觉边"（`connect_nodes`）：白底主图作基准，衍生图有向边指回主图表达参考链
  - 分清维度：`attach_refs`（step5 数据层影响生成）vs `connect_nodes`（step6 视觉层画布可见+布局依据）
  - 配合 `arrange_nodes(along_edges)` 自动分层（工具待开发，见 spec 文档）
  - step8（原 step7）出图后 QA 闸门扩展：先 `focus_node` 定位到新节点再自检
- **0.5.0** (2026-09-29, 视觉自评闭环 P0)：QA 闸门从盲检升级为看图自评。
  - 明确 `run_image_generation` 结果 `imageRefine="attached"` 时图已在上下文，必须先看图再自检
  - 新增"自评与重试预算"小节：REVISE → 改 prompt 重跑一次（系统放行）；仍不过或第 3 次被拦截 → 必须 ask_user 给结论与选项
  - `imageRefine="skipped"` 不得当 PASS；`"n/a"` 走原 status 分支
  - 复审加固：`imageRefine` 字段缺失（自评回流关闭）按 skipped 同款处理，杜绝盲检；`n/a` 明确 `timeout`（`get_generation_status` 查询）/ `fallback_pending`（用户确认平台兜底）两个 status 分支；PASS 自评必须引用图中可见证据而非复述 gate 名；skipped 时结合 `imageRefineReason` 说明原因；注明重试是"确认前不调用 `run_*`"的文档化例外；更正 step2 中 `ask_user` 已实现并注册的表述
  - 诚实兜底：标注 `imageRefine="attached"` 但实际看不到图（纯文本渠道）时须如实说明、不得编造自评
