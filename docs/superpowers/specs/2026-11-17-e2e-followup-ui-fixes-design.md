# E2E 走查 follow-up：任务管理模块 UI 三处修复立项

> 来源：2026-11-17 E2E 用户级走查（会话 `cmwjhglas012bqo01klyuturd`，6 runs，报告 `.workbuddy/e2e-cdp/E2E-走查报告-2026-11-17.md`）问题④。
> 性质：前端 UX 三处独立小刀，共享同一取证背景。工具/运行时侧两刀已先行落地（#935 todo_write 空清单放行、#936 web_search 错误透传）。
> 立项理由：apps/web 本地构建环境受损（软链断 + pnpm patch 校验失败），无法满足「本地测试绿再推」纪律，故先行落规格，待环境恢复后按刀实施。

## 背景（E2E 生产实证）

| # | 现象 | 用户影响 |
|---|---|---|
| U-1 | run_end=failed 后任务卡片停留「正在生成 1/4 · 正在生成：拆解爆款短剧的底层逻辑」（运行态未归零） | 用户以为还在跑，实际 run 已死；无失败感知 |
| U-2 | spawn_subagent 返回 `{ok:false, error:"subagent_failed", usage:{status:"failed"}}`（isError=false，vendor executeTool 不消费 isError——已知形态） | UI「派生代理」显示 ✓，与真实失败相悖 |
| U-3 | agnes 429 失败在对话流以原始 JSON dump 呈现（含 `"code":"assistant_error"`、request id 全文） | 用户看不懂；无重试引导 |

## 刀 1（U-1）：run 终态时任务卡收敛

**根因**：任务卡状态机（`apps/web/src/components/agent/agentTaskProgress.ts`，SSE task_list/task_update 驱动）只消费 task_* 事件；run_end=failed 时不发 task_summary ⇒ running 项永不落终态。

**方案**：
- 新增纯函数 `applyRunInterrupted(state: AgentTaskProgressState, reason?: string)`：对 items 中 `running`/`retrying` 项置 `failed` + `errorHint='任务随本轮中断'`；`pending` 项置 `skipped`；置 `finished: true`。
- 接线：消息流消费层（WorkflowPage/AgentStepper 的 run_end=failed 分支）调用之。位置以「run_end 事件已有分支」为准（避免新增订阅通道）。
- **不改动**：C1/W11 既有语义（task_update hint-only、recordId 权威轮询）全部保留；run_end=completed 时不追加任何收敛（正常路径 task_summary 已覆盖）。

**判据**：mock 一个「task_list(4 项, 1 running) → run_end failed」序列，断言 running→failed(errorHint)、pending→skipped、finished=true；completed 序列回归不变。现有 `agentTaskProgress.test.ts` 全绿。

## 刀 2（U-2）：工具卡失败态判定升级

**根因**：工具卡 ✓/✗ 由 isError 驱动；spawn_subagent 软失败（isError=false 但 ok=false + usage.status=failed）被渲染为成功。

**方案**：
- 工具卡状态推导处（AgentStepper / execution trace 组件，以实际渲染 ✓ 的代码为准）：对 `spawn_subagent`（后续可推广到其他软失败工具）增加二级判定——`result` 文本含 `"ok":false` 或 `usage.status==="failed"` ⇒ 失败态。
- 实现优先放在**数据层**（executionStep 状态推导纯函数）而非模板层，便于单测。

**判据**：`{ok:false,error:"subagent_failed",usage:{status:"failed"}}` 输入 ⇒ 步骤卡 ✗ + 「子代理执行失败」文案；正常完成（ok:true 或 report 非空）回归 ✓；isError=true 直通 ✗ 回归。

## 刀 3（U-3）：上游限频错误友好化

**根因**：assistant error message（`error.message` 含 AgnesAI 原始 JSON + request id）直接渲染进对话流，无映射。

**方案**：
- `apps/web/src/utils/apiError.ts`（或消息渲染层的同族工具文件）新增 `friendlyAssistantError(raw: string): { text: string; kind: 'rate_limit' | 'model_not_found' | 'generic' }`：
  - 匹配 `rate limit for free users` / HTTP 429 ⇒「AI 服务当前限频，请稍后重试；如持续出现请升级套餐或联系支持」（附原 request id 折叠展示或省略）；
  - 匹配 `model_not_found` ⇒「所选模型在当前渠道不可用，请切换模型后重试」；
  - 其余维持原文（generic，不破坏现有未见过的错误透传）。
- 渲染侧替换点：assistant error message 的直接渲染分支。

**判据**：三种输入样本快照断言；generic 透传回归。

## 实施顺序与环境前置

1. **前置**：重建本地 apps/web 构建环境（本次断链 /tmp/pi-lnk-w1c + pnpm patch 校验失败；建议 `pnpm install --force` 或按 CI Dockerfile 复刻 node 阶段）。
2. 三刀可同 PR（共享测试基建）或分 PR；每刀 TDD + 现有 web 测试全绿。
3. 部署走常规 merge→deploy 流水线（apps/web 在 deploy 触发面）。
4. 复验：重放 E2E 场景（红果短剧流程），断言 U-1/U-2/U-3 三点行为。

## 非目标

- vendor executeTool isError 消费修复（#868 语义补正已在 after_tool listener 层覆盖 todo 域；spawn_subagent 的 isError 补正属另一刀候选，本轮 UI 层先兜底）
- 429 自动重试（重试策略属 runtime/产品决策）
- 容器重启竞态（E2E 问题⑤，涉及部署编排，另行评估）
