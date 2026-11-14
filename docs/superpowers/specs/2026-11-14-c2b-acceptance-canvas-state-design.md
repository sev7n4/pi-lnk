# C-2b acceptance：canvas_state 判据子域扩展（立项规格）

> 日期：2026-11-14 · 状态：待实施 · 依赖：A-2'（#863）、Skill SOP（#864）、C-2a（#866，均已上线）
> SSOT：路标 §14（`2026-11-11-task-planning-engineering-roadmap-design.md`）、C-1 §8.3（`2026-11-12-c1-canvas-decomposition-eval-design.md`）
> 按 v1.3 规格生命周期冻结（PR #860）：本刀细化**只进本文**，路标 §14 只回填状态行，正文不改。

## 1. 背景与范围

C-2a 已落地 `generation` 子域：模型在 `todo_write` 里给 completed 项声明 `acceptance:{kind:"generation"}` 时，工具在写入前查会话级最新生成任务，证据不足即零副作用硬拒。路标 §14.5 定义的分期是「C-2a 生成 oracle → **C-2b canvas_state 扩展（探针复用 C-1 已扩展两处）** → C-2c 基线建档 + 阈值提案」。

本刀扩 `canvas_state` 子域，交付：DSL 第二枚举、画布 oracle、多 kind verdict 聚合、判据函数与 C-1 eval 真共享、按 kind 拆分的写入率指标。**不做** C-2c、`noOverlap`、`generationSucceeded`、`user_confirm`。

## 2. 调研实证（干净快照 `685bdb49`，逐条 `文件:行号`）

| # | 事实 | 位置 |
|---|---|---|
| 1 | 路标 §14.2 DSL 声明 `kind: "generation" \| "canvas_state" \| "user_confirm"`，`canvasState?: {nodeCount; nodeTypeCounts; noOverlap}`；§14.3 判据不满足 ⇒ 拒绝该 todo_write、oracle 故障 ⇒ 放行+软提醒+计数；§14.4「canvas_state 至少一谓词」 | 路标 `:395-401`, `:409-412`, `:416-418` |
| 2 | C-1 §8.3 `expectCanvasState` 声明 5 字段；§8.5「**新增探针仅两处**：按类型数节点（L3 扩展）、生成记录存在性（L5 读回）」= §14.5 所指「C-1 已扩展两处」 | C-1 spec `:124-137`, `:156` |
| 3 | **代码层只实现 3 字段**：`CanvasStateExpect = {nodeCount, nodeTypeCounts, generationSubmitted}`；`generationSucceeded`/`noOverlap` 零实现，L0 文本守卫主动打红 | `eval/golden-cases.ts:74-80`, `golden-cases.test.ts:670-683` |
| 4 | `judgeCanvasState(canvas, expect): string[]` 纯函数，只判 `nodeCount`/`nodeTypeCounts`；`CanvasSnapshot = {nodeCount, typeCounts}` | `eval/golden-cases.ts:634-655`, `:83-87` |
| 5 | 生产端点 `get_canvas_summary` → `client.post("/agent/internal/get-canvas-summary", {sessionId})`，返回 `nodes: [{id,type,title,status}]` | `tools/canvas-read.ts:85`, `agent-canvas-tools.service.ts:906-950` |
| 6 | ⭐ **焦点过滤不会污染判据**：`if (!focus \|\| all.length <= 30) return {nodes: all, groups}` —— 不传 `focusNodeId` 时**恒全量返回**，与画布规模无关 | `agent-canvas-tools.service.ts:903, 938` |
| 7 | `NestClient.post` 返回 `payload.data`，默认 10s 超时、异常结构化；`get-canvas-summary` 无 timeout override | `tools/nest-client.ts:96, 117-119, 144`, `tools/config.ts:17-28` |
| 8 | C-2a 模板：`GenerationOracle.inspect({sessionId,userId})`、守卫解析、异常统一 `ok:false` ⇒ fail-open | `tools/acceptance.ts:54-56, 119-156` |
| 9 | C-2a 注入点：`buildTodoTools({oracle, onAcceptanceOutcome})`；纯文本模式零参调用逐字节旧行为 | `tools/config.ts:79-88`, `:60` |
| 10 | 指标 `pi_runtime_acceptance_total{outcome}` 四 outcome，Map 空不渲染数据行 | `metrics.ts:140-141, 473-476, 785-790` |
| 11 | ⚠️ **两类节点陷阱**：`shot/create` 建的 shot 节点 `get-canvas-summary` **看不到**；只有 `add-nodes-batch` 建的可见 | `docs/EVAL_HARNESS_RUNBOOK.md:124-133` |
| 12 | `TaskDiffSchema` 是 `z.object`（默认 strip，宽松）；硬拒时 `diff.updates=[]` ⇒ `extractTaskEvents` 本就返回 `[]` | `pi-events.ts:579, 626, 645` |

**纠正路标陈旧行号**：§14.1 的 `session-manager.ts:616/1704` 已在 C-2a 立项 spec §2 纠偏；本刀不引用该行号。

## 3. 五项裁决

### D1 · 判据函数真共享，不做 eval→tools 反向依赖

路标 §14.2 硬要求「`expectCanvasState`（C-1 离线）与 `acceptance.canvasState`（C-2 生产）**共享判据函数**，杜绝 eval 绿 / 生产拦分裂」。但 `judgeCanvasState` 位于 `src/eval/golden-cases.ts`，生产 `tools/acceptance.ts` 直接 import 会把整份 L0/L1 case 资产（几十条用例与 transcript 常量）拉进生产依赖图 —— **不可接受**。

⇒ **新增中立共享模块 `services/pi-runtime/src/canvas-judge.ts`**（与 `hook-contract.ts` 同级，src 根层），导出 `CanvasSnapshot` / `CanvasCountsExpect` / `judgeCanvasCounts(snapshot, expect): string[]`（从 `golden-cases.ts:634-655` 原样迁移，零语义变更）。`eval/golden-cases.ts` 改为 import 并以薄封装保留 `judgeCanvasState` 公开签名（`return judgeCanvasCounts(canvas, expect)`），既有 4 处调用与 `golden-cases.test.ts` 的 import 路径**逐字节不变**；`tools/acceptance.ts` import 同一个 `judgeCanvasCounts`。

- `CanvasStateExpect extends CanvasCountsExpect { generationSubmitted?: boolean }`：`generationSubmitted` 是 transcript 判据（检查 `actual.has("propose_generation")`，`golden-cases.ts:618-623`），不属于画布快照，**不进共享层**。
- 守卫：wiring 测试锁「`golden-cases.ts` 的 `judgeCanvasState` 实现调用 `judgeCanvasCounts`」+「`acceptance.ts` import 同一符号」，防止日后一侧改判据另一侧不跟。
- 变异自检：改 `judgeCanvasCounts` 的上下界比较 ⇒ eval 侧与 C-2b 侧测试**同时 RED**。

### D2 · DSL 只注册已校验的枚举（延续 C-2a D3 纪律）

```ts
acceptance?: {
  kind: "generation" | "canvas_state";
  generation?: { requireSucceeded?: boolean };
  canvasState?: {
    nodeCount?: { min?: number; max?: number };
    nodeTypeCounts?: Partial<Record<"image" | "text" | "video", { min?: number; max?: number }>>;
  };
};
```

- **不注册 `noOverlap` / `generationSucceeded` / `user_confirm`**：`noOverlap` 全仓零实现（`CanvasSnapshot` 连坐标字段都没有），`generationSucceeded` 是 C-1 明确「本期不实施」并被 L0 打红的字段。**写了判据却不校验 = 伪验收**，比不写更坏。留 C-2c 或独立刀。
- 与 C-1 §8.3「同款子集」对齐：`nodeCount` / `nodeTypeCounts` 字段名、形态、类型枚举（image/text/video）完全一致。
- 防游戏化守卫（§14.4）：`canvas_state` 必须至少带一个谓词；`kind` 与载荷必须匹配（`kind:"canvas_state"` 不给 `generation`，反之亦然）；`min <= max`；未知键 / 非法类型 / 未注册 kind ⇒ **结构非法硬拒**（同 A-2' 幻觉 id 处置，零副作用）。

### D3 · oracle = 会话级画布快照，不传 focus

新增 `createNestCanvasOracle(client: OracleNestClient): CanvasOracle`，复用 C-2a 的 `OracleNestClient` 窄面（`acceptance.ts:115`）：

- `client.post("/agent/internal/get-canvas-summary", { sessionId })` —— **不传 `focusNodeId`**（§2 事实 6 ⇒ 全量 SSOT，无 30 阈值截断、无邻域过滤）。
- 守卫解析 `data.nodes` 为数组、元素 `type` 为字符串 ⇒ reduce 出 `{nodeCount, typeCounts}`（未知 type 计原值，与 `fetchCanvasState` 的 `"unknown"` 处理略有差异 —— **本刀统一为原值键**，与 `judgeCanvasCounts` 的 `typeCounts[type] ?? 0` 语义自洽，写进测试）。
- 形态非法 / 超时 / 网络错 / 熔断 ⇒ `{ok:false, reason}` ⇒ **fail-open**（软提醒 + 计数），与 C-2a 逐字同款。
- **不新增 Nest 端点、不新增 timeout override**（沿用 10s 默认，超时归 fail-open）。

### D4 · 多 kind verdict 聚合：`reject > fail_open > pass`

一次 `todo_write` 可有多个 completed 项、不同 kind。重构 `verifyAcceptance`：

1. 逐项 `parseAcceptance` —— 任一结构非法 ⇒ **立即 reject**（结构问题优先于任何 IO）。
2. 按 kind 分组，每组最多查一次 oracle（同组多项复用同一份快照）。
3. 某组 oracle 查询失败 ⇒ 该组 fail_open（软提醒 + `fail_open` 计数），**不覆盖其他组的 reject**。
4. 聚合优先级 `reject > fail_open > pass`：有任何证据不足就整体硬拒（零副作用）；无 reject 但有 fail_open 才放行 + 软提醒。
5. 依赖缺失（kill switch / 未注入 oracle / 缺 userId）⇒ `skip`（静默，逐字节旧行为）—— 与 C-2a 一致。

**关键不变量**：`overwriteTodos` 只在 `verdict.kind === "pass" | "fail_open" | "skip"` 时执行；`reject` 走 `rejectionResult`（`diff.updates=[]`、store 零写入）。C-2a 既有 9 例 todo 测试必须零回归。

### D5 · 指标：纯新增 `pi_runtime_acceptance_kind_total{kind}`

C-2b 最大风险是「模型不写 `canvas_state` ⇒ 机制空转」（路标 §14.5 诚实边界②），而现有 `pi_runtime_acceptance_total{outcome}` 无 kind 维度，观测不到。

⇒ 新增独立 counter `pi_runtime_acceptance_kind_total{kind="generation"|"canvas_state"}`（只记 `declared`），**不改现有四 outcome 系列**（向后兼容既有面板）。Map 空不渲染数据行（同现有范式）。kill switch 沿用 `PI_RUNTIME_ACCEPTANCE=off` —— off 时连 `declared` 都不记，逐字节旧行为。

## 4. 接口设计（要点）

| 符号 | 位置 | 签名 / 语义 |
|---|---|---|
| `judgeCanvasCounts` | 新 `src/canvas-judge.ts` | `(canvas: CanvasSnapshot, expect: CanvasCountsExpect): string[]` — 纯函数、零 IO，返回证据差文案数组 |
| `CanvasOracle` | `tools/acceptance.ts` | `inspect(input: {sessionId: string}): Promise<{ok:true; canvas: CanvasSnapshot} \| {ok:false; reason:string}>` |
| `createNestCanvasOracle` | `tools/acceptance.ts` | `(client: OracleNestClient): CanvasOracle` |
| `parseAcceptance` | `tools/acceptance.ts` | 扩 `kind:"canvas_state"` 分支 + 白名单/匹配/上下界守卫 |
| `judgeCanvasAcceptance` | `tools/acceptance.ts` | `(canvas, canvasState): {ok:true} \| {ok:false; evidence:string}` |
| `TodoToolDeps` | `tools/todo.ts` | 增 `canvasOracle?: CanvasOracle` |
| `TodoAcceptance` | `tools/acceptance.ts` | `kind: "generation" \| "canvas_state"`；`canvasState?: CanvasCountsExpect` |

证据差回执形态（与 C-2a 同构，模型可读）：`调用被拒绝：任务项「…」声明了画布验收判据，但画布证据不支持。期望：…；实际：…。当前清单保持不变。请继续干活或如实降级…`

## 5. 改动清单（预期 DELTA）

| 文件 | 动作 |
|---|---|
| `services/pi-runtime/src/canvas-judge.ts` + `.test.ts` | 新增：共享判据 + 单测 |
| `services/pi-runtime/src/eval/golden-cases.ts` | 改：import 共享模块、`CanvasStateExpect extends`、`judgeCanvasState` 薄封装 |
| `services/pi-runtime/src/tools/acceptance.ts` + `.test.ts` | 改：DSL/oracle/判据 + 新例 |
| `services/pi-runtime/src/tools/todo.ts` + `todo.acceptance.test.ts` | 改：多 kind 聚合 + 新例（既有 9 例零回归） |
| `services/pi-runtime/src/tools/config.ts` | 改：注入 `createNestCanvasOracle(client)` |
| `services/pi-runtime/src/metrics.ts` | 改：新增 kind counter + render |
| `services/pi-runtime/src/tools/acceptance.wiring.test.ts` | 改：守卫扩段（注入 / 指标 / 共享符号） |
| `skills/task-decomposition/SKILL.md` | 改：纪律⑥ 增 canvas_state 声明句与边界 |
| `docs/superpowers/specs/2026-11-14-c2b-*.md` + `plans/2026-11-14-c2b-*.md` | 新增：本文 + 实施计划 |
| 路标 §14 | 改：**仅状态行**（1 行） |

## 6. 验证计划

1. **TDD**：先写 `canvas-judge.test.ts` / `acceptance.test.ts` 新例 / `todo.acceptance.test.ts` 多 kind 例 ⇒ RED，再实现 ⇒ GREEN。
2. **全量**：`node --import tsx --test --test-concurrency=1 "src/**/*.test.ts"`（node:test，本机 nvm node24 + `env -u NODE_OPTIONS`）；三静态门禁 `verify-tool-contract` / `verify-tool-tiering` / `verify-spec-figures`。
3. **类型检查**：本机 `tsc --noEmit` 允许仅余既有基线错误（0.85.1 缺 `isError`），**不得新增**；CI Build monorepo（0.99.2）为权威。
4. **变异自检（每项必须 RED）**：① `judgeCanvasCounts` 上下界比较反转（eval + C-2b 同时红）② oracle 恒返回 `ok:true` ③ fail-open 改 fail-closed ④ 多 kind 聚合忽略 reject ⑤ `parseAcceptance` 去「至少一谓词」守卫 ⑥ 生产不注入 canvasOracle ⑦ `focusNodeId` 误传导致截断 ⑧ kind counter 不渲染。判 RED 用**完整 stdout 的 `AssertionError` / `failing tests` 标记**，不用被管道吞掉的退出码。
5. **生产复测**（合并上线后）：真实会话探针提交带 `acceptance:{kind:"canvas_state",canvasState:{nodeCount:{min:1}}}` 的 completed 项，取证「画布 0 节点 ⇒ 硬拒 + 快照不变 + `diff.updates=[]`」与「指标 kind=canvas_state 可查」。

## 7. 诚实边界与 No-Go

- ⚠️ **两类节点陷阱**：`get-canvas-summary` 看不到 `shot/create` 建的 shot 节点（RUNBOOK §3.2）。判据只对 `add-nodes-batch` 系节点成立；写进 SKILL.md 纪律⑥ 与 spec，不掩饰。
- **会话级判据**：只读整个画布的终态快照，**不能证明「这一项对应的那次写入」发生**；与 C-2a 的会话级生成 oracle 同级别限制。
- **声明即校验，不强制模型写**：写入率趋零按 §14.5 止损（`PI_RUNTIME_ACCEPTANCE=off` 一行）。
- **不判用户满意**：acceptance 只判机器可检的结构事实。
- `noOverlap` / `generationSucceeded` / `user_confirm` **本刀不做**；`user_confirm` 还需 HITL 状态机，不在 C-2b 范围。
- SKILL.md 文本变更 ⇒ SOP 激活率长线观测以本刀上线为新起点。
- 429 实名墙仍阻断 C-1a/C-1b 行为跑批（run3 error6/fail3、run4 error8/fail1），**本刀不依赖跑批数据、不宣告基线回填**。
- `services/pi-runtime/**` 与 `skills/**` 均不在 `deploy.yml paths` ⇒ 合并后零自动发布，须手工 dispatch `runtime-deploy`。

## 8. 回滚

- 行为回滚：`PI_RUNTIME_ACCEPTANCE=off`（C-2a 既有 kill switch，本刀沿用）⇒ `verifyAcceptance` 直接 `skip`，逐字节回到 C-2a 前行为；kind counter 不记。
- 代码回滚：本刀为单 commit squash，`git revert` 即可（共享判据抽取需同步 revert，由 wiring 守卫保证两者同进同出）。
