# spawn_subagent 工具层级提回常驻（C4 可达性修正）设计规格

> 日期：2026-11-11 · 版本 v1 · 状态：待评审
> 类型：代码刀（services/pi-runtime）· 触发 pi-runtime 独立部署 ⇒ 合并需单独授权 + 生产复测
> 上游：docs/superpowers/specs/2026-11-11-task-planning-engineering-roadmap-design.md §4 G4 / docs/superpowers/specs/2026-10-10-c4-subagent-design.md

## 1. 问题背景

C4 `spawn_subagent` 自 2026-10 上线以来生产零调用（`pi_runtime_subagent_spawned_total 0`，executionEvents 全量 0 次）。PR #836 已纠正「未进入生产运行时」的错误取证（实为已注册、metrics 三系列暴露），当时将零调用归因为「prompt-registry/skills 零点名」。本轮调查（B-4 后续）发现**更硬的结构性根因：工具层级（tiering）归属缺陷**——零点名只是表层症状。

## 2. 关键事实取证与分析

1. **工具渐进加载机制**（`services/pi-runtime/src/tools/tiering.ts`，0.0.31 起对齐 pi 官方 Dynamic Tool Loading）：
   - 全部工具注册进 config.tools，但 vendor generation 只下发 `activeToolNames` 内工具的 schema；
   - 延迟工具的发现通道 = `tool_search`；
   - 文件头铁律原文：「⭐ 判定某工具能否进延迟集的唯一准绳 = 有没有资产按名字点名它。点名 ⇒ 模型会直调 ⇒ 必须常驻；未点名 ⇒ 可延迟（靠 tool_search 发现）」，且「延迟即不可达——tool_search 触发率实测为 0（无动机时）」。
2. **spawn_subagent 不在 `ALWAYS_ON_TOOL_NAMES`**（master 源码逐条核对；常驻集含 todo_write / propose_plan / ask_user 等 C 系工具，唯独缺 spawn_subagent）⇒ 模型拿不到它的 schema 与「何时必用」description。
3. **生产实证**（2026-11-11，pi-lnk-runtime pod，镜像 `d9085d33`）：
   - `PI_RUNTIME_TOOL_TIERING=true`（tiering 启用，非 kill switch 关闭态）；
   - 生产 dist `tiering.js` 中 spawn_subagent 命中 0（不在常驻集）；todo_write 在（`:154`）；
   - `pi_runtime_tool_search_calls_total{outcome="hit"} = 4`（tool_search 可达，但模型没有任何动机去搜子代理——无资产点名、无 prompt 引导）；
   - `subagent_spawned_total 0`。
4. **规范-实现漂移**：C4 spec（2026-10-10-c4-subagent-design.md）对 tiering/延迟/常驻**零提及**——C4 上线时未走 tier 归属检查，而 tiering 守卫 `scripts/verify-tool-tiering.ts` 的 A1 判据（延迟集 ∩ 资产点名 = ∅）对「零点名+延迟」组合恒绿，三层（spec/代码/守卫）均未拦截。
5. **先例支持**（同文件自证）：`get_canvas_summary`（2026-10-07 提回常驻：description 自述「Call this first」却在延迟集 ⇒ 模型拿不到 schema ⇒ 生产退化）与分组三工具（2026-10-21：零点名常驻，「官方模式：description 承担发现能力」，且唯一入口无退路）——spawn_subagent 与两者同构：
   - description 已自述「何时必用：大范围查资料/核对多文件/联网调研…」；
   - **唯一入口性**：只读深度调研无任何常驻替代品；且 web_search/web_fetch 常驻只能「凑部分答案」（仅 web，不带画布/文档上下文），按文件头铁律「部分替代 ⇒ 幻觉，比没有能力更糟」，恰恰加重了提回常驻的必要性。

## 3. 方案

**最小正确刀：把 spawn_subagent 提回 `ALWAYS_ON_TOOL_NAMES`**（propose_plan 条目之后），附归属理由注释（注释内不出现带引号的字符串，守卫解析器约束）。

- 契合文件自身先例（group_nodes：零点名 + description 承担发现 + 唯一入口）；
- 零 prompt-registry 改动（L6 组合余量 25 字符，加规则物理不可行；且「点名 ⇒ 必须常驻」，点名不解决可达性）；
- 守卫影响：A1 不受影响（spawn_subagent 资产点名恒为 0）；A4 不适用；「常驻里零资产点名（可下沉候选）」会多列一项——这是**提示性输出非错误**，且本规格即为「不下沉」的裁决记录。
- 上下文成本：+1 个工具 schema（description 约 200 字符 + 参数 schema），相对 2026-10-07 get_canvas_summary 提回的量级，代价极小。

### 配套改动

- `tiering.test.ts`：新增回归锁用例（仿 get_canvas_summary 防下沉锁）+ 变异自检（临时移除条目 ⇒ RED）。
- C4 spec 头部追加状态注记（纯追加）：记录 tier 归属缺陷与本刀。
- 路标规格 §5 阶段 B 追加一行闭环记录（纯追加）。

## 4. 不做什么（No-Go）

1. 不改 prompt-registry / task_tool.md（预算封锁 + 不解决 schema 可达性）；
2. 不新建 prompt 规则文件、不扩规则组；
3. 不动 coordinator / gate / spawn-subagent.ts 工具本体（实现与 description 均健康）；
4. 不改 kill switch 语义（PI_RUNTIME_TOOL_TIERING=off 行为不变）；
5. 不在本刀内做「子代理并发/依赖」等能力增强（路标阶段 B 后续独立立项）。

## 5. 门禁与生产复测判据

1. 本地：pi-runtime 单测（tiering.test.ts 全绿）+ `vue-tsc/tsc` 无新错 + `verify-tool-tiering` 通过（解析 常驻 N/延迟 M 数字合理）。
2. CI：PR `pull_request` 三检查全绿（Build monorepo 含 pi-runtime 编译）。
3. 合并（需单独授权）：squash；合并树 == CI 已验证 PR head 树。
4. 部署：runtime-deploy 发 pi-runtime 新镜像；Nest 不受影响（本刀不触 deploy.yml paths，合并后零 Nest 发布为预期）。
5. 生产复测（镜像更新后）：
   - dist `tiering.js`：spawn_subagent 进入常驻集（grep 命中于 ALWAYS_ON 块内）；
   - `/metrics`：health 200、subagent 三系列仍在；
   - 行为验证（诚实边界）：「模型在调研类任务中是否真的调用」需真实会话观察，本环境不可代跑——只取证 schema 可达（dist+部署面），调用率交由 metrics 持续观测，不预设阈值。

## 6. 诚实边界

- 「提回常驻 ⇒ 模型会用」是合理推断非保证（get_canvas_summary 先例支持，但调用率受模型与任务分布影响）；观测周期内若 spawned 仍为 0，回头评估 prompt 点名替代方案（需先解决预算）。
- 常驻数量对 roadmap「常驻 ≤28」目标的偏离未做专项评估（P1 目标为 2026-10-06 时点口径，其后 C1/C3/分组等已多次自然增员）。
- 本刀只修可达性；C1-B 并行清单、子代理并发等仍按总纲触发条件字面执行。
