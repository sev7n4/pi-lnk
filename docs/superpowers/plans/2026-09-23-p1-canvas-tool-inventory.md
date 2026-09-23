# P1 · Canvas 工具盘点与迁移分期（2026-09-23）

> 定位：P1（Atomic-First）的第一步——**工具清单盘点**。本文只做事实盘点与分期，不含实现。
> SSOT：`services/agent-runtime/app/tools/tool_registry.py`（placement/tier）+ `definitions.py`（structured tool 声明）。
> 生成方式：从上述两个文件解析生成（非手抄），可与代码逐条对照。

> **路线修订（2026-09-24，已定稿）**：分期顺序经产品/架构评审后重排，见 `2026-09-24-p1-roadmap-revision.md`（用户拍板「都按默认」）。要点：P0=UI_COMMAND → P1=B-5 生成闭环（B-3 并入，HITL 走 harness Gate 重构）→ D-η' skill 缺口核查；**B-6/B-7 显式关闭**（graph_node/destructive 工具均不向 Explore 界面暴露，无迁移对象）；B-4 降级为使用率数据决策。本档 §2 清单仍为 SSOT，§3 顺序以修订档为准。

> **状态更新（2026-09-24，#13 收尾）**：① B-1 批次**关闭**——7 个 read 已上线（PR #1，pi-runtime 0.0.4+，生产 e2e 已验 `get_canvas_summary` 真实调用）；`get_image_edit_capabilities` / `list_public_assets` 按 `DEFERRED_TOOL_NAMES` 决策**不迁**（老链路同样未向模型暴露，行为对齐）。② B-2（写×13）按计划推进；其中 `introduce_nodes_to_agent` 同属 DEFERRED，默认**注册但不暴露**（对齐老链路）。③ UI_COMMAND×5 通道设计定案见 `2026-09-24-ui-command-canvas-action-design.md`。④ K4 首轮基线已产出（runtime-compare --suite，有效 2 用例 diff 2/2——根因即缺写工具，作为 B-2 验收对照基线）。

## 0. 结论速览

| # | 事实 | 证据 |
|---|---|---|
| 1 | 老链路向 LLM 暴露 **40 个 Explore 工具**（EXPLORE 35 + UI_COMMAND 5），另有 **7 个 graph_node 专用**工具不进 Explore 界面（总计 47 条登记） | `tool_registry.py` TOOL_PLACEMENTS |
| 2 | 其中 **46 个**以 structured tool 形式在 `definitions.py` 声明（含 5 个 UI 命令） | `definitions.py` |
| 3 | **pi-runtime 当前注册 0 个工具** | `services/pi-runtime/src/index.ts:15` → `new SessionManager()`；`session-manager.ts:86-89` 默认 `tools = []`；`:117` 直接透传 `tools: this.tools` |
| 4 | pi-runtime 建会话时**不传 system prompt、不注入画布上下文** | `apps/server/src/agent/agent.service.ts:428` → `client.createSession(sessionId)`（无第二参） |
| 5 | active 分支 healthz 通过即**直接返回**，不回落老链路 | `agent.service.ts:202-219`（`yield` 完即 `return`） |

**由此得出一条必须明确的现状**：生产 `PI_RUNTIME_MODE=active` 下，**纯文本对话走 pi-runtime 正常，但画布工具调用不可用**（模型手上没有任何工具）。这不是故障，而是 P1 的起点——工具迁移完成前，画布相关能力不应认为已切换。

> 交叉印证：11:17 画布测试时 `upsert_media_node` 等工具"看起来正常"，是因为当时 B4 源码被覆盖、请求实际仍走老 LangGraph runtime；`2b636e7` 恢复 B4 之后，这一点才暴露出来。

## 1. 现状接线（逐条证据）

| 环节 | 事实 | 位置 |
|---|---|---|
| pi-runtime 工具注入 | 构造 `SessionManager()` 未传 tools，构造函数默认 `[]` | `services/pi-runtime/src/index.ts:15`、`session-manager.ts:86-89` |
| 工具透传 | `AgentHarness.create({ …, tools: this.tools, toolContext: {} })` | `session-manager.ts:117-118` |
| 会话创建 | Nest 只传 sessionId，不需要 systemPrompt | `agent.service.ts:426-433` |
| active 决策 | `piMode === 'active' && await piClient.healthz()` → 流式透传 pi 事件后 `return` | `agent.service.ts:200-219` |
| shadow 镜像 | 同一 prompt 镜像到 `shadow-{sessionId}`，输出不进 UI，仅记日志 | `agent.service.ts:220-223`、`624+` |
| 事件归一 | `tool_execution_start/end` → `tool_call`/`tool_result`（UI 侧形态） | `apps/server/src/agent/pi-runtime/pi-events.ts:27-88` |
| 画布动作缺口 | 注释明写「canvas_action 提取待 pi 侧 custom tool 事件形态定型后补（Round 5）」 | `agent.service.ts:571-572` |
| 老链路工具实现 | `_all_tool_specs(client)` 以 `NestCanvasClient` 代理到 Nest HTTP 接口 | `definitions.py:312+`、`nest_client.py` |

## 2. 工具全清单（47 条，按 tier 分组）

### 2.1 分层汇总

| 层 | 枚举 | 数量 | 代表 |
|---|---|---|---|
| 读 | `read` | 9 | `get_canvas_layout`、`get_canvas_summary`、`get_generation_diagnostic` … |
| 轻写 | `write_light` | 13 | `apply_asset_to_node`、`apply_sidebar_attachments`、`attach_refs` … |
| 生命周期 | `lifecycle` | 3 | `cancel_generation`、`cancel_platform_fallback`、`confirm_platform_fallback` |
| 工作流 IO | `workflow_io` | 5 | `import_workflow`、`instantiate_workflow_template`、`match_workflow_templates` … |
| 导出 | `export` | 1 | `export_media_package` |
| 生成 | `gen` | 2 | `run_image_generation`、`upscale_image` |
| 图内批处理 | `graph_batch` | 8 | `add_nodes_batch`、`apply_layout_ops`、`arrange_nodes_along_edges` … |
| 未分层 | `—` | 6 | `focus_node`、`focus_nodes`、`open_image_editor` … |

placement 分布：`explore` 35, `ui_command` 5, `graph_node` 7

### 2.2 明细

| 工具名 | placement | tier | exposure | definitions.py | pi-runtime |
|---|---|---|---|---|---|
| `get_canvas_layout` | explore | read | core | ✓ | ❌ 未注册 |
| `get_canvas_summary` | explore | read | core | ✓ | ❌ 未注册 |
| `get_generation_diagnostic` | explore | read | core | ✓ | ❌ 未注册 |
| `get_generation_status` | explore | read | core | ✓ | ❌ 未注册 |
| `get_image_edit_capabilities` | explore | read | deferred | ✓ | ❌ 未注册 |
| `get_node` | explore | read | core | ✓ | ❌ 未注册 |
| `list_generation_tasks` | explore | read | core | ✓ | ❌ 未注册 |
| `list_public_assets` | explore | read | deferred | ✓ | ❌ 未注册 |
| `list_user_assets` | explore | read | core | ✓ | ❌ 未注册 |
| `apply_asset_to_node` | explore | write_light | core | ✓ | ❌ 未注册 |
| `apply_sidebar_attachments` | explore | write_light | core | ✓ | ❌ 未注册 |
| `attach_refs` | explore | write_light | core | ✓ | ❌ 未注册 |
| `duplicate_node` | explore | write_light | core | ✓ | ❌ 未注册 |
| `grid_slice_image` | explore | write_light | core | ✓ | ❌ 未注册 |
| `introduce_nodes_to_agent` | explore | write_light | deferred | ✓ | ❌ 未注册 |
| `propose_generation` | explore | write_light | core | ✓ | ❌ 未注册 |
| `save_node_to_asset_library` | explore | write_light | core | ✓ | ❌ 未注册 |
| `set_node_content` | explore | write_light | core | ✓ | ❌ 未注册 |
| `set_node_prompt` | explore | write_light | core | ✓ | ❌ 未注册 |
| `upload_media_to_canvas` | explore | write_light | core | ✓ | ❌ 未注册 |
| `upsert_media_node` | explore | write_light | core | ✓ | ❌ 未注册 |
| `upsert_prompt_node` | explore | write_light | core | ✓ | ❌ 未注册 |
| `cancel_generation` | explore | lifecycle | core | ✓ | ❌ 未注册 |
| `cancel_platform_fallback` | explore | lifecycle | core | ✓ | ❌ 未注册 |
| `confirm_platform_fallback` | explore | lifecycle | core | ✓ | ❌ 未注册 |
| `import_workflow` | explore | workflow_io | core | ✓ | ❌ 未注册 |
| `instantiate_workflow_template` | explore | workflow_io | core | ✓ | ❌ 未注册 |
| `match_workflow_templates` | explore | workflow_io | core | ✓ | ❌ 未注册 |
| `preview_workflow_template` | explore | workflow_io | core | ✓ | ❌ 未注册 |
| `promote_workflow_template` | explore | workflow_io | core | ✓ | ❌ 未注册 |
| `export_media_package` | explore | export | core | ✓ | ❌ 未注册 |
| `run_image_generation` | graph_node | gen | graph_only | ✓ | ❌ 未注册 |
| `upscale_image` | explore | gen | core | ✓ | ❌ 未注册 |
| `add_nodes_batch` | graph_node | graph_batch | graph_only | ✓ | ❌ 未注册 |
| `apply_layout_ops` | graph_node | graph_batch | graph_only | ✓ | ❌ 未注册 |
| `arrange_nodes_along_edges` | explore | graph_batch | core | ✓ | ❌ 未注册 |
| `arrange_nodes_grid` | graph_node | graph_batch | graph_only | ✓ | ❌ 未注册 |
| `connect_nodes` | explore | graph_batch | core | ✓ | ❌ 未注册 |
| `group_nodes` | graph_node | graph_batch | graph_only | ✓ | ❌ 未注册 |
| `move_nodes` | graph_node | graph_batch | graph_only | ✓ | ❌ 未注册 |
| `ungroup_node` | graph_node | graph_batch | graph_only | ✓ | ❌ 未注册 |
| `focus_node` | ui_command | — | core | ✓ | ❌ 未注册 |
| `focus_nodes` | ui_command | — | core | ✓ | ❌ 未注册 |
| `open_image_editor` | ui_command | — | core | ✓ | ❌ 未注册 |
| `redo` | ui_command | — | core | ✓ | ❌ 未注册 |
| `tool_search` | explore | — | meta | — | ❌ 未注册 |
| `undo` | ui_command | — | core | ✓ | ❌ 未注册 |

## 3. 迁移分期建议（Atomic-First）

按「依赖深度 × 风险」排序，前两批即可覆盖绝大多数真实使用：

| 批次 | 范围 | 工具 | 为什么这个顺序 |
|---|---|---|---|
| **B-1 原子读** | `read` | get_canvas_summary / get_node / get_canvas_layout / get_generation_status / get_generation_diagnostic / list_generation_tasks / list_user_assets / list_public_assets† / get_image_edit_capabilities† | 只读、幂等、无副作用；是"模型能看见画布"的前提，也是比对的基线 |
| **B-2 原子写** | `write_light` | set_node_prompt / set_node_content / attach_refs / upsert_prompt_node / upsert_media_node / propose_generation / apply_sidebar_attachments / apply_asset_to_node / save_node_to_asset_library / duplicate_node / upload_media_to_canvas / grid_slice_image / introduce_nodes_to_agent† | 画布交互的主干（你实测到的 upsert_media_node / propose_generation / apply_sidebar_attachments 都在这里） |
| **B-3 生命周期** | `lifecycle` | cancel_generation / confirm_platform_fallback / cancel_platform_fallback | 与平台降级/取消相关，需与 HITL 状态机一起设计 |
| **B-4 工作流 IO / 导出** | `workflow_io` + `export` | import_workflow / match_ / preview_ / instantiate_ / promote_workflow_template / export_media_package | 契约较重（模板匹配、导入导出），可独立推进 |
| **B-5 生成类** | `gen` | run_/start_/wait_ image·video·text·prompt·audio generation / upscale_image / run_icon_refine | 需要异步任务 + 轮询 + 超时，且与画布任务状态耦合；必须在 B-1/B-3 之上 |
| **B-6 图内批处理** | `graph_batch` | add_nodes_batch / connect_nodes / update_nodes_batch / group_nodes / ungroup_node / arrange_nodes_grid / arrange_nodes_along_edges / move_nodes / apply_layout_ops | 老链路里属 graph_node 专用（不在 Explore 界面）；其中 5 个已标 `DEFERRED_GRAPH_NODE_TOOLS`（无节点调用） |
| **B-7 破坏性** | `destructive` | remove_nodes / remove_edges | 放最后，需审批/二次确认语义 |

† = `DEFERRED_TOOL_NAMES`（Explore 侧按需 deferred 暴露）。

**UI_COMMAND 5 个单独处理**：`focus_node` / `focus_nodes` / `undo` / `redo` / `open_image_editor` —— 它们不是 HTTP 工具，而是发给前端的 UI 指令。迁移路径与工具不同：应在 `canvas_action` / SSE 事件通道上实现，与 B-1/B-2 解耦并可并行。

## 4. 容易被忽略的非工具依赖（比工具清单更关键）

| 依赖 | 老链路现状 | 迁移含义 |
|---|---|---|
| 画布上下文注入 | 老 runtime 的 system prompt 由 Python 侧组装（含画布快照/选中节点等） | pi-runtime 必须补等价的上下文注入，否则模型"看不见画布"，工具再多也无意义 |
| system prompt 来源 | Nest 调 `client.createSession(sessionId)` 时**不传** prompt；pi-runtime 用 `PI_RUNTIME_SYSTEM_PROMPT` 环境变量 | 需改为按会话/画布动态注入 |
| skill 与 prompt-mode | D-η'：12 个 prompt-mode 删除 → slash command + skill | 迁移期需要映射表，否则用户观感上的"模式"全部消失 |
| HITL / 用户确认 | 老链路 `userDecision` 参数 + confirm 循环 | pi 侧用 `before_tool` hook（讨论文档 A.6 校准）承接 |
| 附件与 refs | `apply_sidebar_attachments`、`attach_refs` 依赖侧栏与引用图 | 属 B-2，但需要上下文里先有侧栏/引用信息 |
| 工具结果的 UI 形态 | `tool_result` → Vue 侧消费（`agentChipSet`） | 需固定 custom tool 事件形态后补 `canvas_action` 提取（Round 5） |

## 5. 下一步（本文之后的动作）

1. **核实老 runtime 的 prompt 组装**：system prompt 由哪些函数拼、字段清单是什么（目标：pi 侧等价注入的最小集）。
2. **核实工具真实使用率**：从生产日志统计 47 条里哪些被真实调用过，识别 dead tools，避免把冷工具一起迁。
3. **确认 Nest HTTP 契约**：`nest_client.py` 里每个工具对应的接口路径/鉴权/错误码（pi 侧要复用同一契约，不重写业务逻辑）。
4. **定 pi 侧工具形态**：`AgentHarnessTool` + TypeBox schema 的注册表骨架（含 tier 元数据，便于后续 DESTRUCTIVE 审批）。
5. **B-1/B-2 先行**：在 shadow 模式用 `deploy/runtime-compare.py` 做同 prompt 双跑比对，工具调用序列与结果一致后再往 B-3+ 走。

> ⚠️ 迁移完成前，生产处于 active 状态意味画布工具缺席。若期间有真实用户使用，应先切 `PI_RUNTIME_MODE=shadow`（老链路服务、pi 侧继续采集比对数据），待 B-1/B-2 落地并通过比对后再切回 active。
