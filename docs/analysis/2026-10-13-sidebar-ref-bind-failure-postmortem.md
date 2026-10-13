# 侧栏参考图绑定失败事故分析：apply_sidebar_attachments 500 与「带病出图」

> 日期：2026-10-13（事故时段 16:36–16:37 CST）
> 事故会话：`cmv6f48s20041p401qm0hxfkh`（画布 `http://119.29.173.89:8888/workflow/cmv6f48s20041p401qm0hxfkh`）
> 取证方式：生产 DB（AgentMessage.executionEvents / GenerationRecord.metadata）+ Nest 容器日志 + pi-runtime pod 日志，三源交叉
> 关联规格：`2026-09-16-agent-sidebar-media-propose-bind-design.md`（SM-D4/D7）、`2026-10-13-propose-confirm-evidence-and-clarify-matrix-design.md`、`docs/agent/tool-result-quality-signal-gap.md`

---

## 0. TL;DR

| 问题 | 结论 |
|---|---|
| ① 为什么失败 | 模型**自行编造**了 `attachments` 数组（`[{"source":"I1","target_node_id":...}]`，字段名全虚构），绕过「省略参数由服务端填充」的设计路径（SM-D4）。工具 schema 是空对象（`Type.Object({}, {additionalProperties:true})`）不拦截，请求到达 Nest 后被 Zod 校验拒绝（`id/mediaType/sourceKind/label` 全 undefined）→ 未处理异常 → **HTTP 500**。模型侧只收到 `http 500: Internal server error` 一句话，丧失自愈能力。 |
| ② 失败后平台能从上下文获取侧栏参考图吗 | **不能，没有任何这样的机制。** 生成请求的参考图唯一来源是 `node.data.localRefs`，其唯一写入方是 `apply_sidebar_attachments`（或用户手动在 dock 上传）。会话附件（vision 平面）与生成参考（画布平面）是两套完全分离的数据。模型「平台应该能从上下文中获取」是**幻觉**，生产实证：GenerationRecord `refImageMode:"none" / referenceImageCount:0 / refWire:"none"`，任务是纯文生图（t2i）。 |
| 暴露的系统工程问题 | 7 类，见 §4。核心不是「一次 500」，而是：**软约束无硬执行、跨服务契约断链、错误信息边界损耗、信号层盲区（throw 路径）、前置条件不校验的带病流水线、用户确认与失败可见性脱节、业务指标缺失**。 |

---

## 1. 事实链（生产实证，逐条可复现）

### 1.1 输入侧：参考图确实在上下文里

- 16:36:14 用户消息：「让这个小姑娘换上黑丝，更性感迷人」，附带 1 个侧栏上传图：
  `{id:"mv6feh37-c4sw1mht8", mediaType:"image", sourceKind:"upload", label:"mmexport1791260651494.jpg", url:"http://119.29.173.89:8888/api/uploads/..."}`
- Nest `streamConversation` 用 `validateSidebarAttachments`（Zod）校验通过 → 随 `turnContext.attachments` 下发 pi-runtime → `tc.attachments` = 完整实体。
- prompt manifest 实证：`sidebar:sidebar:15tok`（16:36:22）。
- 视觉平面也通：模型 thinking 原文「参考图 I1 是人物全身照」——说明 T1 直通/识图让模型**看得见**图。

### 1.2 工具序列（executionEvents 全文还原）

```
list_generation_scenes          ✓
upsert_media_node               ✓ → image-1791880588355-5（小姐姐 - 黑丝换装）
apply_sidebar_attachments       ✗  args: {"attachments":[{"source":"I1","target_node_id":"image-1791880588355-5"}],
                                          "mentioned_keys":["I1"], "node_ids":["image-1791880588355-5"]}
set_node_generation_params      ✓  guide_scene_id=g1_style_lighting
propose_generation              ✓  confirmed:true, reason:"answered"
```

**关键事实：模型传的附件对象字段名（`source` / `target_node_id`）是编造的**，与 `SidebarAttachmentSchema`（`id` / `mediaType` / `sourceKind` / `label` 必填，`url` 或 `text` 至少一非空）零交集。而真实实体就在 `tc.attachments` 里——**只要省略 `attachments` 参数，本次就会成功**。

**精确机制（二轮复核补充）**：execute 的回落实写是 `p.attachments?.length ? p.attachments : tc.attachments`——**非空的伪造数组优先于真实实体，且永不回落**。模型只要传了任何非空数组（哪怕字段全错），服务端填充路径就被短路。这是消毒点（S0-2）的精确靶子。

### 1.3 失败链路（Nest 日志 16:36:33）

```
apply_sidebar_attachments
  → POST /agent/internal/apply-sidebar-attachments（body.attachments = [{"source":"I1",...}]）
  → Nest AgentCanvasToolsService.applySidebarAttachments → validateSidebarAttachments（packages/shared）
  → ZodError: id/mediaType/sourceKind/label 四个必填字段全部 undefined
  → 未转换为 HttpException → Nest ExceptionsHandler → HTTP 500 "Internal server error"
  → runtime NestToolError: "nest /agent/internal/apply-sidebar-attachments http 500: Internal server error"
  → 模型看到的 tool_result content 就是这一句话（isError:true，无任何字段级细节）
```

### 1.4 带病出图（GenerationRecord 实证）

- 16:36:46 用户在画布节点 dock 点「生成」（`/answers` 与 GenerationRecord 同秒）——**此时 trace 里的红色 ✗ 已存在 13 秒，但没有任何机制把它和「确认」这个决策连起来**。
- GenerationRecord `cmv6fg4qa004sp401422ux0br` metadata：
  `"refImageMode":"none", "referenceImageCount":0, "referenceImages":[], "refWire":"none", "skippedMerge":true`；上游任务 URL 为 `t2i/task_...`（纯文生图）。
- 模型最终话术：「参考图 I1 会自动用于保持人物特征一致」——**对用户的虚假承诺**，与节点实际状态（localRefs 为空）完全脱节。
- 72h 窗口内该 ZodError 仅出现 1 次：这是 SM-D7「隐式全挂」（无 @ + 本轮上传图）路径的**首次真实流量触发**，评测集金标句（带 `@I1 @I2`）从未覆盖此形态。

---

## 2. 问题①根因：为什么模型会去「构造」attachments

直接原因是模型编造 payload；但「为什么会编造」是五层防线的全部失守：

| 层 | 应有约束 | 实际状态 |
|---|---|---|
| 设计约定 | SM-D4：「模型只传 node_ids/mode/mentioned_keys，**不填附件 JSON**，服务端从 turnContext 填充」 | 只写在规格文档里，**代码零强制** |
| 工具 schema | `attachments` 应为「引用」而非「实体」 | `Type.Object({}, {additionalProperties:true})`——**空对象 schema，任何东西都合法**；vendor `validateToolArguments` 对它形同虚设 |
| 提示词规则 | media_tool_policy 规则 4 要求走 apply_sidebar_attachments + mentioned_keys | 未禁止传 attachments；且该模型（agnes-2.5-flash）对软约束的遵从性**已被两次生产证伪**（见 10-13 规格 §1.2：「提示词层对该模型的约束力已被生产证伪两次，解法重心必须是机制编码」） |
| 工具 description | 「attachments may be omitted」 | 「可省略」对弱模型 ≈ 「随你」 |
| 模型心智 | 侧栏块呈现为「I1 芯片 + 识图摘要」 | 模型把「芯片」当「可传实体」——典型的符号实体化错误 |

**结论：这不是一次偶发的参数错误，是「提示词约定型契约」在弱模型 + 宽松 schema 下的必然失效。** 同类形态在仓库里有三次前科（tool-framework-audit 的 get_canvas_summary 静默答错、10-06 与 10-12 两次 propose 虚假确认），全部指向同一结论：**对结果有硬性要求的链路，约束必须编码进 schema / tool_result / hook，不能停留在条文。**

---

## 3. 问题②：失败后平台能否从上下文获取侧栏参考图——不能，且不应有隐式通道

### 3.1 代码事实：两个平面零桥接

```
vision 平面（会话态）：turnContext.attachments → tc.attachments → 模型可见（识图/直通）
画布平面（生成态）：node.data.localRefs → 前端生成请求（useNodeGeneration/sceneComposer/CanvasPage）→ Nest 生成链路
```

- `propose_generation` 只做 `pending_confirm` 状态转移（canvas-write.ts:349），不读附件、不写 refs。
- 生成请求的参考图**唯一**来源 = `node.data.localRefs`；`localRefs` 的写入方只有：`apply_sidebar_attachments`（mode=localRefs）或用户手动上传。
- 所以 apply 失败 ⇒ localRefs 空 ⇒ dock 无参考图条 ⇒ 纯文生图。模型操作记录里的猜想（「平台应该能从上下文中获取侧栏参考图」）没有任何代码支撑，是幻觉。

### 3.2 架构判断：不该加「propose 自动偷图」的隐式通道

隐式绑定看似兜底，实则有三个反作用：① 破坏画布态 SSOT——用户看不到、改不了突然出现的参考图；② 违反 SM-D7 已确立的显式绑定哲学（「隐式全挂只认本轮新上传的图」本身就是收窄后的特例）；③ 与 Codex/Claude 的共识相反——**模型的动作必须显式，harness 只做确定性执行**。

**正确形态是把「从上下文取图」放在 harness 层做确定性兜底**（见方案 S2-2）：检测到「本轮有侧栏图 + 用户意图是参考生成 + 节点 localRefs 为空」时，由服务端直接补挂一次（用 tc.attachments 实体，不问模型），并对用户可见。是「平台保证绑定结果」，不是「模型声称平台会绑定」。

---

## 4. 暴露的系统工程问题（harness 工程视角）

1. **软约束无硬执行**：设计文档的约定（SM-D4）没有落成 schema/门禁，靠模型自觉。弱模型场景下提示词约束力已被生产证伪两次。
2. **跨服务契约断链**：runtime TypeBox schema（放行任意对象）↔ Nest Zod schema（严格）之间存在「中间地带」；两侧各有单测，但没有「runtime 发出的 body 必过 Nest schema」的契约镜像测试。
3. **错误信息边界损耗**：Nest 把 ZodError 当未处理异常抛成 500，字段级细节（缺 id/mediaType/sourceKind/label + 正确用法）全部丢失；模型只拿到 "Internal server error"，**自我修复能力被剥夺**——它连「自己传错了」都不知道，只能猜替代路径。
4. **信号层盲区（throw 路径）**：`result-signal-wiring.ts` 的 listener 只读 `details._signal`，而 `_signal` 只在工具**正常返回**时由 `withWriteSignal` 注入；工具**抛错**路径（NestToolError）经 vendor `executeToolCall` catch 生成 error result，无 details ⇒ listener 直接跳过。本次生产实证：content 里没有任何信号行。⇒ tool-result-quality-signal-gap.md 规划的 P1 信号层没有覆盖本事故形态。
5. **前置条件不校验的带病流水线**（本事故最重的一环）：参考图挂载失败后，`set_node_generation_params`、`propose_generation`、dock 生成**全部照常成功**。propose/生成门禁只校验「节点是否 pending_confirm」（10-12 事故补的），不校验「用户意图需要的依赖是否满足」。与 10-12 事故同家族：**工具的成功话术不受事实约束**。
6. **用户确认与失败可见性脱节**：trace 里 16:36:33 就有的红色 ✗，与 16:36:46 用户的确认动作之间没有任何关联——用户看到 ✗ 仍然点了生成，因为 dock 的确认按钮不知道 ✗ 的存在。（二轮复核修正：trace 步骤的 `detail` **有**渲染——AgentExecutionTrace.vue `v-if="step.detail"`；真正的问题是 ① detail 内容不可行动——"http 500: Internal server error" 不告诉用户/模型哪里错、怎么修；② 失败步骤随流一闪而过，没有任何持久警示把它和后续的「确认生成」决策连起来。）
7. **业务指标缺失**：72h 仅 1 次，但没有任何「侧栏参考图绑定成功率」指标——本次是我手工翻 Nest 日志才发现的。一个只在 UI 停留 0.5 秒的红色 ✗，等于工程上的零信号。

---

## 5. 解决方案：把「参考图绑定」从提示词约定升级为链路级不变量

设计原则（对齐上游 pi-agent 源码能力 + Codex/Claude/WorkBuddy 已证实践）：

| 原则 | 行业/上游依据 |
|---|---|
| **引用不是值**：模型只能传芯片 key，实体永远服务端填充 | Codex apply_patch 的严格格式哲学；本仓 SM-D4 |
| **失败必须可行动**：错误信息携带修复路径 | Claude Code 工具错误全部带修复指引；本仓 10-13 规格 P1-1（媒体节点拒写 content 的同款哲学） |
| **前置条件不过不出图**：依赖缺失即 fail-closed | 本仓 generation-gate 既有模式；10-12 事故修复哲学（「终态本身永远没有 confirmed 表决权」的扩展：前置不满足永远不给 confirmed） |
| **承诺必须对账**：话术与节点实际状态一致 | 10-13 规格 P0-A（confirmed 必须带 reason/evidence）的同款扩展 |
| **用户可见 = 工程可见**：UI 的 ✗ 与 metrics/告警同源 | 本仓 silent-degrade 家族纪律 |

### 第 0 层｜止血（低风险，当周可上线）

- **S0-1 Nest 错误可行动化**：`applySidebarAttachments` 的 ZodError 转 `BadRequestException`，message 带缺失字段 + 正确用法（「请省略 attachments，由平台自动填充本轮侧栏附件」）。500 → 400 同时让 runtime 的 errorKind 从 upstream_5xx 变为 upstream_4xx（参数错，语义正确）。
- **S0-2 runtime 工具层消毒（用 vendor 原生 `prepareArguments`，本仓未用过的能力）**：`prepareArguments` 先于 `validateToolArguments` 执行——在其中丢弃形状不符的 `attachments`（无 id/mediaType/label 且无 url/text 即弃），execute 自然回落 `tc.attachments`；结果文案说明「已自动使用本轮侧栏附件（I1）」，让模型知道实际用了什么。**不改 execute 逻辑，消毒点在 vendor 管线上。**
- **S0-3 提示词规则 4 收紧（预算内改写，先跑 `pnpm prompt:lint` 看余量）**：「apply_sidebar_attachments 只传 node_ids 与 mentioned_keys，禁止自行构造 attachments」。注意：这是第 0 层的兜底条文，不是根治手段（见 §2）。
- **S0-4 前端失败步骤持久警示**：trace 的 failed 步骤 detail 已有渲染（`v-if="step.detail"`），但随流闪过、与后续确认动作无联动。把「本轮存在 failed 步骤」提升为 dock 确认区可见的持久状态（确认按钮旁一行警示），让红色 ✗ 与确认决策真正同窗。可行动化由 S0-1/S1-3 保证（detail 内容从 "http 500" 变成「缺 id/mediaType；请省略 attachments」）。

### 第 1 层｜契约硬化（防再发）

- **S1-1 schema 从「实体」改「引用」**：`attachments` 参数类型从任意对象数组改为芯片 key 数组（或直接移除该参数——破坏性变更排后期）；Nest Zod 同步收紧。参数层不再给「编造实体」留任何空间。
- **S1-2 跨服务契约镜像测试**：runtime 工具层对每个 Nest 端点发出 body 的构造，必须过 Nest 侧同款 Zod schema（共享 `packages/shared` 的 schema 做单测双端复用），消灭「runtime 放行 ↔ Nest 拒绝」中间地带。
- **S1-3 信号层覆盖 throw 路径**：`result-signal-wiring` 增加 `event.isError` 分支——从 error message 正则提取 nest 路径 + status：4xx ⇒ `{status:"failed", retryable:false, errorCode:"invalid_params"}` + content 追加可行动短句（≤30 token，自解释，如 `⚠️ 参数被拒：attachments 字段不符；请省略该参数重试`）；5xx ⇒ `upstream_5xx`。成功静默 0 token 的既有纪律不变。

### 第 2 层｜门禁与兜底（核心防线，直接消灭「带病出图」）

- **S2-1 propose_generation 前置校验（工具/门禁双侧，复用 generation-gate 哲学）**：runtime 调用时附带 `sidebarImageCount`（本轮 `tc.attachments` 中 image 数）；Nest 侧（SSOT 所在）校验「`sidebarImageCount>0` 且目标节点 localRefs 为空」⇒ 返回 `confirmed:false, reason:"missing_refs"` + 可行动文案（「参考图未绑定成功，请重试 apply_sidebar_attachments（只传 node_ids 与 mentioned_keys），或请用户在 dock 手动添加参考图」），**不出图**。误伤边界（用户明说纯创作）由文案出口消解。
- **S2-2 dock 直生路径二次确认（前端）**：画布点生成时，节点无 refs 但本轮有侧栏图 ⇒ 前端弹二次确认（「未检测到参考图，确定直接生成吗？」），把红色 ✗ 与确认决策真正连起来。（二轮复核收窄：删除原「服务端自动补挂」——S0-2 消毒已覆盖「模型编造参数」场景，自动补挂与之重叠且让模型对发生过什么无知觉，违背「承诺必须对账」；fail-closed + 可行动反馈让模型显式重试才是正解。）
- **S2-3 产出后对账**：扩展 vision self-refine loop——生成完成回流时，若本轮 mentionedKeys 有图而节点无 refs，产出打标「参考图未生效」并提示用户可重试。承诺（话术）与产出（事实）最终对账。

### 第 3 层｜观测与回归

- **S3-1 业务指标**：`sidebar_ref_bind_total{outcome="ok|invalid_params|upstream_error|short_circuit"}`、`propose_missing_refs_total`、`nest_zod_reject_total{endpoint}`——把「UI 里 0.5 秒的 ✗」变成可持续观测的序列。
- **S3-2 eval golden case**：本会话（无 @ + 上传图 + 换装口语）进 `services/pi-runtime/src/eval/golden-cases.ts`——SM-D7 隐式路径的首个真实流量形态；同时补「畸形 attachments 被消毒/拒绝后模型自愈」用例。
- **S3-3 告警**：apply-sidebar 5xx / ZodError 按静默降级家族纪律接入告警；上线后按 `prod-deploy-verify` 惯例跑一次真实换装对话，验收判据 = dock 出现参考图缩略图 + GenerationRecord `referenceImageCount>0`。

### 明确不做（反模式）

- ❌ 不加「propose 自动从会话上下文偷图」的隐式通道（见 §3.2）——兜底必须是 harness 显式执行 + 用户可见，不是模型幻觉的默许。
- ❌ 不安装外部工具包装包（`@bytesbrains/pi-tool-awareness-gate` 等）——架构不匹配的结论已在 tool-result-quality-signal-gap.md §8.1 论证，吸收设计、自建实现。
- ❌ 不在提示词里加长文——L6 预算硬约束 + 该模型对条文的约束力已两次被生产证伪；条文只作兜底，根治靠 S1/S2。

---

## 6. 与既有计划的关系（不重复造轮子）

- S0-1 是 10-13 规格 P1-1（媒体节点拒写 content）的**同款哲学在新端点的复用**：把静默错误变成模型可自愈的显式报错。
- S2-1 是 10-13 规格 P0-A（propose 只认正证据）的**前置维度扩展**：P0-A 管「确认后是否真在生成」，S2-1 管「生成前依赖是否满足」。
- S1-3 是 tool-result-quality-signal-gap.md §十 P1 信号层的**盲区补丁**（throw 路径）。
- S0-2 是 vendor `prepareArguments` 能力在本仓的**首次启用**（§9.2-2 记录的「四个未用能力」之一）。

---

## 7. 验收判据（上线后生产取证）

1. 重放本事故对话（上传图 + 「让这个小姐姐换上黑丝」无 @）：apply 成功且 dock 显示参考图缩略图；或 apply 失败时 propose 返回 `missing_refs` 且**零 GenerationRecord**。
2. GenerationRecord metadata：`referenceImageCount>0`、`refImageMode≠"none"`。
3. 模型话术不含「参考图会自动使用」类断言，除非节点 localRefs 非空（对账）。
4. `pi_runtime_sidebar_ref_bind_total` 有数据；ZodError 告警为零残留。
5. 回归：金标句（@I1 @I2 试衣）、纯文生图（无图）、dock 手动上传参考图三条路径行为不退化。

---

## 8. 二轮审核修正记录（2026-10-13，对照代码逐条复核后）

| # | 原表述 | 修正 |
|---|---|---|
| R1 | §4-6「reducer 有 detail/errorCode 字段但 UI 未渲染」 | `step.detail` **有**渲染（AgentExecutionTrace.vue `v-if="step.detail"`）；问题是 detail 内容不可行动 + 无持久警示。S0-4 已重写为「持久警示 + 与确认联动」。 |
| R2 | S2-2 含「服务端自动补挂」 | 收窄删除：与 S0-2 消毒功能重叠，且让模型对补挂无知觉、违背「承诺必须对账」。S2-2 只保留 dock 前端二次确认。 |
| R3 | S3-2 引用 `eval/golden-cases.ts` | 实际路径 `services/pi-runtime/src/eval/golden-cases.ts`。 |
| R4 | （新增）§1.2 精确机制 | 补充 `p.attachments?.length ? p.attachments : tc.attachments` 的短路语义——非空伪造数组永不回落。 |

复核方法：7 项承重结论逐条回源码核对（runtime canvas-write.ts / Nest controller+service / vendor harness/execution/tools.ts / result-signal-listener.ts / 前端 AgentExecutionTrace.vue / 09-16 规格 SM-D4 原文 / pi-runtime package.json）。其余结论（①②③④⑤⑦）全部确认无误。
