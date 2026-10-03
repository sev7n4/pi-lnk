# pi-runtime 能力吃满：多模态直通 + 上下文治理 设计（T1/T2/T3/T4）

日期：2026-10-02 ｜ 基线：origin/master `25b00ad` ｜ 状态：已评审（v2，含 Codex/Claude 视角审查修订）
前置材料：`docs/2026-10-02-sidebar-context-chain-audit.md`（§六吃满度评估，T1-T5 演进路线）

## 1. 背景与目标

侧栏三入口（本地上传/资产库/画布选择）进上下文链路审核（R1-R6）+ vendor 能力对照（§六）暴露四项欠账：

- **R1/T1**：`lane.prompt(text, undefined)` 焊死 images 通道（session-manager.ts:1001），主模型永远看不到像素；vendor 双形态 prompt（`runtime/lane.ts:1133-1140`）闲置
- **R2/T3**：dynamicBlocks（画布摘要/识图块/素材块）无 token 预算，systemPrompt 逐轮膨胀打断 prompt cache
- **R5/T2**：出站 payload 无治理挂点（vendor `before_payload` hook，hooks.ts:249-257 `result.payload` 直接替换，闲置）
- **T4**：图片进历史后，压缩摘要（文本模型，假设见 §7）看不见 image parts → 压缩后图片信息全丢

**已拍板**：T1 能力门控（视觉名单内才直发像素，否则识图兜底）；预算保守（≤4 张、单张 ≤5MB、超限 downscale、装不下回退识图）；交付形态用 vendor 原生 `images` 参数（不手搓 AgentMessage[]，升级路径保留在 session-manager 单层）；两批交付；**T5（setActiveTools）维持拍板延期**。

## 2. PR-A（第一批，纯 pi-runtime 内部）：T3 dynamicBlocks 预算

### 2.1 实现

- 新纯函数 `services/pi-runtime/src/dynamic-budget.ts`：
  - 输入：`dynamicBlocks: string[]`（保持现有数组形态，不动 Nest 契约）
  - 块分类：按块首标记识别 kind（`[画布快照]` / `[I\d=` 识图 / `[侧栏素材]` / 其他=general）——实施时以 sidebar-block.ts / assembleDynamic 实际产出的块首约定为准
  - **unknown kind 兜底**：未识别 kind 落 general 配额（不丢块），同时计 `pi_runtime_dynamic_budget_unknown_kind_total`（标记约定漂移的告警信号）
  - 总预算：env `PI_RUNTIME_DYNAMIC_BUDGET_TOTAL_CHARS`（默认 48000 chars ≈ 12k token CJK 口径）；单 kind 上限按比例（画布摘要 ≤60%、识图 ≤25%、素材 ≤15%，可覆盖）
  - 超限降级：**截断方向按 kind 定策略**——识图/素材块保头部；画布摘要 JSON「保头保尾、掐中段」（节点按时间追加，重要新节点在尾部）；从不整块丢弃（保业务下限）；截断块追加尾注「（本段已截断 N 字，可用 read_document 取回全文）」
- 接线：`composeSystemPrompt`（session-manager.ts:386）入口处先过 budget；env `PI_RUNTIME_DYNAMIC_BUDGET=off` 时逐字节直通（回退开关）
- metrics：`pi_runtime_dynamic_budget_drops_total{kind}`；`pi_runtime_system_prompt_bytes`（gauge，static+dynamic 总水位观测，成本/膨胀可见性）

### 2.2 硬不变式（单测必测）

1. **byte-stable**：输入不变 → 输出逐字节相同（护 prompt cache；截断判定只依赖块内容，无时间/随机因素）
2. 不超限时输出 === 输入拼接（零开销直通）
3. 截断块必含尾注，且总长 ≤ 预算
4. 空数组/全空块 → 空 systemPrompt 尾部不残留分隔符

### 2.3 发布

CI 绿 → squash 合并 → dispatch runtime-deploy **tag=0.0.36**，`feature_grep=dynamic-budget`（派前 `gh api .../runtime-deploy.yml/runs?per_page=5` 查并行窗口防撞 tag）→ 新 env 走 `--set-string` 并同步补 triple verify 断言串（注意主仓 runtime-deploy.yml 正被并行窗口改动，rebase 时逐行核对）→ E2E：超大画布会话验证截断尾注出现 + metrics 增量。

## 3. PR-B（第二批，跨服务）：T1 直通 + T2 payload 治理 + T4 压缩降级

### 3.0 实施前置项（开工前取证，结果记入 PR 描述）

- **signal vs images（高优先）**：`session-manager.ts:995` 注释「第二参是 images，传不了 signal」暗示当年为保留中断能力才焊死 images——核实该调用点 signal 消费链，确认 `lane.prompt(text, images, context)` 形态下中断/超时不回归；若确有冲突，在调用层用 Promise.race 或 vendor abort 通道补齐，**中断能力是硬前提**
- **vendor retry 语义**：确认 retry（config.ts DEFAULT_RETRY_POLICY）对图片类 400 是否原样重试三次全炸；必要时注册 strip-images 降级重试（去掉 image parts 带错误话术重发一次）
- **摘要模型假设**：确认 generateSummary 使用的模型为文本模型（若是视觉模型则 T4 策略重议）

### 3.1 T1 多模态直通

**Nest 侧**（agent.service.ts 附件组装处）：
- 能力门控：主模型（BYOK 解析结果）过 `supportsVisionModel`（sidebar-vision.ts:51）——**该正则升级为配置化**：env `SIDEBAR_VISION_MODELS`（逗号分隔 glob/正则，缺省回落现有三正则），消除新模型静默降级（R1 附带修复）
- 命中视觉 → 复用识图前置同一读取点（本地磁盘/内联 base64，upstream-ref-inline.ts）把 ≤4 张附件转 `DirectImage{name,mimeType,data}`；单张 >5MB 走 `downscaleOversizedReferenceImages` 压缩后重试；仍装不下或非视觉模型 → 走既有识图兜底（**识图路径保留不删，从唯一通道降为 fallback**）
- **载荷位置（v2 修正）**：`directImages` 不进 TurnContext（TurnContext 契约是「每轮易变世界状态、不进历史、被工具消费」，图片是本轮消息内容，混装破坏「缺省即清空」语义）——改为 **prompt 载荷顶层 `images` 字段**（与 text 平级，pi-runtime.client.ts prompt 方法与 Nest→pi-runtime HTTP 载荷均加顶层可选字段）；session-manager prompt 入口直取传 `lane.prompt(text, images, context)`，不落 turnContext、不参与 normalize
- 直通生效时 user 文本尾部追加 `[I1=文件名]` 标记行，与 dynamicBlocks 既有 I 编号（sidebar-block.ts:13-50）对齐——为 T2/T4 提供文本可恢复的映射
- metrics：`pi_runtime_direct_images_total{outcome}`（sent/downscaled/fallback）；`pi_runtime_direct_image_tokens_estimated`（按尺寸+mimeType 公式估算的图片 token，累计——agnes 不回 usage，这是唯一的成本可见性）

### 3.2 T2 before_payload 治理（常开，无开关——低风险只减不增）

- index.ts 注册 `harness.hooks.on("before_payload")`，每请求触发，职责三件：
  1. **历史图片渐进降级（v2 新增，成本主闸门）**：image parts 仅保留**最近 2 轮**的，更早的转文本占位 `[图片 I{n} 已从上下文移除，可用 read_document 取回]`——否则 84k 长会话带 4 张图时中间每轮白烧 ~6k token（Codex/Claude Code 同款策略）
  2. **本轮优先裁剪（v2 修正）**：image parts 总数 >4 时按「当前轮 → 新→旧历史」顺序回填保留，超出的降级占位（**不得**「取前 4」——那会把本轮新图裁掉保留最旧的）
  3. 超大 text part（>200k chars）截断告警
- fail-soft：handler 异常吞掉 + warn，payload 原样放行
- metrics：`pi_runtime_before_payload_trims_total{reason}`（history_image/overflow/text_overflow）
- 历史图片保留轮数 env 化：`PI_RUNTIME_DIRECT_IMAGE_HISTORY_ROUNDS`（默认 2，调大=少裁剪）

### 3.3 T4 压缩降级（依赖 T1 的 images 进历史）

- **实施期取证点**：vendor `before_compaction` hook（hooks.ts:121-124 走 `firstStructural`）的 result 语义需实施时核实——若可改写进摘要模型的消息，则注册 hook 做「历史 image parts → 文本占位」变换；若只能改写摘要提示，则 fallback：在宿主触发 compaction 的路径上预变换消息副本
- 占位格式：`[图片 I{n}: {文件名} | {mimeType} | 来源见 dynamicBlocks，全文可用 read_document 取回]`——映射从 user 文本尾部 `[I1=文件名]` 标记恢复（T1 埋点）
- 直通未生效的旧会话（无标记无 image parts）天然零影响
- **read_document 取回闭环（v2 新增）**：压缩/降级后的占位全指向 read_document——① 实施前确认 uploads 源文件保留期 ≥ 会话生命周期（若存储侧有清理周期，需对齐或对压缩会话豁免）；② 源文件已失效时 read_document 返回明确话术「该参考图片已被清理，无法取回原文」而非报错

### 3.4 发布

CI 绿 → 合并 → dispatch **tag=0.0.37**，`feature_grep=directImages`（同样先查撞 tag）→ **部署顺序无关**（载荷纯增量可选字段：新 Nest+旧 runtime 旧字段被忽略；旧 Nest+新 runtime images=undefined 直通自然关闭）→ E2E（provider 矩阵，v2 补）：
1. **像素直通实证**（agnes/gemini 系生产主路径）：带图 prompt「描述这张图的内容」→ 模型真实描述图片内容（非识图兜底话术）
2. **provider 矩阵**：BYOK openai 系、claude 系各验一例直通（vendor ai 层各 provider 对 ImageContent 序列化不同）
3. **回退路径**：构造非视觉模型会话（或临时名单改空）→ 识图兜底仍工作
4. **成本闸门**：直通会话多轮对话后验证历史图片已转占位（SSE/metrics 取证）+ `direct_image_tokens_estimated` 增量合理
5. T4：直通会话触发 compaction → 摘要中含 `[图片 I1: ...]` 占位（metrics + ContextSnapshot/摘要文本取证）

## 4. 接口变更清单（B 批，v2 修正）

| 位置 | 变更 | 兼容性 |
|---|---|---|
| Nest→pi-runtime prompt 载荷 | **顶层** +`images?: DirectImage[]`（不进 TurnContext） | 可选字段，旧载荷零影响；部署顺序无关 |
| `PiTurnContext`（pi-runtime.client.ts:36） | **不变**（图片不走 turnContext） | — |
| `TurnContext` / `normalizeTurnContext`（session-manager.ts:269+） | **不变** | — |
| `supportsVisionModel` | env 配置化，缺省回落现正则 | 缺省行为不变 |

## 5. env 汇总

| env | 侧 | 默认 | 说明 |
|---|---|---|---|
| `PI_RUNTIME_DYNAMIC_BUDGET_TOTAL_CHARS` | runtime | 48000 | A 批；--set-string + triple verify |
| `PI_RUNTIME_DYNAMIC_BUDGET` | runtime | on | off=逐字节旧行为 |
| `PI_RUNTIME_DIRECT_IMAGES` | runtime | on | B 批总开关；off=images 恒 undefined |
| `PI_RUNTIME_DIRECT_IMAGE_HISTORY_ROUNDS` | runtime | 2 | B 批；历史图片保留轮数（T2 渐进降级） |
| `SIDEBAR_VISION_MODELS` | Nest(/opt/lnkpi/.env) | 空=回落现正则 | 能力清单配置化 |

## 6. 测试判据与纪律

- pi-runtime：TDD；判据 = `tsc -p` + 全量 `node --import tsx --test "src/**/*.test.ts"`（绝对路径，worktree 软链主仓依赖）
- Nest：vitest（agent.service / pi-runtime.client / sidebar-vision 相关套件）
- worktree 自 origin/master 新起（建分支前必 fetch，主工作区正被并行窗口改动，绝不触碰）；每批合并前查部署队列空
- 回退：两批各有独立 env 开关（A：DYNAMIC_BUDGET；B：DIRECT_IMAGES），秒级回旧行为；不删识图路径（兜底常在）；T2 渐进降级轮数可调可关（调大=少裁剪）

## 7. 假设与边界（v2 明示）

- **压缩摘要模型为文本模型**（generateSummary 现行为）——若将来配置成视觉模型，T4 的占位策略需重议（可带图摘要，成本另算）
- 识图兜底产出的文本会被摘要继承（比直通像素的压缩后状态更强）——产品语义上「识图=可压缩的持久理解，直通=当轮高保真+read_document 持久取回」，两者互补而非替代
