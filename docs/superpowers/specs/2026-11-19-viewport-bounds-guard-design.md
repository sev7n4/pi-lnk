# 视口污染导致 PC 画布内容不可见 —— 修复规格

> 日期：2026-11-19　状态：已拍板实施　SSOT：本文 + 同名实施计划

## 第一原则：吃满上游、不重复造轮子

任何新增判据/工具/字段/引擎前必须过三判据：①检索等价物 ②接线优先于新建，锚已有结构化数据面 ③禁造数/禁自报。

| 候选新增 | 等价物检索结论 | 裁决 |
|---|---|---|
| 视口边界校验 | 已有 `clampViewport` / `isViewportUsable`（`packages/shared/src/canvas/viewport.ts`）就是 SSOT，仅缺 x/y 边界 | 扩展既有原语，不新建模块 |
| 远端回落 fitView | `CanvasPage` 已有 `fitView({nodes:[…]})` 多处用法（:1924/:2026/:2046） | 复用，不新增导航组件 |
| 服务端落库校验 | 已有 `sanitizeClientOps`（`apps/server/src/sessions/sessions-canvas-patch.ts`）与 `applyCanvasActions`（shared applier）两道闸门 | 两处补判据，不新增中间件 |
| 落位异常兜底 | 已有 `computeNewNodePosition`（`useCanvasNodePlacement.ts`） | 加 guard，不新建 placement 引擎 |
| 历史数据修复 | 已有 `PATCH /sessions/:id/canvas` 的 `set_viewport` op | 用现成端点，不写 DB 脚本 |

## 问题与根因

- 症状：PC 画布只剩节点/空白，图片本身 200 且已加载；污染会话 `cmvbv1vb…` viewport.x≈1,114,387、zoom=0.1，37 节点全在视口外。
- 根因：`isViewportUsable` 只校验“有限数”，`clampViewport` 只 clamp zoom，x/y 原样透传（`viewport.ts:21-41`）；`set_viewport` applier 与 `sanitizeClientOps` 均零校验；`computeNewNodePosition` 用受污染的 `screenToFlowCoordinate` 产出千万级落位，形成自放大。
- 边界：`cmwn0xt5…` 等健康会话图片渲染完全正常；本次修复针对“落库/实时视口被污染”这一类，不声称修复用户 PC 网络拦截外域图片（那是独立环境问题）。

## 规格

R1 · **视口原语加界**：新增 `VIEWPORT_XY_LIMIT = 100_000`；`isViewportUsable` 拒绝 |x| 或 |y| 超限的三值（判否 ⇒ 回落），正常范围 x/y 仍逐字不动，`zoom` clamp 不变。

R2 · **恢复侧远端回落**：`loadSession()` 中当服务端 viewport 存在但被判脏时，不再停在 `{0.8,0,0}`，而是对“非离群节点”（|x|,|y| ≤ LIMIT）调用一次 `fitView({nodes: ids, duration: 0})`。无 viewport 的存量会话维持原行为。

R3 · **写入侧双向闸门**：`applyCanvasActions` 的 `set_viewport` 分支与 `sanitizeClientOps` 的 `set_viewport` op 均只接受 `isViewportUsable` 通过的视口，否则跳过并留痕。`normalizeViewportPayload` 因复用 `clampViewport` 自动继承。

R4 · **落位异常 guard**：`computeNewNodePosition` 对 `screenToFlowCoordinate` 结果做有限性与边界校验，异常时回落到「现有非离群节点最大 x + 320 / y 基准」。

R5 · **历史污染修复**：对已确认 3 个污染会话，用现有 PATCH `set_viewport` 把视口改为对准非离群节点群的安全值；执行前备份 canvasData，dry-run 核对，apply 后复核。

R6 · **测试反转与守卫**：`viewport.test.ts`、`useCanvasViewport.test.ts` 增补“超限 x/y 判否/不调用 setViewport”；新增 applier 与 sanitizeClientOps 的脏视口用例；`computeNewNodePosition` 增补异常坐标回落用例。每个新判据做变异验证（改坏实现 ⇒ 必须转红）。

## 验证判据（DoD）

1. 定向 vitest 全绿；变异 ≥4/4 RED，恢复后全绿。
2. `pnpm -r build` / `vue-tsc -b` 干净。
3. CI 三个 required check 全绿；合并树与 CI head 树逐路径一致。
4. web-only 部署后：生产入口 chunk 特征串命中；零篡改 CDP 复现污染会话 `nodesInViewport>0`、图片 `complete=true`；健康会话 `cmwn0xt5…` 复测不回退。
5. 历史数据修复前后 viewport 数值+截图留证；不宣称未闭环项为 ALL_PASS。
