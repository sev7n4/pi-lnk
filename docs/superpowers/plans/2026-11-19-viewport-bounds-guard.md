# 实施计划：视口边界守卫（2026-11-19）

> 对应规格：`docs/superpowers/specs/2026-11-19-viewport-bounds-guard-design.md`
> 第一原则与等价物检索结论见规格 §第一原则，本文不重复。

## 基线

真实 master HEAD = `0eb0660c0e593777b56d469c8aa6b9aede3696e0`（gh api 为准；git fetch 502）。
隔离工作区 `.worktrees/fix-viewport-bounds`，分支 `fix/viewport-bounds-guard`，REST 推 PR（blob→tree→commit→ref→PR）。

## 步骤（TDD：每步先写红测试再看实现）

1. **R1 视口原语**：改 `packages/shared/src/canvas/viewport.ts` + `viewport.test.ts`。红用例：x=8574349 / y=-393934 ⇒ `isViewportUsable=false`、`clampViewport=null`；正常 x/y 不动用例保持。
2. **R2 恢复侧回落**：改 `apps/web/src/pages/CanvasPage.vue`（`loadSession` + 新 helper）+ `CanvasPage.viewport.test.ts`（若现有静态守卫结构不匹配则新增同目录专测）。红用例：脏 viewport 且有非离群节点 ⇒ 触发 `fitView({nodes:[…]})`。
3. **R3 写入闸门**：改 `packages/shared/src/canvasActionApplier.ts` + `apps/server/src/sessions/sessions-canvas-patch.ts`，各自测试加脏视口用例；红→绿。
4. **R4 落位 guard**：改 `apps/web/src/composables/useCanvasNodePlacement.ts` + 新/既有测试；红用例：`screenToFlowCoordinate` 返回千万级 ⇒ 不采用，回落。
5. **R5 历史修复**：写一次性脚本（放 `.workbuddy/e2e-cdp/`，不进交付 commit），`--dry-run` 打印 3 会话当前/目标 viewport 与节点统计；确认后 `--apply`，再读回复核。
6. **R6 门禁**：定向 vitest、`vue-tsc -b`、`pnpm -r build`、变异 ≥4/4 RED 后还原；`Verify spec figures` 若对文档数字有异议按实测修正。
7. **交付**：REST 推分支 → PR（四个必填项）→ CI → 合并树对账 → 部署 → 生产 CDP 取证与复测 → 清理 worktree/分支。

## 影响面与不变量

- 不改 `resolveMediaUrl`、图片渲染组件、鉴权与缓存头；不改 SSE 与工具分层。
- 正常视口的三值语义不变（x/y 逐字保留、zoom clamp [0.1,2]）；只对超限/非有限值 fail-open。
- 无 viewport 的存量会话行为完全不变（零 fitView 新调用）。
- 数据修复只写 viewport 一个键，不碰 nodes/edges/groups。

## 回滚

- 代码：revert 合并 commit；旧版本对超限视口仍原样恢复（回到修复前行为）。
- 数据：修复脚本输出 `before.json` 备份，必要时 PATCH 回原值。
