# B-2 写工具批次（P1-#13 后续）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans + test-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

## 文档头（SPEC-CONVENTIONS）

- **状态**：已定稿待执行（依据：契约提取 2026-09-24 Explore 代理报告 + `2026-09-23-p1-nest-http-contract-audit.md` + `2026-09-23-p1-canvas-tool-inventory.md`）
- **前置**：#11（骨架 + B-1 七读，0.0.4）、#12（动态 systemPrompt + toolContext 上下文，0.0.5）均已上线；K4 首轮基线已产出（runtime-compare --suite，diff 2/2 根因即缺写工具）
- **分支约定**：pi-lnk 仓库 feature 分支 `p1/b2-write-tools`，PR → CI → merge → 双侧部署
- **部署**：pi-runtime 0.0.6（helm 链路，RUNBOOK-pi-runtime-deploy.md）+ Nest API 发布门（assembler/agent.service 变更）

## 0. 配图索引

本文档不含图（工具契约表 + 任务分解，无状态机/拓扑需要图示）。

## 1. 范围与关键决策

### 1.1 工具清单（14 个 = 13 写 + connect_nodes 提前）

| 工具 | tier | 暴露 | 超时 | Nest 端点（POST /agent/internal/*） |
|---|---|---|---|---|
| upsert_prompt_node | write_light | ✓ | 10s | upsert-prompt-node |
| upsert_media_node | write_light | ✓ | 10s | upsert-media-node |
| set_node_prompt | write_light | ✓ | 10s | set-node-prompt |
| set_node_content | write_light | ✓ | 10s | set-node-content |
| attach_refs | write_light | ✓ | 10s | attach-refs |
| propose_generation | write_light | ✓ | 10s | propose-generation |
| apply_sidebar_attachments | write_light | ✓ | 10s | apply-sidebar-attachments |
| apply_asset_to_node | write_light | ✓ | 10s | apply-asset-to-node |
| save_node_to_asset_library | write_light | ✓ | 10s | save-node-to-asset-library |
| duplicate_node | write_light | ✓ | 10s | duplicate-node |
| upload_media_to_canvas | write_light | ✓ | 10s | upload-media-to-canvas |
| grid_slice_image | write_light | ✓ | **120s**（timeoutOverrides） | grid-slice-image |
| connect_nodes | **graph_batch** | ✓ | 10s | connect-nodes（**自 B-6 提前**） |
| introduce_nodes_to_agent | write_light | **✗（deferred）** | 10s | introduce-nodes-to-agent |

**决策 D1（对 inventory 分期的声明偏离）**：`connect_nodes` 提前纳入本批。理由：规则 4/5 的主场景「多节点 + 连线 + 填参 + 确认」强引用它（explore.py:108-112），不迁则 B-2 上线即出现「规则指引模型调用未注册工具」；契约极简（`edges:[{source,target}]` ≤20 条，body `{sessionId, edges}`）。其余 graph_batch 工具仍留 B-6。

**决策 D2（对齐老链路 DEFERRED）**：`introduce_nodes_to_agent` 注册但不暴露（老链路 `DEFERRED_TOOL_NAMES`，模型不可见；其 `canvasCommands` 输出依赖 UI_COMMAND 通道，该通道独立批次）。exposed = 13。

### 1.2 规则组决策（writeTools 组启用）

- **规则 4、5**：从 `explore.py:95-112` **逐字拷贝**（connect_nodes 已在批内，措辞自洽）。
- **规则 6（tool_search）不拷贝**——声明偏离：pi-runtime 无 tool_search 功能，该规则语义不适用；随 tool_search 出现时补。
- **规则 8 不拷贝**——引用 import_workflow/instantiate（B-4）与 arrange_nodes_along_edges（B-6），随所在批次拷贝。
- **规则 9 不拷贝**——引用 upscale_image（断头工具，B-5 拍板），随 B-5。
- **core 第 10 条（写守卫）**：writeTools 启用后不得再注入。实现：把第 10 条从 core 文本拆出为独立常量，core 组 = 规则 1/2/3/7 恒注入 + 第 10 条仅当 ruleGroups 不含 writeTools。
- **core 规则 3 恢复 explore.py 原文**（修复评审 F1：此前精简未声明偏离）。

### 1.3 评审 deferred minors 清理（6 条全在本批）

| # | 内容 | 修法 |
|---|---|---|
| F1 | core 规则 3 文本精简未声明 | 恢复 explore.py 原文（见 §1.2） |
| F2 | buildSidebarBlock 按 raw index 对齐 keys，未知 mediaType 错位 | 改为先过滤合法 mediaType 再 zip keys |
| F3 | priorMessages 查询在 B4 分支前无条件执行 | 移入 pi 分支内（active/shadow 共用点） |
| F4 | AgentService canvasTools `@Optional` 削弱 fail-fast | 去掉 @Optional（module 已提供 provider），测试注入路径同步调整 |
| F5 | mentionedKeys 死输入 | 本批激活：apply_sidebar_attachments 的 attachments/mentionedKeys fallback 从 toolContext 读取（对齐老链路双层 fallback，pi 侧只做工具侧一层） |
| F6 | 侧栏 text 素材无长度截断 | buildSidebarBlock text 素材 200 字截断（对齐老链路 recent_turns 工具结果 120 字口径的画布版） |

## 2. 契约要点（实现对照，来自 nest_client.py + Nest DTO 逐条核对）

- **body 命名**：snake_case 入参 → camelCase body；`sessionId` 恒发（toolContext）；`userId` 按 DTO 要求发（set_node_content / upsert_* / propose_generation / apply_asset_to_node / save_node_to_asset_library / duplicate_node / upload_media_to_canvas / grid_slice_image / introduce_nodes_to_agent 发；set_node_prompt / attach_refs / connect_nodes / apply_sidebar_attachments 不发——对齐老 client）。
- **条件字段**：title/nodeId/nodeIds/sourceUrl/label/mentionedKeys 仅非空才发；refOrder 恒发（apply_sidebar_attachments，空则 []）；duplicate_node 的 includeUpstream 仅 true 才发。
- **apply_sidebar_attachments 特殊语义**：attachments 缺省 → 取 toolContext.attachments（本轮 Nest 注入侧栏），mentionedKeys 同理；两层皆空 → **短路返回 `{ok:false, error:"没有侧栏附件"}` 不打 Nest**（不计熔断/计数）。
- **grid_slice_image**：source_url 优先于 node_id（都缺省时工具侧直接报错还是打 Nest？——对齐老链路：交给 Nest 400，工具不预校验）；NestClient `timeoutOverrides: {"/agent/internal/grid-slice-image": 120_000}`。
- **connect_nodes**：`edges` ≤20 条上限在工具侧校验（对齐 definitions.py CONNECT_NODES_MAX_EDGES=20）。
- **propose_generation**：纯状态操作（置 pending_confirm），不触发异步任务；description 原文含「Never calls run_*」。
- **propose/clear 配对**：clear-propose-generation 不在本批（老链路模型也不直调）。

## 3. 任务分解（TDD，每任务 RED→GREEN）

### Task 1: canvas-write.ts —— 14 个写工具 + registry 工厂
- `src/tools/canvas-write.ts`：`createCanvasWriteTools(client, ctx 式 toolContext)`；每工具入参 TypeBox schema 平移 Pydantic（字段描述文本照抄 definitions.py，duplicate_node 的 include_upstream 描述采用 description 侧语义「复用既有上游节点并连入边，不复制上游节点」——修复不一致 #5）。
- `src/tools/registry.ts`：追加 `buildCanvasWriteTools`；exposed 集合不含 introduce_nodes_to_agent。
- 装配处（index.ts）把 read+write 合并传入 SessionManager；`timeoutOverrides` 增加 grid-slice-image 120s（装配层 config 传入）。
- 测试：每工具 ≥1（入参转换 + 条件字段 + userId 有无 + apply_sidebar 短路 + connect ≤20 校验）；无 env 降级 tools=[] 依旧。

### Task 2: PiPromptAssembler —— writeTools 组 + core 调整（F1）
- WRITE_TOOLS_RULES = 规则 4 + 5 原文（explore.py:95-112 逐字，含换行结构）。
- core 拆分：规则 1/2/3/7 恒注入（规则 3 恢复原文）；第 10 条守卫仅 writeTools 未启用时注入。
- 测试：writeTools 启用 → 含规则 4/5 原文特征句、不含第 10 条；默认 → 含第 10 条、不含规则 4。

### Task 3: agent.service 接线（F3/F4/F5 之 Nest 侧部分）
- B4 active/shadow 分支 `ruleGroups: ["core","writeTools"]`。
- priorMessages 查询移入 pi 分支（F3）。
- canvasTools 去 @Optional（F4）+ 测试 fake 同步。
- 测试：现有 234 用例保持绿 + 新增 ruleGroups 断言。

### Task 4: pi-runtime 工具侧 minors（F5/F6 之 pi 侧）
- F5：apply_sidebar_attachments fallback 读 toolContext.attachments/mentionedKeys（#12 已透传）。
- F6：buildSidebarBlock（Nest 侧 sidebar-block.ts）text 素材 200 字截断 + 合法 mediaType 过滤后 zip（F2 同处）。
- 测试各 1。

### Task 5: 全量回归 + 独立评审
- pi-runtime node --test + tsc；Nest vitest 分批 + tsc。
- review-package → 独立 reviewer（reasoning 模型）；Critical/Important 必修。

### Task 6: 部署 + 生产复测
- PR → CI 4/4 → merge → pi-runtime 0.0.6（helm，显式 --set image.tag）→ API 发布门 dispatch → 验收四件套。
- **e2e**：真实画布 upsert_prompt_node（新建 prompt 节点，Nest 侧核对 canvasData 落库）；「画布加圆形和文字」prompt 复测（模型应 upsert_media_node×2 + propose_generation，对照 K4 基线 case3）。
- 台账 + 日志 + MEMORY 更新。

## 4. 风险与回滚

- 写工具直达用户画布：生产验证用冒烟画布会话（专用 userId），不动真实用户画布。
- 回滚：pi-runtime 镜像回 0.0.5 + API 镜像回退（发布门既有机制）；writeTools 规则组未启用前（Nest 先行/滞后一拍）模型只见读工具，第 10 条守卫保证不误调——**部署顺序：先 pi-runtime（工具就位）后 API（规则启用）**，中间态安全。
- 有真实用户时：先切 `PI_RUNTIME_MODE=shadow` 再合并（纪律不变）。
