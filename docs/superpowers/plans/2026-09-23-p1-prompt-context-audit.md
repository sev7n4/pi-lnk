# P1-① · 老 runtime system prompt 组装与画布上下文盘点（2026-09-23）

状态：已完成（事实盘点，2026-09-23）
前置：`2026-09-23-p1-canvas-tool-inventory.md` §5.1（工具盘点文档）
分支约定：纯文档变更，直接 master（不触发 CI）。

## 0. 配图索引

本文档不含图（理由：组装链路是「6 个块按顺序拼一条字符串」的线性结构，一张表即可无损表达，不满足 SPEC-CONVENTIONS §1 的画图判据）。

> 任务来源：P1 盘点文档 §5.1（核实老 runtime 的 prompt 组装）。
> 结论先行：**pi 侧等价注入的最小集 = 静态规则 + 画布摘要 + 侧栏附件/芯片 + 近期对话压缩**，四件全在 explore 节点一处拼装，无隐藏分支。

> 边界声明：§4 仅罗列实现选项与依赖事实，**不作最终方案决策**；方案选型在 B-1 开工前经 brainstorming → writing-plans 流程落到正式计划文档后生效。

## 1. 唯一的 prompt 组装点：explore 节点

老 runtime 中所有「画布助手」对话都走 `app/graph/nodes/explore.py`（chat 零工具路径已在 M2a 退役，`chat.py` 仅 re-export `_EXPLORE_SYSTEM`）。每轮调用时拼装如下：

| # | 块 | 来源 | 证据 | 注入时机 |
|---|---|---|---|---|
| 1 | 静态规则 ×9 条 | `_EXPLORE_SYSTEM`（硬编码中文） | `explore.py:87-132` | 每轮 SystemMessage |
| 2 | 画布摘要 | `nest.get_canvas_summary()` → JSON 序列化填入 `{summary}` 槽位 | `explore.py:232-234, 393`；Nest 接口 `POST /agent/internal/get-canvas-summary`（`nest_client.py:222-227`） | 每轮**重新拉取**（非会话级缓存） |
| 3 | 侧栏参考图解析块 | `format_parse_context_block(state["sidebar_media_parse"])` + 解析失败附加规则 `_PARSE_FAIL_NO_EMPTY_LISTING` | `explore.py:394-399` | 有解析结果时追加 |
| 4 | 工作流规划规则 | `_PLANNER_SYSTEM` | `explore.py:59-74, 400-401` | 仅当 `match/preview_workflow_template` 在本轮可见工具集时 |
| 5 | 近期对话摘要 | `compress_recent_turns(prior, max_turns=4)` → 第二条 SystemMessage「近期对话摘要：…」 | `explore.py:402-408`；`recent_turns.py:58-106` | 每轮；含**工具名 + 工具结果截断 120 字**（供「再导一次」类指代） |
| 6 | 当前用户消息 | `HumanMessage(user_text)`（最新一条；先前轮只进 ⑤ 不重复） | `explore.py:403-409` | 每轮 |

工具循环内还有两条**动态追加**（pi 侧可后置）：
- 写意图未调写工具 → 追加 `_WRITE_RETRY_SYSTEM` 重试（`explore.py:423-436`），上限 `MAX_EXPLORE_TOOL_ROUNDS=4`；
- `tool_search` 加载 deferred 工具成功 → **同轮重绑**工具集（`explore.py:503-509`）。

## 2. 每轮请求携带的画布上下文（RunRequest）

`app/runs.py:301-331`，Nest 每轮 POST /runs 时传：

| 字段 | 作用 | pi 侧去向 |
|---|---|---|
| `session_id` / `user_id` | 会话与身份 | 已有 |
| `message` | 用户消息 | 已有 |
| `thread_id` | checkpoint 恢复多轮历史 | pi-runtime 自有会话历史 |
| `attachments` → `sidebar_attachments` | 侧栏参考素材（≤5，url/text） | **需新增**：进 system 或工具上下文 |
| `mentioned_keys` | 用户 @I1/@T1 芯片提及（≤5） | **需新增**（B-2 的 `apply_sidebar_attachments` 依赖它） |
| `ref_order` | 芯片顺序（I1/I2 序） | **需新增**（同上，mode=localRefs 的 mentioned_keys 语义） |
| `focus_node_id` | W28 单节点快捷生成目标 | **需新增**（B-2 propose_generation 场景） |
| `skill_id` / `user_decision` / `thinking` | skill 编排/HITL/深度思考 | 后置批次 |

侧栏 key 规则：按 mediaType 分配 `T1/I1/V1/A1`（`sidebar_attachments.py:30-43`）；@提及解析 `@([TIVA]\d+)`（`:46-53`）。

## 3. 跨轮持久状态（LangGraph checkpoint，pi 侧需等价物）

- `tool_plan_loaded`：tool_search 已加载的 deferred 工具，跨轮存活（`explore.py:220-228`）。
- `composition_pending` / `composition_dump_hash`：工作流规划预览 HITL 状态。
- clarify 状态（`clarify_context` / `pending_atomic_clarify`）。

→ pi-runtime 的 session 已可跨轮存状态；`tool_plan_loaded` 建议放进 session 级 metadata。

## 4. pi 侧最小注入集（#12 的实现规格）

**已具备**：pi-runtime `POST /sessions` 已接受 `systemPrompt`（`index.ts:53-59`），`SessionManager` 透传给 harness（`session-manager.ts:101-119`）；缺的只是 Nest 侧 `agent.service.ts:428` 不传、且没有动态内容。

**最小集拼装方案**（Nest 侧每轮组装，首次 createSession 传入 + 后续轮更新）：

```
systemPrompt = EXPLORE_RULES(静态 9 条，从 explore.py 平移)
  + "\n当前画布摘要：\n" + get-canvas-summary(sessionId)   ← 每轮刷新
  + [侧栏块] "侧栏参考图：I1=<文件名/描述>…"（attachments + mentioned_keys）
  + [近期摘要] compress_recent_turns(等价实现，max_turns=4)
```

两个实现选项（B-1 时定）：
- **A（推荐）**：Nest 在每轮转发请求时组装完整 system prompt，经 pi-runtime 现有 per-turn 通道更新（需给 pi-runtime 加一个「更新 systemPrompt」入口或复用 session upsert）。与老链路语义 1:1，summary 每轮新鲜。
- **B**：把 `get_canvas_summary` 做成 B-1 工具让模型自己拉 + 首轮注入静态摘要。省通道改动，但模型行为多一步、且与老链路「摘要必在」语义不等价——比对脚本会出 diff。

**明确后置（不进最小集）**：
- `_PLANNER_SYSTEM`（B-4 工作流 IO 批次一起迁）；
- 侧栏图 vision 解析块（`sidebar_media_parse`，涉及 vision 模型调用，独立小项）；
- mandatory dispatch（`run_mandatory_explore` 的免 LLM 快路径，属优化非语义必需）；
- write-retry / 同轮重绑（pi harness 自带多轮工具循环，先观察是否需要）。

## 5. 与工具批次的关系

- 最小集不依赖任何工具注册，可与 #11 并行；但 **B-2 的 `apply_sidebar_attachments` 硬依赖 `mentioned_keys`/`attachments` 进上下文**（见 §2 表）。
- `focus_node_id` 在 B-2 propose_generation（W28 单节点快捷生成）时必须带上。
