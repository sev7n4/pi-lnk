# AgentSideRail 死链清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

spec-figures: off —— 理由：实施计划按 writing-plans 模板组织，结构图已在同名 spec 的 §0 / §5 承载，计划不重复配图。

**Goal:** 删除 ADR-0015 退役后遗留的 PC 侧历史 popover 死链（`historyOpen` / `historyRef` 及其跨文件恒等写入），零行为变更，并建立一条类别化可失败门禁。

**Architecture:** 不改模板、不新增抽象、不新增 composable。SFC 与 `useAgentThread.ts` 同步移除死状态及其注入字段；新增一个源级 ratchet 读这两个真实文件，用「否定断言 + 存在性配对 + 类别化循环」锁住边界；`vue-tsc -b` 保证类型自洽。

**Tech Stack:** Vue 3 `<script setup>` + TypeScript、Vitest（源级 ratchet）、`vue-tsc -b`、`pnpm verify-spec-figures`、`gh api` Git-Data 链、GitHub Actions 三 required check。

**Spec:** `docs/superpowers/specs/2026-11-08-agent-siderail-p1-denoise-design.md`（执行者须同时读 `docs/superpowers/specs/2026-11-08-agent-siderail-phase3-closeout.md` 了解冻结边界）。

## Global Constraints

- 分支约定：feature 分支 + PR + squash merge；本仓 `git push` 被网络阻断，提交走 `gh api` Git-Data 链（`docs/agent/delivery.md`）。
- `gh api` Git-Data tree entry **必须 repo-root 相对**（`apps/web/src/components/agent/...`）；用 app 相对路径会产生幻影文件（#774 事故）。
- 推前与推后都做「改动文件 worktree-HEAD vs master blob sha 逐路径核对」；master 真值只认 `gh api`，不信本地 ref。
- 本机 vitest / vue-tsc 用 `source ~/.nvm/nvm.sh && nvm use 24`，且必须 `env -u NODE_OPTIONS`。
- CI 三个 required check = `Verify spec figures` / `Build monorepo`（含全量 vitest）/ `Build API Docker image`；`pnpm -r build` 的 tsc 会编译 `*.test.ts` ⇒ 测试断言**禁用 `as never`**。
- 判据必须能真的失败：每条否定断言配肯定断言；实现后做变异测试 RED 并确认 `exit≠0`；验证脚本读真实源文件，不复刻逻辑副本。
- 事实性数字 / 符号归属落笔前实测；`grep -rn` 在本机可能被 shim 包装返回 0 命中，须用 Python 直读复核。
- `deploy.yml` paths 白名单含 `apps/web/**` ⇒ 本刀合并会触发自动部署；纯文档部分不触发。
- 冻结边界：`sendMessage` / `handleEvent` / `canvas_command` 分支 / S2 核心 ref 所有权 / S12·S14 接线层 / `defineExpose` 11 项对外契约，一律不动。
- 不改 `docs/agent/*.md`（否则触发 `pnpm verify-claims`）、不改 `docs/superpowers/INDEX.md`、不改 `prompt-registry/**`。
- KPI：本刀使 `useAgentThread` 注入依赖数 -1；不新增注入依赖 / 回环 / 共享 ref 写者。

## Review Focus

| # | 隐含失败模式 | 合理预期 | 钉住它的测试 |
| --- | --- | --- | --- |
| 1 | 注释里的退役归因文字被当成代码命中，造成假绿 / 假红 | 所有断言基于剥注释后的源码 | Task 1 组 1–4 统一用 `stripComments`；组 3 的 `targets` 取自剥注释源码 |
| 2 | 删了注入对象字段却漏删 `AgentThreadDeps` 接口字段（或反之），类型不自洽 | 两处同步消失，`vue-tsc -b` EXIT=0 | Task 1 组 1 的 `depsBlock` / `injectBlock` 断言 + Task 4 Step 3 |
| 3 | 误删 `useClickOutside` 的 import，连带两个活菜单失效 | import 与两处活调用都保留 | Task 1 组 3 的 import 断言与 `attachMenuRef` / `thinkingMenuRef` 配对 |
| 4 | 把移动端历史面板当成同一死链删掉，破坏 `defineExpose` 对外契约 | 活面板 11 项契约完整 | Task 1 组 2 + M3 变异 RED |
| 5 | 今后新增一个挂空元素的 `useClickOutside(ghostRef, …)` | 类别化判据应立刻拦下，而不是只挡 `historyRef` | Task 1 组 3 的循环判据 + M5 变异 RED |

---

### Task 1: 写源级 ratchet 并证明基线 RED

**Files:**
- Create: `apps/web/src/components/agent/AgentSideRail.deadHistoryChain.test.ts`

**Interfaces:**
- Consumes: `AgentSideRail.vue`、`useAgentThread.ts` 的磁盘文本（不是它们的运行时导出）。
- Produces: 一个 vitest 测试文件，供 Task 2 转绿、Task 3 变异验证使用。

- [ ] **Step 1: 写测试文件**

```ts
/**
 * ADR-0015 退役残留：PC 侧历史 popover 死链不得复现。
 * 所有断言读真实源文件；注释必须剥离（历史归因注释会提到已退役符号）。
 * 否定断言一律配肯定断言，防止「把文件删空也能绿」。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfcRaw = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')
const threadRaw = readFileSync(join(here, 'useAgentThread.ts'), 'utf8')

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
}

const sfc = stripComments(sfcRaw)
const thread = stripComments(threadRaw)
const tpl = sfcRaw
  .slice(sfcRaw.indexOf('<template>'), sfcRaw.lastIndexOf('</template>'))
  .replace(/<!--[\s\S]*?-->/g, '')

/** 按内容锚点切块（不按行号，行号会随改动位移）。 */
function blockOf(src: string, anchor: string, endAnchor: string): string {
  const start = src.indexOf(anchor)
  if (start < 0) return ''
  const stop = src.indexOf(endAnchor, start + anchor.length)
  return stop < 0 ? src.slice(start) : src.slice(start, stop)
}

/** 函数体截取：懒匹配到第一个行首 `}`（内部块均有缩进）。 */
function fnBlock(signature: string): string {
  const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${escaped}[\\s\\S]*?\\n\\}`)
  return thread.match(re)?.[0] ?? ''
}

describe('ADR-0015 退役残留：PC 历史 popover 死链', () => {
  it('组 1：SFC 与 useAgentThread 均不再出现 historyOpen / historyRef', () => {
    expect(sfc).not.toContain('historyOpen')
    expect(sfc).not.toContain('historyRef')
    expect(thread).not.toContain('historyOpen')

    const depsBlock = blockOf(thread, 'export interface AgentThreadDeps', 'export interface AgentThreadApi')
    expect(depsBlock, '必须能定位 AgentThreadDeps 接口块').toContain('agentThreadId')
    expect(depsBlock).not.toContain('historyOpen')

    const injectBlock = blockOf(sfc, 'useAgentThread({', '\n})')
    expect(injectBlock, '必须能定位 useAgentThread 注入块').toContain('threads,')
    expect(injectBlock).not.toContain('historyOpen')
  })

  it('组 2：移动端历史面板与 defineExpose 契约完整（存在性配对）', () => {
    expect(sfc).toContain('const threads = ref<AgentThreadRow[]>([])')
    expect(sfc).toContain('async function fetchThreads()')
    expect(sfc).toContain('async function openThreadHistory()')
    expect(sfc).toContain('function closeThreadHistory()')
    expect(sfc).toContain('mobileThreadHistoryOpen')
    expect(tpl).toContain('v-for="thread in threads"')

    const exposeBlock = blockOf(sfc, 'defineExpose({', '</script>')
    expect(exposeBlock, '必须能定位 defineExpose 块').toContain('openThreadHistory,')
    expect(exposeBlock).toContain('closeThreadHistory,')
  })

  it('组 3：每个 useClickOutside 目标都必须在模板有 ref 绑定（类别化判据）', () => {
    const targets = [...sfc.matchAll(/useClickOutside\((\w+)/g)].map((m) => m[1])
    expect(targets.length, '至少两处活 click-outside 仍存活（防空集假绿）').toBeGreaterThanOrEqual(2)
    for (const name of targets) {
      expect(tpl, `${name} 必须有模板 ref 绑定，否则是挂空元素的死监听`).toContain(`ref="${name}"`)
    }
    expect(sfc).toContain("import { useClickOutside } from '@/composables/useClickOutside'")
    expect(targets).toContain('attachMenuRef')
    expect(targets).toContain('thinkingMenuRef')
  })

  it('组 4：selectThread 守卫与切线程编排未被连带删除', () => {
    const fn = fnBlock('async function selectThread(')
    expect(fn, '必须能定位 selectThread 函数体').toContain('if (threadId !== getSessionId())')
    expect(fn).toContain('if (threadId === agentThreadId.value)')
    expect(fn).toContain('clearComposer()')
    expect(fn).toContain('clearForkedThreadId(getSessionId())')
    expect(fn).toContain('await loadHistory()')
  })
})
```

- [ ] **Step 2: 跑测试，确认基线 RED**

Run:
```bash
cd /Users/4seven/workspace/pi-lnk/apps/web && source ~/.nvm/nvm.sh 2>/dev/null && nvm use 24 >/dev/null 2>&1 && env -u NODE_OPTIONS npx vitest run src/components/agent/AgentSideRail.deadHistoryChain.test.ts
```
Expected: **FAIL**。`组 1` 因 `historyOpen` / `historyRef` 仍在而红；`组 3` 因 `historyRef` 无 `ref="historyRef"` 而红；`组 2` / `组 4` 绿。若全绿 ⇒ 判据写错了（先怀疑 `stripComments` 或锚点切块为空），修判据而不是改实现。

- [ ] **Step 3: 备份两个源文件（供 Task 3 恢复）**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/web/src/components/agent
cp AgentSideRail.vue /tmp/p1_sfc.baseline.vue
cp useAgentThread.ts /tmp/p1_thread.baseline.ts
```

- [ ] **Step 4: Commit 测试（RED 态）**

```bash
cd /Users/4seven/workspace/pi-lnk
git add apps/web/src/components/agent/AgentSideRail.deadHistoryChain.test.ts
git commit -m "test(agent): add dead history-chain ratchet (RED)"
```
> 本仓本地 git 可能不可靠；若 `git commit` 失败，记录 ruling 并把文件保留在工作树，最终统一走 Task 5 的 `gh api` 链提交。

---

### Task 2: 删除死链（SFC + composable）

**Files:**
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（按 §9 内容锚点定位）
- Modify: `apps/web/src/components/agent/useAgentThread.ts`（同）

**Interfaces:**
- Consumes: Task 1 的 ratchet（RED 态）。
- Produces: `AgentThreadDeps` 不再含 `historyOpen`；`AgentThreadApi` 签名**完全不变**；模板零改动。

- [ ] **Step 1: 打印锚点行号（当场定位，不硬写行号）**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/web/src/components/agent
grep -n "const historyOpen = ref(false)\|const historyRef = ref\|useClickOutside(historyRef\|useAgentThread({" AgentSideRail.vue
grep -n "historyOpen" useAgentThread.ts
```

- [ ] **Step 2: 改 SFC —— 删 3 行声明与 3 行回调块**

删除以下连续块（原文逐字）：

```ts
const historyOpen = ref(false)
const historyRef = ref<HTMLElement | null>(null)
```
以及：
```ts
useClickOutside(historyRef, () => {
  historyOpen.value = false
})
```
保留紧邻其上的 `/* ---- 对话 thread 列表 ---- */` 注释、紧随其后的 `const threads = ref<AgentThreadRow[]>([])`，以及 `import { useClickOutside } from '@/composables/useClickOutside'`。

- [ ] **Step 3: 改 SFC —— 删注入字段**

在 `useAgentThread({ ... })` 调用块内删除这一行：
```ts
  historyOpen,
```
其余注入项（含 `threads,`、`taskProgress,`、`loadHistory,`）全部保留。

- [ ] **Step 4: 改 useAgentThread.ts —— 删接口字段、解构项、3 处恒等写入**

删除：
```ts
  historyOpen: Ref<boolean>
```
（`AgentThreadDeps` 接口内）、
```ts
    historyOpen,
```
（`} = deps` 之前的解构块内）、以及 `selectThread` 函数体内 3 处：
```ts
      historyOpen.value = false
```
**两个早返回分支的 `return` 必须保留**；`clearForkedThreadId(getSessionId())` 之后的业务状态清空与 `await loadHistory()` 必须保留。

- [ ] **Step 5: 跑 ratchet，确认转绿**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/web && source ~/.nvm/nvm.sh 2>/dev/null && nvm use 24 >/dev/null 2>&1 && env -u NODE_OPTIONS npx vitest run src/components/agent/AgentSideRail.deadHistoryChain.test.ts
```
Expected: **4/4 PASS**。若不绿，先查 `blockOf` 的结束锚点是否切空（组 1 / 组 2 的「必须能定位」消息会提示），不要靠放宽断言转绿。

- [ ] **Step 6: 跑类型门禁**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/web && source ~/.nvm/nvm.sh 2>/dev/null && nvm use 24 >/dev/null 2>&1 && env -u NODE_OPTIONS npx vue-tsc -b
```
Expected: `EXIT=0`。`AgentThreadDeps` 与注入对象必须同时删干净，否则此处报类型错误。

- [ ] **Step 7: Commit 实现**

```bash
cd /Users/4seven/workspace/pi-lnk
git add apps/web/src/components/agent/AgentSideRail.vue apps/web/src/components/agent/useAgentThread.ts
git commit -m "refactor(agent): remove retired PC history popover dead chain"
```

---

### Task 3: 变异测试（证明判据真的能红）

**Files:**
- Modify（临时，随后恢复）: Task 2 的两个源文件。

**Interfaces:**
- Consumes: Task 2 转绿后的两个源文件、Task 1 的 ratchet。
- Produces: 5 条变异的 RED 证据，源文件最终恢复到 Task 2 状态（裸 blob sha 与备份一致）。

- [ ] **Step 1: 写变异脚本**

Create `/tmp/p1_mutation.py`：

```python
import subprocess, shutil, os
WEB = '/Users/4seven/workspace/pi-lnk/apps/web'
SFC = f'{WEB}/src/components/agent/AgentSideRail.vue'
THREAD = f'{WEB}/src/components/agent/useAgentThread.ts'
CMD = ('cd /Users/4seven/workspace/pi-lnk/apps/web && source ~/.nvm/nvm.sh 2>/dev/null '
       '&& nvm use 24 >/dev/null 2>&1 && env -u NODE_OPTIONS '
       'npx vitest run src/components/agent/AgentSideRail.deadHistoryChain.test.ts')

MUTATIONS = [
    ('M1 死链复现', SFC, 'const threads = ref<AgentThreadRow[]>([])',
     'const historyOpen = ref(false)\nconst threads = ref<AgentThreadRow[]>([])'),
    ('M2 恒等写入复现', THREAD, 'async function selectThread(',
     'async function selectThread(\n  /* M2 */ historyOpen.value = false'),
    ('M3 活面板误删', SFC, 'function closeThreadHistory() {',
     'function closeThreadHistory_REMOVED() {'),
    ('M4 click-outside 目标误删', SFC, 'useClickOutside(attachMenuRef,',
     'useClickOutside_attachMenuRef_REMOVED('),
    ('M5 类别判据失效', SFC, 'useClickOutside(thinkingMenuRef,',
     'useClickOutside(ghostRef, () => {})\nuseClickOutside(thinkingMenuRef,'),
]

for name, path, old, new in MUTATIONS:
    original = open(path, encoding='utf-8').read()
    assert old in original, f'{name}: 锚点未命中，变异无效'
    open(path, 'w', encoding='utf-8').write(original.replace(old, new, 1))
    p = subprocess.run(['bash', '-lc', CMD], capture_output=True, text=True)
    print(f'{name}: exit={p.returncode} {"RED(OK)" if p.returncode != 0 else "GREEN(FAIL: 判据恒绿)"}')
    open(path, 'w', encoding='utf-8').write(original)
    assert p.returncode != 0, f'{name}: 判据没有转红，禁止继续'
```
> ⚠️ M2 / M5 注入的是语法上可解析但语义违规的文本；vitest 读的是文件文本而非编译产物，故不会因 TS 报错干扰判据。**若 M2 因 `historyOpen` 未声明而触发类型层噪音，改用等价注入 `const historyOpen = { value: false }` 前置到 `useAgentThread` 函数体外**，只要能让组 1 转红即可。

- [ ] **Step 2: 跑变异脚本**

```bash
python3 /tmp/p1_mutation.py
```
Expected: 5 行全部 `RED(OK)`；任何 `GREEN(FAIL)` 都说明断言恒绿，必须回 Task 1 修判据。

- [ ] **Step 3: 确认源文件已恢复且与 Task 2 产物一致**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/web/src/components/agent
for f in AgentSideRail.vue useAgentThread.ts; do
  printf "%s  " "$f"; (printf 'blob %d\0' "$(wc -c < "$f")"; cat "$f") | shasum | awk '{print $1}'
done
cd /Users/4seven/workspace/pi-lnk/apps/web && source ~/.nvm/nvm.sh 2>/dev/null && nvm use 24 >/dev/null 2>&1 && env -u NODE_OPTIONS npx vitest run src/components/agent/AgentSideRail.deadHistoryChain.test.ts
```
Expected: 复跑 4/4 PASS（证明恢复干净）。

- [ ] **Step 4: 记录变异结果到 PR 描述**（不单独 commit，脚本与输出留在 `/tmp`）。

---

### Task 4: 全量门禁与推前核对

**Files:** 无新增；核对 Task 1–2 的 3 个源文件 + 3 份文档。

**Interfaces:**
- Consumes: Task 2 的实现、Task 3 的恢复结果。
- Produces: 一份可贴进 PR 描述的门禁结果表 + master base 一致性证据。

- [ ] **Step 1: AgentSideRail 全组测试**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/web && source ~/.nvm/nvm.sh 2>/dev/null && nvm use 24 >/dev/null 2>&1 && env -u NODE_OPTIONS npx vitest run "src/components/agent/AgentSideRail"
```
Expected: 43 files / **221 tests**（基线 217 + 新增 4）全绿，失败数 0。同时看末尾 `Errors` 与 `Exit status`（`delivery.md`：全 passed 但 Errors 非零仍算失败）。

- [ ] **Step 2: `tsc --noEmit` 检查新测试文件**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/web && source ~/.nvm/nvm.sh 2>/dev/null && nvm use 24 >/dev/null 2>&1 && env -u NODE_OPTIONS npx tsc --noEmit 2>&1 | grep -E "deadHistoryChain" || echo "NO_ERRORS_IN_NEW_TEST"
```
Expected: `NO_ERRORS_IN_NEW_TEST`（其余 `.vue` 模块声明噪音属既有，需 `vue-tsc` 才解析）。

- [ ] **Step 3: 规格配图门禁（三份文档）**

```bash
cd /Users/4seven/workspace/pi-lnk && env -u NODE_OPTIONS pnpm verify-spec-figures
```
Expected: 无 error。若新 spec 报错，按 `SPEC-CONVENTIONS.md` R1–R8 修图号 / 图注 / §0 索引 / Mermaid 标签引号，**不要加 `spec-figures: off` 绕过**（计划文档已按理由豁免，spec 不豁免）。

- [ ] **Step 4: 构建门禁**

```bash
cd /Users/4seven/workspace/pi-lnk && env -u NODE_OPTIONS pnpm -r build
```
Expected: 通过；特别确认 `*.test.ts` 被 tsc 编译时无 `as never` 类错误。

- [ ] **Step 5: `gh api` 复核 master 未前移、新增文件在 master 不存在**

```bash
REPO=sev7n4/pi-lnk
MASTER=$(gh api repos/$REPO/git/refs/heads/master --jq '.object.sha')
echo "MASTER=$MASTER"
TREE=$(gh api repos/$REPO/git/commits/$MASTER --jq '.tree.sha')
gh api "repos/$REPO/git/trees/$TREE?recursive=1" --jq '.tree[] | select(.path|test("AgentSideRail\\.deadHistoryChain\\.test\\.ts$|2026-11-08-agent-siderail")) | .path'
```
Expected: 第一行为当前 master SHA（与规格结项记录中的 `dd0c43e5…` 一致，或更新则记录新值）；第二行为空（4 个新增文件都不在 master）。

- [ ] **Step 6: 逐文件裸 blob sha 核对（只提交自己的文件）**

```bash
cd /Users/4seven/workspace/pi-lnk
for f in apps/web/src/components/agent/AgentSideRail.vue apps/web/src/components/agent/useAgentThread.ts; do
  printf "%s  " "$f"; (printf 'blob %d\0' "$(wc -c < "$f")"; cat "$f") | shasum | awk '{print $1}'
done
```
Expected: 与 Task 2 结束时的 sha 一致（证明变异后已恢复）。同时确认工作树里**没有**其它 `apps/web` 文件被顺手改动。

---

### Task 5: `gh api` Git-Data 提交、开 PR、CI、squash 合并

**Files:** 提交 **6 个文件**：
- `apps/web/src/components/agent/AgentSideRail.vue`（modify）
- `apps/web/src/components/agent/useAgentThread.ts`（modify）
- `apps/web/src/components/agent/AgentSideRail.deadHistoryChain.test.ts`（add）
- `docs/superpowers/specs/2026-11-08-agent-siderail-phase3-closeout.md`（add）
- `docs/superpowers/specs/2026-11-08-agent-siderail-p1-denoise-design.md`（add）
- `docs/superpowers/plans/2026-11-08-agent-siderail-p1-denoise.md`（add，即本文）

**Interfaces:**
- Consumes: Task 4 的核对结果、master SHA。
- Produces: 一个 PR（预期编号 #777，以实际为准）、CI 三绿、squash 合并、分支删除。

- [ ] **Step 1: 写提交脚本 `/tmp/p1_submit.py`**

```python
import base64, json, os, subprocess, tempfile, time, sys
REPO = 'sev7n4/pi-lnk'
ROOT = '/Users/4seven/workspace/pi-lnk'
BRANCH = 'phase4/p1-dead-history-chain-20261108'
FILES = [
    'apps/web/src/components/agent/AgentSideRail.vue',
    'apps/web/src/components/agent/useAgentThread.ts',
    'apps/web/src/components/agent/AgentSideRail.deadHistoryChain.test.ts',
    'docs/superpowers/specs/2026-11-08-agent-siderail-phase3-closeout.md',
    'docs/superpowers/specs/2026-11-08-agent-siderail-p1-denoise-design.md',
    'docs/superpowers/plans/2026-11-08-agent-siderail-p1-denoise.md',
]

def api(method, path, data=None):
    cmd = ['gh', 'api', f'repos/{REPO}/{path}']
    if method == 'POST': cmd += ['-X', 'POST']
    if method == 'PATCH': cmd += ['-X', 'PATCH']
    tmp = None
    if data is not None:
        fd, tmp = tempfile.mkstemp(suffix='.json')
        with os.fdopen(fd, 'w') as fh: json.dump(data, fh)
        cmd += ['--input', tmp]
    for attempt in range(5):
        p = subprocess.run(cmd, capture_output=True)
        if p.returncode == 0: break
        sys.stderr.write(f'retry {attempt+1}: {p.stderr.decode()[:200]}\n')
        time.sleep(2 ** attempt)
    if tmp: os.remove(tmp)
    if p.returncode != 0:
        sys.exit(f'FAILED {method} {path}: {p.stderr.decode()}')
    return json.loads(p.stdout.decode() or '{}')

master = api('GET', 'git/refs/heads/master')['object']['sha']
tree_sha = api('GET', f'git/commits/{master}')['tree']['sha']
print('base master =', master, 'tree =', tree_sha)

entries = []
for rel in FILES:
    raw = open(os.path.join(ROOT, rel), 'rb').read()
    blob = api('POST', 'git/blobs', {'content': base64.b64encode(raw).decode(), 'encoding': 'base64'})
    print('blob', blob['sha'][:12], rel, len(raw))
    # ⚠️ path 必须 repo-root 相对；app 相对路径会产生幻影文件（#774）
    entries.append({'path': rel, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})

tree = api('POST', 'git/trees', {'base_tree': tree_sha, 'tree': entries})
commit = api('POST', 'git/commits', {
    'message': 'refactor(agent): remove retired PC history popover dead chain + ratchet (Phase 4 P1)',
    'tree': tree['sha'], 'parents': [master],
})
api('POST', 'git/refs', {'ref': f'refs/heads/{BRANCH}', 'sha': commit['sha']})
pr = api('POST', 'pulls', {
    'title': 'refactor(agent): remove retired PC history popover dead chain (Phase 4 P1 cut 1)',
    'head': BRANCH, 'base': 'master',
    'body': 'Spec: docs/superpowers/specs/2026-11-08-agent-siderail-p1-denoise-design.md\n'
            'Closeout: docs/superpowers/specs/2026-11-08-agent-siderail-phase3-closeout.md\n'
            'Plan: docs/superpowers/plans/2026-11-08-agent-siderail-p1-denoise.md\n'
            'Zero behavior change; ratchet RED->PASS + 5 mutations RED; vue-tsc -b EXIT=0.\n'
            'Note: push to master auto-deploys web; business-level prod smoke remains P0 backlog.',
})
print('PR', pr['number'], pr['html_url'])
```

- [ ] **Step 2: 执行提交并验证 PR 文件列表**

```bash
python3 /tmp/p1_submit.py
gh api repos/sev7n4/pi-lnk/pulls/<PR号>/files --jq '.[] | "\(.status)  \(.filename)  +\(.additions)/-\(.deletions)"'
```
Expected: 2 个 `modified`（SFC、`useAgentThread.ts`）+ 4 个 `added`；**`AgentSideRail.vue` 必须是 `modified` 且 deletions > 0**，若是 `added` 说明 tree entry 路径写错，立即关闭 PR 删分支重提（#774 处置方式）。

- [ ] **Step 3: 盯 CI 三必需到全绿**

```bash
gh pr checks <PR号>
gh run view <run-id> --json jobs --jq '.jobs[].steps[]|"\(.name) :: \(.conclusion)"'
```
Expected: `Verify spec figures` / `Build monorepo` / `Build API Docker image` 全 pass；下钻确认 `pnpm test` step 的结论与末尾 `Exit status`（`gh pr checks` 看不到它）。

- [ ] **Step 4: squash 合并并核验**

```bash
gh pr merge <PR号> --squash --delete-branch
gh api repos/sev7n4/pi-lnk/pulls/<PR号> --jq '{state, merged, merge_commit_sha}'
gh api repos/sev7n4/pi-lnk/git/refs/heads/master --jq '.object.sha'
```
Expected: `merged: true`；新 master tree 中 6 个文件的 blob sha 与本地逐字节相等；分支 404。

- [ ] **Step 5: 更新项目日志**

Append 到 `.workbuddy/memory/2026-11-08.md`：记录 PR 号、merge SHA、4 个测试用例、5 条变异结果、注入依赖数 17→16、结项与规格/计划三份文档路径、以及「上一轮 P1 清单 5 项经复核仅 1 项成立」的纠偏。

---

## Self-Review（写计划时自查，执行者不必重做）

- **Spec coverage**：§1 三目标 → Task 1/2/3 + Task 4 Step 6（-1 注入依赖由 Task 2 Step 3/4 与 `vue-tsc` 保证）；§2 范围 → Task 2 明确保留项；§3 修订 → 规格本体，计划不重复；§4 判据 → Task 1 四组断言 + Task 3 五条变异；§5 契约 → Task 2 Step 6；§9 文件清单 → Task 2 / Task 5 文件列表一致；§10 门禁 → Task 4 全量；§12 后续包不进本计划。无缺口。
- **Placeholder scan**：无 `TBD` / `TODO` / 「适当处理」/ 「类似 Task N」；所有代码步骤含实际代码块；`<PR号>` / `<run-id>` 是运行时值的占位（不是内容占位），Step 2 的输出会给出真值。
- **Type consistency**：`AgentSideRail.deadHistoryChain.test.ts`、`stripComments`、`blockOf`、`fnBlock`、`AgentThreadDeps`、`AgentThreadApi` 在各 Task 中名称一致；`useAgentThread({` / `defineExpose({` / `async function selectThread(` 锚点一致。
- **Review Focus**：5 条全部在 Task 1 有对应断言，并在 Task 3 有 M3 / M5 变异覆盖；§2（类型自洽）另由 Task 4 Step 2/4 覆盖。
- **判据自身有效性（设计期已取证）**：用 Python 直读 master blob 的同一份真实源文件跑等价切片，结果为「组 1 四处命中 + 组 3 `historyRef` 无 ref 绑定 ⇒ RED；组 2 五项活面板锚点 + 组 4 五条守卫 ⇒ GREEN」，`depsBlock` 709 字符、`injectBlock` 352 字符、`fnBlock` 2461 字符均非空。故 Task 1 Step 2 的 RED 来自真实死链，不是锚点切空。规格 §10.2 有同一份证据。
- **文档门禁已跑**：`pnpm verify-spec-figures` 全量 193 篇在范围内、0 error；三份新文档逐篇 `--file` 均 0 error / 0 warning（计划文档按理由走 `spec-figures: off` 豁免，结构图由 spec 承载）。全量那 2 个警告来自其它历史文档，按「只修自己引入的断链」原则不动。
