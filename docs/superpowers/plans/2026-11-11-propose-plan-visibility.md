# 实施计划：propose_plan 方案可见性修复（P0-P1）

> 关联规格：`docs/superpowers/specs/2026-11-11-propose-plan-visibility-design.md`
> 日期：2026-11-11
> 分支策略：基于 true master `e9e0251532457e342096b0efcbb7f7a3d43b3e2c`，经 `gh api` Git-Data 只提交本任务改动路径；**排除**工作树中无关的脏文件（`services/pi-runtime/src/graph/__snapshots__/golden.json`、`render-canvas-view.ts`、`render-canvas-view.expressive.ts`）。

## 1. 问题回顾（一句话）

SSE 对话里 agent 调 `propose_plan` 拟定方案后，方案正文（如"三步制作 Codex 知识教学视频"）**未投影到任何 UI**（任务卡无、确认卡只有标题），用户对着一句标题被推确认卡，体验断裂。

根因（D1）：`propose-plan.ts` 的 `build()` 把方案只放进 `details.plan`，但**未把 `overwriteTodos` 返回的 `diff` 放进 `details.todo`**；而前端 `extractTaskEvents`（`pi-events.ts:584`）只从 `tool_execution_end.details.todo.{snapshot,diff}` 派生 `task_list` 事件 → 任务卡永远收不到方案步骤。确认卡（D3）的 `question` 也未携带方案本体，前端 `AskUserCard` 只能渲染标题。

## 2. 改动清单（仅本任务路径）

### 后端 `services/pi-runtime`（真实目录）
| 文件 | 改动 | 对应判据 |
|---|---|---|
| `src/tools/propose-plan.ts` | ① 措辞改"方案由宿主渲染"；② 新增 `explanation` 参数；③ `overwriteTodos` 取 `diff`；④ `question` 增加 `plan:{summary,explanation?,steps}`；⑤ `build().details` 增加 `todo:{snapshot,diff}` | P0-1, P0-2, P1-1 |
| `src/tools/propose-plan.test.ts` | 新增"details 同时含 todo 与 plan、确认卡 questions[0].plan.steps 透传" | P0-1/P0-2/P1-1 契约 |

### 前端 `apps/web`（符号链接目标，已对齐 true master）
| 文件 | 改动 | 对应判据 |
|---|---|---|
| `src/components/agent/AskUserCard.vue` | `AskUserQuestion` 接口加 `plan?`；模板内联方案块（摘要+有序步骤）；新增 `--lnk-*` 令牌样式 | P0-2 |
| `src/components/agent/AskUserCard.test.ts` | 新增"question.plan 存在时渲染方案摘要+步骤清单" | P0-2 |
| `src/components/agent/turnTimeline.ts` | `question` part 与 `ask_user` data 的 `questions[]` 元素加 `plan?` 类型 | P0-2 透传 |
| `src/stores/agent.ts` | `trackAskUser` 的 `questions[]` 元素加 `plan?` 类型 | P0-2 透传 |
| `src/lib/share/toShareTurn.ts` | `questions.map` 透传 `plan` | P0-2 透传 |

### 文档
| 文件 | 说明 |
|---|---|
| `docs/superpowers/specs/2026-11-11-propose-plan-visibility-design.md` | 规格（已 `verify-spec-figures` 通过：0 错误） |
| `docs/superpowers/plans/2026-11-11-propose-plan-visibility.md` | 本计划 |

## 3. 已通过的验证（实施前自测）

- 后端：`pnpm exec tsx --test src/tools/propose-plan.test.ts` → **7 passed**（含新 P0-1/P0-2/P1-1 契约测试）。
- 前端：`pnpm exec vitest run src/components/agent/AskUserCard.test.ts --maxWorkers=1 --no-file-parallelism` → **18 passed**。
- 规格：`pnpm verify-spec-figures` → 本规格 `✓`，全局 0 错误。
- 差异核对：5 个前端文件与 2 个后端文件均已 `diff` 对照 true master，确认**仅含本任务改动**（无 stale 发散）。

## 4. 提交 / PR 策略

1. 取当前 true master SHA（提交前再核验是否前移）。
2. 对 7 个源码文件 + 规格 + 计划，逐路径用 `gh api` 创建 blob（内容 = 已验证文件字节）。
3. `POST /git/trees`：`base_tree`=master tree，仅列上述 9 个路径（避免全量 4912 条触发网关 502）。
4. `POST /git/commits` 建 commit；`POST /git/refs` 建 `feature/...` 分支。
5. `POST /pulls` 开 PR，正文回读 body 长度（避免 `@文件` 静默丢内容）。
6. **不**纳入 3 个无关脏文件。

## 5. CI / 合并 / 部署 / 取证 / 复测

- 盯 CI：重点关注 `services/pi-runtime` 单测与 `apps/web` 构建+单测（含 `AskUserCard.test.ts`）。
- 合并：squash 合 master，合并树须 == 已验证 PR head tree。
- 部署：走 `deploy.yml`（`apps/web` + `services` 改动触发发布）；部署后约 30s 502 窗。
- 生产取证（只读 `docker cp` + sqlite）：在新会话复现"拟定计划"场景，断言 `executionEvents` / SSE 流中**含方案步骤文本**（`task_list` 事件派生自 `details.todo.diff`）+ 确认卡 `questions[0].plan.steps` 非空；`canvasData` 在确认前为空；超时后不谎报"已创建节点"。
- 复测判据（防伪锚点）：以「实际 SSE 事件流含 `task_list` + 带 steps 确认卡」为强证据；不依赖产物 chunk hash（esbuild 恒剥离注释，chunk hash 级联不可作锚）。

## 6. 风险与回滚

- 符号链接 `apps/web`：提交经 `gh api` 绕开 `git add`，不碰本地 symlink 工作树。
- master 前移：提交前重核 SHA；若前移，按 `MASTER_MOVED_SAFE` 换 parent 重建单 commit。
- 零行为变更风险：本修复**新增** UI 投影，不影响既有拦写/超时语义（测试已覆盖 `refine/keep/timeout` 仍 fail-closed）。
