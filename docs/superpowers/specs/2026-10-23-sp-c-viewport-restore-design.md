# SP-C 视口恢复（viewport 一等状态化）

> 来源：`docs/superpowers/specs/2026-10-20-agent-canvas-batch-layout-design.md` §12 路线图
> 「**SP-C 视口恢复**：viewport 入序列化 + loadSession 恢复；回合末无新节点分支的 fitView 劫持问题」。
> 前置：SP-A（放置内核）、SP-B（对齐与参考线）均已上线（`7471901a` / `4d0d3376` / `f2342253`）。
>
> **状态**：Draft 一稿，2026-10-23 代码级取证后成文，待评审。

## 0. 一句话主张（Thesis）

**画布视角是用户的状态，不是系统的状态** —— 用户调好的视角必须活过刷新、重开与回合结束；
系统在「没有明确理由」时不得替用户改视角。

## 1. 现状盘点（代码级取证，2026-10-23，基准 `origin/master` @ `a7498059`）

| # | 事实 | 证据 | 后果 |
|---|---|---|---|
| 1 | **视口变换不落库** | `CanvasPage.vue:4694` `saveCanvas()` → `flowToCanvasData(folded.nodes, …)`；产出 canvasData 只有 nodes/edges/groups，**无 viewport** | 刷新/重开 ⇒ 视角归零 |
| 2 | **加载后不恢复视口** | CanvasPage 内唯一的 `setViewport` 调用在 `:1687`，属 **imported viewport** 通道（`useCanvasActions` 的 `fitImportedViewport`，为「导入画布」服务），与普通打开无关 | 普通打开画布 ⇒ 视角由默认 fitView 决定 |
| 3 | **回合末无条件全览（劫持）** | `:1740` `await vueFlowRef.value?.fitView({ padding: 0.24, duration: 360 })` —— 走的是「无新节点」分支 ⇒ **每个回合结束都把用户视角拉回全览** | 用户刚调好的视角被系统拽走；正在细看某个区域时被打断 |
| 4 | 回合末「有新节点」分支已正确分流 | `:1738` `fitView({ nodes: newNodeIds, padding: 0.45, maxZoom: 1.05 })`（SP-A Task 5 落地） | ✅ 无需改动 |
| 5 | 存储是 JSON blob ⇒ **加字段零 migration** | `apps/server/src/canvas/canvas.controller.ts:50` `JSON.stringify(dto.canvasData)`；节点/边/位置本就在其内 | 视口入序列化**不动 DB schema** |
| 6 | viewport 读写原语齐备 | `getViewport()`（`:2033`）、`setViewport()`（`:3340`）、`panBy`（`:3342`）、`zoomTo`（`:3352`） | 恢复无需新造轮子 |
| 7 | 已有「回到全览」兜底入口 | `CanvasBottomLeftControls.vue:85` `fitView({ padding: 0.2 })`（移动端 `MobileCanvasTopControls.vue:15` 同款） | 去掉回合末全览后，用户仍有手动回到全览的路 |

### 1.1 问题清单（按严重度）

| # | 问题 | 严重度 | 归属 |
|---|---|---|---|
| P1 | 刷新/重开画布 ⇒ 视角丢失（用户得自己重新找） | 高 | 本包 G1 |
| P2 | 每回合结束被全览 fitView 拽走（细看区域时被打断） | 高 | 本包 G2 |
| P3 | 视口变化若每次都落库 ⇒ 写放大 | 中 | 本包 G3（节流） |

## 2. 目标

| # | 目标 | 验收 |
|---|---|---|
| G1 | 视口成为持久化的一等状态：保存时随 canvasData 落库，加载时恢复 | 调好视角 → 刷新 → 视角一致（x/y/zoom 三者全等） |
| G2 | 回合结束**不再**无理由改视角 | 回合结束（无新节点）后视口 x/y/zoom **完全不变** |
| G3 | 落库有节流，视角拖动不产生写风暴 | 一次连续拖拽 ≤ 1 次落库（防抖窗口内合并） |

## 3. 范围

### 3.1 本规格做

- **canvasData 增可选字段** `viewport?: { x: number; y: number; zoom: number }`
  （可选 ⇒ 存量画布零兼容负担：没有就按现状走）；
- **保存**：落库时带上当前视口（**节流**：视口变化后防抖窗口内合并一次，不逐事件落库）；
- **恢复**：打开画布时，若 canvasData 带 viewport ⇒ `setViewport` 恢复（zoom 需 clamp 到
  合法区间）；若不带（存量画布 / 首次打开）⇒ **维持现状**（默认 fitView），不改变老画布的观感；
- **回合末**：删掉「无新节点」分支的全览 fitView；「有新节点」分支维持 SP-A 的聚焦（不动）。

### 3.2 明确不做（登记，不隐性扩范围）

- 跨设备 / 多标签页视口同步（属 SP-E 并发底座的 CAS + 广播范畴）；
- 视口历史、书签、逐节点视角记忆；
- 「本回合有节点被更新但没有新节点」时的自动聚焦（⚠️ 需回合级 diff 能力，成本高于收益；
  兜底：底部控制条「回到全览」按钮 + 有新节点时的聚焦已覆盖主要场景）；
- 移动端与 PC 分别记忆视口（同一画布一份视口，跨端共用）。

## 4. 判据与不变量

| # | 不变量 |
|---|---|
| N1 | **存量画布零变化**：无 viewport 字段的画布，加载行为与今天完全一致（默认 fitView） |
| N2 | **不迁移 DB**：canvasData 是 JSON blob，加字段不产生 migration |
| N3 | **回合末不越权改视角**：无新节点时视口三值一字不动 |
| N4 | **写节流**：视口变化的连续事件在防抖窗口内只落库一次 |
| N5 | **缩放合法**：恢复时 zoom 必须 clamp（`zoomTo` 既有区间 0.1~2 ⇒ 恢复同区间），避免异常视口导致「画布空白」 |
| N6 | **恢复不闪**：恢复用 `duration: 0`（或极短）⇒ 打开即在位，不出现「先全览再跳回」的二次动画 |

## 5. 实施要点（文件级）

| 文件 | 改动 |
|---|---|
| `packages/shared/src/canvas/types.ts`（`CanvasData` 所在处） | `CanvasData` 增**可选**字段 `viewport?: { x: number; y: number; zoom: number }`（可选 ⇒ 存量画布零兼容负担，且不产生 migration） |
| `packages/shared/src/canvas/viewport.ts`（新增） | 纯函数 `clampViewport(vp)`（zoom 收敛到既有合法区间 [0.1, 2]）、`isViewportUsable(vp)`（脏值/缺字段判否）；与 `CanvasData` 同源 ⇒ 类型不重复定义 |
| `apps/web/src/composables/useCanvasActions.ts` | `flowToCanvasData(nodes, edges, extras?)` 的 `extras` 增 `viewport?` ⇒ 产出可选带出该字段；**不带则产出的对象里没有这个键**（N1） |
| `apps/web/src/pages/CanvasPage.vue` | ① 视口变化监听（防抖合并）→ 记 `pendingViewport`；② `saveCanvas` 带上它；③ 加载后若 canvasData 带 viewport ⇒ `setViewport` 恢复（clamp + duration 0）；④ 回合末「无新节点」分支去掉全览 fitView（保留「有新节点」聚焦） |
| 测试 | 见 §6 |

## 6. 测试与守卫

| 层 | 用例 |
|---|---|
| 纯函数 | `clampViewport`：zoom 越界收敛到 [0.1, 2]；x/y 保持；缺字段/脏值回落 null |
| 序列化 | `flowToCanvasData` 带 viewport ⇒ 产出含 `viewport`；不带 ⇒ **不含该键**（N1/N2：可选字段不污染存量结构） |
| 回合末 | 无新节点回合 ⇒ 视口三值不变（N3）；有新节点回合 ⇒ 仍聚焦新节点（SP-A 回归锁） |
| 恢复 | 带 viewport 的 canvasData 加载 ⇒ `setViewport` 被调用且参数 = 落库值（N5/N6）；不带 ⇒ 不调用（N1） |
| 节流 | 连续 10 次视口变化 ⇒ 落库调用次数 = 1（N4） |
| 守卫 | 静态断言：回合末**不得**出现无条件的 `fitView({ padding: … })` 全览调用（防回归） |

## 7. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 视口变化落库太频繁 ⇒ 写放大 | 防抖合并（N4）；且视口变化**不**触发 undo checkpoint（不进用户撤销栈） |
| R2 | 恢复的视口让内容落在屏幕外（例如换了设备） | zoom clamp（N5）；恢复后若内容 bbox 与视口无交集 ⇒ 回落默认 fitView（fail-open） |
| R3 | 去掉回合末全览后，回合产物在视口外看不见 | 有新节点 ⇒ 聚焦（SP-A 已有）；无新节点 ⇒ 产物本就在已有节点上（对话面板可见）+ 用户可点「回到全览」（既有按钮） |
| R4 | 视口写进 canvasData 与节点坐标同 blob ⇒ 并发写覆盖风险 | 属 SP-E 范畴（canvasVersion CAS）；本包只在**用户手动编辑**的落库通道带视口，不与回合产出写冲突 |
| R5 | 打开画布时序（nodes 未测量完就 setViewport） | 恢复在 nodes 应用之后、`nextTick` 之后执行（复用 imported viewport 通道的既有时序经验） |

## 8. 与后续包的关系

SP-C 的视口状态是 **SP-E（并发与暂存底座）** 的前置：视口一旦是一等持久化状态，多端并发写
canvasData 就要对它做 CAS 与冲突裁决；SP-E 的 `canvasVersion` CAS 同时覆盖节点与视口。
SP-F（分组深化 + 内核合一）不涉及视口。
