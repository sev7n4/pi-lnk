# 后续三项收尾规格：失败轮计费 / 错误分类合一 / pi-mcp 基线

## 1. 已完成主线
PR #1024 已合并（`4856da44`），CI / Deploy / Runtime Deploy 三线全绿，生产取证：
- runtime `healthz.version=4856da44`，生产 dist 直接调用 `sanitizeMalformedToolCalls` 断言通过；
- API dist 含 `duplicate_intent` / `failIdempotencyKey` / 新文案，纯函数 `isDedupEligibleIntent('继续推进')=false`；
- web `CanvasPage-CtHPiy15.js` 命中「仍要发送」。

## 2. 等价物检索结论表

| 项 | 现成等价物 | 是否够用 | 结论 |
|---|---|---|---|
| 0 tokens 失败扣 1 积分 | `shouldReleaseHold`（turn-end.ts）+ `runFailed` 分支 + `points.release` | **够用但未接线**：仅 `event.type==='error'` 置 `runFailed`，生产失败以 `agent_end{status:'failed'}` 到达 ⇒ 走成功分支 `Math.max(1,ceil(0))` 扣 1 分 | 复用现成分支，补 `agent_end` 失败判据，不新建结算路径 |
| 错误分类三套 | `classifyPiRunError`（server）、`mapMessageToErrorCode`（shared）、`classifyToolOutcome`/`classifyLlmFailure`（runtime） | 各有专用枚举与文案，不能直接互替；但**文本识别规则重复**（429/timeout/400/网络） | 新增 shared 纯函数 `classifyProviderErrorText` 作为**文本识别 SSOT**，三处委托并保留各自输出枚举/优先级 |
| pi-mcp 缺失 | `package.json` 与 `pnpm-lock.yaml` 已声明 `0.99.2` | 是本地 node_modules 陈旧（依赖 11-24 才加入，软链 11-17 建立），CI 安装正常 | 不做代码降级；本地 `pnpm install --frozen-lockfile` 修复环境并复测 |

## 3. 规格

### R1 失败轮不扣费（B1）
- `runFailed` 判据从 `event.type === 'error'` 扩为：`event.type === 'error'` **或** `classifyPiRunError(event) !== null`。
- 正常 `agent_end{status:'completed'}` 仍返回 null，行为不变。
- 失败轮走既有 `points.release` + `turn_settled{released:true}`；不得调用 `settleFromHold`。
- 不与窄判据 `shouldReleaseHold` 合并（它管「无终态的中断」，本项管「明确失败终态」）。

### R2 错误文本识别 SSOT（B2）
- 新文件 `packages/shared/src/providerError.ts`：闭集 `ProviderErrorKind` + `classifyProviderErrorText(text)`；**只返回分类，不返回原文**（避免 label 基数爆炸）。
- 优先级固定：aborted/cancelled → insufficient → auth → rate_limit/queue_full → invalid_input → context_overflow → timeout → network → model_unavailable → validation。
- 三处委托但保留各自语义：
  - `mapMessageToErrorCode`：保留专用 `insufficient_points`/`upload_required`/`fallback_pending`，重叠段委托 canonical 后映射。
  - `classifyPiRunError`：canonical 映射为 5+invalid_input 类，保留 `retry_hint` 与前端文案。
  - **pi-runtime 不能委托 shared**：`services/pi-runtime/src/independence.test.ts` 把「零 workspace 依赖」做成 CI 守卫，import `@lnkpi/shared` 会直接失败，且破坏物理拆仓边界。其 `llm-error-class` 已委托 `tool-error-class`（本产品线内已是单一 SSOT）；本轮用**跨包契约测试**锁住两边关键字面（429 / timeout / network / invalid_request / 模型不可用）一致，防漂移而不越界。
- 既有测试逐条保持通过；新增 canonical 测试 + 两处委托等价测试 + 跨包契约测试。

### R3 pi-mcp 基线（B3）
- 不改代码契约，不把 vendor 依赖改 optional（生产镜像已含 0.99.2）。
- 本地执行 `pnpm install --frozen-lockfile` 修复软链，`tsc --noEmit` 与两条测试文件必须转绿。

## 4. 验证
- server 全量 vitest、pi-runtime 全量 node:test、shared 相关测试；`tsc --noEmit`/`vue-tsc -b`/`git diff --check`。
- 变异自检：把 B1 判据改回仅 `error` 事件，新增计费测试必须变红。
- 本轮完成推 PR→CI→合并→部署→取证→复测前，不宣告闭环。
