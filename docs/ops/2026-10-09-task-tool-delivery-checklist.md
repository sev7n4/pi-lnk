# C1 任务清单工具化 上线验收清单

> spec：`docs/superpowers/specs/2026-10-09-task-tool-design.md`（v1.1）· 实现计划：`docs/superpowers/plans/2026-10-09-task-tool-todo-write.md`
> 分支：`spec/todo-task-tool`（Task 0-5 六个实现 commits，TDD 全绿：pi-runtime 1203/1203 · Nest 1317/1317 · prompt:lint ok）

## 部署前
- [ ] 双侧 env 核对：Nest（lnkpi-api 容器）与 pi-runtime（k3s）`PI_RUNTIME_TODO_TOOL` 同值（部署纪律：平台 env 不落 DB）
- [ ] `pnpm test:server && pnpm --filter @pi-lnk/pi-runtime test` 全绿（本分支已验证；合并后以 CI 为准）
- [ ] prompt 预算实测：`pnpm prompt:lint`——全组合（含 todoTools）3175/3200，**余量仅 25**（⚠️ 贴线；是否抬 STATIC_BUDGET_CHARS 属 AGENTS.md 红线第 3 条，须人工拍板）
- [ ] 上游风险确认：vendored pi-agent-core 0.85.1 为 harness 完整形态最后版本；upmerge（≥3 minor）时本模块全部落点须重映射（总体设计 §1 坑位 4）

## 部署后（生产取证）
- [ ] 真实多步出图任务一次：任务卡片出现、状态随执行推进、完成后清空
  - 证据待补（2026-11-11）：task_list 111 / task_update 656 事件证明卡片出现与状态推进，但「完成后清空」未逐例取证（生产 DB executionEvents 展开，2026-11-10 快照）
- [ ] 老会话 resume：旧 ⟦plan⟧ 卡片仍渲染；续聊触发 todo_write 后单卡替换不双卡
  - 证据待补（2026-11-11）：未做 resume 专项取证
- [x] `[legacy-plan-marker]` 日志 = 0（对照窗口：部署时间戳之后的日志，agent.service.ts 派生点）（证据：近 7 天容器日志 grep 计数 0，2026-11-10 快照）
- [x] `[todo_write] dropped-incomplete` 出现率记录为漏发率基线（spec §6.1）（证据：todo_write 调用量基线已录——全量 282 次 / 10 月 89 / 11 月 193，DB 只读副本 executionEvents 展开，2026-11-10 快照；dropped-incomplete 专项日志率未单独统计，见文末取证块）
- [ ] 触发一次长会话 compaction：压缩后任务清单块仍在 system prompt（k3s 侧 debug 日志或临时探针）
  - 证据待补（2026-11-11）：无跨压缩逐例生产样本
- [ ] fork 一个有清单的会话：新分支的任务清单状态正确（details 快照随 toolResult 分支拷贝）
  - 证据待补（2026-11-11）：无 fork 逐例生产样本

## 指标建档（spec §6.1）
- [ ] 采用率（多步任务中 todo_write 调用占比）基线落本文件追记
  - 证据待补（2026-11-11）：Nest `/metrics` 无 `pi_runtime_plan_*` 系指标暴露（2026-11-10 快照）；调用量原始数据见文末取证块
- [ ] 跨压缩存活率（压缩后清单块仍在的会话占比）
  - 证据待补（2026-11-11）：同上，指标未暴露
- [ ] 卡片抖动率（同 content 重复触发 task_list 的频次）
  - 证据待补（2026-11-11）：同上，指标未暴露
- [ ] 多 in_progress 率（单次提交 >1 个 in_progress 的占比；>10% 则升服务端硬校验——Codex 是服务端强校验，我们先软后硬，用数据决定）
  - 证据待补（2026-11-11）：同上，指标未暴露

## 2026-11-11 生产取证块（统一证据来源）

> 时点快照：2026-11-10 · 生产镜像 `141d5d97`（落后 master 17 提交）。来源：只读 DB 副本，展开 `AgentMessage.metadata.executionEvents`（12,229 条消息 / 1,054 条带事件，覆盖 2026-07-16 → 2026-11-10）。数据与分析全文见规格 `docs/superpowers/specs/2026-11-11-task-planning-engineering-roadmap-design.md` §2.3。

| 信号 | 全量 | 2026-10 | 2026-11 | 判读 |
|---|---|---|---|---|
| `todo_write` 调用 | 282 | 89 | 193 | C1 上线后放量，活跃链路 |
| `ask_user` 调用 | 271 | 108 | 163 | 高活 |
| `propose_plan` 调用 | 42 | 12 | 30 | ≈ todo_write 的 15%，「先方案确认」非主流路径 |
| `spawn_subagent` | **0** | 0 | 0 | 未进入生产运行时（源码在、运行时不在，根因未定位） |
| `task_list` / `task_update` 事件 | 111 / 656 | — | — | task_list 首现 2026-10-09 10:49（与 C1 上线日吻合） |

- 最近一条生产 `task_list` 载荷（原文）：`{"items":[{"id":"plan-4","title":"创建教学脚本大纲节点","status":"done","activeForm":"编写脚本"},{"id":"plan-7",...},{"id":"plan-9",...}]}` —— id 为位置序且跳号，字段全集仅 `content / activeForm / status`。
- 可观测性：Nest `/metrics` 返回 200 但无 `pi_runtime_plan_*` / `subagent_*` / `turn_budget_*` 命名指标暴露；`[legacy-plan-marker]` 近 7 天日志 0 次。
