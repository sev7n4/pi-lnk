# 子代理任务在 SSE 对话流可见（任务卡 + 详情面板）· 实施计划

> 对应规格：`docs/superpowers/specs/2026-11-17-subagent-sse-visibility-design.md`（A 档，用户已拍板 2026-11-17）。
> 纪律：TDD（先写测试 RED → 实现 GREEN → 变异自检 RED）；第一原则「吃满上游、不重复造轮子」（规格 §11 已附等价物检索表）；本计划遵循同原则，任务均锚既有数据面。
> 触碰面：**仅 `apps/web`**；pi-runtime / Nest 零改动 ⇒ 无 runtime-deploy、无环境审批。

## 0. 排期与触碰面

| 任务 | 文件 | 判据 | 变异 |
|---|---|---|---|
| T1 数据模型 + reducer | `turnTimeline.ts`、`toolArgSummary.ts`（如需） | C1/C2/C3/C5/C6 | N1/N2/N3/N5/N6 |
| T2 任务卡渲染 | `AgentTurnTimeline.vue` | C1/C4/C6 | N4 |
| T3 详情 Sheet | `SubagentTaskSheet.vue`（新）、`AgentSideRail.vue` | C1/C3/C4 | N4 |
| T4 变异自检 | 测试夹具 | 全 | N1–N6 |
| T5 门禁 + PR + 部署 + 冒烟 | — | 全 | — |

预估 1 个 PR（web-only）。分刀可合并提交（squash），但测试须逐步 RED→GREEN 留痕。

## 1. 任务拆分（TDD）

### T1 · subagent_task part 数据模型 + 派生 reducer（判据 C1/C2/C3/C5/C6；变异 N1/N2/N3/N5/N6）
- 先写测试文件 `turnTimeline.subagent.test.ts`（新），喂入真实事件夹具：
  - block spawn（tool_call + tool_result with report）→ 断言 1 张 `subagent_task` part，status=completed，task/report/durationMs/turns 完整。
  - background spawn（running）+ collect（terminal，同 callId）→ 断言卡从 running 收敛到终态。
  - partial/stream_interrupted → 断言标记。
  - 重复事件（重连/重放）→ 断言幂等（1 张卡）。
  - 非子代理工具 → 断言不产生 subagent_task，原 tool part 仍在。
- RED 后实现：
  - `TimelinePart` 加 `subagent_task` 变体（规格 §4.1）。
  - `applyTimelineEvent` 在 `tool_call`/`tool_result` 分支加派生/upsert（规格 §4.2）。
  - **完整 task/report 读原始 `event.data.args` / `result`，禁止走 `summarizeToolArgs`/`summarizeToolResult`**（规格 §4.3，N2 靶点）。
- 判据：全绿 + N1/N2/N3/N5/N6 各自 RED。

### T2 · AgentTurnTimeline 任务卡渲染（判据 C1/C4/C6；变异 N4）
- 写组件测试 `AgentTurnTimeline.subagent.test.ts`（新）：渲染 subagent_task part → 卡片显示短码名/任务摘要/状态/耗时；点击 emit `open-subagent-task`；普通工具仍走原 tool 分支。
- RED 后：`AgentTurnTimeline.vue` 在 `kind:'tool'` 分支前加 `v-else-if="part.kind === 'subagent_task'"`；卡片样式复用 design token（`--agent-assistant-divider` 等），**不新增 hex / rgba / --neo-***。
- 判据：全绿 + C6 负例（普通工具不出卡）。

### T3 · SubagentTaskSheet 详情面板 + 挂载（判据 C1/C3/C4；变异 N4）
- 写组件测试 `SubagentTaskSheet.test.ts`（新）：完整 task 折叠块、报告全文、状态行、partial/truncated/degraded 标记、兜底文案。
- RED 后：
  - 新建 `SubagentTaskSheet.vue`，仿 `SkillPickSheet.vue` 的 `sheet-head/sheet-body/sheet-close` + `role="dialog" aria-modal`。
  - `AgentSideRail.vue` 同级挂载，接 `open-subagent-task` emit 打开、`close` 关闭。
  - degraded（background 无结构化报告）时显示「结果已并入回复」，不留空白报告（N4 靶点）。
- 判据：全绿 + N4 RED。

### T4 · 变异自检 N1–N6
- 逐条按规格 §6 做变异，全部须 RED；用完整 stdout 判定（`| tail` 吃退出码，禁止）。
- 汇总变异矩阵到实施记录。

### T5 · 门禁 + PR + 部署 + 生产冒烟
- 门禁：`pnpm --filter web test`、`vue-tsc -b`（勿加 --noEmit）、`design-token.test.ts`（若改样式）、`pnpm verify-claims`（若改文档引用）。
- PR：走 `.workbuddy/push-pr.cjs` REST 推送纪律；推前核 `compare base...master` 触碰面；合并树 == CI 验证 head 树。
- 部署：web-only（push 自动分流或手工 dispatch 带 `deploy_web_only=true`）；判据=产物 chunk 含新组件标记（如 `SubagentTaskSheet` 函数名于 `dist/assets/*.js`），勿只看时间戳。
- 生产冒烟：真实会话派一个子代理，确认任务卡出现、点击弹面板、task/report 完整。

## 2. 判据映射

| 判据 | 覆盖任务 | 变异 |
|---|---|---|
| C1 block 卡 + 详情 | T1/T2/T3 | N1/N2 |
| C2 background 配对 | T1 | N3 |
| C3 断流标记 | T1/T3 | — |
| C4 degraded 兜底 | T2/T3 | N4 |
| C5 重放幂等 | T1 | N5 |
| C6 不影响普通工具 | T1/T2 | N6 |

## 3. 验证命令备忘
```bash
# web 单测（nvm node24 + 单线程；pnpm 须 env -u NODE_OPTIONS）
cd /Users/4seven/workspace/pi-lnk
env -u NODE_OPTIONS nvm exec 24 pnpm --filter web test -- --maxWorkers=1 --no-file-parallelism
# 类型
env -u NODE_OPTIONS nvm exec 24 pnpm --filter web exec vue-tsc -b
# 设计令牌（改样式时）
env -u NODE_OPTIONS nvm exec 24 pnpm --filter web test -- design-token
# 生产取证：SSH deploy-cvm；web 产物 chunk grep 新标记
```

## 4. 授权闸门
- **本计划仅到 spec + plan 产出**（用户 2026-11-17 授权范围）。
- 实施、PR、合并、部署、生产取证需用户**另行授权**后再执行（用户偏好：合并-部署-生产复测单独授权）。
- docs-only 回填亦按总授权纪律执行。

## 5. 实施结论
- 待实施后回填（PR 号、合并 SHA、CI 状态、部署 tag、生产冒烟结果、变异矩阵）。
