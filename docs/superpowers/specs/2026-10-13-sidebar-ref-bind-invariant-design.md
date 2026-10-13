# 侧栏参考图绑定链路不变量 — 引用化 schema / 可行动错误 / propose 前置门禁

> 日期：2026-10-13（二轮审核后定稿）
> 状态：**待批准**
> 产品：超创平台（lnkpi）无限画布 / Agent Runtime
> 事故复盘：[../../analysis/2026-10-13-sidebar-ref-bind-failure-postmortem.md](../../analysis/2026-10-13-sidebar-ref-bind-failure-postmortem.md)（生产三源取证 + 二轮审核修正记录 R1–R4）
> 父规格：[2026-09-16-agent-sidebar-media-propose-bind-design.md](./2026-09-16-agent-sidebar-media-propose-bind-design.md)（SM-D4/SM-D7）
> 关联规格：[2026-10-13-propose-confirm-evidence-and-clarify-matrix-design.md](./2026-10-13-propose-confirm-evidence-and-clarify-matrix-design.md)（P0-A 正证据哲学）、[2026-10-12-tool-details-contract-design.md](./2026-10-12-tool-details-contract-design.md)（信号层 §4/§5/§6）、[../../agent/tool-result-quality-signal-gap.md](../../agent/tool-result-quality-signal-gap.md)（§9.2 vendor 未用能力清单）

---

## 决策表

| # | 决策 |
|---|------|
| **RB-D1** | 根因定性：本次 500 不是偶发参数错误，是「提示词约定型契约」（SM-D4 只存在于文档）在弱模型 + 宽松 schema 下的**必然失效**。该模型对提示词软约束的遵从性已被生产证伪两次（10-13 规格 §1.2）。**解法重心 = 机制编码（schema / vendor hook / 门禁 / 信号），提示词条文只作兜底，不追加预算外长文。** |
| **RB-D2** | **引用不是值**。用 vendor 原生 `prepareArguments`（先于 `validateToolArguments` 执行，本仓首次启用）对 `apply_sidebar_attachments` 的 `attachments` 做确定性消毒：数组任一项「缺 `id`/`mediaType`/`label` 之一，或 `url`/`text` 均空」⇒ 判定为模型伪造，**整参数删除**。execute 既有回落 `p.attachments?.length ? p.attachments : tc.attachments` 自然命中 `tc.attachments`（SM-D4 路径），**不改 execute**。成功文案必须说明实际挂载来源（「已自动使用本轮侧栏附件 I1」），让模型知道发生了什么（对账）。 |
| **RB-D3** | **失败必须可行动**。Nest `AgentCanvasToolsService.applySidebarAttachments` 的 `validateSidebarAttachments` ZodError 转 `BadRequestException`（400），message 含：缺失字段清单 + 正确用法（「请省略 attachments，由平台自动填充本轮侧栏附件」）。500→400 同时把 runtime errorKind 从 `upstream_5xx` 修正为 `upstream_4xx`（参数错，语义正确）。新增 `@Catch` 不如就地转换——保持与既有 `BadRequestException('创建媒体节点失败')` 同款局部风格，不引全局 filter。 |
| **RB-D4** | **信号层覆盖 throw 路径**（补 10-12 规格盲区）。result-signal 接线层增加 `isError` 分支：工具抛错（NestToolError，无 `details._signal`）时从 error message 提取 nest status——4xx ⇒ 合成 `{status:"failed", retryable:false, errorCode:"invalid_params"}` 并追加 ≤30 token 自解释短句（格式沿用 `⚠️[<tier>] ...`，如 `⚠️[write] 参数被拒：attachments 形状不符；省略该参数由平台填充`）；5xx ⇒ `upstream_5xx` 退避提示。成功静默 0 token、只改 content+details、不碰 isError/usage/terminate 的既有纪律（§4）不变。 |
| **RB-D5** | **前置不过不出图（fail-closed）**。runtime `propose_generation` 调用体增加 `sidebarImageCount`（本轮 `tc.attachments` 中 `mediaType==="image"` 计数）；Nest `proposeGeneration`（SSOT 所在侧）校验：`sidebarImageCount>0` 且目标节点 `data.localRefs` 为空 ⇒ **不做状态转移**，返回 `{confirmed:false, reason:"missing_refs", message:"参考图未绑定成功，请重试 apply_sidebar_attachments（只传 node_ids 与 mentioned_keys），或请用户在画布上手动添加参考图"}`；runtime 映射为 `withWriteSignal(..., 0)` + 文案。误伤出口：用户明说纯创作/无参考意图时，文案已给出人工路径；`sidebarImageCount===0` 不触发（纯文生图零影响）。 |
| **RB-D6** | **用户确认与失败联动（前端）**。① dock 直生路径：节点无 refs 且本轮会话有侧栏图 ⇒ 点生成弹二次确认（「未检测到参考图，确定直接生成吗？」）。② 本轮 trace 存在 failed 步骤 ⇒ dock 确认区渲染持久警示一行（非 toast，不自动消失）。trace 步骤 `detail` 已有渲染（二轮审核 R1 修正），可行动化由 RB-D3/RB-D4 保证，前端不重复造文案。 |
| **RB-D7** | **跨服务契约镜像测试**。pi-runtime 不依赖 `@lnkpi/shared`（Zod 世界），**不引跨包运行时依赖**；改为共享 fixture（JSON：`runtime 会发出的 body 形态集`——SM-D4 回落实体 / 老链路显式实体 / 畸形态 `{source,target_node_id}` / 空数组）+ 双端单测：shared/Nest 侧断言过/拒 Zod 矩阵，runtime 侧断言消毒谓词输出。消灭「runtime 放行 ↔ Nest 拒绝」中间地带。 |
| **RB-D8** | **schema 引用化（破坏性，缓议单独 PR）**。`attachments` 参数终态 = 芯片 key 引用数组或直接移除；不在本批。前科警示：harness 不应用 TypeBox default（canvas-write.ts I-1 注释），改 schema 必须同步核对 Nest DTO 必填项，否则 400。 |
| **RB-D9** | **观测即验收**。metrics：`pi_runtime_sidebar_ref_bind_total{outcome="ok|invalid_params|upstream_error|short_circuit"}`、`pi_runtime_propose_missing_refs_total`、`nest_zod_reject_total{endpoint}`；告警按静默降级家族纪律接入。事故会话形态（无 @ + 本轮新图 + 换装口语）进 `services/pi-runtime/src/eval/golden-cases.ts`，补「畸形 attachments 被消毒后回落成功」用例。 |
| **RB-D10** | **回归红线**。金标句 `@I1 模特 @I2 产品，让模特穿上`（eval-route-set rt-img2img-01）、纯文生图（无图无 @）、dock 手动上传参考图三条路径行为零退化；B-5 阻塞确认旧行为逐字节保留（spec §8 回退纪律沿用）。 |

---

## 金标句（钉死）

**G1（事故原句，SM-D7 隐式路径首个真实流量形态）**：
> 「让这个小姑娘换上黑丝，更性感迷人」+ 1 张本轮新上传图，无 @

期望：apply 成功（省略参数或消毒后回落）→ dock 参考图条可见 → propose `confirmed:true` → GenerationRecord `referenceImageCount>0`。

**G2（模型伪造参数形态）**：模型传 `[{"source":"I1","target_node_id":"image-x"}]` ⇒ 消毒删除 → 回落 `tc.attachments` → 结果同 G1，且文案声明实际来源。

**G3（门禁拦截形态）**：apply 未执行且节点无 refs、本轮有侧栏图 ⇒ propose 返回 `missing_refs`，**零 GenerationRecord**。

## 硬表（测试断言）

| 测 | 断言 |
|----|------|
| runtime 单测：畸形 attachments | `prepareArguments` 输出不含 `attachments`；POST body.attachments === `tc.attachments` 实体（含 id/mediaType/label/url） |
| runtime 单测：省略 / 空数组 attachments | 行为逐字节不变（SM-D4、M-1 回归） |
| runtime 单测：合法实体 attachments | 不消毒，原样透传（不误杀老链路） |
| Nest 单测：ZodError 路径 | HTTP 400 BadRequest，message 含缺失字段名 + 「请省略 attachments」；不再出现 500 |
| Nest 单测：propose 门禁 | `sidebarImageCount>0` && localRefs 空 ⇒ `missing_refs` 且节点状态不变；localRefs 非空 ⇒ 放行；`sidebarImageCount=0` ⇒ 放行 |
| 信号层单测：isError + 4xx message | content 尾部追加 `⚠️[write]` 可行动短句；details 合并 `_signal{errorCode:"invalid_params",retryable:false}`，既有 actions 键不被抹掉（展开合并护栏） |
| 信号层单测：isError + 5xx message | `errorCode:"upstream_5xx"` 退避提示；成功结果仍零注入 |
| 契约镜像：fixture 四形态 | shared 侧 Zod 过/拒矩阵与 runtime 消毒输出一一对应 |
| 前端单测：failed 步骤 + dock | 本轮有 failed 步骤时确认区警示行渲染；无 failed 步骤不渲染 |

---

## 1. 背景

事故与根因全部见复盘文档（TL;DR 表 + §1 事实链 + §2 五层失守 + §4 七类系统问题），本规格不再复述。二轮审核（R1–R4）已修正复盘的三处错误并补充精确短路机制，本规格的 RB-D2/D5/D6 按修正后结论立项。

**一句话**：把「参考图绑定」从提示词约定升级为链路级不变量——模型只能传引用（RB-D2/D8），失败必须可行动（RB-D3/D4），前置不满足永远不给 confirmed（RB-D5，10-12「终态没有 confirmed 表决权」的前置维度扩展），UI 的 ✗ 与 metrics 同源（RB-D6/D9）。

## 2. 与既有计划的关系（不重复造轮子）

| 本规格 | 复用对象 |
|---|---|
| RB-D2 | vendor `prepareArguments`（harness/execution/tools.ts `prepareToolCall`：prepare→validate→immediateError）——tool-result-quality-signal-gap.md §9.2 记录的四个未用能力之一，本仓首次启用 |
| RB-D3 | 10-13 规格 P1-1「静默错误 → 模型可自愈的显式报错」同款哲学在 apply-sidebar 端点的复用 |
| RB-D4 | 10-12 规格 §4/§5/§6 信号层的 throw 路径补丁（`_isError` 形参已预留未用） |
| RB-D5 | generation-gate 既有模式 + 10-13 P0-A 的前置维度扩展（P0-A 管「确认后是否真在生成」，RB-D5 管「生成前依赖是否满足」）；10-12「confirmed 只认正证据」家族 |
| RB-D9 | #395 观测指标同族（`pi_runtime_*` 命名）；静默降级家族告警纪律 |

## 3. 落地批次（每批独立可上、独立验收）

| 批 | 内容 | 风险 |
|---|---|---|
| **PR-A 止血** | RB-D2（prepareArguments 消毒）+ RB-D3（Nest 400）+ 提示词规则 4 收紧一句（先 `pnpm prompt:lint` 看余量）+ RB-D6②（持久警示） | 低：不改 execute 语义；消毒只删伪造参数 |
| **PR-B 契约** | RB-D7（fixture + 双端镜像测试）+ RB-D4（信号层 throw 分支） | 低：纯测试 + listener 分支 |
| **PR-C 门禁** | RB-D5（propose 前置，含 DTO 增字段）+ RB-D6①（dock 二次确认） | 中：fail-closed 有误伤面，靠 `sidebarImageCount===0` 出口与文案消解；上线后按 RB-D9 指标盯 |
| **PR-D 观测** | RB-D9（metrics + golden case + 告警）+ 生产取证（重放 G1，判据见下） | 低 |
| 缓议 | RB-D8（schema 引用化，破坏性）+ RB-D10 全量回归 | 单独评审 |

## 4. 验收判据（上线后生产取证，对齐 prod-deploy-verify 惯例）

1. 重放 G1（上传图 + 事故原句、无 @）：apply 成功且 dock 显示参考图缩略图；若 apply 仍失败 ⇒ propose 返回 `missing_refs` 且**零 GenerationRecord**。
2. GenerationRecord metadata：`referenceImageCount>0`、`refImageMode≠"none"`。
3. 模型话术不含「参考图会自动使用」类断言，除非节点 localRefs 非空（承诺对账）。
4. `pi_runtime_sidebar_ref_bind_total` 四 outcome 有数据；`nest_zod_reject_total` 有计数且告警零残留（400 化后 5xx 告警应消失）。
5. RB-D10 三条回归路径行为不退化。

## 5. 明确不做（反模式）

- ❌ 服务端「自动补挂」（二轮审核 R2 删除）：与 RB-D2 消毒功能重叠，且让模型对发生过什么无知觉，违背承诺对账；fail-closed + 可行动反馈让模型显式重试才是正解。
- ❌ 「propose 自动从会话上下文偷图」的隐式通道（复盘 §3.2）：破坏画布态 SSOT、违反 SM-D7 显式绑定哲学。
- ❌ 外部工具包装包（`@bytesbrains/pi-tool-awareness-gate` 等）：架构不匹配结论见 tool-result-quality-signal-gap.md §8.1，吸收设计、自建实现。
- ❌ 提示词长文：L6 预算硬约束 + 该模型对条文约束力已两次被生产证伪；条文只作兜底。
- ❌ 本批不动 schema 引用化（RB-D8）、不改 CORE/deferred 常驻集、不动 H8/V2 裸生成脚本（沿用 SM-D6 边界）。

## 6. 自检（写档时）

- [x] 每条决策可指回复盘的生产实证或二轮审核代码核对记录；无凭空虚构机制
- [x] 二轮审核修正（R1–R4）已全部反映：detail 已渲染、eval 路径、服务端补挂删除、短路机制精确化
- [x] 未引入跨包运行时依赖（RB-D7 走 fixture + 双端单测）
- [x] vendor 能力复用有源码落点（prepareToolCall 顺序、immediateError 携 message）
- [x] fail-closed 误伤面有出口（`sidebarImageCount===0` + 文案人工路径）
- [x] 硬表覆盖金标 G1/G2/G3 与回归红线；无 TBD
- [x] 与 09-16（SM-D4/D7）、10-12（信号层）、10-13（P0-A/P1-1）规格无冲突，均为扩展而非推翻
