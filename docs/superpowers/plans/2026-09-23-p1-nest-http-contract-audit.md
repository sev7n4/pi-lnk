# P1-③ · 工具 → Nest HTTP 契约梳理（2026-09-23）

状态：已完成（事实梳理，2026-09-23）
前置：`2026-09-23-p1-canvas-tool-inventory.md` §5.3；`2026-09-23-p1-prompt-context-audit.md`
分支约定：纯文档变更，直接 master（不触发 CI）。

## 0. 配图索引

本文档不含图（理由：契约是「工具 → 端点 → 参数语义」的平铺映射，表格无损表达，不满足 SPEC-CONVENTIONS §1 画图判据）。

## 1. 传输契约（pi 侧必须 1:1 复用）

| 项 | 值 | 证据 |
|---|---|---|
| 基址 | `nest_base_url`（默认 `http://127.0.0.1:3000/api`；生产由 compose 注入） | `app/config.py:6` |
| 鉴权 | 请求头 `x-lnkpi-service-token: <nest_service_token>`（所有 `/agent/internal/*` 请求统一携带） | `nest_client.py:90-92` |
| 方法 | 全部 `POST`，JSON body；body 首键一律含 `sessionId`（`get_canvas_summary` 仅此一键），写操作另含 `userId` | `nest_client.py` 各方法 |
| 响应包络 | `{code, message, data}`；`code != 0` → 抛 `AgentToolError`（`error_type`：`tool_timeout` / `downstream_unavailable` 等） | `nest_client.py:149-155` |
| 超时 | 画布工具 10s；图像生成 180+30=210s；视频 660+30=690s；线程锁 5s（按路径白名单区分） | `nest_client.py:20-61`、`config.py:14-19` |
| 熔断 | 每 tool 名独立计数，连续 5 次失败（超时/5xx/不可用）熔断 60s；成功即复位 | `nest_client.py:85-88, 117-158` |
| 观测 | 进程内 `record_tool_call(name, success)` 计数器（`/metrics` 暴露，容器重建清零——呼应 #9 的遥测缺口） | `nest_client.py:118, 134, 146, 154, 158` |

## 2. 工具 → 端点全表（42 个 HTTP 工具，AST 提取 + Nest 控制器逐一比对）

Nest 侧实现集中在 `apps/server/src/agent/agent-canvas-tools.controller.ts`（`@Controller('agent/internal')`）。命名规律：tool 名 ↔ 端点 kebab-case，**除 5 个 workflow 模板工具外全部同名直译**。

| 工具 | 端点（`/agent/internal/` 前缀省略） | 备注 |
|---|---|---|
| get_canvas_summary | get-canvas-summary | body 仅 sessionId；prompt 注入也用它（#①） |
| get_node / get_canvas_layout | get-node / get-canvas-layout | 读 |
| get_generation_status / get_generation_diagnostic | 同名 | 读 |
| list_generation_tasks / list_user_assets / list_public_assets | 同名 | 读 |
| get_image_edit_capabilities | get-image-edit-capabilities | 读（deferred） |
| upsert_media_node / upsert_prompt_node | 同名 | 写（body 含 userId） |
| set_node_prompt / set_node_content | 同名 | 写 |
| attach_refs / apply_sidebar_attachments | 同名 | 写；依赖 #① 的 mentioned_keys/ref_order 上下文 |
| duplicate_node / grid_slice_image | 同名 | 写 |
| upload_media_to_canvas / apply_asset_to_node | 同名 | 写 |
| save_node_to_asset_library / introduce_nodes_to_agent | 同名 | 写 |
| propose_generation | propose-generation | 写；生成前 HITL |
| connect_nodes | connect-nodes | body `edges` 上限 `CONNECT_NODES_MAX_EDGES`（definitions.py 客户端校验） |
| add_nodes_batch / update_nodes_batch | 同名 | body `items` |
| group_nodes / ungroup_node / move_nodes | 同名 | graph_batch |
| arrange_nodes_grid / arrange_nodes_along_edges / apply_layout_ops | 同名 | graph_batch |
| remove_nodes / remove_edges | 同名 | destructive；body 带 `stage` 可选 |
| cancel_generation | cancel-generation | lifecycle |
| confirm_platform_fallback / cancel_platform_fallback | 同名 | lifecycle（fallback_pending 321 条实证） |
| import_workflow / export_media_package | 同名 | 工作流 IO |
| match_workflow_templates | **match-recipes** | 映射非直译 |
| preview_workflow_template | **preview-recipe-delta** | 映射非直译 |
| instantiate_workflow_template | **instantiate-recipe** | 映射非直译 |
| promote_workflow_template | **promote-recipe** | 映射非直译 |
| run_image_generation | run-image-generation | 生成；另有 start-/wait- 端点供长任务分段（`nest_client.py` 有 start/wait 方法，包装在 gen 流水线内） |
| run_video_generation | run-video-generation | 同上 |
| upscale_image | upscale-image | ⚠️ **Nest 侧无此路由，见 §3** |

**非 HTTP 的 5 条**：`focus_node` / `focus_nodes` / `undo` / `redo` / `open_image_editor`（UI_COMMAND，经 state 的 `canvas_commands` → SSE 下发前端）+ `tool_search`（meta，runtime 本地）。与盘点文档的 47 条对齐：42 HTTP + 5 UI_COMMAND + tool_search。

## 3. 发现：`upscale_image` 是断头工具

- `nest_client.py` 向 `/agent/internal/upscale-image` 发 POST，但 **pi-lnk 与 lnkpi 两仓库的 `apps/server/src` 均无 `upscale`/`image_upscale` 任何实现**（路由 404）。
- 生产 `GenerationRecord` 有 16 条 `image_upscale`（fal 渠道、chargedPoints 10），时间范围 **2026-09-13 → 09-21**——是**已被删除的老代码**的产物，当前代码写不出这类记录。
- 推论：老 runtime 现在调 `upscale_image` 必失败（除非 Nest 有未入仓库的热修——已对照生产镜像构建源 pi-lnk master，排除）。
- **决策建议（待拍板）**：B-5 不迁移 `upscale_image`，或先在 Nest 侧重建 UpscaleService 再迁。因 explore 的静态规则第 9 条还在向模型承诺放大能力，若不迁需同步改 prompt，否则模型会反复调一个必败工具。

## 4. 对 #11（pi 侧骨架）的落点

1. **不重写业务逻辑**：pi-runtime 工具 handler = 转发 Nest 同一端点、同一 header、同一包络解析；TypeBox schema 从 `definitions.py` 的 Pydantic Input 模型平移（契约不变）。
2. **需要新增部署配置**：pi-runtime → Nest 的 `NEST_BASE_URL` + `NEST_SERVICE_TOKEN` 环境变量（当前 pi-runtime 只有 Nest → pi 的 `PI_RUNTIME_URL` 反向配置）。K3s 部署时经 helm values 注入。
3. **保留熔断 + per-tool 计数器语义**（5 次/60s + `tool_calls_total{name,success}`），与 K2 观测对齐。
4. **超时语义照抄**（10s 画布 / 210s 图 / 690s 视），避免 shadow 比对出现假超时 diff。
