# UI_COMMAND×5 → canvas_action/SSE 通道设计（P1-#13 并行项）

## 文档头（SPEC-CONVENTIONS）

- **状态**：已定稿待实现（设计定案，实现独立于 B-1/B-2 批次，可与任一批次并行）
- **前置**：#11 工具注册表骨架已上线（pi-runtime 0.0.4+）；#12 动态 systemPrompt 已上线（0.0.5）
- **分支约定**：实现时新建 feature 分支 `p1/ui-command-tools`；本文档本身不含实现
- **部署**：实现随其所在批次的发布链路走（pi-runtime helm + 可选 Nest 侧）

## 0. 配图索引

本文档不含图（纯通道设计与事件流文字描述，无状态机/拓扑需要图示）。

## 1. 老链路事实（代码核对 2026-09-24）

- 5 个 UI_COMMAND 工具是**老 runtime 本地函数，非 HTTP 转发**：`definitions.py:472-489` —— `focus_node` / `focus_nodes` / `undo` / `redo` / `open_image_editor` 直接返回 `{"ok": True, "canvasCommands": [{type, ...}]}`。
- 老链路把工具结果里的 `canvasCommands` 抽出，经 `explore_dispatch.py` 的 `canvas_commands` 通道并入 run 输出 → `runs.py:1216` 以事件下发前端。
- 前端 `apps/web/src/components/agent/executionTraceReducer.ts:496` 已有 `canvas_action` 事件消费（`applyCanvasAction`）。

## 2. pi-runtime 通道设计（定案）

1. **工具形态**：5 个工具在 pi-runtime **本地实现**（与老链路一致，不走 Nest 转发），tier 归 `ui_command`（ToolTier 枚举新增该值或归入 `read`？——**定案：新增 `ui_command` tier**，与老 registry 的 ToolPlacement.UI_COMMAND 对齐，便于 metrics 面板区分）。
2. **返回形态**：execute 返回 `{ content: [...], details: { ok: true, canvasCommands: [{type, nodeId?, nodeIds?}] } }`，字段名 camelCase（对齐老链路输出，前端免转换）。
3. **事件派生**：`apps/server/src/agent/pi-runtime/pi-events.ts` 的 `mapPiEventToUiEvent` 在 `tool_execution_end` 时检查 result details：含 `canvasCommands` 数组 → 除 `tool_result` 外**逐条派生 `canvas_action` 事件**（`{type: cmd.type, ...cmd}`）。前端零改动。
4. **暴露策略**：5 个工具进 Explore 界面（老 registry `TOOL_EXPOSURES` 中 UI_COMMAND 属 Explore 白名单），system prompt 无需新增规则（与老链路一致由模型自主调用）。

## 3. 验收口径

- 会话说「定位到节点 X」→ 前端收到 `canvas_action{type:"focus_node", nodeId:"X"}` 且 trace 中出现对应条目。
- `undo`/`redo`/`open_image_editor` 同理；`pi_runtime_tool_calls_total{tool="focus_node"}` 正常计数。

## 4. 实现批次建议

体量小（5 个本地工具 + pi-events 派生 ~30 行），建议作为独立小 PR 随 B-2 之后任意时点合入，不阻塞 B-2；若 B-2 执行顺利可并入 B-2 分支末尾（同 PR 双提交，评审分区标注）。
