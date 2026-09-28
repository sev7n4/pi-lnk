# Agent 对话体验 P0-P2 优化设计（2026-09-28）

- **状态**：设计经用户分节确认（2026-09-28），待实现
- **来源**：`docs/discussion/2026-09-28-agent-conversation-ux-gap-analysis.md`（差距分析）+ 用户对 11 项决策点的逐条确认（全部按推荐默认）
- **范围**：前端消费侧为主 + Nest 事件映射微调；**不改 pi-runtime、不新增 SSE 事件类型**
- **关系**：P0#1/#2 为 bug 级修复；P1 为主干体验；P2 含清理与增强。runtime 侧事件生产者（阶段事件、todo 工具化、绘图工具）明确不在本期，见 §9

## 0. 配图索引

本文档不含图（改动面用表格与清单表达，无状态机/拓扑需要图示）。

## 1. 决策记录（2026-09-28 用户确认，全部按默认）

| # | 决策点 | 结论 |
|---|---|---|
| ① | 分期与合并 | 单分支、3 批 commit（P0→P1→P2）、单 PR |
| ② | pi-runtime 是否动 | **不动**。阶段叙事前端聚合；todo 用 prompt 标记；runtime 生产者留 P3 |
| ③ | gen_progress 死契约 | **删**（controller/service/契约/前端分支）；prisma model 保留 |
| ④ | thinking 展示 | 折叠面板 + end 后全文（b 方案），不做逐字流 |
| ⑤ | 错误三段式 | 人话映射表 + 兜底原始 message，不做 LLM 二次解释 |
| ⑥ | 工具卡 | 全量 12 工具摘要；≥3 次连续同调用合并 |
| ⑦ | 产物缩略图 | 缩略图 + 点击定位画布（focus_node 链路），不做弹层画廊 |
| ⑧ | ask_user 恢复 | questions 落 message metadata，不新增端点 |
| ⑨ | mermaid | npm 包 + 动态 import 懒加载，失败降级 `<pre>` |
| ⑩ | 绘图澄清工具 | 本期不做，登记「有意不支持」（§9） |
| ⑪ | 重连去脆弱化 | thread-state 回合终态查询替代 snippet 文本匹配轮询 |

## 2. 架构总览与不变式

**总原则**：所有改造落在「Nest 现有产出 → 前端消费」链路上。消费的事件集合不变：

```
text_delta / tool_call / tool_result / canvas_action / canvas_command /
thinking / turn_usage / done / pi_error
```

目标：前端从「部分消费」变为「全消费」。两个例外说明：

- `pi_error` 此前被前端静默丢弃（bug），本期正式纳入消费（P0#1）。
- `thinking` 事件由 Nest accumulator 产出，本期载荷从「200 字摘要」扩为「全文」（server 内存已有完整累积，仅序列化截断，无契约破坏）。

### 2.1 阶段叙事：前端聚合器

新增 `apps/web/src/components/agent/phaseAggregator.ts`（纯函数）：

- 输入：tool_call / tool_result 事件流
- 输出：当前阶段，三态枚举
  - `exploring`（探索中）：read 类工具活跃（get_canvas_summary、load_skill、引用检索等）
  - `creating`（创作中）：写类工具活跃（run_*、upsert_media_node、propose_generation 等）
  - `wrapping`（收尾中）：cancel_generation 后至 done 前
- 未知工具默认归入 `exploring`，不阻塞
- 输出喂给现有 `executionTraceReducer` 的 step 分支；`AgentExecutionTrace.vue` 顶部渲染当前阶段徽章
- 理由：不改契约、可独立单测、runtime 侧 phase 事件（P3）就绪后可直接替换输入源

### 2.2 todo 面板：服务端 prompt 标记

- agent system prompt（Nest 侧组装处）追加约定：多步任务开工前输出一行 `⟦plan⟧{JSON: [{n, title}]}`、每完成一项输出 `⟦task-done⟧n`
- Nest 在 text_delta 持久化前**剥离标记**，派生为 assistant message metadata 字段（`planTasks` / `taskDone`）
- 前端 `AgentTaskProgressCard.vue` 改由 metadata 驱动；现有 `reconcileFromNodes` 画布对账降级为校验兜底（不一致时以画布为准并打日志）
- 解析器为纯函数（`planMarkers.ts`），容错：畸形 JSON 静默丢弃不展示

## 3. P0 改动面（bug 级修复）

### 3.1 错误链路（P0#1）

| 位置 | 改动 |
|---|---|
| `AgentSideRail.vue` handleEvent | 新增 `pi_error` 分支，映射为与现有 error 分支同构的结构进 store |
| `stores/agent.ts` | 记录 `failureReason`（结构化：kind / message / suggestion） |
| 错误卡渲染（新 `AgentErrorCard.vue` 或复用现有 callout 容器） | 三段式：**发生了什么**（具体失败）→ **可能原因**（映射表：超时/限流/权限/模型错误等人话；映射不上则展示原始 message）→ **下一步**（重试按钮，复用 sendMessage 幂等链路） |
| `executionTraceReducer.ts` `applyToolCall` | 尊重 `tool_result.isError`：失败步骤红色 ✗、**保留在时间线**（不消失）、摘要取 error message |

### 3.2 思考面板（P0#2）

| 位置 | 改动 |
|---|---|
| `apps/server/src/agent/pi-runtime/pi-events.ts` | thinking accumulator 结束时序列化**全文**（现为 200 字截断） |
| 前端 trace 区 | 独立「思考」折叠区块：默认折叠、首行摘要可见、展开看全文；位于时间线顶部、普通工具步骤之前 |
| thinkingLevel=off | 区块不渲染（事件本身不产出，前端容错即可） |

## 4. P1 改动面（主干体验）

### 4.1 工具调用卡（P1#3）

- `toolPresentation.ts`：注册表从 5 精确名 + 兜底扩为**全 12 工具**图标+动词
- `toolArgSummary.ts`：全量补齐参数摘要（现仅 4 工具）
- 新 `ToolCallCard.vue`：名称+图标+参数摘要+状态徽章+耗时+可展开完整结果
- 耗时：前端 tool_call→tool_result 本地时间差（runtime 无耗时字段）
- 合并规则：≥3 次连续同工具调用合并为一张带计数的卡

### 4.2 阶段徽章（P1#4）

§2.1 方案。徽章状态机：无事件时隐藏 → 首个 tool_call 出现 → done 后随时间线折叠。

### 4.3 todo 面板（P1#5）

§2.2 方案。

### 4.4 产物缩略图（P1#6）

- `AgentCanvasOutputs.vue`：产出行加缩略图——图片 `<img>`；视频取 url 首帧 + 播放角标
- 点击行为：复用 focus_node / canvas_command 链路定位画布节点，**不做弹层画廊**（画布即画廊）
- 无 url / 加载失败：降级为现有类型 icon

### 4.5 ask_user 恢复（P1#7）

- ask_user 派发时 questions 序列化进 assistant message metadata
- `loadHistory` 与重连恢复路径重建待答卡片；已答状态灰显（不可再点）
- 卡片与对应工具调用行做关联标注（同 turn 关联）

### 4.6 重连去脆弱化（P1#11）

- `reconcileLatestAssistant`（`AgentSideRail.vue:1850-1922`）从「BUSY_TIP_SNIPPET/COPY_WRITTEN_SNIPPET 文本匹配轮询 36×5s」改为「轮询 thread-state 回合终态字段判断完成 + 有限重试上限」
- 文本常量与匹配逻辑删除

## 5. P2 改动面（清理与增强）

### 5.1 mermaid 渲染（P2#8）

- `web/package.json` 新增 `mermaid` 依赖
- `AgentTopoCardList.vue`：mermaid 内容动态 `import('mermaid')` 渲染；渲染失败降级回 `<pre>` 源码（现状即降级形态）

### 5.2 死代码清理（P2#10）

| 项 | 动作 | 实证 |
|---|---|---|
| `AgentPanel.vue` | 删除 | 全仓 0 引用（import grep 实证） |
| `AgentFloatingWindow.vue` | 删除 | 同上 |
| gen_progress | 删 controller 端点（agent-canvas-tools.controller.ts:1355）、service 方法、`agentContract.ts:566-593` 契约、前端 reducer 分支 | 前端 0 引用；轮询链路已覆盖需求 |
| prisma `genProgress` model | **保留**（迁移成本>收益） | — |
| journeyTrace | 删死契约定义 | 无生产者、无消费者 |
| PHASE_LABELS（useAgentStream.ts） | 仅保留重连恢复实际使用的键，其余删 | pi 路径不产出 phase_hint |

每删一项在 §9「有意不支持/已退役」清单登记。

## 6. 错误处理

- 错误呈现统一收敛在错误卡一处；trace 内失败步骤与错误卡并存（时间线管过程审计，错误卡管行动）
- phaseAggregator 未知工具不抛错、归入 exploring
- plan 标记解析对畸形 JSON 静默丢弃
- mermaid 渲染失败不阻塞卡片其余内容
- 缩略图加载失败降级 icon

## 7. 测试策略

| 层 | 覆盖 |
|---|---|
| 纯函数 vitest（大头） | phaseAggregator、planMarkers、toolArgSummary 全量、错误映射表 |
| reducer | applyToolCall isError 分支、thinking 全文分支、replay 兼容旧 metadata |
| Nest 集成 | pi-events thinking 全文序列化、text_delta 标记剥离与 metadata 派生、gen_progress 端点删除后无残留路由 |
| 组件测试 | ToolCallCard、思考面板、缩略图降级、ask_user 恢复、错误卡三段式 |
| 快照 | AgentSideRail 渲染分支沿用现有快照模式更新 |
| 门禁 | 本地改动相关测试 + `tsc --noEmit`；CI 三项（Verify spec figures / Build monorepo / Build API Docker image） |

## 8. 交付批次

单分支（worktree），3 批 commit，单 PR：

1. **Batch P0**：错误链路 + 思考面板（含 pi-events 全文改动）
2. **Batch P1**：工具卡 + 阶段徽章 + todo 面板 + 缩略图 + ask_user 恢复 + 重连改造
3. **Batch P2**：mermaid + 死代码清理 + 「有意不支持」登记

CI 通过且用户验收后合并；合并期间遵守部署串行纪律（队列未清空不合并新 PR）。

## 9. 有意不支持 / 已退役（本期登记）

| 项 | 结论 | 依据 |
|---|---|---|
| pi-runtime 侧 phase/task 事件生产者 | 有意不支持，留 P3 立项 | runtime 构建部署重（no-cache >10min）；前端聚合已满足当前叙事需求 |
| 绘图澄清工具（SVG/图表生成） | 有意不支持，留 P3 | 同上，需 runtime 新增工具 |
| thinking 逐字流 | 有意不支持，待 runtime 事件打通后升级 | 本期 b 方案已覆盖「可审计」诉求 |
| 产物弹层画廊 | 有意不支持 | 画布即画廊（focus 定位已可达） |
| gen_progress 长任务进度行 | 已退役（删除） | 轮询链路已覆盖；双轨徒增维护面 |
| prisma genProgress model | 保留但无消费方 | 迁移成本>收益，随下次 schema 变更再清理 |

## 10. 风险

- **AgentSideRail.vue 体量大**（2600+ 行）：新组件一律独立 .vue 文件，handleEvent 分支改动以最小 diff 为准；不做顺手重构
- **metadata 派生影响落库路径**：text_delta 剥离标记的改动必须保证「无标记时字节级等价」（回归测试锁）
- **删 gen_progress 端点**：先 grep 全仓（含 deploy/ 审计脚本）确认无隐藏调用再删
- **三入口漂移已通过删除消解**：若后续发现隐藏引用（动态 import 等），实施时以 grep 复核为准
