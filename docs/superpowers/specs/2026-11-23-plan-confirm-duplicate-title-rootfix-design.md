# 确认卡方案标题重复两次 — 根因与契约分层修复（立项规格）

- **状态**：已拍板（用户 2026-11-23 选方案 A「契约分层」），待 PR
- **触发**：生产会话 `cmwta4mxl09b2ld014nml823m` 确认卡「完成QA质检 + 继续推进EP03剧本」标题出现两次
- **归属**：plan-gate / 确认卡呈现层

---

## 1. 现象与生产取证（一次调用，不是两次）

服务端 `executionEvents` 回读（seq=7，messageId `cmwtbadux0a17ld01wv57j09n`，events 已 shrink 但关键事件在）：

- `tool_call(name=propose_plan, toolCallId=call_c80514518ecf4331a4fdd490)` × **1**
- `waiting_user(callId=同)` waiting ×1 / resolved ×1
- `plan_proposed(callId=同)` ×1
- `tool_result` 内 `canvasCommands[0].questions[0]`：

```
question      = "完成QA质检 + 继续推进EP03剧本"
plan.summary  = "完成QA质检 + 继续推进EP03剧本"   ← 同值
plan.steps    = 4 条；plan.scope = {inScope:5, outOfScope:2}
```

⇒ 排除「模型输出两遍 / SSE 重投 / 重连重放 / 两条消息」；是一次工具调用里**两个字段同值**，前端两层渲染。

## 2. 根因链（带行号）

| 环节 | 位置 | 事实 |
|---|---|---|
| 双层标题的产出 | `services/pi-runtime/src/tools/propose-plan.ts:100` | `question: p.summary`（外层题干，渲染于 `AskUserCard.vue:247`） |
| 同上 | `propose-plan.ts:102` | `plan.summary: p.summary`（内层方案卡标题，渲染于 `AskUserCard.vue:260`） |
| 规范早已禁止 | `docs/superpowers/specs/2026-11-11-propose-plan-visibility-design.md:124` R2 | 「卡片 `question` 不得仅等于 `summary`」——只写在文档，无机检 |
| 回归引入点 | `d9085d33`（2026-11-11, PR #831） | 为修「看到标题却没看到方案」新增内联 `plan`，复制 `summary` 进 `plan.summary`，但保留旧 `question: p.summary` |
| 测试假绿 | `propose-plan.test.ts:96-108` / `AskUserCard.plan.test.ts:25,42` | 只断言字段存在与 steps 透传，未断言 `question` 语义；fixture 恰好把 `question` 与 `summary` 写成同值，固化了错误形态 |

**架构判断**：`question` 在通用 `ask_user`（`services/pi-runtime/src/tools/ask-user.ts:87`）的语义是 `question text shown to user`——一个**征询问题**；`plan.summary` 是**方案对象的标题**。把二者指向同一字符串，是「展示关注点」与「收集关注点」的错误合并（R2 描述的正是这个）。

## 3. 第一原则：等价物检索结论表

| 候选等价物 | 检索方式 | 结论 | 处置 |
|---|---|---|---|
| 上游 pi-agent-core 内置 plan / ask 工具 | `vendor/earendil-works/pi` 全树 + `docs/.../2026-11-11...md:92` 既有取证 | **不存在**（0.99.2 只有通用 toolCall + `beforeToolCall` hook） | 自建工具合理，不接线上游（上游无等价物） |
| 上游 `ui_prompt_start/end` 事件 | `packages/coding-agent/src/core/extensions/types.ts:989-1005` | 只有 `kind` + 可选 `title`，无 plan 内容结构、无双字段去重约定 | 不适用本缺陷；保留现状不动 |
| 上游 plan-mode 扩展先例 | `vendor/.../examples/extensions/plan-mode/index.ts` | 用 `ctx.ui.setWidget("plan-todos")` 展示方案，写操作用 hook 拦；确认题面是**独立固定问句** | **可借鉴的分层模式**（不引入新依赖，仅作为契约依据） |
| 项目内 R2 规范 | `2026-11-11-propose-plan-visibility-design.md:124` | 已存在且明文禁止 `question === summary` | **接线**：本刀即执行 R2，不另造规则 |
| 行业实践（一手） | Claude Code 官方 `permission-modes.md`：「plan is presented → asks how to proceed」；Codex `codex-rs/.../plan.rs:send_event(EventMsg::PlanUpdate)` | 「方案内容」与「征询问题」是两个 artifact；标题只出现一次 | 采用同名分层模式 |

⇒ 三判据全过：有等价物（R2）⇒ 接线执行；不新增字段 / 引擎 / 指标；不造数。

## 4. 裁决（方案 A · 契约分层）

**数据契约**：`question` = 宿主生成的固定征询语，与模型参数解耦；`plan.summary` = 模型给出的方案标题，`questionTitle`（pending 卡标题）继续用 `p.summary` 不动。

- **D1**：`question: "是否按此方案执行？"`（`propose-plan.ts:100`）。
  - 为什么不用 `p.summary`：那正是缺陷本身。
  - 为什么不用 `explanation` 当题面：那是方案思路，属展示层，不是征询。
  - 为什么不新增模型参数 `questionText`：增加模型负担且仍可能填成同值（违反「接线优先于新建」）。
- **D2**：`plan.summary: p.summary` 不变——方案标题只保留在内层一次；`details.plan.summary`、`questionTitle` 也不变（transcript / eval / pending 语义零改动）。
- **D3**：零 schema 变更、零前端产品代码变更（`ask_user` 通道形态不变）；历史 transcript append-only 不回填，旧会话仍显示旧文案（明确接受的边界）。
- **D4**：机检守卫落在**数据出口**而非源码字符串：`propose-plan.test.ts` 断言 `question === "是否按此方案执行？"` 且 `question !== plan.summary`；前端 fixture 改为题面与方案标题不同值，避免测试继续固化错误形态。
- **D5**：同步工具参数 `summary` 描述（`propose-plan.ts:46`），从「确认卡片题面」改为「方案标题（确认卡内联方案区展示）」，避免提示词再把 summary 当题面。

## 5. 不在本刀范围

- 前端 `AskUserCard.vue` 渲染逻辑零改动（不做字符串相等隐藏 hack）。
- 历史会话不回填、不迁移（遵循 A-3 D6 append-only 纪律）。
- `plan` part 的 SSE 合并幂等性（`useAgentStream` 的 plan 覆盖风险）属另一缺陷，另刀处理，不在本刀混改。

## 6. 验收（AC）

- **AC1**：`propose_plan` 下发的 `ask_user` 卡 `question === "是否按此方案执行？"`，且 `plan.summary === p.summary`，二者不相等。
- **AC2**：`details.plan`、`questionTitle`、`todo`/`decision` 语义逐字段不变。
- **AC3**：`propose-plan.test.ts` 新增 AC1 断言，旧断言全绿；前端 `AskUserCard*.test.ts` fixture 不再同值，全绿。
- **AC4**：生产复测——同一会话新跑一次 propose_plan，确认卡出现「征询题面 + 唯一方案标题」，无重复。

## 7. 变异自检

- **M1**：把 `question` 改回 `p.summary` ⇒ AC1 RED。
- **M2**：把守卫断言删掉 ⇒ M1 不再 RED（说明守卫确实锁住规则本体）。

## 8. 部署面

只改 `services/pi-runtime`（不在 `deploy.yml` paths）⇒ 合并后须手工 dispatch `runtime-deploy.yml` + 生产闸门；前端零改动不派 web。

## 9. 放行门禁

PR + CI 全绿 + squash 合并（合并树 == CI 验证 head 树）+ runtime-deploy + 生产复测后才宣告闭环。
