# 实施计划——spawn_subagent 调用升级预案（观测期预案刀）

> 规格锚：`docs/superpowers/specs/2026-11-11-subagent-invocation-escalation-design.md`（§3 触发条件 / §4 路径裁决 / §5 观测纪律）。
> 本计划 **只含 docs-only 刀**（本 PR）+ 触发后的执行 stub。P3/P4/P5 代码刀各自触发后重新走 specs→plans→implementation，不在本计划展开。

## Task 1（本 PR，docs-only）：裁决落档 ✅

- [x] spec：`2026-11-11-subagent-invocation-escalation-design.md`（6 章，F1–F6 取证 / T1–T2 触发 / P1–P5 裁决）
- [x] plan：本文件
- [x] 预算/行号等数字核对：F2（`STATIC_BUDGET_CHARS=3200`）、F3（`session-manager.ts:2332` 48_000）、F5（`gate/plan-gate.ts:70`）均本机读码核实
- [ ] PR 合并 + CI 全绿核验（合并树 == head 树）

## Task 2（观测期，0 代码）：守基线

- [ ] 基线记录：2026-11-11 16:00 `spawned_total=0`、`tool_search_activated_total=0`（F6）——已记入 spec §2-F6
- [ ] 观测动作：合并 7 天后（或 200 run 先到）ssh 取三序列快照：
      `pi_runtime_subagent_spawned_total` / `pi_runtime_plan_gate_blocked_total{tool="spawn_subagent"}` / `pi_runtime_tool_search_calls_total`
- [ ] T2 场景抽样：executionEvents 按意图标记（联网/多文件/调研）抽 run，判定「没场景」vs「有场景不用」
- [ ] 判定回填本文件：T1∧T2 → 走 Task 3；否则 No-Go 回填一句结论，主线到此为止

## Task 3（仅触发后）：按 §4 执行顺序起刀

- [ ] 先看 `plan_gate_blocked_total{tool="spawn_subagent"}`：> 0 → P4 独立评审刀（改 C3 安全语义，须单独授权）；= 0 → P3 动态 guideline 块刀
- [ ] P3 实施要点（届时展开为独立 plan）：`assembleDynamicBlocks`（session-manager.ts:2344）加 guideline 块 + dynamic-budget kind 份额 + `observeDynamicBudgetDrop` 通道复用；回归锁 = 块在/预算 kind 生效/压缩后重求值恒在
- [ ] 每刀结束：runtime-deploy → 取证 → 复测报告；一个周期后仍 0 → P5 description 兜底 → 仍 0 → 止损回填

## 红线（沿用纪律）

- 观测期内禁 P3/P4/P5 任何代码改动（基线作废 = 归因失效）
- prompt-registry 任何改动须 `pnpm prompt:lint` + 6 处同步（本刀零触碰）
- 独立窗口改动同文件（session-manager.ts）须合并评审
