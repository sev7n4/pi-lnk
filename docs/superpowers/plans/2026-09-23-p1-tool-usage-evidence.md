# P1-② · 47 条工具生产使用率证据盘点（2026-09-23）

状态：已完成（间接证据盘点，2026-09-23）
前置：`2026-09-23-p1-canvas-tool-inventory.md` §5.2；数据源：生产 CVM（119.29.173.89）
分支约定：纯文档变更，直接 master（不触发 CI）。

## 0. 配图索引

本文档不含图（理由：证据是「数据源 → 表/字段 → 数值」的平铺清单，一张表无损表达，不满足 SPEC-CONVENTIONS §1 画图判据）。

## 1. 先说一个硬事实：生产不存在工具级遥测

| 数据源 | 现状 | 结论 |
|---|---|---|
| 容器 stdout | 两个容器今日 force-recreate，日志只剩当晚 | 历史不可回溯 |
| LangGraph checkpoint（`lnkpi-checkpoints` 卷，749MB，1348 线程 / 106,649 条消息） | **只有最终 AIMessage，0 条 tool_calls / ToolMessage** | explore 节点不把中间工具轮写回 state（`explore.py:551-560` 只回写收尾消息），checkpoint 天然无工具痕迹 |
| Nest `AgentMessage`（11,919 条） | 只存最终 user/assistant 文本 | 同上 |
| Nest `GenerationRecord.metadata`（4,215 条） | 无 source/origin 字段 | **无法区分 agent 触发 vs UI 手动** |

→ 两个动作项：
1. **pi-runtime 必须内建 `tool_calls_total{name=}` 计数器**（接 K2 观测，进 #11 骨架设计），否则迁移后同样无法回答"哪些工具在被用"。
2. 老链路如需精确数据，唯一途径是加日志——不值得为 30 天回退期补做。

## 2. 间接证据：效果痕迹（SQLite `lnkpi.db`，持久卷，跨重建有效）

| 证据源 | 数值 | 指向的工具 | 强度 |
|---|---|---|---|
| 350 会话含 canvasData；节点类型分布 | image 1567 / prompt 466 / video 346 / text 218 / **group 67** / mediaInput 46 / audio 20 / shot 18 / sceneComposer 11 / worldModel 9 | `upsert_media_node`、`upsert_prompt_node`、`set_node_prompt/content`、skill 链路节点 | 强 |
| 边总数 | **1,997**，单会话最多 107 节点 | `connect_nodes`、`add_nodes_batch` | 强 |
| `GenerationRecord` 4,215 条 | image 3004 / video 669 / text 284 / **prompt 185** / image_edit 39 / audio 18 / **image_upscale 16** | 生成链路（propose→用户确认→系统执行）、`upscale_image` | 强（但 agent/UI 无法区分） |
| `GenerationRecord.status` | fallback_pending **321** | `confirm_platform_fallback` / `cancel_platform_fallback` 所服务的降级流真实存在 | 中 |
| `UserAsset` 111 | image 107 / video 3 / audio 1 | `save_node_to_asset_library`、`upload_media_to_canvas` | 中 |
| `UserWorkflowRecipe` | **仅 2** | `import_workflow` / `promote_workflow_template` | 冷 |
| `Session.stagedActions` | **0 个非空** | canvas stage/rollback 路径未被真实使用 | 冷 |

## 3. 对迁移批次的影响

- **B-1/B-2 先行的排序被证据支持**（节点/边/生成的量级都在千级）。
- **B-6 中 `connect_nodes` 证据强**（1,997 边）；其余 graph_batch（arrange/move/layout ops）属体验优化，保持低优先级。
- **B-4 工作流模板 6 个工具降级为"最小迁移"**：生产 recipe 仅 2 条，倾向只迁 `instantiate` + `preview`（HITL 路径），match/promote/import 视 #3 契约梳理的成本再定。
- **`upscale_image`（16 次）保留但放 B-5 尾部**；image_edit 39 次属于编辑器链路，`open_image_editor` 走 UI_COMMAND 通道。
- `get_canvas_layout/summary/node` 等读工具无法从效果痕迹判定使用率，但它们是模型"看见画布"的前提，不因无证据而砍。

## 4. 数据获取方式（可复现）

checkpoint 解析与 DB 查询均在 CVM 上以一次性容器执行（`docker run --rm -i -v lnkpi_lnkpi-data:/d:ro --entrypoint python lnkpi-agent-runtime:local -`，脚本经 stdin 传入，只读模式 `file:...?mode=ro`）。SSH 注意：`deploy-cvm` 别名经代理会解析到 fake-ip（198.18.x）间歇失败，直连 `root@119.29.173.89 -i ~/.ssh/tencent_cloud_deploy` 稳定。
