# P2 观测指标实施计划：pi_runtime_propose_outcome_total{reason}

> 来源规格：`docs/superpowers/specs/2026-10-13-propose-confirm-evidence-and-clarify-matrix-design.md` §2 P2（本批登记项，现落地）。
> 前置事实：P0-A 已上线（tag 7303543ac），propose 结算已收敛到单点 `outcome`（Promise.race 之后）。

## 0. 目标与非目标

**目标**：runtime /metrics 新增 counter `pi_runtime_propose_outcome_total{reason}`，按结算 reason 分布计数——回答「propose 等待期到底以什么方式结束」（ answered / timeout / stale_status:* / …），为 2026-10-12 虚假确认类事故提供永久观测面。

**非目标**：
- ask_user 触发率**不加新指标**——事件层 `tool_calls_total{tool="ask_user"}` 已存在（2026-10-04 全工具统一结算），触发率 = ask_user 调用数 / 总 turn 数，派生即可；
- eval 场景（style-unspecified-declare 等 3 条）另批落地，不在本计划。

## 1. 关键设计约束（来自代码取证）

1. **工具层不持 Metrics**（2026-10-04 既定纪律，registry.ts 三处注释）：计数统一走事件层。但 propose 的 `reason` 在工具结果 JSON 内部，事件层只能正则猜 ⇒ 采用 **回调观察者注入**（同 memory.ts `SuppressionObserver` 模式，#182 解耦先例）：`createCanvasWriteTools` 新增 `opts.onProposeOutcome?` 回调，工具层零 Metrics import。
2. **接线点**：`tools/config.ts` `resolveToolsWithClient(metrics, deps)` 作用域天然持有 metrics，在此把回调接到 `metrics.observeProposeOutcome`。
3. **结算单点**：propose_generation 的所有出口收敛于 Promise.race 后的 `outcome`（canvas-write.ts:447-456）；另有 race 前**旧行为早退**（:355，无 registry 或 B-5 off）——记 `reason="nonblocking"`（这不是等待结算，但归零它会使分母失真）。
4. **label 基数防御**：`stale_status:${status}` 的 status 来自前端写入的任意终态 ⇒ 白名单归一：`completed|error|failed|cancelled` 保留，其余 → `stale_status:other`。归一在 `Metrics.observeProposeOutcome` 内做（单点、可测）；工具结果/模型可见文本**不变**（归一只作用于 label）。
5. **零流量不渲染数据行**：Map 为空只出 HELP/TYPE（与 skill_loads / result_signal 同口径）。

## 2. reason 取值域（label 白名单）

| reason | 语义 | confirmed |
|---|---|---|
| answered | /answers 显式确认（唯一不依赖 SSOT 时序的路径） | true |
| generating / fallback_pending | 轮询见 in-flight 状态 | true |
| new_record / new_generation | 轮询见新生成指纹 | true |
| timeout | 等待时限到 | false |
| aborted | 用户中止 | false |
| rejected | draft 稳定启发式（连续 2 次 draft） | false |
| gone | 节点消失 / 连续查询失败 | false |
| stale_status:completed\|error\|failed\|cancelled\|other | 终态残留、无新生成证据（2026-10-12 事故形态） | false |
| nonblocking | B-5 off / 无 registry 的旧行为早退 | —（非阻塞路径） |

## 3. 任务分解（bite-sized）

- **T1 metrics.ts**：字段 `proposeOutcomes` + `observeProposeOutcome(reason: string)`（内含 stale 归一）+ render 块（尾部既有族之间，恒渲染 HELP/TYPE）+ 头部注释表加一行。label = `{reason}`（confirmed 可由 reason 推导，不双写）。
- **T2 canvas-write.ts**：`opts` 加 `onProposeOutcome?: (reason: string, confirmed: boolean) => void`；早退路径 :355 与 outcome 单点各调一次（try/catch 包裹？否——观察者只做 Map.set，不允许抛；约定注释写明）。
- **T3 registry.ts + config.ts**：`buildCanvasWriteTools` 加第三参 `hooks?: { onProposeOutcome? }` 透传；config.ts 接线 `metrics.observeProposeOutcome`。
- **T4 测试**：
  - metrics.test.ts：多 reason 计数渲染 + stale 归一（`stale_status:weird` → `stale_status:other`）+ 空 Map 无数据行；
  - canvas-write.test.ts：① 无 registry → onProposeOutcome("nonblocking", false)；② answered（registry resolve）→ ("answered", true)；③ stale completed → ("stale_status:completed", false)；④ timeout → ("timeout", false)。
- **T5 文档**：规格 §2 P2 标注「已实施（本计划）」；本文件回填实测。

## 4. Review Focus

1. 早退路径与 outcome 单点**不能双计**（一个 propose 恰好一条观测）；
2. 归一不得改动模型可见的 tool_result 文本（只动 label）；
3. 回调签名 `(reason, confirmed)`——confirmed 放第二位，容未来加第三参；
4. 部署面：services/pi-runtime 变更 ⇒ 需 runtime-deploy（tag=合并后 master 短 SHA）。

## 5. 验收

- 46+ 新增用例全绿（本机内存受限时关键用例 -t 过滤跑，全量交 CI）；
- /metrics 渲染含新族且既有族逐字节不变（render 顺序：追加不改前文）；
- 生产取证：runtime /metrics 出现 `pi_runtime_propose_outcome_total` 族。

## 6. 实测回填（本地）

- metrics.test.ts **31/31 绿**（含新增 3 条：多 reason 渲染 / stale 白名单归一 / 零样本无数据行）；
- canvas-write.test.ts **51/51 绿**（46 → 51，新增 5 条：nonblocking×2 / answered / stale_status:completed / timeout）；
- `tsc -p … --noEmit` RC=0（借主仓 tsc 对 worktree tsconfig 显式 -p，规避 cwd 静默重置与 OOM）。
