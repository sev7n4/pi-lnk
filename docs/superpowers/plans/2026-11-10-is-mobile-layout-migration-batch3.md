# `isMobileLayout` 逐处搬第三批（D 类第一批）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `AgentSideRail.vue` 脚本函数 `closePanel` 内唯一一处 `if (isMobileLayout.value) return` 改为 `if (!isDesktopDock.value) return`（复用第一批派生、不新增 computed、不新增读取点），门禁上限 12 → 11，用真实 mount 两端 DOM 形态 + closePanel 行为断言证明零行为变更。

**Architecture:** 只在 Shell SFC 的一个函数体内改 1 个 `if` 条件；`isDesktopDock` 的定义、`useAgentMobileLayout()` 唯一来源、其余 11 处读取全部不动。门禁脚本只改常量与其 V3 方向判据字面量。不新增 required check、不改 CI 挂载行。

**Tech Stack:** Vue 3 `<script setup>` + `computed`、Vitest + `@vue/test-utils` + Pinia + vue-router memory history、Python 3 标准库门禁、`gh api` Git Data API、`deploy.yml` web-only 发布。

**Spec:** `docs/superpowers/specs/2026-11-10-is-mobile-layout-migration-batch3-design.md`

> 用户已指定执行方式为 **Native**（前几刀沿用，本刀不变）。

## Global Constraints

- 真值基线：`gh api` true master `ecf4ee0dd1aa36cec6db79bbad6a630de1ce622f`（2026-11-10 复核：相对 #807 的 `203e8277` 仅因 PR #802 纯文档合入前移，SFC 与门禁脚本 blob 不变）；推送前重新核对 + `MASTER_MOVED_SAFE`。
- `AgentSideRail.vue` 必须从 `gh api` true master 取回后编辑，逐文件核裸 blob sha（`sha1("blob %d\0" + data)`）；禁止采信本地脏工作树。
- 冻结边界：`sendMessage` / `handleEvent` / `canvas_command` / `defineExpose` 11 项 / `getIsMobileLayout` 零改写。
- 门禁 `MAX_ALLOWED` 只降不升：12 → **11**；V3 方向判据 `^MAX_ALLOWED = 11$` 必须与常量双处同步（先改正则行、再改常量行，避免子串双命中）。
- 新写 Vue 注释禁止出现 `isMobileLayout` 字面量（会污染 `strip_comments` 后的计数）；既有 L1012 中文注释不含该字面量，保留不改。
- `git/trees` POST 必须用 `base_tree` 只传改动路径；PR / Issue 正文必须回读 `body|length`。
- CI 三必需：`Verify spec figures` / `Build monorepo` / `Build API Docker image` 全 success 才可 squash。
- `pnpm -r build` 编译 `*.test.ts` ⇒ 断言禁 `as never`；本机 pnpm 加 `env -u NODE_OPTIONS`。
- `deploy.yml` `push.paths` 含 `apps/web/**` ⇒ 本刀触发一次 web-only 生产发布，必须 bundle 五证复测 + `/api/health`。
- 历史时点结论不追溯改写，只做只追加状态回填；不宣告未闭环项 `ALL_PASS`。

## Review Focus

1. **`closePanel` 漏了取反**（写成 `isDesktopDock`）⇒ 移动/桌面语义反转：由 Task 1 的 ⑤ 用例（移动不 emit / 桌面 emit `expandedChange=false`）与 Task 4 的 M1 变异钉死。
2. **`closePanel` 改写波及冻结边界**（误改 `defineExpose` 项或 `getIsMobileLayout`）：由 Task 1 的 ④ 用例与 Task 4 的 M4 变异钉死。
3. **`MAX_ALLOWED` 与方向判据不同步**：常量改 11 而正则仍 12 会假红，两者同改但实现层判据被删会恒绿；由 Task 3 的 `--json` 输出与 Task 4 的 M3 变异钉死（先正则后常量，防子串双命中）。
4. **`isDesktopDock` 局部 const 被 esbuild mangle** ⇒ 生产 chunk 字面量为 0：不得据此判「未部署」，由 Task 6 的五证（chunk hash / setup 派生结构 / 渲染条件 / DOM 锚点 / health）钉死。
5. **并行窗口再次前移 master**：推前 `MASTER_MOVED_SAFE` 逐路径核对，前移则重建镜像重做，由 Task 5 的推前检查与合并树真实 parent 核对钉死。

---

### Task 1: 取回 true master 源码并写行为级 RED 测试

**Files:**
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（从 master 取回，内容不变）
- Modify: `scripts/verify-is-mobile-layout-scope.py`（从 master 取回，内容不变）
- Fetch: `apps/web/src/components/agent/AgentSideRail.mobileDockDerived.test.ts`（从 master 取回，供回归）
- Create: `apps/web/src/components/agent/AgentSideRail.closePanelDock.test.ts`

**Interfaces:**
- Consumes: `gh api` Git Data API 的 `git/trees/{ref}?recursive=1` 与 `git/blobs/{sha}`；既有 `AgentSideRail.mobileDockDerived.test.ts` 的 `mountRail()` 范式。
- Produces: `AgentSideRail.closePanelDock.test.ts` 的 5 个用例（① PC 形态 / ② 移动形态 / ③ 源码契约 / ④ 冻结边界 / ⑤ closePanel 行为），供 Task 2 验证 RED→PASS。

- [ ] **Step 1: 从 true master 取回四个目标文件并校验裸 blob sha**

```bash
cd /Users/4seven/workspace/pi-lnk && python3 - <<'PY'
import base64, hashlib, json, pathlib, subprocess
REPO='sev7n4/pi-lnk'; ROOT=pathlib.Path('.')
def gh(a):
    r=subprocess.run(['gh','api']+a,capture_output=True,text=True)
    assert r.returncode==0, r.stderr[:300]
    return r.stdout.strip()
def naked(d): return hashlib.sha1(b'blob '+str(len(d)).encode()+b'\0'+d).hexdigest()
head=gh([f'repos/{REPO}/branches/master','--jq','.commit.sha'])
tree=dict(l.split('\t') for l in gh([f'repos/{REPO}/git/trees/{head}?recursive=1',
    '--jq','.tree[]|select(.type=="blob")|.path+"\t"+.sha']).split('\n') if l)
for p in ['apps/web/src/components/agent/AgentSideRail.vue',
          'scripts/verify-is-mobile-layout-scope.py',
          'apps/web/src/components/agent/AgentSideRail.mobileDockDerived.test.ts']:
    d=base64.b64decode(json.loads(gh([f'repos/{REPO}/git/blobs/{tree[p]}']))['content'])
    assert naked(d)==tree[p]
    (ROOT/p).write_bytes(d)
    print('RESTORED', p, tree[p][:12])
PY
```

- [ ] **Step 2: 写 5 个行为级用例（新建 `AgentSideRail.closePanelDock.test.ts`）**

测试文件沿用第二批的四个 `vi.mock`（sessions-api / api-base / provider-api / mermaid）、`ResizeObserverStub`、`matchMedia` stub、`fetch` stub、`document.body` 查询与 `EXPOSE_KEYS`。③ 是 RED 判据，⑤ 是行为级零变更锚：

```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import AgentSideRail from './AgentSideRail.vue'

vi.mock('@/services/sessions-api', () => ({
  sessionsApi: { list: vi.fn().mockResolvedValue([]), get: vi.fn().mockResolvedValue({ messages: [] }) },
}))
vi.mock('@/services/api-base', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/api-base')>()),
  apiUrl: (p: string) => p,
}))
vi.mock('@/services/provider-api', () => ({
  providerApi: { bootstrap: vi.fn().mockResolvedValue({ platformChannel: null, channels: [], preferences: null, webdav: null }) },
}))
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: '' }) } }))

const DESKTOP_ONLY_SELECTORS = ['.agent-resize-handle', '.agent-subtitle', '[title="收起助手"]'] as const
const EXPOSE_KEYS = ['newAgentSession','openThreadHistory','closeThreadHistory','openPanel','closePanel','setComposerInput','addAttachment','reconcileFromNodes','confirmProposeWait','cancelProposeForNode','addFromCanvasNodes'] as const

function queryAll(sel: string): Element[] {
  return Array.from(document.body.querySelectorAll(sel))
}
async function mountRail(matches: boolean) {
  class ResizeObserverStub { observe(){} unobserve(){} disconnect(){} }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('matchMedia', (query: string) => ({ matches, media: query, addEventListener: () => {}, removeEventListener: () => {} }))
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })))
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] })
  await router.push('/'); await router.isReady()
  const w = mount(AgentSideRail, { attachTo: document.body, global: { plugins: [router] }, props: { sessionId: 's1' } })
  await flushPromises()
  return w
}
async function openHistory(w: any) { await (w.vm as any).openThreadHistory().catch(() => {}); await flushPromises() }
function railSource(): string { return readFileSync(resolve(__dirname, 'AgentSideRail.vue'), 'utf8') }
function stripVueComments(src: string): string {
  return src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('路线 ③ 第三批（D 类第一批）：closePanel 改用 !isDesktopDock', () => {
  beforeEach(() => { setActivePinia(createPinia()); document.body.innerHTML = '' })
  afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

  it('① PC 端（matchMedia=false）：桌面形态在位，移动 dock 与移动历史抽屉均不出现', async () => {
    const w = await mountRail(false)
    expect(DESKTOP_ONLY_SELECTORS.map((s) => queryAll(s).length), 'PC 端三项必须各 1').toEqual([1, 1, 1])
    expect(queryAll('.agent-panel-mobile-dock').length).toBe(0)
    await openHistory(w)
    expect(queryAll('.thread-history-layer').length).toBe(0)
    w.unmount()
  })

  it('② 移动端（matchMedia=true）：移动 dock 形态与移动历史抽屉均在位，桌面锚点全隐', async () => {
    const w = await mountRail(true)
    expect(DESKTOP_ONLY_SELECTORS.map((s) => queryAll(s).length), '移动端三项必须各 0').toEqual([0, 0, 0])
    expect(queryAll('.agent-panel-mobile-dock').length).toBe(1)
    await openHistory(w)
    expect(queryAll('.thread-history-layer').length).toBe(1)
    w.unmount()
  })

  it('③ 源码契约：closePanel 改用 !isDesktopDock，派生定义仍是纯否定，SFC 读取点恰 11', () => {
    const src = railSource()
    expect(src).toMatch(/const isDesktopDock = computed\(\(\) => !isMobileLayout\.value\)/)
    const m = src.match(/function closePanel\(\)\s*\{[\s\S]*?\n\}/)
    expect(m, 'closePanel 必须存在').toBeTruthy()
    const body = m![0]
    expect(body, 'closePanel 不得直接读 isMobileLayout').not.toMatch(/\bisMobileLayout\b/)
    expect(body, 'closePanel 必须走 !isDesktopDock 派生').toMatch(/if\s*\(\s*!isDesktopDock\.value\s*\)\s*return/)
    const stripped = stripVueComments(src)
    expect((stripped.match(/\bisMobileLayout\b/g) ?? []).length, 'SFC isMobileLayout 读取点必须恰好 11').toBe(11)
    expect((src.match(/\bisDesktopDock\b/g) ?? []).length, 'isDesktopDock 总消费须 14（13 + closePanel 1）').toBeGreaterThanOrEqual(14)
  })

  it('④ 冻结边界：defineExpose 11 项与 getIsMobileLayout 契约零改写', () => {
    const src = railSource()
    const start = src.indexOf('defineExpose({')
    const end = src.indexOf('</script>', start)
    const expose = src.slice(start, end)
    for (const key of EXPOSE_KEYS) expect(expose, `defineExpose 缺项 ${key}`).toMatch(new RegExp(`\\b${key}\\b`))
    expect(src).toMatch(/getIsMobileLayout:\s*\(\)\s*=>\s*isMobileLayout\.value/)
    expect(src).toContain('sendMessage'); expect(src).toContain('handleEvent'); expect(src).toContain('canvas_command')
  })

  it('⑤ closePanel 行为：移动端早返回（不 emit expandedChange=false），桌面端关闭（emit expandedChange=false）', async () => {
    const m = await mountRail(true)
    ;(m.vm as any).closePanel(); await flushPromises()
    expect((m.emitted('expandedChange') ?? []).some((a: any) => a[0] === false), '移动端 closePanel 不得 emit 关闭').toBe(false)
    m.unmount()
    const d = await mountRail(false)
    ;(d.vm as any).closePanel(); await flushPromises()
    expect((d.emitted('expandedChange') ?? []).some((a: any) => a[0] === false), '桌面端 closePanel 必须 emit 关闭').toBe(true)
    d.unmount()
  })
})
```

- [ ] **Step 3: 跑出精确 RED**

```bash
cd apps/web && env -u NODE_OPTIONS ./node_modules/.bin/vitest run \
  src/components/agent/AgentSideRail.closePanelDock.test.ts \
  --config vitest.config.ts --maxWorkers=1 --no-file-parallelism
```

Expected: `Tests 1 failed | 4 passed (5)`，且失败点唯一为 ③ 的「closePanel 不得直接读 isMobileLayout」/「SFC 读取点必须恰好 11」/「isDesktopDock 总消费须 14」。若 ①②④⑤ 也失败，先修测试环境（不是产品代码）。

### Task 2: 实现 closePanel 单处替换

**Files:**
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`

**Interfaces:**
- Consumes: Task 1 的 5 个用例；第一批已存在的 `isDesktopDock` computed。
- Produces: `closePanel` 内 `isMobileLayout` 零出现、`!isDesktopDock` 恰 1 处，供 Task 3 精算 11 点。

- [ ] **Step 1: 只在 closePanel 函数体内做一处精确替换**

```python
import pathlib
p = pathlib.Path('apps/web/src/components/agent/AgentSideRail.vue')
s = p.read_text()
old = '  if (isMobileLayout.value) return\n'
new = '  if (!isDesktopDock.value) return\n'
assert s.count(old) == 1, f'closePanel anchor count != 1: {s.count(old)}'
s = s.replace(old, new)
# 仅 closePanel 函数体不得再出现 isMobileLayout
i = s.index('function closePanel()')
j = s.index('\n}', i)
assert 'isMobileLayout' not in s[i:j], 'closePanel 函数体仍残留 isMobileLayout'
assert s.count('!isDesktopDock') == s.count('!isDesktopDock')  # 语法守卫
p.write_text(s)
```

- [ ] **Step 2: 跑行为级 PASS**

```bash
cd apps/web && env -u NODE_OPTIONS ./node_modules/.bin/vitest run \
  src/components/agent/AgentSideRail.closePanelDock.test.ts \
  --config vitest.config.ts --maxWorkers=1 --no-file-parallelism
```

Expected: `Tests 5 passed (5)`。

- [ ] **Step 3: 跑第二批契约与相关回归集**

```bash
cd apps/web && env -u NODE_OPTIONS ./node_modules/.bin/vitest run \
  src/components/agent/AgentSideRail.mobileDockDerived.test.ts \
  src/components/agent/AgentSideRail.desktopDockDerived.test.ts \
  src/components/agent/AgentSideRail.dockLayout.test.ts \
  src/components/agent/AgentSideRail.mobileLivePin.test.ts \
  src/components/agent/AgentSideRail.canvasRefEntry.test.ts \
  src/components/agent/AgentSideRail.defineExpose.test.ts \
  src/components/agent/AgentSideRail.mobileMaskTabbar.test.ts \
  src/components/agent/AgentSideRail.askInline.test.ts \
  src/components/agent/AgentSideRail.closePanelDock.test.ts \
  --config vitest.config.ts --maxWorkers=1 --no-file-parallelism
```

Expected: 9 文件全 PASS。

### Task 3: 收紧门禁上限 12 → 11

**Files:**
- Modify: `scripts/verify-is-mobile-layout-scope.py`

**Interfaces:**
- Consumes: Task 2 的 closePanel 改写；`count_hits()` / `strip_comments()` 既有实现。
- Produces: `MAX_ALLOWED = 11` 与 V3 方向判据 `^MAX_ALLOWED = 11$`，供 Task 4 的 M3 变异与 Task 5 的 CI 自举。

- [ ] **Step 1: 双处同步替换（先正则行、后常量行，防子串双命中）**

```python
import pathlib
p = pathlib.Path('scripts/verify-is-mobile-layout-scope.py')
s = p.read_text()
# 先改 V3 方向判据的正则行（唯一全串锚点，含 = 11$）
assert s.count("re.search(r'^MAX_ALLOWED = 12$', impl, re.M)") == 1
s = s.replace("re.search(r'^MAX_ALLOWED = 12$', impl, re.M)",
              "re.search(r'^MAX_ALLOWED = 11$', impl, re.M)")
# 再改常量行（此时正则行已不含 12，常量行独立唯一）
assert s.count('MAX_ALLOWED = 12') == 1
s = s.replace('MAX_ALLOWED = 12', 'MAX_ALLOWED = 11')
assert 'MAX_ALLOWED = 12' not in s
assert s.count("re.search(r'^MAX_ALLOWED = 11$', impl, re.M)") == 1
p.write_text(s)
```

- [ ] **Step 2: 跑门禁确认计数恰为 11**

```bash
python3 scripts/verify-is-mobile-layout-scope.py
python3 scripts/verify-is-mobile-layout-scope.py --json
python3 scripts/verify-phase4-delete-scope.py
python3 scripts/verify-pc-canvas-legacy-scope.py
```

Expected: 四条全部 `VERDICT ALL_PASS`，第一条 V3 详情为 `Shell 读取点 11 <= 11，方向判据在位`。

- [ ] **Step 3: 编译与全量门禁**

```bash
cd apps/web && env -u NODE_OPTIONS ./node_modules/.bin/vue-tsc -b
cd /Users/4seven/workspace/pi-lnk && env -u NODE_OPTIONS pnpm verify-agent-rail-gates
env -u NODE_OPTIONS pnpm verify-spec-figures --file docs/superpowers/specs/2026-11-10-is-mobile-layout-migration-batch3-design.md
env -u NODE_OPTIONS pnpm verify-spec-figures
env -u NODE_OPTIONS pnpm verify-claims
python3 scripts/verify-web-upload.py
```

Expected: `vue-tsc -b` exit 0；本规格 0 error / 0 warning；全量 0 error（既有 warning 不归因本刀）；rail-gates 11/11；claims 7/7；web-upload 13/13。

### Task 4: 变异测试 ≥ 6 组

**Files:**
- Test: `apps/web/src/components/agent/AgentSideRail.vue`、`scripts/verify-is-mobile-layout-scope.py`、`apps/web/src/components/agent/AgentSideRail.closePanelDock.test.ts`（临时改后恢复）

**Interfaces:**
- Consumes: Task 2/3 的绿灯状态；三个目标文件的基准裸 blob sha。
- Produces: 6 组变异的期望/实测对照表，登记进证据文档。

- [ ] **Step 1: 在沙箱副本注入 6 组变异**

| 组 | 变异 | 期望 |
| --- | --- | --- |
| M1 | 把 closePanel 的 `!isDesktopDock` 改成 `isDesktopDock` | 行为级 ③ + ⑤ RED |
| M2 | 只还原 L1013 一处为 `isMobileLayout` | 行为级 ③ RED + 门禁 V3 RED |
| M3 | 只把 `MAX_ALLOWED` 常量抬回 12（方向判据仍要求 11） | 门禁 `V3` RED，vitest 仍绿 |
| M4 | 删掉一个 `defineExpose` 项 | 行为级 ④ RED |
| M5 | 在 Vue 脚本区注释写 `isMobileLayout` 字面量 | 全绿（对照，`strip_comments` 生效） |
| M6 | 新增一处 `isMobileLayout.value` 读取 | 门禁 V3 RED |

- [ ] **Step 2: 恢复三个目标文件并核裸 blob sha 全等**

```python
import hashlib, pathlib
def naked(d): return hashlib.sha1(b'blob '+str(len(d)).encode()+b'\0'+d).hexdigest()
# 与 Task 1 记录的基准 sha 逐个比对，全部相等才继续
print('ALL_LOCAL_MATCH', all(...))
```

Expected: `MUTATIONS 6/6`、`ALL_LOCAL_MATCH True`。任何一组不 RED 先怀疑伪变异（注入点被下游过滤 / 余量吞掉 / 崩溃伪装），不得直接宣告通过。

### Task 5: 推 PR / CI 三必需 / squash / 合并树核对

**Files:**
- Create: 分支 `feat/is-mobile-layout-migration-batch3-20261110` 与 PR

**Interfaces:**
- Consumes: 交付路径（SFC / 门禁脚本 / 新测试 / 规格 / 计划 / runbook / 证据）。
- Produces: PR 编号、merge commit sha，供 Task 6 定位生产发布 run。

- [ ] **Step 1: 推前 `MASTER_MOVED_SAFE`**

```bash
gh api repos/sev7n4/pi-lnk/branches/master --jq '.commit.sha'
```

逐路径比对：交付路径在新旧 master 的 blob sha 必须全等。前移则按新 master 重建镜像并重跑 Task 3/4。

- [ ] **Step 2: Git Data API 推送 + PR 正文回读**

```python
# git/blobs（按内容 sha 幂等，502 有限重试）
# git/trees 用 {'base_tree': head, 'tree': [交付路径]} —— 禁带全量条目
# git/commits parents=[head] → git/refs → pulls
got = gh([f'repos/{REPO}/pulls/{n}', '--jq', '.body|length'])
assert int(got) == len(BODY), 'PR body truncated!'
```

Expected: `PUSHED_DIFF_COUNT` = 交付路径数、`PUSH_TREE_OK`、`PR_BODY_LEN == EXPECTED`。

- [ ] **Step 3: CI 三必需全绿后 squash 并核合并树**

```bash
gh api repos/sev7n4/pi-lnk/actions/runs/<run_id>/jobs --jq '.jobs[] | {name,conclusion}'
```

按 merge commit **真实 parent** 取树比对：差异恰为交付路径、`MASTER_EQ_PRHEAD True`、`NO_OTHER True`、`ALL_PARALLEL_KEPT True`。删除临时分支。

### Task 6: 生产发布复测与状态回填

**Files:**
- Modify: Issue #755（只追加）、`docs/ops/2026-11-10-is-mobile-layout-migration-batch3-evidence.md`（执行时状态回填）、`.workbuddy/memory/2026-11-10.md` / `MEMORY.md`

**Interfaces:**
- Consumes: Task 5 的 merge sha；`deploy-cvm` SSH alias。
- Produces: 生产五证、Issue 回填、记忆索引更新。

- [ ] **Step 1: 确认 web-only 发布 success**

```bash
gh api 'repos/sev7n4/pi-lnk/actions/workflows/deploy.yml/runs?per_page=3' \
  --jq '.workflow_runs[] | {head_sha,conclusion}'
```

Expected: 本次 merge sha 的 run `success`，`Deploy web to CVM` success / `Build API on CVM` skipped。

- [ ] **Step 2: 生产五证下钻**

```bash
ssh deploy-cvm "curl -s http://127.0.0.1:8888/api/health; \
  F=\$(ls /opt/lnkpi/web/dist/assets/CanvasPage-*.js | head -1); \
  echo CHUNK=\$F; \
  for a in agent-resize-handle agent-subtitle 收起助手; do echo \$a \$(grep -o \$a \$F | wc -l); done; \
  grep -o -E '.{120}isMobileLayout:.{160}' \$F | head -3"
```

Expected: `{"ok":true}`、web 200、三个桌面锚点各 1、setup 段 `{isMobileLayout:l}=dr(),u=R(()=>!l.value)` 派生仍在。⭐ 不要求 `isDesktopDock` 字面量命中（局部 const 被 mangle）；以 chunk hash 变化 + 派生结构 + 渲染条件 + DOM 锚点 + health 五证判定。

- [ ] **Step 3: 只追加回填**

Issue #755 追加第三批（D 类第一批）闭环；证据文档追加「执行时状态回填」；日志与 `MEMORY.md` 更新索引。全部用「原 body/原文为前缀」校验 `APPEND_ONLY True`，不追溯改写历史结论。

## Self-Review

1. **Spec coverage**：§1 目标 1→Task 1 Step 1；目标 2→Task 2 + Task 3；目标 3→Task 1 Step 2/3 + Task 2 Step 2 + Task 4。§4 判据 A→Task 1 Step 1 / Task 5 Step 1；B→Task 2 Step 1 + M1 + ⑤；C→Task 3 Step 1 + M3；D→Task 1 Step 2（①②④⑤）；E→Task 1 ④ + M4；F→M5；G→Task 6。§6 S1–S7 分别由 Task 1 Step 1 / Task 2 / Task 3 / Task 1 ①② / Task 1 ⑤ / Task 1 ④ / Task 6 覆盖。无缺口。
2. **Placeholder scan**：所有步骤均给出可运行命令或完整代码片段，无 `TBD` / `TODO` / 「适当处理」；M1–M6 变异均有明确注入点与期望。
3. **Type consistency**：`MAX_ALLOWED` 只出现 12→11 一种迁移；`!isDesktopDock` 在 Task 2 与 Task 1 ③ 断言中一致；交付路径在 Task 5 与规格 §9 一致。
4. **Review Focus**：5 条分别由 Task 1 ⑤/M1、Task 1 ④/M4、Task 3 Step 2/M3、Task 6 Step 2、Task 5 Step 1/Step 3 的测试或步骤钉死，无空项。
