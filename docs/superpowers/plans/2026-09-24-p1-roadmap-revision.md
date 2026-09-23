# P1 路线修订：核心循环优先 + 老 runtime 退役判据（2026-09-24）

- **状态**：已定稿（用户 2026-09-24 04:16 拍板「都按默认采纳」）
- **前置**：#8-#13 已完成，B-1（7 read）/ B-2（13 写 + connect_nodes）已上生产（pi-runtime 0.0.6 / PR #3 merge `aa72d36`）
- **关系**：修订 `2026-09-23-p1-canvas-tool-inventory.md` §3 的分期顺序；不推翻其工具清单事实（§2 仍为 SSOT）
- **分支约定**：本文档不含实现；各批次开工前按 writing-plans 出独立实现计划

## 0. 配图索引

本文档不含图（纯批次重排与判据定义，无状态机/拓扑需要图示）。

## 1. 决策依据：核心循环

画布产品的 agent 核心循环为：

**看见画布（B-1 ✅）→ 改画布（B-2 ✅）→ 生成资产（B-5 ❌）→ 让用户看见结果（UI_COMMAND ❌）→ 中途取消/确认（B-3 ❌）**

原分期（B-3 → B-4 → B-5）把长尾批次排在核心循环缺口之前，与产品价值相悖，故重排。

## 2. 定案决策（逐条）

| # | 决策 | 内容 |
|---|---|---|
| D1 | P0 = UI_COMMAND 小批次 | 按既定设计执行（`2026-09-24-ui-command-canvas-action-design.md`）：5 个本地工具 + pi-events 派生 ~80 行，前端零改动 |
| D2 | P1 = B-5 生成闭环，B-3 并入 | `run_image_generation` 是核心循环最关键缺口；cancel_generation / platform_fallback 确认流与生成同批设计（无生成则 cancel 是孤儿工具） |
| D3 | B-3 HITL 走重构不迁代码 | 老「userDecision 参数 + confirm 循环」改为 harness `before_tool` + Gate；`confirm_platform_fallback`/`cancel_platform_fallback` 从 LLM 工具改建模为 Gate 拦截点（确认权收归 harness，不让模型自己批自己的审批） |
| D4 | upscale_image 不迁 | 断头工具；B-5 批次内删规则 9（writeTools 规则组同步剔除），除非后续数据推翻 |
| D5 | B-4 workflow_io 降级为数据决策 | 迁移与否取决于真实使用率（见 §3.3 数据源缺口）；未取得数据前不排期 |
| D6 | B-6 显式关闭 | connect_nodes 已随 B-2 上线；剩余 `add_nodes_batch`/`arrange_nodes_grid`/`move_nodes`/`group_nodes`/`ungroup_node` 均 placement=graph_node，老链路本就不向 Explore 界面暴露——无迁移对象。inventory §3 B-6 行标记 CLOSED |
| D7 | B-7 显式关闭 | 事实核查（§3.1）：remove_nodes/remove_edges 在 registry 为 DESTRUCTIVE，但 `definitions.py:1118` 注明 reserved for deterministic graph paths，不向模型暴露。B-7 无 Explore 侧迁移对象 |
| D8 | D-η' 缺口确认并补排期 | 事实核查（§3.2）：老 runtime skill 体系完整（loader/routing/taxonomy/`prompt_mode_taxonomy.py`），Nest `PiPromptAssembler` 完全无 skill 概念。需先核对生产 skill 使用情况，再定 pi 链路 skill 注入口径——优先级高于 B-4/B-6 长尾 |
| D9 | 定义老 runtime 退役判据 | 见 §4，P1 north star |

## 3. 事实核查记录（2026-09-24 04:10）

### 3.1 B-7 SSOT 核对 → 无迁移对象
`tool_registry.py:160-161` 登记 remove_nodes/remove_edges 为 DESTRUCTIVE；`definitions.py:1118`「Generation / destructive tools reserved for deterministic graph paths」；`runs.py:408-419` 仅内部确定性链路（topo revise）调用。

### 3.2 D-η' 现状
老 runtime：`app/skills/loader.py`、routing（valid_skill_ids）、`prompt_mode_taxonomy.py`、skills/ 目录（ecommerce-product-visual 等）。Nest pi-runtime 目录 grep skill/prompt_mode 零命中——pi 链路当前无 skill 能力。

### 3.3 使用率统计：数据源缺口
老 runtime 容器 2026-09-23 17:30 重建（回滚演练），docker logs 仅 408 行健康检查；lnkpi-api 同日随发布门重建。**容器日志无法提供历史使用数据**。可行数据源（按优先级）：
1. 生产 DB：session/事件表中老链路 run 的工具调用记录（若有落库）；
2. 老 runtime `/metrics` 若有 tool 计数（容器重建后计数已清零，只能从现在开始积累）；
3. 自现在起在两侧累计 1-2 周再决策 B-4。

### 3.4 UI_COMMAND 附带验证点
undo/redo 上线前必须验证：前端 client undo stack 是否覆盖 pi→Nest 写入（B-2 已上线的写工具）。若不覆盖则 undo 工具会误导用户，需先修前端或暂缓 undo/redo 两个工具。

## 4. 老 runtime 退役判据（P1 north star）

三条全绿后，生产仅保留 pi-runtime（老 LangGraph runtime 下线，双轨结束）：

1. K4 suite 有效用例 diff 收敛到 0（runtime-compare --suite）；
2. 生产使用率 top-20 工具（覆盖约 95% 调用量）在 pi 链路 100% 可用；
3. shadow 模式连续 7 天无行为差异。

说明：双轨并存是当前最大隐性成本（每个功能写两遍）；B-4/B-6/B-7 长尾经 D5/D6/D7 处理后不再是拖长退役的主要变量，剩余风险集中在 D2（B-5）与 D8（skill）。

## 5. 后续动作顺序

1. **UI_COMMAND 小批次**（独立 PR，含 §3.4 验证点）
2. **B-5+B-3 合并批次**：writing-plans 出实现计划（异步工具形态 + Gate 建模 + 删规则 9），这是剩余最大工作量
3. **D-η' 核查**：生产 skill 使用数据 → pi 链路 skill 注入设计
4. **使用率数据积累**：确定 DB/metrics 数据源后启动统计，数据到位再裁决 B-4
5. 各批部署纪律沿用 B-2 定案：先 pi-runtime 后 API，发布门走 pi-lnk master
