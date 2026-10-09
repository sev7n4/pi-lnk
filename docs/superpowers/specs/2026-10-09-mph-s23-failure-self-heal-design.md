# S2-3 失败自助恢复（一键换模型重试 + 退款透明化）—— 分项规格

状态：待评审（2026-10-09）
上级规格：`2026-10-09-model-platform-hardening-design.md`（批次 B2，服务目标 G2/G4 的用户侧收口）

## 1. 目标

生成失败后，用户在诊断抽屉里能：①看到「已自动退还 N 积分」；②对可重试失败一键换推荐模型重试，不需要回 Dock 重新配置。

## 2. 现状摘录（真实锚点）

- 诊断抽屉：节点左上角状态图标（`NodeStatusInfoButton.vue`）→ 媒体属性抽屉「诊断」tab（`useMediaInspector` / `MediaInspectorDrawer.vue`）；内容源 `GenerationDiagnostic`（`packages/shared/src/generationDiagnostics.ts`：`userMessage/hint/httpStatus/...`）；复制格式 `formatDiagnosticCopy()`。
- 退款：`GenerationRecord.metadata` 含 `chargedPoints/refundedPoints/refundReason`（今日事故 charged 5/refunded 5 实证），**前端未展示**。
- 重试通路：`NodeTaskCornerActions` 已有 retry 按钮（`CANVAS_NODE_RETRY_KEY`，按 nodeId 重试原模型）；图片侧已有 fallback 机制（`fallback_pending`，BYOK 失败回退平台）；**文本侧无「换模型重试」**。
- 推荐来源：S1-2 健康端点（admin）；需要用户侧投影（S1-3 的 `/api/model-health/summary` 模式）。

## 3. 改动设计

1. **退款透明化**（独立可先发的小步）：
   - `GenerationDiagnostic` 增加可选字段 `chargedPoints?/refundedPoints?/refundReason?`（shared 类型 + 文本/图片两条落库路径透传 metadata 三字段）；
   - 抽屉诊断 tab 渲染「已自动退还 5 积分」（refundedPoints>0 时）；`formatDiagnosticCopy()` 追加 `refund: charged 5 → refunded 5 (platform_failed)` 行。
2. **推荐模型（纯函数）** `packages/shared/src/retryRecommendation.ts`：
   ```ts
   recommendRetryModel(input: { failedModelKey: string; capability: StudioModality;
     candidates: Array<{ modelKey: string; availability: Availability; successRate: number | null }>;
   }): { modelKey: string; reason: string } | null
   ```
   规则：排除失败模型自身与 unavailable；按 successRate 降序、null（零流量）排可用组末位；平台渠道候选优先于 BYOK（跨渠道计费语义不同，首版**只推荐同渠道**——YAGNI）；无候选 → null（不渲染按钮）。
3. **一键换模型重试**：
   - 服务端：既有重试通路加可选参数 `retryWithModelKey`（DTO 可选字段；校验 = 目标模型 ∈ 目录 ∧ availability≠unavailable ∧ 同渠道，越权/不存在 → `invalid_input`）；
   - 前端：诊断抽屉失败态渲染「换 {displayName} 重试」按钮（recommendation 非 null 时）；点击 → 以新模型重跑该节点生成（复用 `CANVAS_NODE_RETRY_KEY` 通路，带模型覆盖参数）；
   - 新失败的计费/退款语义与普通失败一致（零新逻辑）。
4. **不加推荐的情况显式留白**：errorCode ∈ {cancelled, invalid_input, upload_required} 不渲染重试区（无可重试语义）。

## 4. 验收判据（可断言）

| # | 判据 | 断言方式 |
|---|---|---|
| A1 | 退款展示：metadata 退款三字段 → 抽屉渲染 + copy 文本含 refund 行；缺字段不渲染 | 组件测试（`MediaInspectorDrawer` 既有 harness）|
| A2 | 推荐纯函数：候选含 unavailable/自身/零流量混合 → 排序与排除正确；全 unavailable → null | shared 单测（矩阵用例）|
| A3 | 服务端校验：retryWithModelKey 不存在/跨渠道/unavailable → 400 `invalid_input`；合法 → 生成记录 model=新模型 | 集成测试 |
| A4 | 幽灵回归：对 `model_unavailable` 失败，推荐候选**排除探活 unavailable**（S1-1 数据）——用户不会被推到又一个必挂模型 | 集成测试 |
| A5 | 二次失败链路：换模型重试再失败 → 新 GenerationRecord 独立计费退款，旧记录不变 | 集成测试 |
| A6 | 生产复测：真实失败节点上执行换模型重试 → 新记录成功、抽屉展示退款 | runbook 归档 |

## 5. 测试要点

- A2 用例矩阵必须含「全部候选 successRate=null（冷启动）」形态——首版上线时真实数据就是这种（健康统计刚上线）。
- retry 通路改造注意受控画布：模型覆盖必须走页面级 patch（`CANVAS_NODE_PATCH_KEY` 教训——updateNodeData 只写内部 store 会被旧数据覆盖）。

## 6. 涉及文件

- Modify: `packages/shared/src/generationDiagnostics.ts`（类型+copy）、文本/图片诊断落库路径透传、重试 DTO 与 service、`MediaInspectorDrawer.vue` + test
- Create: `packages/shared/src/retryRecommendation.ts` + test、重试端点参数集成测试
- 消费：S1-2/S1-3 的健康数据（依赖其用户侧投影）

## 7. 依赖与风险

- 退款透明化**零依赖可先发**（与 B0/B1 并行不冲突）；换模型重试依赖 S1-1/S1-2。
- 风险=推荐循环（推荐了又一个失败模型）：A4 排除 unavailable + R2 ghost_suspect（S1-2）双保险；回滚=前端隐藏按钮（DTO 可选字段向后兼容）。
