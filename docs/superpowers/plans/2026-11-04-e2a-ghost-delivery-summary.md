# E2-a 回合产物幽灵摘要（ghost delivery summary）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 回合尾一行「查看本轮产物 · N」幽灵摘要 + 展开横向缩略图条；tile 一跳直达原生 viewer（移动端）/ focus_node 定位（桌面端）。零后端契约改动（埋点小端点除外）。

**Architecture:** 纯渲染期派生——`turnDeliveryItems(parts)` 纯函数过滤 done artifact parts，产物本体按 nodeId 经 `resolveViewerNode` prop（AgentSideRail 由 canvasNodes 解析）供给；viewer 直开经既有 `inject(MOBILE_NODE_OPEN_VIEWER_KEY)`（CanvasPage :2895 provide，对话面板在子树内）；不新增 part kind / 不改 `NodeStatusData` / 不碰事件通道。

**Tech Stack:** Vue 3 + vitest（web）；NestJS + vitest（server，仅埋点端点）。

**Spec:** `docs/superpowers/specs/2026-11-04-e2a-ghost-delivery-summary-design.md`（已拍板 2026-11-04）。执行者须同读规格与本计划。

## Global Constraints

- 幽灵行/清单**纯渲染派生**：不改 parts、不新增 part kind、不落 executionEvents（D-a）；历史重放/快照重建结果一致。
- 显隐判据（D-b）：N=0 不渲染；failed 不计入；存在 running artifact（回合进行中）不渲染；N>9 显 9+。
- viewer 直开（D-c）：`resolveViewerNode` 解析成功 + inject 命中 ⇒ `{id,type,data}` 直开（NodeRenderer.vue:72 同款契约）；inject 缺省（DevTimelinePreviewPage）或桌面 ⇒ emit `focusNode`。文本 tap 直开阅读器（不做 TTS 分流）。
- 样式仅 `--lnk-*` 令牌（禁 `--neo-*` / 新增 hex / emoji）；图标内联 SVG 24 网格 stroke:2；移动端触控 ≥44px（透明外扩先例：AgentSideRail mic）；展开动效 `--lnk-duration-fast` + reduced-motion 降级。
- 测试纪律：vitest `--maxWorkers=1 --no-file-parallelism`；改组件后必跑 `vue-tsc -b`。
- 推送纪律：git https 502 走 REST Git Data API（blob sha 逐项核对）；commit 只在 worktree。

## Review Focus

1. **派生不落库**：幽灵行状态（展开态）是组件本地 ref，禁止写进 timeline/executionEvents（Task 2 静态契约钉死）。
2. **显隐边界**：回合进行中不渲染——避免与 running 行内卡双入口打架；N=0/failed 不计（Task 1/2 测试钉死）。
3. **viewer 契约同源**：传参形态必须与 `NodeRenderer.vue:72` 一致（id/type/data），data 来自 canvas store 节点本体（版本正确性同源），禁止用 part.url 拼凑 data（Task 2）。
4. **埋点零阻塞**：fetch 失败静默丢弃不重试，不得阻塞渲染（Task 3）。

---

### Task 1: web — deliverySummary 纯函数

**Files:**
- Create: `apps/web/src/components/agent/deliverySummary.ts`
- Test: `apps/web/src/components/agent/deliverySummary.test.ts`

**Interfaces:**
- Consumes: `TimelinePart`（turnTimeline.ts，只读）。
- Produces: `turnDeliveryItems(parts): Array<{ nodeId: string; nodeType: string; title: string }>`（done artifact 保序过滤）；`hasRunningGeneration(parts): boolean`；`deliveryCountLabel(n): string`（0→''，>9→'9+'，余 String(n)）。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { turnDeliveryItems, hasRunningGeneration, deliveryCountLabel } from './deliverySummary'
// part 构造助手沿用 turnTimeline.test.ts 的既有 builder（先读该文件头部确认构造方式）

it('过滤：仅 done 且有 nodeId 的 artifact part 入选，保序', () => {
  const items = turnDeliveryItems([
    mkArtifact({ nodeId: 'n1', status: 'running' }),
    mkArtifact({ nodeId: 'n2', status: 'done', url: 'https://x/a.png' }),
    mkArtifact({ nodeId: 'n3', status: 'failed' }),
    mkArtifact({ nodeId: 'n4', status: 'done' }),
  ])
  expect(items.map((i) => i.nodeId)).toEqual(['n2', 'n4'])
})
it('重放一致性：同输入两次调用同输出；不 mutate 入参（冻结数组断言）', () => {})
it('hasRunningGeneration：存在 running artifact ⇒ true；全终态 ⇒ false', () => {})
it('deliveryCountLabel：0→"" / 9→"9" / 10→"9+"', () => {})
```

- [ ] **Step 2: 跑测试确认失败** `cd apps/web && ./node_modules/.bin/vitest run src/components/agent/deliverySummary.test.ts --maxWorkers=1 --no-file-parallelism`
- [ ] **Step 3: 最小实现**（纯函数 ~30 行；`Object.freeze` 输入副本内过滤）
- [ ] **Step 4: 跑测试确认通过** + **变异**：把过滤条件 `status==='done'` 改成 `!== 'failed'` ⇒ 用例必须红（抓得住）。
- [ ] **Step 5: Commit** `feat(web): 回合产物清单派生纯函数（E2-a Task 1，D-a）`

---

### Task 2: web — AgentTurnTimeline 幽灵行 + viewer 直开

**Files:**
- Modify: `apps/web/src/components/agent/AgentTurnTimeline.vue`（props 增 `resolveViewerNode?`；template 回合尾部追加幽灵行/展开条）
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（实现并传入 `resolveViewerNode`，镜像 `resolveCanvasNodeUrl` :1832 模式：`props.canvasNodes?.find(...)` → `{ id, type: node.type, data: node.data }`，type 不属 image/video/audio/text ⇒ undefined）
- Test: `apps/web/src/components/agent/AgentTurnTimeline.deliverySummary.test.ts`（静态契约，readFileSync + stripComments + 正则，沿用 AgentSideRail 测试约定）

**Interfaces:**
- Consumes: Task 1 纯函数；`MOBILE_NODE_OPEN_VIEWER_KEY`（`@/components/canvas/nodeViewerKeys` 或其既有导出位置——实施时先 grep 确认，`inject(KEY, null)` 带缺省）；既有 emit `focusNode`。
- Produces: 回合尾部两态幽灵行（收起：tint 文本行 + chevron；展开：横向 64px tile 条）。

- [ ] **Step 1: 写静态契约失败测试**（断言项，stripComments 后正则）：
  - 显隐：幽灵行容器 `v-if` 含 `deliveryItems.length` 与 `!hasRunningGeneration`（D-b）；
  - 路由：tile tap 处理器内先 `resolveViewerNode` 后 `openViewer(...)`/`emit('focusNode', ...)` 分支（D-c）；viewer 传参形如 `{ id: ..., type: ..., data: ... }`；
  - 形态：chevron 旋转过渡类、`overflow-x: auto`（横滑）、tile 64px；
  - 纪律：无新增 hex / `--neo-` / emoji（design-token 守卫同款正则）；`aria-label` 在定位角标上；
  - 状态：展开态为本地 `ref`，模板外无 timeline 写入。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（要点）：
  - `const deliveryItems = computed(() => turnDeliveryItems(props.parts))`；`const expanded = ref(false)`；
  - tile 缩略图：`artifactUrl(part)` 既有函数复用（part.url 优先、resolveNodeUrl 兜底）；audio/text 无图走内联 SVG 类型 tile；video 时长徽标读 `resolveViewerNode(nodeId)?.data?.durationMs`（非数字隐藏）；
  - tap：`openViewerFromTile(item)` —— `const node = props.resolveViewerNode?.(item.nodeId); if (node && viewerOpen) viewerOpen(node); else emit('focusNode', item.nodeId)`；文本节点同路由（直开阅读器）；
  - 定位角标：`@click.stop` emit focusNode；`::after` 外扩至 44px；
  - 打点：Task 3 完成后接线 `observeDeliveryCard`（先留 TODO 注释不阻塞）。
- [ ] **Step 4: 跑测试确认通过** + `npx vue-tsc -b` 0 error + design-token/theme-usage/dead-styles 三测试零回归
- [ ] **Step 5: Commit** `feat(web): 回合产物幽灵摘要行 + viewer 直开（E2-a Task 2，D-b/D-c/E-d）`

---

### Task 3: 埋点端点（Nest）+ 前端批量上报

**Files:**
- Create: `apps/server/src/agent/delivery-metrics.controller.ts` + `.test.ts`
- Modify: `apps/server/src/agent/agent.module.ts`（注册）
- Create: `apps/web/src/components/agent/deliveryMetrics.ts`
- Modify: `apps/web/src/components/agent/AgentTurnTimeline.vue`（三处打点接线）

**Interfaces:**
- Produces: `POST /api/agent/metrics/delivery`（AuthGuard；body `{ events: Array<{ type: 'impression'|'expand'|'viewer_open'|'locate'; nodeId?: string; kind?: string; ts?: number }> }`，批量上限 50 超出 400，空数组 400；进程内存 `Map` 计数，并入 `GET /api/health/notify-metrics` 的 `deliveryCard:{...}` 面——notify-metrics 同模式）。
- web：`observeDeliveryCard(type, meta)` 批量缓冲（50 条或 5s flush，POST 失败静默丢弃）；接线点：幽灵行首渲 `impression`（`onMounted` + IntersectionObserver 单例可选，v1 简化为首渲即计）、`expanded` watch → `expand`、tile tap 成功开 viewer → `viewer_open`、定位 → `locate`。

- [ ] **Step 1: Nest 失败测试**（Auth mock / 空数组 400 / 正常批次 201 计数递增 / 超 50 条 400）→ **Step 2 RED** → **Step 3 最小实现**（notify-metrics controller 抄结构）→ **Step 4 GREEN + `npx tsc --noEmit`** → **Step 5 Commit** `feat(agent): 交付摘要埋点端点（E2-a Task 3）`
- [ ] **Step 6: web deliveryMetrics.ts**（缓冲与 flush 单测：假 timer、fetch mock、失败不重试）→ Commit `feat(web): 埋点批量上报（E2-a Task 3）`

---

### Task 4: DevTimelinePreview 样例 + 全量回归收口

**Files:**
- Modify: `apps/web/src/pages/DevTimelinePreviewPage.vue`（§5 六场景样例事件流：单图 / 四格 / 混合四类 / 补拍回填计数变化 / 失败不计入 / 桌面路由）

- [ ] **Step 1: 增补样例**（沿用预览页既有样例注入机制）
- [ ] **Step 2: 全量回归**

```bash
cd apps/web && npx vue-tsc -b && ./node_modules/.bin/vitest run --maxWorkers=1 --no-file-parallelism
cd apps/server && npx tsc --noEmit && ./node_modules/.bin/vitest run --maxWorkers=1 --no-file-parallelism
```

Expected: 两端全绿 0 error。
- [ ] **Step 3: Commit** `test(dev-preview): E2-a 六场景样例（E2-a Task 4）`
- [ ] **Step 4: 推送 + PR**（worktree 分支 `feat/e2a-ghost-delivery-summary`；PR body 引用规格 §5 验收判据；无 pi-runtime/server 行为改动 ⇒ 无需 runtime-deploy，仅常规 web 部署）→ CI → squash merge → 部署 → 移动真机走查（44px 命中/横滑/reduced-motion）。

---

## Self-Review 记录

- 规格覆盖：§1 目标（Task 2）、§3 D-a（Task 1）/D-b（Task 1+2）/D-c（Task 2）/D-d+E-d（Task 2 静态契约）、§5 六场景（Task 4）、§6 埋点（Task 3）、§7 清单逐项映射。
- Review Focus 四项均有归属测试（Task 1/2/3）。
- 与原 E2 计划关系：本计划替代其 Task 5（埋点原样保留）/Task 8（渲染形态替换）；原 Task 1-4/6/7/9/10 归 E2-b（原计划文件头部已标注）。
