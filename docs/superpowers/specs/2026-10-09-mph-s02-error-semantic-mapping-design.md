# S0-2 错误语义映射 —— 分项规格

状态：待评审（2026-10-09）
上级规格：`2026-10-09-model-platform-hardening-design.md`（批次 B0，服务目标 G2）
事故依据：总体规格 §2.4——生产失败记录 `errorCode: 'unknown'`，用户看到裸 503 JSON。

## 1. 目标

已知上游错误族的每笔失败都拿到产品语义错误码与中文文案；`errorCode='unknown'` 收敛为长尾（目标：新增失败中占比 < 5%）。

## 2. 现状摘录（真实锚点）

- 分类器：`packages/shared/src/generationDiagnostics.ts`
  - `mapMessageToErrorCode()`（L89-100）：规则只覆盖 积分不足/timeout/已取消/参考图未上传/模型停用 → 本次 503 `model_not_found` **不命中 → 'unknown'**；
  - `translateUpstreamFailure()`（L110-130）：已覆盖 402/403锁定/401/网络/429，**缺 `model_not_found` 文案**；
  - `ErrorCode` 联合类型已有 `model_unavailable`（L7）——本次复用它，不新增枚举值。
- 消费方：`apps/server/src/studio/studio.service.ts`（L290/L313 起 switch）与 `apps/server/src/canvas/material.service.ts`（L194/L217）按 code 分支渲染诊断。
- 生产原文 fixture（必须原样入测试，禁止臆造）：
  - 文本：`Text API 503: {"error":{"code":"model_not_found","message":"No available channel for model deepseek-v4 under group default (distributor) (request id: 20261009043413943840776XprVkXAP)","type":"AgnesAI_error"}}`
  - 欠费（既有注释已记录）：`Image edit API 402: ... insufficient balance (current: 0.013570 USD, required: 0.050000 USD)`

## 3. 改动设计

1. `mapMessageToErrorCode()` 新增规则（**放在 timeout 规则之后、unknown 兜底之前**）：
   ```ts
   if (/model_not_found|No available channel/i.test(text)) return 'model_unavailable'
   ```
2. `translateUpstreamFailure()` 新增文案：
   ```ts
   if (/model_not_found|No available channel/i.test(text)) {
     return '平台暂未开通该模型（上游无可用渠道），请换个模型或联系管理员'
   }
   ```
3. **httpStatus 传递核查**：`GenerationDiagnostic.httpStatus` 字段已存在；确认文本 503 路径把 `503` 填进 diagnostic（studio.service 现有解析链），不新增字段。
4. 禁止把规则写宽（总体规格 §4 第 3 条）：只匹配 `model_not_found` 与 `No available channel` 两个已取证字面量族。

## 4. 验收判据（可断言）

| # | 判据 | 断言方式 |
|---|---|---|
| A1 | `mapMessageToErrorCode(生产503原文) === 'model_unavailable'` | shared 单测，fixture = 总体规格 §2.4 原文逐字 |
| A2 | `translateUpstreamFailure(生产503原文)` 返回 §3.2 文案；`translateUpstreamFailure(生产402原文)` 仍返回既有欠费文案（回归） | 同上 |
| A3 | 反例不误伤：`'Text API 503: Internal Error'`、`'model_not_found_x'` 类近似串**不得**命中（若决定仅精确匹配 `model_not_found` token，则断言 `No available channel` 路径仍命中） | 单测反例组 |
| A4 | 既有规则回归：积分不足/timeout/已取消/停用 四条原样通过 | 既有测试全绿 |
| A5 | 生产复测：部署后新失败记录 `errorCode='unknown'` 占比 < 5%（SQL：`metadata.errorCode` 按 createdAt 过滤） | SQL |

## 5. 测试要点

- 测试文件：`packages/shared/src/generationDiagnostics.model-not-found.test.ts`（新），正例用生产原文、反例按 A3。
- 消费方渲染：`studio.diagnostic.test.ts` 追加一条「503 model_not_found → userMessage=新文案」用例（走真实 switch 路径，不直调共享函数）。

## 6. 涉及文件

- Modify: `packages/shared/src/generationDiagnostics.ts`（两函数各 +1 规则）
- Test: `packages/shared/src/generationDiagnostics.model-not-found.test.ts`（新）、`apps/server/src/studio/studio.diagnostic.test.ts`（追加）

## 7. 依赖与风险

- 无依赖，与 S0-1 同批发车互不冲突（不同文件）。
- 风险=规则误伤：缓解与回滚见总体规格 §6 末行（规则带 fixture、revert 单条规则）。
