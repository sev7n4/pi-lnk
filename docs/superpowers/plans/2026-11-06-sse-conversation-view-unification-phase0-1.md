# SSE 对话页视图层统一（移动端为锚）· Phase 0–1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立「视图层统一」的回归护栏（Phase 0），并把移动端 `MobileNodeTile` / `MobileNodeViewer` 提升为设备无关共享组件（Phase 1），使后续 Phase 2–4 在零移动回归的前提下安全推进。

**Architecture:** 以移动端组件为锚，原地提升为 `components/agent/presentation/` 下的共享 `NodeView` 族（只吃 props/store，禁读 `isMobileLayout`）；移动壳（`MobileCanvasShell` / 手势）原样保留，仅改引用指向共享组件。Phase 0 用本仓既有的「静态契约 `.test.ts`」机制（对齐 `CanvasPage.mobileChromeHygiene.test.ts`、`AgentSideRail.mobileEntryWiring.test.ts` 等）把三条护栏钉进 CI。

**Tech Stack:** Vue 3 SFC + TypeScript + Vitest（本仓 `pnpm test`，node24 + `--maxWorkers=1 --no-file-parallelism`）；静态契约测试读取源文件文本断言；`vue-tsc -b` 类型校验。

**Spec:** `docs/superpowers/specs/2026-11-05-sse-conversation-view-unification-design.md`（§5 / §9 / §10 / §13.1；生产态复核以 §13.1 为准）

## Global Constraints

- **判据 A**：组件若同时读 `isMobileLayout` 与渲染业务内容 ⇒ 必须拆。内容进共享层（只吃 props/store，禁读 `isMobileLayout`），形态进壳。
- **判据 B**：重构存量分叉时，优先把更新、更干净、更满意的那套实现升级为共享层，另一端去消费它，而非另起中立层。
- **判据 C**：任何 `fetch`/网络调用不得出现在渲染组件内；必须落在 `agentCommandClient`（Phase 2 处理，本期不涉及）。
- **判据 D**：前端内容组件统一落在 `components/agent/presentation/`（PC 内容组件已在此），不与 `components/canvas/` 混用。
- **AGENTS.md 移动端呈现规则**：移动端编排只有一个所有者 `components/mobile/` 壳层；禁止在 PC 组件新增 767px media query 补丁；断点语义二维（形态 × 能力集）；新增移动端专用呈现落 `components/mobile/` 或 `*Mobile*` 命名——**本规格 Phase 0 收敛该条：新内容组件应进 `presentation/`，不再新开 `Mobile*`**。
- **设计令牌守卫**：改组件后须跑 `apps/web/src/styles/design-token.test.ts` 等四测试，禁形态专属硬编码（hex / `rgba(` / `text-white` / `bg-[#`）。
- **测试纪律**：Vitest 用 node24 + `--maxWorkers=1 --no-file-parallelism`；改组件后跑 `vue-tsc -b`。

## Review Focus

1. **共享组件残留 `isMobileLayout`**：Phase 1 提升 `MobileNodeTile/Viewer` 时若把移动环境判断带进共享层 ⇒ 污染 PC、违反判据 A。→ Task 4 静态契约断言共享组件文本零 `isMobileLayout`。
2. **新建 `Mobile*` 内容组件绕过护栏**：Phase 1–4 中若有人新开 `Mobile*` 渲染组件 ⇒ 分叉复发。→ Task 1 allowlist 把当前 26 个 `Mobile*` 钉成允许列表，新增即红。
3. **反向依赖**：移动组件 import 桌面 `components/agent/Agent*` ⇒ 壳/内容边界崩塌。→ Task 1 断言 `components/mobile/*.vue` 不 import `components/agent/Agent*`。
4. **手势接线丢失**：提升时把长按/横滑/菜单接线误删 ⇒ 移动端核心交互静默失效。→ Task 2/3/5 以 `MobileNodeTile.gesture.test.ts` / `MobileNodeViewer.test.ts` 全绿为门禁，并断言共享组件仍透传手势回调 props。
5. **移动测试被跳过/假绿**：提升后移动测试子集未实际运行 ⇒ 回归未发现。→ Task 2/3/5 显式运行移动专属测试文件并断言通过，禁止 `@skip` / 条件跳过。

---

### Task 1: 视图统一护栏（allowlist + 反向依赖 + 共享层零 isMobileLayout）

**Files:**
- Create: `apps/web/src/components/agent/viewUnification.guards.test.ts`

**Interfaces:**
- Consumes: 读取 `apps/web/src/components/mobile/` 目录与源文件文本（node `fs`）；读取 `apps/web/src/components/agent/presentation/` 下共享组件文本
- Produces: 三个静态契约断言（allowlist pin / reverse-dep ban / 共享层零 `isMobileLayout`），供后续 Phase 2–4 持续守护

> 说明：静态护栏是**回归守卫**，当前代码已合规，测试默认通过。TDD 的「看它失败」通过**临时注入违例**（见 Step 2）来证明测试有效，随后还原。

- [ ] **Step 1: Write the failing test**

```ts
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 对齐本仓静态契约测试惯例（见 CanvasPage.mobileChromeHygiene.test.ts）：
// 以测试文件自身位置为锚解析，不依赖 process.cwd()。
const here = dirname(fileURLToPath(import.meta.url))
const MOBILE_DIR = join(here, '..', 'mobile')
const PRESENTATION_DIR = join(here, 'presentation')

// 当前 Mobile* 允许列表（Phase 1 提升后，被提升者从此列表移除并迁入 presentation/）
const ALLOWED_MOBILE = new Set([
  'DiscoverPane', 'MobileAnnotationCapsule', 'MobileCanvasCreateFab', 'MobileCanvasShell',
  'MobileCreateSheet', 'MobileMultiSelectBar', 'MobileMultiSelectMoreSheet',
  'MobileNodeActionSheet', 'MobileNodeAnnotateSheet', 'MobileNodeCoachMark',
  'MobileNodeEditorSheet', 'MobileNodeStatusBar', 'MobileNodeTile', 'MobileNodeViewer',
  'MobileNodeWaveform', 'MobileReadingSurface', 'MobileSaveStatus', 'MobileSheet',
  'MobileTabBar', 'MobileTaskSheet', 'MobileTopBar', 'MobileUndoToast', 'MobileViewerChrome',
  'ProfilePane',
])

test('no new Mobile* content component beyond pinned allowlist', () => {
  const files = readdirSync(MOBILE_DIR).filter(f => f.endsWith('.vue'))
  for (const f of files) {
    const name = f.replace(/\.vue$/, '')
    expect(ALLOWED_MOBILE.has(name),
      `新增 Mobile 组件 ${name} 须经视图统一评审（应提升为 presentation/ 共享组件），禁止绕过 Phase 0 护栏`
    ).toBe(true)
  }
})

test('mobile components must not import desktop Agent* components', () => {
  const files = readdirSync(MOBILE_DIR).filter(f => f.endsWith('.vue'))
  for (const f of files) {
    const src = readFileSync(join(MOBILE_DIR, f), 'utf8')
    expect(src, `${f} 不得反向依赖桌面 Agent* 组件（壳/内容边界）`)
      .not.toMatch(/from\s+['"][^'"]*components\/agent\/Agent/)
  }
})

test('shared presentation components must not read isMobileLayout', () => {
  const files = readdirSync(PRESENTATION_DIR).filter(f => f.endsWith('.vue'))
  for (const f of files) {
    const src = readFileSync(join(PRESENTATION_DIR, f), 'utf8')
    expect(src, `${f} 属共享内容层，禁止读 isMobileLayout（判据 A）`)
      .not.toContain('isMobileLayout')
  }
})
```

- [ ] **Step 2: Verify RED（临时注入违例证明测试有效）**

Run: `cd apps/web && pnpm exec vitest run src/components/agent/viewUnification.guards.test.ts`
临时在 `components/mobile/` 放一个 `MobileScratchProbe.vue` 含 `import X from '@/components/agent/AgentSideRail.vue'`，再跑 → 期望 **FAIL**（allowlist + 反向依赖两条红）。还原临时文件后重跑 → 期望 PASS。

- [ ] **Step 3: 落实护栏（无生产代码；现有代码已合规）**

护栏即测试本身。若 Step 2 还原后全绿，则护栏生效，无需改生产代码。

- [ ] **Step 4: Run full suite**

Run: `cd apps/web && pnpm test`（或 `pnpm exec vitest run`）确认无回归、无告警。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agent/viewUnification.guards.test.ts
git commit -m "test: 视图统一护栏——Mobile allowlist + 禁反向依赖 + 共享层零 isMobileLayout"
```

---

### Task 2: 提升 `MobileNodeTile` → 共享 `NodeTileView`（presentation/）

**Files:**
- Create: `apps/web/src/components/agent/presentation/NodeTileView.vue`（由 `MobileNodeTile.vue` 提升）
- Modify: `apps/web/src/components/mobile/MobileNodeTile.vue`（改为薄壳，委托 `NodeTileView`；保留手势接线）
- Test: `apps/web/src/components/mobile/MobileNodeTile.gesture.test.ts`、`apps/web/src/components/mobile/MobileNodeTile.propose.test.ts`（既有，作门禁）、`apps/web/src/components/agent/presentation/NodeTileView.test.ts`（新建）

> **预检裁定（Ruling 2）**：Task 2 **不修改** `viewUnification.guards.test.ts`。依据 Ruling 1，allowlist 保持 24 件不变（MobileNodeTile 仍是薄壳文件，不得从 allowlist 移除）；`NodeTileView.vue` 是新建的 `presentation/` 非 `Mobile*` 组件，自动被护栏第三条（零 `isMobileLayout`）覆盖，无需任何 allowlist 变更。brief 中的「presentation 白名单认知」在本规格下无意义——本仓无 presentation 白名单。

**Interfaces:**
- Consumes: 现有 `MobileNodeTile.vue` 的渲染逻辑与 props 契约（逐字保留 props 名/类型）
- Produces: `NodeTileView.vue` 导出的默认组件，props 与 `MobileNodeTile` 完全一致；被移动壳与（Phase 3）PC 画布节点复用

- [ ] **Step 1: Write the failing test**

新增 `apps/web/src/components/agent/presentation/NodeTileView.test.ts`，断言：给定同一组 props（节点数据 + `presentation='mobile-tile'`），`NodeTileView` 挂载后渲染出与 `MobileNodeTile` 等价的关键 DOM 结构（节点标题/媒体要素/状态条挂载点）。运行 → 期望 **FAIL**（`NodeTileView` 不存在）。

- [ ] **Step 2: Verify RED**

Run: `cd apps/web && pnpm exec vitest run src/components/agent/presentation/NodeTileView.test.ts` → FAIL（模块未找到）。

- [ ] **Step 3: Write minimal implementation**

将 `MobileNodeTile.vue` 的渲染主体（template + 纯渲染 script，去除壳层手势接线 `useLongPress` 等，改为接收手势回调 props）复制到 `NodeTileView.vue`；确保文本零 `isMobileLayout`、零 `window.innerWidth`/`matchMedia`。`MobileNodeTile.vue` 瘦身为薄壳：仅保留 `useLongPress`/横滑等手势接线，并把渲染委托给 `<NodeTileView v-bind="$attrs" @long-press="..." />`。

- [ ] **Step 4: Verify GREEN**

Run: `cd apps/web && pnpm exec vitest run src/components/mobile/MobileNodeTile.gesture.test.ts src/components/mobile/MobileNodeTile.propose.test.ts src/components/agent/presentation/NodeTileView.test.ts` → 全绿；随后 `pnpm exec vitest run` 确认全仓无回归。再跑 `vue-tsc -b` 确认类型。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agent/presentation/NodeTileView.vue \
        apps/web/src/components/agent/presentation/NodeTileView.test.ts \
        apps/web/src/components/mobile/MobileNodeTile.vue
git commit -m "feat(view): 提升 MobileNodeTile → 共享 NodeTileView（presentation/，移动壳零行为变更）"
```

---

### Task 3: 提升 `MobileNodeViewer` → 共享 `NodeViewerView`（presentation/）

**Files:**
- Create: `apps/web/src/components/agent/presentation/NodeViewerView.vue`（由 `MobileNodeViewer.vue` 提升）
- Modify: `apps/web/src/components/mobile/MobileNodeViewer.vue`（改为薄壳，委托 `NodeViewerView`；保留手势/退出/缩放接线）
- Test: `apps/web/src/components/mobile/MobileNodeViewer.test.ts`、`apps/web/src/components/mobile/MobileNodeViewer.fit.test.ts`、`apps/web/src/components/mobile/MobileNodeViewer.vue` 相关

**Interfaces:**
- Consumes: 现有 `MobileNodeViewer.vue` 的渲染逻辑与 props 契约（逐字保留）
- Produces: `NodeViewerView.vue` 默认组件，props 与 `MobileNodeViewer` 一致；被移动壳与（Phase 3）PC 查看器复用

- [ ] **Step 1: Write the failing test**

新增 `apps/web/src/components/agent/presentation/NodeViewerView.test.ts`，断言：给定节点数据 + `presentation='mobile-viewer'`，`NodeViewerView` 渲染出与 `MobileNodeViewer` 等价的查看器结构（媒体/标注/缩放容器）。运行 → 期望 **FAIL**。

- [ ] **Step 2: Verify RED**

Run: `cd apps/web && pnpm exec vitest run src/components/agent/presentation/NodeViewerView.test.ts` → FAIL（模块未找到）。

- [ ] **Step 3: Write minimal implementation**

将 `MobileNodeViewer.vue` 渲染主体复制到 `NodeViewerView.vue`，去除壳层接线（退出/双指缩放/`MobileSheet` 浮层基座属壳，留在 `MobileNodeViewer` 薄壳），确保零 `isMobileLayout`。`MobileNodeViewer.vue` 瘦身为薄壳，委托 `<NodeViewerView v-bind="$attrs" @close="..." @zoom="..." />`。

- [ ] **Step 4: Verify GREEN**

Run: `cd apps/web && pnpm exec vitest run src/components/mobile/MobileNodeViewer.test.ts src/components/mobile/MobileNodeViewer.fit.test.ts src/components/agent/presentation/NodeViewerView.test.ts` → 全绿；`pnpm exec vitest run` 全仓无回归；`vue-tsc -b` 类型通过。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agent/presentation/NodeViewerView.vue \
        apps/web/src/components/agent/presentation/NodeViewerView.test.ts \
        apps/web/src/components/mobile/MobileNodeViewer.vue
git commit -m "feat(view): 提升 MobileNodeViewer → 共享 NodeViewerView（presentation/，移动壳零行为变更）"
```

---

### Task 4: Phase 1 后守卫复核 + 移动回归总闸

**Files:**
- Modify: `apps/web/src/components/agent/viewUnification.guards.test.ts`（仅复核，allowlist **保持不变**——`MobileNodeTile`/`MobileNodeViewer` 仍作薄壳存在于 `components/mobile/`，不得从 allowlist 移除）

**Interfaces:**
- Consumes: Task 1 的护栏文件 + Task 2/3 产出的共享组件（`NodeTileView`/`NodeViewerView` 落 `presentation/`）
- Produces: 确认护栏在 Phase 1 后仍然全绿（新增共享组件零 `isMobileLayout`，已由 Task 1 第三条断言覆盖）

> **预检裁定（SDD 前置）**：原 Task 4 写「从 allowlist 移除 `MobileNodeTile`/`MobileNodeViewer`」与 Phase 1「保留二者为薄壳（不删文件）」自相矛盾——若移除，守卫会因文件仍在而红。已裁定 allowlist 保持原集合不变。Task 4 实为「复核 + 回归总闸」，不再改动 allowlist。

- [ ] **Step 1: 复核护栏在 Phase 1 后无回归**

Run: `cd apps/web && pnpm exec vitest run src/components/agent/viewUnification.guards.test.ts` → 期望 **PASS**（allowlist 与当前 `components/mobile/` 目录一致；`presentation/` 下 `NodeTileView`/`NodeViewerView` 零 `isMobileLayout`，由 Task 1 第三条断言覆盖）。

- [ ] **Step 2: 移动 + agent 测试套件总闸**

Run: `cd apps/web && pnpm exec vitest run src/components/mobile src/components/agent` → 全绿（Phase 1 提升后零移动回归）。若任一失败，回到 Task 2/3 修复后重跑。

- [ ] **Step 3: Verify GREEN + 类型 + 令牌**

`pnpm exec vitest run` 全仓无回归；`vue-tsc -b` 通过；并跑 `apps/web/src/styles/design-token.test.ts` 等四令牌测试确认无硬编码形态。

- [ ] **Step 4: Commit（如护栏文件有微调才提交；纯复核则无需提交）**

```bash
git add apps/web/src/components/agent/viewUnification.guards.test.ts
git commit -m "test: Phase 1 后护栏复核 + 移动回归总闸（allowlist 保持，共享层零 isMobileLayout）"
```

---

## 自检（Spec 覆盖）

- 规格 §5.1 判据 A/B/C/D、§9 文件清单、§10 测试策略 → Task 1–4 覆盖（C 留 Phase 2）。
- 规格 §13.1 生产态前提（mobileAppTab 驱动移动 chat 仍成立、锚更优）→ Phase 1 以移动为锚，不触移动壳，符合。
- 规格 §10 移动回归零容忍（MobileNodeTile.gesture / MobileNodeViewer.fit 等）→ Task 2/3/5 显式门禁。
- 未覆盖：Phase 2（L1 agentCommandClient）、Phase 3（拆 God Component + 删 29 处 isMobileLayout + 删 PC 冗余）、Phase 4（双 applier 收敛）→ 各自独立计划，不在本计划范围。
