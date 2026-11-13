# C-1b 实施 plan（对应 spec `2026-11-13-c1b-fullset-multiturn-eval-design.md`）

> 前置：C-1a 已合并（#861）；真模型跑批解锁后执行阶段 6。实施需单独授权（代码刀纪律）。

## 阶段 1：runner 扩展（测试侧代码）

1. `golden-cases.ts`：增 `GoldenStep` 接口 + `GoldenCase.steps?` + `expectTodoStatus` / `expectIdentitySurvival` / `expectCanvasState` 字段；steps 与顶层判据互斥守卫；
2. `driver.ts`：`RuntimeRunResult` 增透传 `model`（/sessions 响应已含）；
3. `runner.ts`：steps 循环（同 sessionId 逐步 runEvalCase）+ 每步判据 + `step[N]` 前缀 failures + identity 跨步追踪 + report 增 model 列与 identity 区块；
4. 画布读回扩展：node.type 计数解析（复用 fetchCanvasNodeCount 通道）。

## 阶段 2：种子集扩量（编写期标注纪律）

5. Q3 多轮 8–12 条（spec §4 结构，生产反查逐条定稿 + 出处标注）；
6. Q4 4–6 条（spec §5：3 正例 + 2 负例 + 观测 q4-03）；
7. Q1/Q2 补量至 10–14 各（生产反查优先）。

## 阶段 3：L0 契约测试

8. spec §7 全部 7 类校验 + 快照语义单测扩充（status 演进 / identity 两态 / 伪造 transcript）；
9. 本机全绿：`golden-cases.test.ts` + 全量 eval 目录（基线 91 例无回归）。

## 阶段 4：推送

10. REST 全链（blob 核等 → tree → commit → ref → PR 正文回读 → compare DELTA）；CI 全绿后停在合并前等授权。

## 阶段 5：合并后（零发布，无需 runtime-deploy）

11. 合并取证：合并树 == CI head 树；更新记忆与路标状态行（冻结纪律：路标只回填状态行）。

## 阶段 6：真模型跑批（环境解锁后，PR 外收尾）

12. 按 `docs/ops/EVAL-c1a-seed-run-2026-11-13.md` 接线重跑（低频 batch 化：Q3 全集 ≈150+ 调用，必须 interval 65s+ 磨限流）；
13. 全集 ≥2 轮 + 抖动率 <20% 核验；失败归因三分类报告落 `docs/ops/`；identity 断裂率进 C-1c 基线档案输入。

## 风险与回退

- runner steps 循环若与 driver 事件收集产生耦合 bug ⇒ 每步独立 runEvalCase 调用已隔离风险（无共享流状态）；L0 语义单测伪造 transcript 兜底；
- 生产反查 Q3 话术不足 8 条 ⇒ 缺口用显式 synthetic 补并在 case about 登记比例（C-1 spec §7.2 纪律）；
- agnes 限流持续 ⇒ 阶段 6 推迟，阶段 1–5 照常交付（spec §9.1）。
