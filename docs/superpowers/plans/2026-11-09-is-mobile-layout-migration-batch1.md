# `isMobileLayout` 逐处搬第一批 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 用户已指定执行方式为 **Native**（本会话内逐任务实施，末尾一次全分支复核）。

**Goal:** 把 `AgentSideRail.vue` 模板里 7 处重复的 `!isMobileLayout` 收敛为单一语义派生 `isDesktopDock`，门禁上限 21 → 15，用真实 mount 的 PC / 移动两端 DOM 断言证明零行为变更。

**Architecture:** 只在 Shell SFC 内新增一个局部 computed 并替换 7 处模板表达式；`useAgentMobileLayout()` 唯一定义点不动、Content/shared 零容忍区不动、冻结边界不动；门禁脚本常量与方向判据同步收紧；因触及 `apps/web/**` 会触发一次 web-only 生产发布，须做 bundle 级复测。

**Tech Stack:** Vue 3 `<script setup>` + `computed`、Vitest + `@vue/test-utils` + Pinia + vue-router memory history、Python 3 标准库门禁脚本、`gh api` Git Data API、GitHub Actions 三必需 job。

**Spec:** `docs/superpowers/specs/2026-11-09-is-mobile-layout-migration-batch1-design.md`

## Global Constraints

- 真值基线 `2b6693c579ffb2931a84d1954e93fecf5617db91`（写作时），推前重新 `gh api` 核对 + `MASTER_MOVED_SAFE`；`AgentSideRail.vue` 是并行会话活跃改动区，必须从 true master 取回后编辑。
- `isDesktopDock = computed(() => !isMobileLayout.value)` 必须是**纯否定**，不得夹带 `open` / `floating` / `railHiddenByTab`。
- 模板区不得残留 `!isMobileLayout`；脚本区 `!isMobileLayout.value` 属后续批次，本批保留。
- `MAX_ALLOWED = 15` 且 V3 判据内 `^MAX_ALLOWED = 15$` 同步；上限只降不升。
- 冻结边界 `sendMessage` / `handleEvent` / `canvas_command` / `defineExpose` 11 项零改写；`getIsMobileLayout` 契约不变。
- `presentation/**` 与 `packages/shared/**` 零读取；`useAgentMobileLayout()` 定义点仍为 1 且位于 SFC。
- 不改母规格、`ci.yml` 挂载行、`package.json`、`deploy.yml`、`pc-visual-baseline.json`。
- `deploy.yml` 的 `push.paths` 含 `apps/web/**` ⇒ 必然触发 web-only 生产发布，T5 强制 bundle 下钻 + health。
- vitest 用 nvm node24 + `--maxWorkers=1 --no-file-parallelism`；改组件后跑 `vue-tsc -b`；本机 pnpm 须 `env -u NODE_OPTIONS`；`pnpm -r build` 编译 `*.test.ts` ⇒ 断言禁 `as never`。
- 推送全走 `gh api`；`git/trees` POST 用 `base_tree` 只传改动路径，禁带全量条目。

## Review Focus

1. **`open = ref(false)` 且面板用 `v-show`**：子元素仍在 DOM 中，行为级断言必须加 PC 端有效性检查，否则「两端都不存在」会假绿 ⇒ Task 1 的 `expect(pcHandles).toHaveLength(1)` 覆盖。
2. **Teleport 到 body**：`wrapper.find()` 取不到 teleport 内容 ⇒ 查询必须包含 `document.body`，Task 1 的 `queryAll()` 覆盖。
3. **V3 硬编码 `MAX_ALLOWED = 21`**：只改常量不改判据 ⇒ 门禁假红，或只改判据不改常量 ⇒ 恒绿 ⇒ Task 3 的双处同步 + 变异 M3 覆盖。
4. **脚本区 `!isMobileLayout.value` 被误替换**：会改变 composer / watch 行为 ⇒ Task 2 用精确行锚点替换 + Task 4 的 S2 断言覆盖。
5. **生产发布后未复测或回退并行改动**：Task 6 的 bundle 下钻 + `ALL_PARALLEL_KEPT` 覆盖。

---

### Task 1: 取回 true master SFC 并写行为级 RED 测试

**Files:**
- Create: `apps/web/src/components/agent/AgentSideRail.desktopDockDerived.test.ts`
- Test: 同上

**Interfaces:**
- Consumes: `gh api repos/sev7n4/pi-lnk/git/blobs/{sha}` 取回的 `AgentSideRail.vue`（裸 blob sha 校验）。
- Produces: `mountRail(matches: boolean)`；`queryAll(sel: string) => Element[]`；`DESKTOP_ONLY_SELECTORS = ['.agent-resize-handle', '.agent-subtitle', '[title="收起助手"]']`。

- [ ] **Step 1: 从 true master 取回 SFC 并覆盖工作树**

```python
import base64, hashlib, json, pathlib, subprocess
REPO='sev7n4/pi-lnk'; SHA='2b6693c579ffb2931a84d1954e93fecf5617db91'
t=json.loads(subprocess.run(['gh','api',f'repos/{REPO}/git/trees/{SHA}?recursive=1'],capture_output=True,text=True).stdout)
p='apps/web/src/components/agent/AgentSideRail.vue'
sha=next(e['sha'] for e in t['tree'] if e['path']==p)
o=json.loads(subprocess.run(['gh','api',f'repos/{REPO}/git/blobs/{sha}'],capture_output=True,text=True).stdout)
data=base64.b64decode(o['content'])
assert hashlib.sha1(b'blob %d\0'%len(data)+data).hexdigest()==sha
pathlib.Path(p).write_bytes(data)
```

- [ ] **Step 2: 写失败测试**

```ts
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import AgentSideRail from './AgentSideRail.vue'

const DESKTOP_ONLY_SELECTORS = [
  '.agent-resize-handle',
  '.agent-subtitle',
  '[title="收起助手"]',
]

function queryAll(sel: string): Element[] {
  const inBody = Array.from(document.body.querySelectorAll(sel))
  return inBody
}

async function mountRail(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches, media: query, addEventListener: () => {}, removeEventListener: () => {},
  }))
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })))
  const router: Router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()
  const w = mount(AgentSideRail, {
    attachTo: document.body,
    global: { plugins: [router] },
    props: { sessionId: 's1' },
  })
  await flushPromises()
  return w
}
```

测试体：① PC 端 `DESKTOP_ONLY_SELECTORS` 三项各 `toHaveLength(1)`（有效性断言）；② 移动端三项各 `toHaveLength(0)`；③ 源码契约断言 `rail` 含 `const isDesktopDock = computed(() => !isMobileLayout.value)` 且模板区不含 `!isMobileLayout`；④ `defineExpose` 11 项与 `getIsMobileLayout` 契约在位。

- [ ] **Step 3: 跑测试确认 RED**

Run: `env -u NODE_OPTIONS npx vitest run apps/web/src/components/agent/AgentSideRail.desktopDockDerived.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL —— `isDesktopDock` 尚不存在（源码契约断言失败）；两端 DOM 断言本身应已 PASS（记录基线形态）。

- [ ] **Step 4: 记录搬迁前的两端 DOM 基线**

把 PC / 移动两端三项命中数写入证据文档，作为「渲染形态未变」的比对基准。

---

### Task 2: 实现 7 处模板替换与派生定义

**Files:**
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`

**Interfaces:**
- Consumes: Task 1 取回的 true master SFC。
- Produces: `isDesktopDock` computed；模板 7 处替换。

- [ ] **Step 1: 在 `const { isMobileLayout } = useAgentMobileLayout()` 之后插入派生**

```ts
const { isMobileLayout } = useAgentMobileLayout()
/** PC dock 语义派生：模板 7 处 !isMobileLayout 的单一真源（路线 ③ 第一批）。 */
const isDesktopDock = computed(() => !isMobileLayout.value)
```

- [ ] **Step 2: 精确替换 7 处模板表达式**

| 锚点 | 改前 | 改后 |
| --- | --- | --- |
| `is-docked-open` | `open && !floating && !isMobileLayout` | `open && !floating && isDesktopDock` |
| `:style="floating && !isMobileLayout ? {` | 同左 | `floating && isDesktopDock ? {` |
| `agent-resize-handle` 的 `v-if` | `v-if="!isMobileLayout"` | `v-if="isDesktopDock"` |
| `agent-panel-header` 的 `:class` | `floating && !isMobileLayout ? 'cursor-move' : ''` | `floating && isDesktopDock ? 'cursor-move' : ''` |
| `agent-subtitle` 的 `v-if` | `v-if="!isMobileLayout"` | `v-if="isDesktopDock"` |
| 浮动窗口切换按钮的 `v-if` | `v-if="!isMobileLayout"` | `v-if="isDesktopDock"` |
| 收起按钮的 `v-if` | `v-if="!isMobileLayout"` | `v-if="isDesktopDock"` |

替换只在 `<template>` 区做；`script` 区的 `!isMobileLayout.value`（L1225 等）**保留**。

- [ ] **Step 3: 跑测试确认 PASS**

Run: 同 Task 1 Step 3 命令。
Expected: 4 个用例全 PASS；PC 三项各 1、移动三项各 0，与 Step 4 基线一致。

- [ ] **Step 4: 核对有效读取点**

Run: `python3 scripts/verify-is-mobile-layout-scope.py --json`
Expected: Shell `count = 15`（21 − 7 + 1），但 `MAX_ALLOWED` 仍为 21 ⇒ V3 PASS（方向允许下降）。

---

### Task 3: 收紧门禁上限 21 → 15

**Files:**
- Modify: `scripts/verify-is-mobile-layout-scope.py`

**Interfaces:**
- Consumes: Task 2 的 15 点实测值。
- Produces: `MAX_ALLOWED = 15`；V3 方向判据 `^MAX_ALLOWED = 15$`。

- [ ] **Step 1: 双处同步**

```python
s = s.replace('MAX_ALLOWED = 21', 'MAX_ALLOWED = 15')
s = s.replace("r'^MAX_ALLOWED = 21$'", "r'^MAX_ALLOWED = 15$'")
```
确认两处都命中（`s.count('MAX_ALLOWED = 21') == 0`）。

- [ ] **Step 2: 跑门禁**

Run: `python3 scripts/verify-is-mobile-layout-scope.py`
Expected: `VERDICT ALL_PASS`，V3 详情含 `15 <= 15`。

- [ ] **Step 3: 跑全量门禁与编译**

Run:
```bash
env -u NODE_OPTIONS npx vue-tsc -b
env -u NODE_OPTIONS pnpm verify-agent-rail-gates
env -u NODE_OPTIONS pnpm verify-spec-figures --file docs/superpowers/specs/2026-11-09-is-mobile-layout-migration-batch1-design.md
python3 scripts/verify-pc-canvas-legacy-scope.py
python3 scripts/verify-phase4-delete-scope.py
```
Expected: 各自全绿；`vue-tsc -b` 0 error。

---

### Task 4: 变异测试 ≥ 6 组

**Files:**
- Test: `/tmp/knife3_mutation.py`（临时脚本，不入库）

**Interfaces:**
- Consumes: 工作树 7 个交付路径的裸 blob sha。
- Produces: `M1..M6` 结果矩阵 + 恢复后 `ALL_LOCAL_MATCH True`。

- [ ] **Step 1: 写 6 组变异**

| 组 | 变异 | 期望 |
| --- | --- | --- |
| M1 | `isDesktopDock` 定义改成 `computed(() => true)` | 移动端 DOM 断言 RED |
| M2 | 少替换一处模板（还原成 `!isMobileLayout`） | 源码契约 S2 RED |
| M3 | `MAX_ALLOWED` 抬回 21 | 门禁 V3 方向 RED |
| M4 | 删掉一个 `defineExpose` 项 | 冻结边界 S6 RED |
| M5 | 注释里写 `!isMobileLayout` | 对照绿（门禁计数不变） |
| M6 | 新增一处读取 | 门禁 V3 RED |

- [ ] **Step 2: 执行并逐组核对**

Run: `python3 /tmp/knife3_mutation.py`
Expected: 6/6 符合期望；任一不符先怀疑伪变异。

- [ ] **Step 3: 恢复校验**

逐文件 `sha1("blob %d\0"+data)` 比对 7 个交付路径 ⇒ `ALL_LOCAL_MATCH True`。

---

### Task 5: 推 PR / CI / squash / 合并树核对

**Files:**
- Modify: `docs/ops/2026-11-09-is-mobile-layout-migration-batch1-evidence.md`（回填）

**Interfaces:**
- Consumes: 7 个交付路径裸 blob sha、master 真实 tree。
- Produces: PR、合并 commit。

- [ ] **Step 1: 推前核对**

逐路径与 master 比对：4 个新增路径不在 master；3 个修改路径的 diff 恰为本刀编辑；`MASTER_MOVED_SAFE` 逐路径核 7 路径 blob 在新旧 master 全等，否则重新取回重做。

- [ ] **Step 2: REST 三段推送**

`git/blobs`（502 有限重试）→ `git/trees` 用 `base_tree` 只传 7 路径 → `git/commits` → `git/refs` → PR；PR body 回读 `body_len`。

- [ ] **Step 3: 等 CI 三必需**

逐 job 核 `Build monorepo` / `Verify spec figures` / `Build API Docker image` 全 success。

- [ ] **Step 4: squash 合并 + 合并树全量核对**

按**合并瞬间真实 parent**核对（可能 CI 期间再前移）；差异恰 7 路径、`ALL_LOCAL_MATCH True`、`NO_OTHER True`、`ALL_PARALLEL_KEPT True`。

---

### Task 6: 生产发布复测与状态回填

**Files:**
- Modify: `Issue #755`（只追加）、`.workbuddy/memory/2026-11-09.md`、`.workbuddy/memory/MEMORY.md`

- [ ] **Step 1: 等 deploy 并取证**

Run: `gh api repos/sev7n4/pi-lnk/actions/workflows/deploy.yml/runs?per_page=3` 确认本次 merge sha 的 `Deploy web to CVM` success（API 构建 skipped）。

- [ ] **Step 2: bundle 级下钻 + health**

直连生产，递归下钻懒加载 chunk，确认 `isDesktopDock` 与 7 处替换后的模板表达式已 live；`/api/health` 返回 `{"ok":true}`。SSH 被沙箱拦时用 `curl --noproxy '*'` 直连 bundle。

- [ ] **Step 3: 只追加回填**

Issue #755 追加「逐处搬第一批：21 → 15，7 处模板否定读取语义化，剩余 15 点后续批次」；两份记忆只追加；`append_only True` 校验。

---

## Self-Review

1. **Spec coverage**：§1 三目标 → Task 1/2/3；§4 判据 A–G → Task 1/2/3/6；§6 S1–S7 → Task 1/2/3/4/6；§9 七路径 → Task 1/2/3/5；§10 T1–T5 → Task 1–6；§11 R1–R7 → Review Focus 与 Task 4/5/6；§12 后续 → 规格本体。无缺口。
2. **Placeholder scan**：无 TBD / TODO /「适当处理」；每个代码步骤给出可运行片段或精确命令。
3. **Type consistency**：`isDesktopDock` / `MAX_ALLOWED` / `DESKTOP_ONLY_SELECTORS` 在 Task 1–3 定义并在 Task 4 引用，名称一致；上限 15 全文一致。
4. **Review Focus**：五条均有对应任务测试（Task 1 有效性断言 / `queryAll` / Task 3 双处同步 + M3 / Task 2 精确锚点 + S2 / Task 6 下钻 + `ALL_PARALLEL_KEPT`）。
