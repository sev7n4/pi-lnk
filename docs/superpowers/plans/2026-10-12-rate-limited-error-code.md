# 上游 429 归类为 `rate_limited`（信号层 P1 配套工单）

> 规格依据：`docs/superpowers/specs/2026-10-12-tool-details-contract-design.md` §6 配套工单——
> 「`errorCode:"unknown"` 的出现次数进 metrics → 用它驱动根因修复：把上游 HTTP 429 在生成工具内归类为
> `rate_limited`（归类后错误文本带 "rate limit" 字样，vendor 分类器即自动判 true）」。
> 生产痛点：agnes-video-2.5-flash 近 48h 失败 19/成 0 全是 429，全部落 `unknown` → 信号层只能 hedge。

## 根因链（2026-10-12 取证）

1. agnes hub 429 → Nest 失败落库路径 `mapMessageToErrorCode(errMsg)`
   （`packages/shared/src/generationDiagnostics.ts:103`）**无 429/rate-limit 规则** → `unknown`。
2. pi-runtime 轮询生成状态 → `signalFromUpstream` 的 rawText 含 "unknown" → vendor 分类器
   （`RETRYABLE_PROVIDER_ERROR_PATTERN`）不命中 → retryable 缺省 → 信号 hedge。
3. `translateUpstreamFailure` 已有 429 用户文案（line 143）——只有 userMessage 翻译，errorCode 没跟上。

## vendor 分类器契约（已核实，勿重造）

- `@earendil-works/pi-ai/dist/utils/retry.js`：`RETRYABLE_PROVIDER_ERROR_PATTERN` 含 `"rate.?limit"`
  （`.` 匹配 `_`）⇒ rawText 含 `rate_limited` 即判 `retryable:true`。
- `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`（GoUsageLimitError 等订阅型配额）优先判 false
  ⇒ 订阅型配额耗尽仍走 hedge，语义正确；本工单不触碰该层。

## 变更清单（TDD，每步先红后绿）

- **Task 1 · shared（核心）**：`ErrorCode` 联合加 `'rate_limited'`；
  `mapMessageToErrorCode` 加规则 `/\b429\b|rate.?limit|too many requests/i` → `'rate_limited'`，
  位置放在 timeout 规则之后（保既有优先级："timeout waiting, then 429" 仍归 `upstream_timeout`，
  pi-runtime 侧 vendor 看全文仍判可重试）。测试：`generationDiagnostics.test.ts` 加 4 变体
  （纯 429 / 中文限流 / too many requests / timeout+429 保持 / GoUsageLimitError 保持 unknown）。
- **Task 2 · Nest UX 镜像**：`studio.service.ts` 与 `material.service.ts` 的
  `hintForCode`（→'请稍后重试'）/`userMessageForCode`（→'上游限流，请稍后重试'）补 `rate_limited` case。
- **Task 3 · web**：`MediaInspectorDrawer.vue` `DIAGNOSTIC_CODE_LABELS` 加 `rate_limited: '上游限流'`；
  `generationPointsMessage.ts` `ERROR_CODES` 白名单加 `'rate_limited'`（否则结构化字段被白名单丢弃）。
- **Task 4 · pi-runtime 契约锁**：`result-signal.test.ts` 补用例——
  `{ok:false, errorCode:'rate_limited', message:'agnes hub: 429 Too Many Requests'}` → `retryable:true`
  （跨层合同：Nest 归类 + vendor 判定的接缝）；订阅型文本（含 GoUsageLimitError）→ 缺省不写 false。
- **Task 5 · 验收 + PR**：shared/server/pi-runtime 测试全绿 + tsc；PR → CI → squash 合并 →
  deploy.yml（api+web 自动）→ Runtime Deploy（shared dist 进 pi-runtime 镜像，tag=新 SHA）→ 生产探针。

## 验收判据

- `mapMessageToErrorCode("…429…")` = `rate_limited`（测试钉死）。
- pi-runtime：errorCode=`rate_limited` 的失败数据 → 信号 `failed/retryable:true` + 「可退避重试」提示。
- `unknown` 计数回落是上线后的观测项（agnes 429 流量恢复后看 metrics），不作为合并闸门。
- 回滚：无迁移、无状态；revert 即可。
