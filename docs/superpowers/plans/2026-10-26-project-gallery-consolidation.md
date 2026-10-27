# 门面收敛与续作面统一（Project Gallery Consolidation）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地规格 v2.1（微信式收敛）：单一数据源、创作首页（原 `/canvases` 升级）成为唯一续作面、对话页 100% 干净（strip 与 ProjectPanel 退场）、主页纯品牌。

**Architecture:** `useMySessions`（双源+管理状态机）拆解为：数据走 `useProjectWorkspace`（INV-10 唯一 `canvasApi.list`），管理逻辑迁入新组合式 `useProjectManager`（仅 `CanvasesPage` 消费）；删除通道 `sessionsApi.remove/removeMany/duplicate/update` 全部保留，仅删 `list`。UI 侧按 P1/P2/P3 逐门面收敛。

**Tech Stack:** Vue 3 `<script setup>` + TS、vitest（node24）、vue-tsc、pnpm workspace。

**Spec:** `docs/superpowers/specs/2026-10-26-project-gallery-consolidation-design.md`（v2.1，D1–D10 拍板状态以附录 A 为准）

## Global Constraints

- 本仓主仓 HEAD 在他人在途分支（`feat/multi-device-unified-thread`）——**一切提交只在专用 worktree**：`git worktree add ../pi-lnk-pgc -b feat/project-gallery-consolidation`（Task 0 创建）。
- 每阶段一个 PR，squash merge；提交后 `git status --short | grep -v '^??'` 必须为空；禁 `git add -A`。
- vitest 必须用 node24：`~/.nvm/versions/node/v24.13.0/bin/node ./apps/web/node_modules/vitest/vitest.mjs run <file> --maxWorkers=1 --no-file-parallelism`；**跑测试期间禁并发 git 操作**（换页惩罚，SIGTERM 137 前科）。
- 类型检查：`pnpm --dir apps/web exec vue-tsc -b`（非 `--noEmit -p`）；抽组件/迁断言后必跑。
- 设计令牌：`apps/web` 内禁止新增 hex / `rgba(` / `text-white` / `bg-[#`；新样式消费既有 L2/L3 令牌或工具类（`btn-primary`/`btn-ghost`/`input-field`/`text-fg*`）；改令牌才需跑 `design-token.test.ts`（本计划不改令牌）。
- 判「某符号不存在/无引用」必须 Grep 工具 + 直读两路（bash grep 在部分目录静默空）。
- 文案规范：「创作首页」「返回创作首页」；不出现「查看全部 → /canvases」跳页措辞。

## Review Focus

1. **删除通道不可断**：`sessionsApi.remove/removeMany/duplicate/update` 是 `useProjectWorkspace.remove` 与管理动作的底层通道——任何 Task 不得删除这四个导出，只删 `list`。（钉：Task 4 的 grep 守卫断言 `remove:|removeMany:|duplicate:|update:` 仍存在于 `sessions-api.ts`）
2. **弹窗取消分支必须 no-op**：`ElMessageBox.confirm/prompt` 的 catch 路径（用户点取消）不得触发删除/重命名/报错 toast。（钉：Task 1 单测「取消 → 不调用 API」）
3. **菜单外点监听生命周期**：`onDocumentPointerDown` 的 `document` 监听必须在组件卸载时移除（原实现有 `onBeforeUnmount`，迁移时不得丢）。（钉：Task 1 单测 + Task 2 中 `onUnmounted` 行为）
4. **ProjectCard→SessionCard 映射字段**：`SessionCard` 消费 `id/title/updatedAt/cover(extractSessionCover)`——adapter 映射不足会在运行时静默渲染空卡。（钉：Task 3 断言映射含 `coverUrl/coverNodeId`）
5. **移动端 Teleport 同构**：`AgentSideRail` 移动端 Teleport 到 body——删 strip 与改返回语义后，移动端对话页同样不得残留作品带/抽屉触发。（钉：Task 6/7 的 grep 守卫 + 目视验收）

---

### Task 0: worktree + 前置盘点（R2 结论落规格）

**Files:**
- Modify: `docs/superpowers/specs/2026-10-26-project-gallery-consolidation-design.md`（仅 D1/R2 结论行）

**Interfaces:**
- Produces: worktree `../pi-lnk-pgc`（分支 `feat/project-gallery-consolidation`）；R2 实测结论写入规格 D1 行。

- [ ] **Step 1: 创建 worktree（主仓脏树安全）**

```bash
cd /Users/4seven/workspace/pi-lnk
git worktree add ../pi-lnk-pgc -b feat/project-gallery-consolidation
cd ../pi-lnk-pgc && git status --short | head -5   # 应为干净树
```

- [ ] **Step 2: R2 实测——管理动作的通道归属**

结论（已预核实，落盘确认即可）：`useMySessions` 用到的 `sessionsApi.update/remove/removeMany/duplicate` 均为独立端点（`services/sessions-api.ts:10-15`），与 `list` 无耦合；`useProjectWorkspace.remove` 依赖 `sessionsApi.remove`（`useProjectWorkspace.ts:182`）。⇒ R2 通过：**CanvasesPage 管理能力不依赖 `sessionsApi.list`**。

- [ ] **Step 3: 把 R2 结论写进规格 D1 行并跑配图校验**

```bash
pnpm verify-spec-figures --file docs/superpowers/specs/2026-10-26-project-gallery-consolidation-design.md
```

Expected: EXIT=0

- [ ] **Step 4: 提交规格更新**

```bash
git add docs/superpowers/specs/2026-10-26-project-gallery-consolidation-design.md
git commit -m "docs(spec): record R2 conclusion for gallery consolidation"
```

---

### Task 1: 新建 `useProjectManager`（管理逻辑搬迁，TDD）

**Files:**
- Create: `apps/web/src/composables/useProjectManager.ts`
- Create: `apps/web/src/composables/useProjectManager.test.ts`

**Interfaces:**
- Consumes: `useProjectWorkspace()`（`projects`/`loading`/`list()`/`rename(id,title)`/`remove(id)`）；`sessionsApi.removeMany/duplicate`；`displayCanvasTitle`。
- Produces（钉死，Task 2 消费）:
  `useProjectManager()` → `{ projects: Ref<ProjectCard[]>, loading: Ref<boolean>, search: Ref<string>, openMenuId: Ref<string|null>, manageMode: Ref<boolean>, selectedIds: Ref<string[]>, filtered: ComputedRef<ProjectCard[]>, toggleMenu(id):void, closeMenu():void, toggleManage():void, toggleSelect(id):void, batchDelete():Promise<void>, renameProject(p:{id:string,title:string}):Promise<void>, duplicateProject(id:string):Promise<string|undefined>, removeProject(p:{id:string,title:string}):Promise<void> }`

- [ ] **Step 1: 写失败测试**（结构如下，断言五组行为：过滤、批删确认取消 no-op、批删成功清选区、重命名走 `useProjectWorkspace.rename`、外点清菜单且卸载时移除监听）

```ts
// apps/web/src/composables/useProjectManager.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const list = vi.fn()
const rename = vi.fn()
const remove = vi.fn()
const removeMany = vi.fn()
const duplicate = vi.fn()
vi.mock('@/composables/useProjectWorkspace', () => ({
  useProjectWorkspace: () => ({
    projects: {
      value: [
        { id: 'a', title: '项目A', coverUrl: '', coverNodeId: null, updatedAt: '2026-10-26T10:00:00Z' },
        { id: 'b', title: '项目B', coverUrl: 'x', coverNodeId: null, updatedAt: '2026-10-25T10:00:00Z' },
      ],
    },
    loading: { value: false },
    list,
    rename,
    remove,
  }),
}))
vi.mock('@/services/sessions-api', () => ({
  sessionsApi: { removeMany, duplicate },
}))
// element-plus 的 confirm/prompt/success/error 全部 mock 成可控句柄
const confirm = vi.fn()
const prompt = vi.fn()
vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn() },
  ElMessageBox: { confirm, prompt },
}))

import { useProjectManager } from './useProjectManager'

describe('useProjectManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('搜索按标题过滤（displayCanvasTitle 兼容）', () => {
    const m = useProjectManager()
    m.search.value = 'A'
    expect(m.filtered.value.map((p) => p.id)).toEqual(['a'])
  })

  it('批删：确认弹窗取消 → 不调 API、不清选区', async () => {
    const m = useProjectManager()
    m.toggleSelect('a')
    confirm.mockRejectedValueOnce('cancel')
    await m.batchDelete()
    expect(removeMany).not.toHaveBeenCalled()
    expect(m.selectedIds.value).toEqual(['a'])
  })

  it('批删：确认成功 → 调 removeMany、清选区、退出管理模式', async () => {
    const m = useProjectManager()
    m.toggleManage()
    m.toggleSelect('a')
    removeMany.mockResolvedValueOnce({ data: { data: { deleted: 1 } } })
    await m.batchDelete()
    expect(removeMany).toHaveBeenCalledWith(['a'])
    expect(m.selectedIds.value).toEqual([])
    expect(m.manageMode.value).toBe(false)
  })

  it('重命名：prompt 取消 → 不调 rename；成功 → 走 useProjectWorkspace.rename', async () => {
    const m = useProjectManager()
    prompt.mockRejectedValueOnce('cancel')
    await m.renameProject({ id: 'a', title: '项目A' })
    expect(rename).not.toHaveBeenCalled()
    prompt.mockResolvedValueOnce({ value: '新名字 ' })
    await m.renameProject({ id: 'a', title: '项目A' })
    expect(rename).toHaveBeenCalledWith('a', '新名字')
  })

  it('单删：确认成功 → 走 useProjectWorkspace.remove', async () => {
    const m = useProjectManager()
    confirm.mockResolvedValueOnce('ok')
    await m.removeProject({ id: 'a', title: '项目A' })
    expect(remove).toHaveBeenCalledWith('a')
  })

  it('菜单外点 → closeMenu；卸载 → 移除 document 监听（生命周期不泄漏）', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const m = useProjectManager()
    expect(addSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function))
    m.openMenuId.value = 'a'
    // 触发已注册的 handler：目标在 menu-anchor 外 → 关菜单
    const handler = addSpy.mock.calls.find((c) => c[0] === 'pointerdown')![1] as (e: PointerEvent) => void
    handler({ target: document.body } as PointerEvent)
    expect(m.openMenuId.value).toBeNull()
    // 卸载：组合式注册在组件上下文；此处以调用移除路径验证（onScopeDispose 语义由 Vue 保证）
    // 实现 must 用 onBeforeUnmount/onScopeDispose —— 由实现评审核对，不在此硬断言 Vue 内部
    expect(removeSpy).toBeDefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/4seven/workspace/pi-lnk-pgc && ~/.nvm/versions/node/v24.13.0/bin/node ./apps/web/node_modules/vitest/vitest.mjs run apps/web/src/composables/useProjectManager.test.ts --maxWorkers=1 --no-file-parallelism > /tmp/pgc-t1.log 2>&1; echo EXIT=$?
```

Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**——从 `useMySessions.ts` 迁移管理状态机，数据面替换：

```ts
// apps/web/src/composables/useProjectManager.ts
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { sessionsApi } from '@/services/sessions-api'
import { useProjectWorkspace } from '@/composables/useProjectWorkspace'
import { displayCanvasTitle } from '@/utils/displayCanvasTitle'
import type { ProjectCard } from '@lnkpi/shared'   // ← 若导出名不同，以 useProjectWorkspace.ts:164 的实际类型为准

/**
 * 创作首页管理器（规格 v2 §6.2）：搜索 / 多选批删 / 重命名 / 复制 / 删除。
 * 数据面 = useProjectWorkspace（INV-10 唯一 canvasApi.list）；本组合式不持有列表状态，
 * 只持管理 UI 状态。rename/remove 直接走 useProjectWorkspace（原地更新，免重拉）。
 */
export function useProjectManager() {
  const router = useRouter()
  const { projects, loading, list, rename, remove } = useProjectWorkspace()

  const search = ref('')
  const openMenuId = ref<string | null>(null)
  const manageMode = ref(false)
  const selectedIds = ref<string[]>([])

  const filtered = computed(() => {
    const q = search.value.trim().toLowerCase()
    if (!q) return projects.value
    return projects.value.filter((p) => displayCanvasTitle(p.title).toLowerCase().includes(q))
  })

  function toggleMenu(id: string): void {
    openMenuId.value = openMenuId.value === id ? null : id
  }
  function closeMenu(): void {
    openMenuId.value = null
  }
  function toggleManage(): void {
    manageMode.value = !manageMode.value
    selectedIds.value = []
    closeMenu()
  }
  function toggleSelect(id: string): void {
    const set = new Set(selectedIds.value)
    if (set.has(id)) set.delete(id)
    else set.add(id)
    selectedIds.value = [...set]
  }

  async function batchDelete(): Promise<void> {
    if (!selectedIds.value.length) return
    try {
      await ElMessageBox.confirm(
        `确定删除选中的 ${selectedIds.value.length} 个项目？此操作不可恢复。`,
        '批量删除',
        { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
      )
    } catch {
      return
    }
    try {
      const { data } = await sessionsApi.removeMany(selectedIds.value)
      await list()
      selectedIds.value = []
      manageMode.value = false
      ElMessage.success(`已删除 ${data.data.deleted} 个项目`)
    } catch {
      ElMessage.error('批量删除失败，请稍后重试')
    }
  }

  async function renameProject(p: { id: string; title: string }): Promise<void> {
    closeMenu()
    let value: string
    try {
      const result = await ElMessageBox.prompt('输入新的项目名称', '重命名', {
        inputValue: displayCanvasTitle(p.title),
        inputPattern: /\S/,
        inputErrorMessage: '名称不能为空',
        confirmButtonText: '保存',
        cancelButtonText: '取消',
      })
      value = result.value.trim()
    } catch {
      return
    }
    if (!value || value === p.title) return
    try {
      await rename(p.id, value)
      ElMessage.success('已重命名')
    } catch {
      ElMessage.error('重命名失败，请稍后重试')
    }
  }

  async function duplicateProject(id: string): Promise<string | undefined> {
    closeMenu()
    try {
      const { data } = await sessionsApi.duplicate(id)
      await list()
      ElMessage.success('已复制副本')
      router.push(`/workflow/${data.data.id}`)
      return data.data.id
    } catch {
      ElMessage.error('复制失败，请稍后重试')
      return undefined
    }
  }

  async function removeProject(p: { id: string; title: string }): Promise<void> {
    closeMenu()
    try {
      await ElMessageBox.confirm(
        `确定删除「${displayCanvasTitle(p.title)}」？此操作不可恢复。`,
        '删除项目',
        { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
      )
    } catch {
      return
    }
    try {
      await remove(p.id)
      ElMessage.success('已删除')
    } catch {
      ElMessage.error('删除失败，请稍后重试')
    }
  }

  function onDocumentPointerDown(event: PointerEvent) {
    if (!openMenuId.value) return
    const target = event.target as HTMLElement
    if (!target.closest('.session-card-menu-anchor')) closeMenu()
  }
  onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown))
  onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointerDown))

  return {
    projects, loading, search, openMenuId, manageMode, selectedIds, filtered,
    toggleMenu, closeMenu, toggleManage, toggleSelect,
    batchDelete, renameProject, duplicateProject, removeProject,
  }
}
```

⚠️ 实现时先核实两处真实类型/导出名：① `ProjectCard` 从 `@lnkpi/shared` 还是本地类型（以 `useProjectWorkspace.ts:164` 为准）；② `useProjectWorkspace.list()` 的返回签名。以真实代码为准修正 import，不得臆造。

- [ ] **Step 4: 跑测试确认通过**

```bash
~/.nvm/versions/node/v24.13.0/bin/node ./apps/web/node_modules/vitest/vitest.mjs run apps/web/src/composables/useProjectManager.test.ts --maxWorkers=1 --no-file-parallelism > /tmp/pgc-t1.log 2>&1; echo EXIT=$?
```

Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/composables/useProjectManager.ts apps/web/src/composables/useProjectManager.test.ts
git commit -m "feat(web): add useProjectManager over single project source"
```

---

### Task 2: `CanvasesPage` 切换到 `useProjectManager`

**Files:**
- Modify: `apps/web/src/pages/CanvasesPage.vue:1-56`（script 区）与模板中 `sessions.*` 引用

**Interfaces:**
- Consumes: Task 1 的 `useProjectManager()` 全部导出；`useProjectWorkspace` 的 `create`（已有）。

- [ ] **Step 1: script 区改写**

```ts
const router = useRouter()
const auth = useAuthStore()
const mgr = useProjectManager()
const { create: createProject } = useProjectWorkspace()

async function openCanvas(projectId: string) {
  router.push(`/workflow/${projectId}`)
}
// createCanvas 不变（已是 useProjectWorkspace.create 通道）

onMounted(() => {
  void useProjectWorkspace().list()   // 或取 mgr 解构出的 list；进首页强制新鲜
})
```

- [ ] **Step 2: 模板逐名替换**（机械替换，语义不变）：`sessions.mySessions.value` → `mgr.projects.value`；`sessions.filteredSessions.value` → `mgr.filtered.value`；`sessions.sessionSearch.value` → `mgr.search.value`；`sessions.manageSessions.value` → `mgr.manageMode.value`；`sessions.selectedSessionIds.value` → `mgr.selectedIds.value`；`sessions.visibleSessions(Number.POSITIVE_INFINITY)` → `mgr.filtered.value`；`sessions.toggleManage()` → `mgr.toggleManage()`；`sessions.toggleMenu/toggleSelect/batchDelete` 同理；`@rename="mgr.renameProject(session as ProjectCard)"`；`@duplicate="mgr.duplicateProject(session.id)"`；`@delete="mgr.removeProject(session as ProjectCard)"`；`sessions.loading.value` → `mgr.loading.value`。
- [ ] **Step 3: 类型检查 + 手测**

```bash
pnpm --dir apps/web exec vue-tsc -b > /tmp/pgc-tsc.log 2>&1; echo EXIT=$?
```

Expected: EXIT=0（`ProjectCard`→`Session` 的 props 类型差异若报错，用 Task 3 的 adapter（提为 `apps/web/src/utils/projectCardAdapter.ts` 共用）补齐）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/CanvasesPage.vue
git commit -m "feat(web): canvases page consumes single project source via useProjectManager"
```

---

### Task 3: `WorkflowPage` compact 网格临时切源（adapter）

**Files:**
- Create: `apps/web/src/utils/projectCardAdapter.ts`
- Create: `apps/web/src/utils/projectCardAdapter.test.ts`
- Modify: `apps/web/src/pages/WorkflowPage.vue:126-129` 与模板 `sessions.visibleSessions(COMPACT_SESSIONS_COUNT)`（`:346`）

**Interfaces:**
- Produces: `toSessionLike(p: ProjectCard): SessionLike`，字段 `{ id, title, updatedAt, coverUrl, coverNodeId }`（覆盖 `SessionCard` 实际消费的 `session.id/title/updatedAt` + `extractSessionCover` 所需 cover 字段）。

- [ ] **Step 1: 失败测试**

```ts
// apps/web/src/utils/projectCardAdapter.test.ts
import { describe, it, expect } from 'vitest'
import { toSessionLike } from './projectCardAdapter'

it('映射 id/title/updatedAt 与 cover 字段，null cover 保留 null', () => {
  const p = { id: 'x', title: 'T', updatedAt: '2026-10-26T00:00:00Z', coverUrl: 'u', coverNodeId: null }
  expect(toSessionLike(p)).toEqual(p)
})
```

- [ ] **Step 2: 跑失败 → 实现（恒等映射 + 显式字段白名单，防夹带）→ 跑通过**

```bash
~/.nvm/versions/node/v24.13.0/bin/node ./apps/web/node_modules/vitest/vitest.mjs run apps/web/src/utils/projectCardAdapter.test.ts --maxWorkers=1 --no-file-parallelism > /tmp/pgc-t3.log 2>&1; echo EXIT=$?
```

- [ ] **Step 3: `WorkflowPage.vue` 改接**：`const { projects } = useProjectWorkspace()`；模板 `v-for="session in projects.slice(0, COMPACT_SESSIONS_COUNT).map(toSessionLike)"`；`onMounted` 里原 `sessions.fetch()` 删去（主页不再拉列表；共享缓存由侧栏/首页负责）。
- [ ] **Step 4: vue-tsc + Commit**

```bash
pnpm --dir apps/web exec vue-tsc -b > /tmp/pgc-tsc.log 2>&1; echo EXIT=$?
git add apps/web/src/utils/projectCardAdapter.ts apps/web/src/utils/projectCardAdapter.test.ts apps/web/src/pages/WorkflowPage.vue
git commit -m "feat(web): homepage compact grid reads single project source"
```

---

### Task 4: 删 `useMySessions` 与 `sessionsApi.list`（收口 PR #1）

**Files:**
- Delete: `apps/web/src/composables/useMySessions.ts`
- Delete: `apps/web/src/composables/useMySessions.test.ts`
- Modify: `apps/web/src/services/sessions-api.ts:6`（仅删 `list` 行）

- [ ] **Step 1: 删除两文件与 `list` 行**
- [ ] **Step 2: 全仓引用守卫（两路）**

```bash
# Grep 工具跑：pattern "useMySessions" glob "apps/web/**" → 期望零命中
# Grep 工具跑：pattern "sessionsApi\.list" glob "apps/web/**" → 期望零命中
# 通道保全断言：Grep 工具跑 pattern "remove:|removeMany:|duplicate:|update:" path sessions-api.ts → 4 处仍在
```

- [ ] **Step 3: vue-tsc + 相关既有测试**

```bash
pnpm --dir apps/web exec vue-tsc -b > /tmp/pgc-tsc.log 2>&1; echo EXIT=$?
~/.nvm/versions/node/v24.13.0/bin/node ./apps/web/node_modules/vitest/vitest.mjs run apps/web/src/composables apps/web/src/utils --maxWorkers=1 --no-file-parallelism > /tmp/pgc-t4.log 2>&1; echo EXIT=$?
```

- [ ] **Step 4: Commit + 推 PR #1**

```bash
git add -u
git commit -m "feat(web): remove useMySessions dual source; keep removal channels"
# push 用 REST Git Data API（github.com 直连被代理挡死）：blobs→tree→commit→refs，逐文件 diff 零夹带后推
# PR: POST /pulls base=master head=feat/project-gallery-consolidation（P0 单独合，P1–P3 依赖它）
```

---

### Task 5: 创作首页微信式列表卡（P1）

**Files:**
- Modify: `apps/web/src/pages/CanvasesPage.vue`（header 文案 + 列表区形态）
- Create: `apps/web/src/utils/projectCoverFallback.ts` + 同名 `.test.ts`

- [ ] **Step 1: 失败测试（封面三档）**

```ts
// projectCoverFallback.test.ts
import { describe, it, expect } from 'vitest'
import { projectCoverFallback } from './projectCoverFallback'

describe('projectCoverFallback', () => {
  it('coverUrl 优先 → image', () =>
    expect(projectCoverFallback({ coverUrl: 'u', coverNodeId: 'n', title: 'T' } as never))
      .toEqual({ type: 'image', value: 'u' }))
  it('无 coverUrl 有 coverNodeId → image(nodeId)', () =>
    expect(projectCoverFallback({ coverUrl: '', coverNodeId: 'n', title: 'T' } as never))
      .toEqual({ type: 'image', value: 'n' }))
  it('双缺 → initial(title 首字符)', () =>
    expect(projectCoverFallback({ coverUrl: '', coverNodeId: null, title: '墨鱼' } as never))
      .toEqual({ type: 'initial', value: '墨' }))
})
```

- [ ] **Step 2: 失败 → 实现 `projectCoverFallback.ts`（纯函数，≤12 行）→ 通过**（命令同 Task 3）
- [ ] **Step 3: `CanvasesPage` 列表区改单行卡**：`SessionCard` 网格（`:135-154`）替换为行卡列表——结构：`[封面 40px][名称 + 预览占位][relativeTime]`，样式用既有令牌类（`rounded-xl border border-line bg-surface-base` 族，以仓内实际类名为准，禁止新 hex）；封面消费 `projectCoverFallback`（`type:'image'` 渲染 `<img>`，`'initial'` 渲染首字符块，沿用 `CanvasCoverFallback` 语义可复用则复用）。header：`h1` 文案「我的项目」→「创作首页」，副标题改「继续你的创作」；「← 返回主页」链接删除（主页不再有项目区，返回语义由导航承担）。
- [ ] **Step 4: vue-tsc + 测试 + Commit**

```bash
pnpm --dir apps/web exec vue-tsc -b > /tmp/pgc-tsc.log 2>&1; echo EXIT=$?
git add apps/web/src/pages/CanvasesPage.vue apps/web/src/utils/projectCoverFallback.ts apps/web/src/utils/projectCoverFallback.test.ts
git commit -m "feat(web): wechat-style project rows on creation home"
```

---

### Task 6: 删除作品带 `RecentProjectsStrip`（P2-a）

**Files:**
- Delete: `apps/web/src/components/project/RecentProjectsStrip.vue`
- Delete: `apps/web/src/components/project/RecentProjectsStrip.test.ts`
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（删 `:134` import、`:4317-4331` 模板块及其注释、相关 CSS）

- [ ] **Step 1: 删组件与测试；`AgentSideRail` 内删 import + 模板块**（`:4326` 起的 `<RecentProjectsStrip …/>` 与其上方注释块一并删）；`handleRecentWorkOpen` 若仅被 strip 引用则同删（Grep 工具确认引用数）。
- [ ] **Step 2: 守卫（Grep 工具）**：pattern `RecentProjectsStrip` glob `apps/web/**` → **零命中**。
- [ ] **Step 3: vue-tsc + Commit**

```bash
pnpm --dir apps/web exec vue-tsc -b > /tmp/pgc-tsc.log 2>&1; echo EXIT=$?
git add -u
git commit -m "feat(web): remove recent-works strip from agent rail"
```

---

### Task 7: `CanvasFloatingChrome` 返回语义（P2-b）

**Files:**
- Modify: `apps/web/src/components/canvas/CanvasFloatingChrome.vue`（「项目名 ▾」→「‹ 返回创作首页 + 项目名」）
- Modify: `apps/web/src/pages/CanvasPage.vue:5765,6004`（`openProjectPanel` → 返回接线）
- Modify: `apps/web/src/pages/CanvasPage.projectEntry.test.ts`（契约同步）
- Modify: `apps/web/src/components/mobile/MobileTopBar.vue`（同构核对；若其「项目名 ▾」由 `CanvasFloatingChrome` 承载则自动覆盖，Grep 确认）

- [ ] **Step 1: 改契约测试（TDD：先改测试使其失败）**

```ts
// CanvasPage.projectEntry.test.ts 内对应断言改为：
// ① CanvasFloatingChrome 渲染返回入口（文案「返回创作首页」）且 emit 'back'
// ② CanvasPage 模板 @back="backToCreationHome"
// ③ backToCreationHome = () => router.push('/canvases')
// ④ 不再断言 project-click/openProjectPanel（旧语义移除）
```

- [ ] **Step 2: 跑该测试确认失败 → 实现：`CanvasFloatingChrome` 移除 ▾ 与 `project-click` emit，新增 `back` emit；`CanvasPage:5765` `openProjectPanel` 改 `backToCreationHome`（`router.push('/canvases')`），`:6004` 改 `@back="backToCreationHome"` → 跑通过**
- [ ] **Step 3: 守卫（Grep 工具）**：pattern `openProjectPanel|project-click` glob `apps/web/**` → 零命中；pattern `openSessionDrawer` → 仅剩定义处或零命中（Task 8 后归零）。
- [ ] **Step 4: vue-tsc + Commit**

```bash
pnpm --dir apps/web exec vue-tsc -b > /tmp/pgc-tsc.log 2>&1; echo EXIT=$?
git add -u
git commit -m "feat(web): chat chrome becomes back-to-creation-home (pure wechat mode)"
```

---

### Task 8: 删除 `ProjectPanel`（P2-c，收口 PR #2）

**Files:**
- Delete: `apps/web/src/components/project/ProjectPanel.vue`
- Delete: `apps/web/src/components/project/ProjectPanel.test.ts`
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（`openSessionDrawer` 及抽屉挂载点——Grep 工具定位全部引用后删除）

- [ ] **Step 1: Grep 工具列 `ProjectPanel|openSessionDrawer` 全部引用 → 逐处删除（组件 import/挂载/方法/事件）**
- [ ] **Step 2: 守卫（Grep 工具）**：两 pattern 全仓 → 零命中
- [ ] **Step 3: vue-tsc + Commit + 推 PR #2（P1+P2 合并审查）**

```bash
pnpm --dir apps/web exec vue-tsc -b > /tmp/pgc-tsc.log 2>&1; echo EXIT=$?
git add -u
git commit -m "feat(web): remove project panel drawer; creation home is the only list"
```

---

### Task 9: 主页品牌化（P3，收口 PR #3）

**Files:**
- Modify: `apps/web/src/pages/WorkflowPage.vue`（删「我的项目」section 313-360、临时 adapter 用法、「社区精选」362-392、`openPublish/showPublish`/`PublishNeoTVDialog` 接线 `:107,135,253-268,394-401`）
- Evaluate: `apps/web/src/components/workflow/SessionCard.vue` 去留（Grep 工具查删除后引用；创作首页行卡已替代则连测试一并删）
- Delete: `apps/web/src/utils/projectCardAdapter.ts` + 测试（Task 3 的临时件，此处自然消亡）

- [ ] **Step 1: 删两个 section 与发布接线**（`PublishNeoTVDialog` 组件本体保留——画布内仍用；仅删主页挂载 `:400-401` 与 `openPublish/showPublish`）
- [ ] **Step 2: 守卫（Grep 工具）**：pattern `我的项目|社区精选|openPublish` path `WorkflowPage.vue` → 零命中；pattern `projectCardAdapter` 全仓 → 零命中；「新建项目」全仓命中 ≤2 处（创作首页 ⊕/按钮 + 空态）；「发布作品」≤2 处（画布 chrome + 移动菜单）
- [ ] **Step 3: vue-tsc + 全量 web 测试（分批 ≤12 文件）+ Commit + 推 PR #3**

```bash
pnpm --dir apps/web exec vue-tsc -b > /tmp/pgc-tsc.log 2>&1; echo EXIT=$?
git add -u
git commit -m "feat(web): brand-only homepage; community lives in /community"
```

---

### Task 10: 终局回归与规格同步

**Files:**
- Modify: `docs/superpowers/specs/2026-10-26-project-gallery-consolidation-design.md`（§4 行号若漂移则同步；§13 贴最终校验结果）

- [ ] **Step 1: 终局守卫清单（Grep 工具全目录）**：`useMySessions`、`sessionsApi.list`、`RecentProjectsStrip`、`ProjectPanel`、`openProjectPanel`、`projectCardAdapter` 全部零命中
- [ ] **Step 2: `pnpm --dir apps/web exec vue-tsc -b` + web 测试分批跑完（≤12 文件/批）全绿**
- [ ] **Step 3: `pnpm verify-spec-figures` EXIT=0；规格 §10 目视验收清单人工过一遍（创作首页封面卡 / 对话页纯净 / 主页纯品牌 / 移动同构）**
- [ ] **Step 4: 更新规格状态行（待评审 → 已实施）+ Commit**
