# 实施计划：意图去重误杀 + 失败轮可重试

> 规格：`docs/superpowers/specs/2026-11-28-intent-dedup-failed-turn-design.md`
> 分支：`fix/intent-dedup-failed-turn-retry`（基线 `origin/master` = 205627f8）

## 纪律
- TDD：先写失败测试 → 实现 → 转绿。
- 测试：`nvm` node24；vitest `--maxWorkers=1 --no-file-parallelism`；`vue-tsc -b`（禁 `--noEmit`）；`env -u NODE_OPTIONS pnpm …`。
- 不合并、不部署、不改生产。

## Step 1 — S1 去重资格判定（server）
- `apps/server/src/agent/intent-dedup.ts` 增 `isDedupEligibleIntent`。
- `intent-dedup.test.ts` 加：继续推进/下一步/重试 false；生成类 true；再生成 true（独立优先级）。
- `agent.service.ts:1006` 登记时按资格写 `normalizedIntent ?? null`。
- 验收：单文件 vitest 绿。

## Step 2 — S2 失败写 error（server）
- `agent.service.ts` 增 `failIdempotencyKey(key, reason)`；`getDuplicateIntent(...)` 返回详情。
- `streamConversation` 的 pi 分支：累计 `error` 事件 / catch 抛错 ⇒ 收尾分支 `fail` 而非 `complete`。
- `agent.service.test.ts` / `agent.service.intent-dedup.test.ts`：失败轮写 error、error 轮不再命中、成功轮仍命中。
- 验收：相关单测绿。

## Step 3 — S3 结构化原因 + 错误分类（server）
- `agent.controller.ts` 去重门改调 `getDuplicateIntent`，按 status/摘要发结构化 `turn_not_submitted{reason:'duplicate_intent', detail}` + 三种真实文案。
- controller 单测（新建 `agent.controller.intent-dedup.test.ts`）：三种文案 + detail 字段 + 无「已为你复用」。
- `pi-events.ts`：`PiRunErrorKind` 加 `invalid_input`，复用 `invalid_request` 字面规则，给 retry_hint。
- `pi-events` 相关测试补 invalid_input 用例。

## Step 4 — S4 强制重发 + S5 真实文案（web）
- `ConversationDto` 加 `force?: boolean`。
- `apps/web/src/stores/agent.ts`：`turnRefusal` 联合类型加 `'duplicate_intent'`，新增 detail 字段（可选）。
- `AgentSideRail.vue`：`turn_not_submitted` 分支读取 detail 并写 store；callout 模板按 reason 渲染三种文案 + 「仍要发送」按钮；`sendMessage` 末位加 `force`。
- `agentCommandClient.ts` / 相关测试：force 透传。
- 前端单测：文案断言、force 透传、既有 refusal 契约不回归。

## Step 5 — 门禁
- 受影响包全量 vitest（顺序跑，不并行两包）。
- `vue-tsc -b`；`tsc --noEmit`（pi-runtime 未动可略）。
- 变异自检：至少对「失败写 error」「继续推进不参与去重」「强制重发跳过门」三处做反向断言确认测试会红。
- 输出变更清单与未闭环项；等待用户授权才推 PR。

## 回滚面
- 服务端去重门只增加前置条件与 detail 字段；`force` 缺省 false ⇒ 旧客户端行为只有文案变化。
- 前端 `turnRefusal` 新值是联合类型扩展，旧 reason 渲染逐字不变。
