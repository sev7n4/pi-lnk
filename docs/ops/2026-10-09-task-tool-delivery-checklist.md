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
- [ ] 老会话 resume：旧 ⟦plan⟧ 卡片仍渲染；续聊触发 todo_write 后单卡替换不双卡
- [ ] `[legacy-plan-marker]` 日志 = 0（对照窗口：部署时间戳之后的日志，agent.service.ts 派生点）
- [ ] `[todo_write] dropped-incomplete` 出现率记录为漏发率基线（spec §6.1）
- [ ] 触发一次长会话 compaction：压缩后任务清单块仍在 system prompt（k3s 侧 debug 日志或临时探针）
- [ ] fork 一个有清单的会话：新分支的任务清单状态正确（details 快照随 toolResult 分支拷贝）

## 指标建档（spec §6.1）
- [ ] 采用率（多步任务中 todo_write 调用占比）基线落本文件追记
- [ ] 跨压缩存活率（压缩后清单块仍在的会话占比）
- [ ] 卡片抖动率（同 content 重复触发 task_list 的频次）
- [ ] 多 in_progress 率（单次提交 >1 个 in_progress 的占比；>10% 则升服务端硬校验——Codex 是服务端强校验，我们先软后硬，用数据决定）
