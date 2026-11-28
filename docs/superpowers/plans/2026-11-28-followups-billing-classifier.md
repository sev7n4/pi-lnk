# 实施计划：三项收尾（2026-11-28）

## P0 分支
- worktree `.worktrees/followups-billing-classifier`，分支 `fix/followups-billing-classifier`（tree 等同已上线 master）。

## P1 B1 红灯→绿灯
- 在 `agent.service.test.ts` 增加 `agent_end{status:'failed', errorMessage:'400 invalid_request_error: messages[55]: missing field tool_call_id'}` 且无 usage 的回合：断言 `release` 1 次、`settleFromHold` 0 次、下发 `error{event_type:'invalid_input'}`。
- 实现：`runFailed = event.type === 'error' || classifyPiRunError(event) !== null`。
- 变异自检：改回旧判据 ⇒ 新测试必须红。

## P2 B2 合一
- 新建 `packages/shared/src/providerError.ts` 与测试。
- `mapMessageToErrorCode`、`classifyPiRunError`、`classifyToolOutcome` 逐处委托；每改一处跑其既有测试文件，确保零回归。
- 保持 `invalid_input` 在 server 与生图两处字面一致。

## P3 B3 环境修复
- `pnpm install --frozen-lockfile`（env -u NODE_OPTIONS，node24）补齐 pi-mcp。
- 复跑 `tsc --noEmit` 与 `src/tools/config.test.ts`、`src/tools/voicestudio-mcp.test.ts`。

## P4 全量验证与上线
- server/web/pi-runtime 全量测试；类型检查；diff check；变异自检。
- 推 PR→盯 CI→合并→deploy.yml + runtime-deploy.yml→生产取证。
- 取证点：API dist 中 `runFailed` 新判据生效（行为断言：agent_end failed 不 settle）；canonical 分类器在 shared 产物中；pi-runtime dist 保持上一轮清洗能力。
