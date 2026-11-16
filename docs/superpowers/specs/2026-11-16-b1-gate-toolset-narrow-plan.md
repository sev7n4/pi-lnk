# B-1 门禁态工具声明集收缩 — 实施计划

- **状态**：plan·待实施（立项基座 `2026-11-15-b123-upstream-primitives-design.md` §1 的细化产物）
- **worktree**：`/Users/4seven/workspace/pi-lnk-b1` @ master `c86b1dbe`，分支 `feat/b1-gate-toolset-narrow`
- **上游锚**：vendor `lane.getActiveTools(ctx): Promise<string[]>` + `lane.setActiveTools(names, ctx)`（declared set 双向接口，0.85.1/0.99.2 一致）

## 1. 目标与动机（基座 §1 摘录）

plan-pending / fail-closed 期间，写工具（tier ∈ `PLAN_GATED_TIERS`）仍 declared → 模型看得见、调了被 before_tool 拦 → 浪费一轮调用 + 拒绝回执噪声。声明集收缩让模型**根本看不到**写工具 schema，结构性减少无效回合。before_tool 拦截保留不动（二线防线，语义不变）。

## 2. 设计裁决（本 plan 新增，基座 §1 四要点全部继承）

- **D1 双挂点全覆盖**（解决基座未细化的时序缺口）：
  - `after_tool`（run 内即时双向）：`toolName === "propose_plan"` 且 `details.plan.decision` 存在时——`execute` → **同点还原**（确认当轮就要写画布，收缩态若带到 run 剩余部分 = 确认了却写不了的严重回归）；`refine/keep/timeout/aborted` → **同点收缩**（fail-closed 的声明集化）。
  - `before_run`（跨 run 态收敛）：覆盖 `seedPlanState` resume 播种、keep/timeout 跨 run 持续。pending ⇒ 收缩；非 pending 且会话处于收缩态 ⇒ 还原。幂等：状态与动作一致时跳过（防重复打点）。
- **D2 单写者纪律**（基座 §4-D2）：declared set 的 host 侧写点只有本 wiring（tiering 只在装配时给初值、tool_search 走 vendor addedToolNames 原生通道——均不在本刀触碰面）。纯函数放独立 `gate/toolset-overlay.ts`，不膨胀 tiering。
- **D3 fork 陷阱规避**：还原一律 `getActiveTools` **现算**差分 + `narrowedRemoved` 记账合并加回，**不持跨会话快照**。子会话 plan-gate store 键独立 ⇒ fork 天然 no-op。
- **D4 还原保护 tool_search 激活**：收缩后到还原前的窗口内，tool_search 激活的延迟工具在还原时以「合并加回」保留（`[...new Set([...current, ...removed])]`），不是恢复快照。
- **D5 kill switch 沿用**：`planGateEnabled()` off ⇒ 两钩子都不注册（既有三面全关语义，新增面不加独立开关）。
- **D6 观测**：`pi_runtime_toolset_gate_narrow_total{kind="narrow"|"restore"}`（基座 §4-D4 命名）。

## 3. 实施清单（DELTA 预估 5 文件）

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `gate/toolset-overlay.ts`（新） | 纯函数 `computeNarrow(activeNames, tiers, exempt)` → `{narrowed, removed}`；`computeRestore(activeNames, removed)` → `string[]`。tier 判定集合从 `plan-gate.ts` 导入（PLAN_GATED_TIERS / PLAN_EXEMPT_TOOLS 单源） |
| 2 | `gate/plan-gate.ts` | `PlanSessionState` 增 `toolsetNarrowed: boolean` + `narrowedRemoved: string[]`；`setToolsetNarrow(key, narrowed, removed)` / `getToolsetNarrow(key)`（LRU 同构，随 stateFor 创建） |
| 3 | `gate/plan-gate-wiring.ts` | `registerPlanGateHooks` 增两钩子：`before_run`（跨 run 收敛/还原）+ `after_tool`（run 内即时双向，读 `event.details.plan.decision`）。lane 访问 = `harness.lane(MAIN_LANE, context)`（`MAIN_LANE="main"` 本地常量 + 锚点注释防漂移）。handler 抛错 fail-open（还原/收缩失败只 warning 打点，不阻塞 run——声明集是优化不是正确性，before_tool 拦截仍在） |
| 4 | `metrics.ts` | `observeToolsetGateNarrow(kind)` + export 行 |
| 5 | `gate/plan-gate-wiring.test.ts` + `gate/toolset-overlay.test.ts` | 行为级：fake lane 断言 setActiveTools 收到收缩集/还原集；execute 即时还原断言；tool_search 激活保护断言；kill switch 不注册断言 |

## 4. 验收判据

1. pending 会话 run 开始后 lane declared set 无 gated 写工具（行为断言 fake lane 收到的 names）。
2. execute 确认后同 run 声明集还原（after_tool 时点，先于下一模型步）。
3. 还原保留窗口期 tool_search 激活的工具。
4. kill switch off ⇒ 钩子不注册、零 lane 写。
5. handler 异常 fail-open（spy 抛错 ⇒ run 不受影响）。
6. 全量 `node --import tsx --test` 绿 + `vue-tsc`（server 侧 tsc）干净 + 变异自检 RED（砍收缩调用 ⇒ 测试红）。

## 5. 诚实边界

- cache_read 打散（声明集变化使 provider 前缀失效）为定性接受，生产复测时做一次门禁进出 cache_read 对照（基座 §5-2 要求），不阻塞合并。
- 收缩面 = 已注册写工具；「注册表外未知工具」不在此刀收紧（plan-gate 既有边界）。
