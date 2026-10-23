# SP-C 视口恢复 实施计划（spec-plan）

> 来源：`docs/superpowers/specs/2026-10-23-sp-c-viewport-restore-design.md`（SP-C 视口恢复，Draft 待评审）。
> 分支纪律：新开分支 `feat/sp-c-viewport-restore`（自 `origin/master`）；Conventional commits；每 Task 一 commit。
> 跨包改动（shared + web）⇒ 收尾必须跑 **根 `pnpm build`** + 各包 tsc。

## Global Constraints

- **零 migration**：`canvasData` 是 JSON blob，viewport 是 blob 内的一个可选键（N2）。
- **存量画布零变化**：无 viewport 键的画布，加载行为与今天完全一致（N1）。
- **不越权改视角**：回合末「无新节点」时视口三值一字不动（N3）。
- **写节流**：视口连续事件在防抖窗口内只落库一次（N4）。
- **恢复不闪**：`setViewport(..., { duration: 0 })`（N6）；zoom 先 clamp（N5）。
- ⛔ 视口变化**不进用户撤销栈**（不进 `canvasUndo` checkpoint）—— 撤销栈是内容语义，视口不是。

## Review Focus

1. **N3/N4 守卫**：回合末不得出现无条件全览 `fitView`；视口变化不得逐事件落库。
2. **N1/N2**：不带 viewport 时产出的 canvasData **不含该键**（不是 `viewport: undefined`）。
3. **恢复时序**：恢复发生在 nodes 应用之后（否则内容不在测量盒里，setViewport 无意义）。
4. **跨包纪律**：shared 类型变更 ⇒ web 的 `@lnkpi/shared` 解析随之变 ⇒ 根 build 全绿才算过。

## File Structure

```
packages/shared/src/canvas/types.ts            # 改：CanvasData 增 viewport?
packages/shared/src/canvas/viewport.ts         # 新增：clampViewport / isViewportUsable
packages/shared/src/canvas/viewport.test.ts    # 新增：纯函数单测
packages/shared/src/canvas/index.ts            # 改：导出新模块
apps/web/src/composables/useCanvasActions.ts  # 改：flowToCanvasData 透传 viewport
apps/web/src/composables/useCanvasActions.canvasData.test.ts # 改：序列化断言
apps/web/src/pages/CanvasPage.vue             # 改：防抖采集 + 落库 + 恢复 + 回合末分支
apps/web/src/pages/CanvasPage.viewport.test.ts # 新增：恢复/回合末/节流行为级单测
```

---

## Task 1: shared 视口类型 + 纯函数

**Files**: `packages/shared/src/canvas/types.ts`、`packages/shared/src/canvas/viewport.ts`（新）、`packages/shared/src/canvas/viewport.test.ts`（新）、`packages/shared/src/canvas/index.ts`

- [ ] **Step 1: 写失败测试**（`viewport.test.ts`）：

```ts
import { describe, expect, it } from 'vitest'
import { clampViewport, isViewportUsable } from './viewport'

describe('视口原语（SP-C）', () => {
  it('zoom 越界收敛到 [0.1, 2]（N5）', () => {
    expect(clampViewport({ x: 10, y: 20, zoom: 0.01 })?.zoom).toBe(0.1)
    expect(clampViewport({ x: 10, y: 20, zoom: 9 })?.zoom).toBe(2)
  })
  it('合法视口原样返回（x/y 不动）', () => {
    expect(clampViewport({ x: -120, y: 33, zoom: 1.25 })).toEqual({ x: -120, y: 33, zoom: 1.25 })
  })
  it('脏值/缺字段一律判否（⇒ 回落默认 fitView，fail-open）', () => {
    expect(isViewportUsable(undefined)).toBe(false)
    expect(isViewportUsable({ x: NaN, y: 0, zoom: 1 })).toBe(false)
    expect(isViewportUsable({ x: 0, y: 0, zoom: 'x' as unknown as number })).toBe(false)
    expect(isViewportUsable({ x: 0, y: 0, zoom: 1 })).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**（模块不存在）
- [ ] **Step 3: 实现**（`viewport.ts` + `types.ts` 增 `viewport?: { x: number; y: number; zoom: number }` + `index.ts` 导出）
- [ ] **Step 4: 跑 shared 全量测试**
- [ ] **Step 5: Commit**（`feat(shared): SP-C 视口类型 + clamp/isViewportUsable 纯函数`）

## Task 2: web 序列化透传

**Files**: `apps/web/src/composables/useCanvasActions.ts` + 其测试

- [ ] **Step 1: 写失败测试**（`useCanvasActions.canvasData.test.ts` 追加）：
  - 传 `extras.viewport` ⇒ 产出的 `canvasData.viewport` 与传入全等；
  - **不传** ⇒ `('viewport' in data)` 为 `false`（N1/N2：不得写成 `viewport: undefined`）。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（`extras` 增 `viewport?`，透传进产出对象）
- [ ] **Step 4: 跑该 composable 相关测试**
- [ ] **Step 5: Commit**（`feat(web): canvasData 序列化透传可选 viewport`）

## Task 3: CanvasPage 采集 / 落库 / 恢复 / 回合末

**Files**: `apps/web/src/pages/CanvasPage.vue` + `CanvasPage.viewport.test.ts`（新）

- [ ] **Step 1: 写失败测试**（`CanvasPage.viewport.test.ts`，静态契约 + 行为级）：
  1. 回合末分支：源码里**不得**出现无条件的 `fitView({ padding: … })` 全览调用（N3 守卫）；
  2. 恢复：canvasData 带 viewport ⇒ 调用 `setViewport(vp, { duration: 0 })` 且参数经 clamp（N5/N6）；
  3. 无 viewport ⇒ **不调用** setViewport（N1）；
  4. 节流：连续 10 次视口变化 ⇒ 落库调用 1 次（N4）。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**：
  - 视口变化采集：`onViewportChange`（vue-flow `onViewportChange` 钩子）→ `pendingViewport`（防抖合并，窗口 400ms）；
  - 落库：`saveCanvas()` 的 `flowToCanvasData(..., { viewport: pendingViewport })`；
  - 恢复：加载完成（nodes 应用后）读 canvasData.viewport ⇒ `isViewportUsable` ⇒ `setViewport(clampViewport(vp), { duration: 0 })`；
  - 回合末：`:1740` 的无新节点分支**去掉**全览 fitView（保留 `:1738` 有新节点聚焦）。
- [ ] **Step 4: 跑 CanvasPage 相关测试 + vue-tsc**
- [ ] **Step 5: Commit**（`feat(web): 视口持久化 + 恢复 + 回合末不再劫持视角`）

## Task 4: 收尾验证

- [ ] **Step 1: 根 build**（`pnpm build` ⇒ 六包全绿；跨包纪律）
- [ ] **Step 2: shared + web 全量测试**（含 design-token / theme-usage 守卫）
- [ ] **Step 3: 变异验证**（每项「改回即红」）：
  1. 回合末恢复全览 fitView ⇒ N3 守卫红；
  2. 恢复时不 clamp ⇒ N5 红；
  3. 视口变化逐事件落库（去掉防抖）⇒ N4 红；
  4. 序列化写 `viewport: undefined` ⇒ N1 红。
- [ ] **Step 4: 生产取证**（部署后：canvasData 内含 viewport 键 + 刷新视角一致 + 回合末视口不动）
- [ ] **Step 5: 回填台账**（本文件执行台账节 + 规格 §9 状态行）
