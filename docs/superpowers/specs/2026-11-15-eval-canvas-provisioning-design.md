# Eval Harness 增强（P1）立项：每 run 新画布（canvas provisioning）

> 性质：立项 spec（设计稿·已评审拍板，实施未排期）。
> 上游：C-1b §9.3「画布无重置能力」诚实边界 + §10 基线回填 q3-07 画布污染实证（67 节点 > 上界 8）。
> 用户裁决（2026-11-15）：①P1 立项拍板「每 run 新画布」路线，**先于**画布快照/恢复（轻一个量级）；②**接线拍板方案 A（CLI 内建）**；③D2–D4 按 §2.2 推荐立场执行（归档不删 / fail-fast / 记 provisioned），实施 spec 里复核。
> ⭐ 适用范围澄清（2026-11-15 用户问询后补）：本机制**仅作用于 eval 跑批 CLI**（`services/pi-runtime/src/eval/`，显式运行才触发，测试账号自建自用）；生产用户路径零接触（生产入口零 `./eval` 引用，C-1a 已核实），用户正常创建/使用画布的流程不变。

## 1. 问题

eval 所有 case 共享同一画布（`PI_EVAL_CANVAS_SESSION_ID` 固定值，如 `cmwcxs37a00hhpa011rurftwg`）：

1. **跨 case 污染累积**：画布节点随 case 只增不减（67 节点），带 `requiresCanvasNodes`/收尾上界判据的 case（q3-07 等）直接 error——环境问题被计入 error 桶，污染通过率分母语义；
2. **跨 run 状态漂移**：run-1 与 run-2 虽逐 case 仅 1 条变化，但画布初始态已不同（run-1 起点比 run-2 干净），基线对比的「同门」假设随 run 数增长持续退化；
3. **Q3 终态断言力弱**：上界 only 判据在脏画布上越来越松（§9.3 已声明）。

## 2. 方案：每 run 自动建画布

**run 开始时**用测试账号（17279698608 / userId `cmrn3ghmt000hpi01fdl0gkjp`）经 Nest API 自动创建新画布会话，取得新 `canvasSessionId` 传给本轮全部 case；**run 结束不删**（只归档命名，保留取证现场）。

### 2.1 接线设计（三选一，评审拍板）

| 方案 | 做法 | 优劣 |
|---|---|---|
| A. CLI 内建（推荐） | `cli.ts` 开跑前调 Nest 建画布，新 id 注入 options；`PI_EVAL_CANVAS_SESSION_ID` 仍在 ⇒ 显式传入优先（可复现单画布模式） | 零新进程编排；失败即 error（明确） |
| B. 外部脚本 | run 前脚本建画布写 env | 灵活但多一步编排，易忘 |
| C. runner 每 case 一画布 | 隔离最彻底 | 成本高（画布创建 × 39）、画布列表爆炸；**No-Go**（跨 case 会话连续性 case 也用不上） |

### 2.2 关键决策点（评审拍板）

- **D1 建画布 API**：Nest 侧画布会话创建端点复用（测试账号登录态/service token 调用）；`driver.ts` 的画布探针（`requiresCanvasNodes` 预检）已依赖 NEST_BASE_URL/NEST_SERVICE_TOKEN，同一凭据面。
- **D2 旧画布处置**：只改名归档（如 `eval-used-<runId>`），**不删除**——生产 DB 写纪律与取证习惯一致；画布数量增长可接受（每 run 1 个）。
- **D3 失败语义**：建画布失败 ⇒ 整 run error（fail-fast），不回落共享画布（回落会把环境问题伪装成行为问题，重蹈 q3-07 覆辙）。
- **D4 JSON 记录**：run 汇总新增 `canvasSessionId` 已有字段——新建时记录**新 id + 创建来源（provisioned）**，报告可见「本轮画布是新建的」。

## 3. 验收标准

1. run-3 起每 run JSON 里 `canvasSessionId` 为新建 id，C-1b 基线对比口径升级为「同 run 同画布、跨 run 各自干净」；
2. q3-07 类 `requiresCleanCanvas` 预检 error 归零；
3. 显式传 `PI_EVAL_CANVAS_SESSION_ID` 时行为与现状完全一致（单画布复现模式保留）。

## 4. 边界

- requiresConfirm 4 条**不在本立项**（用户拍板：A-6 真机走查覆盖；自动确认有真实生成副作用且绕过被测确认门，No-Go）。
- 画布快照/恢复（精确中间态断言）仍按 §9.3 保持独立立项，不因本刀取消。
- 实施刀需先探明 Nest 建画布端点契约（GET /api/canvas-sessions? POST 语义），实施 spec 里补生产锚。
