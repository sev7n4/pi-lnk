# 工具设计与调用缺口分析：结果质量信号层

> 基于 deepseek 建议的审视 + 对 `earendil-works/pi`（vendored `pi-agent-core`）源码与本仓库 `services/pi-runtime` 实际实现的核对。  
> 审查日期：2026-10-11。配套审计：`docs/agent/tool-framework-audit.md`（2026-10-05）。

---

## TL;DR 结论

deepseek 的**架构哲学是对的，具体落地建议一半是幻觉/抄错子系统**。

- ✅ 正确的内核：结果校验应放在 `after_tool` / `before_tool` **hook**，而不是塞进工具定义本身；上游 `after_tool` 确实能改写 `content`/`details`/`isError`，是注入质量信号的唯一正确切入点。
- ⚠️ **复核更正（原稿误判）**：deepseek 引用的三个包**真实存在**于 pi 社区生态（见第八节 §8.1）——原稿据"仓库内 grep 零命中"判为幻觉是错的。修正后的结论：它们是 **pi coding-agent CLI 的扩展**（`pi install npm:...` / `.pi/settings.json` 加载，hook `pi.on("tool_result")`），而本项目 pi-runtime 是自建 harness 服务（无扩展加载器、工具面是画布/媒体、hook 是 `harness.hooks.on("after_tool")`），**架构不匹配、不能直接安装**，且 awareness-gate 的启发式针对 bash/read/write 工具面对画布工具无效。吸收其设计、自建其实现，结论不变但理由更正。
- ❌ 仍然不成立的部分：`wrapToolWithBeforeToolCallHook` 不是真实函数（真实机制是 `harness.hooks.on("before_tool"/"after_tool", ...)`）；`isBashToolResult`/`isReadToolResult` 类型守卫只存在于 `vendor/.../coding-agent`，与本项目（画布/媒体工具，无 bash/read）**无关**。
- 📌 用户的"优先复用 vendor 原生 + 生态，不重复造轮子"原则，恰好意味着：**质量信号层应建在已有的 `after_tool` hook + `ToolTier` + `AgentToolResult.details` 之上**，而不是去引一个不存在的 npm 包。

---

## 一、deepseek 建议逐条审视

| deepseek 主张                                                                                                       | 真实情况                                                                                                                                                                                                                                                                                                                                             | 判定                   |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| 五步管道：参数预处理→Schema 验证→权限拦截→执行→结果后处理，并被 `wrapToolWithBeforeToolCallHook()` 包装                                       | 管道真实（`execution/tools.ts`：`prepareToolCall`→`validateToolArguments`→`before_tool` 决策→`executeToolCall`→`finalizeToolCall` 的 `after_tool` patch）。**函数名错**，真实机制是 `harness.hooks.on("before_tool"/"after_tool", ...)`                                                                                                                               | ⚠️ 哲学对、命名错           |
| `after_tool_results` 钩子在结果进入下一轮前触发                                                                                | 真实名是 `after_tool`（harness `HookMap`）/`afterToolCall`（agent-loop config），语义一致                                                                                                                                                                                                                                                                     | ✅                    |
| `@bytesbrains/pi-tool-awareness-gate`：拦截每个 tool_result，推断 Status/Confidence/Completeness/Truncation/Freshness 并注入 | **真实存在**（npm v1.0.4，pi coding-agent 扩展，hook `pi.on("tool_result")`）。但它是 coding-agent CLI 扩展生态：本项目 pi-runtime 无 `pi install`/`.pi/settings.json` 扩展加载机制，hook API 不同（`harness.hooks.on("after_tool")`），其启发式按 bash/read/write/browser 工具面编写，对画布工具无启发式价值。**结论：不能装，但设计值得吸收**（envelope 结构、短提醒格式、`details._awareness` 富化约定——与本文 `details._signal` 设计同构） | ⚠️ 原稿判"幻觉"有误，已更正     |
| `pi-agent-review`：LLM reviewer 检查 + secret 拦截 + 高风险审批                                                             | **真实存在**（npm v0.2.0，coding-agent 扩展，fail-closed：reviewer 不可用即 block 并扣留输出）。对本项目：① 架构不匹配（同上）；② per-tool-call LLM review 的延迟/成本不可接受（生成链路每步都过 reviewer）；③ fail-closed 会把生产生成链路绑架在 reviewer 可用性上。**不引入的结论成立，理由更正为成本/架构而非不存在**                                                                                                                        | ⚠️ 原稿判"幻觉"有误，已更正     |
| `@getpipher/vision`：检测主模型是否多模态，支持则原图直通                                                                            | **真实存在**（npm v0.5.2，capability-aware vision）。其原则恰是社区共识，且本项目已内建等价机制：`image-refine.ts` 把生成图作为 image block 回流给主模型（vision self-refine loop spec 2026-09-29），主模型 agnes 系支持图像输入 ⇒ 原图直通已成立，无 describe_image 二次委派场景                                                                                                                                      | ✅ 包真实；本项目已有等价实现，无需引入 |
| 工具定义应声明验证契约（如 `image_ref`/`generation_params`/`model_used`）                                                       | 真实缺口：本项目 `LnkpiTool` 的 `TDetails` 默认为 `unknown`，无每工具结构化 `details` 契约                                                                                                                                                                                                                                                                             | ✅ 真缺口                |
| 用 `isBashToolResult` 等类型守卫在 hook 里安全收窄 `details`                                                                  | 守卫只在 `coding-agent` 包内；本项目工具不是 bash/read，应改用已有的 `ToolTier` 分类                                                                                                                                                                                                                                                                                    | ❌ 抄错子系统              |
| 高风险工具（写/删/bash）写专门 hook + 结构化 `details`（exitCode/affectedFiles）                                                   | 部分映射：本项目高危是 `destructive`（delete_nodes/remove_edges）、`write_light`/`lifecycle`/`graph_batch`（canvas-write/upsert\_*/connect_nodes/arrange_nodes）、`gen`（run\_*，已门禁）。**结果侧（after_tool）无任何高危校验 hook**                                                                                                                                               | ✅ 真缺口（需转译到本项目工具分类）   |
| 中风险（图片/网络/查询）轻量 hook 查 image_ref 是否有效、响应是否空                                                                       | 真实缺口：image-refine 已取回 block，但无 after_tool 校验生成结果的 image_ref 并注入短信号                                                                                                                                                                                                                                                                               | ✅ 真缺口                |
| 低风险（读/列目录/时间）依赖内置机制即可                                                                                             | 与本项目 `read`/`present`/`skill` tier 低风险定位一致                                                                                                                                                                                                                                                                                                       | ✅                    |

**结论**：deepseek 的"风险分层 + 渐进增强 + hook 注入"方法论适用于本项目；但其给出的"现成包/现成函数"全都不能直接用。落地时要用 vendor 原生能力重建其描述的"质量信号"能力。

---

## 二、本项目的真实架构基线（已具备的能力）

**工具定义层**

- 上游 `AgentToolResult<T>`（`vendor/.../agent/src/types.ts:362-376`）：`content: (TextContent|ImageContent)[]`、`details: T`、`usage?`、`addedToolNames?`、`terminate?`。
- 上游 `AgentTool`：`label`/`prepareArguments`/`execute`/`replay`/`executionMode`（`types.ts:387-412`）。
- 本项目 `LnkpiTool = AgentHarnessTool<LnkpiToolContext> & { tier, summary?, deferred? }`（`tools/types.ts:71`）；`TDetails` 未指定 → 默认 `unknown`，**无每工具强类型 `details`**。
- `ToolTier` 8 值风险分类：`read`/`write_light`/`lifecycle`/`gen`/`graph_batch`/`destructive`/`ui_command`/`skill`/`present`（`tools/types.ts:11-25`）。注释明确"供 `before_tool` 审批 + metrics 分组；harness 不感知 tier"。

**Hook 接线层（真实代码）**

- `before_tool`：`index.ts:161` 生成闸门（`gate/generation-gate.ts`，run\_* HITL `pending_confirm`，fail-closed）；`gate/plan-gate-wiring.ts:37` C3 方案确认门（planPending + tier gated → block）。**职责＝权限拦截/审批**。
- `after_tool`：`index.ts:85` propose_generation 记录（读 `event.args.node_id`/`event.details.confirmed`）；`tool-result-budget.ts` 接 `after_tool` 做统一字符上限截断（默认 24k，`runtime-config.ts:81` 可关）。
- `transform_context`（`index.ts:117` 信任边界）、`before_payload`（`index.ts:128` 图片治理）。

**已补的护栏（不要重复造）**

- `scripts/verify-tool-contract.ts`：解析 vendored `HookMap`，断言 `before_tool`/`after_tool` 等 event 字段名未被上游改名（解决审计#1 升级门禁）。
- `services/pi-runtime/src/hook-contract.ts`：已书面记录隐式契约风险——`after_tool.details` 是 `JsonValue`（上游不保证结构）、`args` 是 `Record<string, JsonValue>`。

---

## 三、工具设计与调用的缺口（按你的 5 个关注点）

### 1. 工具定义是否定义了清晰的 `AgentToolResult` 接口？

- **上游接口是清晰的**（`content`/`details`/`usage`/`addedToolNames`/`terminate`）。
- **但本项目的消费层不清晰**：`LnkpiTool` 的 `TDetails = unknown`，每个工具 `execute` 返回的 `details` 是自由结构。例如 `canvas-write.ts:431/437` 返回 `{ ok, confirmed }`，`tool_search` 返回 `{ loaded }`，`image-refine` 根本不返回 `details`（只取回 image block）。
- **缺口**：缺少"每工具类别的 `details` 契约类型"（如 `GenerationResultDetails`、`CanvasWriteResultDetails`），也没有编译期/测试期校验。

### 2. 返回结构化的契约

- **现状**：`details` 被 ad-hoc 使用，无强制 schema，无"可被 hook 判读的观察信号"字段（status / confidence / coverage / truncated）。
- **缺口**：工具没有声明"哪些字段供结果校验使用"。这正是 deepseek 说的 `image_ref`/`model_used`/`generation_params`——本项目生成类工具应明确返回这些可观测信号。

### 3. Hook 扩展

- **现状良好**：`before_tool`（权限/审批）+ `after_tool`（记录 + 预算截断）已用 vendor 原生 hook，且支持多 listener（可叠加新 listener）。
- **缺口**：`after_tool` **只做截断，不做结果质量校验/信号注入**。没有"结果是否满足需求"的校验 hook。

### 4. 高风险工具编专门的 hook

- **现状**：高危 `gen`（`run_*`）有 `before_tool` 审批；但 `destructive`（`delete-nodes.ts:5` 明确"v1 免交互审批，误删率高再上 `before_tool` 审批"）、`write_light`/`lifecycle`/`graph_batch`（`canvas-write`/`upsert_*`/`connect_nodes`/`arrange_nodes`）**只有业务层逻辑，没有 after_tool 结果校验**。
- **缺口**：没有"写/删工具执行后，确认副作用真的发生（affectedNodes / confirmed / 实际删除数）"的专用校验 hook。deepseek 的 `affectedFiles`/`exitCode` 思路要转译为 `affectedNodeIds`/`confirmed`/`rowCount`。

### 5. 引入高质量信号为 tool_result，简短注入上下文，提升 agent 对结果的感知

- **现状**：仅 `tool-result-budget.ts` 在超限时往 `content` 尾部加 `…（已截断：省略 N 字符）` 标记。**没有任何 status/coverage/confidence 信号**。grep `confidence|awareness|signal|Status.*success` 在 `services/pi-runtime/src` 零命中（除 AbortSignal）。
- **关键澄清**：上游 `details` 字段注释是"for logs or UI rendering"——**模型感知的是 `content`，不是 `details`**。`details` 会进 `ToolResultMessage` 但模型不一定消费。因此：
  - **模型可感知的短信号 → 注入 `content`**（前置/追加一行）。
  - **结构化质量信号 → 写入 `details._signal`**（供 UI/metrics，不污染模型上下文）。  
    deepseek 把两者混为一谈（说"格式化为简短提醒前置到结果文本"）——前半句对（进 content），结构化的 Status/Confidence 那套应进 `details`。

### 3.6 全量工具排查表（2026-10-12 v2：49 个注册工具逐个核对）

> 本版对 v1 表做了**三处事实更正**（均为取证假阴性，教训见本节末）：①`remove_edges` 实际 tier=**write_light**（曾误归 destructive；第二个 destructive 是 `delete_memory`）；②`delete_nodes`/`remove_edges` **并非 details 为空**——它们经共享 helper `resultWithActions` 返回 `details:{actions}`（delete-nodes.ts:44、remove-edges.ts:36；按本文件 `details: {` 字面量 grep 会漏掉间接返回）；③注册工具总数为 **49**（generation.ts 以工厂产物产出 run_image/video/text/prompt_generation，按名字 grep 会漏计），且 `image-refine.ts` 是 run_image 的视觉自评回流模块、`present-result.ts` 是 present tier 的返回构造器——两者都不是独立注册工具。

| 工具 | tier | details 现状 | ①接口 | ②契约 | ④专门校验 | ⑤信号 | 分期 | 未纳入原因 |
|---|---|---|---|---|---|---|---|---|
| `run_image/video/text/prompt/audio_generation`（generation.ts 工厂产物） | gen | ⚠️ `{actions}`（run_image 另有视觉自评闭环回流） | ✅ | ❌ 缺 status/retryable/errorCode | ❌ | ❌（429/timeout 不可判读，8.3 病例） | **P0+P1** | — |
| `propose_generation`（canvas-write.ts） | write_light | ⚠️ `confirmed` 布尔（gate 消费中） | ✅ | ⚠️ | ❌ | ❌ | **P0**；replay 幂等评估→**P2** 第一工单 | — |
| `upsert_prompt_node`、`upsert_media_node`、`set_node_text`、`update_node`、`set_node_generation_params`、`attach_refs`、`apply_sidebar_attachments`、`apply_asset_to_node`、`save_node_to_asset_library`、`duplicate_node`、`upload_media_to_canvas`、`introduce_nodes_to_agent`（canvas-write.ts） | write_light | ✅ `{actions}`（PR #65 后统一） | ✅ | ⚠️ 缺 affected/affectedNodeIds 统一 | ❌ | ❌ | **P0+P1** | — |
| `connect_nodes`（canvas-write.ts） | graph_batch | ✅ `{actions}` | ✅ | ⚠️ | ❌ | ❌ | **P0+P1** | — |
| `grid_slice_image`（canvas-write.ts） | write_light | ✅ `{actions}` | ✅ | ⚠️ | ❌ | ❌ | **P0**（随文件顺带） | — |
| `delete_nodes`（delete-nodes.ts） | destructive | ✅ `{actions}`（PR #65 曾因 textResult 丢 actions 踩坑后修复） | ✅ | ⚠️ 缺 affectedNodeIds 计数 | ❌ | ❌ | **P0+P1** | — |
| `remove_edges`（remove-edges.ts） | **write_light** | ✅ `{actions}` | ✅ | ⚠️ | ❌ | ❌ | **P0+P1** | — |
| `arrange_nodes`（arrange-nodes.ts） | ui_command | ✅ `{ok, canvasCommands}` | ✅ | ⚠️ 缺 affected 计数 | ❌ | ❌ | **P0** | — |
| `render_canvas_view`（present-result.ts 为其返回构造器） | present | ✅✅ 最完整 `{ok, canvasCommands, truncated?}` | ✅ | ✅ | — | ✅ truncated 雏形已有 | **P0**（仅类型对齐） | — |
| `get_canvas_summary`（canvas-read.ts） | read | ❌ textResult → `details:undefined` | ✅ | ❌ 缺 coverage/scope | ❌ | ❌（静默答错病例） | **P0+P1** | — |
| `get_canvas_layout`、`get_node`、`get_generation_status`、`get_generation_diagnostic`、`list_generation_tasks`、`list_user_assets`、`list_model_options`、`list_generation_scenes`（canvas-read.ts） | read | ❌ `details:undefined` | ✅ | ❌ | — | ❌ | **P1**（层级通用信号，无专门契约） | — |
| `web_search`、`web_fetch`（web.ts） | read | ❌ `details:undefined`（content 截断已有 budget 兜底） | ✅ | ❌ | — | ❌ | **P1** 通用 | — |
| `read_document`（read-document.ts） | read | ❌ `details:undefined` | ✅ | ❌ | — | ❌ | **P1** 轻量 | — |
| `recall_memory`（memory.ts） | read | ❌ `details:undefined` | ✅ | ❌ | — | ❌ | 不纳入 | content JSON 自描述（命中与否 ok 字段可判读），无病例 |
| `save_memory`（memory.ts） | write_light | ❌ `details:undefined` | ✅ | ❌ | ❌ | ❌ | 不纳入 | 写失败模型可从 content 判读；无生产病例；P3 观察 |
| `delete_memory`（memory.ts） | **destructive** | ❌ `details:undefined` | ✅ | ❌ | ❌ | ❌ | 不纳入 | 低频 + 记忆可重建（可逆性可接受）；P3 观察项，由病例数据触发 |
| `todo_write`（todo.ts） | write_light | ✅✅ `{todo:{snapshot,diff}}` + `replay:"safe"` + `executionMode` | ✅ | ✅✅ 全仓样板 | ✅ | — | 模板参照 | — |
| `propose_plan`（propose-plan.ts） | ui_command | ✅ `{ok, plan, canvasCommands}` | ✅ | ✅ | ❌ | — | **P0**（仅类型对齐） | — |
| `ask_user`（ask-user.ts） | ui_command | ✅ `{ok, canvasCommands}` | ✅ | ✅ | ❌ | — | **P0**（仅类型对齐） | — |
| `focus_node`、`focus_nodes`、`undo`、`redo`、`open_image_editor`（ui-command.ts） | ui_command | ⚠️ 部分路径有 details | ✅ | ⚠️ | ❌ | ❌ | 不纳入 | 定位类无外部副作用；undo/redo 走本地栈自证，结果模型可从 content 判读 |
| `load_skill`（skill-tool.ts） | skill | ✅ | ✅ | ✅ | — | — | 不纳入 | 加载成败经 vendor 原生 `addedToolNames` 反馈 |
| `tool_search`（tiering.ts） | skill | ✅ `{loaded}` | ✅ | ✅ | — | — | 不纳入 | 未命中时返回全目录文本，自描述 |
| `cancel_generation`（generation.ts） | lifecycle | ✅ `{actions}` | ✅ | ✅ | ❌ | — | 不纳入 | 取消失败的后果=任务继续跑，可经 get_generation_status 观测补救 |

**勾选汇总**：**P0 契约侧 = 15 个工具 / 8 个文件**（gen 5 + propose_generation + write_light 12 + connect_nodes + delete_nodes + remove_edges + arrange_nodes + get_canvas_summary，另 render_canvas_view/propose_plan/ask_user 仅类型对齐）；**P1 信号层 = 按 tier 覆盖 gen / write_light / graph_batch / destructive / read 五个 tier**（read 仅通用信号无专门契约）；**不纳入 14 个工具**，原因集中三类：结果自描述（recall/save_memory、focus×2、undo/redo、open_image_editor、tool_search、load_skill、cancel_generation）、无生产病例（delete_memory）、可逆性兜底已足。

> **方法论留痕**：本轮三处更正同源于"用 `grep 'details: {'` 字面量判断间接返回"——与 AGENTS.md 记载的 `git show | grep` 假阴性同家族。判据固化：**判断某工具是否返回结构化 details，必须追其 return 语句调用的 helper（resultWithActions/textResult），不能只 grep 本文件字面量。**

---

## 四、推荐实现：工具结果质量信号层（vendor 原生，不引外部包）

> ⚠️ **本节为 2026-10-12 重建版**：原文因并发窗口回写丢失（本文件 untracked 无 git 历史、本机无可用快照），以下按会话记录要点重写；实施细节以 **§十（分阶段范围）** 为权威，冲突处以 §十 为准。**教训与防复发措施见文末附记。**

1. **架构选型**：在既有 `after_tool` hook 上叠加一个 vendor 原生"质量信号 listener"（`harness.hooks.on("after_tool", …)`），不引外部扩展（§8.1 三包不可装的理由）；注册位置必须在 `tool-result-budget` **之后**（8.2-2 链式 replace 语义，否则看不到最终截断状态），并给 `handler_error` 加观测防静默死亡。
2. **分层治理**：按 `ToolTier` 分层——信号层只治理 `gen / write_light / graph_batch / destructive / read` 五个 tier；`present / skill / ui_command / lifecycle` 低风险跳过；被拦/参数错类结果不覆盖（8.2-1，其 block reason 文本模型可感知）。
3. **信号信封**：`ToolResultSignal = { status: "ok"|"partial"|"failed"; retryable?: boolean; truncated?: boolean; coverage?: …; errorCode?: … }`。**双通道分工**：模型可感知的短告警（≤30 token，自解释格式如 `⚠️[gen] 429 retryable`）注入 `content`；结构化全量写 `details._signal`（0 token，供 UI/metrics）。成功静默（0 token）。
4. **契约先行**：工具侧先把 `TDetails` 从 `unknown` 收紧为显式子类型（todo_write 为样板）+ 配套 `isGenDetails()` 等类型守卫（命名对齐 vendor coding-agent 惯例）+ `verify-tool-details-contract.ts` 机检（对齐 `verify-tool-contract.ts` 模式）——hook 消费 `details._signal` 的类型前提。
5. **运维三件套**：kill switch `PI_RUNTIME_RESULT_SIGNALS=off`（off = 不注册 listener，逐字节现状）；metrics `pi_runtime_result_signal_total{tier,status}`（兼活性探针）；eval golden case（429→retryable、写缺 confirmed→重试、截断→truncated）。规则启发式判定，禁 per-call LLM（成本 + fail-closed 风险）。

---

## 五、不要做的事（反模式）

1. ❌ 不安装 `@bytesbrains/pi-tool-awareness-gate` / `pi-agent-review` / `@getpipher/vision`——包真实存在但均为 pi coding-agent CLI 扩展（`pi.on("tool_result")` API），本项目 pi-runtime 是自建 harness（`harness.hooks.on("after_tool")`），无扩展加载机制、工具面不同、启发式无针对性；且 awareness-gate 属外部供应链依赖（官方即注明"review the source before installing"）。吸收其设计，自建其实现。
2. ❌ 不把 `isBashToolResult` 那套 coding-agent 守卫搬过来——本项目工具不是 bash/read，已有 `ToolTier` 更合适。
3. ❌ 不在工具 `execute` 内部塞校验逻辑——那是 deepseek 强调要避免的"把业务逻辑拆进 hook"的反面；工具只产出结构化结果，校验交给 `after_tool` 信号层（hook 是增强层不是补丁层）。
4. ❌ 不把结构化 Status/Confidence 全量塞进 `content`——会污染模型上下文；结构化的进 `details`，只有短告警进 `content`。

---

## 六、渐进路径（对齐"风险分层 + 渐进增强"）

1. **阶段 0（已具备）**：`AgentToolResult` 接口、`ToolTier` 分类、`after_tool`/`before_tool` 接线、`verify-tool-contract.ts` 升级门禁。
2. **阶段 1（补契约）**：为 `gen`/`write`/`destructive` 三类定义 `details` 子类型 + `verify-tool-details-contract.ts` 机检。低风险工具维持 `details: undefined`。
3. **阶段 2（高风险 hook）**：为 `destructive`/`write_light`/`lifecycle`/`graph_batch` 加 after_tool 副作用确认校验（不发即告警），并在 `before_tool` 为 `destructive` 补回用户确认（delete-nodes 当前是延后的）。
4. **阶段 3（质量信号注入）**：统一的 `after_tool` 信号 listener，按 tier 注入 `details._signal` + 异常时 `content` 短标记；复用 `capToolResult` 截断结论。
5. **阶段 4（按需扩展）**：发现某中风险工具频繁出错（如 web 空响应）再为其加专项校验；不预先全量铺开。

> 注：deepseek 原"阶段 3 = 安装 `@bytesbrains/pi-tool-awareness-gate`"在此替换为"基于 vendor 原生 after_tool 自建信号层"——这是本项目唯一合规且可持续的路径。

---

## 八、复核修订（2026-10-11 深夜二次审查）

> 以"不轻易采信自己"的标准对上文逐条复核。本节记录**更正、新核实的硬事实、原报告缺失的补充项**。与上文冲突处以本节为准。

### 8.1 更正：三个包真实存在（原稿误判"幻觉"）

原稿据"仓库内 grep 零命中"判 `@bytesbrains/pi-tool-awareness-gate` / `pi-agent-review` / `@getpipher/vision` 为幻觉——**方法论错误**：仓库零命中只证明本项目未用，不证明包不存在。经 web 检索（npm / pi.dev）证实三者均为真实发布的 pi 社区扩展：

| 包                                     | 版本                       | 实况                                                                                                                               | 对本项目                                                                                                                                      |
| ------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `@bytesbrains/pi-tool-awareness-gate` | v1.0.4（nandal，~249/mo）   | hook `pi.on("tool_result")`，启发式推断 Status/Confidence/Completeness/Truncation/Freshness，短提醒前置注入 + `.awareness/envelopes.log` 结构化留痕 | 不可装（coding-agent 扩展 API + bash/read 工具面启发式），**设计需吸收**：envelope 结构、`details._awareness` 富化约定（与本文 `details._signal` 同构）、excludedTools/阈值配置化 |
| `pi-agent-review`                     | v0.2.0（ejmorgan，~137/mo） | LLM reviewer 两段审查（调用前+输出后）+ secret hard-deny + 用户审批 nonce 门控，**fail-closed**（reviewer 挂即 block+扣留输出）                             | 不可装：per-call LLM review 延迟/成本不可接受，fail-closed 会绑架生成链路可用性                                                                                  |
| `@getpipher/vision`                   | v0.5.2（rz1989，~1332/mo）  | capability-aware：主模型多模态则原图直通（describe_image 工具直接隐藏），纯文本才委派视觉模型                                                                   | 原则已内建：`image-refine.ts` image block 直通 + 主模型 agnes 系支持图像输入，无需引入                                                                           |

**教训沉淀**："依赖是否存在"必须 web 检索验证，不能拿仓库 grep 当存在性判据。

### 8.2 新核实的硬事实（vendor 源码逐行确认）

1. **`after_tool` 不覆盖"被拦/参数错"类结果**（`drive/tools.ts:448,486-488`）：工具不存在、schema 校验失败、`before_tool` block、`stopReason=length` 的截断调用，都走 `outcomeFromFinalizedCall` 直接 publish，**不经过 after_tool**。⇒ 信号层覆盖边界要写清楚：这类结果自带 block reason 文本（模型可感知），无需信号层；信号层只治理"真实执行过"的工具结果。
2. **多 listener 是链式 replace 语义，不是并行**（`harness/hooks.ts:294-335`）：按注册顺序串行，每个 listener 收到前一个的 patch 结果；单 handler 抛错被隔离（`reportError` → `handler_error` 事件，fail-soft 不炸 run）。⇒ 三条设计约束：
   - 信号 listener 必须注册在 `tool-result-budget` **之后**（否则看不到最终截断状态）；
   - `details._signal` 写入必须展开已有 details（field-level replace、无深合并）；
   - handler 抛错**静默隔离** ⇒ 必须注册 `handler_error` 观测/counter，防信号层静默死亡（本项目"静默降级"家族事故的已知形态）。
3. **`details` 不进 provider payload 有代码实锤**（`ai/src/api/bedrock-converse-stream.ts:1050-1056`：payload 只取 `toolUseId`/`content`/`isError`；`transform-messages.ts` 只做 ID 规范化与图片降级）。上文"模型感知的是 content 不是 details"成立，由推断升级为实证。

### 8.3 生产病例映射（原报告缺失：缺口不只是事务性梳理，是已知事故的根因家族）

| 已知生产病例（见 .workbuddy 台账）                                                    | 对应缺口                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `agnes-video-2.5-flash` 近 48h 失败 19/成 0，429 免费档限流但 `errorCode=unknown` 未分类 | 信号缺口实例：模型无法区分"限流应退避"vs"模型坏了"⇒ 信号层应把 429/timeout 归类为**可重试**信号             |
| cogvideox 两笔 `upstream_timeout`（45s 代理黑洞）                                  | 同上：timeout 单独分类后模型能感知"可重试"而非改 prompt 白烧积分                                |
| `get_canvas_summary` 凑答案导致**静默答错**（素材库 18 图答成空）                            | "部分替代⇒无信号"病例：读类工具结果缺少 scope/coverage 信号，模型拿局部当全量                         |
| 弱模型直调延迟工具吃 "Tool X is unavailable"（tiering.ts 文件头实录）                       | 属 8.2-1 边界：被拦结果不经 after_tool，其 block reason 文本本身就是注入点——已在 before_tool 治理 |

### 8.4 实施补充约束（原报告阶段计划遗漏）

1. **Prompt 预算硬约束**：系统提示当前 3197/3200（余量 3 字符）。⇒ 信号格式必须**自解释**（如 `⚠️[write] affected=0 可能未生效`），不能依赖在 prompt-registry 加"如何解读信号"的规则——加一个字都爆预算。如确需教模型解读，走 skill 而非 prompt 规则。
2. **Token 成本纪律**：成功静默（0 token）、异常才注入 content（每条约 15-30 token）；结构化信号进 `details` 成本为零。不用 LLM 推断 confidence（per-call 成本不可接受）——用规则启发式（details 字段在不在、isError、截断标记），与 awareness-gate 的 heuristic 路线一致。
3. **Kill switch 惯例**：对齐 `PI_RUNTIME_TOOL_TIERING=off` / tool-result-budget 开关模式，新增 `PI_RUNTIME_RESULT_SIGNALS=off`（off = 不注册 listener，行为与现状逐字节一致）。
4. **Eval 集成**：质量信号层必须有 golden case（复用 `eval/golden-cases.ts` + driver），至少覆盖：写工具缺 confirmed → 信号注入且模型重试；gen 工具 429 → 可重试信号；截断 → truncated 信号。无 eval 的信号层等于又一个"没人盯的静默层"。
5. **Metrics**：注册 `pi_runtime_result_signal_total{tier,status}` counter（对齐现有 metrics 惯例），同时充当"handler 没静默死"的活性探针。
6. **`destructive` 审批补回维持"数据驱动"**：delete-nodes 已有 undo/redo 兜底 + 单次上限 50，是否补 before_tool 审批应由误删率 metrics 触发，不作为信号层批次的默认动作（原稿阶段 2 表述过强，收紧）。

## 九、上游一致性审计：能否持续吃 vendor 升级红利（2026-10-12）

> 用户追加关注点：工具定义、hook 定义是否充分复用上游接口规范/契约规范/命名规范，保持一致性，从而在 upmerge 时持续吃升级红利。以下逐项实证（vendor 快照 v0.85.1 · d981de1 + services/pi-runtime 源码）。

### 9.1 判定：一致性基础是好的，红利通道已经打通

1. **双通道架构清晰**（`VENDORED.md` D-γ' 纪律）：运行时走 npm 固定版本 `@earendil-works/pi-agent-core@0.85.1` + `pi-ai@0.85.1`（`services/pi-runtime/package.json`）；`vendor/` 是只读参考镜像，明文禁止改 vendor 迁就业务、patch 须登记 `.patches/NNNN-*.patch`、upmerge 触发条件 = 上游 ≥3 minor 季度评审。⇒ 升级 = 改 package.json 版本号 + 按序重放 patch，通道本身健康。pi-runtime 源码零处 import vendor 路径（仅 app.ts 版本描述字符串提及），无隐蔽耦合。
2. **类型零重定义**：`LnkpiTool = AgentHarnessTool<LnkpiToolContext> & { tier; summary?; deferred? }`（tools/types.ts:71）是**继承扩展**而非平行定义；`AgentToolResult` 直接 type-import 自 npm 包；hook 注册全部走 vendor 泛型 `HookMap`（`harness.hooks.on("after_tool", …)` 事件载荷类型自动推断），且有 `hook-contract.ts` 机检防 implicit contract 漂移（审计 #1 已闭环）。上游给 `HookMap`/`AgentToolResult` 加字段时，我们**编译期即感知**——这就是"吃升级红利"的技术前提，已满足。
3. **hook 面覆盖 5/12**（after_tool · transform_context · before_payload · before_tool · before_run_end），全部用 vendor 类型化 API，无一处裸 `as` 强转（index.ts 注释明示"不再 as 强转"）。

### 9.2 三个漂移点（升级红利的实际风险，需纳入治理）

| # | 漂移点                                                                                                                                                                     | 证据                              | 风险与处置                                                                                                                                                                                        |
| - | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | **`LnkpiTool.deferred` 与 vendor `AgentHarnessStreamOptions.deferred` 同名异义**（前者=渐进加载延迟注入 schema，后者=provider 异步续生成）                                                       | tools/types.ts:79-83 注释已自警"勿混淆" | 若上游未来给 `AgentTool` 引入同名语义字段，继承类型会静默撞车。**低频但必炸**；P2 批次改名（如 `lazySchema`），一次性成本极低                                                                                                              |
| 2 | **vendor 工具能力面采纳率低**：`replay` / `executionMode` / `prepareArguments` / `terminate` 四个可选能力，全仓只有 todo.ts 用了 `executionMode:"sequential"` + `replay:"safe"`（todo.ts:97-98） | grep 全 tools/ 目录                | 最要紧的是 `replay`：vendor 语义 = "持久意图已落库但结果未知"的崩溃恢复策略。**propose_generation / canvas-write 正是这个语义**（意图已记录、结果未确认），未标注 ⇒ 会话崩溃恢复时这些调用无法安全重放。`prepareArguments` 可吸收老会话回放的历史脏参数；`terminate` 未用（暂无需求，不动） |
| 3 | **`ToolTier` 是本项目自有分类**，vendor 无对应概念（vendor `Tool` 基接口只有 name/description/parameters/constrainedSampling，无 annotations/权限位）                                             | ai/src/types.ts:517-522         | 现状判定为**正确设计**（应用层叠加，不侵入上游类型）——但须守一条纪律：未来上游若引入工具元数据机制，tier 应迁移映射而不是并行第二套；tier 定义文件已加注释固化这一点                                                                                                   |

### 9.3 边界拓宽：原报告漏掉的四个 vendor 原生面

1. **压缩会丢信号**（新边界）：`after_tool` 注入 content 的短告警属于消息体，`before_compaction` 压缩后**不保证保留**（可能被摘要吞掉）。若需要"跨压缩持久"的信号（如"本轮 gen 已消耗 N 积分"），要么走 `transform_context` 持续重注入（我们已有该 hook 的 trust-boundary 先例），要么明确接受丢失。规格阶段必须给每个信号标注**生命周期**：turn 级（默认，接受压缩丢失）vs session 级（需 transform_context 通道）。
2. **checkpoint / invocation memo 是现成的长时生成恢复机制**：`AgentHarnessToolInvocation.getMemo/setMemo` + `onUpdate(…, {checkpoint:true})`（harness/types.ts:84-105）。视频/图片生成动辄分钟级，中途崩溃重放正是该机制的目标场景——P3 候选，不必自建"生成中断恢复"轮子。
3. **未用的 7 个 hook 事件**：`after_response`（检查 settled assistant message——模型侧质量信号如空回复/格式坏）、`before_request`（per-attempt 重试观测）、`before_compaction`/`before_navigation`（信号生命周期控制点）、`before_run`/`before_run_end`（已用后者）。信号层 V1 不用，但规格里应留"after_response 模型侧信号"为 V2 候选。
4. **coding-agent 包的守卫模式可参考**：`isBashToolResult` 等类型守卫在 vendor `packages/coding-agent` 真实存在（此前已核实），我们不用其 CLI，但"P0 契约类型化后配套 isXxxDetails 守卫"直接照此模式实现，命名对齐上游惯例。

## 十、分阶段实施：范围边界 + 优先级排序（规格铺垫）

> 排序原则：①契约先行（hook 读 `details._signal` 需类型保证）→ ②信号注入 → ③债务清理 → ④按需扩展。每阶段给**明确的文件范围、验收判据、非目标**，可直接作为下一阶段 spec 输入。

### P0 · details 契约类型化（最高 ROI，先做）

- **范围**（精确 8 个文件，其余 41 个文件不动；逐工具×逐关注点×逐分期映射见 §3.6）：`gen`（generation.ts、image-refine.ts）+ `write_light`（canvas-write.ts、arrange-nodes.ts、present-result.ts）+ `destructive`（delete-nodes.ts、remove-edges.ts）+ `read` 大类中的 get_canvas_summary（canvas-read.ts，已有静默答错病例）。present-result 与 ask-user/propose-plan 仅类型对齐、不重做。
- **动作**：tools/types.ts 新增 `ToolResultSignal`（`{ status: "ok"|"partial"|"failed"; retryable?: boolean; truncated?: boolean; coverage?: …; errorCode?: … }`）与每类 details 子类型；各工具 `TDetails` 从 `unknown` 收紧为显式泛型（todo.ts 已是样板：`AgentHarnessToolUpdateCallback<{todo:{snapshot,diff}}>`）；配套 `isGenDetails()` 等守卫（命名对齐 coding-agent 惯例）。
- **验收**：tsc 编译期强制 + 新机检脚本 `verify-tool-details-contract.ts`（对齐 `verify-tool-contract.ts` 既有模式）+ golden case 三条（429→retryable、写缺 confirmed→重试、截断→truncated）。
- **非目标**：不改任何工具执行逻辑、不加 hook、不注入 content——纯类型层，回归风险≈0。
- **直接收益**：agnes 429 / cogvideox timeout 病例的分类地基；UI/审计可开始消费结构化信号。

### P1 · after_tool 信号 listener（第二优先）

- **范围**：新文件 `tools/result-signals.ts` + index.ts 注册（**必须排在 capToolResult 之后**，8.2-2 链式语义）+ `PI_RUNTIME_RESULT_SIGNALS` kill switch + `pi_runtime_result_signal_total{tier,status}` metrics + handler_error 观测。
- **边界**：只处理 `gen / write_light / graph_batch / destructive / read` 五个 tier（connect_nodes 属 graph_batch，随批覆盖）；`present / skill / ui_command / lifecycle` 跳过（低风险，读了也不修）；被拦/参数错类结果不覆盖（8.2-1，其 block reason 自带可感知文本）。
- **注入纪律**：成功静默 0 token；异常才注入 content（≤30 token、自解释格式，prompt 预算 3197/3200 硬约束）；结构化全量进 `details._signal`（0 成本）；规则启发式判定，禁 per-call LLM。
- **验收**：golden case 全绿 + 生产探针（metrics 非零 + handler_error 为零）+ off 开关逐字节回退验证。

### P2 · 一致性债务清理（第三优先，可与 P1 并行小批量）

- **范围**：①`LnkpiTool.deferred` 改名 `lazySchema`（全仓 1 处定义 + 少量消费点，grep 可枚举）；②gen/write_light 类工具补 `replay` 策略标注（需先评估：生成类工具重放的副作用安全性——积分扣减幂等性是前置问题，**该评估本身是 P2 的第一张工单**）；③tier 迁移纪律注释固化到 tiering.ts。
- **非目标**：delete-nodes 审批不进本批（8.4-6 数据驱动）；`terminate`/`prepareArguments` 无需求不预接。

### P3 · 按需扩展（观察触发，不排期）

- 信号跨压缩持久化（transform_context 重注入通道）——触发条件：出现"压缩后丢失关键告警导致重复犯错"的实际病例；
- 长时生成 checkpoint/invocation memo 恢复——触发条件：视频/生成类崩溃重放需求立项；
- `after_response` 模型侧信号——触发条件：空回复/格式坏病例进入 metrics 视野；
- destructive 审批——触发条件：误删率 metrics 超阈值。

### 依赖与排序总图

```
P0 契约类型化 ──► P1 信号 listener ──► P3 按需（压缩持久化/after_response）
   │                                   
   └──► P2 一致性债务（deferred 改名 / replay 标注）──► P3（checkpoint 恢复依赖 replay 评估结论）
```

P0→P1 是硬依赖（hook 消费类型）；P2 相互独立可插队；P3 全部由 metrics/病例数据触发。按此铺垫，下一阶段每批可直接展开为独立 spec（范围/验收/回滚三件套已在各节给出）。
